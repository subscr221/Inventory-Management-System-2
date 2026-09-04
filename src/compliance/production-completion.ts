import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import type { AuditEntryPayload } from '../read/projections/audit_log.js';
import { AppError } from '../middleware/error.js';
import { config } from '../config/index.js';
import {
  getProductionOrderByIdForUpdate,
  type ProductionOrderRow,
} from '../read/projections/production_order.js';
import { applyStockReceipt } from '../read/projections/stock_balance.js';
import { createLot } from '../read/projections/lot_master.js';
import {
  getCompletedPrimaryQuantity,
  getOutputLotSequence,
  insertProductionCompletion,
} from '../read/projections/production_completion.js';
import { insertScrapDeclaration } from '../read/projections/production_scrap_declaration.js';
import {
  getIssuedWipValue,
  getOpenPostingCount,
  getWipSummary,
  relieveOpenPostings,
  type ProductionWipPostingRow,
} from '../read/projections/production_wip_ledger.js';
import {
  resolveCompletionOutputs,
  resolveCompletionTolerance,
} from '../production/completion-outputs.js';
import { receiveQcCompletion } from '../quality/completion.js';
import { resolveApprover } from '../api/v1/indents.js';
// Table 10 (Reuse Inventory) and Task 5.5: the plant-scope re-check is the 6.2 seam's, exported
// rather than re-created. A second copy was written here originally and a code review on
// 2026-08-31 removed it - two copies of an authorisation check can drift apart.
import { assertActorPlantAccess, assertOrderNotClosed } from './production-material.js';
import { toIstCalendarDate } from '../lib/business-days.js';

/**
 * Story 6.3 compliance seam for production completions, process scrap and the close-short decision
 * (FR-MO-07/08/09). Structurally mirrors src/compliance/production-material.ts verbatim: a stream
 * gate, a PURE pre-transaction shape assert, an in-transaction projection switch, and the same
 * reject() AppError helper, copied rather than re-derived.
 *
 * This seam is the enforcement point, NOT the handler. Every rule below is enforced inside the
 * appliers, so a direct POST /api/v1/events cannot bypass any of them (AD-12). The handler may
 * pre-run the same resolutions to return a cleaner error earlier, but removing a handler check must
 * never change what is possible through the direct-event path.
 *
 * Locking contract: every applier takes the production order row FOR UPDATE FIRST (404
 * PRODUCTION_ORDER_NOT_FOUND when absent), then the new output lots (taken by their own inserts and
 * re-taken by the Story 8.1 applier), then the open WIP postings in a deterministic ordered
 * SELECT ... FOR UPDATE, then stock_balance rows inside the Epic 2 helper, then the Story 8.1 gate
 * rows inside receiveQcCompletion. Taking WIP before the order, or stock before WIP, reintroduces
 * the deadlock the 6.2 fixed lock order exists to prevent.
 *
 * Binding Decision 1: the QC hand-off is DELEGATED to receiveQcCompletion on this same transaction
 * client. This seam creates the lot and posts the finished stock first, because the Story 8.1
 * applier reads both and rejects QC_HOLD_REQUIRED when either is missing or already in sellable
 * use. A hand-off failure therefore rolls back the lot, the stock and the completion row with it,
 * which is what makes AC2 structural rather than a check that could be forgotten.
 *
 * Binding Decision 12: all three events require order status `in_process`. That is deliberately
 * narrower than the 6.2 material gate (released or in_process) and must not be widened silently.
 */

const PRODUCTION_STREAM_TYPES = new Set(['production']);
const PRODUCTION_COMPLETION_EVENT_TYPES = new Set([
  'production_order.completion_posted',
  'production_order.scrap_declared',
  'production_order.short_close_recorded',
]);

/** The DOA transaction type governing an over-completion (AC 5). */
export const OVER_COMPLETION_TRANSACTION_TYPE = 'production_order.over_completion';

/**
 * The DOA transaction type governing a close-short decision (AC 6).
 *
 * Product-owner decision, code review 2026-08-31: a close-short writes off the ENTIRE remaining
 * open WIP balance, which is a larger financial exposure than the over-completion that already
 * carried an approval chain, and AC6 says "the supervisor resolves the short completion". The
 * acting user must BE the resolved approver - there is no separate declared approver field,
 * because the person recording the decision is the person making it.
 */
export const SHORT_CLOSE_TRANSACTION_TYPE = 'production_order.short_close';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Matches the NUMERIC(18,6) ceiling used across the BOM and production modules.
const DECIMAL_REGEX = /^\d{1,12}(\.\d{1,6})?$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
// An explicit UTC offset is REQUIRED (the Story 7.2 offset lesson).
const ISO8601_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_REASON_CODE_LENGTH = 200;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_REGEX.test(value)) return false;
  const [y, m, d] = value.split('-').map((part) => Number(part));
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO8601_TIMESTAMP_REGEX.test(value)) return false;
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m! - 1 || dt.getUTCDate() !== d)
    return false;
  const timeMatch = value.match(/T(\d{2}):(\d{2}):(\d{2})/);
  if (!timeMatch) return false;
  if (Number(timeMatch[1]) > 23 || Number(timeMatch[2]) > 59 || Number(timeMatch[3]) > 59)
    return false;
  // PostgreSQL rejects a time zone displacement outside +/-15:59 with SQLSTATE 22009, which is not
  // mapped; bound the offset here so an out-of-range displacement is a clean 400, not a 500.
  const offsetMatch = value.match(/([+-])(\d{2}):(\d{2})$/);
  if (offsetMatch && (Number(offsetMatch[2]) > 15 || Number(offsetMatch[3]) > 59)) return false;
  return true;
}

function isPositiveDecimal(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_REGEX.test(value) && Number(value) > 0;
}

export function productionCompletionEventType(envelope: EventEnvelope): string | null {
  if (!PRODUCTION_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!PRODUCTION_COMPLETION_EVENT_TYPES.has(envelope.event_type)) return null;
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

export function assertProductionCompletionShape(envelope: EventEnvelope): void {
  const type = productionCompletionEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  if (!isUuid(p['production_order_id'])) {
    reject('INVALID_PAYLOAD', 'production_order_id must be a UUID');
  }
  if (envelope.stream_id !== p['production_order_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must match the payload production_order_id', {
      stream_id: envelope.stream_id,
      payload_production_order_id: p['production_order_id'],
    });
  }

  switch (type) {
    case 'production_order.completion_posted':
      assertCompletionPostedShape(p);
      break;
    case 'production_order.scrap_declared':
      assertScrapDeclaredShape(p);
      break;
    case 'production_order.short_close_recorded':
      assertShortCloseShape(p);
      break;
  }
}

function assertCompletionPostedShape(p: Record<string, unknown>): void {
  if (!isPositiveDecimal(p['primary_quantity'])) {
    reject('INVALID_PAYLOAD', 'primary_quantity is required and must be a positive decimal string');
  }
  if (!isIsoTimestamp(p['completed_at'])) {
    reject('INVALID_PAYLOAD', 'completed_at must be an ISO 8601 timestamp with an explicit offset');
  }
  // null is rejected here rather than falling through to the drift comparison and surfacing as a
  // misleading BOM_REVISION_DRIFT (code review 2026-08-31); business_date already behaved this way.
  if (p['revision_id'] !== undefined && !isUuid(p['revision_id'])) {
    reject('INVALID_PAYLOAD', 'revision_id must be a UUID when present');
  }
  if (p['business_date'] !== undefined && !isIsoDate(p['business_date'])) {
    reject('INVALID_PAYLOAD', 'business_date must be a YYYY-MM-DD calendar date when present');
  }
  if (
    p['over_completion_approved'] !== undefined &&
    typeof p['over_completion_approved'] !== 'boolean'
  ) {
    reject('INVALID_PAYLOAD', 'over_completion_approved must be a boolean when present');
  }
  if (p['approved_by'] !== undefined && p['approved_by'] !== null && !isUuid(p['approved_by'])) {
    reject('INVALID_PAYLOAD', 'approved_by must be a UUID when present');
  }
  // outputs[] and wip_relief[] are server-minted write-back. A declared value is rejected by the
  // applier with PRODUCTION_COMPLETION_DERIVATION_MISMATCH; the assert only proves the shape is an
  // array so a malformed direct event is a clean 400 rather than a 500 downstream.
  for (const field of ['outputs', 'wip_relief']) {
    if (p[field] !== undefined && p[field] !== null && !Array.isArray(p[field])) {
      reject('INVALID_PAYLOAD', `${field} must be an array when present`);
    }
  }
}

function assertReasonCodeShape(p: Record<string, unknown>): void {
  if (typeof p['reason_code'] !== 'string' || p['reason_code'].trim().length === 0) {
    reject('REASON_CODE_REQUIRED', 'reason_code is required and must be non-blank');
  }
  if ((p['reason_code'] as string).length > MAX_REASON_CODE_LENGTH) {
    reject('INVALID_PAYLOAD', `reason_code must be at most ${MAX_REASON_CODE_LENGTH} characters`);
  }
}

function assertScrapDeclaredShape(p: Record<string, unknown>): void {
  if (!isPositiveDecimal(p['scrap_quantity'])) {
    reject('INVALID_PAYLOAD', 'scrap_quantity is required and must be a positive decimal string');
  }
  assertReasonCodeShape(p);
  if (!isIsoTimestamp(p['declared_at'])) {
    reject('INVALID_PAYLOAD', 'declared_at must be an ISO 8601 timestamp with an explicit offset');
  }
  if (p['scrap_id'] !== undefined && p['scrap_id'] !== null && !isUuid(p['scrap_id'])) {
    reject('INVALID_PAYLOAD', 'scrap_id must be a UUID when present');
  }
}

function assertShortCloseShape(p: Record<string, unknown>): void {
  assertReasonCodeShape(p);
  if (p['residual_disposition'] !== 'returned' && p['residual_disposition'] !== 'scrapped') {
    reject('INVALID_PAYLOAD', 'residual_disposition must be either returned or scrapped');
  }
  if (!isIsoTimestamp(p['decided_at'])) {
    reject('INVALID_PAYLOAD', 'decided_at must be an ISO 8601 timestamp with an explicit offset');
  }
}

// ---------------------------------------------------------------------------
// Shared applier helpers
// ---------------------------------------------------------------------------

/**
 * The sibling-seam replay guard (Task 5.1, restored by code review 2026-08-31). A plain SELECT on
 * domain_events, never FOR UPDATE (the Story 4.3 lesson). Without it this seam behaved differently
 * from every other compliance seam on a same-id replay.
 */
async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key?.trim() && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

/** Binding Decision 12: completions, scrap and the close-short decision need a running order. */
async function lockOrderForCompletion(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<ProductionOrderRow> {
  const p = envelope.payload as Record<string, unknown>;
  const productionOrderId = p['production_order_id'] as string;
  const order = await getProductionOrderByIdForUpdate(productionOrderId, client);
  if (!order) {
    reject(
      'PRODUCTION_ORDER_NOT_FOUND',
      'The production order does not resolve',
      { production_order_id: productionOrderId },
      404,
    );
  }
  return order;
}

/**
 * Binding Decision 12, checked ONLY after the caller has been authorised for the order's plant
 * (code review 2026-08-31). Folding this into the lock helper meant an actor with no assignment
 * covering the plant received INVALID_STATE_TRANSITION (400) and learned the order's lifecycle
 * state before LOCATION_ACCESS_DENIED (403) could fire.
 *
 * A short-closed order is terminal to production even though its status is still in_process: the
 * close-short decision has already swept the remaining WIP and fixed completed_quantity, so a
 * later completion would resurrect an order that has been settled (code review 2026-08-31).
 */
function assertOrderAcceptsProduction(order: ProductionOrderRow): void {
  // Story 6.4 (FR-MO-12, AC 4): a closed order answers ORDER_CLOSED, not the generic
  // INVALID_STATE_TRANSITION below. Shared with the material seam, never re-implemented.
  assertOrderNotClosed(order);
  if (order.status !== 'in_process') {
    reject(
      'INVALID_STATE_TRANSITION',
      'Completions, scrap declarations and close-short decisions require the order to be in_process',
      { production_order_id: order.production_order_id, status: order.status },
      400,
    );
  }
  if (order.short_closed_at !== null) {
    reject(
      'INVALID_STATE_TRANSITION',
      'The order carries a close-short decision and accepts no further production',
      {
        production_order_id: order.production_order_id,
        short_closed_at: order.short_closed_at,
        short_close_reason: order.short_close_reason,
      },
      400,
    );
  }
}

/** The Counter Contract (6.2): the order lock is already held, so the recompute is race-free. */
async function recomputeUnreversedCounter(orderId: string, client: PoolClient): Promise<void> {
  const count = await getOpenPostingCount(orderId, client);
  await client.query(
    `UPDATE production_order
        SET unreversed_transaction_count = $2, updated_at = now()
      WHERE production_order_id = $1`,
    [orderId, count],
  );
}

async function numericEquals(client: PoolClient, left: unknown, right: unknown): Promise<boolean> {
  const result = await client.query('SELECT $1::numeric = $2::numeric AS eq', [left, right]);
  return result.rows[0]!['eq'] === true;
}

/** The declared business_date must agree with the IST date derived from the event instant. */
function assertBusinessDate(p: Record<string, unknown>, derived: string): void {
  if (p['business_date'] !== undefined && p['business_date'] !== derived) {
    reject(
      'PRODUCTION_COMPLETION_DERIVATION_MISMATCH',
      'Declared business_date disagrees with the server derivation',
      { declared_business_date: p['business_date'], business_date: derived },
      409,
    );
  }
  p['business_date'] = derived;
}

function assertNotDeclared(p: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    const value = p[field];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    reject(
      'PRODUCTION_COMPLETION_DERIVATION_MISMATCH',
      `${field} is server-derived and must not be declared`,
      { field },
      409,
    );
  }
}

function reliefEntries(postings: ProductionWipPostingRow[]): Record<string, unknown>[] {
  return postings.map((posting) => ({
    posting_id: posting.posting_id,
    source_posting_id: posting.source_posting_id,
    bom_line_id: posting.bom_line_id,
    component_item_id: posting.component_item_id,
    component_sku: posting.component_sku,
    lot_number: posting.lot_number,
    source_location_id: posting.source_location_id,
    quantity: posting.quantity,
    unit_cost: posting.unit_cost,
    posting_value: posting.posting_value,
  }));
}

// ---------------------------------------------------------------------------
// Projection switch
// ---------------------------------------------------------------------------

export async function applyProductionCompletionProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  auditCtx?: Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>,
): Promise<void> {
  const type = productionCompletionEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'production_order.completion_posted':
      await applyCompletionPosted(envelope, client, eventId, auditCtx);
      break;
    case 'production_order.scrap_declared':
      await applyScrapDeclared(envelope, client, eventId);
      break;
    case 'production_order.short_close_recorded':
      await applyShortCloseRecorded(envelope, client, eventId);
      break;
  }
}

async function applyCompletionPosted(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  auditCtx?: Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;
  const p = envelope.payload as Record<string, unknown>;
  const order = await lockOrderForCompletion(envelope, client);
  await assertActorPlantAccess(envelope, order, client);
  assertOrderAcceptsProduction(order);

  assertNotDeclared(p, ['outputs', 'wip_relief', 'relieved_value', 'completed_by']);

  const primaryQuantity = p['primary_quantity'] as string;
  const completedAt = p['completed_at'] as string;
  const businessDate = toIstCalendarDate(new Date(completedAt));
  assertBusinessDate(p, businessDate);

  // AC5: the tolerance bounds the CUMULATIVE primary quantity, never a single event.
  const priorCompleted = await getCompletedPrimaryQuantity(order.production_order_id, client);
  const tolerance = await resolveCompletionTolerance(
    {
      order_quantity: order.order_quantity,
      prior_completed: priorCompleted,
      additional: primaryQuantity,
    },
    client,
  );
  const approvalClaimed = p['over_completion_approved'] === true;
  let approvedBy: string | null = null;
  // Only a completion that actually breaches the ceiling takes the approval path (code review
  // 2026-08-31). Running it on `tolerance.over || approvalClaimed` meant a caller who volunteered
  // a redundant flag on a perfectly ordinary completion had every completion row permanently
  // stamped as an approved over-completion, with the DOA approver named on it.
  if (tolerance.over) {
    if (!approvalClaimed) {
      reject(
        'APPROVAL_REQUIRED',
        'The completion exceeds the ordered quantity plus tolerance and needs supervisor approval',
        {
          production_order_id: order.production_order_id,
          order_quantity: order.order_quantity,
          cumulative_quantity: tolerance.cumulative,
          ceiling: tolerance.ceiling,
          tolerance_percent: tolerance.tolerance_percent,
        },
        403,
      );
    }
    // AC5 re-derived under the transaction (AD-12): the override authority is the DOA registry,
    // never a hard-coded role, and a forged approved_by cannot bypass it. The Story 6.1
    // release-override chain verbatim, including the acting-user check that closes the direct-event
    // forgery.
    const approval = await resolveApprover(OVER_COMPLETION_TRANSACTION_TYPE, 0);
    if (!approval.requiresApproval || approval.approverActorId === null) {
      reject(
        'APPROVAL_UNRESOLVED',
        `No DOA entry governs ${OVER_COMPLETION_TRANSACTION_TYPE}`,
        { transaction_type: OVER_COMPLETION_TRANSACTION_TYPE },
        409,
      );
    }
    if (p['approved_by'] !== approval.approverActorId) {
      reject(
        'APPROVAL_REQUIRED',
        'An over-completion requires the resolved DOA approver',
        {
          production_order_id: order.production_order_id,
          resolved_approver_user_id: approval.approverActorId,
        },
        403,
      );
    }
    if (envelope.metadata.actor.user_id !== approval.approverActorId) {
      reject(
        'APPROVAL_REQUIRED',
        'An over-completion requires the acting user to be the resolved DOA approver',
        {
          production_order_id: order.production_order_id,
          acting_user_id: envelope.metadata.actor.user_id,
          resolved_approver_user_id: approval.approverActorId,
        },
        403,
      );
    }
    approvedBy = approval.approverActorId;
  }
  const overCompletionApproved = tolerance.over && approvalClaimed;
  p['over_completion_approved'] = overCompletionApproved;
  p['approved_by'] = approvedBy;

  // AC3: the co-product and by-product outputs of the PINNED released revision.
  // Resolved on SERVER time, never the envelope's client-controlled completed_at (code review
  // 2026-08-31, the rule src/compliance/production-material.ts already states): a backdated direct
  // event must not select an older effective BOM line set. Backdating used to make a by-product
  // line vanish silently - no lot, no stock, no QC task. business_date still comes from
  // completed_at, because it is the accounting date of the event, not an effectivity selector.
  const outputSet = await resolveCompletionOutputs(
    {
      order,
      primary_quantity: primaryQuantity,
      business_date: toIstCalendarDate(new Date()),
    },
    client,
  );
  if (p['revision_id'] !== undefined && p['revision_id'] !== outputSet.revision_id) {
    reject(
      'BOM_REVISION_DRIFT',
      'Declared revision_id disagrees with the revision the order was released against',
      { declared_revision_id: p['revision_id'], released_revision_id: outputSet.revision_id },
      409,
    );
  }
  p['revision_id'] = outputSet.revision_id;

  // Binding Decision 8, relieved BEFORE any lot, stock or QC-gate row is touched (code review
  // 2026-08-31). The documented Locking Contract is order, WIP, lot, stock, gate; running the
  // relief after the output loop took stock and gate locks before WIP, which is the inversion the
  // contract's own warning names.
  //
  // The prorated share is measured against the value ISSUED to the order, not against what is
  // still open, so relief tracks output linearly instead of decaying geometrically. It is capped
  // at the currently open value, and a completion that reaches the ordered quantity sweeps
  // everything so rounding drift cannot strand a residue for Story 6.4's zero-WIP gate.
  const openBefore = await getWipSummary(order.production_order_id, client);
  const issuedValue = await getIssuedWipValue(order.production_order_id, client);
  const reliefPlan = await client.query(
    `SELECT ($1::numeric >= $2::numeric) AS reached,
            LEAST(
              ($3::numeric * $4::numeric / NULLIF($2::numeric, 0)),
              $5::numeric
            )::numeric(14,3)::text AS target`,
    [
      tolerance.cumulative,
      order.order_quantity,
      issuedValue,
      primaryQuantity,
      openBefore.net_open_value,
    ],
  );
  const reached = reliefPlan.rows[0]!['reached'] === true;
  const target = String(reliefPlan.rows[0]!['target'] ?? '0');
  const relief = await relieveOpenPostings(
    {
      production_order_id: order.production_order_id,
      target: reached ? 'all' : target,
      posting_type: 'completion_relief',
      reason_code: null,
      source_event_id: eventId,
      occurred_at: completedAt,
      mintPostingId: randomUUID,
    },
    client,
  );

  const actorId = envelope.metadata.actor.user_id;
  let sequence = await getOutputLotSequence(order.production_order_id, client);
  const outputs: Record<string, unknown>[] = [];

  const postOutput = async (
    outputClass: 'primary' | 'co_product' | 'by_product',
    bomLineId: string | null,
    itemId: string,
    sku: string,
    quantity: string,
    uom: string,
    specificationRevisionId: string,
  ): Promise<void> => {
    sequence += 1;
    // Binding Decision 5: the lot number is server-minted and immutable. A collision surfaces as
    // the uq_lot_master_lot_number 23505 mapping rather than as a silent second lot.
    const lotNumber = `${order.order_number_ext}-L${sequence}`;
    const lot = await createLot(
      {
        lot_number: lotNumber,
        sku,
        expiry_date: null,
        quality_hold_status: 'none',
        quality_hold_reason: null,
      },
      client,
    );
    // stock_balance.lot_id carries the lot NUMBER (the Epic 2 ledger convention the Story 8.1 gate
    // probe reads); the lot UUID lives on lot_master and on the completion row.
    await applyStockReceipt(
      {
        sku,
        location_id: order.plant_location_id,
        lot_id: lotNumber,
        quantity,
      },
      client,
    );
    const completionId = randomUUID();
    const taskId = randomUUID();
    await insertProductionCompletion(
      {
        completion_id: completionId,
        production_order_id: order.production_order_id,
        output_class: outputClass,
        bom_line_id: bomLineId,
        output_item_id: itemId,
        output_sku: sku,
        lot_id: lot.lot_id,
        lot_number: lotNumber,
        quantity,
        uom,
        qc_task_id: taskId,
        plant_location_id: order.plant_location_id,
        business_date: businessDate,
        over_completion_approved: overCompletionApproved,
        approved_by: approvedBy,
        completed_by: actorId,
        completed_at: completedAt,
        source_event_id: eventId,
      },
      client,
    );
    // Binding Decision 1: the hand-off is delegated. Story 8.1 resolves and freezes the approved
    // plan, creates the inspection task, records the gate as qc_hold and writes its own event and
    // audit entry - all on THIS transaction, so any refusal rolls the lot and stock back too.
    const handoff = await receiveQcCompletion(
      {
        source_completion_type: 'production_order',
        source_completion_id: completionId,
        lot_id: lot.lot_id,
        lot_number: lotNumber,
        item_id: itemId,
        quantity,
        uom,
        site_id: order.plant_location_id,
        bom_revision_id: specificationRevisionId,
        completed_at: completedAt,
        business_stream: order.business_stream,
        source_order_type: null,
        source_order_ref: null,
        actor: {
          user_id: actorId,
          role: envelope.metadata.actor.role,
          location_id: order.plant_location_id,
        },
        task_id: taskId,
      },
      client,
      // FR-AC-13 (code review 2026-08-31): without this the qc.completion_received event minted by
      // every production completion landed in domain_events with no audit row at all.
      auditCtx,
    );
    if (handoff.task.task_id !== taskId) {
      // 500, not QC_HOLD_REQUIRED (code review 2026-08-31): the gate returning a different task
      // than we minted is a server invariant violation, and dressing it as a quality hold made
      // clients retry a condition no retry can clear. Table 8 marks QC_HOLD_REQUIRED delegated.
      reject(
        'QC_TASK_MISSING',
        'The QC gate returned a different inspection task than the completion minted',
        { completion_id: completionId, expected_task_id: taskId, task_id: handoff.task.task_id },
        500,
      );
    }
    outputs.push({
      completion_id: completionId,
      output_class: outputClass,
      bom_line_id: bomLineId,
      output_item_id: itemId,
      output_sku: sku,
      lot_id: lot.lot_id,
      lot_number: lotNumber,
      quantity,
      uom,
      qc_task_id: taskId,
    });
  };

  await postOutput(
    'primary',
    null,
    outputSet.primary.output_item_id,
    outputSet.primary.output_sku,
    outputSet.primary.quantity,
    outputSet.primary.uom,
    outputSet.revision_id,
  );
  for (const secondary of outputSet.secondary) {
    await postOutput(
      secondary.output_class,
      secondary.bom_line_id,
      secondary.output_item_id,
      secondary.output_sku,
      secondary.quantity,
      secondary.uom,
      secondary.bom_revision_id,
    );
  }

  await client.query(
    `UPDATE production_order
        SET completed_quantity = $2::numeric, updated_at = now()
      WHERE production_order_id = $1`,
    [order.production_order_id, tolerance.cumulative],
  );
  await recomputeUnreversedCounter(order.production_order_id, client);

  p['outputs'] = outputs;
  p['wip_relief'] = reliefEntries(relief.postings);
  p['relieved_value'] = relief.relieved_value;
  p['completed_by'] = actorId;
}

async function applyScrapDeclared(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;
  const p = envelope.payload as Record<string, unknown>;
  const order = await lockOrderForCompletion(envelope, client);
  await assertActorPlantAccess(envelope, order, client);
  assertOrderAcceptsProduction(order);

  assertNotDeclared(p, ['wip_relief', 'relieved_value', 'declared_by', 'scrap_id']);

  const scrapQuantity = p['scrap_quantity'] as string;
  const declaredAt = p['declared_at'] as string;
  const businessDate = toIstCalendarDate(new Date(declaredAt));
  assertBusinessDate(p, businessDate);

  const reasonCode = (p['reason_code'] as string).trim();
  if (!config.production.scrapReasonCodes.includes(reasonCode)) {
    reject(
      'SCRAP_REASON_CODE_INVALID',
      'The scrap reason code is not in the configured list',
      { reason_code: reasonCode, allowed: config.production.scrapReasonCodes },
      422,
    );
  }
  p['reason_code'] = reasonCode;

  if (p['uom'] !== undefined && p['uom'] !== order.order_uom) {
    reject(
      'PRODUCTION_COMPLETION_DERIVATION_MISMATCH',
      'Declared uom disagrees with the order uom',
      { declared_uom: p['uom'], uom: order.order_uom },
      409,
    );
  }
  p['uom'] = order.order_uom;

  // AC4: WIP is relieved by the declared scrap VALUE. The scrap is a quantity of the order's own
  // output, valued against open WIP pro rata to the ordered quantity; a declaration whose value
  // would exceed open WIP is rejected, never clamped.
  const summary = await getWipSummary(order.production_order_id, client);
  const issuedValue = await getIssuedWipValue(order.production_order_id, client);
  const valuation = await client.query(
    `SELECT LEAST(
              ($1::numeric * $2::numeric / NULLIF($3::numeric, 0)),
              $4::numeric
            )::numeric(14,3)::text AS scrap_value,
            (($5::numeric + $2::numeric) > $3::numeric) AS exceeds,
            ($4::numeric = 0) AS no_open_value`,
    [
      issuedValue,
      scrapQuantity,
      order.order_quantity,
      summary.net_open_value,
      order.scrapped_quantity,
    ],
  );
  const scrapValue = String(valuation.rows[0]!['scrap_value'] ?? '0');
  // A target that rounds to zero against a non-zero balance (a small scrap on a large order) would
  // write a declaration that relieves nothing at all (code review 2026-08-31).
  if (
    valuation.rows[0]!['no_open_value'] !== true &&
    (await numericEquals(client, scrapValue, '0'))
  ) {
    reject(
      'SCRAP_BELOW_RELIEF_PRECISION',
      'The declared scrap is too small to relieve any WIP value at the ledger precision',
      {
        production_order_id: order.production_order_id,
        scrap_quantity: scrapQuantity,
        order_quantity: order.order_quantity,
        open_wip_value: summary.net_open_value,
      },
      422,
    );
  }
  // Keyed on open QUANTITY, not open value (code review 2026-08-31, second pass): an order whose
  // open postings all carry unit_cost 0 has real open WIP and zero open value, and the earlier
  // value-keyed guard rejected every scrap declaration against it with a message asserting it had
  // no open WIP, which was false.
  if (await numericEquals(client, summary.net_open_quantity, '0')) {
    reject(
      'SCRAP_EXCEEDS_WIP',
      'The order has no open WIP to relieve; a scrap declaration cannot be recorded against it',
      {
        production_order_id: order.production_order_id,
        scrap_quantity: scrapQuantity,
        open_wip_value: summary.net_open_value,
        open_wip_quantity: summary.net_open_quantity,
      },
      409,
    );
  }
  if (valuation.rows[0]!['exceeds'] === true) {
    // Bounded on CUMULATIVE quantity against the ordered quantity (code review 2026-08-31). The
    // previous predicate compared a fraction of open value against open value itself, which
    // reduces algebraically to scrap_quantity > order_quantity and never consulted WIP at all -
    // repeated declarations could drive scrapped_quantity to many multiples of the order.
    reject(
      'SCRAP_EXCEEDS_WIP',
      'The declared scrap would take cumulative scrap beyond the ordered quantity',
      {
        production_order_id: order.production_order_id,
        scrap_quantity: scrapQuantity,
        already_scrapped: order.scrapped_quantity,
        order_quantity: order.order_quantity,
        scrap_value: scrapValue,
        open_wip_value: summary.net_open_value,
      },
      409,
    );
  }

  const relief = await relieveOpenPostings(
    {
      production_order_id: order.production_order_id,
      target: scrapValue,
      posting_type: 'scrap_relief',
      reason_code: reasonCode,
      source_event_id: eventId,
      occurred_at: declaredAt,
      mintPostingId: randomUUID,
    },
    client,
  );

  const scrapId = randomUUID();
  await insertScrapDeclaration(
    {
      scrap_id: scrapId,
      production_order_id: order.production_order_id,
      scrap_quantity: scrapQuantity,
      uom: order.order_uom,
      reason_code: reasonCode,
      relieved_value: relief.relieved_value,
      business_date: businessDate,
      declared_by: envelope.metadata.actor.user_id,
      declared_at: declaredAt,
      source_event_id: eventId,
    },
    client,
  );

  // Written ABSOLUTELY from the declaration rows, exactly as the completion path writes
  // completed_quantity (code review 2026-08-31). The previous `scrapped_quantity + $2` accumulated,
  // so the two aggregates on the same row behaved differently under any re-application of the event
  // and the column could drift away from the table it is meant to summarise.
  await client.query(
    `UPDATE production_order
        SET scrapped_quantity = (
              SELECT COALESCE(SUM(scrap_quantity), 0)
                FROM production_scrap_declaration
               WHERE production_order_id = $1
            ),
            updated_at = now()
      WHERE production_order_id = $1`,
    [order.production_order_id],
  );
  await recomputeUnreversedCounter(order.production_order_id, client);

  p['scrap_id'] = scrapId;
  p['relieved_value'] = relief.relieved_value;
  p['wip_relief'] = reliefEntries(relief.postings);
  p['declared_by'] = envelope.metadata.actor.user_id;
}

async function applyShortCloseRecorded(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;
  const p = envelope.payload as Record<string, unknown>;
  const order = await lockOrderForCompletion(envelope, client);
  await assertActorPlantAccess(envelope, order, client);
  // Story 6.4 (AC 4): ORDER_CLOSED before the generic gate, exactly as in
  // assertOrderAcceptsProduction. This applier keeps its own copy of the status check rather than
  // calling that helper because the close-short decision is the one event that is legitimate on an
  // order already carrying a short_closed_at.
  assertOrderNotClosed(order);
  if (order.status !== 'in_process') {
    reject(
      'INVALID_STATE_TRANSITION',
      'Completions, scrap declarations and close-short decisions require the order to be in_process',
      { production_order_id: order.production_order_id, status: order.status },
      400,
    );
  }

  assertNotDeclared(p, ['wip_relief', 'relieved_value', 'short_closed_by', 'completed_quantity']);

  if (order.short_closed_at !== null) {
    reject(
      'SHORT_CLOSE_EXISTS',
      'The order already carries a close-short decision',
      {
        production_order_id: order.production_order_id,
        short_closed_at: order.short_closed_at,
        short_close_reason: order.short_close_reason,
      },
      409,
    );
  }

  const decidedAt = p['decided_at'] as string;
  const businessDate = toIstCalendarDate(new Date(decidedAt));
  assertBusinessDate(p, businessDate);

  const reasonCode = (p['reason_code'] as string).trim();
  if (!config.production.shortCloseReasonCodes.includes(reasonCode)) {
    reject(
      'SHORT_CLOSE_REASON_CODE_INVALID',
      'The close-short reason code is not in the configured list',
      { reason_code: reasonCode, allowed: config.production.shortCloseReasonCodes },
      422,
    );
  }
  p['reason_code'] = reasonCode;

  // AC6 (product-owner decision, code review 2026-08-31): the close-short decision is a supervisor
  // authority resolved from the DOA registry, never a role constant, and it is re-derived here so
  // a direct POST /api/v1/events cannot bypass it (AD-12).
  const approval = await resolveApprover(SHORT_CLOSE_TRANSACTION_TYPE, 0);
  if (!approval.requiresApproval || approval.approverActorId === null) {
    reject(
      'APPROVAL_UNRESOLVED',
      `No DOA entry governs ${SHORT_CLOSE_TRANSACTION_TYPE}`,
      { transaction_type: SHORT_CLOSE_TRANSACTION_TYPE },
      409,
    );
  }
  if (envelope.metadata.actor.user_id !== approval.approverActorId) {
    reject(
      'APPROVAL_REQUIRED',
      'A close-short decision requires the acting user to be the resolved DOA approver',
      {
        production_order_id: order.production_order_id,
        acting_user_id: envelope.metadata.actor.user_id,
        resolved_approver_user_id: approval.approverActorId,
      },
      403,
    );
  }

  // AC6: the decision only exists for an order BELOW the short floor. An order inside tolerance
  // completes normally and never needs one.
  const completed = await getCompletedPrimaryQuantity(order.production_order_id, client);
  const tolerance = await resolveCompletionTolerance(
    { order_quantity: order.order_quantity, prior_completed: completed, additional: '0' },
    client,
  );
  if (!tolerance.short) {
    reject(
      'SHORT_CLOSE_NOT_APPLICABLE',
      'The order is at or above the short-completion floor and needs no close-short decision',
      {
        production_order_id: order.production_order_id,
        completed_quantity: completed,
        floor: tolerance.floor,
        tolerance_percent: tolerance.tolerance_percent,
      },
      409,
    );
  }

  const relief = await relieveOpenPostings(
    {
      production_order_id: order.production_order_id,
      target: 'all',
      posting_type: 'completion_relief',
      reason_code: null,
      source_event_id: eventId,
      occurred_at: decidedAt,
      mintPostingId: randomUUID,
    },
    client,
  );

  await client.query(
    `UPDATE production_order
        SET short_close_reason = $2, short_closed_at = $3, short_closed_by = $4,
            completed_quantity = $5::numeric, updated_at = now()
      WHERE production_order_id = $1`,
    [order.production_order_id, reasonCode, decidedAt, envelope.metadata.actor.user_id, completed],
  );
  await recomputeUnreversedCounter(order.production_order_id, client);

  const residualWip = await getWipSummary(order.production_order_id, client);
  if (!(await numericEquals(client, residualWip.net_open_quantity, '0'))) {
    // Its own code (code review 2026-08-31): overloading SHORT_CLOSE_NOT_APPLICABLE here left the
    // caller unable to tell "you did not need a short close" from "the server failed to drain WIP".
    reject(
      'SHORT_CLOSE_RESIDUAL_WIP',
      'Residual WIP remains open after the close-short relief pass',
      {
        production_order_id: order.production_order_id,
        net_open_quantity: residualWip.net_open_quantity,
      },
      409,
    );
  }

  p['completed_quantity'] = completed;
  p['relieved_value'] = relief.relieved_value;
  p['wip_relief'] = reliefEntries(relief.postings);
  p['short_closed_by'] = envelope.metadata.actor.user_id;
}
