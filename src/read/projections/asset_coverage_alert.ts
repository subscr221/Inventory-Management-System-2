import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 7.7 accessors for the staged coverage expiry alerts (FR-M-10, AC 1).
 *
 * The grain is (coverage_id, stage_days): getCoverageAlertForStage is the existence check the scan
 * and the applier both run before writing, and uq_asset_coverage_alert_stage is the concurrency
 * backstop behind it. DATE columns are rendered to text in SQL, never handed back as JS Dates.
 */
export interface CoverageAlertRow {
  alert_id: string;
  coverage_id: string;
  asset_id: string;
  stage_days: number;
  expiry_date: string;
  business_date: string;
  flagged_at: string;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALERT_COLUMNS = `alert_id, coverage_id, asset_id, stage_days,
    to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date,
    to_char(business_date, 'YYYY-MM-DD') AS business_date,
    flagged_at, created_at`;

export interface InsertCoverageAlertRow {
  alert_id: string;
  coverage_id: string;
  asset_id: string;
  stage_days: number;
  expiry_date: string;
  business_date: string;
  flagged_at: string;
}

export async function insertCoverageAlert(
  row: InsertCoverageAlertRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO asset_coverage_alert (
      alert_id, coverage_id, asset_id, stage_days, expiry_date, business_date, flagged_at
    ) VALUES ($1,$2,$3,$4,$5::date,$6::date,$7)`,
    [
      row.alert_id,
      row.coverage_id,
      row.asset_id,
      row.stage_days,
      row.expiry_date,
      row.business_date,
      row.flagged_at,
    ],
  );
}

export async function getCoverageAlertForStage(
  coverageId: string,
  stageDays: number,
  client?: PoolClient,
): Promise<CoverageAlertRow | null> {
  if (!UUID_REGEX.test(coverageId)) return null;
  if (!Number.isInteger(stageDays)) return null;
  const result = await runner(client).query(
    `SELECT ${ALERT_COLUMNS} FROM asset_coverage_alert
      WHERE coverage_id = $1 AND stage_days = $2`,
    [coverageId, stageDays],
  );
  return (result.rows[0] as CoverageAlertRow) ?? null;
}

export async function getCoverageAlertById(
  alertId: string,
  client?: PoolClient,
): Promise<CoverageAlertRow | null> {
  if (!UUID_REGEX.test(alertId)) return null;
  const result = await runner(client).query(
    `SELECT ${ALERT_COLUMNS} FROM asset_coverage_alert WHERE alert_id = $1`,
    [alertId],
  );
  return (result.rows[0] as CoverageAlertRow) ?? null;
}

export interface ListCoverageAlertFilters {
  coverage_id?: string | null | undefined;
  asset_id?: string | null | undefined;
  stage_days?: number | null | undefined;
}

export interface ListPaging {
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listCoverageAlerts(
  filters: ListCoverageAlertFilters = {},
  paging: ListPaging = {},
  client?: PoolClient,
): Promise<CoverageAlertRow[]> {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;
  if (filters.coverage_id) {
    if (!UUID_REGEX.test(filters.coverage_id)) return [];
    conditions.push(`coverage_id = $${idx++}`);
    values.push(filters.coverage_id);
  }
  if (filters.asset_id) {
    if (!UUID_REGEX.test(filters.asset_id)) return [];
    conditions.push(`asset_id = $${idx++}`);
    values.push(filters.asset_id);
  }
  if (filters.stage_days !== undefined && filters.stage_days !== null) {
    if (!Number.isInteger(filters.stage_days)) return [];
    conditions.push(`stage_days = $${idx++}`);
    values.push(filters.stage_days);
  }
  const limit = Number.isFinite(paging.limit ?? 100)
    ? Math.min(Math.max(Math.trunc(paging.limit ?? 100), 1), 500)
    : 100;
  const offset = Number.isFinite(paging.offset ?? 0)
    ? Math.max(Math.trunc(paging.offset ?? 0), 0)
    : 0;
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await runner(client).query(
    `SELECT ${ALERT_COLUMNS} FROM asset_coverage_alert
      ${where}
      ORDER BY flagged_at DESC, alert_id ASC
      LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as CoverageAlertRow[];
}
