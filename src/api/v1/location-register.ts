import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getParsedBody, getAuthContext, getAuthorizedAssignment, getTraceId } from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getPool } from '../../config/db.js';
import {
  createLocation,
  updateLocation,
  getLocationById,
  LOCATION_LEVELS,
  ZONE_TYPES,
  TEMPERATURE_CLASSES,
  LOCATION_STATUSES,
} from '../../read/projections/location_register.js';
import type {
  CreateLocationInput,
  UpdateLocationPatch,
  LocationLevel,
  ZoneType,
  TemperatureClass,
  LocationStatus,
} from '../../read/projections/location_register.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Sentinel used ONLY for the domain-event envelope's actor.location_id when the acting admin's
// authorizing assignment is enterprise-wide ('*'), which is not a UUID. Mirrors src/api/v1/doa.ts.
const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';

// Human-readable codes such as BIN-A43; URL-safe because the code may appear in query strings.
const LOCATION_CODE_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

function isLevel(value: unknown): value is LocationLevel {
  return typeof value === 'string' && (LOCATION_LEVELS as readonly string[]).includes(value);
}

function isZoneType(value: unknown): value is ZoneType {
  return typeof value === 'string' && (ZONE_TYPES as readonly string[]).includes(value);
}

function isTemperatureClass(value: unknown): value is TemperatureClass {
  return typeof value === 'string' && (TEMPERATURE_CLASSES as readonly string[]).includes(value);
}

function isLocationStatus(value: unknown): value is LocationStatus {
  return typeof value === 'string' && (LOCATION_STATUSES as readonly string[]).includes(value);
}

function parseBooleanField(body: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = body[field];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new AppError(400, 'INVALID_PARAMS', `${field} must be a boolean`);
  }
  return value;
}

function isDuplicateCodeError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505' &&
    'constraint' in err &&
    (err as { constraint?: string }).constraint === 'uq_location_register_code'
  );
}

// -----------------------------------------------------------------------------------------------
// POST /api/v1/locations
// -----------------------------------------------------------------------------------------------
const createLocationBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body || !isNonEmptyString(body['location_code'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'location_code is required and must be a non-empty string');
    return;
  }
  const locationCode = body['location_code'];
  if (!LOCATION_CODE_REGEX.test(locationCode)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'location_code must be 1-64 URL-safe characters (letters, digits, ".", "_", "-")');
    return;
  }
  if (!isLevel(body['level'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', `level must be one of ${LOCATION_LEVELS.join(', ')}`, {
      allowed: [...LOCATION_LEVELS],
    });
    return;
  }
  const level = body['level'];
  if (body['zone_type'] !== undefined && !isZoneType(body['zone_type'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', `zone_type must be one of ${ZONE_TYPES.join(', ')}`, { allowed: [...ZONE_TYPES] });
    return;
  }
  if (body['temperature_class'] !== undefined && !isTemperatureClass(body['temperature_class'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', `temperature_class must be one of ${TEMPERATURE_CLASSES.join(', ')}`, {
      allowed: [...TEMPERATURE_CLASSES],
    });
    return;
  }
  if (body['status'] !== undefined && !isLocationStatus(body['status'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'status must be one of active, inactive');
    return;
  }

  const parentIdRaw = body['parent_location_id'];

  const actor = actorContext(req);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const locationId = randomUUID();

    const input: CreateLocationInput = {
      location_id: locationId,
      location_code: locationCode,
      level,
      parent_location_id: parentIdRaw === undefined || parentIdRaw === null ? null : String(parentIdRaw),
      zone_type: isZoneType(body['zone_type']) ? body['zone_type'] : 'general',
      temperature_class: isTemperatureClass(body['temperature_class']) ? body['temperature_class'] : 'ambient',
      hazmat_allowed: parseBooleanField(body, 'hazmat_allowed', false),
      quarantine: parseBooleanField(body, 'quarantine', false),
      status: isLocationStatus(body['status']) ? body['status'] : 'active',
    };
    const location = await createLocation(input, client);
    await persistEvent(
      {
        stream_type: 'location_register',
        stream_id: location.location_id,
        event_type: 'location_register.created',
        payload: { location },
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
    sendJson(res, 201, location);
  } catch (err) {
    await client.query('ROLLBACK');
    if (isDuplicateCodeError(err)) {
      throw new AppError(409, 'DUPLICATE_LOCATION_CODE', `A location with code "${locationCode}" already exists`, {
        location_code: locationCode,
      });
    }
    throw err;
  } finally {
    client.release();
  }
};

// -----------------------------------------------------------------------------------------------
// PATCH /api/v1/locations/:locationId
// -----------------------------------------------------------------------------------------------
const updateLocationBase: RouteHandler = async (req, res, params) => {
  const locationId = params['locationId'];
  if (!locationId || !UUID_REGEX.test(locationId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'locationId must be a valid UUID');
    return;
  }
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body must be a JSON object');
    return;
  }

  const patch: UpdateLocationPatch = {};
  if (body['zone_type'] !== undefined) {
    if (!isZoneType(body['zone_type'])) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', `zone_type must be one of ${ZONE_TYPES.join(', ')}`, { allowed: [...ZONE_TYPES] });
      return;
    }
    patch.zone_type = body['zone_type'];
  }
  if (body['temperature_class'] !== undefined) {
    if (!isTemperatureClass(body['temperature_class'])) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', `temperature_class must be one of ${TEMPERATURE_CLASSES.join(', ')}`, {
        allowed: [...TEMPERATURE_CLASSES],
      });
      return;
    }
    patch.temperature_class = body['temperature_class'];
  }
  for (const field of ['hazmat_allowed', 'quarantine'] as const) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== 'boolean') {
        sendRequestError(req, res, 400, 'INVALID_PARAMS', `${field} must be a boolean`);
        return;
      }
      patch[field] = body[field];
    }
  }
  if (body['status'] !== undefined) {
    if (!isLocationStatus(body['status'])) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'status must be one of active, inactive');
      return;
    }
    patch.status = body['status'];
  }
  if (Object.keys(patch).length === 0) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'At least one updatable field is required');
    return;
  }

  const actor = actorContext(req);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await getLocationById(locationId, client);
    if (!before) {
      throw new AppError(404, 'LOCATION_NOT_FOUND', `No location register record exists for location_id "${locationId}"`, {
        location_id: locationId,
      });
    }
    const after = await updateLocation(locationId, patch, client);
    await persistEvent(
      {
        stream_type: 'location_register',
        stream_id: locationId,
        event_type: 'location_register.updated',
        payload: { location_id: locationId, before, after },
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
    sendJson(res, 200, after);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// -----------------------------------------------------------------------------------------------
// GET /api/v1/locations/:locationId (AC3: returns zone and temperature attributes)
// -----------------------------------------------------------------------------------------------
const getLocationBase: RouteHandler = async (req, res, params) => {
  const locationId = params['locationId'];
  if (!locationId || !UUID_REGEX.test(locationId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'locationId must be a valid UUID');
    return;
  }
  const location = await getLocationById(locationId);
  if (!location) {
    sendRequestError(req, res, 404, 'LOCATION_NOT_FOUND', `No location register record exists for location_id "${locationId}"`, {
      location_id: locationId,
    });
    return;
  }
  sendJson(res, 200, location);
};

export const createLocationHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(createLocationBase);
export const updateLocationHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(updateLocationBase);
export const getLocationHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read' })(getLocationBase);
