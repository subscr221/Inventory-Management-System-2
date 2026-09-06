import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 8.4 accessor for the qc_retention_sample projection (FR-Q-08, AC 4 and AC 5). One sample
 * per lot; its presence is what lets a lot be released (Binding Scope Decision 6).
 *
 * There are exactly two update paths. setQcRetentionSampleExpiry re-stamps the retention window
 * when the lot is released, so the sample and its batch release record share ONE clock (AC1 ties
 * retention to release). markQcRetentionSampleDisposalPending is guarded by
 * `WHERE status = 'retained'`, the same shape as setQcNcrOutcome's `WHERE outcome IS NULL`, so it
 * can never double-transition a row; the caller refuses a zero-row result rather than reporting a
 * success it did not perform. 'disposed' is schema'd but unreachable in this story (physical
 * disposal is Phase 2 / Epic 16).
 *
 * DATE columns are read back as text so a calendar date never round-trips through a JS Date.
 */

export const QC_RETENTION_SAMPLE_STATUSES = ['retained', 'disposal_pending', 'disposed'] as const;
export type QcRetentionSampleStatus = (typeof QC_RETENTION_SAMPLE_STATUSES)[number];

export interface QcRetentionSampleRow {
  retention_sample_id: string;
  lot_id: string;
  task_id: string;
  quantity: string;
  uom: string;
  location_id: string;
  status: QcRetentionSampleStatus;
  logged_by: string;
  logged_at: string;
  expires_on: string;
  disposal_event_id: string | null;
  disposed_at: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export type InsertQcRetentionSampleRow = Pick<
  QcRetentionSampleRow,
  | 'retention_sample_id'
  | 'lot_id'
  | 'task_id'
  | 'quantity'
  | 'uom'
  | 'location_id'
  | 'logged_by'
  | 'logged_at'
  | 'expires_on'
  | 'source_event_id'
>;

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SAMPLE_COLUMNS = `retention_sample_id, lot_id, task_id, quantity::text AS quantity, uom,
    location_id, status, logged_by, logged_at, expires_on::text AS expires_on, disposal_event_id,
    disposed_at, source_event_id, created_at, updated_at`;

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const toIsoOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : toIso(v);

function mapRow(row: Record<string, unknown>): QcRetentionSampleRow {
  return {
    retention_sample_id: row['retention_sample_id'] as string,
    lot_id: row['lot_id'] as string,
    task_id: row['task_id'] as string,
    quantity: String(row['quantity']),
    uom: row['uom'] as string,
    location_id: row['location_id'] as string,
    status: row['status'] as QcRetentionSampleStatus,
    logged_by: row['logged_by'] as string,
    logged_at: toIso(row['logged_at']),
    expires_on: String(row['expires_on']),
    disposal_event_id: (row['disposal_event_id'] as string | null) ?? null,
    disposed_at: toIsoOrNull(row['disposed_at']),
    source_event_id: row['source_event_id'] as string,
    created_at: toIso(row['created_at']),
    updated_at: toIso(row['updated_at']),
  };
}

export async function insertQcRetentionSample(
  row: InsertQcRetentionSampleRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO qc_retention_sample (retention_sample_id, lot_id, task_id, quantity, uom,
       location_id, status, logged_by, logged_at, expires_on, source_event_id)
     VALUES ($1, $2, $3, $4::numeric, $5, $6, 'retained', $7, $8, $9::date, $10)`,
    [
      row.retention_sample_id,
      row.lot_id,
      row.task_id,
      row.quantity,
      row.uom,
      row.location_id,
      row.logged_by,
      row.logged_at,
      row.expires_on,
      row.source_event_id,
    ],
  );
}

export async function getQcRetentionSampleById(
  retentionSampleId: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<QcRetentionSampleRow | null> {
  if (!UUID_REGEX.test(retentionSampleId)) return null;
  const result = await runner(client).query(
    `SELECT ${SAMPLE_COLUMNS} FROM qc_retention_sample WHERE retention_sample_id = $1${
      forUpdate ? ' FOR UPDATE' : ''
    }`,
    [retentionSampleId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

export async function getQcRetentionSampleByLotId(
  lotId: string,
  client?: PoolClient,
): Promise<QcRetentionSampleRow | null> {
  if (!UUID_REGEX.test(lotId)) return null;
  const result = await runner(client).query(
    `SELECT ${SAMPLE_COLUMNS} FROM qc_retention_sample WHERE lot_id = $1`,
    [lotId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

/**
 * AC 5: the rows the expiry sweep must alert on - still retained and inside the alert lead window.
 * Locked FOR UPDATE SKIP LOCKED so two overlapping sweeps (or a second app instance) never contend
 * on the same row; the `status = 'retained'` guard on the UPDATE below is the real idempotency
 * backstop.
 */
export async function listQcRetentionSamplesDueForDisposal(
  leadDays: number,
  client: PoolClient,
  limit = 500,
): Promise<QcRetentionSampleRow[]> {
  // expires_on is minted as an IST calendar date (toIstCalendarDate), so the window must be
  // measured against the IST date too. CURRENT_DATE resolves in the DB session timezone - UTC in
  // every container here - which lags IST by 5.5 hours and produced a deterministic off-by-one at
  // the exact AC5 boundary for every sweep firing between 18:30 and 24:00 UTC.
  const result = await client.query(
    `SELECT ${SAMPLE_COLUMNS} FROM qc_retention_sample
      WHERE status = 'retained'
        AND expires_on <= ((now() AT TIME ZONE 'Asia/Kolkata')::date + $1::int)
      ORDER BY expires_on, retention_sample_id
      LIMIT $2
      FOR UPDATE SKIP LOCKED`,
    [leadDays, limit],
  );
  return result.rows.map((row) => mapRow(row as Record<string, unknown>));
}

/**
 * Re-stamps the retention window when the lot is released. AC1 anchors retention to the release
 * ("when it is released ... retained for a default 7 years"), so qc_batch_release is the authority
 * and the sample follows it - otherwise the sample, whose own window ran from logged_at, is swept
 * for disposal before the certificate it evidences leaves retention.
 */
export async function setQcRetentionSampleExpiry(
  retentionSampleId: string,
  expiresOn: string,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE qc_retention_sample
        SET expires_on = $2::date,
            updated_at = now()
      WHERE retention_sample_id = $1 AND status = 'retained'`,
    [retentionSampleId, expiresOn],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * AC 5: flips 'retained' -> 'disposal_pending' and stamps the recorded disposal event. disposed_at
 * stays null - nothing has been physically disposed of yet (Phase 2 / Epic 16), and
 * chk_qc_retention_sample_disposal_pairing states that biconditional in the database. Returns
 * false when the row was already transitioned (zero rows updated); the caller REFUSES that with
 * 409 RETENTION_SAMPLE_NOT_RETAINED rather than reporting a success it did not perform, so a
 * forged direct post cannot claim a transition that never happened. The sweep never reaches it,
 * because its candidate query carries the same `status = 'retained'` predicate.
 */
export async function markQcRetentionSampleDisposalPending(
  retentionSampleId: string,
  disposalEventId: string,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE qc_retention_sample
        SET status = 'disposal_pending',
            disposal_event_id = $2,
            updated_at = now()
      WHERE retention_sample_id = $1 AND status = 'retained'`,
    [retentionSampleId, disposalEventId],
  );
  return (result.rowCount ?? 0) > 0;
}
