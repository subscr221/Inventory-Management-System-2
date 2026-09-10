import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { PoolClient } from 'pg';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson } from '../../middleware/error.js';
import {
  getAuthContext,
  getAuthorizedAssignment,
  getParsedBody,
  getTraceId,
} from '../../middleware/context.js';
import { requireRole, permittedLocationsForModuleScope } from '../../middleware/rbac.js';
import { getPool } from '../../config/db.js';
import { persistEvent, type EventEnvelope } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getItemBySku, type ItemMaster } from '../../read/projections/item_master.js';
import { getLotByNumberAndSku } from '../../read/projections/lot_master.js';
import { getSerialByNumberAndSku } from '../../read/projections/serial_master.js';
import {
  getLocationById,
  getLocationByCode,
  type LocationRegisterEntry,
} from '../../read/projections/location_register.js';
import { VALID_STOCK_CLASSES } from '../../compliance/stock-balance.js';
import { toIstCalendarDate } from '../../lib/business-days.js';
import { resolveApprover } from './indents.js';
import { parseCsv } from '../../migration/csv.js';
import {
  MAX_IMPORT_BODY_BYTES,
  MAX_OPENING_STOCK_IMPORT_ROWS,
  assertOpeningStockTemplateHeader,
  fileSha256,
  openingStockContentHash,
  openingStockRowIdempotencyKey,
  toTemplateRowV1,
  type OpeningStockTemplateRowV1,
} from '../../migration/opening-stock-template.js';
import {
  IMPORT_MODES,
  MIGRATION_ERROR_CODES,
  MIGRATION_STREAM_TYPE,
  MIGRATION_VARIANCE_EXPLANATION_DOA_TYPE,
  NUMERIC_18_6_REGEX,
  OPENING_STOCK_DOMAIN,
  VARIANCE_CAUSE_CODES,
  assertOpeningStockPromotable,
  readMigrationStage,
} from '../../compliance/migration-opening-stock.js';
import {
  computeOpeningStockVariances,
  summariseOpeningStockVariances,
  type OpeningStockVariance,
} from '../../read/projections/migration_variance.js';
import type {
  MigrationImportRejection,
  MigrationOpeningStockLoadedPayload,
} from '../../events/schema.js';

// ---------------------------------------------------------------------------
// Story 13.1 (FR-DM-01, SM-48): opening-stock migration routes. These are the ONLY producers of
// the 'migration' event stream (both event doors bar it). Every write route binds the request's
// site_id to the SAME assignment that grants the function (module `migration`, scope `write`,
// role in MIGRATION_WRITE_ROLES) - the 2026-09-06 cross-site lesson - and every event's actor is
// the authenticated identity, never the body.
// ---------------------------------------------------------------------------

export const MIGRATION_MODULE = 'migration';
export const MIGRATION_WRITE_ROLES = new Set(['migration_lead', 'system_administrator']);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 100;

/**
 * Test seam for the AC 6 resume proof (Task 9.4): a hook the integration test sets to throw after
 * N rows so the import dies mid-file. A no-op in production; nothing else reads it.
 */
export const openingStockImportTestHooks: {
  beforeRow?: (index: number, lineNo: number) => void | Promise<void>;
} = {};

type AuditCtx = Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;

interface Actor {
  userId: string;
  role: string;
  auditLocationId: string;
}

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_REGEX.test(v);
}

function requireObjectBody(req: IncomingMessage): Record<string, unknown> {
  const body = getParsedBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(400, 'INVALID_PARAMS', 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function requireUuidField(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (!isUuid(v)) {
    throw new AppError(400, 'INVALID_PARAMS', `${field} must be a UUID`, { field });
  }
  return v.toLowerCase();
}

function requireNonEmptyString(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v !== 'string' || !v.trim()) {
    throw new AppError(400, 'INVALID_PARAMS', `${field} is required`, { field });
  }
  return v.trim();
}

/** Mirrors assertBranchTransferGstIdempotencyKey (events.ts): mandatory, non-blank. */
function requireIdempotencyKey(body: Record<string, unknown>): string {
  const key = body['idempotency_key'];
  if (typeof key !== 'string' || !key.trim()) {
    throw new AppError(400, 'INVALID_PARAMS', 'idempotency_key is required', {
      field: 'idempotency_key',
    });
  }
  return key.trim();
}

/**
 * Story 9.10 AC 4 lesson: lower-cased because UUID_REGEX is case-insensitive while PostgreSQL
 * returns uuid columns lower-cased.
 */
function requireUuidParam(params: Record<string, string> | undefined, name: string): string {
  const value = params?.[name];
  if (!value || !isUuid(value)) {
    throw new AppError(400, 'INVALID_PARAMS', `${name} must be a UUID`, { [name]: value ?? null });
  }
  return value.toLowerCase();
}

function requireQueryUuid(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value || !isUuid(value)) {
    throw new AppError(400, 'INVALID_PARAMS', `${name} query parameter must be a UUID`, {
      [name]: value,
    });
  }
  return value.toLowerCase();
}

function pageParams(url: URL): { limit: number; offset: number } {
  const rawLimit = url.searchParams.get('limit');
  const rawOffset = url.searchParams.get('offset');
  const limit = rawLimit === null ? DEFAULT_PAGE_SIZE : Number(rawLimit);
  const offset = rawOffset === null ? 0 : Number(rawOffset);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AppError(400, 'INVALID_PARAMS', 'limit must be a positive integer', {
      limit: rawLimit,
    });
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new AppError(400, 'INVALID_PARAMS', 'offset must be a non-negative integer', {
      offset: rawOffset,
    });
  }
  return { limit: Math.min(limit, MAX_PAGE_SIZE), offset };
}

/**
 * The write-side actor binding: privilege (role in MIGRATION_WRITE_ROLES, module `migration`,
 * scope `write`) AND site scope come from ONE assignment. A caller with the role but no assignment
 * for this site is LOCATION_ACCESS_DENIED; a caller whose migration write assignment is on a role
 * outside the set is FUNCTION_ACCESS_DENIED.
 */
function requireMigrationWriteActor(req: IncomingMessage, siteId: string): Actor {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const qualifying = authContext.roles.filter(
    (r) =>
      MIGRATION_WRITE_ROLES.has(r.role) &&
      (r.module === MIGRATION_MODULE || r.module === '*') &&
      r.functionScope === 'write',
  );
  if (qualifying.length === 0) {
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      'A migration_lead or system_administrator write assignment on module migration is required',
      { required_roles: [...MIGRATION_WRITE_ROLES] },
    );
  }
  const granting = qualifying.find((r) => r.locationId === '*' || r.locationId === siteId);
  if (!granting) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      `No migration write assignment grants access to site "${siteId}"`,
      { site_id: siteId },
    );
  }
  return { userId: authContext.userId, role: granting.role, auditLocationId: granting.locationId };
}

function requireSiteReadAccess(req: IncomingMessage, siteId: string): Actor {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const scope = permittedLocationsForModuleScope(authContext.roles, MIGRATION_MODULE, 'read');
  if (!scope.wildcard && !scope.locations.has(siteId)) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      `No read assignment grants access to site "${siteId}"`,
      { site_id: siteId },
    );
  }
  const assignment = getAuthorizedAssignment(req);
  return {
    userId: authContext.userId,
    role: assignment?.role ?? '',
    auditLocationId: assignment?.locationId ?? '*',
  };
}

function auditCtxFor(req: IncomingMessage, actor: Actor, httpStatus: number): AuditCtx {
  return {
    trace_id: getTraceId(req) ?? '',
    user_id: actor.userId,
    role: actor.role,
    location_id: actor.auditLocationId,
    endpoint: req.url ?? '',
    method: req.method ?? 'POST',
    http_status: httpStatus,
  };
}

function siteEnvelope(
  siteId: string,
  eventType: string,
  payload: Record<string, unknown>,
  actor: Actor,
  opts: {
    correlation_id?: string;
    causation_id?: string | null;
    idempotency_key: string;
    occurred_at?: string;
  },
): EventEnvelope {
  return {
    stream_type: MIGRATION_STREAM_TYPE,
    stream_id: siteId,
    event_type: eventType,
    payload,
    metadata: {
      correlation_id: opts.correlation_id ?? randomUUID(),
      causation_id: opts.causation_id ?? null,
      actor: { user_id: actor.userId, role: actor.role, location_id: siteId },
      occurred_at: opts.occurred_at ?? new Date().toISOString(),
    },
    idempotency_key: opts.idempotency_key,
  };
}

async function findEventByIdempotencyKey(
  key: string,
): Promise<{ event_id: string; payload: Record<string, unknown> } | null> {
  const r = await getPool().query(
    `SELECT event_id, payload FROM domain_events WHERE idempotency_key = $1`,
    [key],
  );
  if (r.rows.length === 0) return null;
  return {
    event_id: r.rows[0]!['event_id'] as string,
    payload: r.rows[0]!['payload'] as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Import (Task 3)
// ---------------------------------------------------------------------------

const IMPORT_HEADER_COLUMNS = `load_id, site_id, domain, file_name, file_sha256, template_version, mode,
  row_count, accepted_count, rejected_count, suppressed_count, superseded_count, idempotency_key,
  created_by_actor_id, source_event_id, occurred_at, business_date::text AS business_date, created_at`;

async function loadImportHeader(
  where: string,
  params: unknown[],
): Promise<Record<string, unknown> | null> {
  const r = await getPool().query(
    `SELECT ${IMPORT_HEADER_COLUMNS} FROM migration_import WHERE ${where}`,
    params,
  );
  return (r.rows[0] as Record<string, unknown> | undefined) ?? null;
}

async function listRejections(loadId: string): Promise<Record<string, unknown>[]> {
  const r = await getPool().query(
    `SELECT rejection_id, load_id, line_no, error_code, details, raw_row, created_at
       FROM migration_import_rejection WHERE load_id = $1 ORDER BY line_no`,
    [loadId],
  );
  return r.rows as Record<string, unknown>[];
}

interface RowOutcome {
  rejection?: MigrationImportRejection;
  suppressed?: { line_no: number; existing_event_id: string };
  accepted?: { line_no: number; row_id: string; superseded_row_id: string | null };
}

interface ImportContext {
  site: LocationRegisterEntry;
  siteId: string;
  loadId: string;
  mode: 'initial' | 'correction';
  businessDate: string;
  occurredAt: string;
  actor: Actor;
  auditCtx: AuditCtx;
  bins: Map<string, LocationRegisterEntry | null>;
  items: Map<string, ItemMaster | null>;
  seenGrains: Map<string, number>;
  seenSerials: Map<string, number>;
}

function reject(
  lineNo: number,
  raw: string,
  code: MigrationImportRejection['error_code'],
  details: Record<string, unknown>,
): RowOutcome {
  return { rejection: { line_no: lineNo, error_code: code, details, raw_row: raw } };
}

async function resolveBin(ctx: ImportContext, code: string): Promise<LocationRegisterEntry | null> {
  if (!ctx.bins.has(code)) ctx.bins.set(code, await getLocationByCode(code));
  return ctx.bins.get(code) ?? null;
}

async function resolveItem(ctx: ImportContext, sku: string): Promise<ItemMaster | null> {
  if (!ctx.items.has(sku)) ctx.items.set(sku, await getItemBySku(sku));
  return ctx.items.get(sku) ?? null;
}

/** Task 3.5: one row, checks (a) to (g) in order; the first failure decides the rejection code. */
async function processRow(
  ctx: ImportContext,
  csvRow: { line_no: number; cells: string[]; raw: string },
  expectedColumns: number,
): Promise<RowOutcome> {
  const { line_no: lineNo, raw } = csvRow;
  // (a) cell count and typed cells
  if (csvRow.cells.length !== expectedColumns) {
    return reject(lineNo, raw, 'MALFORMED_ROW', {
      column: null,
      reason: 'cell_count',
      expected: expectedColumns,
      received: csvRow.cells.length,
    });
  }
  const row: OpeningStockTemplateRowV1 = toTemplateRowV1(csvRow.cells);
  for (const column of [
    'site_code',
    'location_code',
    'sku',
    'uom',
    'stock_class',
    'pv_ref_ext',
  ] as const) {
    if (!row[column]) return reject(lineNo, raw, 'MALFORMED_ROW', { column, reason: 'empty' });
  }
  if (!NUMERIC_18_6_REGEX.test(row.quantity) || Number(row.quantity) <= 0) {
    return reject(lineNo, raw, 'MALFORMED_ROW', {
      column: 'quantity',
      reason: 'not_positive_numeric',
    });
  }
  if (row.unit_cost && !NUMERIC_18_6_REGEX.test(row.unit_cost)) {
    return reject(lineNo, raw, 'MALFORMED_ROW', { column: 'unit_cost', reason: 'not_numeric' });
  }
  if (!VALID_STOCK_CLASSES.has(row.stock_class)) {
    return reject(lineNo, raw, 'MALFORMED_ROW', {
      column: 'stock_class',
      reason: 'unknown_class',
      allowed: [...VALID_STOCK_CLASSES],
    });
  }
  if (
    row.expiry_date &&
    (!DATE_REGEX.test(row.expiry_date) || Number.isNaN(Date.parse(`${row.expiry_date}T00:00:00Z`)))
  ) {
    return reject(lineNo, raw, 'MALFORMED_ROW', { column: 'expiry_date', reason: 'not_iso_date' });
  }
  if (!DATE_REGEX.test(row.counted_on) || Number.isNaN(Date.parse(`${row.counted_on}T00:00:00Z`))) {
    return reject(lineNo, raw, 'MALFORMED_ROW', { column: 'counted_on', reason: 'not_iso_date' });
  }
  if (row.counted_on > ctx.businessDate) {
    return reject(lineNo, raw, 'MALFORMED_ROW', {
      column: 'counted_on',
      reason: 'after_business_date',
      business_date: ctx.businessDate,
    });
  }
  // (b) references
  if (row.site_code !== ctx.site.location_code) {
    return reject(lineNo, raw, 'UNKNOWN_REFERENCE', {
      reference: 'site_code',
      value: row.site_code,
      expected: ctx.site.location_code,
    });
  }
  const bin = await resolveBin(ctx, row.location_code);
  if (!bin || bin.level !== 'bin' || bin.status !== 'active' || bin.site_id !== ctx.siteId) {
    return reject(lineNo, raw, 'UNKNOWN_REFERENCE', {
      reference: 'location_code',
      value: row.location_code,
    });
  }
  const item = await resolveItem(ctx, row.sku);
  if (!item || item.status !== 'active') {
    return reject(lineNo, raw, 'UNKNOWN_REFERENCE', { reference: 'sku', value: row.sku });
  }
  if (row.uom !== item.uom) {
    return reject(lineNo, raw, 'UNKNOWN_REFERENCE', {
      reference: 'uom',
      value: row.uom,
      expected: item.uom,
    });
  }
  // (c) lot / serial presence must mirror the item flags; a serial row is one unit
  if (Boolean(row.lot_number) !== item.lot_controlled) {
    return reject(lineNo, raw, 'MALFORMED_ROW', {
      column: 'lot_number',
      reason: item.lot_controlled ? 'lot_required' : 'item_not_lot_controlled',
    });
  }
  if (Boolean(row.serial_number) !== item.serial_controlled) {
    return reject(lineNo, raw, 'MALFORMED_ROW', {
      column: 'serial_number',
      reason: item.serial_controlled ? 'serial_required' : 'item_not_serial_controlled',
    });
  }
  if (row.serial_number && Number(row.quantity) !== 1) {
    return reject(lineNo, raw, 'MALFORMED_ROW', {
      column: 'quantity',
      reason: 'serial_quantity_must_be_1',
    });
  }
  // (d) owned rows carry a cost; any other class declares one at most
  const owned = row.stock_class === 'owned';
  if (owned && !row.unit_cost) {
    return reject(lineNo, raw, 'MALFORMED_ROW', {
      column: 'unit_cost',
      reason: 'required_for_owned',
    });
  }
  const unitCost = owned ? row.unit_cost : null;
  const declaredUnitCost = owned ? null : row.unit_cost || null;
  const lotNumber = row.lot_number || null;
  const serialNumber = row.serial_number || null;
  // (e) in-file duplicates
  const grainKey = [bin.location_id, item.sku, lotNumber ?? '', serialNumber ?? ''].join('');
  const firstGrain = ctx.seenGrains.get(grainKey);
  if (firstGrain !== undefined) {
    return reject(lineNo, raw, 'DUPLICATE_LOT_SERIAL', {
      first_line_no: firstGrain,
      scope: 'grain',
    });
  }
  if (serialNumber) {
    const serialKey = `${item.sku}${serialNumber}`;
    const firstSerial = ctx.seenSerials.get(serialKey);
    if (firstSerial !== undefined) {
      return reject(lineNo, raw, 'DUPLICATE_LOT_SERIAL', {
        first_line_no: firstSerial,
        scope: 'serial',
      });
    }
    ctx.seenSerials.set(serialKey, lineNo);
  }
  ctx.seenGrains.set(grainKey, lineNo);
  // (f) already registered in the live lot or serial registers under another identity: lot_master
  // enforces a GLOBALLY unique lot_number and serial_master a unique (sku, serial), so a colliding
  // physical-count line can never post and is refused here, at import, not at promotion.
  if (lotNumber) {
    const lot = await getLotByNumberAndSku(lotNumber, item.sku);
    if (!lot) {
      const foreign = await getPool().query(
        `SELECT lot_id, sku FROM lot_master WHERE lot_number = $1 AND sku <> $2`,
        [lotNumber, item.sku],
      );
      if (foreign.rows.length > 0) {
        return reject(lineNo, raw, 'DUPLICATE_LOT_SERIAL', {
          scope: 'lot_master',
          existing_lot_id: foreign.rows[0]!['lot_id'],
          existing_sku: foreign.rows[0]!['sku'],
        });
      }
    }
  }
  if (serialNumber && (await getSerialByNumberAndSku(serialNumber, item.sku))) {
    return reject(lineNo, raw, 'DUPLICATE_LOT_SERIAL', { scope: 'serial_master' });
  }
  // (f) already-loaded live rows
  const contentHash = openingStockContentHash(csvRow.cells);
  const live = await getPool().query(
    `SELECT row_id, content_hash, status, location_id
       FROM migration_opening_stock_row
      WHERE status IN ('accepted', 'posted') AND sku = $2
        AND ((site_id = $1 AND location_id = $3 AND lot_number IS NOT DISTINCT FROM $4
              AND serial_number IS NOT DISTINCT FROM $5)
             OR ($5::text IS NOT NULL AND serial_number = $5))
      ORDER BY (location_id = $3) DESC
      LIMIT 1`,
    [ctx.siteId, item.sku, bin.location_id, lotNumber, serialNumber],
  );
  let supersedesRowId: string | null = null;
  const existing = live.rows[0] as
    { row_id: string; content_hash: string; status: string; location_id: string } | undefined;
  if (existing && existing.content_hash !== contentHash) {
    const sameGrain = existing.location_id === bin.location_id;
    if (ctx.mode === 'correction' && sameGrain && existing.status === 'accepted') {
      supersedesRowId = existing.row_id;
    } else {
      return reject(lineNo, raw, 'DUPLICATE_LOT_SERIAL', {
        existing_row_id: existing.row_id,
        existing_status: existing.status,
        scope: sameGrain ? 'grain' : 'serial',
      });
    }
  }
  // (g) persist, strict on duplicates; an identical row already loaded is suppressed, not rejected
  const rowId = randomUUID();
  const payload: MigrationOpeningStockLoadedPayload = {
    site_id: ctx.siteId,
    load_id: ctx.loadId,
    row_id: rowId,
    line_no: lineNo,
    location_id: bin.location_id,
    location_code: bin.location_code,
    sku: item.sku,
    lot_number: lotNumber,
    serial_number: serialNumber,
    stock_class: row.stock_class,
    quantity: row.quantity,
    uom: row.uom,
    unit_cost: unitCost,
    declared_unit_cost: declaredUnitCost,
    expiry_date: row.expiry_date || null,
    counted_on: row.counted_on,
    pv_ref_ext: row.pv_ref_ext,
    pv_line_ref_ext: row.pv_line_ref_ext || null,
    content_hash: contentHash,
    mode: ctx.mode,
    supersedes_row_id: supersedesRowId,
    business_date: ctx.businessDate,
  };
  try {
    await persistEvent(
      {
        stream_type: MIGRATION_STREAM_TYPE,
        stream_id: ctx.loadId,
        event_type: 'migration.opening_stock.loaded',
        payload: payload as unknown as Record<string, unknown>,
        metadata: {
          correlation_id: ctx.loadId,
          causation_id: ctx.loadId,
          actor: { user_id: ctx.actor.userId, role: ctx.actor.role, location_id: ctx.siteId },
          occurred_at: ctx.occurredAt,
        },
        idempotency_key: openingStockRowIdempotencyKey(ctx.siteId, contentHash),
      },
      ctx.auditCtx,
      undefined,
      { strictDuplicate: true },
    );
  } catch (err) {
    if (err instanceof AppError && err.errorCode === 'DUPLICATE_EVENT') {
      return {
        suppressed: {
          line_no: lineNo,
          existing_event_id: String(err.details['existing_event_id'] ?? ''),
        },
      };
    }
    throw err;
  }
  return { accepted: { line_no: lineNo, row_id: rowId, superseded_row_id: supersedesRowId } };
}

const postOpeningStockImportBase: RouteHandler = async (req, res) => {
  const body = requireObjectBody(req);
  const siteId = requireUuidField(body, 'site_id');
  const actor = requireMigrationWriteActor(req, siteId);
  const idempotencyKey = requireIdempotencyKey(body);
  const fileName = requireNonEmptyString(body, 'file_name');
  const mode = body['mode'];
  if (typeof mode !== 'string' || !IMPORT_MODES.has(mode)) {
    throw new AppError(400, 'INVALID_PARAMS', 'mode must be initial or correction', {
      field: 'mode',
    });
  }
  const csv = body['csv'];
  if (typeof csv !== 'string' || csv.length === 0) {
    throw new AppError(400, 'INVALID_PARAMS', 'csv must be a non-empty string', { field: 'csv' });
  }

  // AD-16: a replayed key returns the stored header and applies nothing.
  const replay = await loadImportHeader('idempotency_key = $1 AND site_id = $2', [
    idempotencyKey,
    siteId,
  ]);
  if (replay) {
    sendJson(res, 200, {
      ...replay,
      rejections: await listRejections(replay['load_id'] as string),
      replayed: true,
    });
    return;
  }

  // Task 3.4: a promoted site takes no further opening-stock files in either mode.
  if ((await readMigrationStage(siteId, OPENING_STOCK_DOMAIN, getPool())) === 'dry_run') {
    throw new AppError(
      409,
      MIGRATION_ERROR_CODES.STAGE_LOCKED,
      'The opening-stock domain for this site is already promoted to dry_run and takes no further files',
      { site_id: siteId, domain: OPENING_STOCK_DOMAIN, stage: 'dry_run' },
    );
  }

  const parsed = parseCsv(csv);
  const columns = assertOpeningStockTemplateHeader(body['template_version'], parsed.header);
  const dataRowCount = parsed.rows.length + parsed.errors.length;
  if (dataRowCount > MAX_OPENING_STOCK_IMPORT_ROWS) {
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'The file exceeds the import row cap', {
      max_rows: MAX_OPENING_STOCK_IMPORT_ROWS,
      max_body_bytes: MAX_IMPORT_BODY_BYTES,
      row_count: dataRowCount,
    });
  }
  if (dataRowCount === 0) {
    throw new AppError(400, 'INVALID_PARAMS', 'The file carries a header and no data rows', {
      field: 'csv',
    });
  }

  const site = await getLocationById(siteId);
  if (!site || site.level !== 'site') {
    throw new AppError(404, 'NOT_FOUND', `Site "${siteId}" is not a registered site`, {
      site_id: siteId,
    });
  }

  const now = new Date();
  const ctx: ImportContext = {
    site,
    siteId,
    loadId: randomUUID(),
    mode: mode as 'initial' | 'correction',
    businessDate: toIstCalendarDate(now),
    occurredAt: now.toISOString(),
    actor,
    auditCtx: auditCtxFor(req, actor, 201),
    bins: new Map(),
    items: new Map(),
    seenGrains: new Map(),
    seenSerials: new Map(),
  };

  const rejections: MigrationImportRejection[] = parsed.errors.map((e) => ({
    line_no: e.line_no,
    error_code: 'MALFORMED_ROW',
    details: { column: null, reason: e.reason.toLowerCase() },
    raw_row: e.raw,
  }));
  const suppressed: { line_no: number; existing_event_id: string }[] = [];
  const accepted: { line_no: number; row_id: string; superseded_row_id: string | null }[] = [];

  for (let index = 0; index < parsed.rows.length; index++) {
    const csvRow = parsed.rows[index]!;
    if (openingStockImportTestHooks.beforeRow) {
      await openingStockImportTestHooks.beforeRow(index, csvRow.line_no);
    }
    const outcome = await processRow(ctx, csvRow, columns.length);
    if (outcome.rejection) rejections.push(outcome.rejection);
    else if (outcome.suppressed) suppressed.push(outcome.suppressed);
    else if (outcome.accepted) accepted.push(outcome.accepted);
  }
  rejections.sort((a, b) => a.line_no - b.line_no);

  const summary = {
    site_id: siteId,
    load_id: ctx.loadId,
    domain: OPENING_STOCK_DOMAIN,
    file_name: fileName,
    file_sha256: fileSha256(csv),
    template_version: body['template_version'] as string,
    mode: ctx.mode,
    row_count: dataRowCount,
    accepted_count: accepted.length,
    rejected_count: rejections.length,
    suppressed_count: suppressed.length,
    superseded_count: accepted.filter((a) => a.superseded_row_id !== null).length,
    idempotency_key: idempotencyKey,
    rejections,
    business_date: ctx.businessDate,
  };
  const completed = await persistEvent(
    siteEnvelope(siteId, 'migration.import.completed', summary, actor, {
      correlation_id: ctx.loadId,
      causation_id: ctx.loadId,
      idempotency_key: `migration:import:${siteId}:${idempotencyKey}`,
      occurred_at: ctx.occurredAt,
    }),
    ctx.auditCtx,
  );
  sendJson(res, 201, {
    ...summary,
    accepted,
    suppressed,
    source_event_id: completed.event_id,
  });
};

const getOpeningStockImportBase: RouteHandler = async (req, res, params) => {
  const loadId = requireUuidParam(params, 'load_id');
  const header = await loadImportHeader('load_id = $1', [loadId]);
  if (!header)
    throw new AppError(404, 'NOT_FOUND', `Import "${loadId}" not found`, { load_id: loadId });
  requireSiteReadAccess(req, header['site_id'] as string);
  sendJson(res, 200, { ...header, rejections: await listRejections(loadId) });
};

const listOpeningStockRowsBase: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  const siteId = requireQueryUuid(url, 'site_id');
  requireSiteReadAccess(req, siteId);
  const { limit, offset } = pageParams(url);
  const status = url.searchParams.get('status');
  const sku = url.searchParams.get('sku');
  const loadId = url.searchParams.get('load_id');
  if (status !== null && !['accepted', 'superseded', 'posted'].includes(status)) {
    throw new AppError(400, 'INVALID_PARAMS', 'status must be accepted, superseded or posted', {
      status,
    });
  }
  if (loadId !== null && !isUuid(loadId)) {
    throw new AppError(400, 'INVALID_PARAMS', 'load_id must be a UUID', { load_id: loadId });
  }
  const r = await getPool().query(
    `SELECT row_id, load_id, site_id, location_id, location_code, sku, lot_number, serial_number,
            stock_class, quantity::text AS quantity, uom, unit_cost::text AS unit_cost,
            declared_unit_cost::text AS declared_unit_cost, expiry_date::text AS expiry_date,
            counted_on::text AS counted_on, pv_ref_ext, pv_line_ref_ext, line_no, content_hash, status,
            superseded_by_row_id, posted_event_id, source_event_id, occurred_at,
            business_date::text AS business_date, created_at,
            count(*) OVER () AS total_count
       FROM migration_opening_stock_row
      WHERE site_id = $1
        AND ($2::text IS NULL OR status = $2)
        AND ($3::text IS NULL OR sku = $3)
        AND ($4::uuid IS NULL OR load_id = $4)
      ORDER BY created_at, line_no
      LIMIT $5 OFFSET $6`,
    [siteId, status, sku, loadId?.toLowerCase() ?? null, limit, offset],
  );
  const total = r.rows.length > 0 ? Number(r.rows[0]!['total_count']) : 0;
  const rows = r.rows.map((row) => {
    const rest = { ...(row as Record<string, unknown>) };
    delete rest['total_count'];
    return rest;
  });
  sendJson(res, 200, { site_id: siteId, rows, limit, offset, total });
};

const listMigrationStagesBase: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  const siteId = requireQueryUuid(url, 'site_id');
  requireSiteReadAccess(req, siteId);
  const r = await getPool().query(
    `SELECT site_id, domain, stage, promoted_at, promoted_event_id, promoted_by_actor_id, posted_row_count, updated_at
       FROM migration_stage WHERE site_id = $1 ORDER BY domain`,
    [siteId],
  );
  const stages = r.rows as Record<string, unknown>[];
  if (!stages.some((s) => s['domain'] === OPENING_STOCK_DOMAIN)) {
    stages.unshift({
      site_id: siteId,
      domain: OPENING_STOCK_DOMAIN,
      stage: 'staging',
      promoted_at: null,
      promoted_event_id: null,
      promoted_by_actor_id: null,
      posted_row_count: null,
      updated_at: null,
    });
  }
  sendJson(res, 200, { site_id: siteId, stages });
};

// ---------------------------------------------------------------------------
// Variance report (Task 5.4)
// ---------------------------------------------------------------------------

const listOpeningStockVariancesBase: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  const siteId = requireQueryUuid(url, 'site_id');
  requireSiteReadAccess(req, siteId);
  const sourceSystem = url.searchParams.get('source_system');
  const status = url.searchParams.get('status');
  if (sourceSystem !== null && !['ERP', 'LEGACY'].includes(sourceSystem)) {
    throw new AppError(400, 'INVALID_PARAMS', 'source_system must be ERP or LEGACY', {
      source_system: sourceSystem,
    });
  }
  if (status !== null && !['open', 'pending_approval', 'stale', 'explained'].includes(status)) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'status must be open, pending_approval, stale or explained',
      {
        status,
      },
    );
  }
  const all = await computeOpeningStockVariances(siteId);
  const variances = all.filter(
    (v) =>
      (sourceSystem === null || v.source_system === sourceSystem) &&
      (status === null || v.status === status),
  );
  sendJson(res, 200, {
    site_id: siteId,
    variances,
    totals: summariseOpeningStockVariances(variances),
    site_totals: summariseOpeningStockVariances(all),
  });
};

// ---------------------------------------------------------------------------
// Explanations (Task 6)
// ---------------------------------------------------------------------------

const EXPLANATION_COLUMNS = `explanation_id, site_id, variance_key, source_system, cause_code, narrative,
  explained_quantity_delta::text AS explained_quantity_delta, explained_value::text AS explained_value,
  explained_by_actor_id, approver_actor_id, doa_entry_id, status, approved_at, approved_event_id,
  source_event_id, occurred_at, business_date::text AS business_date, created_at`;

async function loadExplanations(
  where: string,
  params: unknown[],
): Promise<Record<string, unknown>[]> {
  const r = await getPool().query(
    `SELECT ${EXPLANATION_COLUMNS} FROM migration_variance_explanation WHERE ${where} ORDER BY created_at`,
    params,
  );
  return r.rows as Record<string, unknown>[];
}

/**
 * The DOA-banded amount. `findMatchingDoaEntry` bands on `$2 > value_min`, so a band opened at
 * value_min = 0 (Task 8.2) does not catch an exactly-zero amount; a variance with no known cost
 * is therefore banded at the smallest positive amount so it lands in the lowest band rather than
 * in no band at all (the Story 9.10 count-adjustment defect, closed here by construction).
 */
function bandingAmount(variance: OpeningStockVariance): string {
  return Number(variance.banding_value) > 0 ? variance.banding_value : '0.01';
}

const postVarianceExplanationsBase: RouteHandler = async (req, res) => {
  const body = requireObjectBody(req);
  const siteId = requireUuidField(body, 'site_id');
  const actor = requireMigrationWriteActor(req, siteId);
  const idempotencyKey = requireIdempotencyKey(body);
  const keys = body['variance_keys'];
  if (
    !Array.isArray(keys) ||
    keys.length === 0 ||
    keys.length > 200 ||
    !keys.every((k) => typeof k === 'string' && k.trim())
  ) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'variance_keys must be a non-empty array of up to 200 strings',
      {
        field: 'variance_keys',
      },
    );
  }
  const varianceKeys = (keys as string[]).map((k) => k.trim());
  if (new Set(varianceKeys).size !== varianceKeys.length) {
    throw new AppError(400, 'INVALID_PARAMS', 'variance_keys must not repeat', {
      field: 'variance_keys',
    });
  }
  const causeCode = body['cause_code'];
  if (typeof causeCode !== 'string' || !VARIANCE_CAUSE_CODES.has(causeCode)) {
    throw new AppError(400, 'INVALID_PARAMS', 'cause_code is not a recognised variance cause', {
      field: 'cause_code',
      allowed: [...VARIANCE_CAUSE_CODES],
    });
  }
  const narrative = requireNonEmptyString(body, 'narrative');

  const eventKeys = varianceKeys.map(
    (_, i) => `migration:explain:${siteId}:${idempotencyKey}:${i}`,
  );
  const existingEvents = await getPool().query(
    `SELECT event_id, idempotency_key FROM domain_events WHERE idempotency_key = ANY($1::text[])`,
    [eventKeys],
  );
  const existingByKey = new Map<string, string>(
    existingEvents.rows.map((r) => [r['idempotency_key'] as string, r['event_id'] as string]),
  );
  if (existingByKey.size === eventKeys.length) {
    const explanations = await loadExplanations('source_event_id = ANY($1::uuid[])', [
      [...existingByKey.values()],
    ]);
    sendJson(res, 200, { site_id: siteId, explanations, replayed: true });
    return;
  }

  const variances = await computeOpeningStockVariances(siteId);
  const byKey = new Map(variances.map((v) => [v.variance_key, v]));
  const eventIds: string[] = [];
  const auditCtx = auditCtxFor(req, actor, 201);
  for (let i = 0; i < varianceKeys.length; i++) {
    const varianceKey = varianceKeys[i]!;
    const eventKey = eventKeys[i]!;
    const already = existingByKey.get(eventKey);
    if (already) {
      eventIds.push(already);
      continue;
    }
    const variance = byKey.get(varianceKey);
    if (!variance) {
      throw new AppError(
        404,
        'VARIANCE_NOT_FOUND',
        `"${varianceKey}" is not currently an opening-stock variance`,
        {
          variance_key: varianceKey,
        },
      );
    }
    if (variance.status === 'explained' || variance.status === 'pending_approval') {
      throw new AppError(
        409,
        MIGRATION_ERROR_CODES.INVALID_STATE,
        `Variance "${varianceKey}" already has a ${variance.status} explanation`,
        {
          variance_key: varianceKey,
          status: variance.status,
          explanation_id: variance.explanation_id,
        },
      );
    }
    const amount = bandingAmount(variance);
    const approval = await resolveApprover(MIGRATION_VARIANCE_EXPLANATION_DOA_TYPE, amount);
    if (!approval.approverActorId) {
      throw new AppError(
        409,
        'APPROVAL_UNRESOLVED',
        'No active DOA band governs migration.variance_explanation for this amount',
        {
          transaction_type: MIGRATION_VARIANCE_EXPLANATION_DOA_TYPE,
          value: amount,
          variance_key: varianceKey,
        },
      );
    }
    const explanationId = randomUUID();
    const persisted = await persistEvent(
      siteEnvelope(
        siteId,
        'migration.variance.explained',
        {
          site_id: siteId,
          explanation_id: explanationId,
          variance_key: varianceKey,
          source_system: variance.source_system,
          cause_code: causeCode,
          narrative,
          explained_quantity_delta: variance.quantity_delta,
          explained_value: variance.banding_value,
          approver_actor_id: approval.approverActorId,
          doa_entry_id: approval.doaEntryId,
          business_date: toIstCalendarDate(new Date()),
        },
        actor,
        { idempotency_key: eventKey },
      ),
      auditCtx,
    );
    eventIds.push(persisted.event_id);
  }
  const explanations = await loadExplanations('source_event_id = ANY($1::uuid[])', [eventIds]);
  sendJson(res, 201, { site_id: siteId, explanations });
};

const approveVarianceExplanationBase: RouteHandler = async (req, res, params) => {
  const explanationId = requireUuidParam(params, 'explanation_id');
  const body = requireObjectBody(req);
  const idempotencyKey = requireIdempotencyKey(body);
  const rows = await loadExplanations('explanation_id = $1', [explanationId]);
  const explanation = rows[0];
  if (!explanation) {
    throw new AppError(404, 'NOT_FOUND', `Explanation "${explanationId}" not found`, {
      explanation_id: explanationId,
    });
  }
  const siteId = explanation['site_id'] as string;
  const actor = requireSiteReadAccess(req, siteId);

  const eventKey = `migration:approve:${explanationId}:${idempotencyKey}`;
  const replay = await findEventByIdempotencyKey(eventKey);
  if (replay) {
    sendJson(res, 200, { explanation, replayed: true });
    return;
  }
  // The applier repeats these three checks against the locked row; they run here first so the
  // caller gets the precise refusal before an event row is attempted.
  if (explanation['status'] !== 'pending_approval') {
    throw new AppError(
      409,
      MIGRATION_ERROR_CODES.INVALID_STATE,
      `Explanation is in status "${String(explanation['status'])}", expected "pending_approval"`,
      { explanation_id: explanationId, status: explanation['status'] },
    );
  }
  if (explanation['explained_by_actor_id'] === actor.userId) {
    throw new AppError(
      403,
      MIGRATION_ERROR_CODES.EXPLAINER_CANNOT_APPROVE,
      'The actor who explained a variance cannot approve their own explanation',
      { explanation_id: explanationId },
    );
  }
  if (explanation['approver_actor_id'] !== actor.userId) {
    throw new AppError(
      403,
      MIGRATION_ERROR_CODES.APPROVAL_REQUIRED,
      'Caller is not the resolved approver frozen on this explanation',
      {
        explanation_id: explanationId,
        approver_actor_id: explanation['approver_actor_id'],
        caller_user_id: actor.userId,
      },
    );
  }
  await persistEvent(
    siteEnvelope(
      siteId,
      'migration.variance.explanation_approved',
      {
        site_id: siteId,
        explanation_id: explanationId,
        business_date: toIstCalendarDate(new Date()),
      },
      actor,
      { idempotency_key: eventKey, causation_id: explanation['source_event_id'] as string },
    ),
    auditCtxFor(req, actor, 200),
  );
  const [approved] = await loadExplanations('explanation_id = $1', [explanationId]);
  sendJson(res, 200, { explanation: approved });
};

// ---------------------------------------------------------------------------
// Promotion (Task 7.1)
// ---------------------------------------------------------------------------

const promoteOpeningStockBase: RouteHandler = async (req, res) => {
  const body = requireObjectBody(req);
  const siteId = requireUuidField(body, 'site_id');
  const actor = requireMigrationWriteActor(req, siteId);
  const idempotencyKey = requireIdempotencyKey(body);
  const eventKey = `migration:promote:${siteId}:${idempotencyKey}`;

  const replay = await findEventByIdempotencyKey(eventKey);
  if (replay) {
    const stage = await getPool().query(
      `SELECT stage, posted_row_count, promoted_at FROM migration_stage WHERE site_id = $1 AND domain = $2`,
      [siteId, OPENING_STOCK_DOMAIN],
    );
    sendJson(res, 200, {
      site_id: siteId,
      domain: OPENING_STOCK_DOMAIN,
      event_id: replay.event_id,
      stage: stage.rows[0]?.['stage'] ?? 'dry_run',
      posted_row_count: stage.rows[0]?.['posted_row_count'] ?? null,
      replayed: true,
    });
    return;
  }

  // Handler-side pre-check, on a short-lived client; the applier repeats the gate under lock.
  const pool = getPool();
  const client: PoolClient = await pool.connect();
  let acceptedRowCount = 0;
  try {
    if ((await readMigrationStage(siteId, OPENING_STOCK_DOMAIN, client)) === 'dry_run') {
      throw new AppError(
        409,
        MIGRATION_ERROR_CODES.STAGE_LOCKED,
        'The opening-stock domain for this site is already promoted to dry_run',
        { site_id: siteId, domain: OPENING_STOCK_DOMAIN, stage: 'dry_run' },
      );
    }
    const refusal = await assertOpeningStockPromotable(siteId, client);
    if (refusal) throw refusal;
    const count = await client.query(
      `SELECT count(*)::int AS n FROM migration_opening_stock_row WHERE site_id = $1 AND status = 'accepted'`,
      [siteId],
    );
    acceptedRowCount = count.rows[0]!['n'] as number;
  } finally {
    client.release();
  }

  const started = process.hrtime.bigint();
  const persisted = await persistEvent(
    siteEnvelope(
      siteId,
      'migration.stage.promoted',
      {
        site_id: siteId,
        domain: OPENING_STOCK_DOMAIN,
        from_stage: 'staging',
        to_stage: 'dry_run',
        accepted_row_count: acceptedRowCount,
        business_date: toIstCalendarDate(new Date()),
      },
      actor,
      { idempotency_key: eventKey },
    ),
    auditCtxFor(req, actor, 200),
  );
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const stage = await getPool().query(
    `SELECT stage, posted_row_count, promoted_at FROM migration_stage WHERE site_id = $1 AND domain = $2`,
    [siteId, OPENING_STOCK_DOMAIN],
  );
  sendJson(res, 200, {
    site_id: siteId,
    domain: OPENING_STOCK_DOMAIN,
    event_id: persisted.event_id,
    stage: stage.rows[0]?.['stage'] ?? 'dry_run',
    posted_row_count: stage.rows[0]?.['posted_row_count'] ?? acceptedRowCount,
    promoted_at: stage.rows[0]?.['promoted_at'] ?? null,
    duration_ms: Math.round(durationMs),
  });
};

// ---------------------------------------------------------------------------
// Exports (RBAC-wrapped)
// ---------------------------------------------------------------------------

const write = requireRole({ module: MIGRATION_MODULE, functionScope: 'write' });
const read = requireRole({ module: MIGRATION_MODULE, functionScope: 'read' });

export const postOpeningStockImportHandler: RouteHandler = write(postOpeningStockImportBase);
export const getOpeningStockImportHandler: RouteHandler = read(getOpeningStockImportBase);
export const listOpeningStockRowsHandler: RouteHandler = read(listOpeningStockRowsBase);
export const listMigrationStagesHandler: RouteHandler = read(listMigrationStagesBase);
export const listOpeningStockVariancesHandler: RouteHandler = read(listOpeningStockVariancesBase);
export const postVarianceExplanationsHandler: RouteHandler = write(postVarianceExplanationsBase);
/** Approval is gated by the DOA resolver's frozen identity, not by a role set (Task 6.3). */
export const approveVarianceExplanationHandler: RouteHandler = read(approveVarianceExplanationBase);
export const promoteOpeningStockHandler: RouteHandler = write(promoteOpeningStockBase);
