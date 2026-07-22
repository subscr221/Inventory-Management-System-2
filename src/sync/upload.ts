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
  'LOT_REQUIRED',
  'SERIAL_NOT_FOUND',
  'ITEM_NOT_FOUND',
  'FUNCTION_ACCESS_DENIED',
  'LOCATION_ACCESS_DENIED',
  'VALUATION_METHOD_NOT_PERMITTED',
  'NRV_RECOVERY_EXCEEDS_ORIGINAL_COST',
  'APPROVAL_REQUIRED',
  'QUANTITY_EXCEEDS_APPROVED',
  'LOT_MISMATCH',
  'LOT_SKU_MISMATCH',
  'SERIAL_MISMATCH',
  'APPROVAL_UNRESOLVED',
  // Story 2.6: cycle-count / physical-verification permanent business rejections
  'COUNT_TASK_LOCKED',
  'COUNT_ENTERER_CANNOT_APPROVE',
  'PERIOD_LOCKED',
  'COUNT_VARIANCE_REQUIRES_APPROVAL',
  'STOCK_ADJUSTMENT_NEGATIVE_BALANCE',
  // Story 2.7: inventory-planning permanent business rejections
  'LEAD_TIME_NOT_CONFIGURED',
  'INSUFFICIENT_DEMAND_HISTORY',
  'INVALID_SERVICE_LEVEL',
  'PLANNING_PARAMS_NOT_FOUND',
  'OBSOLESCENCE_THRESHOLD_NOT_CONFIGURED',
  // Story 2.8: consignment/VMI ownership permanent business rejections
  'OWNERSHIP_AGREEMENT_NOT_FOUND',
  'OWNER_PARTY_MISMATCH',
  'VMI_MIN_NOT_CONFIGURED',
  'INVALID_SIGNAL_TYPE',
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

  // A business-rule rejection carrying a known permanent error_code settles the event as
  // needs_attention even at 403 (FUNCTION_ACCESS_DENIED / LOCATION_ACCESS_DENIED / LOT_REQUIRED from
  // the central write path); it must not halt the whole outbox as an auth failure. Checked before
  // the 401/403 halt so those codes are reachable at 403 (Story 2.3 pass-3). A genuine authn failure
  // (401 UNAUTHORIZED, or a 403 with no permanent business code) is not in the set and still halts.
  if (PERMANENT_ERROR_CODES.has(error.errorCode)) {
    return {
      action: 'complete',
      localStatus: 'needs_attention',
      retryable: false,
      serverErrorCode: error.errorCode,
    };
  }

  if (error.statusCode === 401 || error.statusCode === 403) {
    return {
      action: 'halt',
      localStatus: 'auth_required',
      retryable: false,
      serverErrorCode: error.errorCode,
    };
  }

  if (error.statusCode >= 400 && error.statusCode < 500) {
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
