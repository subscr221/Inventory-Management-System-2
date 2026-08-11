import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { config } from '../../config/index.js';
import { getEcoById, getEcoChangeLines } from './eco.js';
import { getBomLineById } from './bom.js';
import { getStockBalancesBySku, type StockBalance } from './stock_balance.js';
import { getOpenPurchaseOrderLinesBySkus, type OpenPoLineImpactRow } from './erp_purchase_order.js';

/**
 * Where-used and impact analysis (Story 5.3, AC 2). Follows the release_gate_checklist.ts
 * precedent exactly: a COMPUTED read over bom_line/bom/stock_balance/erp_purchase_order, no
 * stored table, no migration entry - a stored impact graph goes stale the instant stock moves or
 * a PO closes, and the approver must see truth at approval time.
 *
 * Reads bom_line, NOT bom_structure: bom_structure has never been populated by any applier
 * (Story 5.1 debt, confirmed still open at baseline) and reading it would silently report "no
 * impact". The upward walk is depth-capped at config.bom.maxDepth and reports depth_truncated
 * rather than recursing unbounded - Story 5.1 left BOM_CYCLE_DETECTED unimplemented, so a cyclic
 * BOM structure is reachable data.
 */

export interface AffectedBomRow {
  bom_id: string;
  parent_sku: string;
  status: string;
  depth: number;
  via_component_sku: string;
}

export interface EcoImpact {
  eco_id: string;
  affected_boms: AffectedBomRow[];
  stock_impact: StockBalance[];
  open_po_impact: OpenPoLineImpactRow[];
  open_production_order_impact: never[];
  production_order_source: { available: false; registers_with: 'Epic 6' };
  depth_truncated: boolean;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Affected components (Dev Notes, binding): the distinct component_item_id set touched by the
 * ECO's eco_change_line rows (resolved via target_bom_line_id for amend/retire, since those rows
 * do not carry component_item_id themselves) plus the BOM's own parent_item_id.
 */
async function getAffectedComponentItemIds(
  ecoId: string,
  bomParentItemId: string,
  client?: PoolClient,
): Promise<Set<string>> {
  const affected = new Set<string>([bomParentItemId]);
  const changeLines = await getEcoChangeLines(ecoId, client);
  for (const change of changeLines) {
    if (change.component_item_id) {
      affected.add(change.component_item_id);
      continue;
    }
    if (change.target_bom_line_id) {
      const targetLine = await getBomLineById(change.target_bom_line_id, client);
      if (targetLine) affected.add(targetLine.component_item_id);
    }
  }
  return affected;
}

export async function getEcoImpact(ecoId: string, client?: PoolClient): Promise<EcoImpact | null> {
  if (!UUID_REGEX.test(ecoId)) return null;
  const r = runner(client);

  const eco = await getEcoById(ecoId, client);
  if (!eco) return null;

  const bomResult = await r.query('SELECT parent_item_id, parent_sku FROM bom WHERE bom_id = $1', [
    eco.bom_id,
  ]);
  if (bomResult.rows.length === 0) return null;
  const bomParentItemId = bomResult.rows[0]!.parent_item_id as string;
  const bomParentSku = bomResult.rows[0]!.parent_sku as string;

  const affectedComponentIds = await getAffectedComponentItemIds(ecoId, bomParentItemId, client);
  const maxDepth = config.bom.maxDepth;

  const ancestryResult = await r.query(
    `WITH RECURSIVE ancestry AS (
       SELECT bl.bom_id, b.parent_item_id, b.parent_sku, b.status, 0 AS depth,
              im.sku AS via_component_sku
         FROM bom_line bl
         JOIN bom b ON b.bom_id = bl.bom_id AND b.current_revision_id = bl.revision_id
         JOIN item_master im ON im.item_id = bl.component_item_id
        WHERE bl.component_item_id = ANY($1::uuid[])
          AND b.status <> 'obsolete'
          AND (bl.effective_to IS NULL OR bl.effective_to >= CURRENT_DATE)
       UNION ALL
       SELECT bl2.bom_id, b2.parent_item_id, b2.parent_sku, b2.status, a.depth + 1,
              pim.sku AS via_component_sku
         FROM ancestry a
         JOIN item_master pim ON pim.item_id = a.parent_item_id
         JOIN bom_line bl2 ON bl2.component_item_id = a.parent_item_id
         JOIN bom b2 ON b2.bom_id = bl2.bom_id AND b2.current_revision_id = bl2.revision_id
        WHERE a.depth < $2
          AND b2.status <> 'obsolete'
          AND (bl2.effective_to IS NULL OR bl2.effective_to >= CURRENT_DATE)
     ) CYCLE bom_id, parent_item_id SET is_cycle TO true DEFAULT false USING path
     SELECT DISTINCT bom_id, parent_item_id, parent_sku, status, depth, via_component_sku
       FROM ancestry
      WHERE NOT is_cycle
      ORDER BY depth, parent_sku`,
    [Array.from(affectedComponentIds), maxDepth],
  );

  const affectedBoms: AffectedBomRow[] = ancestryResult.rows.map((row) => ({
    bom_id: row.bom_id as string,
    parent_sku: row.parent_sku as string,
    status: row.status as string,
    depth: Number(row.depth),
    via_component_sku: row.via_component_sku as string,
  }));

  // Truncation check: would the walk have continued past maxDepth? Look for a bom_line whose
  // component_item_id matches a parent_item_id reached at the deepest permitted depth.
  let depthTruncated = false;
  const deepestItemIds = ancestryResult.rows
    .filter((row) => Number(row.depth) === maxDepth)
    .map((row) => row.parent_item_id as string);
  if (deepestItemIds.length > 0) {
    const truncationCheck = await r.query(
      `SELECT 1 FROM bom_line WHERE component_item_id = ANY($1::uuid[]) LIMIT 1`,
      [deepestItemIds],
    );
    depthTruncated = truncationCheck.rows.length > 0;
  }

  const affectedSkus = new Set<string>([bomParentSku]);
  for (const bom of affectedBoms) affectedSkus.add(bom.via_component_sku);
  // Also resolve the affected component skus directly (covers components with no upward parent).
  const componentSkuResult = await r.query(
    `SELECT sku FROM item_master WHERE item_id = ANY($1::uuid[])`,
    [Array.from(affectedComponentIds)],
  );
  for (const row of componentSkuResult.rows) affectedSkus.add(row.sku as string);

  const stockImpact: StockBalance[] = [];
  for (const sku of affectedSkus) {
    stockImpact.push(...(await getStockBalancesBySku(sku, client)));
  }

  const openPoImpact = await getOpenPurchaseOrderLinesBySkus(Array.from(affectedSkus), client);

  return {
    eco_id: ecoId,
    affected_boms: affectedBoms,
    stock_impact: stockImpact,
    open_po_impact: openPoImpact,
    open_production_order_impact: [],
    production_order_source: { available: false, registers_with: 'Epic 6' },
    depth_truncated: depthTruncated,
  };
}
