import type { PoolClient } from 'pg';
import { logTamperAttempt } from '../read/projections/audit_log.js';

export async function handleTamperAttempt(
  client: PoolClient,
  context: {
    user_id: string | null;
    role: string | null;
    location_id: string | null;
    endpoint: string | null;
    method: string | null;
    error_code: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
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