import type { PoolClient } from 'pg';
import type { PickLineConfirmedEnvelope, PickTaskCompletedEnvelope, PickTaskCreatedEnvelope, PickLineInput } from '../events/schema.js';
import { AppError } from '../middleware/error.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import { createPickTask, getPickTaskById, getPickTaskByIdForUpdate, updatePickTaskStatus } from '../read/projections/pick_task.js';
import { confirmPickLine, createPickLine, getPickLineByIdForUpdate } from '../read/projections/pick_line.js';
import { applyStockPick } from '../read/projections/stock_balance.js';

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
  if (!isPositiveFiniteQuantity(p.quantity) || !hasMilliPrecision(p.quantity)) reject('quantity is required and must be a positive finite numeric value with at most 3 decimal places');
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
    if (!isPositiveFiniteQuantity(line.directed_quantity) || !hasMilliPrecision(line.directed_quantity)) reject('pick_lines[].directed_quantity is required and must be a positive finite numeric value with at most 3 decimal places');
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
  if (!isPositiveFiniteQuantity(p.confirmed_quantity) || !hasMilliPrecision(p.confirmed_quantity)) reject('confirmed_quantity is required and must be a positive finite numeric value with at most 3 decimal places');
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

/**
 * Releases a previously-taken allocation. Fails closed (review pass 2): scoped to
 * `allocated >= quantity` with the affected row count checked, so a missing or already-drained row
 * raises instead of silently releasing nothing and leaving the site's total allocation above real
 * demand. Its sibling allocateStock has always thrown; the asymmetry was the defect.
 */
async function releaseStock(sku: string, locationId: string, lotNumber: string, quantity: string, client: PoolClient): Promise<void> {
  const result = await client.query(
    `UPDATE stock_balance
        SET allocated = allocated - $1::numeric, updated_at = now()
      WHERE sku = $2 AND location_id = $3 AND lot_id = $4 AND stock_class = 'owned'
        AND allocated >= $1::numeric`,
    [quantity, sku, locationId, lotNumber],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new AppError(409, 'INSUFFICIENT_STOCK_FOR_PICK', 'No allocation to release at this bin and lot', {
      sku,
      location_id: locationId,
      lot_number: lotNumber,
      requested_quantity: quantity,
    });
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
 * which is treated as unrestricted exactly as the other modules do.
 */
const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';

function assertActorSite(actorLocationId: string, siteId: string, context: Record<string, unknown>): void {
  if (actorLocationId === NO_LOCATION_UUID) return;
  if (actorLocationId !== siteId) {
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No assignment grants access to site "${siteId}"`, {
      ...context,
      actor_location_id: actorLocationId,
      site_id: siteId,
    });
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
export async function applyPickTaskCreatedProjection(envelope: PickTaskCreatedEnvelope, client: PoolClient, _eventId: string): Promise<void> {
  const p = envelope.payload;

  const existing = await getPickTaskById(p.pick_task_id, client);
  if (existing) return; // idempotent replay - projection rows and allocations already applied

  // Review pass 2: the dispatch order must exist before any stock is allocated against it.
  // pick_task carries no foreign key to the ERP projection, and both listPickTasks and the site
  // resolver INNER JOIN it, so an unknown dispatch_order_id previously produced an invisible task
  // that had already taken an allocation nothing could release.
  const orderLine = await client.query(`SELECT ship_from_site_id FROM erp_sales_order WHERE id = $1`, [p.dispatch_order_id]);
  if (orderLine.rows.length === 0) {
    throw new AppError(404, 'DISPATCH_ORDER_LINE_NOT_FOUND', `No sales-order line exists for "${p.dispatch_order_id}"`, {
      dispatch_order_id: p.dispatch_order_id,
    });
  }
  assertActorSite(envelope.metadata.actor.location_id, orderLine.rows[0]!['ship_from_site_id'] as string, {
    pick_task_id: p.pick_task_id,
  });

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

  // Review pass 2: lock the line first. An unlocked read let two concurrent identical
  // confirmations both observe `pending`, after which the loser got a spurious 409 that the edge
  // outbox settles as needs_attention on what was actually a success.
  const line = await getPickLineByIdForUpdate(p.pick_line_id, client);
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

  const taskSiteId = await siteForPickTask(p.pick_task_id, client);
  if (taskSiteId === null) {
    throw new AppError(404, 'PICK_TASK_NOT_FOUND', `No pick task exists for "${p.pick_task_id}"`, { pick_task_id: p.pick_task_id });
  }
  assertActorSite(envelope.metadata.actor.location_id, taskSiteId, { pick_line_id: p.pick_line_id, pick_task_id: p.pick_task_id });

  // Review decision (2026-07-27): a confirmed quantity must equal the directed quantity. Accepting
  // a short pick previously completed the task and flagged the dispatch order fully picked with the
  // unpicked remainder vanishing (no shortfall row, no backorder); accepting an over-pick allocated
  // stock beyond sales-order demand. A genuine short pick needs an explicit exception flow, which
  // is its own story rather than silent data loss here.
  if (numericToMicro(p.confirmed_quantity) !== numericToMicro(line.directed_quantity)) {
    throw new AppError(400, 'PICK_QUANTITY_MISMATCH', 'confirmed_quantity must equal the directed quantity for this pick line', {
      pick_line_id: p.pick_line_id,
      directed_quantity: line.directed_quantity,
      confirmed_quantity: String(p.confirmed_quantity),
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

  // Resolve the bin this confirmation allocates at BEFORE stamping the line, so the resolved bin
  // can be persisted on the row. Completion then moves stock at exactly this bin instead of
  // re-deriving it with a different predicate, which could land on another task's allocation when
  // a lot is allocated across several bins (review pass 2).
  let confirmedLocationId = line.location_id;
  if (isSubstitution) {
    // Release the directed lot's allocation at the directed bin...
    const directedLotNumber = await lotNumberForUuid(line.directed_lot_id, line.sku, client);
    await releaseStock(line.sku, line.location_id, directedLotNumber, line.directed_quantity, client);

    // ...and allocate the confirmed lot at the bin where its stock actually sits. The authoritative
    // source for that bin is stock_balance itself: the allocation target row must exist there with
    // sufficient availability. Story 1.6 location_current only tracks scanner-asserted positions
    // and is empty for lots never scanned, so it cannot gate a substitution (review decision:
    // satisfies spec Task 5.4 step 5's "current bin" intent with the authoritative source).
    // Constrained to the same site as the original pick line and an active, writable bin.
    const confirmedLotNumber = await lotNumberForUuid(p.confirmed_lot_id, line.sku, client);
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
      throw new AppError(409, 'INSUFFICIENT_STOCK_FOR_PICK', 'The substituted lot has insufficient available stock at an active, writable bin at this site', {
        pick_line_id: p.pick_line_id,
        confirmed_lot_id: p.confirmed_lot_id,
        requested_quantity: String(p.confirmed_quantity),
      });
    }
    confirmedLocationId = resolved.rows[0]!['location_id'] as string;
    await allocateStock(line.sku, confirmedLocationId, confirmedLotNumber, String(p.confirmed_quantity), client);
  }

  const confirmed = await confirmPickLine(
    p.pick_line_id,
    p.confirmed_lot_id,
    String(p.confirmed_quantity),
    isSubstitution ? overrideReason : null,
    p.capture_method,
    envelope.metadata.actor.user_id,
    confirmedLocationId,
    client,
  );
  if (!confirmed) {
    throw new AppError(409, 'PICK_LINE_ALREADY_CONFIRMED', 'Pick line was confirmed by a concurrent request', {
      pick_line_id: p.pick_line_id,
    });
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
    await finalizePickTaskCompletion(p.pick_task_id, envelope.metadata.actor, client, _eventId);
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
      WHERE pl.pick_task_id = $1 AND pl.status IN ('confirmed', 'substituted')`,
    [pickTaskId],
  );
  for (const row of confirmedLines.rows) {
    const sku = row['sku'] as string;
    const confirmedLotNumber = await lotNumberForUuid(row['confirmed_lot_id'] as string, sku, client);
    await applyStockPick(
      { sku, location_id: row['bin_id'] as string, lot_id: confirmedLotNumber, quantity: row['confirmed_quantity'] as string },
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

  // AC4: the dispatch order moves to picked only when every task for it is complete. A batch task
  // consolidates several order lines, and pick_task.dispatch_order_id holds only the first of them,
  // so each contributing line is resolved through the pick_line rows and then counted against the
  // tasks that actually reference it (review pass 2: the previous version counted contributing
  // lines 2..n against an empty set and skipped them forever).
  const contributing = await client.query(
    `SELECT DISTINCT pl.dispatch_order_line_id AS order_id FROM pick_line pl WHERE pl.pick_task_id = $1`,
    [pickTaskId],
  );
  const orderIds = new Set<string>(contributing.rows.map((r: Record<string, unknown>) => r['order_id'] as string));
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
export async function applyPickTaskCompletedProjection(envelope: PickTaskCompletedEnvelope, client: PoolClient, eventId: string): Promise<void> {
  const p = envelope.payload;

  // Review pass 2: read the task INSIDE the row lock. The previous version read the status
  // unlocked and then relied on an unguarded UPDATE, so two concurrent completions both passed the
  // gate and both ran the allocated-to-picked move, draining allocation belonging to other tasks
  // at the same (sku, bin, lot) row.
  const task = await getPickTaskByIdForUpdate(p.pick_task_id, client);
  if (!task) {
    throw new AppError(404, 'PICK_TASK_NOT_FOUND', `No pick task exists for "${p.pick_task_id}"`, { pick_task_id: p.pick_task_id });
  }
  if (task.status === 'completed') return; // idempotent replay

  const taskSiteId = await siteForPickTask(p.pick_task_id, client);
  if (taskSiteId === null) {
    throw new AppError(404, 'PICK_TASK_NOT_FOUND', `No pick task exists for "${p.pick_task_id}"`, { pick_task_id: p.pick_task_id });
  }
  assertActorSite(envelope.metadata.actor.location_id, taskSiteId, { pick_task_id: p.pick_task_id });

  // SOD (Task 6.2 and the Dev Notes SOD/RBAC rule): completion is a supervisor action. The HTTP
  // handler enforces this, but the edge upload and direct-event paths authorize only on
  // module plus write, so without this check an operator could post the command themselves.
  if (!PICK_COMPLETE_ROLES.includes(envelope.metadata.actor.role)) {
    throw new AppError(403, 'FUNCTION_ACCESS_DENIED', `Completing a pick task is restricted to roles: ${PICK_COMPLETE_ROLES.join(', ')}`, {
      pick_task_id: p.pick_task_id,
      actor_role: envelope.metadata.actor.role,
    });
  }

  // Lock the task's pick lines so a concurrent confirmation cannot slip between the count and the
  // status update. FOR UPDATE cannot ride the aggregate query itself (PostgreSQL 0A000), so the
  // lock runs as a separate statement (mirrors applyStockAllocation's lock-then-check).
  await client.query(`SELECT pick_line_id FROM pick_line WHERE pick_task_id = $1 FOR UPDATE`, [p.pick_task_id]);
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

  await finalizePickTaskCompletion(p.pick_task_id, envelope.metadata.actor, client, eventId);
}
