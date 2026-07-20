import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { AppError } from '../../middleware/error.js';

/**
 * Stock balance read model (Story 2.2). Derived state only: every row is rebuildable by
 * replaying stock.* domain events, and mutation happens exclusively through persistEvent, which
 * applies this projection inside the SAME transaction as the domain_events insert. Grain is
 * (sku, location_id, lot_id) with NULLS NOT DISTINCT - un-lotted stock occupies exactly one row
 * per sku+location - and the stock query aggregates rows per location. `available` is a
 * database-generated column (on_hand - allocated); it is never written by code and never
 * accepted from clients.
 */

export interface StockBalance {
  balance_id: string;
  sku: string;
  location_id: string;
  location_code: string | null;
  lot_id: string | null;
  stock_class: string;
  on_hand: number;
  allocated: number;
  available: number;
  in_transit: number;
  updated_at: string;
}

export interface StockReceiptInput {
  sku: string;
  location_id: string;
  location_code?: string | null;
  lot_id?: string | null;
  stock_class?: string;
  quantity: number;
}

export interface StockAllocationInput {
  sku: string;
  location_id: string;
  lot_id?: string | null;
  quantity: number;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const BALANCE_COLUMNS = `balance_id, sku, location_id, location_code, lot_id, stock_class,
       on_hand, allocated, available, in_transit, updated_at`;

function mapRow(row: Record<string, unknown>): StockBalance {
  const updatedAt = row['updated_at'] instanceof Date ? row['updated_at'].toISOString() : String(row['updated_at']);
  return {
    balance_id: row['balance_id'] as string,
    sku: row['sku'] as string,
    location_id: row['location_id'] as string,
    location_code: (row['location_code'] as string | null) ?? null,
    lot_id: (row['lot_id'] as string | null) ?? null,
    stock_class: row['stock_class'] as string,
    // pg returns NUMERIC as string to avoid silent precision loss; quantities here fit a JS number.
    on_hand: Number(row['on_hand']),
    allocated: Number(row['allocated']),
    available: Number(row['available']),
    in_transit: Number(row['in_transit']),
    updated_at: updatedAt,
  };
}

/** All balance rows for a SKU (one per location+lot), deterministically ordered. */
export async function getStockBalancesBySku(sku: string, client?: PoolClient): Promise<StockBalance[]> {
  const result = await runner(client).query(
    `SELECT ${BALANCE_COLUMNS} FROM stock_balance WHERE sku = $1 ORDER BY location_id, lot_id NULLS FIRST`,
    [sku],
  );
  return result.rows.map(mapRow);
}

/**
 * Applies a stock.received event: on_hand at the target location (and lot, when given) increases
 * by the received quantity. The upsert takes a row lock on conflict, so concurrent receipts to
 * the same grain serialize. Must run on the SAME client/transaction as the domain event insert.
 */
export async function applyStockReceipt(input: StockReceiptInput, client: PoolClient): Promise<StockBalance> {
  const result = await client.query(
    `INSERT INTO stock_balance (sku, location_id, location_code, lot_id, stock_class, on_hand)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (sku, location_id, lot_id)
     DO UPDATE SET on_hand = stock_balance.on_hand + EXCLUDED.on_hand,
                   location_code = COALESCE(EXCLUDED.location_code, stock_balance.location_code),
                   updated_at = now()
     RETURNING ${BALANCE_COLUMNS}`,
    [input.sku, input.location_id, input.location_code ?? null, input.lot_id ?? null, input.stock_class ?? 'owned', input.quantity],
  );
  return mapRow(result.rows[0]!);
}

/**
 * Applies a stock.allocated event with a transaction-local row lock (Task 1.6): the matching
 * balance rows are locked FOR UPDATE, availability is re-read under the lock, and the allocation
 * is rejected with 409 INSUFFICIENT_STOCK before any event row exists when available stock does
 * not cover the request. Two transactions racing for the last unit therefore have exactly one
 * winner - the loser blocks on the lock, re-reads available = 0, and rejects. When lot_id is
 * given only that lot's row is eligible; otherwise the allocation drains rows for the
 * sku+location in deterministic order (un-lotted first, then by lot). on_hand never changes.
 */
export async function applyStockAllocation(input: StockAllocationInput, client: PoolClient): Promise<void> {
  const lotId = input.lot_id ?? null;
  const locked = await client.query(
    `SELECT ${BALANCE_COLUMNS} FROM stock_balance
     WHERE sku = $1 AND location_id = $2 AND ($3::text IS NULL OR lot_id = $3)
     ORDER BY lot_id NULLS FIRST, balance_id
     FOR UPDATE`,
    [input.sku, input.location_id, lotId],
  );
  const rows = locked.rows.map(mapRow);
  const availableQuantity = rows.reduce((sum, row) => sum + row.available, 0);
  if (availableQuantity < input.quantity) {
    throw new AppError(409, 'INSUFFICIENT_STOCK', 'Available stock does not cover the requested allocation', {
      sku: input.sku,
      location_id: input.location_id,
      ...(lotId !== null ? { lot_id: lotId } : {}),
      requested_quantity: input.quantity,
      available_quantity: availableQuantity,
    });
  }

  let remaining = input.quantity;
  for (const row of rows) {
    if (remaining <= 0) break;
    const take = Math.min(row.available, remaining);
    if (take <= 0) continue;
    await client.query(`UPDATE stock_balance SET allocated = allocated + $1, updated_at = now() WHERE balance_id = $2`, [
      take,
      row.balance_id,
    ]);
    remaining -= take;
  }
}
