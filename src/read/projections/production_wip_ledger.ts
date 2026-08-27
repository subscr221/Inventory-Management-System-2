import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { getAvailableBalanceUnderSite } from './stock_balance.js';

/**
 * Production WIP ledger read model (Story 6.2, FR-MO-05/06). Derived state only and APPEND-ONLY
 * by construction: rows are rebuildable by replaying production_order.material_issued /
 * confirmation_recorded / material_returned domain events, and mutation happens exclusively
 * through persistEvent, which applies this projection inside the SAME transaction as the
 * domain_events insert. One posting per drained balance row (Binding Decision 7); returns reduce
 * open_quantity on the SOURCE posting in the same transaction and insert a NULL-open_quantity
 * return posting referencing it.
 *
 * The WIP read (AC4) is computed from this ledger - there is deliberately NO separate rollup table
 * (no desync surface to maintain). NUMERIC columns are read as strings and never coerced to a JS
 * number; every comparison settles in SQL NUMERIC.
 */

export interface ProductionWipPostingRow {
  posting_id: string;
  production_order_id: string;
  posting_type: 'directed_issue' | 'backflush' | 'return';
  bom_line_id: string;
  component_item_id: string;
  component_sku: string;
  lot_number: string | null;
  source_location_id: string;
  /** Exact decimal string (NUMERIC(18,6)); never a JS number. */
  quantity: string;
  /** Exact decimal string or null (NULL on return rows); never a JS number. */
  open_quantity: string | null;
  /** Exact decimal string (NUMERIC(14,3)); never a JS number. */
  unit_cost: string;
  /** Exact decimal string (NUMERIC(14,3)); never a JS number. */
  posting_value: string;
  reason_code: string | null;
  source_posting_id: string | null;
  source_event_id: string;
  occurred_at: string;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const POSTING_COLUMNS = `posting_id, production_order_id, posting_type, bom_line_id,
       component_item_id, component_sku, lot_number, source_location_id, quantity,
       open_quantity, unit_cost, posting_value, reason_code, source_posting_id,
       source_event_id, occurred_at, created_at`;

function mapRow(row: Record<string, unknown>): ProductionWipPostingRow {
  const iso = (value: unknown): string =>
    value instanceof Date ? value.toISOString() : String(value);
  return {
    posting_id: row['posting_id'] as string,
    production_order_id: row['production_order_id'] as string,
    posting_type: row['posting_type'] as ProductionWipPostingRow['posting_type'],
    bom_line_id: row['bom_line_id'] as string,
    component_item_id: row['component_item_id'] as string,
    component_sku: row['component_sku'] as string,
    lot_number: (row['lot_number'] as string | null) ?? null,
    source_location_id: row['source_location_id'] as string,
    // pg returns NUMERIC as a string; it stays a string - never Number().
    quantity: String(row['quantity']),
    open_quantity:
      row['open_quantity'] === null || row['open_quantity'] === undefined
        ? null
        : String(row['open_quantity']),
    unit_cost: String(row['unit_cost']),
    posting_value: String(row['posting_value']),
    reason_code: (row['reason_code'] as string | null) ?? null,
    source_posting_id: (row['source_posting_id'] as string | null) ?? null,
    source_event_id: row['source_event_id'] as string,
    occurred_at: iso(row['occurred_at']),
    created_at: iso(row['created_at']),
  };
}

export interface InsertWipPostingInput {
  posting_id: string;
  production_order_id: string;
  posting_type: 'directed_issue' | 'backflush' | 'return';
  bom_line_id: string;
  component_item_id: string;
  component_sku: string;
  lot_number: string | null;
  source_location_id: string;
  quantity: string;
  /** Issue/backflush rows pass their quantity; return rows pass null. */
  open_quantity: string | null;
  unit_cost: string;
  reason_code: string | null;
  source_posting_id: string | null;
  source_event_id: string;
  occurred_at: string;
}

export async function insertWipPosting(
  input: InsertWipPostingInput,
  client: PoolClient,
): Promise<string> {
  const result = await client.query(
    `INSERT INTO production_wip_ledger (
      posting_id, production_order_id, posting_type, bom_line_id, component_item_id,
      component_sku, lot_number, source_location_id, quantity, open_quantity, unit_cost,
      posting_value, reason_code, source_posting_id, source_event_id, occurred_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$9::numeric * $11::numeric,$12,$13,$14,$15)
    RETURNING posting_value`,
    [
      input.posting_id,
      input.production_order_id,
      input.posting_type,
      input.bom_line_id,
      input.component_item_id,
      input.component_sku,
      input.lot_number,
      input.source_location_id,
      input.quantity,
      input.open_quantity,
      input.unit_cost,
      // posting_value is computed in SQL NUMERIC, never in JS: quantity * unit_cost at the exact
      // precision the WIP ledger column (NUMERIC(14,3)) rounds to.
      input.reason_code,
      input.source_posting_id,
      input.source_event_id,
      input.occurred_at,
    ],
  );
  return String(result.rows[0]!['posting_value']);
}

/**
 * Exact NUMERIC shortfall probe used by the confirmation applier's pre-check (AC3): settled in the
 * database so 0.1 + 0.2 stays exact. Every backflush line is probed once; the applier reports
 * EVERY deficient line in details.shortfall_lines (AC3's plural contract). The confirmation
 * handler pre-runs the same probe outside a transaction for a clean early error; the seam re-runs
 * it inside the persistEvent transaction.
 */
export async function getBackflushShortfall(
  componentSku: string,
  plantLocationId: string,
  requiredQuantity: string,
  client?: PoolClient,
): Promise<{ available_quantity: string; shortfall_quantity: string; satisfied: boolean }> {
  const r = runner(client);
  const available = await getAvailableBalanceUnderSite(componentSku, plantLocationId, client);
  const result = await r.query(
    `SELECT $1::numeric AS available_quantity,
            ($1::numeric >= $2::numeric) AS satisfied,
            GREATEST($2::numeric - $1::numeric, 0)::text AS shortfall_quantity`,
    [available, requiredQuantity],
  );
  return {
    available_quantity: String(result.rows[0]!['available_quantity']),
    shortfall_quantity: result.rows[0]!['shortfall_quantity'] as string,
    satisfied: result.rows[0]!['satisfied'] === true,
  };
}

export async function getPostingById(
  postingId: string,
  client?: PoolClient,
): Promise<ProductionWipPostingRow | null> {
  if (!UUID_REGEX.test(postingId)) return null;
  const result = await runner(client).query(
    `SELECT ${POSTING_COLUMNS} FROM production_wip_ledger WHERE posting_id = $1`,
    [postingId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function getPostingByIdForUpdate(
  postingId: string,
  client: PoolClient,
): Promise<ProductionWipPostingRow | null> {
  if (!UUID_REGEX.test(postingId)) return null;
  const result = await client.query(
    `SELECT ${POSTING_COLUMNS} FROM production_wip_ledger WHERE posting_id = $1 FOR UPDATE`,
    [postingId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export interface ListPostingsByOrderParams {
  orderId: string;
  limit?: number | undefined;
  offset?: number | undefined;
  client?: PoolClient;
}

export async function listPostingsByOrder(
  params: ListPostingsByOrderParams,
): Promise<ProductionWipPostingRow[]> {
  const r = runner(params.client);
  const limit =
    Number.isInteger(params.limit) && params.limit! > 0 ? Math.min(params.limit!, 200) : 50;
  const offset = Number.isInteger(params.offset) && params.offset! >= 0 ? params.offset! : 0;
  const result = await r.query(
    `SELECT ${POSTING_COLUMNS} FROM production_wip_ledger
      WHERE production_order_id = $1
      ORDER BY created_at ASC, posting_id ASC
      LIMIT $2 OFFSET $3`,
    [params.orderId, limit, offset],
  );
  return result.rows.map(mapRow);
}

/**
 * Exact NUMERIC over-return probe (AC6): the source posting's open_quantity is ALREADY net of
 * prior returns (returns decrement it in their own transaction), so the comparison is
 * `quantity > open_quantity` settled in the database - 0.1 + 0.2 exceeds 0.3 in binary float but
 * not in NUMERIC, so a valid fractional closing return is never spuriously rejected. Runs against
 * the caller's locked source posting inside the persist transaction.
 */
export async function getReturnExceeds(
  postingId: string,
  quantity: string,
  client?: PoolClient,
): Promise<boolean> {
  const r = runner(client);
  const result = await r.query(
    `SELECT (open_quantity IS NULL OR $2::numeric > open_quantity) AS exceeds
       FROM production_wip_ledger WHERE posting_id = $1`,
    [postingId, quantity],
  );
  return result.rows.length > 0 ? (result.rows[0] as { exceeds: boolean }).exceeds : false;
}

/**
 * The counter recompute (the Counter Contract): the count of issue/backflush postings whose open
 * quantity is still positive, settled in SQL. Under the already-held order lock this IS
 * production_order.unreversed_transaction_count - the 6.1 cancel guard reads the same column.
 */
export async function getOpenPostingCount(orderId: string, client: PoolClient): Promise<number> {
  const result = await client.query(
    `SELECT COUNT(*)::int AS n FROM production_wip_ledger
      WHERE production_order_id = $1
        AND posting_type IN ('directed_issue','backflush')
        AND open_quantity > 0`,
    [orderId],
  );
  return Number(result.rows[0]!.n);
}

/**
 * The AC4 real-time WIP read: net open quantity and net open value computed in SQL NUMERIC. Net
 * open quantity = SUM(open_quantity) over the non-return postings (returns reduce open_quantity on
 * their SOURCE posting, so they are already netted out); net open value = SUM(open_quantity *
 * unit_cost). Both return exact decimal strings, never JS numbers. A Closed-order zero-WIP check
 * (Story 6.4's closure gate) will read the same accessor.
 */
export async function getWipSummary(
  orderId: string,
  client?: PoolClient,
): Promise<{ net_open_quantity: string; net_open_value: string }> {
  const result = await runner(client).query(
    `SELECT COALESCE(SUM(open_quantity), 0)::text AS net_open_quantity,
            COALESCE(SUM(open_quantity * unit_cost), 0)::text AS net_open_value
       FROM production_wip_ledger
      WHERE production_order_id = $1
        AND posting_type IN ('directed_issue','backflush')`,
    [orderId],
  );
  return {
    net_open_quantity: String(result.rows[0]!['net_open_quantity']),
    net_open_value: String(result.rows[0]!['net_open_value']),
  };
}
