import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Production order read model (Story 6.1, FR-MO-01/02/03). Derived state only: every row is
 * rebuildable by replaying production_order.* domain events, and mutation happens exclusively
 * through persistEvent, which applies this projection inside the SAME transaction as the
 * domain_events insert. status is the six-state lifecycle machine (planned -> released ->
 * in_process -> completed -> closed, plus planned|released -> cancelled).
 *
 * NUMERIC and DATE columns are read as strings out of pg and never coerced to a JS number - an
 * order quantity is an exact decimal, and the release gate compares it (and the availability sums
 * it meets) in SQL NUMERIC, never in IEEE 754.
 */

export interface ProductionOrderRow {
  production_order_id: string;
  order_number_ext: string;
  output_item_id: string;
  output_sku: string;
  order_quantity: string;
  order_uom: string;
  plant_location_id: string;
  bom_id: string;
  released_revision_id: string | null;
  business_stream: string;
  source_reference_type: string;
  source_reference_id: string;
  status: 'planned' | 'released' | 'in_process' | 'completed' | 'closed' | 'cancelled';
  expediting_flag: boolean;
  override_by: string | null;
  override_reason: string | null;
  released_at: string | null;
  released_by: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  unreversed_transaction_count: number;
  /**
   * Story 6.3 (FR-MO-07/09/10). completed_quantity accumulates the PRIMARY output only; the
   * three short_close_* fields are the FR-MO-09 close-short decision Story 6.4's closure gate
   * reads; the two source_* fields are the FR-MO-10 rework linkage (Binding Decision 9). All are
   * exact decimal strings or nulls, never JS numbers.
   */
  completed_quantity: string;
  scrapped_quantity: string;
  short_close_reason: string | null;
  short_closed_at: string | null;
  short_closed_by: string | null;
  source_rework_event_id: string | null;
  source_lot_id: string | null;
  created_by: string;
  correlation_id: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export type ProductionOrderStatus = ProductionOrderRow['status'];

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mapRow(row: Record<string, unknown>): ProductionOrderRow {
  const iso = (value: unknown): string =>
    value instanceof Date ? value.toISOString() : String(value);
  const isoOrNull = (value: unknown): string | null =>
    value === null || value === undefined ? null : iso(value);
  return {
    production_order_id: row['production_order_id'] as string,
    order_number_ext: row['order_number_ext'] as string,
    output_item_id: row['output_item_id'] as string,
    output_sku: row['output_sku'] as string,
    // pg returns NUMERIC as a string; it stays a string - never Number().
    order_quantity: String(row['order_quantity']),
    order_uom: row['order_uom'] as string,
    plant_location_id: row['plant_location_id'] as string,
    bom_id: row['bom_id'] as string,
    released_revision_id: (row['released_revision_id'] as string | null) ?? null,
    business_stream: row['business_stream'] as string,
    source_reference_type: row['source_reference_type'] as string,
    source_reference_id: row['source_reference_id'] as string,
    status: row['status'] as ProductionOrderRow['status'],
    expediting_flag: row['expediting_flag'] === true,
    override_by: (row['override_by'] as string | null) ?? null,
    override_reason: (row['override_reason'] as string | null) ?? null,
    released_at: isoOrNull(row['released_at']),
    released_by: (row['released_by'] as string | null) ?? null,
    cancelled_at: isoOrNull(row['cancelled_at']),
    cancelled_by: (row['cancelled_by'] as string | null) ?? null,
    unreversed_transaction_count: Number(row['unreversed_transaction_count']),
    completed_quantity: String(row['completed_quantity'] ?? '0'),
    scrapped_quantity: String(row['scrapped_quantity'] ?? '0'),
    short_close_reason: (row['short_close_reason'] as string | null) ?? null,
    short_closed_at: isoOrNull(row['short_closed_at']),
    short_closed_by: (row['short_closed_by'] as string | null) ?? null,
    source_rework_event_id: (row['source_rework_event_id'] as string | null) ?? null,
    source_lot_id: (row['source_lot_id'] as string | null) ?? null,
    created_by: row['created_by'] as string,
    correlation_id: (row['correlation_id'] as string | null) ?? null,
    source_event_id: row['source_event_id'] as string,
    created_at: iso(row['created_at']),
    updated_at: iso(row['updated_at']),
  };
}

const ORDER_COLUMNS = `production_order_id, order_number_ext, output_item_id, output_sku,
       order_quantity, order_uom, plant_location_id, bom_id, released_revision_id,
       business_stream, source_reference_type, source_reference_id, status,
       expediting_flag, override_by, override_reason, released_at, released_by,
       cancelled_at, cancelled_by, unreversed_transaction_count, completed_quantity,
       scrapped_quantity, short_close_reason, short_closed_at, short_closed_by,
       source_rework_event_id, source_lot_id, created_by,
       correlation_id, source_event_id, created_at, updated_at`;

export interface InsertProductionOrderInput {
  production_order_id: string;
  order_number_ext: string;
  output_item_id: string;
  output_sku: string;
  order_quantity: string;
  order_uom: string;
  plant_location_id: string;
  bom_id: string;
  business_stream: string;
  source_reference_type: string;
  source_reference_id: string;
  status: ProductionOrderStatus;
  expediting_flag: boolean;
  override_by: string | null;
  override_reason: string | null;
  released_at: string | null;
  released_by: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  unreversed_transaction_count: number;
  /** Story 6.3 (FR-MO-10): the rework linkage, all-or-nothing and null on an ordinary order. */
  source_rework_event_id?: string | null;
  source_lot_id?: string | null;
  created_by: string;
  correlation_id: string | null;
  source_event_id: string;
  created_at: string;
}

export async function insertProductionOrder(
  input: InsertProductionOrderInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO production_order (
      production_order_id, order_number_ext, output_item_id, output_sku, order_quantity,
      order_uom, plant_location_id, bom_id, business_stream, source_reference_type,
      source_reference_id, status, expediting_flag, override_by, override_reason,
      released_at, released_by, cancelled_at, cancelled_by, unreversed_transaction_count,
      created_by, correlation_id, source_event_id, created_at, source_rework_event_id,
      source_lot_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
    [
      input.production_order_id,
      input.order_number_ext,
      input.output_item_id,
      input.output_sku,
      input.order_quantity,
      input.order_uom,
      input.plant_location_id,
      input.bom_id,
      input.business_stream,
      input.source_reference_type,
      input.source_reference_id,
      input.status,
      input.expediting_flag,
      input.override_by,
      input.override_reason,
      input.released_at,
      input.released_by,
      input.cancelled_at,
      input.cancelled_by,
      input.unreversed_transaction_count,
      input.created_by,
      input.correlation_id,
      input.source_event_id,
      input.created_at,
      input.source_rework_event_id ?? null,
      input.source_lot_id ?? null,
    ],
  );
}

export async function getProductionOrderById(
  orderId: string,
  client?: PoolClient,
): Promise<ProductionOrderRow | null> {
  if (!UUID_REGEX.test(orderId)) return null;
  const result = await runner(client).query(
    `SELECT ${ORDER_COLUMNS} FROM production_order WHERE production_order_id = $1`,
    [orderId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function getProductionOrderByIdForUpdate(
  orderId: string,
  client: PoolClient,
): Promise<ProductionOrderRow | null> {
  if (!UUID_REGEX.test(orderId)) return null;
  const result = await client.query(
    `SELECT ${ORDER_COLUMNS} FROM production_order WHERE production_order_id = $1 FOR UPDATE`,
    [orderId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function getProductionOrderByNumber(
  orderNumberExt: string,
  client?: PoolClient,
): Promise<ProductionOrderRow | null> {
  const result = await runner(client).query(
    `SELECT ${ORDER_COLUMNS} FROM production_order WHERE order_number_ext = $1`,
    [orderNumberExt],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export interface ListProductionOrdersParams {
  status?: ProductionOrderStatus | undefined;
  plantLocationId?: string | undefined;
  outputItemId?: string | undefined;
  businessStream?: string | undefined;
  permittedPlantLocations?: { wildcard: boolean; locations: Set<string> } | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listProductionOrders(
  params: ListProductionOrdersParams,
  client?: PoolClient,
): Promise<ProductionOrderRow[]> {
  const r = runner(client);
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.plantLocationId) {
    if (!UUID_REGEX.test(params.plantLocationId)) return [];
    conditions.push(`plant_location_id = $${idx++}`);
    values.push(params.plantLocationId);
  }
  if (params.outputItemId) {
    if (!UUID_REGEX.test(params.outputItemId)) return [];
    conditions.push(`output_item_id = $${idx++}`);
    values.push(params.outputItemId);
  }
  if (params.businessStream) {
    conditions.push(`business_stream = $${idx++}`);
    values.push(params.businessStream);
  }
  // Location scope (the indents precedent): a plant-scoped role sees only its permitted plants.
  // The wildcard '*' assignment sees everything; a scoped assignment with no permitted plant is an
  // empty result, not an error.
  if (params.permittedPlantLocations && !params.permittedPlantLocations.wildcard) {
    if (params.permittedPlantLocations.locations.size === 0) return [];
    conditions.push(`plant_location_id = ANY($${idx++}::uuid[])`);
    values.push([...params.permittedPlantLocations.locations]);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit =
    Number.isInteger(params.limit) && params.limit! > 0 ? Math.min(params.limit!, 200) : 50;
  const offset = Number.isInteger(params.offset) && params.offset! >= 0 ? params.offset! : 0;
  const result = await r.query(
    `SELECT ${ORDER_COLUMNS} FROM production_order ${where} ORDER BY created_at DESC, production_order_id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows.map(mapRow);
}

export interface UpdateProductionOrderStatePatch {
  status: ProductionOrderStatus;
  released_revision_id?: string | null;
  expediting_flag?: boolean;
  override_by?: string | null;
  override_reason?: string | null;
  released_at?: string | null;
  released_by?: string | null;
  cancelled_at?: string | null;
  cancelled_by?: string | null;
  /** Story 6.3: completion and scrap aggregates, and the close-short decision stamps. */
  completed_quantity?: string;
  scrapped_quantity?: string;
  short_close_reason?: string | null;
  short_closed_at?: string | null;
  short_closed_by?: string | null;
}

export async function updateProductionOrderState(
  orderId: string,
  patch: UpdateProductionOrderStatePatch,
  client: PoolClient,
): Promise<void> {
  const sets: string[] = ['status = $2', 'updated_at = now()'];
  const values: unknown[] = [orderId, patch.status];
  let idx = 3;

  const push = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = $${idx++}`);
  };

  if (patch.released_revision_id !== undefined)
    push('released_revision_id', patch.released_revision_id);
  if (patch.expediting_flag !== undefined) push('expediting_flag', patch.expediting_flag);
  if (patch.override_by !== undefined) push('override_by', patch.override_by);
  if (patch.override_reason !== undefined) push('override_reason', patch.override_reason);
  if (patch.released_at !== undefined) push('released_at', patch.released_at);
  if (patch.released_by !== undefined) push('released_by', patch.released_by);
  if (patch.cancelled_at !== undefined) push('cancelled_at', patch.cancelled_at);
  if (patch.cancelled_by !== undefined) push('cancelled_by', patch.cancelled_by);
  if (patch.completed_quantity !== undefined) push('completed_quantity', patch.completed_quantity);
  if (patch.scrapped_quantity !== undefined) push('scrapped_quantity', patch.scrapped_quantity);
  if (patch.short_close_reason !== undefined) push('short_close_reason', patch.short_close_reason);
  if (patch.short_closed_at !== undefined) push('short_closed_at', patch.short_closed_at);
  if (patch.short_closed_by !== undefined) push('short_closed_by', patch.short_closed_by);

  await client.query(
    `UPDATE production_order SET ${sets.join(', ')} WHERE production_order_id = $1`,
    values,
  );
}

/**
 * Allocates the next human-readable production order number in the MO-YYYY-NNNN format from the
 * production_order_number_seq sequence - server-side only, never client-supplied, never
 * MAX(...)+1 (the race the sequence exists to prevent). NNNN is zero-padded to at least 4 digits
 * and simply grows wider beyond 9999. The MO- prefix is deliberate: PO- already belongs to purchase
 * orders (po_number_seq).
 */
export async function allocateProductionOrderNumber(
  year: number,
  client: PoolClient,
): Promise<string> {
  const result = await client.query(`SELECT nextval('production_order_number_seq') AS n`);
  const n = String(result.rows[0]['n']);
  return `MO-${year}-${n.padStart(4, '0')}`;
}

/**
 * Story 6.3 (FR-MO-10, AC 7): resolves the rework order already raised from a qc.rework_requested
 * event, if any. The check-then-act it backs is closed by uq_production_order_source_rework_event,
 * so the race path returns the same REWORK_ORDER_EXISTS through the 23505 mapping.
 */
export async function getProductionOrderByReworkEventId(
  reworkEventId: string,
  client?: PoolClient,
): Promise<ProductionOrderRow | null> {
  if (!UUID_REGEX.test(reworkEventId)) return null;
  const result = await runner(client).query(
    `SELECT ${ORDER_COLUMNS} FROM production_order WHERE source_rework_event_id = $1`,
    [reworkEventId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}
