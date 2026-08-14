import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { AppError } from '../../middleware/error.js';
import { getCostRollupById, type BomCostRollupRow } from './bom_cost_rollup.js';

/**
 * Story 5.6 cost rollup comparison (FR-B-15, AC 2). A COMPUTED read - there is no
 * bom_cost_rollup_comparison table, following the Story 5.3 where_used_impact.ts precedent: a
 * stored comparison goes stale the moment a new snapshot lands, and the deltas are one query.
 *
 * FR-B-15 compares "across versions or dates", so the two snapshots MAY belong to different
 * revisions of the SAME BOM. A cross-BOM comparison and a self-comparison are both rejected.
 *
 * Every delta is computed in PostgreSQL NUMERIC and returned as an exact decimal string.
 */

export type CostRollupLineDeltaStatus = 'added' | 'removed' | 'changed' | 'unchanged';

export interface CostRollupLineDelta {
  path: string;
  line_no: number;
  component_sku: string | null;
  status: CostRollupLineDeltaStatus;
  base_extended_cost: string | null;
  compare_extended_cost: string | null;
  extended_cost_delta: string;
  base_effective_quantity_per: string | null;
  compare_effective_quantity_per: string | null;
  base_unit_cost: string | null;
  compare_unit_cost: string | null;
}

export interface CostRollupComparison {
  base: BomCostRollupRow;
  compare: BomCostRollupRow;
  total_delta: string;
  line_deltas: CostRollupLineDelta[];
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

interface DeltaRow {
  path: string;
  line_no: number;
  component_sku: string | null;
  status: CostRollupLineDeltaStatus;
  base_extended_cost: string | null;
  compare_extended_cost: string | null;
  extended_cost_delta: string;
  base_effective_quantity_per: string | null;
  compare_effective_quantity_per: string | null;
  base_unit_cost: string | null;
  compare_unit_cost: string | null;
}

/**
 * FULL OUTER JOIN on the (path, line_no) grain: a row present only in the compare snapshot is
 * 'added', present only in the base is 'removed', and a matched pair is 'changed' when any of
 * extended cost, quantity or unit cost differs by exact NUMERIC comparison (IS DISTINCT FROM on
 * NUMERIC, never a JS float or a string compare - '1.50' and '1.5' are the same cost).
 */
const DELTA_SQL = `
SELECT
  COALESCE(c.path, b.path)       AS path,
  COALESCE(c.line_no, b.line_no) AS line_no,
  COALESCE(c.component_sku, b.component_sku) AS component_sku,
  CASE
    WHEN b.rollup_line_id IS NULL THEN 'added'
    WHEN c.rollup_line_id IS NULL THEN 'removed'
    WHEN b.extended_cost IS DISTINCT FROM c.extended_cost
      OR b.effective_quantity_per IS DISTINCT FROM c.effective_quantity_per
      OR b.unit_cost IS DISTINCT FROM c.unit_cost THEN 'changed'
    ELSE 'unchanged'
  END AS status,
  b.extended_cost::text          AS base_extended_cost,
  c.extended_cost::text          AS compare_extended_cost,
  (COALESCE(c.extended_cost, 0) - COALESCE(b.extended_cost, 0))::text AS extended_cost_delta,
  b.effective_quantity_per::text AS base_effective_quantity_per,
  c.effective_quantity_per::text AS compare_effective_quantity_per,
  b.unit_cost::text              AS base_unit_cost,
  c.unit_cost::text              AS compare_unit_cost
FROM (SELECT * FROM bom_cost_rollup_line WHERE rollup_id = $1) b
FULL OUTER JOIN (SELECT * FROM bom_cost_rollup_line WHERE rollup_id = $2) c
  ON c.path = b.path AND c.line_no = b.line_no
ORDER BY string_to_array(substr(COALESCE(c.path, b.path), 2), '/')::int[] ASC,
         COALESCE(c.line_no, b.line_no) ASC
`;

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status = 400,
): never {
  throw new AppError(status, code, message, details);
}

export async function compareCostRollups(
  baseRollupId: string,
  compareRollupId: string,
  client?: PoolClient,
): Promise<CostRollupComparison> {
  const base = await getCostRollupById(baseRollupId, client);
  if (!base) {
    reject(
      'COST_ROLLUP_NOT_FOUND',
      'Base cost rollup snapshot not found',
      {
        rollup_id: baseRollupId,
      },
      404,
    );
  }
  const compare = await getCostRollupById(compareRollupId, client);
  if (!compare) {
    reject(
      'COST_ROLLUP_NOT_FOUND',
      'Comparison cost rollup snapshot not found',
      {
        rollup_id: compareRollupId,
      },
      404,
    );
  }
  if (base.rollup_id === compare.rollup_id) {
    reject('COST_ROLLUP_COMPARE_INVALID', 'A snapshot cannot be compared with itself', {
      rollup_id: base.rollup_id,
    });
  }
  // Different REVISIONS of the same BOM are legitimate (FR-B-15 "across versions"); different
  // BOMs are not - the (path, line_no) grain is only meaningful within one BOM.
  if (base.bom_id !== compare.bom_id) {
    reject('COST_ROLLUP_COMPARE_INVALID', 'Both snapshots must belong to the same BOM', {
      base_bom_id: base.bom_id,
      compare_bom_id: compare.bom_id,
    });
  }

  const r = runner(client);
  const deltaResult = await r.query(DELTA_SQL, [base.rollup_id, compare.rollup_id]);
  const lineDeltas = deltaResult.rows as DeltaRow[];

  const totalResult = await r.query(`SELECT ($2::numeric - $1::numeric)::text AS total_delta`, [
    base.total_cost,
    compare.total_cost,
  ]);

  return {
    base,
    compare,
    total_delta: totalResult.rows[0]!.total_delta as string,
    line_deltas: lineDeltas,
  };
}
