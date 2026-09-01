import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

export interface AuditEntryPayload {
  trace_id: string;
  user_id: string;
  role: string;
  location_id: string;
  endpoint: string;
  method: string;
  event_id: string | null;
  http_status: number;
  error_code: string | null;
  details?: Record<string, unknown>;
}

export interface TamperAttemptPayload {
  user_id: string | null;
  role: string | null;
  location_id: string | null;
  endpoint: string | null;
  method: string | null;
  error_code: string;
  details?: Record<string, unknown>;
}

export async function logAuditEntry(client: PoolClient, payload: AuditEntryPayload): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (trace_id, user_id, role, location_id, endpoint, method, event_id, http_status, error_code, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      payload.trace_id,
      payload.user_id,
      payload.role,
      payload.location_id,
      payload.endpoint,
      payload.method,
      payload.event_id,
      payload.http_status,
      payload.error_code,
      payload.details ? JSON.stringify(payload.details) : null,
    ],
  );
}

/**
 * Story 6.4: the connect/log/release wrapper for a rejection that never reaches persistEvent and
 * therefore has no transaction of its own to ride (the Story 6.1 AC7 release-override precedent,
 * which wrote this boilerplate inline). FR-AC-13 requires the refusal itself to be in the edit log,
 * not merely the writes that succeeded.
 *
 * Never throws: an edit-log failure must not convert a clean business rejection into a 500, and the
 * caller is on its way to throwing an AppError that carries the real reason.
 */
export async function logRejectionAudit(payload: AuditEntryPayload): Promise<void> {
  let client: PoolClient | null = null;
  try {
    client = await getPool().connect();
    await logAuditEntry(client, payload);
  } catch {
    // Deliberately swallowed - see the contract above.
  } finally {
    client?.release();
  }
}

export async function logTamperAttempt(
  client: PoolClient,
  payload: TamperAttemptPayload,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log_tamper_attempt_log (user_id, role, location_id, endpoint, method, error_code, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      payload.user_id,
      payload.role,
      payload.location_id,
      payload.endpoint,
      payload.method,
      payload.error_code,
      payload.details ? JSON.stringify(payload.details) : null,
    ],
  );
}
