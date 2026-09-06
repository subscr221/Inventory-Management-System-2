import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import type {
  JobworkCreditNoteAcknowledgedPayload,
  JobworkOffcutDisposedPayload,
  JobworkOffcutRevaluedPayload,
} from '../events/schema.js';
import { AppError } from '../middleware/error.js';
import { resolveApprover } from '../api/v1/indents.js';
import { getItemBySku } from '../read/projections/item_master.js';
import { createLot } from '../read/projections/lot_master.js';
import { createDispatchDocument } from '../read/projections/dispatch_document.js';
import { getBillingFeedByOrder } from '../read/projections/job_work_billing_feed.js';
import {
  getRetainedHoldingForUpdate,
  markOffcutHoldingDisposed,
  updateOffcutHoldingValuation,
} from '../read/projections/job_work_offcut_holding.js';
import type { JobWorkOffcutHoldingRow } from '../read/projections/job_work_offcut_holding.js';
import {
  getCreditNoteById,
  insertCreditNote,
  listCreditNotesByHolding,
  markCreditNoteAcknowledged,
} from '../read/projections/job_work_credit_note.js';
import type { JobWorkCreditNoteRow } from '../read/projections/job_work_credit_note.js';
import type { ServiceOrderRow } from '../read/projections/service_order.js';
import { getServiceOrderById } from '../read/projections/service_order.js';
import type { AuditEntryPayload } from '../read/projections/audit_log.js';
import { insertQcQualityHold } from '../read/projections/qc_quality_hold.js';
import { placeQualityHold } from '../read/projections/lot_master.js';
import { applyStockBalanceProjection } from './stock-balance.js';
import { reconcileReturnClocks } from './jobwork-return-clock.js';
import { orderAcceptsBilling } from './jobwork-billing.js';
import { OFFCUT_STOCK_CLASS } from './jobwork-offcut.js';
import {
  CUSTODY_OFFCUT_DISPOSAL,
  alreadyPersisted,
  classifyDuplicate,
  requireInProcessOrder,
  resolveLocation,
} from './custody-ledger.js';
import {
  billableValueOf,
  moneyFromScaled,
  moneyToScaled,
} from '../adapters/erp/job-work-billing-feed.js';

/**
 * Story 9.7 (FR-JW-09/10, FR-JW-12, FR-AC-11): DISPOSAL of retained contractual offcut, its later
 * REVALUATION, and the ERP acknowledgment of the credit notes both raise.
 *
 * Story 9.6 captures offcut into job_work_offcut_holding UNVALUED and deliberately stops there: the
 * offcut's fate is not known when the material is produced, and pricing it then would be a guess.
 * This module is where the fate is recorded, by the finance controller, when it is actually known.
 *
 * LOCK ORDER, verbatim and in this order (the 7.4 rule, and the reason this header states it):
 *   1. advisory lock on the service order, then the order row FOR UPDATE;
 *   2. the holding row FOR UPDATE;
 *   3. stock (the offcut issue through the Symbol door, then the owned receipt on the minted lot);
 *   4. the Section 143 return clocks;
 *   5. the holding row's guarded UPDATE and the credit-note row, LAST.
 * Every gate is re-derived here, inside the transaction: the routes' pre-checks are a convenience
 * for a fast 400 and never the authority, so a direct POST /api/v1/events meets this identical wall
 * (the hold-bypass class, found five separate times across Epics 8 and 9).
 *
 * THE ORDER MAY BE CLOSED (BSD-3). requireInProcessOrder is called with orderAcceptsBilling, which
 * admits `in_process` OR `closed`. The default predicate would make every offcut undisposable the
 * moment its order closed - and the holding ledger exists precisely because the offcut's lifecycle
 * outlives the order's. The custody balance is already zero by then; that is what let the order
 * close in the first place.
 *
 * TWO DISPOSITIONS AND NO MORE (BSD-4). `returned` issues the offcut stock back out under a return
 * challan, renders documents and writes no credit note. `acquired` transfers title: the offcut stock
 * is issued, a NEW owned lot is minted under a QC hold, and a credit note is raised against the
 * order's service invoice. A contractual FREE retention is `acquired` at a rate of exactly zero
 * (BSD-5) - same title transfer, same lot, same hold, no credit note because there is nothing to
 * credit. Onward resale, auction included, is an ordinary sale of stock the processor already owns
 * and is out of scope; this module records what the processor PAYS, never what it later receives.
 *
 * WHY A NEW LOT IS MANDATORY on `acquired`. The laundering bar in stock-balance.ts is lot-ROW based:
 * it refuses an `owned` receipt onto any lot that has ever carried a segregated balance row,
 * regardless of on_hand. The captured offcut lot has one. The mint is therefore not decoration, and
 * the receipt goes through the COMPLIANCE SEAM rather than applyStockReceipt so the bar, the
 * quantity ceiling and the location checks all actually run (the 2026-09-06 fix in jobwork-offcut.ts).
 *
 * DUAL CONTROL INVERTS THE 9.4 ACTING-USER CHECK (BSD-10). In the over-norm-loss chain
 * (custody-ledger.ts) the acting user MUST equal the resolved approver. Here the finance controller
 * posts and the CFO signs, so the acting user must NOT equal the approver. Same shape, opposite
 * comparison - read the comment at that check before "fixing" it as a transcription bug.
 */

const JOBWORK_STREAM_TYPES = new Set(['jobwork']);
export const JOBWORK_OFFCUT_DISPOSED = 'jobwork.offcut_disposed';
export const JOBWORK_OFFCUT_REVALUED = 'jobwork.offcut_revalued';
export const JOBWORK_CREDIT_NOTE_ACKNOWLEDGED = 'jobwork.credit_note_acknowledged';
const OFFCUT_DISPOSAL_EVENT_TYPES = new Set([
  JOBWORK_OFFCUT_DISPOSED,
  JOBWORK_OFFCUT_REVALUED,
  JOBWORK_CREDIT_NOTE_ACKNOWLEDGED,
]);

/**
 * BSD-9: a DEDICATED transaction type, held by `cfo` alone. resolveApprover falls back to the holder
 * of ANY OTHER role banded under the same transaction_type when the matched band's role has no
 * holder, so reusing an existing type - or seeding a second role under this one - would silently
 * resolve the CFO signature to somebody else while every test stayed green. `npm run verify:roles`
 * (src/cli/verify-segregated-roles.ts) reports exactly that hazard as DOA_TYPE_MULTI_ROLE.
 */
export const JOBWORK_OFFCUT_ACQUISITION_TRANSACTION_TYPE = 'jobwork.offcut_acquisition';

/** The 9.1 governed business stream code carried on every job-work movement. */
const JOB_WORK_BUSINESS_STREAM = 'job_work';
const OWNED_STOCK_CLASS = 'owned';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 200;
/** NUMERIC(18,4), non-negative. Zero is legal and means a contractual free retention. */
const MONEY_REGEX = /^\d+(\.\d{1,4})?$/;

const DISPOSAL_FIELDS = new Set([
  'service_order_id',
  'disposal_id',
  'holding_id',
  'site_id',
  'disposition',
  'rate',
  'currency',
  'approved_by',
  'return_challan_number_ext',
  'location_id',
  'posted_by',
]);
/** Server-derived on disposal: refused on input, written back by the applier (the 9.2 idiom). */
export const DISPOSAL_DERIVED_FIELDS = [
  'disposal_value',
  'indicative_rate',
  'credit_note_id',
  'owned_lot_number',
  'clock_reconciled_qty',
] as const;

const REVALUATION_FIELDS = new Set([
  'service_order_id',
  'revaluation_id',
  'holding_id',
  'site_id',
  'rate',
  'currency',
  'approved_by',
  'posted_by',
]);
export const REVALUATION_DERIVED_FIELDS = [
  'delta_value',
  'credit_note_id',
  'supersedes_credit_note_id',
  'disposal_value',
] as const;

const ACKNOWLEDGMENT_FIELDS = new Set([
  'service_order_id',
  'credit_note_id',
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

export type OffcutDisposalRefusal =
  | 'not_retained'
  | 'already_disposed'
  | 'rate_required'
  | 'currency_required'
  | 'rate_refused'
  | 'currency_refused'
  | 'challan_required'
  | 'location_required'
  | 'challan_refused';

/**
 * The whole disposal shape as ONE pure predicate, returning the FIRST failing reason or null. The
 * caller maps `not_retained` / `already_disposed` to OFFCUT_NOT_RETAINED (409) and everything else
 * to INVALID_PARAMS (400).
 */
export function offcutDisposalOpen(
  holding: Pick<JobWorkOffcutHoldingRow, 'status'>,
  input: {
    disposition: 'returned' | 'acquired';
    rate?: string | undefined;
    currency?: string | undefined;
    return_challan_number_ext?: string | undefined;
    location_id?: string | undefined;
  },
): { open: true } | { open: false; reason: OffcutDisposalRefusal } {
  if (holding.status === 'disposed') return { open: false, reason: 'already_disposed' };
  if (holding.status !== 'retained') return { open: false, reason: 'not_retained' };
  if (input.disposition === 'acquired') {
    // A rate of exactly zero is a contractual free retention (BSD-5), so the check is presence,
    // never truthiness: `!input.rate` would refuse "0" and make free retention unpostable.
    if (input.rate === undefined) return { open: false, reason: 'rate_required' };
    if (input.currency === undefined) return { open: false, reason: 'currency_required' };
    if (input.return_challan_number_ext !== undefined) {
      return { open: false, reason: 'challan_refused' };
    }
  } else {
    if (input.rate !== undefined) return { open: false, reason: 'rate_refused' };
    if (input.currency !== undefined) return { open: false, reason: 'currency_refused' };
    if (input.return_challan_number_ext === undefined) {
      return { open: false, reason: 'challan_required' };
    }
  }
  if (input.location_id === undefined) return { open: false, reason: 'location_required' };
  return { open: true };
}

/**
 * AC 5: the signed difference between the new commercial value and the value of the document being
 * superseded. Negative when the rate is revised down; the delta document carries it as-is, because
 * a credit note revised down is a debit against the customer, not a smaller credit.
 */
export function creditNoteDeltaValue(latestValue: string, newValue: string): string {
  return moneyFromScaled(moneyToScaled(newValue) - moneyToScaled(latestValue));
}

/** BSD-5: a rate of exactly zero raises no credit note; there is nothing to credit. */
export function raisesCreditNote(disposition: 'returned' | 'acquired', rate: string): boolean {
  return disposition === 'acquired' && moneyToScaled(rate) > 0n;
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

function assertClosedShape(
  payload: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  derived: readonly string[],
): void {
  for (const field of derived) {
    if (payload[field] !== undefined) {
      reject('INVALID_PARAMS', `${field} is derived by the server and must not be supplied`, {
        field,
      });
    }
  }
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      reject('INVALID_PARAMS', `${key} is not a recognized field on this event`, { field: key });
    }
  }
}

function assertMoney(value: unknown, field: string): void {
  if (typeof value !== 'string' || !MONEY_REGEX.test(value.trim())) {
    reject(
      'INVALID_PARAMS',
      `${field} must be a non-negative NUMERIC string with at most four decimals`,
      { field },
    );
  }
}

function assertText(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT_LENGTH) {
    reject(
      'INVALID_PARAMS',
      `${field} is required and must be at most ${MAX_TEXT_LENGTH} characters`,
      {
        field,
      },
    );
  }
}

export function assertJobworkOffcutDisposalShape(envelope: EventEnvelope): void {
  if (!OFFCUT_DISPOSAL_EVENT_TYPES.has(envelope.event_type)) return;
  if (!JOBWORK_STREAM_TYPES.has(envelope.stream_type)) {
    reject('INVALID_EVENT_ENVELOPE', 'jobwork.* events must ride the jobwork stream', {
      event_type: envelope.event_type,
      stream_type: envelope.stream_type,
    });
  }
  const p = envelope.payload as Record<string, unknown>;
  if (envelope.event_type === JOBWORK_OFFCUT_DISPOSED) {
    assertClosedShape(p, DISPOSAL_FIELDS, DISPOSAL_DERIVED_FIELDS);
    for (const field of ['service_order_id', 'disposal_id', 'holding_id', 'site_id', 'posted_by']) {
      if (!isUuid(p[field])) reject('INVALID_PARAMS', `${field} is required and must be a UUID`);
    }
    if (p['disposition'] !== 'returned' && p['disposition'] !== 'acquired') {
      reject('INVALID_PARAMS', "disposition must be 'returned' or 'acquired'", {
        disposition: p['disposition'] ?? null,
      });
    }
    if (p['rate'] !== undefined) assertMoney(p['rate'], 'rate');
    if (p['currency'] !== undefined) assertText(p['currency'], 'currency');
    if (p['return_challan_number_ext'] !== undefined) {
      assertText(p['return_challan_number_ext'], 'return_challan_number_ext');
    }
    if (p['location_id'] !== undefined && !isUuid(p['location_id'])) {
      reject('INVALID_PARAMS', 'location_id must be a UUID when supplied');
    }
    if (p['approved_by'] !== undefined && !isUuid(p['approved_by'])) {
      reject('INVALID_PARAMS', 'approved_by must be a UUID when supplied');
    }
    return;
  }
  if (envelope.event_type === JOBWORK_OFFCUT_REVALUED) {
    assertClosedShape(p, REVALUATION_FIELDS, REVALUATION_DERIVED_FIELDS);
    for (const field of [
      'service_order_id',
      'revaluation_id',
      'holding_id',
      'site_id',
      'posted_by',
    ]) {
      if (!isUuid(p[field])) reject('INVALID_PARAMS', `${field} is required and must be a UUID`);
    }
    assertMoney(p['rate'], 'rate');
    assertText(p['currency'], 'currency');
    if (p['approved_by'] !== undefined && !isUuid(p['approved_by'])) {
      reject('INVALID_PARAMS', 'approved_by must be a UUID when supplied');
    }
    return;
  }
  assertClosedShape(p, ACKNOWLEDGMENT_FIELDS, []);
  for (const field of ['service_order_id', 'credit_note_id', 'site_id', 'acknowledged_by']) {
    if (!isUuid(p[field])) reject('INVALID_PARAMS', `${field} is required and must be a UUID`);
  }
  assertText(p['acknowledged_ref_ext'], 'acknowledged_ref_ext');
}

// ---------------------------------------------------------------------------
// Shared in-transaction helpers
// ---------------------------------------------------------------------------

/** The holding row under FOR UPDATE, bound to THIS order and site, or a classified refusal. */
async function lockedHolding(
  holdingId: string,
  order: ServiceOrderRow,
  client: PoolClient,
): Promise<JobWorkOffcutHoldingRow> {
  const holding = await getRetainedHoldingForUpdate(holdingId, client);
  if (!holding || holding.service_order_id !== order.service_order_id) {
    reject(
      'NOT_FOUND',
      'No offcut holding row with this id exists for this service order',
      { holding_id: holdingId, service_order_id: order.service_order_id },
      404,
    );
  }
  // The row's own site, not just the order's: the central events-door gate ties the payload site to
  // the actor's grants, the order gate ties it to the order, and this ties it to the ROW.
  if (holding.site_id !== order.site_id) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      'The offcut holding row belongs to a different site than its order',
      { holding_id: holdingId, holding_site_id: holding.site_id, order_site_id: order.site_id },
      409,
    );
  }
  return holding;
}

/**
 * AC 7 (BSD-9, BSD-10): the DOA second signature on an acquisition value.
 *
 * Below every band findMatchingDoaEntry returns no entry and the disposal proceeds unapproved; a
 * claimed approved_by in that case is refused INVALID_PARAMS rather than silently dropped, so the
 * 201 can never echo an approver the ledger did not record (the 9.4 symmetric refusal).
 */
async function resolveAcquisitionApproval(
  value: string,
  claimedApprover: string | undefined,
  actingUserId: string,
  details: Record<string, unknown>,
): Promise<{ approved_by: string | null; doa_entry_id: string | null }> {
  const approval = await resolveApprover(JOBWORK_OFFCUT_ACQUISITION_TRANSACTION_TYPE, value);
  if (!approval.requiresApproval) {
    if (claimedApprover !== undefined) {
      reject(
        'INVALID_PARAMS',
        'This acquisition value is below every governed band and cannot carry an approval claim',
        { ...details, acquisition_value: value },
        400,
      );
    }
    return { approved_by: null, doa_entry_id: null };
  }
  if (approval.approverActorId === null) {
    reject(
      'APPROVAL_UNRESOLVED',
      `No active approver could be resolved for ${JOBWORK_OFFCUT_ACQUISITION_TRANSACTION_TYPE}`,
      { ...details, transaction_type: JOBWORK_OFFCUT_ACQUISITION_TRANSACTION_TYPE },
      409,
    );
  }
  if (claimedApprover !== approval.approverActorId) {
    reject(
      'APPROVAL_REQUIRED',
      'An offcut acquisition in or above the governed band requires the resolved DOA approver',
      {
        ...details,
        acquisition_value: value,
        resolved_approver_user_id: approval.approverActorId,
      },
      403,
    );
  }
  // DUAL CONTROL, and this comparison is INVERTED against the Story 9.4 over-norm-loss chain at
  // custody-ledger.ts, where the acting user must EQUAL the resolved approver. It is not a
  // transcription bug. Here the finance controller names the price and the CFO approves paying it,
  // and the whole point of the second signature is that those are two different people - a
  // finance_controller who also held `cfo` could otherwise sign their own acquisition. The go-live
  // verifier (npm run verify:roles) refuses ROLES_SHARE_HOLDER for the same reason.
  if (actingUserId === approval.approverActorId) {
    reject(
      'APPROVAL_REQUIRED',
      'An offcut acquisition is dual control: the acting user must not be the resolved DOA approver',
      {
        ...details,
        acting_user_id: actingUserId,
        resolved_approver_user_id: approval.approverActorId,
      },
      403,
    );
  }
  return { approved_by: approval.approverActorId, doa_entry_id: approval.doaEntryId };
}

/**
 * Task 4.11: the credit note CITES the service invoice, so there must be one. The order's billing
 * feed must be acknowledged and carry the ERP document reference; a placeholder would be a
 * fabricated citation. The `returned` branch never reaches here.
 */
async function citedInvoiceRef(order: ServiceOrderRow, client: PoolClient): Promise<string> {
  const feed = await getBillingFeedByOrder(order.service_order_id, client);
  if (!feed) {
    reject(
      'CREDIT_NOTE_UNCITABLE',
      'This order has no billing feed, so there is no service invoice to credit',
      { service_order_id: order.service_order_id, reason: 'no_billing_feed' },
      409,
    );
  }
  if (feed.status !== 'acknowledged' || !feed.acknowledged_ref_ext) {
    reject(
      'CREDIT_NOTE_UNCITABLE',
      'The service invoice for this order has not been acknowledged by ERP, so there is no document reference to cite',
      {
        service_order_id: order.service_order_id,
        feed_id: feed.feed_id,
        feed_status: feed.status,
        reason: 'feed_not_acknowledged',
      },
      409,
    );
  }
  return feed.acknowledged_ref_ext;
}

/**
 * Task 4.8 (AC 2, BSD-6): plain-text documents stored through the GENERIC dispatch_document table,
 * keyed by service_order_id (its dispatch_order_id is a bare UUID with no foreign key). The Story
 * 3.7 renderers are deliberately not imported: they hard-query erp_sales_order and packing_record
 * and would silently render "Unknown" for a job-work order instead of failing closed. The four
 * allowed document_type values are not widened - the return challan takes the commercial_invoice
 * slot, exactly as Story 9.4's job-work challan does.
 */
function renderOffcutReturnDocuments(
  order: ServiceOrderRow,
  holding: JobWorkOffcutHoldingRow,
  challanNumberExt: string,
  disposedAt: string,
  disposalId: string,
): { document_type: 'bol' | 'packing_slip' | 'commercial_invoice' | 'label'; content: string }[] {
  const header = [
    `Order            : ${order.order_number_ext}  (${order.service_order_id})`,
    `Disposal         : ${disposalId}`,
    `Customer         : ${order.customer_party_code}  ${order.customer_name}`,
    `Offcut Contract  : ${holding.offcut_contract_ref_ext ?? order.order_number_ext}`,
    `Return Challan   : ${challanNumberExt}`,
    `SKU / Lot        : ${holding.sku} / ${holding.lot_id}`,
    `Source Lot       : ${holding.source_lot_id}`,
    `Returned Qty     : ${holding.quantity} ${holding.uom}`,
    `Returned At      : ${disposedAt}`,
  ].join('\n');
  return [
    {
      document_type: 'bol',
      content: `BILL OF LADING (OFFCUT RETURN)\n${'='.repeat(30)}\n${header}\n`,
    },
    {
      document_type: 'packing_slip',
      content: `PACKING SLIP (OFFCUT RETURN)\n${'='.repeat(30)}\n${header}\n`,
    },
    {
      document_type: 'commercial_invoice',
      content: `OFFCUT RETURN CHALLAN\n${'='.repeat(30)}\n${header}\n`,
    },
    {
      document_type: 'label',
      content: `${holding.sku}\n${holding.lot_id}\n${order.order_number_ext}\n`,
    },
  ];
}

/** Task 4.9: stop the clock for the disposed quantity, on BOTH branches. */
async function stopTheClock(
  order: ServiceOrderRow,
  holding: JobWorkOffcutHoldingRow,
  client: PoolClient,
): Promise<string> {
  // NON-strict, for the reason the 9.5 chunk-2 review settled: clock capacity is challan_qty while
  // the holding quantity derives from the RECEIVED balance, which an over-tolerance receipt may
  // legitimately exceed. A clock-accounting mismatch must never block the physical disposal.
  const result = await reconcileReturnClocks(
    {
      serviceOrderId: order.service_order_id,
      sku: holding.sku,
      quantity: holding.quantity,
      counter: 'reconciled_qty',
      category: 'offcut',
      strict: false,
    },
    client,
  );
  return result.allocated;
}

// ---------------------------------------------------------------------------
// Disposal applier (AC 1, 2, 3, 4, 7)
// ---------------------------------------------------------------------------

export async function applyJobworkOffcutDisposed(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  // Accepted for chain symmetry with every other applier in store.ts. Unused: the disposal's
  // refusals are audited by the route through AUDITED_REJECTIONS, and the QC gate here is a
  // governed hold rather than the audit-carrying QC completion hand-off.
  _auditCtx?: Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>,
): Promise<void> {
  if (envelope.event_type !== JOBWORK_OFFCUT_DISPOSED) return;
  if (!JOBWORK_STREAM_TYPES.has(envelope.stream_type)) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as JobworkOffcutDisposedPayload;
  const occurredAt = envelope.metadata.occurred_at ?? new Date().toISOString();

  // 1. Order advisory lock + FOR UPDATE. `closed` is accepted deliberately (BSD-3).
  const order = await requireInProcessOrder(
    p.service_order_id,
    p.site_id,
    client,
    orderAcceptsBilling,
  );

  // 2. The holding row under FOR UPDATE, then the whole disposal shape as one predicate.
  const holding = await lockedHolding(p.holding_id, order, client);
  const gate = offcutDisposalOpen(holding, {
    disposition: p.disposition,
    rate: p.rate,
    currency: p.currency,
    return_challan_number_ext: p.return_challan_number_ext,
    location_id: p.location_id,
  });
  if (!gate.open) {
    if (gate.reason === 'not_retained' || gate.reason === 'already_disposed') {
      reject(
        'OFFCUT_NOT_RETAINED',
        'This offcut holding row is no longer retained and cannot be disposed of again',
        {
          holding_id: holding.holding_id,
          status: holding.status,
          disposition: holding.disposition,
          disposed_at: holding.disposed_at,
          reason: gate.reason,
        },
        409,
      );
    }
    reject(
      'INVALID_PARAMS',
      `The disposal payload does not match the ${p.disposition} disposition`,
      { holding_id: holding.holding_id, disposition: p.disposition, reason: gate.reason },
      400,
    );
  }

  const location = await resolveLocation(p.location_id as string, client);

  // 3. The DOA second signature comes BEFORE any write (Task 4.7): an above-band acquisition must
  // leave the stock, the lot and the clock untouched when it is refused.
  const rate = p.disposition === 'acquired' ? (p.rate as string) : null;
  const disposalValue = rate === null ? null : billableValueOf(holding.quantity, rate);
  let approval: { approved_by: string | null; doa_entry_id: string | null } = {
    approved_by: null,
    doa_entry_id: null,
  };
  if (p.disposition === 'acquired') {
    approval = await resolveAcquisitionApproval(
      disposalValue as string,
      p.approved_by,
      envelope.metadata.actor.user_id,
      { service_order_id: order.service_order_id, holding_id: holding.holding_id },
    );
  } else if (p.approved_by !== undefined) {
    reject(
      'INVALID_PARAMS',
      'A returned disposal transfers no title and cannot carry an approval claim',
      { holding_id: holding.holding_id, disposition: p.disposition },
      400,
    );
  }

  // 4. Issue the offcut stock through the ONE door that opens the `offcut` class. Both branches
  // move the material out of the segregated class: `returned` physically leaves, and `acquired`
  // stops being the customer's.
  const issueView: EventEnvelope = {
    ...envelope,
    event_id: eventId,
    stream_type: 'inventory',
    event_type: 'stock.issued',
    payload: {
      sku: holding.sku,
      target_location_id: location.location_id,
      lot_id: holding.lot_id,
      quantity: holding.quantity,
      stock_class: OFFCUT_STOCK_CLASS,
      business_stream: JOB_WORK_BUSINESS_STREAM,
    },
  };
  (issueView as unknown as Record<symbol, unknown>)[CUSTODY_OFFCUT_DISPOSAL] = true;
  await applyStockBalanceProjection(issueView, client);

  let ownedLotNumber: string | null = null;
  let creditNoteId: string | null = null;

  if (p.disposition === 'acquired') {
    // 5a. Mint the owned lot. A NEW lot is mandatory: the laundering bar is lot-ROW based and
    // refuses an `owned` receipt on any lot that has ever held an `offcut` row, on_hand or not.
    // The item must exist to carry the lot; the row itself is not needed beyond that check.
    const item = await getItemBySku(holding.sku, client);
    if (!item) {
      reject(
        'ITEM_NOT_FOUND',
        'The offcut sku has no item_master record to hold the acquired lot under',
        { sku: holding.sku },
        409,
      );
    }
    const sequenceResult = await client.query(
      `SELECT COUNT(*)::int AS n FROM job_work_offcut_holding
        WHERE service_order_id = $1 AND owned_lot_id IS NOT NULL`,
      [order.service_order_id],
    );
    const sequence = (sequenceResult.rows[0]!['n'] as number) + 1;
    // The site discriminator keeps two sites running the same external order number from colliding
    // on the GLOBAL uq_lot_master_lot_number (the 9.4 lot-number lesson).
    ownedLotNumber = `${order.order_number_ext}-${order.site_id.slice(0, 8)}-OA${sequence}`;
    let lot;
    try {
      lot = await createLot(
        {
          lot_number: ownedLotNumber,
          sku: holding.sku,
          expiry_date: null,
          quality_hold_status: 'none',
          quality_hold_reason: null,
        },
        client,
      );
    } catch (err: unknown) {
      classifyDuplicate(err, p.disposal_id, eventId);
    }

    // 5b. Ordinary owned stock, through the COMPLIANCE SEAM and never applyStockReceipt directly
    // (the 2026-09-06 fix in jobwork-offcut.ts): the mint means the laundering bar has nothing to
    // catch here, which is exactly why the bar must actually run and say so.
    const receiptView: EventEnvelope = {
      ...envelope,
      event_id: eventId,
      stream_type: 'inventory',
      event_type: 'stock.received',
      payload: {
        sku: holding.sku,
        target_location_id: location.location_id,
        lot_id: ownedLotNumber,
        quantity: holding.quantity,
        stock_class: OWNED_STOCK_CLASS,
        business_stream: JOB_WORK_BUSINESS_STREAM,
      },
    };
    await applyStockBalanceProjection(receiptView, client);

    // 5c. QC hold on the minted lot (AC 3). The material was only ever inspected as the CUSTOMER'S,
    // against the customer's specification; as the processor's own saleable stock it has never been
    // inspected at all, so it must not be dispatchable on the strength of that inspection.
    //
    // DISCLOSED DEVIATION from Task 4.6's literal text, and it is the Story 9.6 BSD-19 finding
    // repeating. receiveQcCompletion is PLAN-BOUND: it refuses INVALID_PAYLOAD without a UUID
    // bom_revision_id, and quality.ts then requires that revision's BOM parent to BE the item being
    // gated. The acquired lot carries the customer's RAW MATERIAL sku, which has no BOM at all - the
    // order's kit revision has the OUTPUT item as its parent - so the hand-off is refused outright
    // (verified by execution, not reasoning). The gate used instead is the Story 8.5 GOVERNED hold,
    // which is what every dispatch, allocation and pick gate in the codebase actually reads
    // (dispatchGateBlockedLots), and which Story 9.6 settled on for this exact material for this
    // exact reason. hold_id is minted FROM the disposal id so a replay reproduces the same row.
    await insertQcQualityHold(
      {
        hold_id: p.disposal_id,
        lot_id: lot!.lot_id,
        lot_number: ownedLotNumber,
        sku: holding.sku,
        site_id: order.site_id,
        hold_reason: `Offcut acquired from customer ${order.customer_party_code} under order ${order.order_number_ext}: inspected only as the customer's material, never against this entity's own specification`,
        defect_code: null,
        placed_by: p.posted_by,
        placed_at: occurredAt,
        source_event_id: eventId,
      },
      client,
    );
    // The ONE enforcement flag (Story 8.5 BSD-1). The lot is minted seconds earlier and can carry no
    // other open hold, so a null return is a programming error rather than a race.
    const flagged = await placeQualityHold(
      ownedLotNumber,
      holding.sku,
      'Acquired offcut awaiting inspection as own stock',
      client,
    );
    if (!flagged) {
      reject(
        'LOT_NOT_FOUND',
        'The minted acquisition lot could not be placed on quality hold',
        { disposal_id: p.disposal_id, lot_number: ownedLotNumber },
        500,
      );
    }
  } else {
    // 5d. `returned`: documents through the generic table, no lot, no credit note, no owned stock.
    for (const doc of renderOffcutReturnDocuments(
      order,
      holding,
      p.return_challan_number_ext as string,
      occurredAt,
      p.disposal_id,
    )) {
      await createDispatchDocument(
        {
          document_id: randomUUID(),
          dispatch_order_id: order.service_order_id,
          document_type: doc.document_type,
          document_content: doc.content,
          generated_by: p.posted_by,
        },
        client,
      );
    }
  }

  // 6. Stop the Section 143 clock for the disposed quantity (AC 1), on BOTH branches.
  const clockReconciled = await stopTheClock(order, holding, client);

  // 7. The credit note (AC 3, AC 4). Zero rate is a contractual free retention: title still
  // transfers and the lot is still minted, but there is nothing to credit (BSD-5). The negotiated
  // rate is accepted as-is with the contract's indicative rate stored beside it - no tolerance is
  // applied and nothing is refused on rate (AC 4, the final 2026-09-05 ruling).
  const indicativeRate = order.offcut_rate ?? null;
  if (rate !== null && raisesCreditNote(p.disposition, rate)) {
    const citedRef = await citedInvoiceRef(order, client);
    creditNoteId = randomUUID();
    try {
      await insertCreditNote(
        {
          credit_note_id: creditNoteId,
          service_order_id: order.service_order_id,
          holding_id: holding.holding_id,
          document_kind: 'original',
          supersedes_credit_note_id: null,
          cited_invoice_ref_ext: citedRef,
          rate,
          indicative_rate: indicativeRate,
          currency: p.currency as string,
          value: disposalValue as string,
          delta_value: null,
          valued_by: p.posted_by,
          site_id: order.site_id,
          source_event_id: eventId,
        },
        client,
      );
    } catch (err: unknown) {
      classifyDuplicate(err, p.disposal_id, eventId);
    }
  }

  // 8. Close the holding row LAST, through the guarded UPDATE. A zero-row result means a concurrent
  // disposal won between the FOR UPDATE read and here; that is a race, never a success.
  const closed = await markOffcutHoldingDisposed(
    {
      holding_id: holding.holding_id,
      disposed_at: occurredAt,
      disposition: p.disposition,
      disposal_event_id: eventId,
      disposed_by: p.posted_by,
      disposal_rate: rate,
      indicative_rate: p.disposition === 'acquired' ? indicativeRate : null,
      disposal_currency: p.disposition === 'acquired' ? (p.currency as string) : null,
      disposal_value: disposalValue,
      approved_by: approval.approved_by,
      doa_entry_id: approval.doa_entry_id,
      return_challan_number_ext: p.return_challan_number_ext ?? null,
      owned_lot_id: ownedLotNumber,
    },
    client,
  );
  if (!closed) {
    reject(
      'DUPLICATE_EVENT',
      'This offcut holding row was disposed of concurrently',
      { holding_id: holding.holding_id },
      409,
    );
  }

  // The stored event carries what THIS process derived, never what the caller asserted.
  envelope.payload['disposal_value'] = disposalValue;
  envelope.payload['indicative_rate'] = p.disposition === 'acquired' ? indicativeRate : null;
  envelope.payload['credit_note_id'] = creditNoteId;
  envelope.payload['owned_lot_number'] = ownedLotNumber;
  envelope.payload['clock_reconciled_qty'] = clockReconciled;
}

// ---------------------------------------------------------------------------
// Revaluation applier (AC 5)
// ---------------------------------------------------------------------------

export async function applyJobworkOffcutRevalued(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (envelope.event_type !== JOBWORK_OFFCUT_REVALUED) return;
  if (!JOBWORK_STREAM_TYPES.has(envelope.stream_type)) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as JobworkOffcutRevaluedPayload;

  const order = await requireInProcessOrder(
    p.service_order_id,
    p.site_id,
    client,
    orderAcceptsBilling,
  );
  const holding = await lockedHolding(p.holding_id, order, client);
  // The sibling condition of OFFCUT_NOT_RETAINED: there is nothing to revalue until a disposal has
  // priced it, and a `returned` disposal transferred no title and never carried a value.
  if (holding.status !== 'disposed' || holding.disposition !== 'acquired') {
    reject(
      'INVALID_PARAMS',
      'Only an acquired offcut disposal can be revalued',
      {
        holding_id: holding.holding_id,
        status: holding.status,
        disposition: holding.disposition,
      },
      400,
    );
  }

  // Task 5.2: a delta supersedes a document, so one must exist. A free retention raised none, which
  // is why revaluing it is refused rather than silently promoted to an original.
  const documents = await listCreditNotesByHolding(holding.holding_id, client, true);
  const latest = documents[documents.length - 1] as JobWorkCreditNoteRow | undefined;
  if (!latest) {
    reject(
      'CREDIT_NOTE_MISSING',
      'This acquisition raised no credit note, so there is no document to supersede',
      { holding_id: holding.holding_id, service_order_id: order.service_order_id },
      409,
    );
  }

  const newValue = billableValueOf(holding.quantity, p.rate);
  // Task 5.5 / open question 5: the band applies to the REVALUED value on the same terms, or a
  // below-band disposal followed by a revaluation would be an unsigned route to any value.
  const approval = await resolveAcquisitionApproval(
    newValue,
    p.approved_by,
    envelope.metadata.actor.user_id,
    { service_order_id: order.service_order_id, holding_id: holding.holding_id },
  );

  // The delta chains off the LATEST document, so a second revaluation supersedes the first delta
  // rather than the original again, and the arithmetic stays a running correction.
  const deltaValue = creditNoteDeltaValue(latest.value, newValue);
  const creditNoteId = randomUUID();
  try {
    await insertCreditNote(
      {
        credit_note_id: creditNoteId,
        service_order_id: order.service_order_id,
        holding_id: holding.holding_id,
        document_kind: 'delta',
        supersedes_credit_note_id: latest.credit_note_id,
        cited_invoice_ref_ext: latest.cited_invoice_ref_ext,
        rate: p.rate,
        indicative_rate: holding.indicative_rate,
        currency: p.currency,
        value: newValue,
        delta_value: deltaValue,
        valued_by: p.posted_by,
        site_id: order.site_id,
        source_event_id: eventId,
      },
      client,
    );
  } catch (err: unknown) {
    classifyDuplicate(err, p.revaluation_id, eventId);
  }

  // The DOCUMENT trail is immutable - neither the original nor any earlier delta is touched - while
  // the holding row carries the CURRENT commercial value. That split is the distinction AC 5 draws:
  // "a delta document is raised and the original is never mutated".
  const revalued = await updateOffcutHoldingValuation(
    holding.holding_id,
    {
      disposal_rate: p.rate,
      disposal_value: newValue,
      approved_by: approval.approved_by,
      doa_entry_id: approval.doa_entry_id,
    },
    client,
  );
  if (!revalued) {
    reject(
      'DUPLICATE_EVENT',
      'This offcut holding row was revalued concurrently',
      { holding_id: holding.holding_id },
      409,
    );
  }

  envelope.payload['delta_value'] = deltaValue;
  envelope.payload['credit_note_id'] = creditNoteId;
  envelope.payload['supersedes_credit_note_id'] = latest.credit_note_id;
  envelope.payload['disposal_value'] = newValue;
}

// ---------------------------------------------------------------------------
// Credit-note acknowledgment applier (AC 6)
// ---------------------------------------------------------------------------

export async function applyJobworkCreditNoteAcknowledged(
  envelope: EventEnvelope,
  client: PoolClient,
  _eventId: string,
): Promise<void> {
  if (envelope.event_type !== JOBWORK_CREDIT_NOTE_ACKNOWLEDGED) return;
  if (!JOBWORK_STREAM_TYPES.has(envelope.stream_type)) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as JobworkCreditNoteAcknowledgedPayload;
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
  const note = await getCreditNoteById(p.credit_note_id, client, true);
  // The payload site is bound to the ROW, exactly as the 9.6 acknowledgment binds it to the feed:
  // the central events-door gate ties the site to the actor's grants, this ties it to the row, and
  // only the two together tie the ROW to the actor.
  if (note && note.site_id !== p.site_id) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      'The credit note belongs to a different site than the posting',
      { credit_note_id: p.credit_note_id, note_site_id: note.site_id, site_id: p.site_id },
      409,
    );
  }
  if (!note || note.service_order_id !== order.service_order_id) {
    reject(
      'NOT_FOUND',
      'No credit note with this id exists for this service order',
      { credit_note_id: p.credit_note_id, service_order_id: p.service_order_id },
      404,
    );
  }

  // AC 6, and this guard is the ENTIRE control over the acquisition rate: the 2026-09-05 ruling
  // removed the tolerance band, so nothing arithmetic constrains what the finance controller writes.
  // What constrains it is that they cannot also sign off the document that bills it. Compared
  // against the ROW's valued_by, never the payload, and against BOTH the claimed acknowledger and
  // the acting user - a forged acknowledged_by must not walk past it. Do not weaken this and do not
  // make it configurable.
  const selfAcknowledged =
    note.valued_by === p.acknowledged_by || note.valued_by === envelope.metadata.actor.user_id;
  if (selfAcknowledged) {
    reject(
      'SOD_VIOLATION',
      'A credit note cannot be acknowledged by the actor who valued the offcut it bills',
      {
        credit_note_id: note.credit_note_id,
        service_order_id: order.service_order_id,
        valued_by: note.valued_by,
        acknowledged_by: p.acknowledged_by,
        acting_user_id: envelope.metadata.actor.user_id,
      },
      403,
    );
  }
  if (note.status === 'acknowledged') {
    reject(
      'DUPLICATE_EVENT',
      'This credit note has already been acknowledged',
      {
        credit_note_id: note.credit_note_id,
        acknowledged_at: note.acknowledged_at,
        acknowledged_ref_ext: note.acknowledged_ref_ext,
      },
      409,
    );
  }
  const flipped = await markCreditNoteAcknowledged(
    note.credit_note_id,
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
      'This credit note was acknowledged concurrently',
      { credit_note_id: note.credit_note_id },
      409,
    );
  }
}
