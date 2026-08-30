import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';
import { getPool } from '../config/db.js';
import { getProductionOrderByReworkEventId } from '../read/projections/production_order.js';

/**
 * Story 6.3 rework-order resolver (FR-MO-10, AC 7). PURE read-and-compute, the
 * `src/production/completion-outputs.ts` twin: it resolves the Story 8.3 integration contract and
 * refuses everything that would make a rework order unfaithful to it. It creates nothing - the
 * caller persists an ordinary `production_order.created` event carrying the linkage (Binding
 * Decision 9), so every Story 6.1 guarantee (immutable number, state machine, release gate) applies
 * to a rework order unchanged, and its output re-enters the QC gate because it completes through
 * the same path as any other order.
 *
 * The rejected SOURCE lot is deliberately NOT consumed here (Binding Decision 13): the QC gate
 * blocks it with LOT_ON_HOLD reason 'rejected', and unblocking it for its own rework order is a
 * gate-policy change no acceptance criterion asks for.
 */

export interface ReworkRequest {
  rework_event_id: string;
  ncr_id: string;
  lot_id: string;
  lot_number: string;
  task_id: string;
  sku: string;
  site_id: string;
  quantity: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

/**
 * Resolves the qc.rework_requested event a rework order is raised from. A missing event, or an
 * event of any other type, is 404 REWORK_EVENT_NOT_FOUND: the linkage is only meaningful against
 * the Story 8.3 contract, and accepting an arbitrary event id would let a caller mint an
 * unconnected order that claims to be a rework.
 */
export async function resolveReworkRequest(
  reworkEventId: string,
  client?: PoolClient,
): Promise<ReworkRequest> {
  if (!UUID_REGEX.test(reworkEventId)) {
    reject(
      'REWORK_EVENT_NOT_FOUND',
      'source_rework_event_id must be the UUID of a qc.rework_requested event',
      { source_rework_event_id: reworkEventId },
      404,
    );
  }
  const result = await runner(client).query(
    `SELECT event_type, payload FROM domain_events WHERE event_id = $1`,
    [reworkEventId],
  );
  if (result.rows.length === 0 || result.rows[0]!['event_type'] !== 'qc.rework_requested') {
    reject(
      'REWORK_EVENT_NOT_FOUND',
      'The named event is not a persisted qc.rework_requested event',
      {
        source_rework_event_id: reworkEventId,
        event_type: result.rows.length > 0 ? result.rows[0]!['event_type'] : null,
      },
      404,
    );
  }
  const payload = result.rows[0]!['payload'] as Record<string, unknown>;
  // Validated, not cast (code review 2026-08-31). Bare casts turned a malformed payload into the
  // literal string 'undefined' for order_quantity, which reached a ::numeric cast as SQLSTATE
  // 22P02 - a 500 where this module's own contract promises a 404.
  for (const field of ['ncr_id', 'lot_id', 'task_id'] as const) {
    if (!UUID_REGEX.test(String(payload[field] ?? ''))) {
      reject(
        'REWORK_EVENT_NOT_FOUND',
        `The rework request payload is missing a valid ${field}`,
        { source_rework_event_id: reworkEventId, field },
        404,
      );
    }
  }
  for (const field of ['lot_number', 'sku', 'site_id'] as const) {
    if (typeof payload[field] !== 'string' || (payload[field] as string).trim() === '') {
      reject(
        'REWORK_EVENT_NOT_FOUND',
        `The rework request payload is missing a valid ${field}`,
        { source_rework_event_id: reworkEventId, field },
        404,
      );
    }
  }
  const quantity = String(payload['quantity'] ?? '');
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(quantity) || Number(quantity) <= 0) {
    reject(
      'REWORK_EVENT_NOT_FOUND',
      'The rework request payload carries no positive quantity',
      { source_rework_event_id: reworkEventId, quantity: payload['quantity'] ?? null },
      404,
    );
  }
  return {
    rework_event_id: reworkEventId,
    ncr_id: payload['ncr_id'] as string,
    lot_id: payload['lot_id'] as string,
    lot_number: payload['lot_number'] as string,
    task_id: payload['task_id'] as string,
    sku: payload['sku'] as string,
    site_id: payload['site_id'] as string,
    quantity,
  };
}

/**
 * One rework order per rework request. The check-then-act this backs is closed by
 * uq_production_order_source_rework_event, so the sequential path and the race path return the
 * same 409 REWORK_ORDER_EXISTS.
 */
export async function assertNoReworkOrderYet(
  reworkEventId: string,
  client?: PoolClient,
): Promise<void> {
  const existing = await getProductionOrderByReworkEventId(reworkEventId, client);
  if (existing) {
    reject(
      'REWORK_ORDER_EXISTS',
      'A rework order already exists for this rework request',
      {
        source_rework_event_id: reworkEventId,
        existing_production_order_id: existing.production_order_id,
        existing_order_number_ext: existing.order_number_ext,
      },
      409,
    );
  }
}

export interface ReworkOrderDerivation {
  request: ReworkRequest;
  output_item_id: string;
  output_sku: string;
  order_quantity: string;
  order_uom: string;
  plant_location_id: string;
  bom_id: string;
  business_stream: string;
}

/**
 * Derives the new order's fields from the rework request and the item master. Everything is
 * server-derived: the caller supplies only the rework event id, so there is no field a caller can
 * bend to make the rework order describe something other than the rejected lot.
 */
export async function deriveReworkOrder(
  request: ReworkRequest,
  client?: PoolClient,
): Promise<ReworkOrderDerivation> {
  // Task 6.3: the business stream comes from the SOURCE ORDER when the reworked lot was produced
  // by one, and from item_master otherwise (code review 2026-08-31 - the source-order arm was
  // missing entirely, so a rework of a lot produced under a non-default stream was permanently
  // mistagged, and AD-14 forbids re-tagging afterwards). bom_id DESC tiebreaks the BOM choice so
  // the derivation cannot reject nondeterministically across retries.
  const item = await runner(client).query(
    `SELECT im.item_id, im.sku, im.uom,
            COALESCE(
              (SELECT po.business_stream
                 FROM production_completion pc
                 JOIN production_order po ON po.production_order_id = pc.production_order_id
                WHERE pc.lot_id = $2
                ORDER BY pc.created_at DESC, pc.completion_id DESC
                LIMIT 1),
              im.business_stream
            ) AS business_stream,
            (SELECT b.bom_id FROM bom b
              WHERE b.parent_item_id = im.item_id AND b.status = 'released'
                AND b.bom_type = 'production'
              ORDER BY b.created_at DESC, b.bom_id DESC LIMIT 1) AS bom_id
       FROM item_master im WHERE im.sku = $1`,
    [request.sku, request.lot_id],
  );
  if (item.rows.length === 0) {
    reject(
      'REWORK_EVENT_NOT_FOUND',
      'The reworked lot names a sku that does not resolve in the item master',
      { sku: request.sku, source_rework_event_id: request.rework_event_id },
      404,
    );
  }
  const row = item.rows[0]!;
  // Fail closed: a rework order with no released BOM could never pass the Story 6.1 release gate,
  // and minting it would leave an order nobody can act on rather than an actionable rejection.
  if (row['bom_id'] === null || row['bom_id'] === undefined) {
    reject(
      'BOM_NOT_FOUND',
      'The reworked item has no released BOM to raise a rework order against',
      { sku: request.sku, item_id: row['item_id'] },
      404,
    );
  }
  return {
    request,
    output_item_id: row['item_id'] as string,
    output_sku: row['sku'] as string,
    order_quantity: request.quantity,
    order_uom: row['uom'] as string,
    plant_location_id: request.site_id,
    bom_id: row['bom_id'] as string,
    business_stream: row['business_stream'] as string,
  };
}
