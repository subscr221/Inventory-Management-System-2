import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/** Story 7.3 accessors for the maintenance downtime table (FR-M-06). */
export interface MaintenanceDowntimeRow {
  downtime_id: string;
  work_order_id: string;
  asset_id: string;
  started_at: string;
  ended_at: string | null;
  duration_minutes: string | null;
  closed_by: string | null;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// NUMERIC columns are cast to text so a duration serializes with its exact stored value and the
// report arithmetic (all NUMERIC in SQL) can read it back losslessly.
const DOWNTIME_COLUMNS = `downtime_id, work_order_id, asset_id, started_at, ended_at,
    duration_minutes::text AS duration_minutes, closed_by, created_at, updated_at`;

export async function getDowntimeByWorkOrder(
  workOrderId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<MaintenanceDowntimeRow | null> {
  if (!UUID_REGEX.test(workOrderId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT ${DOWNTIME_COLUMNS} FROM maintenance_downtime WHERE work_order_id = $1${lockClause}`,
    [workOrderId],
  );
  return (result.rows[0] as MaintenanceDowntimeRow) ?? null;
}

export interface InsertDowntimeRow {
  downtime_id: string;
  work_order_id: string;
  asset_id: string;
  started_at: string;
  created_at: string;
  updated_at: string;
}

export async function insertDowntime(row: InsertDowntimeRow, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO maintenance_downtime (
      downtime_id, work_order_id, asset_id, started_at, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      row.downtime_id,
      row.work_order_id,
      row.asset_id,
      row.started_at,
      row.created_at,
      row.updated_at,
    ],
  );
}

/**
 * Closes the window, computing duration_minutes IN SQL so the stored number and the reliability
 * report's EXTRACT(EPOCH ...) arithmetic agree exactly (never a JS float, never a rounding drift).
 */
export async function closeDowntime(
  downtimeId: string,
  endedAt: string,
  closedBy: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE maintenance_downtime
        SET ended_at = $2,
            duration_minutes = EXTRACT(EPOCH FROM ($2::timestamptz - started_at)) / 60,
            closed_by = $3,
            updated_at = now()
      WHERE downtime_id = $1`,
    [downtimeId, endedAt, closedBy],
  );
}

export interface SummarizeDowntimeParams {
  period_start: string;
  period_end: string;
  asset_id?: string | undefined;
  scope_type: 'asset' | 'criticality_class';
}

export interface DowntimeSummaryRow {
  scope_key: string;
  breakdown_count: number;
  downtime_minutes: string;
  assets_in_scope: number;
}

/**
 * The reliability report's aggregation surface (Reliability Computation Contract). All grouping
 * and summing runs in SQL, never in JS loops over row sets. Eligible work orders are origin =
 * 'breakdown' with a downtime row whose ended_at falls inside
 * [period_start 00:00Z, period_end 23:59:59.999Z] (expressed as a half-open interval over the
 * DATE range). scope_type 'asset' yields one row per asset with at least one eligible work order
 * (assets_in_scope = 1); 'criticality_class' yields one row per class (assets_in_scope = distinct
 * assets in that class that had at least one eligible work order). A scope with zero eligible work
 * orders produces no row.
 */
export async function summarizeDowntime(
  params: SummarizeDowntimeParams,
  client?: PoolClient,
): Promise<DowntimeSummaryRow[]> {
  const r = runner(client);
  const assetFilter = params.asset_id ? ' AND d.asset_id = $3' : '';
  const values: (string | number)[] = params.asset_id
    ? [params.period_start, params.period_end, params.asset_id]
    : [params.period_start, params.period_end];
  const scopeExpr = params.scope_type === 'asset' ? 'd.asset_id::text' : 'a.criticality_class';
  const assetsExpr = params.scope_type === 'asset' ? '1' : 'count(DISTINCT d.asset_id)::int';
  const result = await r.query(
    `SELECT ${scopeExpr} AS scope_key,
            count(*)::int AS breakdown_count,
            COALESCE(sum(d.duration_minutes), 0)::text AS downtime_minutes,
            ${assetsExpr} AS assets_in_scope
       FROM maintenance_downtime d
       JOIN maintenance_work_order w ON w.work_order_id = d.work_order_id
       JOIN asset a ON a.asset_id = d.asset_id
      WHERE w.origin = 'breakdown'
        AND d.ended_at IS NOT NULL
        AND d.ended_at >= ($1::date AT TIME ZONE 'UTC')
        AND d.ended_at < (($2::date + 1) AT TIME ZONE 'UTC')${assetFilter}
      GROUP BY ${scopeExpr}
      ORDER BY ${scopeExpr} ASC`,
    values,
  );
  return result.rows as DowntimeSummaryRow[];
}
