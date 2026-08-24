import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/** Story 7.2 accessors for the maintenance work order register (FR-M-02). */
export interface MaintenanceWorkOrderRow {
  work_order_id: string;
  plan_id: string | null;
  asset_id: string;
  origin: 'preventive' | 'breakdown';
  due_date: string;
  grace_until_date: string;
  status: 'open' | 'overdue' | 'completed';
  generated_for_cycle: string;
  completed_at: string | null;
  completed_by: string | null;
  overdue_at: string | null;
  escalated_at: string | null;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DATE columns are rendered as text so a work order serializes to a stable YYYY-MM-DD.
const WORK_ORDER_COLUMNS = `work_order_id, plan_id, asset_id, origin,
    to_char(due_date, 'YYYY-MM-DD') AS due_date,
    to_char(grace_until_date, 'YYYY-MM-DD') AS grace_until_date,
    status, generated_for_cycle, completed_at, completed_by, overdue_at, escalated_at,
    created_at, updated_at`;

export async function getWorkOrderById(
  workOrderId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<MaintenanceWorkOrderRow | null> {
  if (!UUID_REGEX.test(workOrderId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT ${WORK_ORDER_COLUMNS} FROM maintenance_work_order WHERE work_order_id = $1${lockClause}`,
    [workOrderId],
  );
  return (result.rows[0] as MaintenanceWorkOrderRow) ?? null;
}

/** The anti-double-generation lookup: one work order per (plan, cycle). */
export async function getWorkOrderByCycle(
  planId: string,
  cycleKey: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<MaintenanceWorkOrderRow | null> {
  if (!UUID_REGEX.test(planId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  // The explicit plan_id IS NOT NULL makes the partial unique index
  // (uq_maintenance_work_order_cycle ... WHERE plan_id IS NOT NULL) provable to the planner;
  // with only plan_id = $1 the predicate cannot be inferred from a parameter.
  const result = await r.query(
    `SELECT ${WORK_ORDER_COLUMNS} FROM maintenance_work_order
      WHERE plan_id IS NOT NULL AND plan_id = $1 AND generated_for_cycle = $2${lockClause}`,
    [planId, cycleKey],
  );
  return (result.rows[0] as MaintenanceWorkOrderRow) ?? null;
}

export interface InsertMaintenanceWorkOrderRow {
  work_order_id: string;
  plan_id: string | null;
  asset_id: string;
  origin: 'preventive' | 'breakdown';
  due_date: string;
  grace_until_date: string;
  generated_for_cycle: string;
  created_at: string;
  updated_at: string;
}

export async function insertWorkOrder(
  row: InsertMaintenanceWorkOrderRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO maintenance_work_order (
      work_order_id, plan_id, asset_id, origin, due_date, grace_until_date,
      status, generated_for_cycle, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9)`,
    [
      row.work_order_id,
      row.plan_id,
      row.asset_id,
      row.origin,
      row.due_date,
      row.grace_until_date,
      row.generated_for_cycle,
      row.created_at,
      row.updated_at,
    ],
  );
}

export async function setWorkOrderCompleted(
  workOrderId: string,
  completedAt: string,
  completedBy: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE maintenance_work_order
        SET status = 'completed',
            completed_at = $2,
            completed_by = $3,
            updated_at = now()
      WHERE work_order_id = $1`,
    [workOrderId, completedAt, completedBy],
  );
}

export async function setWorkOrderOverdue(
  workOrderId: string,
  overdueAt: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE maintenance_work_order
        SET status = 'overdue',
            overdue_at = $2,
            escalated_at = $2,
            updated_at = now()
      WHERE work_order_id = $1`,
    [workOrderId, overdueAt],
  );
}

export interface ListWorkOrdersParams {
  asset_id?: string | undefined;
  plan_id?: string | undefined;
  status?: 'open' | 'overdue' | 'completed' | undefined;
  due_before?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listWorkOrders(
  params: ListWorkOrdersParams,
  client?: PoolClient,
): Promise<MaintenanceWorkOrderRow[]> {
  const r = runner(client);
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;

  if (params.asset_id) {
    if (!UUID_REGEX.test(params.asset_id)) return [];
    conditions.push(`asset_id = $${idx++}`);
    values.push(params.asset_id);
  }
  if (params.plan_id) {
    if (!UUID_REGEX.test(params.plan_id)) return [];
    conditions.push(`plan_id = $${idx++}`);
    values.push(params.plan_id);
  }
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.due_before) {
    // Guard like the UUID filters: an unparseable date would surface as an unmapped 22007 500.
    if (Number.isNaN(Date.parse(params.due_before))) return [];
    conditions.push(`due_date < $${idx++}::date`);
    values.push(params.due_before);
  }

  const limit = Number.isFinite(params.limit ?? 100)
    ? Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 500)
    : 100;
  const offset = Number.isFinite(params.offset ?? 0)
    ? Math.max(Math.trunc(params.offset ?? 0), 0)
    : 0;
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await r.query(
    `SELECT ${WORK_ORDER_COLUMNS} FROM maintenance_work_order ${where}
      ORDER BY due_date ASC, work_order_id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as MaintenanceWorkOrderRow[];
}

/**
 * AC 2: work orders still open after their grace window closed, as of the job's business_date.
 * Filtering on status = 'open' is what makes the sweep re-runnable - an already-escalated work
 * order is 'overdue' and never reappears.
 */
export async function listGraceExpiredWorkOrders(
  businessDate: string,
  client?: PoolClient,
  assetId?: string,
): Promise<MaintenanceWorkOrderRow[]> {
  const r = runner(client);
  const assetFilter = assetId ? ' AND asset_id = $2' : '';
  const values: string[] = assetId ? [businessDate, assetId] : [businessDate];
  const result = await r.query(
    `SELECT ${WORK_ORDER_COLUMNS} FROM maintenance_work_order
      WHERE status = 'open' AND grace_until_date < $1::date${assetFilter}
      ORDER BY due_date ASC, work_order_id ASC`,
    values,
  );
  return result.rows as MaintenanceWorkOrderRow[];
}
