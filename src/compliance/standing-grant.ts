import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { toIstCalendarDate } from '../lib/business-days.js';
import {
  allocateGrantRef,
  getGrantById,
  getGrantLabel,
  insertGrant,
  REVOCABLE_STATUSES,
  setGrantStatus,
  type StandingGrantRow,
} from '../read/projections/standing_grant.js';
import {
  findActiveDelegation,
  findRoleHolder,
  isActiveRoleHolderForEntry,
  listActiveDoaEntries,
} from '../read/projections/doa_registry.js';
import { logAuditEntry } from '../read/projections/audit_log.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import { alreadyPersisted } from './indent.js';

/**
 * Story 4.8 compliance seam: standing approvals and self-approval limits. Every guard lives here,
 * inside persistEvent's transaction, so no route, direct post or sweep can skip one (the Story 4.3
 * rule). Authority is read from the DOA registry only (D3, AD-3): this module names no role.
 */

export const STANDING_GRANT_ASSIGN_DOA_TYPE = 'standing_grant_assign';
export const STANDING_GRANT_FINANCE_DOA_TYPE = 'standing_grant_finance';
/** The system principal that auto-revokes (D12) and expires grants; not a real user. */
export const STANDING_GRANT_SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

const STANDING_GRANT_STREAM = 'standing_grant';
const STANDING_GRANT_EVENT_TYPES = new Set([
  'standing_grant.assigned',
  'standing_grant.finance_approved',
  'standing_grant.finance_rejected',
  'standing_grant.revoked',
  'standing_grant.expired',
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const QTY_REGEX = /^\d{1,12}(\.\d{1,3})?$/;
const AMOUNT_REGEX = /^\d{1,14}(\.\d{1,4})?$/;
const MAX_REASON_LENGTH = 500;
const MAX_SKU_LENGTH = 100;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && DATE_REGEX.test(value) && !Number.isNaN(Date.parse(value));
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

export function standingGrantEventType(envelope: EventEnvelope): string | null {
  if (envelope.stream_type !== STANDING_GRANT_STREAM) return null;
  if (!STANDING_GRANT_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

/** A quantity or amount as NUMERIC text, or null when it is not a plain positive decimal. */
function decimalText(value: unknown, pattern: RegExp): string | null {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !pattern.test(text.trim())) return null;
  return Number(text) > 0 ? text.trim() : null;
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

export function assertStandingGrantShape(envelope: EventEnvelope): void {
  const type = standingGrantEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['grant_id'])) reject('INVALID_PARAMS', 'grant_id is required and must be a UUID');
  switch (type) {
    case 'standing_grant.assigned':
      assertAssignedShape(p);
      break;
    case 'standing_grant.finance_rejected':
      if (!isNonEmptyString(p['reason'])) {
        reject('INVALID_PARAMS', 'A finance rejection requires a non-empty reason');
      }
      if ((p['reason'] as string).trim().length > MAX_REASON_LENGTH) {
        reject('INVALID_PARAMS', `reason must be at most ${MAX_REASON_LENGTH} characters`);
      }
      break;
    case 'standing_grant.revoked':
      if (p['revoke_reason'] !== 'assigner' && p['revoke_reason'] !== 'account_disabled') {
        reject('INVALID_PARAMS', 'revoke_reason must be assigner or account_disabled');
      }
      break;
    default:
      break;
  }
}

function assertAssignedShape(p: Record<string, unknown>): void {
  const kind = p['grant_kind'];
  if (kind !== 'standing_approval' && kind !== 'self_approval_limit') {
    reject('INVALID_PARAMS', 'grant_kind must be standing_approval or self_approval_limit');
  }
  if (!isUuid(p['grantee_user_id'])) {
    reject('INVALID_PARAMS', 'grantee_user_id is required and must be a UUID');
  }
  if (!isUuid(p['site_id'])) reject('INVALID_PARAMS', 'site_id is required and must be a UUID');
  if (p['end_date'] !== undefined && p['end_date'] !== null && !isDateString(p['end_date'])) {
    reject('INVALID_PARAMS', 'end_date must be a YYYY-MM-DD date string');
  }
  const hasSku = p['scope_sku'] !== undefined && p['scope_sku'] !== null;
  const hasGroup = p['scope_item_group_id'] !== undefined && p['scope_item_group_id'] !== null;
  const hasCap = p['monthly_qty_cap'] !== undefined && p['monthly_qty_cap'] !== null;
  const hasLimit = p['limit_amount'] !== undefined && p['limit_amount'] !== null;
  if (kind === 'standing_approval') {
    if (hasSku === hasGroup) {
      reject(
        'GRANT_SCOPE_INVALID',
        'A standing approval names exactly one of scope_sku or scope_item_group_id',
      );
    }
    if (hasSku && (!isNonEmptyString(p['scope_sku']) || p['scope_sku'].length > MAX_SKU_LENGTH)) {
      reject('GRANT_SCOPE_INVALID', 'scope_sku must be a non-empty SKU');
    }
    if (hasGroup && !isUuid(p['scope_item_group_id'])) {
      reject('GRANT_SCOPE_INVALID', 'scope_item_group_id must be a UUID');
    }
    if (hasLimit) {
      reject('INVALID_PARAMS', 'A standing approval carries no limit_amount');
    }
    if (hasCap && decimalText(p['monthly_qty_cap'], QTY_REGEX) === null) {
      reject(
        'INVALID_PARAMS',
        'monthly_qty_cap must be a positive quantity with at most 3 decimals',
      );
    }
  } else {
    if (hasSku || hasGroup || hasCap) {
      reject('INVALID_PARAMS', 'A self-approval limit carries no scope or monthly_qty_cap');
    }
    if (decimalText(p['limit_amount'], AMOUNT_REGEX) === null) {
      reject('INVALID_PARAMS', 'limit_amount must be a positive amount with at most 4 decimals');
    }
  }
}

// ---------------------------------------------------------------------------
// Authority (D3) - resolved through the DOA registry
// ---------------------------------------------------------------------------

/** Holders of any role the registry governs `transactionType` with, at the grant site (D3). */
async function holdsGoverningRole(
  transactionType: string,
  userId: string,
  siteId: string,
  client?: PoolClient,
): Promise<boolean> {
  const entries = await listActiveDoaEntries(transactionType, client);
  for (const entry of entries) {
    if (await isActiveRoleHolderForEntry(entry.entry_id, userId, client, siteId)) return true;
  }
  return false;
}

/** Story 4.3 pattern: a governing-role holder, or the active delegate of the role's resolved holder. */
export async function isResolvedFinanceApprover(
  userId: string,
  siteId: string,
  onDate: string,
  client?: PoolClient,
): Promise<boolean> {
  if (await holdsGoverningRole(STANDING_GRANT_FINANCE_DOA_TYPE, userId, siteId, client))
    return true;
  for (const entry of await listActiveDoaEntries(STANDING_GRANT_FINANCE_DOA_TYPE, client)) {
    const holder = await findRoleHolder(entry.role, client, siteId);
    if (!holder) continue;
    const delegation = await findActiveDelegation(holder.user_id, onDate, client);
    if (delegation?.delegate_user_id === userId) return true;
  }
  return false;
}

/** Roles governing finance approval, for notification routing and the "can this grant be decided" check. */
export async function financeRoles(client?: PoolClient): Promise<string[]> {
  const entries = await listActiveDoaEntries(STANDING_GRANT_FINANCE_DOA_TYPE, client);
  return [...new Set(entries.map((e) => e.role))];
}

export function isGrantLive(grant: Pick<StandingGrantRow, 'status'>): boolean {
  return (REVOCABLE_STATUSES as readonly string[]).includes(grant.status);
}

// ---------------------------------------------------------------------------
// Inside-transaction projection (DB access)
// ---------------------------------------------------------------------------

function ctxOf(envelope: EventEnvelope): { actorId: string; now: string; today: string } {
  const now = envelope.metadata.occurred_at;
  return {
    actorId: envelope.metadata.actor.user_id,
    now,
    today: toIstCalendarDate(new Date(now)),
  };
}

async function audit(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  verb: string,
  grant: StandingGrantRow,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await logAuditEntry(client, {
    trace_id: envelope.metadata.correlation_id ?? '',
    user_id: envelope.metadata.actor.user_id,
    role: envelope.metadata.actor.role,
    location_id: envelope.metadata.actor.location_id,
    endpoint: `/standing-grants/${grant.grant_id}/${verb}`,
    method: 'POST',
    event_id: eventId,
    http_status: 200,
    error_code: `standing_grant.${verb}`,
    details: {
      grant_id: grant.grant_id,
      grant_ref: grant.grant_ref,
      grant_kind: grant.grant_kind,
      grantee_user_id: grant.grantee_user_id,
      assigner_user_id: grant.assigner_user_id,
      site_id: grant.site_id,
      ...extra,
    },
  });
}

async function notify(
  envelope: EventEnvelope,
  client: PoolClient,
  target: { role: string; user_id?: string; location_id?: string },
  grant: StandingGrantRow,
  statusVerb: string,
  nextStep: string,
): Promise<void> {
  await emitNotificationInTransaction(
    {
      target,
      event_type: 'standing_grant',
      status_verb: statusVerb,
      object_type: 'standing_grant',
      object_id: grant.grant_id,
      actor_label: grant.grant_ref,
      next_step: nextStep,
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      occurred_at: envelope.metadata.occurred_at,
    },
    client,
  );
}

export async function applyStandingGrantProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = standingGrantEventType(envelope);
  if (!type) return;
  if (await alreadyPersisted(envelope, client)) return;
  switch (type) {
    case 'standing_grant.assigned':
      await applyAssigned(envelope, client, eventId);
      break;
    case 'standing_grant.finance_approved':
      await applyFinanceDecision(envelope, client, eventId, 'active');
      break;
    case 'standing_grant.finance_rejected':
      await applyFinanceDecision(envelope, client, eventId, 'rejected');
      break;
    case 'standing_grant.revoked':
      await applyRevoked(envelope, client, eventId);
      break;
    case 'standing_grant.expired':
      await applyExpired(envelope, client, eventId);
      break;
  }
}

async function applyAssigned(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const grantId = p['grant_id'] as string;
  const kind = p['grant_kind'] as StandingGrantRow['grant_kind'];
  const granteeId = p['grantee_user_id'] as string;
  const siteId = p['site_id'] as string;
  const { actorId, today } = ctxOf(envelope);

  if (await getGrantById(grantId, client)) {
    reject(
      'DUPLICATE_EVENT',
      'A grant with this grant_id already exists',
      { grant_id: grantId },
      409,
    );
  }
  // D4: a person is never the assigner of their own grant.
  if (actorId === granteeId) {
    reject(
      'GRANT_SELF_ASSIGNMENT',
      'A standing approval or limit cannot be assigned to yourself',
      { grantee_user_id: granteeId },
      403,
    );
  }
  // D3: the assigner holds a role the registry names for standing_grant_assign, at the grant site.
  if (!(await holdsGoverningRole(STANDING_GRANT_ASSIGN_DOA_TYPE, actorId, siteId, client))) {
    reject(
      'GRANT_ASSIGNER_NOT_AUTHORIZED',
      'Only a site head or head of department of this site can assign a standing approval or limit',
      { site_id: siteId, acting_user_id: actorId },
      403,
    );
  }
  const grantee = await client.query(`SELECT active FROM users WHERE user_id = $1`, [granteeId]);
  if (grantee.rows.length === 0 || (grantee.rows[0] as { active: boolean }).active !== true) {
    reject(
      'GRANT_GRANTEE_INVALID',
      'The grantee is not an active user',
      { grantee_user_id: granteeId },
      409,
    );
  }
  const endDate = typeof p['end_date'] === 'string' ? p['end_date'] : null;
  if (endDate !== null && endDate < today) {
    reject('INVALID_PARAMS', 'end_date is already in the past', { end_date: endDate });
  }
  // A grant nobody can approve would sit pending forever: refuse it while the assigner is looking.
  if ((await financeRoles(client)).length === 0) {
    reject(
      'GRANT_FINANCE_NOT_RESOLVED',
      'No finance approval authority is registered for standing grants',
      { transaction_type: STANDING_GRANT_FINANCE_DOA_TYPE },
      409,
    );
  }

  let scopeSku: string | null = null;
  let scopeGroupId: string | null = null;
  if (kind === 'standing_approval') {
    if (typeof p['scope_sku'] === 'string') {
      scopeSku = p['scope_sku'].trim();
      const item = await client.query(`SELECT status FROM item_master WHERE sku = $1`, [scopeSku]);
      if (item.rows.length === 0 || (item.rows[0] as { status: string }).status !== 'active') {
        reject('GRANT_SCOPE_INVALID', 'scope_sku is not an active item', { scope_sku: scopeSku });
      }
    } else {
      scopeGroupId = p['scope_item_group_id'] as string;
      const group = await client.query(`SELECT status FROM item_group WHERE item_group_id = $1`, [
        scopeGroupId,
      ]);
      if (group.rows.length === 0 || (group.rows[0] as { status: string }).status !== 'active') {
        reject('GRANT_SCOPE_INVALID', 'scope_item_group_id is not an active item group', {
          scope_item_group_id: scopeGroupId,
        });
      }
    }
  }

  const year = Number(today.slice(0, 4));
  const grantRef = await allocateGrantRef(year, client);
  await insertGrant(
    {
      grant_id: grantId,
      grant_ref: grantRef,
      grant_kind: kind,
      grantee_user_id: granteeId,
      assigner_user_id: actorId,
      site_id: siteId,
      scope_sku: scopeSku,
      scope_item_group_id: scopeGroupId,
      monthly_qty_cap:
        kind === 'standing_approval' ? decimalText(p['monthly_qty_cap'], QTY_REGEX) : null,
      limit_amount:
        kind === 'self_approval_limit' ? decimalText(p['limit_amount'], AMOUNT_REGEX) : null,
      end_date: endDate,
      correlation_id: envelope.metadata.correlation_id ?? null,
      source_event_id: eventId,
    },
    client,
  );
  const grant = (await getGrantById(grantId, client))!;
  await audit(envelope, client, eventId, 'assigned', grant, {
    scope_sku: grant.scope_sku,
    scope_item_group_id: grant.scope_item_group_id,
    monthly_qty_cap: grant.monthly_qty_cap,
    limit_amount: grant.limit_amount,
    end_date: grant.end_date,
  });
  const label = await getGrantLabel(grant, client);
  const what =
    kind === 'standing_approval'
      ? `standing approval for ${label.grantee_name} (${label.scope_label})`
      : `self-approval limit Rs ${grant.limit_amount} for ${label.grantee_name}`;
  for (const role of await financeRoles(client)) {
    await notify(
      envelope,
      client,
      { role, location_id: siteId },
      grant,
      'awaiting your approval',
      `Approve or reject ${what}`,
    );
  }
}

async function loadForDecision(
  p: Record<string, unknown>,
  client: PoolClient,
): Promise<StandingGrantRow> {
  const grant = await getGrantById(p['grant_id'] as string, client, true);
  if (!grant) {
    reject('GRANT_NOT_FOUND', 'Standing grant not found', { grant_id: p['grant_id'] }, 404);
  }
  return grant;
}

async function applyFinanceDecision(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  outcome: 'active' | 'rejected',
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const grant = await loadForDecision(p, client);
  const { actorId, now, today } = ctxOf(envelope);
  if (grant.status !== 'pending-finance') {
    reject(
      'GRANT_NOT_PENDING',
      `Grant ${grant.grant_ref} is ${grant.status}; only a pending grant can be decided`,
      { grant_id: grant.grant_id, status: grant.status },
      409,
    );
  }
  // D4: finance is neither the assigner nor the grantee, so a limit is never self-approved.
  if (actorId === grant.assigner_user_id || actorId === grant.grantee_user_id) {
    reject(
      'GRANT_FINANCE_NOT_RESOLVED',
      'The assigner and the grantee cannot decide the finance approval of their own grant',
      { grant_id: grant.grant_id, acting_user_id: actorId },
      403,
    );
  }
  if (!(await isResolvedFinanceApprover(actorId, grant.site_id, today, client))) {
    reject(
      'GRANT_FINANCE_NOT_RESOLVED',
      'The acting user is not a resolved finance approver for standing grants',
      { grant_id: grant.grant_id, acting_user_id: actorId },
      403,
    );
  }
  if (outcome === 'active') {
    const grantee = await client.query(`SELECT active FROM users WHERE user_id = $1`, [
      grant.grantee_user_id,
    ]);
    if ((grantee.rows[0] as { active?: boolean } | undefined)?.active !== true) {
      reject(
        'GRANT_GRANTEE_INVALID',
        'The grantee is no longer an active user',
        { grantee_user_id: grant.grantee_user_id },
        409,
      );
    }
    if (grant.end_date !== null && grant.end_date < today) {
      reject(
        'GRANT_END_DATE_PASSED',
        'The end date of this grant has already passed',
        { end_date: grant.end_date },
        409,
      );
    }
  }
  const reason = outcome === 'rejected' ? (p['reason'] as string).trim() : null;
  await setGrantStatus(
    grant.grant_id,
    outcome,
    {
      finance_approver_user_id: actorId,
      finance_decided_at: now,
      ...(reason !== null ? { finance_rejection_reason: reason } : {}),
    },
    client,
  );
  await audit(
    envelope,
    client,
    eventId,
    outcome === 'active' ? 'finance_approved' : 'finance_rejected',
    grant,
    reason !== null ? { reason } : {},
  );
  const label = await getGrantLabel(grant, client);
  const scope =
    grant.grant_kind === 'standing_approval' ? label.scope_label : `limit Rs ${grant.limit_amount}`;
  if (outcome === 'active') {
    await notify(
      envelope,
      client,
      { role: envelope.metadata.actor.role, user_id: grant.assigner_user_id },
      grant,
      'approved',
      `Finance approved ${grant.grant_ref} for ${label.grantee_name} (${scope}); it is now active`,
    );
    await notify(
      envelope,
      client,
      { role: envelope.metadata.actor.role, user_id: grant.grantee_user_id },
      grant,
      'active',
      grant.grant_kind === 'standing_approval'
        ? `Standing approval ${grant.grant_ref} is active for ${label.scope_label}`
        : `Self-approval limit Rs ${grant.limit_amount} is active`,
    );
  } else {
    await notify(
      envelope,
      client,
      { role: envelope.metadata.actor.role, user_id: grant.assigner_user_id },
      grant,
      'rejected',
      `Finance rejected ${grant.grant_ref} for ${label.grantee_name} (${scope}). Reason: ${reason}`,
    );
  }
}

async function applyRevoked(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const grant = await loadForDecision(p, client);
  const { actorId, now } = ctxOf(envelope);
  const reason = p['revoke_reason'] as 'assigner' | 'account_disabled';
  // Only the assigner revokes by hand (no second approver, D2); account_disabled is the system's.
  const isSystem = actorId === STANDING_GRANT_SYSTEM_ACTOR_ID;
  const allowed = reason === 'assigner' ? actorId === grant.assigner_user_id : isSystem;
  if (!allowed) {
    reject(
      'GRANT_ASSIGNER_NOT_AUTHORIZED',
      'Only the assigner can revoke this grant',
      { grant_id: grant.grant_id, acting_user_id: actorId },
      403,
    );
  }
  if (!isGrantLive(grant)) {
    reject(
      'GRANT_NOT_LIVE',
      `Grant ${grant.grant_ref} is ${grant.status} and cannot be revoked`,
      { grant_id: grant.grant_id, status: grant.status },
      409,
    );
  }
  await setGrantStatus(
    grant.grant_id,
    'revoked',
    { revoked_at: now, revoked_by: actorId, revoke_reason: reason },
    client,
  );
  await audit(envelope, client, eventId, 'revoked', grant, {
    revoke_reason: reason,
    previous_status: grant.status,
  });
  const label = await getGrantLabel(grant, client);
  if (reason === 'account_disabled') {
    await notify(
      envelope,
      client,
      { role: envelope.metadata.actor.role, user_id: grant.assigner_user_id },
      grant,
      'revoked',
      `${grant.grant_ref} for ${label.grantee_name} was revoked: the account was disabled`,
    );
  } else {
    await notify(
      envelope,
      client,
      { role: envelope.metadata.actor.role, user_id: grant.grantee_user_id },
      grant,
      'revoked',
      `${grant.grant_ref} was revoked by the person who assigned it`,
    );
  }
}

async function applyExpired(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const grant = await loadForDecision(p, client);
  const { actorId, now, today } = ctxOf(envelope);
  if (actorId !== STANDING_GRANT_SYSTEM_ACTOR_ID) {
    reject(
      'GRANT_ASSIGNER_NOT_AUTHORIZED',
      'Only the expiry sweep expires a grant',
      { grant_id: grant.grant_id, acting_user_id: actorId },
      403,
    );
  }
  if (grant.status !== 'active' || grant.end_date === null || grant.end_date >= today) {
    reject(
      'GRANT_NOT_LIVE',
      `Grant ${grant.grant_ref} is not an active grant past its end date`,
      { grant_id: grant.grant_id, status: grant.status, end_date: grant.end_date },
      409,
    );
  }
  await setGrantStatus(grant.grant_id, 'expired', { expired_at: now }, client);
  await audit(envelope, client, eventId, 'expired', grant, { end_date: grant.end_date });
  const label = await getGrantLabel(grant, client);
  await notify(
    envelope,
    client,
    { role: envelope.metadata.actor.role, user_id: grant.assigner_user_id },
    grant,
    'expired',
    `${grant.grant_ref} for ${label.grantee_name} ended on ${grant.end_date}`,
  );
}
