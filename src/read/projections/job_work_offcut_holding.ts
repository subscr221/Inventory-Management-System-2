import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 9.6 revised (FR-JW-09/10): the offcut holding ledger. Contractual offcut is captured here
 * UNVALUED and retained until the finance controller disposes of it in Story 9.7. Nothing in this
 * projection carries money.
 *
 * Capture drains the custody ledger so the Story 9.5 closure gate stays reachable, but the material
 * is still the CUSTOMER'S until disposal and the Section 143 clock keeps running against it - see
 * the header of read/projections/job_work_offcut_holding.sql for why that tension is deliberate and
 * why every deemed-supply and ageing read must include this table.
 *
 * `disposed_at`, `disposition` and `disposal_event_id` are forward-declared for Story 9.7; nothing
 * in Story 9.6 writes them.
 */

export type JobWorkOffcutHoldingStatus = 'retained' | 'disposed';
export type JobWorkOffcutDisposition = 'returned' | 'acquired';

export interface JobWorkOffcutHoldingRow {
  holding_id: string;
  service_order_id: string;
  customer_party_code: string;
  offcut_contract_ref_ext: string | null;
  sku: string;
  /** The MINTED offcut lot carrying the segregated `offcut` stock. */
  lot_id: string;
  /** The customer lot the offcut came off, for recall and genealogy. */
  source_lot_id: string;
  location_id: string;
  quantity: string;
  uom: string;
  status: JobWorkOffcutHoldingStatus;
  captured_at: string;
  business_date: string;
  disposed_at: string | null;
  disposition: JobWorkOffcutDisposition | null;
  disposal_event_id: string | null;
  /** Story 9.7 disposal facts. All NULL while status = 'retained'. */
  disposed_by: string | null;
  /** The NEGOTIATED acquisition rate, NUMERIC(18,4) text. NULL on a `returned` disposal. */
  disposal_rate: string | null;
  /** The offcut contract's indicative rate, copied off the order so the variance stays visible. */
  indicative_rate: string | null;
  disposal_currency: string | null;
  /** quantity x disposal_rate at the money scale. Exactly "0.0000" on a free retention. */
  disposal_value: string | null;
  approved_by: string | null;
  doa_entry_id: string | null;
  return_challan_number_ext: string | null;
  /**
   * How much of the Section 143 clock this disposal actually absorbed (code review 2026-09-06): the
   * reconcile is deliberately non-strict (over-tolerance receipts can exceed challan_qty capacity),
   * and a shortfall must be visible ON this row - `quantity - clock_reconciled_qty` is the residual
   * still outstanding against the clock after the holding closed. NULL only on rows disposed before
   * this column existed.
   */
  clock_reconciled_qty: string | null;
  /** The owned lot minted on an `acquired` disposal; NULL on `returned`. */
  owned_lot_id: string | null;
  site_id: string;
  captured_by: string;
  source_event_id: string;
  correlation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertOffcutHoldingInput {
  holding_id: string;
  service_order_id: string;
  customer_party_code: string;
  offcut_contract_ref_ext: string | null;
  sku: string;
  lot_id: string;
  source_lot_id: string;
  location_id: string;
  quantity: string;
  uom: string;
  captured_at: string;
  business_date: string;
  site_id: string;
  captured_by: string;
  source_event_id: string;
  correlation_id: string | null;
}

const SELECT_COLUMNS = `holding_id, service_order_id, customer_party_code, offcut_contract_ref_ext,
  sku, lot_id, source_lot_id, location_id, quantity::text AS quantity, uom, status, captured_at,
  to_char(business_date, 'YYYY-MM-DD') AS business_date,
  disposed_at, disposition, disposal_event_id, disposed_by,
  disposal_rate::text AS disposal_rate, indicative_rate::text AS indicative_rate,
  disposal_currency, disposal_value::text AS disposal_value, approved_by, doa_entry_id,
  return_challan_number_ext, clock_reconciled_qty::text AS clock_reconciled_qty, owned_lot_id,
  site_id, captured_by, source_event_id, correlation_id, created_at, updated_at`;

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapRow(row: Record<string, unknown>): JobWorkOffcutHoldingRow {
  return {
    ...(row as unknown as JobWorkOffcutHoldingRow),
    captured_at: toIso(row['captured_at']) as string,
    // Selected as text by to_char above. Mapping the raw DATE with toISOString() shifted it a day
    // back in any timezone ahead of UTC, because node-pg returns a DATE as LOCAL midnight - a row
    // written 2026-09-06 IST read back 2026-09-05 (fixed 2026-09-06, the custody_ledger_entry
    // precedent).
    business_date: String(row['business_date']),
    disposed_at: toIso(row['disposed_at']),
    created_at: toIso(row['created_at']) as string,
    updated_at: toIso(row['updated_at']) as string,
  };
}

export async function insertOffcutHolding(
  input: InsertOffcutHoldingInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO job_work_offcut_holding (
       holding_id, service_order_id, customer_party_code, offcut_contract_ref_ext, sku, lot_id,
       source_lot_id, location_id, quantity, uom, status, captured_at, business_date, site_id,
       captured_by, source_event_id, correlation_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, 'retained', $11::timestamptz,
       $12::date, $13, $14, $15, $16)`,
    [
      input.holding_id,
      input.service_order_id,
      input.customer_party_code,
      input.offcut_contract_ref_ext,
      input.sku,
      input.lot_id,
      input.source_lot_id,
      input.location_id,
      input.quantity,
      input.uom,
      input.captured_at,
      input.business_date,
      input.site_id,
      input.captured_by,
      input.source_event_id,
      input.correlation_id,
    ],
  );
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getOffcutHoldingById(
  holdingId: string,
  client?: PoolClient,
): Promise<JobWorkOffcutHoldingRow | null> {
  // A malformed id is "not found", not a 22P02 500 (the getBillingFeedById precedent).
  if (!UUID_REGEX.test(holdingId)) return null;
  const runner = client ?? getPool();
  const result = await runner.query(
    `SELECT ${SELECT_COLUMNS} FROM job_work_offcut_holding WHERE holding_id = $1`,
    [holdingId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

/**
 * Every holding row for an order, newest first. `retainedOnly` is what the Story 9.7 ageing and
 * deemed-supply reads want: rows still carrying an open Section 143 exposure.
 */
export async function listOffcutHoldingsByOrder(
  serviceOrderId: string,
  client?: PoolClient,
  retainedOnly = false,
): Promise<JobWorkOffcutHoldingRow[]> {
  const runner = client ?? getPool();
  const result = await runner.query(
    `SELECT ${SELECT_COLUMNS} FROM job_work_offcut_holding
      WHERE service_order_id = $1 ${retainedOnly ? `AND status = 'retained'` : ''}
      ORDER BY captured_at DESC, holding_id ASC`,
    [serviceOrderId],
  );
  return (result.rows as Record<string, unknown>[]).map(mapRow);
}

// ---------------------------------------------------------------------------
// Story 9.7 (FR-JW-09/10, FR-JW-12): disposal accessors
// ---------------------------------------------------------------------------

/**
 * The holding row under FOR UPDATE, for the disposal and revaluation appliers. Returns the row
 * whatever its status: the applier decides, and refuses OFFCUT_NOT_RETAINED with the status it
 * actually found rather than a bare "not found".
 */
export async function getRetainedHoldingForUpdate(
  holdingId: string,
  client: PoolClient,
): Promise<JobWorkOffcutHoldingRow | null> {
  if (!UUID_REGEX.test(holdingId)) return null;
  const result = await client.query(
    `SELECT ${SELECT_COLUMNS} FROM job_work_offcut_holding WHERE holding_id = $1 FOR UPDATE`,
    [holdingId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

export interface MarkOffcutHoldingDisposedInput {
  holding_id: string;
  disposed_at: string;
  disposition: JobWorkOffcutDisposition;
  disposal_event_id: string;
  disposed_by: string;
  disposal_rate: string | null;
  indicative_rate: string | null;
  disposal_currency: string | null;
  disposal_value: string | null;
  approved_by: string | null;
  doa_entry_id: string | null;
  return_challan_number_ext: string | null;
  owned_lot_id: string | null;
  clock_reconciled_qty: string;
}

/**
 * GUARDED update: matches only while the row is still `retained`. A false return is a RACE (a
 * concurrent disposal won), never a success - the 9.5 sweep's skippedRaced lesson applied to a
 * write path, and the reason a second disposal of the same row can never double-post.
 */
export async function markOffcutHoldingDisposed(
  input: MarkOffcutHoldingDisposedInput,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE job_work_offcut_holding
        SET status = 'disposed', disposed_at = $2::timestamptz, disposition = $3,
            disposal_event_id = $4::uuid, disposed_by = $5::uuid, disposal_rate = $6::numeric,
            indicative_rate = $7::numeric, disposal_currency = $8, disposal_value = $9::numeric,
            approved_by = $10::uuid, doa_entry_id = $11::uuid, return_challan_number_ext = $12,
            owned_lot_id = $13, clock_reconciled_qty = $14::numeric, updated_at = now()
      WHERE holding_id = $1 AND status = 'retained'`,
    [
      input.holding_id,
      input.disposed_at,
      input.disposition,
      input.disposal_event_id,
      input.disposed_by,
      input.disposal_rate,
      input.indicative_rate,
      input.disposal_currency,
      input.disposal_value,
      input.approved_by,
      input.doa_entry_id,
      input.return_challan_number_ext,
      input.owned_lot_id,
      input.clock_reconciled_qty,
    ],
  );
  return (result.rowCount ?? 0) === 1;
}

/**
 * Revaluation (AC 5) moves the CURRENT commercial value; indicative_rate is never touched.
 * disposal_currency is written too (code review 2026-09-06): a revaluation changes the currency the
 * current value is expressed in, and the row must not keep advertising the old one.
 */
export async function updateOffcutHoldingValuation(
  holdingId: string,
  valuation: {
    disposal_rate: string;
    disposal_currency: string;
    disposal_value: string;
    approved_by: string | null;
    doa_entry_id: string | null;
  },
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE job_work_offcut_holding
        SET disposal_rate = $2::numeric, disposal_currency = $3, disposal_value = $4::numeric,
            approved_by = $5::uuid, doa_entry_id = $6::uuid, updated_at = now()
      WHERE holding_id = $1 AND status = 'disposed' AND disposition = 'acquired'`,
    [
      holdingId,
      valuation.disposal_rate,
      valuation.disposal_currency,
      valuation.disposal_value,
      valuation.approved_by,
      valuation.doa_entry_id,
    ],
  );
  return (result.rowCount ?? 0) === 1;
}

/**
 * AC 8 / AC 9: every still-`retained` holding row, site-scoped, oldest first, with its age in days
 * against the caller's IST business date. `siteIds` null means a wildcard read assignment.
 *
 * Retained rows are the whole of AC 9's second half: once a row is `acquired` it has left customer
 * ownership and is carried as ordinary owned stock, so it must NOT appear on a job-work exposure
 * report; once it is `returned` there is nothing left to age.
 */
export async function listRetainedOffcutHoldings(
  input: { siteIds: string[] | null; today: string },
  client?: PoolClient,
): Promise<(JobWorkOffcutHoldingRow & { age_days: number })[]> {
  const runner = client ?? getPool();
  const params: unknown[] = [input.today];
  let where = `status = 'retained'`;
  if (input.siteIds !== null) {
    if (input.siteIds.length === 0) return [];
    // A malformed site id must be "no rows", not a 22P02 500 on the uuid[] cast (chunk B code
    // review 2026-09-06); every sibling accessor guards malformed ids the same way.
    if (!input.siteIds.every((id) => UUID_REGEX.test(id))) return [];
    params.push(input.siteIds);
    where += ` AND site_id = ANY($${params.length}::uuid[])`;
  }
  const result = await runner.query(
    `SELECT ${SELECT_COLUMNS},
            ($1::date - business_date)::int AS age_days
       FROM job_work_offcut_holding
      WHERE ${where}
      ORDER BY captured_at ASC, holding_id ASC`,
    params,
  );
  return (result.rows as Record<string, unknown>[]).map((row) => ({
    ...mapRow(row),
    age_days: Number(row['age_days'] ?? 0),
  }));
}

/** The retained rows on one (order, sku) - what the Story 9.5 clock sweep names in its alert. */
export async function listRetainedOffcutHoldingsForOrderSku(
  serviceOrderId: string,
  sku: string,
  client: PoolClient,
): Promise<JobWorkOffcutHoldingRow[]> {
  // A malformed id is "no rows", not a 22P02 500 (chunk B code review 2026-09-06).
  if (!UUID_REGEX.test(serviceOrderId)) return [];
  const result = await client.query(
    `SELECT ${SELECT_COLUMNS} FROM job_work_offcut_holding
      WHERE service_order_id = $1 AND sku = $2 AND status = 'retained'
      ORDER BY captured_at ASC, holding_id ASC`,
    [serviceOrderId, sku],
  );
  return (result.rows as Record<string, unknown>[]).map(mapRow);
}
