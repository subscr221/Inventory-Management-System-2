import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 8.8 accessor for the qc_witness_notice ledger (FR-Q-15, AC 2). Binding Scope Decision 5:
 * a notice is a first-class RECORD of evidence (recipient, date, method), not a fire-and-forget
 * notification. The table is APPEND-ONLY - there is deliberately no update and no delete path
 * here, because a notice that was served is a posted contractual fact.
 */

export const WITNESS_NOTICE_METHODS = ['email', 'letter', 'portal', 'in_person'] as const;
export type WitnessNoticeMethod = (typeof WITNESS_NOTICE_METHODS)[number];

export interface QcWitnessNoticeRow {
  notice_id: string;
  hold_point_id: string;
  recipient: string;
  /** IST calendar date, YYYY-MM-DD. */
  notice_date: string;
  method: WitnessNoticeMethod;
  recorded_by: string;
  recorded_at: string;
  source_event_id: string;
  created_at: string;
}

export type InsertQcWitnessNoticeRow = Omit<QcWitnessNoticeRow, 'created_at'>;

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOTICE_COLUMNS = `notice_id, hold_point_id, recipient, notice_date, method, recorded_by,
    recorded_at, source_event_id, created_at`;

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
/** A DATE column comes back as a Date at local midnight; take the IST calendar date verbatim. */
const toDate = (v: unknown): string =>
  v instanceof Date
    ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
    : String(v);

function mapRow(row: Record<string, unknown>): QcWitnessNoticeRow {
  return {
    notice_id: row['notice_id'] as string,
    hold_point_id: row['hold_point_id'] as string,
    recipient: row['recipient'] as string,
    notice_date: toDate(row['notice_date']),
    method: row['method'] as WitnessNoticeMethod,
    recorded_by: row['recorded_by'] as string,
    recorded_at: toIso(row['recorded_at']),
    source_event_id: row['source_event_id'] as string,
    created_at: toIso(row['created_at']),
  };
}

export async function insertWitnessNotice(
  row: InsertQcWitnessNoticeRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO qc_witness_notice (notice_id, hold_point_id, recipient, notice_date, method,
       recorded_by, recorded_at, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      row.notice_id,
      row.hold_point_id,
      row.recipient,
      row.notice_date,
      row.method,
      row.recorded_by,
      row.recorded_at,
      row.source_event_id,
    ],
  );
}

/** The BSD-6 notice-before-inspection predicate reads this: zero notices refuses a sign-off. */
export async function countNoticesForHoldPoint(
  holdPointId: string,
  client?: PoolClient,
): Promise<number> {
  if (!UUID_REGEX.test(holdPointId)) return 0;
  const result = await runner(client).query(
    `SELECT count(*)::int AS count FROM qc_witness_notice WHERE hold_point_id = $1`,
    [holdPointId],
  );
  return (result.rows[0] as { count: number } | undefined)?.count ?? 0;
}

export async function listNoticesForHoldPoint(
  holdPointId: string,
  client?: PoolClient,
): Promise<QcWitnessNoticeRow[]> {
  if (!UUID_REGEX.test(holdPointId)) return [];
  const result = await runner(client).query(
    `SELECT ${NOTICE_COLUMNS} FROM qc_witness_notice
      WHERE hold_point_id = $1 ORDER BY notice_date, notice_id`,
    [holdPointId],
  );
  return result.rows.map((row) => mapRow(row as Record<string, unknown>));
}
