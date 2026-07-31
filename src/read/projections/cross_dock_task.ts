import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { priorityRankSql, type TaskPriority } from './pick_task.js';

export interface CrossDockTask {
  cross_dock_task_id: string;
  grn_line_id: string;
  dispatch_order_line_id: string;
  sku: string;
  lot_id: string;
  quantity: string;
  site_id: string;
  from_location_id: string;
  staging_zone_id: string;
  to_location_id: string | null;
  status: 'ready' | 'completed';
  priority: TaskPriority;
  assigned_to: string | null;
  assigned_by: string | null;
  assigned_at: string | null;
  created_by: string;
  created_at: string;
  completed_by: string | null;
  completed_at: string | null;
  correlation_id: string;
  source_event_id: string;
  completion_event_id: string | null;
  updated_at: string;
}

export interface CrossDockTaskDetail extends CrossDockTask {
  grn_line_no: number;
  po_ref_ext: string;
  lot_number: string | null;
  uom: string;
  sales_order_number: string;
  sales_order_line_no: number;
  staging_zone_code: string;
  to_location_code: string | null;
}

export interface InsertCrossDockTaskInput {
  cross_dock_task_id: string;
  grn_line_id: string;
  dispatch_order_line_id: string;
  sku: string;
  lot_id: string;
  quantity: string;
  site_id: string;
  from_location_id: string;
  staging_zone_id: string;
  priority?: TaskPriority;
  created_by: string;
  created_at: string;
  correlation_id: string;
  source_event_id: string;
}

export interface ListCrossDockTasksFilters {
  siteId?: string | null;
  siteAny?: string[] | null;
  stagingZoneId?: string | null;
  status?: 'ready' | 'completed' | null;
  assignedTo?: string | null;
  priority?: TaskPriority | null;
  orderByPriority?: boolean;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

const COLUMNS = `cross_dock_task_id, grn_line_id, dispatch_order_line_id, sku, lot_id,
       quantity::text AS quantity, site_id, from_location_id, staging_zone_id, to_location_id,
       status, priority, assigned_to, assigned_by, assigned_at, created_by, created_at,
       completed_by, completed_at, correlation_id, source_event_id, completion_event_id, updated_at`;

function mapRow(row: Record<string, unknown>): CrossDockTask {
  return {
    cross_dock_task_id: row['cross_dock_task_id'] as string,
    grn_line_id: row['grn_line_id'] as string,
    dispatch_order_line_id: row['dispatch_order_line_id'] as string,
    sku: row['sku'] as string,
    lot_id: row['lot_id'] as string,
    quantity: String(row['quantity']),
    site_id: row['site_id'] as string,
    from_location_id: row['from_location_id'] as string,
    staging_zone_id: row['staging_zone_id'] as string,
    to_location_id: (row['to_location_id'] as string | null) ?? null,
    status: row['status'] as CrossDockTask['status'],
    priority: row['priority'] as TaskPriority,
    assigned_to: (row['assigned_to'] as string | null) ?? null,
    assigned_by: (row['assigned_by'] as string | null) ?? null,
    assigned_at: row['assigned_at'] ? timestamp(row['assigned_at']) : null,
    created_by: row['created_by'] as string,
    created_at: timestamp(row['created_at']),
    completed_by: (row['completed_by'] as string | null) ?? null,
    completed_at: row['completed_at'] ? timestamp(row['completed_at']) : null,
    correlation_id: row['correlation_id'] as string,
    source_event_id: row['source_event_id'] as string,
    completion_event_id: (row['completion_event_id'] as string | null) ?? null,
    updated_at: timestamp(row['updated_at']),
  };
}

export async function getCrossDockTaskById(crossDockTaskId: string, client?: PoolClient): Promise<CrossDockTask | null> {
  const result = await runner(client).query(`SELECT ${COLUMNS} FROM cross_dock_task WHERE cross_dock_task_id = $1`, [crossDockTaskId]);
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function getCrossDockTaskDetailById(crossDockTaskId: string, client?: PoolClient): Promise<CrossDockTaskDetail | null> {
  const result = await runner(client).query(
    `SELECT cdt.cross_dock_task_id, cdt.grn_line_id, cdt.dispatch_order_line_id, cdt.sku, cdt.lot_id,
            cdt.quantity::text AS quantity, cdt.site_id, cdt.from_location_id, cdt.staging_zone_id,
            cdt.to_location_id, cdt.status, cdt.priority, cdt.assigned_to, cdt.assigned_by,
            cdt.assigned_at, cdt.created_by, cdt.created_at, cdt.completed_by, cdt.completed_at,
            cdt.correlation_id, cdt.source_event_id, cdt.completion_event_id, cdt.updated_at,
            gl.line_no AS grn_line_no, gl.po_ref_ext, gl.lot_id AS lot_number, gl.uom,
            eso.so_number_ext AS sales_order_number, eso.line_no AS sales_order_line_no,
            staging.location_code AS staging_zone_code, destination.location_code AS to_location_code
       FROM cross_dock_task cdt
       JOIN grn_line gl ON gl.grn_line_id = cdt.grn_line_id
       JOIN erp_sales_order eso ON eso.id = cdt.dispatch_order_line_id
       JOIN location_register staging ON staging.location_id = cdt.staging_zone_id
       LEFT JOIN location_register destination ON destination.location_id = cdt.to_location_id
      WHERE cdt.cross_dock_task_id = $1`,
    [crossDockTaskId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0]!;
  return {
    ...mapRow(row),
    grn_line_no: Number(row['grn_line_no']),
    po_ref_ext: row['po_ref_ext'] as string,
    lot_number: (row['lot_number'] as string | null) ?? null,
    uom: row['uom'] as string,
    sales_order_number: row['sales_order_number'] as string,
    sales_order_line_no: Number(row['sales_order_line_no']),
    staging_zone_code: row['staging_zone_code'] as string,
    to_location_code: (row['to_location_code'] as string | null) ?? null,
  };
}

export async function getCrossDockTaskByIdForUpdate(crossDockTaskId: string, client: PoolClient): Promise<CrossDockTask | null> {
  const result = await client.query(`SELECT ${COLUMNS} FROM cross_dock_task WHERE cross_dock_task_id = $1 FOR UPDATE`, [crossDockTaskId]);
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function getCrossDockTaskByGrnLine(grnLineId: string, client?: PoolClient): Promise<CrossDockTask | null> {
  const result = await runner(client).query(`SELECT ${COLUMNS} FROM cross_dock_task WHERE grn_line_id = $1`, [grnLineId]);
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function listCrossDockTasks(filters: ListCrossDockTasksFilters = {}, client?: PoolClient): Promise<CrossDockTask[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    clauses.push(sql.replace('?', `$${values.length}`));
  };
  if (filters.siteId) add('site_id = ?', filters.siteId);
  if (filters.siteAny !== undefined && filters.siteAny !== null) add('site_id = ANY(?::uuid[])', filters.siteAny);
  if (filters.stagingZoneId) add('staging_zone_id = ?', filters.stagingZoneId);
  if (filters.status) add('status = ?', filters.status);
  if (filters.assignedTo) add('assigned_to = ?', filters.assignedTo);
  if (filters.priority) add('priority = ?', filters.priority);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const orderBy = filters.orderByPriority ? `ORDER BY ${priorityRankSql('priority')}, created_at ASC` : 'ORDER BY created_at DESC';
  const result = await runner(client).query(`SELECT ${COLUMNS} FROM cross_dock_task ${where} ${orderBy}`, values);
  return result.rows.map(mapRow);
}

export async function insertCrossDockTask(input: InsertCrossDockTaskInput, client: PoolClient): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO cross_dock_task
       (cross_dock_task_id, grn_line_id, dispatch_order_line_id, sku, lot_id, quantity, site_id,
        from_location_id, staging_zone_id, priority, created_by, created_at, correlation_id, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10, $11, $12::timestamptz, $13, $14)
     ON CONFLICT DO NOTHING`,
    [
      input.cross_dock_task_id,
      input.grn_line_id,
      input.dispatch_order_line_id,
      input.sku,
      input.lot_id,
      input.quantity,
      input.site_id,
      input.from_location_id,
      input.staging_zone_id,
      input.priority ?? 'normal',
      input.created_by,
      input.created_at,
      input.correlation_id,
      input.source_event_id,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function assignCrossDockTask(
  input: {
    crossDockTaskId: string;
    assignedTo: string;
    assignedBy: string;
    assignedAt: string;
    priority?: TaskPriority | null;
    allowReassign?: boolean;
  },
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE cross_dock_task
        SET assigned_to = $2, assigned_by = $3, assigned_at = $4::timestamptz,
            priority = COALESCE($5, priority), updated_at = $4::timestamptz
      WHERE cross_dock_task_id = $1 AND status = 'ready'
        AND ($6::boolean OR assigned_to IS NULL OR assigned_to = $2)`,
    [input.crossDockTaskId, input.assignedTo, input.assignedBy, input.assignedAt, input.priority ?? null, input.allowReassign ?? false],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function completeCrossDockTask(
  input: {
    crossDockTaskId: string;
    toLocationId: string;
    completedBy: string;
    completedAt: string;
    completionEventId: string;
  },
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE cross_dock_task
        SET status = 'completed', to_location_id = $2, completed_by = $3,
            completed_at = $4::timestamptz, completion_event_id = $5, updated_at = $4::timestamptz
      WHERE cross_dock_task_id = $1 AND status = 'ready'`,
    [input.crossDockTaskId, input.toLocationId, input.completedBy, input.completedAt, input.completionEventId],
  );
  return (result.rowCount ?? 0) > 0;
}
