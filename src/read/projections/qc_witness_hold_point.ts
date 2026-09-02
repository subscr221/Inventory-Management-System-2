import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 8.8 accessor for the qc_witness_hold_point projection (FR-Q-15, AC 1 and AC 2). The record
 * of a witnessed / third-party inspection obligation (Binding Scope Decision 2): the applier that
 * inserts a row here ALSO inserts a normal governed qc_quality_hold row and sets
 * lot_master.quality_hold_status = 'held' in the SAME transaction, so every existing enforcement
 * site keeps reading that one flag and no new enforcement axis is introduced.
 *
 * closeWitnessHoldPoint is the ONLY update path and is guarded by `WHERE status = 'open'`: a
 * concurrent second closure updates zero rows, which the caller turns into 409
 * WITNESS_HOLD_POINT_NOT_OPEN. Closure is terminal; there is no reopen.
 */

export const WITNESS_INSPECTION_TYPES = ['customer_witnessed', 'third_party'] as const;
export type WitnessInspectionType = (typeof WITNESS_INSPECTION_TYPES)[number];

export const WITNESS_HOLD_POINT_STATUSES = ['open', 'signed_off', 'waived'] as const;
export type WitnessHoldPointStatus = (typeof WITNESS_HOLD_POINT_STATUSES)[number];

export interface QcWitnessHoldPointRow {
  hold_point_id: string;
  lot_id: string;
  lot_number: string;
  sku: string;
  site_id: string | null;
  inspection_type: WitnessInspectionType;
  status: WitnessHoldPointStatus;
  qc_hold_id: string;
  raised_by: string;
  raised_at: string;
  source_event_id: string;
  closed_by: string | null;
  closed_at: string | null;
  close_event_id: string | null;
  waiver_doa_entry_id: string | null;
  waiver_reason: string | null;
  created_at: string;
  updated_at: string;
}

export type InsertQcWitnessHoldPointRow = Pick<
  QcWitnessHoldPointRow,
  | 'hold_point_id'
  | 'lot_id'
  | 'lot_number'
  | 'sku'
  | 'site_id'
  | 'inspection_type'
  | 'qc_hold_id'
  | 'raised_by'
  | 'raised_at'
  | 'source_event_id'
>;

export interface QcWitnessHoldPointClosurePatch {
  hold_point_id: string;
  /** 'signed_off' or 'waived' - the biconditional CHECK pairs 'waived' with waiver_doa_entry_id. */
  status: Exclude<WitnessHoldPointStatus, 'open'>;
  closed_by: string;
  closed_at: string;
  close_event_id: string;
  waiver_doa_entry_id: string | null;
  waiver_reason: string | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HOLD_POINT_COLUMNS = `hold_point_id, lot_id, lot_number, sku, site_id, inspection_type,
    status, qc_hold_id, raised_by, raised_at, source_event_id, closed_by, closed_at,
    close_event_id, waiver_doa_entry_id, waiver_reason, created_at, updated_at`;

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const toIsoOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : toIso(v);

/**
 * A FOR UPDATE on a pool checkout is a lock that does nothing: the row lock is released the moment
 * the implicit single-statement transaction commits, so the caller believes it holds the row while
 * a concurrent writer walks straight past. The Story 8.7 review found exactly this, so it throws
 * rather than silently degrading.
 */
function assertLockable(client: PoolClient | undefined, forUpdate: boolean, fn: string): void {
  if (forUpdate && !client) {
    throw new Error(`${fn}: forUpdate requires a transaction client`);
  }
}

function mapRow(row: Record<string, unknown>): QcWitnessHoldPointRow {
  return {
    hold_point_id: row['hold_point_id'] as string,
    lot_id: row['lot_id'] as string,
    lot_number: row['lot_number'] as string,
    sku: row['sku'] as string,
    site_id: (row['site_id'] as string | null) ?? null,
    inspection_type: row['inspection_type'] as WitnessInspectionType,
    status: row['status'] as WitnessHoldPointStatus,
    qc_hold_id: row['qc_hold_id'] as string,
    raised_by: row['raised_by'] as string,
    raised_at: toIso(row['raised_at']),
    source_event_id: row['source_event_id'] as string,
    closed_by: (row['closed_by'] as string | null) ?? null,
    closed_at: toIsoOrNull(row['closed_at']),
    close_event_id: (row['close_event_id'] as string | null) ?? null,
    waiver_doa_entry_id: (row['waiver_doa_entry_id'] as string | null) ?? null,
    waiver_reason: (row['waiver_reason'] as string | null) ?? null,
    created_at: toIso(row['created_at']),
    updated_at: toIso(row['updated_at']),
  };
}

export async function insertWitnessHoldPoint(
  row: InsertQcWitnessHoldPointRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO qc_witness_hold_point (hold_point_id, lot_id, lot_number, sku, site_id,
       inspection_type, status, qc_hold_id, raised_by, raised_at, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9, $10)`,
    [
      row.hold_point_id,
      row.lot_id,
      row.lot_number,
      row.sku,
      row.site_id,
      row.inspection_type,
      row.qc_hold_id,
      row.raised_by,
      row.raised_at,
      row.source_event_id,
    ],
  );
}

export async function getWitnessHoldPointById(
  holdPointId: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<QcWitnessHoldPointRow | null> {
  assertLockable(client, forUpdate, 'getWitnessHoldPointById');
  if (!UUID_REGEX.test(holdPointId)) return null;
  const result = await runner(client).query(
    `SELECT ${HOLD_POINT_COLUMNS} FROM qc_witness_hold_point
      WHERE hold_point_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [holdPointId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

/**
 * The one open hold point for a lot, if any (uq_qc_witness_hold_point_open makes "the" a database
 * fact).
 */
export async function getOpenWitnessHoldPointByLotId(
  lotId: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<QcWitnessHoldPointRow | null> {
  assertLockable(client, forUpdate, 'getOpenWitnessHoldPointByLotId');
  if (!UUID_REGEX.test(lotId)) return null;
  const result = await runner(client).query(
    `SELECT ${HOLD_POINT_COLUMNS} FROM qc_witness_hold_point
      WHERE lot_id = $1 AND status = 'open'${forUpdate ? ' FOR UPDATE' : ''}`,
    [lotId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

/**
 * The open hold point whose governed hold is `qcHoldId`, if any. Queries the qc_hold_id COLUMN
 * rather than relying on the `qc_hold_id = hold_point_id` minting convention, so the Story 8.5
 * release guard survives a future change to how the pair is minted (code review 2026-09-02,
 * round 2).
 */
export async function getOpenWitnessHoldPointByQcHoldId(
  qcHoldId: string,
  client?: PoolClient,
): Promise<QcWitnessHoldPointRow | null> {
  if (!UUID_REGEX.test(qcHoldId)) return null;
  const result = await runner(client).query(
    `SELECT ${HOLD_POINT_COLUMNS} FROM qc_witness_hold_point
      WHERE qc_hold_id = $1 AND status = 'open'`,
    [qcHoldId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

export interface ListWitnessHoldPointsParams {
  site_id?: string | undefined;
  /** The caller's permitted sites when not wildcard-scoped (the Story 8.2 read-scope pattern). */
  site_ids?: string[] | undefined;
  status?: WitnessHoldPointStatus | undefined;
  lot_id?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listWitnessHoldPoints(
  params: ListWitnessHoldPointsParams,
  client?: PoolClient,
): Promise<QcWitnessHoldPointRow[]> {
  if (params.site_id !== undefined && params.site_ids !== undefined) {
    throw new Error('listWitnessHoldPoints: site_id and site_ids are mutually exclusive');
  }
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (params.site_id !== undefined) {
    values.push(params.site_id);
    conditions.push(`site_id = $${values.length}`);
  }
  if (params.site_ids !== undefined) {
    values.push(params.site_ids);
    // Code review 2026-09-02: a NULL site_id means the hold point is not site-tenanted (ungoverned
    // lot) - it must stay visible to scoped readers, who can already GET it by id.
    conditions.push(`(site_id = ANY($${values.length}::uuid[]) OR site_id IS NULL)`);
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
    `SELECT ${HOLD_POINT_COLUMNS} FROM qc_witness_hold_point ${where}
      ORDER BY raised_at DESC, hold_point_id
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return result.rows.map((row) => mapRow(row as Record<string, unknown>));
}

/**
 * The once-only open -> signed_off/waived transition. Returns false when the hold point was already
 * closed (zero rows updated), which the caller reports as 409 WITNESS_HOLD_POINT_NOT_OPEN - the
 * concurrency backstop, so a lost race is a domain refusal and never a silent no-op.
 */
export async function closeWitnessHoldPoint(
  patch: QcWitnessHoldPointClosurePatch,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE qc_witness_hold_point
        SET status = $2,
            closed_by = $3,
            closed_at = $4,
            close_event_id = $5,
            waiver_doa_entry_id = $6,
            waiver_reason = $7,
            updated_at = now()
      WHERE hold_point_id = $1 AND status = 'open'`,
    [
      patch.hold_point_id,
      patch.status,
      patch.closed_by,
      patch.closed_at,
      patch.close_event_id,
      patch.waiver_doa_entry_id,
      patch.waiver_reason,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}
