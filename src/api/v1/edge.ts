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
import { requireRole } from '../../middleware/rbac.js';
import { validateEnvelope, persistEvent } from '../../events/store.js';
import { validateEdgeEnvelope } from '../../sync/upload.js';
import { config } from '../../config/index.js';

const DEFAULT_TOKEN_TTL = '15m';
const DEFAULT_TOKEN_EXPIRES_IN_SECONDS = 900;

function edgeSiteName(): string {
  return config.edge.siteName;
}

function powerSyncSecretKey(): ReturnType<typeof createSecretKey> {
  return createSecretKey(Buffer.from(config.powerSync.tokenSecret, 'utf-8'));
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
  const assignment = authContext?.roles[0];
  if (!authContext || !assignment)
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');

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
  const assignment = authContext?.roles[0];
  if (!authContext || !assignment)
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');

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
    .setIssuedAt()
    .setExpirationTime(config.powerSync.tokenTtl ?? DEFAULT_TOKEN_TTL)
    .sign(powerSyncSecretKey());

  sendJson(res, 200, {
    endpoint: config.powerSync.url,
    token,
    expires_in_seconds: DEFAULT_TOKEN_EXPIRES_IN_SECONDS,
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

  body.metadata.actor.user_id = authContext.userId;
  body.metadata.actor.role = assignment.role;
  body.metadata.actor.location_id = assignment.locationId;

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
};

export const edgeBootstrapHandler: RouteHandler = edgeBootstrapBase;
export const powerSyncCredentialsHandler: RouteHandler = powerSyncCredentialsBase;

export const edgeEventUploadHandler: RouteHandler = requireRole({
  module: resolveModuleFromBody,
  functionScope: 'write',
  locationId: resolveLocationFromBody,
})(edgeEventUploadBase);
