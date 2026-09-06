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
  sku, lot_id, source_lot_id, location_id, quantity::text AS quantity, uom, status, captured_at, business_date,
  disposed_at, disposition, disposal_event_id, site_id, captured_by, source_event_id,
  correlation_id, created_at, updated_at`;

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapRow(row: Record<string, unknown>): JobWorkOffcutHoldingRow {
  return {
    ...(row as unknown as JobWorkOffcutHoldingRow),
    captured_at: toIso(row['captured_at']) as string,
    business_date: String(
      row['business_date'] instanceof Date
        ? (row['business_date'] as Date).toISOString().slice(0, 10)
        : row['business_date'],
    ),
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

export async function getOffcutHoldingById(
  holdingId: string,
  client?: PoolClient,
): Promise<JobWorkOffcutHoldingRow | null> {
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
