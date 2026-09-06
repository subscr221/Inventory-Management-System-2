import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import type { CustodyOffcutRecordedPayload } from '../events/schema.js';
import { AppError } from '../middleware/error.js';
import { getItemBySku } from '../read/projections/item_master.js';
import { createLot } from '../read/projections/lot_master.js';
import { insertOffcutHolding } from '../read/projections/job_work_offcut_holding.js';
import {
  insertCustodyLedgerEntry,
  customerCustodyBalance,
} from '../read/projections/custody_ledger_entry.js';
import type { AuditEntryPayload } from '../read/projections/audit_log.js';
import { toIstCalendarDate } from '../lib/business-days.js';
import { applyStockBalanceProjection } from './stock-balance.js';
import { JOB_WORK_STOCK_CLASS } from './jobwork-receipt.js';
import { qtyAdd, qtyNegate } from './custody-statement.js';
import {
  CUSTODY_OFFCUT_RECORDED,
  CUSTODY_RETURN,
  alreadyPersisted,
  appendCustodyTrace,
  classifyDuplicate,
  custodyBalanceCovers,
  orderAcceptsCustodyReturn,
  requireInProcessOrder,
  resolveLocation,
} from './custody-ledger.js';

/**
 * Story 9.6 REVISED (FR-JW-09/10): CAPTURE of contractual offcut into its own holding ledger.
 *
 * Sprint change proposal 2026-09-05 reversed the original model, in which the disposition and the
 * rate were elected at order confirmation and one posting settled, valued, converted and billed the
 * offcut. That model was commercially wrong. Offcut is its OWN asset with its own contract, and its
 * fate is not known when the material is produced.
 *
 * THIS module now does exactly one thing: it moves offcut out of the customer's custody account and
 * into the offcut holding ledger, UNVALUED. It does not price it, does not convert it to own stock,
 * does not raise a billing line, does not render documents and does not stop the statutory clock.
 * All of that is disposal, and disposal is Story 9.7, performed by the finance controller when the
 * offcut's fate is actually known.
 *
 * WHAT CAPTURE DOES, in order (the 7.4 lock rule: advisory lock, order row FOR UPDATE, then plain
 * SELECTs, then the stock rows, then the ledger rows):
 *   1. Locks the order and re-reads it. The order must carry a contractual offcut arrangement;
 *      nothing else about the offcut is elected here.
 *   2. Re-derives the same three gates the 9.3 custody path uses: the lot must have been received
 *      under THIS order for this sku, the uom must match how the sku is carried, and the customer
 *      custody balance must cover the quantity.
 *   3. Drains the segregated `job_work` stock through the EXISTING CUSTODY_RETURN Symbol door, then
 *      MINTS A NEW LOT and receives the quantity into the `offcut` stock class. The mint is not
 *      decoration: the laundering bar is lot-ROW based, so receiving a second segregated class onto
 *      a lot that has ever held a `job_work` balance row is refused regardless of on_hand. The new
 *      lot has no history, so the receipt is clean. `source_lot_id` on the holding row carries the
 *      genealogy back to the customer's lot.
 *   4. Writes the custody ledger drain row and the holding-ledger row.
 *
 * THE OWNERSHIP TENSION (see read/projections/job_work_offcut_holding.sql for the full statement).
 * The custody drain takes `customerCustodyBalance` to zero so the Story 9.5 closure gate is
 * reachable and a finished order can close. The material is nonetheless still the CUSTOMER'S until
 * disposal, and the CGST Section 143 clock KEEPS RUNNING against it - which is precisely why
 * `reconcileReturnClocks` is NOT called here, unlike every other custody drain in Epic 9. Stopping
 * the clock at capture would erase an exposure that is still open. Story 9.7 stops it at disposal,
 * and Story 9.7's sweep must read the holding ledger so retained offcut ages visibly.
 *
 * GENEALOGY: read/projections/lot_trace.sql has a UNIQUE index on event_id, so ONE event can carry
 * ONE trace row. The trace row written here is the customer lot's drain. The minted offcut lot's
 * provenance is carried by job_work_offcut_holding (holding_id, lot_id, source_lot_id), never by a
 * second trace row under the same event.
 */

const CUSTODY_STREAM_TYPES = new Set(['custody']);
/** The 9.1 governed business stream code carried on every job-work lot_trace row. */
const JOB_WORK_BUSINESS_STREAM = 'job_work';
/**
 * Contractual offcut retained pending disposal. Customer-owned and laundering-barred exactly like
 * `job_work`, but a distinct class so material awaiting a disposal decision is separable from
 * material still in process on the shop floor.
 */
export const OFFCUT_STOCK_CLASS = 'offcut';

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

// ---------------------------------------------------------------------------
// Pure predicate (parameterised so unit tests can fail it - the 8.4 lesson)
// ---------------------------------------------------------------------------

/**
 * Binding decision 1, as revised: offcut may be captured only against an order that carries a
 * contractual offcut arrangement. There is deliberately NO election check and NO settled check any
 * more - the disposition is decided at disposal (Story 9.7), and an order may produce offcut in
 * several batches over its life.
 */
export function offcutCaptureOpen(
  order: Pick<ServiceOrderContractualOffcut, 'has_contractual_offcut'>,
): { open: true } | { open: false; reason: string } {
  if (order.has_contractual_offcut !== true) return { open: false, reason: 'not_contractual' };
  return { open: true };
}

interface ServiceOrderContractualOffcut {
  has_contractual_offcut: boolean;
}

// ---------------------------------------------------------------------------
// Applier
// ---------------------------------------------------------------------------

export async function applyCustodyOffcutProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  _auditCtx?: Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>,
): Promise<void> {
  if (envelope.event_type !== CUSTODY_OFFCUT_RECORDED) return;
  if (!CUSTODY_STREAM_TYPES.has(envelope.stream_type)) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as CustodyOffcutRecordedPayload;
  const occurredAt = envelope.metadata.occurred_at ?? new Date().toISOString();

  // 1. Order advisory lock + FOR UPDATE, then the arrangement re-read from the ROW. Hold-bypass
  // class: a direct POST /api/v1/events meets this identical wall.
  const order = await requireInProcessOrder(
    p.service_order_id,
    p.site_id,
    client,
    orderAcceptsCustodyReturn,
  );
  const gate = offcutCaptureOpen(order);
  if (!gate.open) {
    reject(
      'OFFCUT_ELECTION_MISSING',
      'This service order has no contractual offcut arrangement, so no offcut may be captured against it',
      {
        service_order_id: order.service_order_id,
        reason: gate.reason,
        has_contractual_offcut: order.has_contractual_offcut,
      },
      409,
    );
  }

  // 2. The lot must have been received under THIS order for this sku (the 9.5 return gate).
  const received = await client.query(
    `SELECT 1 FROM jobwork_material_receipt
      WHERE service_order_id = $1 AND sku = $2 AND lot_id = $3 LIMIT 1`,
    [order.service_order_id, p.sku, p.lot_id],
  );
  if (received.rows.length === 0) {
    reject(
      'CROSS_ISSUE_BLOCKED',
      'The named lot was not received under this service order for this sku',
      {
        service_order_id: order.service_order_id,
        sku: p.sku,
        lot_id: p.lot_id,
        demand_kind: 'custody_offcut',
      },
      409,
    );
  }

  const existingUomResult = await client.query(
    `SELECT uom FROM custody_ledger_entry
      WHERE service_order_id = $1 AND sku = $2 AND ownership = 'customer'
      ORDER BY occurred_at ASC LIMIT 1`,
    [order.service_order_id, p.sku],
  );
  const existingUom = existingUomResult.rows[0]?.['uom'] as string | undefined;
  if (existingUom && p.uom !== existingUom) {
    reject(
      'INVALID_PARAMS',
      'The offcut uom must match the uom this sku is carried in on the custody ledger',
      { service_order_id: order.service_order_id, sku: p.sku, uom: p.uom, ledger_uom: existingUom },
      400,
    );
  }

  const balance = await customerCustodyBalance(order.service_order_id, p.sku, client);
  if (!custodyBalanceCovers(balance, p.quantity)) {
    reject(
      'INSUFFICIENT_STOCK',
      'The offcut quantity exceeds the customer-owned custody balance for this sku',
      {
        service_order_id: order.service_order_id,
        sku: p.sku,
        requested_qty: p.quantity,
        custody_balance_qty: balance,
      },
      409,
    );
  }

  // 3a. Drain the job_work stock through the EXISTING CUSTODY_RETURN door (Binding decision 3).
  const location = await resolveLocation(p.location_id, client);
  const stockView: EventEnvelope = {
    ...envelope,
    event_id: eventId,
    stream_type: 'inventory',
    event_type: 'stock.issued',
    payload: {
      sku: p.sku,
      target_location_id: location.location_id,
      lot_id: p.lot_id,
      quantity: p.quantity,
      stock_class: JOB_WORK_STOCK_CLASS,
      business_stream: JOB_WORK_BUSINESS_STREAM,
    },
  };
  (stockView as unknown as Record<symbol, unknown>)[CUSTODY_RETURN] = true;
  await applyStockBalanceProjection(stockView, client);

  // 3b. Mint the offcut lot and receive the quantity into the segregated `offcut` class. A NEW lot
  // is required, not a reuse: the laundering bar is lot-ROW based and would refuse a second
  // segregated class on a lot that has ever carried a job_work row.
  const item = await getItemBySku(p.sku, client);
  if (!item) {
    reject(
      'ITEM_NOT_FOUND',
      'The offcut sku has no item_master record to hold the offcut lot under',
      { sku: p.sku },
      409,
    );
  }
  const sequenceResult = await client.query(
    `SELECT COUNT(*)::int AS n FROM job_work_offcut_holding WHERE service_order_id = $1`,
    [order.service_order_id],
  );
  // This posting's holding row is not written yet, so the sequence needs the +1.
  const sequence = (sequenceResult.rows[0]!['n'] as number) + 1;
  // The site discriminator keeps two sites running the same external order number from colliding
  // on uq_lot_master_lot_number (the 9.4 lot-number lesson).
  const offcutLotNumber = `${order.order_number_ext}-${order.site_id.slice(0, 8)}-OC${sequence}`;
  try {
    await createLot(
      {
        lot_number: offcutLotNumber,
        sku: p.sku,
        expiry_date: null,
        quality_hold_status: 'none',
        quality_hold_reason: null,
      },
      client,
    );
  } catch (err: unknown) {
    // uq_lot_master_lot_number is GLOBAL while order_number_ext is unique only per site, and the
    // eight-character site prefix in the lot number is a truncation rather than a key - so a
    // collision is reachable and must be a classified 409, not a raw 500 (fixed 2026-09-06).
    classifyDuplicate(err, p.offcut_id, eventId);
  }
  // Through the COMPLIANCE SEAM, not the raw projection (fixed 2026-09-06). The module header
  // justifies minting a new lot precisely BECAUSE the laundering bar is lot-row based and would
  // refuse a second segregated class on a lot that has held `job_work` - but the previous code
  // called `applyStockReceipt` directly, so the bar it named as its reason was never invoked, and
  // neither were the quantity ceiling or the location checks. The mint means the bar has nothing to
  // catch here; that is the point, and now the bar actually runs and says so.
  const receiptView: EventEnvelope = {
    ...envelope,
    event_id: eventId,
    stream_type: 'inventory',
    event_type: 'stock.received',
    payload: {
      sku: p.sku,
      target_location_id: location.location_id,
      lot_id: offcutLotNumber,
      quantity: p.quantity,
      stock_class: OFFCUT_STOCK_CLASS,
      business_stream: JOB_WORK_BUSINESS_STREAM,
    },
  };
  await applyStockBalanceProjection(receiptView, client);

  // 4. The custody drain row, then the holding row.
  const quantityDelta = qtyNegate(p.quantity);
  try {
    await insertCustodyLedgerEntry(
      {
        entry_id: p.offcut_id,
        service_order_id: order.service_order_id,
        customer_party_code: order.customer_party_code,
        movement_category: 'offcut',
        ownership: 'customer',
        sku: p.sku,
        lot_id: p.lot_id,
        location_id: location.location_id,
        quantity_delta: quantityDelta,
        uom: p.uom,
        // Nothing is billable at capture: the offcut is unvalued until disposal (Story 9.7).
        billable: false,
        bom_line_id: null,
        kit_bom_revision_id: null,
        receipt_id: null,
        variance_qty: null,
        variance_flagged: null,
        site_id: order.site_id,
        posted_by: p.posted_by,
        occurred_at: occurredAt,
        business_date: toIstCalendarDate(new Date(occurredAt)),
        source_event_id: eventId,
        source_event_type: CUSTODY_OFFCUT_RECORDED,
        correlation_id: envelope.metadata.correlation_id ?? null,
        // The offcut contract is the reference this movement cites; the order number is the
        // fallback when the contract has not been agreed yet.
        reference_ext: order.offcut_contract_ref_ext ?? order.order_number_ext,
      },
      client,
    );
  } catch (err: unknown) {
    classifyDuplicate(err, p.offcut_id, eventId);
  }

  try {
    await insertOffcutHolding(
      {
        holding_id: p.offcut_id,
        service_order_id: order.service_order_id,
        customer_party_code: order.customer_party_code,
        offcut_contract_ref_ext: order.offcut_contract_ref_ext ?? null,
        sku: p.sku,
        lot_id: offcutLotNumber,
        source_lot_id: p.lot_id,
        location_id: location.location_id,
        quantity: p.quantity,
        uom: p.uom,
        captured_at: occurredAt,
        business_date: toIstCalendarDate(new Date(occurredAt)),
        site_id: order.site_id,
        captured_by: p.posted_by,
        source_event_id: eventId,
        correlation_id: envelope.metadata.correlation_id ?? null,
      },
      client,
    );
  } catch (err: unknown) {
    // Both the holding_id PK and uq_job_work_offcut_holding_source_event can raise 23505; the
    // sibling custody insert above is classified and this was not (fixed 2026-09-06).
    classifyDuplicate(err, p.offcut_id, eventId);
  }

  await appendCustodyTrace(
    {
      sku: p.sku,
      lotNumber: p.lot_id,
      quantityChange: quantityDelta,
      eventType: CUSTODY_OFFCUT_RECORDED,
      eventId,
      occurredAt,
      location,
    },
    client,
  );

  // The stored event carries what THIS process derived, never what the caller asserted. ONE lot
  // identifier, the NUMBER, matching what the holding row and the stock_balance row carry - a
  // lot_master UUID here would join against neither (fixed 2026-09-06).
  envelope.payload['custody_balance_after'] = qtyAdd(balance, quantityDelta);
  envelope.payload['offcut_lot_number'] = offcutLotNumber;
}
