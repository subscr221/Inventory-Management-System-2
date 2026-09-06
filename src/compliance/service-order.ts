import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import type {
  JobworkOrderClosureRequestedPayload,
  JobworkOrderConfirmedPayload,
  JobworkOrderCreatedPayload,
  JobworkOrderUpdatedPayload,
  ServiceOrderPriceBasisPayload,
} from '../events/schema.js';
import type { ServiceOrderRow } from '../read/projections/service_order.js';
import {
  allocateServiceOrderNumber,
  getServiceOrderById,
  insertServiceOrder,
  updateServiceOrderFields,
  updateServiceOrderStatus,
} from '../read/projections/service_order.js';
import { getBomById } from '../read/projections/bom.js';
import { customerCustodyBalancesByOrder } from '../read/projections/custody_ledger_entry.js';
import { qtyToScaled } from './custody-statement.js';

/**
 * Story 9.1: job-work service order seam (FR-JW-01, FR-JW-02, FR-B-16).
 *
 * Locking contract (the quality.ts comment discipline):
 * - Every transition takes pg_advisory_xact_lock keyed by service_order_id FIRST, then re-reads
 *   the order row FOR UPDATE inside the same transaction. Route pre-checks are advisory only
 *   (the 8.3/8.4/8.5/8.8 hold-bypass lesson: appliers acting on shared state re-derive that
 *   state under lock, fail-closed).
 * - The kit BOM referential read is a plain SELECT on the shared bom projection (AD-14) and
 *   carries no lock-order dependency.
 */

const JOBWORK_STREAM_TYPES = new Set(['jobwork']);
export const JOBWORK_ORDER_CREATED = 'jobwork.order_created';
export const JOBWORK_ORDER_UPDATED = 'jobwork.order_updated';
export const JOBWORK_ORDER_CONFIRMED = 'jobwork.order_confirmed';
/** Story 9.5 (FR-JW-15, AD-6): the closure request that activates the reserved BSD-2 closure seam. */
export const JOBWORK_ORDER_CLOSURE_REQUESTED = 'jobwork.order_closure_requested';
const SERVICE_ORDER_EVENT_TYPES = new Set([
  JOBWORK_ORDER_CREATED,
  JOBWORK_ORDER_UPDATED,
  JOBWORK_ORDER_CONFIRMED,
  JOBWORK_ORDER_CLOSURE_REQUESTED,
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const PARTY_CODE_REGEX = /^[A-Z0-9][A-Z0-9-]{1,31}$/;
const PRICE_BASIS_TYPES = new Set(['per_piece', 'per_kg', 'per_hour', 'lumpsum']);
const OFFCUT_ELECTIONS = new Set(['return', 'retain_and_buy', 'retain_free']);
// BSD-7 / FR-AC-01: the only governed business_stream code for this stream (read/projections/business_stream_config.sql).
const JOB_WORK_BUSINESS_STREAM = 'job_work';
const CURRENCY_REGEX = /^[A-Z]{3}$/;
const CREATE_FIELDS = new Set([
  'service_order_id',
  'site_id',
  'business_stream',
  'customer_party_code',
  'customer_name',
  'spec_reference_ext',
  'promised_start_date',
  'promised_delivery_date',
  'price_basis',
  'kit_bom_id',
  'has_contractual_offcut',
  // Story 9.6 Task 0 (Binding decision 16): the contracted offcut rate pair, optional here and on
  // update, MANDATORY at confirm when has_contractual_offcut is true.
  'offcut_rate',
  'offcut_currency',
  'offcut_contract_ref_ext',
]);
// has_contractual_offcut is deliberately NOT updatable: it is set at creation and is the sole
// predicate of the FR-JW-09/10 confirm gate, so an updatable flag would let the same actor blocked
// at confirm simply clear it and confirm anyway, with no distinct audit event (code review
// 2026-09-03, decision 2). A genuinely wrong flag is corrected by voiding and re-raising the order.
const UPDATE_FIELDS = new Set([
  'service_order_id',
  'customer_party_code',
  'customer_name',
  'spec_reference_ext',
  'promised_start_date',
  'promised_delivery_date',
  'price_basis',
  'kit_bom_id',
  'offcut_rate',
  'offcut_currency',
  'offcut_contract_ref_ext',
]);
// Story 9.6 Task 0: at most FOUR decimals (the NUMERIC(18,4) column), strictly positive, and an
// exact decimal STRING at the event boundary - the receiptTolerancePercent convention, never a
// number literal, so the billing line settles in scaled-integer arithmetic.
const OFFCUT_RATE_REGEX = /^\d{1,14}(\.\d{1,4})?$/;

export type ServiceOrderStatus = 'draft' | 'confirmed' | 'in_process' | 'closed';

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isDateString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_REGEX.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

/**
 * Story 9.6 Task 0.3: the contracted offcut rate shape. Exported so a unit test can fail it (the
 * 8.4 tautological-config lesson): a positive exact decimal string with at most four decimals.
 */
export function isOffcutRateString(value: unknown): value is string {
  if (typeof value !== 'string' || !OFFCUT_RATE_REGEX.test(value)) return false;
  return /[1-9]/.test(value);
}

export function isValidPriceBasis(value: unknown): value is ServiceOrderPriceBasisPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const keys = Object.keys(p);
  if (keys.length !== 3) return false;
  if (typeof p['basis_type'] !== 'string' || !PRICE_BASIS_TYPES.has(p['basis_type'])) return false;
  if (typeof p['rate'] !== 'number' || !Number.isFinite(p['rate']) || p['rate'] < 0) return false;
  if (typeof p['currency'] !== 'string' || !CURRENCY_REGEX.test(p['currency'])) return false;
  return true;
}

// ---------------------------------------------------------------------------
// State machine predicate (parameterized so unit tests can fail - the 8.4
// tautological-config lesson). This is the ONLY transition-legality authority;
// both the confirm applier and the future Story 9.2 / 9.5 transitions consult it.
// ---------------------------------------------------------------------------

export interface TransitionContext {
  /** The order row already links a kit BOM (confirm gate, BSD-3). */
  hasKitBom: boolean;
  /** The order row already carries a price basis (confirm gate, BSD-3). */
  hasPriceBasis: boolean;
  /**
   * Story 9.5 closure-gate marker. 9.1 never sets it, so every direct attempt at 'closed'
   * refuses (BSD-2); 9.5 will pass it after the zero-custody check.
   */
  closureGatePassed?: boolean;
}

export function serviceOrderTransitionAllowed(
  current: ServiceOrderStatus,
  target: ServiceOrderStatus,
  ctx: TransitionContext,
): boolean {
  switch (target) {
    case 'draft':
      // An order is only ever CREATED into draft; nothing transitions back to it.
      return false;
    case 'confirmed':
      return current === 'draft' && ctx.hasKitBom && ctx.hasPriceBasis;
    case 'in_process':
      // Fired only by Story 9.2's first customer-material receipt.
      return current === 'confirmed';
    case 'closed':
      // Reachable only through the Story 9.5 closure gate (AD-6 zero-custody check).
      return current === 'in_process' && ctx.closureGatePassed === true;
    default:
      return false;
  }
}

function transitionContextFor(order: ServiceOrderRow): TransitionContext {
  return {
    hasKitBom: order.kit_bom_id !== null,
    hasPriceBasis: order.price_basis !== null,
  };
}

export function serviceOrderEventType(envelope: EventEnvelope): string | null {
  if (!JOBWORK_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!SERVICE_ORDER_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access) - a malformed jobwork event
// never consumes an idempotency key (the store.ts:482 pattern).
// ---------------------------------------------------------------------------

export function assertServiceOrderShape(envelope: EventEnvelope): void {
  // A jobwork.* event NAME on any other stream is rejected before another assert can give it a
  // different rejection or an applier can silently ignore it (the Story 8.1 stream-mismatch
  // bypass closure).
  if (
    SERVICE_ORDER_EVENT_TYPES.has(envelope.event_type) &&
    !JOBWORK_STREAM_TYPES.has(envelope.stream_type)
  ) {
    reject('INVALID_EVENT_ENVELOPE', 'jobwork.* events must ride the jobwork stream', {
      event_type: envelope.event_type,
      stream_type: envelope.stream_type,
    });
  }
  const type = serviceOrderEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  switch (type) {
    case JOBWORK_ORDER_CREATED:
      assertOrderCreatedShape(p);
      break;
    case JOBWORK_ORDER_UPDATED:
      assertOrderUpdatedShape(p);
      break;
    case JOBWORK_ORDER_CONFIRMED:
      assertNoExtraKeys(
        p,
        new Set(['service_order_id', 'offcut_election', 'offcut_rate', 'offcut_currency']),
      );
      if (!isUuid(p['service_order_id']))
        reject('INVALID_PARAMS', 'service_order_id is required and must be a UUID');
      if (
        p['offcut_election'] !== undefined &&
        (typeof p['offcut_election'] !== 'string' ||
          !OFFCUT_ELECTIONS.has(p['offcut_election'] as string))
      ) {
        reject(
          'INVALID_PARAMS',
          'offcut_election must be return, retain_and_buy, or retain_free when supplied',
        );
      }
      assertOffcutRateShape(p);
      break;
    case JOBWORK_ORDER_CLOSURE_REQUESTED:
      assertNoExtraKeys(p, new Set(['service_order_id', 'requested_by', 'site_id']));
      if (!isUuid(p['service_order_id']))
        reject('INVALID_PARAMS', 'service_order_id is required and must be a UUID');
      if (!isUuid(p['requested_by']))
        reject('INVALID_PARAMS', 'requested_by is required and must be a UUID');
      // Story 9.5 code review (chunk 2): site_id is what the applier re-derives the site gate from.
      if (!isUuid(p['site_id'])) reject('INVALID_PARAMS', 'site_id is required and must be a UUID');
      // The requester named in the payload must BE the authenticated actor. Without this a direct
      // POST /api/v1/events could name any UUID as the closure requester while closed_by recorded
      // someone else - the forged-actor pattern applyPhysicalVerificationSignedOff already refuses.
      if (p['requested_by'] !== envelope.metadata.actor.user_id) {
        reject(
          'FUNCTION_ACCESS_DENIED',
          'requested_by must be the authenticated actor requesting the closure',
          { requested_by: p['requested_by'], actor_user_id: envelope.metadata.actor.user_id },
          403,
        );
      }
      if (envelope.stream_id !== p['service_order_id']) {
        reject('INVALID_EVENT_ENVELOPE', 'stream_id must equal service_order_id', {
          stream_id: envelope.stream_id,
          service_order_id: p['service_order_id'],
        });
      }
      break;
  }
}

function assertCommonFieldShapes(p: Record<string, unknown>, required: boolean): void {
  if (required || p['customer_party_code'] !== undefined) {
    if (
      typeof p['customer_party_code'] !== 'string' ||
      !PARTY_CODE_REGEX.test(p['customer_party_code'])
    ) {
      reject(
        'INVALID_PARAMS',
        'customer_party_code is required and must match ^[A-Z0-9][A-Z0-9-]{1,31}$',
      );
    }
  }
  if (required || p['customer_name'] !== undefined) {
    if (!isNonEmptyString(p['customer_name'])) {
      reject('INVALID_PARAMS', 'customer_name is required and must be a non-empty string');
    }
  }
  if (p['spec_reference_ext'] !== undefined && p['spec_reference_ext'] !== null) {
    if (!isNonEmptyString(p['spec_reference_ext'])) {
      reject('INVALID_PARAMS', 'spec_reference_ext must be a non-empty string when supplied');
    }
  }
  for (const field of ['promised_start_date', 'promised_delivery_date']) {
    if (p[field] !== undefined && p[field] !== null && !isDateString(p[field])) {
      reject('INVALID_PARAMS', `${field} must be a YYYY-MM-DD calendar date when supplied`);
    }
  }
  if (
    p['promised_start_date'] != null &&
    p['promised_delivery_date'] != null &&
    (p['promised_delivery_date'] as string) < (p['promised_start_date'] as string)
  ) {
    reject('INVALID_PARAMS', 'promised_delivery_date must be on or after promised_start_date');
  }
  if (p['price_basis'] !== undefined && p['price_basis'] !== null) {
    if (!isValidPriceBasis(p['price_basis'])) {
      reject(
        'INVALID_PARAMS',
        'price_basis must be {basis_type: per_piece|per_kg|per_hour|lumpsum, rate >= 0, currency}',
      );
    }
  }
  if (p['kit_bom_id'] !== undefined && p['kit_bom_id'] !== null && !isUuid(p['kit_bom_id'])) {
    reject('INVALID_PARAMS', 'kit_bom_id must be a UUID when supplied');
  }
  // Story 9.4 (FR-JW-09/10): a plain boolean, no existing field distinguishes a contractual
  // offcut arrangement from none.
  if (
    p['has_contractual_offcut'] !== undefined &&
    typeof p['has_contractual_offcut'] !== 'boolean'
  ) {
    reject('INVALID_PARAMS', 'has_contractual_offcut must be a boolean when supplied');
  }
  assertOffcutRateShape(p);
}

/**
 * Story 9.6 Task 0.2/0.3: the contracted offcut rate pair rides created, updated and confirmed as
 * an optional pair. Shape only here; the currency-versus-price-basis and contractual-arrangement
 * gates are re-derived against the ROW under the order lock in the appliers.
 */
function assertOffcutRateShape(p: Record<string, unknown>): void {
  if (p['offcut_rate'] !== undefined && p['offcut_rate'] !== null) {
    if (!isOffcutRateString(p['offcut_rate'])) {
      reject(
        'INVALID_PARAMS',
        'offcut_rate must be a strictly positive exact decimal string with at most four decimals',
        { field: 'offcut_rate', value: p['offcut_rate'] },
      );
    }
  }
  if (p['offcut_currency'] !== undefined && p['offcut_currency'] !== null) {
    if (typeof p['offcut_currency'] !== 'string' || !CURRENCY_REGEX.test(p['offcut_currency'])) {
      reject(
        'INVALID_PARAMS',
        'offcut_currency must be a three-letter ISO 4217 code when supplied',
        { field: 'offcut_currency' },
      );
    }
  }
  // The pair travels together: a rate with no currency is an unbounded number on an invoice line,
  // and a null clear must clear both.
  const rateState =
    p['offcut_rate'] === undefined ? 'absent' : p['offcut_rate'] === null ? 'null' : 'set';
  const currencyState =
    p['offcut_currency'] === undefined ? 'absent' : p['offcut_currency'] === null ? 'null' : 'set';
  if (rateState !== currencyState) {
    reject('INVALID_PARAMS', 'offcut_rate and offcut_currency must be supplied together', {
      offcut_rate: p['offcut_rate'] ?? null,
      offcut_currency: p['offcut_currency'] ?? null,
    });
  }
}

/**
 * Story 9.6 Task 0.3: offcut_currency must equal the price-basis currency whenever a price basis is
 * present. Re-derived against the effective (row plus payload) values under the order lock.
 */
function assertOffcutCurrencyMatchesPriceBasis(
  serviceOrderId: string,
  offcutCurrency: string | null | undefined,
  priceBasis: ServiceOrderPriceBasisPayload | null | undefined,
): void {
  if (offcutCurrency == null || priceBasis == null) return;
  if (offcutCurrency !== priceBasis.currency) {
    reject(
      'INVALID_PARAMS',
      'offcut_currency must equal the price_basis currency',
      {
        service_order_id: serviceOrderId,
        offcut_currency: offcutCurrency,
        price_basis_currency: priceBasis.currency,
      },
      400,
    );
  }
}

function assertNoExtraKeys(p: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(p)) {
    if (!allowed.has(key)) {
      reject('INVALID_PARAMS', `${key} is not a recognized field on this event`, { field: key });
    }
  }
}

function assertOrderCreatedShape(p: Record<string, unknown>): void {
  assertNoExtraKeys(p, CREATE_FIELDS);
  if (!isUuid(p['service_order_id']))
    reject('INVALID_PARAMS', 'service_order_id is required and must be a UUID');
  if (!isUuid(p['site_id'])) reject('INVALID_PARAMS', 'site_id is required and must be a UUID');
  if (p['business_stream'] !== JOB_WORK_BUSINESS_STREAM) {
    reject('INVALID_PARAMS', `business_stream must be "${JOB_WORK_BUSINESS_STREAM}"`);
  }
  // AC1: the order must link a kit BOM and carry a price basis at creation.
  if (p['kit_bom_id'] === undefined || p['kit_bom_id'] === null || !isUuid(p['kit_bom_id'])) {
    reject('INVALID_PARAMS', 'kit_bom_id is required and must be a UUID');
  }
  if (!isValidPriceBasis(p['price_basis'])) {
    reject(
      'INVALID_PARAMS',
      'price_basis is required: {basis_type: per_piece|per_kg|per_hour|lumpsum, rate >= 0, currency}',
    );
  }
  assertCommonFieldShapes(p, true);
}

function assertOrderUpdatedShape(p: Record<string, unknown>): void {
  assertNoExtraKeys(p, UPDATE_FIELDS);
  if (!isUuid(p['service_order_id']))
    reject('INVALID_PARAMS', 'service_order_id is required and must be a UUID');
  const changeable = [
    'customer_party_code',
    'customer_name',
    'spec_reference_ext',
    'promised_start_date',
    'promised_delivery_date',
    'price_basis',
    'kit_bom_id',
    'has_contractual_offcut',
    'offcut_rate',
    'offcut_currency',
  ];
  const changed = changeable.filter((f) => p[f] !== undefined);
  if (changed.length === 0) {
    reject('INVALID_PARAMS', 'jobwork.order_updated requires at least one changed field');
  }
  // customer_party_code / customer_name are NOT NULL on the row: null clears are rejected.
  if (p['customer_party_code'] === null || p['customer_name'] === null) {
    reject('INVALID_PARAMS', 'customer_party_code and customer_name cannot be cleared');
  }
  assertCommonFieldShapes(p, false);
}

// ---------------------------------------------------------------------------
// Inside-transaction projection (DB access)
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

async function advisoryLock(key: string, client: PoolClient): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
}

/** BSD-3: the kit BOM link must reference an existing BOM with bom_type job_work_kit. */
async function requireKitBom(kitBomId: string, client: PoolClient): Promise<void> {
  const bom = await getBomById(kitBomId, client);
  if (!bom) {
    reject('BOM_NOT_FOUND', 'Kit BOM not found', { kit_bom_id: kitBomId }, 404);
  }
  if (bom.bom_type !== 'job_work_kit') {
    reject(
      'INVALID_PARAMS',
      'kit_bom_id must reference a BOM with bom_type job_work_kit',
      { kit_bom_id: kitBomId, bom_type: bom.bom_type },
      409,
    );
  }
}

export async function applyServiceOrderProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = serviceOrderEventType(envelope);
  if (!type) return;

  switch (type) {
    case JOBWORK_ORDER_CREATED:
      await applyOrderCreated(envelope, client, eventId);
      break;
    case JOBWORK_ORDER_UPDATED:
      await applyOrderUpdated(envelope, client);
      break;
    case JOBWORK_ORDER_CONFIRMED:
      await applyOrderConfirmed(envelope, client);
      break;
    case JOBWORK_ORDER_CLOSURE_REQUESTED:
      await applyOrderClosureRequested(envelope, client);
      break;
  }
}

async function applyOrderCreated(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as JobworkOrderCreatedPayload;
  await advisoryLock(p.service_order_id, client);

  const existing = await getServiceOrderById(p.service_order_id, client, true);
  if (existing) {
    reject(
      'DUPLICATE_EVENT',
      'A service order with this service_order_id already exists',
      { service_order_id: p.service_order_id, existing_status: existing.status },
      409,
    );
  }

  if (p.kit_bom_id !== undefined && p.kit_bom_id !== null) {
    await requireKitBom(p.kit_bom_id, client);
  }

  const siteCheck = await client.query(
    `SELECT 1 FROM location_register WHERE location_id = $1 AND level = 'site' AND status = 'active'`,
    [p.site_id],
  );
  if (siteCheck.rows.length === 0) {
    reject(
      'LOCATION_NOT_FOUND',
      'site_id does not reference an active site-level location',
      {
        site_id: p.site_id,
      },
      404,
    );
  }

  const occurredAt = envelope.metadata.occurred_at;
  if (
    !occurredAt ||
    typeof occurredAt !== 'string' ||
    Number.isNaN(new Date(occurredAt).getTime())
  ) {
    reject('INVALID_PARAMS', 'occurred_at is required and must be a valid ISO 8601 date string');
  }
  // Order-number year uses server wall-clock, not the client-influenced occurred_at (which is
  // only format-checked, not bounded) - the printed year must not be spoofable.
  const year = new Date().getUTCFullYear();
  const orderNumber = await allocateServiceOrderNumber(year, client);
  // Story 9.6 Task 0: the rate pair is optional at creation, but a rate on an order with no
  // contractual arrangement is refused exactly as an election is (the confirm gate's mirror).
  if (p.offcut_rate != null && p.has_contractual_offcut !== true) {
    reject(
      'INVALID_STATE_TRANSITION',
      'A service order without a contractual offcut arrangement cannot carry an offcut rate',
      { service_order_id: p.service_order_id, has_contractual_offcut: false },
      409,
    );
  }
  assertOffcutCurrencyMatchesPriceBasis(p.service_order_id, p.offcut_currency, p.price_basis);

  try {
    await insertServiceOrder(
      {
        service_order_id: p.service_order_id,
        order_number_ext: orderNumber,
        customer_party_code: p.customer_party_code,
        customer_name: p.customer_name.trim(),
        spec_reference_ext: p.spec_reference_ext?.trim() ?? null,
        promised_start_date: p.promised_start_date ?? null,
        promised_delivery_date: p.promised_delivery_date ?? null,
        price_basis: p.price_basis ?? null,
        kit_bom_id: p.kit_bom_id ?? null,
        has_contractual_offcut: p.has_contractual_offcut ?? false,
        offcut_rate: p.offcut_rate ?? null,
        offcut_currency: p.offcut_currency ?? null,
        offcut_contract_ref_ext: p.offcut_contract_ref_ext ?? null,
        site_id: p.site_id,
        business_stream: p.business_stream,
        created_by: envelope.metadata.actor.user_id,
        correlation_id: envelope.metadata.correlation_id ?? null,
        source_event_id: eventId,
      },
      client,
    );
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
      // Only a collision on THIS service_order_id's own primary key is a harmless replay; any
      // other unique violation (e.g. order-number collision) is a real conflict, not a replay.
      const reInsertedRow = await getServiceOrderById(p.service_order_id, client, true);
      if (reInsertedRow) return;
    }
    throw err;
  }
}

async function applyOrderUpdated(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as JobworkOrderUpdatedPayload;
  await advisoryLock(p.service_order_id, client);

  const order = await getServiceOrderById(p.service_order_id, client, true);
  if (!order) {
    reject(
      'SERVICE_ORDER_NOT_FOUND',
      'Service order not found',
      { service_order_id: p.service_order_id },
      404,
    );
  }
  // Open question 2 default: draft-only field edits; post-confirm amendment is out of 9.1 scope.
  if (order.status !== 'draft') {
    reject(
      'INVALID_STATE_TRANSITION',
      'Only a draft service order can be updated',
      { service_order_id: p.service_order_id, status: order.status },
      409,
    );
  }

  if (p.kit_bom_id !== undefined && p.kit_bom_id !== null) {
    await requireKitBom(p.kit_bom_id, client);
  }

  // Cross-field date check re-derived against the row: assertCommonFieldShapes only catches this
  // when BOTH dates are in the same payload, but an update may change just one. The row's date
  // columns round-trip through pg as Date objects, not YYYY-MM-DD strings, so compare as dates.
  const effectiveStart =
    p.promised_start_date !== undefined ? p.promised_start_date : order.promised_start_date;
  const effectiveDelivery =
    p.promised_delivery_date !== undefined
      ? p.promised_delivery_date
      : order.promised_delivery_date;
  if (
    effectiveStart != null &&
    effectiveDelivery != null &&
    new Date(effectiveDelivery).getTime() < new Date(effectiveStart).getTime()
  ) {
    reject('INVALID_PARAMS', 'promised_delivery_date must be on or after promised_start_date');
  }

  // Story 9.6 Task 0: same two gates as creation, re-derived against the row under the lock.
  if (p.offcut_rate != null && order.has_contractual_offcut !== true) {
    reject(
      'INVALID_STATE_TRANSITION',
      'A service order without a contractual offcut arrangement cannot carry an offcut rate',
      { service_order_id: p.service_order_id, has_contractual_offcut: false },
      409,
    );
  }
  const effectiveOffcutCurrency =
    p.offcut_currency !== undefined ? p.offcut_currency : order.offcut_currency;
  const effectivePriceBasis = p.price_basis !== undefined ? p.price_basis : order.price_basis;
  assertOffcutCurrencyMatchesPriceBasis(
    p.service_order_id,
    effectiveOffcutCurrency,
    effectivePriceBasis,
  );

  await updateServiceOrderFields(
    p.service_order_id,
    {
      ...(p.customer_party_code !== undefined && { customer_party_code: p.customer_party_code }),
      ...(p.customer_name !== undefined && { customer_name: p.customer_name.trim() }),
      ...(p.spec_reference_ext !== undefined && {
        spec_reference_ext: p.spec_reference_ext?.trim() ?? null,
      }),
      ...(p.promised_start_date !== undefined && { promised_start_date: p.promised_start_date }),
      ...(p.promised_delivery_date !== undefined && {
        promised_delivery_date: p.promised_delivery_date,
      }),
      ...(p.price_basis !== undefined && { price_basis: p.price_basis }),
      ...(p.kit_bom_id !== undefined && { kit_bom_id: p.kit_bom_id }),
      ...(p.offcut_rate !== undefined && { offcut_rate: p.offcut_rate }),
      ...(p.offcut_currency !== undefined && { offcut_currency: p.offcut_currency }),
      ...(p.offcut_contract_ref_ext !== undefined && {
        offcut_contract_ref_ext: p.offcut_contract_ref_ext,
      }),
    },
    client,
  );
}

async function applyOrderConfirmed(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as JobworkOrderConfirmedPayload;
  await advisoryLock(p.service_order_id, client);

  // Hold-bypass lesson (8.3/8.4/8.5/8.8): the current status and the confirm-gate inputs are
  // re-derived HERE under the advisory lock + FOR UPDATE, never trusted from route pre-checks.
  const order = await getServiceOrderById(p.service_order_id, client, true);
  if (!order) {
    reject(
      'SERVICE_ORDER_NOT_FOUND',
      'Service order not found',
      { service_order_id: p.service_order_id },
      404,
    );
  }

  const ctx = transitionContextFor(order);
  if (!serviceOrderTransitionAllowed(order.status, 'confirmed', ctx)) {
    reject(
      'INVALID_STATE_TRANSITION',
      order.status === 'draft'
        ? 'A draft service order can only be confirmed with a linked kit BOM and a price basis'
        : 'Only a draft service order can be confirmed',
      {
        service_order_id: p.service_order_id,
        status: order.status,
        has_kit_bom: ctx.hasKitBom,
        has_price_basis: ctx.hasPriceBasis,
      },
      409,
    );
  }
  // The link may have been recorded before the BOM row changed type; re-verify at the gate.
  await requireKitBom(order.kit_bom_id as string, client);

  // Story 9.4 (FR-JW-09/10): a contractual offcut arrangement makes the ALREADY-forward-declared
  // (BSD-6) offcut_election mandatory at confirm. Mirrors the kit-BOM/price-basis gate shape
  // exactly - same code, same status, same 409.
  // Story 9.6 REVISED 2026-09-06 (sprint change proposal): the confirm-time ELECTION mandate is
  // withdrawn, exactly as the rate mandate below it was. The disposition is decided at DISPOSAL by
  // the finance controller (Story 9.7), not at confirmation - the approved ruling is that "no
  // disposition and no rate are elected at confirmation". Leaving this gate in place blocked an
  // operator from confirming an order until they answered a question nobody can answer yet, and the
  // value it collected was dead: the capture applier never reads `offcut_election`.
  // The symmetric refusal below SURVIVES: an election on an order with no contractual arrangement is
  // still meaningless and still refused.
  // Symmetric refusal: an election is meaningless without the contractual arrangement it elects
  // under, and silently storing one would misreport the order's offcut obligation to 9.6 billing.
  if (order.has_contractual_offcut !== true && p.offcut_election !== undefined) {
    reject(
      'INVALID_STATE_TRANSITION',
      'A service order without a contractual offcut arrangement cannot carry an offcut election',
      { service_order_id: p.service_order_id, has_contractual_offcut: false },
      409,
    );
  }
  // Story 9.6 REVISED 2026-09-05 (sprint change proposal): the confirm-time rate MANDATE is
  // withdrawn. The offcut contract is its own contract and may be agreed after the service order is
  // confirmed, and where the offcut is later sold at auction no rate can exist in advance at all.
  // What survives is the indicative rate's SHAPE gate below: a rate may not ride an order that has
  // no contractual offcut arrangement to price.
  if (order.has_contractual_offcut !== true && p.offcut_rate !== undefined) {
    reject(
      'INVALID_STATE_TRANSITION',
      'A service order without a contractual offcut arrangement cannot carry an offcut rate',
      { service_order_id: p.service_order_id, has_contractual_offcut: false, field: 'offcut_rate' },
      409,
    );
  }
  assertOffcutCurrencyMatchesPriceBasis(
    p.service_order_id,
    p.offcut_currency !== undefined ? p.offcut_currency : order.offcut_currency,
    order.price_basis,
  );
  if (p.offcut_rate !== undefined) {
    await updateServiceOrderFields(
      p.service_order_id,
      { offcut_rate: p.offcut_rate, offcut_currency: p.offcut_currency ?? null },
      client,
    );
  }

  await updateServiceOrderStatus(
    p.service_order_id,
    'confirmed',
    {
      confirmed_at: envelope.metadata.occurred_at,
      confirmed_by: envelope.metadata.actor.user_id,
      ...(p.offcut_election !== undefined && { offcut_election: p.offcut_election }),
    },
    client,
  );
}

/**
 * Story 9.5 (FR-JW-15, FR-AC-11; AD-6 literally): "no job-work order can close while its custody
 * ledger balance is non-zero". Same structure as applyOrderConfirmed: advisory lock, order row FOR
 * UPDATE, then the gate input re-derived HERE - every per-sku customer-owned balance summed in SQL
 * under the same lock, compared as exact scaled integers - never trusted from a route pre-check
 * (the 8.x/9.x hold-bypass class). A direct POST /api/v1/events meets the identical wall.
 *
 * The gate is the custody balance ALONE (Binding decision 6). jobwork_return_clock.status is
 * deliberately NOT a second closure key: two keys that should agree can disagree, and then nothing
 * says which wins. A breached clock with a deemed supply is a tax consequence on the principal, not
 * an operational blocker; the order still closes and the ITC-04 still shows the breach.
 */
async function applyOrderClosureRequested(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as JobworkOrderClosureRequestedPayload;
  await advisoryLock(p.service_order_id, client);

  const order = await getServiceOrderById(p.service_order_id, client, true);
  if (!order) {
    reject(
      'SERVICE_ORDER_NOT_FOUND',
      'Service order not found',
      { service_order_id: p.service_order_id },
      404,
    );
  }

  // Story 9.5 code review (chunk 2): the site gate is re-derived HERE, under the same advisory lock
  // as the balance, not trusted from the route's assertSiteWriteAccess. A gate that only a route
  // enforces is one a direct POST /api/v1/events does not meet - the hold-bypass defect class this
  // project has now closed five times. Same code and shape as requireInProcessOrder's site arm.
  if (order.site_id !== p.site_id) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      'The service order belongs to a different site than the closure request',
      {
        service_order_id: order.service_order_id,
        order_site_id: order.site_id,
        site_id: p.site_id,
      },
      409,
    );
  }

  const balances = await customerCustodyBalancesByOrder(order.service_order_id, client);
  const nonZero = balances.filter((row) => qtyToScaled(row.balance) !== 0n);
  if (nonZero.length > 0) {
    reject(
      'CUSTODY_NOT_ZERO',
      'Service order cannot close with a non-zero custody balance',
      {
        service_order_id: order.service_order_id,
        non_zero_skus: nonZero.map((row) => row.sku),
        non_zero_balances: nonZero.map((row) => ({
          sku: row.sku,
          uom: row.uom,
          balance: row.balance,
        })),
      },
      409,
    );
  }

  // The RESERVED 9.1 seam, not a reimplementation: it re-checks in_process under the same lock and
  // stamps closed_at / closed_by.
  await transitionServiceOrder(
    order.service_order_id,
    'closed',
    {
      occurredAt: envelope.metadata.occurred_at ?? new Date().toISOString(),
      actorUserId: envelope.metadata.actor.user_id,
      closureGatePassed: true,
    },
    client,
  );
}

// ---------------------------------------------------------------------------
// Applier-level transition machinery for downstream stories (BSD-2). No routes
// and no 9.1 events fire these; they exist so 9.2 (first customer-material
// receipt -> in_process) and 9.5 (closure gate -> closed) have a guarded seam,
// and so out-of-sequence attempts are testable today.
// ---------------------------------------------------------------------------

export async function transitionServiceOrder(
  serviceOrderId: string,
  target: 'in_process' | 'closed',
  opts: { occurredAt: string; actorUserId: string; closureGatePassed?: boolean },
  client: PoolClient,
): Promise<void> {
  await advisoryLock(serviceOrderId, client);
  const order = await getServiceOrderById(serviceOrderId, client, true);
  if (!order) {
    reject(
      'SERVICE_ORDER_NOT_FOUND',
      'Service order not found',
      { service_order_id: serviceOrderId },
      404,
    );
  }
  const ctx: TransitionContext = {
    ...transitionContextFor(order),
    ...(opts.closureGatePassed !== undefined && { closureGatePassed: opts.closureGatePassed }),
  };
  if (!serviceOrderTransitionAllowed(order.status, target, ctx)) {
    reject(
      'INVALID_STATE_TRANSITION',
      `Transition to ${target} is not allowed from ${order.status}`,
      { service_order_id: serviceOrderId, status: order.status, target },
      409,
    );
  }
  if (target === 'in_process') {
    await updateServiceOrderStatus(
      serviceOrderId,
      'in_process',
      { in_process_at: opts.occurredAt },
      client,
    );
  } else {
    await updateServiceOrderStatus(
      serviceOrderId,
      'closed',
      { closed_at: opts.occurredAt, closed_by: opts.actorUserId },
      client,
    );
  }
}
