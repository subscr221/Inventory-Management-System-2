import type { PoolClient } from 'pg';
import { getPool } from '../config/db.js';
import { config } from '../config/index.js';
import { getTraceForLot } from '../read/projections/lot_trace.js';
import type { LotTrace } from '../read/projections/lot_trace.js';
import type { QcQualityHoldRow } from '../read/projections/qc_quality_hold.js';

/**
 * Story 8.5 (FR-Q-09, AC 1): the where-used and where-shipped trace assembly, kept out of the
 * already-oversized src/compliance/quality.ts. Read-only over the SHARED read projections (AD-14):
 * lot_trace, production_wip_ledger + production_order (where-used), packing_record +
 * dispatch_order_status + dispatch_document (where-shipped). Never another module's event stream.
 *
 * COVERAGE LIMIT, declared rather than implied: where_used runs over the consumption event types
 * that exist at this baseline - production issue (Story 6.2, production_order.material_issued,
 * projected into production_wip_ledger's directed_issue/backflush postings) and job-work custody
 * consumption (Story 9.3, custody.consumption_posted, read from lot_trace joined to the custody
 * ledger and its service order). Production genealogy (Story 6.4) is NOT yet in this query, so the
 * trace is complete only with respect to what exists; the response carries an explicit `coverage`
 * field so a caller can never read an incomplete trace as a complete one. The coverage list and
 * the queries below MUST change together (a coverage list that lies is worse than none).
 *
 * Binding Scope Decision 7: the 15-minute contract is a MEASURED, recorded latency. The envelope
 * reports now() - placed_at against qc.holdPropagationBudgetMinutes as
 * propagation_budget_breached; nothing here waits.
 */

export interface WhereUsedEntry {
  posting_id: string;
  /** production_order_id for production postings; service_order_id for job-work consumption. */
  production_order_id: string;
  order_number_ext: string;
  output_sku: string;
  posting_type: string;
  component_sku: string;
  quantity: string;
  occurred_at: string;
  /** Story 9.3: which consumption family produced this entry. */
  source: 'production_order.material_issued' | 'custody.consumption_posted';
}

export interface WhereShippedEntry {
  packing_record_id: string;
  dispatch_order_id: string;
  sku: string;
  packed_qty: string;
  packing_status: string;
  packed_at: string;
  dispatched_at: string | null;
  documents: Array<{ document_id: string; document_type: string; generated_at: string }>;
}

export interface RecallTrace {
  hold_id: string;
  lot_id: string;
  lot_number: string;
  sku: string;
  placed_at: string;
  elapsed_minutes: number;
  propagation_budget_minutes: number;
  propagation_budget_breached: boolean;
  coverage: {
    where_used: string[];
    not_yet_covered: string[];
  };
  movements: LotTrace[];
  where_used: WhereUsedEntry[];
  where_shipped: WhereShippedEntry[];
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

export async function assembleRecallTrace(
  hold: QcQualityHoldRow,
  client?: PoolClient,
): Promise<RecallTrace> {
  const movements = await getTraceForLot(hold.lot_id, client as PoolClient | undefined);

  const usedResult = await runner(client).query(
    `SELECT w.posting_id, w.production_order_id, o.order_number_ext, o.output_sku,
            w.posting_type, w.component_sku, w.quantity::text AS quantity, w.occurred_at
       FROM production_wip_ledger w
       JOIN production_order o ON o.production_order_id = w.production_order_id
      WHERE w.lot_number = $1
        AND w.posting_type IN ('directed_issue', 'backflush')
      ORDER BY w.occurred_at ASC, w.posting_id`,
    [hold.lot_number],
  );
  const whereUsed: WhereUsedEntry[] = usedResult.rows.map((row: Record<string, unknown>) => ({
    posting_id: row['posting_id'] as string,
    production_order_id: row['production_order_id'] as string,
    order_number_ext: row['order_number_ext'] as string,
    output_sku: row['output_sku'] as string,
    posting_type: row['posting_type'] as string,
    component_sku: row['component_sku'] as string,
    quantity: String(row['quantity']),
    occurred_at: toIso(row['occurred_at']),
    source: 'production_order.material_issued',
  }));

  // Story 9.3: job-work custody consumption. lot_trace.lot_id is the lot_master UUID; the ledger
  // row for the same event carries the order, and the order carries the customer-facing number.
  // output_sku is the kit BOM parent sku (what the customer material was consumed INTO).
  const custodyResult = await runner(client).query(
    `SELECT c.entry_id AS posting_id, c.service_order_id, o.order_number_ext,
            COALESCE(b.parent_sku, '') AS output_sku, c.movement_category AS posting_type,
            c.sku AS component_sku, (-c.quantity_delta)::text AS quantity, c.occurred_at
       FROM lot_trace t
       JOIN custody_ledger_entry c ON c.source_event_id = t.event_id
       JOIN service_order o ON o.service_order_id = c.service_order_id
       LEFT JOIN bom b ON b.bom_id = o.kit_bom_id
      WHERE t.lot_id = $1
        AND t.event_type = 'custody.consumption_posted'
        AND c.movement_category = 'consumption'
      ORDER BY c.occurred_at ASC, c.entry_id`,
    [hold.lot_id],
  );
  for (const row of custodyResult.rows as Array<Record<string, unknown>>) {
    whereUsed.push({
      posting_id: row['posting_id'] as string,
      production_order_id: row['service_order_id'] as string,
      order_number_ext: row['order_number_ext'] as string,
      output_sku: row['output_sku'] as string,
      posting_type: row['posting_type'] as string,
      component_sku: row['component_sku'] as string,
      quantity: String(row['quantity']),
      occurred_at: toIso(row['occurred_at']),
      source: 'custody.consumption_posted',
    });
  }
  whereUsed.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));

  // packing_record.lot_id holds the lot_master.lot_id UUID (the dispatch seam joins on it).
  const shippedResult = await runner(client).query(
    `SELECT pr.packing_record_id, pr.dispatch_order_id, pr.sku,
            pr.packed_qty::text AS packed_qty, pr.status AS packing_status, pr.packed_at,
            dos.dispatched_at,
            COALESCE(dd.documents, '[]'::json) AS documents
       FROM packing_record pr
       LEFT JOIN dispatch_order_status dos ON dos.dispatch_order_id = pr.dispatch_order_id
       LEFT JOIN LATERAL (
         SELECT json_agg(
                  json_build_object(
                    'document_id', d.document_id,
                    'document_type', d.document_type,
                    'generated_at', d.generated_at
                  )
                  ORDER BY d.generated_at, d.document_id
                ) AS documents
           FROM dispatch_document d
          WHERE d.dispatch_order_id = pr.dispatch_order_id
       ) dd ON true
      WHERE pr.lot_id = $1
      ORDER BY pr.packed_at ASC, pr.packing_record_id`,
    [hold.lot_id],
  );
  const whereShipped: WhereShippedEntry[] = shippedResult.rows.map(
    (row: Record<string, unknown>) => ({
      packing_record_id: row['packing_record_id'] as string,
      dispatch_order_id: row['dispatch_order_id'] as string,
      sku: row['sku'] as string,
      packed_qty: String(row['packed_qty']),
      packing_status: row['packing_status'] as string,
      packed_at: toIso(row['packed_at']),
      dispatched_at: row['dispatched_at'] ? toIso(row['dispatched_at']) : null,
      documents: row['documents'] as WhereShippedEntry['documents'],
    }),
  );

  const placedAtMs = new Date(hold.placed_at).getTime();
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - placedAtMs) / 60_000));
  const budget = config.qc.holdPropagationBudgetMinutes;

  return {
    hold_id: hold.hold_id,
    lot_id: hold.lot_id,
    lot_number: hold.lot_number,
    sku: hold.sku,
    placed_at: hold.placed_at,
    elapsed_minutes: elapsedMinutes,
    propagation_budget_minutes: budget,
    propagation_budget_breached: elapsedMinutes > budget,
    coverage: {
      where_used: [
        'production_order.material_issued (Story 6.2 directed_issue/backflush)',
        'custody.consumption_posted (Story 9.3)',
      ],
      not_yet_covered: ['production genealogy (Story 6.4, not in this query)'],
    },
    movements,
    where_used: whereUsed,
    where_shipped: whereShipped,
  };
}
