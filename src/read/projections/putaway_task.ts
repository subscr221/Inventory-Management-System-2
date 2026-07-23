import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

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
       completed_at, completed_by`;

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
  };
}

export async function getPutawayTaskById(putawayTaskId: string, client?: PoolClient): Promise<PutawayTask | null> {
  const result = await runner(client).query(`SELECT ${PUTAWAY_TASK_COLUMNS} FROM putaway_task WHERE putaway_task_id = $1`, [putawayTaskId]);
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
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await runner(client).query(`SELECT ${PUTAWAY_TASK_COLUMNS} FROM putaway_task ${where} ORDER BY created_at DESC`, values);
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

/** Story 3.5: Set the directed suggestion for a putaway task (idempotent, no-op if already completed). */
export async function setDirectedSuggestion(
  putawayTaskId: string,
  directedLocationId: string,
  directedLocationCode: string,
  velocityClass: 'A' | 'B' | 'C',
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE putaway_task
        SET directed_location_id = $2,
            directed_location_code = $3,
            velocity_class_at_suggestion = $4,
            updated_at = now()
      WHERE putaway_task_id = $1 AND status != 'completed'`,
    [putawayTaskId, directedLocationId, directedLocationCode, velocityClass],
  );
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
