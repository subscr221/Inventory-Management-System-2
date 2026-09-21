import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import {
  getAuthContext,
  getAuthorizedAssignment,
  getParsedBody,
  getTraceId,
} from '../../middleware/context.js';
import {
  requireRole,
  permittedLocationsForModule,
  permittedLocationsForModuleScope,
} from '../../middleware/rbac.js';
import { persistEvent, findEventByIdempotencyKey } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getPool } from '../../config/db.js';
import { getLocationByCode } from '../../read/projections/location_register.js';
import { getGrnById, listGrns } from '../../read/projections/grn.js';
import {
  getGrnLineById,
  listGrnLinesByGrn,
  listDiscrepancyLines,
} from '../../read/projections/grn_line.js';
import {
  getPutawayTaskById,
  getPutawayTaskByGrnLine,
} from '../../read/projections/putaway_task.js';
import { getCrossDockTaskByGrnLine } from '../../read/projections/cross_dock_task.js';
import { getServiceOrderById } from '../../read/projections/service_order.js';
import { JOBWORK_CHALLAN_SOURCE } from '../../compliance/receiving.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRN_CREATE_ROLES = ['store_assistant'];
const PUTAWAY_RELEASE_ROLES = ['unloading_supervisor', 'warehouse_manager'];
const RECEIVING_READ_ROLES = [
  'store_assistant',
  'unloading_supervisor',
  'warehouse_manager',
  'inventory_controller',
];

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

function auditCtxFor(
  req: IncomingMessage,
  actor: ActorContext,
  httpStatus: number,
): Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'> {
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

function assertRoleAllowed(
  req: IncomingMessage,
  allowedRoles: string[],
  functionScope: 'read' | 'write',
): void {
  const authContext = getAuthContext(req);
  const roles = authContext?.roles ?? [];
  const ok = roles.some(
    (r) =>
      (r.module === 'receiving' || r.module === '*' || r.module === 'inventory') &&
      (functionScope === 'read' || r.functionScope === 'write') &&
      allowedRoles.includes(r.role),
  );
  if (!ok)
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      `This operation is restricted to roles: ${allowedRoles.join(', ')}`,
    );
}

function receivingScope(
  req: IncomingMessage,
  scope: 'read' | 'write',
): { wildcard: boolean; locations: Set<string> } {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return scope === 'read'
    ? (() => {
        const rec = permittedLocationsForModule(authContext.roles, 'receiving');
        const inv = permittedLocationsForModule(authContext.roles, 'inventory');
        return {
          wildcard: rec.wildcard || inv.wildcard,
          locations: new Set([...rec.locations, ...inv.locations]),
        };
      })()
    : (() => {
        const rec = permittedLocationsForModuleScope(authContext.roles, 'receiving', 'write');
        const inv = permittedLocationsForModuleScope(authContext.roles, 'inventory', 'write');
        return {
          wildcard: rec.wildcard || inv.wildcard,
          locations: new Set([...rec.locations, ...inv.locations]),
        };
      })();
}

function assertSiteAccess(req: IncomingMessage, siteId: string, scope: 'read' | 'write'): void {
  const s = receivingScope(req, scope);
  if (!s.wildcard && !s.locations.has(siteId)) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      `No ${scope} assignment grants access to site "${siteId}"`,
    );
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

/** The business fields of a challan submission; ids, the key and server-set fields are not part of it. */
const CHALLAN_SUBMISSION_FIELDS = [
  'source_document',
  'stock_class',
  'service_order_id',
  'challan_number_ext',
  'challan_date',
  'challan_qty',
  'challan_class',
  'sku',
  'lot_id',
  'expiry_date',
  'received_qty',
  'target_location_id',
  'target_location_code',
  'correlation_id',
] as const;

/**
 * Same key, same submission? (the gate.ts bodyMatches contract.) Compared field by field on the
 * trimmed string form, so 100 and '100' agree with the normalized quantity the stored event holds;
 * an absent field and a null one are the same. A retry may mint fresh grn ids - those are excluded.
 */
function challanSubmissionMatches(
  stored: Record<string, unknown>,
  body: Record<string, unknown>,
): boolean {
  const norm = (value: unknown): string | null =>
    value === undefined || value === null ? null : String(value).trim();
  return CHALLAN_SUBMISSION_FIELDS.every((field) => norm(stored[field]) === norm(body[field]));
}

/**
 * Pilot Ruling B: POST /grn-lines with source_document 'JOBWORK_CHALLAN'. Same role gate, same
 * goods.received event and the same response shape as a purchase-order GRN line. Differences:
 * - the site scope is checked against the job-work order's site (there may be no token to name
 *   one); an unknown order falls through to the seam's stable SOURCE_DOCUMENT_REQUIRED refusal;
 * - correlation_id is optional, and when absent it is left OFF the payload so the seam knows no
 *   weighbridge ticket was presented;
 * - an idempotency_key replays the original result as 200 with replayed: true (the Pilot B2
 *   putaway-completion contract), resolved before anything can trip over the first attempt's state.
 */
async function createJobworkChallanGrnLine(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
): Promise<void> {
  const rawTicket = body['correlation_id'];
  const ticketId = typeof rawTicket === 'string' ? rawTicket.trim() : '';
  if (rawTicket !== undefined && rawTicket !== null && !UUID_REGEX.test(ticketId)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'correlation_id (weighbridge ticket) must be a UUID when supplied',
    );
    return;
  }
  const idempotencyKey =
    typeof body['idempotency_key'] === 'string' && body['idempotency_key'].trim().length > 0
      ? body['idempotency_key']
      : null;

  const answerReplay = async (originalLineId: string): Promise<boolean> => {
    const line = await getGrnLineById(originalLineId);
    const grn = line ? await getGrnById(line.grn_id) : null;
    if (!line || !grn) return false;
    assertSiteAccess(req, grn.site_id, 'write');
    sendJson(res, 200, {
      grn,
      grn_line: line,
      putaway_task: await getPutawayTaskByGrnLine(originalLineId),
      cross_dock_task: await getCrossDockTaskByGrnLine(originalLineId),
      cross_dock_nonqualification_reason: line.cross_dock_nonqualification_reason ?? null,
      replayed: true,
    });
    return true;
  };
  const keyConflict = (): never => {
    throw new AppError(
      409,
      'IDEMPOTENCY_KEY_CONFLICT',
      'idempotency_key was already used for a different receipt submission',
    );
  };
  if (idempotencyKey) {
    const original = await findEventByIdempotencyKey(idempotencyKey);
    if (original) {
      if (
        original.event_type !== 'goods.received' ||
        typeof original.payload['grn_line_id'] !== 'string' ||
        !challanSubmissionMatches(original.payload, body) ||
        !(await answerReplay(original.payload['grn_line_id']))
      )
        keyConflict();
      return;
    }
  }

  const serviceOrderId =
    typeof body['service_order_id'] === 'string' && UUID_REGEX.test(body['service_order_id'])
      ? body['service_order_id']
      : null;
  const order = serviceOrderId ? await getServiceOrderById(serviceOrderId) : null;
  if (order) assertSiteAccess(req, order.site_id, 'write');
  if (ticketId) {
    const ticketSiteId = await resolveSiteByToken(ticketId);
    if (ticketSiteId) assertSiteAccess(req, ticketSiteId, 'write');
  }

  const actor = actorContext(req);
  const grnId =
    typeof body['grn_id'] === 'string' && UUID_REGEX.test(body['grn_id'])
      ? body['grn_id']
      : randomUUID();
  const grnLineId =
    typeof body['grn_line_id'] === 'string' && UUID_REGEX.test(body['grn_line_id'])
      ? body['grn_line_id']
      : randomUUID();
  // Same rule as the purchase-order path: a client-supplied id must not target another site's GRN.
  const existingGrn = await getGrnById(grnId);
  if (existingGrn) assertSiteAccess(req, existingGrn.site_id, 'write');
  const existingLine = await getGrnLineById(grnLineId);
  if (existingLine) {
    const parentGrn = await getGrnById(existingLine.grn_id);
    if (parentGrn) assertSiteAccess(req, parentGrn.site_id, 'write');
  }

  // Our own event id, so a racing retry that loses inside persistEvent (and is handed the STORED
  // event) is recognized by identity - even when it re-sent the same grn_line_id.
  const eventId = randomUUID();
  const payload: Record<string, unknown> = {
    ...body,
    grn_id: grnId,
    grn_line_id: grnLineId,
    received_by: actor.userId,
  };
  delete payload['idempotency_key'];
  if (ticketId) payload['correlation_id'] = ticketId;
  else delete payload['correlation_id'];

  const client = await getPool().connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const persisted = await persistEvent(
      {
        stream_type: 'receiving',
        stream_id: grnId,
        event_type: 'goods.received',
        event_id: eventId,
        payload,
        metadata: {
          correlation_id: ticketId || randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: idempotencyKey,
      },
      auditCtxFor(req, actor, 201),
      client,
    );
    // A racing retry loses to the first attempt inside persistEvent and is handed the STORED
    // event: answer it as the replay it is, or as a key conflict when its payload differs.
    const replayed = persisted.event_id !== eventId;
    if (replayed && !challanSubmissionMatches(persisted.payload, body)) keyConflict();
    const persistedLineId = persisted.payload['grn_line_id'] as string;
    const line = await getGrnLineById(persistedLineId, client);
    const grn = line ? await getGrnById(line.grn_id, client) : null;
    const putaway = await getPutawayTaskByGrnLine(persistedLineId, client);
    const crossDockTask = await getCrossDockTaskByGrnLine(persistedLineId, client);
    await client.query('COMMIT');
    committed = true;
    sendJson(res, replayed ? 200 : 201, {
      grn,
      grn_line: line,
      putaway_task: putaway,
      cross_dock_task: crossDockTask,
      cross_dock_nonqualification_reason: line?.cross_dock_nonqualification_reason ?? null,
      ...(replayed ? { replayed: true } : {}),
    });
  } catch (err) {
    if (!committed) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const createGrnLineBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, GRN_CREATE_ROLES, 'write');
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }
  // Pilot Ruling B: customer material received against the job-work order and the customer's
  // challan has no purchase order and an OPTIONAL weighbridge ticket. It is the same event through
  // the same seam; only the token and site pre-checks differ, so it branches here and nowhere else.
  if (body['source_document'] === JOBWORK_CHALLAN_SOURCE) {
    await createJobworkChallanGrnLine(req, res, body);
    return;
  }
  const correlationId =
    typeof body['correlation_id'] === 'string' ? body['correlation_id'].trim() : '';
  if (!correlationId || !UUID_REGEX.test(correlationId)) {
    sendRequestError(
      req,
      res,
      400,
      'RECEIVING_BINDING_TOKEN_REQUIRED',
      'correlation_id (binding token) is required and must be a UUID',
    );
    return;
  }
  // Enforce site scope up front when the token resolves to a site; an unknown token falls through to
  // the seam's stable RECEIVING_BINDING_TOKEN_NOT_FOUND rejection.
  const siteId = await resolveSiteByToken(correlationId);
  if (siteId) assertSiteAccess(req, siteId, 'write');

  const actor = actorContext(req);
  const grnId =
    typeof body['grn_id'] === 'string' && UUID_REGEX.test(body['grn_id'])
      ? body['grn_id']
      : randomUUID();
  const grnLineId =
    typeof body['grn_line_id'] === 'string' && UUID_REGEX.test(body['grn_line_id'])
      ? body['grn_line_id']
      : randomUUID();
  const crossDockTaskId =
    body['cross_dock'] === true
      ? typeof body['cross_dock_task_id'] === 'string' &&
        UUID_REGEX.test(body['cross_dock_task_id'])
        ? body['cross_dock_task_id']
        : randomUUID()
      : undefined;

  // A client-supplied grn_id/grn_line_id must belong to a GRN this actor already has write access to
  // (idempotent replay of the caller's own receipt); otherwise it could target another site's record.
  const existingGrn = await getGrnById(grnId);
  if (existingGrn) assertSiteAccess(req, existingGrn.site_id, 'write');
  const existingLine = await getGrnLineById(grnLineId);
  if (existingLine) {
    const parentGrn = await getGrnById(existingLine.grn_id);
    if (parentGrn) assertSiteAccess(req, parentGrn.site_id, 'write');
  }

  const pool = getPool();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const persisted = await persistEvent(
      {
        stream_type: 'receiving',
        stream_id: grnId,
        event_type: 'goods.received',
        payload: {
          ...body,
          grn_id: grnId,
          grn_line_id: grnLineId,
          correlation_id: correlationId,
          ...(crossDockTaskId ? { cross_dock_task_id: crossDockTaskId } : {}),
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
    const crossDockTask = await getCrossDockTaskByGrnLine(grnLineId, client);
    await client.query('COMMIT');
    committed = true;
    // Pilot triage 2026-09-13: the applier derives erp_receipt_overlap_qty when the ERP's open_qty
    // implies more received than the frozen legacy figure (a platform GRN was recorded in the ERP
    // as well); it rides the stored event and is echoed here for the reconciliation trail.
    const overlap =
      typeof persisted.payload['erp_receipt_overlap_qty'] === 'string'
        ? { erp_receipt_overlap_qty: persisted.payload['erp_receipt_overlap_qty'] }
        : {};
    // AC5: an over-tolerance line is a committed business outcome, not a rollback - surface the code
    // in a 2xx body alongside the durable rejected line.
    if (line && line.status === 'rejected') {
      sendJson(res, 200, {
        grn,
        grn_line: line,
        error_code: 'RECEIPT_TOLERANCE_EXCEEDED',
        cross_dock_task: crossDockTask,
        cross_dock_nonqualification_reason: line.cross_dock_nonqualification_reason ?? null,
        ...overlap,
      });
      return;
    }
    sendJson(res, 201, {
      grn,
      grn_line: line,
      putaway_task: putaway,
      cross_dock_task: crossDockTask,
      cross_dock_nonqualification_reason: line?.cross_dock_nonqualification_reason ?? null,
      ...overlap,
    });
  } catch (err) {
    if (!committed) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const getGrnBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, RECEIVING_READ_ROLES, 'read');
  const grnId = params['grnId']?.toLowerCase();
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
    if (!site || site.status !== 'active' || site.level !== 'site')
      throw new AppError(
        404,
        'RECEIVING_SITE_NOT_FOUND',
        `No active site exists for "${siteCode}"`,
      );
    if (!scope.wildcard && !scope.locations.has(site.location_id))
      throw new AppError(
        403,
        'LOCATION_ACCESS_DENIED',
        `No read assignment grants access to site "${site.location_id}"`,
      );
    siteId = site.location_id;
  } else if (!scope.wildcard) {
    siteAny = [...scope.locations];
  }
  const rows = await listGrns({
    siteId,
    siteAny,
    poRefExt: poRef,
    status: status as 'open' | 'posted' | null,
  });
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
    if (!site || site.status !== 'active' || site.level !== 'site')
      throw new AppError(
        404,
        'RECEIVING_SITE_NOT_FOUND',
        `No active site exists for "${siteCode}"`,
      );
    if (!scope.wildcard && !scope.locations.has(site.location_id))
      throw new AppError(
        403,
        'LOCATION_ACCESS_DENIED',
        `No read assignment grants access to site "${site.location_id}"`,
      );
    siteId = site.location_id;
  } else if (!scope.wildcard) {
    siteAny = [...scope.locations];
  }
  const rows = await listDiscrepancyLines({ siteId, siteAny });
  sendJson(res, 200, { discrepancies: rows });
};

const releasePutawayTaskBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, PUTAWAY_RELEASE_ROLES, 'write');
  const putawayTaskId = params['putawayTaskId']?.toLowerCase();
  if (!putawayTaskId || !UUID_REGEX.test(putawayTaskId)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'putawayTaskId path parameter must be a UUID',
    );
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
    sendRequestError(
      req,
      res,
      404,
      'PUTAWAY_TASK_NOT_FOUND',
      `No putaway task exists for "${putawayTaskId}"`,
    );
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

export const createGrnLineHandler: RouteHandler = requireRole({
  module: 'receiving',
  functionScope: 'write',
})(createGrnLineBase);
export const getGrnHandler: RouteHandler = requireRole({
  module: 'receiving',
  functionScope: 'read',
})(getGrnBase);
export const listGrnsHandler: RouteHandler = requireRole({
  module: 'receiving',
  functionScope: 'read',
})(listGrnsBase);
export const listDiscrepanciesHandler: RouteHandler = requireRole({
  module: 'receiving',
  functionScope: 'read',
})(listDiscrepanciesBase);
export const releasePutawayTaskHandler: RouteHandler = requireRole({
  module: 'receiving',
  functionScope: 'write',
})(releasePutawayTaskBase);
