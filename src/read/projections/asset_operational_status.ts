import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 7.6 accessors for the asset operational status projection (FR-M-16). One row per asset,
 * keyed by the Story 7.1 register (AD-9). sign_off_by / sign_off_at are the return-to-service
 * supervisor sign-off (AC5), written by the applier from the resolved DOA approver under lock.
 */
export interface AssetOperationalStatusRow {
  asset_id: string;
  status: 'running' | 'idle' | 'breakdown' | 'maintenance';
  updated_at: string;
  updated_by: string | null;
  sign_off_by: string | null;
  sign_off_at: string | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// OFFSET is a bigint in PostgreSQL. A floor of 0 alone lets `?offset=99999999999999999999` through
// as a value outside that range, which raises 22003 and 500s the read endpoint; cap it here so a
// silly page request returns an empty page instead.
const MAX_OFFSET = 1_000_000_000;
const ASSET_STATUSES = new Set(['running', 'idle', 'breakdown', 'maintenance']);

const STATUS_COLUMNS = `asset_id, status, updated_at, updated_by, sign_off_by, sign_off_at`;

export interface UpsertAssetOperationalStatusRow {
  asset_id: string;
  status: 'running' | 'idle' | 'breakdown' | 'maintenance';
  updated_by: string;
  sign_off_by: string | null;
  sign_off_at: string | null;
}

export async function upsertAssetOperationalStatus(
  row: UpsertAssetOperationalStatusRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO asset_operational_status (asset_id, status, updated_at, updated_by, sign_off_by, sign_off_at)
     VALUES ($1,$2,now(),$3,$4,$5)
     ON CONFLICT (asset_id) DO UPDATE
        SET status = EXCLUDED.status,
            updated_at = now(),
            updated_by = EXCLUDED.updated_by,
            sign_off_by = EXCLUDED.sign_off_by,
            sign_off_at = EXCLUDED.sign_off_at`,
    [row.asset_id, row.status, row.updated_by, row.sign_off_by, row.sign_off_at],
  );
}

export async function getAssetOperationalStatus(
  assetId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<AssetOperationalStatusRow | null> {
  if (!UUID_REGEX.test(assetId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT ${STATUS_COLUMNS} FROM asset_operational_status WHERE asset_id = $1${lockClause}`,
    [assetId],
  );
  return (result.rows[0] as AssetOperationalStatusRow) ?? null;
}

export interface ListAssetOperationalStatusesParams {
  status?: 'running' | 'idle' | 'breakdown' | 'maintenance' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listAssetOperationalStatuses(
  params: ListAssetOperationalStatusesParams,
  client?: PoolClient,
): Promise<AssetOperationalStatusRow[]> {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;

  if (params.status) {
    if (!ASSET_STATUSES.has(params.status)) return [];
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }

  const limit = Number.isFinite(params.limit ?? 100)
    ? Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 500)
    : 100;
  const offset = Number.isFinite(params.offset ?? 0)
    ? Math.min(Math.max(Math.trunc(params.offset ?? 0), 0), MAX_OFFSET)
    : 0;
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await runner(client).query(
    `SELECT ${STATUS_COLUMNS} FROM asset_operational_status ${where}
      ORDER BY updated_at DESC, asset_id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as AssetOperationalStatusRow[];
}
