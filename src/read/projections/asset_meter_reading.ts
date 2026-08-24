import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/** Story 7.2 accessors for the append-only meter reading ledger (FR-M-03, AC 4). */
export interface AssetMeterReadingRow {
  reading_id: string;
  meter_id: string;
  asset_id: string;
  reading_value: string;
  reading_at: string;
  source: 'manual' | 'hub_booking' | 'station_equipment';
  capture_method: 'manual_entry' | 'api' | 'device_feed';
  recorded_by: string;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InsertAssetMeterReadingRow {
  reading_id: string;
  meter_id: string;
  asset_id: string;
  reading_value: number;
  reading_at: string;
  source: 'manual' | 'hub_booking' | 'station_equipment';
  capture_method: 'manual_entry' | 'api' | 'device_feed';
  recorded_by: string;
  created_at: string;
}

export async function insertMeterReading(
  row: InsertAssetMeterReadingRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO asset_meter_reading (
      reading_id, meter_id, asset_id, reading_value, reading_at,
      source, capture_method, recorded_by, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      row.reading_id,
      row.meter_id,
      row.asset_id,
      row.reading_value,
      row.reading_at,
      row.source,
      row.capture_method,
      row.recorded_by,
      row.created_at,
    ],
  );
}

/**
 * The single-row read-back by id: the 201 response must return the row it just persisted, not
 * the meter's newest row (a backdated reading would otherwise come back as a different one).
 */
export async function getMeterReadingById(
  readingId: string,
  client?: PoolClient,
): Promise<AssetMeterReadingRow | null> {
  if (!UUID_REGEX.test(readingId)) return null;
  const r = runner(client);
  const result = await r.query(`SELECT * FROM asset_meter_reading WHERE reading_id = $1`, [
    readingId,
  ]);
  return (result.rows[0] as AssetMeterReadingRow) ?? null;
}

export interface ListMeterReadingsParams {
  meter_id: string;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listMeterReadings(
  params: ListMeterReadingsParams,
  client?: PoolClient,
): Promise<AssetMeterReadingRow[]> {
  if (!UUID_REGEX.test(params.meter_id)) return [];
  const r = runner(client);
  const conditions: string[] = ['meter_id = $1'];
  const values: (string | number)[] = [params.meter_id];
  let idx = 2;

  if (params.from) {
    conditions.push(`reading_at >= $${idx++}`);
    values.push(params.from);
  }
  if (params.to) {
    conditions.push(`reading_at <= $${idx++}`);
    values.push(params.to);
  }

  const limit = Number.isFinite(params.limit ?? 100)
    ? Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 500)
    : 100;
  const offset = Number.isFinite(params.offset ?? 0)
    ? Math.max(Math.trunc(params.offset ?? 0), 0)
    : 0;
  const result = await r.query(
    `SELECT * FROM asset_meter_reading
      WHERE ${conditions.join(' AND ')}
      ORDER BY reading_at DESC, reading_id ASC
      LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as AssetMeterReadingRow[];
}
