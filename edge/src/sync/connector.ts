import {
  UpdateType,
  type AbstractPowerSyncDatabase,
  type PowerSyncBackendConnector,
  type PowerSyncCredentials,
} from '@powersync/web';
import type { EdgeLocalStatus } from '../local-db/schema';

export interface UploadFailureClassification {
  action: 'complete' | 'retry' | 'halt';
  localStatus: EdgeLocalStatus;
  retryable: boolean;
  serverErrorCode?: string;
  existingEventId?: string;
}

interface ErrorEnvelope {
  error_code?: string;
  details?: Record<string, unknown>;
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
]);

const TRANSIENT_STATUS_CODES = new Set([408, 425, 429]);
const SETTLED_STATUSES = new Set<EdgeLocalStatus>(['synced', 'needs_attention']);

interface OutboxStatusRow {
  local_status: EdgeLocalStatus;
}

function withErrorCode(
  classification: Omit<UploadFailureClassification, 'serverErrorCode'>,
  errorCode: string | undefined,
): UploadFailureClassification {
  return errorCode ? { ...classification, serverErrorCode: errorCode } : classification;
}

export function classifyServerUploadFailure(
  status: number,
  body: ErrorEnvelope,
): UploadFailureClassification {
  const errorCode = body.error_code;
  if (status === 409 && errorCode === 'DUPLICATE_EVENT') {
    const existing = body.details?.['existing_event_id'];
    const classification = withErrorCode(
      {
        action: 'complete',
        localStatus: 'synced',
        retryable: false,
      },
      errorCode,
    );
    if (typeof existing === 'string') classification.existingEventId = existing;
    return classification;
  }

  // A business-rule rejection carrying a known permanent error_code settles the single event as
  // needs_attention even when it surfaces as 403 (e.g. FUNCTION_ACCESS_DENIED / LOCATION_ACCESS_DENIED
  // / LOT_REQUIRED from the central write path). It must NOT halt the whole outbox as an auth failure
  // the way a bare 401/403 does; checked before the 401/403 halt so those codes are reachable at 403
  // (Story 2.3 pass-3). A genuine authn failure (401 UNAUTHORIZED, or a 403 with no permanent
  // business code) is not in the set and still falls through to halt.
  if (errorCode && PERMANENT_ERROR_CODES.has(errorCode)) {
    return withErrorCode(
      { action: 'complete', localStatus: 'needs_attention', retryable: false },
      errorCode,
    );
  }

  if (status === 401 || status === 403) {
    return withErrorCode(
      { action: 'halt', localStatus: 'auth_required', retryable: false },
      errorCode,
    );
  }

  if (TRANSIENT_STATUS_CODES.has(status)) {
    return withErrorCode(
      { action: 'retry', localStatus: 'pending_sync', retryable: true },
      errorCode,
    );
  }

  if (status >= 400 && status < 500) {
    return withErrorCode(
      { action: 'complete', localStatus: 'needs_attention', retryable: false },
      errorCode,
    );
  }

  return withErrorCode(
    { action: 'retry', localStatus: 'pending_sync', retryable: true },
    errorCode,
  );
}

async function recordUploadOutcome(
  database: AbstractPowerSyncDatabase,
  eventId: string,
  classification: UploadFailureClassification,
  details: ErrorEnvelope,
): Promise<void> {
  await database.execute(
    `UPDATE edge_outbox
     SET local_status = ?, server_error_code = ?, server_error_details = ?, updated_at = ?
     WHERE id = ?`,
    [
      classification.localStatus,
      classification.serverErrorCode ?? null,
      JSON.stringify(details.details ?? {}),
      new Date().toISOString(),
      eventId,
    ],
  );
}

async function markOutboxSynced(
  database: AbstractPowerSyncDatabase,
  eventId: string,
  existingEventId?: string,
): Promise<void> {
  await database.execute(
    `UPDATE edge_outbox
     SET local_status = ?, server_error_code = ?, server_error_details = ?, updated_at = ?
     WHERE id = ?`,
    [
      'synced',
      null,
      existingEventId ? JSON.stringify({ existing_event_id: existingEventId }) : null,
      new Date().toISOString(),
      eventId,
    ],
  );
}

async function currentLocalStatus(
  database: AbstractPowerSyncDatabase,
  eventId: string,
): Promise<EdgeLocalStatus | null> {
  const row = await database.getOptional<OutboxStatusRow>(
    `SELECT local_status FROM edge_outbox WHERE id = ?`,
    [eventId],
  );
  return row ? row.local_status : null;
}

export class EdgePowerSyncConnector implements PowerSyncBackendConnector {
  constructor(private readonly apiBaseUrl = '') {}

  async fetchCredentials(): Promise<PowerSyncCredentials> {
    const response = await fetch(`${this.apiBaseUrl}/api/v1/edge/powersync-credentials`, {
      credentials: 'include',
    });
    if (!response.ok) throw new Error('Unable to fetch PowerSync credentials');
    const body = (await response.json()) as { endpoint: string; token: string };
    return { endpoint: body.endpoint, token: body.token };
  }

  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const transaction = await database.getNextCrudTransaction();
    if (!transaction) return;

    for (const op of transaction.crud) {
      if (op.table !== 'edge_outbox' || op.op !== UpdateType.PUT) continue;

      const localStatus = await currentLocalStatus(database, op.id);
      if (localStatus === 'auth_required') return;
      if (localStatus && SETTLED_STATUSES.has(localStatus)) continue;

      const response = await fetch(`${this.apiBaseUrl}/api/v1/edge/events`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...op.opData, event_id: op.id }),
      });
      if (response.ok) {
        await markOutboxSynced(database, op.id);
        continue;
      }

      const errorBody = (await response.json().catch(() => ({}))) as ErrorEnvelope;
      const classification = classifyServerUploadFailure(response.status, errorBody);
      if (classification.action === 'retry') {
        throw new Error(classification.serverErrorCode ?? 'retryable upload failure');
      }

      await recordUploadOutcome(database, op.id, classification, errorBody);
      if (classification.action === 'halt') return;
    }
    await transaction.complete();
  }
}
