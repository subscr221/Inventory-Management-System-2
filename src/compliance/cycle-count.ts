import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getItemBySku } from '../read/projections/item_master.js';
import { getLotByNumberAndSku } from '../read/projections/lot_master.js';
import { appendTraceEntry } from '../read/projections/lot_trace.js';
import {
  getCycleCountById,
  getCycleCountLineByAdjustment,
  insertCycleCountHeader,
  insertCycleCountLine,
  markCycleCountSubmitted,
  setAdjustmentStatus,
  markAdjustmentApplied,
} from '../read/projections/cycle_count.js';
import {
  getPhysicalVerificationById,
  insertPhysicalVerificationHeader,
  insertPhysicalVerificationLine,
  markPhysicalVerificationSignedOff,
} from '../read/projections/physical_verification.js';
import { getCycleCountLines } from '../read/projections/cycle_count.js';

/**
 * Central cycle-count compliance seam (Story 2.6). Split like every other seam:
 *
 * - assertCycleCountShape runs BEFORE any DB work, next to the other pre-transaction asserts, so a
 *   malformed count event is rejected without consuming an idempotency key.
 * - applyCycleCountProjection runs INSIDE the event transaction, BEFORE the domain_events insert. It
 *   computes variance from the ledger under FOR UPDATE locks, drives the DOA-gated adjustment
 *   lifecycle, and applies approved stock adjustments. The AC2/Task 5 invariant lives here: a
 *   stock.adjusted event whose adjustment is not APPROVED is rejected with APPROVAL_REQUIRED, so a
 *   direct POST /api/v1/events or edge upload cannot bypass the approval gate.
 *
 * Gating is deliberately narrow: only `inventory` stream events of the new count / adjustment /
 * physical-verification types. Every older stock, lot, valuation, transfer, DOA, SCIM, and audit
 * event passes through byte-for-byte unaffected.
 */

const CYCLE_COUNT_STREAM_TYPES = new Set(['inventory']);
const CYCLE_COUNT_EVENT_TYPES = new Set([
  'cycle_count.task_created',
  'cycle_count.submitted',
  'cycle_count.adjustment_approved',
  'cycle_count.adjustment_rejected',
  'stock.adjusted',
  'physical_verification.completed',
  'physical_verification.signed_off',
]);

const VALID_STOCK_CLASSES = new Set(['owned', 'consignment', 'vmi', 'job_work']);
const MAX_QUANTITY = 1e12;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CYCLE_COUNT_ERROR_CODES = {
  COUNT_TASK_LOCKED: 'COUNT_TASK_LOCKED',
  COUNT_ENTERER_CANNOT_APPROVE: 'COUNT_ENTERER_CANNOT_APPROVE',
  PERIOD_LOCKED: 'PERIOD_LOCKED',
  COUNT_VARIANCE_REQUIRES_APPROVAL: 'COUNT_VARIANCE_REQUIRES_APPROVAL',
  STOCK_ADJUSTMENT_NEGATIVE_BALANCE: 'STOCK_ADJUSTMENT_NEGATIVE_BALANCE',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
} as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

export function cycleCountEventType(envelope: EventEnvelope): string | null {
  if (!CYCLE_COUNT_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!CYCLE_COUNT_EVENT_TYPES.has(envelope.event_type)) return null;
  // `stock.adjusted` is claimed by this seam ONLY when it carries a cycle-count adjustment_id.
  // The Story 1.9 spine fixtures emit a legacy sku-less `stock.adjusted` with no adjustment_id;
  // those pass through untouched (they touch no balance projection either), exactly as the
  // stock-balance and lot-serial seams let legacy shapes through. A stock mutation via
  // stock.adjusted is therefore only ever possible with an adjustment_id, which forces the
  // approval gate below.
  if (envelope.event_type === 'stock.adjusted' && envelope.payload['adjustment_id'] === undefined) {
    return null;
  }
  return envelope.event_type;
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation
// ---------------------------------------------------------------------------

export function assertCycleCountShape(envelope: EventEnvelope): void {
  const type = cycleCountEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  if (type === 'cycle_count.task_created') {
    if (!isNonEmptyString(p['cycle_count_id']) || !UUID_REGEX.test(p['cycle_count_id'] as string)) {
      throw new AppError(400, 'INVALID_PARAMS', 'cycle_count_id is required and must be a UUID');
    }
    if (!isNonEmptyString(p['location_id']) || !UUID_REGEX.test(p['location_id'] as string)) {
      throw new AppError(400, 'INVALID_PARAMS', 'location_id is required and must be a UUID');
    }
    if (!Array.isArray(p['sku_scope']) || p['sku_scope'].length === 0 || !p['sku_scope'].every(isNonEmptyString)) {
      throw new AppError(400, 'INVALID_PARAMS', 'sku_scope is required and must be a non-empty array of SKUs');
    }
    if (!isNonEmptyString(p['count_type'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'count_type is required');
    }
    if (typeof p['business_date'] !== 'string' || !DATE_REGEX.test(p['business_date'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'business_date is required and must be YYYY-MM-DD');
    }
    if (p['tolerance_percent'] !== undefined && !isNonNegativeFinite(p['tolerance_percent'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'tolerance_percent must be a non-negative number when supplied');
    }
    if (p['stock_class'] !== undefined && (typeof p['stock_class'] !== 'string' || !VALID_STOCK_CLASSES.has(p['stock_class']))) {
      throw new AppError(400, 'INVALID_PARAMS', `stock_class must be one of: ${[...VALID_STOCK_CLASSES].join(', ')}`);
    }
    return;
  }

  if (type === 'cycle_count.submitted') {
    if (!isNonEmptyString(p['cycle_count_id']) || !UUID_REGEX.test(p['cycle_count_id'] as string)) {
      throw new AppError(400, 'INVALID_PARAMS', 'cycle_count_id is required and must be a UUID');
    }
    if (!Array.isArray(p['lines']) || p['lines'].length === 0) {
      throw new AppError(400, 'INVALID_PARAMS', 'lines is required and must be a non-empty array');
    }
    for (const line of p['lines'] as unknown[]) {
      if (typeof line !== 'object' || line === null) {
        throw new AppError(400, 'INVALID_PARAMS', 'each count line must be an object');
      }
      const l = line as Record<string, unknown>;
      if (!isNonEmptyString(l['sku'])) {
        throw new AppError(400, 'INVALID_PARAMS', 'each count line requires a non-empty sku');
      }
      if (!isNonNegativeFinite(l['counted_quantity']) || (l['counted_quantity'] as number) > MAX_QUANTITY) {
        throw new AppError(400, 'INVALID_PARAMS', 'counted_quantity must be a non-negative finite number within bounds');
      }
      if (l['lot_id'] !== undefined && !isNonEmptyString(l['lot_id'])) {
        throw new AppError(400, 'INVALID_PARAMS', 'lot_id must be a non-empty string when supplied');
      }
      if (l['stock_class'] !== undefined && (typeof l['stock_class'] !== 'string' || !VALID_STOCK_CLASSES.has(l['stock_class']))) {
        throw new AppError(400, 'INVALID_PARAMS', `stock_class must be one of: ${[...VALID_STOCK_CLASSES].join(', ')}`);
      }
      if (l['serials'] !== undefined && (!Array.isArray(l['serials']) || !l['serials'].every(isNonEmptyString))) {
        throw new AppError(400, 'INVALID_PARAMS', 'serials must be an array of non-empty strings when supplied');
      }
    }
    return;
  }

  if (type === 'cycle_count.adjustment_approved' || type === 'cycle_count.adjustment_rejected') {
    if (!isNonEmptyString(p['adjustment_id']) || !UUID_REGEX.test(p['adjustment_id'] as string)) {
      throw new AppError(400, 'INVALID_PARAMS', 'adjustment_id is required and must be a UUID');
    }
    if (!isNonEmptyString(p['approver_actor_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'approver_actor_id is required');
    }
    if (!isNonEmptyString(p['reason_code'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'reason_code is required');
    }
    return;
  }

  if (type === 'stock.adjusted') {
    if (!isNonEmptyString(p['adjustment_id']) || !UUID_REGEX.test(p['adjustment_id'] as string)) {
      throw new AppError(400, 'INVALID_PARAMS', 'adjustment_id is required and must be a UUID');
    }
    if (!isNonEmptyString(p['sku'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'sku is required for stock.adjusted');
    }
    if (!isNonEmptyString(p['target_location_id']) || !UUID_REGEX.test(p['target_location_id'] as string)) {
      throw new AppError(400, 'INVALID_PARAMS', 'target_location_id is required and must be a UUID');
    }
    if (!isFiniteNumber(p['delta_quantity']) || p['delta_quantity'] === 0 || Math.abs(p['delta_quantity']) > MAX_QUANTITY) {
      throw new AppError(400, 'INVALID_PARAMS', 'delta_quantity must be a non-zero finite number within bounds');
    }
    if (p['available'] !== undefined) {
      throw new AppError(400, 'INVALID_PARAMS', 'available is derived and must not be supplied');
    }
    if (p['stock_class'] !== undefined && (typeof p['stock_class'] !== 'string' || !VALID_STOCK_CLASSES.has(p['stock_class']))) {
      throw new AppError(400, 'INVALID_PARAMS', `stock_class must be one of: ${[...VALID_STOCK_CLASSES].join(', ')}`);
    }
    if (!isNonEmptyString(p['reason_code'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'reason_code is required for stock.adjusted');
    }
    return;
  }

  if (type === 'physical_verification.completed') {
    if (!isNonEmptyString(p['physical_verification_id']) || !UUID_REGEX.test(p['physical_verification_id'] as string)) {
      throw new AppError(400, 'INVALID_PARAMS', 'physical_verification_id is required and must be a UUID');
    }
    if (!isNonEmptyString(p['location_id']) || !UUID_REGEX.test(p['location_id'] as string)) {
      throw new AppError(400, 'INVALID_PARAMS', 'location_id is required and must be a UUID');
    }
    if (!Array.isArray(p['count_refs']) || p['count_refs'].length === 0 || !p['count_refs'].every(isNonEmptyString)) {
      throw new AppError(400, 'INVALID_PARAMS', 'count_refs is required and must be a non-empty array of cycle_count_ids');
    }
    if (p['coverage_percentage'] !== undefined && !isNonNegativeFinite(p['coverage_percentage'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'coverage_percentage must be a non-negative number when supplied');
    }
    return;
  }

  if (type === 'physical_verification.signed_off') {
    if (!isNonEmptyString(p['physical_verification_id']) || !UUID_REGEX.test(p['physical_verification_id'] as string)) {
      throw new AppError(400, 'INVALID_PARAMS', 'physical_verification_id is required and must be a UUID');
    }
    if (!isNonEmptyString(p['management_signoff_actor_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'management_signoff_actor_id is required');
    }
  }
}

// ---------------------------------------------------------------------------
// Inside-transaction projection
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

/** Owned-stock unit cost from the Story 2.4 valuation projection; falls back to a line-supplied cost. */
async function resolveUnitCost(sku: string, fallback: number | null, client: PoolClient): Promise<number> {
  const r = await client.query(`SELECT running_average_cost FROM inventory_valuation WHERE sku = $1`, [sku]);
  const avg = r.rows[0]?.['running_average_cost'];
  if (avg !== undefined && avg !== null) return Number(avg);
  return fallback ?? 0;
}

export async function applyCycleCountProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = cycleCountEventType(envelope);
  if (!type) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;

  if (type === 'cycle_count.task_created') {
    const cycleCountId = p['cycle_count_id'] as string;
    const existing = await getCycleCountById(cycleCountId, client);
    if (existing) return;
    await insertCycleCountHeader(
      {
        cycle_count_id: cycleCountId,
        location_id: p['location_id'] as string,
        zone_id: (p['zone_id'] as string | undefined) ?? null,
        sku_scope: p['sku_scope'] as string[],
        stock_class: (p['stock_class'] as string | undefined) ?? null,
        count_type: p['count_type'] as string,
        business_date: p['business_date'] as string,
        business_stream: p['business_stream'] as string,
        tolerance_percent: (p['tolerance_percent'] as number | undefined) ?? 0,
        created_by_actor_id: (p['created_by_actor_id'] as string | undefined) ?? envelope.metadata.actor.user_id,
        notes: (p['notes'] as string | undefined) ?? null,
      },
      client,
    );
    return;
  }

  if (type === 'cycle_count.submitted') {
    await applySubmitted(envelope, client);
    return;
  }

  if (type === 'cycle_count.adjustment_approved') {
    await applyAdjustmentDecision(envelope, client, 'approved');
    return;
  }

  if (type === 'cycle_count.adjustment_rejected') {
    await applyAdjustmentDecision(envelope, client, 'rejected');
    return;
  }

  if (type === 'stock.adjusted') {
    await applyStockAdjusted(envelope, client, eventId);
    return;
  }

  if (type === 'physical_verification.completed') {
    await applyPhysicalVerificationCompleted(envelope, client, eventId);
    return;
  }

  if (type === 'physical_verification.signed_off') {
    await applyPhysicalVerificationSignedOff(envelope, client);
    return;
  }
}

// --- cycle_count.submitted -------------------------------------------------

async function applySubmitted(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const cycleCountId = p['cycle_count_id'] as string;
  const lines = p['lines'] as Array<Record<string, unknown>>;
  const submittedBy = (p['submitted_by_actor_id'] as string | undefined) ?? envelope.metadata.actor.user_id;
  const approverActorId = (p['approver_actor_id'] as string | undefined) ?? null;

  const header = await getCycleCountById(cycleCountId, client, true);
  if (!header) {
    throw new AppError(404, 'NOT_FOUND', `Cycle count "${cycleCountId}" not found`);
  }
  // Idempotent: a re-submit after the count is already recorded is a no-op.
  if (header.status !== 'open') {
    if (header.status === 'submitted' || header.status === 'completed') return;
    throw new AppError(409, CYCLE_COUNT_ERROR_CODES.COUNT_TASK_LOCKED, `Cycle count is in status "${header.status}"`);
  }

  const { randomUUID } = await import('node:crypto');

  for (const line of lines) {
    const sku = line['sku'] as string;
    const lotId = (line['lot_id'] as string | undefined) ?? null;
    const stockClass = (line['stock_class'] as string | undefined) ?? header.stock_class ?? 'owned';
    const counted = line['counted_quantity'] as number;
    const serials = line['serials'] as string[] | undefined;

    // Lot / serial control (Story 2.3 preservation): a lot-controlled item must supply a lot line;
    // a serial-controlled item must supply counted serials matching the counted quantity.
    const item = await getItemBySku(sku, client);
    if (item?.serial_controlled) {
      if (!serials || serials.length === 0) {
        throw new AppError(400, 'SERIAL_REQUIRED', `Serial-controlled item "${sku}" requires counted serials`, { sku });
      }
      if (serials.length !== counted) {
        throw new AppError(400, 'INVALID_PARAMS', 'Counted serials must match counted_quantity for a serial-controlled item', {
          sku,
          serials: serials.length,
          counted_quantity: counted,
        });
      }
    } else if (item?.lot_controlled && !lotId) {
      throw new AppError(400, 'LOT_REQUIRED', `Lot-controlled item "${sku}" requires a lot on the count line`, { sku });
    }

    // Lock the balance rows at this grain and read the book (on_hand) baseline, plus allocated /
    // in_transit reported separately so counters never make hidden adjustments for reserved or
    // shipped stock (Task 4).
    await client.query(
      `SELECT balance_id FROM stock_balance
       WHERE sku = $1 AND location_id = $2 AND ($3::text IS NULL OR lot_id = $3) AND stock_class = $4
       FOR UPDATE`,
      [sku, header.location_id, lotId, stockClass],
    );
    const bookRow = await client.query(
      `SELECT COALESCE(SUM(on_hand), 0)::text AS on_hand,
              COALESCE(SUM(allocated), 0)::text AS allocated,
              COALESCE(SUM(in_transit), 0)::text AS in_transit
       FROM stock_balance
       WHERE sku = $1 AND location_id = $2 AND ($3::text IS NULL OR lot_id = $3) AND stock_class = $4`,
      [sku, header.location_id, lotId, stockClass],
    );
    const book = Number(bookRow.rows[0]!['on_hand']);
    const allocated = Number(bookRow.rows[0]!['allocated']);
    const inTransit = Number(bookRow.rows[0]!['in_transit']);
    const variance = counted - book;

    // Tolerance: percent of book when configured; zero tolerance means any non-zero variance
    // breaches and routes to approval (Task 4 default).
    let breach: boolean;
    if (header.tolerance_percent > 0 && book > 0) {
      breach = (Math.abs(variance) / book) * 100 > header.tolerance_percent;
    } else {
      breach = variance !== 0;
    }

    const unitCost = await resolveUnitCost(sku, (line['unit_cost'] as number | undefined) ?? null, client);
    const varianceValue = Math.abs(variance) * unitCost;

    let adjustmentId: string | null = null;
    let adjustmentStatus: string | null = null;
    let lineApprover: string | null = null;
    if (breach && variance !== 0) {
      adjustmentId = randomUUID();
      adjustmentStatus = 'pending_approval';
      lineApprover = approverActorId;
    }

    await insertCycleCountLine(
      {
        cycle_count_id: cycleCountId,
        sku,
        lot_id: lotId,
        stock_class: stockClass,
        counted_quantity: counted,
        book_quantity: book,
        allocated_quantity: allocated,
        in_transit_quantity: inTransit,
        variance_quantity: variance,
        variance_value: varianceValue,
        tolerance_breach: breach,
        adjustment_id: adjustmentId,
        adjustment_status: adjustmentStatus,
        approver_actor_id: lineApprover,
      },
      client,
    );
  }

  await markCycleCountSubmitted(cycleCountId, submittedBy, client);
}

// --- cycle_count.adjustment_approved / _rejected ---------------------------

async function applyAdjustmentDecision(
  envelope: EventEnvelope,
  client: PoolClient,
  decision: 'approved' | 'rejected',
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const adjustmentId = p['adjustment_id'] as string;
  const approver = p['approver_actor_id'] as string;
  const reasonCode = p['reason_code'] as string;

  const line = await getCycleCountLineByAdjustment(adjustmentId, client, true);
  if (!line) {
    throw new AppError(404, 'NOT_FOUND', `No adjustment "${adjustmentId}" found`);
  }
  // Idempotent: a repeated decision that already landed is a no-op.
  if (line.adjustment_status === decision || line.adjustment_status === 'applied') return;
  if (line.adjustment_status !== 'pending_approval') {
    throw new AppError(409, 'INVALID_STATE', `Adjustment is in status "${line.adjustment_status}"`);
  }

  // Segregation of duties (Task 5): the count submitter must not approve the resulting adjustment.
  const header = await getCycleCountById(line.cycle_count_id, client);
  if (header?.submitted_by_actor_id && header.submitted_by_actor_id === approver) {
    throw new AppError(403, CYCLE_COUNT_ERROR_CODES.COUNT_ENTERER_CANNOT_APPROVE, 'The count submitter cannot approve its own adjustment');
  }

  await setAdjustmentStatus(adjustmentId, decision, reasonCode, approver, client);
}

// --- stock.adjusted (the AC2 / Task 5 enforcement point) -------------------

async function applyStockAdjusted(envelope: EventEnvelope, client: PoolClient, eventId: string): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const adjustmentId = p['adjustment_id'] as string;
  const sku = p['sku'] as string;
  const locationId = p['target_location_id'] as string;
  const lotId = (p['lot_id'] as string | undefined) ?? null;
  const stockClass = (p['stock_class'] as string | undefined) ?? 'owned';
  const delta = p['delta_quantity'] as number;

  const line = await getCycleCountLineByAdjustment(adjustmentId, client, true);
  // AC2: no approved adjustment backing this stock mutation -> reject centrally, so a direct
  // POST /api/v1/events or edge upload cannot bypass the approval gate.
  if (!line) {
    throw new AppError(403, CYCLE_COUNT_ERROR_CODES.APPROVAL_REQUIRED, 'Stock adjustment requires an approved cycle-count adjustment', {
      adjustment_id: adjustmentId,
    });
  }
  // Idempotent: the adjustment was already applied.
  if (line.adjustment_status === 'applied') return;
  if (line.adjustment_status !== 'approved') {
    throw new AppError(403, CYCLE_COUNT_ERROR_CODES.APPROVAL_REQUIRED, 'Stock adjustment requires an approved cycle-count adjustment', {
      adjustment_id: adjustmentId,
      adjustment_status: line.adjustment_status,
    });
  }

  // Lock the target balance grain and apply the signed delta.
  await client.query(
    `SELECT balance_id FROM stock_balance
     WHERE sku = $1 AND location_id = $2 AND ($3::text IS NULL OR lot_id = $3) AND stock_class = $4
     FOR UPDATE`,
    [sku, locationId, lotId, stockClass],
  );

  if (delta > 0) {
    await client.query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (sku, location_id, lot_id, stock_class)
       DO UPDATE SET on_hand = stock_balance.on_hand + EXCLUDED.on_hand, updated_at = now()`,
      [sku, locationId, lotId, stockClass, delta],
    );
  } else {
    const cur = await client.query(
      `SELECT COALESCE(SUM(on_hand), 0)::text AS on_hand, COALESCE(SUM(allocated), 0)::text AS allocated
       FROM stock_balance
       WHERE sku = $1 AND location_id = $2 AND ($3::text IS NULL OR lot_id = $3) AND stock_class = $4`,
      [sku, locationId, lotId, stockClass],
    );
    const onHand = Number(cur.rows[0]!['on_hand']);
    const allocated = Number(cur.rows[0]!['allocated']);
    const newOnHand = onHand + delta; // delta is negative
    if (newOnHand < 0 || allocated > newOnHand) {
      throw new AppError(409, CYCLE_COUNT_ERROR_CODES.STOCK_ADJUSTMENT_NEGATIVE_BALANCE, 'Negative adjustment would drive on_hand below zero or below allocated', {
        sku,
        location_id: locationId,
        ...(lotId !== null ? { lot_id: lotId } : {}),
        on_hand: onHand,
        allocated,
        delta_quantity: delta,
      });
    }
    const upd = await client.query(
      `UPDATE stock_balance SET on_hand = on_hand + $5, updated_at = now()
       WHERE sku = $1 AND location_id = $2 AND ($3::text IS NULL OR lot_id = $3) AND stock_class = $4`,
      [sku, locationId, lotId, stockClass, delta],
    );
    if (upd.rowCount === 0) {
      throw new AppError(409, CYCLE_COUNT_ERROR_CODES.STOCK_ADJUSTMENT_NEGATIVE_BALANCE, 'No stock_balance row to apply the negative adjustment against', {
        sku,
        location_id: locationId,
      });
    }
  }

  // Traceability (Task 6): an adjustment against a known lot appends a recall-trace entry, so
  // adjustment events are not invisible to lot trace.
  if (lotId) {
    const lot = await getLotByNumberAndSku(lotId, sku, client);
    if (lot) {
      await appendTraceEntry(
        {
          lot_id: lot.lot_id,
          event_id: eventId,
          event_type: envelope.event_type,
          sku,
          location_id: locationId,
          location_code: null,
          quantity_change: String(delta),
          business_stream: envelope.payload['business_stream'] as string,
          timestamp: envelope.metadata.occurred_at,
        },
        client,
      );
    }
  }

  // Owned-stock valuation (Task 6): quantity and carrying value move consistently with on_hand.
  // Non-owned stock classes never change owned carrying value.
  if (stockClass === 'owned') {
    const val = await client.query(
      `SELECT quantity_on_hand::text AS q, running_average_cost::text AS c, carrying_value::text AS cv
       FROM inventory_valuation WHERE sku = $1 FOR UPDATE`,
      [sku],
    );
    if (val.rows.length > 0) {
      const qty = Number(val.rows[0]!['q']);
      const avg = val.rows[0]!['c'] !== null ? Number(val.rows[0]!['c']) : 0;
      const carrying = Number(val.rows[0]!['cv']);
      const newQty = Math.max(qty + delta, 0);
      const newCarrying = Math.max(carrying + delta * avg, 0);
      await client.query(
        `UPDATE inventory_valuation SET quantity_on_hand = $2, carrying_value = $3 WHERE sku = $1`,
        [sku, newQty, newCarrying],
      );
    }
  }

  await markAdjustmentApplied(adjustmentId, eventId, client);
}

// --- physical_verification.completed ---------------------------------------

async function applyPhysicalVerificationCompleted(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const pvId = p['physical_verification_id'] as string;

  const existing = await getPhysicalVerificationById(pvId, client, true);
  if (existing) {
    // Cannot re-complete a locked report; a correction must be a new verification (Task 8).
    if (existing.period_locked) {
      throw new AppError(409, CYCLE_COUNT_ERROR_CODES.PERIOD_LOCKED, 'Physical verification is signed off and locked', { physical_verification_id: pvId });
    }
    return;
  }

  const countRefs = p['count_refs'] as string[];
  const businessDate = (p['business_date'] as string | undefined) ?? null;

  await insertPhysicalVerificationHeader(
    {
      physical_verification_id: pvId,
      location_id: p['location_id'] as string,
      coverage_percentage: (p['coverage_percentage'] as number | undefined) ?? 0,
      period_start: (p['period_start'] as string | undefined) ?? null,
      period_end: (p['period_end'] as string | undefined) ?? null,
      business_date: businessDate,
      count_refs: countRefs,
      completed_by_actor_id: (p['completed_by_actor_id'] as string | undefined) ?? envelope.metadata.actor.user_id,
      source_event_id: eventId,
    },
    client,
  );

  // Snapshot the count lines into append-only evidence rows (Task 2 / Task 8).
  for (const countId of countRefs) {
    const header = await getCycleCountById(countId, client);
    const lines = await getCycleCountLines(countId, client);
    for (const l of lines) {
      await insertPhysicalVerificationLine(
        {
          physical_verification_id: pvId,
          cycle_count_id: countId,
          count_date: header?.business_date ?? businessDate,
          sku: l.sku,
          lot_id: l.lot_id,
          stock_class: l.stock_class,
          book_quantity: l.book_quantity,
          counted_quantity: l.counted_quantity,
          variance_quantity: l.variance_quantity,
          variance_value: l.variance_value,
          adjustment_event_ref: l.applied_event_id,
          counter_actor_id: header?.submitted_by_actor_id ?? null,
          approver_actor_id: l.approver_actor_id,
        },
        client,
      );
    }
  }
}

// --- physical_verification.signed_off --------------------------------------

async function applyPhysicalVerificationSignedOff(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const pvId = p['physical_verification_id'] as string;
  const signoffActor = p['management_signoff_actor_id'] as string;
  const signedOffAt = (p['signed_off_at'] as string | undefined) ?? envelope.metadata.occurred_at;

  const header = await getPhysicalVerificationById(pvId, client, true);
  if (!header) {
    throw new AppError(404, 'NOT_FOUND', `Physical verification "${pvId}" not found`);
  }
  // Idempotent: already signed off is a no-op; a second distinct sign-off is period-locked.
  if (header.period_locked || header.signed_off_at) {
    if (header.management_signoff_actor_id === signoffActor) return;
    throw new AppError(409, CYCLE_COUNT_ERROR_CODES.PERIOD_LOCKED, 'Physical verification is already signed off and locked', { physical_verification_id: pvId });
  }

  await markPhysicalVerificationSignedOff(pvId, signoffActor, signedOffAt, client);
}
