import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * ERP open sales-order (dispatch-demand) reference projection accessor (Story 2.9). Reference data
 * ONLY: NOT event-sourced. The upsert helper is used exclusively by the ERP sync adapter via direct
 * SQL upsert; ERP remains master. Site identity is dual-namespace: ship_from_site_code_ext preserves
 * the ERP/API code ('site-A') honored by the public ?site= filter, while ship_from_site_id is the
 * internal location_register.location_id UUID used for RBAC. Both predicates apply when present.
 * required_by is read through to_char(...,'YYYY-MM-DD'); quantity maps through Number() on read and
 * binds as a string on write to preserve NUMERIC precision.
 */

export interface ErpSalesOrderRow {
  so_number_ext: string;
  line_no: number;
  sku: string;
  quantity: number;
  required_by: string | null;
  ship_to_ext: string | null;
  ship_from_site_id: string;
  ship_from_site_code_ext: string;
  status: string;
  source_system: string;
  last_synced_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function ts(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

const COLUMNS = `so_number_ext, line_no, sku, quantity,
       to_char(required_by, 'YYYY-MM-DD') AS required_by,
       ship_to_ext, ship_from_site_id, ship_from_site_code_ext, status, source_system, last_synced_at`;

function mapRow(row: Record<string, unknown>): ErpSalesOrderRow {
  return {
    so_number_ext: row['so_number_ext'] as string,
    line_no: Number(row['line_no']),
    sku: row['sku'] as string,
    quantity: Number(row['quantity']),
    required_by: (row['required_by'] as string | null) ?? null,
    ship_to_ext: (row['ship_to_ext'] as string | null) ?? null,
    ship_from_site_id: row['ship_from_site_id'] as string,
    ship_from_site_code_ext: row['ship_from_site_code_ext'] as string,
    status: row['status'] as string,
    source_system: row['source_system'] as string,
    last_synced_at: ts(row['last_synced_at']),
  };
}

export interface SalesOrderFilters {
  ship_from_site_code_ext?: string | null;
  status?: string | null;
  /** Site UUIDs the caller may read (from RBAC). Null/undefined = no location restriction. */
  location_any?: string[] | null;
}

export async function listSalesOrders(filters: SalesOrderFilters, client?: PoolClient): Promise<ErpSalesOrderRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (filters.ship_from_site_code_ext) {
    conditions.push(`ship_from_site_code_ext = $${i++}`);
    params.push(filters.ship_from_site_code_ext);
  }
  if (filters.location_any && filters.location_any.length > 0) {
    conditions.push(`ship_from_site_id = ANY($${i++})`);
    params.push(filters.location_any);
  }
  if (filters.status) {
    conditions.push(`status = $${i++}`);
    params.push(filters.status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM erp_sales_order ${where} ORDER BY so_number_ext, line_no`,
    params,
  );
  return result.rows.map(mapRow);
}

// ---------------------------------------------------------------------------
// Adapter-only mutation helpers (direct SQL upsert; NOT event-sourced)
// ---------------------------------------------------------------------------

export interface UpsertSalesOrderLineInput {
  so_number_ext: string;
  line_no: number;
  sku: string;
  quantity: number;
  required_by?: string | null;
  ship_to_ext?: string | null;
  ship_from_site_id: string;
  ship_from_site_code_ext: string;
  source_snapshot?: unknown;
}

/** Upserts a SO line by (so_number_ext, line_no). source_system/last_synced_at are server-set. */
export async function upsertSalesOrderLine(input: UpsertSalesOrderLineInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO erp_sales_order
       (so_number_ext, line_no, sku, quantity, required_by, ship_to_ext, ship_from_site_id,
        ship_from_site_code_ext, status, source_system, last_synced_at, source_snapshot)
     VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8, 'open', 'ERP', now(), $9::jsonb)
     ON CONFLICT (so_number_ext, line_no) DO UPDATE SET
       sku = EXCLUDED.sku,
       quantity = EXCLUDED.quantity,
       required_by = EXCLUDED.required_by,
       ship_to_ext = EXCLUDED.ship_to_ext,
       ship_from_site_id = EXCLUDED.ship_from_site_id,
       ship_from_site_code_ext = EXCLUDED.ship_from_site_code_ext,
       status = 'open',
       source_system = 'ERP',
       last_synced_at = now(),
       source_snapshot = EXCLUDED.source_snapshot,
       updated_at = now()`,
    [
      input.so_number_ext,
      input.line_no,
      input.sku,
      String(input.quantity),
      input.required_by ?? null,
      input.ship_to_ext ?? null,
      input.ship_from_site_id,
      input.ship_from_site_code_ext,
      input.source_snapshot === undefined ? null : JSON.stringify(input.source_snapshot),
    ],
  );
}

/**
 * Soft-closes every open SO line whose (so_number_ext, line_no) is NOT in the present feed
 * (status = 'closed', never hard-delete). The present set is passed as two parallel arrays and
 * compared as a composite tuple (never string-concatenated) so a so_number_ext containing the old
 * ':' delimiter can never collide with another line's key. Callers gate this on a non-empty applied
 * batch; an empty present set closes all currently-open lines.
 */
export async function closeSalesOrdersNotIn(presentSoNumbers: string[], presentLineNos: number[], client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE erp_sales_order SET status = 'closed', updated_at = now()
     WHERE status = 'open'
       AND (so_number_ext, line_no) NOT IN (SELECT so_number_ext, line_no FROM unnest($1::text[], $2::int[]) AS t(so_number_ext, line_no))`,
    [presentSoNumbers, presentLineNos],
  );
}
