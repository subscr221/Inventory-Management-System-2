import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { resolveApprover } from '../api/v1/indents.js';
import { lockAssetById } from '../read/projections/asset.js';
import {
  getAssetOperationalStatus,
  upsertAssetOperationalStatus,
} from '../read/projections/asset_operational_status.js';
import { listExaminations } from '../read/projections/statutory_examination.js';

/**
 * Story 7.6 compliance seam for the machine status broadcast (FR-M-16). Structurally mirrors
 * src/compliance/calibration-register.ts: a stream gate, a PURE pre-transaction shape assert, an
 * in-transaction projection switch, an alreadyPersisted guard and the same reject() AppError
 * helper, copied verbatim rather than re-derived.
 *
 * The applier validates the Table 5 state machine transition under lock, re-derives previous_status
 * and changed_by from the locked rows (never trusting the declared values), resolves the DOA
 * approver for return-to-service transitions (AD-3: no hard-coded role, no override flag), writes
 * the sign-off fields back onto the persisted payload, and upserts asset_operational_status.
 *
 * Locking contract: asset FOR UPDATE first (Locking Contract step 1), then the asset operational
 * status row - the only other row this applier touches. The DOA registry read is a plain SELECT;
 * the registry is append-only configuration and is never mutated by this seam, so no lock order
 * dependency exists.
 *
 * Return-to-service contract (Table 6): a transition to 'running' from 'breakdown' or
 * 'maintenance' requires a supervisor sign-off. The handler resolves the DOA approver and checks
 * the acting user is that approver (403 APPROVAL_REQUIRED, AC5); HERE the resolution is re-derived
 * under lock and the declared sign_off_by / sign_off_at are checked against it. A fabricated
 * sign_off_by is rejected 409 COST_DERIVATION_MISMATCH - a forged asset_status_changed cannot
 * bypass the return-to-service gate. No DOA entry governing maintenance.return_to_service rejects
 * 404 APPROVAL_UNRESOLVED (Table 6).
 */

const MAINTENANCE_STREAM_TYPES = new Set(['maintenance']);
const ASSET_STATUS_CHANGED = 'maintenance.asset_status_changed';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// An explicit UTC offset is REQUIRED (the Story 7.2 offset lesson).
const ISO8601_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const ASSET_OPERATIONAL_STATUSES = new Set(['running', 'idle', 'breakdown', 'maintenance']);
export const RETURN_TO_SERVICE_DOA_TYPE = 'maintenance.return_to_service';

/** The (none) state key: an asset with no asset_operational_status row yet. */
export const NO_STATUS_KEY = '__none__';

// Table 5: allowed transitions. EXPORTED and consumed by src/api/v1/maintenance.ts rather than
// duplicated there: the handler's pre-check and this applier's enforcement must widen together, or
// one of them silently permits a transition the other rejects.
export const ALLOWED_TRANSITIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [NO_STATUS_KEY, new Set(['idle'])],
  ['idle', new Set(['running', 'breakdown', 'maintenance'])],
  ['running', new Set(['idle', 'breakdown', 'maintenance'])],
  ['breakdown', new Set(['idle', 'maintenance', 'running'])],
  ['maintenance', new Set(['idle', 'breakdown', 'running'])],
]);

/**
 * Return to service is ANY transition into 'running' (AC5), not only the two Table 5 named.
 * Naming just breakdown|running and maintenance|running left breakdown -> idle -> running as two
 * ordinary writes that put a broken machine back in service with sign_off_by null and no DOA
 * approver ever resolved - the gate was two hops wide.
 */
export function requiresReturnToServiceSignOff(newStatus: string): boolean {
  return newStatus === 'running';
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO8601_TIMESTAMP_REGEX.test(value);
}

export function assetOperationalStatusEventType(envelope: EventEnvelope): string | null {
  if (!MAINTENANCE_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (envelope.event_type !== ASSET_STATUS_CHANGED) return null;
  return envelope.event_type;
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

export function assertAssetStatusChangedShape(envelope: EventEnvelope): void {
  if (assetOperationalStatusEventType(envelope) !== ASSET_STATUS_CHANGED) return;
  const p = envelope.payload as Record<string, unknown>;

  if (!isUuid(p['asset_id'])) reject('INVALID_PAYLOAD', 'asset_id must be a UUID');
  if (envelope.stream_id !== p['asset_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must match the payload asset_id', {
      stream_id: envelope.stream_id,
      payload_asset_id: p['asset_id'],
    });
  }
  const previousStatus = p['previous_status'];
  if (previousStatus !== null && !ASSET_OPERATIONAL_STATUSES.has(previousStatus as string)) {
    reject(
      'INVALID_PAYLOAD',
      'previous_status must be one of: running, idle, breakdown, maintenance, or null',
    );
  }
  const newStatus = p['new_status'];
  if (typeof newStatus !== 'string' || !ASSET_OPERATIONAL_STATUSES.has(newStatus)) {
    reject(
      'INVALID_STATUS_TRANSITION',
      'new_status must be one of: running, idle, breakdown, maintenance',
    );
  }
  if (!isUuid(p['changed_by'])) reject('INVALID_PAYLOAD', 'changed_by must be a UUID');
  if (!isIsoTimestamp(p['changed_at'])) {
    reject('INVALID_PAYLOAD', 'changed_at must be an ISO 8601 timestamp with an explicit offset');
  }
  const signOffBy = p['sign_off_by'];
  if (signOffBy !== null && !isUuid(signOffBy)) {
    reject('INVALID_PAYLOAD', 'sign_off_by must be a UUID or null');
  }
  const signOffAt = p['sign_off_at'];
  if (signOffAt !== null && !isIsoTimestamp(signOffAt)) {
    reject(
      'INVALID_PAYLOAD',
      'sign_off_at must be an ISO 8601 timestamp with an explicit offset or null',
    );
  }
}

// ---------------------------------------------------------------------------
// In-transaction applier
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key?.trim() && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

export async function applyAssetOperationalStatusProjection(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (assetOperationalStatusEventType(envelope) !== ASSET_STATUS_CHANGED) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const assetId = p['asset_id'] as string;
  const declaredPreviousStatus = p['previous_status'] as string | null;
  const newStatus = p['new_status'] as 'running' | 'idle' | 'breakdown' | 'maintenance';
  const declaredChangedBy = p['changed_by'] as string;
  const changedAt = p['changed_at'] as string;
  const declaredSignOffBy = p['sign_off_by'] as string | null;
  const declaredSignOffAt = p['sign_off_at'] as string | null;

  // Locking contract step 1: the asset row, FOR UPDATE.
  const assetExists = await lockAssetById(assetId, client);
  if (!assetExists) {
    reject('ASSET_NOT_FOUND', 'The asset does not resolve', { asset_id: assetId }, 404);
  }

  // AC1 use-lock, enforced HERE and not only in setAssetStatusBase (AD-12: the statutory lockout is
  // enforced in persistEvent pre-transaction, not in the HTTP handler, so the direct-event and edge
  // upload paths cannot bypass it). An asset with ANY overdue statutory examination is locked from
  // USE until re-examined, regardless of which examination type is due. Read under the asset lock
  // taken above, so a concurrent overdue flip on the same asset cannot slip between the two.
  //
  // Scoped to transitions INTO 'running': "locked from use" is not "frozen". Blocking every status
  // change left a locked asset unable to be recorded as 'maintenance' or 'breakdown' while the
  // re-examination it is waiting for is performed, and suppressed the AC4 broadcast that tells
  // production planning and hub booking to stop scheduling it - the two things that most need to
  // happen once an examination lapses.
  const examinations =
    newStatus === 'running' ? await listExaminations({ asset_id: assetId }, client) : [];
  const overdue = examinations.find((e) => e.status === 'overdue');
  if (overdue) {
    reject(
      'STATUTORY_EXAMINATION_OVERDUE',
      'The asset is locked: a statutory examination is overdue',
      {
        asset_id: assetId,
        examination_id: overdue.examination_id,
        examination_type: overdue.examination_type,
      },
      423,
    );
  }

  // Locking contract step 2: the status row. The declared previous_status is re-derived from the
  // locked row (null when no row exists), never trusted.
  const current = await getAssetOperationalStatus(assetId, client, true);
  const derivedPreviousStatus = current?.status ?? null;
  if (derivedPreviousStatus !== declaredPreviousStatus) {
    reject(
      'COST_DERIVATION_MISMATCH',
      'Declared previous_status does not match the current status',
      {
        asset_id: assetId,
        declared_previous_status: declaredPreviousStatus,
        derived_previous_status: derivedPreviousStatus,
      },
      409,
    );
  }

  // changed_by is actor-derived; the payload's declared value must match the envelope actor.
  if (declaredChangedBy !== envelope.metadata.actor.user_id) {
    reject(
      'COST_DERIVATION_MISMATCH',
      'Declared changed_by does not match the acting user',
      {
        asset_id: assetId,
        declared_changed_by: declaredChangedBy,
        derived_changed_by: envelope.metadata.actor.user_id,
      },
      409,
    );
  }

  // Table 5 state machine: any transition not listed rejects (no silent no-op).
  const fromKey = derivedPreviousStatus ?? NO_STATUS_KEY;
  const allowed = ALLOWED_TRANSITIONS.get(fromKey);
  if (!allowed || !allowed.has(newStatus)) {
    reject(
      'INVALID_STATUS_TRANSITION',
      'The status transition is not allowed',
      {
        asset_id: assetId,
        previous_status: derivedPreviousStatus,
        new_status: newStatus,
      },
      400,
    );
  }

  // Return-to-service sign-off (AC5, Table 6): a transition to 'running' from 'breakdown' or
  // 'maintenance' requires the DOA-resolved supervisor. The resolution is re-derived under lock
  // and the declared sign-off fields are checked against it, so a fabricated sign_off_by cannot
  // bypass the gate.
  const needsSignOff = requiresReturnToServiceSignOff(newStatus);
  if (needsSignOff) {
    const approval = await resolveApprover(RETURN_TO_SERVICE_DOA_TYPE, 0);
    if (!approval.requiresApproval || approval.approverActorId === null) {
      reject(
        'APPROVAL_UNRESOLVED',
        'No DOA entry governs maintenance.return_to_service',
        { transaction_type: RETURN_TO_SERVICE_DOA_TYPE },
        404,
      );
    }
    // No sign-off at all is the AC5 case: 403 APPROVAL_REQUIRED, the same code the handler raises.
    // Only a FORGED sign_off_by (a value that is present but is not the resolved approver) is the
    // 409 derivation mismatch the Compliance Seam Contract specifies.
    if (declaredSignOffBy === null) {
      reject(
        'APPROVAL_REQUIRED',
        'Return to service requires the resolved DOA approver to sign off',
        {
          asset_id: assetId,
          resolved_approver_user_id: approval.approverActorId,
        },
        403,
      );
    }
    if (declaredSignOffBy !== approval.approverActorId) {
      reject(
        'COST_DERIVATION_MISMATCH',
        'Declared sign_off_by does not match the resolved return-to-service approver',
        {
          asset_id: assetId,
          declared_sign_off_by: declaredSignOffBy,
          derived_sign_off_by: approval.approverActorId,
        },
        409,
      );
    }
    // The sign-off happens at the moment of the status change; the handler stamps both instants
    // together, and a declared sign_off_at that diverges is a forged (or stale) payload.
    if (declaredSignOffAt !== changedAt) {
      reject(
        'COST_DERIVATION_MISMATCH',
        'Declared sign_off_at must equal changed_at for a return-to-service transition',
        {
          asset_id: assetId,
          declared_sign_off_at: declaredSignOffAt,
          derived_sign_off_at: changedAt,
        },
        409,
      );
    }
  } else if (declaredSignOffBy !== null || declaredSignOffAt !== null) {
    reject(
      'COST_DERIVATION_MISMATCH',
      'sign_off_by and sign_off_at are only valid on a return-to-service transition',
      {
        asset_id: assetId,
        previous_status: derivedPreviousStatus,
        new_status: newStatus,
      },
      409,
    );
  }

  const signOffBy = needsSignOff ? declaredSignOffBy : null;
  const signOffAt = needsSignOff ? declaredSignOffAt : null;

  // Write the re-derived fields back onto the persisted payload so the stored event carries what
  // this process derived, not anything the caller asserted.
  p['previous_status'] = derivedPreviousStatus;
  p['changed_by'] = envelope.metadata.actor.user_id;
  p['sign_off_by'] = signOffBy;
  p['sign_off_at'] = signOffAt;

  await upsertAssetOperationalStatus(
    {
      asset_id: assetId,
      status: newStatus,
      updated_by: envelope.metadata.actor.user_id,
      sign_off_by: signOffBy,
      sign_off_at: signOffAt,
    },
    client,
  );
}
