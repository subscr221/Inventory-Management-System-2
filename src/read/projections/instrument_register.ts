import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 7.5 accessors for the instrument register (FR-M-12, FR-M-13, AD-9).
 *
 * instrument_id is the QC-facing TEXT key that qc.result_recorded carries; asset_id is the Story
 * 7.1 register key. This table is the one row where the two identifier worlds meet, so every
 * lookup by instrument_id compares lower(instrument_id) to match uq_instrument_register_instrument_id.
 *
 * There is NO calibration status column here. The current status lives in
 * instrument_calibration_statuses, which the Story 1.7 lockout gate reads; the join below is a
 * READ convenience for the list/detail routes, never a second copy of the fact.
 */
export interface InstrumentRegisterRow {
  instrument_record_id: string;
  asset_id: string;
  instrument_id: string;
  location_id: string;
  calibration_interval_days: number;
  registered_by: string;
  registered_at: string;
  created_at: string;
  updated_at: string;
}

/** A register row joined to the status the lockout gate actually reads. */
export interface InstrumentRegisterWithStatusRow extends InstrumentRegisterRow {
  calibration_status: string | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REGISTER_COLUMNS = `instrument_record_id, asset_id, instrument_id, location_id,
    calibration_interval_days, registered_by, registered_at, created_at, updated_at`;

const REGISTER_COLUMNS_PREFIXED = `r.instrument_record_id, r.asset_id, r.instrument_id, r.location_id,
    r.calibration_interval_days, r.registered_by, r.registered_at, r.created_at, r.updated_at`;

export async function getInstrumentRecordById(
  instrumentRecordId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<InstrumentRegisterRow | null> {
  if (!UUID_REGEX.test(instrumentRecordId)) return null;
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await runner(client).query(
    `SELECT ${REGISTER_COLUMNS} FROM instrument_register WHERE instrument_record_id = $1${lockClause}`,
    [instrumentRecordId],
  );
  return (result.rows[0] as InstrumentRegisterRow) ?? null;
}

/**
 * Case-insensitive to match uq_instrument_register_instrument_id (lower(instrument_id)): a case
 * variant of an existing instrument id is the same physical instrument (the Story 7.1 asset-tag
 * precedent). The seam pre-check and the 23505 race resolver both come through here so the race
 * path and the sequential path see the same row.
 */
export async function getInstrumentRecordByInstrumentId(
  instrumentId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<InstrumentRegisterRow | null> {
  if (typeof instrumentId !== 'string' || instrumentId.trim() === '') return null;
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await runner(client).query(
    `SELECT ${REGISTER_COLUMNS} FROM instrument_register WHERE lower(instrument_id) = lower($1)${lockClause}`,
    [instrumentId],
  );
  return (result.rows[0] as InstrumentRegisterRow) ?? null;
}

export async function getInstrumentRecordByAssetId(
  assetId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<InstrumentRegisterRow | null> {
  if (!UUID_REGEX.test(assetId)) return null;
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await runner(client).query(
    `SELECT ${REGISTER_COLUMNS} FROM instrument_register WHERE asset_id = $1${lockClause}`,
    [assetId],
  );
  return (result.rows[0] as InstrumentRegisterRow) ?? null;
}

export interface InsertInstrumentRegisterRow {
  instrument_record_id: string;
  asset_id: string;
  instrument_id: string;
  location_id: string;
  calibration_interval_days: number;
  registered_by: string;
  registered_at: string;
}

export async function insertInstrumentRecord(
  row: InsertInstrumentRegisterRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO instrument_register (
      instrument_record_id, asset_id, instrument_id, location_id, calibration_interval_days,
      registered_by, registered_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      row.instrument_record_id,
      row.asset_id,
      row.instrument_id,
      row.location_id,
      row.calibration_interval_days,
      row.registered_by,
      row.registered_at,
    ],
  );
}

export interface ListInstrumentRecordsParams {
  asset_id?: string | undefined;
  location_id?: string | undefined;
  calibration_status?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listInstrumentRecords(
  params: ListInstrumentRecordsParams,
  client?: PoolClient,
): Promise<InstrumentRegisterWithStatusRow[]> {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;

  if (params.asset_id) {
    if (!UUID_REGEX.test(params.asset_id)) return [];
    conditions.push(`r.asset_id = $${idx++}`);
    values.push(params.asset_id);
  }
  if (params.location_id) {
    if (!UUID_REGEX.test(params.location_id)) return [];
    conditions.push(`r.location_id = $${idx++}`);
    values.push(params.location_id);
  }
  if (params.calibration_status) {
    conditions.push(`s.calibration_status = $${idx++}`);
    values.push(params.calibration_status);
  }

  const limit = Number.isFinite(params.limit ?? 100)
    ? Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 500)
    : 100;
  const offset = Number.isFinite(params.offset ?? 0)
    ? Math.max(Math.trunc(params.offset ?? 0), 0)
    : 0;
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await runner(client).query(
    `SELECT ${REGISTER_COLUMNS_PREFIXED}, s.calibration_status
       FROM instrument_register r
       LEFT JOIN instrument_calibration_statuses s
         ON lower(s.instrument_id) = lower(r.instrument_id)
      ${where}
      ORDER BY r.registered_at DESC, r.instrument_record_id ASC
      LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as InstrumentRegisterWithStatusRow[];
}
