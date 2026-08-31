import type { PoolClient } from 'pg';
import { getPool } from '../config/db.js';

/**
 * Story 8.6 (FR-Q-13, AC 5/6/7): the quality reporting dashboard aggregation. One exported
 * function per metric plus the buildQualityDashboard orchestrator, kept out of the ~5,000-line
 * src/compliance/quality.ts (the Story 8.5 recall-trace.ts precedent).
 *
 * AD-14: reads SHARED projections only - qc_lot_disposition, qc_inspection_task, qc_ncr,
 * qc_capa, qc_deviation and audit_log - never the event store and no module-private tables. No
 * new metric projections exist (Binding Scope Decision 10); everything is computed on read.
 *
 * Metric definitions are FIXED by Binding Scope Decision 11. First-pass yield rests on the
 * one-row-per-lot grain of uq_qc_lot_disposition_lot (verified a full, not partial, unique at
 * implementation time), so every disposition row IS the lot's first disposition. NUMERIC outputs
 * leave the database as ::text; ratios are computed here and returned as fixed-2-decimal strings.
 *
 * Empty periods return first-class no-data shapes: a zero denominator reports state 'no_data'
 * with a null rate, never a fabricated 0% or 100% (AC 6, the supplier-scorecard rule).
 *
 * Site narrowing (AC 7): `siteFilter` is null for a wildcard `qc` read (no narrowing) or the
 * caller's permitted site-id list. qc_capa carries NO site column (an enterprise-wide register,
 * like the defect-code catalogue it hangs off), so the CAPA metric is not site-narrowed - the
 * one metric-level exception, stated here deliberately.
 *
 * Calibration lockouts (Binding Scope Decision 12): counted from audit_log filtered on
 * error_code = 'CALIBRATION_LOCKOUT'. No lockout event or counter projection exists (the Story
 * 8.2 rejection writes only the statutory audit row) and this story does not create one. The
 * archival CLI can move old rows to audit_log_archive, so counts over windows reaching past the
 * archive horizon are LOWER BOUNDS; the response carries coverage: 'live_audit_log_only' to say
 * so. Site narrowing for this metric matches audit_log.location_id (TEXT - the Story 8.2 lockout
 * audit rows stamp the task's site uuid there) or details->>'site_id' when present.
 */

export interface DashboardPeriod {
  /** Inclusive IST calendar dates, YYYY-MM-DD. */
  from: string;
  to: string;
  /** The IST calendar date "today" used for aging buckets and expiry splits. */
  asOf: string;
}

/** Bounded drill-through series limit (the supplier-scorecard 200-row rule). */
export const DASHBOARD_SERIES_LIMIT = 200;

export const DASHBOARD_COVERAGE = 'live_audit_log_only' as const;

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

/** null = wildcard (no narrowing); [] = caller can see no site (every narrowed metric is empty). */
export type SiteFilter = string[] | null;

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

/** Fixed-2-decimal percentage string, or null on a zero denominator (no-data, never 0%). */
/** Exported for the parameterised FPY/rejection-rate boundary unit tests (Task 9). */
export function percent(numerator: number, denominator: number): string | null {
  if (denominator === 0) return null;
  return ((numerator / denominator) * 100).toFixed(2);
}

/**
 * WHERE-fragment helper: appends an `= ANY` site condition when the filter narrows. `column` is a
 * trusted literal from this module, never caller input.
 */
function siteCondition(
  column: string,
  filter: SiteFilter,
  values: unknown[],
): string {
  if (filter === null) return '';
  values.push(filter);
  return ` AND ${column} = ANY($${values.length}::uuid[])`;
}

/** First-pass yield: accepted lots over dispositioned lots, on the IST date of decided_at. */
export async function firstPassYieldMetric(
  period: DashboardPeriod,
  siteFilter: SiteFilter,
  client?: PoolClient,
): Promise<Record<string, unknown>> {
  const values: unknown[] = [period.from, period.to];
  const site = siteCondition('t.site_id', siteFilter, values);
  const result = await runner(client).query(
    `SELECT d.disposition_id, d.lot_id, d.task_id, t.sku, t.site_id, d.disposition,
            d.decided_at
       FROM qc_lot_disposition d
       JOIN qc_inspection_task t ON t.task_id = d.task_id
      WHERE (d.decided_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date${site}
      ORDER BY d.decided_at DESC, d.disposition_id
      LIMIT ${DASHBOARD_SERIES_LIMIT}`,
    values,
  );
  const countValues: unknown[] = [period.from, period.to];
  const countSite = siteCondition('t.site_id', siteFilter, countValues);
  const counts = await runner(client).query(
    `SELECT COUNT(*)::text AS dispositioned,
            COUNT(*) FILTER (WHERE d.disposition = 'accept')::text AS accepted
       FROM qc_lot_disposition d
       JOIN qc_inspection_task t ON t.task_id = d.task_id
      WHERE (d.decided_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date${countSite}`,
    countValues,
  );
  const dispositioned = Number(counts.rows[0]!['dispositioned']);
  const accepted = Number(counts.rows[0]!['accepted']);
  return {
    state: dispositioned === 0 ? 'no_data' : 'ok',
    lots_dispositioned: dispositioned,
    lots_accepted: accepted,
    yield_percent: percent(accepted, dispositioned),
    series: result.rows.map((row) => ({
      disposition_id: row['disposition_id'],
      lot_id: row['lot_id'],
      task_id: row['task_id'],
      sku: row['sku'],
      site_id: row['site_id'],
      disposition: row['disposition'],
      decided_at: toIso(row['decided_at']),
    })),
  };
}

/** Rejection rate by product: reject dispositions over dispositions, grouped by the task's sku. */
export async function rejectionRateByProductMetric(
  period: DashboardPeriod,
  siteFilter: SiteFilter,
  client?: PoolClient,
): Promise<Record<string, unknown>> {
  const values: unknown[] = [period.from, period.to];
  const site = siteCondition('t.site_id', siteFilter, values);
  const groups = await runner(client).query(
    `SELECT t.sku,
            COUNT(*)::text AS dispositioned,
            COUNT(*) FILTER (WHERE d.disposition = 'reject')::text AS rejected
       FROM qc_lot_disposition d
       JOIN qc_inspection_task t ON t.task_id = d.task_id
      WHERE (d.decided_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date${site}
      GROUP BY t.sku
      ORDER BY COUNT(*) FILTER (WHERE d.disposition = 'reject') DESC, t.sku`,
    values,
  );
  const seriesValues: unknown[] = [period.from, period.to];
  const seriesSite = siteCondition('t.site_id', siteFilter, seriesValues);
  const series = await runner(client).query(
    `SELECT d.disposition_id, d.lot_id, d.task_id, t.sku, t.site_id, d.decided_at
       FROM qc_lot_disposition d
       JOIN qc_inspection_task t ON t.task_id = d.task_id
      WHERE d.disposition = 'reject'
        AND (d.decided_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date${seriesSite}
      ORDER BY d.decided_at DESC, d.disposition_id
      LIMIT ${DASHBOARD_SERIES_LIMIT}`,
    seriesValues,
  );
  return {
    state: groups.rows.length === 0 ? 'no_data' : 'ok',
    by_product: groups.rows.map((row) => ({
      sku: row['sku'],
      dispositioned: Number(row['dispositioned']),
      rejected: Number(row['rejected']),
      rejection_rate_percent: percent(Number(row['rejected']), Number(row['dispositioned'])),
    })),
    series: series.rows.map((row) => ({
      disposition_id: row['disposition_id'],
      lot_id: row['lot_id'],
      task_id: row['task_id'],
      sku: row['sku'],
      site_id: row['site_id'],
      decided_at: toIso(row['decided_at']),
    })),
  };
}

/** Rejection by defect code: qc_ncr rows in period, NULL codes bucketed as UNSPECIFIED. */
export async function rejectionRateByDefectCodeMetric(
  period: DashboardPeriod,
  siteFilter: SiteFilter,
  client?: PoolClient,
): Promise<Record<string, unknown>> {
  const values: unknown[] = [period.from, period.to];
  const site = siteCondition('n.site_id', siteFilter, values);
  const groups = await runner(client).query(
    `SELECT COALESCE(n.defect_code, 'UNSPECIFIED') AS defect_code, COUNT(*)::text AS ncr_count
       FROM qc_ncr n
      WHERE (n.raised_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date${site}
      GROUP BY COALESCE(n.defect_code, 'UNSPECIFIED')
      ORDER BY COUNT(*) DESC, COALESCE(n.defect_code, 'UNSPECIFIED')`,
    values,
  );
  const seriesValues: unknown[] = [period.from, period.to];
  const seriesSite = siteCondition('n.site_id', siteFilter, seriesValues);
  const series = await runner(client).query(
    `SELECT n.ncr_id, n.lot_id, n.sku, n.site_id, n.origin,
            COALESCE(n.defect_code, 'UNSPECIFIED') AS defect_code, n.raised_at
       FROM qc_ncr n
      WHERE (n.raised_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date${seriesSite}
      ORDER BY n.raised_at DESC, n.ncr_id
      LIMIT ${DASHBOARD_SERIES_LIMIT}`,
    seriesValues,
  );
  return {
    state: groups.rows.length === 0 ? 'no_data' : 'ok',
    by_defect_code: groups.rows.map((row) => ({
      defect_code: row['defect_code'],
      ncr_count: Number(row['ncr_count']),
    })),
    series: series.rows.map((row) => ({
      ncr_id: row['ncr_id'],
      lot_id: row['lot_id'],
      sku: row['sku'],
      site_id: row['site_id'],
      origin: row['origin'],
      defect_code: row['defect_code'],
      raised_at: toIso(row['raised_at']),
    })),
  };
}

/** The fixed aging bucket labels shared by the NCR and CAPA aging metrics. */
export const AGING_BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/**
 * Buckets a non-negative age in whole days. Exported for the parameterised boundary unit tests:
 * day 30 is the last of '0-30', day 31 the first of '31-60', day 91 lands in '90+'.
 */
export function agingBucketFor(ageDays: number): AgingBucket {
  if (ageDays <= 30) return '0-30';
  if (ageDays <= 60) return '31-60';
  if (ageDays <= 90) return '61-90';
  return '90+';
}

function emptyBuckets(): Record<AgingBucket, number> {
  return { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
}

/** NCR aging: OPEN NCRs (outcome IS NULL), aged in IST days from raised_at to asOf. */
export async function ncrAgingMetric(
  period: DashboardPeriod,
  siteFilter: SiteFilter,
  client?: PoolClient,
): Promise<Record<string, unknown>> {
  const values: unknown[] = [period.asOf];
  const site = siteCondition('n.site_id', siteFilter, values);
  const result = await runner(client).query(
    `SELECT n.ncr_id, n.lot_id, n.sku, n.site_id, n.raised_at,
            ($1::date - (n.raised_at AT TIME ZONE 'Asia/Kolkata')::date)::int AS age_days
       FROM qc_ncr n
      WHERE n.outcome IS NULL${site}
      ORDER BY n.raised_at DESC, n.ncr_id
      LIMIT ${DASHBOARD_SERIES_LIMIT}`,
    values,
  );
  const countValues: unknown[] = [];
  const countSite = siteCondition('n.site_id', siteFilter, countValues);
  const counts = await runner(client).query(
    `SELECT COUNT(*)::text AS open_count
       FROM qc_ncr n
      WHERE n.outcome IS NULL${countSite}`,
    countValues,
  );
  const buckets = emptyBuckets();
  const bucketValues: unknown[] = [period.asOf];
  const bucketSite = siteCondition('n.site_id', siteFilter, bucketValues);
  const bucketCounts = await runner(client).query(
    `SELECT GREATEST(($1::date - (n.raised_at AT TIME ZONE 'Asia/Kolkata')::date)::int, 0) AS age_days
       FROM qc_ncr n
      WHERE n.outcome IS NULL${bucketSite}`,
    bucketValues,
  );
  for (const row of bucketCounts.rows) {
    buckets[agingBucketFor(Number(row['age_days']))] += 1;
  }
  const openCount = Number(counts.rows[0]!['open_count']);
  return {
    state: openCount === 0 ? 'no_data' : 'ok',
    open_count: openCount,
    buckets,
    series: result.rows.map((row) => ({
      ncr_id: row['ncr_id'],
      lot_id: row['lot_id'],
      sku: row['sku'],
      site_id: row['site_id'],
      raised_at: toIso(row['raised_at']),
      age_days: Math.max(Number(row['age_days']), 0),
      bucket: agingBucketFor(Math.max(Number(row['age_days']), 0)),
    })),
  };
}

/**
 * CAPA aging: OPEN CAPAs aged from opened_at, with an overdue count where due_on < asOf. qc_capa
 * carries no site column (an enterprise-wide register), so this metric is NOT site-narrowed - the
 * documented exception to AC 7's narrowing.
 */
export async function capaAgingMetric(
  period: DashboardPeriod,
  client?: PoolClient,
): Promise<Record<string, unknown>> {
  const result = await runner(client).query(
    `SELECT c.capa_id, c.capa_number, c.sku, c.defect_code, c.due_on::text AS due_on, c.opened_at,
            GREATEST(($1::date - (c.opened_at AT TIME ZONE 'Asia/Kolkata')::date)::int, 0) AS age_days,
            (c.due_on < $1::date) AS overdue
       FROM qc_capa c
      WHERE c.status = 'open'
      ORDER BY c.opened_at DESC, c.capa_id
      LIMIT ${DASHBOARD_SERIES_LIMIT}`,
    [period.asOf],
  );
  const counts = await runner(client).query(
    `SELECT COUNT(*)::text AS open_count,
            COUNT(*) FILTER (WHERE c.due_on < $1::date)::text AS overdue_count
       FROM qc_capa c
      WHERE c.status = 'open'`,
    [period.asOf],
  );
  const buckets = emptyBuckets();
  const bucketRows = await runner(client).query(
    `SELECT GREATEST(($1::date - (c.opened_at AT TIME ZONE 'Asia/Kolkata')::date)::int, 0) AS age_days
       FROM qc_capa c
      WHERE c.status = 'open'`,
    [period.asOf],
  );
  for (const row of bucketRows.rows) {
    buckets[agingBucketFor(Number(row['age_days']))] += 1;
  }
  const openCount = Number(counts.rows[0]!['open_count']);
  return {
    state: openCount === 0 ? 'no_data' : 'ok',
    open_count: openCount,
    overdue_count: Number(counts.rows[0]!['overdue_count']),
    buckets,
    series: result.rows.map((row) => ({
      capa_id: row['capa_id'],
      capa_number: row['capa_number'],
      sku: row['sku'],
      defect_code: row['defect_code'],
      due_on: String(row['due_on']),
      opened_at: toIso(row['opened_at']),
      age_days: Number(row['age_days']),
      bucket: agingBucketFor(Number(row['age_days'])),
      overdue: row['overdue'] === true,
    })),
  };
}

/**
 * Conditional releases decided in the period, split active vs expired against the authorizing
 * deviation's expires_on as of asOf. A conditional release whose deviation cannot be resolved
 * counts as expired (fail-closed on the reporting axis too).
 */
export async function conditionalReleaseMetric(
  period: DashboardPeriod,
  siteFilter: SiteFilter,
  client?: PoolClient,
): Promise<Record<string, unknown>> {
  const values: unknown[] = [period.from, period.to, period.asOf];
  const site = siteCondition('t.site_id', siteFilter, values);
  const result = await runner(client).query(
    `SELECT d.disposition_id, d.lot_id, d.task_id, t.sku, t.site_id, d.decided_at,
            d.deviation_id, v.expires_on::text AS expires_on,
            (v.expires_on IS NOT NULL AND v.expires_on >= $3::date) AS active
       FROM qc_lot_disposition d
       JOIN qc_inspection_task t ON t.task_id = d.task_id
       LEFT JOIN qc_deviation v ON v.deviation_id = d.deviation_id
      WHERE d.disposition = 'conditional_release'
        AND (d.decided_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date${site}
      ORDER BY d.decided_at DESC, d.disposition_id
      LIMIT ${DASHBOARD_SERIES_LIMIT}`,
    values,
  );
  const countValues: unknown[] = [period.from, period.to, period.asOf];
  const countSite = siteCondition('t.site_id', siteFilter, countValues);
  const counts = await runner(client).query(
    `SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE v.expires_on IS NOT NULL AND v.expires_on >= $3::date)::text AS active
       FROM qc_lot_disposition d
       JOIN qc_inspection_task t ON t.task_id = d.task_id
       LEFT JOIN qc_deviation v ON v.deviation_id = d.deviation_id
      WHERE d.disposition = 'conditional_release'
        AND (d.decided_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date${countSite}`,
    countValues,
  );
  const total = Number(counts.rows[0]!['total']);
  const active = Number(counts.rows[0]!['active']);
  return {
    state: total === 0 ? 'no_data' : 'ok',
    total,
    active,
    expired: total - active,
    series: result.rows.map((row) => ({
      disposition_id: row['disposition_id'],
      lot_id: row['lot_id'],
      task_id: row['task_id'],
      sku: row['sku'],
      site_id: row['site_id'],
      deviation_id: row['deviation_id'],
      expires_on: row['expires_on'] === null ? null : String(row['expires_on']),
      active: row['active'] === true,
      decided_at: toIso(row['decided_at']),
    })),
  };
}

/**
 * Calibration lockout events from the LIVE audit_log only (Binding Scope Decision 12; see the
 * module doc comment for the archive caveat). Site narrowing matches location_id (TEXT - the
 * Story 8.2 lockout rows stamp the task's site uuid there) or details->>'site_id' when present.
 */
export async function calibrationLockoutMetric(
  period: DashboardPeriod,
  siteFilter: SiteFilter,
  client?: PoolClient,
): Promise<Record<string, unknown>> {
  const values: unknown[] = [period.from, period.to];
  let site = '';
  if (siteFilter !== null) {
    values.push(siteFilter);
    site = ` AND (a.location_id = ANY($${values.length}::text[])
        OR a.details->>'site_id' = ANY($${values.length}::text[]))`;
  }
  const result = await runner(client).query(
    `SELECT a.log_id, a.timestamp, a.user_id, a.endpoint, a.details
       FROM audit_log a
      WHERE a.error_code = 'CALIBRATION_LOCKOUT'
        AND (a.timestamp AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date${site}
      ORDER BY a.timestamp DESC, a.log_id
      LIMIT ${DASHBOARD_SERIES_LIMIT}`,
    values,
  );
  const counts = await runner(client).query(
    `SELECT COUNT(*)::text AS lockout_count
       FROM audit_log a
      WHERE a.error_code = 'CALIBRATION_LOCKOUT'
        AND (a.timestamp AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date${site}`,
    values,
  );
  const lockoutCount = Number(counts.rows[0]!['lockout_count']);
  return {
    state: lockoutCount === 0 ? 'no_data' : 'ok',
    lockout_count: lockoutCount,
    coverage: DASHBOARD_COVERAGE,
    series: result.rows.map((row) => ({
      log_id: row['log_id'],
      timestamp: toIso(row['timestamp']),
      user_id: row['user_id'],
      endpoint: row['endpoint'],
      details: row['details'],
    })),
  };
}

/** The full FR-Q-13 dashboard: every metric over the same period and site scope. */
export async function buildQualityDashboard(
  period: DashboardPeriod,
  siteFilter: SiteFilter,
  client?: PoolClient,
): Promise<Record<string, unknown>> {
  return {
    first_pass_yield: await firstPassYieldMetric(period, siteFilter, client),
    rejection_rate_by_product: await rejectionRateByProductMetric(period, siteFilter, client),
    rejection_rate_by_defect_code: await rejectionRateByDefectCodeMetric(
      period,
      siteFilter,
      client,
    ),
    ncr_aging: await ncrAgingMetric(period, siteFilter, client),
    capa_aging: await capaAgingMetric(period, client),
    conditional_releases: await conditionalReleaseMetric(period, siteFilter, client),
    calibration_lockouts: await calibrationLockoutMetric(period, siteFilter, client),
  };
}
