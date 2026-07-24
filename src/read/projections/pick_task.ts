import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Pick task projection accessor (Story 3.6). One task per dispatch-order line (single/wave), per
 * (sku, zone) group (batch), or per zone (zone strategy). dispatch_order_id is the Story 2.9
 * erp_sales_order.id surrogate UUID. Quantities are bound/returned as NUMERIC strings, never JS
 * floats. Site scope resolves through the erp_sales_order join (ship_from_site_id).
 */
export interface PickTask {
  pick_task_id: string;
  dispatch_order_id: string;
  sku: string;
  total_quantity: string;
  strategy: 'single' | 'batch' | 'wave' | 'zone';
  wave_id: string | null;
  batch_id: string | null;
  zone_id: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  assigned_to: string | null;
  created_by: string;
  created_at: string;
  completed_at: string | null;
  completed_by: string | null;
  updated_at: string;
}

export interface CreatePickTaskInput {
  pick_task_id: string;
  dispatch_order_id: string;
  sku: string;
  total_quantity: string;
  strategy: 'single' | 'batch' | 'wave' | 'zone';
  wave_id?: string | null;
  batch_id?: string | null;
  zone_id: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  created_by: string;
}

export interface ListPickTasksFilters {
  siteId?: string | null;
  siteAny?: string[] | null;
  status?: 'pending' | 'in_progress' | 'completed' | 'cancelled' | null;
  assignedTo?: string | null;
  zoneId?: string | null;
  waveId?: string | null;
  batchId?: string | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function ts(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

const PICK_TASK_COLUMNS = `pick_task_id, dispatch_order_id, sku, total_quantity::text AS total_quantity,
       strategy, wave_id, batch_id, zone_id, status, assigned_to, created_by, created_at,
       completed_at, completed_by, updated_at`;

function mapRow(row: Record<string, unknown>): PickTask {
  return {
    pick_task_id: row['pick_task_id'] as string,
    dispatch_order_id: row['dispatch_order_id'] as string,
    sku: row['sku'] as string,
    total_quantity: String(row['total_quantity']),
    strategy: row['strategy'] as PickTask['strategy'],
    wave_id: (row['wave_id'] as string | null) ?? null,
    batch_id: (row['batch_id'] as string | null) ?? null,
    zone_id: row['zone_id'] as string,
    status: row['status'] as PickTask['status'],
    assigned_to: (row['assigned_to'] as string | null) ?? null,
    created_by: row['created_by'] as string,
    created_at: ts(row['created_at']),
    completed_at: row['completed_at'] ? ts(row['completed_at']) : null,
    completed_by: (row['completed_by'] as string | null) ?? null,
    updated_at: ts(row['updated_at']),
  };
}

export async function getPickTaskById(pickTaskId: string, client?: PoolClient): Promise<PickTask | null> {
  const result = await runner(client).query(`SELECT ${PICK_TASK_COLUMNS} FROM pick_task WHERE pick_task_id = $1`, [pickTaskId]);
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

/** Idempotent, replay-safe insert keyed on pick_task_id. total_quantity bound as a NUMERIC string. */
export async function createPickTask(input: CreatePickTaskInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO pick_task
       (pick_task_id, dispatch_order_id, sku, total_quantity, strategy, wave_id, batch_id, zone_id,
        status, created_by)
     VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (pick_task_id) DO NOTHING`,
    [
      input.pick_task_id,
      input.dispatch_order_id,
      input.sku,
      input.total_quantity,
      input.strategy,
      input.wave_id ?? null,
      input.batch_id ?? null,
      input.zone_id,
      input.status ?? 'pending',
      input.created_by,
    ],
  );
}

/** Idempotent status update; returns false (no-op) when the task does not exist. */
export async function updatePickTaskStatus(
  pickTaskId: string,
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled',
  completedBy: string | null,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE pick_task
        SET status = $2,
            completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END,
            completed_by = CASE WHEN $2 = 'completed' THEN $3 ELSE completed_by END,
            updated_at = now()
      WHERE pick_task_id = $1`,
    [pickTaskId, status, completedBy],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Idempotent operator assignment; returns false (no-op) when the task does not exist. */
export async function assignPickTask(pickTaskId: string, assignedTo: string, client: PoolClient): Promise<boolean> {
  const result = await client.query(
    `UPDATE pick_task SET assigned_to = $2, updated_at = now() WHERE pick_task_id = $1`,
    [pickTaskId, assignedTo],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Filtered list; site scope resolves through the Story 2.9 sales-order projection join. */
export async function listPickTasks(filters: ListPickTasksFilters = {}, client?: PoolClient): Promise<PickTask[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    clauses.push(sql.replace('?', `$${values.length}`));
  };
  if (filters.siteId) add('eso.ship_from_site_id = ?', filters.siteId);
  if (filters.siteAny !== undefined && filters.siteAny !== null) add('eso.ship_from_site_id = ANY(?::uuid[])', filters.siteAny);
  if (filters.status) add('pt.status = ?', filters.status);
  if (filters.assignedTo) add('pt.assigned_to = ?', filters.assignedTo);
  if (filters.zoneId) add('pt.zone_id = ?', filters.zoneId);
  if (filters.waveId) add('pt.wave_id = ?', filters.waveId);
  if (filters.batchId) add('pt.batch_id = ?', filters.batchId);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const columns = `pt.pick_task_id, pt.dispatch_order_id, pt.sku, pt.total_quantity::text AS total_quantity,
       pt.strategy, pt.wave_id, pt.batch_id, pt.zone_id, pt.status, pt.assigned_to, pt.created_by,
       pt.created_at, pt.completed_at, pt.completed_by, pt.updated_at`;
  const result = await runner(client).query(
    `SELECT ${columns}
       FROM pick_task pt
       JOIN erp_sales_order eso ON eso.id = pt.dispatch_order_id
       ${where}
      ORDER BY pt.created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

/** Resolves the site UUID a pick task belongs to via the Story 2.9 sales-order join. */
export async function getPickTaskSiteId(pickTaskId: string, client?: PoolClient): Promise<string | null> {
  const result = await runner(client).query(
    `SELECT eso.ship_from_site_id
       FROM pick_task pt
       JOIN erp_sales_order eso ON eso.id = pt.dispatch_order_id
      WHERE pt.pick_task_id = $1`,
    [pickTaskId],
  );
  return result.rows.length > 0 ? (result.rows[0]!['ship_from_site_id'] as string) : null;
}
