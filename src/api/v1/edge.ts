import { SignJWT } from 'jose';
import { createSecretKey } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson } from '../../middleware/error.js';
import {
  getAuthContext,
  getAuthorizedAssignment,
  getParsedBody,
  getTraceId,
} from '../../middleware/context.js';
import { requireRole, permittedLocationsForModuleScope } from '../../middleware/rbac.js';
import { validateEnvelope, persistEvent } from '../../events/store.js';
import { validateEdgeEnvelope } from '../../sync/upload.js';
import { ZoneIncompatibleWarning, zoneWarningEnvelope } from '../../compliance/inventory-master.js';
import { config } from '../../config/index.js';
import type { AuthContext } from '../../middleware/context.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const PLANNING_EVENT_TYPES = new Set([
  'inventory_planning.params_set',
  'inventory_planning.safety_stock_computed',
  'replenishment.recommended',
  'obsolescence.flagged',
  'obsolescence.cleared',
]);

function planningPayloadLocation(body: { stream_type: string; event_type: string; payload: Record<string, unknown> }): string | null {
  if (body.stream_type !== 'inventory' || !PLANNING_EVENT_TYPES.has(body.event_type)) return null;
  const locationId = body.payload['location_id'];
  return typeof locationId === 'string' ? locationId : null;
}

function assertPlanningPayloadWriteLocation(authContext: AuthContext, body: { stream_type: string; event_type: string; payload: Record<string, unknown> }): void {
  const locationId = planningPayloadLocation(body);
  if (!locationId) return;
  const { wildcard, locations } = permittedLocationsForModuleScope(authContext.roles, 'inventory', 'write');
  if (!wildcard && !locations.has(locationId)) {
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No write assignment grants access to planning payload location "${locationId}"`);
  }
}

function edgeSiteName(): string {
  return config.edge.siteName;
}

function powerSyncSecretKey(): ReturnType<typeof createSecretKey> {
  return createSecretKey(Buffer.from(config.powerSync.tokenSecret, 'utf-8'));
}

interface OperatingAssignment {
  role: string;
  locationId: string;
}

function selectOperatingAssignment(authContext: AuthContext): OperatingAssignment {
  const concrete = authContext.roles.filter((r) => r.locationId !== '*');
  const distinctLocations = new Set(concrete.map((r) => r.locationId));

  if (distinctLocations.size === 0) {
    throw new AppError(
      403,
      'EDGE_NO_CONCRETE_SITE',
      'No concrete operating location is assigned to this user; edge sync requires a specific site assignment',
    );
  }
  if (distinctLocations.size > 1) {
    throw new AppError(
      409,
      'EDGE_AMBIGUOUS_SITE',
      'Multiple concrete operating locations are assigned to this user; edge sync requires a single site',
    );
  }

  const locationId = [...distinctLocations][0]!;
  const assignment = concrete
    .filter((r) => r.locationId === locationId)
    .sort((a, b) =>
      [a.role, a.module, a.functionScope].join('\0').localeCompare([b.role, b.module, b.functionScope].join('\0')),
    )[0]!;
  return { role: assignment.role, locationId };
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

const edgeBootstrapBase: RouteHandler = async (req, res) => {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');

  const assignment = selectOperatingAssignment(authContext);

  sendJson(res, 200, {
    user_id: authContext.userId,
    user_name: authContext.displayName ?? authContext.externalId,
    site_id: assignment.locationId,
    site_name: edgeSiteName(),
    role: assignment.role,
    navigation: ['Dashboard', 'Frontline'],
    offline_ready: true,
  });
};

const powerSyncCredentialsBase: RouteHandler = async (req, res) => {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');

  const assignment = selectOperatingAssignment(authContext);

  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    user_id: authContext.userId,
    role: assignment.role,
    site_id: assignment.locationId,
    site_name: edgeSiteName(),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(authContext.externalId)
    .setIssuer(config.powerSync.tokenIssuer)
    .setAudience(config.powerSync.tokenAudience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + config.powerSync.tokenTtlSeconds)
    .sign(powerSyncSecretKey());

  sendJson(res, 200, {
    endpoint: config.powerSync.url,
    token,
    expires_in_seconds: config.powerSync.tokenTtlSeconds,
  });
};

const edgeEventUploadBase: RouteHandler = async (req, res) => {
  const body = getParsedBody(req);
  validateEnvelope(body);
  validateEdgeEnvelope(body);

  const authContext = getAuthContext(req);
  const assignment = getAuthorizedAssignment(req);
  if (!authContext || !assignment)
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  assertPlanningPayloadWriteLocation(authContext, body);

  body.metadata.actor.user_id = authContext.userId;
  body.metadata.actor.role = assignment.role;
  if (assignment.locationId !== '*') {
    body.metadata.actor.location_id = assignment.locationId;
  } else if (body.stream_type === 'inventory') {
    body.metadata.actor.location_id = NO_LOCATION_UUID;
  }
  if (
    body.stream_type === 'inventory' &&
    (body.payload['target_location_id'] !== undefined || body.payload['target_location_code'] !== undefined)
  ) {
    body.payload['placement_confirmed'] = true;
  }

  try {
    const persisted = await persistEvent(body, {
      trace_id: getTraceId(req) ?? '',
      user_id: authContext.userId,
      role: assignment.role,
      location_id: assignment.locationId,
      endpoint: req.url ?? '',
      method: req.method ?? 'POST',
      http_status: 201,
    });
    sendJson(res, 201, persisted);
  } catch (err) {
    if (err instanceof ZoneIncompatibleWarning) {
      sendJson(res, 200, zoneWarningEnvelope(err, getTraceId(req) ?? ''));
      return;
    }
    throw err;
  }
};

export const edgeBootstrapHandler: RouteHandler = edgeBootstrapBase;
export const powerSyncCredentialsHandler: RouteHandler = powerSyncCredentialsBase;

export const edgeEventUploadHandler: RouteHandler = requireRole({
  module: resolveModuleFromBody,
  functionScope: 'write',
  locationId: resolveLocationFromBody,
})(edgeEventUploadBase);
