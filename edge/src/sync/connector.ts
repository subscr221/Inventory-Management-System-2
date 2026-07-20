import type {
  AbstractPowerSyncDatabase,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
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
]);

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

  if (status === 401 || status === 403) {
    return withErrorCode(
      { action: 'halt', localStatus: 'auth_required', retryable: false },
      errorCode,
    );
  }

  if ((errorCode && PERMANENT_ERROR_CODES.has(errorCode)) || (status >= 400 && status < 500)) {
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
      if (op.table !== 'edge_outbox') continue;
      const body = { event_id: op.id, ...op.opData };
      const response = await fetch(`${this.apiBaseUrl}/api/v1/edge/events`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const errorBody = (await response.json().catch(() => ({}))) as ErrorEnvelope;
        const classification = classifyServerUploadFailure(response.status, errorBody);
        if (classification.action === 'retry')
          throw new Error(classification.serverErrorCode ?? 'retryable upload failure');
        await recordUploadOutcome(database, op.id, classification, errorBody);
      }
    }
    await transaction.complete();
  }
}
