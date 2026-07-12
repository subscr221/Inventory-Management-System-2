import type { RouteHandler } from '../../middleware/error.js';
import type { IncomingMessage } from 'node:http';
import { sendJson, sendError } from '../../middleware/error.js';
import { validateEnvelope, persistEvent, readStream } from '../../events/store.js';

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw) return undefined;
  return JSON.parse(raw);
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

  const events = await readStream(streamType, streamId);
  sendJson(res, 200, { events });
};
