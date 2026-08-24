import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/** Story 7.3 accessors for the maintenance reliability metric snapshot table (FR-M-06). */
export interface MaintenanceReliabilityMetricRow {
  metric_id: string;
  report_id: string;
  period_start: string;
  period_end: string;
  scope_type: 'asset' | 'criticality_class';
  scope_key: string;
  breakdown_count: number;
  downtime_minutes: string;
  mttr_minutes: string | null;
  mtbf_minutes: string | null;
  generated_by: string;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const SCOPE_TYPES = new Set(['asset', 'criticality_class']);

const RELIABILITY_COLUMNS = `metric_id, report_id,
    to_char(period_start, 'YYYY-MM-DD') AS period_start,
    to_char(period_end, 'YYYY-MM-DD') AS period_end,
    scope_type, scope_key, breakdown_count,
    downtime_minutes::text AS downtime_minutes,
    mttr_minutes::text AS mttr_minutes,
    mtbf_minutes::text AS mtbf_minutes,
    generated_by, created_at`;

export async function getMetricByScope(
  periodStart: string,
  periodEnd: string,
  scopeType: string,
  scopeKey: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<MaintenanceReliabilityMetricRow | null> {
  if (!SCOPE_TYPES.has(scopeType)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT ${RELIABILITY_COLUMNS} FROM maintenance_reliability_metric
      WHERE period_start = $1::date AND period_end = $2::date
        AND scope_type = $3 AND scope_key = $4${lockClause}`,
    [periodStart, periodEnd, scopeType, scopeKey],
  );
  return (result.rows[0] as MaintenanceReliabilityMetricRow) ?? null;
}

export interface InsertReliabilityMetricRow {
  metric_id: string;
  report_id: string;
  period_start: string;
  period_end: string;
  scope_type: 'asset' | 'criticality_class';
  scope_key: string;
  breakdown_count: number;
  downtime_minutes: string;
  mttr_minutes: string | null;
  mtbf_minutes: string | null;
  generated_by: string;
}

export async function insertReliabilityMetric(
  row: InsertReliabilityMetricRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO maintenance_reliability_metric (
      metric_id, report_id, period_start, period_end, scope_type, scope_key,
      breakdown_count, downtime_minutes, mttr_minutes, mtbf_minutes, generated_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      row.metric_id,
      row.report_id,
      row.period_start,
      row.period_end,
      row.scope_type,
      row.scope_key,
      row.breakdown_count,
      row.downtime_minutes,
      row.mttr_minutes,
      row.mtbf_minutes,
      row.generated_by,
    ],
  );
}

export interface ListReliabilityMetricsParams {
  period_start?: string | undefined;
  period_end?: string | undefined;
  scope_type?: 'asset' | 'criticality_class' | undefined;
  scope_key?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listReliabilityMetrics(
  params: ListReliabilityMetricsParams,
  client?: PoolClient,
): Promise<MaintenanceReliabilityMetricRow[]> {
  const r = runner(client);
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;

  if (params.period_start) {
    if (Number.isNaN(Date.parse(params.period_start))) return [];
    conditions.push(`period_start = $${idx++}::date`);
    values.push(params.period_start);
  }
  if (params.period_end) {
    if (Number.isNaN(Date.parse(params.period_end))) return [];
    conditions.push(`period_end = $${idx++}::date`);
    values.push(params.period_end);
  }
  if (params.scope_type) {
    if (!SCOPE_TYPES.has(params.scope_type)) return [];
    conditions.push(`scope_type = $${idx++}`);
    values.push(params.scope_type);
  }
  if (params.scope_key) {
    conditions.push(`scope_key = $${idx++}`);
    values.push(params.scope_key);
  }

  const limit = Number.isFinite(params.limit ?? 100)
    ? Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 500)
    : 100;
  const offset = Number.isFinite(params.offset ?? 0)
    ? Math.max(Math.trunc(params.offset ?? 0), 0)
    : 0;
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await r.query(
    `SELECT ${RELIABILITY_COLUMNS} FROM maintenance_reliability_metric ${where}
      ORDER BY period_start ASC, period_end ASC, scope_type ASC, scope_key ASC
      LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as MaintenanceReliabilityMetricRow[];
}
