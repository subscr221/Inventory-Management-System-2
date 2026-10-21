import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Standing approval and self-approval limit read model (Story 4.8, D1). One table, two kinds; the
 * lifecycle (pending-finance, active, rejected, revoked, expired) is driven only by the
 * standing_grant.* events through src/compliance/standing-grant.ts. Only an `active` grant takes
 * effect (D2): every lookup that grants a right filters on it, so a pending or revoked grant is
 * inert by construction.
 */

export const GRANT_KINDS = ['standing_approval', 'self_approval_limit'] as const;
export type GrantKind = (typeof GRANT_KINDS)[number];
export const GRANT_STATUSES = [
  'pending-finance',
  'active',
  'rejected',
  'revoked',
  'expired',
] as const;
export type GrantStatus = (typeof GRANT_STATUSES)[number];
/** Statuses an assigner may still revoke (D2: revoke of anything else is 409 GRANT_NOT_LIVE). */
export const REVOCABLE_STATUSES: readonly GrantStatus[] = ['pending-finance', 'active'];

export interface StandingGrantRow {
  grant_id: string;
  grant_ref: string;
  grant_kind: GrantKind;
  grantee_user_id: string;
  assigner_user_id: string;
  site_id: string;
  scope_sku: string | null;
  scope_item_group_id: string | null;
  monthly_qty_cap: string | null;
  limit_amount: string | null;
  end_date: string | null;
  status: GrantStatus;
  finance_approver_user_id: string | null;
  finance_decided_at: string | null;
  finance_rejection_reason: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: 'assigner' | 'account_disabled' | null;
  expired_at: string | null;
  correlation_id: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface InsertGrantInput {
  grant_id: string;
  grant_ref: string;
  grant_kind: GrantKind;
  grantee_user_id: string;
  assigner_user_id: string;
  site_id: string;
  scope_sku: string | null;
  scope_item_group_id: string | null;
  monthly_qty_cap: string | null;
  limit_amount: string | null;
  end_date: string | null;
  correlation_id: string | null;
  source_event_id: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/** end_date is a DATE: pg returns a Date at local midnight, so read it back as the IST-agnostic text. */
const GRANT_COLUMNS = `grant_id, grant_ref, grant_kind, grantee_user_id, assigner_user_id, site_id,
  scope_sku, scope_item_group_id, monthly_qty_cap::text AS monthly_qty_cap,
  limit_amount::text AS limit_amount, to_char(end_date, 'YYYY-MM-DD') AS end_date, status,
  finance_approver_user_id, finance_decided_at, finance_rejection_reason, revoked_at, revoked_by,
  revoke_reason, expired_at, correlation_id, source_event_id, created_at, updated_at`;

function mapGrant(row: Record<string, unknown>): StandingGrantRow {
  return {
    ...(row as unknown as StandingGrantRow),
    finance_decided_at: iso(row['finance_decided_at']),
    revoked_at: iso(row['revoked_at']),
    expired_at: iso(row['expired_at']),
    created_at: iso(row['created_at']) as string,
    updated_at: iso(row['updated_at']) as string,
  };
}

/** Server-side SA-YYYY-NNN allocation from the sequence (the indent_number_seq idiom). */
export async function allocateGrantRef(year: number, client: PoolClient): Promise<string> {
  const result = await client.query(`SELECT nextval('standing_grant_ref_seq') AS n`);
  const n = String(result.rows[0]['n']);
  return `SA-${year}-${n.padStart(3, '0')}`;
}

export async function insertGrant(row: InsertGrantInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO standing_grant (
       grant_id, grant_ref, grant_kind, grantee_user_id, assigner_user_id, site_id,
       scope_sku, scope_item_group_id, monthly_qty_cap, limit_amount, end_date,
       correlation_id, source_event_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10::numeric,$11::date,$12,$13)`,
    [
      row.grant_id,
      row.grant_ref,
      row.grant_kind,
      row.grantee_user_id,
      row.assigner_user_id,
      row.site_id,
      row.scope_sku,
      row.scope_item_group_id,
      row.monthly_qty_cap,
      row.limit_amount,
      row.end_date,
      row.correlation_id,
      row.source_event_id,
    ],
  );
}

export async function getGrantById(
  grantId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<StandingGrantRow | null> {
  if (!UUID_REGEX.test(grantId)) return null;
  const result = await runner(client).query(
    `SELECT ${GRANT_COLUMNS} FROM standing_grant WHERE grant_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [grantId],
  );
  return result.rows.length > 0 ? mapGrant(result.rows[0]!) : null;
}

/** D8: the issue path locks the grant row, then re-checks active, end date and cap. */
export async function getGrantForUpdate(
  grantId: string,
  client: PoolClient,
): Promise<StandingGrantRow | null> {
  return getGrantById(grantId, client, true);
}

export interface GrantStatusPatch {
  finance_approver_user_id?: string;
  finance_decided_at?: string;
  finance_rejection_reason?: string | null;
  revoked_at?: string;
  revoked_by?: string;
  revoke_reason?: 'assigner' | 'account_disabled';
  expired_at?: string;
}

export async function setGrantStatus(
  grantId: string,
  status: GrantStatus,
  patch: GrantStatusPatch,
  client: PoolClient,
): Promise<void> {
  const sets: string[] = ['status = $2', 'updated_at = now()'];
  const values: unknown[] = [grantId, status];
  let idx = 3;
  const push = (column: string, value: unknown, cast = ''): void => {
    sets.push(`${column} = $${idx++}${cast}`);
    values.push(value);
  };
  if (patch.finance_approver_user_id !== undefined)
    push('finance_approver_user_id', patch.finance_approver_user_id, '::uuid');
  if (patch.finance_decided_at !== undefined)
    push('finance_decided_at', patch.finance_decided_at, '::timestamptz');
  if (patch.finance_rejection_reason !== undefined)
    push('finance_rejection_reason', patch.finance_rejection_reason);
  if (patch.revoked_at !== undefined) push('revoked_at', patch.revoked_at, '::timestamptz');
  if (patch.revoked_by !== undefined) push('revoked_by', patch.revoked_by);
  if (patch.revoke_reason !== undefined) push('revoke_reason', patch.revoke_reason);
  if (patch.expired_at !== undefined) push('expired_at', patch.expired_at, '::timestamptz');
  await client.query(`UPDATE standing_grant SET ${sets.join(', ')} WHERE grant_id = $1`, values);
}

/**
 * D6: the active standing approvals that cover a line - the grantee holds an active grant at the
 * raise site, not past its end date (inclusive), whose scope is the line's SKU or the item group
 * the SKU belongs to. A SKU grant sorts before a group grant, then oldest first, so the caller
 * tries the most specific grant first and falls through when its cap has no room.
 */
export async function findCoveringStandingApprovals(
  userId: string,
  siteId: string,
  sku: string,
  itemGroupId: string | null,
  onDate: string,
  client?: PoolClient,
): Promise<StandingGrantRow[]> {
  const result = await runner(client).query(
    `SELECT ${GRANT_COLUMNS} FROM standing_grant
     WHERE grantee_user_id = $1 AND site_id = $2 AND grant_kind = 'standing_approval'
       AND status = 'active'
       AND (end_date IS NULL OR end_date >= $5::date)
       AND (scope_sku = $3 OR ($4::uuid IS NOT NULL AND scope_item_group_id = $4::uuid))
     ORDER BY (scope_sku IS NOT NULL) DESC, created_at ASC, grant_id ASC`,
    [userId, siteId, sku, itemGroupId, onDate],
  );
  return result.rows.map(mapGrant);
}

/**
 * D10: the person's active self-approval limit at the site (the largest when several), not past its
 * end date. `siteId` null means any site, for the "do they hold a limit at all" view rule.
 */
export async function findActiveSelfApprovalLimit(
  userId: string,
  siteId: string | null,
  onDate: string,
  client?: PoolClient,
): Promise<StandingGrantRow | null> {
  const result = await runner(client).query(
    `SELECT ${GRANT_COLUMNS} FROM standing_grant
     WHERE grantee_user_id = $1 AND grant_kind = 'self_approval_limit' AND status = 'active'
       AND ($2::uuid IS NULL OR site_id = $2::uuid)
       AND (end_date IS NULL OR end_date >= $3::date)
     ORDER BY limit_amount DESC, created_at ASC, grant_id ASC
     LIMIT 1`,
    [userId, siteId, onDate],
  );
  return result.rows.length > 0 ? mapGrant(result.rows[0]!) : null;
}

/**
 * D7: quantity issued against a grant in one IST calendar month ('YYYY-MM'), as NUMERIC text,
 * summed from the stores issue records that carry the grant id.
 */
export async function monthToDateIssued(
  grantId: string,
  istMonth: string,
  client?: PoolClient,
): Promise<string> {
  const result = await runner(client).query(
    `SELECT COALESCE(SUM(l.quantity), 0)::numeric(18,3)::text AS issued
     FROM indent_issue_line l
     JOIN indent_issue i ON i.issue_id = l.issue_id
     WHERE l.standing_grant_id = $1
       AND to_char(i.issued_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = $2`,
    [grantId, istMonth],
  );
  return (result.rows[0] as { issued: string }).issued;
}

/** Last time stores issued against the grant, or null if never. */
export async function lastIssueAt(grantId: string, client?: PoolClient): Promise<string | null> {
  const result = await runner(client).query(
    `SELECT MAX(i.issued_at) AS last_at
     FROM indent_issue_line l JOIN indent_issue i ON i.issue_id = l.issue_id
     WHERE l.standing_grant_id = $1`,
    [grantId],
  );
  return iso((result.rows[0] as { last_at: unknown }).last_at);
}

/** Last time the person approved one of their own lines under the limit, or null if never. */
export async function lastLimitUseAt(grantId: string, client?: PoolClient): Promise<string | null> {
  const result = await runner(client).query(
    `SELECT MAX(decided_at) AS last_at FROM indent_line WHERE self_approval_grant_id = $1`,
    [grantId],
  );
  return iso((result.rows[0] as { last_at: unknown }).last_at);
}

/** Quantity issued under a grant in the half-open window [since, until), for the pruning list. */
export async function issuedBetween(
  grantId: string,
  since: string,
  until: string,
  client?: PoolClient,
): Promise<string> {
  const result = await runner(client).query(
    `SELECT COALESCE(SUM(l.quantity), 0)::numeric(18,3)::text AS issued
     FROM indent_issue_line l JOIN indent_issue i ON i.issue_id = l.issue_id
     WHERE l.standing_grant_id = $1 AND i.issued_at >= $2::timestamptz AND i.issued_at < $3::timestamptz`,
    [grantId, since, until],
  );
  return (result.rows[0] as { issued: string }).issued;
}

/** Active grants the assigner has put in place, oldest first (the pruning list's subject). */
export async function listLiveGrantsByAssigner(
  assignerUserId: string,
  client?: PoolClient,
): Promise<StandingGrantRow[]> {
  const result = await runner(client).query(
    `SELECT ${GRANT_COLUMNS} FROM standing_grant
     WHERE assigner_user_id = $1 AND status = 'active'
     ORDER BY created_at ASC, grant_id ASC`,
    [assignerUserId],
  );
  return result.rows.map(mapGrant);
}

/** Grants a person holds that can still be revoked (pending or active): D12 auto-revoke. */
export async function listLiveGrantsHeldBy(
  userId: string,
  client?: PoolClient,
): Promise<StandingGrantRow[]> {
  const result = await runner(client).query(
    `SELECT ${GRANT_COLUMNS} FROM standing_grant
     WHERE grantee_user_id = $1 AND status IN ('pending-finance', 'active')
     ORDER BY created_at ASC, grant_id ASC`,
    [userId],
  );
  return result.rows.map(mapGrant);
}

export interface ListGrantsFilter {
  assignedBy?: string;
  heldBy?: string;
  pendingFinance?: boolean;
  /** Restrict a pending-finance view to these sites (the approver's coverage). */
  siteIds?: string[] | null;
  status?: GrantStatus;
  limit?: number;
}

export async function listGrants(
  filter: ListGrantsFilter,
  client?: PoolClient,
): Promise<StandingGrantRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (filter.assignedBy) {
    conditions.push(`assigner_user_id = $${idx++}`);
    values.push(filter.assignedBy);
  }
  if (filter.heldBy) {
    conditions.push(`grantee_user_id = $${idx++}`);
    values.push(filter.heldBy);
  }
  if (filter.pendingFinance) conditions.push(`status = 'pending-finance'`);
  if (filter.status) {
    conditions.push(`status = $${idx++}`);
    values.push(filter.status);
  }
  if (filter.siteIds) {
    conditions.push(`site_id = ANY($${idx++}::uuid[])`);
    values.push(filter.siteIds);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit =
    Number.isInteger(filter.limit) && filter.limit! > 0 ? Math.min(filter.limit!, 200) : 100;
  const result = await runner(client).query(
    `SELECT ${GRANT_COLUMNS} FROM standing_grant ${where}
     ORDER BY created_at DESC, grant_id ASC LIMIT $${idx}`,
    [...values, limit],
  );
  return result.rows.map(mapGrant);
}

/** Active grants whose end date has passed, oldest end first, for the expiry sweep. */
export async function listActiveGrantsPastEnd(
  today: string,
  limit: number,
  client?: PoolClient,
): Promise<StandingGrantRow[]> {
  const result = await runner(client).query(
    `SELECT ${GRANT_COLUMNS} FROM standing_grant
     WHERE status = 'active' AND end_date IS NOT NULL AND end_date < $1::date
     ORDER BY end_date ASC, grant_id ASC LIMIT $2`,
    [today, limit],
  );
  return result.rows.map(mapGrant);
}

/** Assigners that have at least one active grant, for the pruning sweep. */
export async function listAssignersWithActiveGrants(client?: PoolClient): Promise<string[]> {
  const result = await runner(client).query(
    `SELECT DISTINCT assigner_user_id FROM standing_grant WHERE status = 'active'
     ORDER BY assigner_user_id`,
  );
  return result.rows.map((r) => (r as { assigner_user_id: string }).assigner_user_id);
}

// ---------------------------------------------------------------------------
// Pruning cadence
// ---------------------------------------------------------------------------

export interface PruneSetting {
  assigner_user_id: string;
  prune_interval_days: number;
  last_prune_sent_at: string | null;
}

export const DEFAULT_PRUNE_INTERVAL_DAYS = 30;

export async function getPruneSetting(
  assignerUserId: string,
  client?: PoolClient,
): Promise<PruneSetting> {
  const result = await runner(client).query(
    `SELECT assigner_user_id, prune_interval_days, last_prune_sent_at
     FROM standing_grant_prune_setting WHERE assigner_user_id = $1`,
    [assignerUserId],
  );
  if (result.rows.length === 0) {
    return {
      assigner_user_id: assignerUserId,
      prune_interval_days: DEFAULT_PRUNE_INTERVAL_DAYS,
      last_prune_sent_at: null,
    };
  }
  const row = result.rows[0] as Record<string, unknown>;
  return {
    assigner_user_id: assignerUserId,
    prune_interval_days: row['prune_interval_days'] as number,
    last_prune_sent_at: iso(row['last_prune_sent_at']),
  };
}

export async function upsertPruneInterval(
  assignerUserId: string,
  days: number,
  client?: PoolClient,
): Promise<void> {
  await runner(client).query(
    `INSERT INTO standing_grant_prune_setting (assigner_user_id, prune_interval_days)
     VALUES ($1, $2)
     ON CONFLICT (assigner_user_id)
     DO UPDATE SET prune_interval_days = EXCLUDED.prune_interval_days, updated_at = now()`,
    [assignerUserId, days],
  );
}

export async function stampPruneSent(
  assignerUserId: string,
  sentAt: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO standing_grant_prune_setting (assigner_user_id, last_prune_sent_at)
     VALUES ($1, $2::timestamptz)
     ON CONFLICT (assigner_user_id)
     DO UPDATE SET last_prune_sent_at = EXCLUDED.last_prune_sent_at, updated_at = now()`,
    [assignerUserId, sentAt],
  );
}

// ---------------------------------------------------------------------------
// Display helpers (slip and screen text, D9)
// ---------------------------------------------------------------------------

export interface GrantLabel {
  grantee_name: string;
  scope_label: string;
}

/** "<display name>" of the grantee and "<SKU or item group name>" of the scope. */
export async function getGrantLabel(
  grant: Pick<StandingGrantRow, 'grantee_user_id' | 'scope_sku' | 'scope_item_group_id'>,
  client?: PoolClient,
): Promise<GrantLabel> {
  const user = await runner(client).query(
    `SELECT COALESCE(NULLIF(btrim(display_name), ''), email, external_id) AS name
     FROM users WHERE user_id = $1`,
    [grant.grantee_user_id],
  );
  let scopeLabel = grant.scope_sku ?? '';
  if (grant.scope_item_group_id) {
    const group = await runner(client).query(
      `SELECT name FROM item_group WHERE item_group_id = $1`,
      [grant.scope_item_group_id],
    );
    scopeLabel = (group.rows[0] as { name?: string } | undefined)?.name ?? scopeLabel;
  }
  return {
    grantee_name: (user.rows[0] as { name?: string } | undefined)?.name ?? grant.grantee_user_id,
    scope_label: scopeLabel,
  };
}

/** D9, verbatim: the exact sentence printed on the issue screen and the slip. */
export function standingApprovalText(
  grantRef: string,
  granteeName: string,
  scopeLabel: string,
): string {
  return `Standing approval ${grantRef} for ${granteeName} (${scopeLabel}). Storekeeper please issue.`;
}

/** The item group a SKU belongs to, or null (D5: a group grant covers a line by the item's group). */
export async function getItemGroupIdOfSku(
  sku: string,
  client?: PoolClient,
): Promise<string | null> {
  const result = await runner(client).query(
    `SELECT item_group_id FROM item_master WHERE sku = $1`,
    [sku],
  );
  return (result.rows[0] as { item_group_id?: string | null } | undefined)?.item_group_id ?? null;
}
