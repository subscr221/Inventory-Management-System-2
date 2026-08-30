import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 8.3 accessor for the qc_ncr projection (FR-Q-06, AC 3, AC 4 and AC 5). One NCR per
 * rejected lot, created BY the reject disposition (Annex requirement 8), with an outcome that is
 * set exactly once (Annex requirement 9).
 *
 * setQcNcrOutcome is the ONLY update path and is guarded by `WHERE outcome IS NULL`: a concurrent
 * second outcome command updates zero rows, which the caller turns into 409 NCR_OUTCOME_EXISTS.
 * There is no reopen and no second outcome.
 */

export const QC_NCR_OUTCOMES = ['rework', 'downgrade', 'scrap'] as const;
export type QcNcrOutcome = (typeof QC_NCR_OUTCOMES)[number];

export interface QcNcrRow {
  ncr_id: string;
  lot_id: string;
  lot_number: string;
  task_id: string;
  disposition_id: string;
  site_id: string;
  sku: string;
  quantity: string;
  justification: string;
  raised_by: string;
  raised_at: string;
  source_event_id: string;
  outcome: QcNcrOutcome | null;
  outcome_reason: string | null;
  outcome_by: string | null;
  outcome_at: string | null;
  outcome_event_id: string | null;
  downgrade_sku: string | null;
  downgrade_lot_id: string | null;
  rework_requested_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export type InsertQcNcrRow = Pick<
  QcNcrRow,
  | 'ncr_id'
  | 'lot_id'
  | 'lot_number'
  | 'task_id'
  | 'disposition_id'
  | 'site_id'
  | 'sku'
  | 'quantity'
  | 'justification'
  | 'raised_by'
  | 'raised_at'
  | 'source_event_id'
>;

export interface QcNcrOutcomePatch {
  ncr_id: string;
  outcome: QcNcrOutcome;
  outcome_reason: string;
  outcome_by: string;
  outcome_at: string;
  outcome_event_id: string;
  downgrade_sku: string | null;
  downgrade_lot_id: string | null;
  rework_requested_event_id: string | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NCR_COLUMNS = `ncr_id, lot_id, lot_number, task_id, disposition_id, site_id, sku,
    quantity::text AS quantity, justification, raised_by, raised_at, source_event_id, outcome,
    outcome_reason, outcome_by, outcome_at, outcome_event_id, downgrade_sku, downgrade_lot_id,
    rework_requested_event_id, created_at, updated_at`;

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const toIsoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : toIso(v));

function mapRow(row: Record<string, unknown>): QcNcrRow {
  return {
    ncr_id: row['ncr_id'] as string,
    lot_id: row['lot_id'] as string,
    lot_number: row['lot_number'] as string,
    task_id: row['task_id'] as string,
    disposition_id: row['disposition_id'] as string,
    site_id: row['site_id'] as string,
    sku: row['sku'] as string,
    quantity: String(row['quantity']),
    justification: row['justification'] as string,
    raised_by: row['raised_by'] as string,
    raised_at: toIso(row['raised_at']),
    source_event_id: row['source_event_id'] as string,
    outcome: (row['outcome'] as QcNcrOutcome | null) ?? null,
    outcome_reason: (row['outcome_reason'] as string | null) ?? null,
    outcome_by: (row['outcome_by'] as string | null) ?? null,
    outcome_at: toIsoOrNull(row['outcome_at']),
    outcome_event_id: (row['outcome_event_id'] as string | null) ?? null,
    downgrade_sku: (row['downgrade_sku'] as string | null) ?? null,
    downgrade_lot_id: (row['downgrade_lot_id'] as string | null) ?? null,
    rework_requested_event_id: (row['rework_requested_event_id'] as string | null) ?? null,
    created_at: toIso(row['created_at']),
    updated_at: toIso(row['updated_at']),
  };
}

export async function insertQcNcr(row: InsertQcNcrRow, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO qc_ncr (ncr_id, lot_id, lot_number, task_id, disposition_id, site_id, sku,
       quantity, justification, raised_by, raised_at, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, $12)`,
    [
      row.ncr_id,
      row.lot_id,
      row.lot_number,
      row.task_id,
      row.disposition_id,
      row.site_id,
      row.sku,
      row.quantity,
      row.justification,
      row.raised_by,
      row.raised_at,
      row.source_event_id,
    ],
  );
}

export async function getQcNcrById(
  ncrId: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<QcNcrRow | null> {
  if (!UUID_REGEX.test(ncrId)) return null;
  const result = await runner(client).query(
    `SELECT ${NCR_COLUMNS} FROM qc_ncr WHERE ncr_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [ncrId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

export async function getQcNcrByLotId(
  lotId: string,
  client?: PoolClient,
): Promise<QcNcrRow | null> {
  if (!UUID_REGEX.test(lotId)) return null;
  const result = await runner(client).query(
    `SELECT ${NCR_COLUMNS} FROM qc_ncr WHERE lot_id = $1`,
    [lotId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

export interface ListQcNcrsParams {
  site_id?: string | undefined;
  /** The caller's permitted sites when not wildcard-scoped (the Story 8.2 read-scope pattern). */
  site_ids?: string[] | undefined;
  outcome?: QcNcrOutcome | 'open' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listQcNcrs(
  params: ListQcNcrsParams,
  client?: PoolClient,
): Promise<QcNcrRow[]> {
  if (params.site_id !== undefined && params.site_ids !== undefined) {
    throw new Error('listQcNcrs: site_id and site_ids are mutually exclusive');
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
  if (params.outcome === 'open') {
    conditions.push('outcome IS NULL');
  } else if (params.outcome !== undefined) {
    values.push(params.outcome);
    conditions.push(`outcome = $${values.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(
    Math.max(Number.isInteger(params.limit) ? (params.limit as number) : 50, 1),
    200,
  );
  const offset = Math.max(Number.isInteger(params.offset) ? (params.offset as number) : 0, 0);
  values.push(limit, offset);
  const result = await runner(client).query(
    `SELECT ${NCR_COLUMNS} FROM qc_ncr ${where}
      ORDER BY raised_at DESC, ncr_id
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return result.rows.map((row) => mapRow(row as Record<string, unknown>));
}

/**
 * Sets the once-only outcome. Returns false when the row was already decided (zero rows updated),
 * which the caller reports as 409 NCR_OUTCOME_EXISTS - this is the concurrency backstop, not a
 * convenience.
 */
export async function setQcNcrOutcome(
  patch: QcNcrOutcomePatch,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE qc_ncr
        SET outcome = $2,
            outcome_reason = $3,
            outcome_by = $4,
            outcome_at = $5,
            outcome_event_id = $6,
            downgrade_sku = $7,
            downgrade_lot_id = $8,
            rework_requested_event_id = $9,
            updated_at = now()
      WHERE ncr_id = $1 AND outcome IS NULL`,
    [
      patch.ncr_id,
      patch.outcome,
      patch.outcome_reason,
      patch.outcome_by,
      patch.outcome_at,
      patch.outcome_event_id,
      patch.downgrade_sku,
      patch.downgrade_lot_id,
      patch.rework_requested_event_id,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}
