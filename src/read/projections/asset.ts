import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

export interface AssetRow {
  asset_id: string;
  asset_tag: string;
  asset_name: string;
  criticality_class: 'critical' | 'high' | 'medium' | 'low';
  serial_number: string | null;
  manufacturer: string | null;
  model: string | null;
  fixed_asset_ref: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getAssetById(assetId: string, client?: PoolClient): Promise<AssetRow | null> {
  if (!UUID_REGEX.test(assetId)) return null;
  const r = runner(client);
  const result = await r.query(`SELECT * FROM asset WHERE asset_id = $1`, [assetId]);
  return (result.rows[0] as AssetRow) ?? null;
}

/**
 * The Locking Contract's step-1 asset lock: locks the Story 7.1 asset row FOR UPDATE so every
 * multi-row applier that mutates maintenance state on an asset serializes on the SAME row in the
 * SAME order. Assets are never deleted, so the lock is ordering discipline rather than existence
 * protection; returns whether the asset exists. Story 7.6 appliers take this before any other row.
 */
export async function lockAssetById(assetId: string, client: PoolClient): Promise<boolean> {
  if (!UUID_REGEX.test(assetId)) return false;
  const result = await client.query(`SELECT 1 FROM asset WHERE asset_id = $1 FOR UPDATE`, [
    assetId,
  ]);
  return result.rows.length > 0;
}

export async function getAssetByTag(
  assetTag: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<AssetRow | null> {
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  // Case-insensitive to match uq_asset_tag (lower(asset_tag)): case variants are one asset.
  const result = await r.query(
    `SELECT * FROM asset WHERE lower(asset_tag) = lower($1)${lockClause}`,
    [assetTag],
  );
  return (result.rows[0] as AssetRow) ?? null;
}

export async function getAssetBySerial(
  serialNumber: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<AssetRow | null> {
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  // Case-insensitive to match uq_asset_serial (lower(serial_number)): case variants are one asset.
  const result = await r.query(
    `SELECT * FROM asset WHERE lower(serial_number) = lower($1)${lockClause}`,
    [serialNumber],
  );
  return (result.rows[0] as AssetRow) ?? null;
}

export async function insertAsset(row: AssetRow, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO asset (
      asset_id, asset_tag, asset_name, criticality_class, serial_number,
      manufacturer, model, fixed_asset_ref, created_by, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      row.asset_id,
      row.asset_tag,
      row.asset_name,
      row.criticality_class,
      row.serial_number,
      row.manufacturer,
      row.model,
      row.fixed_asset_ref,
      row.created_by,
      row.created_at,
      row.updated_at,
    ],
  );
}

export interface ListAssetsParams {
  criticality_class?: 'critical' | 'high' | 'medium' | 'low' | undefined;
  search?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listAssets(
  params: ListAssetsParams,
  client?: PoolClient,
): Promise<AssetRow[]> {
  const r = runner(client);
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;

  if (params.criticality_class) {
    conditions.push(`criticality_class = $${idx++}`);
    values.push(params.criticality_class);
  }

  if (params.search) {
    const escaped = params.search.replace(/[%_\\]/g, '\\$&');
    conditions.push(
      `(asset_name ILIKE $${idx} ESCAPE '\\' OR asset_tag ILIKE $${idx + 1} ESCAPE '\\')`,
    );
    const pattern = `%${escaped}%`;
    values.push(pattern, pattern);
    idx += 2;
  }

  const limit = Number.isFinite(params.limit ?? 100)
    ? Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 500)
    : 100;
  const offset = Number.isFinite(params.offset ?? 0)
    ? Math.max(Math.trunc(params.offset ?? 0), 0)
    : 0;
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await r.query(
    `SELECT * FROM asset ${where} ORDER BY asset_name ASC, asset_id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as AssetRow[];
}
