import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 7.2 accessors for the asset usage-meter register (FR-M-03). NUMERIC columns come back
 * from pg as strings; callers that need arithmetic parse them explicitly (a meter value in
 * NUMERIC(18,4) is exactly representable as a double for any realistic reading).
 */
export interface AssetMeterRow {
  meter_id: string;
  asset_id: string;
  meter_code: string;
  unit: 'hours' | 'cycles' | 'km' | 'units';
  current_reading: string;
  last_reading_at: string | null;
  silent_after_days: number;
  alert_role: string;
  silent_flagged_at: string | null;
  last_reconciled_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getMeterById(
  meterId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<AssetMeterRow | null> {
  if (!UUID_REGEX.test(meterId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(`SELECT * FROM asset_meter WHERE meter_id = $1${lockClause}`, [
    meterId,
  ]);
  return (result.rows[0] as AssetMeterRow) ?? null;
}

export async function getMeterByCode(
  assetId: string,
  meterCode: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<AssetMeterRow | null> {
  if (!UUID_REGEX.test(assetId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  // Case-insensitive to match uq_asset_meter_code (asset_id, lower(meter_code)).
  const result = await r.query(
    `SELECT * FROM asset_meter WHERE asset_id = $1 AND lower(meter_code) = lower($2)${lockClause}`,
    [assetId, meterCode],
  );
  return (result.rows[0] as AssetMeterRow) ?? null;
}

export interface InsertAssetMeterRow {
  meter_id: string;
  asset_id: string;
  meter_code: string;
  unit: 'hours' | 'cycles' | 'km' | 'units';
  silent_after_days: number;
  alert_role: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export async function insertMeter(row: InsertAssetMeterRow, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO asset_meter (
      meter_id, asset_id, meter_code, unit, current_reading, silent_after_days,
      alert_role, created_by, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,0,$5,$6,$7,$8,$9)`,
    [
      row.meter_id,
      row.asset_id,
      row.meter_code,
      row.unit,
      row.silent_after_days,
      row.alert_role,
      row.created_by,
      row.created_at,
      row.updated_at,
    ],
  );
}

/**
 * Advances the meter to the accepted reading. A fresh reading also clears silent_flagged_at: a
 * meter that has just reported is no longer silent, which is the "the meter is reconciled" half
 * of AC 5. Both the clock and the flag-clear decision are floored at COALESCE(last_reading_at,
 * created_at) so they share the SAME clock as listSilentMeters - a reading backdated before the
 * meter's registration can neither rewind the silent clock nor clear a live flag.
 */
export async function updateMeterReading(
  meterId: string,
  readingValue: number,
  readingAt: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE asset_meter
        SET current_reading = $2,
            last_reading_at = GREATEST(COALESCE(last_reading_at, created_at), $3::timestamptz),
            silent_flagged_at = CASE
              WHEN $3::timestamptz >= COALESCE(last_reading_at, created_at)
                THEN NULL
              ELSE silent_flagged_at
            END,
            updated_at = now()
      WHERE meter_id = $1`,
    [meterId, readingValue, readingAt],
  );
}

export async function flagMeterSilent(
  meterId: string,
  flaggedAt: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE asset_meter
        SET silent_flagged_at = $2,
            last_reconciled_at = $2,
            updated_at = now()
      WHERE meter_id = $1`,
    [meterId, flaggedAt],
  );
}

export interface ListMetersParams {
  asset_id?: string | undefined;
  silent_only?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listMeters(
  params: ListMetersParams,
  client?: PoolClient,
): Promise<AssetMeterRow[]> {
  const r = runner(client);
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;

  if (params.asset_id) {
    if (!UUID_REGEX.test(params.asset_id)) return [];
    conditions.push(`asset_id = $${idx++}`);
    values.push(params.asset_id);
  }
  if (params.silent_only) {
    conditions.push('silent_flagged_at IS NOT NULL');
  }

  const limit = Number.isFinite(params.limit ?? 100)
    ? Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 500)
    : 100;
  const offset = Number.isFinite(params.offset ?? 0)
    ? Math.max(Math.trunc(params.offset ?? 0), 0)
    : 0;
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await r.query(
    `SELECT * FROM asset_meter ${where} ORDER BY created_at ASC, meter_id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as AssetMeterRow[];
}

/**
 * AC 5: meters that have reported nothing for their own configured interval, measured against the
 * job's business_date. A meter that has never reported is measured from its registration date, so
 * a meter registered and then ignored is caught the same way as one that went quiet. Meters
 * already carrying a silent flag are excluded, which is what makes the monthly job idempotent.
 */
export async function listSilentMeters(
  businessDate: string,
  client?: PoolClient,
  assetId?: string,
): Promise<AssetMeterRow[]> {
  const r = runner(client);
  const assetFilter = assetId ? ' AND asset_id = $2' : '';
  const values: string[] = assetId ? [businessDate, assetId] : [businessDate];
  const result = await r.query(
    `SELECT * FROM asset_meter
      WHERE silent_flagged_at IS NULL
        AND COALESCE(last_reading_at, created_at) < (($1::date AT TIME ZONE 'UTC') - (silent_after_days || ' days')::interval)${assetFilter}
      ORDER BY created_at ASC, meter_id ASC`,
    values,
  );
  return result.rows as AssetMeterRow[];
}
