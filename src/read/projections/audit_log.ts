import type { PoolClient } from 'pg';

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

export async function logTamperAttempt(client: PoolClient, payload: TamperAttemptPayload): Promise<void> {
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