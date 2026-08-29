import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import {
  getAuthContext,
  getAuthorizedAssignment,
  getParsedBody,
  getTraceId,
} from '../../middleware/context.js';
import { permittedLocationsForModuleScope, requireRole } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { PersistedEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { logAuditEntry } from '../../read/projections/audit_log.js';
import { getPool } from '../../config/db.js';
import { isValidCalendarDate } from '../../lib/business-days.js';
import {
  CONDITIONAL_RELEASE_DOA_TYPE,
  INSPECTION_PLAN_APPROVAL_DOA_TYPE,
  INSPECTION_PLAN_APPROVED,
  INSPECTION_PLAN_CREATED,
  QC_CONDITIONAL_RELEASE_RECORDED,
  resolveInspectionPlanForLot,
  resolveQcAuthority,
} from '../../compliance/quality.js';
import { receiveQcCompletion } from '../../quality/completion.js';
import {
  getInspectionPlanByGrain,
  getInspectionPlanById,
  getInspectionPlanVersionById,
  listInspectionPlanCharacteristics,
  listInspectionPlanVersions,
  listInspectionPlans,
} from '../../read/projections/inspection_plan.js';
import type { InspectionPlanScope } from '../../read/projections/inspection_plan.js';
import { getInspectionPlanApproval } from '../../read/projections/inspection_plan_approval.js';
import {
  getQcInspectionTaskById,
  listQcInspectionTasks,
} from '../../read/projections/qc_inspection_task.js';
import type { QcGateStatus } from '../../read/projections/qc_inspection_task.js';
import { getConditionalReleaseForLot } from '../../read/projections/qc_lot_disposition.js';

/**
 * Story 8.1 REST surface for inspection plans and the QC gate (FR-Q-01, FR-Q-02, FR-Q-05). Module
 * `qc` on every route (the legacy `quality` module of the Story 2.3 lot-hold routes is untouched).
 * Every handler is a thin shell: shape checks that make a 400 cheap, a DOA PRE-check that turns
 * an unauthorized attempt into an audited 403 before persistEvent, then persistEvent - the seam in
 * src/compliance/quality.ts re-derives every security-sensitive fact under lock (AD-12).
 *
 * Plan routes are enterprise-scoped master data (no site dimension). The synthetic completion
 * route resolves its location from the body's site_id for RBAC; conditional release checks the
 * task's site against the caller's write scope inside the handler (the task must be read first).
 */

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO8601_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const GATE_STATUSES = new Set(['qc_hold', 'conditionally_released']);
const PLAN_SCOPES = new Set(['standard', 'customer_override']);

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
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

function sendAppError(req: IncomingMessage, res: Parameters<RouteHandler>[1], err: unknown): void {
  if (err instanceof AppError) {
    sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
    return;
  }
  throw err;
}

function idempotencyKeyFrom(body: Record<string, unknown>): string {
  return typeof body['idempotency_key'] === 'string' && body['idempotency_key'].trim() !== ''
    ? body['idempotency_key']
    : randomUUID();
}

/**
 * persistEvent returns ANY event already holding this idempotency key. A legitimate replay is the
 * same event type carrying the same id field; anything else is a reused key (the Story 7.1 lesson).
 */
function replayIdOrReject(
  persisted: PersistedEvent,
  expectedEventType: string,
  idField: string,
): string {
  const value = (persisted.payload as Record<string, unknown> | undefined)?.[idField];
  if (persisted.event_type !== expectedEventType || !isUuid(value)) {
    throw new AppError(
      409,
      'DUPLICATE_EVENT',
      'This idempotency key is already in use by a different event',
      {
        existing_event_id: persisted.event_id,
        existing_event_type: persisted.event_type,
      },
    );
  }
  return value;
}

/**
 * AC 5: a rejected unauthorized attempt is recorded in the statutory audit log with the
 * authenticated actor, the object, the endpoint, the trace id and the error code. The rejection
 * never reaches persistEvent (or was rolled back by it), so the row is written on a dedicated
 * pool client (the gate.ts / production-orders precedent) before the 403 is sent.
 */
async function auditRejectedAttempt(
  req: IncomingMessage,
  actor: ActorContext,
  err: AppError,
  details: Record<string, unknown>,
): Promise<void> {
  const auditClient = await getPool().connect();
  try {
    await logAuditEntry(auditClient, {
      ...auditCtxFor(req, actor, err.statusCode),
      event_id: null,
      error_code: err.errorCode,
      details: { ...details, ...err.details },
    });
  } finally {
    auditClient.release();
  }
}

const AUDITED_REJECTIONS = new Set(['APPROVAL_REQUIRED', 'APPROVAL_UNRESOLVED', 'SOD_VIOLATION']);

function requireBody(
  req: IncomingMessage,
  res: Parameters<RouteHandler>[1],
): Record<string, unknown> | null {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return null;
  }
  return body;
}

function requireUuidParam(params: Record<string, string> | undefined, name: string): string {
  const value = params?.[name];
  if (!value || !isUuid(value)) {
    throw new AppError(400, 'INVALID_PARAMS', `${name} must be a UUID`, { [name]: value ?? null });
  }
  return value;
}

function optionalNullableString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new AppError(400, 'INVALID_PARAMS', `${field} must be a string or null`, {
      [field]: value,
    });
  }
  return value;
}

// ---------------------------------------------------------------------------
// Inspection plans (FR-Q-01)
// ---------------------------------------------------------------------------

const createInspectionPlanBase: RouteHandler = async (req, res, _params) => {
  const body = requireBody(req, res);
  if (!body) return;
  const actor = actorContext(req);
  const now = new Date().toISOString();

  try {
    if (!isUuid(body['item_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'item_id must be a UUID');
    }
    if (!isUuid(body['bom_revision_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'bom_revision_id must be a UUID');
    }
    const scope = body['scope'] ?? 'standard';
    if (typeof scope !== 'string' || !PLAN_SCOPES.has(scope)) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'scope must be one of: standard, customer_override',
        {
          scope,
        },
      );
    }
    const sourceOrderType = optionalNullableString(body, 'source_order_type');
    const sourceOrderRef = optionalNullableString(body, 'source_order_ref');
    if (scope === 'customer_override' && sourceOrderType !== 'job_work_order') {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'A customer override requires source_order_type job_work_order and a source_order_ref',
      );
    }
    if (
      typeof body['effective_from'] !== 'string' ||
      !isValidCalendarDate(body['effective_from'])
    ) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'effective_from must be a YYYY-MM-DD calendar date',
      );
    }
    if (!Array.isArray(body['characteristics']) || body['characteristics'].length === 0) {
      throw new AppError(400, 'INVALID_PARAMS', 'characteristics must be a non-empty array');
    }
    if (body['plan_id'] !== undefined && !isUuid(body['plan_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'plan_id must be a UUID when supplied');
    }

    // The header grain is looked up so a second version of an existing plan re-uses its plan_id
    // without the client having to know it; the seam re-checks the grain under lock.
    let planId = body['plan_id'] as string | undefined;
    if (!planId) {
      const existing = await getInspectionPlanByGrain({
        item_id: body['item_id'],
        bom_revision_id: body['bom_revision_id'],
        scope: scope as InspectionPlanScope,
        source_order_type: (sourceOrderType as 'job_work_order' | null) ?? null,
        source_order_ref: sourceOrderRef,
      });
      planId = existing?.plan_id ?? randomUUID();
    }
    const planVersionId = randomUUID();
    const characteristics = (body['characteristics'] as unknown[]).map((raw, index) => {
      const c =
        typeof raw === 'object' && raw !== null && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      return {
        characteristic_id: isUuid(c['characteristic_id']) ? c['characteristic_id'] : randomUUID(),
        line_no: c['line_no'] ?? index + 1,
        characteristic_name: c['characteristic_name'],
        characteristic_class: c['characteristic_class'],
        test_method_ref: c['test_method_ref'],
        instrument_type: c['instrument_type'] ?? null,
        result_kind: c['result_kind'],
        lower_limit: c['lower_limit'] ?? null,
        upper_limit: c['upper_limit'] ?? null,
        limit_uom: c['limit_uom'] ?? null,
        acceptance_criteria: c['acceptance_criteria'] ?? null,
        sample_handling: c['sample_handling'],
      };
    });

    const persisted = await persistEvent(
      {
        stream_type: 'qc',
        stream_id: planId,
        event_type: INSPECTION_PLAN_CREATED,
        payload: {
          plan_id: planId,
          plan_version_id: planVersionId,
          scope,
          item_id: body['item_id'],
          bom_revision_id: body['bom_revision_id'],
          source_order_type: sourceOrderType,
          source_order_ref: sourceOrderRef,
          effective_from: body['effective_from'],
          aql: body['aql'] ?? null,
          inspection_level: body['inspection_level'] ?? null,
          characteristics,
          created_at: now,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: now,
        },
        idempotency_key: idempotencyKeyFrom(body),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );

    const persistedVersionId = replayIdOrReject(
      persisted,
      INSPECTION_PLAN_CREATED,
      'plan_version_id',
    );
    const version = await getInspectionPlanVersionById(persistedVersionId);
    const plan = version ? await getInspectionPlanById(version.plan_id) : null;
    const lines = await listInspectionPlanCharacteristics(persistedVersionId);
    sendJson(res, 201, {
      event_id: persisted.event_id,
      plan: plan ?? null,
      version: version ?? null,
      characteristics: lines,
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const listInspectionPlansBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const itemId = url.searchParams.get('item_id');
  const bomRevisionId = url.searchParams.get('bom_revision_id');
  const scope = url.searchParams.get('scope');
  const sourceOrderRef = url.searchParams.get('source_order_ref');
  const limitRaw = url.searchParams.get('limit');
  const offsetRaw = url.searchParams.get('offset');
  if (itemId !== null && !isUuid(itemId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'item_id must be a UUID');
    return;
  }
  if (bomRevisionId !== null && !isUuid(bomRevisionId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'bom_revision_id must be a UUID');
    return;
  }
  if (scope !== null && !PLAN_SCOPES.has(scope)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'scope must be one of: standard, customer_override',
    );
    return;
  }
  if (
    (limitRaw !== null && !/^\d+$/.test(limitRaw)) ||
    (offsetRaw !== null && !/^\d+$/.test(offsetRaw))
  ) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'limit and offset must be non-negative integers');
    return;
  }
  const plans = await listInspectionPlans({
    item_id: itemId ?? undefined,
    bom_revision_id: bomRevisionId ?? undefined,
    scope: (scope as InspectionPlanScope | null) ?? undefined,
    source_order_ref: sourceOrderRef ?? undefined,
    limit: limitRaw === null ? undefined : Number(limitRaw),
    offset: offsetRaw === null ? undefined : Number(offsetRaw),
  });
  sendJson(res, 200, { plans });
};

const resolveInspectionPlanBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const itemId = url.searchParams.get('item_id');
  const bomRevisionId = url.searchParams.get('bom_revision_id');
  const businessDate = url.searchParams.get('business_date');
  const sourceOrderType = url.searchParams.get('source_order_type');
  const sourceOrderRef = url.searchParams.get('source_order_ref');
  try {
    if (!isUuid(itemId)) throw new AppError(400, 'INVALID_PARAMS', 'item_id must be a UUID');
    if (!isUuid(bomRevisionId)) {
      throw new AppError(400, 'INVALID_PARAMS', 'bom_revision_id must be a UUID');
    }
    if (businessDate === null || !isValidCalendarDate(businessDate)) {
      throw new AppError(400, 'INVALID_PARAMS', 'business_date must be a YYYY-MM-DD calendar date');
    }
    if (sourceOrderType !== null && sourceOrderType !== 'job_work_order') {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'source_order_type must be job_work_order when supplied',
      );
    }
    if (sourceOrderType === 'job_work_order' && (sourceOrderRef === null || sourceOrderRef.trim() === '')) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'source_order_ref is required when source_order_type is job_work_order',
      );
    }
    const resolved = await resolveInspectionPlanForLot({
      item_id: itemId,
      bom_revision_id: bomRevisionId,
      source_order_type: sourceOrderType === 'job_work_order' ? 'job_work_order' : null,
      source_order_ref: sourceOrderType === 'job_work_order' ? sourceOrderRef : null,
      business_date: businessDate,
    });
    const characteristics = await listInspectionPlanCharacteristics(
      resolved.version.plan_version_id,
    );
    sendJson(res, 200, {
      scope: resolved.scope,
      plan: resolved.plan,
      version: resolved.version,
      characteristics,
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const getInspectionPlanBase: RouteHandler = async (req, res, params) => {
  try {
    const planId = requireUuidParam(params, 'planId');
    const plan = await getInspectionPlanById(planId);
    if (!plan) {
      throw new AppError(404, 'INSPECTION_PLAN_NOT_FOUND', 'Inspection plan not found', {
        plan_id: planId,
      });
    }
    const versions = await listInspectionPlanVersions(planId);
    sendJson(res, 200, { plan, versions });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const getInspectionPlanVersionBase: RouteHandler = async (req, res, params) => {
  try {
    const planId = requireUuidParam(params, 'planId');
    const planVersionId = requireUuidParam(params, 'planVersionId');
    const version = await getInspectionPlanVersionById(planVersionId);
    if (!version || version.plan_id !== planId) {
      throw new AppError(404, 'INSPECTION_PLAN_NOT_FOUND', 'Inspection plan version not found', {
        plan_id: planId,
        plan_version_id: planVersionId,
      });
    }
    const characteristics = await listInspectionPlanCharacteristics(planVersionId);
    const approval = await getInspectionPlanApproval(planVersionId);
    sendJson(res, 200, { version, characteristics, approval });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const approveInspectionPlanBase: RouteHandler = async (req, res, params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);
  const now = new Date().toISOString();
  let planId = '';
  let planVersionId = '';
  try {
    planId = requireUuidParam(params, 'planId');
    planVersionId = requireUuidParam(params, 'planVersionId');
    const version = await getInspectionPlanVersionById(planVersionId);
    if (!version || version.plan_id !== planId) {
      throw new AppError(404, 'INSPECTION_PLAN_NOT_FOUND', 'Inspection plan version not found', {
        plan_id: planId,
        plan_version_id: planVersionId,
      });
    }

    // DOA pre-check (AD-3): the 403 is a business rule raised AFTER the RBAC wrapper. The seam
    // re-derives the same authority under lock; this pre-check only makes the audited rejection
    // cheap and never replaces the in-transaction check.
    const authority = await resolveQcAuthority(INSPECTION_PLAN_APPROVAL_DOA_TYPE, {
      requireQcHead: true,
    });
    if (authority.approver_user_id !== actor.userId) {
      throw new AppError(
        403,
        'APPROVAL_REQUIRED',
        'Approving an inspection plan requires the resolved QC Head-level DOA approver',
        {
          plan_version_id: planVersionId,
          resolved_approver_user_id: authority.approver_user_id,
          governing_role: authority.governing_role,
        },
      );
    }

    const persisted = await persistEvent(
      {
        stream_type: 'qc',
        stream_id: planId,
        event_type: INSPECTION_PLAN_APPROVED,
        payload: { plan_id: planId, plan_version_id: planVersionId, approved_at: now },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: now,
        },
        idempotency_key: idempotencyKeyFrom(body),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 200),
    );
    const persistedVersionId = replayIdOrReject(
      persisted,
      INSPECTION_PLAN_APPROVED,
      'plan_version_id',
    );
    const approval = await getInspectionPlanApproval(persistedVersionId);
    const refreshed = await getInspectionPlanVersionById(persistedVersionId);
    sendJson(res, 200, { event_id: persisted.event_id, version: refreshed, approval });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditRejectedAttempt(req, actor, err, {
        plan_id: planId,
        plan_version_id: planVersionId,
      });
    }
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// Synthetic completion submission (FR-Q-02, Task 5)
// ---------------------------------------------------------------------------

/**
 * The synthetic conforming producer: a central-only route that invokes the hand-off contract for a
 * lot and finished stock that ALREADY exist (created by a test fixture or an operator's migration
 * script inside their own transaction). It creates no lot and posts no stock; a hand-off whose lot
 * or stock is missing rejects QC_HOLD_REQUIRED exactly as it would for a real producer.
 */
const submitSyntheticCompletionBase: RouteHandler = async (req, res, _params) => {
  const body = requireBody(req, res);
  if (!body) return;
  const actor = actorContext(req);
  try {
    if (body['source_completion_type'] !== 'synthetic_completion') {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'This route accepts source_completion_type synthetic_completion only; producers invoke the hand-off contract directly',
        { source_completion_type: body['source_completion_type'] ?? null },
      );
    }
    for (const field of [
      'source_completion_id',
      'lot_id',
      'item_id',
      'site_id',
      'bom_revision_id',
    ]) {
      if (!isUuid(body[field]))
        throw new AppError(400, 'INVALID_PARAMS', `${field} must be a UUID`);
    }
    for (const field of ['lot_number', 'quantity', 'uom', 'business_stream']) {
      if (typeof body[field] !== 'string' || body[field].trim() === '') {
        throw new AppError(400, 'INVALID_PARAMS', `${field} must be a non-empty string`);
      }
    }
    if (
      typeof body['completed_at'] !== 'string' ||
      !ISO8601_TIMESTAMP_REGEX.test(body['completed_at'])
    ) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'completed_at must be an ISO 8601 timestamp with an explicit offset',
      );
    }
    const sourceOrderType = optionalNullableString(body, 'source_order_type');
    const sourceOrderRef = optionalNullableString(body, 'source_order_ref');
    if (sourceOrderType !== null && sourceOrderType !== 'job_work_order') {
      throw new AppError(400, 'INVALID_PARAMS', 'source_order_type must be null or job_work_order');
    }

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const result = await receiveQcCompletion(
        {
          source_completion_type: 'synthetic_completion',
          source_completion_id: body['source_completion_id'] as string,
          lot_id: body['lot_id'] as string,
          lot_number: (body['lot_number'] as string).trim(),
          item_id: body['item_id'] as string,
          quantity: (body['quantity'] as string).trim(),
          uom: (body['uom'] as string).trim(),
          site_id: body['site_id'] as string,
          bom_revision_id: body['bom_revision_id'] as string,
          completed_at: body['completed_at'] as string,
          business_stream: (body['business_stream'] as string).trim(),
          source_order_type: (sourceOrderType as 'job_work_order' | null) ?? null,
          source_order_ref: sourceOrderRef,
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          idempotency_key: idempotencyKeyFrom(body),
        },
        client,
        auditCtxFor(req, actor, 201),
      );
      await client.query('COMMIT');
      sendJson(res, result.replayed ? 200 : 201, {
        event_id: result.event.event_id,
        task: result.task,
      });
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// Tasks and conditional release (FR-Q-02, FR-Q-05)
// ---------------------------------------------------------------------------

const listTasksBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const gateStatus = url.searchParams.get('gate_status');
  const siteId = url.searchParams.get('site_id');
  const sku = url.searchParams.get('sku');
  const limitRaw = url.searchParams.get('limit');
  const offsetRaw = url.searchParams.get('offset');
  if (gateStatus !== null && !GATE_STATUSES.has(gateStatus)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'gate_status must be one of: qc_hold, conditionally_released',
    );
    return;
  }
  if (siteId !== null && !isUuid(siteId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'site_id must be a UUID');
    return;
  }
  if (
    (limitRaw !== null && !/^\d+$/.test(limitRaw)) ||
    (offsetRaw !== null && !/^\d+$/.test(offsetRaw))
  ) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'limit and offset must be non-negative integers');
    return;
  }
  const tasks = await listQcInspectionTasks({
    gate_status: (gateStatus as QcGateStatus | null) ?? undefined,
    site_id: siteId ?? undefined,
    sku: sku ?? undefined,
    limit: limitRaw === null ? undefined : Number(limitRaw),
    offset: offsetRaw === null ? undefined : Number(offsetRaw),
  });
  sendJson(res, 200, { tasks });
};

const getTaskBase: RouteHandler = async (req, res, params) => {
  try {
    const taskId = requireUuidParam(params, 'taskId');
    const task = await getQcInspectionTaskById(taskId);
    if (!task) {
      throw new AppError(404, 'QC_TASK_NOT_FOUND', 'QC inspection task not found', {
        task_id: taskId,
      });
    }
    const release = await getConditionalReleaseForLot(task.lot_id);
    sendJson(res, 200, {
      task,
      disposition: release?.disposition ?? null,
      deviation: release?.deviation ?? null,
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

function assertWriteSiteAccess(req: IncomingMessage, siteId: string): void {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const scope = permittedLocationsForModuleScope(authContext.roles, 'qc', 'write');
  if (!scope.wildcard && !scope.locations.has(siteId)) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      `No write assignment grants access to site "${siteId}"`,
      { site_id: siteId },
    );
  }
}

const recordConditionalReleaseBase: RouteHandler = async (req, res, params) => {
  const body = requireBody(req, res);
  if (!body) return;
  const actor = actorContext(req);
  const now = new Date().toISOString();
  let taskId = '';
  let lotId: string | null = null;
  try {
    taskId = requireUuidParam(params, 'taskId');
    const task = await getQcInspectionTaskById(taskId);
    if (!task) {
      throw new AppError(404, 'QC_TASK_NOT_FOUND', 'QC inspection task not found', {
        task_id: taskId,
      });
    }
    lotId = task.lot_id;
    assertWriteSiteAccess(req, task.site_id);

    for (const field of ['justification', 'conditions', 'scope_ref']) {
      if (typeof body[field] !== 'string' || body[field].trim() === '') {
        throw new AppError(400, 'INVALID_PARAMS', `${field} must be a non-empty string`);
      }
    }
    if (
      typeof body['scope_kind'] !== 'string' ||
      !['internal_movement', 'order_allocation', 'dispatch'].includes(body['scope_kind'])
    ) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'scope_kind must be one of: internal_movement, order_allocation, dispatch',
      );
    }
    if (typeof body['expires_on'] !== 'string' || !isValidCalendarDate(body['expires_on'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'expires_on must be a YYYY-MM-DD calendar date');
    }

    // DOA pre-check (AD-3); the seam re-derives under the lot and gate locks (AC 5 audited 403).
    const authority = await resolveQcAuthority(CONDITIONAL_RELEASE_DOA_TYPE, {
      requireQcHead: false,
    });
    if (authority.approver_user_id !== actor.userId) {
      throw new AppError(
        403,
        'APPROVAL_REQUIRED',
        'Conditional release requires the resolved DOA approver',
        { task_id: taskId, lot_id: lotId, resolved_approver_user_id: authority.approver_user_id },
      );
    }

    const persisted = await persistEvent(
      {
        stream_type: 'qc',
        stream_id: taskId,
        event_type: QC_CONDITIONAL_RELEASE_RECORDED,
        payload: {
          task_id: taskId,
          lot_id: task.lot_id,
          deviation_id: randomUUID(),
          disposition_id: randomUUID(),
          justification: (body['justification'] as string).trim(),
          conditions: (body['conditions'] as string).trim(),
          scope_kind: body['scope_kind'],
          scope_ref: (body['scope_ref'] as string).trim(),
          expires_on: body['expires_on'],
          decided_at: now,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: now,
        },
        idempotency_key: idempotencyKeyFrom(body),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );
    replayIdOrReject(persisted, QC_CONDITIONAL_RELEASE_RECORDED, 'disposition_id');
    const refreshed = await getQcInspectionTaskById(taskId);
    const release = await getConditionalReleaseForLot(task.lot_id);
    sendJson(res, 201, {
      event_id: persisted.event_id,
      task: refreshed,
      disposition: release?.disposition ?? null,
      deviation: release?.deviation ?? null,
    });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditRejectedAttempt(req, actor, err, { task_id: taskId, lot_id: lotId });
    }
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// Exports (module `qc`)
// ---------------------------------------------------------------------------

export const createInspectionPlanHandler = requireRole({ module: 'qc', functionScope: 'write' })(
  createInspectionPlanBase,
);
export const listInspectionPlansHandler = requireRole({ module: 'qc', functionScope: 'read' })(
  listInspectionPlansBase,
);
export const resolveInspectionPlanHandler = requireRole({ module: 'qc', functionScope: 'read' })(
  resolveInspectionPlanBase,
);
export const getInspectionPlanHandler = requireRole({ module: 'qc', functionScope: 'read' })(
  getInspectionPlanBase,
);
export const getInspectionPlanVersionHandler = requireRole({ module: 'qc', functionScope: 'read' })(
  getInspectionPlanVersionBase,
);
export const approveInspectionPlanHandler = requireRole({ module: 'qc', functionScope: 'write' })(
  approveInspectionPlanBase,
);
export const submitSyntheticCompletionHandler = requireRole({
  module: 'qc',
  functionScope: 'write',
  locationId: (_params, body) => {
    const siteId = (body as Record<string, unknown> | undefined)?.['site_id'];
    return isUuid(siteId) ? siteId : undefined;
  },
})(submitSyntheticCompletionBase);
export const listQcTasksHandler = requireRole({ module: 'qc', functionScope: 'read' })(
  listTasksBase,
);
export const getQcTaskHandler = requireRole({ module: 'qc', functionScope: 'read' })(getTaskBase);
export const recordConditionalReleaseHandler = requireRole({
  module: 'qc',
  functionScope: 'write',
})(recordConditionalReleaseBase);
