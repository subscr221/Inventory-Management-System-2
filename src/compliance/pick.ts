import type { PoolClient } from 'pg';
import type { PickLineConfirmedEnvelope, PickTaskCompletedEnvelope, PickTaskCreatedEnvelope, PickLineInput } from '../events/schema.js';
import { AppError } from '../middleware/error.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import { createPickTask, getPickTaskById, updatePickTaskStatus } from '../read/projections/pick_task.js';
import { confirmPickLine, createPickLine, getPickLineById } from '../read/projections/pick_line.js';
import { getCurrentLocation } from '../read/projections/location.js';
import { applyStockPick } from '../read/projections/stock_balance.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRATEGIES = ['single', 'batch', 'wave', 'zone'];

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

function microToNumeric(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = (abs / QUANTITY_FACTOR).toString();
  const frac = (abs % QUANTITY_FACTOR).toString().padStart(QUANTITY_SCALE, '0');
  const num = `${whole}.${frac}`;
  return negative ? `-${num}` : num;
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

function reject(message: string, details: Record<string, unknown> = {}): never {
  throw new AppError(400, 'PICK_TASK_INVALID_PAYLOAD', message, details);
}

/** Story 3.6 Task 5.2: pre-transaction shape validation for pick_task.created (no DB access). */
export function assertPickTaskCreatedShape(envelope: PickTaskCreatedEnvelope): void {
  const p = envelope.payload;
  if (!isUuid(p.pick_task_id)) reject('pick_task_id is required and must be a UUID');
  if (!isUuid(p.dispatch_order_id)) reject('dispatch_order_id is required and must be a UUID');
  if (typeof p.sku !== 'string' || p.sku.length === 0) reject('sku is required');
  if (!isPositiveFiniteQuantity(p.quantity)) reject('quantity is required and must be a positive finite numeric value');
  if (!isUuid(p.lot_id)) reject('lot_id is required and must be a UUID');
  if (!isUuid(p.location_id)) reject('location_id is required and must be a UUID');
  if (!Number.isInteger(p.pick_sequence)) reject('pick_sequence is required and must be an integer');
  if (!STRATEGIES.includes(p.strategy)) reject("strategy must be one of 'single', 'batch', 'wave', 'zone'");
  if (!isUuid(p.zone_id)) reject('zone_id is required and must be a UUID');
  if (p.wave_id !== undefined && p.wave_id !== null && !isUuid(p.wave_id)) reject('wave_id must be a UUID when present');
  if (p.batch_id !== undefined && p.batch_id !== null && !isUuid(p.batch_id)) reject('batch_id must be a UUID when present');
  if (!Array.isArray(p.pick_lines) || p.pick_lines.length === 0) reject('pick_lines is required and must be a non-empty array');
  for (const line of p.pick_lines) {
    if (!isUuid(line.pick_line_id)) reject('pick_lines[].pick_line_id is required and must be a UUID');
    if (!isUuid(line.dispatch_order_line_id)) reject('pick_lines[].dispatch_order_line_id is required and must be a UUID');
    if (typeof line.sku !== 'string' || line.sku.length === 0) reject('pick_lines[].sku is required');
    if (!isUuid(line.directed_lot_id)) reject('pick_lines[].directed_lot_id is required and must be a UUID');
    if (!isPositiveFiniteQuantity(line.directed_quantity)) reject('pick_lines[].directed_quantity is required and must be a positive finite numeric value');
    if (!isUuid(line.location_id)) reject('pick_lines[].location_id is required and must be a UUID');
    if (!Number.isInteger(line.pick_sequence)) reject('pick_lines[].pick_sequence is required and must be an integer');
  }
}

/** Story 3.6 Task 5.2: pre-transaction shape validation for pick_line.confirmed (no DB access). */
export function assertPickLineConfirmedShape(envelope: PickLineConfirmedEnvelope): void {
  const p = envelope.payload;
  if (!isUuid(p.pick_task_id)) reject('pick_task_id is required and must be a UUID');
  if (!isUuid(p.pick_line_id)) reject('pick_line_id is required and must be a UUID');
  if (!isUuid(p.confirmed_lot_id)) reject('confirmed_lot_id is required and must be a UUID');
  if (!isPositiveFiniteQuantity(p.confirmed_quantity)) reject('confirmed_quantity is required and must be a positive finite numeric value');
  if (p.capture_method !== 'PWA' && p.capture_method !== 'PAPER') reject("capture_method must be 'PWA' or 'PAPER'");
  // override_reason requiredness compares against the directed lot, which needs DB access -
  // enforced in applyPickLineConfirmedProjection, not here.
}

/** Story 3.6 Task 5.2: pre-transaction shape validation for pick_task.completed (no DB access). */
export function assertPickTaskCompletedShape(envelope: PickTaskCompletedEnvelope): void {
  const p = envelope.payload;
  if (!isUuid(p.pick_task_id)) reject('pick_task_id is required and must be a UUID');
}

/** Bridges a lot_master.lot_id UUID to the lot_number TEXT key stock_balance rows carry. */
async function lotNumberForUuid(lotUuid: string, sku: string, client: PoolClient): Promise<string> {
  const result = await client.query(`SELECT lot_number FROM lot_master WHERE lot_id = $1 AND sku = $2`, [lotUuid, sku]);
  if (result.rows.length === 0) {
    throw new AppError(404, 'LOT_NOT_FOUND', `No lot exists for lot_id "${lotUuid}" and sku "${sku}"`, { lot_id: lotUuid, sku });
  }
  return result.rows[0]!['lot_number'] as string;
}

/**
 * Allocates `quantity` of owned stock for (sku, location, lot_number), guarded on availability in
 * the same UPDATE (defensive against races - the generator already checked availability).
 * `available` is a generated column (on_hand - allocated - picked), so only `allocated` is written.
 */
async function allocateStock(sku: string, locationId: string, lotNumber: string, quantity: string, client: PoolClient): Promise<void> {
  const result = await client.query(
    `UPDATE stock_balance
        SET allocated = allocated + $1::numeric, updated_at = now()
      WHERE sku = $2 AND location_id = $3 AND lot_id = $4 AND stock_class = 'owned'
        AND available >= $1::numeric`,
    [quantity, sku, locationId, lotNumber],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new AppError(409, 'INSUFFICIENT_STOCK_FOR_PICK', 'Available stock does not cover the pick allocation', {
      sku,
      location_id: locationId,
      lot_number: lotNumber,
      requested_quantity: quantity,
    });
  }
}

/** Releases a previously-taken allocation (never below zero). */
async function releaseStock(sku: string, locationId: string, lotNumber: string, quantity: string, client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE stock_balance
        SET allocated = GREATEST(allocated - $1::numeric, 0), updated_at = now()
      WHERE sku = $2 AND location_id = $3 AND lot_id = $4 AND stock_class = 'owned'`,
    [quantity, sku, locationId, lotNumber],
  );
}

/**
 * Story 3.6 Task 5.3: in-transaction apply for pick_task.created. Inserts the task and its pick
 * lines, then allocates stock for every line. A replay of an already-applied event (task row
 * exists) is a no-op so the allocation is never double-taken.
 */
export async function applyPickTaskCreatedProjection(envelope: PickTaskCreatedEnvelope, client: PoolClient, _eventId: string): Promise<void> {
  const p = envelope.payload;

  const existing = await getPickTaskById(p.pick_task_id, client);
  if (existing) return; // idempotent replay - projection rows and allocations already applied

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
    const lotNumber = await lotNumberForUuid(line.directed_lot_id, line.sku, client);
    await allocateStock(line.sku, line.location_id, lotNumber, String(line.directed_quantity), client);
  }
}

/**
 * Story 3.6 Task 5.4: in-transaction apply for pick_line.confirmed. Idempotent replay of the same
 * confirmation is a no-op success; a conflicting re-confirmation rejects
 * PICK_LINE_ALREADY_CONFIRMED. A substitution requires an override reason (AC6/AC8), releases the
 * directed lot's allocation, and allocates the confirmed lot at its current bin.
 */
export async function applyPickLineConfirmedProjection(envelope: PickLineConfirmedEnvelope, client: PoolClient, _eventId: string): Promise<void> {
  const p = envelope.payload;

  const line = await getPickLineById(p.pick_line_id, client);
  if (!line) {
    throw new AppError(404, 'PICK_LINE_NOT_FOUND', `No pick line exists for "${p.pick_line_id}"`, { pick_line_id: p.pick_line_id });
  }
  if (line.pick_task_id !== p.pick_task_id) {
    throw new AppError(404, 'PICK_LINE_NOT_FOUND', `Pick line "${p.pick_line_id}" does not belong to task "${p.pick_task_id}"`, {
      pick_line_id: p.pick_line_id,
      pick_task_id: p.pick_task_id,
    });
  }

  if (line.status === 'confirmed' || line.status === 'substituted') {
    const sameLot = line.confirmed_lot_id === p.confirmed_lot_id;
    const sameQty = line.confirmed_quantity !== null && numericToMicro(line.confirmed_quantity) === numericToMicro(p.confirmed_quantity);
    if (sameLot && sameQty) return; // idempotent replay - no re-mutation
    throw new AppError(409, 'PICK_LINE_ALREADY_CONFIRMED', 'Pick line is already confirmed with a different lot or quantity', {
      pick_line_id: p.pick_line_id,
      confirmed_lot_id: line.confirmed_lot_id,
      confirmed_quantity: line.confirmed_quantity,
    });
  }
  if (line.status === 'cancelled') {
    throw new AppError(409, 'PICK_LINE_ALREADY_CONFIRMED', 'Pick line has been cancelled and cannot be confirmed', {
      pick_line_id: p.pick_line_id,
    });
  }

  const isSubstitution = p.confirmed_lot_id !== line.directed_lot_id;
  const overrideReason = typeof p.override_reason === 'string' ? p.override_reason.trim() : '';
  if (isSubstitution && overrideReason.length === 0) {
    throw new AppError(400, 'PICK_OVERRIDE_REASON_REQUIRED', 'A lot substitution requires an override reason', {
      pick_line_id: p.pick_line_id,
      directed_lot_id: line.directed_lot_id,
      confirmed_lot_id: p.confirmed_lot_id,
    });
  }

  const confirmed = await confirmPickLine(
    p.pick_line_id,
    p.confirmed_lot_id,
    String(p.confirmed_quantity),
    isSubstitution ? overrideReason : null,
    p.capture_method,
    envelope.metadata.actor.user_id,
    client,
  );
  if (!confirmed) {
    throw new AppError(409, 'PICK_LINE_ALREADY_CONFIRMED', 'Pick line was confirmed by a concurrent request', {
      pick_line_id: p.pick_line_id,
    });
  }

  let finalLocationId = line.location_id;

  if (isSubstitution) {
    // Release the directed lot's allocation at the directed bin...
    const directedLotNumber = await lotNumberForUuid(line.directed_lot_id, line.sku, client);
    await releaseStock(line.sku, line.location_id, directedLotNumber, line.directed_quantity, client);

    // ...and allocate the confirmed lot at the bin where its stock actually sits. Resolve the lot's
    // current location from Story 1.6 location_current (per spec Task 5.4 step 5), constrained to
    // the same site as the original pick line and with sufficient available owned stock.
    const confirmedLotNumber = await lotNumberForUuid(p.confirmed_lot_id, line.sku, client);
    const current = await getCurrentLocation(p.confirmed_lot_id, client);
    if (!current || current.location === null) {
      throw new AppError(409, 'INSUFFICIENT_STOCK_FOR_PICK', 'The substituted lot has no current bin location', {
        pick_line_id: p.pick_line_id,
        confirmed_lot_id: p.confirmed_lot_id,
      });
    }
    const resolvedBin = await client.query(
      `SELECT lr.location_id
         FROM location_register lr
        WHERE lr.location_code = $1
          AND lr.site_id = (SELECT site_id FROM location_register WHERE location_id = $2 LIMIT 1)
          AND lr.status = 'active'
          AND lr.quarantine = false
          AND lr.access_restricted = false
        LIMIT 1`,
      [current.location, line.location_id],
    );
    if (resolvedBin.rows.length === 0) {
      throw new AppError(409, 'INSUFFICIENT_STOCK_FOR_PICK', 'The substituted lot has no active, writable bin at this site', {
        pick_line_id: p.pick_line_id,
        confirmed_lot_id: p.confirmed_lot_id,
        location_code: current.location,
      });
    }
    const confirmedLocationId = resolvedBin.rows[0]!['location_id'] as string;
    const balance = await client.query(
      `SELECT sb.location_id
         FROM stock_balance sb
        WHERE sb.sku = $1 AND sb.lot_id = $2 AND sb.location_id = $3 AND sb.stock_class = 'owned'
          AND sb.available >= $4::numeric
        LIMIT 1`,
      [line.sku, confirmedLotNumber, confirmedLocationId, String(p.confirmed_quantity)],
    );
    if (balance.rows.length === 0) {
      throw new AppError(409, 'INSUFFICIENT_STOCK_FOR_PICK', 'The substituted lot has insufficient available stock at its current bin', {
        pick_line_id: p.pick_line_id,
        confirmed_lot_id: p.confirmed_lot_id,
        requested_quantity: String(p.confirmed_quantity),
      });
    }
    await allocateStock(line.sku, confirmedLocationId, confirmedLotNumber, String(p.confirmed_quantity), client);
    finalLocationId = confirmedLocationId;
  } else if (numericToMicro(p.confirmed_quantity) !== numericToMicro(line.directed_quantity)) {
    // Same lot but a different quantity: adjust the allocation so allocated reflects the actual
    // picked quantity (never negative, never exceeding on_hand via the available guard).
    const directedLotNumber = await lotNumberForUuid(line.directed_lot_id, line.sku, client);
    const directedMicro = numericToMicro(line.directed_quantity);
    const confirmedMicro = numericToMicro(p.confirmed_quantity);
    if (confirmedMicro > directedMicro) {
      const delta = microToNumeric(confirmedMicro - directedMicro);
      await allocateStock(line.sku, line.location_id, directedLotNumber, delta, client);
    } else {
      const delta = microToNumeric(directedMicro - confirmedMicro);
      await releaseStock(line.sku, line.location_id, directedLotNumber, delta, client);
    }
  }

  // AC7: the confirmed quantity has now been verified as actually picked - move it out of
  // `allocated` into `picked` at the final (sku, location, lot) so it is no longer offered to
  // new allocations but is distinguishable from stock still awaiting a pick. Story 3.7
  // (packing/shipping) owns the next transition out of `picked`.
  const finalLotNumber = await lotNumberForUuid(p.confirmed_lot_id, line.sku, client);
  await applyStockPick(
    { sku: line.sku, location_id: finalLocationId, lot_id: finalLotNumber, quantity: String(p.confirmed_quantity) },
    client,
  );

  // Mark the task in_progress on first confirmation (pending -> in_progress).
  await client.query(
    `UPDATE pick_task SET status = 'in_progress', updated_at = now() WHERE pick_task_id = $1 AND status = 'pending'`,
    [p.pick_task_id],
  );
}

/**
 * Story 3.6 Task 5.5: in-transaction apply for pick_task.completed. Requires every pick line
 * confirmed (AC7), notifies the packing station (warehouse_manager placeholder until Story 3.7
 * defines the packing role), and - when every task for the dispatch order is complete - flags the
 * order picked in dispatch_order_status (AC4 zone completion included). The AC7 "stock status
 * moves from allocated to picked" transition itself already happened per-line at confirmation
 * time (applyPickLineConfirmedProjection -> applyStockPick), because that is the point at which
 * the actually-picked lot/location/quantity is known; this function only gates completion on
 * every line being confirmed and does not mutate stock_balance itself.
 */
export async function applyPickTaskCompletedProjection(envelope: PickTaskCompletedEnvelope, client: PoolClient, eventId: string): Promise<void> {
  const p = envelope.payload;

  const task = await getPickTaskById(p.pick_task_id, client);
  if (!task) {
    throw new AppError(404, 'PICK_TASK_NOT_FOUND', `No pick task exists for "${p.pick_task_id}"`, { pick_task_id: p.pick_task_id });
  }
  if (task.status === 'completed') return; // idempotent replay

  const counts = await client.query(
    `SELECT COUNT(*) FILTER (WHERE status IN ('confirmed', 'substituted')) AS confirmed_count,
            COUNT(*) FILTER (WHERE status <> 'cancelled') AS active_count
       FROM pick_line
      WHERE pick_task_id = $1`,
    [p.pick_task_id],
  );
  const confirmedCount = Number(counts.rows[0]!['confirmed_count']);
  const activeCount = Number(counts.rows[0]!['active_count']);
  if (confirmedCount < activeCount || activeCount === 0) {
    throw new AppError(409, 'PICK_TASK_NOT_ALL_LINES_CONFIRMED', 'Every pick line must be confirmed before the task completes', {
      pick_task_id: p.pick_task_id,
      confirmed_count: confirmedCount,
      total_count: activeCount,
    });
  }

  const completedBy = envelope.metadata.actor.user_id;
  await updatePickTaskStatus(p.pick_task_id, 'completed', completedBy, client);

  // AC7: notify the packing station. warehouse_manager is a documented placeholder target until
  // Story 3.7 (packing) defines the packing-station role.
  await emitNotificationInTransaction(
    {
      target: { role: 'warehouse_manager' },
      event_type: 'pick_task_completed',
      status_verb: 'Completed',
      object_type: 'Pick task',
      object_id: p.pick_task_id,
      next_step: 'Ready for packing.',
      actor: envelope.metadata.actor,
      causation_id: eventId,
    },
    client,
  );

  // AC4: the order moves to picked only when EVERY task for the dispatch order is completed
  // (this event's own task was just marked completed above).
  const orderCounts = await client.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'completed') AS completed_count,
            COUNT(*) FILTER (WHERE status <> 'cancelled') AS active_count
       FROM pick_task
      WHERE dispatch_order_id = $1`,
    [task.dispatch_order_id],
  );
  const orderCompleted = Number(orderCounts.rows[0]!['completed_count']);
  const orderActive = Number(orderCounts.rows[0]!['active_count']);
  if (orderActive > 0 && orderCompleted === orderActive) {
    await client.query(
      `INSERT INTO dispatch_order_status (dispatch_order_id, picked_at, picked_by)
       VALUES ($1, now(), $2)
       ON CONFLICT (dispatch_order_id) DO NOTHING`,
      [task.dispatch_order_id, completedBy],
    );
  }
}
