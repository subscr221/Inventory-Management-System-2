import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 3.18 (AC 2): the pack station list read. `getDispatchOrderStatus` (dispatch_order_status.ts)
 * derives `status` from timestamps only and does not know `documents_generated`; this accessor
 * derives the four-way stage the pack screen groups on, from timestamps plus a document-existence
 * sub-select plus the IRN coverage LEFT JOIN. Quantities stay NUMERIC strings (never JS floats).
 */

export type DispatchStage = 'picked' | 'packed' | 'documents_generated' | 'dispatched';

export interface DispatchListRow {
  dispatch_order_id: string;
  so_number_ext: string;
  line_no: number;
  ship_to_ext: string | null;
  sku: string;
  quantity: string;
  picked_at: string;
  packed_at: string | null;
  dispatched_at: string | null;
  stage: DispatchStage;
  irn_recorded: boolean;
}

const STAGES: readonly DispatchStage[] = ['picked', 'packed', 'documents_generated', 'dispatched'];

function stageFor(row: {
  dispatched_at: string | null;
  packed_at: string | null;
  has_documents: boolean;
}): DispatchStage {
  if (row.dispatched_at) return 'dispatched';
  if (row.has_documents) return 'documents_generated';
  if (row.packed_at) return 'packed';
  return 'picked';
}

export async function listDispatchOrders(
  siteId: string,
  stage?: DispatchStage | null,
  client?: PoolClient,
): Promise<DispatchListRow[]> {
  const pool = client ?? getPool();
  const result = await pool.query(
    `SELECT dos.dispatch_order_id,
            eso.so_number_ext,
            eso.line_no,
            eso.ship_to_ext,
            eso.sku,
            eso.quantity::text AS quantity,
            dos.picked_at,
            dos.packed_at,
            dos.dispatched_at,
            (di.dispatch_order_id IS NOT NULL) AS irn_recorded,
            EXISTS (
              SELECT 1 FROM dispatch_document dd
              WHERE dd.dispatch_order_id = dos.dispatch_order_id
            ) AS has_documents
       FROM dispatch_order_status dos
       JOIN erp_sales_order eso ON eso.id = dos.dispatch_order_id
       LEFT JOIN dispatch_irn di ON di.dispatch_order_id = dos.dispatch_order_id
       WHERE eso.ship_from_site_id = $1
      ORDER BY dos.picked_at ASC, eso.so_number_ext, eso.line_no`,
    [siteId],
  );
  const rows = result.rows.map((row) => {
    const base = {
      dispatch_order_id: row['dispatch_order_id'] as string,
      so_number_ext: row['so_number_ext'] as string,
      line_no: Number(row['line_no']),
      ship_to_ext: (row['ship_to_ext'] as string | null) ?? null,
      sku: row['sku'] as string,
      quantity: String(row['quantity']),
      picked_at: row['picked_at'] as string,
      packed_at: (row['packed_at'] as string | null) ?? null,
      dispatched_at: (row['dispatched_at'] as string | null) ?? null,
      irn_recorded: (row['irn_recorded'] as boolean) === true,
    };
    const stageValue = stageFor({
      ...base,
      has_documents: (row['has_documents'] as boolean) === true,
    });
    return { ...base, stage: stageValue };
  });
  // AC 3: the "Dispatched today" group is today's dispatches only; older dispatched orders are out
  // of the queue. Filter on the local calendar day (the repo's date.timezone_format_local_ymd rule).
  const todayLocal = localYmd(new Date());
  const visible = rows.filter(
    (row) =>
      row.stage !== 'dispatched' || localYmd(new Date(row.dispatched_at as string)) === todayLocal,
  );
  return stage ? visible.filter((row) => row.stage === stage) : visible;
}

/** Local calendar Y-M-D (server-local getters, matching the repo's business-date convention). */
function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** The four legal `?stage=` filter values, exported for the route's validation. */
export const DISPATCH_LIST_STAGES: readonly DispatchStage[] = STAGES;
