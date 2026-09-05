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
import type { CustodyLedgerEntryRow } from '../read/projections/custody_ledger_entry.js';
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
 * Generation (AC 4) has TWO preconditions, both BILLING_NOT_READY with details.reason:
 *   (a) at least one job_work_dispatch row - AC4's literal "completed, dispatched";
 *   (b) offcut_settled_at stamped when has_contractual_offcut (Binding decision 15) - one feed per
 *       order plus an offcut-blind precondition would silently lose the retain-and-buy line forever.
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
 * null when billing may proceed. `offcutSettled` is the row's stamp; `dispatchCount` the count of
 * job_work_dispatch rows for the order.
 */
export function billingNotReadyReason(input: {
  status: ServiceOrderRow['status'];
  dispatchCount: number;
  hasContractualOffcut: boolean;
  offcutSettledAt: string | null;
}): 'order_not_started' | 'no_dispatch' | 'offcut_not_settled' | null {
  if (!orderAcceptsBilling(input.status)) return 'order_not_started';
  if (input.dispatchCount < 1) return 'no_dispatch';
  if (input.hasContractualOffcut && input.offcutSettledAt === null) return 'offcut_not_settled';
  return null;
}

/**
 * Binding decision 17: the acknowledging actor must not be the feed's generating actor.
 *
 * Story 9.6 code review 2026-09-05 widened this to the offcut SETTLER. The settling posting is the
 * only place the retain-and-buy rate is named (custody.offcut_recorded carries a caller-supplied
 * offcut_rate_estimate) AND it is the posting that stamps offcut_settled_at, which is the sole
 * billing precondition. Comparing only the generator to the acknowledger left the person who priced
 * the scrap free to sign off the invoice that bills it, so the rate-setter sat outside the SoD chain
 * entirely. All three roles must now be distinct actors.
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
    for (const field of ['feed_id', 'service_order_id', 'acknowledged_by']) {
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
    hasContractualOffcut: order.has_contractual_offcut,
    offcutSettledAt: order.offcut_settled_at,
  });
  if (notReady !== null) {
    reject(
      'BILLING_NOT_READY',
      notReady === 'no_dispatch'
        ? 'A billing feed requires a completed, dispatched order: no job-work dispatch has been recorded'
        : notReady === 'offcut_not_settled'
          ? 'A billing feed on an order with a contractual offcut requires the offcut election to be settled first (post the settling offcut with settles_offcut: true)'
          : `A billing feed requires an order that has started processing; this order is ${order.status}`,
      {
        service_order_id: order.service_order_id,
        reason: notReady,
        status: order.status,
        dispatch_count: dispatches.length,
        has_contractual_offcut: order.has_contractual_offcut,
        offcut_settled_at: order.offcut_settled_at,
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
  const offcutLedgerRows = ledger.filter(
    (r) => r.movement_category === 'offcut' && r.billable === true,
  );
  // The rate and value each offcut event DERIVED live on the stored event payload: custody_ledger_entry
  // is a general custody QUANTITY ledger shared by Stories 9.3 to 9.5, and denormalising money into it
  // for this one caller both pollutes that table and creates a second figure that can disagree with the
  // event after a replay. Reading the derived values back out of the payload is the codebase's own
  // idiom (master-data.ts:344, quality.ts:3077). Story 9.6 code review 2026-09-05: fetched with a
  // single `= ANY($1)` rather than one round trip per offcut row inside the write transaction.
  const offcutPayloads = new Map<string, Record<string, unknown>>();
  if (offcutLedgerRows.length > 0) {
    const stored = await client.query(
      `SELECT event_id, payload FROM domain_events WHERE event_id = ANY($1::uuid[])`,
      [offcutLedgerRows.map((r: CustodyLedgerEntryRow) => r.source_event_id)],
    );
    for (const storedRow of stored.rows) {
      offcutPayloads.set(
        storedRow['event_id'] as string,
        (storedRow['payload'] ?? {}) as Record<string, unknown>,
      );
    }
  }
  const offcutRows = await Promise.all(
    offcutLedgerRows.map(async (row: CustodyLedgerEntryRow) => {
      const payload = offcutPayloads.get(row.source_event_id) ?? {};
      return {
        row,
        offcut_rate:
          typeof payload['effective_offcut_rate'] === 'string'
            ? (payload['effective_offcut_rate'] as string)
            : null,
        contracted_offcut_rate:
          typeof payload['contracted_offcut_rate'] === 'string'
            ? (payload['contracted_offcut_rate'] as string)
            : null,
        billable_value:
          typeof payload['billable_value'] === 'string'
            ? (payload['billable_value'] as string)
            : null,
        converted_lot_number:
          typeof payload['converted_lot_number'] === 'string'
            ? (payload['converted_lot_number'] as string)
            : null,
      };
    }),
  );

  const idempotencyKey = p.idempotency_key ?? envelope.idempotency_key ?? eventId;
  const payload = buildJobWorkBillingFeedPayload({
    feedId: p.feed_id,
    order,
    receipts,
    dispatches,
    ownMaterialRows,
    offcutRows,
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
