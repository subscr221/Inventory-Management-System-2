import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

export type CalibrationStatus = 'calibrated' | 'out_of_calibration';

export interface InstrumentCalibrationStatus {
  instrument_uuid: string;
  instrument_id: string;
  calibration_status: CalibrationStatus;
  status_event_id: string | null;
  status_event_version: number | null;
  status_changed_by: string;
  status_changed_at: string;
  reason: string | null;
  updated_at: string;
}

export interface UpsertCalibrationStatusInput {
  instrument_id: string;
  calibration_status: CalibrationStatus;
  status_event_id: string;
  status_event_version: number;
  status_changed_by: string;
  reason: string | null;
}

/**
 * Story 7.5: the register writes status from INSIDE persistEvent's transaction, before the
 * domain_events row exists, so the event's version has not been assigned yet. status_event_id is
 * always known (persistEvent generates it up front and hands it to the applier); the version is
 * nullable on the column and is recorded as null on this path rather than guessed.
 */
export interface RegisterCalibrationStatusInput extends Omit<
  UpsertCalibrationStatusInput,
  'status_event_version'
> {
  status_event_version: number | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function mapRow(row: Record<string, unknown>): InstrumentCalibrationStatus {
  const changedAt =
    row['status_changed_at'] instanceof Date
      ? row['status_changed_at'].toISOString()
      : String(row['status_changed_at']);
  const updatedAt =
    row['updated_at'] instanceof Date ? row['updated_at'].toISOString() : String(row['updated_at']);
  return {
    instrument_uuid: row['instrument_uuid'] as string,
    instrument_id: row['instrument_id'] as string,
    calibration_status: row['calibration_status'] as CalibrationStatus,
    status_event_id: (row['status_event_id'] as string | null) ?? null,
    status_event_version: (row['status_event_version'] as number | null) ?? null,
    status_changed_by: row['status_changed_by'] as string,
    status_changed_at: changedAt,
    reason: (row['reason'] as string | null) ?? null,
    updated_at: updatedAt,
  };
}

export async function getInstrumentCalibrationStatus(
  instrumentId: string,
  client?: PoolClient,
): Promise<InstrumentCalibrationStatus | null> {
  // Story 7.5: matched case-insensitively, backed by
  // idx_instrument_calibration_statuses_instrument_id_lower. A registered instrument stored as
  // 'ins-42' and queried as 'INS-42' would otherwise return null, and null is treated as locked by
  // the Story 1.7 gate - fail-closed is correct but wrong for the operator, and the repo
  // convention (Story 7.1 asset tags, Story 7.2 scanned-versus-typed keys) is to canonicalize.
  const result = await runner(client).query(
    `SELECT instrument_uuid, instrument_id, calibration_status, status_event_id, status_event_version, status_changed_by, status_changed_at, reason, updated_at
     FROM instrument_calibration_statuses WHERE lower(instrument_id) = lower($1)`,
    [instrumentId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function getCalibrationStatus(
  instrumentId: string,
  client?: PoolClient,
): Promise<CalibrationStatus | null> {
  const row = await getInstrumentCalibrationStatus(instrumentId, client);
  return row?.calibration_status ?? null;
}

export async function ensureInstrumentCalibrationRow(
  instrumentId: string,
  actorUserId: string,
  client?: PoolClient,
): Promise<InstrumentCalibrationStatus> {
  const result = await runner(client).query(
    `INSERT INTO instrument_calibration_statuses (instrument_id, calibration_status, status_changed_by)
     VALUES ($1, 'calibrated', $2)
     ON CONFLICT (instrument_id) DO UPDATE SET instrument_id = EXCLUDED.instrument_id
     RETURNING instrument_uuid, instrument_id, calibration_status, status_event_id, status_event_version, status_changed_by, status_changed_at, reason, updated_at`,
    [instrumentId, actorUserId],
  );
  return mapRow(result.rows[0]!);
}

/**
 * Story 7.5 (Status Write-Through Contract): the ONE writer the calibration register uses.
 *
 * It NEVER defaults to 'calibrated' - the caller always passes an explicit status - which is what
 * separates it from ensureInstrumentCalibrationRow, whose `VALUES ($1, 'calibrated', $2)` default
 * would silently make a newly registered instrument usable for measurement. That default is the
 * exact defect AD-8 exists to prevent, so the register must not call it.
 *
 * The UPDATE runs first and matches case-insensitively, so a status row the Story 1.7 admin path
 * already created under a different case is UPDATED rather than shadowed by a second row (which
 * would make the lower() lookup ambiguous and the lockout unpredictable). It also renames the row
 * to the canonical register case (instrument_id = $1), so a later exact-match ON CONFLICT
 * (instrument_id) on the Story 1.7 path finds it instead of inserting a second row. The INSERT ...
 * ON CONFLICT is the create path for an instrument the platform has never seen.
 *
 * Per the Locking Contract this takes the status row LAST, so it must be the FINAL database call
 * in any applier that changes status.
 */
export async function setCalibrationStatusFromRegister(
  input: RegisterCalibrationStatusInput,
  client: PoolClient,
): Promise<InstrumentCalibrationStatus> {
  const columns = `instrument_uuid, instrument_id, calibration_status, status_event_id, status_event_version, status_changed_by, status_changed_at, reason, updated_at`;
  const values = [
    input.instrument_id,
    input.calibration_status,
    input.status_event_id,
    input.status_event_version,
    input.status_changed_by,
    input.reason,
  ];
  const updated = await client.query(
    `UPDATE instrument_calibration_statuses
     SET instrument_id = $1,
         calibration_status = $2,
         status_event_id = $3,
         status_event_version = $4,
         status_changed_by = $5,
         status_changed_at = now(),
         reason = $6,
         updated_at = now()
     WHERE lower(instrument_id) = lower($1)
     RETURNING ${columns}`,
    values,
  );
  if (updated.rows.length > 0) return mapRow(updated.rows[0]!);

  const inserted = await client.query(
    `INSERT INTO instrument_calibration_statuses (instrument_id, calibration_status, status_event_id, status_event_version, status_changed_by, reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (instrument_id) DO UPDATE
       SET calibration_status = EXCLUDED.calibration_status,
           status_event_id = EXCLUDED.status_event_id,
           status_event_version = EXCLUDED.status_event_version,
           status_changed_by = EXCLUDED.status_changed_by,
           status_changed_at = now(),
           reason = EXCLUDED.reason,
           updated_at = now()
     RETURNING ${columns}`,
    values,
  );
  return mapRow(inserted.rows[0]!);
}

export async function updateInstrumentCalibrationStatus(
  input: UpsertCalibrationStatusInput,
  client?: PoolClient,
): Promise<InstrumentCalibrationStatus> {
  const result = await runner(client).query(
    `UPDATE instrument_calibration_statuses
     SET calibration_status = $2,
         status_event_id = $3,
         status_event_version = $4,
         status_changed_by = $5,
         status_changed_at = now(),
         reason = $6,
         updated_at = now()
     WHERE instrument_id = $1
     RETURNING instrument_uuid, instrument_id, calibration_status, status_event_id, status_event_version, status_changed_by, status_changed_at, reason, updated_at`,
    [
      input.instrument_id,
      input.calibration_status,
      input.status_event_id,
      input.status_event_version,
      input.status_changed_by,
      input.reason,
    ],
  );
  return mapRow(result.rows[0]!);
}
