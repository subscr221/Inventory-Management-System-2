import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 9.3 (FR-JW-05, FR-JW-06, FR-JW-07): the per-order custody ledger. One append-only row per
 * movement, SIGNED quantity_delta per sku. The customer-owned running balance is DERIVED from the
 * rows (never stored): SUM(quantity_delta) over ownership = 'customer' rows. Processor-owned
 * own_material rows are billable and excluded from that balance by the predicate below.
 */

export type CustodyMovementCategory =
  | 'receipt'
  | 'consumption'
  | 'return'
  | 'loss'
  | 'offcut'
  | 'dispatch'
  | 'count_adjustment'
  | 'own_material';

export type CustodyOwnership = 'customer' | 'processor';

export interface CustodyLedgerEntryRow {
  entry_id: string;
  service_order_id: string;
  customer_party_code: string;
  movement_category: CustodyMovementCategory;
  ownership: CustodyOwnership;
  sku: string;
  /** The lot_master.lot_number business key (the stock_balance / jobwork_material_receipt grain). */
  lot_id: string | null;
  location_id: string | null;
  quantity_delta: string;
  uom: string;
  billable: boolean;
  bom_line_id: string | null;
  kit_bom_revision_id: string | null;
  receipt_id: string | null;
  variance_qty: string | null;
  variance_flagged: boolean | null;
  site_id: string;
  posted_by: string;
  occurred_at: string;
  business_date: string;
  source_event_id: string;
  source_event_type: string;
  correlation_id: string | null;
  created_at: string;
}

export interface InsertCustodyLedgerEntryInput {
  entry_id: string;
  service_order_id: string;
  customer_party_code: string;
  movement_category: CustodyMovementCategory;
  ownership: CustodyOwnership;
  sku: string;
  lot_id: string | null;
  location_id: string | null;
  quantity_delta: string;
  uom: string;
  billable: boolean;
  bom_line_id: string | null;
  kit_bom_revision_id: string | null;
  receipt_id: string | null;
  variance_qty: string | null;
  variance_flagged: boolean | null;
  site_id: string;
  posted_by: string;
  occurred_at: string;
  business_date: string;
  source_event_id: string;
  source_event_type: string;
  correlation_id: string | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The customer-owned balance predicate (Task 5.3). Exported so a unit test can pin that the
 * balance SQL excludes processor-owned (own_material) rows - the FR-JW-07 exclusion is a WHERE
 * clause, and a WHERE clause silently dropped is the kind of green-but-wrong the 8.4 review caught.
 */
export const CUSTOMER_OWNED_PREDICATE = `ownership = 'customer'`;

/** Statement order (AC 2): occurred_at, then created_at, then entry_id as a total tiebreak. */
export const STATEMENT_ORDER_BY = `ORDER BY occurred_at ASC, created_at ASC, entry_id ASC`;

const SELECT_COLUMNS = `entry_id, service_order_id, customer_party_code, movement_category, ownership,
  sku, lot_id, location_id, quantity_delta::text AS quantity_delta, uom, billable, bom_line_id,
  kit_bom_revision_id, receipt_id, variance_qty::text AS variance_qty, variance_flagged, site_id,
  posted_by, occurred_at, to_char(business_date, 'YYYY-MM-DD') AS business_date, source_event_id,
  source_event_type, correlation_id, created_at`;

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function mapRow(row: Record<string, unknown>): CustodyLedgerEntryRow {
  return {
    ...(row as unknown as CustodyLedgerEntryRow),
    occurred_at: toIso(row['occurred_at']),
    created_at: toIso(row['created_at']),
  };
}

/** Plain INSERT: a duplicate source_event_id or entry_id surfaces as 23505 for the seam to classify. */
export async function insertCustodyLedgerEntry(
  input: InsertCustodyLedgerEntryInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO custody_ledger_entry (
       entry_id, service_order_id, customer_party_code, movement_category, ownership, sku, lot_id,
       location_id, quantity_delta, uom, billable, bom_line_id, kit_bom_revision_id, receipt_id,
       variance_qty, variance_flagged, site_id, posted_by, occurred_at, business_date,
       source_event_id, source_event_type, correlation_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11, $12, $13, $14, $15::numeric,
               $16, $17, $18, $19::timestamptz, $20::date, $21, $22, $23)`,
    [
      input.entry_id,
      input.service_order_id,
      input.customer_party_code,
      input.movement_category,
      input.ownership,
      input.sku,
      input.lot_id,
      input.location_id,
      input.quantity_delta,
      input.uom,
      input.billable,
      input.bom_line_id,
      input.kit_bom_revision_id,
      input.receipt_id,
      input.variance_qty,
      input.variance_flagged,
      input.site_id,
      input.posted_by,
      input.occurred_at,
      input.business_date,
      input.source_event_id,
      input.source_event_type,
      input.correlation_id,
    ],
  );
}

/** Every ledger row for one order in statement order (AC 2). */
export async function listCustodyLedgerByOrder(
  serviceOrderId: string,
  client?: PoolClient,
): Promise<CustodyLedgerEntryRow[]> {
  if (!UUID_REGEX.test(serviceOrderId)) return [];
  const result = await runner(client).query(
    `SELECT ${SELECT_COLUMNS} FROM custody_ledger_entry
      WHERE service_order_id = $1
      ${STATEMENT_ORDER_BY}`,
    [serviceOrderId],
  );
  return result.rows.map((row) => mapRow(row as Record<string, unknown>));
}

/**
 * The customer-owned custody balance for one sku on one order as a NUMERIC(18,3) string. Summed
 * in SQL (never JS float); callers compare with exact scaled-integer arithmetic. Gates call this
 * INSIDE the order advisory lock so the SUM and the drain are one serialized step (AC 4).
 */
export async function customerCustodyBalance(
  serviceOrderId: string,
  sku: string,
  client: PoolClient,
): Promise<string> {
  if (!UUID_REGEX.test(serviceOrderId)) {
    throw new Error(`customerCustodyBalance: invalid serviceOrderId "${serviceOrderId}"`);
  }
  const result = await client.query(
    `SELECT COALESCE(SUM(quantity_delta), 0)::numeric(18,3)::text AS balance
       FROM custody_ledger_entry
      WHERE service_order_id = $1 AND sku = $2 AND ${CUSTOMER_OWNED_PREDICATE}`,
    [serviceOrderId, sku],
  );
  return result.rows[0]!['balance'] as string;
}

export interface CustomerCustodyBalanceRow {
  sku: string;
  uom: string;
  balance: string;
}

/** Closing customer-owned balance per sku for one order (statement closing section). */
export async function customerCustodyBalancesByOrder(
  serviceOrderId: string,
  client?: PoolClient,
): Promise<CustomerCustodyBalanceRow[]> {
  if (!UUID_REGEX.test(serviceOrderId)) return [];
  const result = await runner(client).query(
    `SELECT sku, MIN(uom) AS uom, COALESCE(SUM(quantity_delta), 0)::numeric(18,3)::text AS balance
       FROM custody_ledger_entry
      WHERE service_order_id = $1 AND ${CUSTOMER_OWNED_PREDICATE}
      GROUP BY sku
      ORDER BY sku ASC`,
    [serviceOrderId],
  );
  return result.rows as CustomerCustodyBalanceRow[];
}
