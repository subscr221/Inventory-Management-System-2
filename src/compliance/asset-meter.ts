import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getAssetById } from '../read/projections/asset.js';
import {
  flagMeterSilent,
  getMeterByCode,
  getMeterById,
  insertMeter,
  updateMeterReading,
} from '../read/projections/asset_meter.js';
import { insertMeterReading } from '../read/projections/asset_meter_reading.js';

/**
 * Story 7.2 compliance seam for the usage-meter register (FR-M-03). Structurally mirrors
 * src/compliance/asset.ts: pure shape asserts run pre-transaction so a malformed event never
 * consumes an idempotency key, and the appliers run inside persistEvent's transaction with
 * FOR UPDATE locks on every row they are about to change.
 */

const MAINTENANCE_STREAM_TYPES = new Set(['maintenance']);
const ASSET_METER_EVENT_TYPES = new Set([
  'maintenance.meter_registered',
  'maintenance.meter_reading_recorded',
  'maintenance.meter_silent_flagged',
]);

const METER_UNITS = new Set(['hours', 'cycles', 'km', 'units']);
const READING_SOURCES = new Set(['manual', 'hub_booking', 'station_equipment']);
const CAPTURE_METHODS = new Set(['manual_entry', 'api', 'device_feed']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
// An explicit UTC offset is REQUIRED: a naive timestamp is parsed by JS Date.parse in
// process-local time but cast by pg ::timestamptz in session time, so the stored instant (the
// silent-meter clock) would shift when the two differ.
const ISO8601_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// Day-count caps for the interval fields: 100000 days is ~274 years, far beyond any real PM
// plan, and keeps PostgreSQL date arithmetic (and the jobs' JS addDays) inside their ranges -
// the INTEGER-column range alone (2^31-1 days, ~5.8M years) overflows both.
const MAX_INTERVAL_DAYS = 100000;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' && ISO_DATE_REGEX.test(value) && !Number.isNaN(Date.parse(value))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function assetMeterEventType(envelope: EventEnvelope): string | null {
  if (!MAINTENANCE_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!ASSET_METER_EVENT_TYPES.has(envelope.event_type)) return null;
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

export function assertAssetMeterShape(envelope: EventEnvelope): void {
  const type = assetMeterEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  switch (type) {
    case 'maintenance.meter_registered':
      assertMeterRegisteredShape(p);
      break;
    case 'maintenance.meter_reading_recorded':
      assertMeterReadingShape(p);
      break;
    case 'maintenance.meter_silent_flagged':
      assertMeterSilentShape(p);
      break;
  }
}

function assertMeterRegisteredShape(p: Record<string, unknown>): void {
  if (!isUuid(p['meter_id'])) reject('INVALID_PARAMS', 'meter_id is required and must be a UUID');
  if (!isUuid(p['asset_id'])) reject('INVALID_PARAMS', 'asset_id is required and must be a UUID');
  if (!isNonEmptyString(p['meter_code']))
    reject('INVALID_PARAMS', 'meter_code is required and must be a non-empty string');
  if (!isNonEmptyString(p['unit']) || !METER_UNITS.has(p['unit'] as string)) {
    reject('INVALID_PARAMS', 'unit is required and must be one of: hours, cycles, km, units', {
      unit: p['unit'],
    });
  }
  const silentAfterDays = p['silent_after_days'];
  if (
    !Number.isInteger(silentAfterDays) ||
    (silentAfterDays as number) <= 0 ||
    (silentAfterDays as number) > MAX_INTERVAL_DAYS
  ) {
    reject(
      'INVALID_PARAMS',
      'silent_after_days must be a positive integer of at most 100000 days',
      {
        silent_after_days: silentAfterDays,
      },
    );
  }
  if (!isNonEmptyString(p['alert_role']))
    reject('INVALID_PARAMS', 'alert_role is required and must be a non-empty string');
}

function assertMeterReadingShape(p: Record<string, unknown>): void {
  if (!isUuid(p['reading_id']))
    reject('INVALID_PARAMS', 'reading_id is required and must be a UUID');
  if (!isUuid(p['meter_id'])) reject('INVALID_PARAMS', 'meter_id is required and must be a UUID');
  if (!isUuid(p['asset_id'])) reject('INVALID_PARAMS', 'asset_id is required and must be a UUID');
  const value = p['reading_value'];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    reject('INVALID_PARAMS', 'reading_value must be a finite number greater than or equal to 0', {
      reading_value: value,
    });
  }
  // The column is NUMERIC(18,4): a value beyond the range or with more than 4 decimal places
  // either raises an unmapped 22003 (raw 500) or is silently rounded in the projected row while
  // the event payload keeps the original - which then rejects the next legitimate reading as a
  // "regression" against the rounded value. NUMERIC(18,4) holds up to 99999999999999.9999, so
  // strict `< 1e14` is exactly the representable bound (1e14 itself overflows the column).
  const scaled = (value as number) * 10000;
  if ((value as number) >= 1e14 || Math.abs(scaled - Math.round(scaled)) > 1e-9) {
    reject('INVALID_PARAMS', 'reading_value must fit NUMERIC(18,4)', {
      reading_value: value,
    });
  }
  if (
    !isNonEmptyString(p['reading_at']) ||
    !ISO8601_TIMESTAMP_REGEX.test(p['reading_at'] as string)
  ) {
    reject(
      'INVALID_PARAMS',
      'reading_at is required and must be an ISO-8601 timestamp with an explicit UTC offset',
      {
        reading_at: p['reading_at'],
      },
    );
  }
  // A future-dated observation is a data-entry error: it suppresses silent-meter detection until
  // the date passes and persists a timestamp that does not exist yet. 24h tolerance for clock
  // skew on the Phase-2 device feeds; manual entry is expected to be at or before now.
  if (Date.parse(p['reading_at'] as string) > Date.now() + 24 * 60 * 60 * 1000) {
    reject('INVALID_PARAMS', 'reading_at must not be in the future (24h clock-skew tolerance)', {
      reading_at: p['reading_at'],
    });
  }
  if (!isNonEmptyString(p['source']) || !READING_SOURCES.has(p['source'] as string)) {
    reject(
      'INVALID_PARAMS',
      'source is required and must be one of: manual, hub_booking, station_equipment',
      { source: p['source'] },
    );
  }
  if (
    !isNonEmptyString(p['capture_method']) ||
    !CAPTURE_METHODS.has(p['capture_method'] as string)
  ) {
    reject(
      'INVALID_PARAMS',
      'capture_method is required and must be one of: manual_entry, api, device_feed',
      { capture_method: p['capture_method'] },
    );
  }
}

function assertMeterSilentShape(p: Record<string, unknown>): void {
  if (!isUuid(p['meter_id'])) reject('INVALID_PARAMS', 'meter_id is required and must be a UUID');
  if (!isUuid(p['asset_id'])) reject('INVALID_PARAMS', 'asset_id is required and must be a UUID');
  if (!isIsoDate(p['business_date']))
    reject('INVALID_PARAMS', 'business_date is required and must be an ISO date', {
      business_date: p['business_date'],
    });
  if (p['last_reading_at'] != null && Number.isNaN(Date.parse(p['last_reading_at'] as string))) {
    reject('INVALID_PARAMS', 'last_reading_at must be an ISO timestamp when present', {
      last_reading_at: p['last_reading_at'],
    });
  }
  const silentAfterDays = p['silent_after_days'];
  if (
    !Number.isInteger(silentAfterDays) ||
    (silentAfterDays as number) <= 0 ||
    (silentAfterDays as number) > MAX_INTERVAL_DAYS
  ) {
    reject(
      'INVALID_PARAMS',
      'silent_after_days must be a positive integer of at most 100000 days',
      {
        silent_after_days: silentAfterDays,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Inside-transaction projection (DB access)
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

export async function applyAssetMeterProjection(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  const type = assetMeterEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'maintenance.meter_registered':
      await applyMeterRegistered(envelope, client);
      break;
    case 'maintenance.meter_reading_recorded':
      await applyMeterReadingRecorded(envelope, client);
      break;
    case 'maintenance.meter_silent_flagged':
      await applyMeterSilentFlagged(envelope, client);
      break;
  }
}

async function applyMeterRegistered(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const now = new Date().toISOString();
  const assetId = p['asset_id'] as string;

  // No foreign keys exist between projections (they are event-rebuildable read models), so the
  // register's referential integrity is asserted here, inside the transaction.
  const asset = await getAssetById(assetId, client);
  if (!asset) {
    reject('ASSET_NOT_FOUND', 'Asset not found', { asset_id: assetId }, 404);
  }

  const meterCode = (p['meter_code'] as string).trim();
  const existing = await getMeterByCode(assetId, meterCode, client, true);
  if (existing) {
    reject(
      'DUPLICATE_METER',
      'A meter with this code is already registered on this asset',
      { asset_id: assetId, meter_code: meterCode, existing_meter_id: existing.meter_id },
      409,
    );
  }

  await insertMeter(
    {
      meter_id: p['meter_id'] as string,
      asset_id: assetId,
      meter_code: meterCode,
      unit: p['unit'] as 'hours' | 'cycles' | 'km' | 'units',
      silent_after_days: p['silent_after_days'] as number,
      alert_role: (p['alert_role'] as string).trim(),
      created_by: envelope.metadata.actor.user_id,
      created_at: now,
      updated_at: now,
    },
    client,
  );
}

async function applyMeterReadingRecorded(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const now = new Date().toISOString();
  const meterId = p['meter_id'] as string;
  const readingValue = p['reading_value'] as number;

  const meter = await getMeterById(meterId, client, true);
  if (!meter) {
    reject('METER_NOT_FOUND', 'Meter not found', { meter_id: meterId }, 404);
  }

  // The payload's declared asset must be the meter's own asset; a direct-event envelope cannot
  // attribute a reading to a foreign asset while the ledger row is bound to the meter.
  if (p['asset_id'] !== meter.asset_id) {
    reject('INVALID_PARAMS', "asset_id must be the meter's own asset", {
      meter_id: meterId,
      meter_asset_id: meter.asset_id,
      asset_id: p['asset_id'],
    });
  }

  // Meters do not run backwards: a reading below the stored current reading is a data-entry error
  // or a replaced/rolled-over meter, both of which need a deliberate decision rather than a silent
  // rewind of the PM due calculation. An EQUAL reading is accepted - "no usage since last report"
  // is a valid observation and it refreshes the silent-meter clock.
  const currentReading = Number(meter.current_reading);
  if (readingValue < currentReading) {
    reject(
      'METER_READING_REGRESSION',
      'Meter reading is below the current reading; meters do not run backwards',
      {
        meter_id: meterId,
        current_reading: meter.current_reading,
        submitted_reading: readingValue,
      },
      409,
    );
  }

  await insertMeterReading(
    {
      reading_id: p['reading_id'] as string,
      meter_id: meterId,
      asset_id: meter.asset_id,
      reading_value: readingValue,
      reading_at: p['reading_at'] as string,
      source: p['source'] as 'manual' | 'hub_booking' | 'station_equipment',
      capture_method: p['capture_method'] as 'manual_entry' | 'api' | 'device_feed',
      recorded_by: envelope.metadata.actor.user_id,
      created_at: now,
    },
    client,
  );

  await updateMeterReading(meterId, readingValue, p['reading_at'] as string, client);
}

async function applyMeterSilentFlagged(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const meterId = p['meter_id'] as string;

  const meter = await getMeterById(meterId, client, true);
  if (!meter) {
    reject('METER_NOT_FOUND', 'Meter not found', { meter_id: meterId }, 404);
  }
  // Re-check BOTH halves of the silent predicate on the locked row: a reading may have landed
  // between the job's list read and this write (that meter is no longer silent), and an
  // overlapping run may have flagged it already. Reject with a catchable code rather than
  // silently returning, so the caller neither persists a second meter_silent_flagged event nor
  // raises a second alert (the "re-run raises no second escalation" binding decision).
  const businessDateMs = Date.parse(`${p['business_date']}T00:00:00Z`);
  const lastReportMs = Date.parse(meter.last_reading_at ?? meter.created_at);
  const isSilent = lastReportMs < businessDateMs - meter.silent_after_days * 86400000;
  if (meter.silent_flagged_at !== null || !isSilent) {
    reject('METER_NOT_SILENT', 'The meter is not currently silent; nothing to flag', {
      meter_id: meterId,
    });
  }

  await flagMeterSilent(meterId, envelope.metadata.occurred_at ?? new Date().toISOString(), client);
}

/**
 * Concurrency fallback for uq_asset_meter_code: the caller (src/events/store.ts) has already
 * rolled back its transaction, so this runs a fresh query and returns the SAME detail shape as
 * the seam's own pre-check (DUPLICATE_METER with existing_meter_id). Mirrors
 * resolveAssetDuplicateConflict.
 */
export async function resolveMeterDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const assetId = typeof payload['asset_id'] === 'string' ? payload['asset_id'] : null;
  const meterCode =
    typeof payload['meter_code'] === 'string' && payload['meter_code'].trim() !== ''
      ? payload['meter_code'].trim()
      : null;
  const attempted: Record<string, unknown> = { asset_id: assetId, meter_code: meterCode };
  if (assetId !== null && meterCode !== null) {
    const existing = await getMeterByCode(assetId, meterCode);
    if (existing) {
      return { asset_id: assetId, meter_code: meterCode, existing_meter_id: existing.meter_id };
    }
  }
  return attempted;
}
