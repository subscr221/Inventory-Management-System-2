import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { isValidCalendarDate } from '../../lib/business-days.js';

/**
 * Story 7.7 accessors for the asset coverage register: AMC, warranty, and insurance contracts
 * (FR-M-10, FR-M-11, AD-9).
 *
 * getActiveWarrantyForAsset is load-bearing on the AC 2 work-order check, so its predicate lives
 * entirely in SQL against a caller-supplied business_date: the server clock is never read inside a
 * statement here. DATE columns are rendered to text with to_char and NUMERIC with ::text, never
 * handed back as JS Date or number objects - a pg Date carries a wall-clock instant, and deriving
 * a calendar date from it with slice(0, 10) is the documented clock-window defect family in this
 * repo, while a JS float would silently round a contract value.
 */
export type CoverageType = 'amc' | 'warranty' | 'insurance';

export interface CoverageRow {
  coverage_id: string;
  asset_id: string;
  coverage_type: CoverageType;
  provider_name: string;
  reference_number_ext: string;
  start_date: string;
  expiry_date: string;
  contract_value: string | null;
  recorded_by: string;
  recorded_at: string;
  created_at: string;
  updated_at: string;
}

/** A coverage row plus the stage that is due for it and the day count the alert text needs. */
export interface CoverageStageDueRow extends CoverageRow {
  stage_days: number;
  /**
   * Whole days from business_date to expiry_date, computed in SQL DATE arithmetic. The scan puts
   * it in the notification text; deriving it in JS from a pg Date is the clock-window shortcut this
   * repo has a documented family of defects from.
   */
  days_remaining: number;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COVERAGE_TYPE_VALUES: readonly string[] = ['amc', 'warranty', 'insurance'];

/**
 * The alert stages FR-M-10 pins, mirrored from chk_asset_coverage_alert_stage. Declared here rather
 * than imported from the compliance seam so the read layer keeps no dependency on it; the drift
 * test pins the CHECK, and listCoverageStagesDue rejects anything outside this set so a caller can
 * never be handed due rows whose insert would raise an unmapped SQLSTATE 23514 mid-scan.
 */
const ALERT_STAGE_DAYS: readonly number[] = [90, 60, 30];

/** A filter is SUPPLIED when the caller passed a value, including '' - only null/undefined mean absent. */
function isSupplied(value: string | null | undefined): value is string {
  return value !== null && value !== undefined;
}

export const COVERAGE_COLUMNS = `coverage_id, asset_id, coverage_type, provider_name, reference_number_ext,
    to_char(start_date, 'YYYY-MM-DD') AS start_date,
    to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date,
    contract_value::text AS contract_value,
    recorded_by, recorded_at, created_at, updated_at`;

const COVERAGE_COLUMNS_PREFIXED = `c.coverage_id, c.asset_id, c.coverage_type, c.provider_name, c.reference_number_ext,
    to_char(c.start_date, 'YYYY-MM-DD') AS start_date,
    to_char(c.expiry_date, 'YYYY-MM-DD') AS expiry_date,
    c.contract_value::text AS contract_value,
    c.recorded_by, c.recorded_at, c.created_at, c.updated_at`;

export interface InsertCoverageRow {
  coverage_id: string;
  asset_id: string;
  coverage_type: CoverageType;
  provider_name: string;
  reference_number_ext: string;
  start_date: string;
  expiry_date: string;
  contract_value: string | null;
  recorded_by: string;
  recorded_at: string;
}

export async function insertCoverage(row: InsertCoverageRow, client: PoolClient): Promise<void> {
  // The read accessors validate calendar form before they cast; the write path must too, or a
  // ::date cast quietly accepts the Postgres special literals ('infinity', 'today', 'now'). An
  // 'infinity' expiry_date passes chk_asset_coverage_dates, matches every warranty check forever,
  // and then makes (expiry_date - $1::date) raise "cannot subtract infinite dates", which fails
  // every subsequent coverage scan for the whole tenant against a row that has no delete path.
  if (!isValidCalendarDate(row.start_date)) {
    throw new Error(`insertCoverage: start_date is not a calendar date: ${row.start_date}`);
  }
  if (!isValidCalendarDate(row.expiry_date)) {
    throw new Error(`insertCoverage: expiry_date is not a calendar date: ${row.expiry_date}`);
  }
  await client.query(
    `INSERT INTO asset_coverage (
      coverage_id, asset_id, coverage_type, provider_name, reference_number_ext,
      start_date, expiry_date, contract_value, recorded_by, recorded_at
    ) VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8::numeric,$9,$10)`,
    [
      row.coverage_id,
      row.asset_id,
      row.coverage_type,
      row.provider_name,
      row.reference_number_ext,
      row.start_date,
      row.expiry_date,
      row.contract_value,
      row.recorded_by,
      row.recorded_at,
    ],
  );
}

export async function getCoverageById(
  coverageId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<CoverageRow | null> {
  if (!UUID_REGEX.test(coverageId)) return null;
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await runner(client).query(
    `SELECT ${COVERAGE_COLUMNS} FROM asset_coverage WHERE coverage_id = $1${lockClause}`,
    [coverageId],
  );
  return (result.rows[0] as CoverageRow) ?? null;
}

/**
 * The uniqueness grain read: (asset_id, coverage_type, lower(reference_number_ext)).
 * uq_asset_coverage_reference is the backstop behind this pre-check, not a substitute for it - the
 * caller holds the asset row under FOR UPDATE while it runs, and the 23505 resolver returns the
 * same code and the same existing_coverage_id when a concurrent writer wins the race anyway.
 */
export async function getCoverageByReference(
  assetId: string,
  coverageType: string,
  referenceLower: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<CoverageRow | null> {
  if (!UUID_REGEX.test(assetId)) return null;
  if (!COVERAGE_TYPE_VALUES.includes(coverageType)) return null;
  if (typeof referenceLower !== 'string' || referenceLower.trim() === '') return null;
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await runner(client).query(
    `SELECT ${COVERAGE_COLUMNS} FROM asset_coverage
      WHERE asset_id = $1 AND coverage_type = $2 AND lower(reference_number_ext) = lower($3)${lockClause}`,
    [assetId, coverageType, referenceLower],
  );
  return (result.rows[0] as CoverageRow) ?? null;
}

/**
 * The AC 2 warranty check, resolved entirely in SQL (Binding Decision 4): a coverage row of type
 * 'warranty' whose start_date is on or before and whose expiry_date is on or after the payload
 * business_date. When several qualify, the one expiring LAST wins, tie-broken on the lowest
 * coverage_id so the derivation is deterministic and re-derivable at review time. A plain SELECT,
 * no lock: the flag is advisory ("may be covered"), and the caller already holds the asset row.
 */
export async function getActiveWarrantyForAsset(
  assetId: string,
  businessDate: string,
  client?: PoolClient,
): Promise<CoverageRow | null> {
  if (!UUID_REGEX.test(assetId)) return null;
  if (!isValidCalendarDate(businessDate)) return null;
  const result = await runner(client).query(
    `SELECT ${COVERAGE_COLUMNS} FROM asset_coverage
      WHERE asset_id = $1
        AND coverage_type = 'warranty'
        AND start_date <= $2::date
        AND expiry_date >= $2::date
      ORDER BY expiry_date DESC, coverage_id ASC
      LIMIT 1`,
    [assetId, businessDate],
  );
  return (result.rows[0] as CoverageRow) ?? null;
}

export interface ListCoveragesFilters {
  asset_id?: string | null | undefined;
  coverage_type?: string | null | undefined;
  /** 'active' | 'expired' | 'future', resolved against business_date - never the server clock. */
  status?: string | null | undefined;
  business_date?: string | null | undefined;
}

export interface ListPaging {
  limit?: number | undefined;
  offset?: number | undefined;
}

/**
 * Cross-asset coverage list. status is resolved against the CALLER's business_date, passed in as a
 * parameter: reading now() inside the statement would make the same request answer differently
 * either side of midnight UTC while the business day is still open in IST.
 */
export async function listCoverages(
  filters: ListCoveragesFilters = {},
  paging: ListPaging = {},
  client?: PoolClient,
): Promise<CoverageRow[]> {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;
  // Presence tests, not truthiness: '' is a SUPPLIED filter that matches nothing, so it must take
  // the same path as any other unparseable value and return []. A truthiness test sends '' down
  // the "filter absent" branch instead, and a caller whose asset id resolved to empty gets the
  // whole company's register back behind a 200.
  if (isSupplied(filters.asset_id)) {
    if (!UUID_REGEX.test(filters.asset_id)) return [];
    conditions.push(`asset_id = $${idx++}`);
    values.push(filters.asset_id);
  }
  if (isSupplied(filters.coverage_type)) {
    if (!COVERAGE_TYPE_VALUES.includes(filters.coverage_type)) return [];
    conditions.push(`coverage_type = $${idx++}`);
    values.push(filters.coverage_type);
  }
  if (isSupplied(filters.status)) {
    const businessDate = filters.business_date;
    if (!businessDate || !isValidCalendarDate(businessDate)) return [];
    if (filters.status === 'active') {
      conditions.push(`start_date <= $${idx}::date AND expiry_date >= $${idx}::date`);
    } else if (filters.status === 'expired') {
      conditions.push(`expiry_date < $${idx}::date`);
    } else if (filters.status === 'future') {
      conditions.push(`start_date > $${idx}::date`);
    } else {
      return [];
    }
    idx += 1;
    values.push(businessDate);
  }
  const limit = Number.isFinite(paging.limit ?? 100)
    ? Math.min(Math.max(Math.trunc(paging.limit ?? 100), 1), 500)
    : 100;
  const offset = Number.isFinite(paging.offset ?? 0)
    ? Math.max(Math.trunc(paging.offset ?? 0), 0)
    : 0;
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await runner(client).query(
    `SELECT ${COVERAGE_COLUMNS} FROM asset_coverage
      ${where}
      ORDER BY expiry_date ASC, coverage_id ASC
      LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as CoverageRow[];
}

export interface CoverageStageDueFilters {
  asset_id?: string | null | undefined;
}

/**
 * The Staged Alert Contract, evaluated entirely in SQL (the Story 7.5 twin with 30/14/7 replaced
 * by 90/60/30).
 *
 * A stage is DUE when (expiry_date - business_date) <= stage_days and expiry_date >= business_date,
 * and it is UNFIRED when no asset_coverage_alert row occupies its (coverage_id, stage_days) grain.
 * An equality test on the day count would silently drop a stage whenever the job is not run daily;
 * the <= comparison plus the unfired join is what makes a skipped scan catch up on the next run
 * instead of losing the warning.
 *
 * Scope is narrowed HERE, not in a JS filter afterwards, or the job's counters would overstate what
 * was evaluated (the Story 7.4 lesson).
 *
 * EVERY coverage in force is scanned, never a single winner per (asset_id, coverage_type). The
 * uniqueness grain is (asset_id, coverage_type, lower(reference_number_ext)), so several coverages
 * of one type simultaneously in force on one asset are legal and ordinary: a machinery-breakdown
 * policy and a fire policy are both coverage_type 'insurance', and two overlapping AMCs from
 * different vendors are equally legal. A review pass narrowed this to the latest-expiring row per
 * (asset_id, coverage_type) to stop a renewal re-raising the superseded contract's remaining
 * stages; that narrowing was REVERTED, because it silenced every earlier-expiring concurrent
 * policy - the contract nearest to lapsing was exactly the one that lost its warning. Binding
 * Decision 5 gives coverages no supersede column, and no data-only rule separates a renewal from a
 * second live contract (both carry a fresh reference number), so the renewal double-alert is
 * logged in deferred-work instead of being papered over here.
 */
export async function listCoverageStagesDue(
  businessDate: string,
  stages: readonly number[],
  filters: CoverageStageDueFilters = {},
  client?: PoolClient,
): Promise<CoverageStageDueRow[]> {
  if (!isValidCalendarDate(businessDate)) return [];
  // Deduplicated and pinned to the stages chk_asset_coverage_alert_stage accepts. A repeated stage
  // would unnest twice and make the scan's second insert collide 23505 with the grain its own first
  // insert just created; a non-member stage would return due rows whose insert raises 23514, a
  // class the 23505 duplicate resolver does not map, failing the whole scan transaction.
  const stageList = [...new Set(stages)].filter((s) => ALERT_STAGE_DAYS.includes(s));
  if (stageList.length === 0) return [];

  const conditions = [
    `a.alert_id IS NULL`,
    `(c.expiry_date - $1::date) <= s.stage_days`,
    `c.expiry_date >= $1::date`,
  ];
  const values: (string | number | number[])[] = [businessDate, stageList];
  let idx = 3;
  if (isSupplied(filters.asset_id)) {
    if (!UUID_REGEX.test(filters.asset_id)) return [];
    conditions.push(`c.asset_id = $${idx++}`);
    values.push(filters.asset_id);
  }

  const result = await runner(client).query(
    `SELECT ${COVERAGE_COLUMNS_PREFIXED}, s.stage_days::int AS stage_days,
            (c.expiry_date - $1::date)::int AS days_remaining
       FROM asset_coverage c
       CROSS JOIN unnest($2::int[]) AS s(stage_days)
       LEFT JOIN asset_coverage_alert a
         ON a.coverage_id = c.coverage_id AND a.stage_days = s.stage_days
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.expiry_date ASC, s.stage_days ASC, c.coverage_id ASC`,
    values,
  );
  return result.rows as CoverageStageDueRow[];
}
