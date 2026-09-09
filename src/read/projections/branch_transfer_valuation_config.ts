import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { AppError } from '../../middleware/error.js';
import { dateColumnToString } from './site_gstin.js';

/**
 * Per-GSTIN-pair branch transfer valuation configuration (Story 11.5, Binding Decision 4). Dated
 * configuration resolved on the IST business date the caller passes in (never CURRENT_DATE). A pair
 * with no effective row is refused VALUATION_CONFIG_MISSING by the transfer seam; two rows effective
 * on one date is a 500 VALUATION_CONFIG_CONFLICT (configuration corruption, not an ambiguous pick).
 */

export const RULE_28_BASES = [
  'open_market_value',
  'like_kind_quality',
  'cost_plus',
  'invoice_value_full_itc',
] as const;
export type Rule28Basis = (typeof RULE_28_BASES)[number];

export function isRule28Basis(value: unknown): value is Rule28Basis {
  return typeof value === 'string' && (RULE_28_BASES as readonly string[]).includes(value);
}

export interface ValuationConfigRow {
  config_id: string;
  from_gstin_ext: string;
  to_gstin_ext: string;
  default_basis: Rule28Basis;
  recipient_full_itc_eligible: boolean;
  cost_plus_percent: string;
  effective_from: string;
  effective_to: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface InsertValuationConfigInput {
  from_gstin_ext: string;
  to_gstin_ext: string;
  default_basis: Rule28Basis;
  recipient_full_itc_eligible: boolean;
  cost_plus_percent: string;
  effective_from: string;
  effective_to?: string | null;
  created_by: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function ts(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

const COLUMNS = `config_id, from_gstin_ext, to_gstin_ext, default_basis, recipient_full_itc_eligible,
       cost_plus_percent, effective_from, effective_to, created_by, created_at, updated_at`;

function mapRow(row: Record<string, unknown>): ValuationConfigRow {
  return {
    config_id: row['config_id'] as string,
    from_gstin_ext: row['from_gstin_ext'] as string,
    to_gstin_ext: row['to_gstin_ext'] as string,
    default_basis: row['default_basis'] as Rule28Basis,
    recipient_full_itc_eligible: row['recipient_full_itc_eligible'] as boolean,
    cost_plus_percent: String(row['cost_plus_percent']),
    effective_from: dateColumnToString(row['effective_from']),
    effective_to:
      row['effective_to'] === null || row['effective_to'] === undefined
        ? null
        : dateColumnToString(row['effective_to']),
    created_by: row['created_by'] as string,
    created_at: ts(row['created_at']),
    updated_at: ts(row['updated_at']),
  };
}

/**
 * Inserts a pair configuration, refusing an overlapping window (409 VALUATION_CONFIG_OVERLAP).
 *
 * The overlap probe and the INSERT are serialized per GSTIN pair on pg_advisory_xact_lock keyed by
 * the pair (the transaction_tagging_rules idiom in src/api/v1/business-stream.ts). Without it two
 * concurrent inserts carrying DIFFERENT effective_from values both see a clean probe and both
 * commit, and findValuationConfig then refuses every transfer on that pair as a 500
 * VALUATION_CONFIG_CONFLICT with no DELETE grant to repair it. The lock is transaction-scoped, so
 * pass the caller's transactional `client` for it to bind; the DDL-level EXCLUDE constraint is the
 * backstop, this is what turns the race into a clean sequential 409.
 */
export async function insertValuationConfig(
  input: InsertValuationConfigInput,
  client?: PoolClient,
): Promise<ValuationConfigRow> {
  const q = runner(client);
  await q.query(`SELECT pg_advisory_xact_lock(hashtext($1 || '|' || $2))`, [
    `branch_transfer_valuation_config:${input.from_gstin_ext}`,
    input.to_gstin_ext,
  ]);
  const overlap = await q.query(
    `SELECT ${COLUMNS} FROM branch_transfer_valuation_config
      WHERE from_gstin_ext = $1 AND to_gstin_ext = $2
        AND effective_from <= COALESCE($4::date, 'infinity'::date)
        AND ($3::date <= COALESCE(effective_to, 'infinity'::date))
      ORDER BY effective_from ASC, config_id ASC
      LIMIT 1`,
    [input.from_gstin_ext, input.to_gstin_ext, input.effective_from, input.effective_to ?? null],
  );
  if (overlap.rows.length > 0) {
    const existing = mapRow(overlap.rows[0]!);
    throw new AppError(
      409,
      'VALUATION_CONFIG_OVERLAP',
      `A valuation configuration for ${input.from_gstin_ext} to ${input.to_gstin_ext} already covers part of this window`,
      {
        from_gstin_ext: input.from_gstin_ext,
        to_gstin_ext: input.to_gstin_ext,
        existing_config_id: existing.config_id,
        existing_effective_from: existing.effective_from,
        existing_effective_to: existing.effective_to,
      },
    );
  }
  const result = await q.query(
    `INSERT INTO branch_transfer_valuation_config
       (from_gstin_ext, to_gstin_ext, default_basis, recipient_full_itc_eligible, cost_plus_percent,
        effective_from, effective_to, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${COLUMNS}`,
    [
      input.from_gstin_ext,
      input.to_gstin_ext,
      input.default_basis,
      input.recipient_full_itc_eligible,
      input.cost_plus_percent,
      input.effective_from,
      input.effective_to ?? null,
      input.created_by,
    ],
  );
  return mapRow(result.rows[0]!);
}

/** The single configuration effective for the pair on `asOfDate`, or null. Two is a 500 conflict. */
export async function findValuationConfig(
  fromGstin: string,
  toGstin: string,
  asOfDate: string,
  client?: PoolClient,
): Promise<ValuationConfigRow | null> {
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM branch_transfer_valuation_config
      WHERE from_gstin_ext = $1 AND to_gstin_ext = $2
        AND effective_from <= $3::date
        AND (effective_to IS NULL OR effective_to >= $3::date)`,
    [fromGstin, toGstin, asOfDate],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length > 1) {
    throw new AppError(
      500,
      'VALUATION_CONFIG_CONFLICT',
      `More than one valuation configuration is effective for ${fromGstin} to ${toGstin} on ${asOfDate}`,
      {
        from_gstin_ext: fromGstin,
        to_gstin_ext: toGstin,
        as_of_date: asOfDate,
        conflicting_config_ids: result.rows.map((r) => r['config_id'] as string),
      },
    );
  }
  return mapRow(result.rows[0]!);
}

/** One configuration by id, or null. Used by the close route's idempotent-replay path. */
export async function findValuationConfigById(
  configId: string,
  client?: PoolClient,
): Promise<ValuationConfigRow | null> {
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM branch_transfer_valuation_config WHERE config_id = $1`,
    [configId],
  );
  return result.rows.length === 0 ? null : mapRow(result.rows[0]!);
}

/**
 * Closes an OPEN configuration window by stamping `effective_to` (Story 11.5 code review E2-P).
 * Without this a wrong cost_plus_percent or default basis is permanent:
 * excl_branch_transfer_valuation_config_window refuses any overlapping correction and app_user
 * holds no DELETE grant.
 *
 * Only an open-ended window may be closed, and only to a date on or after its own effective_from,
 * so the resulting range is a strict subset of the committed one - it can neither collide with the
 * EXCLUDE constraint nor invert. The `effective_to IS NULL` predicate on the UPDATE makes the close
 * atomic against a concurrent one. The site_gstin closeSiteGstin twin carries the same shape.
 */
export async function closeValuationConfig(
  configId: string,
  effectiveTo: string,
  client?: PoolClient,
): Promise<ValuationConfigRow> {
  const q = runner(client);
  const current = await q.query(
    `SELECT ${COLUMNS} FROM branch_transfer_valuation_config WHERE config_id = $1`,
    [configId],
  );
  if (current.rows.length === 0) {
    throw new AppError(
      404,
      'VALUATION_CONFIG_NOT_FOUND',
      `No branch transfer valuation configuration ${configId} exists`,
      { config_id: configId },
    );
  }
  const existing = mapRow(current.rows[0]!);
  if (existing.effective_to !== null) {
    throw new AppError(
      409,
      'VALUATION_CONFIG_ALREADY_CLOSED',
      `Valuation configuration ${configId} already ends on ${existing.effective_to}`,
      { config_id: configId, existing_effective_to: existing.effective_to },
    );
  }
  if (effectiveTo < existing.effective_from) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `effective_to ${effectiveTo} precedes the configuration's effective_from ${existing.effective_from}`,
      { config_id: configId, effective_to: effectiveTo, effective_from: existing.effective_from },
    );
  }
  const result = await q.query(
    `UPDATE branch_transfer_valuation_config SET effective_to = $2::date, updated_at = now()
      WHERE config_id = $1 AND effective_to IS NULL
      RETURNING ${COLUMNS}`,
    [configId, effectiveTo],
  );
  if (result.rows.length === 0) {
    throw new AppError(
      409,
      'VALUATION_CONFIG_ALREADY_CLOSED',
      `Valuation configuration ${configId} was closed concurrently`,
      { config_id: configId },
    );
  }
  return mapRow(result.rows[0]!);
}

/** Every configuration for a pair (both optional filters), oldest window first. */
export async function listValuationConfigs(
  filter: { from_gstin_ext?: string; to_gstin_ext?: string },
  client?: PoolClient,
): Promise<ValuationConfigRow[]> {
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM branch_transfer_valuation_config
      WHERE ($1::text IS NULL OR from_gstin_ext = $1)
        AND ($2::text IS NULL OR to_gstin_ext = $2)
      ORDER BY from_gstin_ext ASC, to_gstin_ext ASC, effective_from ASC, config_id ASC`,
    [filter.from_gstin_ext ?? null, filter.to_gstin_ext ?? null],
  );
  return result.rows.map(mapRow);
}
