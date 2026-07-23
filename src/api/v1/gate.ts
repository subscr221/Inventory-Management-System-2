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
import { getGateEventById, getGateEventByIdempotencyKey, listGateEvents } from '../../read/projections/gate_event.js';
import type { GateEvent } from '../../read/projections/gate_event.js';
import { logAuditEntry } from '../../read/projections/audit_log.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GATE_WRITE_ROLES = ['gate_officer'];
const UNMATCHED_READ_ROLES = ['gate_officer', 'unloading_supervisor', 'warehouse_manager'];
const GENERAL_READ_ROLES = ['gate_officer', 'unloading_supervisor', 'warehouse_manager'];

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
    (r) => (r.module === 'inventory' || r.module === '*' || r.module === 'gate') && r.functionScope === functionScope && allowedRoles.includes(r.role),
  );
  if (!ok) throw new AppError(403, 'FUNCTION_ACCESS_DENIED', `This operation is restricted to roles: ${allowedRoles.join(', ')}`);
}

function assertSiteAccess(req: IncomingMessage, siteId: string, scope: 'read' | 'write'): void {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const { wildcard, locations } = permittedLocationsForModuleScope(authContext.roles, 'inventory', scope);
  const gateScope = permittedLocationsForModuleScope(authContext.roles, 'gate', scope);
  if (!wildcard && !gateScope.wildcard && !locations.has(siteId) && !gateScope.locations.has(siteId)) {
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No ${scope} assignment grants access to site "${siteId}"`);
  }
}

function gateEventToJson(row: GateEvent, poSummary?: Record<string, unknown> | null): Record<string, unknown> {
  return {
    gate_event_id: row.gate_event_id,
    site_id: row.site_id,
    site_code_ext: row.site_code_ext,
    po_ref_ext: row.po_ref_ext ?? 'UNKNOWN',
    binding_status: row.binding_status,
    vehicle_reg_ext: row.vehicle_reg_ext,
    driver_name: row.driver_name,
    challan_number_ext: row.challan_number_ext,
    challan_photo_ref: row.challan_photo_ref,
    gate_id: row.gate_id,
    gate_officer_id: row.gate_officer_id,
    correlation_id: row.correlation_id,
    // AD-2 (Review D2): deprecated alias of correlation_id, kept for response-contract stability
    // with edge/PWA consumers. New consumers must read correlation_id; remove via versioned
    // deprecation only.
    binding_token: row.correlation_id,
    entered_at: row.entered_at,
    business_date: row.business_date,
    status: row.status,
    reversal_reason: row.reversal_reason,
    source_event_id: row.source_event_id,
    ...(poSummary !== undefined ? { po_summary: poSummary } : {}),
  };
}

async function poSummary(row: GateEvent): Promise<Record<string, unknown> | null> {
  if (!row.po_ref_ext) return null;
  const po = await getPurchaseOrderByRef(row.po_ref_ext);
  if (!po) return null;
  return { po_number_ext: po.po_number_ext, supplier_ref_ext: po.supplier_ref_ext, status: po.status };
}

const createGateEventBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, GATE_WRITE_ROLES, 'write');
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }
  const siteCode = typeof body['site_code_ext'] === 'string' ? body['site_code_ext'].trim() : '';
  const site = siteCode ? await getLocationByCode(siteCode) : null;
  if (!site || site.status !== 'active' || site.level !== 'site') throw new AppError(404, 'GATE_SITE_NOT_FOUND', `No active site exists for "${siteCode}"`, { site_code_ext: siteCode });
  assertSiteAccess(req, site.location_id, 'write');
  const actor = actorContext(req);

  // Review D1: the online create path dedups retried submissions on a client-supplied
  // Idempotency-Key (stored in domain_events under uq_idempotency). A replayed key returns the
  // originally created gate event with 200 instead of inserting a duplicate row.
  //
  // Re-review fix: a key match alone is not sufficient to replay. uq_idempotency is unscoped
  // (any event_type, any site, any actor), so returning the matched row unconditionally would let
  // an officer at Site X see another site's gate event (vehicle_reg, driver, challan photo, PO ref)
  // just by colliding on a client-generated key - and would silently swallow a corrected retry
  // (typo fix, different vehicle) that reused the same key. Both are rejected as 409
  // IDEMPOTENCY_KEY_CONFLICT instead of returning stale/foreign data; only a same-site,
  // same-submission replay short-circuits with 200.
  const idempotencyKeyHeader = req.headers['idempotency-key'];
  if (Array.isArray(idempotencyKeyHeader) && new Set(idempotencyKeyHeader).size > 1) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Idempotency-Key header must not repeat with different values');
    return;
  }
  const idempotencyKey = (Array.isArray(idempotencyKeyHeader) ? idempotencyKeyHeader[0] ?? '' : idempotencyKeyHeader ?? '').trim();
  if (idempotencyKey.length > 255) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Idempotency-Key header must be at most 255 characters');
    return;
  }

  const replayIfMatch = async (): Promise<GateEvent | null> => {
    const replay = await getGateEventByIdempotencyKey(idempotencyKey);
    if (!replay) return null;
    const expectedPoRef = typeof body['po_ref_ext'] === 'string' && body['po_ref_ext'].trim() && body['po_ref_ext'].trim() !== 'UNKNOWN' ? body['po_ref_ext'].trim() : null;
    const bodyMatches =
      replay.site_id === site!.location_id &&
      replay.vehicle_reg_ext === (typeof body['vehicle_reg_ext'] === 'string' ? body['vehicle_reg_ext'].trim().toUpperCase() : '') &&
      replay.gate_id === (typeof body['gate_id'] === 'string' ? body['gate_id'].trim() : '') &&
      replay.challan_photo_ref === (typeof body['challan_photo_ref'] === 'string' ? body['challan_photo_ref'].trim() : '') &&
      replay.po_ref_ext === expectedPoRef;
    if (!bodyMatches) {
      throw new AppError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key was already used for a different gate event submission');
    }
    const auditClient = await getPool().connect();
    try {
      await logAuditEntry(auditClient, { ...auditCtxFor(req, actor, 200), event_id: replay.source_event_id, error_code: null });
    } finally {
      auditClient.release();
    }
    return replay;
  };

  if (idempotencyKey) {
    const replay = await replayIfMatch();
    if (replay) {
      sendJson(res, 200, gateEventToJson(replay));
      return;
    }
  }

  const gateEventId = randomUUID();
  const correlationId = randomUUID();
  const pool = getPool();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await persistEvent(
      {
        stream_type: 'gate',
        stream_id: gateEventId,
        event_type: 'gate.entered',
        payload: {
          ...body,
          gate_event_id: gateEventId,
          gate_officer_id: actor.userId,
        },
        metadata: {
          correlation_id: correlationId,
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: idempotencyKey || null,
      },
      auditCtxFor(req, actor, 201),
      client,
    );
    const saved = await getGateEventById(gateEventId, client);
    await client.query('COMMIT');
    committed = true;
    sendJson(res, 201, gateEventToJson(saved!));
  } catch (err) {
    if (!committed) await client.query('ROLLBACK');
    // Concurrent same-key requests race past the replay pre-check; the uq_idempotency constraint
    // rejects the loser, which then replays the winner's row (through the same site/body check
    // used above) instead of surfacing an opaque 409.
    if (idempotencyKey && err instanceof AppError && err.errorCode === 'DUPLICATE_EVENT') {
      const replay = await replayIfMatch();
      if (replay) {
        sendJson(res, 200, gateEventToJson(replay));
        return;
      }
    }
    throw err;
  } finally {
    client.release();
  }
};

const reverseGateEventBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, GATE_WRITE_ROLES, 'write');
  const gateEventId = params['gateEventId'];
  if (!gateEventId || !UUID_REGEX.test(gateEventId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'gateEventId path parameter must be a UUID');
    return;
  }
  const existing = await getGateEventById(gateEventId);
  if (!existing) throw new AppError(404, 'GATE_EVENT_NOT_FOUND', `No gate event exists for "${gateEventId}"`, { gate_event_id: gateEventId });
  assertSiteAccess(req, existing.site_id, 'write');
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const actor = actorContext(req);
  await persistEvent(
    {
      stream_type: 'gate',
      stream_id: gateEventId,
      event_type: 'gate.reversed',
      payload: { gate_event_id: gateEventId, reversal_reason: body?.['reversal_reason'], reversed_by: actor.userId },
      metadata: {
        correlation_id: existing.correlation_id,
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: new Date().toISOString(),
      },
    },
    auditCtxFor(req, actor, 200),
  );
  const saved = await getGateEventById(gateEventId);
  sendJson(res, 200, gateEventToJson(saved!));
};

const getGateEventBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, GENERAL_READ_ROLES, 'read');
  const gateEventId = params['gateEventId'];
  if (!gateEventId || !UUID_REGEX.test(gateEventId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'gateEventId path parameter must be a UUID');
    return;
  }
  const row = await getGateEventById(gateEventId);
  if (!row) {
    sendRequestError(req, res, 404, 'GATE_EVENT_NOT_FOUND', `No gate event exists for "${gateEventId}"`);
    return;
  }
  assertSiteAccess(req, row.site_id, 'read');
  sendJson(res, 200, gateEventToJson(row, await poSummary(row)));
};

const listGateEventsBase: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const binding = url.searchParams.get('binding');
  const status = url.searchParams.get('status');
  const siteCode = url.searchParams.get('site');
  if (binding !== null && binding !== 'matched' && binding !== 'unmatched') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', "binding filter must be 'matched' or 'unmatched'");
    return;
  }
  if (status !== null && status !== 'open' && status !== 'reversed') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', "status filter must be 'open' or 'reversed'");
    return;
  }
  const orderParam = url.searchParams.get('order');
  if (orderParam !== null && orderParam !== 'asc' && orderParam !== 'desc') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', "order filter must be 'asc' or 'desc'");
    return;
  }
  const offsetParam = url.searchParams.get('offset');
  const offset = offsetParam === null ? 0 : Number(offsetParam);
  if (!Number.isInteger(offset) || offset < 0) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'offset must be a non-negative integer');
    return;
  }
  assertRoleAllowed(req, binding === 'unmatched' ? UNMATCHED_READ_ROLES : GENERAL_READ_ROLES, 'read');
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const inventoryScope = permittedLocationsForModule(authContext.roles, 'inventory');
  const gateScope = permittedLocationsForModule(authContext.roles, 'gate');
  const wildcard = inventoryScope.wildcard || gateScope.wildcard;
  const locations = new Set([...inventoryScope.locations, ...gateScope.locations]);
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
  // Review D3 (AC3): the unmatched worklist defaults oldest-first so long-stuck vehicles surface
  // before newer arrivals; every other listing stays newest-first. An explicit order param wins.
  const order = (orderParam as 'asc' | 'desc' | null) ?? (binding === 'unmatched' ? 'asc' : 'desc');
  const rows = await listGateEvents({ siteId, siteAny, status: status as 'open' | 'reversed' | null, bindingStatus: binding as 'matched' | 'unmatched' | null, limit: 200, offset, order });
  sendJson(res, 200, { gate_events: rows.map((row) => gateEventToJson(row)) });
};

export const createGateEventHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(createGateEventBase);
export const reverseGateEventHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(reverseGateEventBase);
export const getGateEventHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read' })(getGateEventBase);
export const listGateEventsHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read' })(listGateEventsBase);
