import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Accessor for the `gate_dwell_metric` view (Story 3.8, AC3 / SM-13).
 *
 * The spec named this file in both its Source Tree and Files to Touch sections and it was never
 * created: the view was queried inline from src/warehouse/task-metrics.ts, so the one-accessor-per-
 * projection layout every other read model follows was broken for this one. It exists now so the
 * view's shape is declared in exactly one place.
 *
 * Division of labour with task-metrics.ts: row-level reads of the view live HERE; the per-shift
 * aggregate (median via percentile_cont, the SM-C2 counter rollups) stays there, because that is a
 * metric computation over the view rather than a projection read, and keeping the ordered-set
 * aggregate next to the code that reasons about PostgreSQL 18's window-function restriction is
 * where a reader will look for it.
 *
 * `gate_dwell_metric` is a VIEW, not a table: every column derives from gate_event,
 * weighbridge_event and grn, so it holds no independent state and needs no apply*Projection hook.
 */
export interface GateDwellMetricRow {
  gate_event_id: string;
  correlation_id: string;
  site_id: string;
  site_code_ext: string;
  business_date: string;
  vehicle_reg_ext: string;
  po_ref_ext: string | null;
  gate_entered_at: string;
  /** Null while the vehicle is still in the yard. */
  resolved_at: string | null;
  resolution_source: 'weighbridge' | 'grn' | null;
  /**
   * Minutes, exact NUMERIC text. Null ONLY for a clock-skewed row whose resolution instant precedes
   * its gate entry; an unresolved vehicle carries an open dwell measured against now() instead.
   */
  dwell_minutes: string | null;
  /** Vehicle still in the yard: dwell_minutes is open and counts toward the shift median. */
  dwell_open: boolean;
  /** Resolution instant precedes gate entry; excluded from the median rather than dragging it down. */
  clock_skew_detected: boolean;
  /** An accepted weighment exists, independent of whether it carries a capture instant. */
  weighment_present: boolean;
  /** The dwell was resolved from the GRN rather than a weighment. */
  grn_fallback_used: boolean;
  /** Always true under the current gate_event DDL; retained as an invariant tripwire. */
  challan_photo_present: boolean;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function ts(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export const GATE_DWELL_METRIC_COLUMNS = `gate_event_id, correlation_id, site_id, site_code_ext,
       to_char(business_date, 'YYYY-MM-DD') AS business_date, vehicle_reg_ext, po_ref_ext,
       gate_entered_at, resolved_at, resolution_source,
       ROUND((EXTRACT(EPOCH FROM dwell_interval) / 60.0)::numeric, 6)::text AS dwell_minutes,
       dwell_open, clock_skew_detected, weighment_present, grn_fallback_used, challan_photo_present`;

function mapRow(row: Record<string, unknown>): GateDwellMetricRow {
  return {
    gate_event_id: row['gate_event_id'] as string,
    correlation_id: row['correlation_id'] as string,
    site_id: row['site_id'] as string,
    site_code_ext: row['site_code_ext'] as string,
    business_date: String(row['business_date']),
    vehicle_reg_ext: row['vehicle_reg_ext'] as string,
    po_ref_ext: (row['po_ref_ext'] as string | null) ?? null,
    gate_entered_at: ts(row['gate_entered_at']),
    resolved_at:
      row['resolved_at'] === null || row['resolved_at'] === undefined
        ? null
        : ts(row['resolved_at']),
    resolution_source: (row['resolution_source'] as 'weighbridge' | 'grn' | null) ?? null,
    dwell_minutes:
      row['dwell_minutes'] === null || row['dwell_minutes'] === undefined
        ? null
        : String(row['dwell_minutes']),
    dwell_open: row['dwell_open'] === true,
    clock_skew_detected: row['clock_skew_detected'] === true,
    weighment_present: row['weighment_present'] === true,
    grn_fallback_used: row['grn_fallback_used'] === true,
    challan_photo_present: row['challan_photo_present'] === true,
  };
}

/**
 * Row-level read of the view. Site scoping is the caller's responsibility in the same way as every
 * other list accessor here: pass `siteId` for a single site or `siteAny` for the caller's permitted
 * set. Passing neither reads across all sites, which only a wildcard-scoped caller may do.
 */
export async function listGateDwellMetrics(
  filters: {
    siteId?: string | null;
    siteAny?: string[] | null;
    businessDate?: string | null;
    correlationId?: string | null;
    openOnly?: boolean;
  } = {},
  client?: PoolClient,
): Promise<GateDwellMetricRow[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    clauses.push(sql.replace('?', `$${values.length}`));
  };
  if (filters.siteId) add('site_id = ?', filters.siteId);
  else if (filters.siteAny && filters.siteAny.length > 0)
    add('site_id = ANY(?::uuid[])', filters.siteAny);
  if (filters.businessDate) add('business_date = ?::date', filters.businessDate);
  if (filters.correlationId) add('correlation_id = ?', filters.correlationId);
  if (filters.openOnly) clauses.push('dwell_open');
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const result = await runner(client).query(
    `SELECT ${GATE_DWELL_METRIC_COLUMNS} FROM gate_dwell_metric ${where}
      ORDER BY business_date DESC, gate_entered_at ASC`,
    values,
  );
  return result.rows.map(mapRow);
}
