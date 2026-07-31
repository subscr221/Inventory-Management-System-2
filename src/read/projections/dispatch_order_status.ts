import { getPool } from '../../config/db.js';

export interface DispatchOrderStatus {
  dispatch_order_id: string;
  picked_at: string;
  picked_by: string;
  packed_at?: string | null;
  packed_by?: string | null;
  dispatched_at?: string | null;
  dispatched_by?: string | null;
  site_id: string;
  status?: 'picked' | 'packed' | 'documents_generated' | 'dispatched';
}

export async function getDispatchOrderStatus(
  dispatchOrderId: string,
): Promise<DispatchOrderStatus | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT dos.dispatch_order_id, dos.picked_at, dos.picked_by,
            dos.packed_at, dos.packed_by,
            dos.dispatched_at, dos.dispatched_by,
            eso.ship_from_site_id AS site_id
     FROM dispatch_order_status dos
     JOIN erp_sales_order eso ON eso.id = dos.dispatch_order_id
     WHERE dos.dispatch_order_id = $1`,
    [dispatchOrderId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as DispatchOrderStatus;
  // Compute status from the timestamp columns
  if (row.dispatched_at) {
    row.status = 'dispatched';
  } else if (row.packed_at) {
    row.status = 'packed';
  } else if (row.picked_at) {
    row.status = 'picked';
  }
  return row;
}
