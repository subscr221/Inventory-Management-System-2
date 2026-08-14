import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 5.6 cost rollup snapshot accessors (FR-B-15). One header row per
 * bom.cost_rollup_snapshotted event plus its costed line rows; prior snapshots are never updated
 * or deleted, so a BOM accumulates a dated history (AC 1).
 *
 * Every cost and quantity is an exact decimal string - the DB columns are NUMERIC and node-pg
 * returns them as strings, never as JS floats.
 */

export interface BomCostRollupRow {
  rollup_id: string;
  bom_id: string;
  revision_id: string;
  rollup_date: string;
  rate_basis: string;
  total_cost: string;
  line_count: number;
  missing_rate_count: number;
  depth_truncated: boolean;
  rolled_up_by: string | null;
  correlation_id: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface BomCostRollupLineRow {
  rollup_line_id: string;
  rollup_id: string;
  depth: number;
  path: string;
  source_bom_id: string | null;
  source_revision_id: string | null;
  bom_line_id: string;
  line_no: number;
  component_item_id: string | null;
  component_sku: string | null;
  effective_quantity_per: string;
  scrap_percent: string | null;
  unit_cost: string | null;
  extended_cost: string;
  rate_missing: boolean;
  via_phantom: boolean;
  has_child_bom: boolean;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// rollup_date::text keeps the contract string type: node-pg would otherwise parse the DATE column
// as a local-midnight Date and shift it one day back in JSON responses on east-of-UTC servers.
const HEADER_COLUMNS = `rollup_id, bom_id, revision_id, rollup_date::text AS rollup_date, rate_basis,
            total_cost, line_count, missing_rate_count, depth_truncated, rolled_up_by,
            correlation_id, source_event_id, created_at, updated_at`;

export async function insertCostRollup(
  row: Omit<BomCostRollupRow, 'created_at' | 'updated_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO bom_cost_rollup (rollup_id, bom_id, revision_id, rollup_date, rate_basis, total_cost, line_count, missing_rate_count, depth_truncated, rolled_up_by, correlation_id, source_event_id)
     VALUES ($1, $2, $3, $4::date, $5, $6::numeric, $7, $8, $9, $10, $11, $12)`,
    [
      row.rollup_id,
      row.bom_id,
      row.revision_id,
      row.rollup_date,
      row.rate_basis,
      row.total_cost,
      row.line_count,
      row.missing_rate_count,
      row.depth_truncated,
      row.rolled_up_by,
      row.correlation_id,
      row.source_event_id,
    ],
  );
}

export async function insertCostRollupLine(
  row: Omit<BomCostRollupLineRow, 'created_at' | 'updated_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO bom_cost_rollup_line (rollup_line_id, rollup_id, depth, path, source_bom_id, source_revision_id, bom_line_id, line_no, component_item_id, component_sku, effective_quantity_per, scrap_percent, unit_cost, extended_cost, rate_missing, via_phantom, has_child_bom, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::numeric, $12::numeric, $13::numeric, $14::numeric, $15, $16, $17, $18)`,
    [
      row.rollup_line_id,
      row.rollup_id,
      row.depth,
      row.path,
      row.source_bom_id,
      row.source_revision_id,
      row.bom_line_id,
      row.line_no,
      row.component_item_id,
      row.component_sku,
      row.effective_quantity_per,
      row.scrap_percent,
      row.unit_cost,
      row.extended_cost,
      row.rate_missing,
      row.via_phantom,
      row.has_child_bom,
      row.source_event_id,
    ],
  );
}

export async function getCostRollupById(
  rollupId: string,
  client?: PoolClient,
): Promise<BomCostRollupRow | null> {
  if (!UUID_REGEX.test(rollupId)) return null;
  const result = await runner(client).query(
    `SELECT ${HEADER_COLUMNS} FROM bom_cost_rollup WHERE rollup_id = $1`,
    [rollupId],
  );
  return (result.rows[0] as BomCostRollupRow) ?? null;
}

export async function getCostRollupLines(
  rollupId: string,
  client?: PoolClient,
): Promise<BomCostRollupLineRow[]> {
  if (!UUID_REGEX.test(rollupId)) return [];
  // path segments are compared numerically, not lexicographically, so '/1/10' sorts after '/1/2'
  // on BOMs with ten or more sibling lines.
  const result = await runner(client).query(
    `SELECT * FROM bom_cost_rollup_line WHERE rollup_id = $1
       ORDER BY string_to_array(substr(path, 2), '/')::int[] ASC, line_no ASC`,
    [rollupId],
  );
  return result.rows as BomCostRollupLineRow[];
}

export async function listCostRollupsByBom(
  bomId: string,
  params: { limit?: number | undefined; offset?: number | undefined },
  client?: PoolClient,
): Promise<{ rows: BomCostRollupRow[]; total: number; limit: number; offset: number }> {
  if (!UUID_REGEX.test(bomId)) return { rows: [], total: 0, limit: 0, offset: 0 };
  const r = runner(client);
  // Integer guard plus clamp (the module's limit/offset discipline): NaN or fractional values
  // would reach LIMIT and die as a raw 500, so non-integers fail closed to the defaults.
  const limitRaw = params.limit ?? 50;
  const offsetRaw = params.offset ?? 0;
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 ? Math.min(limitRaw, 200) : 50;
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  const countResult = await r.query(
    'SELECT COUNT(*) AS total FROM bom_cost_rollup WHERE bom_id = $1',
    [bomId],
  );
  const result = await r.query(
    `SELECT ${HEADER_COLUMNS} FROM bom_cost_rollup WHERE bom_id = $1
       ORDER BY rollup_date DESC, created_at DESC LIMIT $2 OFFSET $3`,
    [bomId, limit, offset],
  );
  return {
    rows: result.rows as BomCostRollupRow[],
    total: Number(countResult.rows[0]!.total),
    limit,
    offset,
  };
}

/**
 * The release-gate predicate's accessor (AC 3): the newest snapshot for the exact
 * (bom_id, revision_id) that has NO missing rates. Staleness is a separate part of the gate
 * condition and is evaluated against bom_line.updated_at by the caller.
 */
export async function getLatestCompleteRollup(
  bomId: string,
  revisionId: string,
  client?: PoolClient,
): Promise<BomCostRollupRow | null> {
  if (!UUID_REGEX.test(bomId) || !UUID_REGEX.test(revisionId)) return null;
  const result = await runner(client).query(
    `SELECT ${HEADER_COLUMNS} FROM bom_cost_rollup
      WHERE bom_id = $1 AND revision_id = $2 AND missing_rate_count = 0
      ORDER BY created_at DESC LIMIT 1`,
    [bomId, revisionId],
  );
  return (result.rows[0] as BomCostRollupRow) ?? null;
}

/** The newest snapshot for a revision regardless of completeness - reject details only. */
export async function getLatestRollup(
  bomId: string,
  revisionId: string,
  client?: PoolClient,
): Promise<BomCostRollupRow | null> {
  if (!UUID_REGEX.test(bomId) || !UUID_REGEX.test(revisionId)) return null;
  const result = await runner(client).query(
    `SELECT ${HEADER_COLUMNS} FROM bom_cost_rollup
      WHERE bom_id = $1 AND revision_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [bomId, revisionId],
  );
  return (result.rows[0] as BomCostRollupRow) ?? null;
}
