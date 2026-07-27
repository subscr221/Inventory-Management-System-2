import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type { DispatchDispatchedEnvelope, DispatchPackedEnvelope, DispatchShippingDocumentsGeneratedEnvelope } from '../events/schema.js';
import { AppError } from '../middleware/error.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import { createPackingRecord, updatePackingRecordsStatusByDispatchOrder } from '../read/projections/packing_record.js';
import { createDispatchDocument, clearDocumentsByDispatchOrder } from '../read/projections/dispatch_document.js';
import { getSalesOrderLineById } from '../read/projections/erp_sales_order.js';
import { renderBOL, renderPackingSlip, renderCommercialInvoice, renderLabels } from '../warehouse/document-renderer.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOCUMENT_TYPES = ['bol', 'packing_slip', 'commercial_invoice', 'label'];

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

const NUMERIC_REGEX = /^-?\d+(\.\d+)?$/;

function isPositiveFiniteQuantity(value: unknown): value is string | number {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (typeof value !== 'string' || value.length === 0) return false;
  return NUMERIC_REGEX.test(value) && BigInt(value.replace(/^0+/, '0').replace('.', '')) > 0n;
}

function reject(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new AppError(400, code, message, details);
}

export function assertDispatchPackedShape(envelope: DispatchPackedEnvelope): void {
  const p = envelope.payload;
  if (!isUuid(p.packing_record_id)) reject('DISPATCH_PACKED_INVALID_PAYLOAD', 'packing_record_id is required and must be a UUID');
  if (!isUuid(p.dispatch_order_id)) reject('DISPATCH_PACKED_INVALID_PAYLOAD', 'dispatch_order_id is required and must be a UUID');
  if (typeof p.sku !== 'string' || p.sku.length === 0) reject('DISPATCH_PACKED_INVALID_PAYLOAD', 'sku is required');
  if (!isPositiveFiniteQuantity(p.packed_qty)) reject('DISPATCH_PACKED_INVALID_PAYLOAD', 'packed_qty is required and must be a positive finite numeric value');
  if (!isUuid(p.lot_id)) reject('DISPATCH_PACKED_INVALID_PAYLOAD', 'lot_id is required and must be a UUID');
  if (!Number.isInteger(p.carton_count) || p.carton_count < 0) reject('DISPATCH_PACKED_INVALID_PAYLOAD', 'carton_count is required and must be a non-negative integer');
}

export function assertDispatchShippingDocumentsGeneratedShape(envelope: DispatchShippingDocumentsGeneratedEnvelope): void {
  const p = envelope.payload;
  if (!isUuid(p.dispatch_order_id)) reject('DISPATCH_DOCUMENTS_INVALID_PAYLOAD', 'dispatch_order_id is required and must be a UUID');
  if (!Array.isArray(p.document_types) || p.document_types.length === 0) reject('DISPATCH_DOCUMENTS_INVALID_PAYLOAD', 'document_types is required and must be a non-empty array');
  for (const dt of p.document_types) {
    if (!DOCUMENT_TYPES.includes(dt)) reject('DISPATCH_DOCUMENTS_INVALID_PAYLOAD', `invalid document_type: ${dt}`);
  }
}

export function assertDispatchDispatchedShape(envelope: DispatchDispatchedEnvelope): void {
  const p = envelope.payload;
  if (!isUuid(p.dispatch_order_id)) reject('DISPATCH_DISPATCHED_INVALID_PAYLOAD', 'dispatch_order_id is required and must be a UUID');
}

export async function applyDispatchPackedProjection(
  envelope: DispatchPackedEnvelope,
  client: PoolClient,
  _eventId: string,
): Promise<void> {
  const p = envelope.payload;

  // Check the dispatch order is picked (all pick lines confirmed)
  const pickedResult = await client.query(
    `SELECT picked_at, dispatched_at FROM dispatch_order_status
     WHERE dispatch_order_id = $1 FOR UPDATE`,
    [p.dispatch_order_id],
  );
  if (pickedResult.rows.length === 0 || pickedResult.rows[0].picked_at === null) {
    throw new AppError(400, 'DISPATCH_ORDER_NOT_PICKED', 'Dispatch order must be fully picked before packing');
  }
  if (pickedResult.rows[0].dispatched_at !== null) {
    throw new AppError(400, 'DISPATCH_ORDER_ALREADY_DISPATCHED', 'Dispatch order has already been dispatched');
  }

  // Verify packed quantity matches confirmed pick quantity for this dispatch order
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
  const packedQtyStr = String(p.packed_qty);
  if (packedQtyStr !== totalConfirmed) {
    throw new AppError(400, 'PACKED_QTY_MISMATCH', 'Packed quantity does not match total confirmed pick quantity');
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
      packed_by: p.packed_by ?? 'unknown',
    },
    client,
  );

  // Update dispatch_order_status: packed
  await client.query(
    `UPDATE dispatch_order_status
     SET packed_at = now(), packed_by = $2
     WHERE dispatch_order_id = $1`,
    [p.dispatch_order_id, p.packed_by ?? 'unknown'],
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
        actor: { user_id: p.packed_by ?? 'unknown', role: 'dispatch_clerk', location_id: '00000000-0000-0000-0000-000000000000' },
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
    throw new AppError(400, 'DISPATCH_ORDER_NOT_PACKED', 'Dispatch order must be packed before generating documents');
  }

  // LOT_ON_HOLD check: verify no lot in the packing records is on quality hold
  const holdResult = await client.query(
    `SELECT lm.lot_id, lm.lot_number
     FROM packing_record pr
     JOIN lot_master lm ON lm.lot_id = pr.lot_id
     WHERE pr.dispatch_order_id = $1
       AND lm.quality_hold_status = 'held'
     FOR UPDATE OF lm`,
    [p.dispatch_order_id],
  );
  if (holdResult.rows.length > 0) {
    const heldLots = holdResult.rows.map((r: Record<string, unknown>) => r['lot_id'] as string);
    throw new AppError(400, 'LOT_ON_HOLD', 'Cannot generate documents: one or more lots are on quality hold', { held_lot_ids: heldLots });
  }

  // Clear existing documents
  await clearDocumentsByDispatchOrder(p.dispatch_order_id, client);

  // Render documents
  const docTypes = p.document_types;
  const generatedBy = p.generated_by ?? 'unknown';

  if (docTypes.includes('bol')) {
    const bolContent = await renderBOL(p.dispatch_order_id, client);
    await createDispatchDocument({
      document_id: randomUUID(),
      dispatch_order_id: p.dispatch_order_id,
      document_type: 'bol',
      document_content: bolContent,
      generated_by: generatedBy,
    }, client);
  }

  if (docTypes.includes('packing_slip')) {
    const psContent = await renderPackingSlip(p.dispatch_order_id, client);
    await createDispatchDocument({
      document_id: randomUUID(),
      dispatch_order_id: p.dispatch_order_id,
      document_type: 'packing_slip',
      document_content: psContent,
      generated_by: generatedBy,
    }, client);
  }

  if (docTypes.includes('commercial_invoice')) {
    const ciContent = await renderCommercialInvoice(p.dispatch_order_id, client);
    await createDispatchDocument({
      document_id: randomUUID(),
      dispatch_order_id: p.dispatch_order_id,
      document_type: 'commercial_invoice',
      document_content: ciContent,
      generated_by: generatedBy,
    }, client);
  }

  if (docTypes.includes('label')) {
    const labels = await renderLabels(p.dispatch_order_id, client);
    for (const label of labels) {
      await createDispatchDocument({
        document_id: randomUUID(),
        dispatch_order_id: p.dispatch_order_id,
        document_type: 'label',
        document_content: label,
        generated_by: generatedBy,
      }, client);
    }
  }

  // Update packing record statuses
  await updatePackingRecordsStatusByDispatchOrder(p.dispatch_order_id, 'documents_generated', client);
}

export async function applyDispatchDispatchedProjection(
  envelope: DispatchDispatchedEnvelope,
  client: PoolClient,
  _eventId: string,
): Promise<void> {
  const p = envelope.payload;

  // Verify order has been packed and not already dispatched
  const statusResult = await client.query(
    `SELECT packed_at, dispatched_at FROM dispatch_order_status
     WHERE dispatch_order_id = $1 FOR UPDATE`,
    [p.dispatch_order_id],
  );
  if (statusResult.rows.length === 0) {
    throw new AppError(400, 'DISPATCH_ORDER_NOT_PACKED', 'Dispatch order must be packed before dispatch');
  }
  if (statusResult.rows[0].packed_at === null) {
    throw new AppError(400, 'DISPATCH_ORDER_NOT_PACKED', 'Dispatch order must be packed before dispatch');
  }
  if (statusResult.rows[0].dispatched_at !== null) {
    throw new AppError(400, 'DISPATCH_ORDER_ALREADY_DISPATCHED', 'Dispatch order has already been dispatched');
  }

  // Verify documents have been generated
  const docResult = await client.query(
    `SELECT COUNT(*) AS cnt FROM dispatch_document WHERE dispatch_order_id = $1`,
    [p.dispatch_order_id],
  );
  const docCount = Number(docResult.rows[0].cnt);
  if (docCount === 0) {
    throw new AppError(400, 'DISPATCH_ORDER_NOT_PACKED', 'Shipping documents must be generated before dispatch');
  }

  // Re-run LOT_ON_HOLD check
  const holdResult = await client.query(
    `SELECT lm.lot_id
     FROM packing_record pr
     JOIN lot_master lm ON lm.lot_id = pr.lot_id
     WHERE pr.dispatch_order_id = $1
       AND lm.quality_hold_status = 'held'
     FOR UPDATE OF lm`,
    [p.dispatch_order_id],
  );
  if (holdResult.rows.length > 0) {
    throw new AppError(400, 'LOT_ON_HOLD', 'Cannot dispatch: one or more lots are on quality hold');
  }

  // Decrement stock: move packed quantity from picked to dispatched (reduce on_hand and picked)
  await client.query(
    `UPDATE stock_balance sb
     SET on_hand = sb.on_hand - pr.packed_qty::numeric,
         picked = sb.picked - pr.packed_qty::numeric,
         updated_at = now()
     FROM packing_record pr
     JOIN lot_master lm ON lm.lot_id = pr.lot_id
     WHERE sb.sku = pr.sku
       AND sb.lot_id = lm.lot_number
       AND sb.stock_class = 'owned'
       AND pr.dispatch_order_id = $1`,
    [p.dispatch_order_id],
  );

  // Update dispatch_order_status
  await client.query(
    `UPDATE dispatch_order_status
     SET dispatched_at = now(), dispatched_by = $2
     WHERE dispatch_order_id = $1`,
    [p.dispatch_order_id, p.dispatched_by ?? 'unknown'],
  );

  // Update packing record statuses
  await updatePackingRecordsStatusByDispatchOrder(p.dispatch_order_id, 'dispatched', client);
}
