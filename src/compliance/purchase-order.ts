import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { persistEvent } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import type { PurchaseOrderRow } from '../read/projections/purchase_order.js';
import {
  getPurchaseOrderById,
  getPurchaseOrderLines,
  insertPurchaseOrder,
  insertPurchaseOrderLine,
  recomputePoTotalValue,
  updatePurchaseOrderStatus,
  updatePurchaseOrderLinePromisedDate,
  allocatePoNumber,
  insertPoOutboundMessage,
  addPoReleaseValue,
} from '../read/projections/purchase_order.js';
import { getIndentById, updateIndentStatus } from '../read/projections/indent.js';
import { getSupplierById } from '../read/projections/supplier.js';
import { findActiveDelegation } from '../read/projections/doa_registry.js';
import { resolveApprover } from '../api/v1/indents.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import { buildPoOutboundPayload } from '../adapters/erp/po-outbound.js';

const PROCUREMENT_STREAM_TYPES = new Set(['procurement']);
const PURCHASE_ORDER_EVENT_TYPES = new Set([
  'purchase_order.drafted',
  'purchase_order.approved',
  'purchase_order.rejected',
  'purchase_order.issued',
  'purchase_order.confirmed',
  'purchase_order.release_recorded',
  'purchase_order.ceiling_revised',
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_NUMERIC_14_2 = 999_999_999_999.99;
const MAX_NUMERIC_14_3 = 99_999_999_999.999;
const MAX_NUMERIC_14_4 = 9_999_999_999.9999;

export const PO_DOA_TYPE = 'purchase_order_approval';

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isDateString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_REGEX.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function hasScale(value: number, scale: number): boolean {
  const scaled = value * 10 ** scale;
  return Math.abs(scaled - Math.round(scaled)) < Number.EPSILON * 10;
}

function hasNumericScale(value: unknown, scale: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && hasScale(value, scale);
}

function assertNumeric(
  value: unknown,
  code: string,
  message: string,
  max: number,
  scale: number,
): void {
  if (!hasNumericScale(value, scale) || Math.abs(value) > max) reject(code, message);
}

export function purchaseOrderEventType(envelope: EventEnvelope): string | null {
  if (!PROCUREMENT_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!PURCHASE_ORDER_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

export function assertPurchaseOrderShape(envelope: EventEnvelope): void {
  const type = purchaseOrderEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  switch (type) {
    case 'purchase_order.drafted':
      assertPoDraftedShape(p);
      break;
    case 'purchase_order.approved':
      if (!isUuid(p['po_id'])) reject('INVALID_PARAMS', 'po_id is required and must be a UUID');
      if (!isUuid(p['approver_actor_id']))
        reject('INVALID_PARAMS', 'approver_actor_id is required and must be a UUID');
      break;
    case 'purchase_order.rejected':
      if (!isUuid(p['po_id'])) reject('INVALID_PARAMS', 'po_id is required and must be a UUID');
      if (!isUuid(p['approver_actor_id']))
        reject('INVALID_PARAMS', 'approver_actor_id is required and must be a UUID');
      if (!isNonEmptyString(p['rejection_reason']))
        reject(
          'PO_REJECTION_REASON_REQUIRED',
          'A rejection requires a non-empty rejection_reason',
          { po_id: p['po_id'] },
        );
      break;
    case 'purchase_order.issued':
      if (!isUuid(p['po_id'])) reject('INVALID_PARAMS', 'po_id is required and must be a UUID');
      break;
    case 'purchase_order.confirmed':
      if (!isUuid(p['po_id'])) reject('INVALID_PARAMS', 'po_id is required and must be a UUID');
      if (!isDateString(p['promised_delivery_date']))
        reject(
          'INVALID_PARAMS',
          'promised_delivery_date is required and must be a YYYY-MM-DD date string',
        );
      break;
    case 'purchase_order.release_recorded':
      if (!isUuid(p['po_id'])) reject('INVALID_PARAMS', 'po_id is required and must be a UUID');
      if (!isNonEmptyString(p['release_reference']))
        reject('INVALID_PARAMS', 'release_reference is required and must be a non-empty string');
      assertNumeric(
        p['release_value'],
        'INVALID_PARAMS',
        'release_value is required and must be a positive amount with at most 2 decimals',
        MAX_NUMERIC_14_2,
        2,
      );
      if ((p['release_value'] as number) <= 0)
        reject('INVALID_PARAMS', 'release_value is required and must be positive');
      break;
    case 'purchase_order.ceiling_revised':
      if (!isUuid(p['po_id'])) reject('INVALID_PARAMS', 'po_id is required and must be a UUID');
      assertNumeric(
        p['new_ceiling_value'],
        'INVALID_PARAMS',
        'new_ceiling_value is required and must be a non-negative amount with at most 2 decimals',
        MAX_NUMERIC_14_2,
        2,
      );
      if ((p['new_ceiling_value'] as number) < 0)
        reject('INVALID_PARAMS', 'new_ceiling_value is required and must be non-negative');
      break;
  }
}

function assertPoDraftedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['po_id'])) reject('INVALID_PARAMS', 'po_id is required and must be a UUID');
  if (!isUuid(p['supplier_id']))
    reject('INVALID_PARAMS', 'supplier_id is required and must be a UUID');
  if (!isUuid(p['indent_id'])) reject('INVALID_PARAMS', 'indent_id is required and must be a UUID');
  if (!isUuid(p['site_id'])) reject('INVALID_PARAMS', 'site_id is required and must be a UUID');

  const poType = p['po_type'];
  if (poType !== 'standard' && poType !== 'blanket' && poType !== 'contract') {
    reject('INVALID_PARAMS', 'po_type is required and must be standard, blanket, or contract');
  }

  if (!Array.isArray(p['lines']) || (p['lines'] as unknown[]).length === 0) {
    reject('PO_LINE_REQUIRED', 'A purchase order requires at least one line item', {
      po_id: p['po_id'],
    });
  }

  let lineNo = 0;
  let totalValue = 0;
  for (const line of p['lines'] as Record<string, unknown>[]) {
    lineNo += 1;
    if (!isNonEmptyString(line['sku'])) {
      reject('INVALID_PARAMS', `Line ${lineNo}: sku is required and must be a non-empty string`);
    }
    if (!isNonEmptyString(line['item_category'])) {
      reject(
        'INVALID_PARAMS',
        `Line ${lineNo}: item_category is required and must be a non-empty string`,
      );
    }
    if (
      !hasNumericScale(line['ordered_qty'], 3) ||
      (line['ordered_qty'] as number) <= 0 ||
      (line['ordered_qty'] as number) > MAX_NUMERIC_14_3
    ) {
      reject(
        'INVALID_PARAMS',
        `Line ${lineNo}: ordered_qty is required and must be positive with at most 3 decimals`,
      );
    }
    if (!isNonEmptyString(line['uom'])) {
      reject('INVALID_PARAMS', `Line ${lineNo}: uom is required and must be a non-empty string`);
    }
    if (
      !hasNumericScale(line['unit_price'], 4) ||
      (line['unit_price'] as number) < 0 ||
      (line['unit_price'] as number) > MAX_NUMERIC_14_4
    ) {
      reject(
        'INVALID_PARAMS',
        `Line ${lineNo}: unit_price is required and must be non-negative with at most 4 decimals`,
      );
    }
    const lineValue = (line['ordered_qty'] as number) * (line['unit_price'] as number);
    if (lineValue > MAX_NUMERIC_14_2) {
      reject('INVALID_PARAMS', `Line ${lineNo}: line_value exceeds NUMERIC(14,2) capacity`);
    }
    totalValue += lineValue;
    if (totalValue > MAX_NUMERIC_14_2) {
      reject('INVALID_PARAMS', 'total_value exceeds NUMERIC(14,2) capacity');
    }
    if (
      line['tax_rate_pct'] !== undefined &&
      line['tax_rate_pct'] !== null &&
      (typeof line['tax_rate_pct'] !== 'number' ||
        !Number.isFinite(line['tax_rate_pct']) ||
        (line['tax_rate_pct'] as number) < 0 ||
        (line['tax_rate_pct'] as number) > 100)
    ) {
      reject('INVALID_PARAMS', `Line ${lineNo}: tax_rate_pct must be a number between 0 and 100`);
    }
  }

  if (poType === 'blanket' || poType === 'contract') {
    if (p['ceiling_value'] === undefined || p['ceiling_value'] === null) {
      reject('PO_CEILING_REQUIRED', 'Blanket and contract POs require a ceiling_value', {
        po_id: p['po_id'],
        po_type: poType,
      });
    }
    if (
      !hasNumericScale(p['ceiling_value'], 2) ||
      (p['ceiling_value'] as number) < 0 ||
      (p['ceiling_value'] as number) > MAX_NUMERIC_14_2
    ) {
      reject('INVALID_PARAMS', 'ceiling_value must be non-negative with at most 2 decimals');
    }
  }
}

// ---------------------------------------------------------------------------
// Inside-transaction projection (DB access)
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

export async function applyPurchaseOrderProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = purchaseOrderEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'purchase_order.drafted':
      await applyPoDrafted(envelope, client, eventId);
      break;
    case 'purchase_order.approved':
      await applyPoApproved(envelope, client);
      break;
    case 'purchase_order.rejected':
      await applyPoRejected(envelope, client);
      break;
    case 'purchase_order.issued':
      await applyPoIssued(envelope, client, eventId);
      break;
    case 'purchase_order.confirmed':
      await applyPoConfirmed(envelope, client);
      break;
    case 'purchase_order.release_recorded':
      await applyPoReleaseRecorded(envelope, client);
      break;
    case 'purchase_order.ceiling_revised':
      await applyPoCeilingRevised(envelope, client);
      break;
  }
}

async function applyPoDrafted(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const poId = p['po_id'] as string;

  const existing = await getPurchaseOrderById(poId, client, true);
  if (existing) {
    reject(
      'DUPLICATE_EVENT',
      'A purchase order with this po_id already exists',
      {
        po_id: poId,
        existing_status: existing.status,
      },
      409,
    );
  }

  const indentId = p['indent_id'] as string;
  const indent = await getIndentById(indentId, client);
  if (!indent) {
    reject('INDENT_NOT_FOUND', 'Source indent not found', { indent_id: indentId }, 404);
  }
  if (indent.status !== 'approved') {
    reject(
      'PO_INDENT_NOT_APPROVED',
      'Source indent must be approved to create a PO',
      {
        indent_id: indentId,
        status: indent.status,
      },
      409,
    );
  }

  const supplierId = p['supplier_id'] as string;
  const supplier = await getSupplierById(supplierId, client);
  if (!supplier) {
    reject('SUPPLIER_NOT_FOUND', 'Supplier not found', { supplier_id: supplierId }, 404);
  }
  if (supplier.status !== 'active') {
    reject(
      'SUPPLIER_NOT_ACTIVE',
      'Supplier must be active to receive a PO',
      {
        supplier_id: supplierId,
        status: supplier.status,
      },
      409,
    );
  }

  const lines = p['lines'] as Record<string, unknown>[];
  const poType = p['po_type'] as 'standard' | 'blanket' | 'contract';
  const ceilingValue =
    (poType === 'blanket' || poType === 'contract') && typeof p['ceiling_value'] === 'number'
      ? String(p['ceiling_value'])
      : null;

  const occurredAt = envelope.metadata.occurred_at;
  if (
    !occurredAt ||
    typeof occurredAt !== 'string' ||
    Number.isNaN(new Date(occurredAt).getTime())
  ) {
    reject('INVALID_PARAMS', 'occurred_at is required and must be a valid ISO 8601 date string');
  }
  const year = new Date(occurredAt).getUTCFullYear();
  const poNumber = await allocatePoNumber(year, client);

  try {
    await insertPurchaseOrder(
      {
        po_id: poId,
        po_number_ext: poNumber,
        po_type: poType,
        supplier_id: supplierId,
        indent_id: indentId,
        site_id: indent.site_id,
        business_stream: indent.business_stream,
        status: 'draft',
        total_value: '0',
        ceiling_value: ceilingValue,
        currency: typeof p['currency'] === 'string' ? p['currency'] : 'INR',
        payment_terms: supplier.commercial_terms,
        created_by: envelope.metadata.actor.user_id,
        approver_actor_id: null,
        doa_entry_id: null,
        correlation_id: envelope.metadata.correlation_id ?? null,
        source_event_id: eventId,
      },
      client,
    );
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
      return;
    }
    throw err;
  }

  let lineNo = 0;
  for (const line of lines) {
    lineNo += 1;
    await insertPurchaseOrderLine(
      {
        po_line_id: randomUUID(),
        po_id: poId,
        line_no: lineNo,
        sku: (line['sku'] as string).trim(),
        item_category: (line['item_category'] as string).trim(),
        ordered_qty: line['ordered_qty'] as number,
        uom: (line['uom'] as string).trim(),
        unit_price: line['unit_price'] as number,
        tax_rate_pct: typeof line['tax_rate_pct'] === 'number' ? line['tax_rate_pct'] : null,
      },
      client,
    );
  }
  await recomputePoTotalValue(poId, client);

  // AC2: DOA resolution against the SQL-computed NUMERIC total (never a JS float sum - the 4.3
  // review float-free precedent). Fail closed (Task 5.4): a matched band with no resolvable
  // holder propagates APPROVAL_UNRESOLVED (409) and rolls the whole draft back.
  const inserted = await getPurchaseOrderById(poId, client);
  const totalValue = inserted?.total_value ?? '0';
  const resolution = await resolveApprover(PO_DOA_TYPE, totalValue);

  let approverActorId: string | null = null;
  let doaEntryId: string | null = null;
  let status: 'pending-approval' | 'approved';
  if (resolution.requiresApproval) {
    approverActorId = resolution.approverActorId;
    doaEntryId = resolution.doaEntryId;
    status = 'pending-approval';
  } else {
    status = 'approved';
  }
  await updatePurchaseOrderStatus(
    poId,
    status,
    { approver_actor_id: approverActorId, doa_entry_id: doaEntryId },
    client,
  );

  if (status === 'pending-approval' && approverActorId) {
    await emitNotificationInTransaction(
      {
        target: {
          role: envelope.metadata.actor.role,
          user_id: approverActorId,
        },
        event_type: 'po_approval_request',
        status_verb: 'pending-approval',
        object_type: 'purchase_order',
        object_id: poId,
        actor_label: `PO ${poNumber}`,
        next_step: 'Review and approve or reject this purchase order',
        actor: envelope.metadata.actor,
        correlation_id: envelope.metadata.correlation_id,
        occurred_at: occurredAt,
      },
      client,
    );
  }
}

async function assertDecisionAllowed(
  envelope: EventEnvelope,
  po: PurchaseOrderRow,
  client: PoolClient,
): Promise<void> {
  if (po.status === 'approved' || po.status === 'rejected') {
    reject(
      'PO_ALREADY_DECIDED',
      'Purchase order has already been decided',
      {
        po_id: po.po_id,
        status: po.status,
      },
      409,
    );
  }
  if (po.status !== 'pending-approval') {
    reject(
      'PO_NOT_PENDING_APPROVAL',
      'Only a pending-approval PO can be decided',
      {
        po_id: po.po_id,
        status: po.status,
      },
      409,
    );
  }

  const actorId = envelope.metadata.actor.user_id;

  if (actorId === po.created_by) {
    reject(
      'PO_CREATOR_CANNOT_APPROVE',
      'The PO creator cannot approve or reject their own PO (SOD)',
      {
        po_id: po.po_id,
        created_by: po.created_by,
      },
      403,
    );
  }

  if (!po.approver_actor_id) {
    reject(
      'NOT_RESOLVED_APPROVER',
      'No DOA-resolved approver exists for this PO',
      {
        po_id: po.po_id,
      },
      403,
    );
  }
  if (actorId !== po.approver_actor_id) {
    const today = envelope.metadata.occurred_at.slice(0, 10);
    const delegation = await findActiveDelegation(po.approver_actor_id, today, client);
    if (!delegation || delegation.delegate_user_id !== actorId) {
      reject(
        'NOT_RESOLVED_APPROVER',
        'The acting user is not the DOA-resolved approver for this PO',
        {
          po_id: po.po_id,
          approver_actor_id: po.approver_actor_id,
          acting_user_id: actorId,
        },
        403,
      );
    }
  }
}

async function applyPoApproved(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const poId = p['po_id'] as string;

  const po = await getPurchaseOrderById(poId, client, true);
  if (!po) {
    reject('PO_NOT_FOUND', 'Purchase order not found', { po_id: poId }, 404);
  }
  await assertDecisionAllowed(envelope, po, client);

  const now = envelope.metadata.occurred_at;
  await updatePurchaseOrderStatus(
    poId,
    'approved',
    { decided_at: now, decided_by: envelope.metadata.actor.user_id },
    client,
  );

  await emitNotificationInTransaction(
    {
      target: {
        role: envelope.metadata.actor.role,
        user_id: po.created_by,
      },
      event_type: 'po_decision',
      status_verb: 'approved',
      object_type: 'purchase_order',
      object_id: poId,
      actor_label: `PO ${po.po_number_ext}`,
      next_step: 'The purchase order can now be issued to the supplier',
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      occurred_at: now,
    },
    client,
  );
}

async function applyPoRejected(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const poId = p['po_id'] as string;

  if (!isNonEmptyString(p['rejection_reason'])) {
    reject('PO_REJECTION_REASON_REQUIRED', 'A rejection requires a non-empty rejection_reason', {
      po_id: poId,
    });
  }

  const po = await getPurchaseOrderById(poId, client, true);
  if (!po) {
    reject('PO_NOT_FOUND', 'Purchase order not found', { po_id: poId }, 404);
  }
  await assertDecisionAllowed(envelope, po, client);

  const now = envelope.metadata.occurred_at;
  const reason = (p['rejection_reason'] as string).trim();
  await updatePurchaseOrderStatus(
    poId,
    'rejected',
    { decided_at: now, decided_by: envelope.metadata.actor.user_id, rejection_reason: reason },
    client,
  );

  await emitNotificationInTransaction(
    {
      target: {
        role: envelope.metadata.actor.role,
        user_id: po.created_by,
      },
      event_type: 'po_decision',
      status_verb: 'rejected',
      object_type: 'purchase_order',
      object_id: poId,
      actor_label: `PO ${po.po_number_ext}`,
      next_step: `Rejection reason: ${reason}`,
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      occurred_at: now,
    },
    client,
  );
}

async function applyPoIssued(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const poId = p['po_id'] as string;

  const po = await getPurchaseOrderById(poId, client, true);
  if (!po) {
    reject('PO_NOT_FOUND', 'Purchase order not found', { po_id: poId }, 404);
  }
  if (po.status !== 'approved') {
    reject(
      'APPROVAL_REQUIRED',
      'Only an approved PO can be issued',
      {
        po_id: poId,
        status: po.status,
      },
      409,
    );
  }

  const now = envelope.metadata.occurred_at;
  await updatePurchaseOrderStatus(poId, 'issued', { issued_at: now }, client);

  const lines = await getPurchaseOrderLines(poId, client);
  const supplier = await getSupplierById(po.supplier_id, client);
  if (!supplier) {
    reject('SUPPLIER_NOT_FOUND', 'Supplier not found', { supplier_id: po.supplier_id }, 404);
  }

  const outboundPayload = buildPoOutboundPayload(
    po,
    lines,
    supplier,
    now,
    envelope.metadata.correlation_id ?? null,
  );

  await insertPoOutboundMessage(randomUUID(), poId, outboundPayload, client);

  await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: po.indent_id,
      event_type: 'indent.ordered',
      payload: {
        indent_id: po.indent_id,
        purchase_order_id: poId,
      },
      metadata: {
        correlation_id: envelope.metadata.correlation_id ?? randomUUID(),
        causation_id: eventId,
        actor: envelope.metadata.actor,
        occurred_at: now,
      },
    },
    undefined,
    client,
  );
}

async function applyPoConfirmed(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const poId = p['po_id'] as string;

  const po = await getPurchaseOrderById(poId, client, true);
  if (!po) {
    reject('PO_NOT_FOUND', 'Purchase order not found', { po_id: poId }, 404);
  }
  if (po.status !== 'issued') {
    reject(
      'PO_NOT_ISSUED',
      'Only an issued PO can be confirmed',
      {
        po_id: poId,
        status: po.status,
      },
      409,
    );
  }

  const now = envelope.metadata.occurred_at;
  const promisedDate = p['promised_delivery_date'] as string;
  await updatePurchaseOrderStatus(
    poId,
    'confirmed',
    { confirmed_at: now, promised_delivery_date: promisedDate },
    client,
  );

  // AC4: the promised date is stamped on every PO line; the payload may override individual
  // lines (keyed by po_line_id) when the supplier commits different dates per line.
  const linePromisedDates = p['line_promised_dates'] as Record<string, string> | undefined;
  const lines = await getPurchaseOrderLines(poId, client);
  for (const line of lines) {
    const override = linePromisedDates?.[line.po_line_id];
    if (override !== undefined && !isDateString(override)) {
      reject('INVALID_PARAMS', 'line_promised_dates must contain YYYY-MM-DD calendar dates');
    }
    const lineDate = override ?? promisedDate;
    await updatePurchaseOrderLinePromisedDate(line.po_line_id, lineDate, client);
  }

  // AC4: surface the promised date on the linked requisition. The indent event vocabulary has no
  // event for a post-ordered date update (indent.ordered requires status 'approved' and would be
  // rejected here), so the expected_delivery_date is stamped through the indent projection
  // accessor inside THIS transaction - the state change stays event-sourced because the
  // purchase_order.confirmed domain event in this same transaction is its replayable source.
  const indent = await getIndentById(po.indent_id, client, true);
  if (indent && indent.status === 'ordered') {
    await updateIndentStatus(
      po.indent_id,
      'ordered',
      { expected_delivery_date: promisedDate },
      client,
    );
  }
}

async function applyPoReleaseRecorded(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const poId = p['po_id'] as string;

  const po = await getPurchaseOrderById(poId, client, true);
  if (!po) {
    reject('PO_NOT_FOUND', 'Purchase order not found', { po_id: poId }, 404);
  }
  if (po.po_type !== 'blanket' && po.po_type !== 'contract') {
    reject(
      'PO_NOT_RELEASE_TYPE',
      'Only blanket or contract POs can have releases',
      {
        po_id: poId,
        po_type: po.po_type,
      },
      409,
    );
  }
  if (po.status !== 'issued' && po.status !== 'confirmed') {
    reject(
      'PO_NOT_ISSUED',
      'Only an issued or confirmed PO can record releases',
      { po_id: poId, status: po.status },
      409,
    );
  }
  if (!po.ceiling_value) {
    reject('PO_CEILING_REQUIRED', 'PO has no ceiling value', { po_id: poId }, 409);
  }

  // AC5: the ceiling comparison runs inside PostgreSQL NUMERIC (addPoReleaseValue's guarded
  // UPDATE), never JS floats. The PO row is already locked FOR UPDATE above, so the read-back
  // in the rejection details is consistent.
  const releaseValue = p['release_value'] as number;
  const result = await addPoReleaseValue(
    poId,
    String(releaseValue),
    p['release_reference'] as string,
    client,
  );
  if (result === 'duplicate') {
    reject(
      'DUPLICATE_EVENT',
      'A release with this release_reference already exists for this PO',
      { po_id: poId, release_reference: p['release_reference'] },
      409,
    );
  }
  if (result === 'ceiling') {
    reject(
      'PO_CEILING_EXCEEDED',
      'Release would exceed PO ceiling',
      {
        po_id: poId,
        ceiling_value: po.ceiling_value,
        released_value: po.released_value,
        release_value: String(releaseValue),
      },
      409,
    );
  }
}

async function applyPoCeilingRevised(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const poId = p['po_id'] as string;

  const po = await getPurchaseOrderById(poId, client, true);
  if (!po) {
    reject('PO_NOT_FOUND', 'Purchase order not found', { po_id: poId }, 404);
  }
  if (po.po_type !== 'blanket' && po.po_type !== 'contract') {
    reject(
      'PO_NOT_RELEASE_TYPE',
      'Only blanket or contract POs can have ceiling revisions',
      {
        po_id: poId,
        po_type: po.po_type,
      },
      409,
    );
  }
  if (po.status === 'rejected') {
    reject('PO_NOT_ISSUED', 'Rejected POs cannot have ceiling revisions', { po_id: poId }, 409);
  }

  // AC5 / AC6: the revision IS the fresh DOA-gated approval act, enforced in the seam so a
  // direct POST /api/v1/events cannot raise a ceiling unapproved. The approver is re-resolved
  // here against the NEW ceiling value (payload approver ids are never trusted), the same
  // decision guards as approve/reject apply (SOD + resolved-approver-or-delegate), and an
  // unresolvable approver fails closed with APPROVAL_UNRESOLVED.
  const newCeiling = p['new_ceiling_value'] as number;
  if (newCeiling < Number(po.released_value)) {
    reject(
      'PO_CEILING_EXCEEDED',
      'New ceiling cannot be below already released value',
      { po_id: poId, released_value: po.released_value, new_ceiling_value: String(newCeiling) },
      409,
    );
  }
  const resolution = await resolveApprover(PO_DOA_TYPE, String(newCeiling));
  if (!resolution.requiresApproval || !resolution.approverActorId) {
    reject(
      'APPROVAL_UNRESOLVED',
      'Ceiling revision requires DOA approval but no governing band exists',
      { po_id: poId, new_ceiling_value: String(newCeiling) },
      409,
    );
  }

  const actorId = envelope.metadata.actor.user_id;
  if (actorId === po.created_by) {
    reject(
      'PO_CREATOR_CANNOT_APPROVE',
      'The PO creator cannot approve their own ceiling revision (SOD)',
      { po_id: poId, created_by: po.created_by },
      403,
    );
  }
  if (actorId !== resolution.approverActorId) {
    const today = envelope.metadata.occurred_at.slice(0, 10);
    const delegation = await findActiveDelegation(resolution.approverActorId, today, client);
    if (!delegation || delegation.delegate_user_id !== actorId) {
      reject(
        'NOT_RESOLVED_APPROVER',
        'The acting user is not the DOA-resolved approver for this ceiling revision',
        {
          po_id: poId,
          approver_actor_id: resolution.approverActorId,
          acting_user_id: actorId,
        },
        403,
      );
    }
  }

  await updatePurchaseOrderStatus(
    poId,
    po.status,
    {
      ceiling_value: String(newCeiling),
      approver_actor_id: resolution.approverActorId,
      doa_entry_id: resolution.doaEntryId,
    },
    client,
  );
}
