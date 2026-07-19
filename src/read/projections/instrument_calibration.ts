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

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function mapRow(row: Record<string, unknown>): InstrumentCalibrationStatus {
  const changedAt = row['status_changed_at'] instanceof Date ? row['status_changed_at'].toISOString() : String(row['status_changed_at']);
  const updatedAt = row['updated_at'] instanceof Date ? row['updated_at'].toISOString() : String(row['updated_at']);
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

export async function getInstrumentCalibrationStatus(instrumentId: string, client?: PoolClient): Promise<InstrumentCalibrationStatus | null> {
  const result = await runner(client).query(
    `SELECT instrument_uuid, instrument_id, calibration_status, status_event_id, status_event_version, status_changed_by, status_changed_at, reason, updated_at
     FROM instrument_calibration_statuses WHERE instrument_id = $1`,
    [instrumentId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function getCalibrationStatus(instrumentId: string, client?: PoolClient): Promise<CalibrationStatus | null> {
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
    [input.instrument_id, input.calibration_status, input.status_event_id, input.status_event_version, input.status_changed_by, input.reason],
  );
  return mapRow(result.rows[0]!);
}
