import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import type { JobworkOutputRecordedPayload } from '../events/schema.js';
import { AppError } from '../middleware/error.js';
import { getServiceOrderById } from '../read/projections/service_order.js';
import type { ServiceOrderRow } from '../read/projections/service_order.js';
import { getBomById } from '../read/projections/bom.js';
import { createLot } from '../read/projections/lot_master.js';
import { applyStockReceipt } from '../read/projections/stock_balance.js';
import { insertJobWorkOutput } from '../read/projections/job_work_output.js';
import { receiveQcCompletion } from '../quality/completion.js';
import { isPositiveQtyString } from './jobwork-receipt.js';
import type { AuditEntryPayload } from '../read/projections/audit_log.js';

/**
 * Story 9.4 (FR-JW-11): job-work output recording on the EXISTING 'jobwork' stream. This is the
 * FIRST caller of the Story 8.1 receiveQcCompletion contract's 'job_work_order' reserved variant
 * (src/quality/completion.ts:11-24) - Epic 9 built no production/completion concept before this
 * story, so this seam creates the output lot and posts finished stock itself, exactly mirroring
 * src/compliance/production-completion.ts's postOutput closure, then delegates the QC hand-off.
 *
 * Binding decision (disclosed): the kit BOM's PARENT item (bom.parent_item_id/parent_sku/
 * parent_uom) is the job-work output item - no output-item field exists on service_order.
 *
 * LOCK ORDER (the 7.4 rule, identical to service-order.ts / jobwork-receipt.ts / custody-ledger.ts):
 *   1. pg_advisory_xact_lock(hashtextextended(service_order_id, 0));
 *   2. the service_order row FOR UPDATE;
 *   3. the kit BOM is a plain SELECT (AD-14);
 *   4. lot_master insert, then stock_balance receipt, then the QC-gate hand-off last (mirrors
 *      production-completion.ts's own documented contract: lot, then stock, then gate).
 */

const JOBWORK_STREAM_TYPES = new Set(['jobwork']);
export const JOBWORK_OUTPUT_RECORDED = 'jobwork.output_recorded';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 200;

const OUTPUT_FIELDS = new Set([
  'service_order_id',
  'output_id',
  'quantity',
  'uom',
  'site_id',
  'recorded_by',
]);
/**
 * Server-derived, mirroring Story 6.3's postOutput closure: the lot NUMBER is minted here, and so
 * is the lot identity itself. lot_id was previously accepted, validated and then silently ignored
 * (every write used the minted number), so a caller supplying its own lot identifier got a 201 and
 * a different lot than it asked for - refuse it instead (code review 2026-09-03).
 */
const OUTPUT_DERIVED_FIELDS = ['lot_number', 'lot_id'] as const;

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

export function jobworkOutputEventType(envelope: EventEnvelope): string | null {
  if (!JOBWORK_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (envelope.event_type !== JOBWORK_OUTPUT_RECORDED) return null;
  return envelope.event_type;
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

export function assertJobworkOutputShape(envelope: EventEnvelope): void {
  if (envelope.event_type !== JOBWORK_OUTPUT_RECORDED) return;
  if (!JOBWORK_STREAM_TYPES.has(envelope.stream_type)) {
    reject('INVALID_EVENT_ENVELOPE', 'jobwork.* events must ride the jobwork stream', {
      event_type: envelope.event_type,
      stream_type: envelope.stream_type,
    });
  }
  const p = envelope.payload as Record<string, unknown>;
  for (const field of OUTPUT_DERIVED_FIELDS) {
    if (p[field] !== undefined) {
      reject('INVALID_PARAMS', `${field} is derived by the server and must not be supplied`, {
        field,
      });
    }
  }
  for (const key of Object.keys(p)) {
    if (!OUTPUT_FIELDS.has(key)) {
      reject('INVALID_PARAMS', `${key} is not a recognized field on this event`, { field: key });
    }
  }
  for (const field of ['service_order_id', 'output_id', 'site_id', 'recorded_by']) {
    if (!isUuid(p[field])) reject('INVALID_PARAMS', `${field} is required and must be a UUID`);
  }
  if (envelope.stream_id !== p['service_order_id']) {
    reject('INVALID_EVENT_ENVELOPE', 'stream_id must equal service_order_id', {
      stream_id: envelope.stream_id,
      service_order_id: p['service_order_id'],
    });
  }
  if (!isNonEmptyString(p['uom']) || (p['uom'] as string).trim().length > MAX_TEXT_LENGTH) {
    reject('INVALID_PARAMS', 'uom is required and must be a non-empty string');
  }
  p['uom'] = (p['uom'] as string).trim();
  if (!isPositiveQtyString(p['quantity'])) {
    reject(
      'INVALID_PARAMS',
      'quantity is required and must be a strictly positive NUMERIC string with at most 3 decimals',
      { field: 'quantity', value: p['quantity'] ?? null },
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

/** Same key and seed as service-order.ts / jobwork-receipt.ts / custody-ledger.ts. */
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
      'Recording output requires an in_process service order; none exists for service_order_id',
      { service_order_id: serviceOrderId },
      409,
    );
  }
  if (order.status !== 'in_process') {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      `Recording output requires an in_process service order; this order is ${order.status}`,
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

export async function applyJobworkOutputProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  auditCtx?: Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>,
): Promise<void> {
  if (jobworkOutputEventType(envelope) === null) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as JobworkOutputRecordedPayload;
  const occurredAt = envelope.metadata.occurred_at ?? new Date().toISOString();
  const order = await requireInProcessOrder(p.service_order_id, p.site_id, client);

  if (!order.kit_bom_id) {
    reject(
      'BOM_NOT_FOUND',
      'The service order has no linked kit BOM to resolve an output item from',
      { service_order_id: order.service_order_id },
      404,
    );
  }
  // Binding decision: the kit BOM's PARENT item is the job-work output item (no output-item field
  // exists on service_order).
  const bom = await getBomById(order.kit_bom_id, client);
  if (!bom) {
    reject(
      'BOM_NOT_FOUND',
      'The order kit BOM could not be resolved',
      { kit_bom_id: order.kit_bom_id },
      404,
    );
  }

  // The output is stocked and QC-gated as the BOM parent item, so it must be recorded in the unit
  // that item is stocked in - otherwise stock_balance and the QC task carry a quantity in a unit
  // the item is not held in.
  if (bom.parent_uom && p.uom !== bom.parent_uom) {
    reject(
      'INVALID_PARAMS',
      'uom must match the kit BOM parent uom',
      { uom: p.uom, parent_uom: bom.parent_uom, sku: bom.parent_sku },
      400,
    );
  }

  // Sequence under the order lock already held above - no race on the lot number.
  const seqResult = await client.query(
    `SELECT COUNT(*)::int AS n FROM job_work_output WHERE service_order_id = $1`,
    [order.service_order_id],
  );
  const sequence = (seqResult.rows[0]!['n'] as number) + 1;
  // Binding Decision 5 precedent (Story 6.3): the lot number is server-minted and immutable.
  // order_number_ext is unique only PER SITE (uq_service_order_number_site) while
  // uq_lot_master_lot_number is GLOBAL, so the site discriminator is what keeps two sites running
  // the same external order number from colliding on the first output and 500ing out of createLot
  // (code review 2026-09-03).
  const siteDiscriminator = order.site_id.slice(0, 8);
  const lotNumber = `${order.order_number_ext}-${siteDiscriminator}-L${sequence}`;

  const lot = await createLot(
    {
      lot_number: lotNumber,
      sku: bom.parent_sku,
      expiry_date: null,
      quality_hold_status: 'none',
      quality_hold_reason: null,
    },
    client,
  );
  // stock_balance.lot_id carries the lot NUMBER (the Epic 2 ledger convention); the lot UUID lives
  // on lot_master and on the job_work_output row. Ordinary owned stock at the order's site - QC
  // Hold is the Story 8.1 gate state, not a bin or a stock class (the 9.3 story text's own
  // articulation of this decision).
  await applyStockReceipt(
    {
      sku: bom.parent_sku,
      location_id: order.site_id,
      lot_id: lotNumber,
      quantity: p.quantity,
    },
    client,
  );

  await insertJobWorkOutput(
    {
      output_id: p.output_id,
      service_order_id: order.service_order_id,
      lot_id: lotNumber,
      lot_number: lotNumber,
      sku: bom.parent_sku,
      quantity: p.quantity,
      uom: p.uom,
      site_id: order.site_id,
      recorded_by: p.recorded_by,
      source_event_id: eventId,
    },
    client,
  );

  // Binding Decision 1 precedent (Story 6.3): the QC hand-off is DELEGATED to receiveQcCompletion
  // on this same transaction. A hand-off failure rolls the lot, the stock and the output row back.
  const taskId = p.output_id;
  const handoff = await receiveQcCompletion(
    {
      source_completion_type: 'job_work_order',
      source_completion_id: p.output_id,
      lot_id: lot.lot_id,
      lot_number: lotNumber,
      item_id: bom.parent_item_id,
      quantity: p.quantity,
      uom: p.uom,
      site_id: order.site_id,
      bom_revision_id: bom.current_revision_id ?? '',
      completed_at: occurredAt,
      business_stream: order.business_stream,
      source_order_type: 'job_work_order',
      source_order_ref: order.order_number_ext,
      actor: {
        user_id: envelope.metadata.actor.user_id,
        role: envelope.metadata.actor.role,
        location_id: order.site_id,
      },
      task_id: taskId,
    },
    client,
    auditCtx,
  );
  if (handoff.task.task_id !== taskId) {
    reject(
      'QC_TASK_MISSING',
      'The QC gate returned a different inspection task than the output minted',
      { output_id: p.output_id, expected_task_id: taskId, task_id: handoff.task.task_id },
      500,
    );
  }

  // The stored event carries what THIS process derived, never what the caller asserted.
  envelope.payload['lot_number'] = lotNumber;
}
