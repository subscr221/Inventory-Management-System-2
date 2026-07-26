import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getAuthContext, getAuthorizedAssignment, getParsedBody, getTraceId } from '../../middleware/context.js';
import { requireRole, permittedLocationsForModule, permittedLocationsForModuleScope } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getPool } from '../../config/db.js';
import { getLocationByCode } from '../../read/projections/location_register.js';
import { getSalesOrderLineById } from '../../read/projections/erp_sales_order.js';
import { getPickTaskById, getPickTaskSiteId, listPickTasks } from '../../read/projections/pick_task.js';
import { listPickLinesByTask } from '../../read/projections/pick_line.js';
import { generatePickTasks } from '../../warehouse/pick-task-generator.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Supervisors generate, assign and complete pick tasks; operators execute pick confirmations.
const PICK_SUPERVISE_ROLES = ['warehouse_manager', 'inventory_controller'];
const PICK_CONFIRM_ROLES = ['store_assistant', 'warehouse_operator'];
const PICK_READ_ROLES = ['store_assistant', 'warehouse_operator', 'warehouse_manager', 'inventory_controller'];

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

async function resolveTaskSite(pickTaskId: string): Promise<string> {
  const siteId = await getPickTaskSiteId(pickTaskId);
  if (!siteId) {
    throw new AppError(404, 'PICK_TASK_NOT_FOUND', `No pick task exists for "${pickTaskId}"`);
  }
  return siteId;
}

function parseLineIds(body: Record<string, unknown>): string[] {
  const raw = body['dispatchOrderLineIds'] ?? body['dispatch_order_line_ids'];
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((v) => typeof v === 'string' && UUID_REGEX.test(v))) {
    throw new AppError(400, 'INVALID_PARAMS', 'dispatchOrderLineIds is required and must be a non-empty array of UUIDs');
  }
  return raw as string[];
}

async function runGenerate(
  req: IncomingMessage,
  res: ServerResponse,
  strategy: 'single' | 'batch' | 'wave' | 'zone',
  body: Record<string, unknown>,
): Promise<void> {
  assertRoleAllowed(req, PICK_SUPERVISE_ROLES, 'write');
  // Deduplicate: a repeated line id must not generate two tasks for the same demand line.
  const dispatchOrderLineIds = [...new Set(parseLineIds(body))];
  const waveId = typeof body['waveId'] === 'string' ? body['waveId'] : typeof body['wave_id'] === 'string' ? (body['wave_id'] as string) : undefined;
  const batchId = typeof body['batchId'] === 'string' ? body['batchId'] : typeof body['batch_id'] === 'string' ? (body['batch_id'] as string) : undefined;
  if (waveId !== undefined && !UUID_REGEX.test(waveId)) throw new AppError(400, 'INVALID_PARAMS', 'waveId must be a UUID');
  if (batchId !== undefined && !UUID_REGEX.test(batchId)) throw new AppError(400, 'INVALID_PARAMS', 'batchId must be a UUID');

  // The generation site derives from the dispatch-order lines themselves; every line must ship
  // from a single site the caller has write access to.
  const siteIds = new Set<string>();
  for (const id of dispatchOrderLineIds) {
    const line = await getSalesOrderLineById(id);
    if (!line) {
      throw new AppError(404, 'DISPATCH_ORDER_LINE_NOT_FOUND', `No sales-order line exists for "${id}"`, { dispatch_order_line_id: id });
    }
    siteIds.add(line.ship_from_site_id);
  }
  if (siteIds.size > 1) {
    throw new AppError(400, 'INVALID_PARAMS', 'All dispatch-order lines must ship from the same site');
  }
  const siteId = [...siteIds][0]!;
  assertSiteAccess(req, siteId, 'write');

  const actor = actorContext(req);
  const pool = getPool();
  const client: PoolClient = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const result = await generatePickTasks(
      {
        dispatchOrderLineIds,
        strategy,
        waveId,
        batchId,
        siteId,
        createdBy: actor.userId,
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
      },
      client,
    );
    await client.query('COMMIT');
    committed = true;
    sendJson(res, 201, result);
  } catch (err) {
    if (!committed) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const generateBase: RouteHandler = async (req, res) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const strategy = body['strategy'];
  if (strategy !== 'single' && strategy !== 'batch' && strategy !== 'wave' && strategy !== 'zone') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', "strategy must be one of 'single', 'batch', 'wave', 'zone'");
    return;
  }
  await runGenerate(req, res, strategy, body);
};

const generateWaveBase: RouteHandler = async (req, res) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  if (typeof body['waveId'] !== 'string' && typeof body['wave_id'] !== 'string') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'waveId is required for wave release');
    return;
  }
  await runGenerate(req, res, 'wave', body);
};

const generateBatchBase: RouteHandler = async (req, res) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  await runGenerate(req, res, 'batch', body);
};

const listPickTasksBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, PICK_READ_ROLES, 'read');
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const status = url.searchParams.get('status');
  if (status !== null && !['pending', 'in_progress', 'completed', 'cancelled'].includes(status)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', "status filter must be 'pending', 'in_progress', 'completed' or 'cancelled'");
    return;
  }
  const scope = warehouseScope(req, 'read');
  const siteCode = url.searchParams.get('site');
  let siteId: string | null = null;
  let siteAny: string[] | null = null;
  if (siteCode) {
    const site = UUID_REGEX.test(siteCode) ? { location_id: siteCode } : await getLocationByCode(siteCode);
    if (!site) throw new AppError(404, 'LOCATION_NOT_FOUND', `No site exists for "${siteCode}"`);
    if (!scope.wildcard && !scope.locations.has(site.location_id)) {
      throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No read assignment grants access to site "${site.location_id}"`);
    }
    siteId = site.location_id;
  } else if (!scope.wildcard) {
    siteAny = [...scope.locations];
  }
  const tasks = await listPickTasks({
    siteId,
    siteAny,
    status: status as 'pending' | 'in_progress' | 'completed' | 'cancelled' | null,
    assignedTo: url.searchParams.get('assignedTo'),
    zoneId: url.searchParams.get('zoneId'),
    waveId: url.searchParams.get('waveId'),
    batchId: url.searchParams.get('batchId'),
  });
  sendJson(res, 200, { pick_tasks: tasks });
};

const getPickTaskBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, PICK_READ_ROLES, 'read');
  const pickTaskId = params['pickTaskId'];
  if (!pickTaskId || !UUID_REGEX.test(pickTaskId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'pickTaskId path parameter must be a UUID');
    return;
  }
  const task = await getPickTaskById(pickTaskId);
  if (!task) {
    sendRequestError(req, res, 404, 'PICK_TASK_NOT_FOUND', `No pick task exists for "${pickTaskId}"`);
    return;
  }
  assertSiteAccess(req, await resolveTaskSite(pickTaskId), 'read');
  const lines = await listPickLinesByTask(pickTaskId);
  sendJson(res, 200, { task, lines });
};

const assignPickTaskBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, PICK_SUPERVISE_ROLES, 'write');
  const pickTaskId = params['pickTaskId'];
  if (!pickTaskId || !UUID_REGEX.test(pickTaskId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'pickTaskId path parameter must be a UUID');
    return;
  }
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const assignedTo = body['assignedTo'] ?? body['assigned_to'];
  if (typeof assignedTo !== 'string' || !UUID_REGEX.test(assignedTo)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'assignedTo is required and must be a UUID');
    return;
  }
  const task = await getPickTaskById(pickTaskId);
  if (!task) {
    sendRequestError(req, res, 404, 'PICK_TASK_NOT_FOUND', `No pick task exists for "${pickTaskId}"`);
    return;
  }
  if (task.status !== 'pending') {
    sendRequestError(req, res, 409, 'PICK_TASK_NOT_PENDING', `Pick task "${pickTaskId}" cannot be assigned because it is ${task.status}`);
    return;
  }
  assertSiteAccess(req, await resolveTaskSite(pickTaskId), 'write');
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updatedRows = await client.query(
      `UPDATE pick_task SET assigned_to = $2, updated_at = now() WHERE pick_task_id = $1 AND status = 'pending' RETURNING pick_task_id`,
      [pickTaskId, assignedTo],
    );
    if ((updatedRows.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      sendRequestError(req, res, 409, 'PICK_TASK_NOT_PENDING', `Pick task "${pickTaskId}" cannot be assigned because it is no longer pending`);
      return;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const updated = await getPickTaskById(pickTaskId);
  sendJson(res, 200, { task: updated });
};

const confirmPickLineBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, PICK_CONFIRM_ROLES, 'write');
  const pickTaskId = params['pickTaskId'];
  const pickLineId = params['pickLineId'];
  if (!pickTaskId || !UUID_REGEX.test(pickTaskId) || !pickLineId || !UUID_REGEX.test(pickLineId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'pickTaskId and pickLineId path parameters must be UUIDs');
    return;
  }
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const confirmedLotId = body['confirmedLotId'] ?? body['confirmed_lot_id'];
  const confirmedQuantity = body['confirmedQuantity'] ?? body['confirmed_quantity'];
  const overrideReason = body['overrideReason'] ?? body['override_reason'];
  const captureMethod = body['captureMethod'] ?? body['capture_method'];
  if (typeof confirmedLotId !== 'string' || !UUID_REGEX.test(confirmedLotId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'confirmedLotId is required and must be a UUID');
    return;
  }
  if (captureMethod !== 'PWA' && captureMethod !== 'PAPER') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', "captureMethod must be 'PWA' or 'PAPER'");
    return;
  }
  const task = await getPickTaskById(pickTaskId);
  if (!task) {
    sendRequestError(req, res, 404, 'PICK_TASK_NOT_FOUND', `No pick task exists for "${pickTaskId}"`);
    return;
  }
  assertSiteAccess(req, await resolveTaskSite(pickTaskId), 'write');

  const actor = actorContext(req);
  const persisted = await persistEvent(
    {
      stream_type: 'warehouse',
      stream_id: pickTaskId,
      event_type: 'pick_line.confirmed',
      payload: {
        pick_task_id: pickTaskId,
        pick_line_id: pickLineId,
        confirmed_lot_id: confirmedLotId,
        confirmed_quantity: typeof confirmedQuantity === 'number' ? String(confirmedQuantity) : confirmedQuantity,
        override_reason: typeof overrideReason === 'string' ? overrideReason : null,
        capture_method: captureMethod,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: new Date().toISOString(),
      },
      idempotency_key: typeof body['idempotency_key'] === 'string' && body['idempotency_key'] !== '' ? body['idempotency_key'] : null,
    },
    auditCtxFor(req, actor, 200),
  );
  const lines = await listPickLinesByTask(pickTaskId);
  const line = lines.find((l) => l.pick_line_id === pickLineId) ?? null;
  // A recorded substitution is a Warning-badge business outcome, not an error - surface it in a
  // 2xx body (mirrors the Story 3.4 RECEIPT_TOLERANCE_EXCEEDED pattern).
  if (line && line.status === 'substituted') {
    sendJson(res, 200, { event_id: persisted.event_id, line, warning_code: 'PICK_LOT_SUBSTITUTED' });
    return;
  }
  sendJson(res, 200, { event_id: persisted.event_id, line });
};

const completePickTaskBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, PICK_SUPERVISE_ROLES, 'write');
  const pickTaskId = params['pickTaskId'];
  if (!pickTaskId || !UUID_REGEX.test(pickTaskId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'pickTaskId path parameter must be a UUID');
    return;
  }
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const task = await getPickTaskById(pickTaskId);
  if (!task) {
    sendRequestError(req, res, 404, 'PICK_TASK_NOT_FOUND', `No pick task exists for "${pickTaskId}"`);
    return;
  }
  if (task.status === 'completed' || task.status === 'cancelled') {
    sendRequestError(req, res, 409, 'PICK_TASK_ALREADY_COMPLETED', `Pick task "${pickTaskId}" is ${task.status} and cannot be completed`);
    return;
  }
  assertSiteAccess(req, await resolveTaskSite(pickTaskId), 'write');

  const actor = actorContext(req);
  const persisted = await persistEvent(
    {
      stream_type: 'warehouse',
      stream_id: pickTaskId,
      event_type: 'pick_task.completed',
      payload: {
        pick_task_id: pickTaskId,
        dispatch_order_id: task.dispatch_order_id,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: new Date().toISOString(),
      },
      idempotency_key: typeof body['idempotency_key'] === 'string' && body['idempotency_key'] !== '' ? body['idempotency_key'] : null,
    },
    auditCtxFor(req, actor, 200),
  );
  const updated = await getPickTaskById(pickTaskId);
  sendJson(res, 200, { event_id: persisted.event_id, task: updated });
};

const printPickTaskBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, PICK_READ_ROLES, 'read');
  const pickTaskId = params['pickTaskId'];
  if (!pickTaskId || !UUID_REGEX.test(pickTaskId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'pickTaskId path parameter must be a UUID');
    return;
  }
  const task = await getPickTaskById(pickTaskId);
  if (!task) {
    sendRequestError(req, res, 404, 'PICK_TASK_NOT_FOUND', `No pick task exists for "${pickTaskId}"`);
    return;
  }
  assertSiteAccess(req, await resolveTaskSite(pickTaskId), 'read');
  const lines = await listPickLinesByTask(pickTaskId);

  // AC5: plain-text paper pick list (deliberately NOT a PDF - documented scope choice). Keyed-in
  // confirmations against these task/line IDs are recorded with capture_method 'PAPER'.
  const header = [
    'PICK LIST',
    '=========',
    `Pick task : ${task.pick_task_id}`,
    `Order     : ${task.dispatch_order_id}`,
    `SKU       : ${task.sku}`,
    `Strategy  : ${task.strategy}`,
    `Zone      : ${task.zone_id}`,
    task.wave_id ? `Wave      : ${task.wave_id}` : null,
    task.batch_id ? `Batch     : ${task.batch_id}` : null,
    '',
    'SEQ | PICK LINE ID                         | ORDER LINE                           | LOT (directed)                       | QTY      | BIN',
    '----+--------------------------------------+--------------------------------------+--------------------------------------+----------+-----',
  ].filter((l): l is string => l !== null);
  const rows = lines.map(
    (l) => `${String(l.pick_sequence).padStart(3)} | ${l.pick_line_id} | ${l.dispatch_order_line_id} | ${l.directed_lot_id} | ${l.directed_quantity.padStart(8)} | ${l.location_id}`,
  );
  const text = [...header, ...rows, ''].join('\n');
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
};

export const generatePickTasksHandler: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'write' })(generateBase);
export const generateWavePickTasksHandler: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'write' })(generateWaveBase);
export const generateBatchPickTasksHandler: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'write' })(generateBatchBase);
export const listPickTasksHandler: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'read' })(listPickTasksBase);
export const getPickTaskHandler: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'read' })(getPickTaskBase);
export const assignPickTaskHandler: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'write' })(assignPickTaskBase);
export const confirmPickLineHandler: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'write' })(confirmPickLineBase);
export const completePickTaskHandler: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'write' })(completePickTaskBase);
export const printPickTaskHandler: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'read' })(printPickTaskBase);
