import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * ERP open purchase-order reference projection accessor (Story 2.9). Reference data ONLY: unlike
 * every other Epic 2 read model this projection is NOT event-sourced. The upsert helpers below are
 * used exclusively by the ERP sync adapter (src/adapters/erp/sync.ts) via DIRECT SQL upsert, never
 * through persistEvent; ERP remains the master for PO lifecycle. source_system is server-set to
 * 'ERP' and last_synced_at to now() on every write - never trusted from the source payload. DATE
 * columns are read through to_char(...,'YYYY-MM-DD') so a DATE never round-trips through a JS Date
 * (the date.timezone_format_local_ymd constraint). NUMERIC columns map through Number() at the read
 * boundary and are bound as strings on write to preserve precision (never JS-float rounded).
 */

export interface ErpPurchaseOrderLineRow {
  po_number_ext: string;
  line_no: number;
  sku: string;
  ordered_qty: number;
  open_qty: number;
  unit_price: number;
  over_receipt_tolerance_pct: number | null;
  under_receipt_tolerance_pct: number | null;
  source_system: string;
  last_synced_at: string;
}

export interface ErpPurchaseOrderHeaderRow {
  po_number_ext: string;
  supplier_ref_ext: string;
  currency: string;
  expected_delivery_date: string | null;
  status: string;
  source_system: string;
  last_synced_at: string;
}

export interface ErpPurchaseOrder extends ErpPurchaseOrderHeaderRow {
  lines: ErpPurchaseOrderLineRow[];
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function ts(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function num(value: unknown): number {
  return Number(value);
}

function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

const HEADER_COLUMNS = `po_number_ext, supplier_ref_ext, currency,
       to_char(expected_delivery_date, 'YYYY-MM-DD') AS expected_delivery_date,
       status, source_system, last_synced_at`;

const LINE_COLUMNS = `po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price,
       over_receipt_tolerance_pct, under_receipt_tolerance_pct, source_system, last_synced_at`;

function mapHeader(row: Record<string, unknown>): ErpPurchaseOrderHeaderRow {
  return {
    po_number_ext: row['po_number_ext'] as string,
    supplier_ref_ext: row['supplier_ref_ext'] as string,
    currency: row['currency'] as string,
    expected_delivery_date: (row['expected_delivery_date'] as string | null) ?? null,
    status: row['status'] as string,
    source_system: row['source_system'] as string,
    last_synced_at: ts(row['last_synced_at']),
  };
}

function mapLine(row: Record<string, unknown>): ErpPurchaseOrderLineRow {
  return {
    po_number_ext: row['po_number_ext'] as string,
    line_no: num(row['line_no']),
    sku: row['sku'] as string,
    ordered_qty: num(row['ordered_qty']),
    open_qty: num(row['open_qty']),
    unit_price: num(row['unit_price']),
    over_receipt_tolerance_pct: numOrNull(row['over_receipt_tolerance_pct']),
    under_receipt_tolerance_pct: numOrNull(row['under_receipt_tolerance_pct']),
    source_system: row['source_system'] as string,
    last_synced_at: ts(row['last_synced_at']),
  };
}

/** The PO header plus its lines (single-header, multi-line assembly), or null when unknown. */
export async function getPurchaseOrderByRef(poNumberExt: string, client?: PoolClient): Promise<ErpPurchaseOrder | null> {
  const q = runner(client);
  const headerResult = await q.query(
    `SELECT ${HEADER_COLUMNS} FROM erp_purchase_order WHERE po_number_ext = $1`,
    [poNumberExt],
  );
  if (headerResult.rows.length === 0) return null;
  const header = mapHeader(headerResult.rows[0]!);
  const lineResult = await q.query(
    `SELECT ${LINE_COLUMNS} FROM erp_purchase_order_line WHERE po_number_ext = $1 ORDER BY line_no`,
    [poNumberExt],
  );
  return { ...header, lines: lineResult.rows.map(mapLine) };
}

// ---------------------------------------------------------------------------
// Adapter-only mutation helpers (direct SQL upsert; NOT event-sourced)
// ---------------------------------------------------------------------------

export interface UpsertPurchaseOrderHeaderInput {
  po_number_ext: string;
  supplier_ref_ext: string;
  currency: string;
  expected_delivery_date?: string | null;
  source_snapshot?: unknown;
}

/**
 * Upserts a PO header by po_number_ext. A PO present in the open feed is (re-)opened. source_system
 * and last_synced_at are server-set. ON CONFLICT keeps re-syncing an unchanged PO idempotent.
 */
export async function upsertPurchaseOrderHeader(input: UpsertPurchaseOrderHeaderInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO erp_purchase_order
       (po_number_ext, supplier_ref_ext, currency, expected_delivery_date, status, source_system, last_synced_at, source_snapshot)
     VALUES ($1, $2, $3, $4, 'open', 'ERP', now(), $5::jsonb)
     ON CONFLICT (po_number_ext) DO UPDATE SET
       supplier_ref_ext = EXCLUDED.supplier_ref_ext,
       currency = EXCLUDED.currency,
       expected_delivery_date = EXCLUDED.expected_delivery_date,
       status = 'open',
       source_system = 'ERP',
       last_synced_at = now(),
       source_snapshot = EXCLUDED.source_snapshot,
       updated_at = now()`,
    [
      input.po_number_ext,
      input.supplier_ref_ext,
      input.currency,
      input.expected_delivery_date ?? null,
      input.source_snapshot === undefined ? null : JSON.stringify(input.source_snapshot),
    ],
  );
}

export interface UpsertPurchaseOrderLineInput {
  po_number_ext: string;
  line_no: number;
  sku: string;
  ordered_qty: number;
  open_qty: number;
  unit_price: number;
  over_receipt_tolerance_pct?: number | null;
  under_receipt_tolerance_pct?: number | null;
}

/** Upserts a PO line by (po_number_ext, line_no). Numeric values bound as strings for precision. */
export async function upsertPurchaseOrderLine(input: UpsertPurchaseOrderLineInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO erp_purchase_order_line
       (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price,
        over_receipt_tolerance_pct, under_receipt_tolerance_pct, source_system, last_synced_at)
     VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6::numeric, $7::numeric, $8::numeric, 'ERP', now())
     ON CONFLICT (po_number_ext, line_no) DO UPDATE SET
       sku = EXCLUDED.sku,
       ordered_qty = EXCLUDED.ordered_qty,
       open_qty = EXCLUDED.open_qty,
       unit_price = EXCLUDED.unit_price,
       over_receipt_tolerance_pct = EXCLUDED.over_receipt_tolerance_pct,
       under_receipt_tolerance_pct = EXCLUDED.under_receipt_tolerance_pct,
       source_system = 'ERP',
       last_synced_at = now(),
       updated_at = now()`,
    [
      input.po_number_ext,
      input.line_no,
      input.sku,
      String(input.ordered_qty),
      String(input.open_qty),
      String(input.unit_price),
      input.over_receipt_tolerance_pct === undefined || input.over_receipt_tolerance_pct === null ? null : String(input.over_receipt_tolerance_pct),
      input.under_receipt_tolerance_pct === undefined || input.under_receipt_tolerance_pct === null ? null : String(input.under_receipt_tolerance_pct),
    ],
  );
}

/**
 * Soft-closes every open PO whose po_number_ext is NOT in the present feed (status = 'closed', never
 * hard-delete) so downstream receipts referencing a closed PO still resolve; ERP stays master.
 * An empty present list closes all currently-open POs.
 */
export async function closePurchaseOrdersNotIn(presentPoNumbers: string[], client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE erp_purchase_order SET status = 'closed', updated_at = now()
     WHERE status = 'open' AND po_number_ext <> ALL($1::text[])`,
    [presentPoNumbers],
  );
}
