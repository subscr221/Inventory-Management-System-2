import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';
import type { EventEnvelope } from '../events/store.js';
import { logRejectionAudit, type AuditEntryPayload } from '../read/projections/audit_log.js';
import type {
  MigrationImportCompletedPayload,
  MigrationImportRejection,
  MigrationOpeningStockLoadedPayload,
  MigrationStagePromotedPayload,
  MigrationVarianceExplainedPayload,
  MigrationVarianceExplanationApprovedPayload,
} from '../events/schema.js';
import { getItemBySku } from '../read/projections/item_master.js';
import { applyStockReceipt } from '../read/projections/stock_balance.js';
import { applyLotEvent, getLotByNumberAndSku } from '../read/projections/lot_master.js';
import { applySerialReceipt, getSerialByNumberAndSku } from '../read/projections/serial_master.js';
import { appendTraceEntry } from '../read/projections/lot_trace.js';
import {
  applyValuationReceipt,
  insertFifoLayer,
  upsertSerialCost,
} from '../read/projections/inventory_valuation.js';
import { computeOpeningStockVariances } from '../read/projections/migration_variance.js';
import {
  applyMigrationDocumentProjection,
  assertMigrationDocumentEventShape,
} from './migration-documents.js';

/**
 * Story 13.1 (FR-DM-01): write-path rules for the opening-stock migration stream.
 *
 * - `assertMigrationEventShape` is PURE (no DB) and runs in persistEvent's pre-transaction seam,
 *   so a malformed migration event never consumes an idempotency key. It also refuses a
 *   `migration.*` event NAME on any stream other than 'migration' and any other event name ON the
 *   'migration' stream (the Story 8.1 foreign-stream rule), so nothing can slip a migration write
 *   past the door bars under a different stream type.
 * - `applyMigrationProjection` self-dispatches on event_type inside persistEvent's transaction. The
 *   promotion gate (VARIANCE_UNRESOLVED / STAGE_LOCKED / NOTHING_TO_PROMOTE) and the approval
 *   identity checks (APPROVAL_REQUIRED / EXPLAINER_CANNOT_APPROVE / INVALID_STATE) live HERE, not
 *   only in the HTTP handlers (Story 3.6 lesson), and every refusal self-audits through auditCtx
 *   (the Story 11.2 applier-self-audit pattern).
 *
 * Reference checks that need the database (lot present iff lot-controlled, serial present iff
 * serial-controlled, location belongs to the site, sku active) are the import ROUTE's job (Task
 * 3.5): by the time a `migration.opening_stock.loaded` event exists, its row has been resolved.
 */

export const MIGRATION_STREAM_TYPE = 'migration';
export const OPENING_STOCK_DOMAIN = 'opening_stock';
export const MIGRATION_VARIANCE_EXPLANATION_DOA_TYPE = 'migration.variance_explanation';

export const MIGRATION_EVENT_TYPES = new Set([
  'migration.opening_stock.loaded',
  'migration.import.completed',
  'migration.variance.explained',
  'migration.variance.explanation_approved',
  'migration.stage.promoted',
  // Story 13.2: document-domain verification (shape and appliers in migration-documents.ts).
  'migration.document_manifest.loaded',
  'migration.domain.verification_run',
  'migration.domain.verified',
]);

export const MIGRATION_DOMAINS_WITH_IMPORT_HEADER = new Set([
  'opening_stock',
  'active_boms',
  'open_pos',
  'jobwork_challans',
  'custody_registers',
]);

export const MIGRATION_ERROR_CODES = {
  STAGE_LOCKED: 'STAGE_LOCKED',
  VARIANCE_UNRESOLVED: 'VARIANCE_UNRESOLVED',
  NOTHING_TO_PROMOTE: 'NOTHING_TO_PROMOTE',
  EXPLAINER_CANNOT_APPROVE: 'EXPLAINER_CANNOT_APPROVE',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  INVALID_STATE: 'INVALID_STATE',
} as const;

export const VARIANCE_CAUSE_CODES = new Set([
  'legacy_unrecorded_receipt',
  'legacy_unrecorded_issue',
  'count_correction',
  'unrecorded_scrap',
  'lot_merge_or_split',
  'uom_conversion',
  'other',
]);

export const IMPORT_MODES = new Set(['initial', 'correction']);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
/** Exact NUMERIC(18,6) shape: up to 12 integer digits and up to 6 fraction digits, no sign. */
export const NUMERIC_18_6_REGEX = /^\d{1,12}(\.\d{1,6})?$/;

type AuditCtx = Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_REGEX.test(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}
function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && DATE_REGEX.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}
function isNumericString(v: unknown): v is string {
  return typeof v === 'string' && NUMERIC_18_6_REGEX.test(v);
}
function isPositiveNumericString(v: unknown): v is string {
  return isNumericString(v) && Number(v) > 0;
}
function shapeError(eventType: string, message: string, details: Record<string, unknown> = {}) {
  return new AppError(400, 'INVALID_PARAMS', message, { event_type: eventType, ...details });
}

// ---------------------------------------------------------------------------
// Pre-transaction shape assert (pure)
// ---------------------------------------------------------------------------

export function assertMigrationEventShape(envelope: EventEnvelope): void {
  const isMigrationName = envelope.event_type.startsWith('migration.');
  const isMigrationStream = envelope.stream_type === MIGRATION_STREAM_TYPE;
  if (!isMigrationName && !isMigrationStream) return;
  if (isMigrationName !== isMigrationStream || !MIGRATION_EVENT_TYPES.has(envelope.event_type)) {
    throw new AppError(
      400,
      'INVALID_EVENT_STREAM',
      `Event type "${envelope.event_type}" is not valid on stream "${envelope.stream_type}"`,
      { event_type: envelope.event_type, stream_type: envelope.stream_type },
    );
  }
  const p = envelope.payload as Record<string, unknown>;
  const type = envelope.event_type;
  if (!isUuid(p['site_id'])) throw shapeError(type, 'site_id must be a UUID');
  if (!isIsoDate(p['business_date'])) {
    throw shapeError(type, 'business_date must be YYYY-MM-DD');
  }

  // Story 13.2: the three document-domain events share the common checks above and dispatch to
  // their own pure assert; one seam entry point, nothing reordered.
  if (
    type === 'migration.document_manifest.loaded' ||
    type === 'migration.domain.verification_run' ||
    type === 'migration.domain.verified'
  ) {
    assertMigrationDocumentEventShape(envelope);
    return;
  }

  if (type === 'migration.opening_stock.loaded') {
    const q = p as Partial<MigrationOpeningStockLoadedPayload>;
    if (!isUuid(q.load_id) || q.load_id.toLowerCase() !== envelope.stream_id.toLowerCase()) {
      throw shapeError(type, 'load_id must be a UUID equal to the stream_id');
    }
    if (!isUuid(q.row_id)) throw shapeError(type, 'row_id must be a UUID');
    if (!Number.isInteger(q.line_no) || (q.line_no as number) < 2) {
      throw shapeError(type, 'line_no must be an integer >= 2');
    }
    if (!isUuid(q.location_id)) throw shapeError(type, 'location_id must be a UUID');
    for (const field of [
      'location_code',
      'sku',
      'uom',
      'stock_class',
      'pv_ref_ext',
      'content_hash',
    ]) {
      if (!isNonEmptyString(q[field as keyof typeof q])) {
        throw shapeError(type, `${field} must be a non-empty string`, { column: field });
      }
    }
    if (!isPositiveNumericString(q.quantity)) {
      throw shapeError(type, 'quantity must be a positive NUMERIC string', { column: 'quantity' });
    }
    if (q.unit_cost !== null && !isNumericString(q.unit_cost)) {
      throw shapeError(type, 'unit_cost must be a non-negative NUMERIC string or null', {
        column: 'unit_cost',
      });
    }
    if (q.declared_unit_cost !== null && !isNumericString(q.declared_unit_cost)) {
      throw shapeError(type, 'declared_unit_cost must be a NUMERIC string or null', {
        column: 'declared_unit_cost',
      });
    }
    if (q.expiry_date !== null && !isIsoDate(q.expiry_date)) {
      throw shapeError(type, 'expiry_date must be YYYY-MM-DD or null', { column: 'expiry_date' });
    }
    if (!isIsoDate(q.counted_on) || q.counted_on > (p['business_date'] as string)) {
      throw shapeError(type, 'counted_on must be YYYY-MM-DD and not after business_date', {
        column: 'counted_on',
      });
    }
    if (q.lot_number !== null && !isNonEmptyString(q.lot_number)) {
      throw shapeError(type, 'lot_number must be a non-empty string or null', {
        column: 'lot_number',
      });
    }
    if (q.serial_number !== null && !isNonEmptyString(q.serial_number)) {
      throw shapeError(type, 'serial_number must be a non-empty string or null', {
        column: 'serial_number',
      });
    }
    if (q.serial_number !== null && Number(q.quantity) !== 1) {
      throw shapeError(type, 'a serialised row must carry quantity 1', { column: 'quantity' });
    }
    if (q.pv_line_ref_ext !== null && typeof q.pv_line_ref_ext !== 'string') {
      throw shapeError(type, 'pv_line_ref_ext must be a string or null');
    }
    if (typeof q.mode !== 'string' || !IMPORT_MODES.has(q.mode)) {
      throw shapeError(type, 'mode must be initial or correction');
    }
    if (q.supersedes_row_id !== null && !isUuid(q.supersedes_row_id)) {
      throw shapeError(type, 'supersedes_row_id must be a UUID or null');
    }
    if (q.mode === 'initial' && q.supersedes_row_id !== null) {
      throw shapeError(type, 'an initial-mode row cannot supersede another row');
    }
    return;
  }

  if (type === 'migration.import.completed') {
    const q = p as Partial<MigrationImportCompletedPayload>;
    if (!isUuid(q.load_id)) throw shapeError(type, 'load_id must be a UUID');
    // Story 13.2 widened the header to the document domains; the CHECK on migration_import agrees.
    if (!MIGRATION_DOMAINS_WITH_IMPORT_HEADER.has(String(q.domain))) {
      throw shapeError(type, 'domain is not a migration domain', {
        supported: [...MIGRATION_DOMAINS_WITH_IMPORT_HEADER],
      });
    }
    for (const field of ['file_name', 'file_sha256', 'template_version', 'idempotency_key']) {
      if (!isNonEmptyString(q[field as keyof typeof q])) {
        throw shapeError(type, `${field} must be a non-empty string`);
      }
    }
    if (typeof q.mode !== 'string' || !IMPORT_MODES.has(q.mode)) {
      throw shapeError(type, 'mode must be initial or correction');
    }
    for (const field of [
      'row_count',
      'accepted_count',
      'rejected_count',
      'suppressed_count',
      'superseded_count',
    ]) {
      const v = q[field as keyof typeof q];
      if (!Number.isInteger(v) || (v as number) < 0) {
        throw shapeError(type, `${field} must be a non-negative integer`);
      }
    }
    if (!Array.isArray(q.rejections)) throw shapeError(type, 'rejections must be an array');
    for (const r of q.rejections as Partial<MigrationImportRejection>[]) {
      if (
        !Number.isInteger(r?.line_no) ||
        !['MALFORMED_ROW', 'UNKNOWN_REFERENCE', 'DUPLICATE_LOT_SERIAL'].includes(
          r?.error_code as string,
        ) ||
        typeof r?.raw_row !== 'string' ||
        typeof r?.details !== 'object' ||
        r.details === null
      ) {
        throw shapeError(type, 'each rejection needs line_no, error_code, details and raw_row');
      }
    }
    if (q.rejections.length !== q.rejected_count) {
      throw shapeError(type, 'rejected_count must equal rejections.length');
    }
    return;
  }

  if (type === 'migration.variance.explained') {
    const q = p as Partial<MigrationVarianceExplainedPayload>;
    if (!isUuid(q.explanation_id)) throw shapeError(type, 'explanation_id must be a UUID');
    if (!isNonEmptyString(q.variance_key) || q.variance_key.split('|').length !== 5) {
      throw shapeError(type, 'variance_key must have five |-separated parts');
    }
    if (!isNonEmptyString(q.source_system)) throw shapeError(type, 'source_system is required');
    if (typeof q.cause_code !== 'string' || !VARIANCE_CAUSE_CODES.has(q.cause_code)) {
      throw shapeError(type, 'cause_code is not a recognised variance cause', {
        allowed: [...VARIANCE_CAUSE_CODES],
      });
    }
    if (!isNonEmptyString(q.narrative)) throw shapeError(type, 'narrative is required');
    if (
      typeof q.explained_quantity_delta !== 'string' ||
      !/^-?\d{1,12}(\.\d{1,6})?$/.test(q.explained_quantity_delta)
    ) {
      throw shapeError(type, 'explained_quantity_delta must be a signed NUMERIC string');
    }
    if (!isNumericString(q.explained_value)) {
      throw shapeError(type, 'explained_value must be a non-negative NUMERIC string');
    }
    if (!isUuid(q.approver_actor_id)) throw shapeError(type, 'approver_actor_id must be a UUID');
    if (q.doa_entry_id !== null && !isUuid(q.doa_entry_id)) {
      throw shapeError(type, 'doa_entry_id must be a UUID or null');
    }
    return;
  }

  if (type === 'migration.variance.explanation_approved') {
    const q = p as Partial<MigrationVarianceExplanationApprovedPayload>;
    if (!isUuid(q.explanation_id)) throw shapeError(type, 'explanation_id must be a UUID');
    // Closed allowlist: nobody names an approver on the approval; the applier compares the
    // authenticated actor with the id FROZEN on the explanation row (Binding Decision 8).
    for (const forbidden of ['approver_actor_id', 'approved_by', 'approved_by_actor_id']) {
      if (p[forbidden] !== undefined) {
        throw shapeError(type, `${forbidden} is not accepted on the approval event`, {
          field: forbidden,
        });
      }
    }
    return;
  }

  if (type === 'migration.stage.promoted') {
    const q = p as Partial<MigrationStagePromotedPayload>;
    if (q.domain !== OPENING_STOCK_DOMAIN) throw shapeError(type, 'domain must be opening_stock');
    if (q.from_stage !== 'staging' || q.to_stage !== 'dry_run') {
      throw shapeError(type, 'the only supported promotion is staging to dry_run');
    }
    if (!Number.isInteger(q.accepted_row_count) || (q.accepted_row_count as number) < 0) {
      throw shapeError(type, 'accepted_row_count must be a non-negative integer');
    }
    if (
      p['site_id'] !== undefined &&
      (p['site_id'] as string).toLowerCase() !== envelope.stream_id.toLowerCase()
    ) {
      throw shapeError(type, 'site_id must equal the stream_id');
    }
  }
}

// ---------------------------------------------------------------------------
// Appliers
// ---------------------------------------------------------------------------

export async function applyMigrationProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  auditCtx?: AuditCtx,
): Promise<void> {
  if (envelope.stream_type !== MIGRATION_STREAM_TYPE) return;
  switch (envelope.event_type) {
    case 'migration.opening_stock.loaded':
      await applyOpeningStockLoaded(envelope, client, eventId, auditCtx);
      return;
    case 'migration.import.completed':
      await applyImportCompleted(envelope, client, eventId);
      return;
    case 'migration.variance.explained':
      await applyVarianceExplained(envelope, client, eventId);
      return;
    case 'migration.variance.explanation_approved':
      await applyExplanationApproved(envelope, client, eventId, auditCtx);
      return;
    case 'migration.stage.promoted':
      await applyStagePromoted(envelope, client, eventId, auditCtx);
      return;
    case 'migration.document_manifest.loaded':
    case 'migration.domain.verification_run':
    case 'migration.domain.verified':
      // Story 13.2: document-domain verification appliers live beside their shape assert.
      await applyMigrationDocumentProjection(envelope, client, eventId, auditCtx);
      return;
    default:
      return;
  }
}

async function refuse(
  err: AppError,
  auditCtx: AuditCtx | undefined,
  eventId: string | null,
): Promise<never> {
  if (auditCtx) {
    await logRejectionAudit({
      ...auditCtx,
      event_id: eventId,
      http_status: err.statusCode,
      error_code: err.errorCode,
      details: err.details,
    });
  }
  throw err;
}

/**
 * Reads (and optionally locks) the stage row for a site/domain, inserting it as 'staging' when
 * absent so a FOR UPDATE lock has a row to hold. Every writer of this table goes through here.
 */
export async function lockMigrationStage(
  siteId: string,
  domain: string,
  client: PoolClient,
): Promise<{ stage: 'staging' | 'dry_run'; posted_row_count: number | null }> {
  await client.query(
    `INSERT INTO migration_stage (site_id, domain, stage) VALUES ($1, $2, 'staging')
     ON CONFLICT (site_id, domain) DO NOTHING`,
    [siteId, domain],
  );
  const r = await client.query(
    `SELECT stage, posted_row_count FROM migration_stage WHERE site_id = $1 AND domain = $2 FOR UPDATE`,
    [siteId, domain],
  );
  const row = r.rows[0]!;
  return {
    stage: row['stage'] as 'staging' | 'dry_run',
    posted_row_count: (row['posted_row_count'] as number | null) ?? null,
  };
}

export async function readMigrationStage(
  siteId: string,
  domain: string,
  client: Pick<PoolClient, 'query'>,
): Promise<'staging' | 'dry_run'> {
  const r = await client.query(
    `SELECT stage FROM migration_stage WHERE site_id = $1 AND domain = $2`,
    [siteId, domain],
  );
  return (r.rows[0]?.['stage'] as 'staging' | 'dry_run' | undefined) ?? 'staging';
}

function stageLockedError(siteId: string): AppError {
  return new AppError(
    409,
    MIGRATION_ERROR_CODES.STAGE_LOCKED,
    'The opening-stock domain for this site is already promoted to dry_run and takes no further staging writes',
    { site_id: siteId, domain: OPENING_STOCK_DOMAIN, stage: 'dry_run' },
  );
}

async function applyOpeningStockLoaded(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  auditCtx?: AuditCtx,
): Promise<void> {
  const p = envelope.payload as unknown as MigrationOpeningStockLoadedPayload;
  // The stage gate lives in the applier as well as the route (Story 3.6 lesson).
  const stage = await lockMigrationStage(p.site_id, OPENING_STOCK_DOMAIN, client);
  if (stage.stage === 'dry_run') await refuse(stageLockedError(p.site_id), auditCtx, null);

  if (p.mode === 'correction' && p.supersedes_row_id) {
    const superseded = await client.query(
      `UPDATE migration_opening_stock_row
          SET status = 'superseded', superseded_by_row_id = $2
        WHERE row_id = $1 AND site_id = $3 AND status = 'accepted'
          AND location_id = $4 AND sku = $5
          AND lot_number IS NOT DISTINCT FROM $6
          AND serial_number IS NOT DISTINCT FROM $7
        RETURNING row_id`,
      [
        p.supersedes_row_id,
        p.row_id,
        p.site_id,
        p.location_id,
        p.sku,
        p.lot_number,
        p.serial_number,
      ],
    );
    if (superseded.rows.length === 0) {
      await refuse(
        new AppError(
          409,
          MIGRATION_ERROR_CODES.INVALID_STATE,
          'The row this correction supersedes is no longer a live accepted row',
          { supersedes_row_id: p.supersedes_row_id },
        ),
        auditCtx,
        null,
      );
    }
  }

  // uq_migration_os_row_live is the last line of defence against two live rows on one grain; a
  // violation here is a bug in the route's duplicate handling and surfaces as a 500 by design.
  await client.query(
    `INSERT INTO migration_opening_stock_row (
       row_id, load_id, site_id, location_id, location_code, sku, lot_number, serial_number,
       stock_class, quantity, uom, unit_cost, declared_unit_cost, expiry_date, counted_on,
       pv_ref_ext, pv_line_ref_ext, line_no, content_hash, status, source_event_id,
       source_event_type, occurred_at, business_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11, $12::numeric, $13::numeric,
             $14::date, $15::date, $16, $17, $18, $19, 'accepted', $20, $21, $22::timestamptz, $23::date)`,
    [
      p.row_id,
      p.load_id,
      p.site_id,
      p.location_id,
      p.location_code,
      p.sku,
      p.lot_number,
      p.serial_number,
      p.stock_class,
      p.quantity,
      p.uom,
      p.unit_cost,
      p.declared_unit_cost,
      p.expiry_date,
      p.counted_on,
      p.pv_ref_ext,
      p.pv_line_ref_ext,
      p.line_no,
      p.content_hash,
      eventId,
      envelope.event_type,
      envelope.metadata.occurred_at,
      p.business_date,
    ],
  );
}

async function applyImportCompleted(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as unknown as MigrationImportCompletedPayload;
  const inserted = await client.query(
    `INSERT INTO migration_import (
       load_id, site_id, domain, file_name, file_sha256, template_version, mode, row_count,
       accepted_count, rejected_count, suppressed_count, superseded_count, idempotency_key,
       created_by_actor_id, source_event_id, source_event_type, occurred_at, business_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::timestamptz, $18::date)
     ON CONFLICT (load_id) DO NOTHING
     RETURNING load_id`,
    [
      p.load_id,
      p.site_id,
      p.domain,
      p.file_name,
      p.file_sha256,
      p.template_version,
      p.mode,
      p.row_count,
      p.accepted_count,
      p.rejected_count,
      p.suppressed_count,
      p.superseded_count,
      p.idempotency_key,
      envelope.metadata.actor.user_id,
      eventId,
      envelope.event_type,
      envelope.metadata.occurred_at,
      p.business_date,
    ],
  );
  if (inserted.rows.length === 0) return;
  for (const rejection of p.rejections) {
    await client.query(
      `INSERT INTO migration_import_rejection (rejection_id, load_id, line_no, error_code, details, raw_row)
       VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb, $5)`,
      [
        p.load_id,
        rejection.line_no,
        rejection.error_code,
        JSON.stringify(rejection.details ?? {}),
        rejection.raw_row,
      ],
    );
  }
}

async function applyVarianceExplained(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as unknown as MigrationVarianceExplainedPayload;
  await client.query(
    `INSERT INTO migration_variance_explanation (
       explanation_id, site_id, variance_key, source_system, cause_code, narrative,
       explained_quantity_delta, explained_value, explained_by_actor_id, approver_actor_id,
       doa_entry_id, status, source_event_id, occurred_at, business_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9, $10, $11, 'pending_approval', $12, $13::timestamptz, $14::date)`,
    [
      p.explanation_id,
      p.site_id,
      p.variance_key,
      p.source_system,
      p.cause_code,
      p.narrative,
      p.explained_quantity_delta,
      p.explained_value,
      envelope.metadata.actor.user_id,
      p.approver_actor_id,
      p.doa_entry_id,
      eventId,
      envelope.metadata.occurred_at,
      p.business_date,
    ],
  );
}

async function applyExplanationApproved(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  auditCtx?: AuditCtx,
): Promise<void> {
  const p = envelope.payload as unknown as MigrationVarianceExplanationApprovedPayload;
  const actorId = envelope.metadata.actor.user_id;
  const r = await client.query(
    `SELECT explanation_id, site_id, variance_key, status, explained_by_actor_id, approver_actor_id
       FROM migration_variance_explanation WHERE explanation_id = $1 AND site_id = $2 FOR UPDATE`,
    [p.explanation_id, p.site_id],
  );
  const row = r.rows[0];
  if (!row) {
    await refuse(
      new AppError(404, 'NOT_FOUND', `Explanation "${p.explanation_id}" not found for this site`, {
        explanation_id: p.explanation_id,
      }),
      auditCtx,
      null,
    );
  }
  const status = row!['status'] as string;
  if (status !== 'pending_approval') {
    await refuse(
      new AppError(
        409,
        MIGRATION_ERROR_CODES.INVALID_STATE,
        `Explanation is in status "${status}", expected "pending_approval"`,
        { explanation_id: p.explanation_id, status },
      ),
      auditCtx,
      null,
    );
  }
  // Maker-checker first, then authority: the explainer never approves their own explanation even
  // when the DOA resolver happened to name them.
  if ((row!['explained_by_actor_id'] as string) === actorId) {
    await refuse(
      new AppError(
        403,
        MIGRATION_ERROR_CODES.EXPLAINER_CANNOT_APPROVE,
        'The actor who explained a variance cannot approve their own explanation',
        { explanation_id: p.explanation_id },
      ),
      auditCtx,
      null,
    );
  }
  if ((row!['approver_actor_id'] as string) !== actorId) {
    await refuse(
      new AppError(
        403,
        MIGRATION_ERROR_CODES.APPROVAL_REQUIRED,
        'Caller is not the resolved approver frozen on this explanation',
        {
          explanation_id: p.explanation_id,
          approver_actor_id: row!['approver_actor_id'],
          caller_user_id: actorId,
        },
      ),
      auditCtx,
      null,
    );
  }
  // One approved explanation per key: an earlier approved (now stale) explanation is flipped to
  // superseded in the same transaction so the partial unique index and the history both hold.
  await client.query(
    `UPDATE migration_variance_explanation SET status = 'superseded'
      WHERE site_id = $1 AND variance_key = $2 AND status = 'approved' AND explanation_id <> $3`,
    [p.site_id, row!['variance_key'], p.explanation_id],
  );
  await client.query(
    `UPDATE migration_variance_explanation
        SET status = 'approved', approved_at = $2::timestamptz, approved_event_id = $3
      WHERE explanation_id = $1`,
    [p.explanation_id, envelope.metadata.occurred_at, eventId],
  );
}

/**
 * Task 7.1 / 7.2: the promotion gate and the one-shot ledger posting. Runs inside persistEvent's
 * transaction, so the stage row, every stock_balance / lot_master / serial_master / valuation /
 * lot_trace write, every row status flip and the domain_events insert commit or roll back
 * together.
 */
async function applyStagePromoted(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  auditCtx?: AuditCtx,
): Promise<void> {
  const p = envelope.payload as unknown as MigrationStagePromotedPayload;
  const siteId = p.site_id;

  const stage = await lockMigrationStage(siteId, OPENING_STOCK_DOMAIN, client);
  if (stage.stage === 'dry_run') await refuse(stageLockedError(siteId), auditCtx, null);

  const gate = await assertOpeningStockPromotable(siteId, client);
  if (gate) await refuse(gate, auditCtx, null);

  const rows = await client.query(
    `SELECT row_id, location_id, location_code, sku, lot_number, serial_number, stock_class,
            quantity::text AS quantity, unit_cost::text AS unit_cost, expiry_date::text AS expiry_date,
            source_event_id, occurred_at
       FROM migration_opening_stock_row
      WHERE site_id = $1 AND status = 'accepted'
      ORDER BY line_no, created_at
      FOR UPDATE`,
    [siteId],
  );

  const itemCache = new Map<string, Awaited<ReturnType<typeof getItemBySku>>>();
  let posted = 0;
  for (const row of rows.rows) {
    const sku = row['sku'] as string;
    let item = itemCache.get(sku);
    if (item === undefined) {
      item = await getItemBySku(sku, client);
      itemCache.set(sku, item);
    }
    if (!item || item.status !== 'active') {
      await refuse(
        new AppError(
          409,
          !item ? 'ITEM_NOT_FOUND' : 'ITEM_INACTIVE',
          !item
            ? `Item "${sku}" no longer exists in item_master`
            : `Item "${sku}" is no longer active in item_master`,
          { sku, row_id: row['row_id'], status: item?.status ?? null },
        ),
        auditCtx,
        null,
      );
    }
    const quantity = row['quantity'] as string;
    const lotNumber = (row['lot_number'] as string | null) ?? null;
    const serialNumber = (row['serial_number'] as string | null) ?? null;
    const stockClass = row['stock_class'] as string;
    const locationId = row['location_id'] as string;
    const locationCode = row['location_code'] as string;
    const sourceEventId = row['source_event_id'] as string;
    const occurredAt =
      row['occurred_at'] instanceof Date
        ? (row['occurred_at'] as Date).toISOString()
        : String(row['occurred_at']);

    // stock_balance.lot_id holds the lot NUMBER (the 2026-09-05 noise-floor trap).
    await applyStockReceipt(
      {
        sku,
        location_id: locationId,
        location_code: locationCode,
        lot_id: lotNumber,
        stock_class: stockClass,
        quantity,
      },
      client,
    );

    let lotUuid: string | null = null;
    if (item!.lot_controlled && lotNumber) {
      const created = await applyLotEvent(
        { lot_number: lotNumber, sku, expiry_date: (row['expiry_date'] as string | null) ?? null },
        client,
      );
      const lot = created ?? (await getLotByNumberAndSku(lotNumber, sku, client));
      if (!lot) {
        // lot_master.lot_number is globally unique: the number is already registered under
        // another sku. The physical count named it, so this is a data defect to surface, not
        // to paper over.
        await refuse(
          new AppError(
            409,
            'DUPLICATE_LOT',
            `Lot number "${lotNumber}" is already registered under a different sku`,
            { lot_number: lotNumber, sku, row_id: row['row_id'] },
          ),
          auditCtx,
          null,
        );
      }
      lotUuid = lot!.lot_id;
    }

    if (item!.serial_controlled && serialNumber) {
      const existing = await getSerialByNumberAndSku(serialNumber, sku, client);
      if (existing) {
        await refuse(
          new AppError(
            409,
            'DUPLICATE_SERIAL',
            `Serial "${serialNumber}" is already registered for sku "${sku}"`,
            { serial_number: serialNumber, sku, row_id: row['row_id'] },
          ),
          auditCtx,
          null,
        );
      }
      // serial_master.lot_id is ALSO the lot number, not the UUID.
      await applySerialReceipt(
        {
          serial_number: serialNumber,
          sku,
          lot_id: lotNumber,
          current_location_id: locationId,
          current_location_code: locationCode,
          current_quantity: quantity,
        },
        client,
      );
    }

    const unitCost = (row['unit_cost'] as string | null) ?? null;
    if (stockClass === 'owned' && unitCost !== null) {
      const qtyNumber = Number(quantity);
      const costNumber = Number(unitCost);
      await applyValuationReceipt(sku, qtyNumber, costNumber, client);
      if (item!.valuation_method === 'fifo') {
        await insertFifoLayer(
          { sku, unit_cost: costNumber, quantity: qtyNumber, event_id: sourceEventId },
          client,
        );
      } else if (item!.valuation_method === 'specific_identification' && serialNumber) {
        await upsertSerialCost({ sku, serial_number: serialNumber, unit_cost: costNumber }, client);
      }
    }

    if (lotUuid) {
      // One origin row per lot, keyed on the row's OWN load event so genealogy points at the
      // physical count that created the lot (idx_lot_trace_event_id is unique on event_id).
      await appendTraceEntry(
        {
          lot_id: lotUuid,
          event_id: sourceEventId,
          event_type: 'migration.opening_stock.loaded',
          sku,
          location_id: locationId,
          location_code: locationCode,
          quantity_change: quantity,
          business_stream: item!.business_stream,
          timestamp: occurredAt,
        },
        client,
      );
    }

    await client.query(
      `UPDATE migration_opening_stock_row SET status = 'posted', posted_event_id = $2 WHERE row_id = $1`,
      [row['row_id'], eventId],
    );
    posted += 1;
  }

  await client.query(
    `UPDATE migration_stage
        SET stage = 'dry_run', promoted_at = $3::timestamptz, promoted_event_id = $4,
            promoted_by_actor_id = $5, posted_row_count = $6, updated_at = now()
      WHERE site_id = $1 AND domain = $2`,
    [
      siteId,
      OPENING_STOCK_DOMAIN,
      envelope.metadata.occurred_at,
      eventId,
      envelope.metadata.actor.user_id,
      posted,
    ],
  );
}

/**
 * The promotion gate proper, shared by the route (pre-check) and the applier (the check that
 * counts). Returns the refusal to raise, or null when the site may promote.
 */
export async function assertOpeningStockPromotable(
  siteId: string,
  client: PoolClient,
): Promise<AppError | null> {
  const variances = await computeOpeningStockVariances(siteId, client);
  const unexplained = variances.filter((v) => v.status !== 'explained');
  if (unexplained.length > 0) {
    return new AppError(
      409,
      MIGRATION_ERROR_CODES.VARIANCE_UNRESOLVED,
      `${unexplained.length} opening-stock variance(s) are not explained`,
      {
        site_id: siteId,
        unexplained: unexplained.map((v) => ({
          variance_key: v.variance_key,
          kind: v.kind,
          quantity_delta: v.quantity_delta,
          variance_value: v.variance_value,
          status: v.status,
        })),
      },
    );
  }
  const count = await client.query(
    `SELECT count(*)::int AS n FROM migration_opening_stock_row WHERE site_id = $1 AND status = 'accepted'`,
    [siteId],
  );
  if ((count.rows[0]!['n'] as number) === 0) {
    return new AppError(
      409,
      MIGRATION_ERROR_CODES.NOTHING_TO_PROMOTE,
      'There are no accepted opening-stock rows to promote for this site',
      { site_id: siteId },
    );
  }
  return null;
}
