import { getPool } from '../../config/db.js';

export interface DispatchOrderStatus {
  dispatch_order_id: string;
  picked_at: string;
  picked_by: string;
  packed_at?: string | null;
  packed_by?: string | null;
  generated_at?: string | null;
  generated_by?: string | null;
  dispatched_at?: string | null;
  dispatched_by?: string | null;
  site_id: string;
}

export async function getDispatchOrderStatus(dispatchOrderId: string): Promise<DispatchOrderStatus | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT dos.dispatch_order_id, dos.picked_at, dos.picked_by,
            dos.packed_at, dos.packed_by, dos.generated_at, dos.generated_by,
            dos.dispatched_at, dos.dispatched_by,
            eso.ship_from_site_id AS site_id
     FROM dispatch_order_status dos
     JOIN erp_sales_order eso ON eso.id = dos.dispatch_order_id
     WHERE dos.dispatch_order_id = $1`,
    [dispatchOrderId],
  );
  if (result.rows.length === 0) return null;
  return result.rows[0] as DispatchOrderStatus;
}