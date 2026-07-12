import type { RouteHandler } from '../../middleware/error.js';
import { sendJson, sendError } from '../../middleware/error.js';
import { validateEnvelope, persistEvent, readStream } from '../../events/store.js';
import { getParsedBody } from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';

function resolveModuleFromBody(_params: Record<string, string>, body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const streamType = (body as Record<string, unknown>)['stream_type'];
    if (typeof streamType === 'string') return streamType;
  }
  return '';
}

function resolveLocationFromBody(_params: Record<string, string>, body: unknown): string | undefined {
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

const postEventBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req);
  validateEnvelope(body);
  const persisted = await persistEvent(body);
  sendJson(res, 201, persisted);
};

const getStreamBase: RouteHandler = async (_req, res, params) => {
  const streamType = params['streamType'];
  const streamId = params['streamId'];

  if (!streamType || !streamId) {
    sendError(res, 400, 'INVALID_PARAMS', 'streamType and streamId are required');
    return;
  }
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_REGEX.test(streamId)) {
    sendError(res, 400, 'INVALID_PARAMS', 'streamId must be a valid UUID');
    return;
  }

  const events = await readStream(streamType, streamId);
  sendJson(res, 200, { events });
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
