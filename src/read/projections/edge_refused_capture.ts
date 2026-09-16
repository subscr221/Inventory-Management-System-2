import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 1.13 accessors for the edge refused-captures queue (AD-18, AC 2 and 4).
 *
 * insertRefusedCapture is called by the record applier; setRefusedCaptureResolved by the resolve
 * applier under the row's FOR UPDATE lock, guarded by status = 'open' so a lost race is a 0-row
 * update the applier rejects, never a silent no-op. listRefusedCaptures narrows by site and module
 * in SQL, so paging never hides rows the caller may see behind rows they may not.
 */
export type RefusedCaptureStatus = 'open' | 'resolved';
export type LocationSource = 'authorized' | 'declared' | 'none';

export interface RefusedCaptureRow {
  refusal_id: string;
  event_id: string;
  stream_type: string;
  stream_id: string | null;
  event_type: string | null;
  idempotency_key: string | null;
  device_id: string | null;
  captured_by: string;
  captured_role: string | null;
  location_id: string | null;
  location_source: LocationSource;
  http_status: number;
  error_code: string;
  error_details: Record<string, unknown> | null;
  envelope: Record<string, unknown> | null;
  envelope_truncated: boolean;
  trace_id: string;
  occurred_at: string | null;
  refused_at: string;
  status: RefusedCaptureStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
}

export type InsertRefusedCaptureRow = Omit<
  RefusedCaptureRow,
  'status' | 'resolved_by' | 'resolved_at' | 'resolution_note' | 'created_at' | 'updated_at'
>;

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REFUSED_CAPTURE_STATUSES: ReadonlySet<string> = new Set(['open', 'resolved']);

const COLUMNS = `refusal_id, event_id, stream_type, stream_id, event_type, idempotency_key, device_id,
    captured_by, captured_role, location_id, location_source, http_status, error_code,
    error_details, envelope, envelope_truncated, trace_id, occurred_at, refused_at, status,
    resolved_by, resolved_at, resolution_note, created_at, updated_at`;

export async function insertRefusedCapture(
  row: InsertRefusedCaptureRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO edge_refused_capture (
      refusal_id, event_id, stream_type, stream_id, event_type, idempotency_key, device_id,
      captured_by, captured_role, location_id, location_source, http_status, error_code,
      error_details, envelope, envelope_truncated, trace_id, occurred_at, refused_at, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18,$19,'open')`,
    [
      row.refusal_id,
      row.event_id,
      row.stream_type,
      row.stream_id,
      row.event_type,
      row.idempotency_key,
      row.device_id,
      row.captured_by,
      row.captured_role,
      row.location_id,
      row.location_source,
      row.http_status,
      row.error_code,
      row.error_details === null ? null : JSON.stringify(row.error_details),
      row.envelope === null ? null : JSON.stringify(row.envelope),
      row.envelope_truncated,
      row.trace_id,
      row.occurred_at,
      row.refused_at,
    ],
  );
}

export async function getRefusedCaptureById(
  refusalId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<RefusedCaptureRow | null> {
  if (!UUID_REGEX.test(refusalId)) return null;
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM edge_refused_capture WHERE refusal_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [refusalId],
  );
  return (result.rows[0] as RefusedCaptureRow) ?? null;
}

export async function getRefusedCaptureByEventId(
  eventId: string,
  client?: PoolClient,
): Promise<RefusedCaptureRow | null> {
  if (!UUID_REGEX.test(eventId)) return null;
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM edge_refused_capture WHERE event_id = $1`,
    [eventId],
  );
  return (result.rows[0] as RefusedCaptureRow) ?? null;
}

export async function setRefusedCaptureResolved(
  refusalId: string,
  note: string,
  resolvedBy: string,
  resolvedAt: string,
  client: PoolClient,
): Promise<number> {
  const result = await client.query(
    `UPDATE edge_refused_capture
        SET status = 'resolved', resolution_note = $2, resolved_by = $3, resolved_at = $4,
            updated_at = now()
      WHERE refusal_id = $1 AND status = 'open'`,
    [refusalId, note, resolvedBy, resolvedAt],
  );
  return result.rowCount ?? 0;
}

/** One (module, location) read grant; '*' stands for any module or any location. */
export interface RefusedCaptureScope {
  stream_type: string;
  location_id: string;
}

export interface ListRefusedCapturesParams {
  status: RefusedCaptureStatus;
  /** The caller's grants. A '*' location also matches rows with no location. */
  scopes: RefusedCaptureScope[];
  location_id?: string | undefined;
  stream_type?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listRefusedCaptures(
  params: ListRefusedCapturesParams,
  client?: PoolClient,
): Promise<RefusedCaptureRow[]> {
  const values: unknown[] = [params.status];
  const conditions = ['status = $1'];
  if (params.location_id !== undefined) {
    values.push(params.location_id);
    conditions.push(`location_id = $${values.length}`);
  }
  if (params.stream_type !== undefined) {
    values.push(params.stream_type);
    conditions.push(`stream_type = $${values.length}`);
  }
  // A row is visible when one (module, location) grant matches it: narrowed in SQL, before paging.
  values.push(JSON.stringify(params.scopes));
  conditions.push(`EXISTS (
    SELECT 1 FROM jsonb_to_recordset($${values.length}::jsonb) AS s(stream_type text, location_id text)
     WHERE (s.stream_type = '*' OR s.stream_type = edge_refused_capture.stream_type)
       AND (s.location_id = '*' OR s.location_id = edge_refused_capture.location_id::text))`);
  const limit = Math.min(Math.max(Math.trunc(params.limit ?? 50), 1), 500);
  const offset = Math.max(Math.trunc(params.offset ?? 0), 0);
  values.push(limit, offset);
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM edge_refused_capture WHERE ${conditions.join(' AND ')}
      ORDER BY refused_at DESC, refusal_id ASC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return result.rows as RefusedCaptureRow[];
}
