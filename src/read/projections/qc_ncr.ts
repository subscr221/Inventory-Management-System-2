import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 8.3 accessor for the qc_ncr projection (FR-Q-06, AC 3, AC 4 and AC 5). One NCR per
 * rejected lot, created BY the reject disposition (Annex requirement 8), with an outcome that is
 * set exactly once (Annex requirement 9).
 *
 * Story 8.5 (FR-Q-10, Binding Scope Decision 9) adds a second ORIGIN: a hold-sourced NCR raised
 * independently of any disposition, carrying a defect code and (optionally) a CAPA link. The
 * disposition-sourced behaviour is unchanged; `origin` is the discriminator and
 * uq_qc_ncr_lot_disposition_sourced keeps the one-per-lot backstop for disposition rows only.
 *
 * setQcNcrOutcome is the ONLY outcome path and is guarded by `WHERE outcome IS NULL`: a concurrent
 * second outcome command updates zero rows, which the caller turns into 409 NCR_OUTCOME_EXISTS.
 * There is no reopen and no second outcome. linkCapaToNcr is guarded by `WHERE capa_id IS NULL`
 * the same way (409 CAPA_ALREADY_LINKED on zero rows).
 */

export const QC_NCR_OUTCOMES = ['rework', 'downgrade', 'scrap', 'closed_with_capa'] as const;
export type QcNcrOutcome = (typeof QC_NCR_OUTCOMES)[number];

export const QC_NCR_ORIGINS = ['disposition', 'hold'] as const;
export type QcNcrOrigin = (typeof QC_NCR_ORIGINS)[number];

export interface QcNcrRow {
  ncr_id: string;
  lot_id: string;
  lot_number: string;
  task_id: string | null;
  disposition_id: string | null;
  site_id: string;
  sku: string;
  quantity: string;
  justification: string;
  raised_by: string;
  raised_at: string;
  source_event_id: string;
  origin: QcNcrOrigin;
  hold_id: string | null;
  defect_code: string | null;
  capa_id: string | null;
  capa_mandatory: boolean;
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

/**
 * The Story 8.3 disposition-sourced insert; origin is stamped 'disposition' here. Story 8.6
 * (Binding Scope Decision 9) widens it with an OPTIONAL defect_code: chk_qc_ncr_origin now only
 * requires a code on hold-origin rows, and a coded reject NCR feeds the FR-Q-13 by-defect-code
 * rejection metric (an uncoded one buckets as UNSPECIFIED).
 */
export interface InsertQcNcrRow {
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
  defect_code?: string | null;
}

/** The Story 8.5 hold-sourced insert; origin is stamped 'hold' here. */
export interface InsertHoldSourcedQcNcrRow {
  ncr_id: string;
  lot_id: string;
  lot_number: string;
  site_id: string;
  sku: string;
  quantity: string;
  justification: string;
  raised_by: string;
  raised_at: string;
  source_event_id: string;
  hold_id: string | null;
  defect_code: string;
  capa_id: string | null;
  capa_mandatory: boolean;
}

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
    quantity::text AS quantity, justification, raised_by, raised_at, source_event_id, origin,
    hold_id, defect_code, capa_id, capa_mandatory, outcome,
    outcome_reason, outcome_by, outcome_at, outcome_event_id, downgrade_sku, downgrade_lot_id,
    rework_requested_event_id, created_at, updated_at`;

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const toIsoOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : toIso(v);

function mapRow(row: Record<string, unknown>): QcNcrRow {
  return {
    ncr_id: row['ncr_id'] as string,
    lot_id: row['lot_id'] as string,
    lot_number: row['lot_number'] as string,
    task_id: (row['task_id'] as string | null) ?? null,
    disposition_id: (row['disposition_id'] as string | null) ?? null,
    site_id: row['site_id'] as string,
    sku: row['sku'] as string,
    quantity: String(row['quantity']),
    justification: row['justification'] as string,
    raised_by: row['raised_by'] as string,
    raised_at: toIso(row['raised_at']),
    source_event_id: row['source_event_id'] as string,
    origin: row['origin'] as QcNcrOrigin,
    hold_id: (row['hold_id'] as string | null) ?? null,
    defect_code: (row['defect_code'] as string | null) ?? null,
    capa_id: (row['capa_id'] as string | null) ?? null,
    capa_mandatory: row['capa_mandatory'] as boolean,
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
       quantity, justification, raised_by, raised_at, source_event_id, origin, defect_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, $12, 'disposition', $13)`,
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
      row.defect_code ?? null,
    ],
  );
}

export async function insertHoldSourcedQcNcr(
  row: InsertHoldSourcedQcNcrRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO qc_ncr (ncr_id, lot_id, lot_number, site_id, sku, quantity, justification,
       raised_by, raised_at, source_event_id, origin, hold_id, defect_code, capa_id,
       capa_mandatory)
     VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10, 'hold', $11, $12, $13, $14)`,
    [
      row.ncr_id,
      row.lot_id,
      row.lot_number,
      row.site_id,
      row.sku,
      row.quantity,
      row.justification,
      row.raised_by,
      row.raised_at,
      row.source_event_id,
      row.hold_id,
      row.defect_code,
      row.capa_id,
      row.capa_mandatory,
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

/** The disposition-sourced NCR for a lot (the Story 8.3 one-per-lot grain), if any. */
export async function getQcNcrByLotId(
  lotId: string,
  client?: PoolClient,
): Promise<QcNcrRow | null> {
  if (!UUID_REGEX.test(lotId)) return null;
  const result = await runner(client).query(
    `SELECT ${NCR_COLUMNS} FROM qc_ncr WHERE lot_id = $1 AND disposition_id IS NOT NULL`,
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
 * Story 8.5 (FR-Q-10, Binding Scope Decision 12): counts PRIOR NCRs for the same enterprise-wide
 * (sku, defect_code) grain whose raised_at IST business date falls in the `windowDays` calendar
 * days STRICTLY preceding `beforeBusinessDate` (the new NCR's own business date - the new row is
 * never its own predecessor, and a predecessor raised on the same business date still counts as
 * prior). Bounds arrive as parameters, not module constants, so the predicate is genuinely
 * exercisable in a unit test (the Story 8.4 tautological-config lesson).
 *
 * The IST business date of raised_at is computed in SQL with the same fixed +05:30 offset
 * toIstCalendarDate uses (IST has no DST).
 */
export async function countMatchingNcrsInWindow(
  sku: string,
  defectCode: string,
  beforeBusinessDate: string,
  windowDays: number,
  client?: PoolClient,
): Promise<number> {
  const result = await runner(client).query(
    `SELECT count(*)::int AS n
       FROM qc_ncr
      WHERE sku = $1
        AND defect_code = $2
        AND (raised_at AT TIME ZONE 'UTC' + INTERVAL '5 hours 30 minutes')::date
              > ($3::date - $4::int)
        AND (raised_at AT TIME ZONE 'UTC' + INTERVAL '5 hours 30 minutes')::date
              < $3::date`,
    [sku, defectCode, beforeBusinessDate, windowDays],
  );
  return result.rows[0]['n'] as number;
}

/**
 * Story 8.5 (AC 4): links an open CAPA to the NCR exactly once. Returns false when the NCR already
 * carries a CAPA (zero rows updated), which the caller reports as 409 CAPA_ALREADY_LINKED.
 */
export async function linkCapaToNcr(
  ncrId: string,
  capaId: string,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE qc_ncr SET capa_id = $2, updated_at = now() WHERE ncr_id = $1 AND capa_id IS NULL`,
    [ncrId, capaId],
  );
  return (result.rowCount ?? 0) > 0;
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
