import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import type {
  PickLineConfirmedEnvelope,
  PickLineShortPickedEnvelope,
  PickTaskCompletedEnvelope,
  PickTaskCreatedEnvelope,
  PickLineInput,
} from '../events/schema.js';
import { AppError } from '../middleware/error.js';
import { assertActorAtSite } from './actor-site.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import {
  createPickTask,
  getPickTaskById,
  getPickTaskByIdForUpdate,
  updatePickTaskStatus,
} from '../read/projections/pick_task.js';
import {
  confirmPickLine,
  createPickLine,
  getPickLineByIdForUpdate,
} from '../read/projections/pick_line.js';
import {
  applyStockPick,
  applyStockIssue,
  applyStockReceipt,
  applyStockAllocationRelief,
} from '../read/projections/stock_balance.js';
import { openPickShortDamageCase } from './damage.js';
import { QC_HOLD_ZONE_CODE } from './receiving.js';
import { assertQcGateAllows, gateBusinessDateOf } from './quality.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRATEGIES = ['single', 'batch', 'wave', 'zone'];
// SOD (Task 6.2): completing a pick task is a supervisor action, enforced here on the central
// write path so the edge and direct-event routes cannot bypass the HTTP handler's role check.
const PICK_COMPLETE_ROLES = ['warehouse_manager', 'inventory_controller'];

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

const NUMERIC_REGEX = /^-?\d+(\.\d+)?$/;
const QUANTITY_SCALE = 6;
const QUANTITY_FACTOR = 1_000_000n;

function numericToMicro(value: string | number): bigint {
  const s = typeof value === 'number' ? value.toString() : value;
  const clean = s.trim();
  const [intPart = '0', fracPart = ''] = clean.split('.');
  const frac = (fracPart + '0'.repeat(QUANTITY_SCALE)).slice(0, QUANTITY_SCALE);
  const sign = clean.startsWith('-') ? -1n : 1n;
  return sign * (BigInt(intPart.replace('-', '')) * QUANTITY_FACTOR + BigInt(frac));
}

function isPositiveFiniteQuantity(value: unknown): value is string | number {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0;
  }
  if (typeof value !== 'string' || value.length === 0) return false;
  if (!NUMERIC_REGEX.test(value)) return false;
  const n = numericToMicro(value);
  return n > 0n;
}

function isNonNegativeFiniteQuantity(value: unknown): value is string | number {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0;
  }
  if (typeof value !== 'string' || value.length === 0) return false;
  if (!NUMERIC_REGEX.test(value)) return false;
  const n = numericToMicro(value);
  return n >= 0n;
}

const SHORT_REASONS = ['BIN_EMPTY', 'LESS_IN_BIN', 'DAMAGED', 'OTHER'] as const;

/**
 * pick_task/pick_line quantities persist into NUMERIC(14,3) columns. A value with significant
 * digits beyond 3 decimal places would round on write, so a later replay of the same event would
 * compare unequal against the stored row and be misjudged a conflicting re-confirmation. Reject
 * at the shape boundary instead (fail closed). Trailing zeros beyond 3 places are fine.
 */
function hasMilliPrecision(value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  // Review pass 2: check the RAW fraction first. numericToMicro slices the fraction to 6 digits,
  // so testing its output alone let a value like "5.0000009" (which does round on write) pass the
  // guard whose contract is to fail closed, and made two different confirmations compare equal on
  // replay. Anything carrying more than 3 decimal places is rejected here.
  const raw = typeof value === 'number' ? value.toString() : value.trim();
  const fraction = raw.includes('.') ? raw.slice(raw.indexOf('.') + 1) : '';
  if (fraction.replace(/0+$/, '').length > 3) return false;
  try {
    return numericToMicro(value) % 1_000n === 0n;
  } catch {
    return false;
  }
}

function reject(message: string, details: Record<string, unknown> = {}): never {
  throw new AppError(400, 'PICK_TASK_INVALID_PAYLOAD', message, details);
}

/** Story 3.6 Task 5.2: pre-transaction shape validation for pick_task.created (no DB access). */
export function assertPickTaskCreatedShape(envelope: PickTaskCreatedEnvelope): void {
  const p = envelope.payload;
  if (!isUuid(p.pick_task_id)) reject('pick_task_id is required and must be a UUID');
  if (!isUuid(p.dispatch_order_id)) reject('dispatch_order_id is required and must be a UUID');
  if (typeof p.sku !== 'string' || p.sku.length === 0) reject('sku is required');
  if (!isPositiveFiniteQuantity(p.quantity) || !hasMilliPrecision(p.quantity))
    reject(
      'quantity is required and must be a positive finite numeric value with at most 3 decimal places',
    );
  // Pilot B3: an explicit null is the lot-less form (stock that is not lot-controlled); a missing
  // or malformed value is still rejected.
  if (p.lot_id !== null && !isUuid(p.lot_id))
    reject('lot_id is required and must be a UUID, or null for stock that is not lot-controlled');
  if (!isUuid(p.location_id)) reject('location_id is required and must be a UUID');
  if (!Number.isInteger(p.pick_sequence))
    reject('pick_sequence is required and must be an integer');
  if (!STRATEGIES.includes(p.strategy))
    reject("strategy must be one of 'single', 'batch', 'wave', 'zone'");
  if (!isUuid(p.zone_id)) reject('zone_id is required and must be a UUID');
  if (p.wave_id !== undefined && p.wave_id !== null && !isUuid(p.wave_id))
    reject('wave_id must be a UUID when present');
  if (p.batch_id !== undefined && p.batch_id !== null && !isUuid(p.batch_id))
    reject('batch_id must be a UUID when present');
  if (!Array.isArray(p.pick_lines) || p.pick_lines.length === 0)
    reject('pick_lines is required and must be a non-empty array');
  for (const line of p.pick_lines) {
    if (!isUuid(line.pick_line_id))
      reject('pick_lines[].pick_line_id is required and must be a UUID');
    if (!isUuid(line.dispatch_order_line_id))
      reject('pick_lines[].dispatch_order_line_id is required and must be a UUID');
    if (typeof line.sku !== 'string' || line.sku.length === 0)
      reject('pick_lines[].sku is required');
    if (line.directed_lot_id !== null && !isUuid(line.directed_lot_id))
      reject(
        'pick_lines[].directed_lot_id is required and must be a UUID, or null for stock that is not lot-controlled',
      );
    if (
      !isPositiveFiniteQuantity(line.directed_quantity) ||
      !hasMilliPrecision(line.directed_quantity)
    )
      reject(
        'pick_lines[].directed_quantity is required and must be a positive finite numeric value with at most 3 decimal places',
      );
    if (!isUuid(line.location_id))
      reject('pick_lines[].location_id is required and must be a UUID');
    if (!Number.isInteger(line.pick_sequence))
      reject('pick_lines[].pick_sequence is required and must be an integer');
  }
}

/** Story 3.6 Task 5.2: pre-transaction shape validation for pick_line.confirmed (no DB access). */
export function assertPickLineConfirmedShape(envelope: PickLineConfirmedEnvelope): void {
  const p = envelope.payload;
  if (!isUuid(p.pick_task_id)) reject('pick_task_id is required and must be a UUID');
  if (!isUuid(p.pick_line_id)) reject('pick_line_id is required and must be a UUID');
  if (p.confirmed_lot_id !== null && !isUuid(p.confirmed_lot_id))
    reject(
      'confirmed_lot_id is required and must be a UUID, or null for stock that is not lot-controlled',
    );
  // Story 3.17 (Task 6.5): a lot substitution may carry the scanned lot number when the edge has
  // no lot_master replica; it is resolved to a UUID in-transaction against the line's SKU.
  if (
    p.confirmed_lot_number !== undefined &&
    p.confirmed_lot_number !== null &&
    (typeof p.confirmed_lot_number !== 'string' ||
      p.confirmed_lot_number.trim().length === 0 ||
      p.confirmed_lot_number.length > 64)
  )
    reject('confirmed_lot_number must be a non-empty string of at most 64 characters');
  if (!isPositiveFiniteQuantity(p.confirmed_quantity) || !hasMilliPrecision(p.confirmed_quantity))
    reject(
      'confirmed_quantity is required and must be a positive finite numeric value with at most 3 decimal places',
    );
  if (p.capture_method !== 'PWA' && p.capture_method !== 'PAPER')
    reject("capture_method must be 'PWA' or 'PAPER'");
  // override_reason requiredness compares against the directed lot, which needs DB access -
  // enforced in applyPickLineConfirmedProjection, not here.
}

/** Story 3.17 Task 2.2: pre-transaction shape validation for pick_line.short_picked (no DB access). */
export function assertPickLineShortPickedShape(envelope: PickLineShortPickedEnvelope): void {
  const p = envelope.payload;
  if (!p || typeof p !== 'object') reject('payload is required');
  if (!isUuid(p.pick_task_id)) reject('pick_task_id is required and must be a UUID');
  if (!isUuid(p.pick_line_id)) reject('pick_line_id is required and must be a UUID');
  if (!isNonNegativeFiniteQuantity(p.found_quantity) || !hasMilliPrecision(p.found_quantity)) {
    reject(
      'found_quantity is required and must be a non-negative finite numeric value with at most 3 decimal places',
    );
  }
  if (!SHORT_REASONS.includes(p.reason as (typeof SHORT_REASONS)[number])) {
    reject("reason must be 'BIN_EMPTY', 'LESS_IN_BIN', 'DAMAGED', or 'OTHER'");
  }
  if (p.capture_method !== 'PWA' && p.capture_method !== 'PAPER') {
    reject("capture_method must be 'PWA' or 'PAPER'");
  }
  if (p.note !== undefined && p.note !== null && (typeof p.note !== 'string' || p.note.length > 200)) {
    reject('note must be at most 200 characters');
  }
}

/** Story 3.6 Task 5.2: pre-transaction shape validation for pick_task.completed (no DB access). */
export function assertPickTaskCompletedShape(envelope: PickTaskCompletedEnvelope): void {
  const p = envelope.payload;
  if (!isUuid(p.pick_task_id)) reject('pick_task_id is required and must be a UUID');
}

/** Bridges a lot_master.lot_id UUID to the lot_number TEXT key stock_balance rows carry. */
async function lotNumberForUuid(lotUuid: string, sku: string, client: PoolClient): Promise<string> {
  const result = await client.query(
    `SELECT lot_number FROM lot_master WHERE lot_id = $1 AND sku = $2`,
    [lotUuid, sku],
  );
  if (result.rows.length === 0) {
    throw new AppError(
      404,
      'LOT_NOT_FOUND',
      `No lot exists for lot_id "${lotUuid}" and sku "${sku}"`,
      { lot_id: lotUuid, sku },
    );
  }
  return result.rows[0]!['lot_number'] as string;
}

/**
 * Allocates `quantity` of owned stock for (sku, location, lot_number), guarded on availability in
 * the same UPDATE (defensive against races - the generator already checked availability).
 * `available` is a generated column (on_hand - allocated - picked), so only `allocated` is written.
 * Pilot B3: a null lotNumber addresses the lot-less row (stock_balance.lot_id IS NULL) and only
 * that row, the same `IS NOT DISTINCT FROM` grain match the cycle-count writes use.
 */
async function allocateStock(
  sku: string,
  locationId: string,
  lotNumber: string | null,
  quantity: string,
  client: PoolClient,
): Promise<void> {
  const result = await client.query(
    `UPDATE stock_balance
        SET allocated = allocated + $1::numeric, updated_at = now()
      WHERE sku = $2 AND location_id = $3 AND lot_id IS NOT DISTINCT FROM $4::text
        AND stock_class = 'owned'
        AND available >= $1::numeric`,
    [quantity, sku, locationId, lotNumber],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new AppError(
      409,
      'INSUFFICIENT_STOCK_FOR_PICK',
      'Available stock does not cover the pick allocation',
      {
        sku,
        location_id: locationId,
        lot_number: lotNumber,
        requested_quantity: quantity,
      },
    );
  }
}

/**
 * Releases a previously-taken allocation. Fails closed (review pass 2): scoped to
 * `allocated >= quantity` with the affected row count checked, so a missing or already-drained row
 * raises instead of silently releasing nothing and leaving the site's total allocation above real
 * demand. Its sibling allocateStock has always thrown; the asymmetry was the defect.
 */
async function releaseStock(
  sku: string,
  locationId: string,
  lotNumber: string | null,
  quantity: string,
  client: PoolClient,
): Promise<void> {
  const result = await client.query(
    `UPDATE stock_balance
        SET allocated = allocated - $1::numeric, updated_at = now()
      WHERE sku = $2 AND location_id = $3 AND lot_id IS NOT DISTINCT FROM $4::text
        AND stock_class = 'owned'
        AND allocated >= $1::numeric`,
    [quantity, sku, locationId, lotNumber],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new AppError(
      409,
      'INSUFFICIENT_STOCK_FOR_PICK',
      'No allocation to release at this bin and lot',
      {
        sku,
        location_id: locationId,
        lot_number: lotNumber,
        requested_quantity: quantity,
      },
    );
  }
}

/**
 * Story 3.6 (review pass 2): site isolation belongs on the central write path, not only in the
 * pick-tasks HTTP handlers. Without this, POST /api/v1/events and POST /api/v1/edge/events - both
 * authorized on `module = stream_type` plus write, with no comparison against the target task's
 * site - let a caller scoped to one site confirm pick lines and mutate stock at another.
 *
 * The actor location is server-set on every path: the HTTP/edge layers overwrite it with the
 * authorizing assignment's location, and a wildcard ('*') assignment yields the all-zero sentinel,
 * which is treated as unrestricted exactly as the other modules do. The rule itself is the shared
 * assertActorAtSite (src/compliance/actor-site.ts): at the site, or at a location of that site.
 */

/**
 * Pilot B3: a lot-less pick line is only valid for an item that is not lot-controlled. The
 * generator already excludes lot-less balances of lot-controlled items; this repeats the rule on
 * the central write path so the edge and direct-event routes cannot direct a pick that bypasses
 * the lot hold and QC gates.
 */
async function assertLotLessPickAllowed(sku: string, client: PoolClient): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM item_master WHERE sku = $1 AND lot_controlled = true`,
    [sku],
  );
  if (result.rows.length > 0) {
    throw new AppError(
      400,
      'PICK_TASK_INVALID_PAYLOAD',
      `Item "${sku}" is lot-controlled; a pick line must direct a lot`,
      { sku },
    );
  }
}

/** Resolves the site a pick task belongs to through the Story 2.9 sales-order projection. */
async function siteForPickTask(pickTaskId: string, client: PoolClient): Promise<string | null> {
  const result = await client.query(
    `SELECT eso.ship_from_site_id
       FROM pick_task pt
       JOIN erp_sales_order eso ON eso.id = pt.dispatch_order_id
      WHERE pt.pick_task_id = $1`,
    [pickTaskId],
  );
  return result.rows.length > 0 ? (result.rows[0]!['ship_from_site_id'] as string) : null;
}

/**
 * Story 3.6 Task 5.3: in-transaction apply for pick_task.created. Inserts the task and its pick
 * lines, then allocates stock for every line. A replay of an already-applied event (task row
 * exists) is a no-op so the allocation is never double-taken.
 */
export async function applyPickTaskCreatedProjection(
  envelope: PickTaskCreatedEnvelope,
  client: PoolClient,
  _eventId: string,
): Promise<void> {
  const p = envelope.payload;

  const existing = await getPickTaskById(p.pick_task_id, client);
  if (existing) return; // idempotent replay - projection rows and allocations already applied

  // Review pass 2: the dispatch order must exist before any stock is allocated against it.
  // pick_task carries no foreign key to the ERP projection, and both listPickTasks and the site
  // resolver INNER JOIN it, so an unknown dispatch_order_id previously produced an invisible task
  // that had already taken an allocation nothing could release.
  const orderLine = await client.query(
    `SELECT ship_from_site_id FROM erp_sales_order WHERE id = $1`,
    [p.dispatch_order_id],
  );
  if (orderLine.rows.length === 0) {
    throw new AppError(
      404,
      'DISPATCH_ORDER_LINE_NOT_FOUND',
      `No sales-order line exists for "${p.dispatch_order_id}"`,
      {
        dispatch_order_id: p.dispatch_order_id,
      },
    );
  }
  await assertActorAtSite(
    envelope.metadata.actor.location_id,
    orderLine.rows[0]!['ship_from_site_id'] as string,
    {
      pick_task_id: p.pick_task_id,
    },
    client,
  );

  await createPickTask(
    {
      pick_task_id: p.pick_task_id,
      dispatch_order_id: p.dispatch_order_id,
      sku: p.sku,
      total_quantity: String(p.quantity),
      strategy: p.strategy,
      wave_id: p.wave_id ?? null,
      batch_id: p.batch_id ?? null,
      zone_id: p.zone_id,
      created_by: envelope.metadata.actor.user_id,
    },
    client,
  );

  for (const line of p.pick_lines as PickLineInput[]) {
    await createPickLine(
      {
        pick_line_id: line.pick_line_id,
        pick_task_id: p.pick_task_id,
        dispatch_order_line_id: line.dispatch_order_line_id,
        sku: line.sku,
        directed_lot_id: line.directed_lot_id,
        directed_quantity: String(line.directed_quantity),
        location_id: line.location_id,
        pick_sequence: line.pick_sequence,
      },
      client,
    );
    // Pilot B3: a lot-less line has no lot_master row, so there is no lot number to bridge and no
    // lot for the QC gate to lock; it allocates the lot-less balance row directly.
    let lotNumber: string | null = null;
    if (line.directed_lot_id === null) {
      await assertLotLessPickAllowed(line.sku, client);
    } else {
      lotNumber = await lotNumberForUuid(line.directed_lot_id, line.sku, client);
      // Story 8.1 (Task 6): picking is a sales path - blocked for qc_hold AND conditionally released
      // lots until the Story 8.4 batch release record exists. Lot lock, gate lock, then the stock row.
      await assertQcGateAllows({
        lot_id: line.directed_lot_id,
        operation: 'pick',
        business_date: gateBusinessDateOf(envelope),
        client,
      });
    }
    await allocateStock(
      line.sku,
      line.location_id,
      lotNumber,
      String(line.directed_quantity),
      client,
    );
  }
}

/**
 * Story 3.6 Task 5.4: in-transaction apply for pick_line.confirmed. Idempotent replay of the same
 * confirmation is a no-op success; a conflicting re-confirmation rejects
 * PICK_LINE_ALREADY_CONFIRMED. A substitution requires an override reason (AC6/AC8), releases the
 * directed lot's allocation, and allocates the confirmed lot at its current bin.
 */
export async function applyPickLineConfirmedProjection(
  envelope: PickLineConfirmedEnvelope,
  client: PoolClient,
  _eventId: string,
): Promise<void> {
  const p = envelope.payload;

  // Review pass 2: lock the line first. An unlocked read let two concurrent identical
  // confirmations both observe `pending`, after which the loser got a spurious 409 that the edge
  // outbox settles as needs_attention on what was actually a success.
  const line = await getPickLineByIdForUpdate(p.pick_line_id, client);
  if (!line) {
    throw new AppError(404, 'PICK_LINE_NOT_FOUND', `No pick line exists for "${p.pick_line_id}"`, {
      pick_line_id: p.pick_line_id,
    });
  }
  if (line.pick_task_id !== p.pick_task_id) {
    throw new AppError(
      404,
      'PICK_LINE_NOT_FOUND',
      `Pick line "${p.pick_line_id}" does not belong to task "${p.pick_task_id}"`,
      {
        pick_line_id: p.pick_line_id,
        pick_task_id: p.pick_task_id,
      },
    );
  }

  // Story 3.17 (Task 6.5): resolve a substituted lot sent by number (edge has no lot_master
  // replica) to its UUID scoped to this line's SKU, before any status/idempotency comparison so a
  // replay of the same substitution compares equal.
  let confirmedLotId = p.confirmed_lot_id;
  if (
    confirmedLotId === null &&
    typeof p.confirmed_lot_number === 'string' &&
    p.confirmed_lot_number.trim().length > 0
  ) {
    const lotRes = await client.query(
      `SELECT lot_id FROM lot_master WHERE sku = $1 AND lot_number = $2 LIMIT 1`,
      [line.sku, p.confirmed_lot_number.trim()],
    );
    if (lotRes.rows.length === 0) {
      throw new AppError(
        404,
        'LOT_NOT_FOUND',
        `No lot "${p.confirmed_lot_number}" exists for SKU "${line.sku}"`,
        { pick_line_id: p.pick_line_id, sku: line.sku, confirmed_lot_number: p.confirmed_lot_number },
      );
    }
    confirmedLotId = lotRes.rows[0]!['lot_id'] as string;
  }

  if (line.status === 'confirmed' || line.status === 'substituted') {
    const sameLot = line.confirmed_lot_id === confirmedLotId;
    const sameQty =
      line.confirmed_quantity !== null &&
      numericToMicro(line.confirmed_quantity) === numericToMicro(p.confirmed_quantity);
    if (sameLot && sameQty) return; // idempotent replay - no re-mutation
    throw new AppError(
      409,
      'PICK_LINE_ALREADY_CONFIRMED',
      'Pick line is already confirmed with a different lot or quantity',
      {
        pick_line_id: p.pick_line_id,
        confirmed_lot_id: line.confirmed_lot_id,
        confirmed_quantity: line.confirmed_quantity,
      },
    );
  }
  if (line.status === 'cancelled') {
    throw new AppError(
      409,
      'PICK_LINE_ALREADY_CONFIRMED',
      'Pick line has been cancelled and cannot be confirmed',
      {
        pick_line_id: p.pick_line_id,
      },
    );
  }

  const taskSiteId = await siteForPickTask(p.pick_task_id, client);
  if (taskSiteId === null) {
    throw new AppError(404, 'PICK_TASK_NOT_FOUND', `No pick task exists for "${p.pick_task_id}"`, {
      pick_task_id: p.pick_task_id,
    });
  }
  await assertActorAtSite(
    envelope.metadata.actor.location_id,
    taskSiteId,
    { pick_line_id: p.pick_line_id, pick_task_id: p.pick_task_id },
    client,
  );

  // Story 3.6 / Story 3.17: a confirmed quantity must equal the directed quantity. Short picks
  // must be submitted via pick_line.short_picked.
  if (numericToMicro(p.confirmed_quantity) !== numericToMicro(line.directed_quantity)) {
    throw new AppError(
      400,
      'PICK_QUANTITY_MISMATCH',
      'confirmed_quantity must equal the directed quantity for this pick line',
      {
        pick_line_id: p.pick_line_id,
        directed_quantity: line.directed_quantity,
        confirmed_quantity: String(p.confirmed_quantity),
      },
    );
  }

// Pilot B3: a lot-less line is confirmed lot-less and a lot line against a lot. Crossing the two
// is not a substitution (there is no lot on one side to release or to gate), so it is refused.
  if ((confirmedLotId === null) !== (line.directed_lot_id === null)) {
    throw new AppError(
      400,
      'PICK_TASK_INVALID_PAYLOAD',
      line.directed_lot_id === null
        ? 'This pick line directs stock that is not lot-controlled; confirmed_lot_id must be null'
        : 'This pick line directs a lot; confirmed_lot_id must be a lot UUID',
      {
        pick_line_id: p.pick_line_id,
        directed_lot_id: line.directed_lot_id,
        confirmed_lot_id: confirmedLotId,
      },
    );
  }

  const isSubstitution = confirmedLotId !== line.directed_lot_id;
  const overrideReason = typeof p.override_reason === 'string' ? p.override_reason.trim() : '';
  if (isSubstitution && overrideReason.length === 0) {
    throw new AppError(
      400,
      'PICK_OVERRIDE_REASON_REQUIRED',
      'A lot substitution requires an override reason',
      {
        pick_line_id: p.pick_line_id,
        directed_lot_id: line.directed_lot_id,
        confirmed_lot_id: confirmedLotId,
      },
    );
  }

  // Resolve the bin this confirmation allocates at BEFORE stamping the line, so the resolved bin
  // can be persisted on the row. Completion then moves stock at exactly this bin instead of
  // re-deriving it with a different predicate, which could land on another task's allocation when
  // a lot is allocated across several bins (review pass 2).
  let confirmedLocationId = line.location_id;
  if (isSubstitution && line.directed_lot_id !== null && confirmedLotId !== null) {
    // Release the directed lot's allocation at the directed bin...
    const directedLotNumber = await lotNumberForUuid(line.directed_lot_id, line.sku, client);
    await releaseStock(
      line.sku,
      line.location_id,
      directedLotNumber,
      line.directed_quantity,
      client,
    );

    // ...and allocate the confirmed lot at the bin where its stock actually sits. The authoritative
    // source for that bin is stock_balance itself: the allocation target row must exist there with
    // sufficient availability. Story 1.6 location_current only tracks scanner-asserted positions
    // and is empty for lots never scanned, so it cannot gate a substitution (review decision:
    // satisfies spec Task 5.4 step 5's "current bin" intent with the authoritative source).
    // Constrained to the same site as the original pick line and an active, writable bin.
    const confirmedLotNumber = await lotNumberForUuid(confirmedLotId, line.sku, client);
    // Story 8.1 (Task 6): a substituted lot is re-validated against the QC gate before allocation.
    await assertQcGateAllows({
      lot_id: confirmedLotId,
      operation: 'pick',
      business_date: gateBusinessDateOf(envelope),
      client,
    });
    const resolved = await client.query(
      `SELECT sb.location_id
         FROM stock_balance sb
         JOIN location_register lr ON lr.location_id = sb.location_id
         WHERE sb.sku = $1 AND sb.lot_id = $2 AND sb.stock_class = 'owned'
           AND lr.site_id = (SELECT site_id FROM location_register WHERE location_id = $3 LIMIT 1)
           AND lr.status = 'active'
           AND lr.quarantine = false
           AND lr.access_restricted = false
           AND sb.available >= $4::numeric
         ORDER BY sb.available DESC, sb.location_id
         LIMIT 1`,
      [line.sku, confirmedLotNumber, line.location_id, String(p.confirmed_quantity)],
    );
    if (resolved.rows.length === 0) {
      throw new AppError(
        409,
        'INSUFFICIENT_STOCK_FOR_PICK',
        'The substituted lot has insufficient available stock at an active, writable bin at this site',
        {
          pick_line_id: p.pick_line_id,
          confirmed_lot_id: confirmedLotId,
          requested_quantity: String(p.confirmed_quantity),
        },
      );
    }
    confirmedLocationId = resolved.rows[0]!['location_id'] as string;
    await allocateStock(
      line.sku,
      confirmedLocationId,
      confirmedLotNumber,
      String(p.confirmed_quantity),
      client,
    );
  }

  const confirmed = await confirmPickLine(
    p.pick_line_id,
    confirmedLotId,
    String(p.confirmed_quantity),
    isSubstitution ? overrideReason : null,
    p.capture_method,
    envelope.metadata.actor.user_id,
    confirmedLocationId,
    client,
  );
  if (!confirmed) {
    throw new AppError(
      409,
      'PICK_LINE_ALREADY_CONFIRMED',
      'Pick line was confirmed by a concurrent request',
      {
        pick_line_id: p.pick_line_id,
      },
    );
  }

  // Per spec Task 5.4 step 6, the per-line allocation stays in place at confirmation time; the AC7
  // allocated -> picked transition runs once, at task completion.

  // Mark the task in_progress on first confirmation (pending -> in_progress).
  await client.query(
    `UPDATE pick_task SET status = 'in_progress', updated_at = now() WHERE pick_task_id = $1 AND status = 'pending'`,
    [p.pick_task_id],
  );

  // AC7 (review decision 2026-07-27): "when the last confirmation is submitted" is the trigger, so
  // finalize here the moment no line is left outstanding rather than waiting for a supervisor's
  // separate call. The supervisor endpoint remains available and is a no-op once this has run.
  // Finalization is performed inline rather than by emitting pick_task.completed, so the SOD gate
  // on that command stays meaningful and an operator cannot use auto-completion to impersonate one.
  const outstanding = await client.query(
    `SELECT COUNT(*) AS pending_count FROM pick_line WHERE pick_task_id = $1 AND status = 'pending'`,
    [p.pick_task_id],
  );
  if (Number(outstanding.rows[0]!['pending_count']) === 0) {
    await finalizePickTaskCompletion(
      p.pick_task_id,
      envelope.metadata.actor,
      client,
      _eventId,
      gateBusinessDateOf(envelope),
    );
  }
}

/**
 * Story 3.17 Task 3.1: projection applier for pick_line.short_picked.
 * Records the short pick, updates stock allocation and picked balances,
 * opens a photo-less damage case when reason is DAMAGED, emits planning notification,
 * marks task in_progress, and auto-completes the task when no pending lines remain.
 */
export async function applyPickLineShortPickedProjection(
  envelope: PickLineShortPickedEnvelope,
  client: PoolClient,
  _eventId: string,
): Promise<void> {
const p = envelope.payload;

// Lock the task to serialize concurrent short-picks on lines of the same task,
// preventing the auto-finalize deadlock where two events each see the other's
// line as pending and neither finalizes.
await client.query(`SELECT pick_task_id FROM pick_task WHERE pick_task_id = $1 FOR UPDATE`, [
  p.pick_task_id,
]);

// 1. Lock the line
const line = await getPickLineByIdForUpdate(p.pick_line_id, client);
if (!line) {
  throw new AppError(404, 'PICK_LINE_NOT_FOUND', 'Pick line not found', {
    pick_line_id: p.pick_line_id,
  });
}

// Verify the line belongs to the specified task
if (line.pick_task_id !== p.pick_task_id) {
  throw new AppError(400, 'PICK_LINE_TASK_MISMATCH', 'Pick line does not belong to the specified task', {
    pick_line_id: p.pick_line_id,
    pick_task_id: p.pick_task_id,
  });
}

  // 2. Idempotent replay check
  if (line.status === 'short') {
    const sfRes = await client.query(
      `SELECT directed_quantity::text, found_quantity::text, reason, note FROM pick_shortfall WHERE pick_line_id = $1`,
      [p.pick_line_id],
    );
    if (sfRes.rows.length > 0) {
      const row = sfRes.rows[0]!;
      const noteMatches = (row['note'] ?? null) === (p.note?.trim() || null);
      if (
        numericToMicro(row['found_quantity']) === numericToMicro(p.found_quantity) &&
        row['reason'] === p.reason &&
        noteMatches
      ) {
        return; // idempotent replay
      }
    }
    throw new AppError(
      409,
      'PICK_LINE_ALREADY_CONFIRMED',
      'Pick line already short-picked with different values',
      { pick_line_id: p.pick_line_id },
    );
  }
if (line.status === 'cancelled') {
  throw new AppError(409, 'PICK_LINE_ALREADY_CONFIRMED', 'Pick line has been cancelled', {
    pick_line_id: p.pick_line_id,
    status: line.status,
  });
}
if (line.status !== 'pending') {
  throw new AppError(409, 'PICK_LINE_ALREADY_CONFIRMED', 'Pick line is not in pending status', {
      pick_line_id: p.pick_line_id,
      status: line.status,
    });
  }

  // 3. Business rule validation
  if (!p.reason || !SHORT_REASONS.includes(p.reason as (typeof SHORT_REASONS)[number])) {
    throw new AppError(400, 'PICK_SHORT_REASON_REQUIRED', 'A valid reason code is required for short pick');
  }
  const foundMicro = numericToMicro(p.found_quantity);
  const directedMicro = numericToMicro(line.directed_quantity);
  if (foundMicro < 0n || foundMicro >= directedMicro) {
    throw new AppError(
      400,
      'PICK_SHORT_QUANTITY_INVALID',
      'Found quantity must be non-negative and less than directed quantity',
      { found_quantity: String(p.found_quantity), directed_quantity: line.directed_quantity },
    );
  }
  if (p.reason === 'BIN_EMPTY' && foundMicro !== 0n) {
    throw new AppError(
      400,
      'PICK_SHORT_QUANTITY_INVALID',
      'Found quantity must be 0 when reason is BIN_EMPTY',
      { found_quantity: String(p.found_quantity) },
    );
  }
  if (p.reason === 'OTHER') {
    if (!p.note || p.note.trim().length === 0 || p.note.length > 200) {
      throw new AppError(
        400,
        'PICK_SHORT_NOTE_REQUIRED',
        'Note is required, non-blank, and at most 200 characters when reason is OTHER',
      );
    }
  }

  // 4. Resolve lot, site, and bin info
  let directedLotNumber: string | null = null;
  if (line.directed_lot_id !== null) {
    directedLotNumber = await lotNumberForUuid(line.directed_lot_id, line.sku, client);
  }
  const taskSiteId = await siteForPickTask(p.pick_task_id, client);
  if (taskSiteId === null) {
    throw new AppError(404, 'PICK_TASK_NOT_FOUND', `No pick task exists for "${p.pick_task_id}"`, {
      pick_task_id: p.pick_task_id,
    });
  }
  await assertActorAtSite(
    envelope.metadata.actor.location_id,
    taskSiteId,
    { pick_line_id: p.pick_line_id, pick_task_id: p.pick_task_id },
    client,
  );

  // 5. Stock adjustments (Task 3.3 & 3.5)
  // Short units = directed minus found.
  // BIN_EMPTY, LESS_IN_BIN and OTHER: releaseStock of the short units only; found units stay allocated.
  // DAMAGED: releaseStock of short units, then relocate into site ZONE-QC-HOLD, then open damage case.
  const shortfallMicro = directedMicro - foundMicro;
  const shortfallInt = shortfallMicro / QUANTITY_FACTOR;
  const shortfallFrac = (shortfallMicro % QUANTITY_FACTOR).toString().padStart(6, '0').slice(0, 3);
  const shortfallQtyStr = `${shortfallInt}.${shortfallFrac}`;

  if (shortfallMicro > 0n) {
    if (p.reason === 'DAMAGED') {
      const qcHoldRes = await client.query(
        `SELECT location_id, location_code
         FROM location_register
         WHERE site_id = $1
           AND UPPER(location_code) = UPPER($2)
           AND status = 'active'
           AND quarantine = true
         LIMIT 1`,
        [taskSiteId, QC_HOLD_ZONE_CODE],
      );
      if (qcHoldRes.rows.length === 0) {
        throw new AppError(
          409,
          'PICK_SHORT_QC_HOLD_MISSING',
          'Quarantine zone ZONE-QC-HOLD is missing or inactive at this site',
          { site_id: taskSiteId },
        );
      }
      const qcHoldLocation = qcHoldRes.rows[0]! as { location_id: string; location_code: string };

      await applyStockAllocationRelief(
      taskSiteId,
      line.sku,
      directedLotNumber,
      line.location_id,
      shortfallQtyStr,
      client,
    );

      await applyStockIssue(
        {
          sku: line.sku,
          location_id: line.location_id,
          lot_id: directedLotNumber,
          stock_class: 'owned',
          quantity: shortfallQtyStr,
          relocation: true,
          relocation_target_location_id: qcHoldLocation.location_id,
        },
        client,
      );

      await applyStockReceipt(
        {
          sku: line.sku,
          location_id: qcHoldLocation.location_id,
          location_code: qcHoldLocation.location_code,
          lot_id: directedLotNumber,
          stock_class: 'owned',
          quantity: shortfallQtyStr,
        },
        client,
      );

      const itemRes = await client.query(`SELECT uom FROM item_master WHERE sku = $1`, [line.sku]);
      const uom = itemRes.rows.length > 0 ? (itemRes.rows[0]!['uom'] as string) : 'unit';

      await openPickShortDamageCase(
        {
          envelope: envelope as unknown as EventEnvelope,
          eventId: _eventId,
          pickLineId: p.pick_line_id,
          pickTaskId: p.pick_task_id,
          siteId: taskSiteId,
          pickerUserId: envelope.metadata.actor.user_id,
          sku: line.sku,
          lotNumber: directedLotNumber,
          quantity: shortfallQtyStr,
          uom,
          qcHoldLocation,
          note: p.note ? p.note.trim() : null,
        },
        client,
      );
    } else {
      await applyStockAllocationRelief(
      taskSiteId,
      line.sku,
      directedLotNumber,
      line.location_id,
      shortfallQtyStr,
      client,
    );
    }
  }

  // 6. Stamp the line short (Task 3.4)
  const actorUserId = envelope.metadata.actor.user_id;
  const updateResult = await client.query(
    `UPDATE pick_line
        SET status = 'short',
            confirmed_quantity = $2::numeric,
            confirmed_lot_id = directed_lot_id,
            confirmed_location_id = location_id,
            confirmed_by = $3,
            confirmed_at = now(),
            updated_at = now()
      WHERE pick_line_id = $1 AND status = 'pending'`,
    [p.pick_line_id, String(p.found_quantity), actorUserId],
  );
  if ((updateResult.rowCount ?? 0) === 0) {
    throw new AppError(
      409,
      'PICK_LINE_ALREADY_CONFIRMED',
      'Pick line was confirmed by a concurrent request',
      { pick_line_id: p.pick_line_id },
    );
  }

  // Insert pick_shortfall
  const shortfallId = randomUUID();
  await client.query(
    `INSERT INTO pick_shortfall (
      pick_shortfall_id,
      pick_task_id,
      pick_line_id,
      directed_quantity,
      found_quantity,
      reason,
      note,
      actor_user_id,
      occurred_at,
      source_event_id
    ) VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6, $7, $8, $9, $10)`,
    [
      shortfallId,
      p.pick_task_id,
      p.pick_line_id,
      line.directed_quantity,
      String(p.found_quantity),
      p.reason,
      p.note ? p.note.trim() : null,
      actorUserId,
      envelope.metadata.occurred_at,
      _eventId,
    ],
  );

  // 7. Update task status: pending -> in_progress (Task 3.4)
  await client.query(
    `UPDATE pick_task SET status = 'in_progress', updated_at = now() WHERE pick_task_id = $1 AND status = 'pending'`,
    [p.pick_task_id],
  );

  // 8. Check if any pending lines remain; if none, auto-finalize completion (Task 3.4)
  const outstanding = await client.query(
    `SELECT COUNT(*) AS pending_count FROM pick_line WHERE pick_task_id = $1 AND status = 'pending'`,
    [p.pick_task_id],
  );
  if (Number(outstanding.rows[0]!['pending_count']) === 0) {
    await finalizePickTaskCompletion(
      p.pick_task_id,
      envelope.metadata.actor,
      client,
      _eventId,
      gateBusinessDateOf(envelope),
    );
  }
}

/**
 * Shared completion side effects (AC7 and AC4), used both by the auto-completion path above and by
 * the explicit `pick_task.completed` command. Assumes the caller holds the task row lock and has
 * verified that every non-cancelled line is confirmed. Returns false when the task was already
 * completed, so both callers can treat a replay as a no-op.
 */
async function finalizePickTaskCompletion(
  pickTaskId: string,
  actor: { user_id: string; role: string; location_id: string },
  client: PoolClient,
  eventId: string,
  businessDate: string,
): Promise<boolean> {
  const task = await getPickTaskByIdForUpdate(pickTaskId, client);
  if (!task || task.status === 'completed') return false;

  const completedBy = actor.user_id;
  // The status predicate makes this the serialization point: a concurrent completion that already
  // committed leaves zero rows here, so the stock move below can never run twice.
  const moved = await updatePickTaskStatus(pickTaskId, 'completed', completedBy, client);
  if (!moved) return false;

  // AC7: move every confirmed line's quantity from allocated to picked at the bin the confirmation
  // recorded. Older rows predating confirmed_location_id fall back to the directed bin.
  const confirmedLines = await client.query(
    `SELECT pl.sku, pl.confirmed_lot_id,
            COALESCE(pl.confirmed_location_id, pl.location_id) AS bin_id,
            pl.confirmed_quantity::text AS confirmed_quantity
     FROM pick_line pl
     WHERE pl.pick_task_id = $1 AND pl.status IN ('confirmed', 'substituted', 'short')
     ORDER BY pl.confirmed_lot_id NULLS FIRST, pl.sku, 3, pl.pick_line_id`,
    [pickTaskId],
  );
  // Lock order: the rows above come in the SAME total order the dispatch decrement walks its
  // balance rows in (lot, SKU, bin), and every lot is gated - which locks its lot_master row -
  // before the first balance row is touched (lot, then gate, then stock, as dispatch does). A
  // two-line completion can then never deadlock against a dispatch sharing its balance rows.
  const lotNumbers = new Map<string, string>();
  for (const row of confirmedLines.rows) {
    if (numericToMicro(row['confirmed_quantity']) === 0n) continue;
    const confirmedLotId = (row['confirmed_lot_id'] as string | null) ?? null;
    const lotKey = `${confirmedLotId}|${row['sku'] as string}`;
    if (confirmedLotId === null || lotNumbers.has(lotKey)) continue;
    lotNumbers.set(lotKey, await lotNumberForUuid(confirmedLotId, row['sku'] as string, client));
    // Story 8.1 (Task 6): the allocated-to-picked move re-runs the QC gate under the lot lock.
    await assertQcGateAllows({
      lot_id: confirmedLotId,
      operation: 'pick',
      business_date: businessDate,
      client,
    });
  }
  for (const row of confirmedLines.rows) {
    if (numericToMicro(row['confirmed_quantity']) === 0n) continue;
    const sku = row['sku'] as string;
    const confirmedLotId = (row['confirmed_lot_id'] as string | null) ?? null;
    if (confirmedLotId === null) {
      // Pilot B3: a lot-less line moves the lot-less balance row only (no lot to bridge or gate).
      await applyStockPick(
        {
          sku,
          location_id: row['bin_id'] as string,
          lot_less: true,
          quantity: row['confirmed_quantity'] as string,
        },
        client,
      );
      continue;
    }
    await applyStockPick(
      {
        sku,
        location_id: row['bin_id'] as string,
        lot_id: lotNumbers.get(`${confirmedLotId}|${sku}`)!,
        quantity: row['confirmed_quantity'] as string,
      },
      client,
    );
  }

  // AC7: notify the packing station. warehouse_manager is a documented placeholder target until
  // Story 3.7 (packing) defines the packing-station role.
  await emitNotificationInTransaction(
    {
      target: { role: 'warehouse_manager' },
      event_type: 'pick_task_completed',
      status_verb: 'Completed',
      object_type: 'Pick task',
      object_id: pickTaskId,
      next_step: 'Ready for packing.',
      actor,
      causation_id: eventId,
    },
    client,
  );

  // Story 3.17 Task 5.1: If the task has at least one short line, emit a notification to production_planner.
  const shortLinesRes = await client.query(
    `SELECT pl.sku, pl.directed_quantity::text, pl.confirmed_quantity::text, ps.reason
     FROM pick_line pl
     JOIN pick_shortfall ps ON ps.pick_line_id = pl.pick_line_id
     WHERE pl.pick_task_id = $1 AND pl.status = 'short'
     ORDER BY pl.pick_sequence ASC, pl.pick_line_id ASC`,
    [pickTaskId],
  );
  if (shortLinesRes.rows.length > 0) {
    const taskSiteId = await siteForPickTask(pickTaskId, client);
    const lineSummaries = shortLinesRes.rows.map(
      (r: Record<string, unknown>) =>
        `${r['sku']}: ${r['confirmed_quantity']} of ${r['directed_quantity']} (${r['reason']})`,
    );
    await emitNotificationInTransaction(
      {
        target: { role: 'production_planner', location_id: taskSiteId },
        event_type: 'pick_shortfall_recorded',
        status_verb: 'Short-picked',
        object_type: 'pick_task',
        object_id: pickTaskId,
        next_step: `Short lines: ${lineSummaries.join('; ')}`,
        actor,
        causation_id: eventId,
      },
      client,
    );
  }

  // AC4: the dispatch order moves to picked only when every task for it is complete. A batch task
  // consolidates several order lines, and pick_task.dispatch_order_id holds only the first of them,
  // so each contributing line is resolved through the pick_line rows and then counted against the
  // tasks that actually reference it (review pass 2: the previous version counted contributing
  // lines 2..n against an empty set and skipped them forever).
  const contributing = await client.query(
    `SELECT DISTINCT pl.dispatch_order_line_id AS order_id FROM pick_line pl WHERE pl.pick_task_id = $1`,
    [pickTaskId],
  );
  const orderIds = new Set<string>(
    contributing.rows.map((r: Record<string, unknown>) => r['order_id'] as string),
  );
  orderIds.add(task.dispatch_order_id);

  for (const orderId of orderIds) {
    // Count every task that carries a line for this order, whether it references the order
    // directly (single/wave/zone) or only through its pick lines (batch).
    const orderCounts = await client.query(
      `SELECT COUNT(*) FILTER (WHERE pt.status = 'completed') AS completed_count,
              COUNT(*) FILTER (WHERE pt.status <> 'cancelled') AS active_count
         FROM pick_task pt
        WHERE pt.dispatch_order_id = $1
           OR EXISTS (SELECT 1 FROM pick_line pl WHERE pl.pick_task_id = pt.pick_task_id AND pl.dispatch_order_line_id = $1)`,
      [orderId],
    );
    const orderCompleted = Number(orderCounts.rows[0]!['completed_count']);
    const orderActive = Number(orderCounts.rows[0]!['active_count']);
    if (orderActive > 0 && orderCompleted === orderActive) {
      await client.query(
        `INSERT INTO dispatch_order_status (dispatch_order_id, picked_at, picked_by)
         VALUES ($1, now(), $2)
         ON CONFLICT (dispatch_order_id) DO NOTHING`,
        [orderId, completedBy],
      );
    }
  }
  return true;
}

/**
 * Story 3.6 Task 5.5: in-transaction apply for pick_task.completed. Requires every pick line
 * confirmed (AC7), moves each confirmed line's quantity from `allocated` to `picked` at the bin
 * where its allocation actually sits (AC7's "stock status moves from allocated to picked" fires
 * when the LAST confirmation is submitted - i.e. at completion, not per-line, per spec Task 5.4
 * step 6 "the allocation from Task 5.3 stays in place"; Story 3.7 packing/shipping owns the next
 * transition out of `picked`), notifies the packing station (warehouse_manager placeholder until
 * Story 3.7 defines the packing role), and - when every task for the dispatch order is complete -
 * flags the order picked in dispatch_order_status (AC4 zone completion included).
 */
export async function applyPickTaskCompletedProjection(
  envelope: PickTaskCompletedEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload;

  // Review pass 2: read the task INSIDE the row lock. The previous version read the status
  // unlocked and then relied on an unguarded UPDATE, so two concurrent completions both passed the
  // gate and both ran the allocated-to-picked move, draining allocation belonging to other tasks
  // at the same (sku, bin, lot) row.
  const task = await getPickTaskByIdForUpdate(p.pick_task_id, client);
  if (!task) {
    throw new AppError(404, 'PICK_TASK_NOT_FOUND', `No pick task exists for "${p.pick_task_id}"`, {
      pick_task_id: p.pick_task_id,
    });
  }
  if (task.status === 'completed') return; // idempotent replay

  const taskSiteId = await siteForPickTask(p.pick_task_id, client);
  if (taskSiteId === null) {
    throw new AppError(404, 'PICK_TASK_NOT_FOUND', `No pick task exists for "${p.pick_task_id}"`, {
      pick_task_id: p.pick_task_id,
    });
  }
  await assertActorAtSite(
    envelope.metadata.actor.location_id,
    taskSiteId,
    { pick_task_id: p.pick_task_id },
    client,
  );

  // SOD (Task 6.2 and the Dev Notes SOD/RBAC rule): completion is a supervisor action. The HTTP
  // handler enforces this, but the edge upload and direct-event paths authorize only on
  // module plus write, so without this check an operator could post the command themselves.
  if (!PICK_COMPLETE_ROLES.includes(envelope.metadata.actor.role)) {
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      `Completing a pick task is restricted to roles: ${PICK_COMPLETE_ROLES.join(', ')}`,
      {
        pick_task_id: p.pick_task_id,
        actor_role: envelope.metadata.actor.role,
      },
    );
  }

  // Lock the task's pick lines so a concurrent confirmation cannot slip between the count and the
  // status update. FOR UPDATE cannot ride the aggregate query itself (PostgreSQL 0A000), so the
  // lock runs as a separate statement (mirrors applyStockAllocation's lock-then-check).
  await client.query(`SELECT pick_line_id FROM pick_line WHERE pick_task_id = $1 FOR UPDATE`, [
    p.pick_task_id,
  ]);
    const counts = await client.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('confirmed', 'substituted', 'short')) AS confirmed_count,
              COUNT(*) FILTER (WHERE status <> 'cancelled') AS active_count
       FROM pick_line
       WHERE pick_task_id = $1`,
      [p.pick_task_id],
    );
  const confirmedCount = Number(counts.rows[0]!['confirmed_count']);
  const activeCount = Number(counts.rows[0]!['active_count']);
  if (confirmedCount < activeCount || activeCount === 0) {
    throw new AppError(
      409,
      'PICK_TASK_NOT_ALL_LINES_CONFIRMED',
      'Every pick line must be confirmed before the task completes',
      {
        pick_task_id: p.pick_task_id,
        confirmed_count: confirmedCount,
        total_count: activeCount,
      },
    );
  }

  await finalizePickTaskCompletion(
    p.pick_task_id,
    envelope.metadata.actor,
    client,
    eventId,
    gateBusinessDateOf(envelope),
  );
}
