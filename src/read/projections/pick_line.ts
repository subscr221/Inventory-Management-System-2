import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Pick line projection accessor (Story 3.6). One row per directed lot within a pick task.
 * directed_lot_id/confirmed_lot_id are lot_master.lot_id UUIDs (NOT lot_number - the
 * stock_balance.lot_id TEXT column carries lot_number; callers bridge via lot_master).
 * Quantities are bound/returned as NUMERIC strings, never JS floats.
 */
export interface PickLine {
  pick_line_id: string;
  pick_task_id: string;
  dispatch_order_line_id: string;
  sku: string;
  directed_lot_id: string;
  confirmed_lot_id: string | null;
  directed_quantity: string;
  confirmed_quantity: string | null;
  location_id: string;
  pick_sequence: number;
  status: 'pending' | 'confirmed' | 'cancelled' | 'substituted';
  override_reason: string | null;
  capture_method: 'PWA' | 'PAPER' | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatePickLineInput {
  pick_line_id: string;
  pick_task_id: string;
  dispatch_order_line_id: string;
  sku: string;
  directed_lot_id: string;
  directed_quantity: string;
  location_id: string;
  pick_sequence: number;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function ts(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

const PICK_LINE_COLUMNS = `pick_line_id, pick_task_id, dispatch_order_line_id, sku, directed_lot_id,
       confirmed_lot_id, directed_quantity::text AS directed_quantity,
       confirmed_quantity::text AS confirmed_quantity, location_id, pick_sequence, status,
       override_reason, capture_method, confirmed_by, confirmed_at, created_at, updated_at`;

function mapRow(row: Record<string, unknown>): PickLine {
  return {
    pick_line_id: row['pick_line_id'] as string,
    pick_task_id: row['pick_task_id'] as string,
    dispatch_order_line_id: row['dispatch_order_line_id'] as string,
    sku: row['sku'] as string,
    directed_lot_id: row['directed_lot_id'] as string,
    confirmed_lot_id: (row['confirmed_lot_id'] as string | null) ?? null,
    directed_quantity: String(row['directed_quantity']),
    confirmed_quantity: row['confirmed_quantity'] === null || row['confirmed_quantity'] === undefined ? null : String(row['confirmed_quantity']),
    location_id: row['location_id'] as string,
    pick_sequence: Number(row['pick_sequence']),
    status: row['status'] as PickLine['status'],
    override_reason: (row['override_reason'] as string | null) ?? null,
    capture_method: (row['capture_method'] as 'PWA' | 'PAPER' | null) ?? null,
    confirmed_by: (row['confirmed_by'] as string | null) ?? null,
    confirmed_at: row['confirmed_at'] ? ts(row['confirmed_at']) : null,
    created_at: ts(row['created_at']),
    updated_at: ts(row['updated_at']),
  };
}

export async function getPickLineById(pickLineId: string, client?: PoolClient): Promise<PickLine | null> {
  const result = await runner(client).query(`SELECT ${PICK_LINE_COLUMNS} FROM pick_line WHERE pick_line_id = $1`, [pickLineId]);
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

/** Idempotent, replay-safe insert keyed on pick_line_id. Quantities bound as NUMERIC strings. */
export async function createPickLine(input: CreatePickLineInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO pick_line
       (pick_line_id, pick_task_id, dispatch_order_line_id, sku, directed_lot_id,
        directed_quantity, location_id, pick_sequence)
     VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8)
     ON CONFLICT (pick_line_id) DO NOTHING`,
    [
      input.pick_line_id,
      input.pick_task_id,
      input.dispatch_order_line_id,
      input.sku,
      input.directed_lot_id,
      input.directed_quantity,
      input.location_id,
      input.pick_sequence,
    ],
  );
}

/**
 * Confirms a pending pick line, stamping the confirmed lot/quantity, capture method and (when the
 * confirmed lot differs from the directed lot) the override reason and 'substituted' status.
 * Scoped to status = 'pending' so a replay or a race is a no-op (returns false).
 */
export async function confirmPickLine(
  pickLineId: string,
  confirmedLotId: string,
  confirmedQuantity: string,
  overrideReason: string | null,
  captureMethod: 'PWA' | 'PAPER',
  confirmedBy: string,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE pick_line
        SET confirmed_lot_id = $2,
            confirmed_quantity = $3::numeric,
            override_reason = $4,
            capture_method = $5,
            confirmed_by = $6,
            confirmed_at = now(),
            status = CASE WHEN $2::uuid <> directed_lot_id THEN 'substituted' ELSE 'confirmed' END,
            updated_at = now()
      WHERE pick_line_id = $1 AND status = 'pending'`,
    [pickLineId, confirmedLotId, confirmedQuantity, overrideReason, captureMethod, confirmedBy],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Returns all lines for a task in directed pick-path order (pick_sequence ASC). */
export async function listPickLinesByTask(pickTaskId: string, client?: PoolClient): Promise<PickLine[]> {
  const result = await runner(client).query(
    `SELECT ${PICK_LINE_COLUMNS} FROM pick_line WHERE pick_task_id = $1 ORDER BY pick_sequence ASC, pick_line_id ASC`,
    [pickTaskId],
  );
  return result.rows.map(mapRow);
}

/**
 * Cancels a still-pending pick line (used when a lot substitution releases the original lot's
 * allocation). Scoped to status = 'pending' so a replay is a no-op (returns false).
 */
export async function releasePickLineAllocation(pickLineId: string, client: PoolClient): Promise<boolean> {
  const result = await client.query(
    `UPDATE pick_line SET status = 'cancelled', updated_at = now() WHERE pick_line_id = $1 AND status = 'pending'`,
    [pickLineId],
  );
  return (result.rowCount ?? 0) > 0;
}
