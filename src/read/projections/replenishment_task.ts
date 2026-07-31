import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { priorityRankSql, type TaskPriority } from './pick_task.js';

/**
 * Replenishment task-board row accessor (Story 3.9). A SKU-zone internal-movement task moving
 * stock from reserve storage into a forward-pick zone; distinct from replenishment_recommendation
 * (Story 2.7/2.8), a SKU-location reorder/VMI signal with no zone concept that is never itself an
 * executable task. Rows are written only through the persistEvent seam
 * (src/compliance/replenishment.ts). quantity is bound/returned as a NUMERIC string.
 */
export interface ReplenishmentTask {
  replenishment_task_id: string;
  sku: string;
  zone_id: string;
  site_id: string;
  from_location_id: string | null;
  to_location_id: string | null;
  quantity: string;
  signal_type: 'min_max' | 'demand_signal';
  status: 'ready' | 'completed' | 'cancelled';
  priority: TaskPriority;
  assigned_to: string | null;
  assigned_by: string | null;
  assigned_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
  correlation_id: string;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface InsertReplenishmentTaskInput {
  replenishment_task_id: string;
  sku: string;
  zone_id: string;
  site_id: string;
  from_location_id?: string | null;
  quantity: string;
  signal_type: 'min_max' | 'demand_signal';
  correlation_id: string;
  source_event_id: string;
}

export interface ListReplenishmentTasksFilters {
  siteId?: string | null;
  siteAny?: string[] | null;
  zoneId?: string | null;
  status?: 'ready' | 'completed' | 'cancelled' | null;
  assignedTo?: string | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function ts(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

const REPLENISHMENT_TASK_COLUMNS = `replenishment_task_id, sku, zone_id, site_id, from_location_id, to_location_id,
       quantity::text AS quantity, signal_type, status, priority, assigned_to, assigned_by, assigned_at,
       completed_at, completed_by, correlation_id, source_event_id, created_at, updated_at`;

function mapRow(row: Record<string, unknown>): ReplenishmentTask {
  return {
    replenishment_task_id: row['replenishment_task_id'] as string,
    sku: row['sku'] as string,
    zone_id: row['zone_id'] as string,
    site_id: row['site_id'] as string,
    from_location_id: (row['from_location_id'] as string | null) ?? null,
    to_location_id: (row['to_location_id'] as string | null) ?? null,
    quantity: String(row['quantity']),
    signal_type: row['signal_type'] as 'min_max' | 'demand_signal',
    status: row['status'] as ReplenishmentTask['status'],
    priority: (row['priority'] as TaskPriority | null) ?? 'normal',
    assigned_to: (row['assigned_to'] as string | null) ?? null,
    assigned_by: (row['assigned_by'] as string | null) ?? null,
    assigned_at: row['assigned_at'] ? ts(row['assigned_at']) : null,
    completed_at: row['completed_at'] ? ts(row['completed_at']) : null,
    completed_by: (row['completed_by'] as string | null) ?? null,
    correlation_id: row['correlation_id'] as string,
    source_event_id: row['source_event_id'] as string,
    created_at: ts(row['created_at']),
    updated_at: ts(row['updated_at']),
  };
}

export async function getReplenishmentTaskById(
  replenishmentTaskId: string,
  client?: PoolClient,
): Promise<ReplenishmentTask | null> {
  const result = await runner(client).query(
    `SELECT ${REPLENISHMENT_TASK_COLUMNS} FROM replenishment_task WHERE replenishment_task_id = $1`,
    [replenishmentTaskId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

/** Locks the row FOR UPDATE inside a transaction to serialise concurrent confirmations. */
export async function getReplenishmentTaskByIdForUpdate(
  replenishmentTaskId: string,
  client: PoolClient,
): Promise<ReplenishmentTask | null> {
  const result = await client.query(
    `SELECT ${REPLENISHMENT_TASK_COLUMNS} FROM replenishment_task WHERE replenishment_task_id = $1 FOR UPDATE`,
    [replenishmentTaskId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function listReplenishmentTasks(
  filters: ListReplenishmentTasksFilters = {},
  client?: PoolClient,
): Promise<ReplenishmentTask[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    clauses.push(sql.replace('?', `$${values.length}`));
  };
  if (filters.siteId) add('site_id = ?', filters.siteId);
  if (filters.siteAny !== undefined && filters.siteAny !== null)
    add('site_id = ANY(?::uuid[])', filters.siteAny);
  if (filters.zoneId) add('zone_id = ?', filters.zoneId);
  if (filters.status) add('status = ?', filters.status);
  if (filters.assignedTo) add('assigned_to = ?', filters.assignedTo);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await runner(client).query(
    `SELECT ${REPLENISHMENT_TASK_COLUMNS} FROM replenishment_task ${where}
      ORDER BY ${priorityRankSql('priority')}, created_at ASC`,
    values,
  );
  return result.rows.map(mapRow);
}

/** Idempotent, replay-safe insert keyed on replenishment_task_id. quantity bound as a NUMERIC string. */
export async function insertReplenishmentTask(
  input: InsertReplenishmentTaskInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO replenishment_task
       (replenishment_task_id, sku, zone_id, site_id, from_location_id, quantity, signal_type,
        correlation_id, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9)
     ON CONFLICT (replenishment_task_id) DO NOTHING`,
    [
      input.replenishment_task_id,
      input.sku,
      input.zone_id,
      input.site_id,
      input.from_location_id ?? null,
      input.quantity,
      input.signal_type,
      input.correlation_id,
      input.source_event_id,
    ],
  );
}

/**
 * Assigns an operator to a ready replenishment task, mirroring assignPutawayTask's
 * status-predicated update (never read-then-write) and its "steal" guard: an already-assigned
 * task is only reassignable when the caller explicitly asks. Returns false when the task does not
 * exist, is no longer ready, or is already assigned to someone else without allowReassign.
 */
export async function assignReplenishmentTask(
  input: {
    replenishmentTaskId: string;
    assignedTo: string;
    assignedBy: string;
    priority?: TaskPriority | null;
    allowReassign?: boolean;
    assignedAt?: string | null;
  },
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE replenishment_task
        SET assigned_to = $2,
            assigned_by = $3,
            assigned_at = COALESCE($6::timestamptz, now()),
            priority = COALESCE($4, priority),
            updated_at = now()
      WHERE replenishment_task_id = $1
        AND status = 'ready'
        AND ($5::boolean OR assigned_to IS NULL OR assigned_to = $2)`,
    [
      input.replenishmentTaskId,
      input.assignedTo,
      input.assignedBy,
      input.priority ?? null,
      input.allowReassign ?? false,
      input.assignedAt ?? null,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Completes a ready replenishment task, recording the resolved destination bin. Status-predicated
 * (`WHERE status = 'ready'`), never read-then-write, mirroring completePutawayTask/
 * completeReplenishmentTask's sibling accessors. Returns false (no-op) if a concurrent request
 * already completed the task.
 */
export async function completeReplenishmentTask(
  input: { replenishmentTaskId: string; toLocationId: string; completedBy: string },
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE replenishment_task
        SET status = 'completed',
            to_location_id = $2,
            completed_by = $3,
            completed_at = now(),
            updated_at = now()
      WHERE replenishment_task_id = $1 AND status = 'ready'`,
    [input.replenishmentTaskId, input.toLocationId, input.completedBy],
  );
  return (result.rowCount ?? 0) > 0;
}
