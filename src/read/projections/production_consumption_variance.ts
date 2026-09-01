import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Consumption variance read model (Story 6.4, FR-B-08). Derived state only: rows are rebuildable by
 * replaying the production_order.state_changed event that closed the order, and mutation happens
 * exclusively through persistEvent, which applies this projection inside the SAME transaction as
 * the domain_events insert. The table is append-only - there is no update or delete accessor here
 * because app_user holds no such privilege.
 *
 * NUMERIC columns are read as strings and never coerced to a JS number; every derived figure
 * (variance quantity, variance percent, implied scrap percent) is computed in SQL NUMERIC on the
 * way in, so no arithmetic in this module ever passes through IEEE 754.
 */

export type ProductionSupplyMethod = 'directed_issue' | 'backflush';

export interface ProductionConsumptionVarianceRow {
  variance_id: string;
  production_order_id: string;
  bom_line_id: string;
  component_item_id: string;
  component_sku: string;
  supply_method: ProductionSupplyMethod;
  /** The primary output quantity the expectation was computed at. Exact decimal string. */
  basis_quantity: string;
  /** The BOM requirement INCLUDING its scrap allowance. Exact decimal string. */
  expected_quantity: string;
  /** The same requirement with NO scrap allowance. Exact decimal string. */
  expected_base_quantity: string;
  /** Net consumption from the WIP ledger (issues + backflush - returns). Exact decimal string. */
  actual_quantity: string;
  /** actual - expected. Exact decimal string; negative when the run under-consumed. */
  variance_quantity: string;
  /** (actual - expected) / expected * 100, or null when expected is zero. */
  variance_percent: string | null;
  /** The scrap percent the BOM line declared, or null when the line declared none. */
  bom_scrap_percent: string | null;
  /**
   * The FR-B-08 recalibration signal: (actual / expected_base - 1) * 100, i.e. the scrap percent
   * this run actually exhibited. Null when the zero-scrap basis is zero.
   */
  implied_scrap_percent: string | null;
  tolerance_percent: string;
  tolerance_breached: boolean;
  revision_id: string;
  source_event_id: string;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VARIANCE_COLUMNS = `variance_id, production_order_id, bom_line_id, component_item_id,
       component_sku, supply_method, basis_quantity::text AS basis_quantity,
       expected_quantity::text AS expected_quantity,
       expected_base_quantity::text AS expected_base_quantity,
       actual_quantity::text AS actual_quantity,
       variance_quantity::text AS variance_quantity,
       variance_percent::text AS variance_percent,
       bom_scrap_percent::text AS bom_scrap_percent,
       implied_scrap_percent::text AS implied_scrap_percent,
       tolerance_percent::text AS tolerance_percent, tolerance_breached, revision_id,
       source_event_id, created_at`;

function mapRow(row: Record<string, unknown>): ProductionConsumptionVarianceRow {
  const iso = (value: unknown): string =>
    value instanceof Date ? value.toISOString() : String(value);
  const nullableDecimal = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);
  return {
    variance_id: row['variance_id'] as string,
    production_order_id: row['production_order_id'] as string,
    bom_line_id: row['bom_line_id'] as string,
    component_item_id: row['component_item_id'] as string,
    component_sku: row['component_sku'] as string,
    supply_method: row['supply_method'] as ProductionSupplyMethod,
    // pg returns NUMERIC as a string; it stays a string - never Number().
    basis_quantity: String(row['basis_quantity']),
    expected_quantity: String(row['expected_quantity']),
    expected_base_quantity: String(row['expected_base_quantity']),
    actual_quantity: String(row['actual_quantity']),
    variance_quantity: String(row['variance_quantity']),
    variance_percent: nullableDecimal(row['variance_percent']),
    bom_scrap_percent: nullableDecimal(row['bom_scrap_percent']),
    implied_scrap_percent: nullableDecimal(row['implied_scrap_percent']),
    tolerance_percent: String(row['tolerance_percent']),
    tolerance_breached: row['tolerance_breached'] === true,
    revision_id: row['revision_id'] as string,
    source_event_id: row['source_event_id'] as string,
    created_at: iso(row['created_at']),
  };
}

export interface InsertConsumptionVarianceInput {
  variance_id: string;
  production_order_id: string;
  bom_line_id: string;
  component_item_id: string;
  component_sku: string;
  supply_method: ProductionSupplyMethod;
  basis_quantity: string;
  expected_quantity: string;
  expected_base_quantity: string;
  actual_quantity: string;
  bom_scrap_percent: string | null;
  tolerance_percent: string;
  revision_id: string;
  source_event_id: string;
}

/**
 * Writes one variance line. variance_quantity, variance_percent, implied_scrap_percent and
 * tolerance_breached are ALL derived in SQL NUMERIC from the four quantities and the tolerance -
 * they are never accepted from a caller, so a forged closure payload cannot claim a line is within
 * tolerance when it is not. The percent divisions are guarded with NULLIF: a zero expectation
 * yields null rather than a division error, and the breach decision then falls back to "any
 * consumption at all against a zero expectation is a breach".
 */
export async function insertConsumptionVariance(
  input: InsertConsumptionVarianceInput,
  client: PoolClient,
): Promise<ProductionConsumptionVarianceRow> {
  const result = await client.query(
    `INSERT INTO production_consumption_variance (
      variance_id, production_order_id, bom_line_id, component_item_id, component_sku,
      supply_method, basis_quantity, expected_quantity, expected_base_quantity, actual_quantity,
      variance_quantity, variance_percent, bom_scrap_percent, implied_scrap_percent,
      tolerance_percent, tolerance_breached, revision_id, source_event_id
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9::numeric, $10::numeric,
      ($10::numeric - $8::numeric),
      ROUND((($10::numeric - $8::numeric) / NULLIF($8::numeric, 0)) * 100, 4),
      $11::numeric,
      ROUND((($10::numeric / NULLIF($9::numeric, 0)) - 1) * 100, 4),
      $12::numeric,
      CASE
        WHEN $8::numeric = 0 THEN $10::numeric > 0
        ELSE ABS((($10::numeric - $8::numeric) / $8::numeric) * 100) > $12::numeric
      END,
      $13, $14
    )
    RETURNING ${VARIANCE_COLUMNS}`,
    [
      input.variance_id,
      input.production_order_id,
      input.bom_line_id,
      input.component_item_id,
      input.component_sku,
      input.supply_method,
      input.basis_quantity,
      input.expected_quantity,
      input.expected_base_quantity,
      input.actual_quantity,
      input.bom_scrap_percent,
      input.tolerance_percent,
      input.revision_id,
      input.source_event_id,
    ],
  );
  return mapRow(result.rows[0]!);
}

export async function listConsumptionVarianceByOrder(
  orderId: string,
  client?: PoolClient,
): Promise<ProductionConsumptionVarianceRow[]> {
  if (!UUID_REGEX.test(orderId)) return [];
  const result = await runner(client).query(
    `SELECT ${VARIANCE_COLUMNS} FROM production_consumption_variance
      WHERE production_order_id = $1
      ORDER BY tolerance_breached DESC, component_sku ASC, bom_line_id ASC`,
    [orderId],
  );
  return result.rows.map(mapRow);
}
