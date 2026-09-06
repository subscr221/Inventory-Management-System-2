import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 9.7 (FR-JW-09/10, FR-JW-12): credit notes raised against the service invoice when the
 * processor ACQUIRES contractual offcut. The `original` row is written by the disposal applier; a
 * revaluation writes a `delta` row that supersedes the latest document and carries the SIGNED
 * difference. Nothing is ever mutated except the acknowledgment stamps, and there is no void state -
 * see the header of read/projections/job_work_credit_note.sql for why.
 *
 * Money is NUMERIC(18,4) text, never floated by a caller.
 */

export type JobWorkCreditNoteKind = 'original' | 'delta';
export type JobWorkCreditNoteStatus = 'pending' | 'acknowledged';

export interface JobWorkCreditNoteRow {
  credit_note_id: string;
  service_order_id: string;
  holding_id: string;
  document_kind: JobWorkCreditNoteKind;
  supersedes_credit_note_id: string | null;
  /** The ERP document reference of the service invoice this credits. A CITATION, not an identity. */
  cited_invoice_ref_ext: string;
  rate: string;
  indicative_rate: string | null;
  currency: string;
  value: string;
  /** Signed difference against the document this supersedes; NULL on an `original`. */
  delta_value: string | null;
  status: JobWorkCreditNoteStatus;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  acknowledged_ref_ext: string | null;
  /** The finance controller who named the rate. The AC 6 SoD comparison is against THIS column. */
  valued_by: string;
  site_id: string;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface InsertCreditNoteInput {
  credit_note_id: string;
  service_order_id: string;
  holding_id: string;
  document_kind: JobWorkCreditNoteKind;
  supersedes_credit_note_id: string | null;
  cited_invoice_ref_ext: string;
  rate: string;
  indicative_rate: string | null;
  currency: string;
  value: string;
  delta_value: string | null;
  valued_by: string;
  site_id: string;
  source_event_id: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT_COLUMNS = `credit_note_id, service_order_id, holding_id, document_kind,
  supersedes_credit_note_id, cited_invoice_ref_ext, rate::text AS rate,
  indicative_rate::text AS indicative_rate, currency, value::text AS value,
  delta_value::text AS delta_value, status, acknowledged_at, acknowledged_by, acknowledged_ref_ext,
  valued_by, site_id, source_event_id, created_at, updated_at`;

const toIso = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);

function mapRow(row: Record<string, unknown>): JobWorkCreditNoteRow {
  return {
    ...(row as unknown as JobWorkCreditNoteRow),
    acknowledged_at: toIso(row['acknowledged_at']),
    created_at: toIso(row['created_at']) as string,
    updated_at: toIso(row['updated_at']) as string,
  };
}

/** Plain INSERT: a duplicate id or source event surfaces as 23505 for the seam to classify. */
export async function insertCreditNote(
  input: InsertCreditNoteInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO job_work_credit_note (
       credit_note_id, service_order_id, holding_id, document_kind, supersedes_credit_note_id,
       cited_invoice_ref_ext, rate, indicative_rate, currency, value, delta_value, status,
       valued_by, site_id, source_event_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9, $10::numeric, $11::numeric,
               'pending', $12, $13, $14)`,
    [
      input.credit_note_id,
      input.service_order_id,
      input.holding_id,
      input.document_kind,
      input.supersedes_credit_note_id,
      input.cited_invoice_ref_ext,
      input.rate,
      input.indicative_rate,
      input.currency,
      input.value,
      input.delta_value,
      input.valued_by,
      input.site_id,
      input.source_event_id,
    ],
  );
}

/** A malformed id is "not found", not a 22P02 500 (the getBillingFeedById precedent). */
export async function getCreditNoteById(
  creditNoteId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<JobWorkCreditNoteRow | null> {
  if (!UUID_REGEX.test(creditNoteId)) return null;
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await runner(client).query(
    `SELECT ${SELECT_COLUMNS} FROM job_work_credit_note WHERE credit_note_id = $1${lockClause}`,
    [creditNoteId],
  );
  return result.rows[0] ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

/** Every document for an order, oldest first - the original then its delta chain in order. */
export async function listCreditNotesByOrder(
  serviceOrderId: string,
  client?: PoolClient,
): Promise<JobWorkCreditNoteRow[]> {
  if (!UUID_REGEX.test(serviceOrderId)) return [];
  const result = await runner(client).query(
    `SELECT ${SELECT_COLUMNS} FROM job_work_credit_note WHERE service_order_id = $1
      ORDER BY created_at ASC, credit_note_id ASC`,
    [serviceOrderId],
  );
  return (result.rows as Record<string, unknown>[]).map(mapRow);
}

/**
 * The documents for one holding row, oldest first. The revaluation applier chains its delta off the
 * LAST element: a second revaluation supersedes the first delta, never the original again.
 */
export async function listCreditNotesByHolding(
  holdingId: string,
  client: PoolClient,
  forUpdate: boolean = false,
): Promise<JobWorkCreditNoteRow[]> {
  if (!UUID_REGEX.test(holdingId)) return [];
  const result = await client.query(
    `SELECT ${SELECT_COLUMNS} FROM job_work_credit_note WHERE holding_id = $1
      ORDER BY created_at ASC, credit_note_id ASC${forUpdate ? ' FOR UPDATE' : ''}`,
    [holdingId],
  );
  return (result.rows as Record<string, unknown>[]).map(mapRow);
}

/** Guarded flip: matches only while the document is not already acknowledged. */
export async function markCreditNoteAcknowledged(
  creditNoteId: string,
  ack: { acknowledged_at: string; acknowledged_by: string; acknowledged_ref_ext: string },
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE job_work_credit_note
        SET status = 'acknowledged', acknowledged_at = $2::timestamptz, acknowledged_by = $3::uuid,
            acknowledged_ref_ext = $4, updated_at = now()
      WHERE credit_note_id = $1 AND status <> 'acknowledged'`,
    [creditNoteId, ack.acknowledged_at, ack.acknowledged_by, ack.acknowledged_ref_ext],
  );
  return (result.rowCount ?? 0) === 1;
}
