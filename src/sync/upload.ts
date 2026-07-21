import { AppError } from '../middleware/error.js';
import type { EventEnvelope } from '../events/store.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LocalSyncStatus =
  'pending_sync' | 'syncing' | 'synced' | 'needs_attention' | 'auth_required';

export interface UploadFailureClassification {
  action: 'complete' | 'retry' | 'halt';
  localStatus: LocalSyncStatus;
  retryable: boolean;
  serverErrorCode?: string;
  existingEventId?: string;
}

const PERMANENT_ERROR_CODES = new Set([
  'INVALID_EVENT_ENVELOPE',
  'UNTAGGED_TRANSACTION',
  'STREAM_CONFLICT',
  'CALIBRATION_LOCKOUT',
  'INSUFFICIENT_STOCK',
  'LOT_EXPIRED',
  'LOT_ON_HOLD',
  'DUPLICATE_LOT',
  'DUPLICATE_SERIAL',
  'SERIAL_REQUIRED',
  'SERIAL_NOT_ALLOWED',
  'SERIAL_NOT_AVAILABLE',
  'NO_AVAILABLE_LOT',
  'LOT_NOT_FOUND',
  'SERIAL_NOT_FOUND',
]);

function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

function existingEventIdFrom(error: AppError): string | undefined {
  const value = error.details['existing_event_id'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function classifyUploadFailure(error: unknown): UploadFailureClassification {
  if (!isAppError(error)) {
    return { action: 'retry', localStatus: 'pending_sync', retryable: true };
  }

  if (error.errorCode === 'DUPLICATE_EVENT') {
    const classification: UploadFailureClassification = {
      action: 'complete',
      localStatus: 'synced',
      retryable: false,
      serverErrorCode: error.errorCode,
    };
    const existingEventId = existingEventIdFrom(error);
    if (existingEventId) classification.existingEventId = existingEventId;
    return classification;
  }

  if (error.statusCode === 401 || error.statusCode === 403) {
    return {
      action: 'halt',
      localStatus: 'auth_required',
      retryable: false,
      serverErrorCode: error.errorCode,
    };
  }

  if (
    PERMANENT_ERROR_CODES.has(error.errorCode) ||
    (error.statusCode >= 400 && error.statusCode < 500)
  ) {
    return {
      action: 'complete',
      localStatus: 'needs_attention',
      retryable: false,
      serverErrorCode: error.errorCode,
    };
  }

  return {
    action: 'retry',
    localStatus: 'pending_sync',
    retryable: true,
    serverErrorCode: error.errorCode,
  };
}

function assertUuid(value: unknown, field: string): void {
  if (typeof value !== 'string' || !UUID_REGEX.test(value)) {
    throw new AppError(
      400,
      'INVALID_EVENT_ENVELOPE',
      `${field} is required and must be a valid UUID`,
    );
  }
}

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError(
      400,
      'INVALID_EVENT_ENVELOPE',
      `${field} is required and must be a non-empty string`,
    );
  }
}

export function validateEdgeEnvelope(envelope: EventEnvelope): void {
  assertUuid(envelope.event_id, 'event_id');
  assertNonEmptyString(envelope.idempotency_key, 'idempotency_key');
  assertNonEmptyString(envelope.metadata.device_id, 'metadata.device_id');
}
