import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { AppError } from '../../middleware/error.js';

export interface BusinessStream {
  stream_code: string;
  display_name: string;
  active: boolean;
  created_at: string;
}

/**
 * A dated tagging-applicability rule (FR-AC-01: "applicability is dated configuration, not
 * code"). While the rule's date range is effective, inventory movement events whose event_type
 * equals `transaction_type` must carry the required tags. `effective_to` null = open-ended.
 */
export interface TransactionTaggingRule {
  rule_id: string;
  transaction_type: string;
  cost_centre_required: boolean;
  project_code_required: boolean;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTaggingRuleInput {
  transaction_type: string;
  cost_centre_required: boolean;
  project_code_required: boolean;
  effective_from: string;
  effective_to: string | null;
}

/**
 * A query runner is either the shared pool or a caller-owned transaction client. When a `client`
 * is supplied, the write participates in the caller's transaction (so the rule row and the
 * domain event commit together - see persistEvent's `client` param); when omitted, the shared
 * pool auto-commits the single statement.
 */
type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

// node-postgres parses a DATE column into a JS Date at LOCAL midnight of the stored calendar day.
// Formatting via toISOString() would convert to UTC and shift the day in non-UTC timezones (the
// bug Story 1.4 found on doa_vacation_delegations); read the local Y-M-D components instead.
function toDateString(v: unknown): string {
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v);
}

function toDateStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return toDateString(v);
}

function mapStream(row: Record<string, unknown>): BusinessStream {
  const createdAt = row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']);
  return {
    stream_code: row['stream_code'] as string,
    display_name: row['display_name'] as string,
    active: row['active'] as boolean,
    created_at: createdAt,
  };
}

function mapRule(row: Record<string, unknown>): TransactionTaggingRule {
  const createdAt = row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']);
  const updatedAt = row['updated_at'] instanceof Date ? row['updated_at'].toISOString() : String(row['updated_at']);
  return {
    rule_id: row['rule_id'] as string,
    transaction_type: row['transaction_type'] as string,
    cost_centre_required: row['cost_centre_required'] as boolean,
    project_code_required: row['project_code_required'] as boolean,
    effective_from: toDateString(row['effective_from']),
    effective_to: toDateStringOrNull(row['effective_to']),
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

/** Returns true if `streamCode` exists and is active in the business_streams vocabulary. */
export async function isValidBusinessStream(streamCode: string, client?: PoolClient): Promise<boolean> {
  const result = await runner(client).query(
    `SELECT 1 FROM business_streams WHERE stream_code = $1 AND active = true LIMIT 1`,
    [streamCode],
  );
  return result.rows.length > 0;
}

/** Lists all active business streams (for the GET /api/v1/business-streams endpoint). */
export async function listBusinessStreams(client?: PoolClient): Promise<BusinessStream[]> {
  const result = await runner(client).query(
    `SELECT stream_code, display_name, active, created_at
     FROM business_streams WHERE active = true ORDER BY stream_code ASC`,
  );
  return result.rows.map(mapStream);
}

/**
 * Resolves the tagging rule effective for `transactionType` on `asOfDate` (YYYY-MM-DD; defaults
 * to the current UTC date). Returns null when no rule is effective - meaning no cost_centre or
 * project_code is required for that type (the default until an admin configures otherwise).
 * Two rules effective on the same date is a configuration error, not an ambiguous pick: the
 * admin endpoint rejects overlaps at write time (409 TAGGING_RULE_CONFLICT), so this throws
 * TAGGING_CONFIG_CONFLICT (500) as defense-in-depth rather than silently choosing one.
 */
export async function findActiveTaggingRule(
  transactionType: string,
  asOfDate?: string,
  client?: PoolClient,
): Promise<TransactionTaggingRule | null> {
  const date = asOfDate ?? new Date().toISOString().slice(0, 10);
  const result = await runner(client).query(
    `SELECT rule_id, transaction_type, cost_centre_required, project_code_required,
            effective_from, effective_to, created_at, updated_at
     FROM transaction_tagging_rules
     WHERE transaction_type = $1
       AND effective_from <= $2::date
       AND (effective_to IS NULL OR effective_to >= $2::date)`,
    [transactionType, date],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length > 1) {
    throw new AppError(500, 'TAGGING_CONFIG_CONFLICT', `More than one tagging rule is effective for "${transactionType}" on ${date}`, {
      transaction_type: transactionType,
      as_of_date: date,
      conflicting_rule_ids: result.rows.map((r) => r['rule_id'] as string),
    });
  }
  return mapRule(result.rows[0]!);
}

/**
 * Returns any existing rule whose date range overlaps [effectiveFrom, effectiveTo] for the given
 * transaction type, or null. An open-ended range (effectiveTo null) overlaps everything from its
 * start onward. Used by the admin endpoint to reject conflicting rules at write time.
 */
export async function findConflictingRule(
  transactionType: string,
  effectiveFrom: string,
  effectiveTo: string | null,
  client?: PoolClient,
): Promise<TransactionTaggingRule | null> {
  // Two ranges [a_from, a_to] and [b_from, b_to] overlap when a_from <= b_to AND b_from <= a_to,
  // treating a NULL end as +infinity on that side.
  const result = await runner(client).query(
    `SELECT rule_id, transaction_type, cost_centre_required, project_code_required,
            effective_from, effective_to, created_at, updated_at
     FROM transaction_tagging_rules
     WHERE transaction_type = $1
       AND effective_from <= COALESCE($3::date, 'infinity'::date)
       AND ($2::date <= COALESCE(effective_to, 'infinity'::date))
     ORDER BY effective_from ASC, rule_id ASC
     LIMIT 1`,
    [transactionType, effectiveFrom, effectiveTo],
  );
  return result.rows.length > 0 ? mapRule(result.rows[0]!) : null;
}

/** Inserts a tagging rule and returns it. Participates in `client`'s transaction if given. */
export async function createTaggingRule(
  input: CreateTaggingRuleInput,
  client?: PoolClient,
): Promise<TransactionTaggingRule> {
  const result = await runner(client).query(
    `INSERT INTO transaction_tagging_rules
       (transaction_type, cost_centre_required, project_code_required, effective_from, effective_to)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING rule_id, transaction_type, cost_centre_required, project_code_required,
               effective_from, effective_to, created_at, updated_at`,
    [input.transaction_type, input.cost_centre_required, input.project_code_required, input.effective_from, input.effective_to],
  );
  return mapRule(result.rows[0]!);
}
