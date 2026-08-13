import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import type { BomExplosionAlternate } from '../../events/schema.js';

/** Story 5.5 explosion run header (FR-B-07). One row per bom.exploded event. */
export interface BomExplosionRow {
  explosion_id: string;
  bom_id: string;
  revision_id: string;
  order_quantity: string;
  business_date: string;
  depth_truncated: boolean;
  requirement_count: number;
  exploded_by: string;
  correlation_id: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

/** One generated requirement row. Quantities are exact NUMERIC strings, never JS numbers. */
export interface BomExplosionLineRow {
  explosion_line_id: string;
  explosion_id: string;
  depth: number;
  path: string;
  source_bom_id: string;
  source_revision_id: string;
  bom_line_id: string;
  line_no: number;
  component_item_id: string;
  component_sku: string | null;
  supply_method: 'directed_issue' | 'backflush';
  required_quantity: string;
  scrap_percent: string | null;
  base_quantity_per: string;
  has_child_bom: boolean;
  via_phantom: boolean;
  alternates: BomExplosionAlternate[];
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function insertExplosion(
  row: Omit<BomExplosionRow, 'created_at' | 'updated_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO bom_explosion (explosion_id, bom_id, revision_id, order_quantity, business_date, depth_truncated, requirement_count, exploded_by, correlation_id, source_event_id)
     VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9, $10)`,
    [
      row.explosion_id,
      row.bom_id,
      row.revision_id,
      row.order_quantity,
      row.business_date,
      row.depth_truncated,
      row.requirement_count,
      row.exploded_by,
      row.correlation_id,
      row.source_event_id,
    ],
  );
}

export async function insertExplosionLine(
  row: Omit<BomExplosionLineRow, 'created_at' | 'updated_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO bom_explosion_line (explosion_line_id, explosion_id, depth, path, source_bom_id, source_revision_id, bom_line_id, line_no, component_item_id, component_sku, supply_method, required_quantity, scrap_percent, base_quantity_per, has_child_bom, via_phantom, alternates, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::numeric, $13, $14::numeric, $15, $16, $17::jsonb, $18)`,
    [
      row.explosion_line_id,
      row.explosion_id,
      row.depth,
      row.path,
      row.source_bom_id,
      row.source_revision_id,
      row.bom_line_id,
      row.line_no,
      row.component_item_id,
      row.component_sku,
      row.supply_method,
      row.required_quantity,
      row.scrap_percent,
      row.base_quantity_per,
      row.has_child_bom,
      row.via_phantom,
      JSON.stringify(row.alternates),
      row.source_event_id,
    ],
  );
}

export async function getExplosionById(
  explosionId: string,
  client?: PoolClient,
): Promise<BomExplosionRow | null> {
  if (!UUID_REGEX.test(explosionId)) return null;
  // business_date::text keeps the contract string type (node-pg would otherwise parse the DATE
  // column as a local-midnight Date and shift it one day back in JSON responses on east-of-UTC
  // servers).
  const result = await runner(client).query(
    `SELECT explosion_id, bom_id, revision_id, order_quantity, business_date::text AS business_date,
            depth_truncated, requirement_count, exploded_by, correlation_id, source_event_id,
            created_at, updated_at
       FROM bom_explosion WHERE explosion_id = $1`,
    [explosionId],
  );
  return (result.rows[0] as BomExplosionRow) ?? null;
}

export async function getExplosionLines(
  explosionId: string,
  client?: PoolClient,
): Promise<BomExplosionLineRow[]> {
  if (!UUID_REGEX.test(explosionId)) return [];
  // path segments are compared numerically, not lexicographically, so '/1/10' sorts after
  // '/1/2' for BOMs with ten or more sibling lines.
  const result = await runner(client).query(
    `SELECT * FROM bom_explosion_line WHERE explosion_id = $1
       ORDER BY string_to_array(substr(path, 2), '/')::int[] ASC, line_no ASC`,
    [explosionId],
  );
  return result.rows as BomExplosionLineRow[];
}

export async function listExplosionsByBom(
  bomId: string,
  params: { limit?: number | undefined; offset?: number | undefined },
  client?: PoolClient,
): Promise<{ rows: BomExplosionRow[]; total: number; limit: number; offset: number }> {
  if (!UUID_REGEX.test(bomId)) return { rows: [], total: 0, limit: 0, offset: 0 };
  const r = runner(client);
  // Integer guard plus clamp (the module's limit/offset discipline): NaN or fractional values
  // would reach LIMIT and die as a raw 500, so non-integers fail closed to the defaults.
  const limitRaw = params.limit ?? 50;
  const offsetRaw = params.offset ?? 0;
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 ? Math.min(limitRaw, 200) : 50;
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  const countResult = await r.query(
    'SELECT COUNT(*) AS total FROM bom_explosion WHERE bom_id = $1',
    [bomId],
  );
  const result = await r.query(
    `SELECT explosion_id, bom_id, revision_id, order_quantity, business_date::text AS business_date,
            depth_truncated, requirement_count, exploded_by, correlation_id, source_event_id,
            created_at, updated_at
       FROM bom_explosion WHERE bom_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [bomId, limit, offset],
  );
  return {
    rows: result.rows as BomExplosionRow[],
    total: Number(countResult.rows[0]!.total),
    limit,
    offset,
  };
}
