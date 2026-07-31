import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  PickTaskAssignedEnvelope,
  PutawayTaskAssignedEnvelope,
  TaskSlaConfigUpdatedEnvelope,
  WarehouseTaskType,
} from '../events/schema.js';
import { AppError } from '../middleware/error.js';
import { assignPickTask } from '../read/projections/pick_task.js';
import { assignPutawayTask } from '../read/projections/putaway_task.js';
import { upsertSlaConfig } from '../read/projections/task_sla_config.js';
import { activeUserExistsById } from '../read/projections/users.js';

/**
 * Story 3.8 write-path seam for the warehouse task-management events (FR-W-07, AC1): SLA-threshold
 * changes and task assignment.
 *
 * Two halves per event, mirroring every other compliance module: a pre-transaction shape assert that
 * runs with the other asserts in src/events/store.ts (so a malformed payload never consumes an
 * idempotency key), and an in-transaction projection apply that runs immediately before the
 * domain_events insert (so the projection row and its event commit or roll back together).
 *
 * The supervisor-only SOD gates live HERE rather than only in the HTTP handlers. That is deliberate:
 * a prior warehouse story shipped a role check that existed only in its route handler, which left a
 * direct POST /api/v1/events call able to perform the same privileged write unchecked. Every path
 * into persistEvent passes through these functions, so this is the only placement that actually
 * holds.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The sentinel an actor carries when their assignment is site-wildcard rather than a single site.
 * Matches the value the API layer substitutes for a '*' location assignment.
 */
const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';

export const WAREHOUSE_TASK_TYPES: readonly WarehouseTaskType[] = [
  'receiving',
  'putaway',
  'picking',
  'packing',
  'replenishment',
  'cross_docking',
];

/**
 * Changing an SLA threshold changes what counts as a breach, and assigning work directs another
 * person's shift. Both are supervisor actions. Kept as one constant next to the seam that enforces
 * it; src/api/v1/warehouse-tasks.ts and src/api/v1/putaway.ts import this same list rather than
 * restating it, so the HTTP gates and the seam gates can never drift apart.
 */
export const WAREHOUSE_TASK_SUPERVISE_ROLES = ['warehouse_manager', 'inventory_controller'];

/**
 * Matches NUMERIC(9,2): at most 7 integer digits and at most 2 fractional digits.
 *
 * The integer bound is not cosmetic. The earlier `^\d+(\.\d{1,2})?$` constrained the scale but left
 * the precision unbounded, so a value like 12345678 passed this pre-transaction assert and then
 * raised PostgreSQL 22003 numeric_field_overflow inside the transaction - a 500 from exactly the
 * validator placed pre-transaction to produce a 400.
 */
const NUMERIC_9_2_REGEX = /^\d{1,7}(\.\d{1,2})?$/;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function reject(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new AppError(400, code, message, details);
}

/**
 * Fails closed unless the actor's assignment covers the site being written to. A wildcard actor
 * (NO_LOCATION_UUID) is permitted, matching the convention in src/compliance/pick.ts.
 */
function assertActorSite(
  actorLocationId: string,
  siteId: string,
  context: Record<string, unknown>,
): void {
  if (actorLocationId === NO_LOCATION_UUID) return;
  if (actorLocationId !== siteId) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      `No assignment grants access to site "${siteId}"`,
      {
        ...context,
        actor_location_id: actorLocationId,
        site_id: siteId,
      },
    );
  }
}

function assertSupervisor(role: string, eventType: string, action: string): void {
  if (!WAREHOUSE_TASK_SUPERVISE_ROLES.includes(role)) {
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      `${action} is restricted to roles: ${WAREHOUSE_TASK_SUPERVISE_ROLES.join(', ')}`,
      { actor_role: role, event_type: eventType },
    );
  }
}

function occurredAtIso(envelope: { metadata: { occurred_at?: string } }): string {
  const raw = envelope.metadata.occurred_at;
  const parsed = raw ? new Date(raw) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

/**
 * Normalizes threshold_minutes to a NUMERIC(9,2)-shaped string, or null when the value is not a
 * strictly positive, finitely representable threshold the column can actually hold. Numbers are
 * stringified first so a JS float never reaches the database as a float; the regex then rejects
 * anything with more precision or scale than the column can hold, and anything in exponent notation.
 */
export function normalizeThresholdMinutes(value: unknown): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const s = String(value).trim();
  if (!NUMERIC_9_2_REGEX.test(s)) return null;
  if (Number(s) <= 0) return null;
  return s;
}

export function assertTaskSlaConfigUpdatedShape(envelope: TaskSlaConfigUpdatedEnvelope): void {
  const p = envelope.payload;
  if (typeof p !== 'object' || p === null) {
    reject('TASK_SLA_CONFIG_INVALID_PAYLOAD', 'payload is required and must be an object');
  }
  if (!isUuid(p.site_id)) {
    reject('TASK_SLA_CONFIG_INVALID_PAYLOAD', 'site_id is required and must be a UUID', {
      site_id: p.site_id,
    });
  }
  if (!WAREHOUSE_TASK_TYPES.includes(p.task_type)) {
    reject(
      'TASK_SLA_CONFIG_INVALID_PAYLOAD',
      `task_type is required and must be one of: ${WAREHOUSE_TASK_TYPES.join(', ')}`,
      {
        task_type: p.task_type,
      },
    );
  }
  if (p.zone_id !== undefined && p.zone_id !== null && !isUuid(p.zone_id)) {
    reject(
      'TASK_SLA_CONFIG_INVALID_PAYLOAD',
      'zone_id must be a UUID when supplied (omit it to set the site-wide default)',
    );
  }
  if (normalizeThresholdMinutes(p.threshold_minutes) === null) {
    reject(
      'TASK_SLA_CONFIG_INVALID_PAYLOAD',
      'threshold_minutes is required and must be a positive value with at most 7 integer and 2 decimal places',
      { threshold_minutes: p.threshold_minutes },
    );
  }
}

/**
 * Upserts the threshold on the (site_id, task_type, zone_id) grain. `updated_by` is taken from the
 * envelope's actor metadata, never from the payload and never from a placeholder string - the
 * payload field of the same name exists only so the recorded event is self-describing, and it is
 * overwritten here.
 *
 * A zone-scoped threshold is validated to reference a real, active, zone-level location that belongs
 * to the site being written to, so a typo cannot quietly create a threshold no task will ever
 * resolve to, and a supervisor at one site cannot set a threshold on another site's zone. The
 * earlier revision selected `status` and never compared it, and never compared the zone's site at
 * all, so a direct POST /api/v1/events performed exactly that cross-site write.
 */
export async function applyTaskSlaConfigUpdatedProjection(
  envelope: TaskSlaConfigUpdatedEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload;

  assertSupervisor(
    envelope.metadata.actor.role,
    envelope.event_type,
    'Changing a task SLA threshold',
  );
  assertActorSite(envelope.metadata.actor.location_id, p.site_id, {
    event_type: envelope.event_type,
  });

  const zoneId = p.zone_id ?? null;
  if (zoneId !== null) {
    const zone = await client.query(
      `SELECT level, status, site_id FROM location_register WHERE location_id = $1`,
      [zoneId],
    );
    if (zone.rows.length === 0) {
      throw new AppError(
        404,
        'LOCATION_NOT_FOUND',
        `No location register entry exists for "${zoneId}"`,
        { zone_id: zoneId },
      );
    }
    const row = zone.rows[0]!;
    if (row['level'] !== 'zone') {
      throw new AppError(
        400,
        'TASK_SLA_CONFIG_INVALID_PAYLOAD',
        `Location "${zoneId}" is not a zone`,
        {
          zone_id: zoneId,
          level: row['level'],
        },
      );
    }
    if (row['status'] !== 'active') {
      throw new AppError(400, 'TASK_SLA_CONFIG_INVALID_PAYLOAD', `Zone "${zoneId}" is not active`, {
        zone_id: zoneId,
        status: row['status'],
      });
    }
    if (row['site_id'] !== p.site_id) {
      throw new AppError(
        403,
        'LOCATION_ACCESS_DENIED',
        `Zone "${zoneId}" does not belong to site "${p.site_id}"`,
        {
          zone_id: zoneId,
          zone_site_id: row['site_id'],
          site_id: p.site_id,
        },
      );
    }
  }

  const threshold = normalizeThresholdMinutes(p.threshold_minutes);
  // assertTaskSlaConfigUpdatedShape already rejected anything unnormalizable; this is the
  // fail-closed guard for the (impossible) case where the two disagree, never a silent no-op.
  if (threshold === null) {
    throw new AppError(
      400,
      'TASK_SLA_CONFIG_INVALID_PAYLOAD',
      'threshold_minutes is not a valid positive threshold',
    );
  }

  // The row id is stable per grain across replays: the ON CONFLICT target is
  // (site_id, task_type, zone_id), so a fresh UUID here is only ever consumed when the grain does
  // not yet exist. event_occurred_at drives the ordering guard inside upsertSlaConfig, which is what
  // stops an out-of-order replay reinstating a superseded threshold.
  await upsertSlaConfig(
    {
      id: randomUUID(),
      site_id: p.site_id,
      task_type: p.task_type,
      zone_id: zoneId,
      threshold_minutes: threshold,
      updated_by: envelope.metadata.actor.user_id,
      source_event_id: eventId,
      event_occurred_at: occurredAtIso(envelope),
    },
    client,
  );
}

// ---------------------------------------------------------------------------
// Task assignment (Story 3.8 code review): putaway_task.assigned / pick_task.assigned
// ---------------------------------------------------------------------------

const TASK_PRIORITY_VALUES = ['low', 'normal', 'high', 'urgent'];

function assertAssignmentShape(
  payload: { assigned_to?: unknown; priority?: unknown },
  taskIdField: string,
  taskId: unknown,
  code: string,
): void {
  if (!isUuid(taskId)) {
    reject(code, `${taskIdField} is required and must be a UUID`, { [taskIdField]: taskId });
  }
  if (!isUuid(payload.assigned_to)) {
    reject(code, 'assigned_to is required and must be a UUID', {
      assigned_to: payload.assigned_to,
    });
  }
  if (
    payload.priority !== undefined &&
    payload.priority !== null &&
    !TASK_PRIORITY_VALUES.includes(payload.priority as string)
  ) {
    reject(code, `priority must be one of: ${TASK_PRIORITY_VALUES.join(', ')}`, {
      priority: payload.priority,
    });
  }
}

export function assertPutawayTaskAssignedShape(envelope: PutawayTaskAssignedEnvelope): void {
  const p = envelope.payload;
  if (typeof p !== 'object' || p === null) {
    reject('PUTAWAY_TASK_INVALID_PAYLOAD', 'payload is required and must be an object');
  }
  assertAssignmentShape(p, 'putaway_task_id', p.putaway_task_id, 'PUTAWAY_TASK_INVALID_PAYLOAD');
}

export function assertPickTaskAssignedShape(envelope: PickTaskAssignedEnvelope): void {
  const p = envelope.payload;
  if (typeof p !== 'object' || p === null) {
    reject('PICK_TASK_INVALID_PAYLOAD', 'payload is required and must be an object');
  }
  assertAssignmentShape(p, 'pick_task_id', p.pick_task_id, 'PICK_TASK_INVALID_PAYLOAD');
}

/**
 * Applies a putaway assignment. `assigned_by` is server-set from the actor, never the payload.
 *
 * The site check reads the task's own site rather than trusting anything in the payload, so an
 * assignment cannot cross sites even when posted directly to /api/v1/events. A task that is no
 * longer ready, or is already assigned to a different operator, fails closed rather than silently
 * overwriting - the assign-versus-assign race the projection guard now rejects.
 */
export async function applyPutawayTaskAssignedProjection(
  envelope: PutawayTaskAssignedEnvelope,
  client: PoolClient,
): Promise<void> {
  const p = envelope.payload;

  assertSupervisor(envelope.metadata.actor.role, envelope.event_type, 'Assigning a putaway task');

  if (!(await activeUserExistsById(p.assigned_to))) {
    throw new AppError(404, 'ASSIGNEE_NOT_FOUND', `No active user exists for "${p.assigned_to}"`, {
      assigned_to: p.assigned_to,
    });
  }

  const task = await client.query(
    `SELECT site_id, status, assigned_to FROM putaway_task WHERE putaway_task_id = $1`,
    [p.putaway_task_id],
  );
  if (task.rows.length === 0) {
    throw new AppError(
      404,
      'PUTAWAY_TASK_NOT_FOUND',
      `No putaway task exists for "${p.putaway_task_id}"`,
      {
        putaway_task_id: p.putaway_task_id,
      },
    );
  }
  const current = task.rows[0]!;
  assertActorSite(envelope.metadata.actor.location_id, current['site_id'] as string, {
    putaway_task_id: p.putaway_task_id,
  });

  const assigned = await assignPutawayTask(
    {
      putawayTaskId: p.putaway_task_id,
      assignedTo: p.assigned_to,
      assignedBy: envelope.metadata.actor.user_id,
      priority: p.priority ?? null,
      assignedAt: occurredAtIso(envelope),
    },
    client,
  );

  if (!assigned) {
    if (current['status'] !== 'ready') {
      throw new AppError(
        409,
        'PUTAWAY_TASK_NOT_READY',
        `Putaway task "${p.putaway_task_id}" is not ready for assignment`,
        {
          putaway_task_id: p.putaway_task_id,
          status: current['status'],
        },
      );
    }
    throw new AppError(
      409,
      'PUTAWAY_TASK_ALREADY_ASSIGNED',
      `Putaway task "${p.putaway_task_id}" is already assigned to another operator`,
      { putaway_task_id: p.putaway_task_id, assigned_to: current['assigned_to'] },
    );
  }
}

/**
 * Applies a pick assignment. Mirrors the putaway seam exactly; the pick task's site is resolved
 * through the Story 2.9 sales-order projection, which is where a pick task's site actually lives.
 * The LEFT JOIN is deliberate - a pick task whose sales order has not yet mirrored still exists and
 * must produce a clear error rather than a spurious "task not found".
 */
export async function applyPickTaskAssignedProjection(
  envelope: PickTaskAssignedEnvelope,
  client: PoolClient,
): Promise<void> {
  const p = envelope.payload;

  assertSupervisor(envelope.metadata.actor.role, envelope.event_type, 'Assigning a pick task');

  if (!(await activeUserExistsById(p.assigned_to))) {
    throw new AppError(404, 'ASSIGNEE_NOT_FOUND', `No active user exists for "${p.assigned_to}"`, {
      assigned_to: p.assigned_to,
    });
  }

  const task = await client.query(
    `SELECT eso.ship_from_site_id AS site_id, pt.status, pt.assigned_to
       FROM pick_task pt
       LEFT JOIN erp_sales_order eso ON eso.id = pt.dispatch_order_id
      WHERE pt.pick_task_id = $1`,
    [p.pick_task_id],
  );
  if (task.rows.length === 0) {
    throw new AppError(404, 'PICK_TASK_NOT_FOUND', `No pick task exists for "${p.pick_task_id}"`, {
      pick_task_id: p.pick_task_id,
    });
  }
  const current = task.rows[0]!;
  const siteId = current['site_id'] as string | null;
  if (siteId === null) {
    throw new AppError(
      409,
      'PICK_TASK_SITE_UNRESOLVED',
      `Pick task "${p.pick_task_id}" cannot be assigned until its dispatch order is mirrored into erp_sales_order`,
      { pick_task_id: p.pick_task_id },
    );
  }
  assertActorSite(envelope.metadata.actor.location_id, siteId, { pick_task_id: p.pick_task_id });

  const assigned = await assignPickTask(
    {
      pickTaskId: p.pick_task_id,
      assignedTo: p.assigned_to,
      assignedBy: envelope.metadata.actor.user_id,
      priority: p.priority ?? null,
      assignedAt: occurredAtIso(envelope),
    },
    client,
  );

  if (!assigned) {
    throw new AppError(
      409,
      'PICK_TASK_ALREADY_ASSIGNED',
      `Pick task "${p.pick_task_id}" is not assignable in status "${current['status']}" or is already assigned to another operator`,
      {
        pick_task_id: p.pick_task_id,
        status: current['status'],
        assigned_to: current['assigned_to'],
      },
    );
  }
}
