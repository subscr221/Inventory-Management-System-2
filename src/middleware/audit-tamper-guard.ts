import type { PoolClient } from 'pg';
import { getPool } from '../config/db.js';
import { logTamperAttempt } from '../read/projections/audit_log.js';

export interface TamperContext {
  user_id: string | null;
  role: string | null;
  location_id: string | null;
  endpoint: string | null;
  method: string | null;
  error_code: string;
  details?: Record<string, unknown>;
}

/** Writes a tamper-attempt record using a caller-supplied (e.g. in-transaction) connection. */
export async function handleTamperAttempt(client: PoolClient, context: TamperContext): Promise<void> {
  const payload: Parameters<typeof logTamperAttempt>[1] = {
    user_id: context.user_id,
    role: context.role,
    location_id: context.location_id,
    endpoint: context.endpoint,
    method: context.method,
    error_code: context.error_code,
  };
  if (context.details !== undefined) {
    payload.details = context.details;
  }
  await logTamperAttempt(client, payload);
}

/**
 * Records a tamper attempt on its OWN fresh connection. Use this when the failure was raised inside
 * a transaction that has since been rolled back (the aborted client can no longer issue writes), or
 * from any context that does not already hold a usable connection.
 */
export async function recordTamperAttempt(context: TamperContext): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await handleTamperAttempt(client, context);
  } finally {
    client.release();
  }
}

/**
 * True when an error is the DB tamper-protection trigger firing (RAISE EXCEPTION
 * 'AUDIT_LOG_TAMPER_ATTEMPT: ...' on an UPDATE/DELETE/TRUNCATE against the audit tables). Detected
 * by the raised message so a trigger rejection can be recorded rather than surfacing as a bare 500.
 */
export function isAuditTamperError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string' &&
    (err as { message: string }).message.includes('AUDIT_LOG_TAMPER_ATTEMPT')
  );
}
