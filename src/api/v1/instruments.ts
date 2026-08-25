import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
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
import type { EventEnvelope } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getPool } from '../../config/db.js';
import {
  ensureInstrumentCalibrationRow,
  getInstrumentCalibrationStatus,
  updateInstrumentCalibrationStatus,
} from '../../read/projections/instrument_calibration.js';
import type { CalibrationStatus } from '../../read/projections/instrument_calibration.js';
import { findFirstActiveDoaEntry, findRoleHolder } from '../../read/projections/doa_registry.js';
import { getInstrumentRecordByInstrumentId } from '../../read/projections/instrument_register.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const MAX_INSTRUMENT_ID_LENGTH = 128;

type WriteAuditCtx = Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;

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

function auditCtxFor(req: IncomingMessage, actor: ActorContext, httpStatus: number): WriteAuditCtx {
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validInstrumentId(
  params: Record<string, string>,
  req: IncomingMessage,
  res: Parameters<RouteHandler>[1],
): string | null {
  const instrumentId = params['id'];
  if (
    !instrumentId ||
    !isNonEmptyString(instrumentId) ||
    instrumentId.length > MAX_INSTRUMENT_ID_LENGTH
  ) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'instrument id must be a non-empty text identifier no longer than 128 characters',
    );
    return null;
  }
  return instrumentId;
}

function parseCalibrationStatus(value: unknown): CalibrationStatus | null {
  return value === 'calibrated' || value === 'out_of_calibration' ? value : null;
}

const updateCalibrationStatusBase: RouteHandler = async (req, res, params) => {
  const instrumentId = validInstrumentId(params, req, res);
  if (!instrumentId) return;
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const calibrationStatus = parseCalibrationStatus(body?.['calibration_status']);
  if (!body || !calibrationStatus) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'calibration_status must be calibrated or out_of_calibration',
    );
    return;
  }
  const reason = body['reason'] === undefined || body['reason'] === null ? null : body['reason'];
  if (reason !== null && !isNonEmptyString(reason)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'reason must be a non-empty string when provided',
    );
    return;
  }

  const actor = actorContext(req);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Story 7.5 (Non-Overridable Contract, AC 2). Once an instrument is in the calibration
    // register, only a recorded certificate can return it to 'calibrated': manual reinstatement is
    // precisely the role override AD-8 forbids, and closing it is the point of AC 2. The check
    // runs INSIDE this transaction and BEFORE persistEvent, so a rejected reinstatement writes no
    // event and leaves no trace of a status change; the 423's audit entry comes from the existing
    // error path. Locking DOWN is never a bypass, so 'out_of_calibration' stays open to every
    // maintenance:write holder for registered and unregistered instruments alike, and an
    // unregistered instrument id keeps the Story 1.7 behaviour byte for byte - which is what keeps
    // the Spine Acceptance Contract green.
    // The register lookup is FOR UPDATE so a concurrent maintenance.instrument_registered
    // serializes here instead of committing between this read and the status write below. Without
    // the lock, the handler could see 'registered = null', then a registration commits, and this
    // path would write a second case-variant status row whose lower() match makes the lockout gate
    // ambiguous.
    const registered = await getInstrumentRecordByInstrumentId(instrumentId, client, true);
    if (registered && calibrationStatus === 'calibrated') {
      throw new AppError(
        423,
        'CALIBRATION_LOCKOUT',
        'A registered instrument can only be returned to calibrated by recording a calibration certificate',
        {
          instrument_id: registered.instrument_id,
          instrument_record_id: registered.instrument_record_id,
        },
      );
    }
    // For a registered instrument the status row is keyed by the id AS STORED in the register, so
    // a case variant in the URL cannot create a second status row and make the lower() lookup the
    // gate depends on ambiguous.
    const statusKey = registered ? registered.instrument_id : instrumentId;
    const existedBefore = (await getInstrumentCalibrationStatus(statusKey, client)) !== null;
    const before = await ensureInstrumentCalibrationRow(statusKey, actor.userId, client);
    const event = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: before.instrument_uuid,
        event_type: 'instrument.calibration_status_updated',
        payload: {
          instrument_id: statusKey,
          previous_status: existedBefore ? before.calibration_status : 'unknown',
          calibration_status: calibrationStatus,
          reason,
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
    const updated = await updateInstrumentCalibrationStatus(
      {
        instrument_id: statusKey,
        calibration_status: calibrationStatus,
        status_event_id: event.event_id,
        status_event_version: event.event_version,
        status_changed_by: actor.userId,
        reason,
      },
      client,
    );
    await client.query('COMMIT');
    sendJson(res, 200, updated);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const createQcResultBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (
    !body ||
    !isNonEmptyString(body['instrument_id']) ||
    !isNonEmptyString(body['lot_id']) ||
    !isNonEmptyString(body['parameter'])
  ) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'instrument_id, lot_id, and parameter are required non-empty strings',
    );
    return;
  }
  if (body['value'] === undefined || body['value'] === null) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'value is required');
    return;
  }

  const actor = actorContext(req);
  const envelope: EventEnvelope = {
    stream_type: 'qc',
    stream_id: randomUUID(),
    event_type: 'qc.result_recorded',
    payload: {
      instrument_id: body['instrument_id'],
      lot_id: body['lot_id'],
      parameter: body['parameter'],
      value: body['value'],
    },
    metadata: {
      correlation_id: randomUUID(),
      actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
      occurred_at: new Date().toISOString(),
    },
  };

  const persisted = await persistEvent(envelope, auditCtxFor(req, actor, 201));
  sendJson(res, 201, persisted);
};

const createCalibrationEscalationBase: RouteHandler = async (req, res, params) => {
  const instrumentId = validInstrumentId(params, req, res);
  if (!instrumentId) return;
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const reason =
    body?.['reason'] === undefined || body?.['reason'] === null ? null : body['reason'];
  if (reason !== null && !isNonEmptyString(reason)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'reason must be a non-empty string when provided',
    );
    return;
  }

  const actor = actorContext(req);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const status = await getInstrumentCalibrationStatus(instrumentId, client);
    if (!status) {
      throw new AppError(
        404,
        'NOT_FOUND',
        `No calibration status exists for instrument "${instrumentId}"`,
      );
    }
    if (status.calibration_status !== 'out_of_calibration') {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'calibration escalation requires an out-of-calibration instrument',
      );
    }

    const entry = await findFirstActiveDoaEntry('calibration.escalation', client);
    if (!entry) {
      throw new AppError(404, 'NO_DOA_ENTRY_MATCH', 'No DOA entry governs calibration.escalation');
    }
    const approver = await findRoleHolder(entry.role, client);
    if (!approver) {
      throw new AppError(404, 'NO_APPROVER_FOUND', `No active user holds role "${entry.role}"`);
    }

    const event = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: status.instrument_uuid,
        event_type: 'calibration.escalation_requested',
        payload: {
          instrument_id: instrumentId,
          requesting_actor: { user_id: actor.userId, role: actor.role },
          doa_entry_id: entry.entry_id,
          routed_approver_user_id: approver.user_id,
          reason,
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
    sendJson(res, 201, {
      event,
      matched_entry: {
        entry_id: entry.entry_id,
        role: entry.role,
        transaction_type: entry.transaction_type,
        value_min: entry.value_min,
        value_max: entry.value_max,
      },
      approver,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const updateCalibrationStatusHandler: RouteHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(updateCalibrationStatusBase);
export const createQcResultHandler: RouteHandler = requireRole({
  module: 'qc',
  functionScope: 'write',
})(createQcResultBase);
export const createCalibrationEscalationHandler: RouteHandler = requireRole({
  module: 'qc',
  functionScope: 'write',
})(createCalibrationEscalationBase);
