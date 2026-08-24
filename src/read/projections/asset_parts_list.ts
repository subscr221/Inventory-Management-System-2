import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 7.4 accessors for the maintenance-owned asset parts list, the equipment BOM (FR-M-07).
 * This is NOT the Epic 5 manufacturing BOM (AD-4) and shares no code with src/engineering/.
 */
export interface AssetPartsListRow {
  part_line_id: string;
  asset_id: string;
  sku: string;
  /** NUMERIC(18,6) rendered as a string so a fractional per-unit quantity keeps its precision. */
  quantity_per: string;
  position_ref: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** One where-used hit: an asset whose parts list references the SKU. */
export interface AssetPartsWhereUsedRow extends AssetPartsListRow {
  asset_tag: string;
  asset_name: string;
  criticality_class: 'critical' | 'high' | 'medium' | 'low';
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PARTS_COLUMNS = `part_line_id, asset_id, sku,
    quantity_per::text AS quantity_per,
    position_ref, created_by, created_at, updated_at`;

export async function getAssetPartById(
  partLineId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<AssetPartsListRow | null> {
  if (!UUID_REGEX.test(partLineId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT ${PARTS_COLUMNS} FROM asset_parts_list WHERE part_line_id = $1${lockClause}`,
    [partLineId],
  );
  return (result.rows[0] as AssetPartsListRow) ?? null;
}

/** The line for one (asset_id, sku) grain - the duplicate pre-check under FOR UPDATE. */
export async function getAssetPartByGrain(
  assetId: string,
  sku: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<AssetPartsListRow | null> {
  if (!UUID_REGEX.test(assetId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT ${PARTS_COLUMNS} FROM asset_parts_list WHERE asset_id = $1 AND sku = $2${lockClause}`,
    [assetId, sku],
  );
  return (result.rows[0] as AssetPartsListRow) ?? null;
}

export interface InsertAssetPartRow {
  part_line_id: string;
  asset_id: string;
  sku: string;
  quantity_per: string;
  position_ref: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export async function insertAssetPart(row: InsertAssetPartRow, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO asset_parts_list (
      part_line_id, asset_id, sku, quantity_per, position_ref, created_by, created_at, updated_at
    ) VALUES ($1,$2,$3,$4::numeric,$5,$6,$7,$8)`,
    [
      row.part_line_id,
      row.asset_id,
      row.sku,
      row.quantity_per,
      row.position_ref,
      row.created_by,
      row.created_at,
      row.updated_at,
    ],
  );
}

export interface ListAssetPartsParams {
  asset_id: string;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listAssetParts(
  params: ListAssetPartsParams,
  client?: PoolClient,
): Promise<AssetPartsListRow[]> {
  if (!UUID_REGEX.test(params.asset_id)) return [];
  const r = runner(client);
  const limit = Number.isFinite(params.limit ?? 100)
    ? Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 500)
    : 100;
  const offset = Number.isFinite(params.offset ?? 0)
    ? Math.max(Math.trunc(params.offset ?? 0), 0)
    : 0;
  const result = await r.query(
    `SELECT ${PARTS_COLUMNS} FROM asset_parts_list WHERE asset_id = $1
      ORDER BY sku ASC LIMIT $2 OFFSET $3`,
    [params.asset_id, limit, offset],
  );
  return result.rows as AssetPartsListRow[];
}

export interface ListWhereUsedParams {
  sku: string;
  limit?: number | undefined;
  offset?: number | undefined;
}

/**
 * AC 1's where-used read: every asset whose parts list references this SKU, joined to the single
 * asset register (AD-9) so the caller gets the tag, name and criticality without a second query.
 */
export async function listWhereUsedBySku(
  params: ListWhereUsedParams,
  client?: PoolClient,
): Promise<AssetPartsWhereUsedRow[]> {
  const r = runner(client);
  const limit = Number.isFinite(params.limit ?? 100)
    ? Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 500)
    : 100;
  const offset = Number.isFinite(params.offset ?? 0)
    ? Math.max(Math.trunc(params.offset ?? 0), 0)
    : 0;
  const result = await r.query(
    `SELECT p.part_line_id, p.asset_id, p.sku,
            p.quantity_per::text AS quantity_per,
            p.position_ref, p.created_by, p.created_at, p.updated_at,
            a.asset_tag, a.asset_name, a.criticality_class
       FROM asset_parts_list p
       JOIN asset a ON a.asset_id = p.asset_id
      WHERE p.sku = $1
      ORDER BY a.asset_tag ASC, p.part_line_id ASC LIMIT $2 OFFSET $3`,
    [params.sku, limit, offset],
  );
  return result.rows as AssetPartsWhereUsedRow[];
}
