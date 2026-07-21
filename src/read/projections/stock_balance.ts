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
  /**
   * Story 2.3: the lot_master.lot_number (TEXT business key), NOT the lot_master.lot_id UUID
   * surrogate key - despite the shared column/field name. lot_trace.lot_id, by contrast, IS the
   * UUID. Do not pass this value where a lot_master.lot_id UUID is expected, or vice versa; the
   * two are structurally identical strings and TypeScript will not catch the mixup.
   */
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

export interface StockIssueInput {
   sku: string;
   location_id: string;
   lot_id?: string | null;
   quantity: number;
   /**
    * Story 2.7: the event's business timestamp, stamped onto last_issue_at for every balance row at
    * this (sku, location_id) so the obsolescence scan can read MAX(last_issue_at) across lots. Only
    * stock.issued resets the obsolescence clock - receipts, allocations, transfers and adjustments do
    * not pass through here.
    */
   occurred_at?: string | null;
 }

 export interface StockDeallocationInput {
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
  const stockClass = input.stock_class ?? 'owned';
  const result = await client.query(
    `INSERT INTO stock_balance (sku, location_id, location_code, lot_id, stock_class, on_hand)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (sku, location_id, lot_id, stock_class)
     DO UPDATE SET on_hand = stock_balance.on_hand + EXCLUDED.on_hand,
                   location_code = COALESCE(EXCLUDED.location_code, stock_balance.location_code),
                   updated_at = now()
     RETURNING ${BALANCE_COLUMNS}`,
    [input.sku, input.location_id, input.location_code ?? null, input.lot_id ?? null, stockClass, input.quantity],
  );
  return mapRow(result.rows[0]!);
}

/**
 * Applies a stock.allocated event with a transaction-local row lock (Task 1.6): the matching
 * balance rows are locked FOR UPDATE, availability is summed in SQL (NUMERIC precision, not
 * JS float), and the allocation is rejected with 409 INSUFFICIENT_STOCK before any event row
 *
 * `$3::text IS NULL OR lot_id = $3` (not `lot_id IS NOT DISTINCT FROM $3`) is deliberate: an
 * un-lotted allocation/issue (no lot_id in the payload) is allowed to draw against ANY lot's stock
 * at this sku+location, not scoped to a NULL-lot row only - this is an established, tested
 * contract (test/integration/story-2-2.test.ts "AC2: allocation ... " allocates 10 units with no
 * lot_id against a location whose only stock is under a named lot). A caller that wants
 * lot-specific behavior supplies lot_id explicitly or uses fefo_mode/fifo_mode selection.
 * exists when available stock does not cover the request. The drain runs in SQL via a windowed
 * cumulative sum so every row update preserves NUMERIC(18,6) precision. Two transactions racing
 * for the last unit therefore have exactly one winner.
 */
export async function applyStockAllocation(input: StockAllocationInput, client: PoolClient): Promise<void> {
  const lotId = input.lot_id ?? null;
  await client.query(
    `SELECT balance_id FROM stock_balance
     WHERE sku = $1 AND location_id = $2 AND ($3::text IS NULL OR lot_id = $3)
     FOR UPDATE`,
    [input.sku, input.location_id, lotId],
  );

  const checkResult = await client.query(
    `SELECT COALESCE(SUM(available), 0)::text AS total_available
     FROM stock_balance
     WHERE sku = $1 AND location_id = $2 AND ($3::text IS NULL OR lot_id = $3)`,
    [input.sku, input.location_id, lotId],
  );
  const totalAvailable = parseFloat(checkResult.rows[0]!['total_available'] as string);
  if (totalAvailable < input.quantity) {
    throw new AppError(409, 'INSUFFICIENT_STOCK', 'Available stock does not cover the requested allocation', {
      sku: input.sku,
      location_id: input.location_id,
      ...(lotId !== null ? { lot_id: lotId } : {}),
      requested_quantity: input.quantity,
      available_quantity: totalAvailable,
    });
  }

  await client.query(
    `WITH ranked AS (
       SELECT balance_id, available AS available_qty,
              SUM(available) OVER (ORDER BY lot_id NULLS FIRST, balance_id) AS cumulative
       FROM stock_balance
       WHERE sku = $1 AND location_id = $2 AND ($3::text IS NULL OR lot_id = $3)
     )
     UPDATE stock_balance
     SET allocated = allocated + LEAST(ranked.available_qty, GREATEST(0, $4 - (ranked.cumulative - ranked.available_qty))),
         updated_at = now()
     FROM ranked
     WHERE stock_balance.balance_id = ranked.balance_id
       AND ranked.cumulative - ranked.available_qty < $4`,
    [input.sku, input.location_id, lotId, input.quantity],
  );
}

export async function applyStockIssue(input: StockIssueInput, client: PoolClient): Promise<void> {
  const lotId = input.lot_id ?? null;
  await client.query(
    `SELECT balance_id FROM stock_balance
     WHERE sku = $1 AND location_id = $2 AND ($3::text IS NULL OR lot_id = $3)
     FOR UPDATE`,
    [input.sku, input.location_id, lotId],
  );

  const checkResult = await client.query(
    `SELECT COALESCE(SUM(available), 0)::text AS total_available
     FROM stock_balance
     WHERE sku = $1 AND location_id = $2 AND ($3::text IS NULL OR lot_id = $3)`,
    [input.sku, input.location_id, lotId],
  );
  const totalAvailable = parseFloat(checkResult.rows[0]!['total_available'] as string);
  if (totalAvailable < input.quantity) {
    throw new AppError(409, 'INSUFFICIENT_STOCK', 'Available stock does not cover the requested issue', {
      sku: input.sku,
      location_id: input.location_id,
      ...(lotId !== null ? { lot_id: lotId } : {}),
      requested_quantity: input.quantity,
      available_quantity: totalAvailable,
    });
  }

await client.query(
     `WITH ranked AS (
        SELECT balance_id, available AS available_qty,
               SUM(available) OVER (ORDER BY lot_id NULLS FIRST, balance_id) AS cumulative
        FROM stock_balance
        WHERE sku = $1 AND location_id = $2 AND ($3::text IS NULL OR lot_id = $3)
      )
      UPDATE stock_balance
      SET on_hand = on_hand - LEAST(ranked.available_qty, GREATEST(0, $4 - (ranked.cumulative - ranked.available_qty))),
          updated_at = now()
      FROM ranked
      WHERE stock_balance.balance_id = ranked.balance_id
        AND ranked.cumulative - ranked.available_qty < $4`,
     [input.sku, input.location_id, lotId, input.quantity],
  );

  // Story 2.7: stamp last_issue_at for every balance row at this (sku, location_id) so the
  // obsolescence scan reads MAX(last_issue_at) across lots. GREATEST keeps the value monotonic - a
  // late or out-of-order issue never moves the obsolescence clock backwards. Touches only
  // last_issue_at/updated_at, never on_hand/allocated/available/in_transit (Story 2.2 invariants).
  const occurredAt = input.occurred_at ?? new Date().toISOString();
  await client.query(
    `UPDATE stock_balance
     SET last_issue_at = GREATEST(COALESCE(last_issue_at, $4::timestamptz), $4::timestamptz),
         updated_at = now()
     WHERE sku = $1 AND location_id = $2 AND ($3::text IS NULL OR lot_id = $3)`,
    [input.sku, input.location_id, lotId, occurredAt],
  );
}

/**
 * Reverses a stock allocation: decreases `allocated` by the given quantity. Used when
 * a previously allocated transfer is shipped (allocation is consumed) or rejected
 * (allocation is rolled back). Must run on the SAME client/transaction as the caller's
 * event insert.
 */
export async function applyStockDeallocation(input: StockDeallocationInput, client: PoolClient): Promise<void> {
  const lotId = input.lot_id ?? null;
  await client.query(
    `UPDATE stock_balance
     SET allocated = GREATEST(allocated - $1, 0),
         updated_at = now()
     WHERE sku = $2 AND location_id = $3 AND ($4::text IS NULL OR lot_id = $4)`,
    [input.quantity, input.sku, input.location_id, lotId],
  );
}
