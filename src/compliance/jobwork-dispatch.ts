import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import type { JobworkOutputDispatchedPayload } from '../events/schema.js';
import { AppError } from '../middleware/error.js';
import { getServiceOrderById } from '../read/projections/service_order.js';
import type { ServiceOrderRow } from '../read/projections/service_order.js';
import {
  getJobWorkOutputByLotId,
  incrementJobWorkOutputDispatched,
  insertJobWorkDispatch,
} from '../read/projections/job_work_output.js';
import type { JobWorkOutputRow } from '../read/projections/job_work_output.js';
import { getLotByNumberAndSku } from '../read/projections/lot_master.js';
import { insertCustodyLedgerEntry } from '../read/projections/custody_ledger_entry.js';
import {
  createDispatchDocument,
  clearDocumentsByDispatchOrder,
} from '../read/projections/dispatch_document.js';
import { dispatchGateBlockedLots } from './dispatch.js';
import { applyStockIssue } from '../read/projections/stock_balance.js';
import { toIstCalendarDate } from '../lib/business-days.js';
import { isPositiveQtyString } from './jobwork-receipt.js';
import { qtyCompare, qtyNegate, qtyToScaled, qtyFromScaled } from './custody-statement.js';

/**
 * Story 9.4 (FR-JW-11): QC-gated job-work dispatch on the EXISTING 'jobwork' stream.
 *
 * Binding decision (disclosed): the Story 3.6/3.7 pick/pack/dispatch state machine
 * (dispatch_order_status) INNER JOINs erp_sales_order (src/read/projections/dispatch_order_status.ts)
 * - a job-work order has no sales-order line, so that state machine is NOT reused. The document
 * RENDERERS in src/warehouse/document-renderer.ts are ALSO not reused: they hard-query
 * erp_sales_order/packing_record by dispatch_order_id internally and would silently render
 * "Unknown"/"N/A" fields for a job-work order rather than failing closed. This module renders its
 * own plain-text documents from service_order + job_work_output data and stores them through the
 * SAME generic dispatch_document table (whose schema carries a bare UUID dispatch_order_id with
 * no FK - verified in read/projections/dispatch_document.sql:9), keyed by service_order_id.
 *
 * The lot gate IS reused, not reimplemented: dispatchGateBlockedLots (src/compliance/dispatch.ts)
 * is imported and called, so the manual/recall hold half and the QC-gate half stay in one place
 * and cannot drift apart per call site (the hold-bypass class, code-reviewed 2026-09-03).
 *
 * LOCK ORDER (the 7.4 rule): advisory lock, order row FOR UPDATE, then the job_work_output row
 * FOR UPDATE (Postgres row lock via SELECT ... FOR UPDATE inside getJobWorkOutputByLotId).
 */

const JOBWORK_STREAM_TYPES = new Set(['jobwork']);
export const JOBWORK_OUTPUT_DISPATCHED = 'jobwork.output_dispatched';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 200;

const DISPATCH_FIELDS = new Set([
  'service_order_id',
  'dispatch_id',
  'lot_id',
  'dispatched_quantity',
  'uom',
  'site_id',
  'dispatched_by',
]);

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

export function jobworkDispatchEventType(envelope: EventEnvelope): string | null {
  if (!JOBWORK_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (envelope.event_type !== JOBWORK_OUTPUT_DISPATCHED) return null;
  return envelope.event_type;
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

export function assertJobworkDispatchShape(envelope: EventEnvelope): void {
  if (envelope.event_type !== JOBWORK_OUTPUT_DISPATCHED) return;
  if (!JOBWORK_STREAM_TYPES.has(envelope.stream_type)) {
    reject('INVALID_EVENT_ENVELOPE', 'jobwork.* events must ride the jobwork stream', {
      event_type: envelope.event_type,
      stream_type: envelope.stream_type,
    });
  }
  const p = envelope.payload as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!DISPATCH_FIELDS.has(key)) {
      reject('INVALID_PARAMS', `${key} is not a recognized field on this event`, { field: key });
    }
  }
  for (const field of ['service_order_id', 'dispatch_id', 'site_id', 'dispatched_by']) {
    if (!isUuid(p[field])) reject('INVALID_PARAMS', `${field} is required and must be a UUID`);
  }
  if (envelope.stream_id !== p['service_order_id']) {
    reject('INVALID_EVENT_ENVELOPE', 'stream_id must equal service_order_id', {
      stream_id: envelope.stream_id,
      service_order_id: p['service_order_id'],
    });
  }
  if (!isNonEmptyString(p['lot_id']) || (p['lot_id'] as string).trim().length > MAX_TEXT_LENGTH) {
    reject('INVALID_PARAMS', 'lot_id is required and must be a non-empty string');
  }
  p['lot_id'] = (p['lot_id'] as string).trim();
  if (!isNonEmptyString(p['uom']) || (p['uom'] as string).trim().length > MAX_TEXT_LENGTH) {
    reject('INVALID_PARAMS', 'uom is required and must be a non-empty string');
  }
  p['uom'] = (p['uom'] as string).trim();
  if (!isPositiveQtyString(p['dispatched_quantity'])) {
    reject(
      'INVALID_PARAMS',
      'dispatched_quantity is required and must be a strictly positive NUMERIC string with at most 3 decimals',
      { field: 'dispatched_quantity', value: p['dispatched_quantity'] ?? null },
    );
  }
}

// ---------------------------------------------------------------------------
// In-transaction gates and projection (DB access)
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

async function lockOrder(serviceOrderId: string, client: PoolClient): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [serviceOrderId]);
}

async function requireInProcessOrder(
  serviceOrderId: string,
  siteId: string,
  client: PoolClient,
): Promise<ServiceOrderRow> {
  await lockOrder(serviceOrderId, client);
  const order = await getServiceOrderById(serviceOrderId, client, true);
  if (!order) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      'Dispatch requires an in_process service order; none exists for service_order_id',
      { service_order_id: serviceOrderId },
      409,
    );
  }
  if (order.status !== 'in_process') {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      `Dispatch requires an in_process service order; this order is ${order.status}`,
      { service_order_id: serviceOrderId, status: order.status },
      409,
    );
  }
  if (order.site_id !== siteId) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      'The service order belongs to a different site than the posting',
      { service_order_id: serviceOrderId, order_site_id: order.site_id, site_id: siteId },
      409,
    );
  }
  return order;
}

/**
 * The custody apportionment for ONE sku on ONE dispatch, as exact scaled integers (Task 4.4).
 *
 * Pro-rata by dispatched_quantity over the ORDER's total output quantity; on the dispatch that
 * closes out that total, the exact remaining balance instead, so scaled-integer truncation can
 * never strand a residual that blocks the Story 9.5 CUSTODY_NOT_ZERO closure gate. Never releases
 * more than the sku's outstanding balance.
 *
 * All arguments and the result are scaled integers (quantity * 1000).
 */
export function apportionDispatchScaled(input: {
  skuConsumed: bigint;
  alreadyReleased: bigint;
  dispatchedQuantity: bigint;
  orderOutputTotal: bigint;
  isFinalDispatch: boolean;
}): bigint {
  const outstanding = input.skuConsumed - input.alreadyReleased;
  if (outstanding <= 0n || input.skuConsumed <= 0n || input.orderOutputTotal <= 0n) return 0n;
  const share = input.isFinalDispatch
    ? outstanding
    : (input.skuConsumed * input.dispatchedQuantity) / input.orderOutputTotal;
  if (share <= 0n) return 0n;
  return share > outstanding ? outstanding : share;
}

/** Both job_work_dispatch keys are 409 DUPLICATE_EVENT; the details name which one collided. */
function classifyDispatchDuplicate(err: unknown, dispatchId: string, eventId: string): never {
  if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
    const constraint = (err as { constraint?: string }).constraint;
    if (constraint === 'uq_job_work_dispatch_source_event') {
      reject(
        'DUPLICATE_EVENT',
        'A job-work dispatch row already exists for this event',
        { source_event_id: eventId, constraint },
        409,
      );
    }
    if (constraint === 'job_work_dispatch_pkey') {
      reject(
        'DUPLICATE_EVENT',
        'A job-work dispatch with this id already exists',
        { dispatch_id: dispatchId, constraint },
        409,
      );
    }
  }
  throw err;
}

function renderJobWorkDispatchDocuments(
  order: ServiceOrderRow,
  output: JobWorkOutputRow,
  dispatchedQuantity: string,
  dispatchedAt: string,
  dispatchId: string,
  dispatchedToDate: string,
): { document_type: 'bol' | 'packing_slip' | 'commercial_invoice' | 'label'; content: string }[] {
  // Each partial dispatch renders its OWN document set; the dispatch id and the running
  // dispatched-to-date total are what tell two partial shipments apart on paper.
  const header = [
    `Order            : ${order.order_number_ext}  (${order.service_order_id})`,
    `Dispatch         : ${dispatchId}`,
    `Customer         : ${order.customer_party_code}  ${order.customer_name}`,
    `SKU / Lot        : ${output.sku} / ${output.lot_number}`,
    `Dispatched Qty   : ${dispatchedQuantity} ${output.uom}`,
    `Dispatched To Date: ${dispatchedToDate} of ${output.quantity} ${output.uom}`,
    `Dispatched At    : ${dispatchedAt}`,
  ].join('\n');
  return [
    { document_type: 'bol', content: `BILL OF LADING (JOB WORK)\n${'='.repeat(30)}\n${header}\n` },
    {
      document_type: 'packing_slip',
      content: `PACKING SLIP (JOB WORK)\n${'='.repeat(30)}\n${header}\n`,
    },
    {
      document_type: 'commercial_invoice',
      content: `JOB-WORK CHALLAN / RETURN NOTE\n${'='.repeat(30)}\n${header}\n`,
    },
    {
      document_type: 'label',
      content: `${output.sku}\n${output.lot_number}\n${order.order_number_ext}\n`,
    },
  ];
}

export async function applyJobworkDispatchProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (jobworkDispatchEventType(envelope) === null) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as JobworkOutputDispatchedPayload;
  const occurredAt = envelope.metadata.occurred_at ?? new Date().toISOString();
  const order = await requireInProcessOrder(p.service_order_id, p.site_id, client);

  const output = await getJobWorkOutputByLotId(p.lot_id, client, true);
  if (!output || output.service_order_id !== order.service_order_id) {
    reject(
      'CROSS_ISSUE_BLOCKED',
      'The named lot was not produced as output of this service order',
      { service_order_id: order.service_order_id, lot_id: p.lot_id },
      409,
    );
  }

  // The QC gate check is lot-UUID-keyed; job-work projections carry the lot NUMBER (stock_balance
  // convention), so resolve the lot_master UUID first (the 9.3 appendCustodyTrace idiom).
  const lot = await getLotByNumberAndSku(output.lot_number, output.sku, client);
  if (!lot) {
    reject(
      'LOT_NOT_FOUND',
      'The named lot has no lot_master record',
      { sku: output.sku, lot_id: output.lot_number },
      409,
    );
  }
  // BOTH halves of the lot gate, through the shared helper: the manual/recall hold and the QC
  // gate are independent facts, and the lock is taken before either is read.
  const { heldLotIds, qcGatedLotIds: gated } = await dispatchGateBlockedLots([lot.lot_id], client);
  if (heldLotIds.length > 0) {
    reject(
      'LOT_ON_HOLD',
      'The lot is on a quality hold and cannot be dispatched',
      {
        service_order_id: order.service_order_id,
        lot_id: output.lot_number,
        held_lot_ids: [output.lot_number],
        reason: 'quality_hold',
      },
      409,
    );
  }
  if (gated.length > 0) {
    reject(
      'LOT_ON_HOLD',
      'The lot has not passed the FG QC gate and cannot be dispatched',
      {
        service_order_id: order.service_order_id,
        lot_id: output.lot_number,
        held_lot_ids: [output.lot_number],
        reason: 'qc_gate',
      },
      409,
    );
  }

  if (p.uom !== output.uom) {
    reject(
      'INVALID_PARAMS',
      'The dispatched uom must match the output lot uom',
      { lot_id: output.lot_number, uom: p.uom, output_uom: output.uom },
      400,
    );
  }

  const remaining = qtyFromScaled(
    qtyToScaled(output.quantity) - qtyToScaled(output.dispatched_quantity),
  );
  if (qtyCompare(p.dispatched_quantity, remaining) > 0) {
    reject(
      'INSUFFICIENT_STOCK',
      'The dispatched quantity exceeds the remaining open-to-dispatch quantity for this lot',
      {
        service_order_id: order.service_order_id,
        lot_id: output.lot_number,
        requested_qty: p.dispatched_quantity,
        remaining_qty: remaining,
      },
      409,
    );
  }

  const incremented = await incrementJobWorkOutputDispatched(
    output.output_id,
    p.dispatched_quantity,
    client,
  );
  if (!incremented) {
    reject(
      'INSUFFICIENT_STOCK',
      'The dispatched quantity exceeds the remaining open-to-dispatch quantity for this lot',
      {
        service_order_id: order.service_order_id,
        lot_id: output.lot_number,
        requested_qty: p.dispatched_quantity,
        remaining_qty: remaining,
      },
      409,
    );
  }

  // Custody-ledger dispatch apportionment (Task 4.4): pro-rata by dispatched_quantity over the
  // ORDER's total output quantity - never this lot's own quantity, which would release ~100% of
  // consumption once per output lot and drive the balance to -100% on a two-lot order.
  //
  // The closure gate (Story 9.5 CUSTODY_NOT_ZERO) requires the balance to reach EXACTLY zero, and
  // scaled-integer division truncates, so pro-rata alone strands a residual (100.000 over three
  // 1.000 dispatches of a 3.000 lot releases 99.999 and the order can never close). The dispatch
  // that closes out the order's total output therefore posts the exact REMAINING balance per sku
  // instead of its pro-rata share.
  const lotShare = qtyToScaled(p.dispatched_quantity);
  const outputTotals = await client.query(
    `SELECT COALESCE(SUM(quantity), 0)::numeric(18,3)::text AS total,
            COALESCE(SUM(dispatched_quantity), 0)::numeric(18,3)::text AS dispatched
       FROM job_work_output WHERE service_order_id = $1`,
    [order.service_order_id],
  );
  const orderOutputTotal = qtyToScaled(String(outputTotals.rows[0]!['total']));
  // dispatched_quantity was already incremented above, so this total INCLUDES the current dispatch.
  const orderDispatchedTotal = qtyToScaled(String(outputTotals.rows[0]!['dispatched']));
  const isFinalDispatch = orderDispatchedTotal >= orderOutputTotal;
  if (orderOutputTotal > 0n) {
    // Consumption/loss to date per sku, and what dispatch has already released against it, so the
    // final true-up is exact regardless of when consumption was posted relative to a dispatch.
    const consumedRows = await client.query(
      `SELECT sku,
              -SUM(quantity_delta) FILTER (WHERE movement_category IN ('consumption', 'loss'))
                AS consumed,
              COALESCE(-SUM(quantity_delta) FILTER (WHERE movement_category = 'dispatch'), 0)
                AS released
         FROM custody_ledger_entry
        WHERE service_order_id = $1
          AND movement_category IN ('consumption', 'loss', 'dispatch')
        GROUP BY sku`,
      [order.service_order_id],
    );
    for (const row of consumedRows.rows as {
      sku: string;
      consumed: string | null;
      released: string;
    }[]) {
      const apportioned = apportionDispatchScaled({
        skuConsumed: qtyToScaled(String(row.consumed ?? '0')),
        alreadyReleased: qtyToScaled(String(row.released)),
        dispatchedQuantity: lotShare,
        orderOutputTotal,
        isFinalDispatch,
      });
      if (apportioned <= 0n) continue;
      const apportionedQty = qtyFromScaled(apportioned);
      await insertCustodyLedgerEntry(
        {
          entry_id: randomUUID(),
          service_order_id: order.service_order_id,
          customer_party_code: order.customer_party_code,
          movement_category: 'dispatch',
          ownership: 'customer',
          sku: row.sku,
          lot_id: output.lot_number,
          location_id: null,
          quantity_delta: qtyNegate(apportionedQty),
          uom: output.uom,
          billable: false,
          bom_line_id: null,
          kit_bom_revision_id: null,
          receipt_id: null,
          variance_qty: null,
          variance_flagged: null,
          site_id: order.site_id,
          posted_by: p.dispatched_by,
          occurred_at: occurredAt,
          business_date: toIstCalendarDate(new Date(occurredAt)),
          source_event_id: eventId,
          source_event_type: JOBWORK_OUTPUT_DISPATCHED,
          correlation_id: envelope.metadata.correlation_id ?? null,
        },
        client,
      );
    }
  }

  try {
    await insertJobWorkDispatch(
      {
        dispatch_id: p.dispatch_id,
        service_order_id: order.service_order_id,
        output_id: output.output_id,
        lot_number: output.lot_number,
        sku: output.sku,
        dispatched_quantity: p.dispatched_quantity,
        uom: output.uom,
        site_id: order.site_id,
        dispatched_by: p.dispatched_by,
        dispatched_at: occurredAt,
        source_event_id: eventId,
      },
      client,
    );
  } catch (err: unknown) {
    classifyDispatchDuplicate(err, p.dispatch_id, eventId);
  }

  // The output lot was received into ordinary owned stock at the order's site when it was recorded
  // (jobwork-output.ts applyStockReceipt); dispatching it MUST take it back out, or the shipped
  // finished goods stay on hand and remain pickable/allocatable forever. qc_gate_cleared: the full
  // lot gate above already ran and passed.
  await applyStockIssue(
    {
      sku: output.sku,
      location_id: order.site_id,
      lot_id: output.lot_number,
      quantity: p.dispatched_quantity,
      qc_gate_cleared: true,
    },
    client,
  );

  // Each dispatch supersedes the order's document set (the dispatch.ts clear-and-regenerate idiom),
  // so a partial-dispatch order never accumulates several indistinguishable BOLs.
  await clearDocumentsByDispatchOrder(order.service_order_id, client);
  const documents = renderJobWorkDispatchDocuments(
    order,
    output,
    p.dispatched_quantity,
    occurredAt,
    p.dispatch_id,
    qtyFromScaled(orderDispatchedTotal),
  );
  for (const doc of documents) {
    await createDispatchDocument(
      {
        document_id: randomUUID(),
        dispatch_order_id: order.service_order_id,
        document_type: doc.document_type,
        document_content: doc.content,
        generated_by: p.dispatched_by,
      },
      client,
    );
  }
}
