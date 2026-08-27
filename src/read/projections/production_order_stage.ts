import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Production order staging read model (Story 6.2, FR-MO-04). Derived state only: every row is
 * rebuildable by replaying production_order.material_staged / production_order.material_issued
 * domain events, and mutation happens exclusively through persistEvent, which applies this
 * projection inside the SAME transaction as the domain_events insert. One row per
 * (production_order_id, bom_line_id) directed-issue requirement line; the UNIQUE grain is the
 * replay/duplicate guard.
 *
 * NUMERIC columns are read as strings out of pg and never coerced to a JS number - required and
 * issued quantities are exact decimals compared in SQL NUMERIC, never in IEEE 754.
 */

export interface ProductionOrderStageRow {
  stage_id: string;
  production_order_id: string;
  bom_line_id: string;
  component_item_id: string;
  component_sku: string;
  supply_method: 'directed_issue';
  /** Exact decimal string (NUMERIC(18,6)); never a JS number. */
  required_quantity: string;
  /** Exact decimal string (NUMERIC(18,6)); never a JS number. */
  issued_quantity: string;
  status: 'allocated' | 'issued';
  source_location_id: string;
  lot_number: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STAGE_COLUMNS = `stage_id, production_order_id, bom_line_id, component_item_id, component_sku,
       supply_method, required_quantity, issued_quantity, status, source_location_id, lot_number,
       source_event_id, created_at, updated_at`;

function mapRow(row: Record<string, unknown>): ProductionOrderStageRow {
  const iso = (value: unknown): string =>
    value instanceof Date ? value.toISOString() : String(value);
  return {
    stage_id: row['stage_id'] as string,
    production_order_id: row['production_order_id'] as string,
    bom_line_id: row['bom_line_id'] as string,
    component_item_id: row['component_item_id'] as string,
    component_sku: row['component_sku'] as string,
    supply_method: row['supply_method'] as ProductionOrderStageRow['supply_method'],
    // pg returns NUMERIC as a string; it stays a string - never Number().
    required_quantity: String(row['required_quantity']),
    issued_quantity: String(row['issued_quantity']),
    status: row['status'] as ProductionOrderStageRow['status'],
    source_location_id: row['source_location_id'] as string,
    lot_number: (row['lot_number'] as string | null) ?? null,
    source_event_id: row['source_event_id'] as string,
    created_at: iso(row['created_at']),
    updated_at: iso(row['updated_at']),
  };
}

export interface InsertProductionOrderStageInput {
  stage_id: string;
  production_order_id: string;
  bom_line_id: string;
  component_item_id: string;
  component_sku: string;
  supply_method: 'directed_issue';
  required_quantity: string;
  issued_quantity: string;
  status: 'allocated';
  source_location_id: string;
  lot_number: string | null;
  source_event_id: string;
  created_at: string;
}

export async function insertProductionOrderStage(
  input: InsertProductionOrderStageInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO production_order_stage (
      stage_id, production_order_id, bom_line_id, component_item_id, component_sku,
      supply_method, required_quantity, issued_quantity, status, source_location_id,
      lot_number, source_event_id, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      input.stage_id,
      input.production_order_id,
      input.bom_line_id,
      input.component_item_id,
      input.component_sku,
      input.supply_method,
      input.required_quantity,
      input.issued_quantity,
      input.status,
      input.source_location_id,
      input.lot_number,
      input.source_event_id,
      input.created_at,
    ],
  );
}

export async function getStageById(
  stageId: string,
  client?: PoolClient,
): Promise<ProductionOrderStageRow | null> {
  if (!UUID_REGEX.test(stageId)) return null;
  const result = await runner(client).query(
    `SELECT ${STAGE_COLUMNS} FROM production_order_stage WHERE stage_id = $1`,
    [stageId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function getStageByIdForUpdate(
  stageId: string,
  client: PoolClient,
): Promise<ProductionOrderStageRow | null> {
  if (!UUID_REGEX.test(stageId)) return null;
  const result = await client.query(
    `SELECT ${STAGE_COLUMNS} FROM production_order_stage WHERE stage_id = $1 FOR UPDATE`,
    [stageId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function listStagesByOrder(
  orderId: string,
  client?: PoolClient,
): Promise<ProductionOrderStageRow[]> {
  const result = await runner(client).query(
    `SELECT ${STAGE_COLUMNS} FROM production_order_stage
      WHERE production_order_id = $1 ORDER BY created_at ASC, stage_id ASC`,
    [orderId],
  );
  return result.rows.map(mapRow);
}

export async function getStageByOrderAndBomLine(
  orderId: string,
  bomLineId: string,
  client?: PoolClient,
): Promise<ProductionOrderStageRow | null> {
  if (!UUID_REGEX.test(orderId) || !UUID_REGEX.test(bomLineId)) return null;
  const result = await runner(client).query(
    `SELECT ${STAGE_COLUMNS} FROM production_order_stage
      WHERE production_order_id = $1 AND bom_line_id = $2`,
    [orderId, bomLineId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

/**
 * Adds the issued quantity and flips the stage to 'issued' when the cumulative issued quantity
 * reaches the required quantity - both settled in SQL NUMERIC, never in JS. Partial issues stay
 * 'allocated'; the DB CHECK (issued_quantity <= required_quantity) backstops the bound. Runs on
 * the caller's locked stage row inside the persist transaction.
 */
export async function applyStageIssuedQuantity(
  stageId: string,
  quantity: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE production_order_stage
        SET issued_quantity = issued_quantity + $2::numeric,
            status = CASE
              WHEN issued_quantity + $2::numeric >= required_quantity THEN 'issued'
              ELSE status
            END,
            updated_at = now()
      WHERE stage_id = $1`,
    [stageId, quantity],
  );
}

/**
 * The 23505 resolver for the UNIQUE (production_order_id, bom_line_id) staging grain: two
 * concurrent stagings of the same line resolve to one winner, and the loser is told exactly which
 * stage holds the grain (the Story 7.2 lesson: race path and sequential path return the SAME code
 * and the SAME detail). A multi-line staging event can collide on a LATER declared line while an
 * earlier one was new, so every declared line's grain is checked and the FIRST colliding line is
 * reported (the code-review fix) - never a blanket lines[0] attribution. Resolves against the pool
 * - the calling transaction is aborted when a 23505 fires, so a fresh connection is required.
 */
export async function resolveProductionOrderStageLineDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const productionOrderId =
    typeof payload['production_order_id'] === 'string' ? payload['production_order_id'] : null;
  const lines = Array.isArray(payload['lines'])
    ? (payload['lines'] as Record<string, unknown>[])
    : [];
  for (const line of lines) {
    if (typeof line?.['bom_line_id'] !== 'string') continue;
    const bomLineId = line['bom_line_id'];
    if (productionOrderId !== null) {
      const existing = await getStageByOrderAndBomLine(productionOrderId, bomLineId);
      if (existing) {
        return {
          production_order_id: productionOrderId,
          bom_line_id: bomLineId,
          existing_stage_id: existing.stage_id,
          existing_status: existing.status,
        };
      }
    }
  }
  return {
    production_order_id: productionOrderId,
    bom_line_id:
      typeof lines[0]?.['bom_line_id'] === 'string' ? (lines[0]!['bom_line_id'] as string) : null,
  };
}
