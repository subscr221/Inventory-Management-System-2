import type { RouteHandler } from '../../middleware/error.js';
import type { IncomingMessage } from 'node:http';
import { sendJson, sendError, AppError } from '../../middleware/error.js';
import { validateEnvelope, persistEvent, readStream } from '../../events/store.js';

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalLength = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    totalLength += buffer.length;
    if (totalLength > MAX_BODY_SIZE) {
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError(400, 'INVALID_JSON', 'Body is not valid JSON');
  }
}

export const postEventHandler: RouteHandler = async (req, res, _params) => {
  const body = await readBody(req);
  validateEnvelope(body);
  const persisted = await persistEvent(body);
  sendJson(res, 201, persisted);
};

export const getStreamHandler: RouteHandler = async (_req, res, params) => {
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
