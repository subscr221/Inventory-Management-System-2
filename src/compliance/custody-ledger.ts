import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import type {
  CustodyConsumptionPostedPayload,
  CustodyOwnMaterialAddedPayload,
  CustodyLossRecordedPayload,
} from '../events/schema.js';
import { AppError } from '../middleware/error.js';
import { config } from '../config/index.js';
import { getServiceOrderById } from '../read/projections/service_order.js';
import type { ServiceOrderRow } from '../read/projections/service_order.js';
import { getBomById, getBomLines } from '../read/projections/bom.js';
import type { BomLineRow } from '../read/projections/bom.js';
import { getLocationById } from '../read/projections/location_register.js';
import { getLotByNumberAndSku } from '../read/projections/lot_master.js';
import { appendTraceEntry } from '../read/projections/lot_trace.js';
import { applyStockIssue } from '../read/projections/stock_balance.js';
import {
  insertCustodyLedgerEntry,
  customerCustodyBalance,
} from '../read/projections/custody_ledger_entry.js';
import { toIstCalendarDate } from '../lib/business-days.js';
import { applyStockBalanceProjection } from './stock-balance.js';
import { isPositiveQtyString, JOB_WORK_STOCK_CLASS } from './jobwork-receipt.js';
import {
  qtyAdd,
  qtyCompare,
  qtyFromScaled,
  qtyNegate,
  qtyToScaled,
} from './custody-statement.js';
import { resolveApprover } from '../api/v1/indents.js';

/**
 * Story 9.3: custody ledger consumption and own-material seam (FR-JW-05, FR-JW-06, FR-JW-07).
 *
 * Split like every other seam: assert* runs BEFORE any DB write (a malformed custody.* event never
 * consumes an idempotency key); apply* runs INSIDE the event transaction. Every gate (order state,
 * site, lot-under-order, kit-line match, custody balance) is re-derived here under lock, so a
 * direct POST /api/v1/events cannot bypass what the route pre-checks (the Epic 8 hold-bypass
 * lesson: route pre-checks are advisory only).
 *
 * LOCK ORDER (the 7.4 rule, identical to service-order.ts and jobwork-receipt.ts):
 *   1. pg_advisory_xact_lock(hashtextextended(service_order_id, 0)) - the SAME key as the 9.1
 *      transitions and the 9.2 receipts, so consumption serialises with both;
 *   2. the service_order row FOR UPDATE (getServiceOrderById(..., true));
 *   3. the kit BOM and its lines are plain SELECTs (AD-14, no lock-order dependency);
 *   4. stock_balance rows LAST, locked only inside applyStockIssue.
 * The custody balance SUM and the physical drain run inside the same locked transaction, so two
 * postings racing the last unit have exactly one winner (AC 4).
 */

const CUSTODY_STREAM_TYPES = new Set(['custody']);
export const CUSTODY_CONSUMPTION_POSTED = 'custody.consumption_posted';
export const CUSTODY_OWN_MATERIAL_ADDED = 'custody.own_material_added';
/** Story 9.4 (FR-JW-08): declared process loss, on the SAME custody stream (9.3 forward-declared it). */
export const CUSTODY_LOSS_RECORDED = 'custody.loss_recorded';
/** Story 9.4 (FR-JW-08): the DOA transaction type governing over-norm loss approval, the Story
 * 6.1/6.3 release-override chain verbatim (resolveApprover, forged-approver rejection, acting-user
 * check). Must be seeded in the DOA registry before the approval path is reachable - no code seeds
 * DOA entries, consistent with every other resolveApprover caller. */
export const JOBWORK_OVER_NORM_LOSS_TRANSACTION_TYPE = 'jobwork.over_norm_loss';
/** The 9.1 governed business stream code carried on every job-work lot_trace row. */
const JOB_WORK_BUSINESS_STREAM = 'job_work';

/**
 * FR-JW-06 gated door through the Story 9.2 TOTAL bar on job_work stock (stock-balance.ts). The
 * consumption applier stamps its synthetic stock.issued view with this Symbol; a JSON body arriving
 * through POST /api/v1/events or the edge upload can never carry a Symbol key, so the bar opens for
 * this seam alone without trusting a payload field. Only this module may set it.
 */
export const CUSTODY_CONSUMPTION = Symbol('custody.consumption_handoff');

export function isCustodyConsumptionHandoff(envelope: EventEnvelope): boolean {
  return (envelope as unknown as Record<symbol, unknown>)[CUSTODY_CONSUMPTION] === true;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 200;
const MAX_NOTE_LENGTH = 1000;

const CONSUMPTION_FIELDS = new Set([
  'service_order_id',
  'consumption_id',
  'sku',
  'lot_id',
  'location_id',
  'quantity',
  'uom',
  'site_id',
  'posted_by',
  'reason_note',
]);
/** Server-derived on consumption: refused on input, written back by the applier (9.2 idiom). */
const CONSUMPTION_DERIVED_FIELDS = [
  'bom_line_id',
  'kit_bom_revision_id',
  'custody_balance_after',
  'supply_source_untagged',
] as const;

const OWN_MATERIAL_FIELDS = new Set([
  'service_order_id',
  'own_material_id',
  'sku',
  'lot_id',
  'location_id',
  'quantity',
  'uom',
  'site_id',
  'posted_by',
  'bom_line_id',
]);
const OWN_MATERIAL_DERIVED_FIELDS = ['kit_bom_revision_id', 'custody_balance_after'] as const;

const LOSS_FIELDS = new Set([
  'service_order_id',
  'loss_id',
  'sku',
  'quantity',
  'uom',
  'site_id',
  'reason_code',
  'posted_by',
  'over_norm_approved',
  'approved_by',
]);
const MAX_REASON_CODE_LENGTH = 200;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

// ---------------------------------------------------------------------------
// Pure predicates (parameterised so unit tests can fail them - the 8.4 lesson)
// ---------------------------------------------------------------------------

/** The order states a custody posting may act on (AC 7): in_process only. */
export function orderAcceptsCustodyPosting(status: ServiceOrderRow['status']): boolean {
  return status === 'in_process';
}

/**
 * FR-JW-06 / FR-B-16 kit-line match for CUSTOMER consumption: a non-placeholder line for the sku
 * whose supply_source is 'customer' or NULL (untagged - not yet reconciled, treated as
 * customer-supplied and recorded as such). A line tagged 'company' or 'job_worker' is NOT
 * customer material and never matches.
 */
export function kitLineMatchesConsumption(
  line: Pick<BomLineRow, 'component_sku' | 'is_placeholder' | 'supply_source'>,
  sku: string,
): boolean {
  if (line.is_placeholder) return false;
  if (line.component_sku !== sku) return false;
  return line.supply_source === 'customer' || line.supply_source === null;
}

/**
 * FR-JW-07 optional kit-line binding for OWN material: when the processor names a kit line it
 * must be a non-placeholder line tagged 'company' or 'job_worker' (the processor's own supply).
 */
export function kitLineMatchesOwnMaterial(
  line: Pick<BomLineRow, 'is_placeholder' | 'supply_source'>,
): boolean {
  if (line.is_placeholder) return false;
  return line.supply_source === 'company' || line.supply_source === 'job_worker';
}

/** True when the customer-owned custody balance covers the requested quantity (AC 4). */
export function custodyBalanceCovers(balance: string, requested: string): boolean {
  return qtyCompare(balance, requested) >= 0;
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

function assertCommonShape(
  envelope: EventEnvelope,
  p: Record<string, unknown>,
  idField: string,
  allowed: Set<string>,
  derived: readonly string[],
): void {
  for (const field of derived) {
    if (p[field] !== undefined) {
      reject('INVALID_PARAMS', `${field} is derived by the server and must not be supplied`, {
        field,
      });
    }
  }
  for (const key of Object.keys(p)) {
    if (!allowed.has(key)) {
      reject('INVALID_PARAMS', `${key} is not a recognized field on this event`, { field: key });
    }
  }
  for (const field of ['service_order_id', idField, 'location_id', 'site_id', 'posted_by']) {
    if (!isUuid(p[field])) reject('INVALID_PARAMS', `${field} is required and must be a UUID`);
  }
  if (envelope.stream_id !== p['service_order_id']) {
    reject('INVALID_EVENT_ENVELOPE', 'stream_id must equal service_order_id', {
      stream_id: envelope.stream_id,
      service_order_id: p['service_order_id'],
    });
  }
  for (const field of ['sku', 'uom']) {
    if (!isNonEmptyString(p[field]) || (p[field] as string).trim().length > MAX_TEXT_LENGTH) {
      reject(
        'INVALID_PARAMS',
        `${field} is required and must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`,
      );
    }
    p[field] = (p[field] as string).trim();
  }
  if (!isPositiveQtyString(p['quantity'])) {
    reject(
      'INVALID_PARAMS',
      'quantity is required and must be a strictly positive NUMERIC string with at most 3 decimals',
      { field: 'quantity', value: p['quantity'] ?? null },
    );
  }
}

export function assertCustodyConsumptionShape(envelope: EventEnvelope): void {
  if (envelope.event_type !== CUSTODY_CONSUMPTION_POSTED) return;
  if (!CUSTODY_STREAM_TYPES.has(envelope.stream_type)) {
    reject('INVALID_EVENT_ENVELOPE', 'custody.* events must ride the custody stream', {
      event_type: envelope.event_type,
      stream_type: envelope.stream_type,
    });
  }
  const p = envelope.payload as Record<string, unknown>;
  assertCommonShape(envelope, p, 'consumption_id', CONSUMPTION_FIELDS, CONSUMPTION_DERIVED_FIELDS);
  // AC 3: the lot is NAMED on a consumption - the custody grain is (order, sku, lot).
  if (!isNonEmptyString(p['lot_id']) || (p['lot_id'] as string).trim().length > MAX_TEXT_LENGTH) {
    reject('INVALID_PARAMS', 'lot_id is required and must be a non-empty string');
  }
  p['lot_id'] = (p['lot_id'] as string).trim();
  if (p['reason_note'] !== undefined && p['reason_note'] !== null) {
    if (
      typeof p['reason_note'] !== 'string' ||
      (p['reason_note'] as string).length > MAX_NOTE_LENGTH
    ) {
      reject(
        'INVALID_PARAMS',
        `reason_note must be a string of at most ${MAX_NOTE_LENGTH} characters`,
      );
    }
  }
}

export function assertCustodyOwnMaterialShape(envelope: EventEnvelope): void {
  if (envelope.event_type !== CUSTODY_OWN_MATERIAL_ADDED) return;
  if (!CUSTODY_STREAM_TYPES.has(envelope.stream_type)) {
    reject('INVALID_EVENT_ENVELOPE', 'custody.* events must ride the custody stream', {
      event_type: envelope.event_type,
      stream_type: envelope.stream_type,
    });
  }
  const p = envelope.payload as Record<string, unknown>;
  assertCommonShape(
    envelope,
    p,
    'own_material_id',
    OWN_MATERIAL_FIELDS,
    OWN_MATERIAL_DERIVED_FIELDS,
  );
  if (p['lot_id'] !== undefined && p['lot_id'] !== null) {
    if (!isNonEmptyString(p['lot_id']) || (p['lot_id'] as string).trim().length > MAX_TEXT_LENGTH) {
      reject('INVALID_PARAMS', 'lot_id must be a non-empty string when supplied');
    }
    p['lot_id'] = (p['lot_id'] as string).trim();
  }
  if (p['bom_line_id'] !== undefined && p['bom_line_id'] !== null && !isUuid(p['bom_line_id'])) {
    reject('INVALID_PARAMS', 'bom_line_id must be a UUID when supplied');
  }
}

/**
 * Story 9.4 (FR-JW-08): declared process loss. No lot/location is drained here (decision: loss is
 * inputs already consumed that never became output - the custody-ledger entry IS the full
 * accounting effect), so this does NOT reuse assertCommonShape (which requires location_id).
 * over_norm_approved / approved_by are claims, re-derived and overwritten by the applier under the
 * DOA chain (the 6.3 over-completion precedent) - accepted here only so the shape check does not
 * reject them outright.
 */
export function assertCustodyLossShape(envelope: EventEnvelope): void {
  if (envelope.event_type !== CUSTODY_LOSS_RECORDED) return;
  if (!CUSTODY_STREAM_TYPES.has(envelope.stream_type)) {
    reject('INVALID_EVENT_ENVELOPE', 'custody.* events must ride the custody stream', {
      event_type: envelope.event_type,
      stream_type: envelope.stream_type,
    });
  }
  const p = envelope.payload as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!LOSS_FIELDS.has(key)) {
      reject('INVALID_PARAMS', `${key} is not a recognized field on this event`, { field: key });
    }
  }
  for (const field of ['service_order_id', 'loss_id', 'site_id', 'posted_by']) {
    if (!isUuid(p[field])) reject('INVALID_PARAMS', `${field} is required and must be a UUID`);
  }
  if (envelope.stream_id !== p['service_order_id']) {
    reject('INVALID_EVENT_ENVELOPE', 'stream_id must equal service_order_id', {
      stream_id: envelope.stream_id,
      service_order_id: p['service_order_id'],
    });
  }
  for (const field of ['sku', 'uom']) {
    if (!isNonEmptyString(p[field]) || (p[field] as string).trim().length > MAX_TEXT_LENGTH) {
      reject(
        'INVALID_PARAMS',
        `${field} is required and must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`,
      );
    }
    p[field] = (p[field] as string).trim();
  }
  if (!isPositiveQtyString(p['quantity'])) {
    reject(
      'INVALID_PARAMS',
      'quantity is required and must be a strictly positive NUMERIC string with at most 3 decimals',
      { field: 'quantity', value: p['quantity'] ?? null },
    );
  }
  if (
    typeof p['reason_code'] !== 'string' ||
    p['reason_code'].trim().length === 0 ||
    (p['reason_code'] as string).length > MAX_REASON_CODE_LENGTH
  ) {
    reject(
      'REASON_CODE_REQUIRED',
      `reason_code is required, non-blank, and at most ${MAX_REASON_CODE_LENGTH} characters`,
    );
  }
  if (p['over_norm_approved'] !== undefined && typeof p['over_norm_approved'] !== 'boolean') {
    reject('INVALID_PARAMS', 'over_norm_approved must be a boolean when supplied');
  }
  if (p['approved_by'] !== undefined && p['approved_by'] !== null && !isUuid(p['approved_by'])) {
    reject('INVALID_PARAMS', 'approved_by must be a UUID when supplied');
  }
}

// ---------------------------------------------------------------------------
// In-transaction gates (DB access)
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

/** Same key and seed as service-order.ts advisoryLock and jobwork-receipt.ts lockOrder. */
async function lockOrder(serviceOrderId: string, client: PoolClient): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [serviceOrderId]);
}

/**
 * Re-derives the order under lock and refuses fail-closed unless it is an in_process order at the
 * posting site (AC 7). SOURCE_DOCUMENT_REQUIRED for both arms (the 9.2 precedent for
 * order-not-receivable; decision 7).
 */
async function requireInProcessOrder(
  serviceOrderId: string,
  siteId: string,
  client: PoolClient,
): Promise<ServiceOrderRow> {
  await lockOrder(serviceOrderId, client);
  const order = await getServiceOrderById(serviceOrderId, client, true);
  if (!order) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      'A custody posting requires an in_process service order; none exists for service_order_id',
      { service_order_id: serviceOrderId },
      409,
    );
  }
  if (!orderAcceptsCustodyPosting(order.status)) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      `A custody posting requires an in_process service order; this order is ${order.status}`,
      { service_order_id: serviceOrderId, status: order.status },
      409,
    );
  }
  if (order.site_id !== siteId) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      'The service order belongs to a different site than the posting',
      { service_order_id: serviceOrderId, order_site_id: order.site_id, site_id: siteId },
      409,
    );
  }
  return order;
}

interface KitRevision {
  kit_bom_id: string;
  kit_bom_revision_id: string;
  lines: BomLineRow[];
}

/** Resolves the CURRENT kit BOM revision at posting time - no revision pin (decision 5). */
async function currentKitRevision(
  order: ServiceOrderRow,
  client: PoolClient,
): Promise<KitRevision | null> {
  if (!order.kit_bom_id) return null;
  const bom = await getBomById(order.kit_bom_id, client);
  if (!bom || !bom.current_revision_id) return null;
  return {
    kit_bom_id: order.kit_bom_id,
    kit_bom_revision_id: bom.current_revision_id,
    lines: await getBomLines(bom.current_revision_id, client),
  };
}

function classifyDuplicate(err: unknown, entryId: string, eventId: string): never {
  // Check WHICH constraint fired (the 9.1 review patch 7 lesson) - both are 409 DUPLICATE_EVENT
  // but the details name the colliding key.
  if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
    const constraint = (err as { constraint?: string }).constraint;
    if (constraint === 'uq_custody_ledger_source_event') {
      reject(
        'DUPLICATE_EVENT',
        'A custody ledger row already exists for this event',
        { source_event_id: eventId, constraint },
        409,
      );
    }
    if (constraint === 'custody_ledger_entry_pkey') {
      reject(
        'DUPLICATE_EVENT',
        'A custody ledger row with this id already exists',
        { entry_id: entryId, constraint },
        409,
      );
    }
  }
  throw err;
}

async function resolveLocation(
  locationId: string,
  client: PoolClient,
): Promise<{ location_id: string; location_code: string | null }> {
  const location = await getLocationById(locationId, client);
  if (!location) {
    reject('LOCATION_NOT_FOUND', 'The posting location is not registered', {
      location_id: locationId,
    });
  }
  return { location_id: location.location_id, location_code: location.location_code };
}

async function appendCustodyTrace(
  input: {
    sku: string;
    lotNumber: string;
    quantityChange: string;
    eventType: string;
    eventId: string;
    occurredAt: string;
    location: { location_id: string; location_code: string | null };
  },
  client: PoolClient,
): Promise<void> {
  // lot_trace.lot_id is the lot_master UUID; postings name the lot_number business key.
  const lot = await getLotByNumberAndSku(input.lotNumber, input.sku, client);
  if (!lot) {
    reject(
      'LOT_NOT_FOUND',
      'The named lot has no lot_master record for this sku',
      { sku: input.sku, lot_id: input.lotNumber },
      409,
    );
  }
  await appendTraceEntry(
    {
      lot_id: lot.lot_id,
      event_id: input.eventId,
      event_type: input.eventType,
      sku: input.sku,
      location_id: input.location.location_id,
      location_code: input.location.location_code,
      quantity_change: input.quantityChange,
      business_stream: JOB_WORK_BUSINESS_STREAM,
      timestamp: input.occurredAt,
    },
    client,
  );
}

// ---------------------------------------------------------------------------
// Consumption (AC 3, 4, 5, 7)
// ---------------------------------------------------------------------------

export async function applyCustodyConsumptionProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (envelope.event_type !== CUSTODY_CONSUMPTION_POSTED) return;
  if (!CUSTODY_STREAM_TYPES.has(envelope.stream_type)) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as CustodyConsumptionPostedPayload;
  const occurredAt = envelope.metadata.occurred_at ?? new Date().toISOString();

  // Gate 1 + 2: order in_process at this site (under the order lock + FOR UPDATE).
  const order = await requireInProcessOrder(p.service_order_id, p.site_id, client);

  // Gate 3: the named lot was received under THIS order for this sku (AC 7).
  const received = await client.query(
    `SELECT 1 FROM jobwork_material_receipt
      WHERE service_order_id = $1 AND sku = $2 AND lot_id = $3 LIMIT 1`,
    [order.service_order_id, p.sku, p.lot_id],
  );
  if (received.rows.length === 0) {
    reject(
      'CROSS_ISSUE_BLOCKED',
      'The named lot was not received under this service order for this sku',
      {
        service_order_id: order.service_order_id,
        sku: p.sku,
        lot_id: p.lot_id,
        demand_kind: 'custody_consumption',
      },
      409,
    );
  }

  // Gate 4: kit-line match on the CURRENT kit BOM revision (AC 5).
  const kit = await currentKitRevision(order, client);
  const line = kit?.lines.find((candidate) => kitLineMatchesConsumption(candidate, p.sku));
  if (!kit || !line) {
    reject(
      'KIT_LINE_MISMATCH',
      'The sku is not a customer-supplied line on the current revision of the order kit BOM',
      {
        service_order_id: order.service_order_id,
        kit_bom_id: order.kit_bom_id ?? null,
        kit_bom_revision_id: kit?.kit_bom_revision_id ?? null,
        sku: p.sku,
      },
      409,
    );
  }

  // Gate 5: customer custody balance covers the request (AC 4) - SUM under the same lock.
  const balance = await customerCustodyBalance(order.service_order_id, p.sku, client);
  if (!custodyBalanceCovers(balance, p.quantity)) {
    reject(
      'INSUFFICIENT_STOCK',
      'The requested quantity exceeds the customer-owned custody balance for this sku',
      {
        service_order_id: order.service_order_id,
        sku: p.sku,
        requested_qty: p.quantity,
        custody_balance_qty: balance,
      },
      409,
    );
  }

  // Physical drain through the gated door: the Story 9.2 total bar on job_work stock opens only
  // for a view carrying CUSTODY_CONSUMPTION. applyStockIssue's own INSUFFICIENT_STOCK propagates
  // for a physical shortfall in the named lot/location (also fully rolled back).
  const location = await resolveLocation(p.location_id, client);
  const stockView: EventEnvelope = {
    ...envelope,
    event_id: eventId,
    stream_type: 'inventory',
    event_type: 'stock.issued',
    payload: {
      sku: p.sku,
      target_location_id: location.location_id,
      lot_id: p.lot_id,
      quantity: p.quantity,
      stock_class: JOB_WORK_STOCK_CLASS,
      business_stream: JOB_WORK_BUSINESS_STREAM,
    },
  };
  (stockView as unknown as Record<symbol, unknown>)[CUSTODY_CONSUMPTION] = true;
  await applyStockBalanceProjection(stockView, client);

  const quantityDelta = qtyNegate(p.quantity);
  try {
    await insertCustodyLedgerEntry(
      {
        entry_id: p.consumption_id,
        service_order_id: order.service_order_id,
        customer_party_code: order.customer_party_code,
        movement_category: 'consumption',
        ownership: 'customer',
        sku: p.sku,
        lot_id: p.lot_id,
        location_id: location.location_id,
        quantity_delta: quantityDelta,
        uom: p.uom,
        billable: false,
        bom_line_id: line.bom_line_id,
        kit_bom_revision_id: kit.kit_bom_revision_id,
        receipt_id: null,
        variance_qty: null,
        variance_flagged: null,
        site_id: order.site_id,
        posted_by: p.posted_by,
        occurred_at: occurredAt,
        business_date: toIstCalendarDate(new Date(occurredAt)),
        source_event_id: eventId,
        source_event_type: CUSTODY_CONSUMPTION_POSTED,
        correlation_id: envelope.metadata.correlation_id ?? null,
      },
      client,
    );
  } catch (err: unknown) {
    classifyDuplicate(err, p.consumption_id, eventId);
  }

  await appendCustodyTrace(
    {
      sku: p.sku,
      lotNumber: p.lot_id,
      quantityChange: quantityDelta,
      eventType: CUSTODY_CONSUMPTION_POSTED,
      eventId,
      occurredAt,
      location,
    },
    client,
  );

  // The stored event carries what THIS process derived, never what the caller asserted.
  envelope.payload['bom_line_id'] = line.bom_line_id;
  envelope.payload['kit_bom_revision_id'] = kit.kit_bom_revision_id;
  envelope.payload['custody_balance_after'] = qtyAdd(balance, quantityDelta);
  if (line.supply_source === null) envelope.payload['supply_source_untagged'] = true;
}

// ---------------------------------------------------------------------------
// Own material (AC 6, 7)
// ---------------------------------------------------------------------------

export async function applyCustodyOwnMaterialProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (envelope.event_type !== CUSTODY_OWN_MATERIAL_ADDED) return;
  if (!CUSTODY_STREAM_TYPES.has(envelope.stream_type)) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as CustodyOwnMaterialAddedPayload;
  const occurredAt = envelope.metadata.occurred_at ?? new Date().toISOString();
  const lotId = p.lot_id ?? null;

  const order = await requireInProcessOrder(p.service_order_id, p.site_id, client);

  // Decision 6: NOT kit-line gated. A supplied bom_line_id is validated against the current kit
  // revision as a processor-supplied ('company' / 'job_worker') non-placeholder line.
  let kitRevisionId: string | null = null;
  if (p.bom_line_id) {
    const kit = await currentKitRevision(order, client);
    const line = kit?.lines.find((candidate) => candidate.bom_line_id === p.bom_line_id);
    if (!kit || !line || !kitLineMatchesOwnMaterial(line)) {
      reject(
        'KIT_LINE_MISMATCH',
        'bom_line_id must name a processor-supplied line on the current revision of the order kit BOM',
        {
          service_order_id: order.service_order_id,
          kit_bom_id: order.kit_bom_id ?? null,
          kit_bom_revision_id: kit?.kit_bom_revision_id ?? null,
          bom_line_id: p.bom_line_id,
          sku: p.sku,
        },
        409,
      );
    }
    kitRevisionId = kit.kit_bom_revision_id;
  }

  // The ORDINARY owned drain (default class; QC-gated lots stay invisible, as everywhere else).
  const location = await resolveLocation(p.location_id, client);
  await applyStockIssue(
    {
      sku: p.sku,
      location_id: location.location_id,
      lot_id: lotId,
      quantity: p.quantity,
      occurred_at: occurredAt,
    },
    client,
  );

  try {
    await insertCustodyLedgerEntry(
      {
        entry_id: p.own_material_id,
        service_order_id: order.service_order_id,
        customer_party_code: order.customer_party_code,
        movement_category: 'own_material',
        ownership: 'processor',
        sku: p.sku,
        lot_id: lotId,
        location_id: location.location_id,
        quantity_delta: p.quantity,
        uom: p.uom,
        billable: true,
        bom_line_id: p.bom_line_id ?? null,
        kit_bom_revision_id: kitRevisionId,
        receipt_id: null,
        variance_qty: null,
        variance_flagged: null,
        site_id: order.site_id,
        posted_by: p.posted_by,
        occurred_at: occurredAt,
        business_date: toIstCalendarDate(new Date(occurredAt)),
        source_event_id: eventId,
        source_event_type: CUSTODY_OWN_MATERIAL_ADDED,
        correlation_id: envelope.metadata.correlation_id ?? null,
      },
      client,
    );
  } catch (err: unknown) {
    classifyDuplicate(err, p.own_material_id, eventId);
  }

  if (lotId !== null) {
    await appendCustodyTrace(
      {
        sku: p.sku,
        lotNumber: lotId,
        quantityChange: qtyNegate(p.quantity),
        eventType: CUSTODY_OWN_MATERIAL_ADDED,
        eventId,
        occurredAt,
        location,
      },
      client,
    );
  }

  if (kitRevisionId !== null) envelope.payload['kit_bom_revision_id'] = kitRevisionId;
}

// ---------------------------------------------------------------------------
// Loss (AC 1, 2 - FR-JW-08)
// ---------------------------------------------------------------------------

/**
 * Cumulative customer material consumed on this order/sku to date: the sum of the ABSOLUTE value
 * of every 'consumption' and 'loss' ledger delta (both strictly negative). Exact SQL SUM, never
 * JS float (the 9.2/9.3 rule). Called under the order lock so the norm check and the insert below
 * are one serialized step.
 */
async function cumulativeConsumedForLossNorm(
  serviceOrderId: string,
  sku: string,
  client: PoolClient,
): Promise<{ consumed: string; priorLoss: string }> {
  // The norm basis is CONSUMPTION ONLY. Including prior 'loss' rows in the denominator would let
  // each accepted loss enlarge the basis for the next one - a ratchet that loosens the gate the
  // more material is lost (code review 2026-09-03, decision 1).
  const result = await client.query(
    `SELECT COALESCE(-SUM(quantity_delta) FILTER (WHERE movement_category = 'consumption'), 0)
              ::numeric(18,3)::text AS consumed,
            COALESCE(-SUM(quantity_delta) FILTER (WHERE movement_category = 'loss'), 0)
              ::numeric(18,3)::text AS prior_loss
       FROM custody_ledger_entry
      WHERE service_order_id = $1 AND sku = $2 AND movement_category IN ('consumption', 'loss')`,
    [serviceOrderId, sku],
  );
  return {
    consumed: result.rows[0]!['consumed'] as string,
    priorLoss: result.rows[0]!['prior_loss'] as string,
  };
}

/** declared / consumed as a percent, to 3 decimals - for refusal details only, never for the gate. */
export function lossPercentOf(declaredQuantity: string, cumulativeConsumed: string): string {
  const consumed = qtyToScaled(cumulativeConsumed);
  const declared = qtyToScaled(declaredQuantity);
  if (consumed <= 0n) return declared > 0n ? '100.000' : '0.000';
  return qtyFromScaled((declared * 100_000n) / consumed);
}

/**
 * True when loss / cumulative-consumed (as a percent) STRICTLY exceeds the norm (the 9.2
 * "exactly-at-boundary does not flag" convention). A zero cumulative-consumed basis with a
 * positive loss is treated as over-norm (any loss against nothing consumed cannot be within a
 * percentage norm). Exact scaled-integer arithmetic - never Number().
 *
 * `declaredQuantity` is the CUMULATIVE loss (prior loss on this order/sku plus the new
 * declaration): a per-declaration test would let ten 4-unit losses each pass a 5% norm against
 * 100 consumed, yielding 40% unapproved loss (code review 2026-09-03, decision 1).
 */
export function lossExceedsNorm(
  declaredQuantity: string,
  cumulativeConsumed: string,
  normPercent: string,
): boolean {
  const consumed = qtyToScaled(cumulativeConsumed);
  const declared = qtyToScaled(declaredQuantity);
  if (consumed <= 0n) return declared > 0n;
  // declared/consumed*100 > norm  <=>  declared*100*1000 > consumed*norm  (norm is qtyToScaled'd
  // at the SAME x1000 fixed-point as declared/consumed, so the extra x1000 on the left cancels
  // the implicit x1000 baked into `norm` - see the worked derivation in the story's Dev Notes).
  const norm = qtyToScaled(normPercent);
  return declared * 100_000n > consumed * norm;
}

export async function applyCustodyLossProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (envelope.event_type !== CUSTODY_LOSS_RECORDED) return;
  if (!CUSTODY_STREAM_TYPES.has(envelope.stream_type)) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as CustodyLossRecordedPayload;
  const occurredAt = envelope.metadata.occurred_at ?? new Date().toISOString();

  const order = await requireInProcessOrder(p.service_order_id, p.site_id, client);

  if (!config.jobwork.lossReasonCodes.includes(p.reason_code)) {
    reject(
      'JOBWORK_LOSS_REASON_CODE_INVALID',
      'The process-loss reason code is not in the configured list',
      { reason_code: p.reason_code, allowed: config.jobwork.lossReasonCodes },
      422,
    );
  }

  // The loss must be declared in the unit the sku is already carried in on this order's ledger, or
  // quantities in two different units get summed into one balance.
  const existingUomResult = await client.query(
    `SELECT uom FROM custody_ledger_entry
      WHERE service_order_id = $1 AND sku = $2 ORDER BY occurred_at ASC LIMIT 1`,
    [order.service_order_id, p.sku],
  );
  const existingUom = existingUomResult.rows[0]?.['uom'] as string | undefined;
  if (existingUom && p.uom !== existingUom) {
    reject(
      'INVALID_PARAMS',
      'The loss uom must match the uom this sku is carried in on the custody ledger',
      { service_order_id: order.service_order_id, sku: p.sku, uom: p.uom, ledger_uom: existingUom },
      400,
    );
  }

  // Gate: the declared loss must be covered by the customer custody balance for this sku, exactly
  // as the consumption path is (applyCustodyConsumptionProjection gate 5). Without it a 10,000-unit
  // loss against 10 units received is accepted and the Rule 45 statement reports a negative balance.
  const custodyBalance = await customerCustodyBalance(order.service_order_id, p.sku, client);
  if (!custodyBalanceCovers(custodyBalance, p.quantity)) {
    reject(
      'INSUFFICIENT_STOCK',
      'The declared loss exceeds the customer-owned custody balance for this sku',
      {
        service_order_id: order.service_order_id,
        sku: p.sku,
        declared_quantity: p.quantity,
        custody_balance_qty: custodyBalance,
      },
      409,
    );
  }

  const { consumed: cumulativeConsumed, priorLoss } = await cumulativeConsumedForLossNorm(
    order.service_order_id,
    p.sku,
    client,
  );
  const normPercent = config.jobwork.processLossNormPercent;
  const cumulativeLoss = qtyFromScaled(qtyToScaled(priorLoss) + qtyToScaled(p.quantity));
  const overNorm = lossExceedsNorm(cumulativeLoss, cumulativeConsumed, normPercent);

  const approvalClaimed = p.over_norm_approved === true;
  let approvedBy: string | null = null;
  if (overNorm) {
    if (!approvalClaimed) {
      reject(
        'APPROVAL_REQUIRED',
        'The declared loss exceeds the configured process-loss norm and needs supervisor approval',
        {
          service_order_id: order.service_order_id,
          sku: p.sku,
          declared_quantity: p.quantity,
          cumulative_consumed: cumulativeConsumed,
          cumulative_loss: cumulativeLoss,
          loss_percent: lossPercentOf(cumulativeLoss, cumulativeConsumed),
          norm_percent: normPercent,
        },
        403,
      );
    }
    // The Story 6.1/6.3 release-override chain verbatim (AD-12): the override authority is the
    // DOA registry, never a hard-coded role, and a forged approved_by cannot bypass it. The
    // CUMULATIVE loss is the banding value - findMatchingDoaEntry bands on `$2 > value_min`, so a
    // hard-coded 0 can only ever match the value_min IS NULL band and every over-norm loss, of any
    // size, would need only the lowest authority (code review 2026-09-03).
    const approval = await resolveApprover(
      JOBWORK_OVER_NORM_LOSS_TRANSACTION_TYPE,
      cumulativeLoss,
    );
    if (!approval.requiresApproval || approval.approverActorId === null) {
      reject(
        'APPROVAL_UNRESOLVED',
        `No DOA entry governs ${JOBWORK_OVER_NORM_LOSS_TRANSACTION_TYPE}`,
        { transaction_type: JOBWORK_OVER_NORM_LOSS_TRANSACTION_TYPE },
        404,
      );
    }
    if (p.approved_by !== approval.approverActorId) {
      reject(
        'APPROVAL_REQUIRED',
        'An over-norm loss declaration requires the resolved DOA approver',
        {
          service_order_id: order.service_order_id,
          resolved_approver_user_id: approval.approverActorId,
        },
        403,
      );
    }
    if (envelope.metadata.actor.user_id !== approval.approverActorId) {
      reject(
        'APPROVAL_REQUIRED',
        'An over-norm loss declaration requires the acting user to be the resolved DOA approver',
        {
          service_order_id: order.service_order_id,
          acting_user_id: envelope.metadata.actor.user_id,
          resolved_approver_user_id: approval.approverActorId,
        },
        403,
      );
    }
    approvedBy = approval.approverActorId;
  }
  if (!overNorm && (approvalClaimed || p.approved_by !== undefined)) {
    // Refuse rather than discard: a silently dropped claim would have the 201 echo an approver the
    // ledger never recorded.
    reject(
      'INVALID_PARAMS',
      'The declared loss is within the process-loss norm and cannot carry an approval claim',
      {
        service_order_id: order.service_order_id,
        sku: p.sku,
        cumulative_loss: cumulativeLoss,
        cumulative_consumed: cumulativeConsumed,
        norm_percent: normPercent,
      },
      400,
    );
  }
  const overNormApproved = overNorm && approvalClaimed;

  const quantityDelta = qtyNegate(p.quantity);
  try {
    await insertCustodyLedgerEntry(
      {
        entry_id: p.loss_id,
        service_order_id: order.service_order_id,
        customer_party_code: order.customer_party_code,
        movement_category: 'loss',
        ownership: 'customer',
        sku: p.sku,
        lot_id: null,
        location_id: null,
        quantity_delta: quantityDelta,
        uom: p.uom,
        billable: false,
        bom_line_id: null,
        kit_bom_revision_id: null,
        receipt_id: null,
        variance_qty: null,
        variance_flagged: null,
        site_id: order.site_id,
        posted_by: p.posted_by,
        occurred_at: occurredAt,
        business_date: toIstCalendarDate(new Date(occurredAt)),
        source_event_id: eventId,
        source_event_type: CUSTODY_LOSS_RECORDED,
        correlation_id: envelope.metadata.correlation_id ?? null,
      },
      client,
    );
  } catch (err: unknown) {
    classifyDuplicate(err, p.loss_id, eventId);
  }

  // The stored event carries what THIS process derived, never what the caller asserted.
  envelope.payload['over_norm_approved'] = overNormApproved;
  envelope.payload['approved_by'] = approvedBy;
}
