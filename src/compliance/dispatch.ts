import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type {
  DispatchDispatchedEnvelope,
  DispatchIrnRecordedEnvelope,
  DispatchPackedEnvelope,
  DispatchShippingDocumentsGeneratedEnvelope,
} from '../events/schema.js';
import { AppError } from '../middleware/error.js';
import { IRN_EXT_REGEX, normalizeIrnExt, isValidIrpAcknowledgedAt } from './irn.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import {
  createPackingRecord,
  updatePackingRecordsStatusByDispatchOrder,
} from '../read/projections/packing_record.js';
import {
  createDispatchDocument,
  clearDocumentsByDispatchOrder,
} from '../read/projections/dispatch_document.js';
import { getSalesOrderLineById } from '../read/projections/erp_sales_order.js';
import { QC_GATE_BLOCKED_STATUSES } from '../read/projections/qc_inspection_task.js';
import type { AuditEntryPayload } from '../read/projections/audit_log.js';
import { logRejectionAudit } from '../read/projections/audit_log.js';
import {
  dispatchIrnPresent,
  getDispatchIrn,
  insertDispatchIrnCoverage,
  supersedeDispatchIrn,
} from '../read/projections/dispatch_irn.js';
import {
  renderBOL,
  renderPackingSlip,
  renderCommercialInvoice,
  renderLabels,
} from '../warehouse/document-renderer.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOCUMENT_TYPES = ['bol', 'packing_slip', 'commercial_invoice', 'label'];

/**
 * Story 8.1 (Task 6): the QC-gate half of the LOT_ON_HOLD check, taken AFTER the lot rows are
 * locked (lot, then gate, then stock - the fixed order). Every lot under a blocked gate (qc_hold,
 * or conditionally released without the Story 8.4 batch release record) blocks shipping-document
 * generation and final dispatch, independently of the manual or recall hold.
 */
export async function qcGatedLotIds(lotIds: string[], client: PoolClient): Promise<string[]> {
  if (lotIds.length === 0) return [];
  const result = await client.query(
    `SELECT lot_id FROM qc_inspection_task WHERE lot_id = ANY($1::uuid[]) AND gate_status = ANY($2::text[])
      ORDER BY lot_id FOR UPDATE`,
    [lotIds, [...QC_GATE_BLOCKED_STATUSES]],
  );
  return result.rows.map((r: Record<string, unknown>) => r['lot_id'] as string);
}

/**
 * The COMPLETE dispatch lot gate, in the fixed order every caller must use: lock every candidate
 * lot_master row FIRST (so a concurrent hold placement on a not-yet-held lot serializes against
 * this transaction instead of racing past it), then the manual/recall hold half, then the QC-gate
 * half. The two halves are independent facts about the same lot - an accepted QC gate says nothing
 * about a recall hold placed afterwards - and forgetting either one has shipped as a hold-bypass
 * defect five times (Stories 8.3, 8.4, 8.5, 8.8, 9.4). Every dispatch surface calls THIS, never
 * one half of it.
 *
 * Returns the blocking lot ids by reason; an empty pair means the lots are dispatchable. Callers
 * raise their own error shape (the code is always LOT_ON_HOLD).
 */
export async function dispatchGateBlockedLots(
  lotIds: string[],
  client: PoolClient,
): Promise<{ heldLotIds: string[]; qcGatedLotIds: string[] }> {
  if (lotIds.length === 0) return { heldLotIds: [], qcGatedLotIds: [] };
  const lockResult = await client.query(
    `SELECT lot_id, quality_hold_status FROM lot_master
      WHERE lot_id = ANY($1::uuid[]) ORDER BY lot_id FOR UPDATE`,
    [lotIds],
  );
  const heldLotIds = lockResult.rows
    .filter((r: Record<string, unknown>) => r['quality_hold_status'] !== 'none')
    .map((r: Record<string, unknown>) => r['lot_id'] as string);
  const gated = await qcGatedLotIds(
    lockResult.rows.map((r: Record<string, unknown>) => r['lot_id'] as string),
    client,
  );
  return { heldLotIds, qcGatedLotIds: gated };
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

// Matches NUMERIC(14,3): at most 3 fractional digits, so scaling by 1000 always yields an integer.
const NUMERIC_REGEX = /^-?\d+(\.\d{1,3})?$/;

function isPositiveFiniteQuantity(value: unknown): value is string | number {
  if (typeof value === 'number')
    return Number.isFinite(value) && value > 0 && toScaled3(String(value)) !== null;
  if (typeof value !== 'string' || value.length === 0) return false;
  if (!NUMERIC_REGEX.test(value)) return false;
  const scaled = toScaled3(value);
  return scaled !== null && scaled > 0n;
}

// Scales a NUMERIC(14,3)-shaped string/number to an integer (value * 1000) for exact comparison.
// Returns null if the value has more than 3 fractional digits (would be silently rounded by Postgres
// on write, which numericEqual must not treat as equal to a truncated JS-side comparison).
function toScaled3(value: string | number): bigint | null {
  const s = String(value);
  if (!NUMERIC_REGEX.test(s)) return null;
  const negative = s.startsWith('-');
  const unsigned = negative ? s.slice(1) : s;
  const dot = unsigned.indexOf('.');
  const whole = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const frac = dot === -1 ? '' : unsigned.slice(dot + 1);
  const scaled = BigInt(whole || '0') * 1000n + BigInt((frac + '000').slice(0, 3));
  return negative ? -scaled : scaled;
}

function reject(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new AppError(400, code, message, details);
}

export function assertDispatchPackedShape(envelope: DispatchPackedEnvelope): void {
  const p = envelope.payload;
  if (!isUuid(p.packing_record_id))
    reject('DISPATCH_PACKED_INVALID_PAYLOAD', 'packing_record_id is required and must be a UUID');
  if (!isUuid(p.dispatch_order_id))
    reject('DISPATCH_PACKED_INVALID_PAYLOAD', 'dispatch_order_id is required and must be a UUID');
  if (typeof p.sku !== 'string' || p.sku.length === 0)
    reject('DISPATCH_PACKED_INVALID_PAYLOAD', 'sku is required');
  if (!isPositiveFiniteQuantity(p.packed_qty))
    reject(
      'DISPATCH_PACKED_INVALID_PAYLOAD',
      'packed_qty is required and must be a positive finite numeric value',
    );
  if (!isUuid(p.lot_id))
    reject('DISPATCH_PACKED_INVALID_PAYLOAD', 'lot_id is required and must be a UUID');
  if (!Number.isInteger(p.carton_count) || p.carton_count < 0)
    reject(
      'DISPATCH_PACKED_INVALID_PAYLOAD',
      'carton_count is required and must be a non-negative integer',
    );
}

export function assertDispatchShippingDocumentsGeneratedShape(
  envelope: DispatchShippingDocumentsGeneratedEnvelope,
): void {
  const p = envelope.payload;
  if (!isUuid(p.dispatch_order_id))
    reject(
      'DISPATCH_DOCUMENTS_INVALID_PAYLOAD',
      'dispatch_order_id is required and must be a UUID',
    );
  if (!Array.isArray(p.document_types) || p.document_types.length === 0)
    reject(
      'DISPATCH_DOCUMENTS_INVALID_PAYLOAD',
      'document_types is required and must be a non-empty array',
    );
  for (const dt of p.document_types) {
    if (!DOCUMENT_TYPES.includes(dt))
      reject('DISPATCH_DOCUMENTS_INVALID_PAYLOAD', `invalid document_type: ${dt}`);
  }
}

export function assertDispatchDispatchedShape(envelope: DispatchDispatchedEnvelope): void {
  const p = envelope.payload;
  if (!isUuid(p.dispatch_order_id))
    reject(
      'DISPATCH_DISPATCHED_INVALID_PAYLOAD',
      'dispatch_order_id is required and must be a UUID',
    );
}

export async function applyDispatchPackedProjection(
  envelope: DispatchPackedEnvelope,
  client: PoolClient,
  _eventId: string,
): Promise<void> {
  const p = envelope.payload;

  // Idempotent replay guard: if this packing_record already exists, skip (replay of same event).
  const existing = await client.query(`SELECT 1 FROM packing_record WHERE packing_record_id = $1`, [
    p.packing_record_id,
  ]);
  if (existing.rows.length > 0) {
    return;
  }

  // Check the dispatch order is picked (all pick lines confirmed)
  const pickedResult = await client.query(
    `SELECT picked_at, dispatched_at FROM dispatch_order_status
     WHERE dispatch_order_id = $1 FOR UPDATE`,
    [p.dispatch_order_id],
  );
  if (pickedResult.rows.length === 0 || pickedResult.rows[0].picked_at === null) {
    throw new AppError(
      400,
      'DISPATCH_ORDER_NOT_PICKED',
      'Dispatch order must be fully picked before packing',
    );
  }
  if (pickedResult.rows[0].dispatched_at !== null) {
    throw new AppError(
      400,
      'DISPATCH_ORDER_ALREADY_DISPATCHED',
      'Dispatch order has already been dispatched',
    );
  }

  // Verify cumulative packed quantity (across all packing lines/SKUs/lots already recorded for
  // this dispatch order, plus this one) never exceeds the total confirmed pick quantity. A single
  // dispatch order may be packed across multiple lines/events (one per SKU/lot); the spec's
  // "packed_qty must match total confirmed" check applies to the sum across the whole order, not
  // to each individual line in isolation.
  const qtyResult = await client.query(
    `SELECT COALESCE(SUM(pl.confirmed_quantity)::numeric, 0) AS total_confirmed
     FROM pick_line pl
     WHERE pl.dispatch_order_line_id IN (
       SELECT id FROM erp_sales_order WHERE id = $1
     )
     AND pl.status IN ('confirmed', 'substituted')`,
    [p.dispatch_order_id],
  );
  const totalConfirmed = qtyResult.rows[0].total_confirmed;

  const packedResult = await client.query(
    `SELECT COALESCE(SUM(packed_qty)::numeric, 0) AS already_packed
     FROM packing_record WHERE dispatch_order_id = $1`,
    [p.dispatch_order_id],
  );
  const alreadyPacked = packedResult.rows[0].already_packed;
  const cumulativeScaled = (toScaled3(alreadyPacked) ?? 0n) + (toScaled3(p.packed_qty) ?? 0n);
  if (cumulativeScaled > (toScaled3(totalConfirmed) ?? 0n)) {
    throw new AppError(
      400,
      'PACKED_QTY_MISMATCH',
      'Cumulative packed quantity exceeds total confirmed pick quantity',
    );
  }

  await createPackingRecord(
    {
      packing_record_id: p.packing_record_id,
      dispatch_order_id: p.dispatch_order_id,
      sku: p.sku,
      packed_qty: p.packed_qty,
      lot_id: p.lot_id,
      actual_weight_kg: p.actual_weight_kg ?? null,
      label_ref: p.label_ref ?? null,
      carton_count: p.carton_count,
      packed_by: p.packed_by ?? envelope.metadata.actor.user_id,
    },
    client,
  );

  // Update dispatch_order_status: packed
  await client.query(
    `UPDATE dispatch_order_status
     SET packed_at = now(), packed_by = $2
     WHERE dispatch_order_id = $1`,
    [p.dispatch_order_id, p.packed_by ?? envelope.metadata.actor.user_id],
  );

  // Notify dispatch clerk
  const soLine = await getSalesOrderLineById(p.dispatch_order_id, client);
  if (soLine) {
    await emitNotificationInTransaction(
      {
        target: { role: 'dispatch_clerk', location_id: soLine.ship_from_site_id },
        event_type: 'dispatch.packed',
        status_verb: 'Packed',
        object_type: 'Dispatch order',
        object_id: p.dispatch_order_id,
        next_step: 'Ready for shipping documents.',
        actor: envelope.metadata.actor,
        correlation_id: p.dispatch_order_id,
      },
      client,
    );
  }
}

export async function applyDispatchShippingDocumentsGeneratedProjection(
  envelope: DispatchShippingDocumentsGeneratedEnvelope,
  client: PoolClient,
  _eventId: string,
): Promise<void> {
  const p = envelope.payload;

  // Verify order has been packed
  const statusResult = await client.query(
    `SELECT packed_at FROM dispatch_order_status
     WHERE dispatch_order_id = $1 FOR UPDATE`,
    [p.dispatch_order_id],
  );
  if (statusResult.rows.length === 0 || statusResult.rows[0].packed_at === null) {
    throw new AppError(
      400,
      'DISPATCH_ORDER_NOT_PACKED',
      'Dispatch order must be packed before generating documents',
    );
  }

  // LOT_ON_HOLD check: both halves, through the shared gate (lock every candidate lot FIRST, then
  // the manual/recall hold, then the QC gate) - see dispatchGateBlockedLots (Task 4.9).
  const candidateResult = await client.query(
    `SELECT pr.lot_id FROM packing_record pr WHERE pr.dispatch_order_id = $1`,
    [p.dispatch_order_id],
  );
  const candidateLotIds = candidateResult.rows.map(
    (r: Record<string, unknown>) => r['lot_id'] as string,
  );
  const { heldLotIds: heldLots, qcGatedLotIds: qcGatedLots } = await dispatchGateBlockedLots(
    candidateLotIds,
    client,
  );
  if (heldLots.length > 0) {
    throw new AppError(
      400,
      'LOT_ON_HOLD',
      'Cannot generate documents: one or more lots are on quality hold',
      { held_lot_ids: heldLots },
    );
  }
  // Story 8.1 (Task 6): the QC gate blocks shipping-document generation until Story 8.4 supplies
  // the batch release record; a conditional release alone never enables it.
  if (qcGatedLots.length > 0) {
    throw new AppError(
      400,
      'LOT_ON_HOLD',
      'Cannot generate documents: one or more lots have not been released by QC',
      { held_lot_ids: qcGatedLots, reason: 'qc_gate' },
    );
  }

  // Clear existing documents
  await clearDocumentsByDispatchOrder(p.dispatch_order_id, client);

  // Render documents
  const docTypes = p.document_types;
  const generatedBy = p.generated_by ?? envelope.metadata.actor.user_id;

  if (docTypes.includes('bol')) {
    const bolContent = await renderBOL(p.dispatch_order_id, client);
    await createDispatchDocument(
      {
        document_id: randomUUID(),
        dispatch_order_id: p.dispatch_order_id,
        document_type: 'bol',
        document_content: bolContent,
        generated_by: generatedBy,
      },
      client,
    );
  }

  if (docTypes.includes('packing_slip')) {
    const psContent = await renderPackingSlip(p.dispatch_order_id, client);
    await createDispatchDocument(
      {
        document_id: randomUUID(),
        dispatch_order_id: p.dispatch_order_id,
        document_type: 'packing_slip',
        document_content: psContent,
        generated_by: generatedBy,
      },
      client,
    );
  }

  if (docTypes.includes('commercial_invoice')) {
    const invoiceDate = envelope.metadata.occurred_at.slice(0, 10);
    const ciContent = await renderCommercialInvoice(p.dispatch_order_id, client, invoiceDate);
    await createDispatchDocument(
      {
        document_id: randomUUID(),
        dispatch_order_id: p.dispatch_order_id,
        document_type: 'commercial_invoice',
        document_content: ciContent,
        generated_by: generatedBy,
      },
      client,
    );
  }

  if (docTypes.includes('label')) {
    const labels = await renderLabels(p.dispatch_order_id, client);
    for (const label of labels) {
      await createDispatchDocument(
        {
          document_id: randomUUID(),
          dispatch_order_id: p.dispatch_order_id,
          document_type: 'label',
          document_content: label,
          generated_by: generatedBy,
        },
        client,
      );
    }
  }

  // Update packing record statuses
  await updatePackingRecordsStatusByDispatchOrder(
    p.dispatch_order_id,
    'documents_generated',
    client,
  );
}

export async function applyDispatchDispatchedProjection(
  envelope: DispatchDispatchedEnvelope,
  client: PoolClient,
  _eventId: string,
  auditCtx?: Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>,
): Promise<void> {
  const p = envelope.payload;

  // Verify order has been packed and not already dispatched
  const statusResult = await client.query(
    `SELECT packed_at, dispatched_at FROM dispatch_order_status
     WHERE dispatch_order_id = $1 FOR UPDATE`,
    [p.dispatch_order_id],
  );
  if (statusResult.rows.length === 0) {
    throw new AppError(
      400,
      'DISPATCH_ORDER_NOT_PACKED',
      'Dispatch order must be packed before dispatch',
    );
  }
  if (statusResult.rows[0].packed_at === null) {
    throw new AppError(
      400,
      'DISPATCH_ORDER_NOT_PACKED',
      'Dispatch order must be packed before dispatch',
    );
  }
  if (statusResult.rows[0].dispatched_at !== null) {
    throw new AppError(
      400,
      'DISPATCH_ORDER_ALREADY_DISPATCHED',
      'Dispatch order has already been dispatched',
    );
  }

  // Verify documents have been generated
  const docResult = await client.query(
    `SELECT COUNT(*) AS cnt FROM dispatch_document WHERE dispatch_order_id = $1`,
    [p.dispatch_order_id],
  );
  const docCount = Number(docResult.rows[0].cnt);
  if (docCount === 0) {
    throw new AppError(
      400,
      'DISPATCH_DOCUMENTS_NOT_GENERATED',
      'Shipping documents must be generated before dispatch',
    );
  }

  // Re-run LOT_ON_HOLD check — the COMPLETE gate through the shared guard, which locks every
  // candidate lot_master row FIRST, then checks the manual/recall hold half and the QC-gate half.
  // Story 9.10 (Task 1.2): this used to inline its own hold query plus a qcGatedLotIds call - both
  // halves checked in the right order, but the shared guard's OWN file diverging from the rule its
  // header comment states is how the next divergence becomes invisible. Converge on the shared
  // guard, keeping the refusal code and HTTP status byte-for-byte (400, LOT_ON_HOLD).
  const lotResult = await client.query(
    `SELECT lm.lot_id
     FROM packing_record pr
     JOIN lot_master lm ON lm.lot_id = pr.lot_id
     WHERE pr.dispatch_order_id = $1
     ORDER BY lm.lot_id`,
    [p.dispatch_order_id],
  );
  const { heldLotIds, qcGatedLotIds: qcGatedAtDispatch } = await dispatchGateBlockedLots(
    lotResult.rows.map((r: Record<string, unknown>) => r['lot_id'] as string),
    client,
  );
  if (heldLotIds.length > 0) {
    throw new AppError(
      400,
      'LOT_ON_HOLD',
      'Cannot dispatch: one or more lots are on quality hold',
      {
        held_lot_ids: heldLotIds,
        reason: 'quality_hold',
      },
    );
  }
  if (qcGatedAtDispatch.length > 0) {
    throw new AppError(
      400,
      'LOT_ON_HOLD',
      'Cannot dispatch: one or more lots have not been released by QC',
      { held_lot_ids: qcGatedAtDispatch, reason: 'qc_gate' },
    );
  }

  // Story 11.2 (AC 1): the IRN-before-dispatch wall, re-derived INSIDE the transaction (the
  // dispatch_order_status row above is already FOR UPDATE) so the direct POST /api/v1/events door
  // meets the identical wall. It runs AFTER the hold and QC rechecks so an order that is already
  // blocked (LOT_ON_HOLD) reports that existing 400 and the IRN wall only fires for an
  // otherwise-clear dispatch attempt. dispatchIsEInvoiceable is the single future-exemption point
  // (binding decision 4: pilot answer true for every erp_sales_order-backed supply on this path) and
  // dispatchGateIrnMissing is the single helper every dispatch surface must call (Task 3.1). There
  // is NO override for anybody (binding decision 5; access-matrix invariant).
  //
  // Code review 2026-09-09: the wall FAILS CLOSED. An order whose erp_sales_order row is missing
  // (dispatch_order_status carries no FK, so a purge or re-sync can strand it) cannot have coverage
  // recorded against it (the recording applier requires the line), so it is refused IRN_MISSING
  // rather than exempted - the 8.4 "null never blocks" shape that Story 8.6 reversed.
  const soLine = await getSalesOrderLineById(p.dispatch_order_id, client);
  const irnMissing =
    soLine === null
      ? true
      : dispatchIsEInvoiceable(soLine) &&
        (await dispatchGateIrnMissing(p.dispatch_order_id, client));
  if (irnMissing) {
    const refusal = new AppError(
      409,
      'IRN_MISSING',
      soLine === null
        ? 'Cannot dispatch: the dispatch order does not resolve to an ERP sales-order line, so no IRN can be verified for it'
        : 'Cannot dispatch: no IRN has been recorded for this dispatch order',
      {
        dispatch_order_id: p.dispatch_order_id,
        so_number_ext: soLine?.so_number_ext ?? null,
        reason: soLine === null ? 'no_erp_sales_order_line' : 'irn_not_recorded',
      },
    );
    if (auditCtx) {
      await logRejectionAudit({
        ...auditCtx,
        event_id: null,
        http_status: 409,
        error_code: 'IRN_MISSING',
        details: refusal.details,
      });
    }
    throw refusal;
  }

  // Count how many packing records this dispatch order has, so the decrement below can be
  // verified to have matched every one of them (not just at-least-one).
  const packingCountResult = await client.query(
    `SELECT COUNT(*) AS cnt FROM packing_record WHERE dispatch_order_id = $1`,
    [p.dispatch_order_id],
  );
  const packingCount = Number(packingCountResult.rows[0].cnt);

  // Decrement stock: move packed quantity from picked to dispatched (reduce on_hand and picked)
  const decResult = await client.query(
    `UPDATE stock_balance sb
     SET on_hand = sb.on_hand - pr.packed_qty::numeric,
         picked = sb.picked - pr.packed_qty::numeric,
         updated_at = now()
     FROM packing_record pr
     JOIN lot_master lm ON lm.lot_id = pr.lot_id
     WHERE sb.sku = pr.sku
       AND sb.lot_id = lm.lot_number
       AND sb.location_id = COALESCE(
         (SELECT pl.confirmed_location_id FROM pick_line pl
           WHERE pl.dispatch_order_line_id = pr.dispatch_order_id AND pl.confirmed_lot_id = pr.lot_id
             AND pl.status IN ('confirmed', 'substituted')
           ORDER BY pl.confirmed_at DESC NULLS LAST, pl.pick_line_id LIMIT 1),
         sb.location_id)
       AND sb.stock_class = 'owned'
       AND sb.picked >= pr.packed_qty::numeric
       AND pr.dispatch_order_id = $1`,
    [p.dispatch_order_id],
  );
  if ((decResult.rowCount ?? 0) < packingCount) {
    throw new AppError(
      500,
      'STOCK_DECREMENT_FAILED',
      'Stock balance not found for one or more dispatched lots; inventory may be inconsistent',
    );
  }

  // Update dispatch_order_status
  await client.query(
    `UPDATE dispatch_order_status
     SET dispatched_at = now(), dispatched_by = $2
     WHERE dispatch_order_id = $1`,
    [p.dispatch_order_id, p.dispatched_by ?? envelope.metadata.actor.user_id],
  );

  // Update packing record statuses
  await updatePackingRecordsStatusByDispatchOrder(p.dispatch_order_id, 'dispatched', client);
}

// ---------------------------------------------------------------------------
// Story 11.2: the outbound IRN coverage registry and the dispatch gate.
// ---------------------------------------------------------------------------

// Binding decision 4 (ruled 2026-09-05): ALL supplies are e-invoiceable. There is no exemption to
// classify, so the gate applies to every dispatch on this path. This predicate is the SINGLE place
// a future exemption would land; it is parameterised on the resolved erp_sales_order line so a unit
// test can actually fail it (the 8.4 tautological-config lesson), and so the applier can keep the
// pilot answer ("true for every erp-backed sales supply") in one auditable place.
export function dispatchIsEInvoiceable(soLine: { so_number_ext: string; status: string }): boolean {
  // A sales dispatch order IS an erp_sales_order row (dispatch_order_status joins on its id), so
  // EVERY order that resolves to an ERP sales line is e-invoiceable - including one whose
  // so_number_ext is blank (a sync defect is not an exemption; the wall must not open on bad data).
  // The predicate takes the line, never null: the applier fails closed BEFORE calling it when the
  // line is missing. A future exemption (e.g. SEZ/export supply) would branch on the line here.
  return typeof soLine.so_number_ext === 'string';
}

// Task 3.1/3.2: the IRN half of the dispatch gate, kept as a SIBLING of dispatchGateBlockedLots (the
// IRN is DISPATCH-ORDER-keyed, not lot-keyed, so forcing it into { heldLotIds, qcGatedLotIds } would
// be wrong). EVERY dispatch surface meets the IRN check by calling THIS helper in the same locked
// transaction; there is no second ad-hoc call site.
export async function dispatchGateIrnMissing(
  dispatchOrderId: string,
  client: PoolClient,
): Promise<boolean> {
  return !(await dispatchIrnPresent(dispatchOrderId, client));
}

// Closed-shape allowlist for the recording payload. so_number_ext is server-derived and refused on
// input; recorded_by is the authenticated actor (metadata.actor.user_id, pinned by both doors) and
// likewise refused; anything not listed here is refused.
const DISPATCH_IRN_ALLOWED_FIELDS = new Set([
  'invoice_number_ext',
  'irn_ext',
  'dispatch_order_ids',
  'irp_acknowledged_at',
  'site_id',
]);

// Story 11.5: the IRN validators moved to the leaf module ./irn.js so the transfer seam can reuse
// them without importing this module (which reaches the event store, which imports the transfer
// seam: a cycle that broke named imports under tsx). Re-exported here so 11.2 callers are unchanged.
export { IRN_EXT_REGEX, normalizeIrnExt, isValidIrpAcknowledgedAt } from './irn.js';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || value === null || isValidIrpAcknowledgedAt(value);
}

export function assertDispatchIrnShape(envelope: DispatchIrnRecordedEnvelope): void {
  const p = envelope.payload;
  if (typeof p !== 'object' || p === null)
    reject('DISPATCH_IRN_INVALID_PAYLOAD', 'payload is required');
  const payload = p as unknown as Record<string, unknown>;
  for (const key of Object.keys(payload)) {
    if (!DISPATCH_IRN_ALLOWED_FIELDS.has(key))
      reject(
        'DISPATCH_IRN_INVALID_PAYLOAD',
        `so_number_ext, recorded_by and every other field is server-derived and refused on input (unexpected key: ${key})`,
      );
  }
  if (payload['so_number_ext'] !== undefined)
    reject('DISPATCH_IRN_INVALID_PAYLOAD', 'so_number_ext is server-derived and refused on input');
  if (!isNonEmptyString(payload['invoice_number_ext']))
    reject(
      'DISPATCH_IRN_INVALID_PAYLOAD',
      'invoice_number_ext is required and must be a non-empty string',
    );
  if (!isNonEmptyString(payload['irn_ext']) || !IRN_EXT_REGEX.test(payload['irn_ext'].trim()))
    reject(
      'DISPATCH_IRN_INVALID_PAYLOAD',
      'irn_ext is required and must be the 64-character hexadecimal IRN issued by the IRP',
    );
  if (!Array.isArray(payload['dispatch_order_ids']) || payload['dispatch_order_ids'].length === 0)
    reject(
      'DISPATCH_IRN_INVALID_PAYLOAD',
      'dispatch_order_ids is required and must be a non-empty array',
    );
  const ids = payload['dispatch_order_ids'] as unknown[];
  for (const id of ids) {
    if (!isUuid(id))
      reject('DISPATCH_IRN_INVALID_PAYLOAD', 'every dispatch_order_id must be a UUID');
  }
  // Case-insensitive dedupe: a UUID differing only in case is the same order, and the applier
  // lower-cases every id before locking and writing.
  if (new Set(ids.map((id) => (id as string).toLowerCase())).size !== ids.length)
    reject('DISPATCH_IRN_INVALID_PAYLOAD', 'dispatch_order_ids must not contain duplicates');
  if (!isUuid(payload['site_id']))
    reject('DISPATCH_IRN_INVALID_PAYLOAD', 'site_id is required and must be a UUID');
  if (!isOptionalTimestamp(payload['irp_acknowledged_at']))
    reject(
      'DISPATCH_IRN_INVALID_PAYLOAD',
      'irp_acknowledged_at must be an RFC 3339 instant not in the future, or null',
    );
}

/**
 * Task 2.5/2.6 applier: one recording event writes N coverage rows, one per listed dispatch order,
 * in this single transaction. Replay idempotency comes from the persistEvent alreadyPersisted
 * short-circuit (never a bespoke pre-read of dispatch_irn, and never a UNIQUE index on
 * source_event_id).
 *
 * Collision handling (deviates from the Task 2.6 text, which said "let the PK raise 23505 and
 * classify it"): a per-dispatch-order advisory xact lock is taken first and the existing coverage
 * row is READ under it, so two concurrent recordings serialize and the loser classifies against the
 * committed row instead of surfacing a raw dispatch_irn_pkey 23505 - outcome-equivalent, disclosed
 * in the story Completion Notes. Classification (review decision D1, 2026-09-09):
 *   - DIFFERENT invoice on an already covered order: 409 DISPATCH_IRN_CONFLICT, no overwrite.
 *   - SAME invoice, SAME IRN: a no-op that succeeds (a re-post, not a replay).
 *   - SAME invoice, DIFFERENT IRN: the IRP cancel-and-regenerate case - the stored IRN is
 *     SUPERSEDED in place (the only UPDATE on dispatch_irn) and the superseding event is stamped.
 * Every input is normalised first: ids lower-cased, invoice trimmed, IRN trimmed + lower-cased -
 * so the events door and the REST door store identical bytes.
 */
export async function applyDispatchIrnRecorded(
  envelope: DispatchIrnRecordedEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload;
  // The recording clerk is the authenticated actor, pinned onto metadata by both doors. Never a
  // payload field (the Story 9.9 approved_by lesson).
  const recordedBy = envelope.metadata.actor.user_id;
  const correlationId = envelope.metadata.correlation_id ?? null;
  const invoiceNumberExt = p.invoice_number_ext.trim();
  const irnExt = normalizeIrnExt(p.irn_ext);
  const irpAcknowledgedAt = p.irp_acknowledged_at ?? null;
  const dispatchOrderIds = p.dispatch_order_ids.map((id) => id.toLowerCase());

  // Site binding (Task 2.4): the payload MUST carry site_id so assertPayloadSiteWriteAccess fires on
  // the direct events door, and the applier binds payload site to row site by checking every listed
  // dispatch order resolves to that same site (via its erp_sales_order line), refusing the whole
  // event otherwise. so_number_ext is server-derived from that same line. Review decision D3: a line
  // ERP has closed can no longer be invoiced, so recording against it is refused on both doors.
  const resolved: Array<{ dispatch_order_id: string; so_number_ext: string }> = [];
  for (const dispatchOrderId of dispatchOrderIds) {
    const soLine = await getSalesOrderLineById(dispatchOrderId, client);
    if (!soLine) {
      throw new AppError(
        404,
        'DISPATCH_ORDER_NOT_FOUND',
        `No ERP sales-order line exists for dispatch order "${dispatchOrderId}"`,
        { dispatch_order_id: dispatchOrderId },
      );
    }
    if (soLine.status !== 'open') {
      throw new AppError(
        409,
        'DISPATCH_ORDER_CLOSED',
        `Dispatch order "${dispatchOrderId}" is ${soLine.status} in ERP; an IRN cannot be recorded against it`,
        { dispatch_order_id: dispatchOrderId, status: soLine.status },
      );
    }
    if (soLine.ship_from_site_id !== p.site_id) {
      throw new AppError(
        400,
        'DISPATCH_ORDER_SITE_MISMATCH',
        `Dispatch order "${dispatchOrderId}" does not belong to the payload site`,
        {
          dispatch_order_id: dispatchOrderId,
          site_id: p.site_id,
          resolved_site_id: soLine.ship_from_site_id,
        },
      );
    }
    resolved.push({ dispatch_order_id: dispatchOrderId, so_number_ext: soLine.so_number_ext });
  }

  // Write one coverage row per listed dispatch order. Take a per-dispatch-order advisory xact lock
  // FIRST (deterministic order) so two concurrent recordings that cover the SAME dispatch order
  // (e.g. via each other's also_covers) serialize: the loser blocks, then reads the committed
  // coverage row and classifies (same invoice = no-op, different invoice = 409), instead of one
  // losing on a raw dispatch_irn_pkey 23505. The insert below then never races a PK collision.
  const lockKeys = [...resolved.map((r) => r.dispatch_order_id)].sort();
  for (const dispatchOrderId of lockKeys) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `dispatch_irn:${dispatchOrderId}`,
    ]);
  }

  for (const row of resolved) {
    const existing = await getDispatchIrn(row.dispatch_order_id, client);
    if (existing) {
      if (existing.invoice_number_ext !== invoiceNumberExt) {
        throw new AppError(
          409,
          'DISPATCH_IRN_CONFLICT',
          `Dispatch order ${row.dispatch_order_id} is already covered by invoice ${existing.invoice_number_ext}`,
          {
            dispatch_order_id: row.dispatch_order_id,
            invoice_number_ext: invoiceNumberExt,
            existing_invoice_number_ext: existing.invoice_number_ext,
            so_number_ext: existing.so_number_ext,
          },
        );
      }
      if (existing.irn_ext === irnExt) {
        // SAME invoice, SAME IRN: a no-op that succeeds.
        continue;
      }
      // SAME invoice, DIFFERENT IRN: supersede in place (decision D1).
      await supersedeDispatchIrn(
        {
          dispatch_order_id: row.dispatch_order_id,
          irn_ext: irnExt,
          irp_acknowledged_at: irpAcknowledgedAt,
          recorded_by: recordedBy,
          source_event_id: eventId,
          correlation_id: correlationId,
        },
        client,
      );
      continue;
    }
    await insertDispatchIrnCoverage(
      {
        dispatch_order_id: row.dispatch_order_id,
        invoice_number_ext: invoiceNumberExt,
        irn_ext: irnExt,
        so_number_ext: row.so_number_ext,
        irp_acknowledged_at: irpAcknowledgedAt,
        site_id: p.site_id,
        recorded_by: recordedBy,
        source_event_id: eventId,
        correlation_id: correlationId,
      },
      client,
    );
  }
}
