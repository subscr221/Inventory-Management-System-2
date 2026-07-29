import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getAuthContext, getAuthorizedAssignment, getParsedBody, getTraceId } from '../../middleware/context.js';
import { requireRole, permittedLocationsForModule, permittedLocationsForModuleScope } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { listPutawayTasks, getPutawayTaskById, setDirectedSuggestion } from '../../read/projections/putaway_task.js';
import { isTaskPriority, TASK_PRIORITIES } from '../../read/projections/pick_task.js';
import { listVelocityClasses } from '../../read/projections/velocity_class.js';
import { computeDirectedSuggestion } from '../../warehouse/putaway-suggestion.js';
import { runReslottingJob } from '../../warehouse/reslotting-job.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUTAWAY_READ_ROLES = ['store_assistant', 'unloading_supervisor', 'warehouse_manager', 'inventory_controller'];
const PUTAWAY_EXECUTE_ROLES = ['store_assistant'];
const RESLOTTING_ROLES = ['warehouse_manager', 'inventory_controller'];
/**
 * Story 3.8 (Task 2.6/7.2): assignment and prioritisation are supervisor actions, mirroring pick's
 * PICK_SUPERVISE_ROLES. Kept as its own named constant rather than reusing RESLOTTING_ROLES so that
 * changing who may re-slot never silently changes who may assign work.
 */
const PUTAWAY_SUPERVISE_ROLES = ['warehouse_manager', 'inventory_controller'];

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
  return scope === 'read'
    ? permittedLocationsForModule(authContext.roles, 'warehouse')
    : permittedLocationsForModuleScope(authContext.roles, 'warehouse', 'write');
}

function assertSiteAccess(req: IncomingMessage, siteId: string, scope: 'read' | 'write'): void {
  const s = warehouseScope(req, scope);
  if (!s.wildcard && !s.locations.has(siteId)) {
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No ${scope} assignment grants access to site "${siteId}"`);
  }
}

const listPutawayTasksBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, PUTAWAY_READ_ROLES, 'read');
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const status = url.searchParams.get('status');
  if (status !== null && status !== 'ready' && status !== 'held' && status !== 'completed') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', "status filter must be 'ready', 'held' or 'completed'");
    return;
  }
  const scope = warehouseScope(req, 'read');
  const siteId = url.searchParams.get('site');
  if (siteId && !scope.wildcard && !scope.locations.has(siteId)) {
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No read assignment grants access to site "${siteId}"`);
  }
  const tasks = await listPutawayTasks({
    siteId,
    siteAny: !siteId && !scope.wildcard ? [...scope.locations] : null,
    status: status as 'ready' | 'held' | 'completed' | null,
  });
  sendJson(res, 200, { tasks });
};

const getPutawayTaskBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, PUTAWAY_READ_ROLES, 'read');
  const putawayTaskId = params['putawayTaskId'];
  if (!putawayTaskId || !UUID_REGEX.test(putawayTaskId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'putawayTaskId path parameter must be a UUID');
    return;
  }
  const task = await getPutawayTaskById(putawayTaskId);
  if (!task) {
    sendRequestError(req, res, 404, 'PUTAWAY_TASK_NOT_FOUND', `No putaway task exists for "${putawayTaskId}"`);
    return;
  }
  assertSiteAccess(req, task.site_id, 'read');
  sendJson(res, 200, { task });
};

const getPutawaySuggestionBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, PUTAWAY_EXECUTE_ROLES, 'read');
  const putawayTaskId = params['putawayTaskId'];
  if (!putawayTaskId || !UUID_REGEX.test(putawayTaskId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'putawayTaskId path parameter must be a UUID');
    return;
  }
  const task = await getPutawayTaskById(putawayTaskId);
  if (!task) {
    sendRequestError(req, res, 404, 'PUTAWAY_TASK_NOT_FOUND', `No putaway task exists for "${putawayTaskId}"`);
    return;
  }
  assertSiteAccess(req, task.site_id, 'read');

  const suggestion = await computeDirectedSuggestion(putawayTaskId);
  if (suggestion.locationId) {
    const pool = (await import('../../config/db.js')).getPool();
    const client = await pool.connect();
    try {
      await setDirectedSuggestion(putawayTaskId, suggestion.locationId, suggestion.locationCode, suggestion.velocityClass, client);
    } finally {
      client.release();
    }
  }
  sendJson(res, 200, { suggestion });
};

const completePutawayBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, PUTAWAY_EXECUTE_ROLES, 'write');
  const putawayTaskId = params['putawayTaskId'];
  if (!putawayTaskId || !UUID_REGEX.test(putawayTaskId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'putawayTaskId path parameter must be a UUID');
    return;
  }
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const task = await getPutawayTaskById(putawayTaskId);
  if (!task) {
    sendRequestError(req, res, 404, 'PUTAWAY_TASK_NOT_FOUND', `No putaway task exists for "${putawayTaskId}"`);
    return;
  }
  assertSiteAccess(req, task.site_id, 'write');

  const actor = actorContext(req);
  const persisted = await persistEvent(
    {
      stream_type: 'putaway',
      stream_id: putawayTaskId,
      event_type: 'putaway.completed',
      payload: {
        putaway_task_id: putawayTaskId,
        actual_location_id: typeof body['actual_location_id'] === 'string' ? body['actual_location_id'] : undefined,
        actual_location_code: typeof body['actual_location_code'] === 'string' ? body['actual_location_code'] : undefined,
        correlation_id: task.grn_line_id,
        override_reason_code: typeof body['override_reason_code'] === 'string' ? body['override_reason_code'] : undefined,
        override_confidence: typeof body['override_confidence'] === 'string' ? body['override_confidence'] : undefined,
        completed_by: actor.userId,
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
  const updated = await getPutawayTaskById(putawayTaskId);
  sendJson(res, 200, { event_id: persisted.event_id, task: updated });
};

const listVelocityClassificationBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, PUTAWAY_READ_ROLES, 'read');
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const siteId = url.searchParams.get('site');
  const velocityClass = url.searchParams.get('class');
  if (velocityClass !== null && !['A', 'B', 'C'].includes(velocityClass)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', "class filter must be 'A', 'B' or 'C'");
    return;
  }
  const scope = warehouseScope(req, 'read');
  if (siteId && !scope.wildcard && !scope.locations.has(siteId)) {
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No read assignment grants access to site "${siteId}"`);
  }
  const classes = await listVelocityClasses({ siteId, velocityClass: velocityClass as 'A' | 'B' | 'C' | null });
  const filtered = scope.wildcard ? classes : classes.filter((c) => scope.locations.has(c.site_id));
  sendJson(res, 200, { velocity_classifications: filtered });
};

/**
 * Story 3.8 (AC1, Task 2.6): a supervisor assigns a ready putaway task to an operator, optionally
 * setting its board priority in the same call. The assigning identity is taken from the
 * authenticated context and never from the request body (Task 7.5). The underlying UPDATE is
 * status-predicated, so a task that a concurrent request released, held, or completed is reported
 * as a 409 rather than silently reassigned.
 *
 * Code review moved the write onto persistEvent. It previously took a raw pooled client and wrote
 * the projection directly, which made it the only warehouse state mutation with no domain event and
 * no audit entry: a projection rebuild discarded every assignment, an assignment dispute had no
 * evidence, and the SOD gate existed only in this handler, so a direct POST /api/v1/events reached
 * the same write unchecked. The role check stays here for a fast, well-shaped 403 and runs again in
 * the compliance seam, which is the placement that actually holds.
 */
const assignPutawayTaskBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, PUTAWAY_SUPERVISE_ROLES, 'write');
  const putawayTaskId = params['putawayTaskId'];
  if (!putawayTaskId || !UUID_REGEX.test(putawayTaskId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'putawayTaskId path parameter must be a UUID');
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

  const task = await getPutawayTaskById(putawayTaskId);
  if (!task) {
    sendRequestError(req, res, 404, 'PUTAWAY_TASK_NOT_FOUND', `No putaway task exists for "${putawayTaskId}"`);
    return;
  }
  assertSiteAccess(req, task.site_id, 'write');

  const actor = actorContext(req);
  const persisted = await persistEvent(
    {
      stream_type: 'warehouse',
      stream_id: putawayTaskId,
      event_type: 'putaway_task.assigned',
      payload: {
        putaway_task_id: putawayTaskId,
        assigned_to: assignedTo,
        priority: isTaskPriority(priority) ? priority : null,
        assigned_by: actor.userId,
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

  const updated = await getPutawayTaskById(putawayTaskId);
  sendJson(res, 200, { event_id: persisted.event_id, task: updated });
};

const reslottingJobBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, RESLOTTING_ROLES, 'write');
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const siteId = typeof body['site_id'] === 'string' ? body['site_id'] : undefined;
  if (siteId) assertSiteAccess(req, siteId, 'write');
  const results = await runReslottingJob(siteId);
  sendJson(res, 200, { results });
};

export const handleListPutawayTasks: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'read' })(listPutawayTasksBase);
export const handleGetPutawayTask: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'read' })(getPutawayTaskBase);
export const handleGetPutawaySuggestion: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'read' })(getPutawaySuggestionBase);
export const handleCompletePutaway: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'write' })(completePutawayBase);
export const handleAssignPutawayTask: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'write' })(assignPutawayTaskBase);
export const handleListVelocityClassification: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'read' })(listVelocityClassificationBase);
export const handleReslottingJob: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'write' })(reslottingJobBase);
