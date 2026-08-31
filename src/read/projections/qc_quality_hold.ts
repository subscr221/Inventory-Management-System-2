import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 8.5 accessor for the qc_quality_hold projection (FR-Q-09, AC 1 and AC 2). The governed
 * record of a hold decision (Binding Scope Decision 1): the applier that inserts a row here sets
 * lot_master.quality_hold_status = 'held' in the SAME transaction, and every enforcement site
 * keeps reading that one flag.
 *
 * releaseQcQualityHold is the ONLY update path and is guarded by `WHERE status = 'open'`: a
 * concurrent second release updates zero rows, which the caller turns into 409
 * HOLD_ALREADY_RELEASED. Release is terminal; there is no reopen.
 */

export const QC_HOLD_STATUSES = ['open', 'released'] as const;
export type QcHoldStatus = (typeof QC_HOLD_STATUSES)[number];

export interface QcQualityHoldRow {
  hold_id: string;
  lot_id: string;
  lot_number: string;
  sku: string;
  site_id: string;
  hold_reason: string;
  defect_code: string | null;
  status: QcHoldStatus;
  placed_by: string;
  placed_at: string;
  source_event_id: string;
  released_by: string | null;
  released_at: string | null;
  release_reason: string | null;
  release_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export type InsertQcQualityHoldRow = Pick<
  QcQualityHoldRow,
  | 'hold_id'
  | 'lot_id'
  | 'lot_number'
  | 'sku'
  | 'site_id'
  | 'hold_reason'
  | 'defect_code'
  | 'placed_by'
  | 'placed_at'
  | 'source_event_id'
>;

export interface QcQualityHoldReleasePatch {
  hold_id: string;
  released_by: string;
  released_at: string;
  release_reason: string;
  release_event_id: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HOLD_COLUMNS = `hold_id, lot_id, lot_number, sku, site_id, hold_reason, defect_code, status,
    placed_by, placed_at, source_event_id, released_by, released_at, release_reason,
    release_event_id, created_at, updated_at`;

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const toIsoOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : toIso(v);

function mapRow(row: Record<string, unknown>): QcQualityHoldRow {
  return {
    hold_id: row['hold_id'] as string,
    lot_id: row['lot_id'] as string,
    lot_number: row['lot_number'] as string,
    sku: row['sku'] as string,
    site_id: row['site_id'] as string,
    hold_reason: row['hold_reason'] as string,
    defect_code: (row['defect_code'] as string | null) ?? null,
    status: row['status'] as QcHoldStatus,
    placed_by: row['placed_by'] as string,
    placed_at: toIso(row['placed_at']),
    source_event_id: row['source_event_id'] as string,
    released_by: (row['released_by'] as string | null) ?? null,
    released_at: toIsoOrNull(row['released_at']),
    release_reason: (row['release_reason'] as string | null) ?? null,
    release_event_id: (row['release_event_id'] as string | null) ?? null,
    created_at: toIso(row['created_at']),
    updated_at: toIso(row['updated_at']),
  };
}

export async function insertQcQualityHold(
  row: InsertQcQualityHoldRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO qc_quality_hold (hold_id, lot_id, lot_number, sku, site_id, hold_reason,
       defect_code, status, placed_by, placed_at, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10)`,
    [
      row.hold_id,
      row.lot_id,
      row.lot_number,
      row.sku,
      row.site_id,
      row.hold_reason,
      row.defect_code,
      row.placed_by,
      row.placed_at,
      row.source_event_id,
    ],
  );
}

export async function getQcQualityHoldById(
  holdId: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<QcQualityHoldRow | null> {
  if (!UUID_REGEX.test(holdId)) return null;
  const result = await runner(client).query(
    `SELECT ${HOLD_COLUMNS} FROM qc_quality_hold WHERE hold_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [holdId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

/** The one open hold for a lot, if any (uq_qc_quality_hold_open makes "the" a database fact). */
export async function getOpenQcQualityHoldByLotId(
  lotId: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<QcQualityHoldRow | null> {
  if (!UUID_REGEX.test(lotId)) return null;
  const result = await runner(client).query(
    `SELECT ${HOLD_COLUMNS} FROM qc_quality_hold WHERE lot_id = $1 AND status = 'open'${forUpdate ? ' FOR UPDATE' : ''}`,
    [lotId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

/** True when the lot carries any OTHER open hold beside the named one (the release-clear guard). */
export async function otherOpenQcQualityHoldExists(
  lotId: string,
  excludingHoldId: string,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM qc_quality_hold WHERE lot_id = $1 AND status = 'open' AND hold_id <> $2 LIMIT 1`,
    [lotId, excludingHoldId],
  );
  return result.rows.length > 0;
}

export interface ListQcQualityHoldsParams {
  site_id?: string | undefined;
  /** The caller's permitted sites when not wildcard-scoped (the Story 8.2 read-scope pattern). */
  site_ids?: string[] | undefined;
  status?: QcHoldStatus | undefined;
  lot_id?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listQcQualityHolds(
  params: ListQcQualityHoldsParams,
  client?: PoolClient,
): Promise<QcQualityHoldRow[]> {
  if (params.site_id !== undefined && params.site_ids !== undefined) {
    throw new Error('listQcQualityHolds: site_id and site_ids are mutually exclusive');
  }
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (params.site_id !== undefined) {
    values.push(params.site_id);
    conditions.push(`site_id = $${values.length}`);
  }
  if (params.site_ids !== undefined) {
    values.push(params.site_ids);
    conditions.push(`site_id = ANY($${values.length}::uuid[])`);
  }
  if (params.status !== undefined) {
    values.push(params.status);
    conditions.push(`status = $${values.length}`);
  }
  if (params.lot_id !== undefined) {
    values.push(params.lot_id);
    conditions.push(`lot_id = $${values.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(
    Math.max(Number.isInteger(params.limit) ? (params.limit as number) : 50, 1),
    200,
  );
  const offset = Math.max(Number.isInteger(params.offset) ? (params.offset as number) : 0, 0);
  values.push(limit, offset);
  const result = await runner(client).query(
    `SELECT ${HOLD_COLUMNS} FROM qc_quality_hold ${where}
      ORDER BY placed_at DESC, hold_id
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return result.rows.map((row) => mapRow(row as Record<string, unknown>));
}

/**
 * The once-only open -> released transition. Returns false when the hold was already released
 * (zero rows updated), which the caller reports as 409 HOLD_ALREADY_RELEASED - this is the
 * concurrency backstop, not a convenience.
 */
export async function releaseQcQualityHold(
  patch: QcQualityHoldReleasePatch,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE qc_quality_hold
        SET status = 'released',
            released_by = $2,
            released_at = $3,
            release_reason = $4,
            release_event_id = $5,
            updated_at = now()
      WHERE hold_id = $1 AND status = 'open'`,
    [
      patch.hold_id,
      patch.released_by,
      patch.released_at,
      patch.release_reason,
      patch.release_event_id,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}
