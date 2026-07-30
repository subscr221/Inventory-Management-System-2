import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  ForwardPickConfigUpdatedEnvelope,
  ReplenishmentTaskCreatedEnvelope,
  ReplenishmentTaskAssignedEnvelope,
  ReplenishmentTaskCompletedEnvelope,
} from '../events/schema.js';
import { AppError } from '../middleware/error.js';
import { upsertForwardPickConfig } from '../read/projections/forward_pick_config.js';
import {
  insertReplenishmentTask,
  getReplenishmentTaskByIdForUpdate,
  assignReplenishmentTask,
  completeReplenishmentTask,
} from '../read/projections/replenishment_task.js';
import { getLocationByCode, getLocationById } from '../read/projections/location_register.js';
import { applyStockIssue, applyStockReceipt } from '../read/projections/stock_balance.js';

/**
 * Story 3.9 write-path seam for forward-pick replenishment (FR-W-08): threshold configuration,
 * task creation, and task completion. Mirrors src/compliance/warehouse-task.ts's structure - a
 * pre-transaction shape assert per event type (runs with the other asserts in src/events/store.ts,
 * so a malformed payload never consumes an idempotency key) and an in-transaction projection apply
 * (runs immediately before the domain_events insert). The FORWARD_PICK_ZONE_INVALID zone check
 * lives HERE, not only in the HTTP handler, per the Story 3.8 lesson that a role/shape check
 * living only in a route handler lets a direct POST /api/v1/events bypass it.
 */

const MAX_QUANTITY = 1e12;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function reject(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new AppError(400, code, message, details);
}

/** Normalizes a strictly-positive quantity-shaped value to a NUMERIC string, or null when it cannot be. */
function normalizeQuantity(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0 || value > MAX_QUANTITY) return null;
    return String(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_QUANTITY) return null;
    return value;
  }
  return null;
}

/** Like normalizeQuantity but admits zero (for min_qty, whose CHECK constraint is >= 0). */
function normalizeNonNegativeQuantity(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > MAX_QUANTITY) return null;
    return String(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > MAX_QUANTITY) return null;
    return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared zone validation (Task 2.2 / 5.2)
// ---------------------------------------------------------------------------

/**
 * Validates that `zoneId` resolves to an active, zone-level location_register row with
 * zone_type = 'forward_pick'. Returns the zone's site_id. Used by both the config write (Task 2.2)
 * and replenishment task creation (Task 5.2) - both must reject the same way against a config or a
 * task pointed at a non-forward-pick zone.
 */
async function assertForwardPickZone(zoneId: string, client: PoolClient): Promise<{ siteId: string }> {
  const zone = await client.query(
    `SELECT level, status, zone_type, site_id FROM location_register WHERE location_id = $1`,
    [zoneId],
  );
  if (zone.rows.length === 0) {
    throw new AppError(404, 'LOCATION_NOT_FOUND', `No location register entry exists for "${zoneId}"`, { zone_id: zoneId });
  }
  const row = zone.rows[0]!;
  if (row['level'] !== 'zone' || row['zone_type'] !== 'forward_pick' || row['status'] !== 'active') {
    throw new AppError(400, 'FORWARD_PICK_ZONE_INVALID', `Location "${zoneId}" is not an active forward-pick zone`, {
      zone_id: zoneId,
      level: row['level'],
      zone_type: row['zone_type'],
      status: row['status'],
    });
  }
  return { siteId: row['site_id'] as string };
}

// ---------------------------------------------------------------------------
// Task 2/6: forward_pick_config.updated
// ---------------------------------------------------------------------------

export function assertForwardPickConfigUpdatedShape(envelope: ForwardPickConfigUpdatedEnvelope): void {
  const p = envelope.payload;
  if (typeof p !== 'object' || p === null) {
    reject('FORWARD_PICK_CONFIG_INVALID_PAYLOAD', 'payload is required and must be an object');
  }
  if (!isNonEmptyString(p.sku)) {
    reject('FORWARD_PICK_CONFIG_INVALID_PAYLOAD', 'sku is required and must be a non-empty string');
  }
  if (!isNonEmptyString(p.zone_id)) {
    reject('FORWARD_PICK_CONFIG_INVALID_PAYLOAD', 'zone_id is required and must be a non-empty string');
  }
  const minQty = normalizeNonNegativeQuantity(p.min_qty);
  if (minQty === null) {
    reject('FORWARD_PICK_CONFIG_INVALID_PAYLOAD', 'min_qty is required and must be a non-negative number', { min_qty: p.min_qty });
  }
  const maxQty = normalizeQuantity(p.max_qty);
  if (maxQty === null) {
    reject('FORWARD_PICK_CONFIG_INVALID_PAYLOAD', 'max_qty is required and must be a positive number', { max_qty: p.max_qty });
  }
  if (Number(maxQty) <= Number(minQty)) {
    reject('FORWARD_PICK_CONFIG_INVALID_PAYLOAD', 'max_qty must be greater than min_qty', { min_qty: p.min_qty, max_qty: p.max_qty });
  }
}

/**
 * Upserts the (sku, zone_id) threshold. site_id is resolved from the zone itself, never accepted
 * from the payload, so a client cannot claim a site the zone does not belong to. updated_by is
 * server-set from the envelope's actor metadata, never the payload.
 */
export async function applyForwardPickConfigUpdatedProjection(
  envelope: ForwardPickConfigUpdatedEnvelope,
  client: PoolClient,
): Promise<void> {
  const p = envelope.payload;
  const { siteId } = await assertForwardPickZone(p.zone_id, client);
  const minQty = normalizeNonNegativeQuantity(p.min_qty) ?? '0';
  const maxQty = normalizeQuantity(p.max_qty)!;

  await upsertForwardPickConfig(
    {
      sku: p.sku,
      zone_id: p.zone_id,
      site_id: siteId,
      min_qty: minQty,
      max_qty: maxQty,
      updated_by: envelope.metadata.actor.user_id,
    },
    client,
  );
}

// ---------------------------------------------------------------------------
// Task 5: replenishment_task.created / .completed
// ---------------------------------------------------------------------------

const SIGNAL_TYPES = ['min_max', 'demand_signal'];

export function assertReplenishmentTaskCreatedShape(envelope: ReplenishmentTaskCreatedEnvelope): void {
  const p = envelope.payload;
  if (typeof p !== 'object' || p === null) {
    reject('REPLENISHMENT_TASK_INVALID_PAYLOAD', 'payload is required and must be an object');
  }
  if (!isNonEmptyString(p.replenishment_task_id)) {
    reject('REPLENISHMENT_TASK_INVALID_PAYLOAD', 'replenishment_task_id is required and must be a non-empty string');
  }
  if (!isNonEmptyString(p.sku)) {
    reject('REPLENISHMENT_TASK_INVALID_PAYLOAD', 'sku is required and must be a non-empty string');
  }
  if (!isNonEmptyString(p.zone_id)) {
    reject('REPLENISHMENT_TASK_INVALID_PAYLOAD', 'zone_id is required and must be a non-empty string');
  }
  if (!isNonEmptyString(p.site_id)) {
    reject('REPLENISHMENT_TASK_INVALID_PAYLOAD', 'site_id is required and must be a non-empty string');
  }
  if (normalizeQuantity(p.quantity) === null) {
    reject('REPLENISHMENT_TASK_INVALID_PAYLOAD', `quantity is required and must be a positive number not exceeding ${MAX_QUANTITY}`, {
      quantity: p.quantity,
    });
  }
  if (!SIGNAL_TYPES.includes(p.signal_type)) {
    reject('REPLENISHMENT_TASK_INVALID_PAYLOAD', `signal_type is required and must be one of: ${SIGNAL_TYPES.join(', ')}`, {
      signal_type: p.signal_type,
    });
  }
}

/**
 * Idempotency short-circuit on replenishment_task_id (mirrors applyTransferRequestProjection's
 * existing-row check), then validates the zone via the shared FORWARD_PICK_ZONE_INVALID check
 * before inserting the row. correlation_id is stamped from the envelope's metadata - AC3 requires
 * the same id to reappear on the completion movements, and the row's stored value is what any
 * drill-through query traces both movements back to.
 */
export async function applyReplenishmentTaskCreatedProjection(
  envelope: ReplenishmentTaskCreatedEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload;

  const existing = await client.query(
    `SELECT replenishment_task_id FROM replenishment_task WHERE replenishment_task_id = $1`,
    [p.replenishment_task_id],
  );
  if (existing.rows.length > 0) return;

  const { siteId } = await assertForwardPickZone(p.zone_id, client);
  if (siteId !== p.site_id) {
    throw new AppError(400, 'FORWARD_PICK_ZONE_INVALID', `Zone "${p.zone_id}" does not belong to site "${p.site_id}"`, {
      zone_id: p.zone_id,
      zone_site_id: siteId,
      site_id: p.site_id,
    });
  }

  if (p.from_location_id) {
    const source = await getLocationById(p.from_location_id, client);
    if (!source || source.status !== 'active') {
      throw new AppError(400, 'LOCATION_NOT_FOUND', `from_location_id "${p.from_location_id}" does not exist or is not active`, {
        from_location_id: p.from_location_id,
      });
    }
  }

  const quantity = normalizeQuantity(p.quantity)!;
  await insertReplenishmentTask(
    {
      replenishment_task_id: p.replenishment_task_id,
      sku: p.sku,
      zone_id: p.zone_id,
      site_id: siteId,
      from_location_id: p.from_location_id ?? null,
      quantity,
      signal_type: p.signal_type,
      correlation_id: envelope.metadata.correlation_id ?? randomUUID(),
      source_event_id: eventId,
    },
    client,
  );
}

export function assertReplenishmentTaskAssignedShape(envelope: ReplenishmentTaskAssignedEnvelope): void {
  const p = envelope.payload;
  if (typeof p !== 'object' || p === null) {
    reject('REPLENISHMENT_TASK_INVALID_PAYLOAD', 'payload is required and must be an object');
  }
  if (!isNonEmptyString(p.replenishment_task_id)) {
    reject('REPLENISHMENT_TASK_INVALID_PAYLOAD', 'replenishment_task_id is required and must be a non-empty string');
  }
  if (!isNonEmptyString(p.assigned_to)) {
    reject('REPLENISHMENT_TASK_INVALID_PAYLOAD', 'assigned_to is required and must be a non-empty string');
  }
  if (p.priority !== undefined && p.priority !== null && !['low', 'normal', 'high', 'urgent'].includes(p.priority)) {
    reject('REPLENISHMENT_TASK_INVALID_PAYLOAD', 'priority must be one of: low, normal, high, urgent, or null', {
      priority: p.priority,
    });
  }
}

export async function applyReplenishmentTaskAssignedProjection(
  envelope: ReplenishmentTaskAssignedEnvelope,
  client: PoolClient,
): Promise<void> {
  const p = envelope.payload;
  const assignedBy = envelope.metadata.actor.user_id;
  await assignReplenishmentTask(
    {
      replenishmentTaskId: p.replenishment_task_id,
      assignedTo: p.assigned_to,
      assignedBy,
      priority: p.priority ?? null,
    },
    client,
  );
}

export function assertReplenishmentTaskCompletedShape(envelope: ReplenishmentTaskCompletedEnvelope): void {
  const p = envelope.payload;
  if (typeof p !== 'object' || p === null) {
    reject('REPLENISHMENT_TASK_INVALID_PAYLOAD', 'payload is required and must be an object');
  }
  if (!isNonEmptyString(p.replenishment_task_id)) {
    reject('REPLENISHMENT_TASK_INVALID_PAYLOAD', 'replenishment_task_id is required and must be a non-empty string');
  }
  const hasId = isNonEmptyString(p.to_location_id);
  const hasCode = isNonEmptyString(p.to_location_code);

  if (!hasId && !hasCode) {
    reject('REPLENISHMENT_TASK_INVALID_PAYLOAD', 'Either to_location_id or to_location_code is required');
  }
  if (hasId && hasCode) {
    reject('REPLENISHMENT_TASK_INVALID_PAYLOAD', 'Provide exactly one of to_location_id or to_location_code, not both');
  }
}

/**
 * Confirms a replenishment task (AC3). The row is locked FOR UPDATE first, serializing concurrent
 * confirmations exactly like applyPutawayCompletedProjection; an already-completed task is an
 * idempotent no-op, a task that is neither ready nor completed is a fail-closed 409. The resolved
 * destination bin must descend from the task's own zone_id (REPLENISHMENT_DESTINATION_OUTSIDE_ZONE
 * otherwise). Both stock movements call applyStockIssue/applyStockReceipt directly - never
 * applyStockBalanceProjection, which is gated to the 'inventory' stream and would silently no-op
 * here - inside this same transaction as completeReplenishmentTask, so AC3's "both movements carry
 * the same correlation_id" holds because both run against the one stored correlation_id set at
 * creation, inside the one replenishment_task.completed transaction.
 */
export async function applyReplenishmentTaskCompletedProjection(
  envelope: ReplenishmentTaskCompletedEnvelope,
  client: PoolClient,
): Promise<void> {
  const p = envelope.payload;

  const task = await getReplenishmentTaskByIdForUpdate(p.replenishment_task_id, client);
  if (!task) {
    throw new AppError(404, 'REPLENISHMENT_TASK_NOT_FOUND', `No replenishment task exists for "${p.replenishment_task_id}"`, {
      replenishment_task_id: p.replenishment_task_id,
    });
  }
  if (task.status === 'completed') return;
  if (task.status !== 'ready') {
    throw new AppError(409, 'REPLENISHMENT_TASK_NOT_READY', `Replenishment task "${p.replenishment_task_id}" is not ready`, {
      replenishment_task_id: p.replenishment_task_id,
      status: task.status,
    });
  }
  if (!task.from_location_id) {
    throw new AppError(409, 'REPLENISHMENT_TASK_NOT_READY', `Replenishment task "${p.replenishment_task_id}" has no source location resolved`, {
      replenishment_task_id: p.replenishment_task_id,
    });
  }

  const destination = p.to_location_code
    ? await getLocationByCode(p.to_location_code, client)
    : await getLocationById(p.to_location_id!, client);
  if (!destination || destination.status !== 'active') {
    throw new AppError(404, 'LOCATION_NOT_FOUND', `Destination location does not exist or is not active`, {
      to_location_id: p.to_location_id,
      to_location_code: p.to_location_code,
    });
  }

  // Verify the destination bin descends from the task's own zone (the mirror-image descendant
  // walk of Task 4.1, scoped to a single candidate rather than aggregating a balance).
  const descendantCheck = await client.query(
    `WITH RECURSIVE ancestry AS (
       SELECT location_id, parent_location_id, 0 AS depth FROM location_register WHERE location_id = $1
       UNION ALL
       SELECT lr.location_id, lr.parent_location_id, a.depth + 1
         FROM location_register lr
         JOIN ancestry a ON lr.location_id = a.parent_location_id
        WHERE a.depth < 10
     )
     SELECT 1 FROM ancestry WHERE location_id = $2 LIMIT 1`,
    [destination.location_id, task.zone_id],
  );
  if (destination.location_id !== task.zone_id && descendantCheck.rows.length === 0) {
    throw new AppError(
      409,
      'REPLENISHMENT_DESTINATION_OUTSIDE_ZONE',
      `Destination location "${destination.location_id}" does not belong to zone "${task.zone_id}"`,
      { destination_location_id: destination.location_id, zone_id: task.zone_id },
    );
  }

  const completedBy = envelope.metadata.actor.user_id;

  await applyStockIssue(
    { sku: task.sku, location_id: task.from_location_id, quantity: Number(task.quantity) },
    client,
  );
  await applyStockReceipt(
    { sku: task.sku, location_id: destination.location_id, location_code: destination.location_code, quantity: Number(task.quantity) },
    client,
  );

  const completed = await completeReplenishmentTask(
    { replenishmentTaskId: p.replenishment_task_id, toLocationId: destination.location_id, completedBy },
    client,
  );
  if (!completed) {
    throw new AppError(409, 'REPLENISHMENT_TASK_NOT_READY', `Replenishment task "${p.replenishment_task_id}" could not be completed`, {
      replenishment_task_id: p.replenishment_task_id,
    });
  }
}
