import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RouteHandler } from '../../middleware/error.js';
import { sendJson, sendRequestError } from '../../middleware/error.js';
import { getParsedBody, getAuthContext, getAuthorizedAssignment, getTraceId } from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getCurrentLocation } from '../../read/projections/location.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Sentinel used ONLY for the domain-event envelope's actor.location_id when the acting admin's
// authorizing assignment is enterprise-wide ('*'), which is not a UUID. The audit_log.location_id
// (TEXT) has no such constraint, so it records the real '*' assignment value. Duplicated from
// src/api/v1/doa.ts (the Story 1.4 source of this pattern) rather than extracted, to avoid
// touching reviewed 1.4 code; if another consumer appears, extract to a shared module then.
const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';

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

function validLotId(params: Record<string, string>): string | null {
  const lotId = params['lotId'];
  return lotId && UUID_REGEX.test(lotId) ? lotId : null;
}

const getCurrentLocationBase: RouteHandler = async (_req, res, params) => {
  const lotId = validLotId(params);
  if (!lotId) {
    sendRequestError(_req, res, 400, 'INVALID_PARAMS', 'lotId must be a valid UUID');
    return;
  }

  const current = await getCurrentLocation(lotId);
  sendJson(res, 200, {
    location: current?.location ?? null,
    confidence: current?.confidence ?? 'none',
  });
};

// Synthetic expected-fact seeding endpoint for spine testing. There is deliberately no PUT/PATCH
// or DELETE for location facts: current location changes only through location.* events. Lot IDs
// and location IDs are opaque in Epic 1; Epic 2 owns real lot and location masters.
const seedExpectedLocationBase: RouteHandler = async (req, res, params) => {
  const lotId = validLotId(params);
  if (!lotId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'lotId must be a valid UUID');
    return;
  }
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body || !isNonEmptyString(body['expected_location'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'expected_location is required and must be a non-empty string');
    return;
  }

  const source = isNonEmptyString(body['source']) ? body['source'] : 'seed';
  const actor = actorContext(req);
  const persisted = await persistEvent(
    {
      stream_type: 'inventory',
      stream_id: lotId,
      event_type: 'location.expected',
      payload: {
        business_stream: 'production',
        lot_id: lotId,
        expected_location: body['expected_location'],
        source,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: new Date().toISOString(),
      },
    },
    auditCtxFor(req, actor, 201),
  );

  sendJson(res, 201, persisted);
};

export const getCurrentLocationHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read' })(getCurrentLocationBase);
export const seedExpectedLocationHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(seedExpectedLocationBase);
