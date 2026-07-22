import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * GRN line projection accessor (Story 3.4). NUMERIC columns (received_qty, shortage_variance_qty)
 * are bound and returned as strings, never Number()'d or compared as JS floats. expiry_date is read
 * through to_char(...,'YYYY-MM-DD'). A `rejected` line (AC5 over-tolerance) carries no
 * target_location_id and posted no stock. Lines are append-only with soft status transitions.
 */
export interface GrnLine {
  grn_line_id: string;
  grn_id: string;
  po_ref_ext: string;
  line_no: number;
  sku: string;
  lot_id: string | null;
  expiry_date: string | null;
  received_qty: string;
  uom: string;
  stock_class: string;
  weighbridge_correlation_id: string;
  qc_hold: boolean;
  shortage_variance_qty: string;
  target_location_id: string | null;
  status: 'posted' | 'quarantined' | 'rejected';
  rejection_reason: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface InsertGrnLineInput {
  grn_line_id: string;
  grn_id: string;
  po_ref_ext: string;
  line_no: number;
  sku: string;
  lot_id?: string | null;
  expiry_date?: string | null;
  received_qty: string;
  uom: string;
  stock_class?: string;
  weighbridge_correlation_id: string;
  qc_hold?: boolean;
  shortage_variance_qty?: string;
  target_location_id?: string | null;
  status?: 'posted' | 'quarantined' | 'rejected';
  rejection_reason?: string | null;
  source_event_id: string;
}

export interface ListDiscrepancyLinesFilters {
  siteId?: string | null;
  siteAny?: string[] | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function ts(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function grnLineColumns(prefix = ''): string {
  const p = prefix;
  return `${p}grn_line_id, ${p}grn_id, ${p}po_ref_ext, ${p}line_no, ${p}sku, ${p}lot_id,
       to_char(${p}expiry_date, 'YYYY-MM-DD') AS expiry_date, ${p}received_qty::text AS received_qty, ${p}uom,
       ${p}stock_class, ${p}weighbridge_correlation_id, ${p}qc_hold,
       ${p}shortage_variance_qty::text AS shortage_variance_qty, ${p}target_location_id, ${p}status,
       ${p}rejection_reason, ${p}source_event_id, ${p}created_at, ${p}updated_at`;
}

const GRN_LINE_COLUMNS = grnLineColumns();

function mapRow(row: Record<string, unknown>): GrnLine {
  return {
    grn_line_id: row['grn_line_id'] as string,
    grn_id: row['grn_id'] as string,
    po_ref_ext: row['po_ref_ext'] as string,
    line_no: Number(row['line_no']),
    sku: row['sku'] as string,
    lot_id: (row['lot_id'] as string | null) ?? null,
    expiry_date: (row['expiry_date'] as string | null) ?? null,
    received_qty: String(row['received_qty']),
    uom: row['uom'] as string,
    stock_class: row['stock_class'] as string,
    weighbridge_correlation_id: row['weighbridge_correlation_id'] as string,
    qc_hold: row['qc_hold'] === true,
    shortage_variance_qty: String(row['shortage_variance_qty']),
    target_location_id: (row['target_location_id'] as string | null) ?? null,
    status: row['status'] as GrnLine['status'],
    rejection_reason: (row['rejection_reason'] as string | null) ?? null,
    source_event_id: row['source_event_id'] as string,
    created_at: ts(row['created_at']),
    updated_at: ts(row['updated_at']),
  };
}

export async function getGrnLineById(grnLineId: string, client?: PoolClient): Promise<GrnLine | null> {
  const result = await runner(client).query(`SELECT ${GRN_LINE_COLUMNS} FROM grn_line WHERE grn_line_id = $1`, [grnLineId]);
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function listGrnLinesByGrn(grnId: string, client?: PoolClient): Promise<GrnLine[]> {
  const result = await runner(client).query(
    `SELECT ${GRN_LINE_COLUMNS} FROM grn_line WHERE grn_id = $1 ORDER BY line_no, created_at`,
    [grnId],
  );
  return result.rows.map(mapRow);
}

/**
 * The receiving discrepancy view (AC5/AC6): every line with a short-receipt shortage variance or a
 * quarantined status, optionally scoped to a site by joining the header. rejected over-tolerance
 * lines are also surfaced (rejection_reason carries the breach detail).
 */
export async function listDiscrepancyLines(filters: ListDiscrepancyLinesFilters = {}, client?: PoolClient): Promise<GrnLine[]> {
  const clauses: string[] = [`(l.shortage_variance_qty > 0 OR l.status IN ('quarantined', 'rejected'))`];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    clauses.push(sql.replace('?', `$${values.length}`));
  };
  if (filters.siteId) add('h.site_id = ?', filters.siteId);
  if (filters.siteAny !== undefined && filters.siteAny !== null) add('h.site_id = ANY(?::uuid[])', filters.siteAny);
  const result = await runner(client).query(
    `SELECT ${grnLineColumns('l.')} FROM grn_line l JOIN grn h ON h.grn_id = l.grn_id
      WHERE ${clauses.join(' AND ')} ORDER BY l.created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

/** Idempotent, replay-safe upsert keyed on grn_line_id. NUMERIC values bound as strings. */
export async function insertGrnLine(input: InsertGrnLineInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO grn_line
       (grn_line_id, grn_id, po_ref_ext, line_no, sku, lot_id, expiry_date, received_qty, uom,
        stock_class, weighbridge_correlation_id, qc_hold, shortage_variance_qty, target_location_id,
        status, rejection_reason, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, $12, $13::numeric, $14, $15, $16, $17)
     ON CONFLICT (grn_line_id) DO UPDATE SET
       grn_id = EXCLUDED.grn_id,
       po_ref_ext = EXCLUDED.po_ref_ext,
       line_no = EXCLUDED.line_no,
       sku = EXCLUDED.sku,
       lot_id = EXCLUDED.lot_id,
       expiry_date = EXCLUDED.expiry_date,
       received_qty = EXCLUDED.received_qty,
       uom = EXCLUDED.uom,
       stock_class = EXCLUDED.stock_class,
       weighbridge_correlation_id = EXCLUDED.weighbridge_correlation_id,
       qc_hold = EXCLUDED.qc_hold,
       shortage_variance_qty = EXCLUDED.shortage_variance_qty,
       target_location_id = EXCLUDED.target_location_id,
       status = EXCLUDED.status,
       rejection_reason = EXCLUDED.rejection_reason,
       source_event_id = EXCLUDED.source_event_id,
       updated_at = now()`,
    [
      input.grn_line_id,
      input.grn_id,
      input.po_ref_ext,
      input.line_no,
      input.sku,
      input.lot_id ?? null,
      input.expiry_date ?? null,
      input.received_qty,
      input.uom,
      input.stock_class ?? 'owned',
      input.weighbridge_correlation_id,
      input.qc_hold ?? false,
      input.shortage_variance_qty ?? '0',
      input.target_location_id ?? null,
      input.status ?? 'posted',
      input.rejection_reason ?? null,
      input.source_event_id,
    ],
  );
}
