import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import type {
  JobworkBillingFeedAcknowledgedPayload,
  JobworkBillingFeedGeneratedPayload,
} from '../events/schema.js';
import { AppError } from '../middleware/error.js';
import {
  getServiceOrderById,
  updateServiceOrderFields,
} from '../read/projections/service_order.js';
import type { ServiceOrderRow } from '../read/projections/service_order.js';
import { listJobworkMaterialReceiptsByOrder } from '../read/projections/jobwork_material_receipt.js';
import { listCustodyLedgerByOrder } from '../read/projections/custody_ledger_entry.js';
import {
  getBillingFeedById,
  insertBillingFeed,
  markBillingFeedAcknowledged,
} from '../read/projections/job_work_billing_feed.js';
import {
  buildJobWorkBillingFeedPayload,
  resolveMeasuredBasis,
} from '../adapters/erp/job-work-billing-feed.js';
import type { JobWorkBillingDispatchLine } from '../adapters/erp/job-work-billing-feed.js';
import { qtyFromScaled, qtyToScaled } from './custody-statement.js';

/**
 * Story 9.6 (FR-JW-12): the measured ERP billing feed and its acknowledgment, on the EXISTING
 * 'jobwork' stream (Binding decision 7: never `erp.*` / stream `erp`, which assertErpReadOnly 405s
 * before any write). Split like every other seam: assert* runs BEFORE any DB write; apply* runs
 * INSIDE the event transaction with every precondition re-derived under the order advisory lock
 * (the hold-bypass class - a direct POST /api/v1/events meets the identical wall).
 *
 * Generation (AC 4) has ONE precondition, BILLING_NOT_READY with details.reason: at least one
 * job_work_dispatch row - AC4's literal "completed, dispatched".
 *
 * Story 9.6 REVISED 2026-09-05: the offcut precondition is GONE. Offcut is now captured unvalued and
 * disposed of later (Story 9.7), so waiting for it would hold the service invoice for however long
 * the offcut sits retained - possibly months after the work was delivered. Offcut buyback reaches
 * ERP as a CREDIT NOTE against this invoice when the finance controller values it, never as a line
 * on this feed.
 * There is deliberately NO "every output fully dispatched" gate (Binding decision 18): the
 * open-to-dispatch quantity goes on the feed and the reconciliation report instead.
 * One feed per order is a SCHEMA rule (Binding decision 14, uq_job_work_billing_feed_order), so a
 * second generation is a 409 DUPLICATE_EVENT through the 23505 classification, never bespoke logic.
 *
 * Acknowledgment (AC 4) is an INBOUND command (Binding decision 8) that flips the feed and stamps
 * invoiced_at / invoiced_feed_id on the order - a column pair, never a fifth status (Binding
 * decision 9). SEGREGATION OF DUTIES (Binding decision 17): RBAC is module plus function scope, so
 * generation and acknowledgment sit behind one key; the applier refuses SOD_VIOLATION when the
 * acknowledging actor is the feed's generated_by, modelled on the 9.4 acting-user check.
 *
 * LOCK ORDER (the 7.4 rule): order advisory lock, order row FOR UPDATE, then plain SELECTs on the
 * receipt / dispatch / ledger projections, then the feed row LAST.
 */

const JOBWORK_STREAM_TYPES = new Set(['jobwork']);
export const JOBWORK_BILLING_FEED_GENERATED = 'jobwork.billing_feed_generated';
export const JOBWORK_BILLING_FEED_ACKNOWLEDGED = 'jobwork.billing_feed_acknowledged';
const BILLING_EVENT_TYPES = new Set([
  JOBWORK_BILLING_FEED_GENERATED,
  JOBWORK_BILLING_FEED_ACKNOWLEDGED,
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 200;

const GENERATED_FIELDS = new Set([
  'service_order_id',
  'feed_id',
  'site_id',
  'generated_by',
  'measured_hours',
  'idempotency_key',
]);
/** Server-derived on generation: refused on input, written back by the applier. */
export const GENERATED_DERIVED_FIELDS = [
  'measured_basis',
  'measured_quantity',
  'total_value',
  'currency',
  'open_to_dispatch_qty',
] as const;
const ACKNOWLEDGED_FIELDS = new Set([
  'feed_id',
  'service_order_id',
  'site_id',
  'acknowledged_ref_ext',
  'acknowledged_by',
]);

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
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
// Pure predicates (parameterised so unit tests can fail them - the 8.4 lesson)
// ---------------------------------------------------------------------------

/** AC 4: an order is billable once it has started; closure does not un-bill it (decision 9). */
export function orderAcceptsBilling(status: ServiceOrderRow['status']): boolean {
  return status === 'in_process' || status === 'closed';
}

/**
 * The two generation preconditions as one pure predicate. Returns the FIRST failing reason, or
 * null when billing may proceed. `dispatchCount` is the count of job_work_dispatch rows for the
 * order. Story 9.6 revised: there is deliberately no offcut leg - see the module header.
 */
export function billingNotReadyReason(input: {
  status: ServiceOrderRow['status'];
  dispatchCount: number;
}): 'order_not_started' | 'no_dispatch' | null {
  if (!orderAcceptsBilling(input.status)) return 'order_not_started';
  if (input.dispatchCount < 1) return 'no_dispatch';
  return null;
}

/**
 * Binding decision 17: the acknowledging actor must not be the feed's generating actor.
 *
 * Story 9.6 code review 2026-09-05 widened this to the offcut SETTLER: whoever names the price of
 * the customer's offcut must not also sign off the document that bills it. Under the revised model
 * the rate is named at DISPOSAL by the finance controller (Story 9.7), and with the tolerance band
 * removed this guard is the ONLY control over that rate - so it must not be weakened. The
 * `offcutSettledBy` leg is inert until Story 9.7 stamps the column.
 */
export function acknowledgmentSodViolation(input: {
  generatedBy: string;
  offcutSettledBy: string | null;
  actingUserId: string;
}): 'generator' | 'offcut_settler' | null {
  if (input.generatedBy === input.actingUserId) return 'generator';
  if (input.offcutSettledBy !== null && input.offcutSettledBy === input.actingUserId) {
    return 'offcut_settler';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

export function assertJobworkBillingShape(envelope: EventEnvelope): void {
  if (!BILLING_EVENT_TYPES.has(envelope.event_type)) return;
  if (!JOBWORK_STREAM_TYPES.has(envelope.stream_type)) {
    reject('INVALID_EVENT_ENVELOPE', 'jobwork.* events must ride the jobwork stream', {
      event_type: envelope.event_type,
      stream_type: envelope.stream_type,
    });
  }
  const p = envelope.payload as Record<string, unknown>;
  if (envelope.event_type === JOBWORK_BILLING_FEED_GENERATED) {
    for (const field of GENERATED_DERIVED_FIELDS) {
      if (p[field] !== undefined) {
        reject('INVALID_PARAMS', `${field} is derived by the server and must not be supplied`, {
          field,
        });
      }
    }
    for (const key of Object.keys(p)) {
      if (!GENERATED_FIELDS.has(key)) {
        reject('INVALID_PARAMS', `${key} is not a recognized field on this event`, { field: key });
      }
    }
    for (const field of ['service_order_id', 'feed_id', 'site_id', 'generated_by']) {
      if (!isUuid(p[field])) reject('INVALID_PARAMS', `${field} is required and must be a UUID`);
    }
    // Story 9.6 review 2026-09-06: it is only meaningful on a per_hour basis. Accepting it on any
    // other basis stored an hours figure on the event that had no effect on the invoice, which reads
    // as evidence of a billing input that was never used. The basis lives on the order, so the seam
    // refuses the mismatch below, under the lock; this stays a type check.
    if (p['measured_hours'] !== undefined && typeof p['measured_hours'] !== 'string') {
      reject('INVALID_PARAMS', 'measured_hours must be a NUMERIC string when supplied', {
        field: 'measured_hours',
      });
    }
    if (p['idempotency_key'] !== undefined && typeof p['idempotency_key'] !== 'string') {
      reject('INVALID_PARAMS', 'idempotency_key must be a string when supplied');
    }
    // The generator named in the payload must BE the authenticated actor (the 9.5 closure
    // requested_by pattern): the SoD check on acknowledgment compares against this value, so a
    // forged generated_by would let the same person acknowledge their own feed.
    if (p['generated_by'] !== envelope.metadata.actor.user_id) {
      reject(
        'FUNCTION_ACCESS_DENIED',
        'generated_by must be the authenticated actor generating the feed',
        { generated_by: p['generated_by'], actor_user_id: envelope.metadata.actor.user_id },
        403,
      );
    }
  } else {
    for (const key of Object.keys(p)) {
      if (!ACKNOWLEDGED_FIELDS.has(key)) {
        reject('INVALID_PARAMS', `${key} is not a recognized field on this event`, { field: key });
      }
    }
    for (const field of ['feed_id', 'service_order_id', 'site_id', 'acknowledged_by']) {
      if (!isUuid(p[field])) reject('INVALID_PARAMS', `${field} is required and must be a UUID`);
    }
    if (
      typeof p['acknowledged_ref_ext'] !== 'string' ||
      p['acknowledged_ref_ext'].trim().length === 0 ||
      p['acknowledged_ref_ext'].trim().length > MAX_TEXT_LENGTH
    ) {
      reject(
        'INVALID_PARAMS',
        `acknowledged_ref_ext is required and must be the non-blank ERP document number (at most ${MAX_TEXT_LENGTH} characters)`,
        { field: 'acknowledged_ref_ext' },
      );
    }
    p['acknowledged_ref_ext'] = (p['acknowledged_ref_ext'] as string).trim();
    if (p['acknowledged_by'] !== envelope.metadata.actor.user_id) {
      reject(
        'FUNCTION_ACCESS_DENIED',
        'acknowledged_by must be the authenticated actor acknowledging the feed',
        { acknowledged_by: p['acknowledged_by'], actor_user_id: envelope.metadata.actor.user_id },
        403,
      );
    }
  }
  if (envelope.stream_id !== p['service_order_id']) {
    reject('INVALID_EVENT_ENVELOPE', 'stream_id must equal service_order_id', {
      stream_id: envelope.stream_id,
      service_order_id: p['service_order_id'],
    });
  }
}

// ---------------------------------------------------------------------------
// In-transaction gates (DB access)
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

/** Same key and seed as service-order.ts advisoryLock and custody-ledger.ts lockOrder. */
async function lockedOrder(
  serviceOrderId: string,
  siteId: string,
  client: PoolClient,
): Promise<ServiceOrderRow> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [serviceOrderId]);
  const order = await getServiceOrderById(serviceOrderId, client, true);
  if (!order) {
    reject(
      'SERVICE_ORDER_NOT_FOUND',
      'Service order not found',
      { service_order_id: serviceOrderId },
      404,
    );
  }
  if (order.site_id !== siteId) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      'The service order belongs to a different site than the posting',
      { service_order_id: order.service_order_id, order_site_id: order.site_id, site_id: siteId },
      409,
    );
  }
  return order;
}

/** Both feed keys are 409 DUPLICATE_EVENT; the details name which one collided (the 9.1 lesson). */
function classifyFeedDuplicate(
  err: unknown,
  feedId: string,
  orderId: string,
  eventId: string,
): never {
  if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
    const constraint = (err as { constraint?: string }).constraint;
    if (constraint === 'uq_job_work_billing_feed_order') {
      reject(
        'DUPLICATE_EVENT',
        'A billing feed already exists for this service order; retries re-send the same feed and never mint a second billable event',
        { service_order_id: orderId, constraint },
        409,
      );
    }
    if (constraint === 'uq_job_work_billing_feed_source_event') {
      reject(
        'DUPLICATE_EVENT',
        'A billing feed already exists for this event',
        { source_event_id: eventId, constraint },
        409,
      );
    }
    if (constraint === 'job_work_billing_feed_pkey') {
      reject(
        'DUPLICATE_EVENT',
        'A billing feed with this id already exists',
        { feed_id: feedId, constraint },
        409,
      );
    }
  }
  // Story 9.6 code review (2026-09-06): a computed amount that exceeds the NUMERIC(18,4) feed
  // columns dies here as SQLSTATE 22003. Order-creation now bounds the rate to 14 integer digits,
  // so this is a second belt for pathological combinations (huge measured quantity x large rate);
  // classify it as a clean refusal rather than a raw 500. 23505 remains the only classified state.
  if (err instanceof Error && 'code' in err && (err as { code: string }).code === '22003') {
    reject(
      'INVALID_PARAMS',
      'The computed billing value exceeds the feed amount range; check the order rate and the measured quantity',
      { feed_id: feedId, service_order_id: orderId },
      400,
    );
  }
  // Story 9.6 code review (2026-09-06): the row CHECKs (open_to_dispatch_qty >= 0 and the money
  // columns' non-negativity) fail as SQLSTATE 23514. Only reachable if an upstream invariant has
  // already broken (over-dispatch), so the refusal must name the feed rather than die as a 500.
  if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23514') {
    reject(
      'INVALID_PARAMS',
      'A computed feed value violates the billing feed row constraints; reconcile the order dispatches before billing',
      {
        feed_id: feedId,
        service_order_id: orderId,
        constraint: (err as { constraint?: string }).constraint ?? null,
      },
      400,
    );
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Generation (AC 4, Task 5)
// ---------------------------------------------------------------------------

export async function applyJobworkBillingFeedGenerated(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (envelope.event_type !== JOBWORK_BILLING_FEED_GENERATED) return;
  if (!JOBWORK_STREAM_TYPES.has(envelope.stream_type)) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as JobworkBillingFeedGeneratedPayload;
  const occurredAt = envelope.metadata.occurred_at ?? new Date().toISOString();
  const order = await lockedOrder(p.service_order_id, p.site_id, client);

  const dispatchResult = await client.query(
    `SELECT dispatch_id, lot_number, sku, dispatched_quantity::text AS dispatched_quantity, uom,
            dispatched_at
       FROM job_work_dispatch WHERE service_order_id = $1
      ORDER BY dispatched_at ASC, created_at ASC, dispatch_id ASC`,
    [order.service_order_id],
  );
  // Dispatch lines are summed into ONE measured_quantity and billed at ONE rate, so mixing uoms
  // would bill kilograms and pieces as if they were the same unit (fixed 2026-09-06).
  const dispatchUoms = new Set(dispatchResult.rows.map((row) => row['uom'] as string));
  if (dispatchUoms.size > 1) {
    reject(
      'INVALID_PARAMS',
      'This order has dispatches in more than one unit of measure and cannot be billed on a single measured quantity',
      { service_order_id: order.service_order_id, uoms: [...dispatchUoms].sort() },
    );
  }
  const dispatches: JobWorkBillingDispatchLine[] = dispatchResult.rows.map((row) => ({
    dispatch_id: row['dispatch_id'] as string,
    lot_number: row['lot_number'] as string,
    sku: row['sku'] as string,
    dispatched_quantity: row['dispatched_quantity'] as string,
    uom: row['uom'] as string,
    dispatched_at:
      row['dispatched_at'] instanceof Date
        ? (row['dispatched_at'] as Date).toISOString()
        : String(row['dispatched_at']),
  }));

  const notReady = billingNotReadyReason({
    status: order.status,
    dispatchCount: dispatches.length,
  });
  if (notReady !== null) {
    reject(
      'BILLING_NOT_READY',
      notReady === 'no_dispatch'
        ? 'A billing feed requires a completed, dispatched order: no job-work dispatch has been recorded'
        : `A billing feed requires an order that has started processing; this order is ${order.status}`,
      {
        service_order_id: order.service_order_id,
        reason: notReady,
        status: order.status,
        dispatch_count: dispatches.length,
      },
      409,
    );
  }
  if (!order.price_basis) {
    reject(
      'BILLING_NOT_READY',
      'The order carries no price basis to bill from',
      { service_order_id: order.service_order_id, reason: 'price_basis_missing' },
      409,
    );
  }

  // Measured basis (Binding decision 12): dispatched total for per_piece/per_kg, exact scaled sum.
  let dispatchedTotal = 0n;
  for (const line of dispatches) dispatchedTotal += qtyToScaled(line.dispatched_quantity);
  // measured_hours is only an input to a per_hour basis. Accepting it on any other basis stored an
  // hours figure on the event that never touched the invoice (fixed 2026-09-06). The basis lives on
  // the ORDER, so this is the first point that can judge it - under the lock, not at the route.
  if (p.measured_hours !== undefined && order.price_basis.basis_type !== 'per_hour') {
    reject(
      'INVALID_PARAMS',
      'measured_hours applies only to a per_hour price basis',
      {
        field: 'measured_hours',
        basis_type: order.price_basis.basis_type,
        service_order_id: order.service_order_id,
      },
      400,
    );
  }
  const measured = resolveMeasuredBasis({
    basisType: order.price_basis.basis_type,
    dispatchedTotal: qtyFromScaled(dispatchedTotal),
    measuredHours: p.measured_hours,
  });

  // Binding decision 18: open-to-dispatch is a reporting fact, never a refusal.
  const openResult = await client.query(
    `SELECT COALESCE(SUM(quantity - dispatched_quantity), 0)::numeric(18,3)::text AS open_qty
       FROM job_work_output WHERE service_order_id = $1`,
    [order.service_order_id],
  );
  const openToDispatchQty = openResult.rows[0]!['open_qty'] as string;

  const receipts = await listJobworkMaterialReceiptsByOrder(order.service_order_id, client);
  const ledger = await listCustodyLedgerByOrder(order.service_order_id, client);
  // FR-JW-07 own-material lines (the 9.3 shape) and FR-JW-09/10 retain-and-buy lines (Task 5.2).
  const ownMaterialRows = ledger.filter((r) => r.ownership === 'processor' && r.billable === true);
  const idempotencyKey = p.idempotency_key ?? envelope.idempotency_key ?? eventId;
  const payload = buildJobWorkBillingFeedPayload({
    feedId: p.feed_id,
    order,
    receipts,
    dispatches,
    ownMaterialRows,
    measured,
    openToDispatchQty,
    idempotencyKey,
    generatedAt: occurredAt,
    correlationId: envelope.metadata.correlation_id ?? null,
  });

  try {
    await insertBillingFeed(
      {
        feed_id: p.feed_id,
        service_order_id: order.service_order_id,
        idempotency_key: idempotencyKey,
        payload: payload as unknown as Record<string, unknown>,
        measured_basis: measured.measured_basis,
        measured_quantity: measured.measured_quantity,
        currency: payload.currency,
        total_value: payload.total_value,
        open_to_dispatch_qty: openToDispatchQty,
        first_sent_at: occurredAt,
        site_id: order.site_id,
        generated_by: p.generated_by,
        source_event_id: eventId,
      },
      client,
    );
  } catch (err: unknown) {
    classifyFeedDuplicate(err, p.feed_id, order.service_order_id, eventId);
  }

  // The stored event carries what THIS process derived, never what the caller asserted.
  envelope.payload['measured_basis'] = measured.measured_basis;
  envelope.payload['measured_quantity'] = measured.measured_quantity;
  envelope.payload['total_value'] = payload.total_value;
  envelope.payload['currency'] = payload.currency;
  envelope.payload['open_to_dispatch_qty'] = openToDispatchQty;
  envelope.payload['idempotency_key'] = idempotencyKey;
}

// ---------------------------------------------------------------------------
// Acknowledgment and the invoiced stamp (AC 4, Task 6)
// ---------------------------------------------------------------------------

export async function applyJobworkBillingFeedAcknowledged(
  envelope: EventEnvelope,
  client: PoolClient,
  _eventId: string,
): Promise<void> {
  if (envelope.event_type !== JOBWORK_BILLING_FEED_ACKNOWLEDGED) return;
  if (!JOBWORK_STREAM_TYPES.has(envelope.stream_type)) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as JobworkBillingFeedAcknowledgedPayload;
  const occurredAt = envelope.metadata.occurred_at ?? new Date().toISOString();

  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [p.service_order_id]);
  const order = await getServiceOrderById(p.service_order_id, client, true);
  if (!order) {
    reject(
      'SERVICE_ORDER_NOT_FOUND',
      'Service order not found',
      { service_order_id: p.service_order_id },
      404,
    );
  }
  const feed = await getBillingFeedById(p.feed_id, client, true);
  // Added 2026-09-06. The payload site is bound to the FEED ROW here, exactly as generation binds it
  // to the order row at lockedOrder(). That binding is what lets the central site gate on
  // POST /api/v1/events (assertPayloadSiteWriteAccess) reach this event at all: the gate ties the
  // payload site to the actor's grants, this ties it to the row, and only the two together tie the
  // ROW to the actor. Before this, the acknowledgment payload carried no site and a writer granted
  // solely at another site acknowledged this feed and stamped the order invoiced.
  if (feed && feed.site_id !== p.site_id) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      'The billing feed belongs to a different site than the posting',
      { feed_id: p.feed_id, feed_site_id: feed.site_id, site_id: p.site_id },
      409,
    );
  }
  if (!feed || feed.service_order_id !== order.service_order_id) {
    reject(
      'NOT_FOUND',
      'No billing feed with this id exists for this service order',
      { feed_id: p.feed_id, service_order_id: p.service_order_id },
      404,
    );
  }
  // Binding decision 17: the coordinator who generated the feed must not be the one who stamps it
  // acknowledged with an invented ERP document number. Compared against the ROW, never the payload.
  const sodViolation = acknowledgmentSodViolation({
    generatedBy: feed.generated_by,
    offcutSettledBy: order.offcut_settled_by ?? null,
    actingUserId: envelope.metadata.actor.user_id,
  });
  if (sodViolation !== null) {
    reject(
      'SOD_VIOLATION',
      sodViolation === 'generator'
        ? 'A billing feed cannot be acknowledged by the actor who generated it'
        : 'A billing feed cannot be acknowledged by the actor who settled the offcut it bills',
      {
        feed_id: feed.feed_id,
        service_order_id: order.service_order_id,
        generated_by: feed.generated_by,
        offcut_settled_by: order.offcut_settled_by ?? null,
        acting_user_id: envelope.metadata.actor.user_id,
        reason: sodViolation,
      },
      409,
    );
  }
  if (feed.status === 'acknowledged') {
    reject(
      'DUPLICATE_EVENT',
      'This billing feed has already been acknowledged',
      {
        feed_id: feed.feed_id,
        acknowledged_at: feed.acknowledged_at,
        acknowledged_ref_ext: feed.acknowledged_ref_ext,
      },
      409,
    );
  }
  const flipped = await markBillingFeedAcknowledged(
    feed.feed_id,
    {
      acknowledged_at: occurredAt,
      acknowledged_by: p.acknowledged_by,
      acknowledged_ref_ext: p.acknowledged_ref_ext,
    },
    client,
  );
  if (!flipped) {
    reject(
      'DUPLICATE_EVENT',
      'This billing feed was acknowledged concurrently',
      { feed_id: feed.feed_id },
      409,
    );
  }
  // Binding decision 9: invoiced is a column pair on the order, orthogonal to its lifecycle.
  await updateServiceOrderFields(
    order.service_order_id,
    { invoiced_at: occurredAt, invoiced_feed_id: feed.feed_id },
    client,
  );
}
