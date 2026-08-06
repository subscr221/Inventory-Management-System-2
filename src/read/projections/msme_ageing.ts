import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * MSME ageing read model (Story 4.6, AC3/AC8).
 *
 * "Outstanding" and "unpaid" here mean: a supplier_invoice row exists with a non-null
 * statutory_due_date. No payment state exists anywhere in this system (no paid_at, no settlement
 * event - payment executes in ERP), so every captured MSME invoice is outstanding by definition
 * and the ERP-side s.43B(h) disallowance computation consumes this ageing to reconcile against
 * its own payment records.
 *
 * All date arithmetic runs in SQL against the supplied as-of IST calendar date (never now() in
 * JS), and the MSMED s.16 interest exposure is computed in SQL NUMERIC (never JS floats):
 * simple statement of exposure - interest accrues from the day after the statutory due date at
 * the configured annual rate (three times RBI bank rate), compounded monthly (months = overdue
 * days / 30, fractional months compound pro-rata via power()).
 */

export interface MsmeAgeingRow {
  invoice_id: string;
  invoice_number_ext: string;
  supplier_id: string;
  supplier_legal_name: string;
  msme_classification: 'micro' | 'small' | 'medium';
  statutory_due_date: string;
  /** Days until the statutory due date as of the as-of date; negative when overdue. */
  days_to_due: number;
  /** Days past the statutory due date as of the as-of date; 0 when not yet due. */
  days_overdue: number;
  statutory_breach: boolean;
  /** s.43B(h): deduction disallowed when unpaid past the statutory due date as of the as-of date. */
  s43b_exposure: boolean;
  total_value: string;
  /** MSMED s.16 compound interest exposure (NUMERIC as string), 0.00 when not overdue. */
  s16_interest_exposure: string;
}

export async function queryMsmeAgeing(
  asOfDate: string,
  interestRatePercentAnnual: number,
  client?: PoolClient,
): Promise<MsmeAgeingRow[]> {
  const r = client ?? getPool();
  const result = await r.query(
    `SELECT
       si.invoice_id,
       si.invoice_number_ext,
       si.supplier_id,
       s.legal_name AS supplier_legal_name,
       si.msme_classification_at_capture AS msme_classification,
       si.statutory_due_date::text AS statutory_due_date,
       (si.statutory_due_date - $1::date)::int AS days_to_due,
       GREATEST(($1::date - si.statutory_due_date), 0)::int AS days_overdue,
       si.statutory_breach,
       ($1::date > si.statutory_due_date) AS s43b_exposure,
       si.total_value::text AS total_value,
       CASE
         WHEN $1::date > si.statutory_due_date THEN
           round(
             si.total_value * (
               power(
                 1::numeric + $2::numeric / 1200,
                 (($1::date - si.statutory_due_date)::numeric / 30)
               ) - 1
             ),
             2
           )::text
         ELSE '0.00'
       END AS s16_interest_exposure
     FROM supplier_invoice si
     JOIN supplier s ON s.supplier_id = si.supplier_id
     WHERE si.statutory_due_date IS NOT NULL
     ORDER BY si.statutory_due_date ASC, si.invoice_id ASC`,
    [asOfDate, interestRatePercentAnnual],
  );
  return result.rows as MsmeAgeingRow[];
}

export interface MsmeAgeingFeedRow {
  feed_id: string;
  payload: Record<string, unknown>;
  row_count: number;
  recorded_at: string;
}

/**
 * Append-only ledger insert, written atomically with the msme_ageing_feed.recorded domain event
 * inside the same persistEvent transaction (po_outbound_message precedent).
 */
export async function insertMsmeAgeingFeed(
  row: Pick<MsmeAgeingFeedRow, 'feed_id' | 'payload' | 'row_count'>,
  client: PoolClient,
): Promise<void> {
  // ON CONFLICT DO NOTHING: a replayed or spoofed msme_ageing_feed.recorded event with the same
  // feed_id must not abort the persistEvent transaction with a raw 23505. The handler relies on
  // alreadyPersisted for idempotency; this keeps the row-insert side idempotent too.
  await client.query(
    `INSERT INTO msme_ageing_feed (feed_id, payload, row_count)
     VALUES ($1, $2, $3)
     ON CONFLICT (feed_id) DO NOTHING`,
    [row.feed_id, JSON.stringify(row.payload), row.row_count],
  );
}

export async function getMsmeAgeingFeedById(
  feedId: string,
  client?: PoolClient,
): Promise<MsmeAgeingFeedRow | null> {
  const r = client ?? getPool();
  const result = await r.query(
    `SELECT feed_id, payload, row_count, recorded_at FROM msme_ageing_feed WHERE feed_id = $1`,
    [feedId],
  );
  return (result.rows[0] as MsmeAgeingFeedRow) ?? null;
}
