import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getAuthContext, getAuthorizedAssignment, getParsedBody, getTraceId } from '../../middleware/context.js';
import { requireRole, permittedLocationsForModuleScope } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getCrossDockTaskById, getCrossDockTaskDetailById } from '../../read/projections/cross_dock_task.js';
import { isTaskPriority, TASK_PRIORITIES } from '../../read/projections/pick_task.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_ROLES = ['store_assistant', 'warehouse_operator', 'warehouse_manager', 'inventory_controller'];
const ASSIGN_ROLES = ['warehouse_manager', 'inventory_controller'];
const EXECUTE_ROLES = ['store_assistant', 'warehouse_operator'];

interface ActorContext {
  userId: string;
  role: string;
  auditLocationId: string;
  eventLocationId: string;
}

function assertRoleAllowed(req: IncomingMessage, allowedRoles: string[], functionScope: 'read' | 'write'): void {
  const roles = getAuthContext(req)?.roles ?? [];
  if (!roles.some((role) => (role.module === 'warehouse' || role.module === '*')
    && (functionScope === 'read' || role.functionScope === 'write')
    && allowedRoles.includes(role.role))) {
    throw new AppError(403, 'FUNCTION_ACCESS_DENIED', `This operation is restricted to roles: ${allowedRoles.join(', ')}`);
  }
}

function assertSiteAccess(req: IncomingMessage, siteId: string, scope: 'read' | 'write'): void {
  const auth = getAuthContext(req);
  if (!auth) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const permitted = permittedLocationsForModuleScope(auth.roles, 'warehouse', scope);
  if (!permitted.wildcard && !permitted.locations.has(siteId)) {
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No ${scope} assignment grants access to site "${siteId}"`);
  }
}

function actorContextForSite(req: IncomingMessage, siteId: string, allowedRoles: readonly string[]): ActorContext {
  const auth = getAuthContext(req);
  const assignment = getAuthorizedAssignment(req);
  const covering = auth?.roles.find((role) => (role.module === 'warehouse' || role.module === '*')
    && role.functionScope === 'write'
    && allowedRoles.includes(role.role)
    && (role.locationId === '*' || role.locationId === siteId));
  if (!covering) throw new AppError(403, 'FUNCTION_ACCESS_DENIED', `This operation is restricted to roles: ${allowedRoles.join(', ')}`);
  return {
    userId: auth?.userId ?? NO_LOCATION_UUID,
    role: covering?.role ?? assignment?.role ?? '',
    auditLocationId: covering?.locationId ?? assignment?.locationId ?? '*',
    eventLocationId: siteId,
  };
}

function auditCtxFor(req: IncomingMessage, actor: ActorContext): Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'> {
  return {
    trace_id: getTraceId(req) ?? '',
    user_id: actor.userId,
    role: actor.role,
    location_id: actor.auditLocationId,
    endpoint: req.url ?? '',
    method: req.method ?? 'POST',
    http_status: 200,
  };
}

function taskId(params: Record<string, string>): string | null {
  const value = params['crossDockTaskId'];
  return value && UUID_REGEX.test(value) ? value : null;
}

async function requiredTask(id: string) {
  const task = await getCrossDockTaskById(id);
  if (!task) throw new AppError(404, 'CROSS_DOCK_TASK_NOT_FOUND', `No cross-dock task exists for "${id}"`);
  return task;
}

const getCrossDockTaskBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, READ_ROLES, 'read');
  const id = taskId(params);
  if (!id) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'crossDockTaskId path parameter must be a UUID');
    return;
  }
  const detail = await getCrossDockTaskDetailById(id);
  if (!detail) {
    sendRequestError(req, res, 404, 'CROSS_DOCK_TASK_NOT_FOUND', `No cross-dock task exists for "${id}"`);
    return;
  }
  assertSiteAccess(req, detail.site_id, 'read');
  sendJson(res, 200, { task: detail });
};

const assignCrossDockTaskBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, ASSIGN_ROLES, 'write');
  const id = taskId(params);
  if (!id) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'crossDockTaskId path parameter must be a UUID');
    return;
  }
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const assignedTo = body['assigned_to'];
  const priority = body['priority'];
  if (typeof assignedTo !== 'string' || !UUID_REGEX.test(assignedTo)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'assigned_to is required and must be a UUID');
    return;
  }
  if (priority !== undefined && priority !== null && !isTaskPriority(priority)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', `priority must be one of: ${TASK_PRIORITIES.join(', ')}`);
    return;
  }
  const idempotencyKey = body['idempotency_key'];
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'idempotency_key must be a non-empty string when supplied');
    return;
  }
  const task = await requiredTask(id);
  assertSiteAccess(req, task.site_id, 'write');
  const actor = actorContextForSite(req, task.site_id, ASSIGN_ROLES);
  const persisted = await persistEvent({
    stream_type: 'warehouse',
    stream_id: id,
    event_type: 'cross_dock_task.assigned',
    payload: {
      cross_dock_task_id: id,
      assigned_to: assignedTo,
      priority: isTaskPriority(priority) ? priority : null,
      assigned_by: actor.userId,
    },
    metadata: {
      correlation_id: task.correlation_id,
      actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
      occurred_at: new Date().toISOString(),
    },
    idempotency_key: typeof idempotencyKey === 'string' ? idempotencyKey.trim() : null,
  }, auditCtxFor(req, actor));
  sendJson(res, 200, { event_id: persisted.event_id, task: await getCrossDockTaskDetailById(id) });
};

const confirmCrossDockTaskBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, EXECUTE_ROLES, 'write');
  const id = taskId(params);
  if (!id) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'crossDockTaskId path parameter must be a UUID');
    return;
  }
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const hasId = body['to_location_id'] !== undefined;
  const hasCode = body['to_location_code'] !== undefined;
  if (hasId === hasCode
    || (hasId && (typeof body['to_location_id'] !== 'string' || !UUID_REGEX.test(body['to_location_id'])))
    || (hasCode && (typeof body['to_location_code'] !== 'string' || body['to_location_code'].trim().length === 0))) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'exactly one valid to_location_id or to_location_code is required');
    return;
  }
  const suppliedEventId = body['event_id'];
  if (suppliedEventId !== undefined && (typeof suppliedEventId !== 'string' || !UUID_REGEX.test(suppliedEventId))) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'event_id must be a UUID when supplied');
    return;
  }
  const idempotencyKey = body['idempotency_key'];
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'idempotency_key must be a non-empty string when supplied');
    return;
  }
  const deviceId = body['device_id'];
  if (deviceId !== undefined && (typeof deviceId !== 'string' || deviceId.trim().length === 0)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'device_id must be a non-empty string when supplied');
    return;
  }
  const task = await requiredTask(id);
  assertSiteAccess(req, task.site_id, 'write');
  const actor = actorContextForSite(req, task.site_id, EXECUTE_ROLES);
  const persisted = await persistEvent({
    ...(typeof suppliedEventId === 'string' ? { event_id: suppliedEventId } : {}),
    stream_type: 'warehouse',
    stream_id: id,
    event_type: 'cross_dock_task.completed',
    payload: {
      cross_dock_task_id: id,
      ...(hasId ? { to_location_id: body['to_location_id'] as string } : { to_location_code: (body['to_location_code'] as string).trim() }),
      pick_task_id: randomUUID(),
      pick_line_id: randomUUID(),
      completed_by: actor.userId,
    },
    metadata: {
      correlation_id: task.correlation_id,
      actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
      device_id: typeof deviceId === 'string' ? deviceId.trim() : null,
      occurred_at: new Date().toISOString(),
    },
    idempotency_key: typeof idempotencyKey === 'string' ? idempotencyKey.trim() : null,
  }, auditCtxFor(req, actor));
  sendJson(res, 200, { event_id: persisted.event_id, task: await getCrossDockTaskDetailById(id) });
};

export const handleGetCrossDockTask: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'read' })(getCrossDockTaskBase);
export const handleAssignCrossDockTask: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'write' })(assignCrossDockTaskBase);
export const handleConfirmCrossDockTask: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'write' })(confirmCrossDockTaskBase);
