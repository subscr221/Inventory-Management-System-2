import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * A DOA registry entry: which role approves a given transaction type within a value band.
 * `value_min` is an EXCLUSIVE lower bound, `value_max` an INCLUSIVE upper bound; either/both null
 * means unbounded on that side (see read/projections/doa_registry.sql).
 */
export interface DoaRegistryEntry {
  entry_id: string;
  role: string;
  transaction_type: string;
  value_min: number | null;
  value_max: number | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface VacationDelegation {
  delegation_id: string;
  delegator_user_id: string;
  delegate_user_id: string;
  start_date: string;
  end_date: string;
  active: boolean;
  created_at: string;
}

export interface CreateDoaEntryInput {
  role: string;
  transaction_type: string;
  value_min: number | null;
  value_max: number | null;
}

export interface UpdateDoaEntryPatch {
  role?: string;
  transaction_type?: string;
  value_min?: number | null;
  value_max?: number | null;
  active?: boolean;
}

export interface CreateVacationDelegationInput {
  delegator_user_id: string;
  delegate_user_id: string;
  start_date: string;
  end_date: string;
}

/**
 * A query runner is either the shared pool or a caller-owned transaction client. When a `client`
 * is supplied, the write participates in the caller's transaction (so the registry row and the
 * domain event commit together - see persistEvent's `client` param and Story 1.4 Task 1.5); when
 * omitted, the shared pool auto-commits the single statement.
 */
type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

// node-postgres returns NUMERIC as a string to avoid precision loss; convert to a JS number (or
// null) at the projection boundary so callers get the numeric contract the API layer expects.
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function mapEntry(row: Record<string, unknown>): DoaRegistryEntry {
  const createdAt = row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']);
  const updatedAt = row['updated_at'] instanceof Date ? row['updated_at'].toISOString() : String(row['updated_at']);
  return {
    entry_id: row['entry_id'] as string,
    role: row['role'] as string,
    transaction_type: row['transaction_type'] as string,
    value_min: toNumberOrNull(row['value_min']),
    value_max: toNumberOrNull(row['value_max']),
    active: row['active'] as boolean,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function mapDelegation(row: Record<string, unknown>): VacationDelegation {
  // node-postgres parses a DATE column into a JS Date at LOCAL midnight of the stored calendar day.
  // Formatting via toISOString() would convert to UTC and shift the day in non-UTC timezones (e.g.
  // 2026-08-01 -> 2026-07-31 at UTC+); read the local Y-M-D components to preserve the calendar date.
  const toDateString = (v: unknown): string => {
    if (v instanceof Date) {
      const y = v.getFullYear();
      const m = String(v.getMonth() + 1).padStart(2, '0');
      const d = String(v.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    return String(v);
  };
  const createdAt = row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']);
  return {
    delegation_id: row['delegation_id'] as string,
    delegator_user_id: row['delegator_user_id'] as string,
    delegate_user_id: row['delegate_user_id'] as string,
    start_date: toDateString(row['start_date']),
    end_date: toDateString(row['end_date']),
    active: row['active'] as boolean,
    created_at: createdAt,
  };
}

/** Inserts a new DOA registry entry and returns it. Participates in `client`'s transaction if given. */
export async function createDoaEntry(input: CreateDoaEntryInput, client?: PoolClient): Promise<DoaRegistryEntry> {
  const result = await runner(client).query(
    `INSERT INTO doa_registry_entries (role, transaction_type, value_min, value_max)
     VALUES ($1, $2, $3, $4)
     RETURNING entry_id, role, transaction_type, value_min, value_max, active, created_at, updated_at`,
    [input.role, input.transaction_type, input.value_min, input.value_max],
  );
  return mapEntry(result.rows[0]!);
}

/**
 * Applies a partial update to a DOA entry and returns the updated row, or null if no entry matches.
 * Only the fields present in `patch` are changed; `updated_at` is always bumped. Participates in
 * `client`'s transaction if given.
 */
export async function updateDoaEntry(
  entryId: string,
  patch: UpdateDoaEntryPatch,
  client?: PoolClient,
): Promise<DoaRegistryEntry | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown): void => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.role !== undefined) push('role', patch.role);
  if (patch.transaction_type !== undefined) push('transaction_type', patch.transaction_type);
  if (patch.value_min !== undefined) push('value_min', patch.value_min);
  if (patch.value_max !== undefined) push('value_max', patch.value_max);
  if (patch.active !== undefined) push('active', patch.active);
  sets.push('updated_at = now()');

  params.push(entryId);
  const result = await runner(client).query(
    `UPDATE doa_registry_entries SET ${sets.join(', ')} WHERE entry_id = $${params.length}
     RETURNING entry_id, role, transaction_type, value_min, value_max, active, created_at, updated_at`,
    params,
  );
  return result.rows.length > 0 ? mapEntry(result.rows[0]!) : null;
}

/** Returns a single DOA entry by primary key, or null, locking it when called in a transaction. */
export async function getDoaEntry(entryId: string, client?: PoolClient): Promise<DoaRegistryEntry | null> {
  const result = await runner(client).query(
    `SELECT entry_id, role, transaction_type, value_min, value_max, active, created_at, updated_at
     FROM doa_registry_entries WHERE entry_id = $1${client ? ' FOR UPDATE' : ''}`,
    [entryId],
  );
  return result.rows.length > 0 ? mapEntry(result.rows[0]!) : null;
}

/**
 * Finds the active DOA entry governing `transactionType` at `value`. value_min is exclusive,
 * value_max inclusive; NULL means unbounded. If more than one entry could match (overlapping
 * bands), the earliest-created wins (deterministic tie-break) - documented as a Phase-1
 * simplification; Epic 4 may add richer selection later.
 */
export async function findMatchingDoaEntry(
  transactionType: string,
  value: number,
  client?: PoolClient,
): Promise<DoaRegistryEntry | null> {
  const result = await runner(client).query(
    `SELECT entry_id, role, transaction_type, value_min, value_max, active, created_at, updated_at
     FROM doa_registry_entries
     WHERE transaction_type = $1
       AND active = true
       AND (value_min IS NULL OR $2 > value_min)
       AND (value_max IS NULL OR $2 <= value_max)
     ORDER BY created_at ASC, entry_id ASC
     LIMIT 1`,
    [transactionType, value],
  );
  return result.rows.length > 0 ? mapEntry(result.rows[0]!) : null;
}

/** Returns true if any active DOA entry governs `transactionType` (existence check, not band match). */
export async function transactionTypeIsGoverned(transactionType: string, client?: PoolClient): Promise<boolean> {
  const result = await runner(client).query(
    `SELECT 1 FROM doa_registry_entries WHERE transaction_type = $1 AND active = true LIMIT 1`,
    [transactionType],
  );
  return result.rows.length > 0;
}

/**
 * Returns every active DOA entry for a transaction type, ordered by ascending value band
 * (lowest authority first, NULLs last). Used by the approver-escalation fallback: when the
 * band-matched role has no active holder, callers walk this list to the next authority that does
 * (Story 2.5 review).
 */
export async function listActiveDoaEntries(transactionType: string, client?: PoolClient): Promise<DoaRegistryEntry[]> {
  const result = await runner(client).query(
    `SELECT entry_id, role, transaction_type, value_min, value_max, active, created_at, updated_at
     FROM doa_registry_entries
     WHERE transaction_type = $1 AND active = true
     ORDER BY value_min ASC NULLS LAST, created_at ASC, entry_id ASC`,
    [transactionType],
  );
  return result.rows.map(mapEntry);
}

export async function findFirstActiveDoaEntry(transactionType: string, client?: PoolClient): Promise<DoaRegistryEntry | null> {
  const result = await runner(client).query(
    `SELECT entry_id, role, transaction_type, value_min, value_max, active, created_at, updated_at
     FROM doa_registry_entries
     WHERE transaction_type = $1 AND active = true
     ORDER BY created_at ASC, entry_id ASC
     LIMIT 1`,
    [transactionType],
  );
  return result.rows.length > 0 ? mapEntry(result.rows[0]!) : null;
}

/** Inserts a vacation delegation and returns it. Participates in `client`'s transaction if given. */
export async function createVacationDelegation(
  input: CreateVacationDelegationInput,
  client?: PoolClient,
): Promise<VacationDelegation> {
  const result = await runner(client).query(
    `INSERT INTO doa_vacation_delegations (delegator_user_id, delegate_user_id, start_date, end_date)
     VALUES ($1, $2, $3, $4)
     RETURNING delegation_id, delegator_user_id, delegate_user_id, start_date, end_date, active, created_at`,
    [input.delegator_user_id, input.delegate_user_id, input.start_date, input.end_date],
  );
  return mapDelegation(result.rows[0]!);
}

/**
 * Returns the active delegation for `delegatorUserId` covering `asOfDate` (YYYY-MM-DD), whose
 * delegate is still an active user, or null. The delegate active-status join is deliberate: a
 * deprovisioned delegate must not be resolvable as an approver - the resolver then falls back to
 * the original role holder. Earliest-created wins if several delegations overlap.
 */
export async function findActiveDelegation(
  delegatorUserId: string,
  asOfDate: string,
  client?: PoolClient,
): Promise<VacationDelegation | null> {
  const result = await runner(client).query(
    `SELECT d.delegation_id, d.delegator_user_id, d.delegate_user_id, d.start_date, d.end_date, d.active, d.created_at
     FROM doa_vacation_delegations d
     JOIN users u ON u.user_id = d.delegate_user_id
     WHERE d.delegator_user_id = $1
       AND d.active = true
       AND u.active = true
       AND d.start_date <= $2::date
       AND d.end_date >= $2::date
     ORDER BY d.created_at ASC, d.delegation_id ASC
     LIMIT 1`,
    [delegatorUserId, asOfDate],
  );
  return result.rows.length > 0 ? mapDelegation(result.rows[0]!) : null;
}

export interface RoleHolder {
  user_id: string;
  external_id: string;
}

/**
 * Returns the current active holder of `role`, or null if no active user holds it. If more than one
 * active user holds the same role, the earliest-assigned wins (deterministic tie-break) - a Phase-1
 * simplification with no location dimension; Epic 4 workflows may add location-scoped resolution.
 */
export async function findRoleHolder(role: string, client?: PoolClient): Promise<RoleHolder | null> {
  const result = await runner(client).query(
    `SELECT u.user_id, u.external_id
     FROM user_role_assignments a
     JOIN users u ON u.user_id = a.user_id
     WHERE a.role = $1 AND u.active = true
     ORDER BY a.created_at ASC, a.assignment_id ASC
     LIMIT 1`,
    [role],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0]!;
  return { user_id: row['user_id'] as string, external_id: row['external_id'] as string };
}

/** Returns the external_id for a user_id, or null. Used to enrich a resolved approver. */
export async function getExternalIdByUserId(userId: string, client?: PoolClient): Promise<string | null> {
  const result = await runner(client).query(`SELECT external_id FROM users WHERE user_id = $1`, [userId]);
  return result.rows.length > 0 ? (result.rows[0]!['external_id'] as string) : null;
}
