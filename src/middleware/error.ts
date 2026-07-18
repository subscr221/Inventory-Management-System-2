import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getTraceId } from './context.js';

export interface ErrorEnvelope {
  error_code: string;
  message: string;
  details: Record<string, unknown>;
  trace_id: string;
}

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errorCode: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function createErrorEnvelope(error: AppError, traceId?: string): ErrorEnvelope {
  return {
    error_code: error.errorCode,
    message: error.message,
    details: error.details,
    trace_id: traceId ?? randomUUID(),
  };
}

export function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

export function sendError(
  res: ServerResponse,
  statusCode: number,
  errorCode: string,
  message: string,
  details: Record<string, unknown> = {},
  traceId?: string,
): void {
  const error = new AppError(statusCode, errorCode, message, details);
  const envelope = createErrorEnvelope(error, traceId);
  sendJson(res, statusCode, envelope);
}

/**
 * Convenience wrapper that stamps the error envelope with the request's own trace_id so a
 * client-visible error correlates with its audit-log entry. Handlers that have the request in
 * scope should prefer this over the bare `sendError` (which would otherwise mint a fresh id).
 */
export function sendRequestError(
  req: IncomingMessage,
  res: ServerResponse,
  statusCode: number,
  errorCode: string,
  message: string,
  details: Record<string, unknown> = {},
): void {
  sendError(res, statusCode, errorCode, message, details, getTraceId(req));
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void>;

export function withErrorHandler(handler: RouteHandler): RouteHandler {
  return async (req, res, params) => {
    try {
      await handler(req, res, params);
    } catch (err) {
      if (res.headersSent) return;
      const traceId = getTraceId(req);
      if (err instanceof AppError) {
        sendError(res, err.statusCode, err.errorCode, err.message, err.details, traceId);
        return;
      }
      sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error', {}, traceId);
    }
  };
}
