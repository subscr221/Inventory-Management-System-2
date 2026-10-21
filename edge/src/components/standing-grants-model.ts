/**
 * Story 4.8: pure helpers behind the standing grants page. No fetch, no React, so the unit test
 * drives every rule the screen applies before it posts. The server (src/compliance/standing-grant.ts)
 * stays the authority; these rules only save a round trip and shape the request.
 */

export type GrantKind = 'standing_approval' | 'self_approval_limit';

export interface GrantRow {
  grant_id: string;
  grant_ref: string;
  grant_kind: GrantKind;
  grantee_user_id: string;
  grantee_name: string;
  scope_label: string;
  site_id: string;
  monthly_qty_cap: string | null;
  limit_amount: string | null;
  end_date: string | null;
  status: string;
}

export interface AssignForm {
  grant_kind: GrantKind;
  grantee_user_id: string;
  site_id: string;
  scope_type: 'sku' | 'group';
  scope: string;
  monthly_qty_cap: string;
  limit_amount: string;
  end_date: string;
}

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QTY_REGEX = /^\d{1,12}(\.\d{1,3})?$/;
const AMOUNT_REGEX = /^\d{1,14}(\.\d{1,4})?$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export type AssignReason =
  'bad_grantee' | 'bad_site' | 'no_scope' | 'bad_cap' | 'bad_limit' | 'bad_end_date';

export function emptyAssignForm(siteId = ''): AssignForm {
  return {
    grant_kind: 'standing_approval',
    grantee_user_id: '',
    site_id: siteId,
    scope_type: 'sku',
    scope: '',
    monthly_qty_cap: '',
    limit_amount: '',
    end_date: '',
  };
}

export function isGrantRow(value: unknown): value is GrantRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.grant_id === 'string' &&
    typeof row.grant_ref === 'string' &&
    (row.grant_kind === 'standing_approval' || row.grant_kind === 'self_approval_limit') &&
    typeof row.grantee_user_id === 'string' &&
    typeof row.grantee_name === 'string' &&
    typeof row.scope_label === 'string' &&
    typeof row.status === 'string'
  );
}

/** The POST body, or the first reason the form cannot be sent. */
export function buildAssignBody(
  form: AssignForm,
): { ok: true; body: Record<string, unknown> } | { ok: false; reason: AssignReason } {
  if (!UUID_REGEX.test(form.grantee_user_id.trim())) return { ok: false, reason: 'bad_grantee' };
  if (!UUID_REGEX.test(form.site_id.trim())) return { ok: false, reason: 'bad_site' };
  const endDate = form.end_date.trim();
  if (endDate !== '' && !DATE_REGEX.test(endDate)) return { ok: false, reason: 'bad_end_date' };
  const body: Record<string, unknown> = {
    grant_kind: form.grant_kind,
    grantee_user_id: form.grantee_user_id.trim(),
    site_id: form.site_id.trim(),
  };
  if (endDate !== '') body.end_date = endDate;
  if (form.grant_kind === 'standing_approval') {
    const scope = form.scope.trim();
    if (scope === '') return { ok: false, reason: 'no_scope' };
    if (form.scope_type === 'sku') body.scope_sku = scope;
    else body.scope_item_group_code = scope.toUpperCase();
    const cap = form.monthly_qty_cap.trim();
    if (cap !== '') {
      if (!QTY_REGEX.test(cap) || Number(cap) <= 0) return { ok: false, reason: 'bad_cap' };
      body.monthly_qty_cap = cap;
    }
  } else {
    const limit = form.limit_amount.trim();
    if (!AMOUNT_REGEX.test(limit) || Number(limit) <= 0) return { ok: false, reason: 'bad_limit' };
    body.limit_amount = limit;
  }
  return { ok: true, body };
}

/** The one-line description of a grant a list row shows; no grade words, no "no approval". */
export function describeGrant(grant: GrantRow): string {
  const what =
    grant.grant_kind === 'standing_approval'
      ? `${grant.scope_label}${grant.monthly_qty_cap ? `, up to ${grant.monthly_qty_cap} a month` : ''}`
      : `self-approval limit Rs ${grant.limit_amount ?? ''}`;
  const until = grant.end_date ? `, until ${grant.end_date}` : '';
  return `${grant.grant_ref} · ${grant.grantee_name} · ${what}${until}`;
}

/** Only a pending or active grant can still be revoked (the server answers GRANT_NOT_LIVE otherwise). */
export function canRevoke(grant: Pick<GrantRow, 'status'>): boolean {
  return grant.status === 'pending-finance' || grant.status === 'active';
}

/** Prune interval days: a whole number from 1 to 365, or null. */
export function parsePruneDays(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 365 ? n : null;
}
