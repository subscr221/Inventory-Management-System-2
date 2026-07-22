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
  /** Story 2.8: 'internal' (owned-stock reorder) or 'vmi_replenishment' (supplier-owned VMI). */
  signal_type: string;
  /** Story 2.8: owner-party supplier code; set only on vmi_replenishment signals. */
  owner_party_code: string | null;
  triggered_at: string;
  source_event_id: string | null;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const COLUMNS = `recommendation_id, sku, location_id, on_hand_at_check, reorder_point,
       recommended_order_qty, status, signal_type, owner_party_code, triggered_at, source_event_id, created_at`;

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
    signal_type: row['signal_type'] as string,
    owner_party_code: (row['owner_party_code'] as string | null) ?? null,
    triggered_at: ts(row['triggered_at']),
    source_event_id: (row['source_event_id'] as string | null) ?? null,
    created_at: ts(row['created_at']),
  };
}

/**
 * The current OPEN recommendation for a grain and signal type, if any. Locks FOR UPDATE when a
 * client is supplied so a concurrent check for the same grain cannot create a second open
 * recommendation. Story 2.8: the open guard is per (sku, location_id, signal_type) - an open
 * internal reorder signal and an open VMI replenishment signal for the same grain coexist.
 */
export async function getOpenRecommendation(
  sku: string,
  locationId: string,
  client?: PoolClient,
  forUpdate = false,
  signalType = 'internal',
): Promise<ReplenishmentRecommendationRow | null> {
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM replenishment_recommendation
     WHERE sku = $1 AND location_id = $2 AND signal_type = $3 AND status = 'open'${forUpdate ? ' FOR UPDATE' : ''}`,
    [sku, locationId, signalType],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export interface RecommendationFilters {
  location_id?: string | null;
  location_any?: string[] | null;
  sku?: string | null;
  status?: string | null;
  /** Story 2.8: filter the queue by signal type ('internal' | 'vmi_replenishment'). */
  signal_type?: string | null;
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
  if (filters.signal_type) {
    conditions.push(`signal_type = $${i++}`);
    params.push(filters.signal_type);
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
  /** Story 2.8: defaults to 'internal'; VMI signals pass 'vmi_replenishment'. */
  signal_type?: string;
  /** Story 2.8: owner-party supplier code; required for vmi_replenishment signals. */
  owner_party_code?: string | null;
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
       status, signal_type, owner_party_code, triggered_at, source_event_id
     ) VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6::numeric, 'open', $7, $8, $9::timestamptz, $10)`,
    [
      input.recommendation_id,
      input.sku,
      input.location_id,
      String(input.on_hand_at_check),
      String(input.reorder_point),
      String(input.recommended_order_qty),
      input.signal_type ?? 'internal',
      input.owner_party_code ?? null,
      input.triggered_at,
      input.source_event_id,
    ],
  );
}
