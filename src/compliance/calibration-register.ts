import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { persistEvent } from '../events/store.js';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getAssetById } from '../read/projections/asset.js';
import { getLocationById } from '../read/projections/location_register.js';
import { findFirstActiveDoaEntry, findRoleHolder } from '../read/projections/doa_registry.js';
import {
  getInstrumentRecordByAssetId,
  getInstrumentRecordById,
  getInstrumentRecordByInstrumentId,
  insertInstrumentRecord,
} from '../read/projections/instrument_register.js';
import {
  getActiveCertificate,
  getCertificateById,
  getCertificateByNumber,
  insertCertificate,
  markCertificateExpired,
  supersedeActiveCertificate,
  type CalibrationType,
} from '../read/projections/instrument_calibration_certificate.js';
import {
  getCalibrationAlertForStage,
  insertCalibrationAlert,
} from '../read/projections/instrument_calibration_alert.js';
import {
  getEscalationById,
  getOpenEscalation,
  insertEscalation,
  resolveEscalation,
} from '../read/projections/instrument_calibration_escalation.js';
import {
  getInstrumentCalibrationStatus,
  setCalibrationStatusFromRegister,
} from '../read/projections/instrument_calibration.js';

/**
 * Story 7.5 compliance seam for the calibration register: instrument registration, in-house and
 * ISO 17025 certificates, the staged 30/14/7 expiry alerts, the expiry flip and the DOA-routed
 * escalation register (FR-M-12, FR-M-13, AD-8, AD-9). Structurally mirrors
 * src/compliance/maintenance-spares.ts.
 *
 * This file is NOT the lockout gate. src/compliance/calibration.ts is the Story 1.7 QC-stream gate
 * (assertCalibrationLockout, called from persistEvent for every qc.result_recorded) and must not be
 * renamed, extended with register logic, or have its export changed. Two files with adjacent names
 * is the correct outcome: one gates the QC stream, this one applies maintenance-stream register
 * events. There is exactly ONE lockout check in the platform and it stays where it is.
 *
 * Locking contract: every applier that mutates more than one row takes FOR UPDATE in a FIXED
 * order - asset, then the instrument register row, then certificate rows (active first, then the
 * incoming one), then the escalation row, then instrument_calibration_statuses - so two concurrent
 * commands on the same instrument can never deadlock. setCalibrationStatusFromRegister takes the
 * status row last and is therefore the FINAL database call in any applier that changes status.
 *
 * Status contract: no applier here writes instrument_calibration_statuses with raw SQL and none
 * calls ensureInstrumentCalibrationRow, whose 'calibrated' default would silently unlock every
 * newly registered instrument. Registration is FAIL CLOSED at out_of_calibration; only a recorded
 * certificate valid at business_date sets 'calibrated'; the escalation appliers have no status
 * write path at all, which is how AC 3 is guaranteed by construction rather than by review.
 */

const MAINTENANCE_STREAM_TYPES = new Set(['maintenance']);
const CALIBRATION_REGISTER_EVENT_TYPES = new Set([
  'maintenance.instrument_registered',
  'maintenance.calibration_certificate_recorded',
  'maintenance.calibration_expiry_flagged',
  'maintenance.calibration_expired',
  'maintenance.calibration_escalation_raised',
  'maintenance.calibration_escalation_resolved',
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
// An explicit UTC offset is REQUIRED: a naive timestamp is parsed by JS Date.parse in
// process-local time but cast by pg ::timestamptz in session time, so the stored instant would
// shift when the two differ (the 7.2 offset lesson).
const ISO8601_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const CALIBRATION_STAGES = [30, 14, 7] as const;
const CALIBRATION_STAGE_SET = new Set<number>(CALIBRATION_STAGES);
const CALIBRATION_TYPES = new Set(['in_house', 'iso_17025']);

export const MAX_INSTRUMENT_ID_LENGTH = 128;
export const MAX_CERTIFICATE_NUMBER_LENGTH = 128;
export const MAX_CALIBRATION_INTERVAL_DAYS = 3650;
const MAX_TEXT_LENGTH = 512;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_REGEX.test(value)) return false;
  // Round-trip check: reject impossible calendar dates (e.g. 2026-02-30) that Date.parse silently
  // normalizes. Without this, a forged date passes the pre-transaction shape assert and then dies as
  // an unmapped 22008 500 mid-transaction, or defeats the lexicographic CERTIFICATE_EXPIRED pre-check.
  // The regex guarantees exactly three zero-padded numeric parts, so the indexed reads are safe.
  const [y, m, d] = value.split('-').map((part) => Number(part));
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO8601_TIMESTAMP_REGEX.test(value)) return false;
  // Validate the date portion is a real calendar date (same round-trip check as isIsoDate).
  const datePart = value.slice(0, 10);
  const [y, m, d] = datePart.split('-').map((part) => Number(part));
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m! - 1 || dt.getUTCDate() !== d)
    return false;
  // Validate time components (rejects 25:00:00 etc. that Date.parse silently normalizes to next day).
  const timeMatch = value.match(/T(\d{2}):(\d{2}):(\d{2})/);
  if (!timeMatch) return false;
  const hh = Number(timeMatch[1]);
  const mm = Number(timeMatch[2]);
  const ss = Number(timeMatch[3]);
  return hh <= 23 && mm <= 59 && ss <= 59;
}

/**
 * A bounded integer, REJECTED rather than coerced when it arrives as a string or a float. The
 * Story 7.4 review found a wire boolean silently coerced into disabling a whole FR; the integers
 * here decide an alert horizon and an alert stage, so the same rule applies to them.
 */
function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Canonical form of a human-entered instrument id. Applied in the seam AND in the handler so the
 * direct POST /api/v1/events path cannot bypass it (the Story 7.2 scanned-versus-typed-key
 * lesson). A case variant of a registered instrument is the same physical instrument, and the
 * status row the lockout gate reads is keyed by this canonical form.
 */
export function canonicalInstrumentId(instrumentId: string): string {
  return instrumentId.trim().toLowerCase();
}

/** Canonical form of a human-entered certificate number, matching the lower() unique index. */
export function canonicalCertificateNumber(certificateNumber: string): string {
  return certificateNumber.trim().toLowerCase();
}

export function calibrationRegisterEventType(envelope: EventEnvelope): string | null {
  if (!MAINTENANCE_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!CALIBRATION_REGISTER_EVENT_TYPES.has(envelope.event_type)) return null;
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

export function assertCalibrationRegisterShape(envelope: EventEnvelope): void {
  const type = calibrationRegisterEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  switch (type) {
    case 'maintenance.instrument_registered':
      assertInstrumentRegisteredShape(p);
      break;
    case 'maintenance.calibration_certificate_recorded':
      assertCertificateRecordedShape(p);
      break;
    case 'maintenance.calibration_expiry_flagged':
      assertExpiryFlaggedShape(p);
      break;
    case 'maintenance.calibration_expired':
      assertCalibrationExpiredShape(p);
      break;
    case 'maintenance.calibration_escalation_raised':
      assertEscalationRaisedShape(p);
      break;
    case 'maintenance.calibration_escalation_resolved':
      assertEscalationResolvedShape(p);
      break;
  }

  // Cross-check stream_id against the payload id field. A forged direct event with a mismatched
  // stream_id would pollute readStream replay (the Story 7.2 derivation-match lesson applied to
  // the envelope's routing key).
  const STREAM_ID_FIELD: Record<string, string> = {
    'maintenance.instrument_registered': 'instrument_record_id',
    'maintenance.calibration_certificate_recorded': 'certificate_id',
    'maintenance.calibration_expiry_flagged': 'alert_id',
    'maintenance.calibration_expired': 'instrument_record_id',
    'maintenance.calibration_escalation_raised': 'escalation_id',
    'maintenance.calibration_escalation_resolved': 'escalation_id',
  };
  const expectedField = STREAM_ID_FIELD[type];
  if (
    expectedField &&
    typeof p[expectedField] === 'string' &&
    envelope.stream_id !== p[expectedField]
  ) {
    reject('INVALID_PAYLOAD', `stream_id must match the payload ${expectedField}`, {
      stream_id: envelope.stream_id,
      payload_id: p[expectedField],
    });
  }
}

function assertInstrumentIdShape(value: unknown): void {
  if (!isNonEmptyString(value) || value.trim().length > MAX_INSTRUMENT_ID_LENGTH) {
    reject(
      'INVALID_PAYLOAD',
      `instrument_id is required and must be at most ${MAX_INSTRUMENT_ID_LENGTH} characters`,
    );
  }
}

function assertInstrumentRegisteredShape(p: Record<string, unknown>): void {
  if (!isUuid(p['instrument_record_id'])) {
    reject('INVALID_PAYLOAD', 'instrument_record_id must be a UUID');
  }
  if (!isUuid(p['asset_id'])) reject('INVALID_PAYLOAD', 'asset_id must be a UUID');
  assertInstrumentIdShape(p['instrument_id']);
  if (!isUuid(p['location_id'])) reject('INVALID_PAYLOAD', 'location_id must be a UUID');
  // Bounded at load AND at the handler: an unbounded interval becomes an unmapped 22003/23514 500
  // instead of a stable 400, and mirrors chk_instrument_register_interval.
  if (!isBoundedInteger(p['calibration_interval_days'], 1, MAX_CALIBRATION_INTERVAL_DAYS)) {
    reject(
      'INVALID_PAYLOAD',
      `calibration_interval_days must be an integer between 1 and ${MAX_CALIBRATION_INTERVAL_DAYS}`,
    );
  }
  if (!isIsoTimestamp(p['registered_at'])) {
    reject(
      'INVALID_PAYLOAD',
      'registered_at must be an ISO 8601 timestamp with an explicit offset',
    );
  }
}

function assertCertificateRecordedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['certificate_id'])) reject('INVALID_PAYLOAD', 'certificate_id must be a UUID');
  if (!isUuid(p['instrument_record_id'])) {
    reject('INVALID_PAYLOAD', 'instrument_record_id must be a UUID');
  }
  assertInstrumentIdShape(p['instrument_id']);

  const calibrationType = p['calibration_type'];
  if (typeof calibrationType !== 'string' || !CALIBRATION_TYPES.has(calibrationType)) {
    reject('INVALID_CALIBRATION_TYPE', 'calibration_type must be in_house or iso_17025');
  }
  const issuingLab = p['issuing_lab'];
  if (
    issuingLab !== null &&
    (!isNonEmptyString(issuingLab) || issuingLab.length > MAX_TEXT_LENGTH)
  ) {
    reject('INVALID_CALIBRATION_TYPE', 'issuing_lab must be a non-blank string or null');
  }
  // Mirrors chk_instrument_calibration_certificate_iso_lab: an ISO 17025 certificate with no
  // issuing laboratory is not traceable to an accredited body, which is the whole point of the
  // distinction FR-M-12 draws between the two certificate types.
  if (calibrationType === 'iso_17025' && issuingLab === null) {
    reject('INVALID_CALIBRATION_TYPE', 'an iso_17025 certificate requires an issuing_lab');
  }

  if (
    !isNonEmptyString(p['certificate_number']) ||
    (p['certificate_number'] as string).trim().length > MAX_CERTIFICATE_NUMBER_LENGTH
  ) {
    reject(
      'INVALID_PAYLOAD',
      `certificate_number is required and must be at most ${MAX_CERTIFICATE_NUMBER_LENGTH} characters`,
    );
  }

  if (!isIsoDate(p['calibrated_on'])) {
    reject('INVALID_CERTIFICATE_VALIDITY', 'calibrated_on must be a YYYY-MM-DD calendar date');
  }
  if (!isIsoDate(p['valid_until'])) {
    reject('INVALID_CERTIFICATE_VALIDITY', 'valid_until must be a YYYY-MM-DD calendar date');
  }
  // Lexicographic comparison is exact for zero-padded YYYY-MM-DD and needs no Date parsing; it
  // mirrors chk_instrument_calibration_certificate_validity so the pre-transaction reject and the
  // column constraint can never disagree.
  if ((p['valid_until'] as string) < (p['calibrated_on'] as string)) {
    reject('INVALID_CERTIFICATE_VALIDITY', 'valid_until must not precede calibrated_on', {
      calibrated_on: p['calibrated_on'],
      valid_until: p['valid_until'],
    });
  }
  if (!isIsoDate(p['business_date'])) {
    reject('INVALID_PAYLOAD', 'business_date must be a YYYY-MM-DD calendar date');
  }
  if (!isIsoTimestamp(p['recorded_at'])) {
    reject('INVALID_PAYLOAD', 'recorded_at must be an ISO 8601 timestamp with an explicit offset');
  }
}

function assertExpiryFlaggedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['alert_id'])) reject('INVALID_PAYLOAD', 'alert_id must be a UUID');
  if (!isUuid(p['certificate_id'])) reject('INVALID_PAYLOAD', 'certificate_id must be a UUID');
  if (!isUuid(p['instrument_record_id'])) {
    reject('INVALID_PAYLOAD', 'instrument_record_id must be a UUID');
  }
  if (
    !isBoundedInteger(p['stage_days'], 1, MAX_CALIBRATION_INTERVAL_DAYS) ||
    !CALIBRATION_STAGE_SET.has(p['stage_days'] as number)
  ) {
    reject('INVALID_PAYLOAD', 'stage_days must be one of: 30, 14, 7');
  }
  if (!isIsoDate(p['valid_until'])) {
    reject('INVALID_PAYLOAD', 'valid_until must be a YYYY-MM-DD calendar date');
  }
  if (!isIsoDate(p['business_date'])) {
    reject('INVALID_PAYLOAD', 'business_date must be a YYYY-MM-DD calendar date');
  }
  if (!isIsoTimestamp(p['flagged_at'])) {
    reject('INVALID_PAYLOAD', 'flagged_at must be an ISO 8601 timestamp with an explicit offset');
  }
}

function assertCalibrationExpiredShape(p: Record<string, unknown>): void {
  if (!isUuid(p['instrument_record_id'])) {
    reject('INVALID_PAYLOAD', 'instrument_record_id must be a UUID');
  }
  assertInstrumentIdShape(p['instrument_id']);
  if (!isUuid(p['certificate_id'])) reject('INVALID_PAYLOAD', 'certificate_id must be a UUID');
  if (!isIsoDate(p['valid_until'])) {
    reject('INVALID_PAYLOAD', 'valid_until must be a YYYY-MM-DD calendar date');
  }
  if (!isIsoDate(p['business_date'])) {
    reject('INVALID_PAYLOAD', 'business_date must be a YYYY-MM-DD calendar date');
  }
  if (!isIsoTimestamp(p['expired_at'])) {
    reject('INVALID_PAYLOAD', 'expired_at must be an ISO 8601 timestamp with an explicit offset');
  }
}

function assertEscalationRaisedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['escalation_id'])) reject('INVALID_PAYLOAD', 'escalation_id must be a UUID');
  if (!isUuid(p['instrument_record_id'])) {
    reject('INVALID_PAYLOAD', 'instrument_record_id must be a UUID');
  }
  assertInstrumentIdShape(p['instrument_id']);
  if (!isUuid(p['doa_entry_id'])) reject('INVALID_PAYLOAD', 'doa_entry_id must be a UUID');
  if (!isUuid(p['routed_approver_user_id'])) {
    reject('INVALID_PAYLOAD', 'routed_approver_user_id must be a UUID');
  }
  const reason = p['reason'];
  if (reason !== null && (!isNonEmptyString(reason) || reason.length > MAX_TEXT_LENGTH)) {
    reject('INVALID_PAYLOAD', 'reason must be a non-blank string or null');
  }
  if (!isIsoTimestamp(p['raised_at'])) {
    reject('INVALID_PAYLOAD', 'raised_at must be an ISO 8601 timestamp with an explicit offset');
  }
}

function assertEscalationResolvedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['escalation_id'])) reject('INVALID_PAYLOAD', 'escalation_id must be a UUID');
  if (!isUuid(p['resolving_certificate_id'])) {
    reject('INVALID_PAYLOAD', 'resolving_certificate_id must be a UUID');
  }
  if (!isIsoTimestamp(p['resolved_at'])) {
    reject('INVALID_PAYLOAD', 'resolved_at must be an ISO 8601 timestamp with an explicit offset');
  }
}

// ---------------------------------------------------------------------------
// In-transaction appliers
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  // Treat whitespace-only idempotency_key as absent (a blank key is not a real dedup key).
  // The handlers normalize blank/non-string keys to randomUUID(), but the direct-event path can
  // send a raw whitespace key; treating it as absent prevents two distinct events with '   ' from
  // colliding on the same dedup row.
  if (!envelope.idempotency_key?.trim() && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

/**
 * Whole-day difference between two calendar dates, evaluated in SQL DATE arithmetic rather than in
 * JS. The Staged Alert Contract requires it: JS date maths on a calendar field is where this repo's
 * documented clock-window defect family comes from, and here the arithmetic decides whether an
 * instrument is warned or locked out.
 */
async function daysBetween(
  client: PoolClient,
  laterDate: string,
  earlierDate: string,
): Promise<number> {
  const result = await client.query(`SELECT ($1::date - $2::date)::int AS days`, [
    laterDate,
    earlierDate,
  ]);
  return result.rows[0]!['days'] as number;
}

export async function applyCalibrationRegisterProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = calibrationRegisterEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'maintenance.instrument_registered':
      await applyInstrumentRegistered(envelope, client, eventId);
      break;
    case 'maintenance.calibration_certificate_recorded':
      await applyCertificateRecorded(envelope, client, eventId);
      break;
    case 'maintenance.calibration_expiry_flagged':
      await applyExpiryFlagged(envelope, client);
      break;
    case 'maintenance.calibration_expired':
      await applyCalibrationExpired(envelope, client, eventId);
      break;
    case 'maintenance.calibration_escalation_raised':
      await applyEscalationRaised(envelope, client);
      break;
    case 'maintenance.calibration_escalation_resolved':
      await applyEscalationResolved(envelope, client);
      break;
  }
}

async function applyInstrumentRegistered(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const instrumentRecordId = p['instrument_record_id'] as string;
  const assetId = p['asset_id'] as string;
  const instrumentId = canonicalInstrumentId(p['instrument_id'] as string);
  const locationId = p['location_id'] as string;

  // Lock order step 1: asset. An instrument IS an asset (AD-9); registering one the Story 7.1
  // register has never heard of would create a second asset concept by the back door.
  const asset = await getAssetById(assetId, client);
  if (!asset) {
    reject('ASSET_NOT_FOUND', 'The asset does not resolve', { asset_id: assetId }, 404);
  }

  const location = await getLocationById(locationId, client);
  if (!location) {
    reject('LOCATION_NOT_FOUND', 'The location does not resolve', { location_id: locationId }, 404);
  }

  // Lock order step 2: the register rows. FOR UPDATE so two concurrent registrations resolve to one
  // winner; the loser sees the committed row here and rejects with the same stable code and the
  // same existing_* detail the 23505 resolver produces.
  const existingByInstrument = await getInstrumentRecordByInstrumentId(instrumentId, client, true);
  if (existingByInstrument) {
    reject(
      'INSTRUMENT_ALREADY_REGISTERED',
      'An instrument is already registered under this instrument id',
      {
        instrument_id: instrumentId,
        existing_instrument_record_id: existingByInstrument.instrument_record_id,
      },
      409,
    );
  }
  const existingByAsset = await getInstrumentRecordByAssetId(assetId, client, true);
  if (existingByAsset) {
    reject(
      'ASSET_ALREADY_INSTRUMENT',
      'This asset already has an instrument record',
      { asset_id: assetId, existing_instrument_record_id: existingByAsset.instrument_record_id },
      409,
    );
  }

  await insertInstrumentRecord(
    {
      instrument_record_id: instrumentRecordId,
      asset_id: assetId,
      instrument_id: instrumentId,
      location_id: locationId,
      calibration_interval_days: p['calibration_interval_days'] as number,
      registered_by: envelope.metadata.actor.user_id,
      registered_at: p['registered_at'] as string,
    },
    client,
  );

  // FAIL CLOSED, and the LAST database call in this applier per the Locking Contract. Deliberately
  // NOT ensureInstrumentCalibrationRow: its 'calibrated' default would make every newly registered
  // instrument immediately usable for measurement, which is the exact defect AD-8 exists to
  // prevent. An instrument with no certificate is out of calibration.
  await setCalibrationStatusFromRegister(
    {
      instrument_id: instrumentId,
      calibration_status: 'out_of_calibration',
      status_event_id: eventId,
      status_event_version: null,
      status_changed_by: envelope.metadata.actor.user_id,
      reason: 'Instrument registered; no calibration certificate recorded yet',
    },
    client,
  );
}

async function applyCertificateRecorded(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const certificateId = p['certificate_id'] as string;
  const instrumentRecordId = p['instrument_record_id'] as string;
  const declaredInstrumentId = canonicalInstrumentId(p['instrument_id'] as string);
  const certificateNumber = canonicalCertificateNumber(p['certificate_number'] as string);
  const validUntil = p['valid_until'] as string;
  const businessDate = p['business_date'] as string;
  const recordedAt = p['recorded_at'] as string;

  // Lock order step 2: the instrument register row.
  const record = await getInstrumentRecordById(instrumentRecordId, client, true);
  if (!record) {
    reject(
      'INSTRUMENT_NOT_FOUND',
      'The instrument record does not resolve',
      { instrument_record_id: instrumentRecordId },
      404,
    );
  }
  // instrument_id is DECLARED in the payload and CHECKED against the locked register row, never
  // trusted. This is the payload that can UNLOCK an instrument, so a divergence between the id the
  // caller names and the id the register holds must not silently write status for either one.
  if (record.instrument_id !== declaredInstrumentId) {
    reject(
      'CALIBRATION_DERIVATION_MISMATCH',
      'Declared instrument_id does not match the registered instrument',
      {
        instrument_record_id: instrumentRecordId,
        declared_instrument_id: declaredInstrumentId,
        derived_instrument_id: record.instrument_id,
      },
      409,
    );
  }

  // An already-expired certificate cannot reinstate calibration. Accepting it would leave the
  // operator believing the instrument is usable while the gate still blocks every measurement.
  if (validUntil < businessDate) {
    reject(
      'CERTIFICATE_EXPIRED',
      'The certificate validity has already lapsed at this business date',
      { certificate_id: certificateId, valid_until: validUntil, business_date: businessDate },
      422,
    );
  }

  // Lock order step 3: certificate rows - the active one FIRST, then the incoming one by number.
  // This honors the Locking Contract's stated order ("active first, then the incoming one") and
  // matches the order applyEscalationResolved now takes (certificate rows before the escalation row).
  const active = await getActiveCertificate(instrumentRecordId, client, true);
  const duplicate = await getCertificateByNumber(
    instrumentRecordId,
    certificateNumber,
    client,
    true,
  );
  if (duplicate) {
    reject(
      'CERTIFICATE_ALREADY_RECORDED',
      'A certificate with this number is already recorded for this instrument',
      {
        instrument_record_id: instrumentRecordId,
        certificate_number: certificateNumber,
        existing_certificate_id: duplicate.certificate_id,
      },
      409,
    );
  }

  if (active) {
    // Supersession happens in the SAME transaction as the insert, so the partial unique index
    // uq_instrument_calibration_certificate_active is never transiently violated and the
    // instrument is never momentarily without an active certificate.
    await supersedeActiveCertificate(instrumentRecordId, recordedAt, client);
  }

  await insertCertificate(
    {
      certificate_id: certificateId,
      instrument_record_id: instrumentRecordId,
      instrument_id: record.instrument_id,
      calibration_type: p['calibration_type'] as CalibrationType,
      certificate_number: certificateNumber,
      issuing_lab: (p['issuing_lab'] as string | null) ?? null,
      calibrated_on: p['calibrated_on'] as string,
      valid_until: validUntil,
      recorded_by: envelope.metadata.actor.user_id,
      recorded_at: recordedAt,
    },
    client,
  );

  // Lock order step 4: the escalation row. A re-calibration closes the escalation it was raised to
  // expedite, and it does so through the event ledger rather than a silent row update, so the
  // closure is auditable. The resolve applier has no status effect, so this stays ahead of the
  // status write below.
  const openEscalation = await getOpenEscalation(instrumentRecordId, client, true);
  if (openEscalation) {
    await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: openEscalation.escalation_id,
        event_type: 'maintenance.calibration_escalation_resolved',
        payload: {
          escalation_id: openEscalation.escalation_id,
          resolving_certificate_id: certificateId,
          resolved_at: recordedAt,
        },
        metadata: {
          correlation_id: envelope.metadata.correlation_id ?? randomUUID(),
          causation_id: eventId,
          actor: envelope.metadata.actor,
          occurred_at: recordedAt,
        },
      },
      undefined,
      client,
    );
  }

  // Lock order step 5, and the LAST database call: certificate validity is the ONLY source of
  // calibrated status for a registered instrument, and it has just been established for
  // business_date by the checks above.
  await setCalibrationStatusFromRegister(
    {
      instrument_id: record.instrument_id,
      calibration_status: 'calibrated',
      status_event_id: eventId,
      status_event_version: null,
      status_changed_by: envelope.metadata.actor.user_id,
      reason: `Calibration certificate ${certificateNumber} valid until ${validUntil}`,
    },
    client,
  );
}

async function applyExpiryFlagged(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const alertId = p['alert_id'] as string;
  const certificateId = p['certificate_id'] as string;
  const instrumentRecordId = p['instrument_record_id'] as string;
  const stageDays = p['stage_days'] as number;
  const declaredValidUntil = p['valid_until'] as string;
  const businessDate = p['business_date'] as string;

  // Grain guard: one alert per (certificate_id, stage_days), ever.
  // uq_instrument_calibration_alert_stage is the concurrency backstop behind it.
  const existing = await getCalibrationAlertForStage(certificateId, stageDays, client);
  if (existing) {
    reject(
      'DUPLICATE_CALIBRATION_ALERT',
      'This certificate has already been flagged at this stage',
      {
        certificate_id: certificateId,
        stage_days: stageDays,
        existing_alert_id: existing.alert_id,
      },
      409,
    );
  }

  // Re-derive every derivable field under the certificate's lock. A forged alert occupying the
  // (certificate_id, stage_days) grain would permanently suppress the genuine warning for that
  // stage - there is no second chance, because the grain is once-per-stage, not once-per-day.
  const certificate = await getCertificateById(certificateId, client, true);
  if (!certificate || certificate.status !== 'active') {
    reject(
      'CALIBRATION_DERIVATION_MISMATCH',
      'No active certificate exists for this alert',
      { certificate_id: certificateId, status: certificate?.status ?? null },
      409,
    );
  }
  if (certificate.instrument_record_id !== instrumentRecordId) {
    reject(
      'CALIBRATION_DERIVATION_MISMATCH',
      'Declared instrument_record_id does not match the certificate',
      {
        certificate_id: certificateId,
        declared_instrument_record_id: instrumentRecordId,
        derived_instrument_record_id: certificate.instrument_record_id,
      },
      409,
    );
  }
  if (certificate.valid_until !== declaredValidUntil) {
    reject(
      'CALIBRATION_DERIVATION_MISMATCH',
      'Declared valid_until does not match the certificate',
      {
        certificate_id: certificateId,
        declared_valid_until: declaredValidUntil,
        derived_valid_until: certificate.valid_until,
      },
      409,
    );
  }

  const daysRemaining = await daysBetween(client, certificate.valid_until, businessDate);
  if (daysRemaining < 0 || daysRemaining > stageDays) {
    reject(
      'CALIBRATION_DERIVATION_MISMATCH',
      'This stage is not due for this certificate at this business date',
      {
        certificate_id: certificateId,
        stage_days: stageDays,
        days_remaining: daysRemaining,
        business_date: businessDate,
      },
      409,
    );
  }

  await insertCalibrationAlert(
    {
      alert_id: alertId,
      certificate_id: certificateId,
      instrument_record_id: certificate.instrument_record_id,
      stage_days: stageDays,
      valid_until: certificate.valid_until,
      business_date: businessDate,
      flagged_at: p['flagged_at'] as string,
    },
    client,
  );
}

async function applyCalibrationExpired(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const instrumentRecordId = p['instrument_record_id'] as string;
  const declaredInstrumentId = canonicalInstrumentId(p['instrument_id'] as string);
  const certificateId = p['certificate_id'] as string;
  const declaredValidUntil = p['valid_until'] as string;
  const businessDate = p['business_date'] as string;
  const expiredAt = p['expired_at'] as string;

  const record = await getInstrumentRecordById(instrumentRecordId, client, true);
  if (!record) {
    reject(
      'INSTRUMENT_NOT_FOUND',
      'The instrument record does not resolve',
      { instrument_record_id: instrumentRecordId },
      404,
    );
  }
  if (record.instrument_id !== declaredInstrumentId) {
    reject(
      'CALIBRATION_DERIVATION_MISMATCH',
      'Declared instrument_id does not match the registered instrument',
      {
        instrument_record_id: instrumentRecordId,
        declared_instrument_id: declaredInstrumentId,
        derived_instrument_id: record.instrument_id,
      },
      409,
    );
  }

  const certificate = await getCertificateById(certificateId, client, true);
  if (
    !certificate ||
    certificate.status !== 'active' ||
    certificate.instrument_record_id !== instrumentRecordId
  ) {
    reject(
      'CALIBRATION_DERIVATION_MISMATCH',
      'No active certificate for this instrument matches the expiry',
      {
        certificate_id: certificateId,
        instrument_record_id: instrumentRecordId,
        status: certificate?.status ?? null,
      },
      409,
    );
  }
  if (certificate.valid_until !== declaredValidUntil) {
    reject(
      'CALIBRATION_DERIVATION_MISMATCH',
      'Declared valid_until does not match the certificate',
      {
        certificate_id: certificateId,
        declared_valid_until: declaredValidUntil,
        derived_valid_until: certificate.valid_until,
      },
      409,
    );
  }
  // Re-evaluate the expiry itself in SQL. Without this, a forged event could expire - and so lock
  // out - an instrument whose certificate is still perfectly valid.
  const daysRemaining = await daysBetween(client, certificate.valid_until, businessDate);
  if (daysRemaining >= 0) {
    reject(
      'CALIBRATION_DERIVATION_MISMATCH',
      'The certificate is still valid at this business date',
      {
        certificate_id: certificateId,
        valid_until: certificate.valid_until,
        business_date: businessDate,
      },
      409,
    );
  }

  const expired = await markCertificateExpired(certificateId, expiredAt, client);
  if (!expired) {
    reject(
      'CALIBRATION_DERIVATION_MISMATCH',
      'The certificate is no longer active',
      { certificate_id: certificateId },
      409,
    );
  }

  // LAST database call per the Locking Contract. This is the write that locks the instrument out
  // for measurement; the Story 1.7 gate reads it on every qc.result_recorded.
  await setCalibrationStatusFromRegister(
    {
      instrument_id: record.instrument_id,
      calibration_status: 'out_of_calibration',
      status_event_id: eventId,
      status_event_version: null,
      status_changed_by: envelope.metadata.actor.user_id,
      reason: `Calibration certificate expired on ${certificate.valid_until}`,
    },
    client,
  );
}

/**
 * AC 3, guaranteed by construction: this applier inserts one open escalation row and does nothing
 * else. It must not touch instrument_calibration_statuses, must not write a certificate, and must
 * not set any expiry field - an escalation expedites re-calibration, it never bypasses the lockout.
 */
async function applyEscalationRaised(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const escalationId = p['escalation_id'] as string;
  const instrumentRecordId = p['instrument_record_id'] as string;
  const declaredInstrumentId = canonicalInstrumentId(p['instrument_id'] as string);

  const record = await getInstrumentRecordById(instrumentRecordId, client, true);
  if (!record) {
    reject(
      'INSTRUMENT_NOT_FOUND',
      'The instrument record does not resolve',
      { instrument_record_id: instrumentRecordId },
      404,
    );
  }
  if (record.instrument_id !== declaredInstrumentId) {
    reject(
      'CALIBRATION_DERIVATION_MISMATCH',
      'Declared instrument_id does not match the registered instrument',
      {
        instrument_record_id: instrumentRecordId,
        declared_instrument_id: declaredInstrumentId,
        derived_instrument_id: record.instrument_id,
      },
      409,
    );
  }

  // The Story 1.7 precondition, unchanged: escalation requires an out-of-calibration instrument.
  // Read, never written, from this path.
  const status = await getInstrumentCalibrationStatus(record.instrument_id, client);
  if (!status || status.calibration_status !== 'out_of_calibration') {
    reject(
      'INVALID_PARAMS',
      'calibration escalation requires an out-of-calibration instrument',
      {
        instrument_record_id: instrumentRecordId,
        calibration_status: status?.calibration_status ?? null,
      },
      400,
    );
  }

  const open = await getOpenEscalation(instrumentRecordId, client, true);
  if (open) {
    reject(
      'ESCALATION_ALREADY_OPEN',
      'An escalation is already open for this instrument',
      { instrument_record_id: instrumentRecordId, existing_escalation_id: open.escalation_id },
      409,
    );
  }

  // The DOA route is re-derived, never trusted: routing a lockout escalation to an approver the
  // registry does not name is exactly the kind of forged authority AD-8 forbids.
  const entry = await findFirstActiveDoaEntry('calibration.escalation', client);
  if (!entry) {
    reject('NO_DOA_ENTRY_MATCH', 'No DOA entry governs calibration.escalation', {}, 404);
  }
  const approver = await findRoleHolder(entry.role, client);
  if (!approver) {
    reject(
      'NO_APPROVER_FOUND',
      `No active user holds role "${entry.role}"`,
      { role: entry.role },
      404,
    );
  }
  if (p['doa_entry_id'] !== entry.entry_id) {
    reject(
      'CALIBRATION_DERIVATION_MISMATCH',
      'Declared doa_entry_id does not match the governing DOA entry',
      { declared_doa_entry_id: p['doa_entry_id'], derived_doa_entry_id: entry.entry_id },
      409,
    );
  }
  if (p['routed_approver_user_id'] !== approver.user_id) {
    reject(
      'CALIBRATION_DERIVATION_MISMATCH',
      'Declared routed_approver_user_id does not match the resolved role holder',
      {
        declared_routed_approver_user_id: p['routed_approver_user_id'],
        derived_routed_approver_user_id: approver.user_id,
      },
      409,
    );
  }

  await insertEscalation(
    {
      escalation_id: escalationId,
      instrument_record_id: instrumentRecordId,
      instrument_id: record.instrument_id,
      doa_entry_id: entry.entry_id,
      routed_approver_user_id: approver.user_id,
      reason: (p['reason'] as string | null) ?? null,
      raised_by: envelope.metadata.actor.user_id,
      raised_at: p['raised_at'] as string,
    },
    client,
  );
}

/**
 * Closes an open escalation against an ACTIVE certificate. Like the raise, it has NO calibration
 * status effect: the certificate event is what sets 'calibrated'. Requiring an active certificate
 * is what stops an escalation from being closed without the re-calibration it exists to expedite.
 */
async function applyEscalationResolved(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const escalationId = p['escalation_id'] as string;
  const resolvingCertificateId = p['resolving_certificate_id'] as string;
  const resolvedAt = p['resolved_at'] as string;

  // Lock order: certificate rows FIRST, then the escalation row, then status (the Locking Contract).
  // The escalation is read unlocked first to learn instrument_record_id and verify existence/status;
  // a concurrent certificate recording can auto-resolve the escalation between this read and the
  // lock acquisition below, so status is re-verified after the lock is taken. Locking the escalation
  // BEFORE the certificate was a real AB-BA deadlock against applyCertificateRecorded (which takes
  // certificate rows then the escalation row): each transaction held one lock the other wanted,
  // Postgres aborted one with an unmapped 40P01, and a legitimate write 500'd.
  const escalationRead = await getEscalationById(escalationId, client, false);
  if (!escalationRead) {
    reject(
      'ESCALATION_NOT_FOUND',
      'The escalation does not resolve',
      { escalation_id: escalationId },
      404,
    );
  }
  if (escalationRead.status !== 'open') {
    reject(
      'ESCALATION_NOT_OPEN',
      'This escalation is not open',
      { escalation_id: escalationId, status: escalationRead.status },
      409,
    );
  }

  // Lock order step 3: the certificate row FIRST, per the Locking Contract.
  const certificate = await getCertificateById(resolvingCertificateId, client, true);
  if (
    !certificate ||
    certificate.status !== 'active' ||
    certificate.instrument_record_id !== escalationRead.instrument_record_id
  ) {
    reject(
      'CERTIFICATE_EXPIRED',
      'The resolving certificate is not an active certificate for this instrument',
      {
        escalation_id: escalationId,
        certificate_id: resolvingCertificateId,
        status: certificate?.status ?? null,
      },
      422,
    );
  }

  // Lock order step 4: the escalation row, AFTER the certificate. Re-verify status='open' under the
  // lock, because a concurrent certificate recording may have auto-resolved this escalation between
  // the unlocked read above and this lock acquisition.
  const escalation = await getEscalationById(escalationId, client, true);
  if (!escalation || escalation.status !== 'open') {
    reject(
      'ESCALATION_NOT_OPEN',
      'This escalation is not open',
      { escalation_id: escalationId, status: escalation?.status ?? null },
      409,
    );
  }

  // A resolution cannot precede the raise it resolves. Clamp a backdated declared resolved_at to the
  // raise instant (a forged past timestamp would otherwise stamp resolved_at < raised_at).
  const requestedMs = new Date(resolvedAt).getTime();
  const raisedDate = escalation.raised_at as unknown as Date;
  const raisedMs = raisedDate.getTime();
  const finalResolvedAt = requestedMs < raisedMs ? raisedDate.toISOString() : resolvedAt;

  const resolved = await resolveEscalation(
    escalationId,
    resolvingCertificateId,
    finalResolvedAt,
    client,
  );
  if (!resolved) {
    reject(
      'ESCALATION_NOT_OPEN',
      'This escalation is not open',
      { escalation_id: escalationId },
      409,
    );
  }
}

// ---------------------------------------------------------------------------
// 23505 duplicate resolvers
// ---------------------------------------------------------------------------

/**
 * The race path and the sequential path must return the SAME error code with the SAME existing_*
 * detail (the Story 7.2 lesson). Each resolver re-reads the winning row so a caller that lost a
 * concurrent race is told exactly what a caller that arrived second sequentially is told.
 */
export async function resolveInstrumentRegisterDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const instrumentId =
    typeof payload['instrument_id'] === 'string'
      ? canonicalInstrumentId(payload['instrument_id'])
      : null;
  const attempted: Record<string, unknown> = { instrument_id: instrumentId };
  if (instrumentId !== null) {
    const existing = await getInstrumentRecordByInstrumentId(instrumentId);
    if (existing) {
      return {
        instrument_id: instrumentId,
        existing_instrument_record_id: existing.instrument_record_id,
      };
    }
  }
  return attempted;
}

export async function resolveInstrumentAssetDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const assetId = isUuid(payload['asset_id']) ? (payload['asset_id'] as string) : null;
  const attempted: Record<string, unknown> = { asset_id: assetId };
  if (assetId !== null) {
    const existing = await getInstrumentRecordByAssetId(assetId);
    if (existing) {
      return { asset_id: assetId, existing_instrument_record_id: existing.instrument_record_id };
    }
  }
  return attempted;
}

export async function resolveCertificateNumberDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const instrumentRecordId = isUuid(payload['instrument_record_id'])
    ? (payload['instrument_record_id'] as string)
    : null;
  const certificateNumber =
    typeof payload['certificate_number'] === 'string'
      ? canonicalCertificateNumber(payload['certificate_number'])
      : null;
  const attempted: Record<string, unknown> = {
    instrument_record_id: instrumentRecordId,
    certificate_number: certificateNumber,
  };
  if (instrumentRecordId !== null && certificateNumber !== null) {
    const existing = await getCertificateByNumber(instrumentRecordId, certificateNumber);
    if (existing) {
      return { ...attempted, existing_certificate_id: existing.certificate_id };
    }
  }
  return attempted;
}

export async function resolveActiveCertificateDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const instrumentRecordId = isUuid(payload['instrument_record_id'])
    ? (payload['instrument_record_id'] as string)
    : null;
  const attempted: Record<string, unknown> = { instrument_record_id: instrumentRecordId };
  if (instrumentRecordId !== null) {
    const existing = await getActiveCertificate(instrumentRecordId);
    if (existing) {
      return { ...attempted, existing_certificate_id: existing.certificate_id };
    }
  }
  return attempted;
}

export async function resolveCalibrationAlertDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const certificateId = isUuid(payload['certificate_id'])
    ? (payload['certificate_id'] as string)
    : null;
  const stageDays =
    typeof payload['stage_days'] === 'number' && Number.isInteger(payload['stage_days'])
      ? payload['stage_days']
      : null;
  const attempted: Record<string, unknown> = {
    certificate_id: certificateId,
    stage_days: stageDays,
  };
  if (certificateId !== null && stageDays !== null) {
    const existing = await getCalibrationAlertForStage(certificateId, stageDays);
    if (existing) {
      return { ...attempted, existing_alert_id: existing.alert_id };
    }
  }
  return attempted;
}

export async function resolveOpenEscalationDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const instrumentRecordId = isUuid(payload['instrument_record_id'])
    ? (payload['instrument_record_id'] as string)
    : null;
  const attempted: Record<string, unknown> = { instrument_record_id: instrumentRecordId };
  if (instrumentRecordId !== null) {
    const existing = await getOpenEscalation(instrumentRecordId);
    if (existing) {
      return { ...attempted, existing_escalation_id: existing.escalation_id };
    }
  }
  return attempted;
}
