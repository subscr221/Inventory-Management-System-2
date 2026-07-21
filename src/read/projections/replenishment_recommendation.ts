import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Replenishment recommendation read model (Story 2.7). Derived from replenishment.recommended domain
 * events by the applyInventoryPlanningProjection compliance seam inside persistEvent. One OPEN
 * recommendation per (sku, location_id) is enforced by the partial unique index
 * uq_replenishment_recommendation_open, so a re-run or concurrent reorder check cannot stack
 * duplicates. Phase-1 emits a recommendation only - never a purchase requisition or PO (Epic 4).
 */

export interface ReplenishmentRecommendationRow {
  recommendation_id: string;
  sku: string;
  location_id: string;
  on_hand_at_check: number;
  reorder_point: number;
  recommended_order_qty: number;
  status: string;
  triggered_at: string;
  source_event_id: string | null;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const COLUMNS = `recommendation_id, sku, location_id, on_hand_at_check, reorder_point,
       recommended_order_qty, status, triggered_at, source_event_id, created_at`;

function ts(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapRow(row: Record<string, unknown>): ReplenishmentRecommendationRow {
  return {
    recommendation_id: row['recommendation_id'] as string,
    sku: row['sku'] as string,
    location_id: row['location_id'] as string,
    on_hand_at_check: Number(row['on_hand_at_check']),
    reorder_point: Number(row['reorder_point']),
    recommended_order_qty: Number(row['recommended_order_qty']),
    status: row['status'] as string,
    triggered_at: ts(row['triggered_at']),
    source_event_id: (row['source_event_id'] as string | null) ?? null,
    created_at: ts(row['created_at']),
  };
}

/**
 * The current OPEN recommendation for a grain, if any. Locks FOR UPDATE when a client is supplied so
 * a concurrent reorder check for the same grain cannot create a second open recommendation.
 */
export async function getOpenRecommendation(
  sku: string,
  locationId: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<ReplenishmentRecommendationRow | null> {
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM replenishment_recommendation
     WHERE sku = $1 AND location_id = $2 AND status = 'open'${forUpdate ? ' FOR UPDATE' : ''}`,
    [sku, locationId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export interface RecommendationFilters {
  location_id?: string | null;
  location_any?: string[] | null;
  sku?: string | null;
  status?: string | null;
}

export async function listRecommendations(filters: RecommendationFilters, client?: PoolClient): Promise<ReplenishmentRecommendationRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (filters.location_id) {
    conditions.push(`location_id = $${i++}`);
    params.push(filters.location_id);
  }
  if (filters.location_any && filters.location_any.length > 0) {
    conditions.push(`location_id = ANY($${i++})`);
    params.push(filters.location_any);
  }
  if (filters.sku) {
    conditions.push(`sku = $${i++}`);
    params.push(filters.sku);
  }
  if (filters.status) {
    conditions.push(`status = $${i++}`);
    params.push(filters.status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM replenishment_recommendation ${where} ORDER BY triggered_at DESC, recommendation_id`,
    params,
  );
  return result.rows.map(mapRow);
}

// ---------------------------------------------------------------------------
// Mutation helpers (transaction-scoped; called only from the compliance seam)
// ---------------------------------------------------------------------------

export interface InsertRecommendationInput {
  recommendation_id: string;
  sku: string;
  location_id: string;
  on_hand_at_check: number | string;
  reorder_point: number | string;
  recommended_order_qty: number | string;
  triggered_at: string;
  source_event_id: string;
}

/**
 * Inserts a new open recommendation. The partial unique index uq_replenishment_recommendation_open
 * is the concurrency backstop: two racing checks that both pass the FOR UPDATE gate cannot both land
 * an open row - the loser raises a 23505 that rolls its transaction back.
 */
export async function insertRecommendation(input: InsertRecommendationInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO replenishment_recommendation (
       recommendation_id, sku, location_id, on_hand_at_check, reorder_point, recommended_order_qty,
       status, triggered_at, source_event_id
     ) VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6::numeric, 'open', $7::timestamptz, $8)`,
    [
      input.recommendation_id,
      input.sku,
      input.location_id,
      String(input.on_hand_at_check),
      String(input.reorder_point),
      String(input.recommended_order_qty),
      input.triggered_at,
      input.source_event_id,
    ],
  );
}
