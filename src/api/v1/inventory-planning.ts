import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getParsedBody, getAuthContext, getAuthorizedAssignment, getTraceId } from '../../middleware/context.js';
import { requireRole, permittedLocationsForModule, permittedLocationsForModuleScope } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getPool } from '../../config/db.js';
import { getPlanningParams, listPlanningParams } from '../../read/projections/inventory_planning.js';
import type { PlanningParamsRow } from '../../read/projections/inventory_planning.js';
import { listRecommendations } from '../../read/projections/replenishment_recommendation.js';
import { listObsolescenceReport } from '../../read/projections/obsolescence_flag.js';
import {
  runSafetyStockComputation,
  runReplenishmentCheck,
  runObsolescenceScan,
  runVmiReplenishmentCheck,
  type PlanningJobScope,
} from '../../compliance/planning-jobs.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Story 2.7 suggested roles. requireRole enforces module+function scope; these narrow to named roles.
const PLANNING_WRITE_ROLES = ['inventory_planner', 'demand_planner', 'inventory_controller'];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

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
    (r) => (r.module === 'inventory' || r.module === '*') && r.functionScope === functionScope && allowedRoles.includes(r.role),
  );
  if (!ok) {
    throw new AppError(403, 'FUNCTION_ACCESS_DENIED', `This operation is restricted to roles: ${allowedRoles.join(', ')}`);
  }
}

function assertWriteLocationAccess(req: IncomingMessage, locationId: string): void {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const { wildcard, locations } = permittedLocationsForModuleScope(authContext.roles, 'inventory', 'write');
  if (!wildcard && !locations.has(locationId)) {
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No write assignment grants access to location "${locationId}"`);
  }
}

/**
 * Resolves a compute/check/scan scope from the request body, enforcing location access: a specified
 * location_id must be permitted; without one, a non-wildcard actor is restricted to its assigned
 * locations (location_any) and a wildcard actor sees all.
 */
function resolveScope(req: IncomingMessage, body: Record<string, unknown>, actor: ActorContext): Omit<PlanningJobScope, 'business_date' | 'auditCtx'> {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const { wildcard, locations } = permittedLocationsForModuleScope(authContext.roles, 'inventory', 'write');
  const locationId = isNonEmptyString(body['location_id']) ? (body['location_id'] as string) : null;
  const sku = isNonEmptyString(body['sku']) ? (body['sku'] as string) : null;
  const planningActor = { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId };

  if (locationId) {
    if (!UUID_REGEX.test(locationId)) throw new AppError(400, 'INVALID_PARAMS', 'location_id must be a UUID when supplied');
    if (!wildcard && !locations.has(locationId)) {
      throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No write assignment grants access to location "${locationId}"`);
    }
    return { location_id: locationId, location_any: null, sku, actor: planningActor };
  }
  if (!wildcard) {
    return { location_id: null, location_any: [...locations], sku, actor: planningActor };
  }
  return { location_id: null, location_any: null, sku, actor: planningActor };
}

function requireBusinessDate(body: Record<string, unknown>): string {
  if (typeof body['business_date'] !== 'string' || !DATE_REGEX.test(body['business_date'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'business_date is required and must be YYYY-MM-DD');
  }
  return body['business_date'];
}

function paramsToJson(row: PlanningParamsRow): Record<string, unknown> {
  return {
    planning_params_id: row.planning_params_id,
    sku: row.sku,
    location_id: row.location_id,
    lead_time_days: row.lead_time_days,
    lead_time_source: row.lead_time_source,
    service_level: row.service_level,
    avg_daily_demand: row.avg_daily_demand,
    demand_std_dev: row.demand_std_dev,
    demand_window_days: row.demand_window_days,
    obsolescence_threshold_days: row.obsolescence_threshold_days,
    standard_order_qty: row.standard_order_qty,
    safety_stock: row.safety_stock,
    reorder_point: row.reorder_point,
    last_computed_at: row.last_computed_at,
    computation_inputs: row.computation_inputs,
    business_stream: row.business_stream,
  };
}

// ---------------------------------------------------------------------------
// POST /api/v1/planning/params
// ---------------------------------------------------------------------------

const setPlanningParamsBase: RouteHandler = async (req, res) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }
  if (!isNonEmptyString(body['sku'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'sku is required');
    return;
  }
  if (!isNonEmptyString(body['location_id']) || !UUID_REGEX.test(body['location_id'] as string)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'location_id is required and must be a UUID');
    return;
  }
  if (typeof body['service_level'] !== 'number') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'service_level is required and must be a number');
    return;
  }
  if (!isNonEmptyString(body['business_stream'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'business_stream is required');
    return;
  }
  const sku = body['sku'] as string;
  const locationId = body['location_id'] as string;

  assertRoleAllowed(req, PLANNING_WRITE_ROLES, 'write');
  assertWriteLocationAccess(req, locationId);

  const actor = actorContext(req);
  const pool = getPool();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    // Reuse the existing grain's planning_params_id so config edits keep a stable identity.
    const existing = await getPlanningParams(sku, locationId, client, true);
    const planningParamsId = existing?.planning_params_id ?? randomUUID();

    await persistEvent(
      {
        stream_type: 'inventory',
        stream_id: planningParamsId,
        event_type: 'inventory_planning.params_set',
        payload: {
          planning_params_id: planningParamsId,
          sku,
          location_id: locationId,
          ...(body['lead_time_days'] !== undefined ? { lead_time_days: body['lead_time_days'] } : {}),
          ...(body['lead_time_source'] !== undefined ? { lead_time_source: body['lead_time_source'] } : {}),
          service_level: body['service_level'],
          ...(body['obsolescence_threshold_days'] !== undefined ? { obsolescence_threshold_days: body['obsolescence_threshold_days'] } : {}),
          ...(body['standard_order_qty'] !== undefined ? { standard_order_qty: body['standard_order_qty'] } : {}),
          ...(body['demand_window_days'] !== undefined ? { demand_window_days: body['demand_window_days'] } : {}),
          business_stream: body['business_stream'],
          set_by_actor_id: actor.userId,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: new Date().toISOString(),
        },
      },
      auditCtxFor(req, actor, existing ? 200 : 201),
      client,
    );

    const saved = await getPlanningParams(sku, locationId, client);
    await client.query('COMMIT');
    committed = true;
    sendJson(res, existing ? 200 : 201, paramsToJson(saved!));
  } catch (err) {
    if (!committed) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/planning/params/:sku
// ---------------------------------------------------------------------------

const getPlanningParamsBase: RouteHandler = async (req, res, params) => {
  const sku = params['sku'];
  if (!sku) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'sku is required');
    return;
  }
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const locationId = url.searchParams.get('location_id');

  const { wildcard, locations } = permittedLocationsForModule(authContext.roles, 'inventory');
  let locationAny: string[] | null = null;
  if (!wildcard) {
    if (locationId && !locations.has(locationId)) {
      sendRequestError(req, res, 403, 'LOCATION_ACCESS_DENIED', 'No access to the specified location_id');
      return;
    }
    if (!locationId) locationAny = [...locations];
  }

  const rows = await listPlanningParams({ sku, location_id: locationId, location_any: locationAny });
  sendJson(res, 200, { sku, params: rows.map(paramsToJson) });
};

// ---------------------------------------------------------------------------
// POST /api/v1/planning/safety-stock/compute
// ---------------------------------------------------------------------------

const computeSafetyStockBase: RouteHandler = async (req, res) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  assertRoleAllowed(req, PLANNING_WRITE_ROLES, 'write');
  const businessDate = requireBusinessDate(body);
  const actor = actorContext(req);
  const scope = resolveScope(req, body, actor);
  const result = await runSafetyStockComputation({ ...scope, business_date: businessDate, auditCtx: auditCtxFor(req, actor, 200) });
  sendJson(res, 200, result);
};

// ---------------------------------------------------------------------------
// POST /api/v1/planning/replenishment/check
// ---------------------------------------------------------------------------

const checkReplenishmentBase: RouteHandler = async (req, res) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  assertRoleAllowed(req, PLANNING_WRITE_ROLES, 'write');
  const businessDate = requireBusinessDate(body);
  const actor = actorContext(req);
  const scope = resolveScope(req, body, actor);
  const result = await runReplenishmentCheck({ ...scope, business_date: businessDate, auditCtx: auditCtxFor(req, actor, 200) });
  sendJson(res, 200, result);
};

// ---------------------------------------------------------------------------
// GET /api/v1/planning/replenishment/recommendations
// ---------------------------------------------------------------------------

const listRecommendationsBase: RouteHandler = async (req, res) => {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const locationId = url.searchParams.get('location_id');
  const sku = url.searchParams.get('sku');
  const status = url.searchParams.get('status');
  // Story 2.8: the exception queue serves both internal reorder signals and VMI replenishment
  // signals; signal_type narrows the view.
  const signalType = url.searchParams.get('signal_type');
  if (signalType !== null && signalType !== 'internal' && signalType !== 'vmi_replenishment') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', "signal_type filter must be 'internal' or 'vmi_replenishment'");
    return;
  }

  const { wildcard, locations } = permittedLocationsForModule(authContext.roles, 'inventory');
  let locationAny: string[] | null = null;
  if (!wildcard) {
    if (locationId && !locations.has(locationId)) {
      sendRequestError(req, res, 403, 'LOCATION_ACCESS_DENIED', 'No access to the specified location_id');
      return;
    }
    if (!locationId) locationAny = [...locations];
  }

  const rows = await listRecommendations({ location_id: locationId, location_any: locationAny, sku, status, signal_type: signalType });
  sendJson(res, 200, { recommendations: rows });
};

// ---------------------------------------------------------------------------
// POST /api/v1/planning/vmi/check (Story 2.8)
// ---------------------------------------------------------------------------

const checkVmiReplenishmentBase: RouteHandler = async (req, res) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  assertRoleAllowed(req, PLANNING_WRITE_ROLES, 'write');
  const businessDate = requireBusinessDate(body);
  const actor = actorContext(req);
  const scope = resolveScope(req, body, actor);
  const result = await runVmiReplenishmentCheck({ ...scope, business_date: businessDate, auditCtx: auditCtxFor(req, actor, 200) });
  sendJson(res, 200, result);
};

// ---------------------------------------------------------------------------
// POST /api/v1/planning/obsolescence/scan
// ---------------------------------------------------------------------------

const scanObsolescenceBase: RouteHandler = async (req, res) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  assertRoleAllowed(req, PLANNING_WRITE_ROLES, 'write');
  const businessDate = requireBusinessDate(body);
  const actor = actorContext(req);
  const scope = resolveScope(req, body, actor);
  const result = await runObsolescenceScan({ ...scope, business_date: businessDate, auditCtx: auditCtxFor(req, actor, 200) });
  sendJson(res, 200, result);
};

// ---------------------------------------------------------------------------
// GET /api/v1/planning/obsolescence/report
// ---------------------------------------------------------------------------

const obsolescenceReportBase: RouteHandler = async (req, res) => {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const locationId = url.searchParams.get('location_id');
  const sku = url.searchParams.get('sku');
  const status = url.searchParams.get('status');
  const fromDate = url.searchParams.get('from_date');
  const toDate = url.searchParams.get('to_date');

  const { wildcard, locations } = permittedLocationsForModule(authContext.roles, 'inventory');
  let locationAny: string[] | null = null;
  if (!wildcard) {
    if (locationId && !locations.has(locationId)) {
      sendRequestError(req, res, 403, 'LOCATION_ACCESS_DENIED', 'No access to the specified location_id');
      return;
    }
    if (!locationId) locationAny = [...locations];
  }

  const rows = await listObsolescenceReport({ location_id: locationId, location_any: locationAny, sku, status, from_date: fromDate, to_date: toDate });
  sendJson(res, 200, { reports: rows });
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const setPlanningParamsHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(setPlanningParamsBase);
export const getPlanningParamsHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read' })(getPlanningParamsBase);
export const computeSafetyStockHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(computeSafetyStockBase);
export const checkReplenishmentHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(checkReplenishmentBase);
export const listRecommendationsHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read' })(listRecommendationsBase);
export const scanObsolescenceHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(scanObsolescenceBase);
export const checkVmiReplenishmentHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(checkVmiReplenishmentBase);
export const obsolescenceReportHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read' })(obsolescenceReportBase);
