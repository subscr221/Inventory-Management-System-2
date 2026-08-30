import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { AppError } from '../../middleware/error.js';
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

/**
 * Story 6.3 widened the vocabulary with two RELIEF postings (FR-MO-07, FR-MO-08). Like a return
 * they close open WIP on a named source posting at that posting's issued unit cost and carry a
 * NULL open_quantity of their own; unlike a return they move no stock. 'scrap_relief' carries the
 * operator's reason code, 'completion_relief' does not (the completion event is its own reason).
 */
export type ProductionWipPostingType =
  'directed_issue' | 'backflush' | 'return' | 'completion_relief' | 'scrap_relief';

export interface ProductionWipPostingRow {
  posting_id: string;
  production_order_id: string;
  posting_type: ProductionWipPostingType;
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
  posting_type: ProductionWipPostingType;
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

/**
 * Story 6.3 (FR-MO-07, FR-MO-08; Binding Decision 8): closes open WIP on this order and writes one
 * relief posting per drained source posting.
 *
 * `target` is either a decimal VALUE string (relieve up to that much WIP value) or the literal
 * 'all' (relieve every open posting, used by the final completion and by the close-short decision
 * so rounding drift can never strand a residue that Story 6.4's zero-WIP closure gate would then
 * block on forever). Draining is oldest-posting-first (`created_at ASC, posting_id ASC`), the same
 * deterministic order the ledger reads in, and every division and subtraction settles in SQL
 * NUMERIC - never in JS floats.
 *
 * A zero-cost posting contributes no value, so a value-bounded pass would otherwise never close it;
 * it is drained in full whenever any relief budget remains. Locking is an explicit ordered
 * SELECT ... FOR UPDATE before the UPDATE, so two concurrent relief passes on one order queue in a
 * fixed order instead of deadlocking.
 *
 * Returns the drained detail plus the exact value relieved. It NEVER drives open_quantity negative
 * and NEVER touches stock_balance.
 */
export async function relieveOpenPostings(
  input: {
    production_order_id: string;
    target: string | 'all';
    posting_type: 'completion_relief' | 'scrap_relief';
    reason_code: string | null;
    source_event_id: string;
    occurred_at: string;
    mintPostingId: () => string;
  },
  client: PoolClient,
): Promise<{ relieved_value: string; postings: ProductionWipPostingRow[] }> {
  // Ordered lock first: the UPDATE below cannot guarantee row order on its own.
  await client.query(
    `SELECT posting_id FROM production_wip_ledger
      WHERE production_order_id = $1
        AND posting_type IN ('directed_issue','backflush')
        AND open_quantity > 0
      ORDER BY created_at ASC, posting_id ASC
      FOR UPDATE`,
    [input.production_order_id],
  );

  const isAll = input.target === 'all';
  const drained = await client.query(
    `WITH open_rows AS (
       SELECT posting_id, open_quantity, unit_cost, created_at,
              SUM(open_quantity * unit_cost) OVER (
                ORDER BY created_at ASC, posting_id ASC ROWS UNBOUNDED PRECEDING
              ) AS cum_value
         FROM production_wip_ledger
        WHERE production_order_id = $1
          AND posting_type IN ('directed_issue','backflush')
          AND open_quantity > 0
     ),
     relief AS (
       SELECT posting_id,
              -- ROUND to the NUMERIC(18,6) scale of production_wip_ledger.quantity BEFORE the
              -- positivity filter below (code review 2026-08-31). Filtering an unrounded value let a
              -- sub-precision residual such as 0.0000004 - reachable whenever a value-bounded
              -- budget meets a high unit_cost - pass the filter and then round to 0.000000 on
              -- insert, aborting the entire completion on chk_production_wip_quantity_positive.
              -- Rounding here also keeps the open_quantity decrement and the relief posting's own
              -- quantity in exact agreement instead of rounding them independently.
              -- FLOOR at the NUMERIC(18,6) scale, never ROUND (code review 2026-08-31). Rounding
              -- half-up let the drain exceed the budget by up to 5e-7 * unit_cost; flooring honours
              -- the budget in both directions and still keeps the value below the column scale, so
              -- a sub-precision residual is dropped rather than rounding to 0.000000 on insert and
              -- aborting the whole completion on chk_production_wip_quantity_positive.
              FLOOR(
                CASE
                  WHEN $3::boolean THEN open_quantity
                  -- A zero-cost posting consumes no budget, so it is drained whenever the budget
                  -- has not been overrun - including when a previous row consumed it EXACTLY.
                  -- The strict > 0 here used to strand such rows, leaving
                  -- unreversed_transaction_count non-zero forever.
                  WHEN unit_cost = 0 THEN
                    CASE WHEN $2::numeric - (cum_value - open_quantity * unit_cost) >= 0
                         THEN open_quantity ELSE 0 END
                  ELSE LEAST(
                    open_quantity,
                    GREATEST($2::numeric - (cum_value - open_quantity * unit_cost), 0) / unit_cost
                  )
                END * 1000000
              ) / 1000000 AS relief_quantity
         FROM open_rows
     )
     UPDATE production_wip_ledger l
        SET open_quantity = l.open_quantity - r.relief_quantity
       FROM relief r
      WHERE l.posting_id = r.posting_id
        AND r.relief_quantity > 0
     RETURNING l.posting_id AS source_posting_id, l.bom_line_id, l.component_item_id,
               l.component_sku, l.lot_number, l.source_location_id, l.unit_cost,
               r.relief_quantity::text AS relief_quantity, l.created_at`,
    [input.production_order_id, isAll ? '0' : input.target, isAll],
  );

  const rows = [...drained.rows].sort((a, b) => {
    const at = new Date(String(a['created_at'])).getTime();
    const bt = new Date(String(b['created_at'])).getTime();
    if (at !== bt) return at - bt;
    return String(a['source_posting_id']).localeCompare(String(b['source_posting_id']));
  });

  const postings: ProductionWipPostingRow[] = [];
  for (const row of rows) {
    const postingId = input.mintPostingId();
    await insertWipPosting(
      {
        posting_id: postingId,
        production_order_id: input.production_order_id,
        posting_type: input.posting_type,
        bom_line_id: row['bom_line_id'] as string,
        component_item_id: row['component_item_id'] as string,
        component_sku: row['component_sku'] as string,
        lot_number: (row['lot_number'] as string | null) ?? null,
        source_location_id: row['source_location_id'] as string,
        quantity: String(row['relief_quantity']),
        open_quantity: null,
        unit_cost: String(row['unit_cost']),
        reason_code: input.reason_code,
        source_posting_id: row['source_posting_id'] as string,
        source_event_id: input.source_event_id,
        occurred_at: input.occurred_at,
      },
      client,
    );
    const persisted = await getPostingById(postingId, client);
    if (!persisted) {
      // Fail loudly (code review 2026-08-31): silently omitting it made the persisted event payload
      // under-report a real WIP movement while relieved_value still counted it - a fail-open on a
      // compliance trail.
      throw new AppError(
        500,
        'WIP_RELIEF_UNREADABLE',
        'A relief posting was written but could not be read back',
        { posting_id: postingId, production_order_id: input.production_order_id },
      );
    }
    postings.push(persisted);
  }

  // The relieved value is summed in SQL over the postings just written, never accumulated in JS.
  const total = await client.query(
    `SELECT COALESCE(SUM(posting_value), 0)::text AS relieved_value
       FROM production_wip_ledger
      WHERE production_order_id = $1 AND source_event_id = $2
        AND posting_type IN ('completion_relief','scrap_relief')`,
    [input.production_order_id, input.source_event_id],
  );
  return {
    relieved_value: String(total.rows[0]!['relieved_value']),
    postings,
  };
}

/**
 * The total value ISSUED to this order, i.e. the sum of every issue and backflush posting at the
 * cost it was issued at, regardless of how much of it is still open.
 *
 * This is the basis the completion relief prorates against (product-owner decision, code review
 * 2026-08-31). Prorating against the CURRENT open value instead made relief decay geometrically -
 * three 30-unit completions on a 100-unit order relieved 30%, then 21%, then 14.7%, so 90% of the
 * order relieved only 65.7% of WIP and every interim period was mis-valued.
 */
export async function getIssuedWipValue(orderId: string, client: PoolClient): Promise<string> {
  const result = await client.query(
    `SELECT COALESCE(SUM(posting_value), 0)::text AS issued_value
       FROM production_wip_ledger
      WHERE production_order_id = $1
        AND posting_type IN ('directed_issue','backflush')`,
    [orderId],
  );
  return String(result.rows[0]!['issued_value']);
}
