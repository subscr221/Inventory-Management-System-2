import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { lockAssetById } from '../read/projections/asset.js';
import {
  getExaminationByAssetAndType,
  getExaminationByDeviceKey,
  getExaminationById,
  insertStatutoryExamination,
  setStatutoryExaminationStatus,
  updateStatutoryExamination,
} from '../read/projections/statutory_examination.js';
import {
  getRecordByCertificateNumber,
  insertStatutoryExaminationRecord,
} from '../read/projections/statutory_examination_record.js';

/**
 * Story 7.6 compliance seam for the statutory examination register (FR-M-14, AD-9, AD-12).
 * Structurally mirrors src/compliance/calibration-register.ts: a stream gate, a PURE
 * pre-transaction shape assert, an in-transaction projection switch, an alreadyPersisted guard and
 * the same reject() AppError helper, copied verbatim rather than re-derived.
 *
 * This file is NOT the lockout gate. src/compliance/weighbridge.ts gains
 * assertWeighbridgeStampLockout (called from persistEvent for weighbridge.recorded) and the
 * return-to-service handler enforces AC1; this seam applies the maintenance-stream register events.
 *
 * Locking contract: every applier that mutates more than one row takes FOR UPDATE in a FIXED
 * order - asset, then the statutory examination row, then the statutory examination record row -
 * so two concurrent commands on the same asset can never deadlock. The record applier locks the
 * examination row before deciding insert-versus-update; the overdue applier locks it before the
 * flip. A forged record that occupies the (asset_id, examination_type) grain would suppress the
 * genuine lockout, so every derivable field is re-derived under the lock and a disagreement
 * rejects STATUTORY_DERIVATION_MISMATCH (the Story 7.2 Group 2 decision, unchanged).
 *
 * Status contract (Table 2): (none) --record--> compliant; compliant --scan--> overdue;
 * overdue --record (re-stamp)--> compliant; compliant --weighbridge work-order completion--> overdue.
 * Recording an already-overdue examination (next_due_date < business_date) is rejected 422
 * EXAMINATION_ALREADY_OVERDUE; recording on an already-COMPLIANT grain is rejected 409
 * DUPLICATE_STATUTORY_EXAMINATION (a compliant stamp cannot be re-stamped until a work order or the
 * scan invalidates it). No applier silently no-ops on a state it should reject.
 */

const MAINTENANCE_STREAM_TYPES = new Set(['maintenance']);
const STATUTORY_EVENT_TYPES = new Set([
  'maintenance.statutory_examination_recorded',
  'maintenance.statutory_examination_overdue',
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
// An explicit UTC offset is REQUIRED (the Story 7.2 offset lesson).
const ISO8601_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const STATUTORY_EXAMINATION_TYPES = new Set(['osh_code', 'weighbridge_legal_metrology']);
export const STATUTORY_EXAMINATION_STATUSES = new Set(['compliant', 'overdue']);
export const MAX_EXAMINATION_INTERVAL_MONTHS = 120;
export const MAX_TEXT_LENGTH = 512;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_REGEX.test(value)) return false;
  // Round-trip check: reject impossible calendar dates (e.g. 2026-02-30) that Date.parse silently
  // normalizes (the Story 7.5 round-trip pattern).
  const [y, m, d] = value.split('-').map((part) => Number(part));
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO8601_TIMESTAMP_REGEX.test(value);
}

/** A bounded integer, REJECTED rather than coerced when it arrives as a string or a float. */
function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Canonical form of a human-entered device key / certificate number (the lower() unique indexes). */
export function canonicalDeviceKey(value: string): string {
  return value.trim().toLowerCase();
}

function optionalText(value: unknown, field: string, canonicalize: boolean): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    reject('INVALID_PAYLOAD', `${field} must be a non-blank string or null`);
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_TEXT_LENGTH) {
    reject('INVALID_PAYLOAD', `${field} must be at most ${MAX_TEXT_LENGTH} characters`);
  }
  return canonicalize ? trimmed.toLowerCase() : trimmed;
}

export function statutoryEventType(envelope: EventEnvelope): string | null {
  if (!MAINTENANCE_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!STATUTORY_EVENT_TYPES.has(envelope.event_type)) return null;
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

export function assertStatutoryExaminationShape(envelope: EventEnvelope): void {
  const type = statutoryEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  if (type === 'maintenance.statutory_examination_recorded') {
    assertRecordedShape(p);
    if (envelope.stream_id !== p['examination_id']) {
      reject('INVALID_PAYLOAD', 'stream_id must match the payload examination_id', {
        stream_id: envelope.stream_id,
        payload_examination_id: p['examination_id'],
      });
    }
  } else {
    assertOverdueShape(p);
    if (envelope.stream_id !== p['examination_id']) {
      reject('INVALID_PAYLOAD', 'stream_id must match the payload examination_id', {
        stream_id: envelope.stream_id,
        payload_examination_id: p['examination_id'],
      });
    }
  }
}

function assertRecordedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['examination_id'])) reject('INVALID_PAYLOAD', 'examination_id must be a UUID');
  if (!isUuid(p['asset_id'])) reject('INVALID_PAYLOAD', 'asset_id must be a UUID');
  if (
    typeof p['examination_type'] !== 'string' ||
    !STATUTORY_EXAMINATION_TYPES.has(p['examination_type'])
  ) {
    reject(
      'INVALID_EXAMINATION_TYPE',
      'examination_type must be osh_code or weighbridge_legal_metrology',
    );
  }
  if (!isBoundedInteger(p['interval_months'], 1, MAX_EXAMINATION_INTERVAL_MONTHS)) {
    reject(
      'INVALID_INTERVAL',
      `interval_months must be an integer between 1 and ${MAX_EXAMINATION_INTERVAL_MONTHS}`,
    );
  }
  if (!isIsoDate(p['examined_on'])) {
    reject('INVALID_PAYLOAD', 'examined_on must be a YYYY-MM-DD calendar date');
  }
  if (!isIsoDate(p['next_due_date'])) {
    reject('INVALID_PAYLOAD', 'next_due_date must be a YYYY-MM-DD calendar date');
  }
  optionalText(p['certificate_number_ext'], 'certificate_number_ext', true);
  const deviceKey = optionalText(p['device_key'], 'device_key', true);
  // device_key is the weighbridge lockout's identity mapping (Binding Decision 5) and nothing else.
  // uq_statutory_examination_device_key is not type-scoped, so an osh_code examination carrying a
  // device_key would both squat the index against the genuine stamp and, once overdue, block trade
  // weighment on a weighbridge whose legal-metrology stamp is perfectly valid.
  if (deviceKey !== null && p['examination_type'] !== 'weighbridge_legal_metrology') {
    reject(
      'INVALID_PAYLOAD',
      'device_key is only valid on a weighbridge_legal_metrology examination',
      {
        examination_type: p['examination_type'],
      },
    );
  }
  if (!isIsoDate(p['business_date'])) {
    reject('INVALID_PAYLOAD', 'business_date must be a YYYY-MM-DD calendar date');
  }
  if (!isIsoTimestamp(p['recorded_at'])) {
    reject('INVALID_PAYLOAD', 'recorded_at must be an ISO 8601 timestamp with an explicit offset');
  }
}

function assertOverdueShape(p: Record<string, unknown>): void {
  if (!isUuid(p['examination_id'])) reject('INVALID_PAYLOAD', 'examination_id must be a UUID');
  if (!isUuid(p['asset_id'])) reject('INVALID_PAYLOAD', 'asset_id must be a UUID');
  if (
    typeof p['examination_type'] !== 'string' ||
    !STATUTORY_EXAMINATION_TYPES.has(p['examination_type'])
  ) {
    reject(
      'INVALID_EXAMINATION_TYPE',
      'examination_type must be osh_code or weighbridge_legal_metrology',
    );
  }
  if (!isIsoDate(p['next_due_date'])) {
    reject('INVALID_PAYLOAD', 'next_due_date must be a YYYY-MM-DD calendar date');
  }
  if (!isIsoDate(p['business_date'])) {
    reject('INVALID_PAYLOAD', 'business_date must be a YYYY-MM-DD calendar date');
  }
  if (!isIsoTimestamp(p['flagged_at'])) {
    reject('INVALID_PAYLOAD', 'flagged_at must be an ISO 8601 timestamp with an explicit offset');
  }
}

// ---------------------------------------------------------------------------
// In-transaction appliers
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key?.trim() && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

/** Re-derives next_due_date = examined_on + interval_months in SQL DATE arithmetic. */
async function deriveNextDueDate(
  client: PoolClient,
  examinedOn: string,
  intervalMonths: number,
): Promise<string> {
  const result = await client.query(
    `SELECT ($1::date + make_interval(months => $2))::date::text AS next_due`,
    [examinedOn, intervalMonths],
  );
  return result.rows[0]!['next_due'] as string;
}

export async function applyStatutoryExaminationProjection(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  const type = statutoryEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'maintenance.statutory_examination_recorded':
      await applyStatutoryExaminationRecorded(envelope, client);
      break;
    case 'maintenance.statutory_examination_overdue':
      await applyStatutoryExaminationOverdue(envelope, client);
      break;
  }
}

async function applyStatutoryExaminationRecorded(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const examinationId = p['examination_id'] as string;
  const assetId = p['asset_id'] as string;
  const examinationType = p['examination_type'] as 'osh_code' | 'weighbridge_legal_metrology';
  const intervalMonths = p['interval_months'] as number;
  const examinedOn = p['examined_on'] as string;
  const declaredNextDueDate = p['next_due_date'] as string;
  const certificateNumberExt = optionalText(
    p['certificate_number_ext'],
    'certificate_number_ext',
    true,
  );
  const deviceKey = optionalText(p['device_key'], 'device_key', true);
  const businessDate = p['business_date'] as string;
  const recordedAt = p['recorded_at'] as string;

  // Lock order step 1: asset, FOR UPDATE. A statutory subject IS an asset (AD-9); registering an
  // examination for an asset the Story 7.1 register has never heard of would create a second asset
  // concept. The lock is what makes this applier serialize against a concurrent
  // applyWorkOrderCompleted stamp flip on the same asset - a plain SELECT locks nothing, and a
  // FOR UPDATE on the not-yet-existing examination row cannot serialize a first registration.
  const assetExists = await lockAssetById(assetId, client);
  if (!assetExists) {
    reject('ASSET_NOT_FOUND', 'The asset does not resolve', { asset_id: assetId }, 404);
  }

  // Re-derive next_due_date in SQL. A forged event pushing the due date out is the exact corruption
  // channel that would suppress the genuine lockout, so the declared value is checked, never trusted.
  const derivedNextDueDate = await deriveNextDueDate(client, examinedOn, intervalMonths);
  if (derivedNextDueDate !== declaredNextDueDate) {
    reject(
      'STATUTORY_DERIVATION_MISMATCH',
      'Declared next_due_date does not match examined_on + interval_months',
      {
        examination_id: examinationId,
        declared_next_due_date: declaredNextDueDate,
        derived_next_due_date: derivedNextDueDate,
      },
      409,
    );
  }

  // Fail-closed registration (Task 4.7 / AC 1): an examination whose next due date has already
  // passed is rejected, never silently accepted - accepting it would leave the asset usable while
  // every gate still blocks it.
  if (declaredNextDueDate < businessDate) {
    reject(
      'EXAMINATION_ALREADY_OVERDUE',
      'The examination would already be overdue at this business date',
      {
        examination_id: examinationId,
        next_due_date: declaredNextDueDate,
        business_date: businessDate,
      },
      422,
    );
  }
  // A certificate-style record cannot be dated in the future - there is no such thing as an
  // examination performed after the business date it is being recorded against.
  if (examinedOn > businessDate) {
    reject(
      'EXAMINATION_FUTURE_DATE',
      'examined_on must not be after business_date',
      { examination_id: examinationId, examined_on: examinedOn, business_date: businessDate },
      422,
    );
  }

  // The canonicalized device_key and certificate_number_ext are written back onto the persisted
  // payload, not only used for the projection writes: the Compliance Seam Contract requires the
  // lower() canonicalization BEFORE persisting, in the handler AND in the seam, so the direct-event
  // path cannot store a mixed-case value that disagrees with the projection it just wrote.
  p['certificate_number_ext'] = certificateNumberExt;
  p['device_key'] = deviceKey;

  // Lock order step 2: the statutory examination row for the (asset_id, examination_type) grain.
  const existing = await getExaminationByAssetAndType(assetId, examinationType, client, true);
  if (existing) {
    // A COMPLIANT grain cannot be re-stamped: the stamp is valid until a work order or the scan
    // invalidates it, so a second record is a duplicate (Table 2). An OVERDUE grain IS the
    // re-stamp path: it transitions overdue -> compliant and unlocks the asset (Table 2).
    if (existing.status === 'compliant') {
      reject(
        'DUPLICATE_STATUTORY_EXAMINATION',
        'A compliant statutory examination already exists for this asset and type',
        {
          asset_id: assetId,
          examination_type: examinationType,
          existing_examination_id: existing.examination_id,
        },
        409,
      );
    }
    // The device mapping is the register row's IDENTITY, not per-certificate data: a re-stamp that
    // simply omits device_key must not NULL it, or the AC2 weighbridge lockout fails open forever
    // for that device (getExaminationByDeviceKey would never resolve it again).
    await updateStatutoryExamination(
      existing.examination_id,
      {
        examination_type: examinationType,
        interval_months: intervalMonths,
        next_due_date: declaredNextDueDate,
        status: 'compliant',
        device_key: deviceKey ?? existing.device_key,
      },
      client,
    );
  } else {
    await insertStatutoryExamination(
      {
        examination_id: examinationId,
        asset_id: assetId,
        examination_type: examinationType,
        interval_months: intervalMonths,
        next_due_date: declaredNextDueDate,
        device_key: deviceKey,
      },
      client,
    );
  }

  // Lock order step 3: the record row. Every examination event gets its own evidence row; the
  // register row carries only the current state. The record id is server-minted (the payload does
  // not declare it), so the insert cannot collide with a concurrent one.
  //
  // The record hangs off the REGISTER ROW's examination_id, not the payload's. A re-stamp arrives
  // with a freshly minted examination_id (the handler mints one per POST and stream_id must equal
  // it), while the register row keeps the id it was first registered under. Using the payload id
  // here would orphan the evidence row, hide the re-stamp from listRecordsByExamination, and defeat
  // uq_statutory_examination_record_number, whose grain is (examination_id, certificate number).
  const registerExaminationId = existing ? existing.examination_id : examinationId;
  const recordId = randomUUID();
  await insertStatutoryExaminationRecord(
    {
      record_id: recordId,
      examination_id: registerExaminationId,
      examined_on: examinedOn,
      next_due_date: declaredNextDueDate,
      certificate_number_ext: certificateNumberExt,
      examined_by: envelope.metadata.actor.user_id,
      examined_at: recordedAt,
    },
    client,
  );
}

async function applyStatutoryExaminationOverdue(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const examinationId = p['examination_id'] as string;
  const declaredAssetId = p['asset_id'] as string;
  const declaredType = p['examination_type'] as 'osh_code' | 'weighbridge_legal_metrology';
  const declaredNextDueDate = p['next_due_date'] as string;
  const businessDate = p['business_date'] as string;
  const flaggedAt = p['flagged_at'] as string;

  // Lock the examination row under FOR UPDATE for the duration of its grain, so two concurrent
  // scans serialize into one overdue flip (the Story 7.5 breach-scan pattern).
  const examination = await getExaminationById(examinationId, client, true);
  if (!examination) {
    reject(
      'EXAMINATION_NOT_FOUND',
      'The examination does not resolve',
      {
        examination_id: examinationId,
      },
      404,
    );
  }

  // Every declared derivable field is re-derived from the locked row, never trusted.
  if (examination.asset_id !== declaredAssetId) {
    reject(
      'STATUTORY_DERIVATION_MISMATCH',
      'Declared asset_id does not match the examination',
      {
        examination_id: examinationId,
        declared_asset_id: declaredAssetId,
        derived_asset_id: examination.asset_id,
      },
      409,
    );
  }
  if (examination.examination_type !== declaredType) {
    reject(
      'STATUTORY_DERIVATION_MISMATCH',
      'Declared examination_type does not match the examination',
      {
        examination_id: examinationId,
        declared_examination_type: declaredType,
        derived_examination_type: examination.examination_type,
      },
      409,
    );
  }
  if (examination.next_due_date !== declaredNextDueDate) {
    reject(
      'STATUTORY_DERIVATION_MISMATCH',
      'Declared next_due_date does not match the examination',
      {
        examination_id: examinationId,
        declared_next_due_date: declaredNextDueDate,
        derived_next_due_date: examination.next_due_date,
      },
      409,
    );
  }
  // The overdue flip is only reachable from a compliant row and only when the due date has
  // actually passed at business_date. An already-overdue row is the lost race: reject with the
  // stable DUPLICATE_STATUTORY_EXAMINATION_OVERDUE so the scan can skip it (never fail the run).
  if (examination.status === 'overdue') {
    reject(
      'DUPLICATE_STATUTORY_EXAMINATION_OVERDUE',
      'This examination is already overdue',
      { examination_id: examinationId, status: examination.status },
      409,
    );
  }
  if (businessDate <= examination.next_due_date) {
    reject(
      'STATUTORY_DERIVATION_MISMATCH',
      'The examination is not yet due at this business date',
      {
        examination_id: examinationId,
        next_due_date: examination.next_due_date,
        business_date: businessDate,
      },
      409,
    );
  }

  await setStatutoryExaminationStatus(examinationId, 'overdue', client);
  // flagged_at is an instant, carried for audit; the applier writes nothing else derivable here.
  void flaggedAt;
}

// ---------------------------------------------------------------------------
// 23505 duplicate resolvers
// ---------------------------------------------------------------------------

/**
 * The race path and the sequential path must return the SAME error code with the SAME existing_*
 * detail (the Story 7.2 lesson). Each resolver re-reads the winning row so a caller that lost a
 * concurrent race is told exactly what a caller that arrived second sequentially is told.
 */
export async function resolveStatutoryExaminationDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const assetId = isUuid(payload['asset_id']) ? (payload['asset_id'] as string) : null;
  const examinationType =
    typeof payload['examination_type'] === 'string'
      ? (payload['examination_type'] as string)
      : null;
  const attempted: Record<string, unknown> = {
    asset_id: assetId,
    examination_type: examinationType,
  };
  if (assetId !== null && examinationType !== null) {
    const existing = await getExaminationByAssetAndType(assetId, examinationType);
    if (existing) {
      return {
        ...attempted,
        existing_examination_id: existing.examination_id,
      };
    }
  }
  return attempted;
}

export async function resolveStatutoryDeviceKeyDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const deviceKey =
    typeof payload['device_key'] === 'string' && payload['device_key'].trim() !== ''
      ? canonicalDeviceKey(payload['device_key'])
      : null;
  const attempted: Record<string, unknown> = { device_key: deviceKey };
  if (deviceKey !== null) {
    const existing = await getExaminationByDeviceKey(deviceKey);
    if (existing) {
      return { ...attempted, existing_examination_id: existing.examination_id };
    }
  }
  return attempted;
}

export async function resolveStatutoryRecordDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // The record hangs off the REGISTER ROW's examination_id, not the payload's: on a re-stamp the
  // handler mints a fresh id while the register row keeps its original. Resolving with the payload
  // id would look up a grain no record was ever written under, so the caller that just lost to
  // uq_statutory_examination_record_number would be told nothing exists.
  const assetId = isUuid(payload['asset_id']) ? (payload['asset_id'] as string) : null;
  const examinationType =
    typeof payload['examination_type'] === 'string'
      ? (payload['examination_type'] as string)
      : null;
  const registerExamination =
    assetId !== null && examinationType !== null
      ? await getExaminationByAssetAndType(assetId, examinationType)
      : null;
  const examinationId =
    registerExamination?.examination_id ??
    (isUuid(payload['examination_id']) ? (payload['examination_id'] as string) : null);
  const certificateNumberExt =
    typeof payload['certificate_number_ext'] === 'string' &&
    payload['certificate_number_ext'].trim() !== ''
      ? canonicalDeviceKey(payload['certificate_number_ext'])
      : null;
  const attempted: Record<string, unknown> = {
    examination_id: examinationId,
    certificate_number_ext: certificateNumberExt,
  };
  if (examinationId !== null && certificateNumberExt !== null) {
    const existing = await getRecordByCertificateNumber(examinationId, certificateNumberExt);
    if (existing) {
      return { ...attempted, existing_record_id: existing.record_id };
    }
  }
  return attempted;
}
