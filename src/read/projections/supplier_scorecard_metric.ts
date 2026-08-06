import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { toIstCalendarDate } from '../../lib/business-days.js';

/**
 * Supplier scorecard metric read model (Story 4.2, FR-P-03).
 *
 * Append-only observation history: one row per supplier_scorecard.metric_recorded event, written
 * exclusively by the compliance applier inside the persistEvent transaction. The scorecard view
 * is server-derived at request time from this projection plus the underlying GRN/PO/match
 * projections - no pre-computed rollup exists, so a stale rollup is impossible by construction.
 * NUMERIC crosses the wire as strings; DATE as calendar strings.
 *
 * Site scoping: the supplier registry does not carry a site_id yet, so the scorecard read is
 * procurement-module-wide for now (the Story 4.7 supplier-invoice fallback precedent). The
 * site-scoped variant is a future story; routes still gate on the procurement read scope.
 */

export interface SupplierScorecardMetricRow {
  metric_id: string;
  supplier_id: string;
  metric_kind: 'on_time_delivery' | 'quality_acceptance' | 'price_variance' | 'responsiveness';
  reference_event_id: string;
  reference_entity_id: string;
  value_num: string;
  context: Record<string, unknown>;
  business_date: string;
  source_event_id: string;
  supersedes_metric_id: string | null;
  recorded_at: string;
  recorded_by: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

/** The current IST calendar date - the anchor every trailing window is measured against. */
function istToday(): string {
  return toIstCalendarDate(new Date());
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SUPPLIER_SCORECARD_METRIC_COLUMNS = `metric_id, supplier_id, metric_kind,
       reference_event_id, reference_entity_id, value_num::text AS value_num, context,
       business_date::text AS business_date, source_event_id, supersedes_metric_id,
       recorded_at, recorded_by`;

export async function getScorecardMetricById(
  metricId: string,
  client?: PoolClient,
): Promise<SupplierScorecardMetricRow | null> {
  if (!UUID_REGEX.test(metricId)) return null;
  const result = await runner(client).query(
    `SELECT ${SUPPLIER_SCORECARD_METRIC_COLUMNS} FROM supplier_scorecard_metric WHERE metric_id = $1`,
    [metricId],
  );
  return (result.rows[0] as SupplierScorecardMetricRow) ?? null;
}

/** Replay-idempotency lookup: the (reference_event_id, metric_kind) pair is unique. */
export async function getScorecardMetricByReferenceEvent(
  referenceEventId: string,
  metricKind: SupplierScorecardMetricRow['metric_kind'],
  client?: PoolClient,
): Promise<SupplierScorecardMetricRow | null> {
  if (!UUID_REGEX.test(referenceEventId)) return null;
  const result = await runner(client).query(
    `SELECT ${SUPPLIER_SCORECARD_METRIC_COLUMNS} FROM supplier_scorecard_metric
     WHERE reference_event_id = $1 AND metric_kind = $2`,
    [referenceEventId, metricKind],
  );
  return (result.rows[0] as SupplierScorecardMetricRow) ?? null;
}

export interface InsertScorecardMetricInput {
  metric_id: string;
  supplier_id: string;
  metric_kind: SupplierScorecardMetricRow['metric_kind'];
  reference_event_id: string;
  reference_entity_id: string;
  value_num: string;
  context: Record<string, unknown>;
  business_date: string;
  source_event_id: string;
  supersedes_metric_id: string | null;
  recorded_by: string;
}

/**
 * Append-only write, called ONLY from the compliance applier inside persistEvent. ON CONFLICT DO
 * NOTHING covers both the metric_id primary key and the (reference_event_id, metric_kind) replay
 * guard - a duplicate is a rowCount-0 no-op, never a raw 23505 (the 4.5 precedent). value_num
 * passes through as a string and is cast to NUMERIC in SQL - no JS float ever touches it.
 */
export async function insertScorecardMetric(
  input: InsertScorecardMetricInput,
  client: PoolClient,
): Promise<number> {
  const result = await client.query(
    `INSERT INTO supplier_scorecard_metric (
       metric_id, supplier_id, metric_kind, reference_event_id, reference_entity_id,
       value_num, context, business_date, source_event_id, supersedes_metric_id, recorded_by
     ) VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::jsonb, $8::date, $9, $10, $11)
     ON CONFLICT DO NOTHING`,
    [
      input.metric_id,
      input.supplier_id,
      input.metric_kind,
      input.reference_event_id,
      input.reference_entity_id,
      input.value_num,
      JSON.stringify(input.context),
      input.business_date,
      input.source_event_id,
      input.supersedes_metric_id,
      input.recorded_by,
    ],
  );
  return result.rowCount ?? 0;
}

export interface ListScorecardMetricsParams {
  supplierId: string;
  metricKind?: SupplierScorecardMetricRow['metric_kind'] | undefined;
  sinceDate?: string | undefined;
  untilDate?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listScorecardMetrics(
  params: ListScorecardMetricsParams,
  client?: PoolClient,
): Promise<SupplierScorecardMetricRow[]> {
  if (!UUID_REGEX.test(params.supplierId)) return [];
  const conditions: string[] = ['supplier_id = $1'];
  const values: unknown[] = [params.supplierId];
  let idx = 2;

  if (params.metricKind) {
    conditions.push(`metric_kind = $${idx++}`);
    values.push(params.metricKind);
  }
  if (params.sinceDate) {
    conditions.push(`business_date >= $${idx++}::date`);
    values.push(params.sinceDate);
  }
  if (params.untilDate) {
    conditions.push(`business_date <= $${idx++}::date`);
    values.push(params.untilDate);
  }

  const limit =
    Number.isInteger(params.limit) && params.limit! > 0 ? Math.min(params.limit!, 200) : 50;
  const offset = Number.isInteger(params.offset) && params.offset! >= 0 ? params.offset! : 0;
  const result = await runner(client).query(
    `SELECT ${SUPPLIER_SCORECARD_METRIC_COLUMNS} FROM supplier_scorecard_metric m
     WHERE ${conditions.join(' AND ')}
       AND NOT EXISTS (
         SELECT 1 FROM supplier_scorecard_metric s
         WHERE s.supersedes_metric_id = m.metric_id
       )
     ORDER BY business_date DESC, recorded_at DESC, metric_id ASC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as SupplierScorecardMetricRow[];
}

export interface ScorecardTrendSummary {
  count: number;
  mean: string | null;
  /** recorded_at of the most recent observation. */
  latest: string | null;
  /** value_num of the most recent observation (by business_date, then recorded_at). */
  latest_value: string | null;
  trailing_30d_mean: string | null;
  trailing_90d_mean: string | null;
  trailing_365d_mean: string | null;
}

export interface ScorecardSummary {
  on_time_delivery: ScorecardTrendSummary;
  /** First-class no-data shape (AC2): never a fabricated zero. */
  quality_acceptance: ScorecardTrendSummary | { state: 'no_data' };
  price_variance: ScorecardTrendSummary;
  responsiveness: ScorecardTrendSummary;
}

const METRIC_KINDS: SupplierScorecardMetricRow['metric_kind'][] = [
  'on_time_delivery',
  'quality_acceptance',
  'price_variance',
  'responsiveness',
];

/**
 * One SQL pass computes every per-kind aggregate in PostgreSQL NUMERIC; ROUND(..., 6)::text keeps
 * the values string-stable across the wire. The trailing windows anchor on the CURRENT IST
 * calendar date (istToday(), passed as a parameter) because business_date is an IST calendar
 * date - a UTC/server-date anchor would drift a day at the IST midnight boundary. Rows superseded
 * by a correction (their metric_id appears as another row's supersedes_metric_id) are excluded:
 * the summary reflects authoritative, post-correction values only. quality_acceptance maps a zero
 * count to { state: 'no_data' } in TypeScript.
 */
export async function getScorecardSummary(
  supplierId: string,
  client?: PoolClient,
): Promise<ScorecardSummary | null> {
  if (!UUID_REGEX.test(supplierId)) return null;
  const result = await runner(client).query(
    `WITH active AS (
       SELECT m.*
       FROM supplier_scorecard_metric m
       WHERE m.supplier_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM supplier_scorecard_metric s
           WHERE s.supersedes_metric_id = m.metric_id
         )
     )
     SELECT
       metric_kind,
       COUNT(*)::int                                   AS count,
       ROUND(AVG(value_num), 6)::text                  AS mean,
       MAX(recorded_at)::text                          AS latest,
       (ARRAY_AGG(value_num::text ORDER BY business_date DESC, recorded_at DESC))[1]
                                                       AS latest_value,
       ROUND(AVG(value_num) FILTER (WHERE business_date >= ($2::date - 30)), 6)::text
                                                       AS trailing_30d_mean,
       ROUND(AVG(value_num) FILTER (WHERE business_date >= ($2::date - 90)), 6)::text
                                                       AS trailing_90d_mean,
       ROUND(AVG(value_num) FILTER (WHERE business_date >= ($2::date - 365)), 6)::text
                                                       AS trailing_365d_mean
     FROM active
     GROUP BY metric_kind`,
    [supplierId, istToday()],
  );

  const byKind = new Map<string, ScorecardTrendSummary>();
  for (const raw of result.rows as Record<string, unknown>[]) {
    byKind.set(raw['metric_kind'] as string, {
      count: raw['count'] as number,
      mean: (raw['mean'] as string) ?? null,
      latest: (raw['latest'] as string) ?? null,
      latest_value: (raw['latest_value'] as string) ?? null,
      trailing_30d_mean: (raw['trailing_30d_mean'] as string) ?? null,
      trailing_90d_mean: (raw['trailing_90d_mean'] as string) ?? null,
      trailing_365d_mean: (raw['trailing_365d_mean'] as string) ?? null,
    });
  }

  const emptyTrend = (): ScorecardTrendSummary => ({
    count: 0,
    mean: null,
    latest: null,
    latest_value: null,
    trailing_30d_mean: null,
    trailing_90d_mean: null,
    trailing_365d_mean: null,
  });

  const summary = {} as Record<string, ScorecardTrendSummary | { state: 'no_data' }>;
  for (const kind of METRIC_KINDS) {
    const trend = byKind.get(kind);
    if (kind === 'quality_acceptance') {
      // AC2: a supplier whose lots have never been dispositioned shows no data, never 0.
      summary[kind] = trend && trend.count > 0 ? trend : { state: 'no_data' };
    } else {
      summary[kind] = trend ?? emptyTrend();
    }
  }
  return summary as unknown as ScorecardSummary;
}

/**
 * The PO's promised_delivery_date as a calendar-date STRING. getPurchaseOrderById reads with
 * SELECT *, which surfaces DATE as a JS Date whose serialization is timezone-dependent - the
 * ::text cast keeps the project's DATE-as-calendar-string contract.
 */
export async function getPoPromisedDateText(
  poId: string,
  client?: PoolClient,
): Promise<string | null> {
  if (!UUID_REGEX.test(poId)) return null;
  const result = await runner(client).query(
    `SELECT promised_delivery_date::text AS promised FROM purchase_order WHERE po_id = $1`,
    [poId],
  );
  return ((result.rows[0] as Record<string, unknown>)?.['promised'] as string | null) ?? null;
}

/**
 * AC4/AC7: the event_id of the purchase_order.confirmed event that produced a confirmed PO's
 * responsiveness value. purchase_order.source_event_id is stamped once at draft and never
 * advanced, so the responsiveness metric's reference_event_id is resolved from the event stream
 * (latest confirmation per event_version; the direct-event read precedent lives in
 * src/compliance/three-way-match.ts's note duplicate probe).
 */
export async function getPoConfirmedEventId(
  poId: string,
  client?: PoolClient,
): Promise<string | null> {
  if (!UUID_REGEX.test(poId)) return null;
  const result = await runner(client).query(
    `SELECT event_id FROM domain_events
     WHERE stream_id = $1 AND event_type = 'purchase_order.confirmed'
     ORDER BY event_version DESC
     LIMIT 1`,
    [poId],
  );
  return ((result.rows[0] as Record<string, unknown>)?.['event_id'] as string | null) ?? null;
}

/**
 * AC1: signed(received_date - promised_delivery_date) in days, computed as PostgreSQL DATE
 * subtraction and cast to NUMERIC(14,6) so it crosses the wire as '3.000000' / '-2.000000' -
 * never a JS date diff.
 */
export async function computeSignedDayDelta(
  receivedDate: string,
  promisedDate: string,
  client?: PoolClient,
): Promise<string> {
  const result = await runner(client).query(
    `SELECT (($1::date - $2::date))::numeric(14,6)::text AS delta`,
    [receivedDate, promisedDate],
  );
  return (result.rows[0] as Record<string, unknown>)['delta'] as string;
}

export interface MatchPriceVariance {
  /** Mean per-line signed price variance, NUMERIC-as-string ('0.000000' when no line matched). */
  mean_pct: string;
  /** Count of lines that actually contributed to the mean (invoice_qty > 0). */
  contributing_lines: number;
}

/**
 * AC3: the mean per-line signed price variance of a match, computed entirely in PostgreSQL
 * NUMERIC from the match's stored variance_detail. variance_detail carries price_variance_pct as
 * an absolute value; the sign is re-derived from invoice vs PO unit price. Only matched lines
 * (invoice_qty > 0) contribute; a match whose every line passed at exactly the PO price yields
 * '0.000000'. The jsonb_typeof guard degrades a corrupted (non-array) lines value to an empty
 * set instead of raising jsonb_array_elements's cannot-extract-elements error as a raw 500.
 */
export async function computeMatchPriceVariance(
  matchId: string,
  client?: PoolClient,
): Promise<MatchPriceVariance | null> {
  if (!UUID_REGEX.test(matchId)) return null;
  const result = await runner(client).query(
    `SELECT ROUND(
        COALESCE(AVG(
          CASE
            WHEN (l->>'invoice_unit_price')::numeric >= (l->>'po_unit_price')::numeric
              THEN (l->>'price_variance_pct')::numeric
            ELSE -((l->>'price_variance_pct')::numeric)
          END
        ), 0), 6)::text AS mean_pct,
       COUNT(*)::int AS contributing_lines
      FROM three_way_match t
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(t.variance_detail->'lines') = 'array'
            THEN t.variance_detail->'lines'
          ELSE '[]'::jsonb
        END
      ) AS l
      WHERE t.match_id = $1 AND (l->>'invoice_qty')::numeric > 0`,
    [matchId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    mean_pct: row['mean_pct'] as string,
    contributing_lines: row['contributing_lines'] as number,
  };
}

export interface ScorecardTransactionRow {
  metric_kind: SupplierScorecardMetricRow['metric_kind'];
  reference_entity_id: string;
  occurred_at: string | null;
  summary: string;
  business_date: string;
}

export interface ListScorecardTransactionsParams {
  metricKind?: SupplierScorecardMetricRow['metric_kind'] | undefined;
  sinceDate?: string | undefined;
  untilDate?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/**
 * Drill-through (AC5): the underlying receipt, match, and confirmation rows each metric was
 * derived from, joined back to the grn / three_way_match / purchase_order projections the
 * scorecard consumed. The supplier constraint rides the supplier_id the metric row carries.
 */
export async function listScorecardTransactions(
  supplierId: string,
  params: ListScorecardTransactionsParams,
  client?: PoolClient,
): Promise<ScorecardTransactionRow[]> {
  if (!UUID_REGEX.test(supplierId)) return [];
  const conditions: string[] = ['m.supplier_id = $1'];
  const values: unknown[] = [supplierId];
  let idx = 2;

  if (params.metricKind) {
    conditions.push(`m.metric_kind = $${idx++}`);
    values.push(params.metricKind);
  }
  if (params.sinceDate) {
    conditions.push(`m.business_date >= $${idx++}::date`);
    values.push(params.sinceDate);
  }
  if (params.untilDate) {
    conditions.push(`m.business_date <= $${idx++}::date`);
    values.push(params.untilDate);
  }

  const limit =
    Number.isInteger(params.limit) && params.limit! > 0 ? Math.min(params.limit!, 200) : 50;
  const offset = Number.isInteger(params.offset) && params.offset! >= 0 ? params.offset! : 0;
  const result = await runner(client).query(
    `SELECT
       m.metric_kind,
       m.reference_entity_id,
       COALESCE(g.received_at, t.recorded_at, po.confirmed_at, m.recorded_at)::text AS occurred_at,
       CASE m.metric_kind
         WHEN 'on_time_delivery' THEN
           'GRN received ' || COALESCE(m.context->>'received_date', '?')
             || ' vs promised ' || COALESCE(m.context->>'promised_delivery_date', '?')
             || ' (' || m.value_num::text || ' days)'
         WHEN 'price_variance' THEN
           'Three-way match mean price variance ' || m.value_num::text || '%'
         WHEN 'responsiveness' THEN
           'PO confirmed in ' || m.value_num::text || ' business days'
         ELSE 'QC disposition ' || COALESCE(m.context->>'disposition', '?')
       END AS summary,
       m.business_date::text AS business_date
     FROM supplier_scorecard_metric m
     LEFT JOIN grn g
       ON m.metric_kind = 'on_time_delivery' AND g.grn_id = m.reference_entity_id
     LEFT JOIN three_way_match t
       ON m.metric_kind = 'price_variance' AND t.match_id = m.reference_entity_id
     LEFT JOIN purchase_order po
       ON m.metric_kind = 'responsiveness' AND po.po_id = m.reference_entity_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY m.business_date DESC, m.recorded_at DESC, m.metric_id ASC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as ScorecardTransactionRow[];
}
