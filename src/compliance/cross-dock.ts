import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import type {
  CrossDockTaskAssignedEnvelope,
  CrossDockTaskCompletedEnvelope,
} from '../events/schema.js';
import { AppError } from '../middleware/error.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import {
  assignCrossDockTask,
  completeCrossDockTask,
  getCrossDockTaskByIdForUpdate,
} from '../read/projections/cross_dock_task.js';
import {
  getCurrentLocation,
  getExpectedLocation,
  recordAssertedLocation,
  recordExpectedLocation,
  updateCurrentLocation,
} from '../read/projections/location.js';
import {
  applyStockAllocation,
  applyStockIssue,
  applyStockPick,
  applyStockReceipt,
} from '../read/projections/stock_balance.js';
import { getRemainingDemand } from '../read/projections/erp_sales_order.js';
import { createPickTask } from '../read/projections/pick_task.js';
import { createPickLine } from '../read/projections/pick_line.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const NUMERIC_14_3 = /^\d{1,11}(\.\d{1,3})?$/;

export function isCrossDockQuantityCapacity(value: string): boolean {
  return NUMERIC_14_3.test(value) && !/^0+(\.0+)?$/.test(value);
}

export const CROSS_DOCK_ERROR_CODES = {
  TASK_NOT_FOUND: 'CROSS_DOCK_TASK_NOT_FOUND',
  TASK_NOT_READY: 'CROSS_DOCK_TASK_NOT_READY',
  TASK_ALREADY_COMPLETED: 'CROSS_DOCK_TASK_ALREADY_COMPLETED',
  STAGING_INVALID: 'CROSS_DOCK_STAGING_INVALID',
  DESTINATION_OUTSIDE_STAGING: 'CROSS_DOCK_DESTINATION_OUTSIDE_STAGING',
  SITE_MISMATCH: 'CROSS_DOCK_SITE_MISMATCH',
  ORDER_NOT_OPEN: 'CROSS_DOCK_ORDER_NOT_OPEN',
  DEMAND_ALREADY_ALLOCATED: 'CROSS_DOCK_DEMAND_ALREADY_ALLOCATED',
  QUANTITY_MISMATCH: 'CROSS_DOCK_QUANTITY_MISMATCH',
} as const;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalid(message: string): never {
  throw new AppError(400, 'INVALID_PARAMS', message);
}

export function assertCrossDockTaskAssignedShape(envelope: CrossDockTaskAssignedEnvelope): void {
  const payload = envelope.payload;
  if (!isUuid(payload.cross_dock_task_id))
    invalid('cross_dock_task_id is required and must be a UUID');
  if (!isUuid(payload.assigned_to)) invalid('assigned_to is required and must be a UUID');
  if (
    payload.priority !== undefined &&
    payload.priority !== null &&
    !PRIORITIES.has(payload.priority)
  ) {
    invalid('priority must be low, normal, high, or urgent when supplied');
  }
}

export function assertCrossDockTaskCompletedShape(envelope: CrossDockTaskCompletedEnvelope): void {
  const payload = envelope.payload;
  if (!isUuid(payload.cross_dock_task_id))
    invalid('cross_dock_task_id is required and must be a UUID');
  if (!isUuid(payload.pick_task_id)) invalid('pick_task_id is required and must be a UUID');
  if (!isUuid(payload.pick_line_id)) invalid('pick_line_id is required and must be a UUID');
  const hasId = payload.to_location_id !== undefined;
  const hasCode = payload.to_location_code !== undefined;
  if (hasId === hasCode) invalid('exactly one of to_location_id or to_location_code is required');
  if (hasId && !isUuid(payload.to_location_id))
    invalid('to_location_id must be a UUID when supplied');
  if (hasCode && !isNonEmptyString(payload.to_location_code))
    invalid('to_location_code must be non-empty when supplied');
}

export function assertCrossDockEventShape(envelope: EventEnvelope): void {
  if (envelope.stream_type !== 'warehouse') return;
  if (envelope.event_type === 'cross_dock_task.assigned') {
    assertCrossDockTaskAssignedShape(envelope as unknown as CrossDockTaskAssignedEnvelope);
  }
  if (envelope.event_type === 'cross_dock_task.completed') {
    assertCrossDockTaskCompletedShape(envelope as unknown as CrossDockTaskCompletedEnvelope);
  }
}

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const ASSIGN_ROLES = new Set(['warehouse_manager', 'inventory_controller']);
const COMPLETE_ROLES = new Set(['store_assistant', 'warehouse_operator']);
const ASSIGNEE_ROLES = new Set(['store_assistant', 'warehouse_operator']);

function assertActorSite(actorLocationId: string, siteId: string): void {
  if (actorLocationId !== NO_LOCATION_UUID && actorLocationId !== siteId) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      `No assignment grants access to site "${siteId}"`,
    );
  }
}

async function assertActiveSiteOperator(
  userId: string,
  siteId: string,
  client: PoolClient,
): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM users u JOIN user_role_assignments ura ON ura.user_id = u.user_id
      WHERE u.user_id = $1 AND u.active = true AND ura.role = ANY($2::text[])
        AND ura.function_scope = 'write' AND ura.module IN ('warehouse', '*')
        AND (ura.location_id = '*' OR ura.location_id = $3::text) LIMIT 1`,
    [userId, [...ASSIGNEE_ROLES], siteId],
  );
  if (result.rows.length === 0)
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      'Completion requires an active site-authorized cross-dock operator',
    );
}

async function assertTaskAuthorities(
  task: NonNullable<Awaited<ReturnType<typeof getCrossDockTaskByIdForUpdate>>>,
  client: PoolClient,
): Promise<void> {
  const facts = await client.query(
    `SELECT
       (SELECT site_id FROM grn WHERE grn_id = gl.grn_id) AS grn_site_id,
       (SELECT ship_from_site_id FROM erp_sales_order WHERE id = cdt.dispatch_order_line_id) AS order_site_id,
       (SELECT site_id FROM location_register WHERE location_id = cdt.from_location_id) AS source_site_id,
       (SELECT site_id FROM location_register WHERE location_id = cdt.staging_zone_id) AS staging_site_id
     FROM cross_dock_task cdt JOIN grn_line gl ON gl.grn_line_id = cdt.grn_line_id
     WHERE cdt.cross_dock_task_id = $1`,
    [task.cross_dock_task_id],
  );
  const row = facts.rows[0];
  if (
    !row ||
    [row['grn_site_id'], row['order_site_id'], row['source_site_id'], row['staging_site_id']].some(
      (site) => site !== task.site_id,
    )
  ) {
    throw new AppError(
      409,
      CROSS_DOCK_ERROR_CODES.SITE_MISMATCH,
      'Cross-dock task authoritative entities do not resolve to one site',
    );
  }
}

export async function applyCrossDockTaskAssignedProjection(
  envelope: CrossDockTaskAssignedEnvelope,
  client: PoolClient,
): Promise<void> {
  if (!ASSIGN_ROLES.has(envelope.metadata.actor.role))
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      'Cross-dock assignment requires a warehouse supervisor role',
    );
  const task = await getCrossDockTaskByIdForUpdate(envelope.payload.cross_dock_task_id, client);
  if (!task)
    throw new AppError(404, CROSS_DOCK_ERROR_CODES.TASK_NOT_FOUND, 'Cross-dock task not found');
  assertActorSite(envelope.metadata.actor.location_id, task.site_id);
  await assertTaskAuthorities(task, client);
  const assignee = await client.query(
    `SELECT 1 FROM users u JOIN user_role_assignments ura ON ura.user_id = u.user_id
      WHERE u.user_id = $1 AND u.active = true AND ura.role = ANY($2::text[])
        AND ura.function_scope = 'write' AND (ura.module IN ('warehouse', '*'))
        AND (ura.location_id = '*' OR ura.location_id = $3::text) LIMIT 1`,
    [envelope.payload.assigned_to, [...ASSIGNEE_ROLES], task.site_id],
  );
  if (assignee.rows.length === 0)
    throw new AppError(
      404,
      'ASSIGNEE_NOT_FOUND',
      'Assignee must be an active site-authorized cross-dock operator',
    );
  const assigned = await assignCrossDockTask(
    {
      crossDockTaskId: task.cross_dock_task_id,
      assignedTo: envelope.payload.assigned_to,
      assignedBy: envelope.metadata.actor.user_id,
      assignedAt: envelope.metadata.occurred_at,
      priority: envelope.payload.priority ?? null,
    },
    client,
  );
  if (!assigned)
    throw new AppError(
      409,
      CROSS_DOCK_ERROR_CODES.TASK_NOT_READY,
      'Cross-dock task is not ready or is already assigned',
    );
}

export async function applyCrossDockTaskCompletedProjection(
  envelope: CrossDockTaskCompletedEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (!COMPLETE_ROLES.has(envelope.metadata.actor.role))
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      'Cross-dock completion requires an operator role',
    );
  const p = envelope.payload;
  const task = await getCrossDockTaskByIdForUpdate(p.cross_dock_task_id, client);
  if (!task)
    throw new AppError(404, CROSS_DOCK_ERROR_CODES.TASK_NOT_FOUND, 'Cross-dock task not found');
  const completionAt = new Date(envelope.metadata.occurred_at);
  if (completionAt.getTime() < new Date(task.created_at).getTime())
    throw new AppError(
      409,
      CROSS_DOCK_ERROR_CODES.TASK_NOT_READY,
      'Completion timestamp cannot precede task creation',
    );
  assertActorSite(envelope.metadata.actor.location_id, task.site_id);
  await assertTaskAuthorities(task, client);
  const destination = await client.query(
    `WITH RECURSIVE ancestors AS (
       SELECT location_id, parent_location_id, 0 AS depth FROM location_register WHERE location_id = COALESCE($1::uuid, (SELECT location_id FROM location_register WHERE location_code = $2))
       UNION ALL
       SELECT lr.location_id, lr.parent_location_id, a.depth + 1 FROM location_register lr JOIN ancestors a ON a.parent_location_id = lr.location_id WHERE a.depth < 10
     )
     SELECT lr.* FROM location_register lr
      WHERE lr.location_id = COALESCE($1::uuid, (SELECT location_id FROM location_register WHERE location_code = $2))
        AND lr.level = 'bin' AND lr.status = 'active' AND lr.quarantine = false AND lr.access_restricted = false
        AND lr.site_id = $3 AND EXISTS (SELECT 1 FROM ancestors WHERE location_id = $4)`,
    [p.to_location_id ?? null, p.to_location_code ?? null, task.site_id, task.staging_zone_id],
  );
  if (destination.rows.length === 0)
    throw new AppError(
      409,
      CROSS_DOCK_ERROR_CODES.DESTINATION_OUTSIDE_STAGING,
      'Destination must be an active writable bin below the task staging zone',
    );
  const toLocationId = destination.rows[0]!['location_id'] as string;
  if (task.status === 'completed') {
    const same =
      task.to_location_id === toLocationId &&
      task.completion_event_id === eventId &&
      task.completed_by === envelope.metadata.actor.user_id;
    if (same) return;
    throw new AppError(
      409,
      CROSS_DOCK_ERROR_CODES.TASK_ALREADY_COMPLETED,
      'Cross-dock task was already completed with a conflicting outcome',
    );
  }
  if (task.assigned_to && task.assigned_to !== envelope.metadata.actor.user_id)
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      'Only the active assignee may complete this cross-dock task',
    );
  await assertActiveSiteOperator(envelope.metadata.actor.user_id, task.site_id, client);

  const order = await client.query(`SELECT status FROM erp_sales_order WHERE id = $1 FOR UPDATE`, [
    task.dispatch_order_line_id,
  ]);
  if (order.rows[0]?.['status'] !== 'open')
    throw new AppError(
      409,
      CROSS_DOCK_ERROR_CODES.ORDER_NOT_OPEN,
      'Matched sales-order line is no longer open',
    );
  const remaining = await getRemainingDemand(
    task.dispatch_order_line_id,
    client,
    task.cross_dock_task_id,
  );
  const enough =
    remaining === null
      ? false
      : (
          await client.query(`SELECT $1::numeric >= $2::numeric AS enough`, [
            remaining,
            task.quantity,
          ])
        ).rows[0]!['enough'] === true;
  if (!enough)
    throw new AppError(
      409,
      CROSS_DOCK_ERROR_CODES.DEMAND_ALREADY_ALLOCATED,
      'Matched demand no longer covers the task quantity',
    );
  const lotResult = await client.query(
    `SELECT lm.lot_number, lm.quality_hold_status FROM lot_master lm JOIN grn_line gl ON gl.lot_id = lm.lot_number AND gl.sku = lm.sku
      WHERE lm.lot_id = $1 AND gl.grn_line_id = $2 FOR UPDATE OF lm`,
    [task.lot_id, task.grn_line_id],
  );
  if (lotResult.rows.length === 0)
    throw new AppError(
      409,
      CROSS_DOCK_ERROR_CODES.QUANTITY_MISMATCH,
      'Task lot no longer matches the receipt',
    );
  if (lotResult.rows[0]!['quality_hold_status'] !== 'none')
    throw new AppError(400, 'LOT_ON_HOLD', 'The cross-dock lot is on hold');
  const lotNumber = lotResult.rows[0]!['lot_number'] as string;
  await client.query(
    `SELECT balance_id FROM stock_balance WHERE sku = $1 AND location_id = $2 AND lot_id = $3 AND stock_class = 'owned' ORDER BY balance_id FOR UPDATE`,
    [task.sku, task.from_location_id, lotNumber],
  );
  const source = await client.query(
    `SELECT COALESCE(SUM(available), 0) = $4::numeric AS exact FROM stock_balance
      WHERE sku = $1 AND location_id = $2 AND lot_id = $3 AND stock_class = 'owned'`,
    [task.sku, task.from_location_id, lotNumber, task.quantity],
  );
  if (source.rows[0]!['exact'] !== true)
    throw new AppError(
      409,
      'INSUFFICIENT_STOCK',
      'Source must contain the exact owned available task quantity',
    );

  await applyStockIssue(
    {
      sku: task.sku,
      location_id: task.from_location_id,
      lot_id: lotNumber,
      quantity: task.quantity,
      occurred_at: envelope.metadata.occurred_at,
    },
    client,
  );
  await applyStockReceipt(
    {
      sku: task.sku,
      location_id: toLocationId,
      location_code: destination.rows[0]!['location_code'] as string,
      lot_id: lotNumber,
      quantity: task.quantity,
    },
    client,
  );
  await applyStockAllocation(
    { sku: task.sku, location_id: toLocationId, lot_id: lotNumber, quantity: task.quantity },
    client,
  );
  await applyStockPick(
    { sku: task.sku, location_id: toLocationId, lot_id: lotNumber, quantity: task.quantity },
    client,
  );

  await createPickTask(
    {
      pick_task_id: p.pick_task_id,
      dispatch_order_id: task.dispatch_order_line_id,
      sku: task.sku,
      total_quantity: task.quantity,
      strategy: 'single',
      zone_id: task.staging_zone_id,
      status: 'completed',
      fulfillment_source: 'cross_dock',
      created_by: task.created_by,
      created_at: task.created_at,
      completed_at: envelope.metadata.occurred_at,
      completed_by: envelope.metadata.actor.user_id,
    },
    client,
  );
  await createPickLine(
    {
      pick_line_id: p.pick_line_id,
      pick_task_id: p.pick_task_id,
      dispatch_order_line_id: task.dispatch_order_line_id,
      sku: task.sku,
      directed_lot_id: task.lot_id,
      directed_quantity: task.quantity,
      location_id: toLocationId,
      pick_sequence: 1,
      cross_dock_task_id: task.cross_dock_task_id,
      confirmed_lot_id: task.lot_id,
      confirmed_quantity: task.quantity,
      confirmed_location_id: toLocationId,
      status: 'confirmed',
      capture_method: 'PWA',
      confirmed_by: envelope.metadata.actor.user_id,
      created_at: task.created_at,
      confirmed_at: envelope.metadata.occurred_at,
    },
    client,
  );

  const transitioned = await client.query(
    `INSERT INTO dispatch_order_status (dispatch_order_id, picked_at, picked_by)
     SELECT eso.id, $2::timestamptz, $3 FROM erp_sales_order eso
      WHERE eso.id = $1 AND (SELECT COALESCE(SUM(pl.confirmed_quantity), 0) FROM pick_line pl WHERE pl.dispatch_order_line_id = eso.id AND pl.status IN ('confirmed', 'substituted')) >= eso.quantity
     ON CONFLICT (dispatch_order_id) DO NOTHING RETURNING dispatch_order_id`,
    [task.dispatch_order_line_id, envelope.metadata.occurred_at, envelope.metadata.actor.user_id],
  );
  if (transitioned.rows.length > 0) {
    await emitNotificationInTransaction(
      {
        target: { role: 'warehouse_manager', location_id: task.site_id },
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
  }

  const destinationCode = destination.rows[0]!['location_code'] as string;
  const expected = await getExpectedLocation(task.lot_id, client);
  if (expected && expected.expected_location !== destinationCode)
    throw new AppError(
      409,
      'CROSS_DOCK_DESTINATION_OUTSIDE_STAGING',
      'Existing expected lot location conflicts with cross-dock destination',
    );
  if (!expected)
    await recordExpectedLocation(
      {
        lot_id: task.lot_id,
        expected_location: destinationCode,
        source: 'cross_dock',
        source_event_id: eventId,
      },
      client,
    );
  const current = await getCurrentLocation(task.lot_id, client);
  const nextVersion = (current?.source_event_version ?? 0) + 1;
  const fact = await recordAssertedLocation(
    {
      lot_id: task.lot_id,
      asserted_location: destinationCode,
      recorded_by: envelope.metadata.actor.user_id,
      device_id: envelope.metadata.device_id ?? null,
      confidence: 'certain',
      source_event_id: eventId,
      source_event_version: nextVersion,
    },
    client,
  );
  if (!fact)
    throw new AppError(
      409,
      'STREAM_CONFLICT',
      'A newer location assertion already exists for this lot',
    );
  await updateCurrentLocation(
    task.lot_id,
    destinationCode,
    'certain',
    fact.fact_id,
    nextVersion,
    client,
  );

  const completed = await completeCrossDockTask(
    {
      crossDockTaskId: task.cross_dock_task_id,
      toLocationId,
      completedBy: envelope.metadata.actor.user_id,
      completedAt: envelope.metadata.occurred_at,
      completionEventId: eventId,
    },
    client,
  );
  if (!completed)
    throw new AppError(
      409,
      CROSS_DOCK_ERROR_CODES.TASK_NOT_READY,
      'Cross-dock task changed concurrently',
    );
}
