import { randomUUID } from 'node:crypto';
import { persistEvent } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import {
  summarizeDowntime,
  type DowntimeSummaryRow,
} from '../read/projections/maintenance_downtime.js';
import { listBreakdownWorkOrdersInPeriod } from '../read/projections/maintenance_work_order.js';
import type { AuditCtx, MaintenanceJobActor } from './pm-jobs.js';

/**
 * Story 7.3 monthly reliability report job (FR-M-06). This is a pure function driven by the
 * authenticated POST trigger in src/api/v1/maintenance.ts, mirroring the Story 7.2 pm-jobs and the
 * Story 2.7 planning jobs. There is deliberately NO scheduler: "monthly" means the operator or an
 * external scheduler runs it monthly (the codebase-wide convention).
 *
 * The report is a PERSISTED DATED SNAPSHOT, not a live query (Binding Scope Decisions): one
 * maintenance.reliability_report_generated event carries every metric row and the applier inserts
 * them in the SAME transaction, so a report either lands whole or not at all. A re-run of the same
 * period surfaces the stable DUPLICATE_RELIABILITY_REPORT (the applier's anti-double-report check)
 * rather than writing a second snapshot.
 *
 * The job never mutates through raw SQL. It reads committed read models, decides, and writes
 * through persistEvent (AD-14, AD-16).
 */

export interface ReliabilityReportScope {
  business_date: string;
  period_start: string;
  period_end: string;
  asset_id?: string | undefined;
  actor: MaintenanceJobActor;
  auditCtx?: AuditCtx | undefined;
}

export interface ReliabilityReportResult {
  report_id: string | null;
  period_start: string;
  period_end: string;
  assets_evaluated: number;
  metrics_written: number;
  metric_ids: string[];
}

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PERIOD_SPAN_DAYS = 366;

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' && ISO_DATE_REGEX.test(value) && !Number.isNaN(Date.parse(value))
  );
}

/**
 * Period validation (Reliability Computation Contract): ISO dates, period_end >= period_start, the
 * span is at most 366 days, and period_end is not in the future relative to business_date. A
 * violation rejects with 400 INVALID_REPORT_PERIOD.
 */
function assertValidReportPeriod(scope: ReliabilityReportScope): void {
  const { period_start, period_end, business_date } = scope;
  if (!isIsoDate(period_start) || !isIsoDate(period_end)) {
    throw new AppError(
      400,
      'INVALID_REPORT_PERIOD',
      'period_start and period_end must be ISO dates (YYYY-MM-DD)',
      { period_start, period_end },
    );
  }
  if (period_end < period_start) {
    throw new AppError(400, 'INVALID_REPORT_PERIOD', 'period_end must not be before period_start', {
      period_start,
      period_end,
    });
  }
  // ISO date strings compare lexicographically; day-count arithmetic is whole-day UTC.
  const spanDays =
    (Date.parse(`${period_end}T00:00:00Z`) - Date.parse(`${period_start}T00:00:00Z`)) / 86400000;
  if (spanDays + 1 > MAX_PERIOD_SPAN_DAYS) {
    throw new AppError(
      400,
      'INVALID_REPORT_PERIOD',
      `the report period span must be at most ${MAX_PERIOD_SPAN_DAYS} days`,
      { period_start, period_end, span_days: spanDays + 1 },
    );
  }
  if (!isIsoDate(business_date) || period_end > business_date) {
    throw new AppError(
      400,
      'INVALID_REPORT_PERIOD',
      'period_end must not be in the future relative to business_date',
      { period_start, period_end, business_date },
    );
  }
}

/**
 * The rate derivation over one SQL-aggregated scope row (Reliability Computation Contract):
 * mttr = downtime_minutes / breakdown_count and
 * mtbf = operating_minutes / breakdown_count with operating_minutes =
 * max(0, period_minutes * assets_in_scope - downtime_minutes). Both null when breakdown_count = 0
 * (an empty scope never reaches here - summarizeDowntime emits no row for a scope with zero
 * eligible work orders, and the null-everything row is deliberately not produced).
 */
function deriveRates(
  row: DowntimeSummaryRow,
  periodMinutes: number,
): { mttr_minutes: number | null; mtbf_minutes: number | null } {
  const breakdownCount = row.breakdown_count;
  const downtimeMinutes = Number(row.downtime_minutes);
  if (breakdownCount === 0) return { mttr_minutes: null, mtbf_minutes: null };
  const operatingMinutes = Math.max(0, periodMinutes * row.assets_in_scope - downtimeMinutes);
  // Round to 4 decimals so the stored NUMERIC(18,4) value matches the declared payload exactly and
  // the seam's fitsNumeric184 guard never rejects a realistic quotient (100 / 3 = 33.3333...).
  return {
    mttr_minutes: Math.round((downtimeMinutes / breakdownCount) * 10000) / 10000,
    mtbf_minutes: Math.round((operatingMinutes / breakdownCount) * 10000) / 10000,
  };
}

export async function runReliabilityReport(
  scope: ReliabilityReportScope,
): Promise<ReliabilityReportResult> {
  assertValidReportPeriod(scope);
  const { period_start, period_end, asset_id } = scope;

  // Period minutes is identical for every scope (Reliability Computation Contract).
  const spanDays =
    (Date.parse(`${period_end}T00:00:00Z`) - Date.parse(`${period_start}T00:00:00Z`)) / 86400000;
  const periodMinutes = (spanDays + 1) * 1440;

  // All aggregation runs in SQL in summarizeDowntime; the job only derives the per-row rates.
  const assetRows = await summarizeDowntime({
    period_start,
    period_end,
    asset_id,
    scope_type: 'asset',
  });
  const classRows = await summarizeDowntime({
    period_start,
    period_end,
    asset_id,
    scope_type: 'criticality_class',
  });

  const reportId = randomUUID();
  const metrics: Array<Record<string, unknown>> = [];

  for (const row of assetRows) {
    const rates = deriveRates(row, periodMinutes);
    metrics.push({
      metric_id: randomUUID(),
      scope_type: 'asset',
      scope_key: row.scope_key,
      breakdown_count: row.breakdown_count,
      downtime_minutes: Math.round(Number(row.downtime_minutes) * 10000) / 10000,
      mttr_minutes: rates.mttr_minutes,
      mtbf_minutes: rates.mtbf_minutes,
    });
  }
  for (const row of classRows) {
    const rates = deriveRates(row, periodMinutes);
    metrics.push({
      metric_id: randomUUID(),
      scope_type: 'criticality_class',
      // A narrowed run scopes the class row by the asset (<class>:<asset_id>) so it never collides
      // with the full-period class row via the anti-double-report key (review decision).
      scope_key: asset_id ? `${row.scope_key}:${asset_id}` : row.scope_key,
      breakdown_count: row.breakdown_count,
      downtime_minutes: Math.round(Number(row.downtime_minutes) * 10000) / 10000,
      mttr_minutes: rates.mttr_minutes,
      mtbf_minutes: rates.mtbf_minutes,
    });
  }

  // assets_evaluated is the delivery counter: distinct assets with at least one eligible
  // breakdown work order in the period, narrowed by the optional asset_id scope. It is counted
  // from the eligible work orders themselves, never from a post-hoc JS filter over the report.
  const eligibleWorkOrders = await listBreakdownWorkOrdersInPeriod(
    period_start,
    period_end,
    undefined,
    asset_id,
  );
  const assetsEvaluated = new Set(eligibleWorkOrders.map((w) => w.asset_id)).size;

  // An empty scope (no eligible breakdowns in the period - an asset or class with zero breakdowns
  // produces NO row) is an honest 200 with zero counters and NO event: the shape assert forbids an
  // empty metrics array, and a null-everything snapshot would be noise (Reliability Computation
  // Contract). Nothing is persisted, so nothing is anti-double-reported.
  if (metrics.length === 0) {
    return {
      // No snapshot is persisted, so there is no report_id to retrieve (a phantom id would point
      // at nothing and re-runs would mint a new one each time).
      report_id: null,
      period_start,
      period_end,
      assets_evaluated: assetsEvaluated,
      metrics_written: 0,
      metric_ids: [],
    };
  }

  // ONE event, ONE transaction, all metrics or none (AD-14). A re-run of the same period is a
  // no-op that surfaces DUPLICATE_RELIABILITY_REPORT from the applier - the job does not swallow
  // it, and no second snapshot is written.
  const occurredAt = new Date().toISOString();
  await persistEvent(
    {
      stream_type: 'maintenance',
      stream_id: reportId,
      event_type: 'maintenance.reliability_report_generated',
      payload: {
        report_id: reportId,
        period_start,
        period_end,
        metrics,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: scope.actor,
        occurred_at: occurredAt,
      },
      idempotency_key: randomUUID(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    scope.auditCtx,
  );

  return {
    report_id: reportId,
    period_start,
    period_end,
    assets_evaluated: assetsEvaluated,
    metrics_written: metrics.length,
    metric_ids: metrics.map((m) => m['metric_id'] as string),
  };
}
