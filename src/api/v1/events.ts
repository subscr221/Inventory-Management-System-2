import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { validateEnvelope, persistEvent, readStream } from '../../events/store.js';
import {
  getParsedBody,
  getAuthContext,
  getAuthorizedRole,
  getAuthorizedAssignment,
  getTraceId,
} from '../../middleware/context.js';
import {
  requireRole,
  permittedLocationsForModule,
  permittedLocationsForModuleScope,
} from '../../middleware/rbac.js';
import { auditConfig } from '../../config/audit.js';
import { getPool } from '../../config/db.js';
import { logTamperAttempt } from '../../read/projections/audit_log.js';
import { ZoneIncompatibleWarning, zoneWarningEnvelope } from '../../compliance/inventory-master.js';
import { OWNERSHIP_CONFIG_ROLES } from '../../compliance/ownership.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const PLANNING_EVENT_TYPES = new Set([
  'inventory_planning.params_set',
  'inventory_planning.safety_stock_computed',
  'replenishment.recommended',
  'obsolescence.flagged',
  'obsolescence.cleared',
  // Story 2.8: ownership agreements are location-scoped config; the payload location must be
  // write-permitted exactly like the planning events above.
  'ownership.agreement_set',
]);

function planningPayloadLocation(body: {
  stream_type: string;
  event_type: string;
  payload: Record<string, unknown>;
}): string | null {
  if (body.stream_type !== 'inventory' || !PLANNING_EVENT_TYPES.has(body.event_type)) return null;
  const locationId = body.payload['location_id'];
  return typeof locationId === 'string' ? locationId : null;
}

const PAYLOAD_SITE_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * THE CENTRAL SITE GATE for the direct events door (added 2026-09-06 after a confirmed cross-site
 * write).
 *
 * The hole this closes, precisely, because every part of it looked correct in isolation:
 *   1. `requireRole` authorises this route against `metadata.actor.location_id`, and an attacker
 *      states their OWN honest location - one their grant genuinely satisfies - so RBAC passes.
 *   2. `postEventBase` then overwrites the actor from the authorising assignment, so the stored
 *      event and the audit row are truthful. Nothing is spoofed.
 *   3. The appliers compare the PAYLOAD's site to the resource ROW's site. An attacker names the
 *      target's site in the payload, so that comparison agrees with itself and never once involves
 *      the actor.
 * Nothing anywhere compared the RESOURCE's site to the actor's AUTHORISED location. Proven by
 * execution: a writer granted only at site B captured site A's customer offcut, and acknowledged
 * site A's billing feed with a fabricated ERP reference, both 201.
 *
 * The REST routes were never exposed - they call their own site assertions against the row they
 * loaded (`assertSiteWriteAccess` in service-orders.ts is the pattern). This is that assertion,
 * hoisted to the one door that lacked it, modelled on `assertPlanningPayloadWriteLocation` above.
 *
 * It binds payload site to the actor's grants. The appliers already bind payload site to row site.
 * Composed, the two bind ROW site to the actor - which is the property that was missing. An event
 * whose payload carries no `site_id` is not covered here and must be bound by its own applier; that
 * is why `jobwork.billing_feed_acknowledged` gained a `site_id` in the same change.
 */
function assertPayloadSiteWriteAccess(
  authContext: NonNullable<ReturnType<typeof getAuthContext>>,
  body: { stream_type: string; event_type: string; payload: Record<string, unknown> },
): void {
  const siteId = body.payload['site_id'];
  if (typeof siteId !== 'string' || !PAYLOAD_SITE_UUID_REGEX.test(siteId)) return;
  const { wildcard, locations } = permittedLocationsForModuleScope(
    authContext.roles,
    body.stream_type,
    'write',
  );
  if (!wildcard && !locations.has(siteId)) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      `No write assignment grants access to site "${siteId}"`,
    );
  }
}

function assertPlanningPayloadWriteLocation(
  authContext: NonNullable<ReturnType<typeof getAuthContext>>,
  body: { stream_type: string; event_type: string; payload: Record<string, unknown> },
): void {
  const locationId = planningPayloadLocation(body);
  if (!locationId) return;
  if (body.event_type === 'ownership.agreement_set') {
    const allowed = authContext.roles.some(
      (r) =>
        (r.module === 'inventory' || r.module === '*') &&
        r.functionScope === 'write' &&
        OWNERSHIP_CONFIG_ROLES.includes(r.role),
    );
    if (!allowed)
      throw new AppError(
        403,
        'FUNCTION_ACCESS_DENIED',
        `This operation is restricted to roles: ${OWNERSHIP_CONFIG_ROLES.join(', ')}`,
      );
  }
  const { wildcard, locations } = permittedLocationsForModuleScope(
    authContext.roles,
    'inventory',
    'write',
  );
  if (!wildcard && !locations.has(locationId)) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      `No write assignment grants access to planning payload location "${locationId}"`,
    );
  }
}

function resolveModuleFromBody(_params: Record<string, string>, body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const streamType = (body as Record<string, unknown>)['stream_type'];
    if (typeof streamType === 'string') return streamType;
  }
  return '';
}

function resolveLocationFromBody(
  _params: Record<string, string>,
  body: unknown,
): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const metadata = (body as Record<string, unknown>)['metadata'];
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const actor = (metadata as Record<string, unknown>)['actor'];
  if (typeof actor !== 'object' || actor === null) return undefined;
  const locationId = (actor as Record<string, unknown>)['location_id'];
  return typeof locationId === 'string' ? locationId : undefined;
}

function resolveModuleFromParams(params: Record<string, string>): string {
  return params['streamType'] ?? '';
}

function referencesInventoryMasters(body: {
  stream_type: string;
  payload: Record<string, unknown>;
}): boolean {
  return (
    body.stream_type === 'inventory' &&
    (body.payload['sku'] !== undefined ||
      body.payload['target_location_id'] !== undefined ||
      body.payload['target_location_code'] !== undefined)
  );
}

const postEventBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req);
  validateEnvelope(body);

  if (body.stream_type === 'engineering' || body.stream_type === 'maintenance') {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_EVENT_STREAM',
      `Direct ${body.stream_type} stream writes are not permitted via the events API`,
    );
    return;
  }

  const authContext = getAuthContext(req);
  const authorizedAssignment = getAuthorizedAssignment(req);
  const auditLocationId = authorizedAssignment?.locationId ?? body.metadata.actor.location_id;
  if (authContext) {
    assertPlanningPayloadWriteLocation(authContext, body);
    assertPayloadSiteWriteAccess(authContext, body);
    body.metadata.actor.user_id = authContext.userId;
    const authorizedRole = getAuthorizedRole(req);
    if (authorizedRole) {
      body.metadata.actor.role = authorizedRole;
    }
    if (authorizedAssignment) {
      if (authorizedAssignment.locationId !== '*') {
        body.metadata.actor.location_id = authorizedAssignment.locationId;
      } else if (referencesInventoryMasters(body)) {
        body.metadata.actor.location_id = NO_LOCATION_UUID;
      }
    }
  }

  // Defense-in-depth guard (Story 1.3, Decision 2). The audit log is startup-immutable, so the
  // process cannot normally be running with it disabled - this branch is unreachable in practice.
  // But `auditConfig.enabled` is a real boolean, so if the log is ever observed inactive at request
  // time we record the attempt to mutate without it and block, mirroring the config-endpoint path.
  if (!auditConfig.enabled) {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await logTamperAttempt(client, {
        user_id: authContext?.userId ?? null,
        role: getAuthorizedRole(req) ?? null,
        location_id: auditLocationId,
        endpoint: req.url ?? null,
        method: req.method ?? null,
        error_code: 'AUDIT_LOG_DISABLED',
        details: { reason: 'Mutating request attempted while audit log inactive' },
      });
    } finally {
      client.release();
    }
    sendRequestError(
      req,
      res,
      423,
      'AUDIT_LOG_DISABLED',
      'No mutating operations are permitted while the audit log is inactive',
    );
    return;
  }

  const traceId = getTraceId(req) ?? '';
  const auditCtx = authContext
    ? {
        trace_id: traceId,
        user_id: authContext.userId,
        role: getAuthorizedRole(req) ?? '',
        location_id: auditLocationId,
        endpoint: req.url ?? '',
        method: req.method ?? 'POST',
        http_status: 201,
      }
    : undefined;

  // Story 2.1 (AC3): a zone-incompatible placement is a WARNING, not an error. The event was NOT
  // persisted; the 200 envelope tells the caller to resubmit with payload.placement_confirmed: true.
  try {
    const persisted = await persistEvent(body, auditCtx);
    sendJson(res, 201, persisted);
  } catch (err) {
    if (err instanceof ZoneIncompatibleWarning) {
      sendJson(res, 200, zoneWarningEnvelope(err, traceId));
      return;
    }
    throw err;
  }
};

const getStreamBase: RouteHandler = async (req, res, params) => {
  const streamType = params['streamType'];
  const streamId = params['streamId'];

  if (!streamType || !streamId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'streamType and streamId are required');
    return;
  }
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_REGEX.test(streamId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'streamId must be a valid UUID');
    return;
  }

  const events = await readStream(streamType, streamId);

  // Location-scope the read: a caller only sees events that occurred at a location their role
  // grants them (module already checked by requireRole). A '*' location grant sees everything.
  // Note: filtering by location can return a non-contiguous slice of a stream's versions.
  const authContext = getAuthContext(req);
  const scoped = authContext
    ? (() => {
        const { wildcard, locations } = permittedLocationsForModule(authContext.roles, streamType);
        if (wildcard) return events;
        return events.filter((e) => locations.has(e.metadata.actor.location_id));
      })()
    : events;

  sendJson(res, 200, { events: scoped });
};

export const postEventHandler: RouteHandler = requireRole({
  module: resolveModuleFromBody,
  functionScope: 'write',
  locationId: resolveLocationFromBody,
})(postEventBase);

export const getStreamHandler: RouteHandler = requireRole({
  module: resolveModuleFromParams,
  functionScope: 'read',
})(getStreamBase);
