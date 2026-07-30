import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getAuthContext, getAuthorizedAssignment, getParsedBody, getTraceId } from '../../middleware/context.js';
import { requireRole, permittedLocationsForModuleScope } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getForwardPickConfig, listForwardPickConfigs } from '../../read/projections/forward_pick_config.js';
import { getReplenishmentTaskById, assignReplenishmentTask } from '../../read/projections/replenishment_task.js';
import { isTaskPriority, TASK_PRIORITIES } from '../../read/projections/pick_task.js';
import { activeUserExistsById } from '../../read/projections/users.js';
import { runForwardPickReplenishmentCheck } from '../../warehouse/replenishment-job.js';
import { getPool } from '../../config/db.js';

/**
 * Story 3.9: the forward-pick replenishment surface (FR-W-08).
 *
 * Config threshold changes and the trigger check are supervisor actions; confirmation is a
 * frontline action any warehouse role may perform (mirrors putaway/pick's execute-role pattern).
 * The unified task board (GET /api/v1/warehouse-tasks, Story 3.8) already surfaces replenishment
 * tasks once src/warehouse/task-metrics.ts's TASK_SOURCES entry lands - AC1's "the task appears in
 * the task board for assignment" is satisfied by that existing board, so no second list endpoint
 * is built here.
 */

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REPLENISHMENT_READ_ROLES = [
  'store_assistant',
  'warehouse_operator',
  'dispatch_clerk',
  'unloading_supervisor',
  'warehouse_manager',
  'inventory_controller',
];
export const REPLENISHMENT_SUPERVISE_ROLES = ['warehouse_manager', 'inventory_controller'];

interface ActorContext {
  userId: string;
  role: string;
  auditLocationId: string;
  eventLocationId: string;
}

function actorContext(req: IncomingMessage): ActorContext {
  const authContext = getAuthContext(req);
  const assignment = getAuthorizedAssignment(req);
  const userId = authContext?.userId ?? NO_LOCATION_UUID;
  const role = assignment?.role ?? '';
  const auditLocationId = assignment?.locationId ?? '*';
  const eventLocationId = auditLocationId === '*' ? NO_LOCATION_UUID : auditLocationId;
  return { userId, role, auditLocationId, eventLocationId };
}

/**
 * Like `actorContext` but stamps the event metadata's location_id with the target site of the
 * write, mirroring src/api/v1/putaway.ts's identical helper, so the compliance seam's site checks
 * compare against the site the work actually belongs to.
 */
function actorContextForSite(req: IncomingMessage, targetSiteId: string): ActorContext {
  const base = actorContext(req);
  const authContext = getAuthContext(req);
  const covering = authContext?.roles.find(
    (r) => (r.module === 'warehouse' || r.module === '*')
      && r.functionScope === 'write'
      && (r.locationId === '*' || r.locationId === targetSiteId),
  );
  return { ...base, eventLocationId: targetSiteId, role: covering?.role ?? base.role };
}

function auditCtxFor(req: IncomingMessage, actor: ActorContext, httpStatus: number): Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'> {
  return {
    trace_id: getTraceId(req) ?? '',
    user_id: actor.userId,
    role: actor.role,
    location_id: actor.auditLocationId,
    endpoint: req.url ?? '',
    method: req.method ?? 'POST',
    http_status: httpStatus,
  };
}

function assertRoleAllowed(req: IncomingMessage, allowedRoles: string[], functionScope: 'read' | 'write'): void {
  const authContext = getAuthContext(req);
  const roles = authContext?.roles ?? [];
  const ok = roles.some(
    (r) => (r.module === 'warehouse' || r.module === '*') && (functionScope === 'read' || r.functionScope === 'write') && allowedRoles.includes(r.role),
  );
  if (!ok) throw new AppError(403, 'FUNCTION_ACCESS_DENIED', `This operation is restricted to roles: ${allowedRoles.join(', ')}`);
}

function warehouseScope(req: IncomingMessage, scope: 'read' | 'write'): { wildcard: boolean; locations: Set<string> } {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return permittedLocationsForModuleScope(authContext.roles, 'warehouse', scope);
}

function assertSiteAccess(req: IncomingMessage, siteId: string, scope: 'read' | 'write'): void {
  const s = warehouseScope(req, scope);
  if (!s.wildcard && !s.locations.has(siteId)) {
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No ${scope} assignment grants access to site "${siteId}"`);
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`).searchParams;
}

// ---------------------------------------------------------------------------
// Task 6.2: forward-pick config read/write
// ---------------------------------------------------------------------------

const getConfigBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, REPLENISHMENT_SUPERVISE_ROLES, 'read');
  const params = queryOf(req);
  const sku = params.get('sku');
  const zoneId = params.get('zone_id');
  const siteId = params.get('site_id') ?? params.get('site');

  if (sku && zoneId) {
    if (!UUID_REGEX.test(zoneId)) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'zone_id must be a UUID');
      return;
    }
    const config = await getForwardPickConfig(sku, zoneId);
    if (config) assertSiteAccess(req, config.site_id, 'read');
    sendJson(res, 200, { forward_pick_config: config });
    return;
  }

  const scope = warehouseScope(req, 'read');
  if (siteId && !scope.wildcard && !scope.locations.has(siteId)) {
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No read assignment grants access to site "${siteId}"`);
  }
  const configs = await listForwardPickConfigs({ siteId, zoneId });
  const filtered = scope.wildcard || siteId ? configs : configs.filter((c) => scope.locations.has(c.site_id));
  sendJson(res, 200, { forward_pick_configs: filtered });
};

/**
 * Upserts a (sku, zone_id) forward-pick threshold through persistEvent - never a direct table
 * write - mirroring task_sla_config.updated (its twin projection): the change carries a domain
 * event, an audit entry, and a server-set updated_by, and replays exactly like every other
 * Story 3.5-3.8 warehouse write. site_id is resolved from the zone by the compliance seam, never
 * accepted here, so a client cannot claim a site the zone does not belong to.
 */
const putConfigBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, REPLENISHMENT_SUPERVISE_ROLES, 'write');
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};

  const sku = body['sku'];
  if (typeof sku !== 'string' || sku.length === 0) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'sku is required and must be a non-empty string');
    return;
  }
  const zoneId = body['zone_id'];
  if (typeof zoneId !== 'string' || !UUID_REGEX.test(zoneId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'zone_id is required and must be a UUID');
    return;
  }

  const zone = await getPool().query(`SELECT site_id FROM location_register WHERE location_id = $1`, [zoneId]);
  if (zone.rows.length === 0) {
    sendRequestError(req, res, 404, 'LOCATION_NOT_FOUND', `No location register entry exists for "${zoneId}"`);
    return;
  }
  const siteId = zone.rows[0]!['site_id'] as string;
  assertSiteAccess(req, siteId, 'write');

  const actor = actorContextForSite(req, siteId);
  const persisted = await persistEvent(
    {
      stream_type: 'warehouse',
      stream_id: randomUUID(),
      event_type: 'forward_pick_config.updated',
      payload: {
        sku,
        zone_id: zoneId,
        min_qty: body['min_qty'] as number | string,
        max_qty: body['max_qty'] as number | string,
        updated_by: actor.userId,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: new Date().toISOString(),
      },
      idempotency_key: typeof body['idempotency_key'] === 'string' ? body['idempotency_key'] : null,
    },
    auditCtxFor(req, actor, 200),
  );

  const updated = await getForwardPickConfig(sku, zoneId);
  sendJson(res, 200, { event_id: persisted.event_id, forward_pick_config: updated });
};

// ---------------------------------------------------------------------------
// Task 6.3: trigger check
// ---------------------------------------------------------------------------

const checkReplenishmentBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, REPLENISHMENT_SUPERVISE_ROLES, 'write');
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const siteId = typeof body['site_id'] === 'string' ? body['site_id'] : undefined;
  if (siteId) assertSiteAccess(req, siteId, 'write');

  const actor = actorContext(req);
  const result = await runForwardPickReplenishmentCheck({
    siteId: siteId ?? null,
    zoneId: typeof body['zone_id'] === 'string' ? body['zone_id'] : null,
    sku: typeof body['sku'] === 'string' ? body['sku'] : null,
    actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
    auditCtx: auditCtxFor(req, actor, 200),
  });
  sendJson(res, 200, result);
};

// ---------------------------------------------------------------------------
// Task 6.4: operator confirmation
// ---------------------------------------------------------------------------

const confirmReplenishmentBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, REPLENISHMENT_READ_ROLES, 'write');
  const replenishmentTaskId = params['replenishmentTaskId'];
  if (!replenishmentTaskId || !UUID_REGEX.test(replenishmentTaskId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'replenishmentTaskId path parameter must be a UUID');
    return;
  }
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const task = await getReplenishmentTaskById(replenishmentTaskId);
  if (!task) {
    sendRequestError(req, res, 404, 'REPLENISHMENT_TASK_NOT_FOUND', `No replenishment task exists for "${replenishmentTaskId}"`);
    return;
  }
  assertSiteAccess(req, task.site_id, 'write');

  const actor = actorContextForSite(req, task.site_id);
  const persisted = await persistEvent(
    {
      stream_type: 'warehouse',
      stream_id: replenishmentTaskId,
      event_type: 'replenishment_task.completed',
      payload: {
        replenishment_task_id: replenishmentTaskId,
        to_location_id: typeof body['to_location_id'] === 'string' ? body['to_location_id'] : undefined,
        to_location_code: typeof body['to_location_code'] === 'string' ? body['to_location_code'] : undefined,
        completed_by: actor.userId,
      },
      metadata: {
        correlation_id: task.correlation_id,
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: new Date().toISOString(),
      },
      idempotency_key: typeof body['idempotency_key'] === 'string' ? body['idempotency_key'] : null,
    },
    auditCtxFor(req, actor, 200),
  );

  const updated = await getReplenishmentTaskById(replenishmentTaskId);
  sendJson(res, 200, { event_id: persisted.event_id, task: updated });
};

// ---------------------------------------------------------------------------
// Task 6.5: supervisor assignment
// ---------------------------------------------------------------------------

const assignReplenishmentTaskBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, REPLENISHMENT_SUPERVISE_ROLES, 'write');
  const replenishmentTaskId = params['replenishmentTaskId'];
  if (!replenishmentTaskId || !UUID_REGEX.test(replenishmentTaskId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'replenishmentTaskId path parameter must be a UUID');
    return;
  }
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const assignedTo = body['assigned_to'];
  if (typeof assignedTo !== 'string' || !UUID_REGEX.test(assignedTo)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'assigned_to is required and must be a UUID');
    return;
  }
  const priority = body['priority'];
  if (priority !== undefined && priority !== null && !isTaskPriority(priority)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', `priority must be one of: ${TASK_PRIORITIES.join(', ')}`);
    return;
  }
  if (!(await activeUserExistsById(assignedTo))) {
    sendRequestError(req, res, 404, 'ASSIGNEE_NOT_FOUND', `No active user exists for "${assignedTo}"`);
    return;
  }

  const task = await getReplenishmentTaskById(replenishmentTaskId);
  if (!task) {
    sendRequestError(req, res, 404, 'REPLENISHMENT_TASK_NOT_FOUND', `No replenishment task exists for "${replenishmentTaskId}"`);
    return;
  }
  assertSiteAccess(req, task.site_id, 'write');

  const actor = actorContextForSite(req, task.site_id);
  const client = await getPool().connect();
  try {
    const assigned = await assignReplenishmentTask(
      { replenishmentTaskId, assignedTo, assignedBy: actor.userId, priority: isTaskPriority(priority) ? priority : null },
      client,
    );
    if (!assigned) {
      sendRequestError(req, res, 409, 'REPLENISHMENT_TASK_NOT_READY', `Replenishment task "${replenishmentTaskId}" is not ready or is already assigned`);
      return;
    }
  } finally {
    client.release();
  }

  const updated = await getReplenishmentTaskById(replenishmentTaskId);
  sendJson(res, 200, { task: updated });
};

export const handleGetForwardPickConfig: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'read' })(getConfigBase);
export const handlePutForwardPickConfig: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'write' })(putConfigBase);
export const handleCheckReplenishment: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'write' })(checkReplenishmentBase);
export const handleConfirmReplenishmentTask: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'write' })(confirmReplenishmentBase);
export const handleAssignReplenishmentTask: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'write' })(assignReplenishmentTaskBase);
