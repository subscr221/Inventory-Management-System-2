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
  getCycleCountById,
  getCycleCountLines,
  getCycleCountLineByAdjustment,
  listCycleCounts,
} from '../../read/projections/cycle_count.js';
import type { CycleCountHeaderRow, CycleCountLineRow } from '../../read/projections/cycle_count.js';
import {
  findMatchingDoaEntry,
  findRoleHolder,
  findActiveDelegation,
  listActiveDoaEntries,
} from '../../read/projections/doa_registry.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const COUNT_ADJUSTMENT_DOA_TYPE = 'inventory.count_adjustment';

// Story 2.6 suggested roles. requireRole enforces module+function scope; these narrow to named roles.
const CREATE_ROLES = ['inventory_controller', 'stock_locator', 'store_assistant', 'warehouse_manager'];
const APPROVE_ROLES = ['inventory_controller', 'warehouse_manager', 'finance_controller', 'audit_signoff'];

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

function assertWriteLocationAccess(req: IncomingMessage, locationId: string): void {
  const authContext = getAuthContext(req);
  if (!authContext) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  const { wildcard, locations } = permittedLocationsForModule(authContext.roles, 'inventory');
  if (!wildcard && !locations.has(locationId)) {
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No role assignment grants access to location "${locationId}"`);
  }
}

function assertReadLocationAccess(req: IncomingMessage, locationId: string): void {
  const authContext = getAuthContext(req);
  if (!authContext) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  const { wildcard, locations } = permittedLocationsForModule(authContext.roles, 'inventory');
  if (!wildcard && !locations.has(locationId)) {
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No role assignment grants access to location "${locationId}"`);
  }
}

/**
 * Resolves the DOA approver for a count adjustment banded on absolute variance value. Count
 * adjustments always require approval (they only exist because a variance breached tolerance), so a
 * missing band or absent approver fails closed with APPROVAL_UNRESOLVED - approver roles are never
 * hard-coded here (Task 5).
 */
async function resolveCountApprover(varianceValue: number): Promise<string> {
  const value = Math.abs(varianceValue);
  const doaEntry = await findMatchingDoaEntry(COUNT_ADJUSTMENT_DOA_TYPE, value);
  const today = new Date().toISOString().slice(0, 10);
  const tryHolder = async (role: string): Promise<string | null> => {
    const holder = await findRoleHolder(role);
    if (!holder) return null;
    const delegation = await findActiveDelegation(holder.user_id, today);
    return delegation?.delegate_user_id ?? holder.user_id;
  };

  let approver: string | null = null;
  if (doaEntry) {
    approver = await tryHolder(doaEntry.role);
  }
  if (!approver) {
    const entries = await listActiveDoaEntries(COUNT_ADJUSTMENT_DOA_TYPE);
    for (const e of entries) {
      if (doaEntry && e.role === doaEntry.role) continue;
      approver = await tryHolder(e.role);
      if (approver) break;
    }
  }
  if (!approver) {
    throw new AppError(409, 'APPROVAL_UNRESOLVED', 'Count adjustment requires approval but no active approver could be resolved', {
      transaction_type: COUNT_ADJUSTMENT_DOA_TYPE,
    });
  }
  return approver;
}

function headerToJson(header: CycleCountHeaderRow, lines: CycleCountLineRow[]): Record<string, unknown> {
  return {
    cycle_count_id: header.cycle_count_id,
    location_id: header.location_id,
    zone_id: header.zone_id,
    sku_scope: header.sku_scope,
    stock_class: header.stock_class,
    count_type: header.count_type,
    business_date: header.business_date,
    business_stream: header.business_stream,
    tolerance_percent: header.tolerance_percent,
    status: header.status,
    created_by_actor_id: header.created_by_actor_id,
    submitted_by_actor_id: header.submitted_by_actor_id,
    created_at: header.created_at,
    lines: lines.map((l) => ({
      sku: l.sku,
      lot_id: l.lot_id,
      stock_class: l.stock_class,
      counted_quantity: l.counted_quantity,
      book_quantity: l.book_quantity,
      allocated_quantity: l.allocated_quantity,
      in_transit_quantity: l.in_transit_quantity,
      variance_quantity: l.variance_quantity,
      variance_value: l.variance_value,
      tolerance_breach: l.tolerance_breach,
      adjustment_id: l.adjustment_id,
      adjustment_status: l.adjustment_status,
      approver_actor_id: l.approver_actor_id,
      reason_code: l.reason_code,
      applied_event_id: l.applied_event_id,
    })),
  };
}

// ---------------------------------------------------------------------------
// POST /api/v1/cycle-counts
// ---------------------------------------------------------------------------

const createCycleCountBase: RouteHandler = async (req, res) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }
  if (!isNonEmptyString(body['location_id']) || !UUID_REGEX.test(body['location_id'] as string)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'location_id is required and must be a UUID');
    return;
  }
  if (!Array.isArray(body['sku_scope']) || body['sku_scope'].length === 0 || !body['sku_scope'].every(isNonEmptyString)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'sku_scope is required and must be a non-empty array');
    return;
  }
  if (!isNonEmptyString(body['count_type'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'count_type is required');
    return;
  }
  if (typeof body['business_date'] !== 'string' || !DATE_REGEX.test(body['business_date'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'business_date is required and must be YYYY-MM-DD');
    return;
  }
  if (!isNonEmptyString(body['business_stream'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'business_stream is required');
    return;
  }

  const locationId = body['location_id'] as string;
  assertRoleAllowed(req, CREATE_ROLES);
  assertWriteLocationAccess(req, locationId);

  let cycleCountId: string;
  if (body['cycle_count_id'] !== undefined) {
    if (!isNonEmptyString(body['cycle_count_id']) || !UUID_REGEX.test(body['cycle_count_id'] as string)) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'cycle_count_id must be a valid UUID when supplied');
      return;
    }
    cycleCountId = body['cycle_count_id'] as string;
  } else {
    cycleCountId = randomUUID();
  }

  const actor = actorContext(req);
  const pool = getPool();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const existing = await getCycleCountById(cycleCountId, client);
    if (existing) {
      await client.query('COMMIT');
      committed = true;
      sendJson(res, 200, { cycle_count_id: existing.cycle_count_id, status: existing.status });
      return;
    }

    await persistEvent(
      {
        stream_type: 'inventory',
        stream_id: cycleCountId,
        event_type: 'cycle_count.task_created',
        payload: {
          cycle_count_id: cycleCountId,
          location_id: locationId,
          ...(body['zone_id'] ? { zone_id: body['zone_id'] } : {}),
          sku_scope: body['sku_scope'],
          ...(body['stock_class'] ? { stock_class: body['stock_class'] } : {}),
          count_type: body['count_type'],
          business_date: body['business_date'],
          business_stream: body['business_stream'],
          ...(body['tolerance_percent'] !== undefined ? { tolerance_percent: body['tolerance_percent'] } : {}),
          created_by_actor_id: actor.userId,
          ...(body['notes'] ? { notes: body['notes'] } : {}),
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
    sendJson(res, 201, { cycle_count_id: cycleCountId, status: 'open' });
  } catch (err) {
    if (!committed) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// POST /api/v1/cycle-counts/:cycle_count_id/submit
// ---------------------------------------------------------------------------

const submitCycleCountBase: RouteHandler = async (req, res, params) => {
  const id = params['cycle_count_id'];
  if (!id || !UUID_REGEX.test(id)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'cycle_count_id must be a valid UUID');
    return;
  }
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body || !Array.isArray(body['lines']) || body['lines'].length === 0) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'lines is required and must be a non-empty array');
    return;
  }
  const idempotencyKey = isNonEmptyString(body['idempotency_key']) ? (body['idempotency_key'] as string) : undefined;

  assertRoleAllowed(req, CREATE_ROLES);
  const actor = actorContext(req);
  const pool = getPool();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const header = await getCycleCountById(id, client, true);
    if (!header) {
      throw new AppError(404, 'NOT_FOUND', `Cycle count "${id}" not found`);
    }
    assertWriteLocationAccess(req, header.location_id);

    // Idempotent short-circuit for an already-submitted count.
    if (header.status !== 'open') {
      const lines = await getCycleCountLines(id, client);
      await client.query('COMMIT');
      committed = true;
      sendJson(res, 200, headerToJson(header, lines));
      return;
    }

    await persistEvent(
      {
        stream_type: 'inventory',
        stream_id: id,
        event_type: 'cycle_count.submitted',
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
        payload: {
          cycle_count_id: id,
          lines: body['lines'],
          submitted_by_actor_id: actor.userId,
          submitted_at: new Date().toISOString(),
          business_date: header.business_date,
          business_stream: header.business_stream,
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

    const lines = await getCycleCountLines(id, client);
    const finalHeader = await getCycleCountById(id, client);
    await client.query('COMMIT');
    committed = true;
    sendJson(res, 201, headerToJson(finalHeader ?? header, lines));
  } catch (err) {
    if (!committed) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/v1/cycle-counts/:cycle_count_id/adjustments/:adjustment_id/approve
// ---------------------------------------------------------------------------

const approveAdjustmentBase: RouteHandler = async (req, res, params) => {
  const id = params['cycle_count_id'];
  const adjustmentId = params['adjustment_id'];
  if (!id || !UUID_REGEX.test(id) || !adjustmentId || !UUID_REGEX.test(adjustmentId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'cycle_count_id and adjustment_id must be valid UUIDs');
    return;
  }
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body || !isNonEmptyString(body['reason_code'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'reason_code is required');
    return;
  }
  const reasonCode = body['reason_code'] as string;

  assertRoleAllowed(req, APPROVE_ROLES);
  const actor = actorContext(req);
  const pool = getPool();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const line = await getCycleCountLineByAdjustment(adjustmentId, client, true);
    if (!line || line.cycle_count_id !== id) {
      throw new AppError(404, 'NOT_FOUND', `No adjustment "${adjustmentId}" found for cycle count "${id}"`);
    }
    const header = await getCycleCountById(id, client);
    if (!header) {
      throw new AppError(404, 'NOT_FOUND', `Cycle count "${id}" not found`);
    }
    assertWriteLocationAccess(req, header.location_id);

    if (line.adjustment_status !== 'pending_approval') {
      throw new AppError(400, 'INVALID_STATE', `Adjustment is in status "${line.adjustment_status}", expected "pending_approval"`);
    }

    // Segregation of duties (Task 5): the count submitter must not approve.
    if (header.submitted_by_actor_id && header.submitted_by_actor_id === actor.userId) {
      throw new AppError(403, 'COUNT_ENTERER_CANNOT_APPROVE', 'The count submitter cannot approve its own adjustment');
    }

    // DOA authority: the caller must be the resolved approver for this variance value (Task 5).
    const resolvedApprover = await resolveCountApprover(line.variance_value);
    if (resolvedApprover !== actor.userId) {
      throw new AppError(403, 'APPROVAL_REQUIRED', 'Caller is not the resolved approver for this adjustment', {
        approver_actor_id: resolvedApprover,
        caller_user_id: actor.userId,
      });
    }

    // Record the approval, then apply the stock adjustment (both events, one transaction). The
    // stock.adjusted seam re-checks that the adjustment is approved before mutating stock.
    await persistEvent(
      {
        stream_type: 'inventory',
        stream_id: id,
        event_type: 'cycle_count.adjustment_approved',
        payload: {
          adjustment_id: adjustmentId,
          cycle_count_id: id,
          approver_actor_id: actor.userId,
          reason_code: reasonCode,
          approved_at: new Date().toISOString(),
          business_stream: header.business_stream,
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

    await persistEvent(
      {
        stream_type: 'inventory',
        stream_id: id,
        event_type: 'stock.adjusted',
        payload: {
          adjustment_id: adjustmentId,
          cycle_count_id: id,
          sku: line.sku,
          target_location_id: header.location_id,
          ...(line.lot_id ? { lot_id: line.lot_id } : {}),
          stock_class: line.stock_class,
          delta_quantity: line.variance_quantity,
          variance_value: line.variance_value,
          reason_code: reasonCode,
          approver_actor_id: actor.userId,
          business_stream: header.business_stream,
          // Count adjustments are not placements; skip the zone-compatibility two-step.
          placement_confirmed: true,
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
    sendJson(res, 200, {
      cycle_count_id: id,
      adjustment_id: adjustmentId,
      status: 'applied',
      delta_quantity: line.variance_quantity,
      approved_by: actor.userId,
      reason_code: reasonCode,
    });
  } catch (err) {
    if (!committed) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/v1/cycle-counts/:cycle_count_id/adjustments/:adjustment_id/reject
// ---------------------------------------------------------------------------

const rejectAdjustmentBase: RouteHandler = async (req, res, params) => {
  const id = params['cycle_count_id'];
  const adjustmentId = params['adjustment_id'];
  if (!id || !UUID_REGEX.test(id) || !adjustmentId || !UUID_REGEX.test(adjustmentId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'cycle_count_id and adjustment_id must be valid UUIDs');
    return;
  }
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body || !isNonEmptyString(body['reason_code'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'reason_code is required');
    return;
  }
  const reasonCode = body['reason_code'] as string;

  assertRoleAllowed(req, APPROVE_ROLES);
  const actor = actorContext(req);
  const pool = getPool();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const line = await getCycleCountLineByAdjustment(adjustmentId, client, true);
    if (!line || line.cycle_count_id !== id) {
      throw new AppError(404, 'NOT_FOUND', `No adjustment "${adjustmentId}" found for cycle count "${id}"`);
    }
    const header = await getCycleCountById(id, client);
    if (!header) {
      throw new AppError(404, 'NOT_FOUND', `Cycle count "${id}" not found`);
    }
    assertWriteLocationAccess(req, header.location_id);

    if (line.adjustment_status !== 'pending_approval') {
      throw new AppError(400, 'INVALID_STATE', `Adjustment is in status "${line.adjustment_status}", expected "pending_approval"`);
    }
    if (header.submitted_by_actor_id && header.submitted_by_actor_id === actor.userId) {
      throw new AppError(403, 'COUNT_ENTERER_CANNOT_APPROVE', 'The count submitter cannot decide its own adjustment');
    }

    await persistEvent(
      {
        stream_type: 'inventory',
        stream_id: id,
        event_type: 'cycle_count.adjustment_rejected',
        payload: {
          adjustment_id: adjustmentId,
          cycle_count_id: id,
          approver_actor_id: actor.userId,
          reason_code: reasonCode,
          rejected_at: new Date().toISOString(),
          business_stream: header.business_stream,
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
    sendJson(res, 200, { cycle_count_id: id, adjustment_id: adjustmentId, status: 'rejected', reason_code: reasonCode });
  } catch (err) {
    if (!committed) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/cycle-counts/:cycle_count_id
// ---------------------------------------------------------------------------

const getCycleCountBase: RouteHandler = async (req, res, params) => {
  const id = params['cycle_count_id'];
  if (!id || !UUID_REGEX.test(id)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'cycle_count_id must be a valid UUID');
    return;
  }
  const header = await getCycleCountById(id);
  if (!header) {
    sendRequestError(req, res, 404, 'NOT_FOUND', `Cycle count "${id}" not found`);
    return;
  }
  assertReadLocationAccess(req, header.location_id);
  const lines = await getCycleCountLines(id);
  sendJson(res, 200, headerToJson(header, lines));
};

// ---------------------------------------------------------------------------
// GET /api/v1/cycle-counts
// ---------------------------------------------------------------------------

const listCycleCountsBase: RouteHandler = async (req, res) => {
  const authContext = getAuthContext(req);
  if (!authContext) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const locationId = url.searchParams.get('location_id');
  const zoneId = url.searchParams.get('zone_id');
  const status = url.searchParams.get('status');
  const fromDate = url.searchParams.get('from_date');
  const toDate = url.searchParams.get('to_date');
  const sku = url.searchParams.get('sku');

  const { wildcard, locations } = permittedLocationsForModule(authContext.roles, 'inventory');
  let locationAny: string[] | null = null;
  if (!wildcard) {
    if (locationId && !locations.has(locationId)) {
      sendRequestError(req, res, 403, 'LOCATION_ACCESS_DENIED', 'No access to the specified location_id');
      return;
    }
    if (!locationId) locationAny = [...locations];
  }

  const rows = await listCycleCounts({
    location_id: locationId,
    location_any: locationAny,
    status,
    from_date: fromDate,
    to_date: toDate,
    sku,
  });
  const filtered = zoneId ? rows.filter((r) => r.zone_id === zoneId) : rows;
  sendJson(res, 200, filtered.map((r) => headerToJson(r, [])));
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const createCycleCountHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(createCycleCountBase);
export const submitCycleCountHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(submitCycleCountBase);
export const approveAdjustmentHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(approveAdjustmentBase);
export const rejectAdjustmentHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(rejectAdjustmentBase);
export const getCycleCountHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read' })(getCycleCountBase);
export const listCycleCountsHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read' })(listCycleCountsBase);
