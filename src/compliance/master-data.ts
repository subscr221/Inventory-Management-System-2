import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { toIstCalendarDate } from '../lib/business-days.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import { getItemBySku } from '../read/projections/item_master.js';
import { locationExistsById } from '../read/projections/location_register.js';
import {
  findMatchingDoaEntry,
  findRoleHolder,
  findActiveDelegation,
  listActiveDoaEntries,
} from '../read/projections/doa_registry.js';
import {
  BIS_LICENCE_TYPES,
  insertBisLicence,
  updateBisLicenceWindow,
  getBisLicenceById,
  findOverlappingBisLicence,
  insertBisLicenceAlert,
  markBisLicenceExpired,
  findBisLicenceByScope,
} from '../read/projections/compliance_bis_licence.js';
import {
  insertLabelDraft,
  getLabelMasterById,
  approveLabelVersion,
  supersedeApprovedLabel,
  findLabelMasterByVersion,
} from '../read/projections/label_master.js';

/**
 * Story 8.7 compliance master-data seam (FR-Q-11 BIS licence register, FR-Q-14 Legal Metrology
 * label masters). Structurally mirrors src/compliance/maintenance-coverage.ts: a stream gate, a
 * PURE pre-transaction shape assert, an in-transaction projection switch, and the same reject()
 * AppError helper, copied rather than re-derived (BSD-1).
 *
 * Every guard lives in the applier, never only in the HTTP handler (AD-12): the route pre-checks
 * exist for a cheap, audited rejection, but the applier re-derives every guard under the
 * transaction because the pre-check is not the in-transaction guarantee (BSD-4).
 */

export const BIS_LICENCE_RECORDED = 'compliance.bis_licence_recorded';
export const BIS_LICENCE_UPDATED = 'compliance.bis_licence_updated';
export const BIS_LICENCE_EXPIRY_FLAGGED = 'compliance.bis_licence_expiry_flagged';
export const LABEL_VERSION_DRAFTED = 'compliance.label_version_drafted';
export const LABEL_VERSION_APPROVED = 'compliance.label_version_approved';

const COMPLIANCE_MASTER_DATA_EVENT_TYPES = new Set([
  BIS_LICENCE_RECORDED,
  BIS_LICENCE_UPDATED,
  BIS_LICENCE_EXPIRY_FLAGGED,
  LABEL_VERSION_DRAFTED,
  LABEL_VERSION_APPROVED,
]);

/** FR-Q-11 pins these numbers, so they are a module constant, NOT deployment config (BSD-5). */
export const BIS_LICENCE_EXPIRY_STAGES = [90, 60, 30] as const;

/** The role string lives in ONE module constant so a PO rename is a single edit (BSD-5). */
export const COMPLIANCE_LICENCE_ALERT_ROLE = 'compliance_admin';

/**
 * Label-approval notifications target their own constant. It currently resolves to the same role,
 * but BSD-5 scopes COMPLIANCE_LICENCE_ALERT_ROLE to expiry alerts - sharing it would make a PO
 * rename of the licence-alert recipient silently retarget label approvals too.
 */
export const COMPLIANCE_LABEL_APPROVAL_ROLE = 'compliance_admin';

/** DOA transaction type for label approval (BSD-4). */
export const LABEL_MASTER_APPROVAL_DOA_TYPE = 'compliance.label_master_approval';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_REGEX.test(value)) return false;
  const [y, m, d] = value.split('-').map((part) => Number(part));
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  // Date.UTC maps years 0-99 onto 1900+y, so the round-trip check would reject '0050-06-15'.
  dt.setUTCFullYear(y!);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

/**
 * The expiry stages due for a licence that is `daysToExpiry` calendar days from its valid_to,
 * ordered most-urgent-last. A window already past (daysToExpiry < 0) yields [0] ALONE: the expiry
 * flip is the only meaningful transition, and emitting 90/60/30 alongside it would fire four
 * notifications and land 'Expiring soon' after 'Expired'.
 */
export function dueBisLicenceExpiryStages(daysToExpiry: number): number[] {
  if (daysToExpiry < 0) return [0];
  return BIS_LICENCE_EXPIRY_STAGES.filter((stage) => daysToExpiry <= stage);
}

/** The single most urgent stage currently due, or null when none is. */
export function mostUrgentDueBisLicenceExpiryStage(daysToExpiry: number): number | null {
  const due = dueBisLicenceExpiryStages(daysToExpiry);
  return due.length > 0 ? due[due.length - 1]! : null;
}

export function complianceMasterDataEventType(envelope: EventEnvelope): string | null {
  if (envelope.stream_type !== 'compliance') return null;
  if (!COMPLIANCE_MASTER_DATA_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

/** True only for a 23505 raised by the named constraint - never for an incidental primary key. */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { code?: string }).code === '23505' &&
    (err as { constraint?: string }).constraint === constraint
  );
}

function calendarDaysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

function rejectDeclaredDerived(
  p: Record<string, unknown>,
  fields: string[],
  context: string,
): void {
  for (const field of fields) {
    if (p[field] !== undefined) {
      reject(
        'COMPLIANCE_DERIVATION_MISMATCH',
        `${field} is derived by the server and cannot be declared on ${context}`,
        { field, declared_value: p[field] },
        409,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// DOA authority resolution (BSD-4) - mirrors resolveQcAuthority WITHOUT requireQcHead
// ---------------------------------------------------------------------------

export interface ComplianceAuthority {
  approver_user_id: string;
  doa_entry_id: string;
  governing_role: string;
  delegation_applied: boolean;
}

export async function resolveComplianceAuthority(
  transactionType: string,
  client?: PoolClient,
): Promise<ComplianceAuthority> {
  const entry = await findMatchingDoaEntry(transactionType, 0, client);
  if (!entry) {
    reject(
      'APPROVAL_UNRESOLVED',
      `No DOA entry governs ${transactionType}`,
      { transaction_type: transactionType },
      409,
    );
  }
  const today = toIstCalendarDate(new Date());
  const tryHolder = async (
    role: string,
  ): Promise<{ user_id: string; delegation_applied: boolean } | null> => {
    const holder = await findRoleHolder(role, client);
    if (!holder) return null;
    const delegation = await findActiveDelegation(holder.user_id, today, client);
    return delegation
      ? { user_id: delegation.delegate_user_id, delegation_applied: true }
      : { user_id: holder.user_id, delegation_applied: false };
  };
  let resolved = await tryHolder(entry.role);
  let usedEntry = entry;
  if (!resolved) {
    const entries = await listActiveDoaEntries(transactionType, client);
    for (const candidate of entries) {
      if (candidate.role === entry.role) continue;
      resolved = await tryHolder(candidate.role);
      if (resolved) {
        usedEntry = candidate;
        break;
      }
    }
  }
  if (!resolved) {
    reject(
      'APPROVAL_UNRESOLVED',
      'Approval is required but no active approver could be resolved',
      { transaction_type: transactionType, governing_role: entry.role, reason: 'no_active_holder' },
      409,
    );
  }
  return {
    approver_user_id: resolved.user_id,
    doa_entry_id: usedEntry.entry_id,
    governing_role: usedEntry.role,
    delegation_applied: resolved.delegation_applied,
  };
}

// ---------------------------------------------------------------------------
// Application-level existence validation (BSD-8) - shared by the route and the applier
// ---------------------------------------------------------------------------

export async function requireItemExists(sku: string, client?: PoolClient): Promise<void> {
  const item = await getItemBySku(sku, client);
  if (!item) {
    reject('ITEM_NOT_FOUND', `The item master row for sku ${sku} does not resolve`, { sku }, 409);
  }
}

export async function requireLocationExists(
  siteId: string | null | undefined,
  client?: PoolClient,
): Promise<void> {
  if (siteId === null || siteId === undefined) return;
  if (!(await locationExistsById(siteId, client))) {
    reject('LOCATION_NOT_FOUND', `site_id ${siteId} does not resolve`, { site_id: siteId }, 404);
  }
}

export async function requireNoOverlap(
  sku: string,
  siteId: string | null,
  validFrom: string,
  validTo: string,
  excludeLicenceId: string | null,
  client?: PoolClient,
): Promise<void> {
  const overlap = await findOverlappingBisLicence(
    sku,
    siteId,
    validFrom,
    validTo,
    excludeLicenceId,
    client,
  );
  if (overlap) {
    reject(
      'BIS_LICENCE_OVERLAP',
      'Another licence for the same sku and site scope has an overlapping validity window',
      { existing_licence_id: overlap.licence_id },
      409,
    );
  }
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

function assertBisLicenceRecordedShape(envelope: EventEnvelope): void {
  const p = envelope.payload;
  if (!isUuid(p['licence_id']))
    reject('INVALID_PARAMS', 'licence_id must be a UUID', { field: 'licence_id' });
  if (typeof p['licence_number'] !== 'string' || p['licence_number'].trim() === '') {
    reject('INVALID_PARAMS', 'licence_number is required', { field: 'licence_number' });
  }
  if (!(BIS_LICENCE_TYPES as readonly string[]).includes(p['licence_type'] as string)) {
    reject('INVALID_PARAMS', 'licence_type must be cml or r_number', { field: 'licence_type' });
  }
  if (typeof p['sku'] !== 'string' || p['sku'].trim() === '') {
    reject('INVALID_PARAMS', 'sku is required', { field: 'sku' });
  }
  if (p['site_id'] !== null && p['site_id'] !== undefined && !isUuid(p['site_id'])) {
    reject('INVALID_PARAMS', 'site_id must be a UUID or null', { field: 'site_id' });
  }
  if (!isIsoDate(p['valid_from']))
    reject('INVALID_PARAMS', 'valid_from must be a valid ISO date', { field: 'valid_from' });
  if (!isIsoDate(p['valid_to']))
    reject('INVALID_PARAMS', 'valid_to must be a valid ISO date', { field: 'valid_to' });
  if ((p['valid_to'] as string) < (p['valid_from'] as string)) {
    reject('INVALID_PARAMS', 'valid_to must be on or after valid_from', { field: 'valid_to' });
  }
  rejectDeclaredDerived(p, ['status'], BIS_LICENCE_RECORDED);
}

function assertBisLicenceUpdatedShape(envelope: EventEnvelope): void {
  const p = envelope.payload;
  if (!isUuid(p['licence_id']))
    reject('INVALID_PARAMS', 'licence_id must be a UUID', { field: 'licence_id' });
  if (p['valid_from'] === undefined && p['valid_to'] === undefined) {
    reject('INVALID_PARAMS', 'At least one of valid_from/valid_to is required', {});
  }
  if (p['valid_from'] !== undefined && !isIsoDate(p['valid_from'])) {
    reject('INVALID_PARAMS', 'valid_from must be a valid ISO date', { field: 'valid_from' });
  }
  if (p['valid_to'] !== undefined && !isIsoDate(p['valid_to'])) {
    reject('INVALID_PARAMS', 'valid_to must be a valid ISO date', { field: 'valid_to' });
  }
  rejectDeclaredDerived(
    p,
    ['status', 'licence_number', 'licence_type', 'sku', 'site_id'],
    BIS_LICENCE_UPDATED,
  );
}

function assertBisLicenceExpiryFlaggedShape(envelope: EventEnvelope): void {
  const p = envelope.payload;
  if (!isUuid(p['licence_id']))
    reject('INVALID_PARAMS', 'licence_id must be a UUID', { field: 'licence_id' });
  const stage = p['stage_days'];
  if (typeof stage !== 'number' || ![90, 60, 30, 0].includes(stage)) {
    reject('INVALID_PARAMS', 'stage_days must be one of 90, 60, 30, 0', { field: 'stage_days' });
  }
  rejectDeclaredDerived(p, ['status', 'valid_to', 'flagged_at'], BIS_LICENCE_EXPIRY_FLAGGED);
}

function assertLabelVersionDraftedShape(envelope: EventEnvelope): void {
  const p = envelope.payload;
  if (!isUuid(p['label_id']))
    reject('INVALID_PARAMS', 'label_id must be a UUID', { field: 'label_id' });
  if (typeof p['sku'] !== 'string' || p['sku'].trim() === '') {
    reject('INVALID_PARAMS', 'sku is required', { field: 'sku' });
  }
  if (typeof p['label_version'] !== 'string' || p['label_version'].trim() === '') {
    reject('INVALID_PARAMS', 'label_version is required', { field: 'label_version' });
  }
  rejectDeclaredDerived(p, ['status', 'approved_by', 'approved_at'], LABEL_VERSION_DRAFTED);
}

function assertLabelVersionApprovedShape(envelope: EventEnvelope): void {
  const p = envelope.payload;
  if (!isUuid(p['label_id']))
    reject('INVALID_PARAMS', 'label_id must be a UUID', { field: 'label_id' });
  // BSD-4: approved_by/doa_entry_id/governing_role/delegation_applied are SERVER-resolved at write
  // time and carried on the payload so a projection rebuild is deterministic after the DOA registry
  // drifts. They are therefore required, not forbidden - the applier re-derives and compares them
  // on first apply (AD-12), so carrying them buys replay determinism without trusting the client.
  if (!isUuid(p['approved_by'])) {
    reject('INVALID_PARAMS', 'approved_by must be a UUID', { field: 'approved_by' });
  }
  if (!isUuid(p['doa_entry_id'])) {
    reject('INVALID_PARAMS', 'doa_entry_id must be a UUID', { field: 'doa_entry_id' });
  }
  if (typeof p['governing_role'] !== 'string' || p['governing_role'].trim() === '') {
    reject('INVALID_PARAMS', 'governing_role is required', { field: 'governing_role' });
  }
  if (typeof p['delegation_applied'] !== 'boolean') {
    reject('INVALID_PARAMS', 'delegation_applied must be a boolean', {
      field: 'delegation_applied',
    });
  }
  rejectDeclaredDerived(
    p,
    ['approved_at', 'status', 'sku', 'label_version'],
    LABEL_VERSION_APPROVED,
  );
}

export function assertComplianceMasterDataShape(envelope: EventEnvelope): void {
  if (complianceMasterDataEventType(envelope) === null) return;
  switch (envelope.event_type) {
    case BIS_LICENCE_RECORDED:
      return assertBisLicenceRecordedShape(envelope);
    case BIS_LICENCE_UPDATED:
      return assertBisLicenceUpdatedShape(envelope);
    case BIS_LICENCE_EXPIRY_FLAGGED:
      return assertBisLicenceExpiryFlaggedShape(envelope);
    case LABEL_VERSION_DRAFTED:
      return assertLabelVersionDraftedShape(envelope);
    case LABEL_VERSION_APPROVED:
      return assertLabelVersionApprovedShape(envelope);
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// In-transaction appliers (Task 7)
// ---------------------------------------------------------------------------

async function applyBisLicenceRecorded(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  const p = envelope.payload;
  const licenceId = p['licence_id'] as string;
  const licenceNumber = (p['licence_number'] as string).trim();
  const licenceType = p['licence_type'] as string;
  const sku = p['sku'] as string;
  const siteId = (p['site_id'] as string | null | undefined) ?? null;
  const validFrom = p['valid_from'] as string;
  const validTo = p['valid_to'] as string;

  await requireItemExists(sku, client);
  await requireLocationExists(siteId, client);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sku + '|' + (siteId ?? '')]);
  await requireNoOverlap(sku, siteId, validFrom, validTo, null, client);

  try {
    await insertBisLicence(
      { licenceId, licenceNumber, licenceType, sku, siteId, validFrom, validTo },
      toIstCalendarDate(new Date()),
      client,
    );
  } catch (err) {
    // Only the scope index means "duplicate licence number"; a primary-key violation is a replayed
    // licence_id and must not be reported as a duplicate registration.
    if (isUniqueViolation(err, 'uq_compliance_bis_licence_scope')) {
      // The sequential path must return the SAME details as the store's 23505 race arm, or a
      // caller sees a different contract depending on which one it happened to hit. The lookup
      // deliberately does NOT take `client`: the 23505 has already aborted that transaction, so any
      // further query on it fails with 25P02. The conflicting row is committed, so the pool sees it.
      const existing = await findBisLicenceByScope(licenceNumber, sku, siteId);
      reject(
        'BIS_LICENCE_EXISTS',
        'A licence with this number already exists for this sku and site scope',
        {
          licence_number: licenceNumber,
          sku,
          site_id: siteId,
          existing_licence_id: existing?.licence_id ?? null,
        },
        409,
      );
    }
    throw err;
  }
}

async function applyBisLicenceUpdated(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  const p = envelope.payload;
  const licenceId = p['licence_id'] as string;
  const existing = await getBisLicenceById(licenceId, client, true);
  if (!existing) {
    reject(
      'BIS_LICENCE_NOT_FOUND',
      `No licence found for id ${licenceId}`,
      { licence_id: licenceId },
      404,
    );
  }
  const validFrom = (p['valid_from'] as string | undefined) ?? existing.valid_from;
  const validTo = (p['valid_to'] as string | undefined) ?? existing.valid_to;
  if (validTo < validFrom) {
    reject('INVALID_PARAMS', 'valid_to must be on or after valid_from', { field: 'valid_to' });
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    existing.sku + '|' + (existing.site_id ?? ''),
  ]);
  await requireNoOverlap(existing.sku, existing.site_id, validFrom, validTo, licenceId, client);
  // BSD-3: renewal is an in-place window update, so status is recomputed from the new window (a
  // licence the sweep already flipped to 'expired' comes back into service). The alert ledger is
  // keyed on (licence_id, valid_to, stage_days) and is append-only, so the new window simply has
  // no ledger rows and re-alerts by construction - no history is erased.
  await updateBisLicenceWindow(
    licenceId,
    validFrom,
    validTo,
    toIstCalendarDate(new Date()),
    client,
  );
}

async function applyBisLicenceExpiryFlagged(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload;
  const licenceId = p['licence_id'] as string;
  const stageDays = p['stage_days'] as number;

  const licence = await getBisLicenceById(licenceId, client, true);
  if (!licence) {
    // An alert for a licence that does not exist is an integrity signal, not something to swallow.
    reject(
      'BIS_LICENCE_NOT_FOUND',
      `No licence found for id ${licenceId}`,
      { licence_id: licenceId },
      404,
    );
  }

  // stage_days is asserted by the caller, so it is re-derived here from the stored valid_to under
  // the transaction (AD-12/BSD-4). Without this cross-check any actor able to persist a compliance
  // event could send stage_days = 0 and expire a live licence, blocking every statutory release.
  const daysToExpiry = calendarDaysBetween(toIstCalendarDate(new Date()), licence.valid_to);
  if (!dueBisLicenceExpiryStages(daysToExpiry).includes(stageDays)) {
    reject(
      'BIS_LICENCE_STAGE_NOT_DUE',
      `stage_days ${stageDays} is not due for this licence`,
      { licence_id: licenceId, stage_days: stageDays, valid_to: licence.valid_to },
      409,
    );
  }

  // The insert IS the idempotency decision (no read-then-insert race): rowCount 0 means another
  // transaction already flagged this stage, so this call must neither re-flip nor re-notify.
  const inserted = await insertBisLicenceAlert(licenceId, licence.valid_to, stageDays, client);
  if (!inserted) return; // idempotent by construction (BSD-5)

  if (stageDays === 0) {
    await markBisLicenceExpired(licenceId, client);
  }

  // BSD-5: ONE notification per licence per cycle. The ledger records every missed stage, but only
  // the currently most-urgent due stage speaks; the catch-up rows stay silent.
  if (stageDays !== mostUrgentDueBisLicenceExpiryStage(daysToExpiry)) return;

  await emitNotificationInTransaction(
    {
      target: { role: COMPLIANCE_LICENCE_ALERT_ROLE, location_id: 'ENTERPRISE', user_id: null },
      event_type: 'bis_licence_expiry_alert',
      status_verb: stageDays === 0 ? 'Expired' : 'Expiring soon',
      object_type: 'bis_licence',
      object_id: licenceId,
      actor_label: 'System',
      next_step:
        stageDays === 0
          ? 'Renew the licence to restore release eligibility'
          : `Licence expires within ${stageDays} days`,
      actor: {
        user_id: envelope.metadata.actor.user_id,
        role: envelope.metadata.actor.role,
        location_id: envelope.metadata.actor.location_id,
      },
      causation_id: eventId,
      occurred_at: envelope.metadata.occurred_at,
    },
    client,
  );
}

async function applyLabelVersionDrafted(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  const p = envelope.payload;
  const labelId = p['label_id'] as string;
  const sku = p['sku'] as string;
  const labelVersion = (p['label_version'] as string).trim();

  await requireItemExists(sku, client);

  try {
    await insertLabelDraft(labelId, sku, labelVersion, envelope.metadata.actor.user_id, client);
  } catch (err) {
    // uq_label_master_version is case-folded and trimmed, so 'V1' and 'v1' collide here; a
    // primary-key violation is a replayed label_id and keeps its own error.
    if (isUniqueViolation(err, 'uq_label_master_version')) {
      // Not on `client`: the 23505 has aborted that transaction (see the licence arm above).
      const existing = await findLabelMasterByVersion(sku, labelVersion);
      reject(
        'LABEL_VERSION_EXISTS',
        'A label draft with this sku and version already exists',
        { sku, label_version: labelVersion, existing_label_id: existing?.label_id ?? null },
        409,
      );
    }
    throw err;
  }
}

async function applyLabelVersionApproved(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload;
  const labelId = p['label_id'] as string;

  const capturedApprover = p['approved_by'] as string;
  const capturedDoaEntry = p['doa_entry_id'] as string;

  // BSD-4/AD-12: re-derive the authority under the transaction and refuse a payload that does not
  // match what the server resolves NOW. On a first apply this is the guard - a forged or stale
  // approver cannot land. A projection rebuild runs against the same stored payload, so the
  // captured values are what the row is rebuilt from even after the DOA registry has drifted.
  const authority = await resolveComplianceAuthority(LABEL_MASTER_APPROVAL_DOA_TYPE, client);
  if (
    authority.approver_user_id !== capturedApprover ||
    authority.doa_entry_id !== capturedDoaEntry
  ) {
    reject(
      'APPROVAL_AUTHORITY_MISMATCH',
      'The captured approval authority does not match the authority resolved now',
      {
        label_id: labelId,
        captured_approver_user_id: capturedApprover,
        resolved_approver_user_id: authority.approver_user_id,
      },
      409,
    );
  }
  if (authority.approver_user_id !== envelope.metadata.actor.user_id) {
    reject(
      'APPROVAL_REQUIRED',
      'Actor is not the DOA-resolved approver for label approval',
      {
        label_id: labelId,
        resolved_approver_user_id: authority.approver_user_id,
        governing_role: authority.governing_role,
      },
      403,
    );
  }

  const existing = await getLabelMasterById(labelId, client, true);
  if (!existing) {
    reject(
      'LABEL_MASTER_NOT_FOUND',
      `No label found for id ${labelId}`,
      { label_id: labelId },
      404,
    );
  }
  if (existing.status !== 'draft') {
    reject(
      'LABEL_VERSION_NOT_DRAFT',
      'Only a draft label version can be approved',
      { label_id: labelId, status: existing.status },
      409,
    );
  }
  // Segregation of duties: the drafting actor cannot approve their own label version. This is the
  // control a DOA-governed label master exists to enforce, so it is checked in the applier under
  // the transaction, never only in the route.
  if (existing.created_by !== null && existing.created_by === capturedApprover) {
    reject(
      'LABEL_APPROVAL_SOD_VIOLATION',
      'The drafting user cannot approve their own label version',
      { label_id: labelId, created_by: existing.created_by },
      409,
    );
  }

  const approvedAt = envelope.metadata.occurred_at;
  // Supersede the prior approved row FIRST: uq_label_master_current is a partial unique index on
  // (sku) WHERE status = 'approved', so approving this row before superseding the predecessor
  // would momentarily hold two 'approved' rows for the same sku and violate it.
  await supersedeApprovedLabel(existing.sku, labelId, client);
  try {
    await approveLabelVersion(labelId, capturedApprover, approvedAt, client);
  } catch (err) {
    // Two concurrent approvals for one sku: the loser hits uq_label_master_current (partial unique
    // on sku WHERE status = 'approved'). Surface the stable contract code, never a raw 23505 500.
    if (isUniqueViolation(err, 'uq_label_master_current')) {
      reject(
        'LABEL_VERSION_APPROVAL_CONFLICT',
        'Another label version for this sku was approved concurrently',
        { label_id: labelId, sku: existing.sku },
        409,
      );
    }
    throw err;
  }

  await emitNotificationInTransaction(
    {
      target: { role: COMPLIANCE_LABEL_APPROVAL_ROLE, location_id: 'ENTERPRISE', user_id: null },
      event_type: 'label_master_approved',
      status_verb: 'Approved',
      object_type: 'label_master',
      object_id: labelId,
      actor_label: envelope.metadata.actor.role,
      next_step: null,
      actor: {
        user_id: envelope.metadata.actor.user_id,
        role: envelope.metadata.actor.role,
        location_id: envelope.metadata.actor.location_id,
      },
      causation_id: eventId,
      occurred_at: envelope.metadata.occurred_at,
    },
    client,
  );
}

export async function applyComplianceMasterDataProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (complianceMasterDataEventType(envelope) === null) return;
  switch (envelope.event_type) {
    case BIS_LICENCE_RECORDED:
      return applyBisLicenceRecorded(envelope, client);
    case BIS_LICENCE_UPDATED:
      return applyBisLicenceUpdated(envelope, client);
    case BIS_LICENCE_EXPIRY_FLAGGED:
      return applyBisLicenceExpiryFlagged(envelope, client, eventId);
    case LABEL_VERSION_DRAFTED:
      return applyLabelVersionDrafted(envelope, client);
    case LABEL_VERSION_APPROVED:
      return applyLabelVersionApproved(envelope, client, eventId);
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// 23505 duplicate-conflict resolvers (store.ts race-path arms, Task 3.3)
// ---------------------------------------------------------------------------

export async function resolveBisLicenceExistsDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const licenceNumber = payload['licence_number'];
  const sku = payload['sku'];
  const siteId = (payload['site_id'] as string | null | undefined) ?? null;
  // Return the CONFLICTING row's identity, the way the BIS_LICENCE_OVERLAP path returns
  // existing_licence_id - the submitted values alone tell the caller nothing new.
  const existing =
    typeof licenceNumber === 'string' && typeof sku === 'string'
      ? await findBisLicenceByScope(licenceNumber, sku, siteId)
      : null;
  return {
    licence_number: licenceNumber,
    sku,
    site_id: siteId,
    existing_licence_id: existing?.licence_id ?? null,
  };
}

export async function resolveLabelVersionExistsDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sku = payload['sku'];
  const labelVersion = payload['label_version'];
  const existing =
    typeof sku === 'string' && typeof labelVersion === 'string'
      ? await findLabelMasterByVersion(sku, labelVersion)
      : null;
  return {
    sku,
    label_version: labelVersion,
    existing_label_id: existing?.label_id ?? null,
  };
}
