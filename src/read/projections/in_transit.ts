import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * In-transit read model (Story 2.5). Denormalized from stock_balance.in_transit for efficient
 * querying. The authoritative in-transit quantity lives in stock_balance.in_transit; this
 * projection provides per-transfer tracking with correlation_id and ship_event_id.
 */

export interface InTransitRow {
  sku_id: string;
  location_from: string;
  location_to: string;
  lot_id: string | null;
  quantity: number;
  transfer_request_id: string;
  correlation_id: string | null;
  ship_event_id: string | null;
  created_at: string;
}

export interface InsertInTransitInput {
  sku_id: string;
  location_from: string;
  location_to: string;
  lot_id: string | null;
  quantity: number;
  transfer_request_id: string;
  correlation_id: string;
  ship_event_id: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

/** Insert an in-transit record. Must run inside the same transaction as the ship event. */
export async function insertInTransitRecord(input: InsertInTransitInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO in_transit (sku_id, location_from, location_to, lot_id, quantity,
                            transfer_request_id, correlation_id, ship_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.sku_id,
      input.location_from,
      input.location_to,
      input.lot_id,
      input.quantity,
      input.transfer_request_id,
      input.correlation_id,
      input.ship_event_id,
    ],
  );
}

/** Clear (delete) an in-transit record when the receive posts. Must run inside the same transaction. */
export async function clearInTransitRecord(transferRequestId: string, client: PoolClient): Promise<void> {
  await client.query(`DELETE FROM in_transit WHERE transfer_request_id = $1`, [transferRequestId]);
}

/** Decrement in-transit quantity for a partial receive. Must run inside the same transaction. */
export async function decrementInTransit(
  transferRequestId: string,
  quantity: number,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE in_transit SET quantity = GREATEST(quantity - $1, 0) WHERE transfer_request_id = $2`,
    [quantity, transferRequestId],
  );
}

/** Get all in-transit records for a given SKU. */
export async function getInTransitBySku(sku: string, client?: PoolClient): Promise<InTransitRow[]> {
  const result = await runner(client).query(
    `SELECT sku_id, location_from, location_to, lot_id, quantity,
            transfer_request_id, correlation_id, ship_event_id, created_at
     FROM in_transit
     WHERE sku_id = $1 AND quantity > 0
     ORDER BY created_at ASC`,
    [sku],
  );
  return result.rows.map(mapRow);
}

/** Get in-transit records for a specific transfer request. */
export async function getInTransitByTransferRequest(
  transferRequestId: string,
  client?: PoolClient,
): Promise<InTransitRow | null> {
  const result = await runner(client).query(
    `SELECT sku_id, location_from, location_to, lot_id, quantity,
            transfer_request_id, correlation_id, ship_event_id, created_at
     FROM in_transit
     WHERE transfer_request_id = $1 AND quantity > 0
     LIMIT 1`,
    [transferRequestId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

function mapRow(row: Record<string, unknown>): InTransitRow {
  return {
    sku_id: row['sku_id'] as string,
    location_from: row['location_from'] as string,
    location_to: row['location_to'] as string,
    lot_id: (row['lot_id'] as string) ?? null,
    quantity: Number(row['quantity']),
    transfer_request_id: row['transfer_request_id'] as string,
    correlation_id: (row['correlation_id'] as string) ?? null,
    ship_event_id: (row['ship_event_id'] as string) ?? null,
    created_at:
      row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']),
  };
}