import type { IncomingMessage } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson } from '../../middleware/error.js';
import { getAuthContext, getAuthorizedAssignment, getParsedBody, getTraceId } from '../../middleware/context.js';
import { requireRole, permittedLocationsForModuleScope } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import type { WarehouseTaskType } from '../../events/schema.js';
import { WAREHOUSE_TASK_SUPERVISE_ROLES, WAREHOUSE_TASK_TYPES } from '../../compliance/warehouse-task.js';
import { getSlaConfig, listSlaConfig } from '../../read/projections/task_sla_config.js';
import {
  listOpenTasks,
  groupOpenTasks,
  computeConfirmationRate,
  computeGateDwellExceptions,
  assertValidTaskFilters,
  GATE_DWELL_TARGET_MINUTES,
  OPEN_TASK_DEFAULT_LIMIT,
  OPEN_TASK_MAX_LIMIT,
} from '../../warehouse/task-metrics.js';

/**
 * Story 3.8: the supervisor task-management surface (FR-W-07).
 *
 * Four reads (task board, productivity, gate-dwell exceptions, SLA config) and one write (SLA
 * config). Every read is gated by WAREHOUSE_TASK_READ_ROLES and site-scoped through
 * permittedLocationsForModuleScope; the write is additionally gated by
 * WAREHOUSE_TASK_SUPERVISE_ROLES here AND, independently, at the compliance seam - see
 * src/compliance/warehouse-task.ts for why the seam gate is the one that actually holds.
 */

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Every warehouse role established across Stories 3.5 through 3.7, read-only.
 *
 * The two supervisor roles are enumerated here EXPLICITLY alongside the frontline roles. Write
 * membership does not imply read membership in this codebase, and assuming it did is precisely the
 * regression Story 3.7's second review pass had to fix with its own DISPATCH_READ_ROLES constant.
 * `unloading_supervisor` is included because it already holds read access to the putaway and
 * receiving data this board aggregates (PUTAWAY_READ_ROLES / RECEIVING_READ_ROLES /
 * PUTAWAY_RELEASE_ROLES); omitting it would lock that role out of the unified view while leaving
 * its access to every underlying per-domain endpoint intact.
 */
const WAREHOUSE_TASK_READ_ROLES = [
  'store_assistant',
  'warehouse_operator',
  'dispatch_clerk',
  'unloading_supervisor',
  'warehouse_manager',
  'inventory_controller',
];

/**
 * The productivity rollup and the gate-dwell exception drill-through are supervisory instruments,
 * not board reads, and are gated more tightly than WAREHOUSE_TASK_READ_ROLES above.
 *
 * Code review found the two sharing the board's role list. That let a store_assistant call
 * /productivity with no operator_id filter and receive per-colleague confirmation rates and
 * durations for the whole site, and /exceptions/gate-dwell to receive vehicle registrations,
 * correlation ids and PO references for every breaching vehicle. The reasoning behind the board's
 * wider list - that these roles already reach the same rows through the per-domain endpoints - does
 * not carry over: an aggregate that ranks colleagues against each other is more sensitive than the
 * per-domain task lists it is computed from.
 */
const WAREHOUSE_TASK_METRICS_ROLES = ['unloading_supervisor', 'warehouse_manager', 'inventory_controller'];

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
    method: req.method ?? 'GET',
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

/**
 * Resolves the site filter for a scoped read. A `site` query parameter is honoured only after it is
 * checked against the caller's own scope; otherwise the read is narrowed to exactly the sites the
 * caller may see. `allowAllSites` is set only for a genuine wildcard assignment, so an unscoped
 * cross-site aggregate is always an explicit grant and never the result of a forgotten filter
 * (Task 7.4).
 */
function resolveSiteScope(
  req: IncomingMessage,
  requestedSiteId: string | null,
  scope: 'read' | 'write' = 'read',
): { siteId: string | null; siteAny: string[] | null; allowAllSites: boolean } {
  const permitted = warehouseScope(req, scope);
  if (requestedSiteId) {
    if (!permitted.wildcard && !permitted.locations.has(requestedSiteId)) {
      throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No ${scope} assignment grants access to site "${requestedSiteId}"`);
    }
    return { siteId: requestedSiteId, siteAny: null, allowAllSites: false };
  }
  if (permitted.wildcard) return { siteId: null, siteAny: null, allowAllSites: true };
  return { siteId: null, siteAny: [...permitted.locations], allowAllSites: false };
}

function queryOf(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`).searchParams;
}

/**
 * Deterministic RFC 4122 v5 UUID. The SLA-config event stream is keyed by its (task_type, zone_id)
 * grain rather than by a fresh random id, so every threshold change for the same grain forms one
 * ordered stream and `event_version` means what it says. A random stream id per write would make
 * every change version 1 of its own stream, which is not what an event log is for.
 */
const SLA_CONFIG_NAMESPACE = '6f9619ff-8b86-d011-b42d-00c04fc964ff';

function uuidV5(name: string, namespace: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(Buffer.concat([nsBytes, Buffer.from(name, 'utf8')])).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// AC1: the unified task board
// ---------------------------------------------------------------------------

const listWarehouseTasksBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, WAREHOUSE_TASK_READ_ROLES, 'read');
  const params = queryOf(req);
  // Validate BEFORE touching the database, so a malformed filter is a 400, never a Postgres 500.
  assertValidTaskFilters(params);

  const scope = resolveSiteScope(req, params.get('site_id') ?? params.get('site'));
  const tasks = await listOpenTasks({
    taskType: (params.get('task_type') as WarehouseTaskType | null) ?? null,
    assignedTo: params.get('assigned_to'),
    zoneId: params.get('zone_id'),
    siteId: scope.siteId,
    siteAny: scope.siteAny,
    allowAllSites: scope.allowAllSites,
    ...(params.get('limit') !== null ? { limit: Number(params.get('limit')) } : {}),
  });

  sendJson(res, 200, {
    tasks,
    groups: groupOpenTasks(tasks),
    summary: {
      open_count: tasks.length,
      breached_count: tasks.filter((t) => t.breached).length,
      /** True when the board was capped, so a caller can tell a short list from a complete one. */
      truncated: tasks.length >= Math.min(Number(params.get('limit') ?? OPEN_TASK_DEFAULT_LIMIT), OPEN_TASK_MAX_LIMIT),
    },
  });
};

// ---------------------------------------------------------------------------
// AC2: confirmation rate and productivity
// ---------------------------------------------------------------------------

const getProductivityBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, WAREHOUSE_TASK_METRICS_ROLES, 'read');
  const params = queryOf(req);
  assertValidTaskFilters(params);

  const periodEnd = params.get('period_end') ?? new Date().toISOString();
  // Default window is the 24 hours ending at period_end, derived from period_end itself rather than
  // from a second clock read, so the two bounds are always consistent with each other.
  const periodStart = params.get('period_start') ?? new Date(Date.parse(periodEnd) - 24 * 60 * 60 * 1000).toISOString();
  if (Date.parse(periodStart) >= Date.parse(periodEnd)) {
    throw new AppError(400, 'INVALID_PARAMS', 'period_start must be strictly before period_end', {
      period_start: periodStart,
      period_end: periodEnd,
    });
  }

  const scope = resolveSiteScope(req, params.get('site_id') ?? params.get('site'));
  const productivity = await computeConfirmationRate({
    periodStart,
    periodEnd,
    siteId: scope.siteId,
    siteAny: scope.siteAny,
    allowAllSites: scope.allowAllSites,
    zoneId: params.get('zone_id'),
    operatorId: params.get('operator_id'),
  });

  sendJson(res, 200, {
    period: { start: periodStart, end: periodEnd },
    ...productivity,
  });
};

// ---------------------------------------------------------------------------
// AC3: gate-dwell exceptions
// ---------------------------------------------------------------------------

const getGateDwellExceptionsBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, WAREHOUSE_TASK_METRICS_ROLES, 'read');
  const params = queryOf(req);
  assertValidTaskFilters(params);

  const scope = resolveSiteScope(req, params.get('site_id') ?? params.get('site'));
  const shifts = await computeGateDwellExceptions({
    businessDate: params.get('business_date'),
    siteId: scope.siteId,
    siteAny: scope.siteAny,
    allowAllSites: scope.allowAllSites,
  });

  sendJson(res, 200, {
    target_minutes: GATE_DWELL_TARGET_MINUTES,
    shifts,
    exceptions: shifts.filter((s) => s.exceeded),
  });
};

// ---------------------------------------------------------------------------
// AC1 (configuration): SLA thresholds
// ---------------------------------------------------------------------------

const getSlaConfigBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, WAREHOUSE_TASK_READ_ROLES, 'read');
  const params = queryOf(req);
  assertValidTaskFilters(params);
  // Threshold rows are site-scoped now that site_id is part of the grain, so this narrows the read
  // to the caller's own sites rather than merely verifying that they hold some warehouse assignment.
  const scope = resolveSiteScope(req, params.get('site_id') ?? params.get('site'));

  const taskType = (params.get('task_type') as WarehouseTaskType | null) ?? null;
  const zoneId = params.get('zone_id');
  if (taskType && params.has('resolve')) {
    // Resolution answers "which threshold governs THIS task", which is meaningless without knowing
    // which site's configuration to resolve against, so the site must be explicit here.
    if (!scope.siteId) {
      throw new AppError(400, 'INVALID_PARAMS', 'site_id is required when resolving the governing threshold', {
        task_type: taskType,
      });
    }
    const resolved = await getSlaConfig(taskType, scope.siteId, zoneId);
    sendJson(res, 200, { task_type: taskType, site_id: scope.siteId, zone_id: zoneId, sla_config: resolved });
    return;
  }
  sendJson(res, 200, {
    sla_configs: await listSlaConfig({ siteId: scope.siteId, siteAny: scope.siteAny, taskType, zoneId }),
  });
};

/**
 * Persists a threshold change through persistEvent - never a direct table UPDATE - so the change
 * carries a domain event, an audit entry, and a server-set updated_by. The supervisor role check
 * runs here for a fast, well-shaped 403, and again inside the compliance seam so that a direct
 * POST /api/v1/events cannot reach the same write with the handler bypassed.
 */
const putSlaConfigBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, WAREHOUSE_TASK_SUPERVISE_ROLES, 'write');
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};

  const taskType = body['task_type'];
  if (typeof taskType !== 'string' || !WAREHOUSE_TASK_TYPES.includes(taskType as WarehouseTaskType)) {
    throw new AppError(400, 'INVALID_PARAMS', `task_type must be one of: ${WAREHOUSE_TASK_TYPES.join(', ')}`, { task_type: taskType });
  }
  const rawZoneId = body['zone_id'];
  if (rawZoneId !== undefined && rawZoneId !== null && typeof rawZoneId !== 'string') {
    throw new AppError(400, 'INVALID_PARAMS', 'zone_id must be a UUID string when supplied');
  }
  const zoneId = (rawZoneId as string | null | undefined) ?? null;

  // Every threshold row belongs to exactly one site. A zone-scoped write takes its site from the
  // zone itself; a site-wide default must name its site explicitly, because "site-wide" with no site
  // is what let one supervisor's write change breach thresholds across the whole deployment.
  let siteId: string;
  if (zoneId !== null) {
    const { getPool } = await import('../../config/db.js');
    const zone = await getPool().query(`SELECT site_id FROM location_register WHERE location_id = $1`, [zoneId]);
    if (zone.rows.length === 0) {
      throw new AppError(404, 'LOCATION_NOT_FOUND', `No location register entry exists for "${zoneId}"`, { zone_id: zoneId });
    }
    const zoneSiteId = zone.rows[0]!['site_id'] as string;
    resolveSiteScope(req, zoneSiteId, 'write');
    siteId = zoneSiteId;
  } else {
    const rawSiteId = body['site_id'];
    if (typeof rawSiteId !== 'string' || rawSiteId.length === 0) {
      throw new AppError(400, 'INVALID_PARAMS', 'site_id is required when setting a site-wide default threshold');
    }
    const scope = resolveSiteScope(req, rawSiteId, 'write');
    siteId = scope.siteId ?? rawSiteId;
  }

  const actor = actorContext(req);
  const persisted = await persistEvent(
    {
      stream_type: 'warehouse',
      // The stream is keyed by the full grain including the site, so each site's threshold history is
      // its own ordered stream and event_version means what it says within that site.
      stream_id: uuidV5(`task_sla_config:${siteId}:${taskType}:${zoneId ?? 'site-wide'}`, SLA_CONFIG_NAMESPACE),
      event_type: 'task_sla_config.updated',
      payload: {
        site_id: siteId,
        task_type: taskType,
        zone_id: zoneId,
        threshold_minutes: body['threshold_minutes'] as number | string,
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

  const updated = await getSlaConfig(taskType as WarehouseTaskType, siteId, zoneId);
  sendJson(res, 200, { event_id: persisted.event_id, sla_config: updated });
};

export const handleListWarehouseTasks: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'read' })(listWarehouseTasksBase);
export const handleGetProductivity: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'read' })(getProductivityBase);
export const handleGetGateDwellExceptions: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'read' })(getGateDwellExceptionsBase);
export const handleGetSlaConfig: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'read' })(getSlaConfigBase);
export const handlePutSlaConfig: RouteHandler = requireRole({ module: 'warehouse', functionScope: 'write' })(putSlaConfigBase);
