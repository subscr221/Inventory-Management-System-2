import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import {
  getParsedBody,
  getAuthContext,
  getAuthorizedAssignment,
  getTraceId,
} from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { PersistedEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getMeterById, listMeters } from '../../read/projections/asset_meter.js';
import {
  getMeterReadingById,
  listMeterReadings,
} from '../../read/projections/asset_meter_reading.js';
import { getPlanById, listPlans } from '../../read/projections/maintenance_plan.js';
import { getWorkOrderById, listWorkOrders } from '../../read/projections/maintenance_work_order.js';
import {
  runGraceWindowSweep,
  runMeterReconciliation,
  runPmGeneration,
} from '../../maintenance/pm-jobs.js';

/**
 * Story 7.2 REST surface: PM plans, work orders and the generic meter-reading ingestion API
 * (FR-M-02, FR-M-03). All decisions live in src/compliance/maintenance-plan.ts and
 * src/compliance/asset-meter.ts, not here, so a direct POST /api/v1/events cannot bypass them;
 * these handlers own only the capture-time resolutions (server-minted ids, actor stamping,
 * next-due computation at definition time) and the response shape.
 *
 * The three job endpoints are the Phase-1 scheduling surface: there is no cron in this process,
 * and every job takes an explicit business_date so a run is deterministic and re-runnable (the
 * Story 2.7 planning-job precedent).
 *
 * Like the asset register, this surface is enterprise-scoped (AD-9), so no handler applies a site
 * filter.
 */

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const PLAN_TYPES = new Set(['calendar', 'meter']);
const PLAN_STATUSES = new Set(['active', 'inactive']);
const WORK_ORDER_STATUSES = new Set(['open', 'overdue', 'completed']);
// Mirrors the seam cap: day-count bounds for the interval fields keep PostgreSQL date arithmetic
// (and the handler's addDays below) inside their ranges.
const MAX_INTERVAL_DAYS = 100000;
// Mirrors the seam's reading_at contract: an explicit UTC offset is required so JS Date.parse
// (process-local time) and pg ::timestamptz (session time) cannot disagree on the stored instant.
const ISO8601_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

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

/**
 * A blank or non-string idempotency key is "not supplied": passing '' through would make two
 * genuinely different writes collide on the uq_idempotency row and collapse into one replay of the
 * first (the Story 7.1 review lesson).
 */
function idempotencyKeyFrom(body: Record<string, unknown>): string {
  return typeof body['idempotency_key'] === 'string' && body['idempotency_key'].trim() !== ''
    ? body['idempotency_key']
    : randomUUID();
}

/**
 * persistEvent returns ANY event already holding this idempotency key, regardless of stream or
 * event type. A legitimate replay is the same event type carrying the same id field; anything else
 * means the client reused a key from a different write - surface a 409 instead of a phantom 201
 * built from a foreign event's payload (the Story 7.1 review lesson).
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

/** Mirrors the helper in src/api/v1/inventory-planning.ts; the jobs need an explicit run date. */
function requireBusinessDate(body: Record<string, unknown>): string {
  if (
    typeof body['business_date'] !== 'string' ||
    !DATE_REGEX.test(body['business_date']) ||
    // The regex accepts impossible dates like 2026-02-30; they fail later as an unmapped SQL
    // date-cast 500 instead of the Table 4-promised INVALID_PARAMS 400.
    Number.isNaN(Date.parse(body['business_date']))
  ) {
    throw new AppError(400, 'INVALID_PARAMS', 'business_date is required and must be YYYY-MM-DD');
  }
  return body['business_date'];
}

function optionalAssetIdFilter(body: Record<string, unknown>): string | undefined {
  const value = body['asset_id'];
  if (value === undefined || value === null) return undefined;
  if (!isUuid(value)) {
    throw new AppError(400, 'INVALID_PARAMS', 'asset_id must be a UUID when provided');
  }
  return value;
}

/** Adds whole days to an ISO date in UTC (the pm-jobs helper, duplicated to keep the API layer pure). */
function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map((part) => Number(part));
  const base = Date.UTC(y!, m! - 1, d!);
  return new Date(base + days * 86400000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// POST /api/v1/maintenance/meters
// ---------------------------------------------------------------------------

const createMeterBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const meterId = randomUUID();
  const now = new Date().toISOString();

  try {
    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: meterId,
        event_type: 'maintenance.meter_registered',
        payload: {
          meter_id: meterId,
          asset_id: body['asset_id'],
          meter_code:
            typeof body['meter_code'] === 'string' ? body['meter_code'].trim() : body['meter_code'],
          unit: body['unit'],
          // 30 days is the Phase-1 default silent window; every meter may override it.
          silent_after_days: body['silent_after_days'] ?? 30,
          alert_role:
            typeof body['alert_role'] === 'string' ? body['alert_role'].trim() : body['alert_role'],
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: actor.userId,
            role: actor.role,
            location_id: actor.eventLocationId,
          },
          occurred_at: now,
        },
        idempotency_key: idempotencyKeyFrom(body),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );

    const persistedMeterId = replayIdOrReject(
      persisted,
      'maintenance.meter_registered',
      'meter_id',
    );
    const meter = await getMeterById(persistedMeterId);
    sendJson(res, 201, { event_id: persisted.event_id, meter: meter ?? null });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/maintenance/meters
// ---------------------------------------------------------------------------

const listMetersBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const assetId = url.searchParams.get('asset_id');
  if (assetId !== null && !isUuid(assetId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'asset_id must be a UUID');
    return;
  }
  const silentOnly = url.searchParams.get('silent_only');
  // Only the literal true/false are accepted: a typo ('TRUE', '1', 'yes') must not silently
  // widen the result to every meter.
  if (silentOnly !== null && silentOnly !== 'true' && silentOnly !== 'false') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'silent_only must be true or false');
    return;
  }
  const limitRaw = url.searchParams.get('limit');
  const offsetRaw = url.searchParams.get('offset');
  const meters = await listMeters({
    asset_id: assetId ?? undefined,
    silent_only: silentOnly === 'true',
    limit: limitRaw === null ? undefined : Number(limitRaw),
    offset: offsetRaw === null ? undefined : Number(offsetRaw),
  });
  sendJson(res, 200, { meters });
};

// ---------------------------------------------------------------------------
// POST /api/v1/maintenance/meters/reconcile
// ---------------------------------------------------------------------------

const reconcileMetersBase: RouteHandler = async (req, res, _params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);
  try {
    const result = await runMeterReconciliation({
      business_date: requireBusinessDate(body),
      asset_id: optionalAssetIdFilter(body),
      actor: {
        user_id: actor.userId,
        role: actor.role,
        location_id: actor.eventLocationId,
      },
      auditCtx: auditCtxFor(req, actor, 200),
    });
    sendJson(res, 200, result);
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/maintenance/meters/:meterId/readings
// ---------------------------------------------------------------------------

const listMeterReadingsBase: RouteHandler = async (req, res, params) => {
  const meterId = params?.['meterId'];
  if (!meterId || !isUuid(meterId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'meterId must be a UUID');
    return;
  }
  const meter = await getMeterById(meterId);
  if (!meter) {
    sendRequestError(req, res, 404, 'METER_NOT_FOUND', 'Meter not found', { meter_id: meterId });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  // The accessor interpolates these into SQL; an unparseable value would surface as an unmapped
  // 22007 500 for a client error, so validate here like the seam's reading_at treatment.
  if (from !== null && Number.isNaN(Date.parse(from))) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'from must be an ISO timestamp');
    return;
  }
  if (to !== null && Number.isNaN(Date.parse(to))) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'to must be an ISO timestamp');
    return;
  }
  const limitRaw = url.searchParams.get('limit');
  const offsetRaw = url.searchParams.get('offset');
  const readings = await listMeterReadings({
    meter_id: meterId,
    from: from ?? undefined,
    to: to ?? undefined,
    limit: limitRaw === null ? undefined : Number(limitRaw),
    offset: offsetRaw === null ? undefined : Number(offsetRaw),
  });
  sendJson(res, 200, { meter, readings });
};

// ---------------------------------------------------------------------------
// POST /api/v1/maintenance/meter-readings
// ---------------------------------------------------------------------------

const recordMeterReadingBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const readingId = randomUUID();
  const now = new Date().toISOString();

  // Absence falls back to ingestion time (sanctioned); malformed PRESENCE is a client error and
  // must not silently stamp the observation at now - that would shift the AC 5 silent-meter
  // clock for a device-feed bug.
  if (
    body['reading_at'] !== undefined &&
    (typeof body['reading_at'] !== 'string' || !ISO8601_TIMESTAMP_REGEX.test(body['reading_at']))
  ) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'reading_at must be an ISO-8601 timestamp with an explicit UTC offset when provided',
    );
    return;
  }

  // The reading payload declares the meter's own asset (AC 4 contract); resolve it server-side so
  // the caller never guesses it. The applier re-validates inside the transaction and rejects a
  // mismatched direct-event envelope.
  const meterId = typeof body['meter_id'] === 'string' ? body['meter_id'] : null;
  if (!meterId || !isUuid(meterId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'meter_id is required and must be a UUID');
    return;
  }
  const meter = await getMeterById(meterId);
  if (!meter) {
    sendRequestError(req, res, 404, 'METER_NOT_FOUND', 'Meter not found', { meter_id: meterId });
    return;
  }

  try {
    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: meterId,
        event_type: 'maintenance.meter_reading_recorded',
        payload: {
          reading_id: readingId,
          meter_id: meterId,
          asset_id: meter.asset_id,
          reading_value: body['reading_value'],
          reading_at: typeof body['reading_at'] === 'string' ? body['reading_at'] : now,
          // AC 4: the source is declared by the caller and recorded verbatim; Phase 1 sends
          // 'manual', and the hub-booking and station-equipment feeds need no code change here.
          source: body['source'] ?? 'manual',
          capture_method: body['capture_method'] ?? 'manual_entry',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: actor.userId,
            role: actor.role,
            location_id: actor.eventLocationId,
          },
          occurred_at: now,
        },
        idempotency_key: idempotencyKeyFrom(body),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );

    const persistedReadingId = replayIdOrReject(
      persisted,
      'maintenance.meter_reading_recorded',
      'reading_id',
    );
    const persistedMeterId = (persisted.payload as Record<string, unknown>)['meter_id'] as string;
    const freshMeter = await getMeterById(persistedMeterId);
    // Read back the persisted row BY ID: the meter's newest row is not necessarily this reading
    // (a backdated reading must not come back as a different one).
    const reading = await getMeterReadingById(persistedReadingId);
    sendJson(res, 201, {
      event_id: persisted.event_id,
      reading_id: persistedReadingId,
      reading: reading ?? null,
      meter: freshMeter ?? null,
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// POST /api/v1/maintenance/plans
// ---------------------------------------------------------------------------

const createPlanBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const planId = randomUUID();
  const now = new Date().toISOString();
  const planType = body['plan_type'];

  try {
    if (typeof planType !== 'string' || !PLAN_TYPES.has(planType)) {
      throw new AppError(400, 'INVALID_PARAMS', 'plan_type must be one of: calendar, meter', {
        plan_type: planType,
      });
    }
    const anchorDate = body['anchor_date'];
    if (typeof anchorDate !== 'string' || !DATE_REGEX.test(anchorDate)) {
      throw new AppError(400, 'INVALID_PARAMS', 'anchor_date is required and must be YYYY-MM-DD', {
        anchor_date: anchorDate,
      });
    }

    // The first due cycle is computed here, once, at definition time. A calendar plan falls due one
    // interval after its anchor; a meter plan falls due one interval after the meter's reading at
    // definition time (an explicit next_due_meter in the body overrides that).
    let nextDueDate: string | null = null;
    let nextDueMeter: number | null = null;
    if (planType === 'calendar') {
      const intervalDays = body['interval_days'];
      // The seam caps interval_days at MAX_INTERVAL_DAYS too, but this addDays call runs BEFORE
      // the seam; an uncapped value (e.g. 1e9) would overflow Date.UTC and throw a RangeError
      // (raw 500) instead of a clean 400.
      if (
        !Number.isInteger(intervalDays) ||
        (intervalDays as number) <= 0 ||
        (intervalDays as number) > MAX_INTERVAL_DAYS
      ) {
        throw new AppError(
          400,
          'INVALID_PARAMS',
          `interval_days must be a positive integer of at most ${MAX_INTERVAL_DAYS}`,
          { interval_days: intervalDays },
        );
      }
      nextDueDate =
        typeof body['next_due_date'] === 'string' && DATE_REGEX.test(body['next_due_date'])
          ? body['next_due_date']
          : addDays(anchorDate, intervalDays as number);
    } else {
      const intervalUnits = body['interval_meter_units'];
      if (
        typeof intervalUnits !== 'number' ||
        !Number.isFinite(intervalUnits) ||
        intervalUnits <= 0
      ) {
        throw new AppError(
          400,
          'INVALID_PARAMS',
          'interval_meter_units must be a positive number',
          { interval_meter_units: intervalUnits },
        );
      }
      // next_due_meter is derived in the seam from the meter row read under FOR UPDATE when the
      // body omits it (the "falls due one interval after the meter's reading at definition time"
      // contract, race-free); an explicit override still wins.
      nextDueMeter = typeof body['next_due_meter'] === 'number' ? body['next_due_meter'] : null;
    }

    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: planId,
        event_type: 'maintenance.plan_defined',
        payload: {
          plan_id: planId,
          asset_id: body['asset_id'],
          plan_name:
            typeof body['plan_name'] === 'string' ? body['plan_name'].trim() : body['plan_name'],
          plan_type: planType,
          interval_days: planType === 'calendar' ? body['interval_days'] : null,
          meter_id: planType === 'meter' ? body['meter_id'] : null,
          interval_meter_units: planType === 'meter' ? body['interval_meter_units'] : null,
          grace_period_days: body['grace_period_days'],
          escalation_role:
            typeof body['escalation_role'] === 'string'
              ? body['escalation_role'].trim()
              : body['escalation_role'],
          anchor_date: anchorDate,
          next_due_date: nextDueDate,
          next_due_meter: nextDueMeter,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: actor.userId,
            role: actor.role,
            location_id: actor.eventLocationId,
          },
          occurred_at: now,
        },
        idempotency_key: idempotencyKeyFrom(body),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );

    const persistedPlanId = replayIdOrReject(persisted, 'maintenance.plan_defined', 'plan_id');
    const plan = await getPlanById(persistedPlanId);
    sendJson(res, 201, { event_id: persisted.event_id, plan: plan ?? null });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/maintenance/plans
// ---------------------------------------------------------------------------

const listPlansBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const assetId = url.searchParams.get('asset_id');
  const planType = url.searchParams.get('plan_type');
  const status = url.searchParams.get('status');
  const limitRaw = url.searchParams.get('limit');
  const offsetRaw = url.searchParams.get('offset');

  if (assetId !== null && !isUuid(assetId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'asset_id must be a UUID');
    return;
  }
  if (planType !== null && !PLAN_TYPES.has(planType)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'plan_type must be one of: calendar, meter');
    return;
  }
  if (status !== null && !PLAN_STATUSES.has(status)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'status must be one of: active, inactive');
    return;
  }

  const plans = await listPlans({
    asset_id: assetId ?? undefined,
    plan_type: (planType as 'calendar' | 'meter' | null) ?? undefined,
    status: (status as 'active' | 'inactive' | null) ?? undefined,
    limit: limitRaw === null ? undefined : Number(limitRaw),
    offset: offsetRaw === null ? undefined : Number(offsetRaw),
  });
  sendJson(res, 200, { plans });
};

// ---------------------------------------------------------------------------
// GET /api/v1/maintenance/plans/:planId
// ---------------------------------------------------------------------------

const getPlanBase: RouteHandler = async (req, res, params) => {
  const planId = params?.['planId'];
  if (!planId || !isUuid(planId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'planId must be a UUID');
    return;
  }
  const plan = await getPlanById(planId);
  if (!plan) {
    sendRequestError(req, res, 404, 'PLAN_NOT_FOUND', 'Maintenance plan not found', {
      plan_id: planId,
    });
    return;
  }
  // The remaining-units figure is what AC 3 means by "PM due calculations update": every accepted
  // reading shrinks it, and it reaches zero exactly when the plan becomes due.
  let meterUnitsRemaining: string | null = null;
  if (plan.plan_type === 'meter' && plan.meter_id !== null && plan.next_due_meter !== null) {
    const meter = await getMeterById(plan.meter_id);
    if (meter) {
      meterUnitsRemaining = String(
        Math.max(Number(plan.next_due_meter) - Number(meter.current_reading), 0),
      );
    }
  }
  sendJson(res, 200, { plan, meter_units_remaining: meterUnitsRemaining });
};

// ---------------------------------------------------------------------------
// POST /api/v1/maintenance/pm/generate
// ---------------------------------------------------------------------------

const generateWorkOrdersBase: RouteHandler = async (req, res, _params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);
  try {
    const result = await runPmGeneration({
      business_date: requireBusinessDate(body),
      asset_id: optionalAssetIdFilter(body),
      actor: {
        user_id: actor.userId,
        role: actor.role,
        location_id: actor.eventLocationId,
      },
      auditCtx: auditCtxFor(req, actor, 200),
    });
    sendJson(res, 200, result);
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// POST /api/v1/maintenance/pm/grace-sweep
// ---------------------------------------------------------------------------

const sweepGraceWindowsBase: RouteHandler = async (req, res, _params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);
  try {
    const result = await runGraceWindowSweep({
      business_date: requireBusinessDate(body),
      asset_id: optionalAssetIdFilter(body),
      actor: {
        user_id: actor.userId,
        role: actor.role,
        location_id: actor.eventLocationId,
      },
      auditCtx: auditCtxFor(req, actor, 200),
    });
    sendJson(res, 200, result);
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/maintenance/work-orders
// ---------------------------------------------------------------------------

const listWorkOrdersBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const assetId = url.searchParams.get('asset_id');
  const planId = url.searchParams.get('plan_id');
  const status = url.searchParams.get('status');
  const limitRaw = url.searchParams.get('limit');
  const offsetRaw = url.searchParams.get('offset');

  if (assetId !== null && !isUuid(assetId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'asset_id must be a UUID');
    return;
  }
  if (planId !== null && !isUuid(planId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'plan_id must be a UUID');
    return;
  }
  if (status !== null && !WORK_ORDER_STATUSES.has(status)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'status must be one of: open, overdue, completed',
    );
    return;
  }

  const workOrders = await listWorkOrders({
    asset_id: assetId ?? undefined,
    plan_id: planId ?? undefined,
    status: (status as 'open' | 'overdue' | 'completed' | null) ?? undefined,
    limit: limitRaw === null ? undefined : Number(limitRaw),
    offset: offsetRaw === null ? undefined : Number(offsetRaw),
  });
  sendJson(res, 200, { work_orders: workOrders });
};

// ---------------------------------------------------------------------------
// GET /api/v1/maintenance/work-orders/:workOrderId
// ---------------------------------------------------------------------------

const getWorkOrderBase: RouteHandler = async (req, res, params) => {
  const workOrderId = params?.['workOrderId'];
  if (!workOrderId || !isUuid(workOrderId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'workOrderId must be a UUID');
    return;
  }
  const workOrder = await getWorkOrderById(workOrderId);
  if (!workOrder) {
    sendRequestError(req, res, 404, 'WORK_ORDER_NOT_FOUND', 'Work order not found', {
      work_order_id: workOrderId,
    });
    return;
  }
  sendJson(res, 200, { work_order: workOrder });
};

// ---------------------------------------------------------------------------
// POST /api/v1/maintenance/work-orders/:workOrderId/complete
// ---------------------------------------------------------------------------

const completeWorkOrderBase: RouteHandler = async (req, res, params) => {
  const workOrderId = params?.['workOrderId'];
  if (!workOrderId || !isUuid(workOrderId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'workOrderId must be a UUID');
    return;
  }
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);
  const now = new Date().toISOString();

  try {
    const existing = await getWorkOrderById(workOrderId);
    if (!existing) {
      throw new AppError(404, 'WORK_ORDER_NOT_FOUND', 'Work order not found', {
        work_order_id: workOrderId,
      });
    }

    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: workOrderId,
        event_type: 'maintenance.work_order_completed',
        payload: {
          work_order_id: workOrderId,
          asset_id: existing.asset_id,
          completed_at: now,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: actor.userId,
            role: actor.role,
            location_id: actor.eventLocationId,
          },
          occurred_at: now,
        },
        idempotency_key: idempotencyKeyFrom(body),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 200),
    );

    const persistedWorkOrderId = replayIdOrReject(
      persisted,
      'maintenance.work_order_completed',
      'work_order_id',
    );
    const workOrder = await getWorkOrderById(persistedWorkOrderId);
    sendJson(res, 200, { event_id: persisted.event_id, work_order: workOrder ?? null });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const createMeterHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(createMeterBase);

export const listMetersHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listMetersBase);

export const reconcileMetersHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(reconcileMetersBase);

export const listMeterReadingsHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listMeterReadingsBase);

export const recordMeterReadingHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(recordMeterReadingBase);

export const createPlanHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(createPlanBase);

export const listPlansHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listPlansBase);

export const getPlanHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(getPlanBase);

export const generateWorkOrdersHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(generateWorkOrdersBase);

export const sweepGraceWindowsHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(sweepGraceWindowsBase);

export const listWorkOrdersHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listWorkOrdersBase);

export const getWorkOrderHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(getWorkOrderBase);

export const completeWorkOrderHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(completeWorkOrderBase);
