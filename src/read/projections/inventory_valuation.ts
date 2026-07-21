import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Inventory valuation read models (Story 2.4). Grain is SKU (not sku+location - see
 * read/projections/inventory_valuation.sql for why). `inventory_valuation` is the single
 * authoritative carrying-value row for every valuation_method; the FIFO layer and serial-cost
 * tables exist only to answer "how was this SKU's cost derived" for AC1/AC2/AC5 detail views and
 * to drive FIFO/specific-identification issue costing - the summary row is what NRV mutates and
 * what the API reports as current carrying value.
 */

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function toNumber(value: unknown): number {
  return Number(value);
}

function toNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function cmpMonetary(a: string, b: string): number {
  const aNorm = a.includes('.') ? a : a + '.0';
  const bNorm = b.includes('.') ? b : b + '.0';
  const [aInt, aFrac = ''] = aNorm.split('.');
  const [bInt, bFrac = ''] = bNorm.split('.');
  const aPadded = aInt + (aFrac.padEnd(6, '0').slice(0, 6));
  const bPadded = bInt + (bFrac.padEnd(6, '0').slice(0, 6));
  if (aPadded.length !== bPadded.length) return aPadded.length > bPadded.length ? 1 : -1;
  if (aPadded > bPadded) return 1;
  if (aPadded < bPadded) return -1;
  return 0;
}

export function monToNum(value: string): number {
  return Number(value);
}

// -----------------------------------------------------------------------------------------------
// inventory_valuation (summary row)
// -----------------------------------------------------------------------------------------------

export interface InventoryValuationRow {
  sku: string;
  quantity_on_hand: string;
  running_average_cost: string | null;
  carrying_value: string;
  pre_writedown_cost: string | null;
  cumulative_write_down: string;
  updated_at: string;
}

const VALUATION_COLUMNS = `sku, quantity_on_hand, running_average_cost, carrying_value, pre_writedown_cost, cumulative_write_down, updated_at`;

function mapValuationRow(row: Record<string, unknown>): InventoryValuationRow {
  const updatedAt = row['updated_at'] instanceof Date ? row['updated_at'].toISOString() : String(row['updated_at']);
  return {
    sku: row['sku'] as string,
    quantity_on_hand: String(row['quantity_on_hand']),
    running_average_cost: row['running_average_cost'] !== null ? String(row['running_average_cost']) : null,
    carrying_value: String(row['carrying_value']),
    pre_writedown_cost: row['pre_writedown_cost'] !== null ? String(row['pre_writedown_cost']) : null,
    cumulative_write_down: String(row['cumulative_write_down']),
    updated_at: updatedAt,
  };
}

export async function getInventoryValuation(sku: string, client?: PoolClient): Promise<InventoryValuationRow | null> {
  const result = await runner(client).query(`SELECT ${VALUATION_COLUMNS} FROM inventory_valuation WHERE sku = $1`, [sku]);
  return result.rows.length > 0 ? mapValuationRow(result.rows[0]!) : null;
}

/**
 * Locks (creating if absent) the summary row for `sku` and returns it. Callers that need to
 * compute a value against the CURRENT carrying value under a concurrency-safe lock (NRV
 * write-down/recovery, standard-cost variance review) must call this first, inside their own
 * transaction, before reading `carrying_value`/`pre_writedown_cost`.
 */
export async function lockInventoryValuation(sku: string, client: PoolClient): Promise<InventoryValuationRow> {
  await client.query(
    `INSERT INTO inventory_valuation (sku) VALUES ($1) ON CONFLICT (sku) DO NOTHING`,
    [sku],
  );
  const result = await client.query(`SELECT ${VALUATION_COLUMNS} FROM inventory_valuation WHERE sku = $1 FOR UPDATE`, [sku]);
  return mapValuationRow(result.rows[0]!);
}

/**
 * Additive receipt application (Task 4.1): quantity and carrying_value both increase by
 * quantity*unit_cost, and running_average_cost is recomputed from the new totals in the SAME SQL
 * statement (Dev Notes: weighted average must be SQL-side, never JS floating point). This is
 * applied for every valuation_method on every priced receipt so the summary row's carrying_value
 * always reflects total cost basis, even for FIFO/specific-identification items whose per-unit
 * cost detail lives in the layer/serial tables instead.
 */
export async function applyValuationReceipt(sku: string, quantity: number, unitCost: number, client: PoolClient): Promise<InventoryValuationRow> {
  const result = await client.query(
    `INSERT INTO inventory_valuation (sku, quantity_on_hand, running_average_cost, carrying_value)
     VALUES ($1, $2::numeric, $3::numeric, $2::numeric * $3::numeric)
     ON CONFLICT (sku) DO UPDATE SET
       carrying_value = inventory_valuation.carrying_value + EXCLUDED.carrying_value,
       quantity_on_hand = inventory_valuation.quantity_on_hand + EXCLUDED.quantity_on_hand,
       running_average_cost = CASE
         WHEN inventory_valuation.quantity_on_hand + EXCLUDED.quantity_on_hand = 0 THEN inventory_valuation.running_average_cost
         ELSE (inventory_valuation.carrying_value + EXCLUDED.carrying_value) / (inventory_valuation.quantity_on_hand + EXCLUDED.quantity_on_hand)
       END,
       updated_at = now()
     RETURNING ${VALUATION_COLUMNS}`,
    [sku, quantity, unitCost],
  );
  return mapValuationRow(result.rows[0]!);
}

/**
 * Additive issue application: quantity and carrying_value both decrease by the caller-computed
 * issue cost (already derived from FIFO layers, specific-identification serial cost, or the
 * running weighted average - Task 4). Clamped at zero so a rounding-edge or degraded-cost-basis
 * issue (Dev Notes: a valued item whose receipt omitted unit_cost) cannot drive carrying_value or
 * quantity negative.
 */
export async function applyValuationIssue(sku: string, quantity: number, cost: number, client: PoolClient): Promise<InventoryValuationRow> {
  const result = await client.query(
    `UPDATE inventory_valuation
     SET quantity_on_hand = GREATEST(0, quantity_on_hand - $2::numeric),
         carrying_value = GREATEST(0, carrying_value - $3::numeric),
         updated_at = now()
     WHERE sku = $1
     RETURNING ${VALUATION_COLUMNS}`,
    [sku, quantity, cost],
  );
  return result.rows.length > 0 ? mapValuationRow(result.rows[0]!) : await lockInventoryValuation(sku, client);
}

/**
 * Applies an NRV write-down/recovery as SQL-side deltas (not pre-computed absolute values) so the
 * stored NUMERIC values are exact even though the compliance seam's pre-checks read the row as JS
 * numbers first (Dev Notes: do not accumulate money in JavaScript numbers). `chk_inventory_
 * valuation_recovery_cap` is a second, DB-level line of defense against a recovery that would
 * carry the item above its original cost, independent of the seam's own JS-side comparison.
 */
export async function applyValuationNrvDelta(
  sku: string,
  carryingValueDelta: number,
  newPreWritedownCost: number | null,
  cumulativeWriteDownDelta: number,
  client: PoolClient,
): Promise<InventoryValuationRow> {
  const result = await client.query(
    `UPDATE inventory_valuation
     SET carrying_value = carrying_value + $2::numeric,
         pre_writedown_cost = $3::numeric,
         cumulative_write_down = GREATEST(0, cumulative_write_down + $4::numeric),
         updated_at = now()
     WHERE sku = $1
     RETURNING ${VALUATION_COLUMNS}`,
    [sku, carryingValueDelta, newPreWritedownCost, cumulativeWriteDownDelta],
  );
  return mapValuationRow(result.rows[0]!);
}

// -----------------------------------------------------------------------------------------------
// inventory_valuation_fifo_layer
// -----------------------------------------------------------------------------------------------

export interface FifoLayer {
  layer_id: string;
  sku: string;
  sequence_no: number;
  unit_cost: string;
  original_quantity: string;
  remaining_quantity: string;
  event_id: string | null;
  created_at: string;
}

const FIFO_LAYER_COLUMNS = `layer_id, sku, sequence_no, unit_cost, original_quantity, remaining_quantity, event_id, created_at`;

function mapFifoLayer(row: Record<string, unknown>): FifoLayer {
  const createdAt = row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']);
  return {
    layer_id: row['layer_id'] as string,
    sku: row['sku'] as string,
    sequence_no: Number(row['sequence_no']),
    unit_cost: String(row['unit_cost']),
    original_quantity: String(row['original_quantity']),
    remaining_quantity: String(row['remaining_quantity']),
    event_id: (row['event_id'] as string | null) ?? null,
    created_at: createdAt,
  };
}

export async function insertFifoLayer(
  input: { sku: string; unit_cost: number; quantity: number; event_id?: string | null },
  client: PoolClient,
): Promise<FifoLayer> {
  const result = await client.query(
    `INSERT INTO inventory_valuation_fifo_layer (sku, unit_cost, original_quantity, remaining_quantity, event_id)
     VALUES ($1, $2, $3, $3, $4)
     RETURNING ${FIFO_LAYER_COLUMNS}`,
    [input.sku, input.unit_cost, input.quantity, input.event_id ?? null],
  );
  return mapFifoLayer(result.rows[0]!);
}

/** Locks every layer with remaining stock for `sku`, oldest first, for deterministic FIFO depletion. */
export async function lockOpenFifoLayers(sku: string, client: PoolClient): Promise<FifoLayer[]> {
  const result = await client.query(
    `SELECT ${FIFO_LAYER_COLUMNS} FROM inventory_valuation_fifo_layer
     WHERE sku = $1 AND remaining_quantity > 0
     ORDER BY sequence_no ASC
     FOR UPDATE`,
    [sku],
  );
  return result.rows.map(mapFifoLayer);
}

export async function setFifoLayerRemaining(layerId: string, remainingQuantity: string, client: PoolClient): Promise<void> {
  await client.query(`UPDATE inventory_valuation_fifo_layer SET remaining_quantity = $2 WHERE layer_id = $1`, [layerId, remainingQuantity]);
}

/** Read-only (no lock) listing of open FIFO layers for the valuation detail view - GET routes must not take row locks. */
export async function listOpenFifoLayers(sku: string, client?: PoolClient): Promise<FifoLayer[]> {
  const result = await runner(client).query(
    `SELECT ${FIFO_LAYER_COLUMNS} FROM inventory_valuation_fifo_layer
     WHERE sku = $1 AND remaining_quantity > 0
     ORDER BY sequence_no ASC`,
    [sku],
  );
  return result.rows.map(mapFifoLayer);
}

// -----------------------------------------------------------------------------------------------
// inventory_valuation_serial_cost
// -----------------------------------------------------------------------------------------------

export async function upsertSerialCost(input: { sku: string; serial_number: string; unit_cost: number }, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO inventory_valuation_serial_cost (sku, serial_number, unit_cost)
     VALUES ($1, $2, $3)
     ON CONFLICT (sku, serial_number) DO UPDATE SET unit_cost = EXCLUDED.unit_cost, consumed_at = NULL`,
    [input.sku, input.serial_number, input.unit_cost],
  );
}

/**
 * Locks and marks a serial's cost row consumed (it is no longer on hand once issued - Task 4.4),
 * returning its unit_cost, or null if the serial was never priced or is already consumed. Rows are
 * stamped rather than deleted so received-cost history stays queryable (and app_user needs no
 * DELETE grant on this table).
 */
export async function takeSerialCost(sku: string, serialNumber: string, client: PoolClient): Promise<number | null> {
  const result = await client.query(
    `UPDATE inventory_valuation_serial_cost SET consumed_at = now()
     WHERE sku = $1 AND serial_number = $2 AND consumed_at IS NULL
     RETURNING unit_cost`,
    [sku, serialNumber],
  );
  return result.rows.length > 0 ? toNumber(result.rows[0]!['unit_cost']) : null;
}

/** Sum of unconsumed (still on-hand) serial costs for a specific-identification sku - its carrying value detail. */
export async function sumSerialCosts(sku: string, client?: PoolClient): Promise<number> {
  const result = await runner(client).query(
    `SELECT COALESCE(SUM(unit_cost), 0)::text AS total FROM inventory_valuation_serial_cost WHERE sku = $1 AND consumed_at IS NULL`,
    [sku],
  );
  return toNumber(result.rows[0]!['total']);
}

export async function listSerialCosts(sku: string, client?: PoolClient): Promise<Array<{ serial_number: string; unit_cost: number }>> {
  const result = await runner(client).query(
    `SELECT serial_number, unit_cost FROM inventory_valuation_serial_cost WHERE sku = $1 AND consumed_at IS NULL ORDER BY serial_number`,
    [sku],
  );
  return result.rows.map((row) => ({ serial_number: row['serial_number'] as string, unit_cost: toNumber(row['unit_cost']) }));
}

// -----------------------------------------------------------------------------------------------
// inventory_valuation_nrv_adjustment
// -----------------------------------------------------------------------------------------------

export interface NrvAdjustment {
  adjustment_id: string;
  sku: string;
  adjustment_type: 'write_down' | 'recovery';
  effective_date: string;
  authoriser_actor_id: string;
  original_cost: number;
  carrying_value_before: number;
  carrying_value_after: number;
  amount: number;
  cumulative_write_down_after: number;
  reason: string;
  evidence_ref: string | null;
  event_id: string;
  created_at: string;
}

export interface InsertNrvAdjustmentInput {
  sku: string;
  adjustment_type: 'write_down' | 'recovery';
  effective_date: string;
  authoriser_actor_id: string;
  original_cost: number;
  carrying_value_before: number;
  carrying_value_after: number;
  amount: number;
  cumulative_write_down_after: number;
  reason: string;
  evidence_ref: string | null;
  event_id: string;
}

function mapNrvAdjustment(row: Record<string, unknown>): NrvAdjustment {
  const createdAt = row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']);
  const toDateString = (v: unknown): string => {
    if (v instanceof Date) {
      const y = v.getFullYear();
      const m = String(v.getMonth() + 1).padStart(2, '0');
      const d = String(v.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    return String(v);
  };
  return {
    adjustment_id: row['adjustment_id'] as string,
    sku: row['sku'] as string,
    adjustment_type: row['adjustment_type'] as 'write_down' | 'recovery',
    effective_date: toDateString(row['effective_date']),
    authoriser_actor_id: row['authoriser_actor_id'] as string,
    original_cost: toNumber(row['original_cost']),
    carrying_value_before: toNumber(row['carrying_value_before']),
    carrying_value_after: toNumber(row['carrying_value_after']),
    amount: toNumber(row['amount']),
    cumulative_write_down_after: toNumber(row['cumulative_write_down_after']),
    reason: row['reason'] as string,
    evidence_ref: (row['evidence_ref'] as string | null) ?? null,
    event_id: row['event_id'] as string,
    created_at: createdAt,
  };
}

export async function insertNrvAdjustment(input: InsertNrvAdjustmentInput, client: PoolClient): Promise<NrvAdjustment> {
  const result = await client.query(
    `INSERT INTO inventory_valuation_nrv_adjustment
       (sku, adjustment_type, effective_date, authoriser_actor_id, original_cost, carrying_value_before,
        carrying_value_after, amount, cumulative_write_down_after, reason, evidence_ref, event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING adjustment_id, sku, adjustment_type, effective_date, authoriser_actor_id, original_cost,
       carrying_value_before, carrying_value_after, amount, cumulative_write_down_after, reason, evidence_ref,
       event_id, created_at`,
    [
      input.sku,
      input.adjustment_type,
      input.effective_date,
      input.authoriser_actor_id,
      input.original_cost,
      input.carrying_value_before,
      input.carrying_value_after,
      input.amount,
      input.cumulative_write_down_after,
      input.reason,
      input.evidence_ref,
      input.event_id,
    ],
  );
  return mapNrvAdjustment(result.rows[0]!);
}

export async function listNrvAdjustments(sku: string, client?: PoolClient): Promise<NrvAdjustment[]> {
  const result = await runner(client).query(
    `SELECT adjustment_id, sku, adjustment_type, effective_date, authoriser_actor_id, original_cost,
       carrying_value_before, carrying_value_after, amount, cumulative_write_down_after, reason, evidence_ref,
       event_id, created_at
     FROM inventory_valuation_nrv_adjustment WHERE sku = $1 ORDER BY created_at ASC`,
    [sku],
  );
  return result.rows.map(mapNrvAdjustment);
}

// -----------------------------------------------------------------------------------------------
// inventory_valuation_standard_cost_variance
// -----------------------------------------------------------------------------------------------

export interface StandardCostVarianceRow {
  variance_id: string;
  sku: string;
  period: string;
  standard_cost: number;
  actual_cost: number;
  variance_amount: number;
  variance_percent: number | null;
  tolerance_percent: number | null;
  breached: boolean;
  event_id: string;
  reviewed_at: string;
}

export interface InsertStandardCostVarianceInput {
  sku: string;
  period: string;
  standard_cost: number;
  actual_cost: number;
  variance_amount: number;
  variance_percent: number | null;
  tolerance_percent: number | null;
  breached: boolean;
  event_id: string;
}

function mapStandardCostVariance(row: Record<string, unknown>): StandardCostVarianceRow {
  const reviewedAt = row['reviewed_at'] instanceof Date ? row['reviewed_at'].toISOString() : String(row['reviewed_at']);
  return {
    variance_id: row['variance_id'] as string,
    sku: row['sku'] as string,
    period: row['period'] as string,
    standard_cost: toNumber(row['standard_cost']),
    actual_cost: toNumber(row['actual_cost']),
    variance_amount: toNumber(row['variance_amount']),
    variance_percent: toNumberOrNull(row['variance_percent']),
    tolerance_percent: toNumberOrNull(row['tolerance_percent']),
    breached: row['breached'] as boolean,
    event_id: row['event_id'] as string,
    reviewed_at: reviewedAt,
  };
}

export async function insertStandardCostVarianceReview(input: InsertStandardCostVarianceInput, client: PoolClient): Promise<StandardCostVarianceRow> {
  const result = await client.query(
    `INSERT INTO inventory_valuation_standard_cost_variance
       (sku, period, standard_cost, actual_cost, variance_amount, variance_percent, tolerance_percent, breached, event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING variance_id, sku, period, standard_cost, actual_cost, variance_amount, variance_percent, tolerance_percent, breached, event_id, reviewed_at`,
    [
      input.sku,
      input.period,
      input.standard_cost,
      input.actual_cost,
      input.variance_amount,
      input.variance_percent,
      input.tolerance_percent,
      input.breached,
      input.event_id,
    ],
  );
  return mapStandardCostVariance(result.rows[0]!);
}

export async function getLatestStandardCostVariance(sku: string, client?: PoolClient): Promise<StandardCostVarianceRow | null> {
  const result = await runner(client).query(
    `SELECT variance_id, sku, period, standard_cost, actual_cost, variance_amount, variance_percent, tolerance_percent, breached, event_id, reviewed_at
     FROM inventory_valuation_standard_cost_variance WHERE sku = $1 ORDER BY reviewed_at DESC LIMIT 1`,
    [sku],
  );
  return result.rows.length > 0 ? mapStandardCostVariance(result.rows[0]!) : null;
}

/** Latest review row per SKU, for the period-end variance report (Task 6.4). */
export async function listLatestStandardCostVariancePerSku(client?: PoolClient): Promise<StandardCostVarianceRow[]> {
  const result = await runner(client).query(
    `SELECT DISTINCT ON (sku) variance_id, sku, period, standard_cost, actual_cost, variance_amount, variance_percent, tolerance_percent, breached, event_id, reviewed_at
     FROM inventory_valuation_standard_cost_variance
     ORDER BY sku, reviewed_at DESC`,
  );
  return result.rows.map(mapStandardCostVariance);
}
