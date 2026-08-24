import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import {
  getMetricByScope,
  insertReliabilityMetric,
} from '../read/projections/maintenance_reliability_metric.js';

/**
 * Story 7.3 compliance seam for the monthly reliability report (FR-M-06). Structurally mirrors
 * src/compliance/maintenance-fault.ts. The pure shape assert runs pre-transaction so a malformed
 * event never consumes an idempotency key; the applier runs inside persistEvent's transaction and
 * inserts one maintenance_reliability_metric row per payload entry, all-or-nothing.
 */

const MAINTENANCE_STREAM_TYPES = new Set(['maintenance']);
const MAINTENANCE_RELIABILITY_EVENT_TYPES = new Set(['maintenance.reliability_report_generated']);

const SCOPE_TYPES = new Set(['asset', 'criticality_class']);
const CRITICALITY_CLASSES = new Set(['critical', 'high', 'medium', 'low']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
// The report's metrics array is bounded at 5000 entries per the Reliability Computation Contract;
// a larger payload is a runaway aggregation, not a legitimate monthly snapshot.
const MAX_METRICS_PER_REPORT = 5000;
// The report period span is at most 366 days per the Reliability Computation Contract.
const MAX_PERIOD_SPAN_DAYS = 366;
// NUMERIC(18,4) holds up to 99999999999999.9999; strict < 1e14 is the representable bound.
const NUMERIC_184_MAX = 1e14;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' && ISO_DATE_REGEX.test(value) && !Number.isNaN(Date.parse(value))
  );
}

function fitsNumeric184(value: number): boolean {
  const scaled = value * 10000;
  return value < NUMERIC_184_MAX && Math.abs(scaled - Math.round(scaled)) <= 1e-9;
}

export function maintenanceReliabilityEventType(envelope: EventEnvelope): string | null {
  if (!MAINTENANCE_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!MAINTENANCE_RELIABILITY_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

export function assertMaintenanceReliabilityShape(envelope: EventEnvelope): void {
  const type = maintenanceReliabilityEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  if (!isUuid(p['report_id'])) reject('INVALID_PARAMS', 'report_id is required and must be a UUID');
  if (!isIsoDate(p['period_start']))
    reject('INVALID_PARAMS', 'period_start is required and must be an ISO date', {
      period_start: p['period_start'],
    });
  if (!isIsoDate(p['period_end']))
    reject('INVALID_PARAMS', 'period_end is required and must be an ISO date', {
      period_end: p['period_end'],
    });
  // period_end >= period_start is enforced in the table CHECK; asserting it here makes an
  // impossible period a stable 400 instead of an unmapped 23514 500.
  if ((p['period_end'] as string) < (p['period_start'] as string)) {
    reject('INVALID_PARAMS', 'period_end must not be before period_start', {
      period_start: p['period_start'],
      period_end: p['period_end'],
    });
  }
  // The span is at most 366 days (Reliability Computation Contract); the job validates it too, but
  // a direct-event envelope must not persist an arbitrarily long period.
  const spanDays =
    (Date.parse(`${p['period_end']}T00:00:00Z`) - Date.parse(`${p['period_start']}T00:00:00Z`)) /
    86400000;
  if (spanDays + 1 > MAX_PERIOD_SPAN_DAYS) {
    reject(
      'INVALID_PARAMS',
      `the report period span must be at most ${MAX_PERIOD_SPAN_DAYS} days`,
      { period_start: p['period_start'], period_end: p['period_end'], span_days: spanDays + 1 },
    );
  }
  const metrics = p['metrics'];
  if (!Array.isArray(metrics) || metrics.length === 0) {
    reject('INVALID_PARAMS', 'metrics is required and must be a non-empty array', {
      metrics: metrics,
    });
  }
  if (metrics.length > MAX_METRICS_PER_REPORT) {
    reject('INVALID_PARAMS', `metrics array length must be at most ${MAX_METRICS_PER_REPORT}`, {
      metrics_length: metrics.length,
    });
  }
  for (const rawEntry of metrics as unknown[]) {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
      reject('INVALID_PARAMS', 'every metric must be an object', { metric: rawEntry });
    }
    const entry = rawEntry as Record<string, unknown>;
    if (!isUuid(entry['metric_id']))
      reject('INVALID_PARAMS', 'every metric must carry a UUID metric_id');
    if (!isNonEmptyString(entry['scope_type']) || !SCOPE_TYPES.has(entry['scope_type'] as string)) {
      reject('INVALID_PARAMS', 'scope_type must be one of: asset, criticality_class', {
        scope_type: entry['scope_type'],
      });
    }
    // scope_key must match its scope_type (Reliability Computation Contract): a UUID for an asset
    // row, a known criticality class for a class row. An off-vocabulary key would corrupt the
    // anti-double-report key and the read model grouping.
    const scopeKey = entry['scope_key'];
    if (entry['scope_type'] === 'asset') {
      if (!isUuid(scopeKey))
        reject('INVALID_PARAMS', 'scope_key must be a UUID when scope_type is asset', {
          scope_key: scopeKey,
        });
    } else {
      // scope_key is a criticality class, optionally '<class>:<asset_id>' when the report was
      // narrowed to one asset (the review decision: scoping the class key by the asset keeps a
      // narrowed run from colliding with the full-period class row via the anti-double-report key).
      const key = scopeKey as string;
      const colon = typeof key === 'string' ? key.indexOf(':') : -1;
      const baseClass = colon === -1 ? key : key.slice(0, colon);
      const scopedId = colon === -1 ? null : key.slice(colon + 1);
      if (
        !isNonEmptyString(baseClass) ||
        !CRITICALITY_CLASSES.has(baseClass) ||
        (colon !== -1 && !isUuid(scopedId))
      ) {
        reject(
          'INVALID_PARAMS',
          'scope_key must be a criticality class, optionally <class>:<asset_id> when narrowed',
          { scope_key: scopeKey },
        );
      }
    }
    const breakdownCount = entry['breakdown_count'];
    if (
      !Number.isInteger(breakdownCount) ||
      (breakdownCount as number) < 0 ||
      (breakdownCount as number) > 2147483647
    ) {
      reject('INVALID_PARAMS', 'breakdown_count must be a non-negative integer', {
        breakdown_count: breakdownCount,
      });
    }
    const downtimeMinutes = entry['downtime_minutes'];
    if (
      typeof downtimeMinutes !== 'number' ||
      !Number.isFinite(downtimeMinutes) ||
      downtimeMinutes < 0 ||
      !fitsNumeric184(downtimeMinutes as number)
    ) {
      reject(
        'INVALID_PARAMS',
        'downtime_minutes must be a non-negative number fitting NUMERIC(18,4)',
        {
          downtime_minutes: downtimeMinutes,
        },
      );
    }
    const mttr = entry['mttr_minutes'];
    if (mttr !== null && mttr !== undefined) {
      if (
        typeof mttr !== 'number' ||
        !Number.isFinite(mttr) ||
        (mttr as number) < 0 ||
        !fitsNumeric184(mttr as number)
      ) {
        reject(
          'INVALID_PARAMS',
          'mttr_minutes must be a non-negative number fitting NUMERIC(18,4)',
          {
            mttr_minutes: mttr,
          },
        );
      }
    }
    const mtbf = entry['mtbf_minutes'];
    if (mtbf !== null && mtbf !== undefined) {
      if (
        typeof mtbf !== 'number' ||
        !Number.isFinite(mtbf) ||
        (mtbf as number) < 0 ||
        !fitsNumeric184(mtbf as number)
      ) {
        reject(
          'INVALID_PARAMS',
          'mtbf_minutes must be a non-negative number fitting NUMERIC(18,4)',
          {
            mtbf_minutes: mtbf,
          },
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Inside-transaction projection (DB access)
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

export async function applyMaintenanceReliabilityProjection(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  const type = maintenanceReliabilityEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'maintenance.reliability_report_generated':
      await applyReliabilityReportGenerated(envelope, client);
      break;
  }
}

async function applyReliabilityReportGenerated(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const reportId = p['report_id'] as string;
  const periodStart = p['period_start'] as string;
  const periodEnd = p['period_end'] as string;
  const metrics = p['metrics'] as Record<string, unknown>[];

  // The report is a PERSISTED DATED SNAPSHOT (Binding Scope Decisions). Each metric row's
  // (period_start, period_end, scope_type, scope_key) key is anti-double-reported: a re-run of the
  // same period returns the stable DUPLICATE_RELIABILITY_REPORT rather than writing a second
  // snapshot. This pre-check runs as a plain SELECT (the table is append-only - INSERT, SELECT
  // grants only, so FOR UPDATE would be permission-denied); uq_maintenance_reliability_metric_scope
  // is the concurrency backstop and the 23505 mapper resolves the winner with the same contract.
  // All-or-nothing: if any entry conflicts, the whole event rejects (one event, one transaction,
  // all metrics or none).
  for (const entry of metrics) {
    const scopeType = entry['scope_type'] as string;
    const scopeKey = entry['scope_key'] as string;
    const existing = await getMetricByScope(periodStart, periodEnd, scopeType, scopeKey, client);
    if (existing) {
      reject(
        'DUPLICATE_RELIABILITY_REPORT',
        'A reliability snapshot already exists for this period and scope',
        {
          report_id: reportId,
          period_start: periodStart,
          period_end: periodEnd,
          scope_type: scopeType,
          scope_key: scopeKey,
          existing_metric_id: existing.metric_id,
        },
        409,
      );
    }
  }

  for (const entry of metrics) {
    await insertReliabilityMetric(
      {
        metric_id: entry['metric_id'] as string,
        report_id: reportId,
        period_start: periodStart,
        period_end: periodEnd,
        scope_type: entry['scope_type'] as 'asset' | 'criticality_class',
        scope_key: entry['scope_key'] as string,
        breakdown_count: entry['breakdown_count'] as number,
        downtime_minutes: String(entry['downtime_minutes']),
        mttr_minutes:
          entry['mttr_minutes'] === null || entry['mttr_minutes'] === undefined
            ? null
            : String(entry['mttr_minutes']),
        mtbf_minutes:
          entry['mtbf_minutes'] === null || entry['mtbf_minutes'] === undefined
            ? null
            : String(entry['mtbf_minutes']),
        generated_by: envelope.metadata.actor.user_id,
      },
      client,
    );
  }
}

/**
 * Concurrency fallback for uq_maintenance_reliability_metric_scope: returns the SAME detail shape
 * as the seam's pre-check (DUPLICATE_RELIABILITY_REPORT with existing_metric_id).
 */
export async function resolveReliabilityReportConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const reportId = typeof payload['report_id'] === 'string' ? payload['report_id'] : null;
  const periodStart = typeof payload['period_start'] === 'string' ? payload['period_start'] : null;
  const periodEnd = typeof payload['period_end'] === 'string' ? payload['period_end'] : null;
  const metrics = Array.isArray(payload['metrics']) ? payload['metrics'] : [];
  const attempted: Record<string, unknown> = {
    report_id: reportId,
    period_start: periodStart,
    period_end: periodEnd,
  };
  // The 23505 can fire on ANY metric entry, not just the first (e.g. a narrowed-vs-full race where
  // only a later scope collides); scan every entry for the first existing scope so the race path
  // returns the same detail shape as the sequential pre-check (existing_metric_id included).
  for (const rawEntry of metrics as unknown[]) {
    if (typeof rawEntry !== 'object' || rawEntry === null) continue;
    const entry = rawEntry as Record<string, unknown>;
    const scopeType = typeof entry['scope_type'] === 'string' ? entry['scope_type'] : null;
    const scopeKey = typeof entry['scope_key'] === 'string' ? entry['scope_key'] : null;
    if (periodStart !== null && periodEnd !== null && scopeType !== null && scopeKey !== null) {
      const existing = await getMetricByScope(periodStart, periodEnd, scopeType, scopeKey);
      if (existing) {
        return {
          ...attempted,
          scope_type: scopeType,
          scope_key: scopeKey,
          existing_metric_id: existing.metric_id,
        };
      }
    }
  }
  return attempted;
}
