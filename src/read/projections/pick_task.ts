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
  /** Story 3.8: supervisor-assignable board priority. Pre-3.8 rows read as 'normal' (column default). */
  priority: TaskPriority;
  created_by: string;
  created_at: string;
  completed_at: string | null;
  completed_by: string | null;
  updated_at: string;
}

/** Story 3.8: shared task-board priority vocabulary, ordered least to most urgent. */
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export const TASK_PRIORITIES: readonly TaskPriority[] = ['low', 'normal', 'high', 'urgent'];

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && (TASK_PRIORITIES as readonly string[]).includes(value);
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
  priority?: TaskPriority;
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
  /** Story 3.8: filter the board to a single priority band. */
  priority?: TaskPriority | null;
  /**
   * Story 3.8: order most-urgent-first, then oldest-first, instead of the default newest-first.
   * Ranking happens in SQL via a CASE over the priority vocabulary, so it is not sensitive to the
   * alphabetical ordering of the enum values ('high' < 'low' < 'normal' < 'urgent' as text).
   */
  orderByPriority?: boolean;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function ts(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

const PICK_TASK_COLUMNS = `pick_task_id, dispatch_order_id, sku, total_quantity::text AS total_quantity,
       strategy, wave_id, batch_id, zone_id, status, assigned_to, priority, created_by, created_at,
       completed_at, completed_by, updated_at`;

/**
 * Story 3.8: SQL ranking expression for the priority vocabulary. Text ordering would sort 'high'
 * before 'low' before 'normal' before 'urgent', which is meaningless; this maps each value to its
 * rank. `column` is always a caller-supplied literal identifier, never request input.
 */
export function priorityRankSql(column: string): string {
  return `CASE ${column} WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
}

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
    priority: (row['priority'] as TaskPriority | null) ?? 'normal',
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

/**
 * Reads a pick task under a row lock. Completion must read the status inside the lock, otherwise
 * two concurrent completions both observe a non-completed task, both pass the all-lines-confirmed
 * gate, and both run the allocated-to-picked move (review pass 2).
 */
export async function getPickTaskByIdForUpdate(pickTaskId: string, client: PoolClient): Promise<PickTask | null> {
  const result = await client.query(`SELECT ${PICK_TASK_COLUMNS} FROM pick_task WHERE pick_task_id = $1 FOR UPDATE`, [pickTaskId]);
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

/** Idempotent, replay-safe insert keyed on pick_task_id. total_quantity bound as a NUMERIC string. */
export async function createPickTask(input: CreatePickTaskInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO pick_task
       (pick_task_id, dispatch_order_id, sku, total_quantity, strategy, wave_id, batch_id, zone_id,
        status, priority, created_by)
     VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9, $10, $11)
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
      input.priority ?? 'normal',
      input.created_by,
    ],
  );
}

/**
 * Status update guarded against re-completion: the WHERE excludes a task that is already
 * `completed`, so a second completion of the same task affects zero rows and the caller can treat
 * it as a no-op instead of re-running the allocated-to-picked move (review pass 2). Returns false
 * when the task does not exist or is already completed.
 */
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
      WHERE pick_task_id = $1 AND status <> 'completed'`,
    [pickTaskId, status, completedBy],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Assigns an operator to a still-pending task, optionally re-prioritising it in the same statement.
 * Scoped to `status = 'pending'` so a task that a concurrent request already started or completed is
 * not reassigned; returns false in that case and when the task does not exist.
 *
 * Story 3.8 code review made this the single writer of `priority` for pick tasks. The story
 * originally shipped a separate `setPickTaskPriority` accessor that nothing ever called, alongside
 * an assign route that could not carry a priority, so `pick_task.priority` was permanently 'normal'
 * and AC1's priority column was inert for half the task types. Folding priority into the assignment
 * gives supervisors one operation for "who does this, and how urgent is it".
 *
 * The assigned-to guard mirrors assignPutawayTask: two supervisors assigning the same pending task
 * to different operators must not both silently succeed, so an already-assigned task is only
 * reassignable when the caller explicitly asks.
 */
export async function assignPickTask(
  input: {
    pickTaskId: string;
    assignedTo: string;
    assignedBy: string;
    priority?: TaskPriority | null;
    allowReassign?: boolean;
    /** Event capture instant; replay uses this so the rebuilt row matches the original. */
    assignedAt?: string | null;
  },
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE pick_task
        SET assigned_to = $2,
            assigned_by = $3,
            assigned_at = COALESCE($6::timestamptz, now()),
            priority = COALESCE($4, priority),
            updated_at = now()
      WHERE pick_task_id = $1
        AND status = 'pending'
        AND ($5::boolean OR assigned_to IS NULL OR assigned_to = $2)`,
    [input.pickTaskId, input.assignedTo, input.assignedBy, input.priority ?? null, input.allowReassign ?? false, input.assignedAt ?? null],
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
  if (filters.priority) add('pt.priority = ?', filters.priority);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const columns = `pt.pick_task_id, pt.dispatch_order_id, pt.sku, pt.total_quantity::text AS total_quantity,
       pt.strategy, pt.wave_id, pt.batch_id, pt.zone_id, pt.status, pt.assigned_to, pt.priority,
       pt.created_by, pt.created_at, pt.completed_at, pt.completed_by, pt.updated_at`;
  // Priority ordering ranks the vocabulary explicitly; ORDER BY pt.priority would sort the text
  // values alphabetically ('high', 'low', 'normal', 'urgent'), which is not the intended order.
  const orderBy = filters.orderByPriority
    ? `ORDER BY ${priorityRankSql('pt.priority')}, pt.created_at ASC`
    : 'ORDER BY pt.created_at DESC';
  const result = await runner(client).query(
    `SELECT ${columns}
       FROM pick_task pt
       JOIN erp_sales_order eso ON eso.id = pt.dispatch_order_id
       ${where}
      ${orderBy}`,
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
