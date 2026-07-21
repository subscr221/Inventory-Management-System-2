import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getParsedBody, getAuthContext, getAuthorizedAssignment, getTraceId } from '../../middleware/context.js';
import { requireRole, permittedLocationsForModule } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getPool } from '../../config/db.js';
import {
  getPhysicalVerificationById,
  listPhysicalVerifications,
  getPhysicalVerificationLines,
} from '../../read/projections/physical_verification.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const COMPLETE_ROLES = ['inventory_controller', 'warehouse_manager', 'stock_locator'];
const SIGNOFF_ROLES = ['inventory_controller', 'warehouse_manager', 'finance_controller', 'audit_signoff'];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function localYmd(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

function assertRoleAllowed(req: IncomingMessage, allowedRoles: string[]): void {
  const authContext = getAuthContext(req);
  const roles = authContext?.roles ?? [];
  const ok = roles.some(
    (r) => (r.module === 'inventory' || r.module === '*') && r.functionScope === 'write' && allowedRoles.includes(r.role),
  );
  if (!ok) {
    throw new AppError(403, 'FUNCTION_ACCESS_DENIED', `This operation is restricted to roles: ${allowedRoles.join(', ')}`);
  }
}

function assertLocationAccess(req: IncomingMessage, locationId: string): void {
  const authContext = getAuthContext(req);
  if (!authContext) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  const { wildcard, locations } = permittedLocationsForModule(authContext.roles, 'inventory');
  if (!wildcard && !locations.has(locationId)) {
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No role assignment grants access to location "${locationId}"`);
  }
}

// ---------------------------------------------------------------------------
// POST /api/v1/physical-verifications  (record completion + snapshot evidence)
// ---------------------------------------------------------------------------

const completePhysicalVerificationBase: RouteHandler = async (req, res) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }
  if (!isNonEmptyString(body['location_id']) || !UUID_REGEX.test(body['location_id'] as string)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'location_id is required and must be a UUID');
    return;
  }
  if (!Array.isArray(body['count_refs']) || body['count_refs'].length === 0 || !body['count_refs'].every(isNonEmptyString)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'count_refs is required and must be a non-empty array');
    return;
  }
  if (!isNonEmptyString(body['business_stream'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'business_stream is required');
    return;
  }
  if (body['business_date'] !== undefined && (typeof body['business_date'] !== 'string' || !DATE_REGEX.test(body['business_date'] as string))) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'business_date must be YYYY-MM-DD when supplied');
    return;
  }

  const locationId = body['location_id'] as string;
  assertRoleAllowed(req, COMPLETE_ROLES);
  assertLocationAccess(req, locationId);

  let pvId: string;
  if (body['physical_verification_id'] !== undefined) {
    if (!isNonEmptyString(body['physical_verification_id']) || !UUID_REGEX.test(body['physical_verification_id'] as string)) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'physical_verification_id must be a valid UUID when supplied');
      return;
    }
    pvId = body['physical_verification_id'] as string;
  } else {
    pvId = randomUUID();
  }

  const actor = actorContext(req);
  const pool = getPool();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const existing = await getPhysicalVerificationById(pvId, client);
    if (existing) {
      await client.query('COMMIT');
      committed = true;
      sendJson(res, 200, { physical_verification_id: pvId, status: existing.period_locked ? 'signed_off' : 'completed' });
      return;
    }

    await persistEvent(
      {
        stream_type: 'inventory',
        stream_id: pvId,
        event_type: 'physical_verification.completed',
        payload: {
          physical_verification_id: pvId,
          location_id: locationId,
          coverage_percentage: body['coverage_percentage'] ?? 0,
          ...(body['period_start'] ? { period_start: body['period_start'] } : {}),
          ...(body['period_end'] ? { period_end: body['period_end'] } : {}),
          count_refs: body['count_refs'],
          completed_by_actor_id: actor.userId,
          business_date: body['business_date'] ?? localYmd(),
          business_stream: body['business_stream'],
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: new Date().toISOString(),
        },
      },
      auditCtxFor(req, actor, 201),
      client,
    );
    await client.query('COMMIT');
    committed = true;
    sendJson(res, 201, { physical_verification_id: pvId, status: 'completed' });
  } catch (err) {
    if (!committed) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// POST /api/v1/physical-verifications/:physical_verification_id/sign-off
// ---------------------------------------------------------------------------

const signOffPhysicalVerificationBase: RouteHandler = async (req, res, params) => {
  const id = params['physical_verification_id'];
  if (!id || !UUID_REGEX.test(id)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'physical_verification_id must be a valid UUID');
    return;
  }
  const body = getParsedBody(req) as Record<string, unknown> | undefined;

  assertRoleAllowed(req, SIGNOFF_ROLES);
  const actor = actorContext(req);
  const pool = getPool();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const header = await getPhysicalVerificationById(id, client, true);
    if (!header) {
      throw new AppError(404, 'NOT_FOUND', `Physical verification "${id}" not found`);
    }
    assertLocationAccess(req, header.location_id);
    if (header.period_locked || header.signed_off_at) {
      throw new AppError(409, 'PERIOD_LOCKED', 'Physical verification is already signed off and locked', {
        physical_verification_id: id,
      });
    }

    await persistEvent(
      {
        stream_type: 'inventory',
        stream_id: id,
        event_type: 'physical_verification.signed_off',
        payload: {
          physical_verification_id: id,
          management_signoff_actor_id: actor.userId,
          signed_off_at: new Date().toISOString(),
          business_date: body?.['business_date'] ?? header.business_date ?? localYmd(),
          business_stream: (body?.['business_stream'] as string) ?? 'production',
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
    await client.query('COMMIT');
    committed = true;
    sendJson(res, 200, { physical_verification_id: id, status: 'signed_off', management_signoff_actor_id: actor.userId });
  } catch (err) {
    if (!committed) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/physical-verification/report
// ---------------------------------------------------------------------------

const physicalVerificationReportBase: RouteHandler = async (req, res) => {
  const authContext = getAuthContext(req);
  if (!authContext) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const locationId = url.searchParams.get('location_id');
  const fromDate = url.searchParams.get('from_date');
  const toDate = url.searchParams.get('to_date');
  const status = url.searchParams.get('status');

  const { wildcard, locations } = permittedLocationsForModule(authContext.roles, 'inventory');
  let locationAny: string[] | null = null;
  if (!wildcard) {
    if (locationId && !locations.has(locationId)) {
      sendRequestError(req, res, 403, 'LOCATION_ACCESS_DENIED', 'No access to the specified location_id');
      return;
    }
    if (!locationId) locationAny = [...locations];
  }

  const headers = await listPhysicalVerifications({
    location_id: locationId,
    location_any: locationAny,
    from_date: fromDate,
    to_date: toDate,
    status,
  });

  const reports = [];
  for (const h of headers) {
    const lines = await getPhysicalVerificationLines(h.physical_verification_id);
    reports.push({
      physical_verification_id: h.physical_verification_id,
      location_id: h.location_id,
      count_date: h.business_date,
      period_start: h.period_start,
      period_end: h.period_end,
      coverage_percentage: h.coverage_percentage,
      counter_actor_id: h.completed_by_actor_id,
      management_signoff_actor_id: h.management_signoff_actor_id,
      management_signoff_status: h.signed_off_at ? 'signed_off' : 'pending',
      signed_off_at: h.signed_off_at,
      period_locked: h.period_locked,
      lines: lines.map((l) => ({
        cycle_count_id: l.cycle_count_id,
        count_date: l.count_date,
        sku: l.sku,
        lot_id: l.lot_id,
        stock_class: l.stock_class,
        book_quantity: l.book_quantity,
        counted_quantity: l.counted_quantity,
        variance_quantity: l.variance_quantity,
        variance_value: l.variance_value,
        adjustment_event_ref: l.adjustment_event_ref,
        counter_actor_id: l.counter_actor_id,
        approver_actor_id: l.approver_actor_id,
      })),
    });
  }

  sendJson(res, 200, { reports });
};

export const completePhysicalVerificationHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(completePhysicalVerificationBase);
export const signOffPhysicalVerificationHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(signOffPhysicalVerificationBase);
export const physicalVerificationReportHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read' })(physicalVerificationReportBase);
