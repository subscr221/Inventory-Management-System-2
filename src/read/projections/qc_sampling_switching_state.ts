import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 8.2 accessors for the per-(plan, site) ISO 2859-1 clause 9.3 switching state (FR-Q-03,
 * AC 3, Binding Scope Decision 7). The row is read FOR UPDATE at sampling determination and
 * advanced (upsert) at inspection completion and on a QC Head-level adjustment; app_user holds
 * INSERT, SELECT, UPDATE. An absent row means normal inspection with a zero score.
 */

export type SwitchingSeverity = 'normal' | 'tightened' | 'reduced';

export interface QcSwitchingStateRow {
  plan_id: string;
  site_id: string;
  severity: SwitchingSeverity;
  switching_score: number;
  /** At most five most recent original-inspection outcomes, newest last (true = accepted). */
  recent_original_outcomes: boolean[];
  consecutive_accepted_on_tightened: number;
  not_accepted_on_tightened: number;
  reduced_eligible: boolean;
  inspection_discontinued: boolean;
  last_task_id: string | null;
  lots_counted: number;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS = `plan_id, site_id, severity, switching_score, recent_original_outcomes,
    consecutive_accepted_on_tightened, not_accepted_on_tightened, reduced_eligible, inspection_discontinued,
    last_task_id, lots_counted, source_event_id, created_at, updated_at`;

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function mapRow(row: Record<string, unknown>): QcSwitchingStateRow {
  const window = row['recent_original_outcomes'];
  return {
    plan_id: row['plan_id'] as string,
    site_id: row['site_id'] as string,
    severity: row['severity'] as SwitchingSeverity,
    switching_score: Number(row['switching_score']),
    recent_original_outcomes: Array.isArray(window) ? window.map((v) => v === true) : [],
    consecutive_accepted_on_tightened: Number(row['consecutive_accepted_on_tightened']),
    not_accepted_on_tightened: Number(row['not_accepted_on_tightened']),
    reduced_eligible: row['reduced_eligible'] === true,
    inspection_discontinued: row['inspection_discontinued'] === true,
    last_task_id: (row['last_task_id'] as string | null) ?? null,
    lots_counted: Number(row['lots_counted']),
    source_event_id: row['source_event_id'] as string,
    created_at: toIso(row['created_at']),
    updated_at: toIso(row['updated_at']),
  };
}

/** The initial (absent-row) state: normal inspection, zero score, nothing counted. */
export function initialSwitchingState(
  planId: string,
  siteId: string,
  sourceEventId: string,
): Omit<QcSwitchingStateRow, 'created_at' | 'updated_at'> {
  return {
    plan_id: planId,
    site_id: siteId,
    severity: 'normal',
    switching_score: 0,
    recent_original_outcomes: [],
    consecutive_accepted_on_tightened: 0,
    not_accepted_on_tightened: 0,
    reduced_eligible: false,
    inspection_discontinued: false,
    last_task_id: null,
    lots_counted: 0,
    source_event_id: sourceEventId,
  };
}

export async function getSwitchingState(
  planId: string,
  siteId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<QcSwitchingStateRow | null> {
  if (!UUID_REGEX.test(planId) || !UUID_REGEX.test(siteId)) return null;
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM qc_sampling_switching_state WHERE plan_id = $1 AND site_id = $2${lockClause}`,
    [planId, siteId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export interface ListSwitchingStatesParams {
  plan_id?: string | undefined;
  site_id?: string | undefined;
  site_ids?: string[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listSwitchingStates(
  params: ListSwitchingStatesParams,
  client?: PoolClient,
): Promise<QcSwitchingStateRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (clause: string, value: unknown): void => {
    values.push(value);
    where.push(clause.replace('?', `$${values.length}`));
  };
  if (params.plan_id) push('plan_id = ?', params.plan_id);
  if (params.site_id) push('site_id = ?', params.site_id);
  if (params.site_ids) push('site_id = ANY(?::uuid[])', params.site_ids);
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
  const offset = Math.max(params.offset ?? 0, 0);
  values.push(limit, offset);
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM qc_sampling_switching_state
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY plan_id ASC, site_id ASC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function upsertSwitchingState(
  row: Omit<QcSwitchingStateRow, 'created_at' | 'updated_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO qc_sampling_switching_state (plan_id, site_id, severity, switching_score,
       recent_original_outcomes, consecutive_accepted_on_tightened, not_accepted_on_tightened,
       reduced_eligible, inspection_discontinued, last_task_id, lots_counted, source_event_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (plan_id, site_id) DO UPDATE
       SET severity = EXCLUDED.severity,
           switching_score = EXCLUDED.switching_score,
           recent_original_outcomes = EXCLUDED.recent_original_outcomes,
           consecutive_accepted_on_tightened = EXCLUDED.consecutive_accepted_on_tightened,
           not_accepted_on_tightened = EXCLUDED.not_accepted_on_tightened,
           reduced_eligible = EXCLUDED.reduced_eligible,
           inspection_discontinued = EXCLUDED.inspection_discontinued,
           last_task_id = EXCLUDED.last_task_id,
           lots_counted = EXCLUDED.lots_counted,
           source_event_id = EXCLUDED.source_event_id,
           updated_at = now()`,
    [
      row.plan_id,
      row.site_id,
      row.severity,
      row.switching_score,
      JSON.stringify(row.recent_original_outcomes),
      row.consecutive_accepted_on_tightened,
      row.not_accepted_on_tightened,
      row.reduced_eligible,
      row.inspection_discontinued,
      row.last_task_id,
      row.lots_counted,
      row.source_event_id,
    ],
  );
}
