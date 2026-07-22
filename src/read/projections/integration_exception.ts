import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Integration sync-state heartbeat and exception-queue accessor (Story 2.9). erp_sync_state carries
 * one heartbeat row per projection so freshness (AC3) is observable even at zero rows; integration_
 * exception is the append-plus-resolve queue for malformed source records (AC5) and stale-sync
 * alerts (AC3). raiseException dedupes on the open partial-unique grain
 * (source_system, record_type, source_record_ref, error_code) WHERE status = 'open', so a repeated
 * malformed record or a repeated stale read refreshes the single open row instead of stacking
 * duplicates - the Story 2.7/2.8 "one open per grain" pattern.
 */

export type SyncProjectionName = 'purchase_orders' | 'sales_orders';
export type SyncStatus = 'never_synced' | 'success' | 'failed';
export type ExceptionRecordType = 'purchase_order' | 'sales_order' | 'sync_batch';
export type ExceptionStatus = 'open' | 'resolved';

export interface SyncStateRow {
  projection_name: string;
  status: SyncStatus;
  last_attempted_at: string | null;
  last_successful_at: string | null;
  last_error: string | null;
}

export interface IntegrationExceptionRow {
  exception_id: string;
  source_system: string;
  record_type: string;
  source_record_ref: string | null;
  error_code: string;
  reason: string;
  details: Record<string, unknown> | null;
  status: string;
  raised_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function ts(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

// ---------------------------------------------------------------------------
// erp_sync_state heartbeat
// ---------------------------------------------------------------------------

export async function getSyncState(projectionName: SyncProjectionName, client?: PoolClient): Promise<SyncStateRow | null> {
  const result = await runner(client).query(
    `SELECT projection_name, status, last_attempted_at, last_successful_at, last_error
     FROM erp_sync_state WHERE projection_name = $1`,
    [projectionName],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0]!;
  return {
    projection_name: row['projection_name'] as string,
    status: row['status'] as SyncStatus,
    last_attempted_at: ts(row['last_attempted_at']),
    last_successful_at: ts(row['last_successful_at']),
    last_error: (row['last_error'] as string | null) ?? null,
  };
}

/** Stamps the attempt clock before a sync cycle. Creates a never_synced row on first sight. */
export async function markSyncAttempt(projectionName: SyncProjectionName, client?: PoolClient): Promise<void> {
  await runner(client).query(
    `INSERT INTO erp_sync_state (projection_name, status, last_attempted_at)
     VALUES ($1, 'never_synced', now())
     ON CONFLICT (projection_name) DO UPDATE SET last_attempted_at = now(), updated_at = now()`,
    [projectionName],
  );
}

/** Marks a projection successfully synced within threshold; clears last_error. */
export async function markSyncSuccess(projectionName: SyncProjectionName, client?: PoolClient): Promise<void> {
  await runner(client).query(
    `INSERT INTO erp_sync_state (projection_name, status, last_attempted_at, last_successful_at, last_error)
     VALUES ($1, 'success', now(), now(), NULL)
     ON CONFLICT (projection_name) DO UPDATE SET
       status = 'success', last_successful_at = now(), last_error = NULL, updated_at = now()`,
    [projectionName],
  );
}

/** Marks a projection's sync cycle failed, recording the error for the heartbeat. */
export async function markSyncFailure(projectionName: SyncProjectionName, lastError: string, client?: PoolClient): Promise<void> {
  await runner(client).query(
    `INSERT INTO erp_sync_state (projection_name, status, last_attempted_at, last_error)
     VALUES ($1, 'failed', now(), $2)
     ON CONFLICT (projection_name) DO UPDATE SET
       status = 'failed', last_error = EXCLUDED.last_error, updated_at = now()`,
    [projectionName, lastError],
  );
}

export interface FreshnessResult {
  stale: boolean;
  last_synced_at_age_seconds: number | null;
}

/**
 * Computes projection freshness ENTIRELY in SQL (now() - last_successful_at) against the configured
 * threshold - never against the JS wall clock (the recurring DATE/clock-source defect class). A
 * never_synced or missing heartbeat (including an empty projection) is stale with a null age; the
 * boundary is strict (`>`), so exactly-at-threshold resolves to not-stale.
 */
export async function getFreshness(projectionName: SyncProjectionName, freshnessMs: number, client?: PoolClient): Promise<FreshnessResult> {
  const result = await runner(client).query(
    `SELECT
       CASE WHEN last_successful_at IS NULL THEN NULL
            ELSE EXTRACT(EPOCH FROM (now() - last_successful_at)) END AS age_seconds,
       CASE WHEN last_successful_at IS NULL THEN true
            ELSE (now() - last_successful_at) > make_interval(secs => $2::double precision / 1000.0) END AS stale
     FROM erp_sync_state WHERE projection_name = $1`,
    [projectionName, freshnessMs],
  );
  if (result.rows.length === 0) {
    return { stale: true, last_synced_at_age_seconds: null };
  }
  const row = result.rows[0]!;
  const age = row['age_seconds'];
  return {
    stale: row['stale'] === true,
    last_synced_at_age_seconds: age === null || age === undefined ? null : Number(age),
  };
}

// ---------------------------------------------------------------------------
// integration_exception queue
// ---------------------------------------------------------------------------

export interface RaiseExceptionInput {
  record_type: ExceptionRecordType;
  source_record_ref?: string | null;
  error_code: string;
  reason: string;
  details?: unknown;
  source_system?: string;
}

/**
 * Raises (or refreshes) an integration exception. Dedupes on the open grain: a repeated malformed
 * record or repeated stale-sync failure refreshes reason/details/raised_at on the single open row
 * rather than stacking duplicates. Returns true only when a NEW open row was inserted (via the
 * xmax = 0 discriminator), so a caller can emit a one-time alert notification without re-notifying
 * while an open exception already exists.
 */
export async function raiseException(input: RaiseExceptionInput, client?: PoolClient): Promise<boolean> {
  const result = await runner(client).query(
    `INSERT INTO integration_exception (source_system, record_type, source_record_ref, error_code, reason, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (source_system, record_type, source_record_ref, error_code) WHERE status = 'open'
     DO UPDATE SET reason = EXCLUDED.reason, details = EXCLUDED.details, raised_at = now(), updated_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [
      input.source_system ?? 'ERP',
      input.record_type,
      input.source_record_ref ?? null,
      input.error_code,
      input.reason,
      input.details === undefined ? null : JSON.stringify(input.details),
    ],
  );
  return result.rows[0]?.['inserted'] === true;
}

export interface ExceptionFilters {
  status?: ExceptionStatus | null;
  record_type?: ExceptionRecordType | null;
  source_record_ref?: string | null;
  error_code?: string | null;
}

export async function listExceptions(filters: ExceptionFilters = {}, client?: PoolClient): Promise<IntegrationExceptionRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (filters.status) {
    conditions.push(`status = $${i++}`);
    params.push(filters.status);
  }
  if (filters.record_type) {
    conditions.push(`record_type = $${i++}`);
    params.push(filters.record_type);
  }
  if (filters.source_record_ref) {
    conditions.push(`source_record_ref = $${i++}`);
    params.push(filters.source_record_ref);
  }
  if (filters.error_code) {
    conditions.push(`error_code = $${i++}`);
    params.push(filters.error_code);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await runner(client).query(
    `SELECT exception_id, source_system, record_type, source_record_ref, error_code, reason, details, status, raised_at
     FROM integration_exception ${where} ORDER BY raised_at DESC`,
    params,
  );
  return result.rows.map((row) => ({
    exception_id: row['exception_id'] as string,
    source_system: row['source_system'] as string,
    record_type: row['record_type'] as string,
    source_record_ref: (row['source_record_ref'] as string | null) ?? null,
    error_code: row['error_code'] as string,
    reason: row['reason'] as string,
    details: (row['details'] as Record<string, unknown> | null) ?? null,
    status: row['status'] as string,
    raised_at: ts(row['raised_at']) ?? '',
  }));
}

/** Resolves a single exception by id. Returns true when a row transitioned to resolved. */
export async function resolveException(exceptionId: string, client?: PoolClient): Promise<boolean> {
  const result = await runner(client).query(
    `UPDATE integration_exception SET status = 'resolved', updated_at = now()
     WHERE exception_id = $1 AND status = 'open'`,
    [exceptionId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Resolves any open exception matching a dedupe grain - used when a fresh in-threshold sync clears a
 * stale-sync alert (AC3), or when a re-synced record is no longer malformed. `error_code` is
 * optional: omit it to clear EVERY open exception for the (source_system, record_type,
 * source_record_ref) record regardless of which error code was raised, so a record that syncs
 * cleanly after any prior failure drains its queue entry.
 */
export async function resolveOpenExceptionsByGrain(
  grain: { record_type: ExceptionRecordType; source_record_ref?: string | null; error_code?: string; source_system?: string },
  client?: PoolClient,
): Promise<number> {
  const conditions = [`status = 'open'`, `source_system = $1`, `record_type = $2`, `source_record_ref IS NOT DISTINCT FROM $3`];
  const params: unknown[] = [grain.source_system ?? 'ERP', grain.record_type, grain.source_record_ref ?? null];
  if (grain.error_code !== undefined) {
    conditions.push(`error_code = $${params.length + 1}`);
    params.push(grain.error_code);
  }
  const result = await runner(client).query(
    `UPDATE integration_exception SET status = 'resolved', updated_at = now() WHERE ${conditions.join(' AND ')}`,
    params,
  );
  return result.rowCount ?? 0;
}
