import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 8.3 accessor for the qc_lot_split projection (FR-Q-05, AC 2). One row per CHILD lot,
 * append-only (app_user: INSERT, SELECT). It carries the parent-to-child provenance that the
 * child's own qc_inspection_task row cannot: uq_qc_inspection_task_source forbids reusing the
 * parent's (source_completion_type, source_completion_id), so each child task mints a fresh
 * source_completion_id and the real linkage lives here.
 *
 * The race backstop for a second split of the same parent is uq_qc_lot_disposition_lot on the
 * parent's 'split' disposition row (409 DISPOSITION_EXISTS), not this table; uq_qc_lot_split_child
 * and uq_qc_lot_split_sequence are the belt-and-braces guards.
 */

export interface QcLotSplitRow {
  split_id: string;
  parent_lot_id: string;
  parent_lot_number: string;
  parent_task_id: string;
  disposition_id: string;
  child_lot_id: string;
  child_lot_number: string;
  child_task_id: string;
  sequence: number;
  quantity: string;
  source_event_id: string;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SPLIT_COLUMNS = `split_id, parent_lot_id, parent_lot_number, parent_task_id, disposition_id,
    child_lot_id, child_lot_number, child_task_id, sequence, quantity::text AS quantity,
    source_event_id, created_at`;

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function mapRow(row: Record<string, unknown>): QcLotSplitRow {
  return {
    split_id: row['split_id'] as string,
    parent_lot_id: row['parent_lot_id'] as string,
    parent_lot_number: row['parent_lot_number'] as string,
    parent_task_id: row['parent_task_id'] as string,
    disposition_id: row['disposition_id'] as string,
    child_lot_id: row['child_lot_id'] as string,
    child_lot_number: row['child_lot_number'] as string,
    child_task_id: row['child_task_id'] as string,
    sequence: Number(row['sequence']),
    quantity: String(row['quantity']),
    source_event_id: row['source_event_id'] as string,
    created_at: toIso(row['created_at']),
  };
}

export async function insertQcLotSplit(
  row: Omit<QcLotSplitRow, 'created_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO qc_lot_split (split_id, parent_lot_id, parent_lot_number, parent_task_id,
       disposition_id, child_lot_id, child_lot_number, child_task_id, sequence, quantity,
       source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11)`,
    [
      row.split_id,
      row.parent_lot_id,
      row.parent_lot_number,
      row.parent_task_id,
      row.disposition_id,
      row.child_lot_id,
      row.child_lot_number,
      row.child_task_id,
      row.sequence,
      row.quantity,
      row.source_event_id,
    ],
  );
}

/** Children of a parent lot in split sequence order. */
export async function listQcLotSplitsByParent(
  parentLotId: string,
  client?: PoolClient,
): Promise<QcLotSplitRow[]> {
  if (!UUID_REGEX.test(parentLotId)) return [];
  const result = await runner(client).query(
    `SELECT ${SPLIT_COLUMNS} FROM qc_lot_split WHERE parent_lot_id = $1 ORDER BY sequence`,
    [parentLotId],
  );
  return result.rows.map((row) => mapRow(row as Record<string, unknown>));
}

/** The split row that produced a child lot, or null when the lot is not a split child. */
export async function getQcLotSplitByChild(
  childLotId: string,
  client?: PoolClient,
): Promise<QcLotSplitRow | null> {
  if (!UUID_REGEX.test(childLotId)) return null;
  const result = await runner(client).query(
    `SELECT ${SPLIT_COLUMNS} FROM qc_lot_split WHERE child_lot_id = $1`,
    [childLotId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}
