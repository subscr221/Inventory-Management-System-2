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
  LOT_DISPOSITIONS,
  MAX_READINGS_PER_RESULT,
  NCR_OUTCOMES,
  QC_CONDITIONAL_RELEASE_RECORDED,
  QC_INSPECTION_COMPLETED,
  QC_LOT_DISPOSITIONED,
  QC_LOT_SPLIT_RECORDED,
  QC_BATCH_RELEASE_RECORDED,
  QC_NCR_OUTCOME_RECORDED,
  RELEASABLE_DISPOSITIONS,
  QC_OBSERVATION_RECORDED,
  QC_RETENTION_SAMPLE_LOGGED,
  QC_REWORK_REQUESTED,
  QC_RESULT_RECORDED,
  QC_SAMPLING_DETERMINED,
  QC_SAMPLING_STATE_ADJUSTED,
  SWITCHING_ACTIONS,
  isPositiveQuantity,
  resolveInspectionPlanForLot,
  resolveQcAuthority,
} from '../../compliance/quality.js';
import { config } from '../../config/index.js';
import { receiveQcCompletion } from '../../quality/completion.js';
import { getQcSamplingPlanByTaskId } from '../../read/projections/qc_sampling_plan.js';
import { listQcInspectionResults } from '../../read/projections/qc_inspection_result.js';
import {
  getSwitchingState,
  listSwitchingStates,
} from '../../read/projections/qc_sampling_switching_state.js';
import { getInstrumentRecordByAssetId } from '../../read/projections/instrument_register.js';
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
import type { QcGateStatus, QcTaskStatus } from '../../read/projections/qc_inspection_task.js';
import {
  getConditionalReleaseForLot,
  getQcLotDispositionByLotId,
} from '../../read/projections/qc_lot_disposition.js';
import {
  getQcNcrById,
  getQcNcrByLotId,
  listQcNcrs,
} from '../../read/projections/qc_ncr.js';
import type { QcNcrOutcome } from '../../read/projections/qc_ncr.js';
import { listQcLotSplitsByParent } from '../../read/projections/qc_lot_split.js';
import { getQcBatchReleaseByLotId } from '../../read/projections/qc_batch_release.js';
import { getQcRetentionSampleByLotId } from '../../read/projections/qc_retention_sample.js';

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
// Story 8.3: the gate-status filter vocabulary is derived from the projection's own type so the
// list route can never drift from the CHECK constraint (a local literal was the drift risk).
const GATE_STATUSES: ReadonlySet<string> = new Set<QcGateStatus>([
  'qc_hold',
  'conditionally_released',
  'accepted',
  'rejected',
  'split',
]);
const TASK_STATUSES = new Set(['open', 'sampling_determined', 'inspected']);
/** Story 8.4: the seam owns the rule; this is the same predicate, imported rather than re-declared. */
const isPositiveQuantityInput = (value: unknown): value is string =>
  typeof value === 'string' && isPositiveQuantity(value);
/** chk_qc_retention_sample_uom bounds the trimmed value; the route mirrors it exactly. */
const MAX_UOM_LENGTH = 32;
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
  /** Story 8.2 (Binding Scope Decision 11): the task's site, not an arbitrary role assignment. */
  locationId?: string,
): Promise<void> {
  const auditClient = await getPool().connect();
  try {
    await logAuditEntry(auditClient, {
      ...auditCtxFor(req, actor, err.statusCode),
      ...(locationId ? { location_id: locationId } : {}),
      event_id: null,
      error_code: err.errorCode,
      details: { ...details, ...err.details },
    });
  } finally {
    auditClient.release();
  }
}

/**
 * Story 8.2 (AC 5, FR-Q-13) adds CALIBRATION_LOCKOUT: a rejected attempt to record a result with a
 * non-calibrated instrument is written to the statutory audit log with actor, task, lot,
 * instrument, endpoint, trace id and code.
 */
const AUDITED_REJECTIONS = new Set([
  'APPROVAL_REQUIRED',
  'APPROVAL_UNRESOLVED',
  'SOD_VIOLATION',
  'CALIBRATION_LOCKOUT',
  // Story 8.3 (AC 6): a refused disposition, split or NCR outcome is a statutory record of a
  // refused quality decision, not a routine 4xx.
  'LOCATION_ACCESS_DENIED',
  'QC_INSPECTION_REQUIRED',
  'DISPOSITION_EXISTS',
  'NCR_OUTCOME_EXISTS',
  'INSUFFICIENT_STOCK',
  'LOT_ON_HOLD',
  // Story 8.4 (AC 8): a refused release or retention-sample log is a statutory record of a refused
  // quality decision. Both "already exists" duplicate codes are here, not just one.
  'QC_RELEASE_NOT_ELIGIBLE',
  'RETENTION_SAMPLE_REQUIRED',
  'RELEASE_EXISTS',
  'RETENTION_SAMPLE_EXISTS',
  // Reachable on both new write routes through lockLotForRetention: a caller asserting a task/lot
  // binding that is not the lot's own inspection task is a refused state change on a statutory
  // record, which AC8 requires in the audit log.
  'QC_DERIVATION_MISMATCH',
  'ITEM_NOT_FOUND',
  'LOCATION_NOT_FOUND',
]);

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
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'limit and offset must be non-negative integers',
    );
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
    if (
      sourceOrderType === 'job_work_order' &&
      (sourceOrderRef === null || sourceOrderRef.trim() === '')
    ) {
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

/**
 * Story 8.2 (Binding Scope Decision 10): every task-scoped read is location-scoped through the
 * caller's `qc` read assignments against the task's site; list routes are narrowed to the permitted
 * sites when the caller holds no wildcard read.
 */
function readSiteScope(req: IncomingMessage): { wildcard: boolean; locations: Set<string> } {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return permittedLocationsForModuleScope(authContext.roles, 'qc', 'read');
}

function assertReadSiteAccess(req: IncomingMessage, siteId: string): void {
  const scope = readSiteScope(req);
  if (!scope.wildcard && !scope.locations.has(siteId)) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      `No read assignment grants access to site "${siteId}"`,
      { site_id: siteId },
    );
  }
}

/** Narrows a list query to the caller's read scope; returns null when the caller can see nothing. */
function scopedSiteIds(
  req: IncomingMessage,
  requestedSiteId: string | null,
): { site_id?: string; site_ids?: string[] } | null {
  const scope = readSiteScope(req);
  if (scope.wildcard) return requestedSiteId ? { site_id: requestedSiteId } : {};
  if (requestedSiteId) {
    if (!scope.locations.has(requestedSiteId)) {
      throw new AppError(
        403,
        'LOCATION_ACCESS_DENIED',
        `No read assignment grants access to site "${requestedSiteId}"`,
        { site_id: requestedSiteId },
      );
    }
    return { site_id: requestedSiteId };
  }
  if (scope.locations.size === 0) return null;
  return { site_ids: [...scope.locations] };
}

const listTasksBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const gateStatus = url.searchParams.get('gate_status');
  const taskStatus = url.searchParams.get('task_status');
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
  if (taskStatus !== null && !TASK_STATUSES.has(taskStatus)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'task_status must be one of: open, sampling_determined, inspected',
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
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'limit and offset must be non-negative integers',
    );
    return;
  }
  try {
    const scoped = scopedSiteIds(req, siteId);
    if (scoped === null) {
      sendJson(res, 200, { tasks: [] });
      return;
    }
    const tasks = await listQcInspectionTasks({
      gate_status: (gateStatus as QcGateStatus | null) ?? undefined,
      task_status: (taskStatus as QcTaskStatus | null) ?? undefined,
      ...scoped,
      sku: sku ?? undefined,
      limit: limitRaw === null ? undefined : Number(limitRaw),
      offset: offsetRaw === null ? undefined : Number(offsetRaw),
    });
    sendJson(res, 200, { tasks });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
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
    assertReadSiteAccess(req, task.site_id);
    const release = await getConditionalReleaseForLot(task.lot_id);
    const sampling = await getQcSamplingPlanByTaskId(taskId);
    sendJson(res, 200, {
      task,
      sampling,
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
// Story 8.2: sampling, results, observations, completion, switching state (FR-Q-03, FR-Q-04)
// ---------------------------------------------------------------------------

async function requireTask(
  taskId: string,
): Promise<NonNullable<Awaited<ReturnType<typeof getQcInspectionTaskById>>>> {
  const task = await getQcInspectionTaskById(taskId);
  if (!task) {
    throw new AppError(404, 'QC_TASK_NOT_FOUND', 'QC inspection task not found', {
      task_id: taskId,
    });
  }
  return task;
}

function qcMetadata(actor: ActorContext, now: string): Record<string, unknown> {
  return {
    correlation_id: randomUUID(),
    actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
    occurred_at: now,
  };
}

/** A same-key replay must be the same event type for the same task; anything else is a reused key. */
function assertTaskReplay(persisted: PersistedEvent, eventType: string, taskId: string): void {
  const payloadTask = (persisted.payload as Record<string, unknown> | undefined)?.['task_id'];
  if (persisted.event_type !== eventType || payloadTask !== taskId) {
    throw new AppError(
      409,
      'DUPLICATE_EVENT',
      'This idempotency key is already in use by a different event',
      { existing_event_id: persisted.event_id, existing_event_type: persisted.event_type },
    );
  }
}

function optionalTimestamp(body: Record<string, unknown>, field: string, fallback: string): string {
  const value = body[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !ISO8601_TIMESTAMP_REGEX.test(value)) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `${field} must be an ISO 8601 timestamp with an explicit offset`,
      { [field]: value },
    );
  }
  return value;
}

/** Mints result ids for readings; every other reading field is validated by the seam. */
function readingsFrom(body: Record<string, unknown>): Record<string, unknown>[] {
  const readings = body['readings'];
  if (!Array.isArray(readings) || readings.length === 0) {
    throw new AppError(400, 'INVALID_PARAMS', 'readings must be a non-empty array');
  }
  if (readings.length > MAX_READINGS_PER_RESULT) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `readings must carry at most ${MAX_READINGS_PER_RESULT} entries`,
      {
        readings: readings.length,
        max: MAX_READINGS_PER_RESULT,
      },
    );
  }
  return readings.map((raw) => {
    const r =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    // Task 8: result_id is always server-minted, never taken from the client, so the 200-vs-201
    // replay comparison below has a value that is guaranteed fresh on every genuine new request.
    const out: Record<string, unknown> = {
      result_id: randomUUID(),
      sample_unit_no: r['sample_unit_no'],
    };
    if (r['measured_value'] !== undefined) out['measured_value'] = r['measured_value'];
    if (r['measured_uom'] !== undefined) out['measured_uom'] = r['measured_uom'];
    if (r['attribute_conforms'] !== undefined) out['attribute_conforms'] = r['attribute_conforms'];
    return out;
  });
}

const determineSamplingBase: RouteHandler = async (req, res, params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);
  const now = new Date().toISOString();
  try {
    const taskId = requireUuidParam(params, 'taskId');
    const task = await requireTask(taskId);
    assertWriteSiteAccess(req, task.site_id);
    // AC 1: every later determination attempt for the same task replays the frozen plan.
    const frozen = await getQcSamplingPlanByTaskId(taskId);
    if (frozen && task.task_status !== 'open') {
      sendJson(res, 200, {
        event_id: frozen.source_event_id,
        sampling: frozen,
        task,
        replayed: true,
      });
      return;
    }
    const samplingId = randomUUID();
    const persisted = await persistEvent(
      {
        stream_type: 'qc',
        stream_id: taskId,
        event_type: QC_SAMPLING_DETERMINED,
        payload: {
          task_id: taskId,
          sampling_id: samplingId,
          determined_at: optionalTimestamp(body, 'determined_at', now),
        },
        metadata: qcMetadata(actor, now),
        idempotency_key: idempotencyKeyFrom(body),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );
    const persistedSamplingId = replayIdOrReject(persisted, QC_SAMPLING_DETERMINED, 'sampling_id');
    assertTaskReplay(persisted, QC_SAMPLING_DETERMINED, taskId);
    const sampling = await getQcSamplingPlanByTaskId(taskId);
    const refreshed = await getQcInspectionTaskById(taskId);
    sendJson(res, persistedSamplingId === samplingId ? 201 : 200, {
      event_id: persisted.event_id,
      sampling,
      task: refreshed,
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const getSamplingBase: RouteHandler = async (req, res, params) => {
  try {
    const taskId = requireUuidParam(params, 'taskId');
    const task = await requireTask(taskId);
    assertReadSiteAccess(req, task.site_id);
    const sampling = await getQcSamplingPlanByTaskId(taskId);
    const switchingState = sampling
      ? await getSwitchingState(sampling.plan_id, sampling.site_id)
      : await getSwitchingState(task.plan_id, task.site_id);
    sendJson(res, 200, { task, sampling, switching_state: switchingState });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

async function recordBatch(
  req: Parameters<RouteHandler>[0],
  res: Parameters<RouteHandler>[1],
  params: Parameters<RouteHandler>[2],
  kind: 'result' | 'observation',
): Promise<void> {
  const body = requireBody(req, res);
  if (!body) return;
  const actor = actorContext(req);
  const now = new Date().toISOString();
  let taskId = '';
  let lotId: string | null = null;
  let siteId: string | undefined;
  let instrumentAssetId: string | null = null;
  let instrumentId: string | null = null;
  try {
    taskId = requireUuidParam(params, 'taskId');
    const task = await requireTask(taskId);
    lotId = task.lot_id;
    siteId = task.site_id;
    assertWriteSiteAccess(req, task.site_id);
    if (!isUuid(body['characteristic_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'characteristic_id must be a UUID');
    }
    const readings = readingsFrom(body);
    const recordedAt = optionalTimestamp(body, 'recorded_at', now);
    const payload: Record<string, unknown> = {
      task_id: taskId,
      lot_id: task.lot_id,
      characteristic_id: body['characteristic_id'],
      readings,
      recorded_at: recordedAt,
    };
    if (kind === 'result') {
      if (!isUuid(body['instrument_asset_id'])) {
        throw new AppError(400, 'INVALID_PARAMS', 'instrument_asset_id must be a UUID');
      }
      instrumentAssetId = body['instrument_asset_id'];
      // Binding Scope Decision 3: the asset is the client contract; the register key is what the
      // pre-transaction calibration gate reads, so it is resolved BEFORE persistEvent.
      const register = await getInstrumentRecordByAssetId(instrumentAssetId);
      if (!register) {
        throw new AppError(
          404,
          'INSTRUMENT_NOT_FOUND',
          'The asset is not a registered measuring instrument',
          { instrument_asset_id: instrumentAssetId },
        );
      }
      instrumentId = register.instrument_id;
      payload['instrument_asset_id'] = instrumentAssetId;
      payload['instrument_id'] = register.instrument_id;
    }
    const eventType = kind === 'result' ? QC_RESULT_RECORDED : QC_OBSERVATION_RECORDED;
    const persisted = await persistEvent(
      {
        stream_type: 'qc',
        stream_id: taskId,
        event_type: eventType,
        payload,
        metadata: qcMetadata(actor, now),
        idempotency_key: idempotencyKeyFrom(body),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );
    assertTaskReplay(persisted, eventType, taskId);
    const results = await listQcInspectionResults(taskId, {
      source_event_id: persisted.event_id,
      limit: MAX_READINGS_PER_RESULT,
    });
    const firstMinted = (readings[0] as Record<string, unknown>)['result_id'];
    const replayed = !results.some((r) => r.result_id === firstMinted);
    sendJson(res, replayed ? 200 : 201, { event_id: persisted.event_id, results });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditRejectedAttempt(
        req,
        actor,
        err,
        {
          task_id: taskId,
          lot_id: lotId,
          instrument_asset_id: instrumentAssetId,
          instrument_id: instrumentId,
        },
        siteId,
      );
    }
    sendAppError(req, res, err);
  }
}

const recordResultsBase: RouteHandler = (req, res, params) =>
  recordBatch(req, res, params, 'result');
const recordObservationsBase: RouteHandler = (req, res, params) =>
  recordBatch(req, res, params, 'observation');

const listResultsBase: RouteHandler = async (req, res, params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const characteristicId = url.searchParams.get('characteristic_id');
  const unitRaw = url.searchParams.get('sample_unit_no');
  const conformsRaw = url.searchParams.get('conforms');
  const limitRaw = url.searchParams.get('limit');
  const offsetRaw = url.searchParams.get('offset');
  try {
    const taskId = requireUuidParam(params, 'taskId');
    if (characteristicId !== null && !isUuid(characteristicId)) {
      throw new AppError(400, 'INVALID_PARAMS', 'characteristic_id must be a UUID');
    }
    if (unitRaw !== null && !/^[1-9]\d*$/.test(unitRaw)) {
      throw new AppError(400, 'INVALID_PARAMS', 'sample_unit_no must be a positive integer');
    }
    if (conformsRaw !== null && conformsRaw !== 'true' && conformsRaw !== 'false') {
      throw new AppError(400, 'INVALID_PARAMS', 'conforms must be true or false');
    }
    if (
      (limitRaw !== null && !/^\d+$/.test(limitRaw)) ||
      (offsetRaw !== null && !/^\d+$/.test(offsetRaw))
    ) {
      throw new AppError(400, 'INVALID_PARAMS', 'limit and offset must be non-negative integers');
    }
    const task = await requireTask(taskId);
    assertReadSiteAccess(req, task.site_id);
    const results = await listQcInspectionResults(taskId, {
      characteristic_id: characteristicId ?? undefined,
      sample_unit_no: unitRaw === null ? undefined : Number(unitRaw),
      conforms: conformsRaw === null ? undefined : conformsRaw === 'true',
      limit: limitRaw === null ? undefined : Number(limitRaw),
      offset: offsetRaw === null ? undefined : Number(offsetRaw),
    });
    sendJson(res, 200, { results });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const completeInspectionBase: RouteHandler = async (req, res, params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);
  const now = new Date().toISOString();
  try {
    const taskId = requireUuidParam(params, 'taskId');
    const task = await requireTask(taskId);
    assertWriteSiteAccess(req, task.site_id);
    const persisted = await persistEvent(
      {
        stream_type: 'qc',
        stream_id: taskId,
        event_type: QC_INSPECTION_COMPLETED,
        payload: { task_id: taskId, completed_at: optionalTimestamp(body, 'completed_at', now) },
        metadata: qcMetadata(actor, now),
        idempotency_key: idempotencyKeyFrom(body),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );
    assertTaskReplay(persisted, QC_INSPECTION_COMPLETED, taskId);
    const refreshed = await getQcInspectionTaskById(taskId);
    const switchingState = await getSwitchingState(task.plan_id, task.site_id);
    // The task was already inspected before this request: persistEvent returned the same-key
    // original (a different key would have been rejected by the seam).
    const replayed = task.task_status === 'inspected';
    sendJson(res, replayed ? 200 : 201, {
      event_id: persisted.event_id,
      task: refreshed,
      switching_state: switchingState,
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const listSamplingStatesBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const planId = url.searchParams.get('plan_id');
  const siteId = url.searchParams.get('site_id');
  const limitRaw = url.searchParams.get('limit');
  const offsetRaw = url.searchParams.get('offset');
  try {
    if (planId !== null && !isUuid(planId)) {
      throw new AppError(400, 'INVALID_PARAMS', 'plan_id must be a UUID');
    }
    if (siteId !== null && !isUuid(siteId)) {
      throw new AppError(400, 'INVALID_PARAMS', 'site_id must be a UUID');
    }
    if (
      (limitRaw !== null && !/^\d+$/.test(limitRaw)) ||
      (offsetRaw !== null && !/^\d+$/.test(offsetRaw))
    ) {
      throw new AppError(400, 'INVALID_PARAMS', 'limit and offset must be non-negative integers');
    }
    const scoped = scopedSiteIds(req, siteId);
    if (scoped === null) {
      sendJson(res, 200, { states: [] });
      return;
    }
    const states = await listSwitchingStates({
      plan_id: planId ?? undefined,
      ...scoped,
      limit: limitRaw === null ? undefined : Number(limitRaw),
      offset: offsetRaw === null ? undefined : Number(offsetRaw),
    });
    sendJson(res, 200, { states });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const adjustSamplingStateBase: RouteHandler = async (req, res, params) => {
  const body = requireBody(req, res);
  if (!body) return;
  const actor = actorContext(req);
  const now = new Date().toISOString();
  let planId = '';
  let siteId: string | undefined;
  try {
    planId = requireUuidParam(params, 'planId');
    siteId = requireUuidParam(params, 'siteId');
    assertWriteSiteAccess(req, siteId);
    if (typeof body['action'] !== 'string' || !SWITCHING_ACTIONS.has(body['action'])) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'action must be one of: authorize_reduced, resume_inspection',
      );
    }
    if (typeof body['reason'] !== 'string' || body['reason'].trim() === '') {
      throw new AppError(400, 'INVALID_PARAMS', 'reason must be a non-empty string');
    }
    // Authority pre-check (Binding Scope Decision 9): QC Head-level roles from configuration; the
    // seam re-derives the same check inside the transaction.
    const qcHeadRoles: readonly string[] = config.quality.qcHeadRoles;
    if (!qcHeadRoles.includes(actor.role)) {
      throw new AppError(
        403,
        'APPROVAL_REQUIRED',
        'Adjusting the sampling switching state requires QC Head-level authority',
        { plan_id: planId, site_id: siteId, action: body['action'] },
      );
    }
    const persisted = await persistEvent(
      {
        stream_type: 'qc',
        stream_id: planId,
        event_type: QC_SAMPLING_STATE_ADJUSTED,
        payload: {
          plan_id: planId,
          site_id: siteId,
          action: body['action'],
          reason: body['reason'].trim(),
          adjusted_at: optionalTimestamp(body, 'adjusted_at', now),
        },
        metadata: qcMetadata(actor, now),
        idempotency_key: idempotencyKeyFrom(body),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );
    const payload = persisted.payload as Record<string, unknown> | undefined;
    if (
      persisted.event_type !== QC_SAMPLING_STATE_ADJUSTED ||
      payload?.['plan_id'] !== planId ||
      payload?.['site_id'] !== siteId
    ) {
      throw new AppError(
        409,
        'DUPLICATE_EVENT',
        'This idempotency key is already in use by a different event',
        { existing_event_id: persisted.event_id, existing_event_type: persisted.event_type },
      );
    }
    const switchingState = await getSwitchingState(planId, siteId);
    sendJson(res, 201, { event_id: persisted.event_id, switching_state: switchingState });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditRejectedAttempt(
        req,
        actor,
        err,
        { plan_id: planId, site_id: siteId ?? null, action: body['action'] ?? null },
        siteId,
      );
    }
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// Story 8.3: disposition, partial split, NCR outcomes (FR-Q-05, FR-Q-06)
// ---------------------------------------------------------------------------

/** The task-scoped disposition view every Story 8.3 write route echoes back. */
async function dispositionView(task: {
  task_id: string;
  lot_id: string;
}): Promise<Record<string, unknown>> {
  const refreshed = await getQcInspectionTaskById(task.task_id);
  const disposition = await getQcLotDispositionByLotId(task.lot_id);
  const ncr = await getQcNcrByLotId(task.lot_id);
  const children = await listQcLotSplitsByParent(task.lot_id);
  return {
    task: refreshed,
    disposition,
    ncr,
    ...(children.length > 0 ? { splits: children } : {}),
  };
}

const recordDispositionBase: RouteHandler = async (req, res, params) => {
  const body = requireBody(req, res);
  if (!body) return;
  const actor = actorContext(req);
  const now = new Date().toISOString();
  let taskId = '';
  let lotId: string | null = null;
  let siteId: string | undefined;
  try {
    taskId = requireUuidParam(params, 'taskId');
    const task = await requireTask(taskId);
    lotId = task.lot_id;
    siteId = task.site_id;
    assertWriteSiteAccess(req, task.site_id);

    const disposition = body['disposition'];
    if (typeof disposition !== 'string' || !LOT_DISPOSITIONS.has(disposition)) {
      throw new AppError(400, 'INVALID_PARAMS', 'disposition must be one of: accept, reject');
    }
    if (typeof body['justification'] !== 'string' || body['justification'].trim() === '') {
      throw new AppError(400, 'INVALID_PARAMS', 'justification must be a non-empty string');
    }
    // Pre-check the inspection axis so the common mistake gets its code without a write attempt;
    // the seam re-derives the same rule under the lot and gate locks.
    if (task.task_status !== 'inspected') {
      throw new AppError(
        409,
        'QC_INSPECTION_REQUIRED',
        'A disposition requires a completed inspection for this lot',
        { task_id: taskId, lot_id: lotId, task_status: task.task_status },
      );
    }

    const persisted = await persistEvent(
      {
        stream_type: 'qc',
        stream_id: taskId,
        event_type: QC_LOT_DISPOSITIONED,
        payload: {
          task_id: taskId,
          lot_id: task.lot_id,
          disposition_id: randomUUID(),
          disposition,
          justification: (body['justification'] as string).trim(),
          decided_at: optionalTimestamp(body, 'decided_at', now),
          ...(disposition === 'reject' ? { ncr_id: randomUUID() } : {}),
        },
        metadata: qcMetadata(actor, now),
        idempotency_key: idempotencyKeyFrom(body),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );
    replayIdOrReject(persisted, QC_LOT_DISPOSITIONED, 'disposition_id');
    assertTaskReplay(persisted, QC_LOT_DISPOSITIONED, taskId);
    sendJson(res, 201, { event_id: persisted.event_id, ...(await dispositionView(task)) });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditRejectedAttempt(req, actor, err, { task_id: taskId, lot_id: lotId }, siteId);
    }
    sendAppError(req, res, err);
  }
};

const recordSplitBase: RouteHandler = async (req, res, params) => {
  const body = requireBody(req, res);
  if (!body) return;
  const actor = actorContext(req);
  const now = new Date().toISOString();
  let taskId = '';
  let lotId: string | null = null;
  let siteId: string | undefined;
  try {
    taskId = requireUuidParam(params, 'taskId');
    const task = await requireTask(taskId);
    lotId = task.lot_id;
    siteId = task.site_id;
    assertWriteSiteAccess(req, task.site_id);

    if (typeof body['justification'] !== 'string' || body['justification'].trim() === '') {
      throw new AppError(400, 'INVALID_PARAMS', 'justification must be a non-empty string');
    }
    const splits = body['splits'];
    if (!Array.isArray(splits)) {
      throw new AppError(400, 'INVALID_PARAMS', 'splits must be an array');
    }
    if (task.task_status !== 'inspected') {
      throw new AppError(
        409,
        'QC_INSPECTION_REQUIRED',
        'A split requires a completed inspection for this lot',
        { task_id: taskId, lot_id: lotId, task_status: task.task_status },
      );
    }

    const persisted = await persistEvent(
      {
        stream_type: 'qc',
        stream_id: taskId,
        event_type: QC_LOT_SPLIT_RECORDED,
        payload: {
          task_id: taskId,
          lot_id: task.lot_id,
          disposition_id: randomUUID(),
          justification: (body['justification'] as string).trim(),
          decided_at: optionalTimestamp(body, 'decided_at', now),
          // Only sequence and quantity survive the seam's shape assert; every child identity is
          // minted there and written back.
          splits: splits.map((entry) => {
            const split = (entry ?? {}) as Record<string, unknown>;
            return { sequence: split['sequence'], quantity: split['quantity'] };
          }),
        },
        metadata: qcMetadata(actor, now),
        idempotency_key: idempotencyKeyFrom(body),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );
    replayIdOrReject(persisted, QC_LOT_SPLIT_RECORDED, 'disposition_id');
    assertTaskReplay(persisted, QC_LOT_SPLIT_RECORDED, taskId);
    sendJson(res, 201, { event_id: persisted.event_id, ...(await dispositionView(task)) });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditRejectedAttempt(req, actor, err, { task_id: taskId, lot_id: lotId }, siteId);
    }
    sendAppError(req, res, err);
  }
};

const getDispositionBase: RouteHandler = async (req, res, params) => {
  try {
    const taskId = requireUuidParam(params, 'taskId');
    const task = await requireTask(taskId);
    assertReadSiteAccess(req, task.site_id);
    sendJson(res, 200, await dispositionView(task));
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const recordNcrOutcomeBase: RouteHandler = async (req, res, params) => {
  const body = requireBody(req, res);
  if (!body) return;
  const actor = actorContext(req);
  const now = new Date().toISOString();
  let ncrId = '';
  let siteId: string | undefined;
  try {
    ncrId = requireUuidParam(params, 'ncrId');
    const ncr = await getQcNcrById(ncrId);
    if (!ncr) {
      throw new AppError(404, 'NCR_NOT_FOUND', 'Non-conformance report not found', {
        ncr_id: ncrId,
      });
    }
    siteId = ncr.site_id;
    assertWriteSiteAccess(req, ncr.site_id);

    const outcome = body['outcome'];
    if (typeof outcome !== 'string' || !NCR_OUTCOMES.has(outcome)) {
      throw new AppError(400, 'INVALID_PARAMS', 'outcome must be one of: rework, downgrade, scrap');
    }
    if (typeof body['outcome_reason'] !== 'string' || body['outcome_reason'].trim() === '') {
      throw new AppError(400, 'INVALID_PARAMS', 'outcome_reason must be a non-empty string');
    }
    if (outcome === 'downgrade') {
      if (typeof body['downgrade_sku'] !== 'string' || body['downgrade_sku'].trim() === '') {
        throw new AppError(
          400,
          'DOWNGRADE_SKU_REQUIRED',
          'downgrade_sku is required on a downgrade outcome',
          { ncr_id: ncrId },
        );
      }
    } else if (body['downgrade_sku'] !== undefined) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'downgrade_sku is only valid on a downgrade outcome',
        { outcome },
      );
    }
    if (ncr.outcome !== null) {
      throw new AppError(409, 'NCR_OUTCOME_EXISTS', 'The NCR outcome has already been recorded', {
        ncr_id: ncrId,
        outcome: ncr.outcome,
      });
    }

    const decidedAt = optionalTimestamp(body, 'decided_at', now);
    const idempotencyKey = idempotencyKeyFrom(body);
    // A rework outcome mints the companion event id up front: the outcome applier stores it on the
    // NCR and the qc.rework_requested applier refuses any event the NCR does not already name.
    const reworkEventId = outcome === 'rework' ? randomUUID() : null;
    // The outcome event's own id is minted up front too, so replay is detected by comparing it to
    // what persistEvent actually persisted (its own idempotency-key/event_id pre-check plus 23505
    // race handling is the single race-free source of truth) rather than by a separate check-then-
    // act SELECT, which two concurrent same-key requests could both pass before either commits.
    const outcomeEventId = randomUUID();

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const persisted = await persistEvent(
        {
          event_id: outcomeEventId,
          stream_type: 'qc',
          stream_id: ncrId,
          event_type: QC_NCR_OUTCOME_RECORDED,
          payload: {
            ncr_id: ncrId,
            lot_id: ncr.lot_id,
            outcome,
            outcome_reason: (body['outcome_reason'] as string).trim(),
            decided_at: decidedAt,
            ...(outcome === 'downgrade'
              ? { downgrade_sku: (body['downgrade_sku'] as string).trim() }
              : {}),
            ...(reworkEventId ? { rework_event_id: reworkEventId } : {}),
          },
          metadata: qcMetadata(actor, now),
          idempotency_key: idempotencyKey,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        auditCtxFor(req, actor, 201),
        client,
      );
      if (persisted.event_type !== QC_NCR_OUTCOME_RECORDED) {
        throw new AppError(
          409,
          'DUPLICATE_EVENT',
          'This idempotency key is already in use by a different event',
          { existing_event_id: persisted.event_id, existing_event_type: persisted.event_type },
        );
      }
      const replayed = persisted.event_id !== outcomeEventId;
      if (reworkEventId !== null && !replayed) {
        const decided = await getQcNcrById(ncrId, client);
        await persistEvent(
          {
            event_id: reworkEventId,
            stream_type: 'qc',
            stream_id: ncrId,
            event_type: QC_REWORK_REQUESTED,
            payload: {
              ncr_id: ncrId,
              lot_id: ncr.lot_id,
              lot_number: ncr.lot_number,
              task_id: ncr.task_id,
              sku: ncr.sku,
              site_id: ncr.site_id,
              quantity: ncr.quantity,
              plan_version_id: (await requireTask(ncr.task_id)).plan_version_id,
              requested_by: actor.userId,
              requested_at: decided?.outcome_at ?? decidedAt,
            },
            metadata: { ...qcMetadata(actor, now), causation_id: persisted.event_id },
            idempotency_key: null,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          auditCtxFor(req, actor, 201),
          client,
        );
      }
      await client.query('COMMIT');
      const refreshed = await getQcNcrById(ncrId);
      sendJson(res, replayed ? 200 : 201, { event_id: persisted.event_id, ncr: refreshed });
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditRejectedAttempt(req, actor, err, { ncr_id: ncrId }, siteId);
    }
    sendAppError(req, res, err);
  }
};

const listNcrsBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const siteId = url.searchParams.get('site_id');
  const outcome = url.searchParams.get('outcome');
  const limitRaw = url.searchParams.get('limit');
  const offsetRaw = url.searchParams.get('offset');
  try {
    if (siteId !== null && !isUuid(siteId)) {
      throw new AppError(400, 'INVALID_PARAMS', 'site_id must be a UUID');
    }
    if (outcome !== null && outcome !== 'open' && !NCR_OUTCOMES.has(outcome)) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'outcome must be one of: open, rework, downgrade, scrap',
      );
    }
    if (
      (limitRaw !== null && !/^\d+$/.test(limitRaw)) ||
      (offsetRaw !== null && !/^\d+$/.test(offsetRaw))
    ) {
      throw new AppError(400, 'INVALID_PARAMS', 'limit and offset must be non-negative integers');
    }
    const scoped = scopedSiteIds(req, siteId);
    if (scoped === null) {
      sendJson(res, 200, { ncrs: [] });
      return;
    }
    const ncrs = await listQcNcrs({
      ...scoped,
      ...(outcome === null ? {} : { outcome: outcome as QcNcrOutcome | 'open' }),
      limit: limitRaw === null ? undefined : Number(limitRaw),
      offset: offsetRaw === null ? undefined : Number(offsetRaw),
    });
    sendJson(res, 200, { ncrs });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const getNcrBase: RouteHandler = async (req, res, params) => {
  try {
    const ncrId = requireUuidParam(params, 'ncrId');
    const ncr = await getQcNcrById(ncrId);
    if (!ncr) {
      throw new AppError(404, 'NCR_NOT_FOUND', 'Non-conformance report not found', {
        ncr_id: ncrId,
      });
    }
    assertReadSiteAccess(req, ncr.site_id);
    sendJson(res, 200, { ncr });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// Story 8.4: retention samples and batch release (FR-Q-07, FR-Q-08)
// ---------------------------------------------------------------------------

async function releaseView(task: {
  task_id: string;
  lot_id: string;
}): Promise<Record<string, unknown>> {
  const refreshed = await getQcInspectionTaskById(task.task_id);
  const release = await getQcBatchReleaseByLotId(task.lot_id);
  const retentionSample = await getQcRetentionSampleByLotId(task.lot_id);
  return { task: refreshed, release, retention_sample: retentionSample };
}

const logRetentionSampleBase: RouteHandler = async (req, res, params) => {
  const body = requireBody(req, res);
  if (!body) return;
  const actor = actorContext(req);
  const now = new Date().toISOString();
  let taskId = '';
  let lotId: string | null = null;
  let siteId: string | undefined;
  try {
    taskId = requireUuidParam(params, 'taskId');
    const task = await requireTask(taskId);
    lotId = task.lot_id;
    siteId = task.site_id;
    assertWriteSiteAccess(req, task.site_id);

    if (!isPositiveQuantityInput(body['quantity'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'quantity must be a positive decimal string', {
        quantity: body['quantity'] ?? null,
      });
    }
    if (
      typeof body['uom'] !== 'string' ||
      body['uom'].trim() === '' ||
      body['uom'].trim().length > MAX_UOM_LENGTH
    ) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `uom must be a non-empty string of at most ${MAX_UOM_LENGTH} characters`,
        { uom: body['uom'] ?? null },
      );
    }
    if (!isUuid(body['location_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'location_id must be a UUID');
    }

    // The event id is minted up front so replay is detected by comparing it against what
    // persistEvent actually persisted, never by a check-then-act SELECT two concurrent same-key
    // requests could both pass (the Story 8.3 recordNcrOutcomeBase lesson).
    const eventId = randomUUID();
    const persisted = await persistEvent(
      {
        event_id: eventId,
        stream_type: 'qc',
        stream_id: taskId,
        event_type: QC_RETENTION_SAMPLE_LOGGED,
        payload: {
          task_id: taskId,
          lot_id: task.lot_id,
          retention_sample_id: randomUUID(),
          quantity: body['quantity'],
          uom: (body['uom'] as string).trim(),
          location_id: body['location_id'],
          logged_at: optionalTimestamp(body, 'logged_at', now),
        },
        metadata: qcMetadata(actor, now),
        idempotency_key: idempotencyKeyFrom(body),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );
    replayIdOrReject(persisted, QC_RETENTION_SAMPLE_LOGGED, 'retention_sample_id');
    assertTaskReplay(persisted, QC_RETENTION_SAMPLE_LOGGED, taskId);
    const replayed = persisted.event_id !== eventId;
    sendJson(res, replayed ? 200 : 201, {
      event_id: persisted.event_id,
      retention_sample: await getQcRetentionSampleByLotId(task.lot_id),
    });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditRejectedAttempt(req, actor, err, { task_id: taskId, lot_id: lotId }, siteId);
    }
    sendAppError(req, res, err);
  }
};

const releaseLotBase: RouteHandler = async (req, res, params) => {
  // The release carries no domain fields, but an absent body and a NON-OBJECT body are different
  // things: a JSON array or string silently loses `idempotency_key`, turning a client's retry into
  // a genuinely new attempt that is then refused 409 instead of replaying as 200.
  const rawBody = getParsedBody(req);
  if (rawBody !== undefined && (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody))) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body must be a JSON object');
    return;
  }
  const body = (rawBody as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);
  const now = new Date().toISOString();
  let taskId = '';
  let lotId: string | null = null;
  let siteId: string | undefined;
  try {
    taskId = requireUuidParam(params, 'taskId');
    const task = await requireTask(taskId);
    lotId = task.lot_id;
    siteId = task.site_id;
    assertWriteSiteAccess(req, task.site_id);

    // Cheap pre-checks so the common mistakes get their code without a write attempt and without
    // taking the lot row lock, exactly as recordDispositionBase and recordSplitBase do. The seam
    // re-derives both under the lock - these are a courtesy, never the guarantee.
    const disposition = await getQcLotDispositionByLotId(task.lot_id);
    if (!disposition || !RELEASABLE_DISPOSITIONS.has(disposition.disposition)) {
      throw new AppError(
        409,
        'QC_RELEASE_NOT_ELIGIBLE',
        'A lot can only be released from an accept or conditional_release disposition',
        {
          task_id: taskId,
          lot_id: task.lot_id,
          disposition: disposition?.disposition ?? null,
          gate_status: task.gate_status,
        },
      );
    }
    // Only pre-checked under the broad scope, where a sample is required for every lot regardless
    // of the item. Under `bis_covered_only` the requirement depends on BIS coverage, which the seam
    // resolves under the lot lock - this pre-check is a courtesy, never the guarantee.
    const existingSample =
      config.quality.retentionSampleScope === 'all_released_lots'
        ? await getQcRetentionSampleByLotId(task.lot_id)
        : null;
    if (
      config.quality.retentionSampleScope === 'all_released_lots' &&
      (!existingSample || existingSample.status !== 'retained')
    ) {
      throw new AppError(
        409,
        'RETENTION_SAMPLE_REQUIRED',
        existingSample
          ? 'The retention sample for this lot is no longer retained'
          : 'A retention sample must be logged for this lot before it can be released',
        {
          task_id: taskId,
          lot_id: task.lot_id,
          ...(existingSample ? { retention_sample_status: existingSample.status } : {}),
        },
      );
    }

    // Every field of the release is server-derived (Binding Scope Decisions 1-4 and 7); the body
    // carries nothing but an optional idempotency key and decided_at.
    const eventId = randomUUID();
    const persisted = await persistEvent(
      {
        event_id: eventId,
        stream_type: 'qc',
        stream_id: taskId,
        event_type: QC_BATCH_RELEASE_RECORDED,
        payload: {
          task_id: taskId,
          lot_id: task.lot_id,
          release_id: randomUUID(),
          decided_at: optionalTimestamp(body, 'decided_at', now),
        },
        metadata: qcMetadata(actor, now),
        idempotency_key: idempotencyKeyFrom(body),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );
    replayIdOrReject(persisted, QC_BATCH_RELEASE_RECORDED, 'release_id');
    assertTaskReplay(persisted, QC_BATCH_RELEASE_RECORDED, taskId);
    const replayed = persisted.event_id !== eventId;
    sendJson(res, replayed ? 200 : 201, {
      event_id: persisted.event_id,
      ...(await releaseView(task)),
    });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditRejectedAttempt(req, actor, err, { task_id: taskId, lot_id: lotId }, siteId);
    }
    sendAppError(req, res, err);
  }
};

const getReleaseBase: RouteHandler = async (req, res, params) => {
  try {
    const taskId = requireUuidParam(params, 'taskId');
    const task = await requireTask(taskId);
    assertReadSiteAccess(req, task.site_id);
    const release = await getQcBatchReleaseByLotId(task.lot_id);
    if (!release) {
      throw new AppError(404, 'RELEASE_NOT_FOUND', 'No batch release record exists for this lot', {
        task_id: taskId,
        lot_id: task.lot_id,
      });
    }
    sendJson(res, 200, { release });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const getRetentionSampleBase: RouteHandler = async (req, res, params) => {
  try {
    const taskId = requireUuidParam(params, 'taskId');
    const task = await requireTask(taskId);
    assertReadSiteAccess(req, task.site_id);
    const retentionSample = await getQcRetentionSampleByLotId(task.lot_id);
    if (!retentionSample) {
      // Distinct from the applier's RETENTION_SAMPLE_NOT_FOUND, which means "this id does not
      // resolve"; here nothing has been logged yet, which is a different fact for a caller.
      throw new AppError(
        404,
        'RETENTION_SAMPLE_NOT_LOGGED',
        'No retention sample has been logged for this lot',
        { task_id: taskId, lot_id: task.lot_id },
      );
    }
    sendJson(res, 200, { retention_sample: retentionSample });
  } catch (err: unknown) {
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
// Story 8.2
export const determineSamplingHandler = requireRole({ module: 'qc', functionScope: 'write' })(
  determineSamplingBase,
);
export const getSamplingHandler = requireRole({ module: 'qc', functionScope: 'read' })(
  getSamplingBase,
);
export const recordQcResultsHandler = requireRole({ module: 'qc', functionScope: 'write' })(
  recordResultsBase,
);
export const recordQcObservationsHandler = requireRole({ module: 'qc', functionScope: 'write' })(
  recordObservationsBase,
);
export const listQcResultsHandler = requireRole({ module: 'qc', functionScope: 'read' })(
  listResultsBase,
);
export const completeInspectionHandler = requireRole({ module: 'qc', functionScope: 'write' })(
  completeInspectionBase,
);
export const listSamplingStatesHandler = requireRole({ module: 'qc', functionScope: 'read' })(
  listSamplingStatesBase,
);
export const adjustSamplingStateHandler = requireRole({ module: 'qc', functionScope: 'write' })(
  adjustSamplingStateBase,
);
// Story 8.3
export const recordDispositionHandler = requireRole({ module: 'qc', functionScope: 'write' })(
  recordDispositionBase,
);
export const recordSplitHandler = requireRole({ module: 'qc', functionScope: 'write' })(
  recordSplitBase,
);
export const getDispositionHandler = requireRole({ module: 'qc', functionScope: 'read' })(
  getDispositionBase,
);
export const recordNcrOutcomeHandler = requireRole({ module: 'qc', functionScope: 'write' })(
  recordNcrOutcomeBase,
);
export const listQcNcrsHandler = requireRole({ module: 'qc', functionScope: 'read' })(listNcrsBase);
export const logRetentionSampleHandler = requireRole({ module: 'qc', functionScope: 'write' })(
  logRetentionSampleBase,
);
export const releaseLotHandler = requireRole({ module: 'qc', functionScope: 'write' })(
  releaseLotBase,
);
export const getQcReleaseHandler = requireRole({ module: 'qc', functionScope: 'read' })(
  getReleaseBase,
);
export const getQcRetentionSampleHandler = requireRole({ module: 'qc', functionScope: 'read' })(
  getRetentionSampleBase,
);
export const getQcNcrHandler = requireRole({ module: 'qc', functionScope: 'read' })(getNcrBase);
