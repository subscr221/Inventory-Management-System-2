import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getAuthContext, getAuthorizedAssignment, getParsedBody, getTraceId } from '../../middleware/context.js';
import { requireRole, permittedLocationsForModule, permittedLocationsForModuleScope } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getPool } from '../../config/db.js';
import { getLocationByCode } from '../../read/projections/location_register.js';
import { getGrnById, listGrns } from '../../read/projections/grn.js';
import { getGrnLineById, listGrnLinesByGrn, listDiscrepancyLines } from '../../read/projections/grn_line.js';
import { getPutawayTaskById, getPutawayTaskByGrnLine } from '../../read/projections/putaway_task.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRN_CREATE_ROLES = ['store_assistant'];
const PUTAWAY_RELEASE_ROLES = ['unloading_supervisor', 'warehouse_manager'];
const RECEIVING_READ_ROLES = ['store_assistant', 'unloading_supervisor', 'warehouse_manager', 'inventory_controller'];

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
    (r) => (r.module === 'receiving' || r.module === '*' || r.module === 'inventory') && (functionScope === 'read' || r.functionScope === 'write') && allowedRoles.includes(r.role),
  );
  if (!ok) throw new AppError(403, 'FUNCTION_ACCESS_DENIED', `This operation is restricted to roles: ${allowedRoles.join(', ')}`);
}

function receivingScope(req: IncomingMessage, scope: 'read' | 'write'): { wildcard: boolean; locations: Set<string> } {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return scope === 'read'
    ? (() => {
        const rec = permittedLocationsForModule(authContext.roles, 'receiving');
        const inv = permittedLocationsForModule(authContext.roles, 'inventory');
        return { wildcard: rec.wildcard || inv.wildcard, locations: new Set([...rec.locations, ...inv.locations]) };
      })()
    : (() => {
        const rec = permittedLocationsForModuleScope(authContext.roles, 'receiving', 'write');
        const inv = permittedLocationsForModuleScope(authContext.roles, 'inventory', 'write');
        return { wildcard: rec.wildcard || inv.wildcard, locations: new Set([...rec.locations, ...inv.locations]) };
      })();
}

function assertSiteAccess(req: IncomingMessage, siteId: string, scope: 'read' | 'write'): void {
  const s = receivingScope(req, scope);
  if (!s.wildcard && !s.locations.has(siteId)) {
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No ${scope} assignment grants access to site "${siteId}"`);
  }
}

/** Resolves the site the binding token was captured at (denormalized on the weighbridge row). */
async function resolveSiteByToken(correlationId: string): Promise<string | null> {
  const result = await getPool().query(
    `SELECT site_id FROM weighbridge_event WHERE correlation_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [correlationId],
  );
  return result.rows.length > 0 ? (result.rows[0]!['site_id'] as string) : null;
}

const createGrnLineBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, GRN_CREATE_ROLES, 'write');
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }
  const correlationId = typeof body['correlation_id'] === 'string' ? body['correlation_id'].trim() : '';
  if (!correlationId || !UUID_REGEX.test(correlationId)) {
    sendRequestError(req, res, 400, 'RECEIVING_BINDING_TOKEN_REQUIRED', 'correlation_id (binding token) is required and must be a UUID');
    return;
  }
  // Enforce site scope up front when the token resolves to a site; an unknown token falls through to
  // the seam's stable RECEIVING_BINDING_TOKEN_NOT_FOUND rejection.
  const siteId = await resolveSiteByToken(correlationId);
  if (siteId) assertSiteAccess(req, siteId, 'write');

  const actor = actorContext(req);
  const grnId = typeof body['grn_id'] === 'string' && UUID_REGEX.test(body['grn_id']) ? body['grn_id'] : randomUUID();
  const grnLineId = typeof body['grn_line_id'] === 'string' && UUID_REGEX.test(body['grn_line_id']) ? body['grn_line_id'] : randomUUID();

  const pool = getPool();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await persistEvent(
      {
        stream_type: 'receiving',
        stream_id: grnId,
        event_type: 'goods.received',
        payload: {
          ...body,
          grn_id: grnId,
          grn_line_id: grnLineId,
          correlation_id: correlationId,
          received_by: actor.userId,
        },
        metadata: {
          correlation_id: correlationId,
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: new Date().toISOString(),
        },
      },
      auditCtxFor(req, actor, 201),
      client,
    );
    const line = await getGrnLineById(grnLineId, client);
    const grn = line ? await getGrnById(line.grn_id, client) : null;
    const putaway = await getPutawayTaskByGrnLine(grnLineId, client);
    await client.query('COMMIT');
    committed = true;
    // AC5: an over-tolerance line is a committed business outcome, not a rollback - surface the code
    // in a 2xx body alongside the durable rejected line.
    if (line && line.status === 'rejected') {
      sendJson(res, 200, { grn, grn_line: line, error_code: 'RECEIPT_TOLERANCE_EXCEEDED' });
      return;
    }
    sendJson(res, 201, { grn, grn_line: line, putaway_task: putaway });
  } catch (err) {
    if (!committed) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const getGrnBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, RECEIVING_READ_ROLES, 'read');
  const grnId = params['grnId'];
  if (!grnId || !UUID_REGEX.test(grnId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'grnId path parameter must be a UUID');
    return;
  }
  const grn = await getGrnById(grnId);
  if (!grn) {
    sendRequestError(req, res, 404, 'GRN_NOT_FOUND', `No GRN exists for "${grnId}"`);
    return;
  }
  assertSiteAccess(req, grn.site_id, 'read');
  const lines = await listGrnLinesByGrn(grnId);
  sendJson(res, 200, { ...grn, lines });
};

const listGrnsBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, RECEIVING_READ_ROLES, 'read');
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const status = url.searchParams.get('status');
  const siteCode = url.searchParams.get('site');
  const poRef = url.searchParams.get('po');
  if (status !== null && status !== 'open' && status !== 'posted') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', "status filter must be 'open' or 'posted'");
    return;
  }
  const scope = receivingScope(req, 'read');
  let siteId: string | null = null;
  let siteAny: string[] | null = null;
  if (siteCode) {
    const site = await getLocationByCode(siteCode);
    if (!site || site.status !== 'active' || site.level !== 'site') throw new AppError(404, 'RECEIVING_SITE_NOT_FOUND', `No active site exists for "${siteCode}"`);
    if (!scope.wildcard && !scope.locations.has(site.location_id)) throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No read assignment grants access to site "${site.location_id}"`);
    siteId = site.location_id;
  } else if (!scope.wildcard) {
    siteAny = [...scope.locations];
  }
  const rows = await listGrns({ siteId, siteAny, poRefExt: poRef, status: status as 'open' | 'posted' | null });
  sendJson(res, 200, { grns: rows });
};

const listDiscrepanciesBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, RECEIVING_READ_ROLES, 'read');
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const siteCode = url.searchParams.get('site');
  const scope = receivingScope(req, 'read');
  let siteId: string | null = null;
  let siteAny: string[] | null = null;
  if (siteCode) {
    const site = await getLocationByCode(siteCode);
    if (!site || site.status !== 'active' || site.level !== 'site') throw new AppError(404, 'RECEIVING_SITE_NOT_FOUND', `No active site exists for "${siteCode}"`);
    if (!scope.wildcard && !scope.locations.has(site.location_id)) throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No read assignment grants access to site "${site.location_id}"`);
    siteId = site.location_id;
  } else if (!scope.wildcard) {
    siteAny = [...scope.locations];
  }
  const rows = await listDiscrepancyLines({ siteId, siteAny });
  sendJson(res, 200, { discrepancies: rows });
};

const releasePutawayTaskBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, PUTAWAY_RELEASE_ROLES, 'write');
  const putawayTaskId = params['putawayTaskId'];
  if (!putawayTaskId || !UUID_REGEX.test(putawayTaskId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'putawayTaskId path parameter must be a UUID');
    return;
  }
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const reasonCode = typeof body?.['reason_code'] === 'string' ? body['reason_code'].trim() : '';
  if (!reasonCode) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'reason_code is required');
    return;
  }
  const task = await getPutawayTaskById(putawayTaskId);
  if (!task) {
    sendRequestError(req, res, 404, 'PUTAWAY_TASK_NOT_FOUND', `No putaway task exists for "${putawayTaskId}"`);
    return;
  }
  assertSiteAccess(req, task.site_id, 'write');

  const actor = actorContext(req);
  const pool = getPool();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await persistEvent(
      {
        stream_type: 'receiving',
        stream_id: putawayTaskId,
        event_type: 'goods.putaway_released',
        payload: {
          putaway_task_id: putawayTaskId,
          grn_line_id: task.grn_line_id,
          reason_code: reasonCode,
          released_by: actor.userId,
          approver_actor_id: actor.userId,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: new Date().toISOString(),
        },
      },
      auditCtxFor(req, actor, 200),
      client,
    );
    const updated = await getPutawayTaskById(putawayTaskId, client);
    await client.query('COMMIT');
    committed = true;
    sendJson(res, 200, updated!);
  } catch (err) {
    if (!committed) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const createGrnLineHandler: RouteHandler = requireRole({ module: 'receiving', functionScope: 'write' })(createGrnLineBase);
export const getGrnHandler: RouteHandler = requireRole({ module: 'receiving', functionScope: 'read' })(getGrnBase);
export const listGrnsHandler: RouteHandler = requireRole({ module: 'receiving', functionScope: 'read' })(listGrnsBase);
export const listDiscrepanciesHandler: RouteHandler = requireRole({ module: 'receiving', functionScope: 'read' })(listDiscrepanciesBase);
export const releasePutawayTaskHandler: RouteHandler = requireRole({ module: 'receiving', functionScope: 'write' })(releasePutawayTaskBase);
