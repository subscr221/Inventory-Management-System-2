import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { priorityRankSql, type TaskPriority } from './pick_task.js';

/**
 * Putaway task projection accessor (Story 3.4). A task is generated for every posted or quarantined
 * GRN line; a QC-hold line yields a `held` task released only through the DOA-gated manual release
 * (AC3). Story 3.5 (Directed Putaway) extends this table with directed-bin suggestion/override; keep
 * the accessors additive. quantity is bound/returned as a NUMERIC string, never a JS float.
 */
export interface PutawayTask {
  putaway_task_id: string;
  grn_line_id: string;
  sku: string;
  lot_id: string | null;
  quantity: string;
  from_location_id: string;
  site_id: string;
  status: 'ready' | 'held' | 'completed';
  owner_role: string | null;
  released_by: string | null;
  release_reason_code: string | null;
  released_event_id: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
  // Story 3.5: Directed Putaway (Task 3 fields)
  directed_location_id: string | null;
  directed_location_code: string | null;
  velocity_class_at_suggestion: 'A' | 'B' | 'C' | null;
  actual_location_id: string | null;
  actual_location_code: string | null;
  override_reason_code: string | null;
  override_confidence: 'certain' | 'uncertain' | null;
  completed_at: string | null;
  completed_by: string | null;
  // Story 3.8: Warehouse Task Management (Task 2 fields)
  priority: TaskPriority;
  assigned_to: string | null;
  assigned_by: string | null;
  assigned_at: string | null;
  /** Zone ancestor of the directed bin, resolved once at suggestion time. Null until directed. */
  zone_id: string | null;
}

export interface InsertPutawayTaskInput {
  putaway_task_id: string;
  grn_line_id: string;
  sku: string;
  lot_id?: string | null;
  quantity: string;
  from_location_id: string;
  site_id: string;
  status?: 'ready' | 'held' | 'completed';
  owner_role?: string | null;
  source_event_id: string;
}

export interface ListPutawayTasksFilters {
  siteId?: string | null;
  siteAny?: string[] | null;
  status?: 'ready' | 'held' | 'completed' | null;
  // Story 3.8: task-board filters.
  assignedTo?: string | null;
  priority?: TaskPriority | null;
  zoneId?: string | null;
  /** Order most-urgent-first then oldest-first instead of the default newest-first. */
  orderByPriority?: boolean;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function ts(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

const PUTAWAY_TASK_COLUMNS = `putaway_task_id, grn_line_id, sku, lot_id, quantity::text AS quantity,
       from_location_id, site_id, status, owner_role, released_by, release_reason_code,
       released_event_id, source_event_id, created_at, updated_at,
       directed_location_id, directed_location_code, velocity_class_at_suggestion,
       actual_location_id, actual_location_code, override_reason_code, override_confidence,
       completed_at, completed_by,
       priority, assigned_to, assigned_by, assigned_at, zone_id`;

function mapRow(row: Record<string, unknown>): PutawayTask {
  return {
    putaway_task_id: row['putaway_task_id'] as string,
    grn_line_id: row['grn_line_id'] as string,
    sku: row['sku'] as string,
    lot_id: (row['lot_id'] as string | null) ?? null,
    quantity: String(row['quantity']),
    from_location_id: row['from_location_id'] as string,
    site_id: row['site_id'] as string,
    status: row['status'] as PutawayTask['status'],
    owner_role: (row['owner_role'] as string | null) ?? null,
    released_by: (row['released_by'] as string | null) ?? null,
    release_reason_code: (row['release_reason_code'] as string | null) ?? null,
    released_event_id: (row['released_event_id'] as string | null) ?? null,
    source_event_id: row['source_event_id'] as string,
    created_at: ts(row['created_at']),
    updated_at: ts(row['updated_at']),
    directed_location_id: (row['directed_location_id'] as string | null) ?? null,
    directed_location_code: (row['directed_location_code'] as string | null) ?? null,
    velocity_class_at_suggestion: (row['velocity_class_at_suggestion'] as 'A' | 'B' | 'C' | null) ?? null,
    actual_location_id: (row['actual_location_id'] as string | null) ?? null,
    actual_location_code: (row['actual_location_code'] as string | null) ?? null,
    override_reason_code: (row['override_reason_code'] as string | null) ?? null,
    override_confidence: (row['override_confidence'] as 'certain' | 'uncertain' | null) ?? null,
    completed_at: (row['completed_at'] ? ts(row['completed_at']) : null),
    completed_by: (row['completed_by'] as string | null) ?? null,
    priority: (row['priority'] as TaskPriority | null) ?? 'normal',
    assigned_to: (row['assigned_to'] as string | null) ?? null,
    assigned_by: (row['assigned_by'] as string | null) ?? null,
    assigned_at: row['assigned_at'] ? ts(row['assigned_at']) : null,
    zone_id: (row['zone_id'] as string | null) ?? null,
  };
}

export async function getPutawayTaskById(putawayTaskId: string, client?: PoolClient): Promise<PutawayTask | null> {
  const result = await runner(client).query(`SELECT ${PUTAWAY_TASK_COLUMNS} FROM putaway_task WHERE putaway_task_id = $1`, [putawayTaskId]);
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

/** Story 3.5: Lock the putaway task row FOR UPDATE inside a transaction to serialise concurrent completions. */
export async function getPutawayTaskByIdForUpdate(putawayTaskId: string, client: PoolClient): Promise<PutawayTask | null> {
  const result = await client.query(`SELECT ${PUTAWAY_TASK_COLUMNS} FROM putaway_task WHERE putaway_task_id = $1 FOR UPDATE`, [putawayTaskId]);
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function getPutawayTaskByGrnLine(grnLineId: string, client?: PoolClient): Promise<PutawayTask | null> {
  const result = await runner(client).query(
    `SELECT ${PUTAWAY_TASK_COLUMNS} FROM putaway_task WHERE grn_line_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [grnLineId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function listPutawayTasks(filters: ListPutawayTasksFilters = {}, client?: PoolClient): Promise<PutawayTask[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    clauses.push(sql.replace('?', `$${values.length}`));
  };
  if (filters.siteId) add('site_id = ?', filters.siteId);
  if (filters.siteAny !== undefined && filters.siteAny !== null) add('site_id = ANY(?::uuid[])', filters.siteAny);
  if (filters.status) add('status = ?', filters.status);
  if (filters.assignedTo) add('assigned_to = ?', filters.assignedTo);
  if (filters.priority) add('priority = ?', filters.priority);
  if (filters.zoneId) add('zone_id = ?', filters.zoneId);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const orderBy = filters.orderByPriority
    ? `ORDER BY ${priorityRankSql('priority')}, created_at ASC`
    : 'ORDER BY created_at DESC';
  const result = await runner(client).query(`SELECT ${PUTAWAY_TASK_COLUMNS} FROM putaway_task ${where} ${orderBy}`, values);
  return result.rows.map(mapRow);
}

/** Idempotent, replay-safe upsert keyed on putaway_task_id. quantity bound as a NUMERIC string. */
export async function insertPutawayTask(input: InsertPutawayTaskInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO putaway_task
       (putaway_task_id, grn_line_id, sku, lot_id, quantity, from_location_id, site_id, status,
        owner_role, source_event_id)
     VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, $10)
     ON CONFLICT (putaway_task_id) DO UPDATE SET
       grn_line_id = EXCLUDED.grn_line_id,
       sku = EXCLUDED.sku,
       lot_id = EXCLUDED.lot_id,
       quantity = EXCLUDED.quantity,
       from_location_id = EXCLUDED.from_location_id,
       site_id = EXCLUDED.site_id,
       status = EXCLUDED.status,
       owner_role = EXCLUDED.owner_role,
       source_event_id = EXCLUDED.source_event_id,
       updated_at = now()`,
    [
      input.putaway_task_id,
      input.grn_line_id,
      input.sku,
      input.lot_id ?? null,
      input.quantity,
      input.from_location_id,
      input.site_id,
      input.status ?? 'ready',
      input.owner_role ?? null,
      input.source_event_id,
    ],
  );
}

/**
 * Marks a held putaway task released (AC3): status -> ready, recording the releasing supervisor, the
 * reason code, and the goods.putaway_released event id. Scoped to a currently-held task so a replay
 * or a race cannot re-release a task that is already ready/completed.
 */
/** Returns false (no-op) if a concurrent request already released the task out from under this one. */
export async function markPutawayReleased(
  putawayTaskId: string,
  releasedBy: string,
  reasonCode: string,
  releasedEventId: string,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE putaway_task
        SET status = 'ready',
            released_by = $2,
            release_reason_code = $3,
            released_event_id = $4,
            updated_at = now()
      WHERE putaway_task_id = $1 AND status = 'held'`,
    [putawayTaskId, releasedBy, reasonCode, releasedEventId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Story 3.8: the zone ancestor of a location, found by walking `parent_location_id` upward until a
 * row at `level = 'zone'` is reached. Returns null for a location that hangs off no zone (a site
 * row itself, or an orphaned chain). The recursion is depth-capped so a cyclic parent chain - which
 * the location register should never contain, but which would otherwise hang the query - terminates.
 */
const ZONE_ANCESTOR_CTE = `WITH RECURSIVE ancestry AS (
      SELECT location_id, parent_location_id, level, 0 AS depth
        FROM location_register
       WHERE location_id = $ZONE_PARAM$
      UNION ALL
      SELECT lr.location_id, lr.parent_location_id, lr.level, a.depth + 1
        FROM location_register lr
        JOIN ancestry a ON lr.location_id = a.parent_location_id
       WHERE a.depth < 10
    )`;

/**
 * Story 3.5: Set the directed suggestion for a putaway task (idempotent, no-op if already completed).
 * Story 3.8: the same statement denormalizes the directed bin's zone ancestor onto the task, so the
 * unified task board never has to run a recursive topology walk per row on every dashboard read.
 * Resolving it here (rather than at read time) also freezes the attribution at direction time, which
 * is what "zone the task was issued to" means for SLA grouping.
 *
 * The COALESCE is deliberate. The recursive walk returns NULL for three quite different situations -
 * a bin genuinely hanging off no zone, a chain deeper than the depth cap, and a cyclic
 * parent_location_id - and an unconditional assignment let any of them overwrite a previously
 * correct zone_id with NULL when a task was re-directed. Keeping the prior value means a
 * re-direction can only ever improve the attribution, never silently destroy it.
 */
export async function setDirectedSuggestion(
  putawayTaskId: string,
  directedLocationId: string,
  directedLocationCode: string,
  velocityClass: 'A' | 'B' | 'C',
  client: PoolClient,
): Promise<void> {
  await client.query(
    `${ZONE_ANCESTOR_CTE.replace('$ZONE_PARAM$', '$2')}
     UPDATE putaway_task
        SET directed_location_id = $2,
            directed_location_code = $3,
            velocity_class_at_suggestion = $4,
            zone_id = COALESCE(
              (SELECT location_id FROM ancestry WHERE level = 'zone' ORDER BY depth LIMIT 1),
              putaway_task.zone_id
            ),
            updated_at = now()
      WHERE putaway_task_id = $1 AND status = 'ready'`,
    [putawayTaskId, directedLocationId, directedLocationCode, velocityClass],
  );
}

/**
 * Story 3.8 (AC1): assigns an operator to a putaway task and optionally re-prioritises it in the
 * same statement. Predicated on `status = 'ready'` - never a read-then-write - so a task a
 * concurrent request has already released, held, or completed cannot be reassigned out from under
 * that request. `assignedBy` is always server-set from the authenticated supervisor, never client
 * input. Returns false when the task does not exist or is no longer ready.
 *
 * The `status = 'ready'` predicate alone closed only the released/held/completed race. Code review
 * found it did nothing about assign-versus-assign: two supervisors assigning the same ready task to
 * different operators both matched, both returned rowCount 1, and both handlers returned 200, so the
 * first operator was silently unassigned and neither supervisor learned of the conflict. An
 * already-assigned task is therefore only reassignable when the caller explicitly asks, which makes
 * a deliberate reassignment possible and an accidental steal impossible.
 */
export async function assignPutawayTask(
  input: {
    putawayTaskId: string;
    assignedTo: string;
    assignedBy: string;
    priority?: TaskPriority | null;
    allowReassign?: boolean;
  },
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE putaway_task
        SET assigned_to = $2,
            assigned_by = $3,
            assigned_at = now(),
            priority = COALESCE($4, priority),
            updated_at = now()
      WHERE putaway_task_id = $1
        AND status = 'ready'
        AND ($5::boolean OR assigned_to IS NULL OR assigned_to = $2)`,
    [input.putawayTaskId, input.assignedTo, input.assignedBy, input.priority ?? null, input.allowReassign ?? false],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Story 3.5: Complete a putaway task, recording the actual location and override if applicable. Returns false (no-op) if a concurrent request already completed the task. */
export async function completePutawayTask(
  input: {
    putawayTaskId: string;
    actualLocationId: string;
    actualLocationCode: string;
    overrideReasonCode?: string | null;
    overrideConfidence?: 'certain' | 'uncertain' | null;
    completedBy: string;
    completedEventId?: string;
  },
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE putaway_task
        SET status = 'completed',
            actual_location_id = $2,
            actual_location_code = $3,
            override_reason_code = $4,
            override_confidence = $5,
            completed_by = $6,
            completed_at = now(),
            updated_at = now()
      WHERE putaway_task_id = $1 AND status = 'ready'`,
    [
      input.putawayTaskId,
      input.actualLocationId,
      input.actualLocationCode,
      input.overrideReasonCode ?? null,
      input.overrideConfidence ?? null,
      input.completedBy,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}
