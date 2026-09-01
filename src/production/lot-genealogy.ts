import type { PoolClient } from 'pg';
import { getPool } from '../config/db.js';
import { AppError } from '../middleware/error.js';
import {
  getCompletionByLotId,
  type ProductionCompletionRow,
} from '../read/projections/production_completion.js';
import { getItemById } from '../read/projections/item_master.js';

/**
 * Story 6.4 as-consumed lot genealogy (FR-MO-11). The `src/production/material-staging.ts` twin:
 * PURE read-and-compute - no persistence, no event emission, no HTTP work - so a caller can run it
 * inside its own transaction by passing a PoolClient.
 *
 * There is no genealogy TABLE. The genealogy is already a fact of the event-sourced ledger: a
 * completion event mints its output lots into production_completion, and the material that was
 * consumed to make them is exactly the production_wip_ledger postings of the same order. Adding a
 * third projection would be a second copy of that fact and a desync surface (the AD-14 rule the WIP
 * read itself follows: "there is deliberately NO separate rollup table").
 *
 * BINDING DECISION (Story 6.4, Task 1): every output lot minted by ONE completion event reports the
 * SAME consumed-input list, and the quantity reported per input lot is the quantity actually drawn,
 * NOT a share prorated across the outputs. A completion that yields a primary output plus
 * co-products and by-products consumed one physical batch of material jointly - there is no fact in
 * the ledger, and none in the physical process, that attributes a particular kilogram of input to
 * the by-product rather than the primary output. Story 6.3 prorates VALUE across outputs for
 * costing (BD-8); genealogy is a traceability answer, not a costing one, and inventing a split here
 * would report a fabricated number to a recall investigator.
 *
 * SCOPE: the genealogy is order-scoped, not event-scoped, for material consumed BEFORE the lot was
 * posted. Backflush and directed issues both land on the order as a whole, and an order's inputs
 * are drawn against the run, not against one confirmation. Reporting only the postings sharing the
 * completion's own source_event_id would return an EMPTY list for every lot on a normal order,
 * because material is issued in its own events long before the completion that consumes it.
 * Postings created after the lot's completion are excluded: they cannot have gone into it.
 */

export interface LotGenealogyInputLine {
  bom_line_id: string;
  component_item_id: string;
  component_sku: string;
  /** The consumed lot number as recorded on the drained balance row; null for un-lotted stock. */
  input_lot_number: string | null;
  /** The resolved lot_master UUID for input_lot_number, or null when it does not resolve. */
  input_lot_id: string | null;
  source_location_id: string;
  /** Net consumed (issues + backflush - returns against those postings). Exact decimal string. */
  quantity_consumed: string;
  /** The consumed component's unit of measure, from item_master (Task 1 subtask 3 contract). */
  uom: string;
  /** The earliest and latest consumption instants for this input lot on this order. */
  first_consumed_at: string;
  last_consumed_at: string;
}

export interface LotGenealogy {
  lot_id: string;
  lot_number: string;
  production_order_id: string;
  output_class: ProductionCompletionRow['output_class'];
  output_item_id: string;
  output_sku: string;
  output_quantity: string;
  completed_at: string;
  /**
   * True when the completion event that minted this lot also minted other output lots, i.e. the
   * consumed-input list below is shared with them and is NOT exclusive to this lot.
   */
  shares_inputs_with_sibling_lots: boolean;
  sibling_lot_ids: string[];
  inputs: LotGenealogyInputLine[];
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

/**
 * The as-consumed genealogy of ONE output lot (AC 1).
 *
 * Net consumption is settled in SQL NUMERIC per (bom_line_id, lot_number, source_location_id):
 * issue and backflush postings add, and their reliefs never subtract (a relief closes open WIP, it
 * does not un-consume material) while RETURN postings do subtract, because a return physically puts
 * the material back on the shelf. Lines that net to zero are dropped - material that was issued and
 * fully returned did not go into the lot.
 */
export async function getLotGenealogy(lotId: string, client?: PoolClient): Promise<LotGenealogy> {
  const completion = await getCompletionByLotId(lotId, client);
  if (!completion) {
    throw new AppError(404, 'OUTPUT_LOT_NOT_FOUND', 'The lot is not a production output lot', {
      lot_id: lotId,
    });
  }

  const r = runner(client);
  const siblings = await r.query(
    `SELECT lot_id FROM production_completion
      WHERE production_order_id = $1 AND source_event_id = $2 AND lot_id <> $3
      ORDER BY lot_id ASC`,
    [completion.production_order_id, completion.source_event_id, completion.lot_id],
  );

  // Returns are matched to their source posting so a return of material issued for THIS order nets
  // that order's consumption down; a return posting carries source_posting_id and a NULL
  // open_quantity, so the join is on the source posting's own grain.
  const inputs = await r.query(
    `WITH consumed AS (
       SELECT l.bom_line_id, l.component_item_id, l.component_sku, l.lot_number,
              l.source_location_id, l.quantity, l.occurred_at
         FROM production_wip_ledger l
        WHERE l.production_order_id = $1
          AND l.posting_type IN ('directed_issue','backflush')
          AND l.occurred_at <= $2::timestamptz
     ),
     returned AS (
       SELECT s.bom_line_id, s.lot_number, s.source_location_id,
              COALESCE(SUM(r.quantity), 0) AS returned_quantity
         FROM production_wip_ledger r
         JOIN production_wip_ledger s ON s.posting_id = r.source_posting_id
        WHERE r.production_order_id = $1
          AND r.posting_type = 'return'
          AND r.occurred_at <= $2::timestamptz
        GROUP BY s.bom_line_id, s.lot_number, s.source_location_id
     )
     SELECT c.bom_line_id,
            c.component_item_id,
            c.component_sku,
            c.lot_number,
            c.source_location_id,
            (SUM(c.quantity) - COALESCE(MAX(rt.returned_quantity), 0))::text AS quantity_consumed,
            MIN(c.occurred_at) AS first_consumed_at,
            MAX(c.occurred_at) AS last_consumed_at
       FROM consumed c
       LEFT JOIN returned rt
         ON rt.bom_line_id = c.bom_line_id
        AND rt.source_location_id = c.source_location_id
        AND rt.lot_number IS NOT DISTINCT FROM c.lot_number
      GROUP BY c.bom_line_id, c.component_item_id, c.component_sku, c.lot_number,
               c.source_location_id
     HAVING (SUM(c.quantity) - COALESCE(MAX(rt.returned_quantity), 0)) > 0
      ORDER BY c.component_sku ASC, c.lot_number ASC NULLS LAST, c.source_location_id ASC`,
    [completion.production_order_id, completion.completed_at],
  );

  // The ledger records the lot NUMBER (the stock_balance grain), so the lot_master UUID is resolved
  // per (lot_number, sku) exactly as Story 3.5 bridges the same two vocabularies. A lot number that
  // does not resolve is reported with a null id rather than dropped - the consumption happened.
  const lines: LotGenealogyInputLine[] = [];
  for (const row of inputs.rows) {
    const lotNumber = (row['lot_number'] as string | null) ?? null;
    let inputLotId: string | null = null;
    if (lotNumber !== null) {
      const resolved = await r.query(
        `SELECT lot_id FROM lot_master WHERE lot_number = $1 AND sku = $2 LIMIT 1`,
        [lotNumber, row['component_sku']],
      );
      inputLotId = resolved.rows.length > 0 ? (resolved.rows[0]!['lot_id'] as string) : null;
    }
    const item = await getItemById(row['component_item_id'] as string, client);
    const iso = (value: unknown): string =>
      value instanceof Date ? value.toISOString() : String(value);
    lines.push({
      bom_line_id: row['bom_line_id'] as string,
      component_item_id: row['component_item_id'] as string,
      component_sku: row['component_sku'] as string,
      input_lot_number: lotNumber,
      input_lot_id: inputLotId,
      source_location_id: row['source_location_id'] as string,
      quantity_consumed: String(row['quantity_consumed']),
      uom: item?.uom ?? '',
      first_consumed_at: iso(row['first_consumed_at']),
      last_consumed_at: iso(row['last_consumed_at']),
    });
  }

  return {
    lot_id: completion.lot_id,
    lot_number: completion.lot_number,
    production_order_id: completion.production_order_id,
    output_class: completion.output_class,
    output_item_id: completion.output_item_id,
    output_sku: completion.output_sku,
    output_quantity: completion.quantity,
    completed_at: completion.completed_at,
    shares_inputs_with_sibling_lots: siblings.rows.length > 0,
    sibling_lot_ids: siblings.rows.map((row) => row['lot_id'] as string),
    inputs: lines,
  };
}
