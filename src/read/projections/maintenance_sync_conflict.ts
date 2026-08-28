import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 7.8 accessors for the maintenance sync-conflict queue (FR-M-17, AC 2).
 *
 * insertSyncConflict is called by applySyncConflictRaised; setSyncConflictResolved by
 * applySyncConflictResolved under the conflict row's FOR UPDATE lock, guarded by status = 'open'
 * so a lost race is a 0-row update the applier rejects (409 SYNC_CONFLICT_ALREADY_RESOLVED), never
 * a silent no-op. getSyncConflictByEventId is the grain read (one row per conflicting event).
 */
export type SyncConflictReason = 'version_conflict' | 'safety_fault_rejected';
export type SyncConflictResolutionCode = 'discarded' | 'reapplied_centrally';

export interface SyncConflictRow {
  conflict_id: string;
  stream_id: string;
  conflicting_event_id: string;
  conflicting_event_type: string;
  idempotency_key: string;
  device_id: string;
  captured_by: string;
  location_id: string | null;
  reason: SyncConflictReason;
  expected_version: number | null;
  head_version: number | null;
  rejection_code: string | null;
  conflicting_payload: Record<string, unknown>;
  occurred_at: string;
  raised_at: string;
  status: 'open' | 'resolved';
  resolution_code: SyncConflictResolutionCode | null;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SYNC_CONFLICT_STATUSES: ReadonlySet<string> = new Set(['open', 'resolved']);

const CONFLICT_COLUMNS = `conflict_id, stream_id, conflicting_event_id, conflicting_event_type,
    idempotency_key, device_id, captured_by, location_id, reason, expected_version, head_version,
    rejection_code, conflicting_payload, occurred_at, raised_at, status, resolution_code,
    resolution_note, resolved_by, resolved_at, created_at, updated_at`;

export interface InsertSyncConflictRow {
  conflict_id: string;
  stream_id: string;
  conflicting_event_id: string;
  conflicting_event_type: string;
  idempotency_key: string;
  device_id: string;
  captured_by: string;
  location_id: string | null;
  reason: SyncConflictReason;
  expected_version: number | null;
  head_version: number | null;
  rejection_code: string | null;
  conflicting_payload: Record<string, unknown>;
  occurred_at: string;
  raised_at: string;
}

export async function insertSyncConflict(
  row: InsertSyncConflictRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO maintenance_sync_conflict (
      conflict_id, stream_id, conflicting_event_id, conflicting_event_type, idempotency_key,
      device_id, captured_by, location_id, reason, expected_version, head_version, rejection_code,
      conflicting_payload, occurred_at, raised_at, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,'open')`,
    [
      row.conflict_id,
      row.stream_id,
      row.conflicting_event_id,
      row.conflicting_event_type,
      row.idempotency_key,
      row.device_id,
      row.captured_by,
      row.location_id,
      row.reason,
      row.expected_version,
      row.head_version,
      row.rejection_code,
      JSON.stringify(row.conflicting_payload),
      row.occurred_at,
      row.raised_at,
    ],
  );
}

export async function getSyncConflictById(
  conflictId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<SyncConflictRow | null> {
  if (!UUID_REGEX.test(conflictId)) return null;
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await runner(client).query(
    `SELECT ${CONFLICT_COLUMNS} FROM maintenance_sync_conflict WHERE conflict_id = $1${lockClause}`,
    [conflictId],
  );
  return (result.rows[0] as SyncConflictRow) ?? null;
}

export async function getSyncConflictByEventId(
  conflictingEventId: string,
  client?: PoolClient,
): Promise<SyncConflictRow | null> {
  if (!UUID_REGEX.test(conflictingEventId)) return null;
  const result = await runner(client).query(
    `SELECT ${CONFLICT_COLUMNS} FROM maintenance_sync_conflict WHERE conflicting_event_id = $1`,
    [conflictingEventId],
  );
  return (result.rows[0] as SyncConflictRow) ?? null;
}

export async function setSyncConflictResolved(
  conflictId: string,
  resolutionCode: SyncConflictResolutionCode,
  resolutionNote: string | null,
  resolvedBy: string,
  resolvedAt: string,
  client: PoolClient,
): Promise<number> {
  const result = await client.query(
    `UPDATE maintenance_sync_conflict
        SET status = 'resolved',
            resolution_code = $2,
            resolution_note = $3,
            resolved_by = $4,
            resolved_at = $5,
            updated_at = now()
      WHERE conflict_id = $1 AND status = 'open'`,
    [conflictId, resolutionCode, resolutionNote, resolvedBy, resolvedAt],
  );
  return result.rowCount ?? 0;
}

export interface ListSyncConflictsParams {
  status?: 'open' | 'resolved' | undefined;
  location_id?: string | undefined;
  stream_id?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listSyncConflicts(
  params: ListSyncConflictsParams,
  client?: PoolClient,
): Promise<SyncConflictRow[]> {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;
  if (params.status) {
    if (!SYNC_CONFLICT_STATUSES.has(params.status)) return [];
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.location_id) {
    if (!UUID_REGEX.test(params.location_id)) return [];
    conditions.push(`location_id = $${idx++}`);
    values.push(params.location_id);
  }
  if (params.stream_id) {
    if (!UUID_REGEX.test(params.stream_id)) return [];
    conditions.push(`stream_id = $${idx++}`);
    values.push(params.stream_id);
  }
  const limit = Number.isFinite(params.limit ?? 100)
    ? Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 500)
    : 100;
  const offset = Number.isFinite(params.offset ?? 0)
    ? Math.max(Math.trunc(params.offset ?? 0), 0)
    : 0;
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await runner(client).query(
    `SELECT ${CONFLICT_COLUMNS} FROM maintenance_sync_conflict ${where}
      ORDER BY raised_at DESC, conflict_id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as SyncConflictRow[];
}
