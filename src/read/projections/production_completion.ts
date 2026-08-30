import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Production completion read model (Story 6.3, FR-MO-07/09). Derived state only: rows are
 * rebuildable by replaying production_order.completion_posted events, and mutation happens
 * exclusively through persistEvent, which applies this projection inside the SAME transaction as
 * the domain_events insert. The table is append-only - there is no update or delete accessor here
 * because app_user holds no such privilege.
 *
 * The grain is ONE ROW PER OUTPUT LOT: a completion of an order whose released revision carries
 * co-product and by-product lines writes several rows against one source_event_id, each with its
 * own lot and its own Story 8.1 inspection task (AC 3). completion_id is also the
 * source_completion_id handed to the QC gate.
 *
 * NUMERIC columns are read as strings and never coerced to a JS number.
 */

export type ProductionCompletionOutputClass = 'primary' | 'co_product' | 'by_product';

export interface ProductionCompletionRow {
  completion_id: string;
  production_order_id: string;
  output_class: ProductionCompletionOutputClass;
  bom_line_id: string | null;
  output_item_id: string;
  output_sku: string;
  lot_id: string;
  lot_number: string;
  /** Exact decimal string (NUMERIC(18,6)); never a JS number. */
  quantity: string;
  uom: string;
  qc_task_id: string;
  plant_location_id: string;
  business_date: string;
  over_completion_approved: boolean;
  approved_by: string | null;
  completed_by: string;
  completed_at: string;
  source_event_id: string;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COMPLETION_COLUMNS = `completion_id, production_order_id, output_class, bom_line_id,
       output_item_id, output_sku, lot_id, lot_number, quantity, uom, qc_task_id,
       plant_location_id, business_date, over_completion_approved, approved_by, completed_by,
       completed_at, source_event_id, created_at`;

function mapRow(row: Record<string, unknown>): ProductionCompletionRow {
  const iso = (value: unknown): string =>
    value instanceof Date ? value.toISOString() : String(value);
  const day = (value: unknown): string =>
    value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  return {
    completion_id: row['completion_id'] as string,
    production_order_id: row['production_order_id'] as string,
    output_class: row['output_class'] as ProductionCompletionOutputClass,
    bom_line_id: (row['bom_line_id'] as string | null) ?? null,
    output_item_id: row['output_item_id'] as string,
    output_sku: row['output_sku'] as string,
    lot_id: row['lot_id'] as string,
    lot_number: row['lot_number'] as string,
    // pg returns NUMERIC as a string; it stays a string - never Number().
    quantity: String(row['quantity']),
    uom: row['uom'] as string,
    qc_task_id: row['qc_task_id'] as string,
    plant_location_id: row['plant_location_id'] as string,
    business_date: day(row['business_date']),
    over_completion_approved: row['over_completion_approved'] === true,
    approved_by: (row['approved_by'] as string | null) ?? null,
    completed_by: row['completed_by'] as string,
    completed_at: iso(row['completed_at']),
    source_event_id: row['source_event_id'] as string,
    created_at: iso(row['created_at']),
  };
}

export interface InsertProductionCompletionInput {
  completion_id: string;
  production_order_id: string;
  output_class: ProductionCompletionOutputClass;
  bom_line_id: string | null;
  output_item_id: string;
  output_sku: string;
  lot_id: string;
  lot_number: string;
  quantity: string;
  uom: string;
  qc_task_id: string;
  plant_location_id: string;
  business_date: string;
  over_completion_approved: boolean;
  approved_by: string | null;
  completed_by: string;
  completed_at: string;
  source_event_id: string;
}

export async function insertProductionCompletion(
  input: InsertProductionCompletionInput,
  client: PoolClient,
): Promise<ProductionCompletionRow> {
  const result = await client.query(
    `INSERT INTO production_completion (
      completion_id, production_order_id, output_class, bom_line_id, output_item_id, output_sku,
      lot_id, lot_number, quantity, uom, qc_task_id, plant_location_id, business_date,
      over_completion_approved, approved_by, completed_by, completed_at, source_event_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    RETURNING ${COMPLETION_COLUMNS}`,
    [
      input.completion_id,
      input.production_order_id,
      input.output_class,
      input.bom_line_id,
      input.output_item_id,
      input.output_sku,
      input.lot_id,
      input.lot_number,
      input.quantity,
      input.uom,
      input.qc_task_id,
      input.plant_location_id,
      input.business_date,
      input.over_completion_approved,
      input.approved_by,
      input.completed_by,
      input.completed_at,
      input.source_event_id,
    ],
  );
  return mapRow(result.rows[0]!);
}

export async function getCompletionByLotId(
  lotId: string,
  client?: PoolClient,
): Promise<ProductionCompletionRow | null> {
  if (!UUID_REGEX.test(lotId)) return null;
  const result = await runner(client).query(
    `SELECT ${COMPLETION_COLUMNS} FROM production_completion WHERE lot_id = $1`,
    [lotId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export interface ListCompletionsByOrderParams {
  orderId: string;
  limit?: number | undefined;
  offset?: number | undefined;
  client?: PoolClient;
}

export async function listCompletionsByOrder(
  params: ListCompletionsByOrderParams,
): Promise<ProductionCompletionRow[]> {
  const limit =
    Number.isInteger(params.limit) && params.limit! > 0 ? Math.min(params.limit!, 200) : 50;
  const offset = Number.isInteger(params.offset) && params.offset! >= 0 ? params.offset! : 0;
  const result = await runner(params.client).query(
    `SELECT ${COMPLETION_COLUMNS} FROM production_completion
      WHERE production_order_id = $1
      ORDER BY created_at ASC, completion_id ASC
      LIMIT $2 OFFSET $3`,
    [params.orderId, limit, offset],
  );
  return result.rows.map(mapRow);
}

/**
 * The cumulative PRIMARY output of an order, settled in SQL NUMERIC. Co-products and by-products
 * are separate outputs and never count toward the ordered quantity, so the tolerance ceiling and
 * the short floor of FR-MO-09 are both measured against this number and never against the sum of
 * every completion row.
 */
export async function getCompletedPrimaryQuantity(
  orderId: string,
  client: PoolClient,
): Promise<string> {
  const result = await client.query(
    `SELECT COALESCE(SUM(quantity), 0)::text AS completed
       FROM production_completion
      WHERE production_order_id = $1 AND output_class = 'primary'`,
    [orderId],
  );
  return String(result.rows[0]!['completed']);
}

/** The per-order output-lot sequence used to mint `{order_number_ext}-L{n}` under the order lock. */
export async function getOutputLotSequence(orderId: string, client: PoolClient): Promise<number> {
  const result = await client.query(
    `SELECT COUNT(*)::int AS n FROM production_completion WHERE production_order_id = $1`,
    [orderId],
  );
  return Number(result.rows[0]!['n']);
}
