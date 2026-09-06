import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import type {
  CustodyConsumptionPostedPayload,
  CustodyOwnMaterialAddedPayload,
  CustodyLossRecordedPayload,
  CustodyReturnRecordedPayload,
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
import { qtyAdd, qtyCompare, qtyFromScaled, qtyNegate, qtyToScaled } from './custody-statement.js';
import { resolveApprover } from '../api/v1/indents.js';
import { reconcileReturnClocks } from './jobwork-return-clock.js';

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
/**
 * Story 9.5 (FR-AC-11, Binding decision 2): unconsumed customer material returned to the principal,
 * on the SAME custody stream (9.3 forward-declared the `return` category; this story builds it).
 */
export const CUSTODY_RETURN_RECORDED = 'custody.return_recorded';
/**
 * Story 9.6 (FR-JW-09/10, Binding decision 1): execution of the offcut election, ONE event with
 * three branches switched on service_order.offcut_election under the order lock. The constant and
 * the shape assert live here so every custody.* name stays in one place; the applier lives in
 * jobwork-offcut.ts (this file already carries four appliers).
 */
export const CUSTODY_OFFCUT_RECORDED = 'custody.offcut_recorded';
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

/**
 * Story 9.5 (FR-AC-11): the SECOND gated door through the 9.2 total bar, on the identical Symbol
 * mechanism, opened only by applyCustodyReturnProjection after the order, the lot-under-order, the
 * custody balance and the mandatory return challan number are re-derived under the order lock.
 */
export const CUSTODY_RETURN = Symbol('custody.return_handoff');

export function isCustodyReturnHandoff(envelope: EventEnvelope): boolean {
  return (envelope as unknown as Record<symbol, unknown>)[CUSTODY_RETURN] === true;
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

/** Story 9.5: the closed return shape. return_challan_number_ext is MANDATORY (see the assert). */
const RETURN_FIELDS = new Set([
  'service_order_id',
  'return_id',
  'sku',
  'lot_id',
  'location_id',
  'quantity',
  'uom',
  'site_id',
  'return_challan_number_ext',
  'posted_by',
]);
const RETURN_DERIVED_FIELDS = ['custody_balance_after'] as const;

/**
 * Story 9.6: the closed offcut shape. return_challan_number_ext is mandatory on the `return`
 * branch ONLY, offcut_rate_estimate is the real-time settlement rate on `retain_and_buy` only
 * (PO ruling 2026-09-05 on open question 6: the estimate IS the settlement rate, no DOA gate; the
 * order's contracted rate is the reference stamped beside it), settles_offcut is the settlement
 * declaration (Binding decision 15) - all three are branch-checked by the applier, which alone
 * knows the election.
 */
const OFFCUT_FIELDS = new Set([
  'service_order_id',
  'offcut_id',
  'sku',
  'lot_id',
  'location_id',
  'quantity',
  'uom',
  'site_id',
  'posted_by',
]);
/** Server-derived on an offcut: the election is never named by the caller (Binding decision 1). */
export const OFFCUT_DERIVED_FIELDS = [
  'custody_balance_after',
  'offcut_lot_id',
  'offcut_lot_number',
] as const;
// The 9.6 Task 0 rate shape (service-order.ts OFFCUT_RATE_REGEX): at most four decimals.
const OFFCUT_RATE_ESTIMATE_REGEX = /^\d{1,14}(\.\d{1,4})?$/;

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
 * Story 9.5 code review (chunk 2): the states a RETURN may act on. Identical to
 * `orderAcceptsCustodyPosting` today, and deliberately kept as its own predicate.
 *
 * The review asked for this to be widened so a cancelled order could drain its leftover customer
 * material instead of being forced to book it as `loss` - the case the applier's own docstring used
 * to cite as its motivation. There is no such state to widen to: `chk_service_order_status` admits
 * only draft, confirmed, in_process and closed (`read/projections/service_order.sql:45`), and the
 * Story 9.1 transition matrix has no cancellation path, so a cancelled job-work order cannot exist.
 * `closed` stays barred on its own merits - it passed the AC8 zero-balance gate, so it has nothing
 * left to return, and re-opening its balance would strand it with no route to re-close.
 *
 * This predicate is the seam where a future cancellation state plugs in without loosening the gate
 * for consumption, own-material or loss.
 */
export function orderAcceptsCustodyReturn(status: ServiceOrderRow['status']): boolean {
  return orderAcceptsCustodyPosting(status);
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

/**
 * Story 9.5 (FR-AC-11, Binding decision 2): a return of unconsumed customer material. Same closed
 * shape discipline as consumption (lot NAMED, location NAMED - the drain needs the grain). The
 * return challan number is mandatory and non-blank: goods leaving the job worker without a
 * delivery challan is a GST offence, not a paperwork nit, and the field is named `challan`, not
 * `reference`, so nobody reads it as optional decoration. Rendering is Story 9.6's return-challan
 * renderer by name; 9.5 records the number of the paper challan that already exists.
 */
export function assertCustodyReturnShape(envelope: EventEnvelope): void {
  if (envelope.event_type !== CUSTODY_RETURN_RECORDED) return;
  if (!CUSTODY_STREAM_TYPES.has(envelope.stream_type)) {
    reject('INVALID_EVENT_ENVELOPE', 'custody.* events must ride the custody stream', {
      event_type: envelope.event_type,
      stream_type: envelope.stream_type,
    });
  }
  const p = envelope.payload as Record<string, unknown>;
  assertCommonShape(envelope, p, 'return_id', RETURN_FIELDS, RETURN_DERIVED_FIELDS);
  if (!isNonEmptyString(p['lot_id']) || (p['lot_id'] as string).trim().length > MAX_TEXT_LENGTH) {
    reject('INVALID_PARAMS', 'lot_id is required and must be a non-empty string');
  }
  p['lot_id'] = (p['lot_id'] as string).trim();
  if (
    !isNonEmptyString(p['return_challan_number_ext']) ||
    (p['return_challan_number_ext'] as string).trim().length > MAX_TEXT_LENGTH
  ) {
    reject(
      'INVALID_PARAMS',
      `return_challan_number_ext is required and must be the non-blank delivery challan number the material leaves under (at most ${MAX_TEXT_LENGTH} characters)`,
      { field: 'return_challan_number_ext' },
    );
  }
  p['return_challan_number_ext'] = (p['return_challan_number_ext'] as string).trim();
}

/**
 * Story 9.6 Task 1.3 (FR-JW-09/10): the offcut posting, modelled line for line on the return shape.
 * The lot and location are NAMED (the drain needs the grain). Nothing here knows the election:
 * whether the challan number is required, whether an override is even permitted, is the applier's
 * call under the order lock. Every derived field is refused on input.
 */
export function assertCustodyOffcutShape(envelope: EventEnvelope): void {
  if (envelope.event_type !== CUSTODY_OFFCUT_RECORDED) return;
  if (!CUSTODY_STREAM_TYPES.has(envelope.stream_type)) {
    reject('INVALID_EVENT_ENVELOPE', 'custody.* events must ride the custody stream', {
      event_type: envelope.event_type,
      stream_type: envelope.stream_type,
    });
  }
  const p = envelope.payload as Record<string, unknown>;
  assertCommonShape(envelope, p, 'offcut_id', OFFCUT_FIELDS, OFFCUT_DERIVED_FIELDS);
  if (!isNonEmptyString(p['lot_id']) || (p['lot_id'] as string).trim().length > MAX_TEXT_LENGTH) {
    reject('INVALID_PARAMS', 'lot_id is required and must be a non-empty string');
  }
  p['lot_id'] = (p['lot_id'] as string).trim();
  if (p['return_challan_number_ext'] !== undefined && p['return_challan_number_ext'] !== null) {
    if (
      !isNonEmptyString(p['return_challan_number_ext']) ||
      (p['return_challan_number_ext'] as string).trim().length > MAX_TEXT_LENGTH
    ) {
      reject(
        'INVALID_PARAMS',
        `return_challan_number_ext must be a non-blank delivery challan number of at most ${MAX_TEXT_LENGTH} characters when supplied`,
        { field: 'return_challan_number_ext' },
      );
    }
    p['return_challan_number_ext'] = (p['return_challan_number_ext'] as string).trim();
  }
  if (p['offcut_rate_estimate'] !== undefined && p['offcut_rate_estimate'] !== null) {
    // An exact decimal STRING, never a number literal (the receiptTolerancePercent convention), so
    // the billable value settles in scaled-integer arithmetic.
    if (
      typeof p['offcut_rate_estimate'] !== 'string' ||
      !OFFCUT_RATE_ESTIMATE_REGEX.test(p['offcut_rate_estimate']) ||
      !/[1-9]/.test(p['offcut_rate_estimate'])
    ) {
      reject(
        'INVALID_PARAMS',
        'offcut_rate_estimate must be a strictly positive exact decimal string with at most four decimals',
        { field: 'offcut_rate_estimate', value: p['offcut_rate_estimate'] },
      );
    }
  }
  if (p['settles_offcut'] !== undefined && typeof p['settles_offcut'] !== 'boolean') {
    reject('INVALID_PARAMS', 'settles_offcut must be a boolean when supplied');
  }
}

// ---------------------------------------------------------------------------
// In-transaction gates (DB access)
// ---------------------------------------------------------------------------

/**
 * Story 9.6: the in-transaction helpers below are EXPORTED so jobwork-offcut.ts can reuse the
 * exact gates the return applier runs (order-under-lock, duplicate classification, location
 * resolution, the lot_trace append) instead of carrying a second copy of each.
 */
export async function alreadyPersisted(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<boolean> {
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
export async function requireInProcessOrder(
  serviceOrderId: string,
  siteId: string,
  client: PoolClient,
  // Story 9.5 code review (chunk 2): the state predicate is a parameter so the return path can
  // widen it (orderAcceptsCustodyReturn) without loosening the gate for every other category.
  acceptsState: (status: ServiceOrderRow['status']) => boolean = orderAcceptsCustodyPosting,
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
  if (!acceptsState(order.status)) {
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

export function classifyDuplicate(err: unknown, entryId: string, eventId: string): never {
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

export async function resolveLocation(
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

export async function appendCustodyTrace(
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
      WHERE service_order_id = $1 AND sku = $2 AND ownership = 'customer'
      ORDER BY occurred_at ASC LIMIT 1`,
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
    const approval = await resolveApprover(JOBWORK_OVER_NORM_LOSS_TRANSACTION_TYPE, cumulativeLoss);
    if (!approval.requiresApproval || approval.approverActorId === null) {
      reject(
        'APPROVAL_UNRESOLVED',
        `No DOA entry governs ${JOBWORK_OVER_NORM_LOSS_TRANSACTION_TYPE}`,
        { transaction_type: JOBWORK_OVER_NORM_LOSS_TRANSACTION_TYPE },
        409,
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

  // Story 9.5 (Binding decision 6): loss is Section 143(5) accounted waste - it moves the clock's
  // SEPARATE loss_qty counter (reported in its own ITC-04 column), never reconciled_qty and never
  // deemed supply. Non-strict for the same reason dispatch is: the loss is bounded by the RECEIVED
  // balance, which may exceed the challan.
  const lossReconciled = await reconcileReturnClocks(
    {
      serviceOrderId: order.service_order_id,
      sku: p.sku,
      quantity: p.quantity,
      counter: 'loss_qty',
      category: 'loss',
      strict: false,
    },
    client,
  );
  if (qtyToScaled(lossReconciled.unallocated) > 0n) {
    console.warn(
      `custody loss ${p.loss_id}: ${lossReconciled.unallocated} of ${p.quantity} ${p.sku} had no return-clock capacity on order ${order.service_order_id} (over-tolerance receipt); the loss is recorded in full and the clock accounting is short by that amount`,
    );
  }

  // The stored event carries what THIS process derived, never what the caller asserted.
  envelope.payload['over_norm_approved'] = overNormApproved;
  envelope.payload['approved_by'] = approvedBy;
}

// ---------------------------------------------------------------------------
// Return (Story 9.5, FR-AC-11 - the honest drain for unconsumed customer material)
// ---------------------------------------------------------------------------

/**
 * Story 9.5 Task 1.4. Same lock order as every custody applier: order advisory lock, order row FOR
 * UPDATE, plain reads, stock_balance rows inside applyStockBalanceProjection, clock rows LAST.
 * Gates, all re-derived here so a direct POST /api/v1/events meets the identical wall: order
 * in_process at this site (SOURCE_DOCUMENT_REQUIRED), the lot was received under THIS order for
 * this sku (CROSS_ISSUE_BLOCKED), the uom matches the sku's ledger uom (INVALID_PARAMS), and the
 * customer custody balance covers the quantity (INSUFFICIENT_STOCK). Then the physical drain through
 * the CUSTODY_RETURN door, the negative `return` ledger row, the lot_trace entry, and the CAPPED
 * clock reconciliation, CAPPED at the outstanding challan capacity (Story 9.5 code review chunk 2 -
 * see the call site for why strict mode was fail-open on the ledger). Without this path a short
 * order could only drain leftover customer material by booking it as `loss` with an invented reason
 * code (the Story 7.8 lesson). The earlier wording here also named the CANCELLED order as the
 * motivating case; there is no cancellation state in the Story 9.1 status model, so that claim was
 * never true - see `orderAcceptsCustodyReturn`.
 */
export async function applyCustodyReturnProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (envelope.event_type !== CUSTODY_RETURN_RECORDED) return;
  if (!CUSTODY_STREAM_TYPES.has(envelope.stream_type)) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as CustodyReturnRecordedPayload;
  const occurredAt = envelope.metadata.occurred_at ?? new Date().toISOString();

  const order = await requireInProcessOrder(
    p.service_order_id,
    p.site_id,
    client,
    orderAcceptsCustodyReturn,
  );

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
        demand_kind: 'custody_return',
      },
      409,
    );
  }

  const existingUomResult = await client.query(
    `SELECT uom FROM custody_ledger_entry
      WHERE service_order_id = $1 AND sku = $2 AND ownership = 'customer'
      ORDER BY occurred_at ASC LIMIT 1`,
    [order.service_order_id, p.sku],
  );
  const existingUom = existingUomResult.rows[0]?.['uom'] as string | undefined;
  if (existingUom && p.uom !== existingUom) {
    reject(
      'INVALID_PARAMS',
      'The return uom must match the uom this sku is carried in on the custody ledger',
      { service_order_id: order.service_order_id, sku: p.sku, uom: p.uom, ledger_uom: existingUom },
      400,
    );
  }

  const balance = await customerCustodyBalance(order.service_order_id, p.sku, client);
  if (!custodyBalanceCovers(balance, p.quantity)) {
    reject(
      'INSUFFICIENT_STOCK',
      'The returned quantity exceeds the customer-owned custody balance for this sku',
      {
        service_order_id: order.service_order_id,
        sku: p.sku,
        requested_qty: p.quantity,
        custody_balance_qty: balance,
      },
      409,
    );
  }

  // Physical drain through the SECOND gated door: the 9.2 total bar opens only for a view carrying
  // CUSTODY_RETURN. applyStockIssue's own INSUFFICIENT_STOCK propagates for a physical shortfall.
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
  (stockView as unknown as Record<symbol, unknown>)[CUSTODY_RETURN] = true;
  await applyStockBalanceProjection(stockView, client);

  const quantityDelta = qtyNegate(p.quantity);
  try {
    await insertCustodyLedgerEntry(
      {
        entry_id: p.return_id,
        service_order_id: order.service_order_id,
        customer_party_code: order.customer_party_code,
        movement_category: 'return',
        ownership: 'customer',
        sku: p.sku,
        lot_id: p.lot_id,
        location_id: location.location_id,
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
        source_event_type: CUSTODY_RETURN_RECORDED,
        correlation_id: envelope.metadata.correlation_id ?? null,
        // Story 9.5 code review (chunk 2): the delivery challan number is PERSISTED, not just
        // asserted. The shape assert calls it mandatory because goods leaving the job worker
        // without one is a GST offence, but until now it lived only in the raw event payload,
        // where the Rule 45 statement and every read model were blind to it.
        reference_ext: p.return_challan_number_ext,
      },
      client,
    );
  } catch (err: unknown) {
    classifyDuplicate(err, p.return_id, eventId);
  }

  await appendCustodyTrace(
    {
      sku: p.sku,
      lotNumber: p.lot_id,
      quantityChange: quantityDelta,
      eventType: CUSTODY_RETURN_RECORDED,
      eventId,
      occurredAt,
      location,
    },
    client,
  );

  // Section 143: goods back with the principal stop the clock.
  //
  // Story 9.5 code review (chunk 2): CAPPED, not strict. Clock capacity is `challan_qty` while the
  // custody balance this path drains is built from `received_qty`, so on an over-tolerance receipt
  // (105 received against a challan of 100 - the case dispatch and loss are already non-strict for)
  // the excess had NO legal drain: the return was refused INVALID_PARAMS, the only remaining route
  // was booking it as `loss` with an invented reason code, and CUSTODY_NOT_ZERO blocked closure
  // until someone did. Fail-closed on the clock was turning into fail-open on the ledger. The
  // physical movement is already fully gated upstream - lot-under-order, uom, custody balance and
  // the CUSTODY_RETURN stock door - so the clock absorbs what capacity it has and reports the rest.
  const reconciled = await reconcileReturnClocks(
    {
      serviceOrderId: order.service_order_id,
      sku: p.sku,
      quantity: p.quantity,
      counter: 'reconciled_qty',
      category: 'return',
      strict: false,
    },
    client,
  );
  if (qtyToScaled(reconciled.unallocated) > 0n) {
    console.warn(
      `custody return ${p.return_id}: ${reconciled.unallocated} of ${p.quantity} ${p.sku} exceeded the outstanding return-clock capacity on order ${order.service_order_id} (over-tolerance receipt); the return is recorded in full and the clock accounting is short by that amount`,
    );
  }

  // The stored event carries what THIS process derived, never what the caller asserted.
  envelope.payload['custody_balance_after'] = qtyAdd(balance, quantityDelta);
}
