import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 7.6 accessors for the per-asset maintenance cost rollup (FR-M-15). The three totals are the
 * SUM of the matching columns across all completed maintenance_work_order rows for the asset.
 * upsertMaintenanceAssetCost ADDS the new costs to the existing totals in SQL NUMERIC (never a JS
 * float round-trip), so a replay of the same work order must not double-count - the seam guarantees
 * that by running this inside persistEvent's alreadyPersisted-guarded transaction.
 *
 * NUMERIC columns are rendered as strings out of pg (::text) so every accessor hands the caller
 * exact decimal strings, never a JS number that would round a cost.
 */
export interface MaintenanceAssetCostRow {
  asset_id: string;
  total_labor_cost: string;
  total_parts_cost: string;
  total_cost: string;
  last_work_order_id: string | null;
  last_closed_at: string | null;
  updated_at: string;
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

const COST_COLUMNS = `asset_id,
    total_labor_cost::text AS total_labor_cost,
    total_parts_cost::text AS total_parts_cost,
    total_cost::text AS total_cost,
    last_work_order_id, last_closed_at, updated_at`;

export interface UpsertMaintenanceAssetCostRow {
  asset_id: string;
  labor_cost: string;
  parts_cost: string;
  total_cost: string;
  work_order_id: string;
  closed_at: string;
}

export async function upsertMaintenanceAssetCost(
  row: UpsertMaintenanceAssetCostRow,
  client: PoolClient,
): Promise<void> {
  // INSERT ON CONFLICT DO UPDATE that ADDS the new costs to the existing totals, all in SQL
  // NUMERIC. The last work order pointer moves to the most recent closure BY closure instant, not
  // by arrival order: a backdated completion applied after a later one must not drag the pointer
  // backwards. GREATEST ignores a NULL existing value, so the first write still sets it.
  await client.query(
    `INSERT INTO maintenance_asset_cost (asset_id, total_labor_cost, total_parts_cost, total_cost, last_work_order_id, last_closed_at)
     VALUES ($1, $2::numeric, $3::numeric, $4::numeric, $5, $6)
     ON CONFLICT (asset_id) DO UPDATE
        SET total_labor_cost = maintenance_asset_cost.total_labor_cost + EXCLUDED.total_labor_cost,
            total_parts_cost = maintenance_asset_cost.total_parts_cost + EXCLUDED.total_parts_cost,
            total_cost = maintenance_asset_cost.total_cost + EXCLUDED.total_cost,
            last_work_order_id = CASE
              WHEN maintenance_asset_cost.last_closed_at IS NULL
                OR EXCLUDED.last_closed_at >= maintenance_asset_cost.last_closed_at
              THEN EXCLUDED.last_work_order_id
              ELSE maintenance_asset_cost.last_work_order_id
            END,
            last_closed_at = GREATEST(maintenance_asset_cost.last_closed_at, EXCLUDED.last_closed_at),
            updated_at = now()`,
    [
      row.asset_id,
      row.labor_cost,
      row.parts_cost,
      row.total_cost,
      row.work_order_id,
      row.closed_at,
    ],
  );
}

export async function getMaintenanceAssetCost(
  assetId: string,
  client?: PoolClient,
): Promise<MaintenanceAssetCostRow | null> {
  if (!UUID_REGEX.test(assetId)) return null;
  const result = await runner(client).query(
    `SELECT ${COST_COLUMNS} FROM maintenance_asset_cost WHERE asset_id = $1`,
    [assetId],
  );
  return (result.rows[0] as MaintenanceAssetCostRow) ?? null;
}

export interface ListMaintenanceAssetCostsParams {
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listMaintenanceAssetCosts(
  params: ListMaintenanceAssetCostsParams,
  client?: PoolClient,
): Promise<MaintenanceAssetCostRow[]> {
  const limit = Number.isFinite(params.limit ?? 100)
    ? Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 500)
    : 100;
  const offset = Number.isFinite(params.offset ?? 0)
    ? Math.min(Math.max(Math.trunc(params.offset ?? 0), 0), MAX_OFFSET)
    : 0;
  const result = await runner(client).query(
    `SELECT ${COST_COLUMNS} FROM maintenance_asset_cost
      ORDER BY total_cost::numeric DESC, asset_id ASC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows as MaintenanceAssetCostRow[];
}
