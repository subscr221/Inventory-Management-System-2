import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import type { JobworkMaterialReceivedPayload } from '../events/schema.js';
import { AppError } from '../middleware/error.js';
import { config } from '../config/index.js';
import { getServiceOrderById } from '../read/projections/service_order.js';
import type { ServiceOrderRow } from '../read/projections/service_order.js';
import { insertJobworkMaterialReceipt } from '../read/projections/jobwork_material_receipt.js';
import { insertCustodyLedgerEntry } from '../read/projections/custody_ledger_entry.js';
import { toIstCalendarDate } from '../lib/business-days.js';
import { transitionServiceOrder } from './service-order.js';
import { OWNERSHIP_ERROR_CODES } from './ownership.js';
import {
  DEFAULT_CHALLAN_CLASS,
  isChallanClass,
  openReturnClockForReceipt,
} from './jobwork-return-clock.js';

/**
 * Story 9.2: customer-material receipt seam (FR-JW-03, FR-JW-04, FR-JW-05).
 *
 * Split like every other seam: assert* runs BEFORE any DB write (a malformed
 * jobwork.material_received never consumes an idempotency key); apply* runs INSIDE the event
 * transaction under pg_advisory_xact_lock keyed by service_order_id, then re-reads the order row
 * FOR UPDATE (the Epic 8 hold-bypass lesson: route pre-checks are advisory only).
 *
 * Two gates live here and are reached from every write path:
 * - assertJobworkReceiptOwnership: invoked from applyStockBalanceProjection for every
 *   stock_class 'job_work' RECEIPT (the Story 2.8 assertConsignmentReceiptOwnership precedent), so
 *   a direct POST /api/v1/events stock.received can no more mint unattributed customer stock than
 *   the GRN flow can (AC7).
 * - applyJobworkMaterialReceivedProjection: the custody record itself, the tolerance variance, and
 *   the FIRST-receipt confirmed -> in_process transition through the 9.1 BSD-2 seam (AC2, AC3).
 */

const JOBWORK_STREAM_TYPES = new Set(['jobwork']);
export const JOBWORK_MATERIAL_RECEIVED = 'jobwork.material_received';
export const JOB_WORK_STOCK_CLASS = 'job_work';

/**
 * FR-JW-03: customer material enters ONLY through the gate and receiving flows. The receiving
 * seam stamps its synthetic stock.received view with this Symbol; a JSON body arriving through
 * POST /api/v1/events or the edge upload can never carry a Symbol key, so the stock-surface gate
 * can tell the GRN hand-off from any other job_work receipt attempt without trusting a payload
 * field. Only receiving.ts may set it.
 */
export const RECEIVING_HANDOFF = Symbol('jobwork.receiving_handoff');

function isReceivingHandoff(envelope: EventEnvelope): boolean {
  return (envelope as unknown as Record<symbol, unknown>)[RECEIVING_HANDOFF] === true;
}

/** The order states a customer-material receipt may post against (AC1). */
const RECEIVABLE_ORDER_STATUSES: ReadonlySet<ServiceOrderRow['status']> = new Set([
  'confirmed',
  'in_process',
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Up to 15 integer digits and 3 decimals - the NUMERIC(18,3) column grain. */
const QTY_REGEX = /^\d{1,15}(\.\d{1,3})?$/;
const MAX_TEXT_LENGTH = 200;

const RECEIPT_FIELDS = new Set([
  'service_order_id',
  'receipt_id',
  'grn_line_id',
  'challan_number_ext',
  'challan_date',
  'sku',
  'lot_id',
  'received_qty',
  'challan_qty',
  'uom',
  'site_id',
  'received_by',
  // Story 9.5 (Binding decision 7): OPTIONAL Section 143 challan class, defaulting to 'input'.
  'challan_class',
]);
/** Server-derived fields: refused on input, rewritten by the applier (the 8.1 declared-derived idiom). */
const DERIVED_FIELDS = ['variance_qty', 'variance_flagged'] as const;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCalendarDate(value: unknown): value is string {
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

/** A strictly positive NUMERIC(18,3) quantity as a string ("0", "0.000", 12 (number) all refuse). */
export function isPositiveQtyString(value: unknown): value is string {
  return typeof value === 'string' && QTY_REGEX.test(value) && !/^0+(\.0+)?$/.test(value);
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
// Tolerance predicate (parameterized so a unit test can fail - the 8.4 lesson)
// ---------------------------------------------------------------------------

/** Scale every decimal into an integer of 10^8 so quantity (3 dp) x percent (4 dp) stays exact. */
const SCALE = 8n;
const SCALE_FACTOR = 10n ** SCALE;

function toScaled(value: string): bigint {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, frac = ''] = unsigned.split('.');
  const padded = (frac + '0'.repeat(Number(SCALE))).slice(0, Number(SCALE));
  const scaled = BigInt(whole || '0') * SCALE_FACTOR + BigInt(padded);
  return negative ? -scaled : scaled;
}

function fromScaled(value: bigint, decimals: number = 3): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / SCALE_FACTOR;
  const frac = (abs % SCALE_FACTOR).toString().padStart(Number(SCALE), '0').slice(0, decimals);
  return `${negative ? '-' : ''}${whole.toString()}${decimals > 0 ? `.${frac}` : ''}`;
}

/** Signed variance received - challan, as a NUMERIC(18,3) string ("-0.500", "2.000", "0.000"). */
export function receiptVarianceQty(receivedQty: string, challanQty: string): string {
  return fromScaled(toScaled(receivedQty) - toScaled(challanQty));
}

/**
 * FR-JW-05 receipt tolerance: flag when |variance| STRICTLY exceeds challan_qty * (pct / 100).
 * Exactly at the band does NOT flag. Exact scaled-integer arithmetic; no JS float anywhere.
 * tolerancePercent is a PARAMETER (defaulting to config) so tests exercise real boundaries
 * instead of asserting the config against itself.
 */
export function receiptVarianceFlagged(
  varianceQty: string,
  challanQty: string,
  tolerancePercent: string = config.jobwork.receiptTolerancePercent,
): boolean {
  const variance = toScaled(varianceQty);
  const absVariance = variance < 0n ? -variance : variance;
  // |v| > c * t / 100  <=>  |v| * 100 * SCALE_FACTOR > c * t   (both sides scaled by SCALE^2)
  return absVariance * 100n * SCALE_FACTOR > toScaled(challanQty) * toScaled(tolerancePercent);
}

/** True when a receipt against an order in `status` must fire the in_process transition (AC2). */
export function firstReceiptTransitionRequired(status: ServiceOrderRow['status']): boolean {
  return status === 'confirmed';
}

/** True when an order in `status` can accept a customer-material receipt at all (AC1). */
export function orderAcceptsReceipt(status: ServiceOrderRow['status']): boolean {
  return RECEIVABLE_ORDER_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

export function assertJobworkMaterialReceivedShape(envelope: EventEnvelope): void {
  if (envelope.event_type !== JOBWORK_MATERIAL_RECEIVED) return;
  // The event NAME on any other stream is rejected before an applier can silently ignore it (the
  // Story 8.1 stream-mismatch bypass closure, mirrored from assertServiceOrderShape).
  if (!JOBWORK_STREAM_TYPES.has(envelope.stream_type)) {
    reject('INVALID_EVENT_ENVELOPE', 'jobwork.* events must ride the jobwork stream', {
      event_type: envelope.event_type,
      stream_type: envelope.stream_type,
    });
  }
  const p = envelope.payload as Record<string, unknown>;

  for (const field of DERIVED_FIELDS) {
    if (p[field] !== undefined) {
      reject('INVALID_PARAMS', `${field} is derived by the server and must not be supplied`, {
        field,
      });
    }
  }
  for (const key of Object.keys(p)) {
    if (!RECEIPT_FIELDS.has(key)) {
      reject('INVALID_PARAMS', `${key} is not a recognized field on this event`, { field: key });
    }
  }
  for (const field of ['service_order_id', 'receipt_id', 'grn_line_id', 'site_id', 'received_by']) {
    if (!isUuid(p[field])) reject('INVALID_PARAMS', `${field} is required and must be a UUID`);
  }
  if (envelope.stream_id !== p['service_order_id']) {
    reject('INVALID_EVENT_ENVELOPE', 'stream_id must equal service_order_id', {
      stream_id: envelope.stream_id,
      service_order_id: p['service_order_id'],
    });
  }
  for (const field of ['challan_number_ext', 'sku', 'uom']) {
    if (!isNonEmptyString(p[field]) || (p[field] as string).trim().length > MAX_TEXT_LENGTH) {
      reject(
        'INVALID_PARAMS',
        `${field} is required and must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`,
      );
    }
    p[field] = (p[field] as string).trim();
  }
  if (!isCalendarDate(p['challan_date'])) {
    reject('INVALID_PARAMS', 'challan_date is required and must be a YYYY-MM-DD calendar date');
  }
  if (p['challan_class'] !== undefined && !isChallanClass(p['challan_class'])) {
    reject('INVALID_PARAMS', 'challan_class must be input or capital_goods when supplied', {
      field: 'challan_class',
      value: p['challan_class'],
    });
  }
  if (p['lot_id'] !== undefined && p['lot_id'] !== null) {
    if (!isNonEmptyString(p['lot_id']) || (p['lot_id'] as string).trim().length > MAX_TEXT_LENGTH) {
      reject('INVALID_PARAMS', 'lot_id must be a non-empty string when supplied');
    }
    p['lot_id'] = (p['lot_id'] as string).trim();
  }
  // Strictly positive challan_qty: the tolerance band is challan_qty * pct, so a zero challan
  // would make every receipt an over-tolerance receipt with no meaningful base.
  for (const field of ['received_qty', 'challan_qty']) {
    if (!isPositiveQtyString(p[field])) {
      reject(
        'INVALID_PARAMS',
        `${field} is required and must be a strictly positive NUMERIC string with at most 3 decimals`,
        { field, value: p[field] ?? null },
      );
    }
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

/** Same key and seed as service-order.ts advisoryLock, so receipts serialize with transitions. */
async function lockOrder(serviceOrderId: string, client: PoolClient): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [serviceOrderId]);
}

/**
 * Re-derives the order under lock and refuses fail-closed unless it is a confirmed or in_process
 * order at the receiving site (AC1, AC7). Shared by both gates so the GRN flow and a direct
 * stock.received give the same answer.
 */
async function requireReceivableOrder(
  serviceOrderId: unknown,
  siteId: string | null,
  client: PoolClient,
): Promise<ServiceOrderRow> {
  if (!isUuid(serviceOrderId)) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      'A job_work receipt requires a confirmed service order (service_order_id)',
      { service_order_id: serviceOrderId ?? null },
      409,
    );
  }
  await lockOrder(serviceOrderId, client);
  const order = await getServiceOrderById(serviceOrderId, client, true);
  if (!order) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      'A job_work receipt requires a confirmed service order; none exists for service_order_id',
      { service_order_id: serviceOrderId },
      409,
    );
  }
  if (!orderAcceptsReceipt(order.status)) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      `A job_work receipt requires a confirmed service order; this order is ${order.status}`,
      { service_order_id: serviceOrderId, status: order.status },
      409,
    );
  }
  if (siteId !== null && order.site_id !== siteId) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      'The service order belongs to a different site than the receipt',
      { service_order_id: serviceOrderId, order_site_id: order.site_id, site_id: siteId },
      409,
    );
  }
  return order;
}

/**
 * AC7 ownership binding for the STOCK surface: every stock.received carrying stock_class
 * 'job_work' - the GRN hand-off, a direct POST /api/v1/events, an edge upload - must name a
 * receivable service order and an owner_party_code equal to that order's customer_party_code.
 * Invoked from applyStockBalanceProjection so no write path can mint unattributed customer stock.
 * Refuses BEFORE any balance mutation, so the transaction rolls back without consuming an
 * idempotency key. Non-job_work classes pass through untouched.
 */
export async function assertJobworkReceiptOwnership(
  envelope: EventEnvelope,
  stockClass: string,
  sku: string,
  locationId: string,
  client: PoolClient,
): Promise<void> {
  if (stockClass !== JOB_WORK_STOCK_CLASS) return;
  if (!isReceivingHandoff(envelope)) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      'Customer material (stock_class job_work) can only be received through the gate and receiving flows (POST /api/v1/grn-lines against a confirmed service order)',
      { sku, location_id: locationId, stock_class: stockClass },
      409,
    );
  }
  // Code review 2026-09-03: siteId is deliberately null here - this gate does NOT compare the
  // order's site_id against the receiving location's site. That is safe ONLY because this call
  // always runs inside the same outer transaction as the applyJobworkMaterialReceivedProjection
  // nested event (fired immediately after, same client), which DOES re-derive and check the site
  // and rolls back the whole transaction - including this function's stock write - on a
  // mismatch. If this gate is ever invoked outside that transactional pairing, it must gain its
  // own site check.
  const order = await requireReceivableOrder(envelope.payload['service_order_id'], null, client);
  const ownerPartyCode =
    typeof envelope.payload['owner_party_code'] === 'string'
      ? envelope.payload['owner_party_code'].trim()
      : null;
  if (ownerPartyCode === null || ownerPartyCode !== order.customer_party_code) {
    reject(
      OWNERSHIP_ERROR_CODES.OWNER_PARTY_MISMATCH,
      'owner_party_code must equal the customer_party_code of the linked service order',
      {
        sku,
        location_id: locationId,
        stock_class: stockClass,
        service_order_id: order.service_order_id,
        supplied_owner_party_code: ownerPartyCode,
      },
      409,
    );
  }
  envelope.payload['owner_party_code'] = ownerPartyCode;
}

/**
 * The custody record (AC2, AC3). Under the order advisory lock + FOR UPDATE: re-derives the
 * order status (confirmed or in_process, same site), computes the signed variance and the
 * tolerance flag, inserts the receipt row (one per GRN line), rewrites the payload's derived
 * fields, and fires confirmed -> in_process through transitionServiceOrder on the FIRST receipt
 * only. A second receipt against an in_process order records without re-transitioning.
 */
export async function applyJobworkMaterialReceivedProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (envelope.event_type !== JOBWORK_MATERIAL_RECEIVED) return;
  if (!JOBWORK_STREAM_TYPES.has(envelope.stream_type)) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as JobworkMaterialReceivedPayload;
  const order = await requireReceivableOrder(p.service_order_id, p.site_id, client);

  // FR-JW-03 (the inverse of the stock-surface gate): a custody record exists only for material
  // that physically came through the receiving flow. The GRN line it names must already be in
  // this transaction (the hand-off inserts it before nesting this event) with the segregated
  // class and the same sku, lot, quantity, and site; a direct POST /api/v1/events with an
  // invented or foreign GRN line cannot mint custody or flip the order.
  const grnLine = await client.query(
    `SELECT gl.stock_class, gl.sku, gl.lot_id, gl.received_qty::text AS received_qty, gl.status,
            g.site_id
       FROM grn_line gl JOIN grn g ON g.grn_id = gl.grn_id
      WHERE gl.grn_line_id = $1`,
    [p.grn_line_id],
  );
  const line = grnLine.rows[0] as
    | {
        stock_class: string;
        sku: string;
        lot_id: string | null;
        received_qty: string;
        status: string;
        site_id: string;
      }
    | undefined;
  if (
    !line ||
    line.stock_class !== JOB_WORK_STOCK_CLASS ||
    line.status === 'rejected' ||
    line.sku !== p.sku ||
    (line.lot_id ?? null) !== (p.lot_id ?? null) ||
    line.site_id !== order.site_id ||
    // Exact scaled-integer comparison (the toScaled idiom used everywhere else in this file):
    // NUMERIC(18,3) can exceed Number.MAX_SAFE_INTEGER precision, so a plain Number() coercion
    // could let two distinct quantities collapse to the same float and pass this anti-forgery
    // match check.
    toScaled(line.received_qty) !== toScaled(p.received_qty)
  ) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      'A customer-material custody receipt must reference the posted job_work GRN line it was received on',
      {
        grn_line_id: p.grn_line_id,
        service_order_id: order.service_order_id,
        ...(line
          ? {
              grn_line_stock_class: line.stock_class,
              grn_line_status: line.status,
              grn_line_sku: line.sku,
            }
          : { grn_line_found: false }),
      },
      409,
    );
  }

  const varianceQty = receiptVarianceQty(p.received_qty, p.challan_qty);
  const varianceFlagged = receiptVarianceFlagged(varianceQty, p.challan_qty);
  // Story 9.5 (Binding decision 7): an absent class is an 'input' challan - the SHORTER clock, so a
  // misclassified capital good alerts two years early (nagging), never late (breach).
  const challanClass = isChallanClass(p.challan_class) ? p.challan_class : DEFAULT_CHALLAN_CLASS;

  try {
    await insertJobworkMaterialReceipt(
      {
        receipt_id: p.receipt_id,
        service_order_id: order.service_order_id,
        grn_line_id: p.grn_line_id,
        challan_number_ext: p.challan_number_ext,
        challan_date: p.challan_date,
        sku: p.sku,
        lot_id: p.lot_id ?? null,
        received_qty: p.received_qty,
        challan_qty: p.challan_qty,
        uom: p.uom,
        variance_qty: varianceQty,
        variance_flagged: varianceFlagged,
        received_by: p.received_by,
        site_id: order.site_id,
        correlation_id: envelope.metadata.correlation_id ?? null,
        source_event_id: eventId,
        challan_class: challanClass,
      },
      client,
    );
  } catch (err: unknown) {
    // Check WHICH constraint fired (the 9.1 review patch 7 lesson): a second custody row for the
    // same GRN line and a reused receipt_id are different refusals, and neither is a replay - a
    // genuine replay was short-circuited by alreadyPersisted above.
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
      const constraint = (err as { constraint?: string }).constraint;
      if (constraint === 'uq_jobwork_receipt_grn_line') {
        reject(
          'DUPLICATE_EVENT',
          'A custody receipt already exists for this GRN line',
          { grn_line_id: p.grn_line_id, constraint },
          409,
        );
      }
      if (constraint === 'jobwork_material_receipt_pkey') {
        reject(
          'DUPLICATE_EVENT',
          'A custody receipt with this receipt_id already exists',
          { receipt_id: p.receipt_id, constraint },
          409,
        );
      }
    }
    throw err;
  }

  // Story 9.3 (FR-JW-05, decision 2): the receipt is the ledger's opening movement. Written in
  // the SAME transaction from this applier - no second event for the same fact - keyed by this
  // jobwork.material_received event id (uq_custody_ledger_source_event makes replay safe). The
  // receipt stays on the jobwork stream; the ledger is a shared projection fed by two streams.
  const occurredAt = envelope.metadata.occurred_at ?? new Date().toISOString();
  try {
    await insertCustodyLedgerEntry(
      {
        entry_id: randomUUID(),
        service_order_id: order.service_order_id,
        customer_party_code: order.customer_party_code,
        movement_category: 'receipt',
        ownership: 'customer',
        sku: p.sku,
        lot_id: p.lot_id ?? null,
        location_id: null,
        quantity_delta: p.received_qty,
        uom: p.uom,
        billable: false,
        bom_line_id: null,
        kit_bom_revision_id: null,
        receipt_id: p.receipt_id,
        variance_qty: varianceQty,
        variance_flagged: varianceFlagged,
        site_id: order.site_id,
        posted_by: p.received_by,
        occurred_at: occurredAt,
        business_date: toIstCalendarDate(new Date(occurredAt)),
        source_event_id: eventId,
        source_event_type: JOBWORK_MATERIAL_RECEIVED,
        correlation_id: envelope.metadata.correlation_id ?? null,
      },
      client,
    );
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
      const constraint = (err as { constraint?: string }).constraint;
      if (constraint === 'uq_custody_ledger_source_event') {
        reject(
          'DUPLICATE_EVENT',
          'A custody ledger row already exists for this receipt event',
          { source_event_id: eventId, constraint },
          409,
        );
      }
    }
    throw err;
  }

  // Story 9.5 (FR-AC-11, Binding decision 1): the Section 143 return clock opens in the SAME
  // transaction as the receipt it counts from - one clock row per receipt row, expiry computed in
  // SQL from challan_date by challan_class. Additive alongside the receipt insert, never a
  // replacement for it.
  try {
    await openReturnClockForReceipt(
      {
        receipt_id: p.receipt_id,
        service_order_id: order.service_order_id,
        sku: p.sku,
        challan_qty: p.challan_qty,
        challan_class: challanClass,
        challan_date: p.challan_date,
        site_id: order.site_id,
      },
      client,
    );
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
      const constraint = (err as { constraint?: string }).constraint;
      if (constraint === 'uq_jobwork_return_clock_receipt') {
        reject(
          'DUPLICATE_EVENT',
          'A return clock already exists for this receipt',
          { receipt_id: p.receipt_id, constraint },
          409,
        );
      }
    }
    throw err;
  }

  // The stored event carries what THIS process derived, never what the caller asserted.
  envelope.payload['variance_qty'] = varianceQty;
  envelope.payload['variance_flagged'] = varianceFlagged;
  envelope.payload['challan_class'] = challanClass;

  if (firstReceiptTransitionRequired(order.status)) {
    await transitionServiceOrder(
      order.service_order_id,
      'in_process',
      {
        occurredAt: envelope.metadata.occurred_at ?? new Date().toISOString(),
        actorUserId: envelope.metadata.actor.user_id,
      },
      client,
    );
  }
}
