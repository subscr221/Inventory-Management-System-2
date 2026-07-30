import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import type { WarehouseTaskType } from '../../events/schema.js';

/**
 * Task SLA threshold projection accessor (Story 3.8). One row per (site_id, task_type, zone_id)
 * grain, where a NULL zone_id is the site-wide default for that task type WITHIN that site.
 * threshold_minutes is NUMERIC(9,2) and is read as a string, never Number()'d for storage or
 * comparison - breach comparison happens in PostgreSQL NUMERIC against an interval computed in SQL,
 * so no JS float ever decides a breach.
 *
 * site_id joined the grain in this story's code review. Without it the NULLS NOT DISTINCT index
 * permitted exactly one null-zone row per task type for the whole deployment, so a supervisor
 * scoped to a single site who omitted zone_id silently changed what counted as a breach at every
 * other site. Every read here is therefore site-scoped, and callers must supply a site.
 *
 * Rows are written only through the persistEvent seam (src/compliance/warehouse-task.ts).
 */
export interface TaskSlaConfig {
  id: string;
  site_id: string;
  task_type: WarehouseTaskType;
  zone_id: string | null;
  threshold_minutes: string;
  updated_by: string;
  source_event_id: string | null;
  event_occurred_at: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertTaskSlaConfigInput {
  id: string;
  site_id: string;
  task_type: WarehouseTaskType;
  zone_id?: string | null;
  threshold_minutes: string;
  updated_by: string;
  source_event_id?: string | null;
  /** Capture instant of the writing event; drives the replay-ordering guard in the upsert. */
  event_occurred_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function ts(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export const TASK_SLA_CONFIG_COLUMNS = `id, site_id, task_type, zone_id, threshold_minutes::text AS threshold_minutes,
       updated_by, source_event_id, event_occurred_at, created_at, updated_at`;

function mapRow(row: Record<string, unknown>): TaskSlaConfig {
  return {
    id: row['id'] as string,
    site_id: row['site_id'] as string,
    task_type: row['task_type'] as WarehouseTaskType,
    zone_id: (row['zone_id'] as string | null) ?? null,
    threshold_minutes: String(row['threshold_minutes']),
    updated_by: row['updated_by'] as string,
    source_event_id: (row['source_event_id'] as string | null) ?? null,
    event_occurred_at: ts(row['event_occurred_at']),
    created_at: ts(row['created_at']),
    updated_at: ts(row['updated_at']),
  };
}

/**
 * Resolves the threshold governing a task: the zone-specific row when one exists for this zone,
 * otherwise the site-wide (`zone_id IS NULL`) default for the SAME site. Ordering by
 * `zone_id IS NULL` puts the zone-specific row first, so LIMIT 1 always picks the more specific
 * configuration. Returns null when neither exists, which callers must treat as "no SLA configured",
 * never as "never breaches" by accident - see listOpenTasks, which leaves `breached` false and the
 * threshold null in that case and says so explicitly rather than defaulting to some invented number.
 */
export async function getSlaConfig(
  taskType: WarehouseTaskType,
  siteId: string,
  zoneId?: string | null,
  client?: PoolClient,
): Promise<TaskSlaConfig | null> {
  const result = await runner(client).query(
    `SELECT ${TASK_SLA_CONFIG_COLUMNS}
       FROM task_sla_config
      WHERE site_id = $1
        AND task_type = $2
        AND (zone_id IS NULL OR zone_id = $3::uuid)
      ORDER BY (zone_id IS NULL)
      LIMIT 1`,
    [siteId, taskType, zoneId ?? null],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

/**
 * Lists configured thresholds. A `zoneId` filter deliberately also returns that site's null-zone
 * default rather than only the zone-specific row. Plain `zone_id = $n` excludes NULL by SQL NULL
 * semantics, so filtering by a zone with no override used to return an empty list - reading as "no
 * SLA configured for this zone" - while getSlaConfig on the very same request correctly fell back to
 * the site-wide row and the board flagged that zone's tasks as breached. The config screen and the
 * board must not be able to disagree about whether a zone has an SLA.
 */
export async function listSlaConfig(
  filters: { siteId?: string | null; siteAny?: string[] | null; taskType?: WarehouseTaskType | null; zoneId?: string | null } = {},
  client?: PoolClient,
): Promise<TaskSlaConfig[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    clauses.push(sql.replace('?', `$${values.length}`));
  };
  if (filters.siteId) add('site_id = ?', filters.siteId);
  else if (filters.siteAny && filters.siteAny.length > 0) add('site_id = ANY(?::uuid[])', filters.siteAny);
  if (filters.taskType) add('task_type = ?', filters.taskType);
  if (filters.zoneId) add('(zone_id = ? OR zone_id IS NULL)', filters.zoneId);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await runner(client).query(
    `SELECT ${TASK_SLA_CONFIG_COLUMNS} FROM task_sla_config ${where}
      ORDER BY site_id, task_type, (zone_id IS NULL), zone_id`,
    values,
  );
  return result.rows.map(mapRow);
}

/**
 * Idempotent upsert on the (site_id, task_type, zone_id) grain. The ON CONFLICT target is the
 * uq_task_sla_config_grain NULLS NOT DISTINCT index, which is what lets the site-wide row
 * (zone_id IS NULL) collide with itself instead of stacking duplicates. threshold_minutes is bound
 * as a NUMERIC string, never a JS float.
 *
 * The `WHERE` on the DO UPDATE is the replay-ordering guard. Without it the apply was an
 * unconditional overwrite, so replaying event v1 after v2 silently reinstated a superseded threshold
 * and changed which live tasks read as breached, and two concurrent supervisor writes could leave
 * the row disagreeing with its own event stream about which value is current. An event whose
 * capture instant is older than what the row already carries is now a no-op; because a no-op
 * suppresses RETURNING, the current row is read back so callers always receive the authoritative
 * state rather than undefined.
 */
export async function upsertSlaConfig(input: UpsertTaskSlaConfigInput, client: PoolClient): Promise<TaskSlaConfig> {
  const values = [
    input.id,
    input.site_id,
    input.task_type,
    input.zone_id ?? null,
    input.threshold_minutes,
    input.updated_by,
    input.source_event_id ?? null,
    input.event_occurred_at,
  ];
  const result = await client.query(
    `INSERT INTO task_sla_config
       (id, site_id, task_type, zone_id, threshold_minutes, updated_by, source_event_id, event_occurred_at)
     VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8::timestamptz)
     ON CONFLICT (site_id, task_type, zone_id) DO UPDATE SET
       threshold_minutes = EXCLUDED.threshold_minutes,
       updated_by = EXCLUDED.updated_by,
       source_event_id = EXCLUDED.source_event_id,
       event_occurred_at = EXCLUDED.event_occurred_at,
       updated_at = now()
     -- Tie-break: when two events share event_occurred_at, the higher source_event_id wins so the
     -- result is deterministic instead of whichever INSERT raced last.
     WHERE task_sla_config.event_occurred_at < EXCLUDED.event_occurred_at
        OR (task_sla_config.event_occurred_at = EXCLUDED.event_occurred_at
            AND COALESCE(task_sla_config.source_event_id, '00000000-0000-0000-0000-000000000000')
              < COALESCE(EXCLUDED.source_event_id, '00000000-0000-0000-0000-000000000000'))
     RETURNING ${TASK_SLA_CONFIG_COLUMNS}`,
    values,
  );
  if (result.rows.length > 0) return mapRow(result.rows[0]!);

  const current = await client.query(
    `SELECT ${TASK_SLA_CONFIG_COLUMNS}
       FROM task_sla_config
      WHERE site_id = $1 AND task_type = $2 AND zone_id IS NOT DISTINCT FROM $3::uuid`,
    [input.site_id, input.task_type, input.zone_id ?? null],
  );
  return mapRow(current.rows[0]!);
}
