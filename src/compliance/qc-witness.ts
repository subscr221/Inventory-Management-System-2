import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { config } from '../config/index.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import { getItemBySku } from '../read/projections/item_master.js';
import { appendTraceEntry } from '../read/projections/lot_trace.js';
import { clearQualityHold, placeQualityHold } from '../read/projections/lot_master.js';
import { getQcInspectionTaskByLotId } from '../read/projections/qc_inspection_task.js';
import {
  getQcQualityHoldById,
  insertQcQualityHold,
  otherOpenQcQualityHoldExists,
  releaseQcQualityHold,
} from '../read/projections/qc_quality_hold.js';
import {
  WITNESS_INSPECTION_TYPES,
  insertWitnessHoldPoint,
  getWitnessHoldPointById,
  closeWitnessHoldPoint,
  type WitnessInspectionType,
} from '../read/projections/qc_witness_hold_point.js';
import {
  WITNESS_NOTICE_METHODS,
  insertWitnessNotice,
  countNoticesForHoldPoint,
  type WitnessNoticeMethod,
} from '../read/projections/qc_witness_notice.js';
import { resolveQcAuthority } from './quality.js';

/**
 * Story 8.8 witnessed / third-party inspection seam (FR-Q-15). Structurally mirrors the Story 8.7
 * seam (src/compliance/master-data.ts): a stream gate, PURE pre-transaction shape asserts, an
 * in-transaction projection switch, and the same local reject() AppError helper, copied rather
 * than re-derived.
 *
 * Every guard lives in the applier, never only in the HTTP handler (AD-12): the waive route
 * pre-resolves the DOA authority for a cheap, audited 403, but the applier re-derives and compares
 * it under the transaction because the pre-check is not the in-transaction guarantee.
 *
 * Binding Scope Decision 2: the hold placed by a hold point is a NORMAL governed qc_quality_hold
 * row plus the lot_master flag - the same pair applyHoldPlaced writes. That is what makes AC 1
 * true without touching dispatch.ts: the Story 3.7 gate refuses the lot with LOT_ON_HOLD, and the
 * Story 2.3 ad hoc clear route refuses to lift it with QUALITY_HOLD_GOVERNED, both unchanged.
 */

export const WITNESS_HOLD_POINT_RAISED = 'qc.witness_hold_point_raised';
export const WITNESS_NOTICE_RECORDED = 'qc.witness_notice_recorded';
export const WITNESSED_INSPECTION_SIGNED_OFF = 'qc.witnessed_inspection_signed_off';
export const WITNESSED_INSPECTION_WAIVED = 'qc.witnessed_inspection_waived';

const QC_WITNESS_EVENT_TYPES = new Set([
  WITNESS_HOLD_POINT_RAISED,
  WITNESS_NOTICE_RECORDED,
  WITNESSED_INSPECTION_SIGNED_OFF,
  WITNESSED_INSPECTION_WAIVED,
]);

/**
 * DOA transaction type for a witnessed-inspection waiver (BSD-7), matching the
 * INSPECTION_PLAN_APPROVAL_DOA_TYPE convention. There is no central DOA-type registry - the string
 * is free-form on doa_registry_entries.transaction_type - so it lives in ONE module constant.
 */
export const WITNESS_WAIVER_DOA_TYPE = 'qc.witnessed_inspection_waiver';

/** Notifications about a witness hold point ride the existing QC notification role. */
const WITNESS_NOTIFICATION_ROLE = config.quality.inspectionTaskNotificationRole;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT_2000 = 2000;
const MAX_RECIPIENT = 512;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_REGEX.test(value)) return false;
  const [y, m, d] = value.split('-').map((part) => Number(part));
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCFullYear(y!);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

export function qcWitnessEventType(envelope: EventEnvelope): string | null {
  if (envelope.stream_type !== 'qc') return null;
  if (!QC_WITNESS_EVENT_TYPES.has(envelope.event_type)) return null;
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

/** True only for a 23505 raised by the named constraint - never for an incidental primary key. */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { code?: string }).code === '23505' &&
    (err as { constraint?: string }).constraint === constraint
  );
}

function rejectDeclaredDerived(
  p: Record<string, unknown>,
  fields: string[],
  context: string,
): void {
  for (const field of fields) {
    if (p[field] !== undefined) {
      reject(
        'QC_DERIVATION_MISMATCH',
        `${field} is derived by the server and cannot be declared on ${context}`,
        { field, declared_value: p[field] },
        409,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Pure shape asserts (pre-transaction, no database)
// ---------------------------------------------------------------------------

function assertWitnessHoldPointRaisedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['hold_point_id'])) reject('INVALID_PAYLOAD', 'hold_point_id must be a UUID');
  if (typeof p['lot_number'] !== 'string' || p['lot_number'].trim() === '') {
    reject('INVALID_PAYLOAD', 'lot_number must be a non-empty string');
  }
  if (typeof p['sku'] !== 'string' || p['sku'].trim() === '') {
    reject('INVALID_PAYLOAD', 'sku must be a non-empty string');
  }
  // The vocabulary is validated here so a bad value is a cheap 400 rather than a 23514 round trip.
  if (!WITNESS_INSPECTION_TYPES.includes(p['inspection_type'] as WitnessInspectionType)) {
    reject(
      'INVALID_PAYLOAD',
      `inspection_type must be one of ${WITNESS_INSPECTION_TYPES.join(', ')}`,
      {
        inspection_type: p['inspection_type'],
      },
    );
  }
  if (!isBoundedText(p['hold_reason'], MAX_TEXT_2000)) {
    reject(
      'INVALID_PAYLOAD',
      `hold_reason must be a non-empty string of at most ${MAX_TEXT_2000} characters`,
    );
  }
  rejectDeclaredDerived(
    p,
    ['lot_id', 'site_id', 'qc_hold_id', 'status', 'raised_by', 'raised_at'],
    WITNESS_HOLD_POINT_RAISED,
  );
}

function assertWitnessNoticeRecordedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['notice_id'])) reject('INVALID_PAYLOAD', 'notice_id must be a UUID');
  if (!isUuid(p['hold_point_id'])) reject('INVALID_PAYLOAD', 'hold_point_id must be a UUID');
  if (!isBoundedText(p['recipient'], MAX_RECIPIENT)) {
    reject(
      'INVALID_PAYLOAD',
      `recipient must be a non-empty string of at most ${MAX_RECIPIENT} characters`,
    );
  }
  if (!isIsoDate(p['notice_date'])) {
    reject('INVALID_PAYLOAD', 'notice_date must be a calendar date (YYYY-MM-DD)');
  }
  if (!WITNESS_NOTICE_METHODS.includes(p['method'] as WitnessNoticeMethod)) {
    reject('INVALID_PAYLOAD', `method must be one of ${WITNESS_NOTICE_METHODS.join(', ')}`, {
      method: p['method'],
    });
  }
  rejectDeclaredDerived(p, ['recorded_by', 'recorded_at'], WITNESS_NOTICE_RECORDED);
}

function assertWitnessedInspectionSignedOffShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['hold_point_id'])) reject('INVALID_PAYLOAD', 'hold_point_id must be a UUID');
  if (p['sign_off_note'] !== undefined && !isBoundedText(p['sign_off_note'], MAX_TEXT_2000)) {
    reject(
      'INVALID_PAYLOAD',
      `sign_off_note must be a non-empty string of at most ${MAX_TEXT_2000} characters`,
    );
  }
  rejectDeclaredDerived(
    p,
    ['status', 'closed_by', 'closed_at', 'close_event_id'],
    WITNESSED_INSPECTION_SIGNED_OFF,
  );
}

function assertWitnessedInspectionWaivedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['hold_point_id'])) reject('INVALID_PAYLOAD', 'hold_point_id must be a UUID');
  if (!isBoundedText(p['waiver_reason'], MAX_TEXT_2000)) {
    reject(
      'INVALID_PAYLOAD',
      `waiver_reason must be a non-empty string of at most ${MAX_TEXT_2000} characters`,
    );
  }
  // SERVER-CAPTURED, not server-derived (BSD-7): the route resolves these and the applier compares
  // them against a fresh resolution, so they are REQUIRED on the payload rather than forbidden.
  if (!isUuid(p['approved_by'])) reject('INVALID_PAYLOAD', 'approved_by must be a UUID');
  if (!isUuid(p['doa_entry_id'])) reject('INVALID_PAYLOAD', 'doa_entry_id must be a UUID');
  if (typeof p['governing_role'] !== 'string' || p['governing_role'].trim() === '') {
    reject('INVALID_PAYLOAD', 'governing_role must be a non-empty string');
  }
  if (typeof p['delegation_applied'] !== 'boolean') {
    reject('INVALID_PAYLOAD', 'delegation_applied must be a boolean');
  }
  rejectDeclaredDerived(
    p,
    ['status', 'closed_by', 'closed_at', 'close_event_id'],
    WITNESSED_INSPECTION_WAIVED,
  );
}

export function assertQcWitnessShape(envelope: EventEnvelope): void {
  if (qcWitnessEventType(envelope) === null) return;
  switch (envelope.event_type) {
    case WITNESS_HOLD_POINT_RAISED:
      return assertWitnessHoldPointRaisedShape(envelope);
    case WITNESS_NOTICE_RECORDED:
      return assertWitnessNoticeRecordedShape(envelope);
    case WITNESSED_INSPECTION_SIGNED_OFF:
      return assertWitnessedInspectionSignedOffShape(envelope);
    case WITNESSED_INSPECTION_WAIVED:
      return assertWitnessedInspectionWaivedShape(envelope);
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Pure predicates (unit-testable without a database)
// ---------------------------------------------------------------------------

/**
 * BSD-6: a sign-off against a hold point carrying ZERO notices is refused. A WAIVER is deliberately
 * exempt - a waiver exists precisely for the case where notice could not be given or the inspection
 * could not be held, so requiring a notice first would make the waiver unreachable in the very
 * situation it is for. The asymmetry is intentional; do not "fix" it by symmetry.
 */
export function noticeRequirementSatisfied(noticeCount: number): boolean {
  return noticeCount > 0;
}

/**
 * BSD-4, the hold-bypass class the 8.3, 8.4 and 8.5 reviews EACH found: a release path may clear
 * lot_master.quality_hold_status ONLY when no other open governed hold remains AND the flag was
 * set by THIS hold. The ownership test is string equality on quality_hold_reason - fragile, but it
 * is the house rule at quality.ts:5256-5260, matched here verbatim rather than improved.
 */
export function mayClearQualityHoldFlag(
  otherOpenHoldExists: boolean,
  lotQualityHoldReason: string | null,
  thisHoldReason: string,
): boolean {
  return !otherOpenHoldExists && lotQualityHoldReason === thisHoldReason;
}

// ---------------------------------------------------------------------------
// Appliers
// ---------------------------------------------------------------------------

/**
 * AC 1 + AC 2: opens the hold point and places the governed hold behind it. Locks the LOT row
 * first, then the QC task row (the lot-then-task order every Story 8.1-8.5 applier uses - the other
 * order deadlocks against them), inserts BOTH the qc_quality_hold record and the hold-point record,
 * sets the ONE enforcement flag in the same transaction, appends the lot_trace entry and emits the
 * AD-17 notification.
 *
 * Flag-reason subtlety, carried verbatim from applyHoldPlaced: when the lot is ALREADY flag-held,
 * the existing reason is PRESERVED rather than overwritten, so closing this hold point cannot lift
 * a containment it did not create.
 */
async function applyWitnessHoldPointRaised(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const holdPointId = p['hold_point_id'] as string;
  const lotNumberIn = (p['lot_number'] as string).trim();
  const skuIn = (p['sku'] as string).trim();
  const inspectionType = p['inspection_type'] as WitnessInspectionType;
  const holdReason = (p['hold_reason'] as string).trim();
  const actorId = envelope.metadata.actor.user_id;
  const raisedAt = envelope.metadata.occurred_at;

  // Lot first (the fixed lock order: lot, then QC gate row, then stock - dispatch.ts:31-34).
  const lotResult = await client.query(
    `SELECT lot_id, lot_number, sku, quality_hold_status, quality_hold_reason
       FROM lot_master WHERE lot_number = $1 AND sku = $2 FOR UPDATE`,
    [lotNumberIn, skuIn],
  );
  if (lotResult.rows.length === 0) {
    reject(
      'LOT_NOT_FOUND',
      'The lot does not resolve',
      { lot_number: lotNumberIn, sku: skuIn },
      404,
    );
  }
  const lot = lotResult.rows[0]!;
  const lotId = lot['lot_id'] as string;
  const lotNumber = lot['lot_number'] as string;
  const sku = lot['sku'] as string;
  // May be null: an ungoverned lot is still holdable. A wildcard-scoped actor's metadata carries
  // the zero-UUID NO_LOCATION sentinel (quality.ts:134) - store NULL, never the sentinel, so the
  // row stays visible through the site_id IS NULL arm of the scoped list (code review 2026-09-02
  // round 2). The literal is repeated rather than imported: this module must not import from the
  // api layer.
  const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
  const task = await getQcInspectionTaskByLotId(lotId, client, true);
  const actorLocation = envelope.metadata.actor.location_id;
  // qc_quality_hold.site_id is NOT NULL (the Story 8.5 convention stores the sentinel there);
  // only the witness hold point's nullable column gets the NULL.
  const qcHoldSiteId = task?.site_id ?? actorLocation;
  const siteId = task?.site_id ?? (actorLocation === NO_LOCATION_UUID ? null : actorLocation);

  // The governed hold IS the enforcement (BSD-2). qc_hold_id is minted from the hold point id so a
  // replay of this event reproduces the same pair of rows rather than a second orphaned hold.
  const qcHoldId = holdPointId;
  try {
    await insertQcQualityHold(
      {
        hold_id: qcHoldId,
        lot_id: lotId,
        lot_number: lotNumber,
        sku,
        site_id: qcHoldSiteId,
        hold_reason: holdReason,
        defect_code: null,
        placed_by: actorId,
        placed_at: raisedAt,
        source_event_id: eventId,
      },
      client,
    );
  } catch (err) {
    // uq_qc_quality_hold_open: the lot already carries an open governed hold from ANY source
    // (Story 8.5, 8.3 scrap parking, or an earlier witness hold point). Surface the QC contract
    // code rather than a raw 23505 500.
    if (isUniqueViolation(err, 'uq_qc_quality_hold_open')) {
      reject(
        'HOLD_EXISTS',
        'An open quality hold already exists for this lot',
        { lot_id: lotId, lot_number: lotNumber, sku },
        409,
      );
    }
    throw err;
  }

  try {
    await insertWitnessHoldPoint(
      {
        hold_point_id: holdPointId,
        lot_id: lotId,
        lot_number: lotNumber,
        sku,
        site_id: siteId,
        inspection_type: inspectionType,
        qc_hold_id: qcHoldId,
        raised_by: actorId,
        raised_at: raisedAt,
        source_event_id: eventId,
      },
      client,
    );
  } catch (err) {
    if (isUniqueViolation(err, 'uq_qc_witness_hold_point_open')) {
      reject(
        'WITNESS_HOLD_POINT_EXISTS',
        'An open witness hold point already exists for this lot',
        { lot_id: lotId, lot_number: lotNumber, sku },
        409,
      );
    }
    throw err;
  }

  // Set the ONE enforcement flag, preserving a pre-existing reason (see the doc comment above).
  if (lot['quality_hold_status'] !== 'held') {
    const flagged = await placeQualityHold(lotNumber, sku, holdReason, client);
    if (!flagged) {
      reject('LOT_NOT_FOUND', 'The lot could not be flag-held', { lot_id: lotId }, 404);
    }
  }

  const item = await getItemBySku(sku, client);
  await appendTraceEntry(
    {
      lot_id: lotId,
      event_id: eventId,
      event_type: WITNESS_HOLD_POINT_RAISED,
      sku,
      location_id: null,
      location_code: null,
      quantity_change: '0',
      business_stream: item?.business_stream ?? 'production',
      timestamp: raisedAt,
    },
    client,
  );

  p['lot_id'] = lotId;
  p['site_id'] = siteId;
  p['qc_hold_id'] = qcHoldId;
  p['status'] = 'open';
  p['raised_by'] = actorId;
  p['raised_at'] = raisedAt;

  // AD-17: raising a hold point is a decision.
  await emitNotificationInTransaction(
    {
      target: { role: WITNESS_NOTIFICATION_ROLE, location_id: siteId },
      event_type: 'qc_witness_hold_point_raised',
      status_verb: 'Witness hold point raised',
      object_type: 'qc_witness_hold_point',
      object_id: holdPointId,
      actor_label: `Lot ${lotNumber} (${sku})`,
      next_step:
        'Serve notice on the customer or third party, then record the sign-off or a DOA-approved waiver',
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      causation_id: eventId,
      occurred_at: raisedAt,
    },
    client,
  );
}

/**
 * AC 2: records the notice as EVIDENCE (recipient, date, method) against an OPEN hold point. The
 * hold point is loaded FOR UPDATE first: there is no cross-projection FK by house rule, so
 * referential integrity is this applier's job.
 */
async function applyWitnessNoticeRecorded(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const noticeId = p['notice_id'] as string;
  const holdPointId = p['hold_point_id'] as string;
  const recipient = (p['recipient'] as string).trim();
  const noticeDate = p['notice_date'] as string;
  const method = p['method'] as WitnessNoticeMethod;
  const actorId = envelope.metadata.actor.user_id;
  const recordedAt = envelope.metadata.occurred_at;

  const holdPoint = await getWitnessHoldPointById(holdPointId, client, true);
  if (!holdPoint) {
    reject(
      'WITNESS_HOLD_POINT_NOT_FOUND',
      'The named witness hold point does not resolve',
      { hold_point_id: holdPointId },
      404,
    );
  }
  if (holdPoint.status !== 'open') {
    reject(
      'WITNESS_HOLD_POINT_NOT_OPEN',
      'The witness hold point is no longer open',
      { hold_point_id: holdPointId, status: holdPoint.status },
      409,
    );
  }

  await insertWitnessNotice(
    {
      notice_id: noticeId,
      hold_point_id: holdPointId,
      recipient,
      notice_date: noticeDate,
      method,
      recorded_by: actorId,
      recorded_at: recordedAt,
      source_event_id: eventId,
    },
    client,
  );

  p['recorded_by'] = actorId;
  p['recorded_at'] = recordedAt;

  // BSD-5: the notification is emitted ALONGSIDE the ledger row, never instead of it - a
  // notification stores no recipient/method contract that can be read back as evidence.
  await emitNotificationInTransaction(
    {
      target: { role: WITNESS_NOTIFICATION_ROLE, location_id: holdPoint.site_id },
      event_type: 'qc_witness_notice_recorded',
      status_verb: 'Inspection notice served',
      object_type: 'qc_witness_hold_point',
      object_id: holdPointId,
      actor_label: `Lot ${holdPoint.lot_number} (${holdPoint.sku})`,
      next_step: 'Hold the inspection, then record the sign-off',
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      causation_id: eventId,
      occurred_at: recordedAt,
    },
    client,
  );
}

/**
 * The closure path shared by sign-off and waiver. Both close the hold point the SAME way (the
 * Story 8.7 lifecycle-asymmetry lesson): guarded UPDATE, guarded release of the governed hold, and
 * the BSD-4 two-part flag-ownership predicate.
 */
async function closeHoldPointAndRelease(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  args: {
    holdPointId: string;
    status: 'signed_off' | 'waived';
    releaseReason: string;
    waiverDoaEntryId: string | null;
    waiverReason: string | null;
    /** Guards that need the locked row; throws to refuse before anything is written. */
    beforeClose?: (holdPoint: {
      raised_by: string;
      lot_id: string;
      hold_point_id: string;
    }) => Promise<void> | void;
  },
): Promise<{ lotNumber: string; sku: string; siteId: string | null }> {
  const actorId = envelope.metadata.actor.user_id;
  const closedAt = envelope.metadata.occurred_at;

  // Read WITHOUT a lock to learn the lot (the Story 8.2 pattern), then lock lot-first.
  const peek = await getWitnessHoldPointById(args.holdPointId, client);
  if (!peek) {
    reject(
      'WITNESS_HOLD_POINT_NOT_FOUND',
      'The named witness hold point does not resolve',
      { hold_point_id: args.holdPointId },
      404,
    );
  }
  const lotResult = await client.query(
    `SELECT lot_id, lot_number, sku, quality_hold_status, quality_hold_reason
       FROM lot_master WHERE lot_id = $1 FOR UPDATE`,
    [peek.lot_id],
  );
  if (lotResult.rows.length === 0) {
    reject('LOT_NOT_FOUND', 'The lot does not resolve', { lot_id: peek.lot_id }, 404);
  }
  const lot = lotResult.rows[0]!;

  const holdPoint = await getWitnessHoldPointById(args.holdPointId, client, true);
  if (!holdPoint) {
    reject(
      'WITNESS_HOLD_POINT_NOT_FOUND',
      'The named witness hold point does not resolve',
      { hold_point_id: args.holdPointId },
      404,
    );
  }
  if (holdPoint.status !== 'open') {
    reject(
      'WITNESS_HOLD_POINT_NOT_OPEN',
      'The witness hold point is no longer open',
      { hold_point_id: args.holdPointId, status: holdPoint.status },
      409,
    );
  }

  if (args.beforeClose) await args.beforeClose(holdPoint);

  const closed = await closeWitnessHoldPoint(
    {
      hold_point_id: args.holdPointId,
      status: args.status,
      closed_by: actorId,
      closed_at: closedAt,
      close_event_id: eventId,
      waiver_doa_entry_id: args.waiverDoaEntryId,
      waiver_reason: args.waiverReason,
    },
    client,
  );
  if (!closed) {
    reject(
      'WITNESS_HOLD_POINT_NOT_OPEN',
      'The witness hold point is no longer open',
      { hold_point_id: args.holdPointId },
      409,
    );
  }

  // Release the governed hold this hold point placed, then clear the flag ONLY under the BSD-4
  // two-part ownership predicate.
  const qcHold = await getQcQualityHoldById(holdPoint.qc_hold_id, client, true);
  if (qcHold && qcHold.status === 'open') {
    await releaseQcQualityHold(
      {
        hold_id: qcHold.hold_id,
        released_by: actorId,
        released_at: closedAt,
        release_reason: args.releaseReason,
        release_event_id: eventId,
      },
      client,
    );
    const otherOpen = await otherOpenQcQualityHoldExists(qcHold.lot_id, qcHold.hold_id, client);
    if (
      mayClearQualityHoldFlag(
        otherOpen,
        (lot['quality_hold_reason'] as string | null) ?? null,
        qcHold.hold_reason,
      )
    ) {
      await clearQualityHold(qcHold.lot_number, qcHold.sku, client);
    }
  }

  const item = await getItemBySku(holdPoint.sku, client);
  await appendTraceEntry(
    {
      lot_id: holdPoint.lot_id,
      event_id: eventId,
      event_type: envelope.event_type,
      sku: holdPoint.sku,
      location_id: null,
      location_code: null,
      quantity_change: '0',
      business_stream: item?.business_stream ?? 'production',
      timestamp: closedAt,
    },
    client,
  );

  const p = envelope.payload as Record<string, unknown>;
  p['status'] = args.status;
  p['closed_by'] = actorId;
  p['closed_at'] = closedAt;
  p['close_event_id'] = eventId;

  return { lotNumber: holdPoint.lot_number, sku: holdPoint.sku, siteId: holdPoint.site_id };
}

/** AC 1: the witness signs off, the hold point closes and the governed hold is released. */
async function applyWitnessedInspectionSignedOff(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const holdPointId = p['hold_point_id'] as string;

  const closure = await closeHoldPointAndRelease(envelope, client, eventId, {
    holdPointId,
    status: 'signed_off',
    releaseReason: 'Witnessed inspection signed off',
    waiverDoaEntryId: null,
    waiverReason: null,
    beforeClose: async (holdPoint) => {
      // Code review 2026-09-02: sign-off releases the same governed hold the waiver does, so it
      // carries the same segregation - the raiser cannot sign off their own hold point. Reuses
      // SOD_VIOLATION, matching the BSD-8 waiver arm and the release SoD at quality.ts:5250.
      if (holdPoint.raised_by === envelope.metadata.actor.user_id) {
        reject(
          'SOD_VIOLATION',
          'The actor who raised a witness hold point cannot sign off its inspection',
          { hold_point_id: holdPointId, raised_by: holdPoint.raised_by },
          409,
        );
      }
      // BSD-6: notice before inspection. A waiver is deliberately exempt from this check.
      const notices = await countNoticesForHoldPoint(holdPointId, client);
      if (!noticeRequirementSatisfied(notices)) {
        reject(
          'WITNESS_NOTICE_REQUIRED',
          'A notice must be recorded against the hold point before the inspection is signed off',
          { hold_point_id: holdPointId, notice_count: notices },
          409,
        );
      }
    },
  });

  await emitNotificationInTransaction(
    {
      target: { role: WITNESS_NOTIFICATION_ROLE, location_id: closure.siteId },
      event_type: 'qc_witnessed_inspection_signed_off',
      status_verb: 'Witnessed inspection signed off',
      object_type: 'qc_witness_hold_point',
      object_id: holdPointId,
      actor_label: `Lot ${closure.lotNumber} (${closure.sku})`,
      next_step: 'The lot is released from the witness hold point',
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      causation_id: eventId,
      occurred_at: envelope.metadata.occurred_at,
    },
    client,
  );
}

/**
 * AC 1, waiver arm. BSD-7 composes the Story 8.1 QC-Head resolver with the Story 8.7
 * compare-on-apply: resolveQcAuthority re-derives under the transaction, and a disagreement with
 * the captured quartet is APPROVAL_AUTHORITY_MISMATCH. No existing code composed these two - this
 * is a deliberate synthesis. Only approver_user_id and doa_entry_id are compared, matching the 8.7
 * guard exactly; widening it to governing_role/delegation_applied is recorded as deferred work
 * rather than done here, because keeping the two seams identical is worth more.
 */
async function applyWitnessedInspectionWaived(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const holdPointId = p['hold_point_id'] as string;
  const waiverReason = (p['waiver_reason'] as string).trim();
  const capturedApprover = p['approved_by'] as string;
  const capturedDoaEntry = p['doa_entry_id'] as string;

  const authority = await resolveQcAuthority(
    WITNESS_WAIVER_DOA_TYPE,
    { requireQcHead: true },
    client,
  );
  if (
    authority.approver_user_id !== capturedApprover ||
    authority.doa_entry_id !== capturedDoaEntry
  ) {
    reject(
      'APPROVAL_AUTHORITY_MISMATCH',
      'The captured approval authority does not match the authority resolved now',
      {
        hold_point_id: holdPointId,
        captured_approver_user_id: capturedApprover,
        resolved_approver_user_id: authority.approver_user_id,
        captured_doa_entry_id: capturedDoaEntry,
        resolved_doa_entry_id: authority.doa_entry_id,
      },
      409,
    );
  }
  if (authority.approver_user_id !== envelope.metadata.actor.user_id) {
    reject(
      'APPROVAL_REQUIRED',
      'Actor is not the DOA-resolved approver for a witnessed-inspection waiver',
      {
        hold_point_id: holdPointId,
        resolved_approver_user_id: authority.approver_user_id,
        governing_role: authority.governing_role,
      },
      403,
    );
  }

  const closure = await closeHoldPointAndRelease(envelope, client, eventId, {
    holdPointId,
    status: 'waived',
    releaseReason: `Witnessed inspection waived: ${waiverReason}`.slice(0, MAX_TEXT_2000),
    waiverDoaEntryId: capturedDoaEntry,
    waiverReason,
    beforeClose: (holdPoint) => {
      // BSD-8: the actor who raised the hold point cannot approve its own waiver. Reuses the
      // existing SOD_VIOLATION code - the QC surface already owns it (quality.ts:5242).
      if (holdPoint.raised_by === capturedApprover) {
        reject(
          'SOD_VIOLATION',
          'The actor who raised a witness hold point cannot approve its waiver',
          { hold_point_id: holdPointId, raised_by: holdPoint.raised_by },
          409,
        );
      }
    },
  });

  p['approved_by'] = capturedApprover;
  p['doa_entry_id'] = capturedDoaEntry;
  p['governing_role'] = authority.governing_role;
  p['delegation_applied'] = authority.delegation_applied;

  await emitNotificationInTransaction(
    {
      target: { role: WITNESS_NOTIFICATION_ROLE, location_id: closure.siteId },
      event_type: 'qc_witnessed_inspection_waived',
      status_verb: 'Witnessed inspection waived',
      object_type: 'qc_witness_hold_point',
      object_id: holdPointId,
      actor_label: `Lot ${closure.lotNumber} (${closure.sku})`,
      next_step: 'The lot is released from the witness hold point under a DOA-approved waiver',
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      causation_id: eventId,
      occurred_at: envelope.metadata.occurred_at,
    },
    client,
  );
}

export async function applyQcWitnessProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (qcWitnessEventType(envelope) === null) return;
  switch (envelope.event_type) {
    case WITNESS_HOLD_POINT_RAISED:
      return applyWitnessHoldPointRaised(envelope, client, eventId);
    case WITNESS_NOTICE_RECORDED:
      return applyWitnessNoticeRecorded(envelope, client, eventId);
    case WITNESSED_INSPECTION_SIGNED_OFF:
      return applyWitnessedInspectionSignedOff(envelope, client, eventId);
    case WITNESSED_INSPECTION_WAIVED:
      return applyWitnessedInspectionWaived(envelope, client, eventId);
    default:
      return;
  }
}
