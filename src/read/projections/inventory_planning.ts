import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Inventory planning parameters read model (Story 2.7). Derived from inventory_planning.* domain
 * events by the applyInventoryPlanningProjection compliance seam inside persistEvent. Grain is
 * (sku, location_id) - one config row per SKU-location. Config (lead time, service level,
 * thresholds, standard order qty) is set by inventory_planning.params_set; the computed outputs
 * (safety_stock, reorder_point, avg_daily_demand, demand_std_dev, computation_inputs) are stamped by
 * inventory_planning.safety_stock_computed and are reproducible from computation_inputs.
 *
 * Query-side helpers are used by the API handlers and the batch job cycles; the mutation helpers are
 * transaction-scoped and only called from the seam.
 */

export interface PlanningParamsRow {
  planning_params_id: string;
  sku: string;
  location_id: string;
  lead_time_days: number | null;
  lead_time_source: string | null;
  service_level: number | null;
  avg_daily_demand: number | null;
  demand_std_dev: number | null;
  demand_window_days: number;
  obsolescence_threshold_days: number | null;
  standard_order_qty: number | null;
  safety_stock: number | null;
  reorder_point: number | null;
  last_computed_at: string | null;
  computation_inputs: Record<string, unknown> | null;
  business_stream: string;
  set_by_actor_id: string | null;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const PLANNING_COLUMNS = `planning_params_id, sku, location_id, lead_time_days, lead_time_source,
       service_level, avg_daily_demand, demand_std_dev, demand_window_days, obsolescence_threshold_days,
       standard_order_qty, safety_stock, reorder_point, last_computed_at, computation_inputs,
       business_stream, set_by_actor_id, created_at, updated_at`;

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function ts(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapRow(row: Record<string, unknown>): PlanningParamsRow {
  return {
    planning_params_id: row['planning_params_id'] as string,
    sku: row['sku'] as string,
    location_id: row['location_id'] as string,
    lead_time_days: num(row['lead_time_days']),
    lead_time_source: (row['lead_time_source'] as string | null) ?? null,
    service_level: num(row['service_level']),
    avg_daily_demand: num(row['avg_daily_demand']),
    demand_std_dev: num(row['demand_std_dev']),
    demand_window_days: Number(row['demand_window_days']),
    obsolescence_threshold_days: row['obsolescence_threshold_days'] === null || row['obsolescence_threshold_days'] === undefined
      ? null
      : Number(row['obsolescence_threshold_days']),
    standard_order_qty: num(row['standard_order_qty']),
    safety_stock: num(row['safety_stock']),
    reorder_point: num(row['reorder_point']),
    last_computed_at: ts(row['last_computed_at']),
    computation_inputs: (row['computation_inputs'] as Record<string, unknown> | null) ?? null,
    business_stream: row['business_stream'] as string,
    set_by_actor_id: (row['set_by_actor_id'] as string | null) ?? null,
    created_at: ts(row['created_at']) ?? '',
    updated_at: ts(row['updated_at']) ?? '',
  };
}

/**
 * Get a planning-params row by grain. When `forUpdate` is true a `client` MUST be supplied and the
 * row is locked FOR UPDATE so a concurrent compute/check/scan for the same grain serializes.
 */
export async function getPlanningParams(
  sku: string,
  locationId: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<PlanningParamsRow | null> {
  if (forUpdate && !client) {
    throw new Error('getPlanningParams: forUpdate requires a transaction client');
  }
  const result = await runner(client).query(
    `SELECT ${PLANNING_COLUMNS} FROM inventory_planning_params
     WHERE sku = $1 AND location_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [sku, locationId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export interface PlanningScope {
  location_id?: string | null;
  location_any?: string[] | null;
  sku?: string | null;
}

/** All params rows matching a compute/check/scan scope, deterministically ordered. */
export async function listPlanningParams(scope: PlanningScope, client?: PoolClient): Promise<PlanningParamsRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (scope.location_id) {
    conditions.push(`location_id = $${i++}`);
    params.push(scope.location_id);
  }
  if (scope.location_any && scope.location_any.length > 0) {
    conditions.push(`location_id = ANY($${i++})`);
    params.push(scope.location_any);
  }
  if (scope.sku) {
    conditions.push(`sku = $${i++}`);
    params.push(scope.sku);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await runner(client).query(
    `SELECT ${PLANNING_COLUMNS} FROM inventory_planning_params ${where} ORDER BY sku, location_id`,
    params,
  );
  return result.rows.map(mapRow);
}

// ---------------------------------------------------------------------------
// Mutation helpers (transaction-scoped; called only from the compliance seam)
// ---------------------------------------------------------------------------

export interface UpsertPlanningParamsInput {
  planning_params_id: string;
  sku: string;
  location_id: string;
  lead_time_days?: number | null;
  lead_time_source?: string | null;
  service_level: number;
  obsolescence_threshold_days?: number | null;
  standard_order_qty?: number | null;
  demand_window_days?: number | null;
  business_stream: string;
  set_by_actor_id: string;
}

/**
 * Sets or updates the SKU-location planning config. On conflict the existing row's
 * planning_params_id, computed outputs, and computation_inputs are PRESERVED - only the caller-set
 * config fields change, so a config edit never silently discards a prior valid computation.
 */
export async function upsertPlanningParams(input: UpsertPlanningParamsInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO inventory_planning_params (
       planning_params_id, sku, location_id, lead_time_days, lead_time_source, service_level,
       obsolescence_threshold_days, standard_order_qty, demand_window_days, business_stream, set_by_actor_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 90), $10, $11)
      ON CONFLICT (sku, location_id) DO UPDATE SET
        lead_time_days = CASE WHEN $4::numeric IS NULL THEN inventory_planning_params.lead_time_days ELSE EXCLUDED.lead_time_days END,
        lead_time_source = CASE WHEN $5::text IS NULL THEN inventory_planning_params.lead_time_source ELSE EXCLUDED.lead_time_source END,
        service_level = EXCLUDED.service_level,
        obsolescence_threshold_days = CASE WHEN $7::int IS NULL THEN inventory_planning_params.obsolescence_threshold_days ELSE EXCLUDED.obsolescence_threshold_days END,
        standard_order_qty = CASE WHEN $8::numeric IS NULL THEN inventory_planning_params.standard_order_qty ELSE EXCLUDED.standard_order_qty END,
        demand_window_days = CASE WHEN $9::int IS NULL THEN inventory_planning_params.demand_window_days ELSE EXCLUDED.demand_window_days END,
        business_stream = EXCLUDED.business_stream,
       set_by_actor_id = EXCLUDED.set_by_actor_id,
       updated_at = now()`,
    [
      input.planning_params_id,
      input.sku,
      input.location_id,
      input.lead_time_days,
      input.lead_time_source,
      input.service_level,
      input.obsolescence_threshold_days,
      input.standard_order_qty,
      input.demand_window_days,
      input.business_stream,
      input.set_by_actor_id,
    ],
  );
}

export interface ApplyComputationInput {
  sku: string;
  location_id: string;
  safety_stock: number | string;
  reorder_point: number | string;
  avg_daily_demand: number | string;
  demand_std_dev: number | string;
  computation_inputs: Record<string, unknown>;
  computed_at: string;
}

/** Stamps the computed safety stock, reorder point, demand statistics, and input snapshot. */
export async function applySafetyStockComputation(input: ApplyComputationInput, client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE inventory_planning_params
     SET safety_stock = $3::numeric,
         reorder_point = $4::numeric,
         avg_daily_demand = $5::numeric,
         demand_std_dev = $6::numeric,
         computation_inputs = $7::jsonb,
         last_computed_at = $8::timestamptz,
         updated_at = now()
     WHERE sku = $1 AND location_id = $2`,
    [
      input.sku,
      input.location_id,
      String(input.safety_stock),
      String(input.reorder_point),
      String(input.avg_daily_demand),
      String(input.demand_std_dev),
      JSON.stringify(input.computation_inputs),
      input.computed_at,
    ],
  );
}
