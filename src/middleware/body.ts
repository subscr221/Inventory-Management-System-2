import type { IncomingMessage } from 'node:http';
import { AppError } from './error.js';

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Reads and parses a JSON request body, enforcing a size limit and producing
 * uniform AppError instances for oversized or malformed payloads.
 *
 * Returns `undefined` for an empty body (e.g. GET/DELETE requests with no payload).
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
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
