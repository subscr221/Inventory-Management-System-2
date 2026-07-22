import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getAuthContext, getAuthorizedAssignment, getParsedBody, getTraceId } from '../../middleware/context.js';
import { requireRole, permittedLocationsForModule, permittedLocationsForModuleScope } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getPool } from '../../config/db.js';
import { getPurchaseOrderByRef } from '../../read/projections/erp_purchase_order.js';
import { getLocationByCode } from '../../read/projections/location_register.js';
import { getWeighbridgeEventById, listWeighbridgeEvents } from '../../read/projections/weighbridge_event.js';
import type { WeighbridgeEvent } from '../../read/projections/weighbridge_event.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEIGHBRIDGE_WRITE_ROLES = ['weighbridge_operator'];
const WEIGHBRIDGE_READ_ROLES = ['weighbridge_operator', 'unloading_supervisor', 'warehouse_manager', 'receiving_supervisor'];

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
    (r) => (r.module === 'inventory' || r.module === '*' || r.module === 'gate' || r.module === 'weighbridge') && r.functionScope === functionScope && allowedRoles.includes(r.role),
  );
  if (!ok) throw new AppError(403, 'FUNCTION_ACCESS_DENIED', `This operation is restricted to roles: ${allowedRoles.join(', ')}`);
}

function assertSiteAccess(req: IncomingMessage, siteId: string, scope: 'read' | 'write'): void {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const inventoryScope = permittedLocationsForModuleScope(authContext.roles, 'inventory', scope);
  const gateScope = permittedLocationsForModuleScope(authContext.roles, 'gate', scope);
  const weighbridgeScope = permittedLocationsForModuleScope(authContext.roles, 'weighbridge', scope);
  if (
    !inventoryScope.wildcard && !gateScope.wildcard && !weighbridgeScope.wildcard &&
    !inventoryScope.locations.has(siteId) && !gateScope.locations.has(siteId) && !weighbridgeScope.locations.has(siteId)
  ) {
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No ${scope} assignment grants access to site "${siteId}"`);
  }
}

async function poLineSummary(row: WeighbridgeEvent): Promise<Record<string, unknown> | null> {
  const po = await getPurchaseOrderByRef(row.po_ref_ext);
  if (!po) return null;
  const line = po.lines.find((l) => l.line_no === row.line_no) ?? null;
  return {
    po_number_ext: po.po_number_ext,
    supplier_ref_ext: po.supplier_ref_ext,
    status: po.status,
    line: line
      ? {
          line_no: line.line_no,
          sku: line.sku,
          ordered_qty: line.ordered_qty,
          over_receipt_tolerance_pct: line.over_receipt_tolerance_pct,
          under_receipt_tolerance_pct: line.under_receipt_tolerance_pct,
        }
      : null,
  };
}

function weighbridgeEventToJson(row: WeighbridgeEvent, poSummary?: Record<string, unknown> | null): Record<string, unknown> {
  return {
    weighbridge_event_id: row.weighbridge_event_id,
    correlation_id: row.correlation_id,
    binding_token: row.correlation_id,
    gate_event_id: row.gate_event_id,
    site_id: row.site_id,
    site_code_ext: row.site_code_ext,
    po_ref_ext: row.po_ref_ext,
    line_no: row.line_no,
    tare_kg: row.tare_kg,
    gross_kg: row.gross_kg,
    net_kg: row.net_kg,
    status: row.status,
    tolerance_breach_reason: row.tolerance_breach_reason,
    device_id: row.device_id,
    capture_method: row.capture_method,
    weighed_by: row.weighed_by,
    business_date: row.business_date,
    source_event_id: row.source_event_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(poSummary !== undefined ? { po_summary: poSummary } : {}),
  };
}

const createWeighbridgeEventBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, WEIGHBRIDGE_WRITE_ROLES, 'write');
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }
  const correlationId = typeof body['correlation_id'] === 'string' ? body['correlation_id'].trim() : '';
  if (!correlationId || !UUID_REGEX.test(correlationId)) {
    sendRequestError(req, res, 400, 'WEIGHBRIDGE_BINDING_TOKEN_REQUIRED', 'correlation_id (binding token) is required and must be a UUID');
    return;
  }
  // Resolve the binding token to its gate event so the operator's site scope can be enforced before
  // the write, and so an unknown token is rejected with a stable code rather than a raw 500.
  const gateByToken = await resolveGateByToken(correlationId);
  if (!gateByToken) {
    sendRequestError(req, res, 404, 'WEIGHBRIDGE_BINDING_TOKEN_NOT_FOUND', `No gate event exists for binding token "${correlationId}"`);
    return;
  }
  assertSiteAccess(req, gateByToken.site_id, 'write');

  const actor = actorContext(req);
  const weighbridgeEventId = typeof body['weighbridge_event_id'] === 'string' && UUID_REGEX.test(body['weighbridge_event_id']) ? body['weighbridge_event_id'] : randomUUID();
  const pool = getPool();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await persistEvent(
      {
        stream_type: 'weighbridge',
        stream_id: weighbridgeEventId,
        event_type: 'weighbridge.recorded',
        payload: {
          ...body,
          weighbridge_event_id: weighbridgeEventId,
          correlation_id: correlationId,
          weighed_by: actor.userId,
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
    const saved = await getWeighbridgeEventById(weighbridgeEventId, client);
    await client.query('COMMIT');
    committed = true;
    sendJson(res, 201, weighbridgeEventToJson(saved!));
  } catch (err) {
    if (!committed) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

/** Resolves the most recent gate event carrying the given binding token (correlation_id). */
async function resolveGateByToken(correlationId: string): Promise<{ site_id: string } | null> {
  const result = await getPool().query(
    `SELECT site_id FROM gate_event WHERE correlation_id = $1 ORDER BY entered_at DESC, created_at DESC LIMIT 1`,
    [correlationId],
  );
  return result.rows.length > 0 ? { site_id: result.rows[0]!['site_id'] as string } : null;
}

const getWeighbridgeEventBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, WEIGHBRIDGE_READ_ROLES, 'read');
  const weighbridgeEventId = params['weighbridgeEventId'];
  if (!weighbridgeEventId || !UUID_REGEX.test(weighbridgeEventId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'weighbridgeEventId path parameter must be a UUID');
    return;
  }
  const row = await getWeighbridgeEventById(weighbridgeEventId);
  if (!row) {
    sendRequestError(req, res, 404, 'WEIGHBRIDGE_EVENT_NOT_FOUND', `No weighbridge event exists for "${weighbridgeEventId}"`);
    return;
  }
  assertSiteAccess(req, row.site_id, 'read');
  sendJson(res, 200, weighbridgeEventToJson(row, await poLineSummary(row)));
};

const listWeighbridgeEventsBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, WEIGHBRIDGE_READ_ROLES, 'read');
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const status = url.searchParams.get('status');
  const siteCode = url.searchParams.get('site');
  const poRef = url.searchParams.get('po');
  if (status !== null && status !== 'accepted' && status !== 'tolerance_breach') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', "status filter must be 'accepted' or 'tolerance_breach'");
    return;
  }
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const inventoryScope = permittedLocationsForModule(authContext.roles, 'inventory');
  const gateScope = permittedLocationsForModule(authContext.roles, 'gate');
  const weighbridgeScope = permittedLocationsForModule(authContext.roles, 'weighbridge');
  const wildcard = inventoryScope.wildcard || gateScope.wildcard || weighbridgeScope.wildcard;
  const locations = new Set([...inventoryScope.locations, ...gateScope.locations, ...weighbridgeScope.locations]);
  let siteId: string | null = null;
  let siteAny: string[] | null = null;
  if (siteCode) {
    const site = await getLocationByCode(siteCode);
    if (!site || site.status !== 'active' || site.level !== 'site') throw new AppError(404, 'GATE_SITE_NOT_FOUND', `No active site exists for "${siteCode}"`, { site_code_ext: siteCode });
    if (!wildcard && !locations.has(site.location_id)) throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No read assignment grants access to site "${site.location_id}"`);
    siteId = site.location_id;
  } else if (!wildcard) {
    siteAny = [...locations];
  }
  const rows = await listWeighbridgeEvents({ siteId, siteAny, status: status as 'accepted' | 'tolerance_breach' | null, poRefExt: poRef });
  sendJson(res, 200, { weighbridge_events: rows.map((row) => weighbridgeEventToJson(row)) });
};

export const createWeighbridgeEventHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(createWeighbridgeEventBase);
export const getWeighbridgeEventHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read' })(getWeighbridgeEventBase);
export const listWeighbridgeEventsHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read' })(listWeighbridgeEventsBase);
