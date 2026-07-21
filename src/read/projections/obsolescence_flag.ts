import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Obsolescence flag read model (Story 2.7). Derived from obsolescence.flagged / obsolescence.cleared
 * domain events by the applyInventoryPlanningProjection compliance seam inside persistEvent. Grain is
 * (sku, location_id) - one flag row per SKU-location. status 'aging' carries
 * disposition_status 'pending_disposition' and nrv_testing_triggered = true; NRV testing here is a
 * flag plus alert only - the DOA-gated write-down stays in inventory-valuation.ts. No stock leaves
 * the ledger; disposition is Epic 16.
 */

export interface ObsolescenceFlagRow {
  obsolescence_flag_id: string;
  sku: string;
  location_id: string;
  status: string;
  last_issue_at: string | null;
  days_since_issue: number | null;
  threshold_days: number | null;
  disposition_status: string | null;
  nrv_testing_triggered: boolean;
  flagged_at: string | null;
  cleared_at: string | null;
  source_event_id: string | null;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const COLUMNS = `obsolescence_flag_id, sku, location_id, status, last_issue_at, days_since_issue,
       threshold_days, disposition_status, nrv_testing_triggered, flagged_at, cleared_at,
       source_event_id, created_at`;

function ts(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapRow(row: Record<string, unknown>): ObsolescenceFlagRow {
  return {
    obsolescence_flag_id: row['obsolescence_flag_id'] as string,
    sku: row['sku'] as string,
    location_id: row['location_id'] as string,
    status: row['status'] as string,
    last_issue_at: ts(row['last_issue_at']),
    days_since_issue: row['days_since_issue'] === null || row['days_since_issue'] === undefined ? null : Number(row['days_since_issue']),
    threshold_days: row['threshold_days'] === null || row['threshold_days'] === undefined ? null : Number(row['threshold_days']),
    disposition_status: (row['disposition_status'] as string | null) ?? null,
    nrv_testing_triggered: row['nrv_testing_triggered'] === true,
    flagged_at: ts(row['flagged_at']),
    cleared_at: ts(row['cleared_at']),
    source_event_id: (row['source_event_id'] as string | null) ?? null,
    created_at: ts(row['created_at']) ?? '',
  };
}

/**
 * The flag row for a grain, if any. Locks FOR UPDATE when a client is supplied so a concurrent scan
 * for the same grain cannot double-flag or double-clear.
 */
export async function getObsolescenceFlag(
  sku: string,
  locationId: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<ObsolescenceFlagRow | null> {
  if (forUpdate && !client) {
    throw new Error('getObsolescenceFlag: forUpdate requires a transaction client');
  }
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM obsolescence_flag
     WHERE sku = $1 AND location_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [sku, locationId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export interface ObsolescenceFilters {
  location_id?: string | null;
  location_any?: string[] | null;
  sku?: string | null;
  status?: string | null;
  from_date?: string | null;
  to_date?: string | null;
}

export async function listObsolescenceReport(filters: ObsolescenceFilters, client?: PoolClient): Promise<ObsolescenceFlagRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (filters.location_id) {
    conditions.push(`location_id = $${i++}`);
    params.push(filters.location_id);
  }
  if (filters.location_any && filters.location_any.length > 0) {
    conditions.push(`location_id = ANY($${i++})`);
    params.push(filters.location_any);
  }
  if (filters.sku) {
    conditions.push(`sku = $${i++}`);
    params.push(filters.sku);
  }
  if (filters.status) {
    conditions.push(`status = $${i++}`);
    params.push(filters.status);
  }
  if (filters.from_date) {
    conditions.push(`flagged_at >= $${i++}::date`);
    params.push(filters.from_date);
  }
  if (filters.to_date) {
    conditions.push(`flagged_at < ($${i++}::date + INTERVAL '1 day')`);
    params.push(filters.to_date);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM obsolescence_flag ${where} ORDER BY flagged_at DESC NULLS LAST, sku, location_id`,
    params,
  );
  return result.rows.map(mapRow);
}

// ---------------------------------------------------------------------------
// Mutation helpers (transaction-scoped; called only from the compliance seam)
// ---------------------------------------------------------------------------

export interface FlagObsolescenceInput {
  obsolescence_flag_id: string;
  sku: string;
  location_id: string;
  last_issue_at: string | null;
  days_since_issue: number;
  threshold_days: number;
  disposition_status: string;
  flagged_at: string;
  source_event_id: string;
}

/**
 * Upserts an aging flag for a grain. On conflict (an existing row previously cleared/active) the same
 * grain flips to aging and its planning_flag_id is preserved. nrv_testing_triggered is set true; the
 * DOA-gated write-down stays in inventory-valuation.ts.
 */
export async function flagObsolescence(input: FlagObsolescenceInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO obsolescence_flag (
       obsolescence_flag_id, sku, location_id, status, last_issue_at, days_since_issue, threshold_days,
       disposition_status, nrv_testing_triggered, flagged_at, cleared_at, source_event_id
     ) VALUES ($1, $2, $3, 'aging', $4::timestamptz, $5, $6, $7, true, $8::timestamptz, NULL, $9)
     ON CONFLICT (sku, location_id) DO UPDATE SET
       status = 'aging',
       last_issue_at = EXCLUDED.last_issue_at,
       days_since_issue = EXCLUDED.days_since_issue,
       threshold_days = EXCLUDED.threshold_days,
       disposition_status = EXCLUDED.disposition_status,
       nrv_testing_triggered = true,
       flagged_at = EXCLUDED.flagged_at,
       cleared_at = NULL,
       source_event_id = EXCLUDED.source_event_id,
       updated_at = now()`,
    [
      input.obsolescence_flag_id,
      input.sku,
      input.location_id,
      input.last_issue_at,
      input.days_since_issue,
      input.threshold_days,
      input.disposition_status,
      input.flagged_at,
      input.source_event_id,
    ],
  );
}

export interface ClearObsolescenceInput {
  sku: string;
  location_id: string;
  cleared_at: string;
  source_event_id: string;
}

/** Clears an aging flag: status back to active, disposition_status null, nrv_testing_triggered false. */
export async function clearObsolescence(input: ClearObsolescenceInput, client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE obsolescence_flag
     SET status = 'active',
         disposition_status = NULL,
         nrv_testing_triggered = false,
         cleared_at = $3::timestamptz,
         source_event_id = $4,
         updated_at = now()
     WHERE sku = $1 AND location_id = $2`,
    [input.sku, input.location_id, input.cleared_at, input.source_event_id],
  );
}
