import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/** One row per customer-material GRN line received against a job-work service order (Story 9.2). */
export interface JobworkMaterialReceiptRow {
  receipt_id: string;
  service_order_id: string;
  grn_line_id: string;
  challan_number_ext: string;
  challan_date: string;
  sku: string;
  lot_id: string | null;
  received_qty: string;
  challan_qty: string;
  uom: string;
  variance_qty: string;
  variance_flagged: boolean;
  received_by: string;
  site_id: string;
  correlation_id: string | null;
  source_event_id: string;
  created_at: string;
  /** Story 9.5 (Binding decision 7): the Section 143 challan class; defaults to 'input'. */
  challan_class: 'input' | 'capital_goods';
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// challan_date round-trips as a DATE; select it as text so callers never see a JS Date shifted
// through the local timezone (the Story 9.1 DATE-vs-timezone gotcha).
const SELECT_COLUMNS = `receipt_id, service_order_id, grn_line_id, challan_number_ext,
  to_char(challan_date, 'YYYY-MM-DD') AS challan_date, sku, lot_id,
  received_qty::text AS received_qty, challan_qty::text AS challan_qty, uom,
  variance_qty::text AS variance_qty, variance_flagged, received_by, site_id, correlation_id,
  source_event_id, created_at, challan_class`;

export interface InsertJobworkMaterialReceiptInput {
  receipt_id: string;
  service_order_id: string;
  grn_line_id: string;
  challan_number_ext: string;
  challan_date: string;
  sku: string;
  lot_id: string | null;
  received_qty: string;
  challan_qty: string;
  uom: string;
  variance_qty: string;
  variance_flagged: boolean;
  received_by: string;
  site_id: string;
  correlation_id: string | null;
  source_event_id: string;
  challan_class: 'input' | 'capital_goods';
}

/** Plain INSERT: a duplicate receipt_id or grn_line_id surfaces as 23505 for the seam to classify. */
export async function insertJobworkMaterialReceipt(
  input: InsertJobworkMaterialReceiptInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO jobwork_material_receipt (
       receipt_id, service_order_id, grn_line_id, challan_number_ext, challan_date, sku, lot_id,
       received_qty, challan_qty, uom, variance_qty, variance_flagged, received_by, site_id,
       correlation_id, source_event_id, challan_class
     ) VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8::numeric, $9::numeric, $10, $11::numeric, $12, $13, $14, $15, $16, $17)`,
    [
      input.receipt_id,
      input.service_order_id,
      input.grn_line_id,
      input.challan_number_ext,
      input.challan_date,
      input.sku,
      input.lot_id,
      input.received_qty,
      input.challan_qty,
      input.uom,
      input.variance_qty,
      input.variance_flagged,
      input.received_by,
      input.site_id,
      input.correlation_id,
      input.source_event_id,
      input.challan_class,
    ],
  );
}

export async function getJobworkMaterialReceiptById(
  receiptId: string,
  client?: PoolClient,
): Promise<JobworkMaterialReceiptRow | null> {
  if (!UUID_REGEX.test(receiptId)) return null;
  const result = await runner(client).query(
    `SELECT ${SELECT_COLUMNS} FROM jobwork_material_receipt WHERE receipt_id = $1`,
    [receiptId],
  );
  return (result.rows[0] as JobworkMaterialReceiptRow) ?? null;
}

export async function getJobworkMaterialReceiptByGrnLine(
  grnLineId: string,
  client?: PoolClient,
): Promise<JobworkMaterialReceiptRow | null> {
  if (!UUID_REGEX.test(grnLineId)) return null;
  const result = await runner(client).query(
    `SELECT ${SELECT_COLUMNS} FROM jobwork_material_receipt WHERE grn_line_id = $1`,
    [grnLineId],
  );
  return (result.rows[0] as JobworkMaterialReceiptRow) ?? null;
}

/** Receipts for one order, oldest first (the order the Story 9.3 custody statement renders). */
export async function listJobworkMaterialReceiptsByOrder(
  serviceOrderId: string,
  client?: PoolClient,
): Promise<JobworkMaterialReceiptRow[]> {
  if (!UUID_REGEX.test(serviceOrderId)) return [];
  const result = await runner(client).query(
    `SELECT ${SELECT_COLUMNS} FROM jobwork_material_receipt
      WHERE service_order_id = $1
      ORDER BY created_at ASC, receipt_id ASC`,
    [serviceOrderId],
  );
  return result.rows as JobworkMaterialReceiptRow[];
}
