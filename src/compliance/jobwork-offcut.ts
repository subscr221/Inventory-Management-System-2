import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import type { CustodyOffcutRecordedPayload } from '../events/schema.js';
import { AppError } from '../middleware/error.js';
import { persistEvent } from '../events/store.js';
import { getItemBySku } from '../read/projections/item_master.js';
import { createLot } from '../read/projections/lot_master.js';
import { applyStockReceipt } from '../read/projections/stock_balance.js';
import { createDispatchDocument } from '../read/projections/dispatch_document.js';
import { updateServiceOrderFields } from '../read/projections/service_order.js';
import type { ServiceOrderRow } from '../read/projections/service_order.js';
import {
  insertCustodyLedgerEntry,
  customerCustodyBalance,
} from '../read/projections/custody_ledger_entry.js';
import type { AuditEntryPayload } from '../read/projections/audit_log.js';
import { QC_HOLD_PLACED } from './quality.js';
import { toIstCalendarDate } from '../lib/business-days.js';
import { applyStockBalanceProjection } from './stock-balance.js';
import { JOB_WORK_STOCK_CLASS } from './jobwork-receipt.js';
import { qtyAdd, qtyNegate, qtyToScaled } from './custody-statement.js';
import { reconcileReturnClocks } from './jobwork-return-clock.js';
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
import { billableValueOf, offcutRateOutOfBand } from '../adapters/erp/job-work-billing-feed.js';
import { config } from '../config/index.js';

/** Story 9.6 code review 2026-09-05: the governed band around the order's contracted offcut rate. */
const RATE_TOLERANCE_PCT = config.jobwork.offcutRateTolerancePct;

/**
 * Story 9.6 (FR-JW-09/10): execution of the offcut election, ONE event (`custody.offcut_recorded`)
 * with THREE branches switched on service_order.offcut_election re-read under the order lock
 * (Binding decision 1). The caller never names the branch; a per-election event type would let a
 * caller pick a branch the contract does not permit.
 *
 * Shared drain, all three branches: the segregated job_work stock leaves through the EXISTING
 * CUSTODY_RETURN Symbol door (Binding decision 3 - no third Symbol), then the `offcut` ledger row
 * (forward-declared by 9.3, no migration), the lot_trace entry, and a CAPPED clock reconciliation.
 *   - `return`: goods leave to the customer under a mandatory delivery challan number; the four
 *     dispatch documents render into the generic dispatch_document table (Binding decision 13).
 *   - `retain_and_buy`: after the drain a NEW owned lot is minted (Binding decision 5: the
 *     laundering bar refuses an owned receipt for any lot holding a job_work balance ROW), an
 *     ordinary owned stock.received posts for it, the ledger row is billable at the order's
 *     real-time ESTIMATE supplied on the posting (PO ruling 2026-09-05 on open question 6) or, when
 *     none is supplied, the order's contracted rate (Task 0) - the contracted rate is stamped beside
 *     the effective rate either way so the feed line shows the variance - and the owned lot
 *     is placed on a governed QC hold on mint (Binding decision 19, see the note below).
 *   - `retain_free`: the identical conversion with billable = false; the ledger row IS the
 *     free-retention record (Binding decision 4).
 * settles_offcut stamps offcut_settled_at on the order (Binding decision 15); a posting against an
 * already-settled order is refused.
 *
 * LOCK ORDER (the 7.4 rule, identical to custody-ledger.ts / jobwork-output.ts):
 *   1. pg_advisory_xact_lock(hashtextextended(service_order_id, 0)) inside requireInProcessOrder;
 *   2. the service_order row FOR UPDATE (same call);
 *   3. plain SELECTs on jobwork_material_receipt, custody_ledger_entry, bom, item_master (AD-14);
 *   4. stock_balance rows (locked inside applyStockIssue / applyStockReceipt), then the ledger row,
 *      the lot_master insert, lot_trace, the return-clock rows, and the QC hand-off LAST.
 *
 * GENEALOGY (disclosed): read/projections/lot_trace.sql has no parent column AND a UNIQUE index on
 * event_id (idx_lot_trace_event_id, the ON CONFLICT DO NOTHING target), so ONE event can carry ONE
 * trace row. The story's premise that both lots share a trace row under this event_id cannot hold:
 * the customer lot's drain row is written under the offcut event_id, and a second append for the
 * owned lot would be silently dropped. The owned lot's provenance is therefore carried by (a) the
 * stored offcut payload (converted_lot_id / converted_lot_number / converted_lot_hold_id) and (b)
 * the qc.hold_placed event persisted below, whose causation_id is this offcut event_id and whose
 * applier writes the owned lot's first lot_trace row. Any genealogy or recall query crossing the
 * ownership change must go offcut event -> payload.converted_lot_id, or hold event.causation_id ->
 * offcut event; never through a shared event_id.
 *
 * QC HOLD ON MINT (Binding decision 19, disclosed deviation from Task 2.5a's "QC hold task"): the
 * Story 9.4 hand-off (receiveQcCompletion) resolves an inspection plan on the grain
 * (item_id, bom_revision_id NOT NULL), and plan creation refuses INSPECTION_PLAN_SCOPE_MISMATCH for
 * any revision whose BOM parent is not the item. Customer raw material has no BOM of its own, so
 * that path is unreachable for an offcut lot without minting a BOM per customer item. The control is
 * therefore the Story 8.5 GOVERNED quality hold (`qc.hold_placed`, persisted on this same
 * transaction the way receiveQcCompletion persists its own event): it writes the qc_quality_hold row,
 * flags lot_master.quality_hold_status = 'held' (the ONE enforcement flag every allocation, pick,
 * cross-dock and dispatch gate reads), appends lot_trace and notifies the inspection role. Release
 * is the existing 8.5 segregated release route, never anything in this module.
 */

const CUSTODY_STREAM_TYPES = new Set(['custody']);
/** The 9.1 governed business stream code carried on every job-work lot_trace row. */
const JOB_WORK_BUSINESS_STREAM = 'job_work';
const OWNED_STOCK_CLASS = 'owned';

type Election = NonNullable<ServiceOrderRow['offcut_election']>;

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

// ---------------------------------------------------------------------------
// Pure predicates (parameterised so unit tests can fail them - the 8.4 lesson)
// ---------------------------------------------------------------------------

/** Binding decision 1: an executable election exists only on a contractual, elected, unsettled order. */
export function offcutElectionOpen(
  order: Pick<ServiceOrderRow, 'has_contractual_offcut' | 'offcut_election' | 'offcut_settled_at'>,
): { open: true; election: Election } | { open: false; reason: string } {
  if (order.has_contractual_offcut !== true) return { open: false, reason: 'not_contractual' };
  if (order.offcut_election === null) return { open: false, reason: 'no_election' };
  if (order.offcut_settled_at !== null) return { open: false, reason: 'already_settled' };
  return { open: true, election: order.offcut_election };
}

/** True when the branch buys the material back (the only branch a rate applies to). */
export function electionIsBillable(election: Election): boolean {
  return election === 'retain_and_buy';
}

/** True when the branch converts the material to own stock (both retention branches). */
export function electionConvertsToOwnStock(election: Election): boolean {
  return election === 'retain_and_buy' || election === 'retain_free';
}

// ---------------------------------------------------------------------------
// Documents (AC 1, Task 3)
// ---------------------------------------------------------------------------

/**
 * Modelled on renderJobWorkDispatchDocuments (jobwork-dispatch.ts). The return challan renders as
 * `commercial_invoice`, the exact 9.4 precedent, because chk_dispatch_document_type admits only
 * the four Story 3.7 types. Plain text; the 3.7 renderers hard-query erp_sales_order and are NOT
 * reusable for a job-work order (Binding decision 13).
 */
export function renderOffcutDocuments(input: {
  order: ServiceOrderRow;
  offcutId: string;
  sku: string;
  lotNumber: string;
  quantity: string;
  uom: string;
  returnChallanNumberExt: string;
  occurredAt: string;
}): { document_type: 'bol' | 'packing_slip' | 'commercial_invoice' | 'label'; content: string }[] {
  const header = [
    `Order            : ${input.order.order_number_ext}  (${input.order.service_order_id})`,
    `Offcut Return    : ${input.offcutId}`,
    `Return Challan   : ${input.returnChallanNumberExt}`,
    `Customer         : ${input.order.customer_party_code}  ${input.order.customer_name}`,
    `SKU / Lot        : ${input.sku} / ${input.lotNumber}`,
    `Returned Qty     : ${input.quantity} ${input.uom}`,
    `Election         : return (contractual offcut)`,
    `Returned At      : ${input.occurredAt}`,
  ].join('\n');
  return [
    {
      document_type: 'bol',
      content: `BILL OF LADING (JOB-WORK OFFCUT RETURN)\n${'='.repeat(30)}\n${header}\n`,
    },
    {
      document_type: 'packing_slip',
      content: `PACKING SLIP (JOB-WORK OFFCUT RETURN)\n${'='.repeat(30)}\n${header}\n`,
    },
    {
      document_type: 'commercial_invoice',
      content: `JOB-WORK OFFCUT RETURN CHALLAN\n${'='.repeat(30)}\n${header}\n`,
    },
    {
      document_type: 'label',
      content: `${input.sku}\n${input.lotNumber}\n${input.order.order_number_ext}\nOFFCUT RETURN ${input.returnChallanNumberExt}\n`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Applier (AC 1, 2, 3)
// ---------------------------------------------------------------------------

export async function applyCustodyOffcutProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  auditCtx?: Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>,
): Promise<void> {
  if (envelope.event_type !== CUSTODY_OFFCUT_RECORDED) return;
  if (!CUSTODY_STREAM_TYPES.has(envelope.stream_type)) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as CustodyOffcutRecordedPayload;
  const occurredAt = envelope.metadata.occurred_at ?? new Date().toISOString();

  // 1-2. Order advisory lock + FOR UPDATE, then the election re-read from the ROW (never the
  // payload, which refuses `election` on input). Hold-bypass class: a direct POST /api/v1/events
  // meets this identical wall.
  const order = await requireInProcessOrder(
    p.service_order_id,
    p.site_id,
    client,
    orderAcceptsCustodyReturn,
  );
  const gate = offcutElectionOpen(order);
  if (!gate.open) {
    reject(
      'OFFCUT_ELECTION_MISSING',
      gate.reason === 'already_settled'
        ? 'The contractual offcut on this service order has already been settled; no further offcut may be posted against it'
        : gate.reason === 'not_contractual'
          ? 'This service order has no contractual offcut arrangement to execute'
          : 'This service order carries no offcut election to execute',
      {
        service_order_id: order.service_order_id,
        reason: gate.reason,
        has_contractual_offcut: order.has_contractual_offcut,
        offcut_election: order.offcut_election,
        ...(gate.reason === 'already_settled' && {
          already_settled_at: order.offcut_settled_at,
          already_settled_by: order.offcut_settled_by,
        }),
      },
      409,
    );
  }
  const election = gate.election;

  // Branch-specific caller fields. The shape assert cannot know the branch; this is the authority.
  const estimateSupplied = p.offcut_rate_estimate !== undefined && p.offcut_rate_estimate !== null;
  if (election === 'return') {
    if (typeof p.return_challan_number_ext !== 'string' || p.return_challan_number_ext === '') {
      reject(
        'INVALID_PARAMS',
        'A `return` offcut election requires return_challan_number_ext: goods leaving the job worker without a delivery challan is a GST offence',
        { service_order_id: order.service_order_id, election, field: 'return_challan_number_ext' },
        400,
      );
    }
  }
  if (!electionIsBillable(election) && estimateSupplied) {
    // Refuse rather than discard (the 9.4 within-norm-claim precedent): nothing is being bought.
    reject(
      'INVALID_PARAMS',
      `An offcut_rate_estimate cannot be carried on a \`${election}\` election; nothing is being bought`,
      { service_order_id: order.service_order_id, election, field: 'offcut_rate_estimate' },
      400,
    );
  }

  // retain_and_buy (PO ruling 2026-09-05, open question 6): the settlement rate is the REAL-TIME
  // ESTIMATE the settling posting supplies; the order's contracted rate (Task 0) is the reference,
  // used as the effective rate only when no estimate is supplied, and stamped beside the effective
  // rate either way so the billing line carries the variance. No DOA gate on the deviation.
  let effectiveRate: string | null = null;
  let contractedRate: string | null = null;
  if (electionIsBillable(election)) {
    if (order.offcut_rate === null || order.offcut_currency === null) {
      reject(
        'OFFCUT_ELECTION_MISSING',
        'A retain-and-buy election requires the contracted offcut rate on the order; confirm the order with offcut_rate and offcut_currency',
        { service_order_id: order.service_order_id, reason: 'offcut_rate_missing', election },
        409,
      );
    }
    contractedRate = order.offcut_rate;
    effectiveRate = estimateSupplied ? (p.offcut_rate_estimate as string) : order.offcut_rate;
    // Story 9.6 code review 2026-09-05: the estimate is BOUNDED against the contracted rate. The PO
    // ruling removed the DOA gate BSD-16 specified, which left the settling actor free to name any
    // strictly positive rate - and to stamp settles_offcut, the sole billing precondition, in the
    // same posting. A real-time estimate may drift from the contract within a governed band; beyond
    // it the deviation is a commercial decision, not a measurement, and this refuses fail-closed.
    if (
      estimateSupplied &&
      offcutRateOutOfBand(contractedRate, effectiveRate, RATE_TOLERANCE_PCT)
    ) {
      reject(
        'OFFCUT_RATE_OUT_OF_BAND',
        `The offcut rate estimate deviates from the contracted rate by more than ${RATE_TOLERANCE_PCT}%`,
        {
          service_order_id: order.service_order_id,
          contracted_offcut_rate: contractedRate,
          offcut_rate_estimate: effectiveRate,
          tolerance_pct: RATE_TOLERANCE_PCT,
        },
        409,
      );
    }
  }

  // 3. The lot must have been received under THIS order for this sku (the 9.5 return gate).
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

  // 4. Shared drain through the EXISTING CUSTODY_RETURN door (Binding decision 3).
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

  const billable = electionIsBillable(election);
  const billableValue = billable ? billableValueOf(p.quantity, effectiveRate as string) : null;
  const referenceExt =
    election === 'return'
      ? (p.return_challan_number_ext as string)
      : election === 'retain_and_buy'
        ? order.order_number_ext
        : 'offcut_election:retain_free';

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
        billable,
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
        reference_ext: referenceExt,
      },
      client,
    );
  } catch (err: unknown) {
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

  // Section 143: offcut settled with the principal (returned or bought) stops the clock. CAPPED,
  // not strict (Binding decision 11): clock capacity is challan_qty while the balance drains
  // received_qty, so an over-tolerance receipt must never strand the closure gate.
  const reconciled = await reconcileReturnClocks(
    {
      serviceOrderId: order.service_order_id,
      sku: p.sku,
      quantity: p.quantity,
      counter: 'reconciled_qty',
      category: 'offcut',
      strict: false,
    },
    client,
  );
  if (qtyToScaled(reconciled.unallocated) > 0n) {
    console.warn(
      `custody offcut ${p.offcut_id}: ${reconciled.unallocated} of ${p.quantity} ${p.sku} exceeded the outstanding return-clock capacity on order ${order.service_order_id} (over-tolerance receipt); the offcut is recorded in full and the clock accounting is short by that amount`,
    );
  }

  // 5. Retention: mint a NEW owned lot, post an ordinary owned receipt, hand it to the QC gate.
  let convertedLotId: string | null = null;
  let convertedLotNumber: string | null = null;
  if (electionConvertsToOwnStock(election)) {
    const seqResult = await client.query(
      `SELECT COUNT(*)::int AS n FROM custody_ledger_entry
        WHERE service_order_id = $1 AND movement_category = 'offcut'`,
      [order.service_order_id],
    );
    // This posting's own row is already counted, so the sequence is 1-based without a +1.
    const sequence = seqResult.rows[0]!['n'] as number;
    // The site discriminator keeps two sites running the same external order number from
    // colliding on uq_lot_master_lot_number (the 9.4 lot-number lesson).
    const siteDiscriminator = order.site_id.slice(0, 8);
    convertedLotNumber = `${order.order_number_ext}-${siteDiscriminator}-OC${sequence}`;

    const item = await getItemBySku(p.sku, client);
    if (!item) {
      reject(
        'ITEM_NOT_FOUND',
        'The offcut sku has no item_master record to hold the converted lot under',
        { sku: p.sku },
        409,
      );
    }
    const lot = await createLot(
      {
        lot_number: convertedLotNumber,
        sku: p.sku,
        expiry_date: null,
        quality_hold_status: 'none',
        quality_hold_reason: null,
      },
      client,
    );
    convertedLotId = lot.lot_id;
    // Ordinary OWNED stock in the bin the material physically sits in. The laundering bar cannot
    // fire: this (sku, lot) has never held a job_work balance row (Binding decision 5).
    await applyStockReceipt(
      {
        sku: p.sku,
        location_id: location.location_id,
        location_code: location.location_code,
        lot_id: convertedLotNumber,
        quantity: p.quantity,
        stock_class: OWNED_STOCK_CLASS,
      },
      client,
    );
    // No second appendCustodyTrace here: idx_lot_trace_event_id is UNIQUE on event_id, so it would
    // be dropped silently (see GENEALOGY in the header). The hold event below writes the owned
    // lot's first trace row with causation_id = this event.

    // Binding decision 19: the material was inspected once, at the 9.2 receipt, as the CUSTOMER's
    // material against the CUSTOMER's spec. As our raw stock it has never been inspected, and
    // `owned` is allocatable the moment it exists, so the lot is placed on a GOVERNED quality hold
    // on mint through the Story 8.5 seam (see the module header for why not the 8.1 task path).
    // The hold event rides this same transaction, so a hold failure rolls the lot, the stock and
    // the ledger row back with it. The idempotency key is derived from the offcut id so a replayed
    // transaction re-uses the same hold rather than minting a second.
    const holdId = randomUUID();
    const hold = await persistEvent(
      {
        stream_type: 'qc',
        stream_id: holdId,
        event_type: QC_HOLD_PLACED,
        payload: {
          hold_id: holdId,
          lot_id: lot.lot_id,
          hold_reason: `Job-work offcut converted to own stock under ${election} on order ${order.order_number_ext} (offcut ${p.offcut_id}); inspected only as the customer's material against the customer's specification - inspect as own raw stock before release`,
        },
        metadata: {
          correlation_id: envelope.metadata.correlation_id ?? randomUUID(),
          causation_id: eventId,
          actor: {
            user_id: envelope.metadata.actor.user_id,
            role: envelope.metadata.actor.role,
            location_id: order.site_id,
          },
          occurred_at: occurredAt,
        },
        idempotency_key: `jobwork-offcut-hold:${p.offcut_id}`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtx,
      client,
    );
    const persistedHoldId = (hold.payload as Record<string, unknown>)['hold_id'];
    const flagged = await client.query(
      `SELECT quality_hold_status FROM lot_master WHERE lot_id = $1`,
      [lot.lot_id],
    );
    if (
      hold.event_type !== QC_HOLD_PLACED ||
      typeof persistedHoldId !== 'string' ||
      flagged.rows[0]?.['quality_hold_status'] !== 'held'
    ) {
      reject(
        'LOT_ON_HOLD',
        'The converted offcut lot could not be placed on a quality hold',
        { offcut_id: p.offcut_id, converted_lot_number: convertedLotNumber, hold_id: holdId },
        500,
      );
    }
    envelope.payload['converted_lot_hold_id'] = persistedHoldId;
  }

  // 6. Documents: `return` only (Task 3.3) - retention keeps the goods on site.
  if (election === 'return') {
    const documents = renderOffcutDocuments({
      order,
      offcutId: p.offcut_id,
      sku: p.sku,
      lotNumber: p.lot_id,
      quantity: p.quantity,
      uom: p.uom,
      returnChallanNumberExt: p.return_challan_number_ext as string,
      occurredAt,
    });
    for (const document of documents) {
      await createDispatchDocument(
        {
          document_id: randomUUID(),
          dispatch_order_id: order.service_order_id,
          document_type: document.document_type,
          document_content: document.content,
          generated_by: p.posted_by,
        },
        client,
      );
    }
  }

  // 7. Settlement declaration (Binding decision 15), in the same transaction.
  if (p.settles_offcut === true) {
    await updateServiceOrderFields(
      order.service_order_id,
      { offcut_settled_at: occurredAt, offcut_settled_by: p.posted_by },
      client,
    );
  }

  // The stored event carries what THIS process derived, never what the caller asserted.
  envelope.payload['election'] = election;
  envelope.payload['custody_balance_after'] = qtyAdd(balance, quantityDelta);
  envelope.payload['converted_lot_id'] = convertedLotId;
  envelope.payload['converted_lot_number'] = convertedLotNumber;
  envelope.payload['billable_value'] = billableValue;
  envelope.payload['effective_offcut_rate'] = billable ? effectiveRate : null;
  envelope.payload['contracted_offcut_rate'] = billable ? contractedRate : null;
}
