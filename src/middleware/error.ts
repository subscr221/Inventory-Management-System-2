import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

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
): void {
  const error = new AppError(statusCode, errorCode, message, details);
  const envelope = createErrorEnvelope(error);
  sendJson(res, statusCode, envelope);
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
      if (err instanceof AppError) {
        sendError(res, err.statusCode, err.errorCode, err.message, err.details);
        return;
      }
      const message = err instanceof Error ? err.message : 'Internal server error';
      sendError(res, 500, 'INTERNAL_ERROR', message);
    }
  };
}
