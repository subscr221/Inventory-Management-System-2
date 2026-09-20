import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { stockBalanceEventKind } from './stock-balance.js';
import { getItemBySku, STANDARD_COST_DESIGNATION } from '../read/projections/item_master.js';
import {
  findMatchingDoaEntry,
  findRoleHolder,
  findActiveDelegation,
} from '../read/projections/doa_registry.js';
import {
  getInventoryValuation,
  lockInventoryValuation,
  applyValuationReceipt,
  applyValuationIssue,
  applyValuationReturnValue,
  depleteFifoLayersUpTo,
  applyValuationNrvDelta,
  insertFifoLayer,
  lockOpenFifoLayers,
  setFifoLayerRemaining,
  upsertSerialCost,
  takeSerialCost,
  insertNrvAdjustment,
  insertStandardCostVarianceReview,
  cmpMonetary,
  monToNum,
} from '../read/projections/inventory_valuation.js';

/**
 * Central inventory-valuation seam (Story 2.4), split like src/compliance/stock-balance.ts:
 *
 * - assertValuationShape runs BEFORE any DB work, next to the other compliance asserts, so a
 *   malformed NRV/variance event never consumes an idempotency key. stock.received/stock.issued
 *   unit_cost shape is already validated by assertStockBalanceShape - nothing to add here.
 * - applyInventoryValuationProjection runs INSIDE the event transaction, BEFORE the domain_events
 *   insert (Task 2.2), so a rejected write-down/recovery (bad NRV math, unmatched DOA authoriser,
 *   recovery above original cost) writes no event row and consumes no idempotency key.
 *
 * IMPORTANT: this seam is the ONLY place NRV write-down/recovery math, the recovery cap, and DOA
 * authoriser matching are enforced. It must not be treated as a convenience layer behind the
 * src/api/v1/valuation.ts HTTP handlers - persistEvent is reachable directly via POST
 * /api/v1/events and the Story 1.8 edge upload, so any caller holding inventory:write could
 * otherwise post a hand-crafted stock.nrv_recovery_recorded straight past those handlers. Real
 * enforcement (and the AC4 computed fields: original_cost, current_carrying_value,
 * write_down_amount/cumulative_write_down, or post_recovery_carrying_value) happens HERE, by
 * mutating envelope.payload in place before the domain_events insert captures it - the same
 * pattern src/compliance/lot-serial-validation.ts uses for FEFO/FIFO lot auto-selection.
 *
 * Gating is deliberately narrow (Task 2.3): only stream_type "inventory", and only
 * stock.received/stock.issued (reusing stock-balance.ts's own sku+target-location gate so legacy
 * sku-only spine fixtures stay untouched) plus the three valuation-only event types below.
 */

const VALUATION_STREAM_TYPES = new Set(['inventory']);
const VALUATION_EVENT_TYPES = new Set([
  'stock.received',
  'stock.issued',
  'stock.nrv_write_down_recorded',
  'stock.nrv_recovery_recorded',
  'stock.standard_cost_variance_reviewed',
]);

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateString(value: string): boolean {
  if (!DATE_REGEX.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  if (isNaN(parsed.getTime())) return false;
  const [y, m, d] = value.split('-').map(Number);
  return (
    parsed.getUTCFullYear() === y && parsed.getUTCMonth() + 1 === m && parsed.getUTCDate() === d
  );
}
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertNrvCommonShape(envelope: EventEnvelope): void {
  const p = envelope.payload;
  if (!isNonEmptyString(p['sku'])) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `${envelope.event_type} payload requires a non-empty sku`,
      { event_type: envelope.event_type },
    );
  }
  if (typeof p['effective_date'] !== 'string' || !isValidDateString(p['effective_date'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'effective_date must be a valid YYYY-MM-DD date', {
      event_type: envelope.event_type,
    });
  }
  if (typeof p['authoriser_actor_id'] !== 'string' || !UUID_REGEX.test(p['authoriser_actor_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'authoriser_actor_id must be a valid UUID', {
      event_type: envelope.event_type,
    });
  }
  if (!isNonEmptyString(p['reason'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'reason is required and must be a non-empty string', {
      event_type: envelope.event_type,
    });
  }
  if (
    p['evidence_ref'] !== undefined &&
    p['evidence_ref'] !== null &&
    typeof p['evidence_ref'] !== 'string'
  ) {
    throw new AppError(400, 'INVALID_PARAMS', 'evidence_ref must be a string when supplied', {
      event_type: envelope.event_type,
    });
  }
}

export function assertValuationShape(envelope: EventEnvelope): void {
  if (!VALUATION_STREAM_TYPES.has(envelope.stream_type)) return;

  if (envelope.event_type === 'stock.nrv_write_down_recorded') {
    assertNrvCommonShape(envelope);
    if (!isFiniteNumber(envelope.payload['nrv_amount']) || envelope.payload['nrv_amount'] < 0) {
      throw new AppError(400, 'INVALID_PARAMS', 'nrv_amount must be a non-negative finite number', {
        event_type: envelope.event_type,
      });
    }
    return;
  }

  if (envelope.event_type === 'stock.nrv_recovery_recorded') {
    assertNrvCommonShape(envelope);
    if (
      !isFiniteNumber(envelope.payload['recovery_amount']) ||
      envelope.payload['recovery_amount'] <= 0
    ) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'recovery_amount must be a positive finite number',
        { event_type: envelope.event_type },
      );
    }
    return;
  }

  if (envelope.event_type === 'stock.standard_cost_variance_reviewed') {
    if (!isNonEmptyString(envelope.payload['sku'])) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'stock.standard_cost_variance_reviewed payload requires a non-empty sku',
        {},
      );
    }
    if (!isNonEmptyString(envelope.payload['period'])) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'stock.standard_cost_variance_reviewed payload requires a non-empty period',
        {},
      );
    }
    return;
  }

  // stock.received / stock.issued: unit_cost, quantity, stock_class shape is already validated by
  // assertStockBalanceShape - nothing additional to check pre-transaction.
}

/**
 * Resolves the DOA entry governing `transactionType` at `value` and verifies that
 * `authoriserActorId` IS that entry's resolved approver (the active role holder, or their active
 * vacation delegate) - never a hard-coded approver role (Dev Notes). Reuses the same
 * findMatchingDoaEntry -> findRoleHolder -> findActiveDelegation resolution chain as
 * POST /api/v1/doa/resolve and the Story 1.7 calibration-escalation gate.
 */
async function assertDoaApprovedAuthoriser(
  transactionType: string,
  value: number,
  authoriserActorId: string,
  asOfDate: string,
  client: PoolClient,
): Promise<void> {
  const entry = await findMatchingDoaEntry(transactionType, value, client);
  if (!entry) {
    throw new AppError(
      404,
      'NO_DOA_ENTRY_MATCH',
      `No DOA entry governs "${transactionType}" at value ${value}`,
      {
        transaction_type: transactionType,
        value,
      },
    );
  }
  const holder = await findRoleHolder(entry.role, client);
  if (!holder) {
    throw new AppError(404, 'NO_APPROVER_FOUND', `No active user holds role "${entry.role}"`, {
      role: entry.role,
    });
  }
  const delegation = await findActiveDelegation(holder.user_id, asOfDate, client);
  const approverUserId = delegation ? delegation.delegate_user_id : holder.user_id;
  if (authoriserActorId !== approverUserId) {
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      'authoriser_actor_id is not the DOA-resolved approver for this value band',
      {
        transaction_type: transactionType,
        value,
        expected_approver_user_id: approverUserId,
      },
    );
  }
}

/** FIFO issue costing (Task 4.2): deterministic oldest-layer-first depletion, splitting across layers when needed. */
async function depleteFifoLayers(
  sku: string,
  quantity: number,
  client: PoolClient,
): Promise<number> {
  const layers = await lockOpenFifoLayers(sku, client);
  let remaining = quantity;
  let totalCost = 0;
  for (const layer of layers) {
    if (remaining <= 0) break;
    const consumed = Math.min(monToNum(layer.remaining_quantity), remaining);
    totalCost += consumed * monToNum(layer.unit_cost);
    await setFifoLayerRemaining(
      layer.layer_id,
      (monToNum(layer.remaining_quantity) - consumed).toString(),
      client,
    );
    remaining -= consumed;
  }
  if (remaining > 0) {
    throw new AppError(
      400,
      'INSUFFICIENT_FIFO_COST_LAYERS',
      `FIFO item "${sku}" has insufficient cost layers to cover the requested issue quantity: ${remaining} units could not be costed`,
      { sku, requested: quantity, costed: quantity - remaining, remaining },
    );
  }
  return totalCost;
}

async function applyReceiptOrIssue(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const kind = stockBalanceEventKind(envelope);
  if (!kind) return;

  const stockClass =
    typeof envelope.payload['stock_class'] === 'string' ? envelope.payload['stock_class'] : 'owned';
  // Task 4.5: consignment/vmi/job_work stock is not owned inventory for Ind AS 2 carrying value.
  if (stockClass !== 'owned') return;

  const sku = envelope.payload['sku'] as string;
  const item = await getItemBySku(sku, client);
  // Unreachable in practice - assertInventoryMasterReferences already rejected an unknown sku
  // before the transaction opened - but fail closed (skip valuation) rather than throw here;
  // valuation is not the seam responsible for ITEM_NOT_FOUND.
  if (!item) return;

  const quantity = envelope.payload['quantity'] as number;

  if (kind === 'receipt') {
    const unitCost = envelope.payload['unit_cost'];
    // Dev Notes: unit_cost stays OPTIONAL on stock.received for legacy/non-valuated events - a
    // receipt that omits it is a physically valid movement that simply contributes no cost basis.
    if (typeof unitCost !== 'number') {
      await lockInventoryValuation(sku, client);
      return;
    }

    await applyValuationReceipt(sku, quantity, unitCost, client);

    if (item.valuation_method === 'fifo') {
      await insertFifoLayer({ sku, unit_cost: unitCost, quantity, event_id: eventId }, client);
    } else if (item.valuation_method === 'specific_identification') {
      const serials = envelope.payload['serials'] as Array<{ serial_number: string }> | undefined;
      if (serials && serials.length > 0) {
        for (const serial of serials) {
          await upsertSerialCost(
            { sku, serial_number: serial.serial_number, unit_cost: unitCost },
            client,
          );
        }
      } else {
        throw new AppError(
          400,
          'INVALID_PARAMS',
          `specific_identification item "${sku}" requires serials on receipt to record per-serial cost`,
          { sku, valuation_method: item.valuation_method },
        );
      }
    }
    return;
  }

  // issue
  let cost: number;
  if (item.valuation_method === 'fifo') {
    cost = await depleteFifoLayers(sku, quantity, client);
  } else if (item.valuation_method === 'specific_identification') {
    const serials = envelope.payload['serials'] as Array<{ serial_number: string }> | undefined;
    cost = 0;
    if (serials && serials.length > 0) {
      for (const serial of serials) {
        const serialCost = await takeSerialCost(sku, serial.serial_number, client);
        if (serialCost !== null) cost += serialCost;
      }
    }
  } else {
    // weighted_average: cost the issue at the CURRENT running average (locked - Dev Notes: lock
    // the valuation row before update). Issues never change the average itself, only receipts do.
    const current = await lockInventoryValuation(sku, client);
    cost =
      quantity *
      (current.running_average_cost !== null ? monToNum(current.running_average_cost) : 0);
  }
  await applyValuationIssue(sku, quantity, cost, client);
}

/**
 * Owner ruling 2026-09-20 ("valuation must follow outgoing stock"; supersedes Story 6.2 Binding
 * Decision 9, closes deferred-work row 474). What an outflow took out of inventory_valuation,
 * frozen onto the event payload as NUMERIC strings BEFORE the domain_events insert (the Pilot B4
 * receipt precedent). The block is the AUDIT RECORD of the relief and the basis of a later return.
 * It is NOT a replay input: this repo has no projection rebuild path (nothing re-runs appliers
 * over domain_events), so inventory_valuation is not rebuildable today, and a block a client puts
 * on a live post is always overwritten by the seam, never applied.
 */
export interface ValuationOutflow {
  sku: string;
  valuation_method: string | null;
  /** Unit cost the valued part left at; null when nothing was valued. */
  unit_cost: string | null;
  valued_quantity: string;
  /** Physical quantity that carried no cost basis (see applyValuationOutflow). */
  unvalued_quantity: string;
  /** The amount ACTUALLY taken out of carrying_value (after the clamp to what was carried). */
  value: string;
}

/**
 * Relieves inventory_valuation for a TRUE outflow of OWNED stock posted by a seam that moves stock
 * directly (production issue/backflush, job-work own material, spares issue, customer dispatch,
 * cycle-count loss, quality scrap, return to vendor) - the top-level seam above only sees
 * inventory-stream stock.issued. Callers decide ownership and direction: relocations, inter-site
 * transfers (the grain is SKU, enterprise-wide) and non-owned classes must never call this. Must
 * run inside the event transaction, AFTER the stock drain (the persistEvent lock order: stock rows,
 * then the valuation row); a seam that relieves several SKUs drains ALL its stock rows first and
 * then calls this in ascending SKU order, so two opposite-order transactions cannot deadlock.
 *
 * Rule for stock with no cost basis (sites loaded before the ruling, unpriced/foreign-currency
 * receipts, unvalued production output): the outflow NEVER fails. Valuation is relieved for
 * min(quantity, valued quantity on hand) and the rest is recorded as unvalued_quantity.
 * - weighted_average: at the CARRYING cost per unit (carrying_value / quantity_on_hand) of the
 *   locked row - the running average until an NRV write-down, the written-down cost after it
 *   (owner default D2) - so the last unit out takes exactly the last of the carrying value.
 * - fifo: oldest layers first, as far as they reach, scaled down to the carrying value when a
 *   write-down has taken it below the layer cost. The walk is one SQL NUMERIC statement.
 * - specific_identification: these seams carry no serials, so nothing is relieved and all of it
 *   is unvalued; quantity_on_hand still drops at cost 0, exactly as a serial-less inventory-stream
 *   stock.issued leaves the row.
 */
export async function applyValuationOutflow(
  input: { sku: string; quantity: string | number },
  client: PoolClient,
): Promise<ValuationOutflow> {
  const { sku } = input;
  const quantity = String(input.quantity);
  const item = await getItemBySku(sku, client);
  const method = item?.valuation_method ?? null;

  const none: ValuationOutflow = {
    sku,
    valuation_method: method,
    unit_cost: null,
    valued_quantity: '0',
    unvalued_quantity: quantity,
    value: '0',
  };
  if (!item) return none;

  const current = await lockInventoryValuation(sku, client);
  if (method === 'specific_identification') {
    await applyValuationIssue(sku, quantity, '0', client);
    return none;
  }
  if (cmpMonetary(current.quantity_on_hand, '0') <= 0) return none;

  // fifo: the layers decide how much is valued and at what cost; null for a weighted average.
  const walk =
    method === 'fifo'
      ? await depleteFifoLayersUpTo(sku, quantity, current.quantity_on_hand, client)
      : null;
  // $1 quantity, $2 quantity_on_hand, $3 carrying_value, $4-$6 the fifo walk. A full drain takes
  // the whole carrying value, so no rounding dust is left behind on an empty row.
  const settled = await client.query(
    `SELECT v::text AS valued, ($1::numeric - v)::text AS unvalued, value::text AS value,
            CASE WHEN v > 0 THEN round(value / v, 6)::text END AS unit_cost
       FROM (SELECT v, LEAST($3::numeric, CASE
                      WHEN v >= $2::numeric THEN $3::numeric
                      WHEN $5::numeric IS NULL THEN round(v * $3::numeric / $2::numeric, 6)
                      WHEN $6::numeric > $3::numeric
                        THEN round($5::numeric * $3::numeric / $6::numeric, 6)
                      ELSE round($5::numeric, 6) END) AS value
               FROM (SELECT round(LEAST($1::numeric, $2::numeric,
                                        COALESCE($4::numeric, $1::numeric)), 6) AS v) q) s`,
    [
      quantity,
      current.quantity_on_hand,
      current.carrying_value,
      walk?.costed ?? null,
      walk?.cost ?? null,
      walk?.layer_total ?? null,
    ],
  );
  const row = settled.rows[0] as Record<string, string | null>;
  if (cmpMonetary(row['valued']!, '0') <= 0) return none;

  await applyValuationIssue(sku, row['valued']!, row['value']!, client);
  return {
    sku,
    valuation_method: method,
    unit_cost: row['unit_cost'] ?? null,
    valued_quantity: row['valued']!,
    unvalued_quantity: row['unvalued']!,
    value: row['value']!,
  };
}

/**
 * Splits one relieved block over the parts of the movement it covers (the drained balance rows of
 * a production issue, in drain order), in SQL NUMERIC: the valued quantity fills the parts in
 * order, each part's value is the difference of two cumulative shares, so the parts add up to the
 * block EXACTLY and whatever is left over is unvalued at zero (owner default D1). `blended_unit_cost`
 * is the part's value over its WHOLE quantity - the cost a ledger that prices quantity x unit_cost
 * (the WIP ledger) must carry so it holds the relieved value and nothing more.
 */
export async function splitValuationOutflow(
  block: ValuationOutflow,
  quantities: string[],
  client: PoolClient,
): Promise<Array<{ valuation: ValuationOutflow; blended_unit_cost: string }>> {
  const result = await client.query(
    `WITH part AS (
       SELECT ord, q::numeric AS q, SUM(q::numeric) OVER (ORDER BY ord) AS cum_q
         FROM unnest($1::text[]) WITH ORDINALITY AS t(q, ord)),
     cum AS (
       SELECT ord, q, LEAST(cum_q, $2::numeric) AS cum_v,
              CASE WHEN $2::numeric <= 0 THEN 0
                   WHEN cum_q >= $2::numeric THEN $3::numeric
                   ELSE round($3::numeric * cum_q / $2::numeric, 6) END AS cum_value
         FROM part),
     share AS (
       SELECT ord, q, cum_v - COALESCE(LAG(cum_v) OVER (ORDER BY ord), 0) AS v,
              cum_value - COALESCE(LAG(cum_value) OVER (ORDER BY ord), 0) AS value
         FROM cum)
     SELECT v::text AS valued, (q - v)::text AS unvalued, value::text AS value,
            CASE WHEN v > 0 THEN round(value / v, 6)::text END AS unit_cost,
            round(value / q, 6)::text AS blended
       FROM share ORDER BY ord`,
    [quantities, block.valued_quantity, block.value],
  );
  return (result.rows as Array<Record<string, string | null>>).map((row) => ({
    valuation: {
      sku: block.sku,
      valuation_method: block.valuation_method,
      unit_cost: row['unit_cost'] ?? null,
      valued_quantity: row['valued']!,
      unvalued_quantity: row['unvalued']!,
      value: row['value']!,
    },
    blended_unit_cost: row['blended']!,
  }));
}

/**
 * Return to stock of something applyValuationOutflow relieved (production material return, spare
 * return): adds back the value the matching issue took out, never today's average, or the average
 * drifts - and never more than that, so a return cannot reverse an NRV write-down (owner default
 * D2). Only the valued share of the issue comes back, so an issue that relieved nothing (one that
 * predates the ruling included: `issue` null) restores nothing.
 *
 * `returned_before` is the quantity already returned against this issue. Each return restores the
 * DIFFERENCE of two cumulative shares of the issue's frozen figures, so N partial returns never
 * drift: the last one restores exactly what is left of the issue's valued quantity and value.
 */
export async function applyValuationReturn(
  input: {
    sku: string;
    quantity: string | number;
    issue: ValuationOutflow | null;
    returned_before: string;
  },
  client: PoolClient,
  eventId: string,
): Promise<ValuationOutflow> {
  const { sku, issue } = input;
  const quantity = String(input.quantity);
  const none: ValuationOutflow = {
    sku,
    valuation_method: issue?.valuation_method ?? null,
    unit_cost: null,
    valued_quantity: '0',
    unvalued_quantity: quantity,
    value: '0',
  };
  if (!issue || cmpMonetary(issue.valued_quantity, '0') <= 0) return none;

  // $1 this return, $2 returned before, $3/$4 the issue's valued/unvalued quantity, $5 its value.
  const settled = await client.query(
    `SELECT v::text AS valued, ($1::numeric - v)::text AS unvalued, value::text AS value,
            CASE WHEN v > 0 THEN round(value / v, 6)::text END AS unit_cost
       FROM (SELECT
               CASE WHEN aft >= total THEN $3::numeric ELSE round($3::numeric * aft / total, 6) END
             - CASE WHEN bef >= total THEN $3::numeric ELSE round($3::numeric * bef / total, 6) END
               AS v,
               CASE WHEN aft >= total THEN $5::numeric ELSE round($5::numeric * aft / total, 6) END
             - CASE WHEN bef >= total THEN $5::numeric ELSE round($5::numeric * bef / total, 6) END
               AS value
               FROM (SELECT $2::numeric AS bef, $2::numeric + $1::numeric AS aft,
                            $3::numeric + $4::numeric AS total) q) s`,
    [quantity, input.returned_before, issue.valued_quantity, issue.unvalued_quantity, issue.value],
  );
  const row = settled.rows[0] as Record<string, string | null>;
  if (cmpMonetary(row['valued']!, '0') <= 0) return none;

  await applyValuationReturnValue(sku, row['valued']!, row['value']!, client);
  if (issue.valuation_method === 'fifo') {
    await insertFifoLayer(
      { sku, unit_cost: row['unit_cost']!, quantity: row['valued']!, event_id: eventId },
      client,
    );
  }
  return {
    sku,
    valuation_method: issue.valuation_method,
    unit_cost: row['unit_cost'] ?? null,
    valued_quantity: row['valued']!,
    unvalued_quantity: row['unvalued']!,
    value: row['value']!,
  };
}

/**
 * A quantity gain with no purchase price (cycle-count positive adjustment, owner default D3): the
 * units come in at the CURRENT carrying cost per unit when valuation has one, so the average does
 * not move; with no cost basis on hand they are recorded unvalued - a price is never invented.
 */
export async function applyValuationGainAtCarryingCost(
  input: { sku: string; quantity: string | number },
  client: PoolClient,
  eventId: string,
): Promise<ValuationOutflow> {
  const { sku } = input;
  const quantity = String(input.quantity);
  const item = await getItemBySku(sku, client);
  const method = item?.valuation_method ?? null;
  const none: ValuationOutflow = {
    sku,
    valuation_method: method,
    unit_cost: null,
    valued_quantity: '0',
    unvalued_quantity: quantity,
    value: '0',
  };
  if (!item || method === 'specific_identification') return none;
  const current = await lockInventoryValuation(sku, client);
  if (cmpMonetary(current.quantity_on_hand, '0') <= 0) return none;

  const settled = await client.query(
    `SELECT round($1::numeric * $3::numeric / $2::numeric, 6)::text AS value,
            round($3::numeric / $2::numeric, 6)::text AS unit_cost`,
    [quantity, current.quantity_on_hand, current.carrying_value],
  );
  const row = settled.rows[0] as Record<string, string>;
  await applyValuationReturnValue(sku, quantity, row['value']!, client);
  if (method === 'fifo') {
    await insertFifoLayer(
      { sku, unit_cost: row['unit_cost']!, quantity, event_id: eventId },
      client,
    );
  }
  return {
    sku,
    valuation_method: method,
    unit_cost: row['unit_cost']!,
    valued_quantity: quantity,
    unvalued_quantity: '0',
    value: row['value']!,
  };
}

/** Reads a frozen valuation block back off a persisted payload value (null when absent/malformed). */
export function asValuationOutflow(value: unknown): ValuationOutflow | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['sku'] !== 'string' || typeof v['valued_quantity'] !== 'string') return null;
  if (typeof v['unvalued_quantity'] !== 'string' || typeof v['value'] !== 'string') return null;
  return {
    sku: v['sku'],
    valuation_method: typeof v['valuation_method'] === 'string' ? v['valuation_method'] : null,
    unit_cost: typeof v['unit_cost'] === 'string' ? v['unit_cost'] : null,
    valued_quantity: v['valued_quantity'],
    unvalued_quantity: v['unvalued_quantity'],
    value: v['value'],
  };
}

async function applyNrvWriteDown(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const sku = envelope.payload['sku'] as string;
  const nrvAmount = envelope.payload['nrv_amount'] as number;
  const effectiveDate = envelope.payload['effective_date'] as string;
  const authoriserActorId = envelope.payload['authoriser_actor_id'] as string;
  const reason = envelope.payload['reason'] as string;
  const evidenceRef = (envelope.payload['evidence_ref'] as string | null | undefined) ?? null;

  const current = await lockInventoryValuation(sku, client);
  if (cmpMonetary(current.carrying_value, '0') <= 0) {
    throw new AppError(400, 'INVALID_PARAMS', `Item "${sku}" has no carrying value to write down`, {
      sku,
    });
  }
  if (cmpMonetary(String(nrvAmount), current.carrying_value) >= 0) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'nrv_amount must be less than the current carrying value',
      {
        sku,
        nrv_amount: nrvAmount,
        current_carrying_value: current.carrying_value,
      },
    );
  }

  const writeDownAmount = monToNum(current.carrying_value) - nrvAmount;
  // The FIRST write-down against an un-written-down item captures the cost basis recovery may
  // never exceed; a second write-down while one is already open does not move that ceiling.
  const originalCost = current.pre_writedown_cost ?? current.carrying_value;
  const cumulativeWriteDownAfter = monToNum(current.cumulative_write_down) + writeDownAmount;

  await assertDoaApprovedAuthoriser(
    'inventory.nrv_write_down',
    writeDownAmount,
    authoriserActorId,
    effectiveDate,
    client,
  );

  await applyValuationNrvDelta(
    sku,
    -writeDownAmount,
    monToNum(originalCost),
    writeDownAmount,
    client,
  );
  await insertNrvAdjustment(
    {
      sku,
      adjustment_type: 'write_down',
      effective_date: effectiveDate,
      authoriser_actor_id: authoriserActorId,
      original_cost: monToNum(originalCost),
      carrying_value_before: monToNum(current.carrying_value),
      carrying_value_after: nrvAmount,
      amount: writeDownAmount,
      cumulative_write_down_after: cumulativeWriteDownAfter,
      reason,
      evidence_ref: evidenceRef,
      event_id: eventId,
    },
    client,
  );

  envelope.payload['original_cost'] = monToNum(originalCost);
  envelope.payload['current_carrying_value'] = monToNum(current.carrying_value);
  envelope.payload['write_down_amount'] = writeDownAmount;
  envelope.payload['cumulative_write_down'] = cumulativeWriteDownAfter;
}

async function applyNrvRecovery(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const sku = envelope.payload['sku'] as string;
  const recoveryAmount = envelope.payload['recovery_amount'] as number;
  const effectiveDate = envelope.payload['effective_date'] as string;
  const authoriserActorId = envelope.payload['authoriser_actor_id'] as string;
  const reason = envelope.payload['reason'] as string;
  const evidenceRef = (envelope.payload['evidence_ref'] as string | null | undefined) ?? null;

  const current = await lockInventoryValuation(sku, client);
  if (current.pre_writedown_cost === null) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `Item "${sku}" has no active write-down to recover against`,
      { sku },
    );
  }

  const postRecoveryCarryingValue = monToNum(current.carrying_value) + recoveryAmount;
  if (cmpMonetary(String(postRecoveryCarryingValue), current.pre_writedown_cost) > 0) {
    throw new AppError(
      409,
      'NRV_RECOVERY_EXCEEDS_ORIGINAL_COST',
      'Recovery would carry the item above its original cost',
      {
        sku,
        recovery_amount: recoveryAmount,
        current_carrying_value: current.carrying_value,
        original_cost: current.pre_writedown_cost,
        post_recovery_carrying_value: postRecoveryCarryingValue,
      },
    );
  }

  await assertDoaApprovedAuthoriser(
    'inventory.nrv_recovery',
    recoveryAmount,
    authoriserActorId,
    effectiveDate,
    client,
  );

  const fullyRecovered =
    cmpMonetary(String(postRecoveryCarryingValue), current.pre_writedown_cost) >= 0;
  const originalCost = current.pre_writedown_cost;
  const cumulativeWriteDownAfter = Math.max(
    0,
    monToNum(current.cumulative_write_down) - recoveryAmount,
  );

  await applyValuationNrvDelta(
    sku,
    recoveryAmount,
    fullyRecovered ? null : monToNum(originalCost),
    -recoveryAmount,
    client,
  );
  await insertNrvAdjustment(
    {
      sku,
      adjustment_type: 'recovery',
      effective_date: effectiveDate,
      authoriser_actor_id: authoriserActorId,
      original_cost: monToNum(originalCost),
      carrying_value_before: monToNum(current.carrying_value),
      carrying_value_after: postRecoveryCarryingValue,
      amount: recoveryAmount,
      cumulative_write_down_after: cumulativeWriteDownAfter,
      reason,
      evidence_ref: evidenceRef,
      event_id: eventId,
    },
    client,
  );

  envelope.payload['original_cost'] = monToNum(originalCost);
  envelope.payload['current_carrying_value'] = monToNum(current.carrying_value);
  envelope.payload['post_recovery_carrying_value'] = postRecoveryCarryingValue;
}

async function applyStandardCostVarianceReview(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const sku = envelope.payload['sku'] as string;
  const period = envelope.payload['period'] as string;

  const item = await getItemBySku(sku, client);
  if (
    !item ||
    item.standard_cost_designation !== STANDARD_COST_DESIGNATION ||
    item.standard_cost_amount === null
  ) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `Item "${sku}" is not configured for the standard-cost measurement technique`,
      { sku },
    );
  }

  const current = await lockInventoryValuation(sku, client);
  const qtyOnHand = monToNum(current.quantity_on_hand);
  if (qtyOnHand <= 0) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `Item "${sku}" has no quantity on hand to review variance against`,
      { sku },
    );
  }

  const standardCost = item.standard_cost_amount!;
  const actualCost = monToNum(current.carrying_value) / qtyOnHand;
  const varianceAmount = actualCost - standardCost;
  const variancePercent = standardCost !== 0 ? (varianceAmount / standardCost) * 100 : null;
  const tolerancePercent = item.variance_tolerance_percent;
  const breached =
    standardCost === 0
      ? Math.abs(varianceAmount) > 0
      : tolerancePercent !== null &&
        variancePercent !== null &&
        Math.abs(variancePercent) > tolerancePercent;

  await insertStandardCostVarianceReview(
    {
      sku,
      period,
      standard_cost: standardCost,
      actual_cost: actualCost,
      variance_amount: varianceAmount,
      variance_percent: variancePercent,
      tolerance_percent: tolerancePercent,
      breached,
      event_id: eventId,
    },
    client,
  );

  envelope.payload['standard_cost'] = standardCost;
  envelope.payload['actual_cost'] = actualCost;
  envelope.payload['variance_amount'] = varianceAmount;
  envelope.payload['variance_percent'] = variancePercent;
  envelope.payload['tolerance_percent'] = tolerancePercent;
  envelope.payload['breached'] = breached;
}

export async function applyInventoryValuationProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (!VALUATION_STREAM_TYPES.has(envelope.stream_type)) return;
  if (!VALUATION_EVENT_TYPES.has(envelope.event_type)) return;

  // Idempotency no-op guard (Task 2.4), mirroring stock-balance.ts/lot-serial-validation.ts: this
  // runs before the domain_events INSERT that would trigger uq_idempotency, so a retried
  // write-down/recovery/receipt/issue must not double-apply.
  if (envelope.idempotency_key || envelope.event_id) {
    const existing = await client.query(
      `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
      [envelope.idempotency_key ?? null, envelope.event_id ?? null],
    );
    if (existing.rows.length > 0) return;
  }

  if (envelope.event_type === 'stock.received' || envelope.event_type === 'stock.issued') {
    await applyReceiptOrIssue(envelope, client, eventId);
    return;
  }
  if (envelope.event_type === 'stock.nrv_write_down_recorded') {
    await applyNrvWriteDown(envelope, client, eventId);
    return;
  }
  if (envelope.event_type === 'stock.nrv_recovery_recorded') {
    await applyNrvRecovery(envelope, client, eventId);
    return;
  }
  if (envelope.event_type === 'stock.standard_cost_variance_reviewed') {
    await applyStandardCostVarianceReview(envelope, client, eventId);
  }
}

// Re-exported for the valuation read API (src/api/v1/valuation.ts), which needs to report
// method-specific detail (FIFO layers, serial costs) alongside the summary row.
export { getInventoryValuation };
