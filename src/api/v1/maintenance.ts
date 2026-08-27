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
import { emitNotification } from '../../notify/emit.js';
import { getPool } from '../../config/db.js';
import { isValidCalendarDate, toIstCalendarDate } from '../../lib/business-days.js';
import { config } from '../../config/index.js';
import { getMeterById, listMeters } from '../../read/projections/asset_meter.js';
import { getAssetById, getAssetByTag } from '../../read/projections/asset.js';
import {
  getMeterReadingById,
  listMeterReadings,
} from '../../read/projections/asset_meter_reading.js';
import { getPlanById, listPlans } from '../../read/projections/maintenance_plan.js';
import { getWorkOrderById, listWorkOrders } from '../../read/projections/maintenance_work_order.js';
import {
  getSlaPolicyById,
  getActiveSlaPolicy,
  listSlaPolicies,
} from '../../read/projections/maintenance_sla_policy.js';
import {
  getFaultReportById,
  listFaultReports,
  setFaultNotified,
} from '../../read/projections/maintenance_fault_report.js';
import { getDowntimeByWorkOrder } from '../../read/projections/maintenance_downtime.js';
import { listReliabilityMetrics } from '../../read/projections/maintenance_reliability_metric.js';
import {
  runGraceWindowSweep,
  runMeterReconciliation,
  runPmGeneration,
} from '../../maintenance/pm-jobs.js';
import { runReliabilityReport } from '../../maintenance/reliability-jobs.js';
import {
  runCriticalSpareBreachScan,
  runOverdueReturnSweep,
} from '../../maintenance/spares-jobs.js';
import { canonicalSku, deriveReturnDueDate } from '../../compliance/maintenance-spares.js';
import {
  getSpareCatalogueById,
  listSpareCatalogue,
} from '../../read/projections/maintenance_spare_catalogue.js';
import {
  getAssetPartById,
  listAssetParts,
  listWhereUsedBySku,
} from '../../read/projections/asset_parts_list.js';
import {
  getSpareReservationById,
  listSpareReservations,
} from '../../read/projections/maintenance_spare_reservation.js';
import { listSpareAlerts } from '../../read/projections/maintenance_spare_alert.js';
import { runCalibrationExpiryScan } from '../../maintenance/calibration-jobs.js';
import { runStatutoryExaminationScan } from '../../maintenance/statutory-jobs.js';
import {
  CALIBRATION_STAGES,
  MAX_CALIBRATION_INTERVAL_DAYS,
  MAX_CERTIFICATE_NUMBER_LENGTH,
  MAX_INSTRUMENT_ID_LENGTH,
  canonicalCertificateNumber,
  canonicalInstrumentId,
} from '../../compliance/calibration-register.js';
import {
  MAX_EXAMINATION_INTERVAL_MONTHS,
  STATUTORY_EXAMINATION_STATUSES,
  STATUTORY_EXAMINATION_TYPES,
  canonicalDeviceKey,
} from '../../compliance/maintenance-statutory.js';
import {
  ALLOWED_TRANSITIONS,
  ASSET_OPERATIONAL_STATUSES,
  NO_STATUS_KEY,
  RETURN_TO_SERVICE_DOA_TYPE,
  requiresReturnToServiceSignOff,
} from '../../compliance/asset-operational-status.js';
import { resolveApprover } from './indents.js';
import { getLocationById } from '../../read/projections/location_register.js';
import { findFirstActiveDoaEntry, findRoleHolder } from '../../read/projections/doa_registry.js';
import {
  getInstrumentRecordById,
  listInstrumentRecords,
} from '../../read/projections/instrument_register.js';
import {
  getActiveCertificate,
  getCertificateById,
  listCertificatesByInstrument,
} from '../../read/projections/instrument_calibration_certificate.js';
import { listCalibrationAlerts } from '../../read/projections/instrument_calibration_alert.js';
import {
  getEscalationById,
  listEscalations,
} from '../../read/projections/instrument_calibration_escalation.js';
import { getInstrumentCalibrationStatus } from '../../read/projections/instrument_calibration.js';
import {
  getExaminationByAssetAndType,
  getExaminationById,
  listExaminations,
} from '../../read/projections/statutory_examination.js';
import { listRecordsByExamination } from '../../read/projections/statutory_examination_record.js';
import {
  getAssetOperationalStatus,
  listAssetOperationalStatuses,
} from '../../read/projections/asset_operational_status.js';
import {
  getMaintenanceAssetCost,
  listMaintenanceAssetCosts,
} from '../../read/projections/maintenance_asset_cost.js';
// Story 7.7 (FR-M-10, FR-M-11): AMC, warranty and insurance coverage plus the reason-coded
// warranty override.
import {
  COVERAGE_STAGES,
  COVERAGE_TYPES,
  MAX_REASON_CODE_LENGTH,
  MAX_TEXT_LENGTH as MAX_COVERAGE_TEXT_LENGTH,
} from '../../compliance/maintenance-coverage.js';
import { getCoverageById, listCoverages } from '../../read/projections/asset_coverage.js';
import { listCoverageAlerts } from '../../read/projections/asset_coverage_alert.js';
import {
  getWarrantyOverrideById,
  getWarrantyOverrideByWorkOrder,
} from '../../read/projections/maintenance_warranty_override.js';
import { runCoverageExpiryScan } from '../../maintenance/coverage-jobs.js';

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

// Story 7.3 vocabularies and bounds, mirroring the SLA policy table's CHECK constraints.
const CRITICALITY_CLASSES = new Set(['critical', 'high', 'medium', 'low']);
const PRIORITIES = new Set(['p1', 'p2', 'p3', 'p4']);
const WORK_ORDER_ORIGINS = new Set(['preventive', 'breakdown']);
const SLA_POLICY_STATUSES = new Set(['active', 'inactive']);
const FAULT_STATUSES = new Set(['reported', 'accepted', 'rejected']);
const RELIABILITY_SCOPE_TYPES = new Set(['asset', 'criticality_class']);

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
    // The regex and Date.parse admit impossible dates like 2026-02-30 (Date.parse normalizes
    // them); they fail later as an unmapped SQL date-cast 500 instead of the promised
    // INVALID_PARAMS 400. The round-trip check rejects them here.
    !isValidCalendarDate(body['business_date'])
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

/** Adds whole minutes to an ISO timestamp in UTC; the SLA derivation is pinned to UTC. */
function addMinutesToIso(iso: string | Date, minutes: number): string {
  // pg returns timestamptz columns as Date objects; Date.parse(Date) truncates milliseconds via
  // Date.prototype.toString, so normalize to epoch millis first (a 333ms reported_at must not
  // become a 000ms SLA due - the seam re-derives the SAME values and rejects divergence).
  const baseMs = iso instanceof Date ? iso.getTime() : Date.parse(iso);
  return new Date(baseMs + minutes * 60000).toISOString();
}

/**
 * Story 7.3 SLA Derivation Contract, computed ONCE at the handler so the declared event payload
 * carries every derived field; the seam re-derives the same values from the LOCKED rows and
 * rejects any divergence (WORK_ORDER_DERIVATION_MISMATCH). due_date is the UTC calendar date of
 * the resolution target (pinned so no session timezone can shift it); breakdown work orders have
 * no grace window, so grace_until_date equals due_date.
 */
function deriveSlaFields(
  reportedAt: string | Date,
  responseMinutes: number,
  resolutionHours: number,
): {
  sla_response_due_at: string;
  sla_resolution_due_at: string;
  due_date: string;
  grace_until_date: string;
} {
  const slaResponseDueAt = addMinutesToIso(reportedAt, responseMinutes);
  const slaResolutionDueAt = addMinutesToIso(reportedAt, resolutionHours * 60);
  const dueDate = new Date(Date.parse(slaResolutionDueAt)).toISOString().slice(0, 10);
  return {
    sla_response_due_at: slaResponseDueAt,
    sla_resolution_due_at: slaResolutionDueAt,
    due_date: dueDate,
    grace_until_date: dueDate,
  };
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
  const origin = url.searchParams.get('origin');
  const priority = url.searchParams.get('priority');
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
  // Story 7.3: strict filters - an unknown origin or priority must 400, never silently widen the
  // result (Task 6.5).
  if (origin !== null && !WORK_ORDER_ORIGINS.has(origin)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'origin must be one of: preventive, breakdown',
    );
    return;
  }
  if (priority !== null && !PRIORITIES.has(priority)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'priority must be one of: p1, p2, p3, p4');
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
  if (limitRaw !== null && !/^-?\d+$/.test(limitRaw)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'limit must be an integer');
    return;
  }
  if (offsetRaw !== null && !/^-?\d+$/.test(offsetRaw)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'offset must be an integer');
    return;
  }

  const workOrders = await listWorkOrders({
    asset_id: assetId ?? undefined,
    plan_id: planId ?? undefined,
    origin: (origin as 'preventive' | 'breakdown' | null) ?? undefined,
    priority: (priority as 'p1' | 'p2' | 'p3' | 'p4' | null) ?? undefined,
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

    // Story 7.7 (FR-M-11, AC 3): the chargeable-work pre-check, for a clean early 403 before the
    // event is minted. The AUTHORITATIVE gate is in applyWorkOrderCompleted under the work order's
    // lock, so the direct-event path cannot bypass it (AD-12); this mirrors the way
    // setAssetStatusBase pre-checks the Story 7.6 statutory use-lock.
    if (existing.warranty_flagged === true) {
      const override = await getWarrantyOverrideByWorkOrder(workOrderId);
      if (!override) {
        throw new AppError(
          403,
          'APPROVAL_REQUIRED',
          'This work order is warranty-flagged: record a reason-coded override before completing it',
          {
            work_order_id: workOrderId,
            warranty_coverage_id: existing.warranty_coverage_id,
          },
        );
      }
    }

    // Story 7.6 (FR-M-15): optional additive cost fields, NUMERIC strings. A declared non-string
    // or a string that fails the regex is rejected INVALID_COST, never coerced (the wire-boolean
    // lesson applied to costs). The seam validates them again and derives total_cost /
    // capitalization_flagged server-side, writing both back onto the persisted payload.
    const laborCostRaw = body['labor_cost'];
    if (laborCostRaw !== undefined && laborCostRaw !== null) {
      if (typeof laborCostRaw !== 'string' || !COST_NUMERIC_REGEX.test(laborCostRaw)) {
        throw new AppError(
          400,
          'INVALID_COST',
          'labor_cost must be a NUMERIC string with at most 3 decimals',
          { labor_cost: laborCostRaw },
        );
      }
    }
    const partsCostRaw = body['parts_cost'];
    if (partsCostRaw !== undefined && partsCostRaw !== null) {
      if (typeof partsCostRaw !== 'string' || !COST_NUMERIC_REGEX.test(partsCostRaw)) {
        throw new AppError(
          400,
          'INVALID_COST',
          'parts_cost must be a NUMERIC string with at most 3 decimals',
          { parts_cost: partsCostRaw },
        );
      }
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
          ...(laborCostRaw === undefined || laborCostRaw === null
            ? {}
            : { labor_cost: laborCostRaw }),
          ...(partsCostRaw === undefined || partsCostRaw === null
            ? {}
            : { parts_cost: partsCostRaw }),
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
// Story 7.3: Fault Reporting and Breakdown Work Orders
// ---------------------------------------------------------------------------

// POST /api/v1/maintenance/sla-policies

const createSlaPolicyBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const policyId = randomUUID();
  const now = new Date().toISOString();

  try {
    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: policyId,
        event_type: 'maintenance.sla_policy_defined',
        payload: {
          policy_id: policyId,
          criticality_class: body['criticality_class'],
          safety_flag: body['safety_flag'] ?? false,
          priority: body['priority'],
          response_minutes: body['response_minutes'],
          resolution_hours: body['resolution_hours'],
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

    const persistedPolicyId = replayIdOrReject(
      persisted,
      'maintenance.sla_policy_defined',
      'policy_id',
    );
    const policy = await getSlaPolicyById(persistedPolicyId);
    sendJson(res, 201, { event_id: persisted.event_id, policy: policy ?? null });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// GET /api/v1/maintenance/sla-policies

const listSlaPoliciesBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const criticalityClass = url.searchParams.get('criticality_class');
  const status = url.searchParams.get('status');
  const limitRaw = url.searchParams.get('limit');
  const offsetRaw = url.searchParams.get('offset');

  // Strict filters: an unknown value must 400, never silently widen the result (Task 6.5).
  if (criticalityClass !== null && !CRITICALITY_CLASSES.has(criticalityClass)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'criticality_class must be one of: critical, high, medium, low',
    );
    return;
  }
  if (status !== null && !SLA_POLICY_STATUSES.has(status)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'status must be one of: active, inactive');
    return;
  }
  if (limitRaw !== null && !/^-?\d+$/.test(limitRaw)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'limit must be an integer');
    return;
  }
  if (offsetRaw !== null && !/^-?\d+$/.test(offsetRaw)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'offset must be an integer');
    return;
  }

  const policies = await listSlaPolicies({
    criticality_class: criticalityClass ?? undefined,
    status: (status as 'active' | 'inactive' | null) ?? undefined,
    limit: limitRaw === null ? undefined : Number(limitRaw),
    offset: offsetRaw === null ? undefined : Number(offsetRaw),
  });
  sendJson(res, 200, { policies });
};

// POST /api/v1/maintenance/fault-reports

const createFaultReportBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const faultReportId = randomUUID();
  const now = new Date().toISOString();

  try {
    // Scan path (AC 1): accept EITHER asset_id or asset_tag. When only the tag is supplied the
    // handler resolves it case-insensitively so the operator never needs to know a UUID; the
    // persisted payload always carries the resolved asset_id AND the canonical asset_tag from the
    // asset row (Task 6.2).
    let assetId: string;
    let assetTag: string;
    const bodyAssetId = body['asset_id'];
    const bodyAssetTag = body['asset_tag'];
    if (typeof bodyAssetId === 'string' && bodyAssetId.trim() !== '') {
      // A supplied asset_id must be a UUID - a malformed id must not be silently ignored while a
      // tag happens to resolve (strict validation convention).
      if (!isUuid(bodyAssetId)) {
        throw new AppError(400, 'INVALID_PARAMS', 'asset_id must be a UUID');
      }
      const asset = await getAssetById(bodyAssetId);
      if (!asset) {
        throw new AppError(404, 'ASSET_NOT_FOUND', 'Asset not found', {
          asset_id: bodyAssetId,
        });
      }
      // When both identifiers are supplied they must agree - otherwise the scan could record a
      // fault against the wrong asset (ASSET_TAG_MISMATCH, Error Code Contract).
      if (typeof bodyAssetTag === 'string' && bodyAssetTag.trim() !== '') {
        if (asset.asset_tag.toLowerCase() !== bodyAssetTag.trim().toLowerCase()) {
          throw new AppError(
            400,
            'ASSET_TAG_MISMATCH',
            'asset_id and asset_tag do not refer to the same asset',
            { asset_id: bodyAssetId, asset_tag: bodyAssetTag.trim() },
          );
        }
      }
      assetId = asset.asset_id;
      assetTag = asset.asset_tag;
    } else if (typeof bodyAssetTag === 'string' && bodyAssetTag.trim() !== '') {
      const asset = await getAssetByTag(bodyAssetTag.trim());
      if (!asset) {
        throw new AppError(404, 'ASSET_NOT_FOUND', 'No asset matches this tag', {
          asset_tag: bodyAssetTag.trim(),
        });
      }
      assetId = asset.asset_id;
      assetTag = asset.asset_tag;
    } else {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'asset_id (UUID) or asset_tag (string) is required',
      );
    }

    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: faultReportId,
        event_type: 'maintenance.fault_reported',
        payload: {
          fault_report_id: faultReportId,
          asset_id: assetId,
          asset_tag: assetTag,
          description:
            typeof body['description'] === 'string'
              ? body['description'].trim()
              : body['description'],
          safety_flag: body['safety_flag'] ?? false,
          reported_at: now,
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

    const persistedFaultReportId = replayIdOrReject(
      persisted,
      'maintenance.fault_reported',
      'fault_report_id',
    );

    // The 5-minute AC 1 guarantee is the Story 1.11 escalation window. The emission happens AFTER
    // the fault event commits, through the non-throwing emitNotification (AD-17): a notification
    // outage must not block a fault report, so on ok:false the 201 still succeeds and notified_at
    // stays null (Task 6.3). NEVER emitNotificationInTransaction here.
    //
    // A replay of the same idempotency key returns the ORIGINAL event, so the handler would
    // otherwise emit a second notification; the notification row on the event ledger is the truth
    // that this report was already notified - skip the re-emission when one exists (the "replay
    // emits no second notification" acceptance assertion).
    const existingNotification = await getPool().query(
      `SELECT 1 FROM domain_events
        WHERE event_type = 'notification.created'
          AND payload->>'object_id' = $1
          AND payload->>'event_type' = 'fault_reported'
        LIMIT 1`,
      [persistedFaultReportId],
    );
    const asset = await getAssetById(assetId);
    if (existingNotification.rows.length === 0) {
      const emission = await emitNotification({
        target: { role: 'maintenance_supervisor', location_id: actor.eventLocationId },
        event_type: 'fault_reported',
        status_verb: 'Reported',
        object_type: 'fault_report',
        object_id: persistedFaultReportId,
        actor_label: `${asset?.asset_name ?? 'asset'} (${assetTag})`,
        next_step: 'Triage and accept or reject',
        escalation: { target_role: 'maintenance_manager', acknowledgment_window_seconds: 300 },
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        correlation_id: randomUUID(),
        occurred_at: now,
      });
      if (emission.ok) {
        const emittedAt = emission.event.metadata.occurred_at ?? emission.event.created_at;
        try {
          await setFaultNotified(persistedFaultReportId, emittedAt);
        } catch (patchErr: unknown) {
          // The fault report and the notification both committed; a failed notified_at patch must
          // not turn the 201 into a 500 (AD-17 - the notification must never block the report).
          console.warn(
            `[maintenance] notified_at patch failed for fault report ${persistedFaultReportId}`,
            patchErr,
          );
        }
      }
    }

    // Read back the created resource BY ID (the 7.2 lesson): notified_at reflects the emission.
    const faultReport = await getFaultReportById(persistedFaultReportId);
    sendJson(res, 201, { event_id: persisted.event_id, fault_report: faultReport ?? null });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// GET /api/v1/maintenance/fault-reports

const listFaultReportsBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const assetId = url.searchParams.get('asset_id');
  const status = url.searchParams.get('status');
  const locationId = url.searchParams.get('location_id');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const limitRaw = url.searchParams.get('limit');
  const offsetRaw = url.searchParams.get('offset');

  // Strict filters: an unknown value must 400, never silently widen the result (Task 6.5).
  if (assetId !== null && !isUuid(assetId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'asset_id must be a UUID');
    return;
  }
  if (status !== null && !FAULT_STATUSES.has(status)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'status must be one of: reported, accepted, rejected',
    );
    return;
  }
  if (locationId !== null && !isUuid(locationId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'location_id must be a UUID');
    return;
  }
  // from/to are timestamptz filters; require an explicit UTC offset so a date-only value is not
  // silently cast at session-local midnight (the documented clock-window failure family).
  if (from !== null && !ISO8601_TIMESTAMP_REGEX.test(from)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'from must be an ISO-8601 timestamp with an explicit UTC offset',
    );
    return;
  }
  if (to !== null && !ISO8601_TIMESTAMP_REGEX.test(to)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'to must be an ISO-8601 timestamp with an explicit UTC offset',
    );
    return;
  }
  if (limitRaw !== null && !/^-?\d+$/.test(limitRaw)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'limit must be an integer');
    return;
  }
  if (offsetRaw !== null && !/^-?\d+$/.test(offsetRaw)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'offset must be an integer');
    return;
  }

  const faultReports = await listFaultReports({
    asset_id: assetId ?? undefined,
    status: (status as 'reported' | 'accepted' | 'rejected' | null) ?? undefined,
    location_id: locationId ?? undefined,
    from: from ?? undefined,
    to: to ?? undefined,
    limit: limitRaw === null ? undefined : Number(limitRaw),
    offset: offsetRaw === null ? undefined : Number(offsetRaw),
  });
  sendJson(res, 200, { fault_reports: faultReports });
};

// GET /api/v1/maintenance/fault-reports/:faultReportId

const getFaultReportBase: RouteHandler = async (req, res, params) => {
  const faultReportId = params?.['faultReportId'];
  if (!faultReportId || !isUuid(faultReportId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'faultReportId must be a UUID');
    return;
  }
  const faultReport = await getFaultReportById(faultReportId);
  if (!faultReport) {
    sendRequestError(req, res, 404, 'FAULT_REPORT_NOT_FOUND', 'Fault report not found', {
      fault_report_id: faultReportId,
    });
    return;
  }
  sendJson(res, 200, { fault_report: faultReport });
};

// POST /api/v1/maintenance/fault-reports/:faultReportId/accept

const acceptFaultReportBase: RouteHandler = async (req, res, params) => {
  const faultReportId = params?.['faultReportId'];
  if (!faultReportId || !isUuid(faultReportId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'faultReportId must be a UUID');
    return;
  }
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);
  const now = new Date().toISOString();

  try {
    const report = await getFaultReportById(faultReportId);
    if (!report) {
      throw new AppError(404, 'FAULT_REPORT_NOT_FOUND', 'Fault report not found', {
        fault_report_id: faultReportId,
      });
    }
    // No status pre-check here: the seam re-validates status === 'reported' under FOR UPDATE inside
    // persistEvent, so a genuinely new double-accept still 409s FAULT_ALREADY_TRIAGED, while a
    // same-key idempotency replay short-circuits in persistEvent and resolves through
    // replayIdOrReject to the stored result (AD-16).
    const asset = await getAssetById(report.asset_id);
    if (!asset) {
      throw new AppError(404, 'ASSET_NOT_FOUND', 'Asset not found', {
        asset_id: report.asset_id,
      });
    }
    const policy = await getActiveSlaPolicy(asset.criticality_class, report.safety_flag);
    if (!policy) {
      throw new AppError(
        422,
        'SLA_POLICY_NOT_FOUND',
        'No active SLA policy exists for this (criticality_class, safety_flag) pair',
        { criticality_class: asset.criticality_class, safety_flag: report.safety_flag },
      );
    }

    // The SLA derivation is declared in the payload here and RE-VERIFIED by the seam under the
    // locked rows; divergence rejects WORK_ORDER_DERIVATION_MISMATCH (never silently stored).
    const derived = deriveSlaFields(
      report.reported_at as unknown as string,
      policy.response_minutes,
      policy.resolution_hours,
    );
    const workOrderId = randomUUID();
    const downtimeId = randomUUID();
    const businessDate = new Date().toISOString().slice(0, 10);

    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: workOrderId,
        event_type: 'maintenance.breakdown_work_order_created',
        payload: {
          work_order_id: workOrderId,
          fault_report_id: faultReportId,
          asset_id: report.asset_id,
          downtime_id: downtimeId,
          priority: policy.priority,
          sla_policy_id: policy.policy_id,
          due_date: derived.due_date,
          grace_until_date: derived.grace_until_date,
          sla_response_due_at: derived.sla_response_due_at,
          sla_resolution_due_at: derived.sla_resolution_due_at,
          business_date: businessDate,
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

    const persistedWorkOrderId = replayIdOrReject(
      persisted,
      'maintenance.breakdown_work_order_created',
      'work_order_id',
    );

    // AC 2 notification: same service, targeted at the technician at the fault's location, with
    // the resolution SLA in the next_step. No escalation - the grace sweep already owns the
    // overdue path. A failed emission is logged and swallowed (AD-17). A same-key replay of a
    // committed accept returns the ORIGINAL event, so skip the re-emission when the notification
    // row already exists on the ledger (the "replay emits no second notification" convention).
    const existingTechnicianNotification = await getPool().query(
      `SELECT 1 FROM domain_events
        WHERE event_type = 'notification.created'
          AND payload->>'object_id' = $1
          AND payload->>'event_type' = 'breakdown_work_order_created'
        LIMIT 1`,
      [persistedWorkOrderId],
    );
    if (existingTechnicianNotification.rows.length === 0) {
      await emitNotification({
        // The technician is notified at the FAULT's location (report.location_id), not the
        // acceptor's authorized location - they may differ (Notification Contract).
        target: { role: 'maintenance_technician', location_id: report.location_id },
        event_type: 'breakdown_work_order_created',
        status_verb: 'Created',
        object_type: 'maintenance_work_order',
        object_id: persistedWorkOrderId,
        actor_label: `${asset.asset_name} (${asset.asset_tag})`,
        next_step: `Resolve by ${derived.sla_resolution_due_at}.`,
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        correlation_id: randomUUID(),
        occurred_at: now,
      });
    }

    const workOrder = await getWorkOrderById(persistedWorkOrderId);
    const faultReport = await getFaultReportById(faultReportId);
    sendJson(res, 201, {
      event_id: persisted.event_id,
      work_order: workOrder ?? null,
      fault_report: faultReport ?? null,
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// POST /api/v1/maintenance/fault-reports/:faultReportId/reject

const rejectFaultReportBase: RouteHandler = async (req, res, params) => {
  const faultReportId = params?.['faultReportId'];
  if (!faultReportId || !isUuid(faultReportId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'faultReportId must be a UUID');
    return;
  }
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);
  const now = new Date().toISOString();

  try {
    const report = await getFaultReportById(faultReportId);
    if (!report) {
      throw new AppError(404, 'FAULT_REPORT_NOT_FOUND', 'Fault report not found', {
        fault_report_id: faultReportId,
      });
    }
    // No status pre-check here (same reasoning as accept): the seam re-validates status ===
    // 'reported' under FOR UPDATE, so a fresh double-reject 409s FAULT_ALREADY_TRIAGED while a
    // same-key replay resolves to the stored result through replayIdOrReject (AD-16).
    // Normalize nullable text before persisting; the seam re-asserts non-blank (Task 6.4 lesson).
    const rejectionReason =
      typeof body['rejection_reason'] === 'string' ? body['rejection_reason'].trim() : '';
    if (rejectionReason === '') {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'rejection_reason is required and must be a non-empty string',
      );
    }

    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: faultReportId,
        event_type: 'maintenance.fault_rejected',
        payload: {
          fault_report_id: faultReportId,
          rejection_reason: rejectionReason,
          triaged_at: now,
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

    const persistedFaultReportId = replayIdOrReject(
      persisted,
      'maintenance.fault_rejected',
      'fault_report_id',
    );
    const faultReport = await getFaultReportById(persistedFaultReportId);
    sendJson(res, 200, { event_id: persisted.event_id, fault_report: faultReport ?? null });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// POST /api/v1/maintenance/work-orders/:workOrderId/downtime/close

const closeDowntimeBase: RouteHandler = async (req, res, params) => {
  const workOrderId = params?.['workOrderId'];
  if (!workOrderId || !isUuid(workOrderId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'workOrderId must be a UUID');
    return;
  }
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);
  const now = new Date().toISOString();

  try {
    // The payload declares the window id, which the caller cannot guess: resolve it here so the
    // event names the REAL row (a missing window is 404 DOWNTIME_NOT_FOUND before persisting).
    const downtime = await getDowntimeByWorkOrder(workOrderId);
    if (!downtime) {
      throw new AppError(
        404,
        'DOWNTIME_NOT_FOUND',
        'No downtime window exists for this work order',
        {
          work_order_id: workOrderId,
        },
      );
    }
    // Absence falls back to ingestion time (sanctioned); malformed PRESENCE is a client error. A
    // non-string ended_at must not be silently replaced with now - that would skew duration_minutes
    // and the monthly reliability snapshot for a client bug.
    const endedAtRaw = body['ended_at'];
    if (endedAtRaw !== undefined && typeof endedAtRaw !== 'string') {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'ended_at must be a string (ISO-8601 timestamp with an explicit UTC offset) when provided',
      );
    }
    const endedAt = endedAtRaw ?? now;
    if (!ISO8601_TIMESTAMP_REGEX.test(endedAt)) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'ended_at must be an ISO-8601 timestamp with an explicit UTC offset when provided',
      );
    }

    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: downtime.downtime_id,
        event_type: 'maintenance.downtime_closed',
        payload: {
          downtime_id: downtime.downtime_id,
          work_order_id: workOrderId,
          ended_at: endedAt,
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

    const persistedDowntimeId = replayIdOrReject(
      persisted,
      'maintenance.downtime_closed',
      'downtime_id',
    );
    const closedDowntime = await getDowntimeByWorkOrder(workOrderId);
    sendJson(res, 200, {
      event_id: persisted.event_id,
      downtime_id: persistedDowntimeId,
      downtime: closedDowntime ?? null,
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// POST /api/v1/maintenance/reliability/generate

const generateReliabilityReportBase: RouteHandler = async (req, res, _params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);
  try {
    // business_date via the shared helper (5.3); period bounds validated at the handler for a
    // clean 400, then re-validated in full by the job (INVALID_REPORT_PERIOD).
    const businessDate = requireBusinessDate(body);
    const periodStart = body['period_start'];
    const periodEnd = body['period_end'];
    if (
      typeof periodStart !== 'string' ||
      !DATE_REGEX.test(periodStart) ||
      Number.isNaN(Date.parse(periodStart))
    ) {
      throw new AppError(
        400,
        'INVALID_REPORT_PERIOD',
        'period_start is required and must be YYYY-MM-DD',
      );
    }
    if (
      typeof periodEnd !== 'string' ||
      !DATE_REGEX.test(periodEnd) ||
      Number.isNaN(Date.parse(periodEnd))
    ) {
      throw new AppError(
        400,
        'INVALID_REPORT_PERIOD',
        'period_end is required and must be YYYY-MM-DD',
      );
    }

    const result = await runReliabilityReport({
      business_date: businessDate,
      period_start: periodStart,
      period_end: periodEnd,
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

// GET /api/v1/maintenance/reliability

const listReliabilityMetricsBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const periodStart = url.searchParams.get('period_start');
  const periodEnd = url.searchParams.get('period_end');
  const scopeType = url.searchParams.get('scope_type');
  const scopeKey = url.searchParams.get('scope_key');
  const limitRaw = url.searchParams.get('limit');
  const offsetRaw = url.searchParams.get('offset');

  // Strict filters: an unknown value must 400, never silently widen the result (Task 6.5).
  if (
    periodStart !== null &&
    (Number.isNaN(Date.parse(periodStart)) || !DATE_REGEX.test(periodStart))
  ) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'period_start must be YYYY-MM-DD');
    return;
  }
  if (periodEnd !== null && (Number.isNaN(Date.parse(periodEnd)) || !DATE_REGEX.test(periodEnd))) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'period_end must be YYYY-MM-DD');
    return;
  }
  if (scopeType !== null && !RELIABILITY_SCOPE_TYPES.has(scopeType)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'scope_type must be one of: asset, criticality_class',
    );
    return;
  }
  // scope_key must match its scope_type (Task 6.5 strict filters): a UUID for an asset row, a
  // criticality class (optionally <class>:<asset_id> when narrowed) for a class row. A malformed
  // key must 400, never silently return an empty page.
  if (scopeKey !== null) {
    const firstSegment = scopeKey.split(':')[0] ?? '';
    const scopedPart =
      scopeKey.indexOf(':') === -1 ? null : scopeKey.slice(scopeKey.indexOf(':') + 1);
    const keyOk =
      (scopeType === 'asset' && isUuid(scopeKey)) ||
      (scopeType === 'criticality_class' &&
        CRITICALITY_CLASSES.has(firstSegment) &&
        (scopedPart === null || isUuid(scopedPart))) ||
      (scopeType === null &&
        (isUuid(scopeKey) ||
          (CRITICALITY_CLASSES.has(firstSegment) && (scopedPart === null || isUuid(scopedPart)))));
    if (!keyOk) {
      sendRequestError(
        req,
        res,
        400,
        'INVALID_PARAMS',
        'scope_key must match scope_type (a UUID for asset, a criticality class for criticality_class)',
      );
      return;
    }
  }
  if (limitRaw !== null && !/^-?\d+$/.test(limitRaw)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'limit must be an integer');
    return;
  }
  if (offsetRaw !== null && !/^-?\d+$/.test(offsetRaw)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'offset must be an integer');
    return;
  }

  const metrics = await listReliabilityMetrics({
    period_start: periodStart ?? undefined,
    period_end: periodEnd ?? undefined,
    scope_type: (scopeType as 'asset' | 'criticality_class' | null) ?? undefined,
    scope_key: scopeKey ?? undefined,
    limit: limitRaw === null ? undefined : Number(limitRaw),
    offset: offsetRaw === null ? undefined : Number(offsetRaw),
  });
  sendJson(res, 200, { metrics });
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

export const createSlaPolicyHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(createSlaPolicyBase);

export const listSlaPoliciesHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listSlaPoliciesBase);

export const createFaultReportHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(createFaultReportBase);

export const listFaultReportsHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listFaultReportsBase);

export const getFaultReportHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(getFaultReportBase);

export const acceptFaultReportHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(acceptFaultReportBase);

export const rejectFaultReportHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(rejectFaultReportBase);

export const closeDowntimeHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(closeDowntimeBase);

export const generateReliabilityReportHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(generateReliabilityReportBase);

export const listReliabilityMetricsHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listReliabilityMetricsBase);

// ---------------------------------------------------------------------------
// Story 7.4: spare cataloguing, asset parts list, reservation lifecycle, alerts
// ---------------------------------------------------------------------------

const ALERT_TYPES = new Set(['min_breach', 'return_overdue']);
const RESERVATION_STATUSES = new Set([
  'reserved',
  'issued',
  'partially_returned',
  'returned',
  'cancelled',
]);
// A NUMERIC(18,6) literal. Quantities and levels travel as STRINGS end to end: 0.1 + 0.2 is not
// 0.3 in binary floating point, and a spare quantity that fails to reconcile with stock_balance by
// 1e-17 is a defect nobody can debug from the ledger. A JS number is accepted from the wire and
// normalized to a string here so a caller sending 2 rather than "2" is not punished.
const NUMERIC_REGEX = /^\d{1,12}(\.\d{1,6})?$/;

/** Normalizes a wire quantity to a canonical NUMERIC string, or null when it is not one. */
function numericStringOrNull(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const asString = String(value);
    return NUMERIC_REGEX.test(asString) ? asString : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return NUMERIC_REGEX.test(trimmed) ? trimmed : null;
}

/** A required SKU from the request body, canonicalized exactly as the seam canonicalizes it. */
function requireSku(body: Record<string, unknown>): string {
  if (typeof body['sku'] !== 'string' || body['sku'].trim() === '') {
    throw new AppError(400, 'INVALID_PARAMS', 'sku is required');
  }
  return canonicalSku(body['sku']);
}

function requireUuidField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (!isUuid(value)) {
    throw new AppError(400, 'INVALID_PARAMS', `${field} is required and must be a UUID`);
  }
  return value;
}

function requireQuantity(body: Record<string, unknown>, field: string): string {
  const normalized = numericStringOrNull(body[field]);
  if (normalized === null || Number(normalized) <= 0) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `${field} is required and must be a positive number with at most 6 decimals`,
    );
  }
  return normalized;
}

function optionalNullableText(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(400, 'INVALID_PARAMS', `${field} must be a non-blank string when provided`);
  }
  return value.trim();
}

function parseListPaging(
  req: IncomingMessage,
  res: Parameters<RouteHandler>[1],
  url: URL,
): { limit: number | undefined; offset: number | undefined } | null {
  const limitRaw = url.searchParams.get('limit');
  const offsetRaw = url.searchParams.get('offset');
  if (limitRaw !== null && !/^-?\d+$/.test(limitRaw)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'limit must be an integer');
    return null;
  }
  if (offsetRaw !== null && !/^-?\d+$/.test(offsetRaw)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'offset must be an integer');
    return null;
  }
  return {
    limit: limitRaw === null ? undefined : Number(limitRaw),
    offset: offsetRaw === null ? undefined : Number(offsetRaw),
  };
}

const createSpareBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const catalogueId = randomUUID();
  const now = new Date().toISOString();

  try {
    const sku = requireSku(body);
    const locationId = requireUuidField(body, 'location_id');
    // Strict when present: a wire value like the string "true" must not silently catalogue a
    // non-critical spare (that would disable FR-M-09 alerting with no error) - reject it exactly
    // like the seam does. An omitted is_critical is a non-critical spare and stays allowed.
    if (body['is_critical'] !== undefined && typeof body['is_critical'] !== 'boolean') {
      throw new AppError(400, 'INVALID_PARAMS', 'is_critical must be a boolean');
    }
    const isCritical = body['is_critical'] === true;

    // Levels are optional for a non-critical spare and mandatory-minimum for a critical one; the
    // seam re-validates both, so a direct-event caller gets the same INVALID_MIN_MAX contract.
    const minLevelRaw = body['min_level'];
    const maxLevelRaw = body['max_level'];
    const minLevel =
      minLevelRaw === undefined || minLevelRaw === null ? null : numericStringOrNull(minLevelRaw);
    const maxLevel =
      maxLevelRaw === undefined || maxLevelRaw === null ? null : numericStringOrNull(maxLevelRaw);
    if (minLevelRaw !== undefined && minLevelRaw !== null && minLevel === null) {
      throw new AppError(
        400,
        'INVALID_MIN_MAX',
        'min_level must be a number with at most 6 decimals',
      );
    }
    if (maxLevelRaw !== undefined && maxLevelRaw !== null && maxLevel === null) {
      throw new AppError(
        400,
        'INVALID_MIN_MAX',
        'max_level must be a number with at most 6 decimals',
      );
    }

    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: catalogueId,
        event_type: 'maintenance.spare_catalogued',
        payload: {
          catalogue_id: catalogueId,
          sku,
          location_id: locationId,
          is_critical: isCritical,
          min_level: minLevel,
          max_level: maxLevel,
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

    replayIdOrReject(persisted, 'maintenance.spare_catalogued', 'catalogue_id');
    // Read back BY ID from the persisted payload (the API Contract rule): on a replay the stored
    // event carries the ORIGINAL catalogue_id, never the request's sku/location grain.
    const persistedCatalogueId = (persisted.payload as { catalogue_id?: unknown } | undefined)
      ?.catalogue_id;
    const spare =
      typeof persistedCatalogueId === 'string' && isUuid(persistedCatalogueId)
        ? await getSpareCatalogueById(persistedCatalogueId)
        : null;
    sendJson(res, 201, { event_id: persisted.event_id, spare: spare ?? null });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const listSparesBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const paging = parseListPaging(req, res, url);
  if (!paging) return;

  const sku = url.searchParams.get('sku');
  const locationId = url.searchParams.get('location_id');
  const isCriticalRaw = url.searchParams.get('is_critical');
  if (locationId !== null && !isUuid(locationId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'location_id must be a UUID');
    return;
  }
  if (isCriticalRaw !== null && isCriticalRaw !== 'true' && isCriticalRaw !== 'false') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'is_critical must be true or false');
    return;
  }

  const spares = await listSpareCatalogue({
    sku: sku === null ? undefined : canonicalSku(sku),
    location_id: locationId ?? undefined,
    is_critical: isCriticalRaw === null ? undefined : isCriticalRaw === 'true',
    limit: paging.limit,
    offset: paging.offset,
  });
  sendJson(res, 200, { spares });
};

/**
 * The Phase-1 scheduling surface for spares: one POST runs BOTH cycles for an explicit
 * business_date. They share a trigger because they share a cadence (daily) and an audience (the
 * store), and splitting them would double the operator's scheduler entries for no gain. The
 * counters stay separate in the response so a dropped notification is visible next to the writes.
 */
const scanSparesBase: RouteHandler = async (req, res, _params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);
  try {
    const businessDate = requireBusinessDate(body);
    const locationId = body['location_id'];
    if (locationId !== undefined && locationId !== null && !isUuid(locationId)) {
      throw new AppError(400, 'INVALID_PARAMS', 'location_id must be a UUID when provided');
    }
    const skuFilter = body['sku'];
    if (skuFilter !== undefined && skuFilter !== null && typeof skuFilter !== 'string') {
      throw new AppError(400, 'INVALID_PARAMS', 'sku must be a string when provided');
    }

    const scope = {
      business_date: businessDate,
      location_id: (locationId as string | undefined) ?? undefined,
      sku: typeof skuFilter === 'string' ? canonicalSku(skuFilter) : undefined,
      actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
      auditCtx: auditCtxFor(req, actor, 200),
    };
    const breach = await runCriticalSpareBreachScan(scope);
    const overdue = await runOverdueReturnSweep(scope);
    sendJson(res, 200, { business_date: businessDate, breach_scan: breach, return_sweep: overdue });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const listSpareAlertsBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const paging = parseListPaging(req, res, url);
  if (!paging) return;

  const alertType = url.searchParams.get('alert_type');
  const sku = url.searchParams.get('sku');
  const locationId = url.searchParams.get('location_id');
  const businessDate = url.searchParams.get('business_date');
  if (alertType !== null && !ALERT_TYPES.has(alertType)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'alert_type must be one of: min_breach, return_overdue',
    );
    return;
  }
  if (locationId !== null && !isUuid(locationId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'location_id must be a UUID');
    return;
  }
  if (
    businessDate !== null &&
    (!DATE_REGEX.test(businessDate) || Number.isNaN(Date.parse(businessDate)))
  ) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'business_date must be YYYY-MM-DD');
    return;
  }

  const alerts = await listSpareAlerts({
    alert_type: alertType ?? undefined,
    sku: sku === null ? undefined : canonicalSku(sku),
    location_id: locationId ?? undefined,
    business_date: businessDate ?? undefined,
    limit: paging.limit,
    offset: paging.offset,
  });
  sendJson(res, 200, { alerts });
};

/** AC 1's where-used read: every asset whose parts list references this SKU. */
const whereUsedBase: RouteHandler = async (req, res, params) => {
  const rawSku = params?.['sku'];
  if (!rawSku || rawSku.trim() === '') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'sku is required');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const paging = parseListPaging(req, res, url);
  if (!paging) return;

  // The router already decodes path params once; a second decode here would corrupt a SKU that
  // legitimately contains '%' and throw an uncaught URIError on malformed percent-encoding, so the
  // decode is guarded and failures surface as a clean 400 instead of a 500.
  let sku: string;
  try {
    sku = canonicalSku(decodeURIComponent(rawSku));
  } catch {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'sku is not valid percent-encoding');
    return;
  }
  const usages = await listWhereUsedBySku({ sku, limit: paging.limit, offset: paging.offset });
  sendJson(res, 200, { sku, where_used: usages });
};

const addAssetPartBase: RouteHandler = async (req, res, params) => {
  const assetId = params?.['assetId'];
  if (!assetId || !isUuid(assetId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'assetId must be a UUID');
    return;
  }
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const partLineId = randomUUID();
  const now = new Date().toISOString();

  try {
    const sku = requireSku(body);
    const quantityPer = requireQuantity(body, 'quantity_per');
    const positionRef = optionalNullableText(body, 'position_ref');

    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: partLineId,
        event_type: 'maintenance.asset_part_listed',
        payload: {
          part_line_id: partLineId,
          asset_id: assetId,
          sku,
          quantity_per: quantityPer,
          position_ref: positionRef,
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

    replayIdOrReject(persisted, 'maintenance.asset_part_listed', 'part_line_id');
    // Read back BY ID from the persisted payload (the API Contract rule): on a replay the stored
    // event carries the ORIGINAL part_line_id, never the request's asset/sku grain.
    const persistedPartLineId = (persisted.payload as { part_line_id?: unknown } | undefined)
      ?.part_line_id;
    const part =
      typeof persistedPartLineId === 'string' && isUuid(persistedPartLineId)
        ? await getAssetPartById(persistedPartLineId)
        : null;
    sendJson(res, 201, { event_id: persisted.event_id, part: part ?? null });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const listAssetPartsBase: RouteHandler = async (req, res, params) => {
  const assetId = params?.['assetId'];
  if (!assetId || !isUuid(assetId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'assetId must be a UUID');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const paging = parseListPaging(req, res, url);
  if (!paging) return;

  const asset = await getAssetById(assetId);
  if (!asset) {
    sendRequestError(req, res, 404, 'ASSET_NOT_FOUND', 'Asset not found', { asset_id: assetId });
    return;
  }
  const parts = await listAssetParts({
    asset_id: assetId,
    limit: paging.limit,
    offset: paging.offset,
  });
  sendJson(res, 200, { asset_id: assetId, parts });
};

const reserveSpareBase: RouteHandler = async (req, res, params) => {
  const workOrderId = params?.['workOrderId'];
  if (!workOrderId || !isUuid(workOrderId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'workOrderId must be a UUID');
    return;
  }
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const reservationId = randomUUID();
  const now = new Date().toISOString();

  try {
    const sku = requireSku(body);
    const locationId = requireUuidField(body, 'location_id');
    const quantity = requireQuantity(body, 'quantity');
    const lotId = optionalNullableText(body, 'lot_id');

    // asset_id is resolved from the work order at capture time and DECLARED in the payload; the
    // seam re-derives it from the LOCKED work order and rejects divergence, so a direct-event
    // caller cannot bind a reservation to an asset the work order does not name.
    const workOrder = await getWorkOrderById(workOrderId);
    if (!workOrder) {
      throw new AppError(404, 'WORK_ORDER_NOT_FOUND', 'Work order not found', {
        work_order_id: workOrderId,
      });
    }

    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: reservationId,
        event_type: 'maintenance.spare_reserved',
        payload: {
          reservation_id: reservationId,
          work_order_id: workOrderId,
          asset_id: workOrder.asset_id,
          sku,
          location_id: locationId,
          lot_id: lotId,
          quantity,
          reserved_at: now,
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

    const persistedReservationId = replayIdOrReject(
      persisted,
      'maintenance.spare_reserved',
      'reservation_id',
    );
    const reservation = await getSpareReservationById(persistedReservationId);
    sendJson(res, 201, { event_id: persisted.event_id, reservation: reservation ?? null });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const listSpareReservationsBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const paging = parseListPaging(req, res, url);
  if (!paging) return;

  const workOrderId = url.searchParams.get('work_order_id');
  const sku = url.searchParams.get('sku');
  const locationId = url.searchParams.get('location_id');
  const status = url.searchParams.get('status');
  const returnOverdueRaw = url.searchParams.get('return_overdue');
  const businessDate = url.searchParams.get('business_date');

  if (workOrderId !== null && !isUuid(workOrderId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'work_order_id must be a UUID');
    return;
  }
  if (locationId !== null && !isUuid(locationId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'location_id must be a UUID');
    return;
  }
  if (status !== null && !RESERVATION_STATUSES.has(status)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'status must be one of: reserved, issued, partially_returned, returned, cancelled',
    );
    return;
  }
  if (returnOverdueRaw !== null && returnOverdueRaw !== 'true' && returnOverdueRaw !== 'false') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'return_overdue must be true or false');
    return;
  }
  if (
    businessDate !== null &&
    (!DATE_REGEX.test(businessDate) || Number.isNaN(Date.parse(businessDate)))
  ) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'business_date must be YYYY-MM-DD');
    return;
  }
  // business_date anchors the overdue-return comparison; without return_overdue=true it has no
  // meaning, so reject the unsupported combination instead of silently returning an unfiltered page.
  if (businessDate !== null && returnOverdueRaw !== 'true') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'business_date requires return_overdue=true');
    return;
  }

  const reservations = await listSpareReservations({
    work_order_id: workOrderId ?? undefined,
    sku: sku === null ? undefined : canonicalSku(sku),
    location_id: locationId ?? undefined,
    status: status ?? undefined,
    return_overdue: returnOverdueRaw === null ? undefined : returnOverdueRaw === 'true',
    business_date: businessDate ?? undefined,
    limit: paging.limit,
    offset: paging.offset,
  });
  sendJson(res, 200, { reservations });
};

const issueSpareBase: RouteHandler = async (req, res, params) => {
  const reservationId = params?.['reservationId'];
  if (!reservationId || !isUuid(reservationId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'reservationId must be a UUID');
    return;
  }
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);
  const now = new Date().toISOString();

  try {
    const businessDate = requireBusinessDate(body);
    const reservation = await getSpareReservationById(reservationId);
    if (!reservation) {
      throw new AppError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found', {
        reservation_id: reservationId,
      });
    }

    // The FR-M-08 return clock is derived ONCE here so the declared payload carries it; the seam
    // re-derives it from the same issue instant under the reservation's lock and rejects any
    // divergence (SPARE_DERIVATION_MISMATCH), closing the direct-event path.
    const returnDueDate = deriveReturnDueDate(now);

    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: reservationId,
        event_type: 'maintenance.spare_issued',
        payload: {
          reservation_id: reservationId,
          quantity: reservation.quantity,
          issued_at: now,
          return_due_date: returnDueDate,
          business_date: businessDate,
        },
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

    replayIdOrReject(persisted, 'maintenance.spare_issued', 'reservation_id');
    const updated = await getSpareReservationById(reservationId);
    sendJson(res, 200, { event_id: persisted.event_id, reservation: updated ?? null });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const returnSpareBase: RouteHandler = async (req, res, params) => {
  const reservationId = params?.['reservationId'];
  if (!reservationId || !isUuid(reservationId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'reservationId must be a UUID');
    return;
  }
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const now = new Date().toISOString();

  try {
    const reservation = await getSpareReservationById(reservationId);
    if (!reservation) {
      throw new AppError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found', {
        reservation_id: reservationId,
      });
    }
    // A return with no quantity means "all of it", which is the overwhelmingly common case at the
    // store counter; an explicit quantity supports the partial return the state machine allows.
    // The outstanding remainder is computed in SQL NUMERIC (quantity - quantity_returned), never
    // in JS float - 0.3 - 0.1 is 0.19999999999999998 in binary, which would fail the 6-decimal
    // NUMERIC regex and strand the reservation in partially_returned.
    const outstanding = reservation.outstanding;
    const quantityReturned =
      body['quantity_returned'] === undefined || body['quantity_returned'] === null
        ? outstanding
        : requireQuantity(body, 'quantity_returned');

    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: reservationId,
        event_type: 'maintenance.spare_returned',
        payload: {
          reservation_id: reservationId,
          quantity_returned: quantityReturned,
          returned_at: now,
        },
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

    replayIdOrReject(persisted, 'maintenance.spare_returned', 'reservation_id');
    const updated = await getSpareReservationById(reservationId);
    sendJson(res, 200, { event_id: persisted.event_id, reservation: updated ?? null });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const cancelSpareReservationBase: RouteHandler = async (req, res, params) => {
  const reservationId = params?.['reservationId'];
  if (!reservationId || !isUuid(reservationId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'reservationId must be a UUID');
    return;
  }
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const now = new Date().toISOString();

  try {
    const reason = optionalNullableText(body, 'cancellation_reason');
    if (reason === null) {
      throw new AppError(400, 'INVALID_PARAMS', 'cancellation_reason is required');
    }

    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: reservationId,
        event_type: 'maintenance.spare_reservation_cancelled',
        payload: {
          reservation_id: reservationId,
          cancellation_reason: reason,
          cancelled_at: now,
        },
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

    replayIdOrReject(persisted, 'maintenance.spare_reservation_cancelled', 'reservation_id');
    const updated = await getSpareReservationById(reservationId);
    sendJson(res, 200, { event_id: persisted.event_id, reservation: updated ?? null });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

export const createSpareHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(createSpareBase);

export const listSparesHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listSparesBase);

export const scanSparesHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(scanSparesBase);

export const listSpareAlertsHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listSpareAlertsBase);

export const whereUsedHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(whereUsedBase);

export const addAssetPartHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(addAssetPartBase);

export const listAssetPartsHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listAssetPartsBase);

export const reserveSpareHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(reserveSpareBase);

export const listSpareReservationsHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listSpareReservationsBase);

export const issueSpareHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(issueSpareBase);

export const returnSpareHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(returnSpareBase);

export const cancelSpareReservationHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(cancelSpareReservationBase);

// ---------------------------------------------------------------------------
// Story 7.6: statutory examinations, cost accumulation, and machine status broadcast
// (FR-M-14, FR-M-15, FR-M-16)
// ---------------------------------------------------------------------------
//
// These handlers own only the capture-time resolutions - server-minted ids, actor stamping,
// canonicalization of human-entered keys, the next-due derivation, and resolving the DOA route for
// return-to-service. Every decision lives in src/compliance/maintenance-statutory.ts,
// src/compliance/asset-operational-status.ts and src/compliance/maintenance-plan.ts, which
// re-derive each declared field under lock, so a direct POST /api/v1/events cannot bypass any of
// it.

// The status vocabulary, the DOA transaction type and the Table 5 state machine are IMPORTED from
// the seams that enforce them, never re-declared here. A duplicated copy lets the handler's
// pre-check and the applier's enforcement drift apart, and a widening applied to only one of them
// is a gate that silently opens.
const EXAMINATION_TYPES = STATUTORY_EXAMINATION_TYPES;
const EXAMINATION_STATUSES = STATUTORY_EXAMINATION_STATUSES;
const ASSET_STATUSES = ASSET_OPERATIONAL_STATUSES;
// The cost columns are NUMERIC(14,3): at most 11 integer digits and 3 decimals (the seam mirrors
// this regex; a wider value would overflow the column as an unmapped 22003 500).
const COST_NUMERIC_REGEX = /^\d{1,11}(\.\d{1,3})?$/;

// Table 5: the machine status state machine, owned by src/compliance/asset-operational-status.ts.
const MACHINE_STATUS_TRANSITIONS = ALLOWED_TRANSITIONS;

/** Whole-month addition in SQL DATE arithmetic; make_interval clamps the day, which JS cannot
 *  replicate, so the handler asks the database for the same derivation the seam re-checks. */
async function deriveNextDueDate(examinedOn: string, intervalMonths: number): Promise<string> {
  const result = await getPool().query(
    `SELECT ($1::date + make_interval(months => $2))::date::text AS next_due`,
    [examinedOn, intervalMonths],
  );
  return result.rows[0]!['next_due'] as string;
}

// ---------------------------------------------------------------------------
// Story 7.5: calibration register and non-overridable lockout (FR-M-12, FR-M-13, AD-8)
// ---------------------------------------------------------------------------
//
// These handlers own only the capture-time resolutions - server-minted ids, actor stamping,
// canonicalization of human-entered keys, and resolving the DOA route at raise time. Every
// decision lives in src/compliance/calibration-register.ts, which re-derives each declared field
// under lock, so a direct POST /api/v1/events cannot bypass any of it.
//
// The 423 in updateCalibrationStatusBase (src/api/v1/instruments.ts) is the other half of AC 2 and
// stays there, on the Story 1.7 endpoint it closes.

const CALIBRATION_TYPES = new Set(['in_house', 'iso_17025']);
const CALIBRATION_STAGE_SET = new Set<number>(CALIBRATION_STAGES);
const ESCALATION_STATUSES = new Set(['open', 'resolved']);
const CALIBRATION_STATUSES = new Set(['calibrated', 'out_of_calibration']);

/** A path segment that must be a UUID, rejected as 400 rather than looked up as garbage. */
function requireUuidParam(params: Record<string, string> | undefined, name: string): string {
  const value = params?.[name];
  if (!value || !isUuid(value)) {
    throw new AppError(400, 'INVALID_PARAMS', `${name} must be a UUID`);
  }
  return value;
}

/** A required calendar date field from the body, distinct from business_date. */
function requireCalendarDate(
  body: Record<string, unknown>,
  field: string,
  errorCode: string,
): string {
  const value = body[field];
  // isValidCalendarDate rejects impossible dates (e.g. 2026-02-30) that Date.parse normalizes, so
  // they cannot reach a $N::date SQL cast as an unmapped 22008 500.
  if (typeof value !== 'string' || !isValidCalendarDate(value)) {
    throw new AppError(400, errorCode, `${field} is required and must be YYYY-MM-DD`);
  }
  return value;
}

const createInstrumentBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const instrumentRecordId = randomUUID();
  const now = new Date().toISOString();

  try {
    const assetId = requireUuidField(body, 'asset_id');
    const locationId = requireUuidField(body, 'location_id');
    if (
      typeof body['instrument_id'] !== 'string' ||
      body['instrument_id'].trim() === '' ||
      body['instrument_id'].trim().length > MAX_INSTRUMENT_ID_LENGTH
    ) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `instrument_id is required and must be at most ${MAX_INSTRUMENT_ID_LENGTH} characters`,
      );
    }
    // Canonicalized in the handler AND in the seam, so the direct-event path cannot bypass it.
    const instrumentId = canonicalInstrumentId(body['instrument_id']);

    // Rejected, never coerced: "365" as a string would otherwise become an unmapped constraint
    // violation instead of a stable 400 (the Story 7.4 wire-boolean lesson applied to integers).
    const interval = body['calibration_interval_days'];
    if (
      typeof interval !== 'number' ||
      !Number.isInteger(interval) ||
      interval < 1 ||
      interval > MAX_CALIBRATION_INTERVAL_DAYS
    ) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `calibration_interval_days must be an integer between 1 and ${MAX_CALIBRATION_INTERVAL_DAYS}`,
      );
    }

    const asset = await getAssetById(assetId);
    if (!asset) {
      throw new AppError(404, 'ASSET_NOT_FOUND', 'Asset not found', { asset_id: assetId });
    }
    const location = await getLocationById(locationId);
    if (!location) {
      throw new AppError(404, 'LOCATION_NOT_FOUND', 'Location not found', {
        location_id: locationId,
      });
    }

    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: instrumentRecordId,
        event_type: 'maintenance.instrument_registered',
        payload: {
          instrument_record_id: instrumentRecordId,
          asset_id: assetId,
          instrument_id: instrumentId,
          location_id: locationId,
          calibration_interval_days: interval,
          registered_at: now,
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

    // Read back BY ID from the persisted payload's own id: on a replay the stored event carries
    // the ORIGINAL instrument_record_id, never this request's freshly minted one.
    const persistedId = replayIdOrReject(
      persisted,
      'maintenance.instrument_registered',
      'instrument_record_id',
    );
    const instrument = await getInstrumentRecordById(persistedId);
    const status = instrument
      ? await getInstrumentCalibrationStatus(instrument.instrument_id)
      : null;
    sendJson(res, 201, {
      event_id: persisted.event_id,
      instrument: instrument ?? null,
      calibration_status: status?.calibration_status ?? null,
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const listInstrumentsBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const paging = parseListPaging(req, res, url);
  if (!paging) return;

  const assetId = url.searchParams.get('asset_id');
  const locationId = url.searchParams.get('location_id');
  const calibrationStatus = url.searchParams.get('calibration_status');
  if (assetId !== null && !isUuid(assetId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'asset_id must be a UUID');
    return;
  }
  if (locationId !== null && !isUuid(locationId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'location_id must be a UUID');
    return;
  }
  // A filter that would otherwise be silently ignored returns 400 instead (the Story 7.4 lesson).
  if (calibrationStatus !== null && !CALIBRATION_STATUSES.has(calibrationStatus)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'calibration_status must be one of: calibrated, out_of_calibration',
    );
    return;
  }

  const instruments = await listInstrumentRecords({
    asset_id: assetId ?? undefined,
    location_id: locationId ?? undefined,
    calibration_status: calibrationStatus ?? undefined,
    limit: paging.limit,
    offset: paging.offset,
  });
  sendJson(res, 200, { instruments });
};

const getInstrumentBase: RouteHandler = async (req, res, params) => {
  try {
    const instrumentRecordId = requireUuidParam(params, 'instrumentRecordId');
    const instrument = await getInstrumentRecordById(instrumentRecordId);
    if (!instrument) {
      throw new AppError(404, 'INSTRUMENT_NOT_FOUND', 'Instrument not found', {
        instrument_record_id: instrumentRecordId,
      });
    }
    const [certificate, status] = await Promise.all([
      getActiveCertificate(instrumentRecordId),
      getInstrumentCalibrationStatus(instrument.instrument_id),
    ]);
    sendJson(res, 200, {
      instrument,
      active_certificate: certificate ?? null,
      calibration_status: status?.calibration_status ?? null,
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const recordCertificateBase: RouteHandler = async (req, res, params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const certificateId = randomUUID();
  const now = new Date().toISOString();

  try {
    const instrumentRecordId = requireUuidParam(params, 'instrumentRecordId');
    const businessDate = requireBusinessDate(body);

    const calibrationType = body['calibration_type'];
    if (typeof calibrationType !== 'string' || !CALIBRATION_TYPES.has(calibrationType)) {
      throw new AppError(
        400,
        'INVALID_CALIBRATION_TYPE',
        'calibration_type must be in_house or iso_17025',
      );
    }
    // issuing_lab follows the seam's rule, not optionalNullableText: a blank value on an iso_17025
    // certificate is 'without issuing_lab' and must surface INVALID_CALIBRATION_TYPE (the Error
    // Code Contract), the same code the direct-event path returns for this input.
    const issuingLabRaw = body['issuing_lab'];
    let issuingLab: string | null = null;
    if (issuingLabRaw !== undefined && issuingLabRaw !== null) {
      if (typeof issuingLabRaw !== 'string' || issuingLabRaw.trim() === '') {
        throw new AppError(
          400,
          'INVALID_CALIBRATION_TYPE',
          'issuing_lab must be a non-blank string or null',
        );
      }
      issuingLab = issuingLabRaw.trim();
    }
    if (calibrationType === 'iso_17025' && issuingLab === null) {
      throw new AppError(
        400,
        'INVALID_CALIBRATION_TYPE',
        'an iso_17025 certificate requires an issuing_lab',
      );
    }
    if (
      typeof body['certificate_number'] !== 'string' ||
      body['certificate_number'].trim() === '' ||
      body['certificate_number'].trim().length > MAX_CERTIFICATE_NUMBER_LENGTH
    ) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `certificate_number is required and must be at most ${MAX_CERTIFICATE_NUMBER_LENGTH} characters`,
      );
    }
    const certificateNumber = canonicalCertificateNumber(body['certificate_number']);
    const calibratedOn = requireCalendarDate(body, 'calibrated_on', 'INVALID_CERTIFICATE_VALIDITY');
    const validUntil = requireCalendarDate(body, 'valid_until', 'INVALID_CERTIFICATE_VALIDITY');
    if (validUntil < calibratedOn) {
      throw new AppError(
        400,
        'INVALID_CERTIFICATE_VALIDITY',
        'valid_until must not precede calibrated_on',
        { calibrated_on: calibratedOn, valid_until: validUntil },
      );
    }

    // instrument_id is resolved from the register at capture time and DECLARED in the payload; the
    // seam re-derives it from the LOCKED register row and rejects divergence.
    const instrument = await getInstrumentRecordById(instrumentRecordId);
    if (!instrument) {
      throw new AppError(404, 'INSTRUMENT_NOT_FOUND', 'Instrument not found', {
        instrument_record_id: instrumentRecordId,
      });
    }

    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: certificateId,
        event_type: 'maintenance.calibration_certificate_recorded',
        payload: {
          certificate_id: certificateId,
          instrument_record_id: instrumentRecordId,
          instrument_id: instrument.instrument_id,
          calibration_type: calibrationType,
          certificate_number: certificateNumber,
          issuing_lab: issuingLab,
          calibrated_on: calibratedOn,
          valid_until: validUntil,
          business_date: businessDate,
          recorded_at: now,
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

    const persistedId = replayIdOrReject(
      persisted,
      'maintenance.calibration_certificate_recorded',
      'certificate_id',
    );
    const certificate = await getCertificateById(persistedId);
    const status = await getInstrumentCalibrationStatus(instrument.instrument_id);
    sendJson(res, 201, {
      event_id: persisted.event_id,
      certificate: certificate ?? null,
      calibration_status: status?.calibration_status ?? null,
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const listCertificatesBase: RouteHandler = async (req, res, params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const paging = parseListPaging(req, res, url);
  if (!paging) return;

  try {
    const instrumentRecordId = requireUuidParam(params, 'instrumentRecordId');
    const status = url.searchParams.get('status');
    if (status !== null && !['active', 'superseded', 'expired'].includes(status)) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'status must be one of: active, superseded, expired',
      );
    }
    const certificates = await listCertificatesByInstrument({
      instrument_record_id: instrumentRecordId,
      status: status ?? undefined,
      limit: paging.limit,
      offset: paging.offset,
    });
    sendJson(res, 200, { certificates });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const raiseCalibrationEscalationBase: RouteHandler = async (req, res, params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);
  const escalationId = randomUUID();
  const correlationId = randomUUID();
  const now = new Date().toISOString();

  try {
    const instrumentRecordId = requireUuidParam(params, 'instrumentRecordId');
    const reason = optionalNullableText(body, 'reason');

    const instrument = await getInstrumentRecordById(instrumentRecordId);
    if (!instrument) {
      throw new AppError(404, 'INSTRUMENT_NOT_FOUND', 'Instrument not found', {
        instrument_record_id: instrumentRecordId,
      });
    }

    // The Story 1.7 DOA route, reused rather than reinvented. The seam re-derives both values
    // under lock, so these are capture-time resolutions, not trusted authority.
    const entry = await findFirstActiveDoaEntry('calibration.escalation');
    if (!entry) {
      throw new AppError(404, 'NO_DOA_ENTRY_MATCH', 'No DOA entry governs calibration.escalation');
    }
    const approver = await findRoleHolder(entry.role);
    if (!approver) {
      throw new AppError(404, 'NO_APPROVER_FOUND', `No active user holds role "${entry.role}"`);
    }

    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: escalationId,
        event_type: 'maintenance.calibration_escalation_raised',
        payload: {
          escalation_id: escalationId,
          instrument_record_id: instrumentRecordId,
          instrument_id: instrument.instrument_id,
          doa_entry_id: entry.entry_id,
          routed_approver_user_id: approver.user_id,
          reason,
          raised_at: now,
        },
        metadata: {
          correlation_id: correlationId,
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: now,
        },
        idempotency_key: idempotencyKeyFrom(body),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );

    const persistedId = replayIdOrReject(
      persisted,
      'maintenance.calibration_escalation_raised',
      'escalation_id',
    );
    const escalation = await getEscalationById(persistedId);

    // On a replay (idempotency-key reuse) persistEvent returns the ORIGINAL stored event, whose
    // escalation_id differs from the freshly minted one here - so the notification is emitted only
    // for a newly persisted escalation, never re-sent on a retry (and never routed to a DOA
    // approver who was resolved fresh on the replay).
    const isReplay = persistedId !== escalationId;

    // AFTER the event commits, non-throwing (AD-17). The next_step wording is part of AC 3: the
    // person receiving this must not read it as an unlock authorization. Targeted at the resolved
    // approver by user_id through the Story 4.3 direct-user path, so it cannot fan out to zero
    // recipients the way a role-only target can.
    if (!isReplay) {
      await emitNotification({
        target: { role: entry.role, user_id: approver.user_id },
        event_type: 'calibration_escalation_raised',
        status_verb: 'Escalated',
        object_type: 'instrument',
        object_id: persistedId,
        actor_label: `${instrument.instrument_id}${reason ? `: ${reason}` : ''}`,
        next_step: 'Expedite re-calibration; the lockout stays in force',
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        correlation_id: correlationId,
        occurred_at: now,
      });
    }

    sendJson(res, 201, {
      event_id: persisted.event_id,
      escalation: escalation ?? null,
      matched_entry: {
        entry_id: entry.entry_id,
        role: entry.role,
        transaction_type: entry.transaction_type,
        value_min: entry.value_min,
        value_max: entry.value_max,
      },
      approver,
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

/**
 * The Phase-1 scheduling surface for calibration: one POST runs the staged alert pass and the
 * expiry flip for an explicit business_date. The four counters stay separate in the response so a
 * dropped notification is visible next to the writes.
 */
const scanCalibrationBase: RouteHandler = async (req, res, _params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);
  try {
    const businessDate = requireBusinessDate(body);
    const instrumentRecordId = body['instrument_record_id'];
    if (
      instrumentRecordId !== undefined &&
      instrumentRecordId !== null &&
      !isUuid(instrumentRecordId)
    ) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'instrument_record_id must be a UUID when provided',
      );
    }
    const locationId = body['location_id'];
    if (locationId !== undefined && locationId !== null && !isUuid(locationId)) {
      throw new AppError(400, 'INVALID_PARAMS', 'location_id must be a UUID when provided');
    }

    const result = await runCalibrationExpiryScan({
      business_date: businessDate,
      instrument_record_id: (instrumentRecordId as string | undefined) ?? undefined,
      location_id: (locationId as string | undefined) ?? undefined,
      actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
      auditCtx: auditCtxFor(req, actor, 200),
    });
    sendJson(res, 200, result);
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const listCalibrationAlertsBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const paging = parseListPaging(req, res, url);
  if (!paging) return;

  const instrumentRecordId = url.searchParams.get('instrument_record_id');
  const stageDaysRaw = url.searchParams.get('stage_days');
  const businessDate = url.searchParams.get('business_date');

  if (instrumentRecordId !== null && !isUuid(instrumentRecordId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'instrument_record_id must be a UUID');
    return;
  }
  if (stageDaysRaw !== null && !CALIBRATION_STAGE_SET.has(Number(stageDaysRaw))) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'stage_days must be one of: 30, 14, 7');
    return;
  }
  if (
    businessDate !== null &&
    (!DATE_REGEX.test(businessDate) || Number.isNaN(Date.parse(businessDate)))
  ) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'business_date must be YYYY-MM-DD');
    return;
  }

  const alerts = await listCalibrationAlerts({
    instrument_record_id: instrumentRecordId ?? undefined,
    stage_days: stageDaysRaw === null ? undefined : Number(stageDaysRaw),
    business_date: businessDate ?? undefined,
    limit: paging.limit,
    offset: paging.offset,
  });
  sendJson(res, 200, { alerts });
};

const listCalibrationEscalationsBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const paging = parseListPaging(req, res, url);
  if (!paging) return;

  const instrumentRecordId = url.searchParams.get('instrument_record_id');
  const status = url.searchParams.get('status');
  if (instrumentRecordId !== null && !isUuid(instrumentRecordId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'instrument_record_id must be a UUID');
    return;
  }
  if (status !== null && !ESCALATION_STATUSES.has(status)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'status must be one of: open, resolved');
    return;
  }

  const escalations = await listEscalations({
    instrument_record_id: instrumentRecordId ?? undefined,
    status: status ?? undefined,
    limit: paging.limit,
    offset: paging.offset,
  });
  sendJson(res, 200, { escalations });
};

/**
 * Closes an open escalation against an ACTIVE certificate. Recording a certificate already
 * auto-resolves an open escalation inside the certificate applier's transaction; this route exists
 * for the case where the certificate was recorded before the escalation was noticed.
 */
const resolveCalibrationEscalationBase: RouteHandler = async (req, res, params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);
  const now = new Date().toISOString();

  try {
    const escalationId = requireUuidParam(params, 'escalationId');
    const escalation = await getEscalationById(escalationId);
    if (!escalation) {
      throw new AppError(404, 'ESCALATION_NOT_FOUND', 'Escalation not found', {
        escalation_id: escalationId,
      });
    }
    // The ESCALATION_NOT_OPEN rejection deliberately lives in the seam, not here: a pre-check in
    // the handler would fire on a legitimate REPLAY of this route (the escalation is resolved by
    // then) and return 409 instead of the stored result, which is not what an idempotency key
    // promises. The seam's alreadyPersisted guard short-circuits a replay before the state check.

    // The resolving certificate defaults to the instrument's current active certificate, which is
    // the only certificate that can legitimately close an escalation. An already-resolved
    // escalation defaults to the certificate it was closed against, so a replay rebuilds the exact
    // payload. An explicitly named certificate is still validated against the rule in the seam.
    let resolvingCertificateId = body['certificate_id'];
    if (resolvingCertificateId === undefined || resolvingCertificateId === null) {
      const active =
        escalation.resolving_certificate_id !== null
          ? { certificate_id: escalation.resolving_certificate_id }
          : await getActiveCertificate(escalation.instrument_record_id);
      if (!active) {
        throw new AppError(
          422,
          'CERTIFICATE_EXPIRED',
          'This instrument has no active certificate to resolve the escalation against',
          { escalation_id: escalationId },
        );
      }
      resolvingCertificateId = active.certificate_id;
    }
    if (!isUuid(resolvingCertificateId)) {
      throw new AppError(400, 'INVALID_PARAMS', 'certificate_id must be a UUID when provided');
    }

    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: escalationId,
        event_type: 'maintenance.calibration_escalation_resolved',
        payload: {
          escalation_id: escalationId,
          resolving_certificate_id: resolvingCertificateId,
          resolved_at: now,
        },
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

    const persistedId = replayIdOrReject(
      persisted,
      'maintenance.calibration_escalation_resolved',
      'escalation_id',
    );
    const updated = await getEscalationById(persistedId);
    sendJson(res, 200, { event_id: persisted.event_id, escalation: updated ?? null });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

export const createInstrumentHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(createInstrumentBase);

export const listInstrumentsHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listInstrumentsBase);

export const getInstrumentHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(getInstrumentBase);

export const recordCertificateHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(recordCertificateBase);

export const listCertificatesHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listCertificatesBase);

export const raiseCalibrationEscalationHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(raiseCalibrationEscalationBase);

export const scanCalibrationHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(scanCalibrationBase);

export const listCalibrationAlertsHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listCalibrationAlertsBase);

export const listCalibrationEscalationsHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listCalibrationEscalationsBase);

export const resolveCalibrationEscalationHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(resolveCalibrationEscalationBase);

// ---------------------------------------------------------------------------
// Story 7.6: statutory examinations, cost accumulation, machine status broadcast
// ---------------------------------------------------------------------------

// POST /api/v1/maintenance/statutory-examinations

const createStatutoryExaminationBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const examinationId = randomUUID();
  const now = new Date().toISOString();

  try {
    const assetId = requireUuidField(body, 'asset_id');
    const examinationType = body['examination_type'];
    if (typeof examinationType !== 'string' || !EXAMINATION_TYPES.has(examinationType)) {
      throw new AppError(
        400,
        'INVALID_EXAMINATION_TYPE',
        'examination_type must be osh_code or weighbridge_legal_metrology',
      );
    }
    const intervalMonths = body['interval_months'];
    if (
      typeof intervalMonths !== 'number' ||
      !Number.isInteger(intervalMonths) ||
      intervalMonths < 1 ||
      intervalMonths > MAX_EXAMINATION_INTERVAL_MONTHS
    ) {
      throw new AppError(
        400,
        'INVALID_INTERVAL',
        `interval_months must be an integer between 1 and ${MAX_EXAMINATION_INTERVAL_MONTHS}`,
      );
    }
    const examinedOn = requireCalendarDate(body, 'examined_on', 'INVALID_PARAMS');
    const businessDate = requireBusinessDate(body);
    // The due date is derived ONCE here in the SAME SQL arithmetic the seam re-checks under the
    // asset's lock, so a divergence can never fire on the happy path.
    const nextDueDate = await deriveNextDueDate(examinedOn, intervalMonths);
    const certificateNumberExtRaw = optionalNullableText(body, 'certificate_number_ext');
    // Canonicalized in the handler AND in the seam, like the sibling device_key: the Compliance
    // Seam Contract names both layers, so the invariant never rests on a single one.
    const certificateNumberExt =
      certificateNumberExtRaw === null ? null : canonicalDeviceKey(certificateNumberExtRaw);
    const deviceKeyRaw = optionalNullableText(body, 'device_key');
    // Canonicalized in the handler AND in the seam, so the direct-event path cannot bypass it.
    const deviceKey = deviceKeyRaw === null ? null : canonicalDeviceKey(deviceKeyRaw);

    const asset = await getAssetById(assetId);
    if (!asset) {
      throw new AppError(404, 'ASSET_NOT_FOUND', 'Asset not found', { asset_id: assetId });
    }

    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: examinationId,
        event_type: 'maintenance.statutory_examination_recorded',
        payload: {
          examination_id: examinationId,
          asset_id: assetId,
          examination_type: examinationType,
          interval_months: intervalMonths,
          examined_on: examinedOn,
          next_due_date: nextDueDate,
          certificate_number_ext: certificateNumberExt,
          device_key: deviceKey,
          business_date: businessDate,
          recorded_at: now,
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

    const persistedId = replayIdOrReject(
      persisted,
      'maintenance.statutory_examination_recorded',
      'examination_id',
    );
    // Read back BY ID from the persisted payload's own id (the API Contract rule).
    // Read back BY ID from the persisted payload's own id (the API Contract rule). A RE-STAMP is
    // the one case where that id is not the register row's: this handler mints a fresh
    // examination_id per POST (stream_id must equal it), while the register row keeps the id it
    // was first registered under, so the by-id read misses and the grain is the only way back to
    // the row this event just updated. Records hang off the register row's id, not the payload's.
    //
    // The grain comes from the PERSISTED payload, never from the request body: on an
    // idempotency-key replay `persisted` is the ORIGINAL event, and keying the fallback off this
    // request's asset_id would build a 201 out of a foreign asset's register row - the exact
    // phantom-response class replayIdOrReject exists to prevent.
    const persistedPayload = persisted.payload as Record<string, unknown>;
    const persistedAssetId =
      typeof persistedPayload['asset_id'] === 'string'
        ? (persistedPayload['asset_id'] as string)
        : assetId;
    const persistedExaminationType =
      typeof persistedPayload['examination_type'] === 'string'
        ? (persistedPayload['examination_type'] as string)
        : examinationType;
    const examination =
      (await getExaminationById(persistedId)) ??
      (await getExaminationByAssetAndType(persistedAssetId, persistedExaminationType));
    const records = await listRecordsByExamination(examination?.examination_id ?? persistedId);
    sendJson(res, 201, {
      event_id: persisted.event_id,
      examination: examination ?? null,
      records,
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// GET /api/v1/maintenance/statutory-examinations

const listStatutoryExaminationsBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const paging = parseListPaging(req, res, url);
  if (!paging) return;

  const assetId = url.searchParams.get('asset_id');
  const status = url.searchParams.get('status');
  const examinationType = url.searchParams.get('examination_type');
  if (assetId !== null && !isUuid(assetId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'asset_id must be a UUID');
    return;
  }
  if (status !== null && !EXAMINATION_STATUSES.has(status)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'status must be one of: compliant, overdue');
    return;
  }
  if (examinationType !== null && !EXAMINATION_TYPES.has(examinationType)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'examination_type must be one of: osh_code, weighbridge_legal_metrology',
    );
    return;
  }

  const examinations = await listExaminations({
    asset_id: assetId ?? undefined,
    status: (status as 'compliant' | 'overdue' | null) ?? undefined,
    examination_type:
      (examinationType as 'osh_code' | 'weighbridge_legal_metrology' | null) ?? undefined,
    limit: paging.limit,
    offset: paging.offset,
  });
  sendJson(res, 200, { examinations });
};

// GET /api/v1/maintenance/statutory-examinations/:examinationId

const getStatutoryExaminationBase: RouteHandler = async (req, res, params) => {
  try {
    const examinationId = requireUuidParam(params, 'examinationId');
    const examination = await getExaminationById(examinationId);
    if (!examination) {
      throw new AppError(404, 'EXAMINATION_NOT_FOUND', 'Statutory examination not found', {
        examination_id: examinationId,
      });
    }
    const records = await listRecordsByExamination(examinationId);
    sendJson(res, 200, { examination, records });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// POST /api/v1/maintenance/statutory-examinations/scan

const scanStatutoryExaminationsBase: RouteHandler = async (req, res, _params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);
  try {
    const businessDate = requireBusinessDate(body);
    const assetId = body['asset_id'];
    if (assetId !== undefined && assetId !== null && !isUuid(assetId)) {
      throw new AppError(400, 'INVALID_PARAMS', 'asset_id must be a UUID when provided');
    }
    const result = await runStatutoryExaminationScan({
      business_date: businessDate,
      asset_id: (assetId as string | undefined) ?? undefined,
      actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
      auditCtx: auditCtxFor(req, actor, 200),
    });
    sendJson(res, 200, result);
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// POST /api/v1/maintenance/assets/:assetId/status

const setAssetStatusBase: RouteHandler = async (req, res, params) => {
  const assetId = params?.['assetId'];
  if (!assetId || !isUuid(assetId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'assetId must be a UUID');
    return;
  }
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const now = new Date().toISOString();

  try {
    const asset = await getAssetById(assetId);
    if (!asset) {
      throw new AppError(404, 'ASSET_NOT_FOUND', 'Asset not found', { asset_id: assetId });
    }

    const newStatus = body['new_status'];
    if (typeof newStatus !== 'string' || !ASSET_STATUSES.has(newStatus)) {
      throw new AppError(
        400,
        'INVALID_STATUS_TRANSITION',
        'new_status must be one of: running, idle, breakdown, maintenance',
      );
    }

    // AC1 enforcement (Task 5.2): an asset with ANY overdue statutory examination is locked from
    // USE until re-examined, regardless of which examination type is due. Scoped to transitions
    // into 'running' so a locked asset can still be recorded as 'maintenance' or 'breakdown' while
    // the re-examination is performed, and so the AC4 broadcast still fires. The seam applies the
    // same scope, so the direct-event path cannot bypass it either.
    const examinations =
      newStatus === 'running' ? await listExaminations({ asset_id: assetId }) : [];
    const overdue = examinations.find((e) => e.status === 'overdue');
    if (overdue) {
      throw new AppError(
        423,
        'STATUTORY_EXAMINATION_OVERDUE',
        'The asset is locked: a statutory examination is overdue',
        {
          asset_id: assetId,
          examination_id: overdue.examination_id,
          examination_type: overdue.examination_type,
        },
      );
    }

    // Table 5 state machine: the current status is derived from the projection; a transition not
    // listed is rejected here so the caller gets a clean 400 before any event is written.
    const current = await getAssetOperationalStatus(assetId);
    const previousStatus = current?.status ?? null;
    const fromKey = previousStatus ?? NO_STATUS_KEY;
    const allowed = MACHINE_STATUS_TRANSITIONS.get(fromKey);
    if (!allowed || !allowed.has(newStatus)) {
      throw new AppError(400, 'INVALID_STATUS_TRANSITION', 'The status transition is not allowed', {
        asset_id: assetId,
        previous_status: previousStatus,
        new_status: newStatus,
      });
    }

    // Return-to-service authority (AC5, Table 6): a transition to 'running' from 'breakdown' or
    // 'maintenance' requires a supervisor sign-off, DOA-resolved (AD-3). The 403 is a business
    // rule raised AFTER the RBAC wrapper, per the Architecture Compliance note.
    const needsSignOff = requiresReturnToServiceSignOff(newStatus);
    let signOffBy: string | null = null;
    let signOffAt: string | null = null;
    if (needsSignOff) {
      const approval = await resolveApprover(RETURN_TO_SERVICE_DOA_TYPE, 0);
      if (!approval.requiresApproval || approval.approverActorId === null) {
        throw new AppError(
          404,
          'APPROVAL_UNRESOLVED',
          'No DOA entry governs maintenance.return_to_service',
          { transaction_type: RETURN_TO_SERVICE_DOA_TYPE },
        );
      }
      if (approval.approverActorId !== actor.userId) {
        throw new AppError(
          403,
          'APPROVAL_REQUIRED',
          'Return to service requires the resolved DOA approver to sign off',
          {
            asset_id: assetId,
            resolved_approver_user_id: approval.approverActorId,
          },
        );
      }
      signOffBy = approval.approverActorId;
      signOffAt = now;
    }

    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: assetId,
        event_type: 'maintenance.asset_status_changed',
        payload: {
          asset_id: assetId,
          previous_status: previousStatus,
          new_status: newStatus,
          changed_by: actor.userId,
          changed_at: now,
          sign_off_by: signOffBy,
          sign_off_at: signOffAt,
        },
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

    const persistedAssetId = replayIdOrReject(
      persisted,
      'maintenance.asset_status_changed',
      'asset_id',
    );

    // AC4 broadcast: the status change is fan-out to BOTH production planning and hub booking
    // after the event commits, non-throwing (AD-17). A same-key replay returns the ORIGINAL event
    // with the ORIGINAL correlation_id, so keying the dedup on that correlation_id skips the
    // re-emission without ever suppressing a later, legitimate transition on the same asset (the
    // "replay emits no second notification" convention, made per-transition rather than per-asset).
    // The dedup is PER TARGET ROLE, not per correlation_id. Gating both emissions on a single
    // marker meant a first-succeeds/second-fails broadcast was unrecoverable: the replay found the
    // planner's row and skipped the block, so hub booking was never told, permanently and on every
    // retry. Asking which roles already have a notification for this correlation_id lets a replay
    // fill in exactly the half that is missing.
    const existingNotifications = await getPool().query(
      `SELECT payload->'target'->>'role' AS role
         FROM domain_events
        WHERE event_type = 'notification.created'
          AND metadata->>'correlation_id' = $1`,
      [persisted.metadata.correlation_id],
    );
    const alreadyNotified = new Set(
      existingNotifications.rows
        .map((row) => (row as Record<string, unknown>)['role'])
        .filter((role): role is string => typeof role === 'string'),
    );

    const actorLabel = `${asset.asset_name} (${asset.asset_tag}), ${previousStatus ?? 'none'} -> ${newStatus}`;
    const base = {
      event_type: 'asset_status_changed',
      status_verb: newStatus,
      object_type: 'asset',
      object_id: persistedAssetId,
      actor_label: actorLabel,
      next_step: 'Update planning and booking accordingly',
      actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
      // The persisted event's correlation_id, so the replay dedup above can match.
      correlation_id: persisted.metadata.correlation_id,
      occurred_at: now,
    };
    // emitNotification never throws and reports failure in its result (AD-17). Discarding that
    // result made a silently undelivered broadcast indistinguishable from a delivered one; the
    // scan job in this same story counts delivered and dropped separately for exactly this reason.
    let notificationsDelivered = 0;
    let notificationsDropped = 0;
    for (const role of ['production_planner', 'hub_booking_coordinator']) {
      if (alreadyNotified.has(role)) continue;
      const emitted = await emitNotification({ ...base, target: { role } });
      if (emitted.ok) notificationsDelivered += 1;
      else notificationsDropped += 1;
    }

    const status = await getAssetOperationalStatus(persistedAssetId);
    sendJson(res, 200, {
      event_id: persisted.event_id,
      asset_id: persistedAssetId,
      status: status ?? null,
      notifications_delivered: notificationsDelivered,
      notifications_dropped: notificationsDropped,
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// GET /api/v1/maintenance/assets/:assetId/status

const getAssetStatusBase: RouteHandler = async (req, res, params) => {
  try {
    const assetId = requireUuidParam(params, 'assetId');
    const asset = await getAssetById(assetId);
    if (!asset) {
      throw new AppError(404, 'ASSET_NOT_FOUND', 'Asset not found', { asset_id: assetId });
    }
    const status = await getAssetOperationalStatus(assetId);
    sendJson(res, 200, { asset_id: assetId, status: status ?? null });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// GET /api/v1/maintenance/asset-status

const listAssetStatusesBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const paging = parseListPaging(req, res, url);
  if (!paging) return;

  const status = url.searchParams.get('status');
  if (status !== null && !ASSET_STATUSES.has(status)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'status must be one of: running, idle, breakdown, maintenance',
    );
    return;
  }

  const statuses = await listAssetOperationalStatuses({
    status: (status as 'running' | 'idle' | 'breakdown' | 'maintenance' | null) ?? undefined,
    limit: paging.limit,
    offset: paging.offset,
  });
  sendJson(res, 200, { asset_statuses: statuses });
};

// GET /api/v1/maintenance/assets/:assetId/costs

const getAssetCostsBase: RouteHandler = async (req, res, params) => {
  try {
    const assetId = requireUuidParam(params, 'assetId');
    const asset = await getAssetById(assetId);
    if (!asset) {
      throw new AppError(404, 'ASSET_NOT_FOUND', 'Asset not found', { asset_id: assetId });
    }
    const costs = await getMaintenanceAssetCost(assetId);
    sendJson(res, 200, { asset_id: assetId, costs: costs ?? null });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// GET /api/v1/maintenance/asset-costs

const listAssetCostsBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const paging = parseListPaging(req, res, url);
  if (!paging) return;

  const costs = await listMaintenanceAssetCosts({ limit: paging.limit, offset: paging.offset });
  sendJson(res, 200, { asset_costs: costs });
};

export const createStatutoryExaminationHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(createStatutoryExaminationBase);

export const listStatutoryExaminationsHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listStatutoryExaminationsBase);

export const getStatutoryExaminationHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(getStatutoryExaminationBase);

export const scanStatutoryExaminationsHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(scanStatutoryExaminationsBase);

export const setAssetStatusHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(setAssetStatusBase);

export const getAssetStatusHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(getAssetStatusBase);

export const listAssetStatusesHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listAssetStatusesBase);

export const getAssetCostsHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(getAssetCostsBase);

export const listAssetCostsHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listAssetCostsBase);

// ---------------------------------------------------------------------------
// Story 7.7: AMC, Warranty, and Insurance Tracking (FR-M-10, FR-M-11)
// ---------------------------------------------------------------------------
//
// Every decision lives in src/compliance/maintenance-coverage.ts (and, for the chargeable-work
// gate, in src/compliance/maintenance-plan.ts), not here: these handlers own only the capture-time
// resolutions (server-minted ids, actor stamping, the DOA pre-check for a clean early 403) and the
// response shape, so a direct POST /api/v1/events cannot bypass any of them (AD-12).

// POST /api/v1/maintenance/assets/:assetId/coverages

const recordCoverageBase: RouteHandler = async (req, res, params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const coverageId = randomUUID();
  const now = new Date().toISOString();

  try {
    const assetId = requireUuidParam(params, 'assetId');
    const coverageType = body['coverage_type'];
    if (typeof coverageType !== 'string' || !COVERAGE_TYPES.has(coverageType)) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'coverage_type must be one of: amc, warranty, insurance',
      );
    }
    // Bounded HERE as well as in the seam, and bounded on the TRIMMED value the handler actually
    // persists. The seam measured the untrimmed string, so a 520-character name with ten leading
    // spaces was accepted and stored at 510, and an over-long value came back as 400
    // INVALID_PAYLOAD while every other failure on this route is 400 INVALID_PARAMS.
    const providerName = body['provider_name'];
    if (typeof providerName !== 'string' || providerName.trim() === '') {
      throw new AppError(400, 'INVALID_PARAMS', 'provider_name is required');
    }
    if (providerName.trim().length > MAX_COVERAGE_TEXT_LENGTH) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `provider_name must be at most ${MAX_COVERAGE_TEXT_LENGTH} characters`,
      );
    }
    const referenceNumberExt = body['reference_number_ext'];
    if (typeof referenceNumberExt !== 'string' || referenceNumberExt.trim() === '') {
      throw new AppError(400, 'INVALID_PARAMS', 'reference_number_ext is required');
    }
    if (referenceNumberExt.trim().length > MAX_COVERAGE_TEXT_LENGTH) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `reference_number_ext must be at most ${MAX_COVERAGE_TEXT_LENGTH} characters`,
      );
    }
    const startDate = requireCalendarDate(body, 'start_date', 'INVALID_PARAMS');
    const expiryDate = requireCalendarDate(body, 'expiry_date', 'INVALID_PARAMS');
    // Both are validated YYYY-MM-DD strings, so the lexical comparison IS the calendar comparison.
    if (expiryDate <= startDate) {
      throw new AppError(400, 'INVALID_PARAMS', 'expiry_date must be after start_date', {
        start_date: startDate,
        expiry_date: expiryDate,
      });
    }
    const businessDate = requireBusinessDate(body);
    // An exact decimal string end to end; a JS number would silently round the contract value.
    const contractValueRaw = body['contract_value'];
    let contractValue: string | null = null;
    if (contractValueRaw !== undefined && contractValueRaw !== null) {
      if (typeof contractValueRaw !== 'string' || !COST_NUMERIC_REGEX.test(contractValueRaw)) {
        throw new AppError(
          400,
          'INVALID_PARAMS',
          'contract_value must be a NUMERIC string with at most 3 decimals',
          { contract_value: contractValueRaw },
        );
      }
      contractValue = contractValueRaw;
    }

    const asset = await getAssetById(assetId);
    if (!asset) {
      throw new AppError(404, 'ASSET_NOT_FOUND', 'Asset not found', { asset_id: assetId });
    }

    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: assetId,
        event_type: 'maintenance.coverage_recorded',
        payload: {
          coverage_id: coverageId,
          asset_id: assetId,
          coverage_type: coverageType,
          provider_name: providerName.trim(),
          reference_number_ext: referenceNumberExt.trim(),
          start_date: startDate,
          expiry_date: expiryDate,
          contract_value: contractValue,
          recorded_by: actor.userId,
          recorded_at: now,
          business_date: businessDate,
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

    const persistedId = replayIdOrReject(persisted, 'maintenance.coverage_recorded', 'coverage_id');
    // Read back BY ID from the persisted payload's own id (the API Contract rule), never by
    // re-querying the newest row.
    const coverage = await getCoverageById(persistedId);
    sendJson(res, 201, { event_id: persisted.event_id, coverage: coverage ?? null });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

/**
 * `status` is resolved against a business_date, never the server clock inside SQL. When the caller
 * supplies none, the server's IST calendar date is used: the deployment's business day, not a UTC
 * instant sliced to ten characters.
 */
function coverageStatusFilter(
  req: IncomingMessage,
  res: Parameters<RouteHandler>[1],
  url: URL,
): { ok: true; status: string | undefined; businessDate: string | undefined } | { ok: false } {
  const status = url.searchParams.get('status');
  if (status === null) return { ok: true, status: undefined, businessDate: undefined };
  if (!['active', 'expired', 'future'].includes(status)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'status must be one of: active, expired, future',
    );
    return { ok: false };
  }
  const businessDateRaw = url.searchParams.get('business_date');
  if (businessDateRaw !== null && !isValidCalendarDate(businessDateRaw)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'business_date must be YYYY-MM-DD');
    return { ok: false };
  }
  return {
    ok: true,
    status,
    businessDate: businessDateRaw ?? toIstCalendarDate(new Date()),
  };
}

// GET /api/v1/maintenance/assets/:assetId/coverages

const listAssetCoveragesBase: RouteHandler = async (req, res, params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const paging = parseListPaging(req, res, url);
  if (!paging) return;

  const assetId = params?.['assetId'];
  if (!assetId || !isUuid(assetId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'assetId must be a UUID');
    return;
  }
  const coverageType = url.searchParams.get('coverage_type');
  if (coverageType !== null && !COVERAGE_TYPES.has(coverageType)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'coverage_type must be one of: amc, warranty, insurance',
    );
    return;
  }
  const statusFilter = coverageStatusFilter(req, res, url);
  if (!statusFilter.ok) return;

  const coverages = await listCoverages(
    {
      asset_id: assetId,
      coverage_type: coverageType,
      status: statusFilter.status,
      business_date: statusFilter.businessDate,
    },
    { limit: paging.limit, offset: paging.offset },
  );
  sendJson(res, 200, { coverages });
};

// GET /api/v1/maintenance/coverages

const listCoveragesBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const paging = parseListPaging(req, res, url);
  if (!paging) return;

  const assetId = url.searchParams.get('asset_id');
  if (assetId !== null && !isUuid(assetId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'asset_id must be a UUID');
    return;
  }
  const coverageType = url.searchParams.get('coverage_type');
  if (coverageType !== null && !COVERAGE_TYPES.has(coverageType)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'coverage_type must be one of: amc, warranty, insurance',
    );
    return;
  }
  const statusFilter = coverageStatusFilter(req, res, url);
  if (!statusFilter.ok) return;

  const coverages = await listCoverages(
    {
      asset_id: assetId,
      coverage_type: coverageType,
      status: statusFilter.status,
      business_date: statusFilter.businessDate,
    },
    { limit: paging.limit, offset: paging.offset },
  );
  sendJson(res, 200, { coverages });
};

// GET /api/v1/maintenance/coverages/alerts

const listCoverageAlertsBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const paging = parseListPaging(req, res, url);
  if (!paging) return;

  const coverageId = url.searchParams.get('coverage_id');
  const assetId = url.searchParams.get('asset_id');
  const stageDaysRaw = url.searchParams.get('stage_days');
  if (coverageId !== null && !isUuid(coverageId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'coverage_id must be a UUID');
    return;
  }
  if (assetId !== null && !isUuid(assetId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'asset_id must be a UUID');
    return;
  }
  if (
    stageDaysRaw !== null &&
    !(COVERAGE_STAGES as readonly number[]).includes(Number(stageDaysRaw))
  ) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'stage_days must be one of: 90, 60, 30');
    return;
  }

  const alerts = await listCoverageAlerts(
    {
      coverage_id: coverageId,
      asset_id: assetId,
      stage_days: stageDaysRaw === null ? undefined : Number(stageDaysRaw),
    },
    { limit: paging.limit, offset: paging.offset },
  );
  sendJson(res, 200, { alerts });
};

// POST /api/v1/maintenance/coverages/scan

const scanCoveragesBase: RouteHandler = async (req, res, _params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);
  try {
    const businessDate = requireBusinessDate(body);
    const assetId = optionalAssetIdFilter(body);
    const result = await runCoverageExpiryScan({
      business_date: businessDate,
      asset_id: assetId,
      actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
      auditCtx: auditCtxFor(req, actor, 200),
    });
    sendJson(res, 200, result);
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// GET /api/v1/maintenance/coverages/:coverageId

const getCoverageBase: RouteHandler = async (req, res, params) => {
  try {
    const coverageId = requireUuidParam(params, 'coverageId');
    const coverage = await getCoverageById(coverageId);
    if (!coverage) {
      throw new AppError(404, 'COVERAGE_NOT_FOUND', 'Coverage not found', {
        coverage_id: coverageId,
      });
    }
    sendJson(res, 200, { coverage });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// POST /api/v1/maintenance/work-orders/:workOrderId/warranty-overrides

const recordWarrantyOverrideBase: RouteHandler = async (req, res, params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const overrideId = randomUUID();
  const now = new Date().toISOString();

  try {
    const workOrderId = requireUuidParam(params, 'workOrderId');
    const reasonCodeRaw = body['reason_code'];
    if (
      typeof reasonCodeRaw !== 'string' ||
      reasonCodeRaw.trim() === '' ||
      reasonCodeRaw.trim().length > MAX_REASON_CODE_LENGTH
    ) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `reason_code is required and must be at most ${MAX_REASON_CODE_LENGTH} characters`,
      );
    }
    const reasonCode = reasonCodeRaw.trim();

    const workOrder = await getWorkOrderById(workOrderId);
    if (!workOrder) {
      throw new AppError(404, 'WORK_ORDER_NOT_FOUND', 'Work order not found', {
        work_order_id: workOrderId,
      });
    }
    if (workOrder.warranty_flagged !== true) {
      throw new AppError(
        409,
        'WARRANTY_OVERRIDE_NOT_REQUIRED',
        'The work order is not warranty-flagged, so no override applies',
        { work_order_id: workOrderId },
      );
    }
    // Review decision BD2: a handler pre-check runs BEFORE persistEvent resolves the idempotency
    // key, so any pre-check whose answer can legitimately change between the original write and a
    // same-key retry turns a valid REPLAY into an error and breaks the AD-16 contract. That is why
    // the one-override-per-work-order grain was never pre-checked here (the
    // raiseCalibrationEscalationBase precedent) - but the same reasoning had been applied
    // inconsistently, and three MUTABLE conditions were still pre-checked:
    //
    //   WORK_ORDER_ALREADY_COMPLETED - the normal AC 3 flow is override, THEN complete, so a
    //     client retrying its original POST after a timeout got a 409 instead of its 201.
    //   APPROVAL_UNRESOLVED / APPROVAL_REQUIRED - a DOA delegation rotating between the write and
    //     the retry produced a 404 or 403 on a request that had already succeeded.
    //
    // All three now live only in the seam, which re-evaluates them under the work order's lock and
    // AFTER the alreadyPersisted guard, raising the identical code, message and details. Nothing is
    // committed on rejection, so an unauthorized caller still mints no event.
    //
    // WARRANTY_OVERRIDE_NOT_REQUIRED above and the reason-code check below are deliberately KEPT:
    // warranty_flagged is derived once at work-order creation and never mutates, and the allowed
    // reason codes are load-time config, so neither answer can change under a legitimate replay.
    if (!config.maintenance.warrantyOverrideReasonCodes.includes(reasonCode)) {
      throw new AppError(
        422,
        'WARRANTY_OVERRIDE_REASON_INVALID',
        'The reason code is not a configured warranty override reason',
        {
          work_order_id: workOrderId,
          reason_code: reasonCode,
          allowed: config.maintenance.warrantyOverrideReasonCodes,
        },
      );
    }

    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: workOrderId,
        event_type: 'maintenance.warranty_override_recorded',
        payload: {
          override_id: overrideId,
          work_order_id: workOrderId,
          warranty_coverage_id: workOrder.warranty_coverage_id,
          reason_code: reasonCode,
          overridden_by: actor.userId,
          overridden_at: now,
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

    const persistedId = replayIdOrReject(
      persisted,
      'maintenance.warranty_override_recorded',
      'override_id',
    );
    const override = await getWarrantyOverrideById(persistedId);
    sendJson(res, 201, { event_id: persisted.event_id, override: override ?? null });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// GET /api/v1/maintenance/work-orders/:workOrderId/warranty-overrides

const getWarrantyOverrideBase: RouteHandler = async (req, res, params) => {
  try {
    const workOrderId = requireUuidParam(params, 'workOrderId');
    const workOrder = await getWorkOrderById(workOrderId);
    if (!workOrder) {
      throw new AppError(404, 'WORK_ORDER_NOT_FOUND', 'Work order not found', {
        work_order_id: workOrderId,
      });
    }
    const override = await getWarrantyOverrideByWorkOrder(workOrderId);
    sendJson(res, 200, { override: override ?? null });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

export const recordCoverageHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(recordCoverageBase);

export const listAssetCoveragesHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listAssetCoveragesBase);

export const listCoveragesHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listCoveragesBase);

export const listCoverageAlertsHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listCoverageAlertsBase);

export const scanCoveragesHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(scanCoveragesBase);

export const getCoverageHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(getCoverageBase);

export const recordWarrantyOverrideHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(recordWarrantyOverrideBase);

export const getWarrantyOverrideHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(getWarrantyOverrideBase);
