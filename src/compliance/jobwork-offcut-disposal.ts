import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import type {
  JobworkCreditNoteAcknowledgedPayload,
  JobworkOffcutAcquisitionApprovedPayload,
  JobworkOffcutAcquisitionProposedPayload,
  JobworkOffcutDisposedPayload,
  JobworkOffcutRevaluationApprovedPayload,
  JobworkOffcutRevaluationProposedPayload,
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
  getLatestCreditNoteForHolding,
  insertCreditNote,
  markCreditNoteAcknowledged,
} from '../read/projections/job_work_credit_note.js';
import type { JobWorkCreditNoteRow } from '../read/projections/job_work_credit_note.js';
import {
  getOffcutAcquisitionProposalById,
  getPendingProposalForHolding,
  insertOffcutAcquisitionProposal,
  markOffcutAcquisitionProposalApproved,
  markOffcutRevaluationProposalApproved,
} from '../read/projections/job_work_offcut_acquisition_proposal.js';
import type { ServiceOrderRow } from '../read/projections/service_order.js';
import { getServiceOrderById } from '../read/projections/service_order.js';
import { logRejectionAudit, type AuditEntryPayload } from '../read/projections/audit_log.js';
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
/** Story 9.8: the two-step second signature on an above-band acquisition. */
export const JOBWORK_OFFCUT_ACQUISITION_PROPOSED = 'jobwork.offcut_acquisition_proposed';
export const JOBWORK_OFFCUT_ACQUISITION_APPROVED = 'jobwork.offcut_acquisition_approved';
/** Story 9.9: the same two-step second signature on an above-band REVALUATION. */
export const JOBWORK_OFFCUT_REVALUATION_PROPOSED = 'jobwork.offcut_revaluation_proposed';
export const JOBWORK_OFFCUT_REVALUATION_APPROVED = 'jobwork.offcut_revaluation_approved';
const OFFCUT_DISPOSAL_EVENT_TYPES = new Set([
  JOBWORK_OFFCUT_DISPOSED,
  JOBWORK_OFFCUT_REVALUED,
  JOBWORK_CREDIT_NOTE_ACKNOWLEDGED,
  JOBWORK_OFFCUT_ACQUISITION_PROPOSED,
  JOBWORK_OFFCUT_ACQUISITION_APPROVED,
  JOBWORK_OFFCUT_REVALUATION_PROPOSED,
  JOBWORK_OFFCUT_REVALUATION_APPROVED,
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
const CURRENCY_REGEX = /^[A-Z]{3}$/;
/**
 * NUMERIC(18,4), non-negative. Zero is legal and means a contractual free retention. The integer
 * width is bounded at 14 digits to match the NUMERIC(18,4) money columns that bill the value (the
 * 2026-09-06 service-order rate-bounding precedent); without the bound an oversized rate sails
 * through the scaled arithmetic and dies as an unclassified SQLSTATE 22003 500 on the INSERT.
 */
const MONEY_REGEX = /^\d{1,14}(\.\d{1,4})?$/;

/**
 * Story 9.8, AC 4: `approved_by` is GONE from this set. The Story 9.7 interim let the poster name
 * the approver in their own request body and merely checked the string against resolveApprover's
 * output; there is now no field on a disposal through which any caller can name an approver, on
 * either door. An above-band acquisition is not signed here at all - it is proposed
 * (JOBWORK_OFFCUT_ACQUISITION_PROPOSED) and approved by the CFO's own authenticated action.
 */
const DISPOSAL_FIELDS = new Set([
  'service_order_id',
  'disposal_id',
  'holding_id',
  'site_id',
  'disposition',
  'rate',
  'currency',
  'return_challan_number_ext',
  'location_id',
  'posted_by',
]);

/** Story 9.8: the proposal's caller-supplied shape. No approver field exists (AC 4). */
const PROPOSAL_FIELDS = new Set([
  'service_order_id',
  'proposal_id',
  'holding_id',
  'site_id',
  'rate',
  'currency',
  // Optional and verified against the holding row, never used to move anything: a proposal moves no
  // stock at all. It is accepted so a caller's stated bin is CHECKED rather than ignored.
  'location_id',
  'posted_by',
]);
export const PROPOSAL_DERIVED_FIELDS = [
  'proposed_value',
  'indicative_rate',
  'doa_entry_id',
  'resolved_approver_actor_id',
] as const;

/**
 * Story 9.8: the approval's shape. The caller names the PROPOSAL, never the holding, the rate or an
 * approver - every one of those is read from the frozen proposal row, so an approval cannot be
 * redirected at another holding or repriced on its way through.
 */
const APPROVAL_FIELDS = new Set(['service_order_id', 'proposal_id', 'site_id', 'approved_by']);
export const APPROVAL_DERIVED_FIELDS = [
  'holding_id',
  'disposal_value',
  'indicative_rate',
  'credit_note_id',
  'owned_lot_number',
  'clock_reconciled_qty',
] as const;
/** Server-derived on disposal: refused on input, written back by the applier (the 9.2 idiom). */
export const DISPOSAL_DERIVED_FIELDS = [
  'disposal_value',
  'indicative_rate',
  'credit_note_id',
  'owned_lot_number',
  'clock_reconciled_qty',
] as const;

/**
 * Story 9.9 (AC 3), the same deletion Story 9.8 made on the disposal: `approved_by` is GONE. It was
 * a string the POSTER supplied and the seam merely compared against resolveApprover's output, so
 * the CFO's user id was the entire barrier - and a user id is not a secret. There is now no field
 * on a revaluation through which any caller can name an approver, on either door. An above-band
 * revaluation is not signed here at all: it is proposed (JOBWORK_OFFCUT_REVALUATION_PROPOSED) and
 * approved by the CFO's own authenticated action.
 */
const REVALUATION_FIELDS = new Set([
  'service_order_id',
  'revaluation_id',
  'holding_id',
  'site_id',
  'rate',
  'currency',
  'posted_by',
]);
export const REVALUATION_DERIVED_FIELDS = [
  'delta_value',
  'credit_note_id',
  'supersedes_credit_note_id',
  'disposal_value',
] as const;

/** Story 9.9: the revaluation proposal's caller-supplied shape. No approver field exists (AC 3). */
const REVALUATION_PROPOSAL_FIELDS = new Set([
  'service_order_id',
  'proposal_id',
  'holding_id',
  'site_id',
  'rate',
  'currency',
  'posted_by',
]);
export const REVALUATION_PROPOSAL_DERIVED_FIELDS = [
  'proposed_value',
  'indicative_rate',
  'doa_entry_id',
  'resolved_approver_actor_id',
  'supersedes_credit_note_id',
] as const;

/**
 * Story 9.9: the revaluation approval's shape. The caller names the PROPOSAL, never the holding,
 * the rate, the document being superseded or an approver - every one of those is read from the
 * frozen proposal row.
 */
const REVALUATION_APPROVAL_FIELDS = new Set([
  'service_order_id',
  'proposal_id',
  'site_id',
  'approved_by',
]);
export const REVALUATION_APPROVAL_DERIVED_FIELDS = [
  'holding_id',
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

function isPgCode(err: unknown, code: string): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: string }).code === code
  );
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

/**
 * The refusal codes these three appliers audit THEMSELVES (code review 2026-09-06): a refused
 * statutory decision must leave an audit row on BOTH doors, and the route-level AUDITED_REJECTIONS
 * catch only sees the route door. The three 9.7 routes therefore SKIP these codes in their catch so
 * there is exactly one row per refusal on either door. Codes outside this set (INVALID_PARAMS,
 * NOT_FOUND, ...) are still audited by the route on the route door, exactly as before.
 */
const APPLIER_AUDITED_CODES = new Set([
  'APPROVAL_REQUIRED',
  'APPROVAL_UNRESOLVED',
  'SOD_VIOLATION',
  'OFFCUT_NOT_RETAINED',
  'CREDIT_NOTE_MISSING',
  'CREDIT_NOTE_UNCITABLE',
  'CREDIT_NOTE_SUPERSEDED',
]);

type ApplierAuditCtx = Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;

/**
 * Audit then refuse. Runs through logRejectionAudit (Story 6.4): a fresh connection, so the audit
 * row survives the rollback this throw causes, and it never throws so a clean refusal is never
 * displaced by an audit failure. Used ONLY for the codes above - everything else stays a plain
 * `reject`, audited by the route on the route door as it always was.
 */
async function auditedRefusal(
  auditCtx: ApplierAuditCtx | undefined,
  code: string,
  message: string,
  details: Record<string, unknown>,
  status: number,
): Promise<never> {
  if (auditCtx !== undefined && APPLIER_AUDITED_CODES.has(code)) {
    await logRejectionAudit({
      ...auditCtx,
      event_id: null,
      http_status: status,
      error_code: code,
      details,
    });
  }
  throw new AppError(status, code, message, details);
}

/**
 * 23505 -> DUPLICATE_EVENT via classifyDuplicate; SQLSTATE 22003 (a value that overflowed the
 * NUMERIC(18,4) money columns) -> a clean INVALID_PARAMS 400 rather than a raw 500. The 22003 arm is
 * still reachable with an in-range rate because quantity x rate can exceed 14 integer digits.
 *
 * `columnsLabel` names the table this 22003 actually came from in the error message - code review
 * 2026-09-07: reusing one hardcoded "credit note columns" message for the proposal table's own
 * overflow produced a message naming the wrong table.
 */
function classifyMoneyInsert(
  err: unknown,
  businessId: string,
  eventId: string,
  columnsLabel: string,
): never {
  if (isPgCode(err, '22003')) {
    reject(
      'INVALID_PARAMS',
      `The computed value exceeds the NUMERIC(18,4) range of the ${columnsLabel} columns`,
      { business_id: businessId },
      400,
    );
  }
  return classifyDuplicate(err, businessId, eventId);
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
  | 'location_mismatch'
  | 'challan_refused';

/**
 * The whole disposal shape as ONE pure predicate, returning the FIRST failing reason or null. The
 * caller maps `not_retained` / `already_disposed` to OFFCUT_NOT_RETAINED (409) and everything else
 * to INVALID_PARAMS (400).
 */
export function offcutDisposalOpen(
  holding: Pick<JobWorkOffcutHoldingRow, 'status' | 'location_id'>,
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
    // P10 (code review 2026-09-06): a returned disposal must name the location the material leaves
    // from, which is the holding's own bin. `acquired` never needs a caller location - the stock is
    // where the holding row says it is and the applier uses that.
    if (input.location_id === undefined) return { open: false, reason: 'location_required' };
  }
  // Whether or not the caller supplied a location, it must MATCH the holding row's: the stock
  // physically sits in that bin (no offcut re-location path exists), so a different bin would only
  // surface later as a misleading class-scoped INSUFFICIENT_STOCK after the DOA checks ran.
  if (
    input.location_id !== undefined &&
    holding.location_id !== undefined &&
    input.location_id !== holding.location_id
  ) {
    return { open: false, reason: 'location_mismatch' };
  }
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

/**
 * BSD-5 extended to the COMPUTED value: quantity x rate rounds half-up to the money scale, so a
 * positive rate against a small quantity can still round to "0.0000" - and a zero-value `original`
 * would contradict "nothing to credit" just like a zero rate would, while later poisoning the
 * revaluation gate with a phantom document. The credit note is raised only when the scaled value is
 * non-zero.
 */
export function hasBillableValue(disposalValue: string | null): boolean {
  return disposalValue !== null && moneyToScaled(disposalValue) > 0n;
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

/**
 * The money columns bill ISO 4217 codes only (the service-order offcut_currency precedent). A
 * free-form currency would let a credit note bill a different currency than the invoice it cites
 * and let a delta subtract one currency from another.
 */
function assertCurrency(value: unknown, field: string): void {
  if (typeof value !== 'string' || !CURRENCY_REGEX.test(value)) {
    reject('INVALID_PARAMS', `${field} must be a three-letter ISO 4217 code`, { field });
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
  // The stream binding (the jobwork-billing precedent): an event stored on order A's stream must
  // never mutate order B. Without it the version history and the row it rewrites can diverge.
  if (envelope.stream_id !== p['service_order_id']) {
    reject('INVALID_EVENT_ENVELOPE', 'stream_id must equal service_order_id', {
      stream_id: envelope.stream_id,
      service_order_id: p['service_order_id'],
    });
  }
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
    if (p['currency'] !== undefined) assertCurrency(p['currency'], 'currency');
    if (p['return_challan_number_ext'] !== undefined) {
      assertText(p['return_challan_number_ext'], 'return_challan_number_ext');
      p['return_challan_number_ext'] = (p['return_challan_number_ext'] as string).trim();
    }
    if (p['location_id'] !== undefined && !isUuid(p['location_id'])) {
      reject('INVALID_PARAMS', 'location_id must be a UUID when supplied');
    }
    // The poster named in the payload must BE the authenticated actor (the billing-feed and
    // closure-requested precedents): valued_by, disposed_by and placed_by are all stamped from this
    // field, so a forged posted_by would let one person price an offcut and acknowledge it as two.
    if (p['posted_by'] !== envelope.metadata.actor.user_id) {
      reject(
        'FUNCTION_ACCESS_DENIED',
        'posted_by must be the authenticated actor posting the disposal',
        { posted_by: p['posted_by'], actor_user_id: envelope.metadata.actor.user_id },
        403,
      );
    }
    return;
  }
  if (envelope.event_type === JOBWORK_OFFCUT_ACQUISITION_PROPOSED) {
    assertClosedShape(p, PROPOSAL_FIELDS, PROPOSAL_DERIVED_FIELDS);
    for (const field of ['service_order_id', 'proposal_id', 'holding_id', 'site_id', 'posted_by']) {
      if (!isUuid(p[field])) reject('INVALID_PARAMS', `${field} is required and must be a UUID`);
    }
    assertMoney(p['rate'], 'rate');
    assertCurrency(p['currency'], 'currency');
    if (p['location_id'] !== undefined && !isUuid(p['location_id'])) {
      reject('INVALID_PARAMS', 'location_id must be a UUID when supplied');
    }
    // proposed_by is stamped from this field and the dual-control comparison is made against it, so
    // a forged posted_by would let one person propose an acquisition in another's name.
    if (p['posted_by'] !== envelope.metadata.actor.user_id) {
      reject(
        'FUNCTION_ACCESS_DENIED',
        'posted_by must be the authenticated actor proposing the acquisition',
        { posted_by: p['posted_by'], actor_user_id: envelope.metadata.actor.user_id },
        403,
      );
    }
    return;
  }
  if (envelope.event_type === JOBWORK_OFFCUT_ACQUISITION_APPROVED) {
    assertClosedShape(p, APPROVAL_FIELDS, APPROVAL_DERIVED_FIELDS);
    for (const field of ['service_order_id', 'proposal_id', 'site_id', 'approved_by']) {
      if (!isUuid(p[field])) reject('INVALID_PARAMS', `${field} is required and must be a UUID`);
    }
    // THE POINT OF THIS STORY. The approver is the AUTHENTICATED caller and nothing else: this pins
    // the payload to the session, and the applier then pins the session to the proposal row's frozen
    // resolved_approver_actor_id. A request body can no longer name who signed.
    if (p['approved_by'] !== envelope.metadata.actor.user_id) {
      reject(
        'FUNCTION_ACCESS_DENIED',
        'approved_by must be the authenticated actor approving the acquisition',
        { approved_by: p['approved_by'], actor_user_id: envelope.metadata.actor.user_id },
        403,
      );
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
    assertCurrency(p['currency'], 'currency');
    // Story 9.9 (AC 3): the `approved_by must be a UUID when supplied` branch that used to stand
    // here is DELETED along with the field. assertClosedShape above now refuses the field outright,
    // which is what closes the direct events door as well as the route allow-list.
    if (p['posted_by'] !== envelope.metadata.actor.user_id) {
      reject(
        'FUNCTION_ACCESS_DENIED',
        'posted_by must be the authenticated actor posting the revaluation',
        { posted_by: p['posted_by'], actor_user_id: envelope.metadata.actor.user_id },
        403,
      );
    }
    return;
  }
  if (envelope.event_type === JOBWORK_OFFCUT_REVALUATION_PROPOSED) {
    assertClosedShape(p, REVALUATION_PROPOSAL_FIELDS, REVALUATION_PROPOSAL_DERIVED_FIELDS);
    for (const field of ['service_order_id', 'proposal_id', 'holding_id', 'site_id', 'posted_by']) {
      if (!isUuid(p[field])) reject('INVALID_PARAMS', `${field} is required and must be a UUID`);
    }
    assertMoney(p['rate'], 'rate');
    assertCurrency(p['currency'], 'currency');
    // proposed_by is stamped from this field and the dual-control comparison is made against it, so
    // a forged posted_by would let one person propose a revaluation in another's name.
    if (p['posted_by'] !== envelope.metadata.actor.user_id) {
      reject(
        'FUNCTION_ACCESS_DENIED',
        'posted_by must be the authenticated actor proposing the revaluation',
        { posted_by: p['posted_by'], actor_user_id: envelope.metadata.actor.user_id },
        403,
      );
    }
    return;
  }
  if (envelope.event_type === JOBWORK_OFFCUT_REVALUATION_APPROVED) {
    assertClosedShape(p, REVALUATION_APPROVAL_FIELDS, REVALUATION_APPROVAL_DERIVED_FIELDS);
    for (const field of ['service_order_id', 'proposal_id', 'site_id', 'approved_by']) {
      if (!isUuid(p[field])) reject('INVALID_PARAMS', `${field} is required and must be a UUID`);
    }
    // THE POINT OF STORY 9.9, and identical to the acquisition approval above. The approver is the
    // AUTHENTICATED caller and nothing else: this pins the payload to the session, and the applier
    // then pins the session to the proposal row's frozen resolved_approver_actor_id. A request body
    // can no longer name who signed a revaluation either.
    if (p['approved_by'] !== envelope.metadata.actor.user_id) {
      reject(
        'FUNCTION_ACCESS_DENIED',
        'approved_by must be the authenticated actor approving the revaluation',
        { approved_by: p['approved_by'], actor_user_id: envelope.metadata.actor.user_id },
        403,
      );
    }
    return;
  }
  assertClosedShape(p, ACKNOWLEDGMENT_FIELDS, []);
  for (const field of ['service_order_id', 'credit_note_id', 'site_id', 'acknowledged_by']) {
    if (!isUuid(p[field])) reject('INVALID_PARAMS', `${field} is required and must be a UUID`);
  }
  assertText(p['acknowledged_ref_ext'], 'acknowledged_ref_ext');
  p['acknowledged_ref_ext'] = (p['acknowledged_ref_ext'] as string).trim();
  // The SoD guard on acknowledgment compares against this value, so a forged acknowledged_by would
  // let the valuer walk past it (the 9.6 billing-feed precedent).
  if (p['acknowledged_by'] !== envelope.metadata.actor.user_id) {
    reject(
      'FUNCTION_ACCESS_DENIED',
      'acknowledged_by must be the authenticated actor acknowledging the credit note',
      { acknowledged_by: p['acknowledged_by'], actor_user_id: envelope.metadata.actor.user_id },
      403,
    );
  }
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
 * Story 9.9 (closes deferred-work 9.8-2): `resolveAcquisitionApproval` STOOD HERE and is deleted.
 * It took a `claimedApprover` string off the payload and refused the posting unless it equalled
 * resolveApprover's output - which made the approver's user id the entire barrier to a finance
 * controller signing their own acquisition. Story 9.8 removed its last acquisition call site and
 * Story 9.9 removed the revaluation one, so the parameter, the function and the paragraph that
 * defended it ("the approver's user id is a bearer credential here") are all gone rather than left
 * one line from being reintroduced. A user id is NOT a bearer credential: it appears in audit rows,
 * event payloads, user listings and prior event history, so suppressing it in one refusal message
 * narrowed one leak of a value that leaks everywhere else. Both paths now resolve the BAND only,
 * and the signature is a separate authenticated action on a persisted proposal.
 */

/**
 * Story 9.8: the band lookup for the DISPOSAL path, with no claimed-approver argument because no
 * such field exists any more (AC 4). Below every band the disposal proceeds unsigned in ONE request
 * exactly as Story 9.7 built it (AC 6); in or above a band it is not signable here at all and the
 * caller must propose it instead.
 *
 * resolveApprover raises APPROVAL_UNRESOLVED itself when a band matched but nobody holds the role;
 * the null arm below is the defensive twin of that, audited on both doors.
 */
async function resolveAcquisitionBand(value: string): Promise<{
  requiresApproval: boolean;
  approverActorId: string | null;
  doaEntryId: string | null;
}> {
  return resolveApprover(JOBWORK_OFFCUT_ACQUISITION_TRANSACTION_TYPE, value);
}

/**
 * Story 9.9: resolveAcquisitionBand with the APPROVAL_UNRESOLVED re-routing the Story 9.8 propose
 * applier had inline. resolveApprover (indents.ts) THROWS APPROVAL_UNRESOLVED rather than returning
 * `approverActorId: null` when a band matches but no role holder exists, and left unwrapped that
 * throw skips auditedRefusal entirely - while APPROVAL_UNRESOLVED also sits in the routes'
 * APPLIER_SELF_AUDITED_CODES, so the route skips auditing it too and the refusal lands with no
 * audit_log row on EITHER door. Every band lookup on this path goes through here for that reason.
 */
async function resolveAcquisitionBandAudited(
  value: string,
  details: Record<string, unknown>,
  auditCtx?: ApplierAuditCtx,
): Promise<{ requiresApproval: boolean; approverActorId: string | null; doaEntryId: string | null }> {
  try {
    return await resolveAcquisitionBand(value);
  } catch (err: unknown) {
    if (err instanceof AppError && err.errorCode === 'APPROVAL_UNRESOLVED') {
      return auditedRefusal(
        auditCtx,
        err.errorCode,
        err.message,
        { ...details, ...err.details },
        err.statusCode,
      );
    }
    throw err;
  }
}

/**
 * Story 9.9: the revaluation preconditions that decide whether a revaluation COULD succeed, shared
 * by the single-request below-band path and the proposal path - so a proposal is never raised for a
 * revaluation that would have been refused, and the two cannot drift apart.
 *
 * Task 5.2: a delta supersedes a document, so one must exist. A free retention raised none, which is
 * why revaluing it is refused rather than silently promoted to an original. The latest document is
 * found by the supersede POINTER (the document nothing supersedes), never by created_at order:
 * created_at is the transaction start time, and two overlapping revaluations can invert that order
 * against commit order (chunk B code review 2026-09-06).
 *
 * P6 (code review 2026-09-06): the delta corrects the LATEST document, so it must be priced in that
 * document's currency - otherwise the signed difference subtracts one currency from another and the
 * current-value row mixes units.
 */
async function latestSupersedableCreditNote(
  order: ServiceOrderRow,
  holding: JobWorkOffcutHoldingRow,
  currency: string,
  client: PoolClient,
  auditCtx?: ApplierAuditCtx,
): Promise<JobWorkCreditNoteRow> {
  const latest = await getLatestCreditNoteForHolding(holding.holding_id, client, true);
  if (!latest) {
    return auditedRefusal(
      auditCtx,
      'CREDIT_NOTE_MISSING',
      'This acquisition raised no credit note, so there is no document to supersede',
      { holding_id: holding.holding_id, service_order_id: order.service_order_id },
      409,
    );
  }
  if (currency !== latest.currency) {
    reject(
      'INVALID_PARAMS',
      'The revaluation currency must match the currency of the document it supersedes',
      {
        holding_id: holding.holding_id,
        credit_note_id: latest.credit_note_id,
        currency,
        latest_currency: latest.currency,
      },
      400,
    );
  }
  return latest;
}

/**
 * Story 9.9 Task 4.2: the Story 9.7 AC 5 revaluation effects, extracted so the BELOW-band single
 * request and the APPROVED above-band proposal run the SAME code. Two copies of a delta-credit-note
 * chain would be two places for the arithmetic to drift.
 *
 * The delta chains off the LATEST document, so a second revaluation supersedes the first delta
 * rather than the original again, and the arithmetic stays a running correction.
 *
 * The DOCUMENT trail is immutable - neither the original nor any earlier delta is touched - while
 * the holding row carries the CURRENT commercial value. That split is the distinction AC 5 draws:
 * "a delta document is raised and the original is never mutated". disposal_currency is written too
 * (P6): a revaluation changes the commercial value's currency and the row must not keep advertising
 * the old one.
 */
async function executeOffcutRevaluationDelta(args: {
  client: PoolClient;
  eventId: string;
  /** The id classifyMoneyInsert names in an overflow refusal: the revaluation or the proposal. */
  businessId: string;
  order: ServiceOrderRow;
  holding: JobWorkOffcutHoldingRow;
  latest: JobWorkCreditNoteRow;
  rate: string;
  currency: string;
  newValue: string;
  /** The finance controller who named the rate - the AC 6 SoD comparison is against this column. */
  valuedBy: string;
  approvedBy: string | null;
  doaEntryId: string | null;
}): Promise<{ deltaValue: string; creditNoteId: string; supersedesCreditNoteId: string }> {
  const { client, latest, holding, order } = args;
  const deltaValue = creditNoteDeltaValue(latest.value, args.newValue);
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
        rate: args.rate,
        indicative_rate: holding.indicative_rate,
        currency: args.currency,
        value: args.newValue,
        delta_value: deltaValue,
        valued_by: args.valuedBy,
        site_id: order.site_id,
        source_event_id: args.eventId,
      },
      client,
    );
  } catch (err: unknown) {
    classifyMoneyInsert(err, args.businessId, args.eventId, 'credit note');
  }

  const revalued = await updateOffcutHoldingValuation(
    holding.holding_id,
    {
      disposal_rate: args.rate,
      disposal_currency: args.currency,
      disposal_value: args.newValue,
      approved_by: args.approvedBy,
      doa_entry_id: args.doaEntryId,
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
  return { deltaValue, creditNoteId, supersedesCreditNoteId: latest.credit_note_id };
}

/**
 * Task 4.11: the credit note CITES the service invoice, so there must be one. The order's billing
 * feed must be acknowledged and carry the ERP document reference; a placeholder would be a
 * fabricated citation. The `returned` branch never reaches here.
 */
async function citedInvoiceRef(
  order: ServiceOrderRow,
  client: PoolClient,
  auditCtx?: ApplierAuditCtx,
): Promise<string> {
  const feed = await getBillingFeedByOrder(order.service_order_id, client);
  if (!feed) {
    return auditedRefusal(
      auditCtx,
      'CREDIT_NOTE_UNCITABLE',
      'This order has no billing feed, so there is no service invoice to credit',
      { service_order_id: order.service_order_id, reason: 'no_billing_feed' },
      409,
    );
  }
  if (feed.status !== 'acknowledged' || !feed.acknowledged_ref_ext) {
    return auditedRefusal(
      auditCtx,
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
  // Story 9.7 code review (2026-09-06): the refusal audit used to be the route's job alone, which
  // left every refusal on the direct POST /api/v1/events door with no audit row (AC 7 requires a
  // refused acquisition to be refused AND audited). The applier now writes its own refusal rows
  // through logRejectionAudit (the Story 6.4 helper - a fresh connection, so the row survives the
  // rollback this throw causes). The routes skip the codes this file audits, so there is exactly
  // one row per refusal on either door.
  auditCtx?: Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>,
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

  // Code review 2026-09-07 (Story 9.8 finding): a PENDING acquisition proposal must block every
  // other disposal of this holding, not just a second proposal (the schema's partial unique index
  // already refuses that). Without this, the two-step signature is bypassable by re-submitting an
  // ordinary `returned` disposal, or a repriced-below-band `acquired` one, on the SAME holding while
  // a proposal awaits the CFO - completing with no CFO signature at all and permanently orphaning
  // the pending row (no supersede path exists). Checked AFTER the holding row is locked FOR UPDATE:
  // a concurrent approval also locks this same row (in that order), so Postgres serializes the two
  // paths and this read is never racy.
  const pendingProposal = await getPendingProposalForHolding(holding.holding_id, client);
  if (pendingProposal) {
    await auditedRefusal(
      auditCtx,
      'OFFCUT_NOT_RETAINED',
      'This offcut holding row has a pending acquisition proposal awaiting CFO approval and cannot be disposed of by any other route',
      {
        holding_id: holding.holding_id,
        proposal_id: pendingProposal.proposal_id,
        reason: 'acquisition_proposal_pending',
      },
      409,
    );
  }

  const gate = offcutDisposalOpen(holding, {
    disposition: p.disposition,
    rate: p.rate,
    currency: p.currency,
    return_challan_number_ext: p.return_challan_number_ext,
    location_id: p.location_id,
  });
  if (!gate.open) {
    if (gate.reason === 'not_retained' || gate.reason === 'already_disposed') {
      await auditedRefusal(
        auditCtx,
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

  // P6 (code review 2026-09-06): the credit note bills the order's service invoice, so its currency
  // must be the order's contracted offcut currency when the order carries one. A free-form currency
  // mismatch would let the credit note bill a different currency than the invoice it cites.
  if (
    p.disposition === 'acquired' &&
    order.offcut_currency !== null &&
    order.offcut_currency !== undefined &&
    p.currency !== order.offcut_currency
  ) {
    reject(
      'INVALID_PARAMS',
      "The disposal currency must match the order's contracted offcut currency",
      {
        service_order_id: order.service_order_id,
        holding_id: holding.holding_id,
        currency: p.currency,
        offcut_currency: order.offcut_currency,
      },
      400,
    );
  }

  // 3. The DOA band decision comes BEFORE any write (Task 4.7): an above-band acquisition must
  // leave the stock, the lot and the clock untouched.
  //
  // Story 9.8 (AC 1, AC 4): in or above the band this event CANNOT sign anything. There is no
  // approver field left to claim, and the second signature is a separate authenticated CFO action
  // on a persisted proposal. Refusing here - on the applier, so the direct events door meets the
  // identical wall - is what stops the single-event contract being used to skip it.
  const rate = p.disposition === 'acquired' ? (p.rate as string) : null;
  const disposalValue = rate === null ? null : billableValueOf(holding.quantity, rate);
  if (p.disposition === 'acquired') {
    const band = await resolveAcquisitionBand(disposalValue as string);
    if (band.requiresApproval) {
      await auditedRefusal(
        auditCtx,
        'APPROVAL_REQUIRED',
        'An offcut acquisition in or above the governed band must be proposed and approved by the resolved DOA approver, not posted as a disposal',
        {
          service_order_id: order.service_order_id,
          holding_id: holding.holding_id,
          acquisition_value: disposalValue,
        },
        403,
      );
    }
  }

  const effects = await executeOffcutDisposal({
    envelope,
    eventId,
    client,
    order,
    holding,
    disposition: p.disposition,
    rate,
    currency: p.currency ?? null,
    returnChallanNumberExt: p.return_challan_number_ext ?? null,
    disposalId: p.disposal_id,
    postedBy: p.posted_by,
    occurredAt,
    // Below every band there is no approval to record, and there is no longer any path by which a
    // caller could assert one (AC 4, AC 6).
    approvedBy: null,
    doaEntryId: null,
    auditCtx,
  });

  // The stored event carries what THIS process derived, never what the caller asserted.
  envelope.payload['disposal_value'] = effects.disposalValue;
  envelope.payload['indicative_rate'] = effects.indicativeRate;
  envelope.payload['credit_note_id'] = effects.creditNoteId;
  envelope.payload['owned_lot_number'] = effects.ownedLotNumber;
  envelope.payload['clock_reconciled_qty'] = effects.clockReconciled;
}

// ---------------------------------------------------------------------------
// The disposal EFFECTS themselves (Story 9.7 AC 1, AC 3), shared by two callers since Story 9.8:
// the below-band single-event disposal above, and the CFO approval of an above-band proposal below.
// Everything here runs under the order advisory lock with the holding row already FOR UPDATE, in
// the lock order the module header states.
// ---------------------------------------------------------------------------

interface DisposalExecution {
  envelope: EventEnvelope;
  eventId: string;
  client: PoolClient;
  order: ServiceOrderRow;
  holding: JobWorkOffcutHoldingRow;
  disposition: 'returned' | 'acquired';
  rate: string | null;
  currency: string | null;
  returnChallanNumberExt: string | null;
  /** Also the hold_id of the QC hold on an acquisition, so a replay reproduces the same row. */
  disposalId: string;
  postedBy: string;
  occurredAt: string;
  approvedBy: string | null;
  doaEntryId: string | null;
  auditCtx: ApplierAuditCtx | undefined;
}

interface DisposalEffects {
  disposalValue: string | null;
  indicativeRate: string | null;
  creditNoteId: string | null;
  ownedLotNumber: string | null;
  clockReconciled: string;
}

async function executeOffcutDisposal(a: DisposalExecution): Promise<DisposalEffects> {
  const { envelope, eventId, client, order, holding, auditCtx, occurredAt } = a;
  const p = {
    disposition: a.disposition,
    currency: a.currency ?? undefined,
    return_challan_number_ext: a.returnChallanNumberExt ?? undefined,
    disposal_id: a.disposalId,
    posted_by: a.postedBy,
  };
  const approval = { approved_by: a.approvedBy, doa_entry_id: a.doaEntryId };
  const rate = a.rate;
  const disposalValue = rate === null ? null : billableValueOf(holding.quantity, rate);

  // The stock physically sits where the holding row says it does, and no offcut re-location path
  // exists, so the holding row's location is authoritative for BOTH branches.
  const holdingLocationId = holding.location_id;

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
      target_location_id: holdingLocationId,
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
    // The per-order acquisition counter is derived from the minted lot numbers rather than a raw
    // row count (code review 2026-09-07): MAX over the `-OA{n}` suffix is gap-free and needs no
    // JS arithmetic on a count. Every mint on this order serializes under the order advisory lock,
    // so the value read here is stable for the rest of this transaction. regexp_match rows that
    // carry no suffix (none should) contribute NULL and are ignored by MAX, and the COALESCE
    // keeps an all-NULL result at zero instead of yielding NULL + 1.
    const sequenceResult = await client.query(
      `SELECT COALESCE(MAX((regexp_match(owned_lot_id, '-OA([0-9]+)$'))[1]::bigint), 0) AS n
         FROM job_work_offcut_holding
        WHERE service_order_id = $1 AND owned_lot_id IS NOT NULL`,
      [order.service_order_id],
    );
    const sequence = Number(sequenceResult.rows[0]!['n'] as string) + 1;
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
        target_location_id: holdingLocationId,
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
    try {
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
    } catch (err: unknown) {
      // The PK is hold_id = disposal_id: two DIFFERENT acquired disposals reusing one disposal_id
      // collide here as an unclassified 23505 500 (code review 2026-09-06). Classify it like the
      // createLot and credit-note duplicates above.
      classifyDuplicate(err, p.disposal_id, eventId);
    }
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
  // P9 (code review 2026-09-06): the credit note is raised only when the COMPUTED scaled value is
  // non-zero. quantity x rate rounds half-up to the money scale, so a positive rate against a small
  // quantity can still round to "0.0000" - and a zero-value `original` would contradict BSD-5's
  // "nothing to credit" (free retention is the only no-note case) while poisoning the revaluation
  // chain with a phantom document.
  if (rate !== null && raisesCreditNote(p.disposition, rate) && hasBillableValue(disposalValue)) {
    const citedRef = await citedInvoiceRef(order, client, auditCtx);
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
      classifyMoneyInsert(err, p.disposal_id, eventId, 'credit note');
    }
  }

  // 8. Close the holding row LAST, through the guarded UPDATE. A zero-row result means a concurrent
  // disposal won between the FOR UPDATE read and here; that is a race, never a success. The
  // Section 143 clock reconcile result rides the same row (code review 2026-09-06): clock capacity
  // is challan_qty while the holding quantity may exceed it (over-tolerance), so the reconcile is
  // deliberately non-strict - but a shortfall must be VISIBLE on the ledger row it concerns, not
  // only on an event payload nobody re-reads.
  try {
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
        clock_reconciled_qty: clockReconciled,
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
  } catch (err: unknown) {
    // The ::numeric casts on disposal_rate / disposal_value can still overflow NUMERIC(18,4) when a
    // large holding quantity multiplies an in-range rate - the rate regex bound alone cannot see the
    // product. Classify it rather than surfacing a raw SQLSTATE 22003 500.
    if (isPgCode(err, '22003')) {
      reject(
        'INVALID_PARAMS',
        'The computed disposal value exceeds the NUMERIC(18,4) range of the holding ledger',
        { holding_id: holding.holding_id, disposal_value: disposalValue ?? null },
        400,
      );
    }
    throw err;
  }

  return {
    disposalValue,
    indicativeRate: p.disposition === 'acquired' ? indicativeRate : null,
    creditNoteId,
    ownedLotNumber,
    clockReconciled,
  };
}

// ---------------------------------------------------------------------------
// Story 9.8: the two-step second signature on an above-band acquisition
// ---------------------------------------------------------------------------

/**
 * Story 9.8 AC 1, 4, 5, 8: PROPOSE an above-band acquisition. Nothing physical happens - no stock
 * moves, no lot is minted, no credit note is raised, the holding stays `retained` and the Section
 * 143 clock keeps running. The row this writes is the persisted middle state that the CFO's own
 * authenticated approval later executes.
 *
 * DUAL CONTROL AT PROPOSE TIME (AC 5, BSD-10 inverted). The resolved approver must not be the
 * proposer. Checking it here as well as at approve time is not belt-and-braces: without it a
 * finance controller who also held `cfo` could file a proposal only they could sign, and the
 * schema's chk_..._dual_control would refuse it as an unclassified 23514 500 instead of a clean,
 * audited APPROVAL_REQUIRED.
 */
export async function applyJobworkOffcutAcquisitionProposed(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  auditCtx?: ApplierAuditCtx,
): Promise<void> {
  if (envelope.event_type !== JOBWORK_OFFCUT_ACQUISITION_PROPOSED) return;
  if (!JOBWORK_STREAM_TYPES.has(envelope.stream_type)) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as JobworkOffcutAcquisitionProposedPayload;

  const order = await requireInProcessOrder(
    p.service_order_id,
    p.site_id,
    client,
    orderAcceptsBilling,
  );
  const holding = await lockedHolding(p.holding_id, order, client);
  const gate = offcutDisposalOpen(holding, {
    disposition: 'acquired',
    rate: p.rate,
    currency: p.currency,
    location_id: p.location_id,
  });
  if (!gate.open) {
    if (gate.reason === 'not_retained' || gate.reason === 'already_disposed') {
      await auditedRefusal(
        auditCtx,
        'OFFCUT_NOT_RETAINED',
        'This offcut holding row is no longer retained and cannot be acquired',
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
      'The proposal payload does not match an acquisition',
      { holding_id: holding.holding_id, reason: gate.reason },
      400,
    );
  }

  // P6, carried over from the disposal: the credit note this eventually raises bills the order's
  // service invoice, so its currency must be the order's contracted offcut currency.
  if (
    order.offcut_currency !== null &&
    order.offcut_currency !== undefined &&
    p.currency !== order.offcut_currency
  ) {
    reject(
      'INVALID_PARAMS',
      "The proposed currency must match the order's contracted offcut currency",
      {
        service_order_id: order.service_order_id,
        holding_id: holding.holding_id,
        currency: p.currency,
        offcut_currency: order.offcut_currency,
      },
      400,
    );
  }

  const proposedValue = billableValueOf(holding.quantity, p.rate);
  // Code review 2026-09-07 (Story 9.8 finding), now shared with the Story 9.9 paths as
  // resolveAcquisitionBandAudited: resolveApprover THROWS APPROVAL_UNRESOLVED rather than returning
  // `approverActorId: null`, and left unwrapped that throw would leave the refusal with no audit_log
  // row on EITHER door. See that helper for the whole reasoning.
  const band = await resolveAcquisitionBandAudited(
    proposedValue,
    { service_order_id: order.service_order_id, holding_id: holding.holding_id },
    auditCtx,
  );
  // AC 6 is a hard boundary in BOTH directions: a below-band acquisition has no second signature to
  // capture and must go through the single-request disposal, or a proposal would invent an approval
  // step the governance never asked for and leave the offcut retained until someone signed it.
  if (!band.requiresApproval) {
    reject(
      'INVALID_PARAMS',
      'This acquisition value is below every governed band and must be posted as a disposal, not proposed',
      {
        service_order_id: order.service_order_id,
        holding_id: holding.holding_id,
        acquisition_value: proposedValue,
      },
      400,
    );
  }
  if (band.approverActorId === null) {
    // Unreachable given resolveApprover's throw-not-null contract above; kept as a defensive
    // fallback in case that contract ever changes back.
    await auditedRefusal(
      auditCtx,
      'APPROVAL_UNRESOLVED',
      `No active approver could be resolved for ${JOBWORK_OFFCUT_ACQUISITION_TRANSACTION_TYPE}`,
      {
        service_order_id: order.service_order_id,
        holding_id: holding.holding_id,
        transaction_type: JOBWORK_OFFCUT_ACQUISITION_TRANSACTION_TYPE,
      },
      409,
    );
  }
  // The refusal deliberately does NOT name the resolved approver (the 9.7 chunk-A reasoning, still
  // load-bearing even though there is no claim field left: the id is who the approval route will
  // accept, and a proposer who learns it learns exactly whose session to obtain).
  if (band.approverActorId === p.posted_by) {
    await auditedRefusal(
      auditCtx,
      'APPROVAL_REQUIRED',
      'An offcut acquisition is dual control: the proposer must not be the resolved DOA approver',
      {
        service_order_id: order.service_order_id,
        holding_id: holding.holding_id,
        acting_user_id: p.posted_by,
      },
      403,
    );
  }

  const indicativeRate = order.offcut_rate ?? null;
  try {
    await insertOffcutAcquisitionProposal(
      {
        proposal_id: p.proposal_id,
        service_order_id: order.service_order_id,
        holding_id: holding.holding_id,
        site_id: order.site_id,
        rate: p.rate,
        currency: p.currency,
        indicative_rate: indicativeRate,
        proposed_value: proposedValue,
        doa_entry_id: band.doaEntryId as string,
        resolved_approver_actor_id: band.approverActorId as string,
        proposed_by: p.posted_by,
        source_event_id: eventId,
      },
      client,
    );
  } catch (err: unknown) {
    // AC 4: the partial unique index refuses a SECOND competing proposal on one holding. Classified
    // rather than surfaced as an unclassified 23505 500, and named so the client can tell it apart
    // from a plain replay of its own posting.
    if (
      isPgCode(err, '23505') &&
      String((err as { constraint?: string }).constraint ?? '').includes(
        'uq_job_work_offcut_acq_proposal_pending',
      )
    ) {
      reject(
        'DUPLICATE_EVENT',
        'This offcut holding already has an acquisition proposal awaiting approval',
        { holding_id: holding.holding_id, service_order_id: order.service_order_id },
        409,
      );
    }
    classifyMoneyInsert(err, p.proposal_id, eventId, 'offcut acquisition proposal');
  }

  envelope.payload['proposed_value'] = proposedValue;
  envelope.payload['indicative_rate'] = indicativeRate;
  envelope.payload['doa_entry_id'] = band.doaEntryId;
  envelope.payload['resolved_approver_actor_id'] = band.approverActorId;
}

/**
 * Story 9.8 AC 2, 3, 5: the CFO's own authenticated approval, and the ONLY way an above-band
 * acquisition reaches the Story 9.7 disposal effects.
 *
 * THE IDENTITY IS THE CONTROL. `approved_by` was already pinned to the authenticated actor by the
 * shape validator; here it is compared against the proposal row's FROZEN
 * `resolved_approver_actor_id`. Nothing in any request body chooses who signs, and the resolution is
 * not repeated (the band, the role holder and any delegation could all have moved since - the
 * transfer-request precedent freezes the approver for exactly that reason).
 */
export async function applyJobworkOffcutAcquisitionApproved(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  auditCtx?: ApplierAuditCtx,
): Promise<void> {
  if (envelope.event_type !== JOBWORK_OFFCUT_ACQUISITION_APPROVED) return;
  if (!JOBWORK_STREAM_TYPES.has(envelope.stream_type)) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as JobworkOffcutAcquisitionApprovedPayload;
  const occurredAt = envelope.metadata.occurred_at ?? new Date().toISOString();
  const actingUserId = envelope.metadata.actor.user_id;

  const order = await requireInProcessOrder(
    p.service_order_id,
    p.site_id,
    client,
    orderAcceptsBilling,
  );

  const proposal = await getOffcutAcquisitionProposalById(p.proposal_id, client, true);
  if (!proposal || proposal.service_order_id !== order.service_order_id) {
    reject(
      'NOT_FOUND',
      'No acquisition proposal with this id exists for this service order',
      { proposal_id: p.proposal_id, service_order_id: p.service_order_id },
      404,
    );
  }
  // The payload site is bound to the ROW, exactly as the credit-note acknowledgment binds it: the
  // events door ties the site to the actor's grants and this ties it to the row.
  if (proposal.site_id !== p.site_id) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      'The acquisition proposal belongs to a different site than the approval',
      { proposal_id: proposal.proposal_id, proposal_site_id: proposal.site_id, site_id: p.site_id },
      409,
    );
  }
  // Story 9.9: one table now carries BOTH signatures, so the kind is part of the identity. Without
  // this an acquisition approval aimed at a REVALUATION proposal would run the disposal effects -
  // minting a lot and transferring title - against a holding that was disposed of long ago. It reads
  // as "no acquisition proposal with this id" because from this event's point of view there is none.
  if (proposal.kind !== 'acquisition') {
    reject(
      'NOT_FOUND',
      'No acquisition proposal with this id exists for this service order',
      { proposal_id: proposal.proposal_id, kind: proposal.kind },
      404,
    );
  }
  if (proposal.status !== 'pending') {
    reject(
      'DUPLICATE_EVENT',
      'This acquisition proposal is no longer awaiting approval',
      {
        proposal_id: proposal.proposal_id,
        status: proposal.status,
        decided_at: proposal.decided_at,
      },
      409,
    );
  }

  // AC 3: anyone who is not the resolved approver - the original proposer included - is refused and
  // audited, with no disposal effect. The refusal never names the approver (see the propose-time
  // comment); the caller either is them or has no business knowing who is.
  if (proposal.resolved_approver_actor_id !== actingUserId) {
    await auditedRefusal(
      auditCtx,
      'APPROVAL_REQUIRED',
      'Only the resolved DOA approver may approve this offcut acquisition',
      {
        proposal_id: proposal.proposal_id,
        service_order_id: order.service_order_id,
        acting_user_id: actingUserId,
      },
      403,
    );
  }
  // AC 5, approve-time half of the dual control - STRUCTURALLY UNREACHABLE, not live defense in
  // depth (code review 2026-09-07 correction of the comment that used to claim otherwise). The
  // check immediately above already established actingUserId === proposal.resolved_approver_actor_id;
  // the schema's chk_job_work_offcut_acq_proposal_dual_control CHECK guarantees
  // resolved_approver_actor_id <> proposed_by for every row that can ever exist. Together those make
  // actingUserId === proposal.proposed_by impossible here - role grants moving between the two steps
  // cannot retroactively make two already-frozen columns on a persisted row equal. Kept as a restated
  // invariant for clarity and as a cheap guard against the constraint or the check above ever being
  // weakened independently, not as a currently-reachable branch.
  if (actingUserId === proposal.proposed_by) {
    await auditedRefusal(
      auditCtx,
      'APPROVAL_REQUIRED',
      'An offcut acquisition is dual control: the approver must not be the proposer',
      {
        proposal_id: proposal.proposal_id,
        service_order_id: order.service_order_id,
        acting_user_id: actingUserId,
      },
      403,
    );
  }

  const holding = await lockedHolding(proposal.holding_id, order, client);
  const gate = offcutDisposalOpen(holding, {
    disposition: 'acquired',
    rate: proposal.rate,
    currency: proposal.currency,
  });
  if (!gate.open) {
    await auditedRefusal(
      auditCtx,
      'OFFCUT_NOT_RETAINED',
      'This offcut holding row is no longer retained and cannot be acquired',
      {
        holding_id: holding.holding_id,
        proposal_id: proposal.proposal_id,
        status: holding.status,
        disposition: holding.disposition,
        reason: gate.reason,
      },
      409,
    );
  }

  // Code review 2026-09-07 (Story 9.8 finding): `occurred_at` is caller-suppliable on the direct
  // events door (unlike the REST route, which always stamps server time). A backdated value here
  // would otherwise trip chk_job_work_offcut_acq_proposal_lifecycle's `decided_at >= created_at`
  // as an unclassified Postgres 23514 inside the UPDATE below - checked here instead, before any
  // write, for a clean refusal matching the house convention.
  if (new Date(occurredAt).getTime() < new Date(proposal.created_at).getTime()) {
    reject(
      'INVALID_PARAMS',
      'occurred_at cannot precede the proposal it approves',
      {
        proposal_id: proposal.proposal_id,
        occurred_at: occurredAt,
        proposal_created_at: proposal.created_at,
      },
      400,
    );
  }

  // The Story 9.7 AC 1 / AC 3 effects, unchanged and now driven by the signature rather than by the
  // poster's claim. The proposal id doubles as the disposal id (and so as the QC hold's id), so a
  // replay reproduces the same rows. `disposed_by` stays the finance controller who priced it;
  // `approved_by` is the CFO who signed.
  const effects = await executeOffcutDisposal({
    envelope,
    eventId,
    client,
    order,
    holding,
    disposition: 'acquired',
    rate: proposal.rate,
    currency: proposal.currency,
    returnChallanNumberExt: null,
    disposalId: proposal.proposal_id,
    postedBy: proposal.proposed_by,
    occurredAt,
    approvedBy: actingUserId,
    doaEntryId: proposal.doa_entry_id,
    auditCtx,
  });

  const decided = await markOffcutAcquisitionProposalApproved(
    proposal.proposal_id,
    { decided_at: occurredAt, decided_by: actingUserId, disposal_event_id: eventId },
    client,
  );
  if (!decided) {
    reject(
      'DUPLICATE_EVENT',
      'This acquisition proposal was approved concurrently',
      { proposal_id: proposal.proposal_id },
      409,
    );
  }

  envelope.payload['holding_id'] = holding.holding_id;
  envelope.payload['disposal_value'] = effects.disposalValue;
  envelope.payload['indicative_rate'] = effects.indicativeRate;
  envelope.payload['credit_note_id'] = effects.creditNoteId;
  envelope.payload['owned_lot_number'] = effects.ownedLotNumber;
  envelope.payload['clock_reconciled_qty'] = effects.clockReconciled;
}

// ---------------------------------------------------------------------------
// Revaluation applier (AC 5)
// ---------------------------------------------------------------------------

export async function applyJobworkOffcutRevalued(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  // Story 9.7 code review (2026-09-06): self-audited refusals - see the disposal applier's comment.
  auditCtx?: ApplierAuditCtx,
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

  const latest = await latestSupersedableCreditNote(
    order,
    holding,
    p.currency,
    client,
    auditCtx,
  );
  const newValue = billableValueOf(holding.quantity, p.rate);

  // Task 5.5 / open question 5: the band applies to the REVALUED value on the same terms, or a
  // below-band disposal followed by a revaluation would be an unsigned route to any value.
  //
  // Story 9.9 (AC 1, AC 3, AC 4): in or above the band this event CANNOT sign anything. There is no
  // approver field left to claim, and the second signature is a separate authenticated CFO action on
  // a persisted proposal. Refusing here - on the APPLIER, so the direct events door meets the
  // identical wall - is what stops the single-event contract being used to skip it. Below every
  // band the revaluation completes in ONE request exactly as Story 9.7 built it (AC 4).
  const band = await resolveAcquisitionBandAudited(
    newValue,
    { service_order_id: order.service_order_id, holding_id: holding.holding_id },
    auditCtx,
  );
  if (band.requiresApproval) {
    await auditedRefusal(
      auditCtx,
      'APPROVAL_REQUIRED',
      'An offcut revaluation in or above the governed band must be proposed and approved by the resolved DOA approver, not posted as a revaluation',
      {
        service_order_id: order.service_order_id,
        holding_id: holding.holding_id,
        revalued_value: newValue,
      },
      403,
    );
  }

  const effects = await executeOffcutRevaluationDelta({
    client,
    eventId,
    businessId: p.revaluation_id,
    order,
    holding,
    latest,
    rate: p.rate,
    currency: p.currency,
    newValue,
    valuedBy: p.posted_by,
    // Below every band there is no approval to record, and there is no longer any path by which a
    // caller could assert one (AC 3, AC 4).
    approvedBy: null,
    doaEntryId: null,
  });

  envelope.payload['delta_value'] = effects.deltaValue;
  envelope.payload['credit_note_id'] = effects.creditNoteId;
  envelope.payload['supersedes_credit_note_id'] = effects.supersedesCreditNoteId;
  envelope.payload['disposal_value'] = newValue;
}

// ---------------------------------------------------------------------------
// Story 9.9: the two-step second signature on an above-band revaluation
// ---------------------------------------------------------------------------

/**
 * Story 9.9 AC 1: PROPOSE an above-band revaluation. Nothing happens - no delta credit note is
 * raised, the holding keeps its current value and the Section 143 clock is untouched. The row this
 * writes is the persisted middle state that the CFO's own authenticated approval later executes.
 *
 * It runs EVERY precondition the revaluation applier runs before writing the proposal, so a proposal
 * is never raised for a revaluation that could not have succeeded, and it freezes the two things
 * that can move before the signature arrives: the resolved approver (the band, the role holder and
 * any delegation can all shift) and the document the delta will supersede (a BELOW-band revaluation
 * needs no signature and can land in between - AC 5).
 *
 * DUAL CONTROL AT PROPOSE TIME (BSD-10 inverted). The resolved approver must not be the proposer.
 * Checking it here as well as at approve time is not belt-and-braces: without it a finance
 * controller who also held `cfo` could file a proposal only they could sign, and the schema's
 * chk_..._dual_control would refuse it as an unclassified 23514 500 instead of a clean, audited
 * APPROVAL_REQUIRED.
 */
export async function applyJobworkOffcutRevaluationProposed(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  auditCtx?: ApplierAuditCtx,
): Promise<void> {
  if (envelope.event_type !== JOBWORK_OFFCUT_REVALUATION_PROPOSED) return;
  if (!JOBWORK_STREAM_TYPES.has(envelope.stream_type)) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as JobworkOffcutRevaluationProposedPayload;

  const order = await requireInProcessOrder(
    p.service_order_id,
    p.site_id,
    client,
    orderAcceptsBilling,
  );
  const holding = await lockedHolding(p.holding_id, order, client);
  // The sibling condition of OFFCUT_NOT_RETAINED, identical to the revaluation applier: there is
  // nothing to revalue until a disposal has priced it, and a `returned` disposal transferred no
  // title and never carried a value.
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
  const latest = await latestSupersedableCreditNote(order, holding, p.currency, client, auditCtx);

  const proposedValue = billableValueOf(holding.quantity, p.rate);
  const band = await resolveAcquisitionBandAudited(
    proposedValue,
    { service_order_id: order.service_order_id, holding_id: holding.holding_id },
    auditCtx,
  );
  // A hard boundary in BOTH directions (the Story 9.8 symmetry, copied exactly): a below-band
  // revaluation has no second signature to capture and must go through the single-request route, or
  // a proposal would invent an approval step the governance never asked for and leave the holding
  // carrying a stale value until someone signed it. Re-derived HERE, under the order advisory lock,
  // so the direct events door cannot pick the wrong event type to slip past the signature either
  // way.
  if (!band.requiresApproval) {
    reject(
      'INVALID_PARAMS',
      'This revalued value is below every governed band and must be posted as a revaluation, not proposed',
      {
        service_order_id: order.service_order_id,
        holding_id: holding.holding_id,
        revalued_value: proposedValue,
      },
      400,
    );
  }
  if (band.approverActorId === null) {
    // Unreachable given resolveApprover's throw-not-null contract (see
    // resolveAcquisitionBandAudited); kept as a defensive fallback in case it ever changes back.
    await auditedRefusal(
      auditCtx,
      'APPROVAL_UNRESOLVED',
      `No active approver could be resolved for ${JOBWORK_OFFCUT_ACQUISITION_TRANSACTION_TYPE}`,
      {
        service_order_id: order.service_order_id,
        holding_id: holding.holding_id,
        transaction_type: JOBWORK_OFFCUT_ACQUISITION_TRANSACTION_TYPE,
      },
      409,
    );
  }
  // The refusal deliberately does NOT name the resolved approver: the id is who the approval route
  // will accept, and a proposer who learns it learns exactly whose session to obtain.
  if (band.approverActorId === p.posted_by) {
    await auditedRefusal(
      auditCtx,
      'APPROVAL_REQUIRED',
      'An offcut revaluation is dual control: the proposer must not be the resolved DOA approver',
      {
        service_order_id: order.service_order_id,
        holding_id: holding.holding_id,
        acting_user_id: p.posted_by,
      },
      403,
    );
  }

  const indicativeRate = holding.indicative_rate ?? null;
  try {
    await insertOffcutAcquisitionProposal(
      {
        proposal_id: p.proposal_id,
        service_order_id: order.service_order_id,
        holding_id: holding.holding_id,
        site_id: order.site_id,
        rate: p.rate,
        currency: p.currency,
        indicative_rate: indicativeRate,
        proposed_value: proposedValue,
        doa_entry_id: band.doaEntryId as string,
        resolved_approver_actor_id: band.approverActorId as string,
        proposed_by: p.posted_by,
        source_event_id: eventId,
        kind: 'revaluation',
        // AC 5: the document this was priced against, frozen. Re-deriving it at approve time would
        // let an intervening below-band revaluation move it silently.
        supersedes_credit_note_id: latest.credit_note_id,
      },
      client,
    );
  } catch (err: unknown) {
    // The partial unique index refuses a SECOND competing proposal on one holding, across BOTH
    // kinds. Classified rather than surfaced as an unclassified 23505 500.
    if (
      isPgCode(err, '23505') &&
      String((err as { constraint?: string }).constraint ?? '').includes(
        'uq_job_work_offcut_acq_proposal_pending',
      )
    ) {
      reject(
        'DUPLICATE_EVENT',
        'This offcut holding already has a proposal awaiting approval',
        { holding_id: holding.holding_id, service_order_id: order.service_order_id },
        409,
      );
    }
    classifyMoneyInsert(err, p.proposal_id, eventId, 'offcut revaluation proposal');
  }

  envelope.payload['proposed_value'] = proposedValue;
  envelope.payload['indicative_rate'] = indicativeRate;
  envelope.payload['doa_entry_id'] = band.doaEntryId;
  envelope.payload['resolved_approver_actor_id'] = band.approverActorId;
  envelope.payload['supersedes_credit_note_id'] = latest.credit_note_id;
}

/**
 * Story 9.9 AC 2, 3, 5: the CFO's own authenticated approval, and the ONLY way an above-band
 * revaluation reaches the Story 9.7 AC 5 effects.
 *
 * THE IDENTITY IS THE CONTROL. `approved_by` was already pinned to the authenticated actor by the
 * shape validator; here it is compared against the proposal row's FROZEN
 * `resolved_approver_actor_id`. Nothing in any request body chooses who signs, and the resolution is
 * NEVER repeated - the band, the role holder and any delegation could all have moved since.
 */
export async function applyJobworkOffcutRevaluationApproved(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  auditCtx?: ApplierAuditCtx,
): Promise<void> {
  if (envelope.event_type !== JOBWORK_OFFCUT_REVALUATION_APPROVED) return;
  if (!JOBWORK_STREAM_TYPES.has(envelope.stream_type)) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as unknown as JobworkOffcutRevaluationApprovedPayload;
  const occurredAt = envelope.metadata.occurred_at ?? new Date().toISOString();
  const actingUserId = envelope.metadata.actor.user_id;

  const order = await requireInProcessOrder(
    p.service_order_id,
    p.site_id,
    client,
    orderAcceptsBilling,
  );

  const proposal = await getOffcutAcquisitionProposalById(p.proposal_id, client, true);
  if (!proposal || proposal.service_order_id !== order.service_order_id) {
    reject(
      'NOT_FOUND',
      'No revaluation proposal with this id exists for this service order',
      { proposal_id: p.proposal_id, service_order_id: p.service_order_id },
      404,
    );
  }
  // The payload site is bound to the ROW, exactly as the acquisition approval binds it.
  if (proposal.site_id !== p.site_id) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      'The revaluation proposal belongs to a different site than the approval',
      { proposal_id: proposal.proposal_id, proposal_site_id: proposal.site_id, site_id: p.site_id },
      409,
    );
  }
  // The kind is part of the identity now that one table carries both signatures: this event must
  // never execute an ACQUISITION proposal, whose approval mints a lot and transfers title.
  if (proposal.kind !== 'revaluation') {
    reject(
      'NOT_FOUND',
      'No revaluation proposal with this id exists for this service order',
      { proposal_id: proposal.proposal_id, kind: proposal.kind },
      404,
    );
  }
  if (proposal.status !== 'pending') {
    reject(
      'DUPLICATE_EVENT',
      'This revaluation proposal is no longer awaiting approval',
      {
        proposal_id: proposal.proposal_id,
        status: proposal.status,
        decided_at: proposal.decided_at,
      },
      409,
    );
  }

  // AC 3: anyone who is not the resolved approver - the original proposer included - is refused and
  // audited, with no revaluation effect. The refusal never names the approver (see the propose-time
  // comment); the caller either is them or has no business knowing who is.
  if (proposal.resolved_approver_actor_id !== actingUserId) {
    await auditedRefusal(
      auditCtx,
      'APPROVAL_REQUIRED',
      'Only the resolved DOA approver may approve this offcut revaluation',
      {
        proposal_id: proposal.proposal_id,
        service_order_id: order.service_order_id,
        acting_user_id: actingUserId,
      },
      403,
    );
  }
  // The approve-time half of the dual control - STRUCTURALLY UNREACHABLE, exactly as on the
  // acquisition path: the check above established actingUserId === resolved_approver_actor_id, and
  // chk_job_work_offcut_acq_proposal_dual_control guarantees resolved_approver_actor_id <>
  // proposed_by for every row that can exist. Kept as a restated invariant and as a cheap guard
  // against either of those being weakened independently, not as a currently-reachable branch.
  if (actingUserId === proposal.proposed_by) {
    await auditedRefusal(
      auditCtx,
      'APPROVAL_REQUIRED',
      'An offcut revaluation is dual control: the approver must not be the proposer',
      {
        proposal_id: proposal.proposal_id,
        service_order_id: order.service_order_id,
        acting_user_id: actingUserId,
      },
      403,
    );
  }

  const holding = await lockedHolding(proposal.holding_id, order, client);
  if (holding.status !== 'disposed' || holding.disposition !== 'acquired') {
    reject(
      'INVALID_PARAMS',
      'Only an acquired offcut disposal can be revalued',
      {
        holding_id: holding.holding_id,
        proposal_id: proposal.proposal_id,
        status: holding.status,
        disposition: holding.disposition,
      },
      400,
    );
  }

  // `occurred_at` is caller-suppliable on the direct events door (unlike the REST route, which
  // always stamps server time). A backdated value would otherwise trip the lifecycle CHECK's
  // `decided_at >= created_at` as an unclassified 23514 inside the UPDATE below - checked here
  // instead, before any write (the Story 9.8 finding).
  if (new Date(occurredAt).getTime() < new Date(proposal.created_at).getTime()) {
    reject(
      'INVALID_PARAMS',
      'occurred_at cannot precede the proposal it approves',
      {
        proposal_id: proposal.proposal_id,
        occurred_at: occurredAt,
        proposal_created_at: proposal.created_at,
      },
      400,
    );
  }

  const latest = await latestSupersedableCreditNote(
    order,
    holding,
    proposal.currency,
    client,
    auditCtx,
  );
  // AC 5, THE REASON THE PROPOSAL FREEZES THE DOCUMENT. A below-band revaluation needs no signature
  // and can land between propose and approve, so the document the delta would chain off can move.
  // Raising the proposed delta against a stale document would silently corrupt the running
  // correction: the delta is the signed difference against the value of the document it supersedes,
  // so it would be arithmetically right about the wrong document.
  //
  // The message deliberately does NOT tell the caller to "propose it again": they cannot. The
  // partial unique index gives a holding ONE pending proposal, this one still holds it, and Story
  // 9.8 reserved the `superseded` status for a withdrawal path that nothing writes yet. Saying
  // otherwise would send a finance controller round a loop that refuses them DUPLICATE_EVENT. The
  // gap is recorded as deferred work rather than closed here: a withdrawal is its own authority
  // question (who may withdraw a signature request, and is that itself a governed decision).
  if (latest.credit_note_id !== proposal.supersedes_credit_note_id) {
    await auditedRefusal(
      auditCtx,
      'CREDIT_NOTE_SUPERSEDED',
      'The document this revaluation was priced against has since been superseded by a later revaluation, so this proposal can no longer be approved and is now stale',
      {
        proposal_id: proposal.proposal_id,
        holding_id: holding.holding_id,
        proposed_against_credit_note_id: proposal.supersedes_credit_note_id,
        latest_credit_note_id: latest.credit_note_id,
      },
      409,
    );
  }

  // The Story 9.7 AC 5 effects, unchanged and now driven by the signature rather than by the
  // poster's claim. `valued_by` stays the finance controller who priced it; `approved_by` on the
  // holding row is the CFO who signed.
  const effects = await executeOffcutRevaluationDelta({
    client,
    eventId,
    businessId: proposal.proposal_id,
    order,
    holding,
    latest,
    rate: proposal.rate,
    currency: proposal.currency,
    newValue: proposal.proposed_value,
    valuedBy: proposal.proposed_by,
    approvedBy: actingUserId,
    doaEntryId: proposal.doa_entry_id,
  });

  const decided = await markOffcutRevaluationProposalApproved(
    proposal.proposal_id,
    { decided_at: occurredAt, decided_by: actingUserId, revaluation_event_id: eventId },
    client,
  );
  if (!decided) {
    reject(
      'DUPLICATE_EVENT',
      'This revaluation proposal was approved concurrently',
      { proposal_id: proposal.proposal_id },
      409,
    );
  }

  envelope.payload['holding_id'] = holding.holding_id;
  envelope.payload['delta_value'] = effects.deltaValue;
  envelope.payload['credit_note_id'] = effects.creditNoteId;
  envelope.payload['supersedes_credit_note_id'] = effects.supersedesCreditNoteId;
  envelope.payload['disposal_value'] = proposal.proposed_value;
}

// ---------------------------------------------------------------------------
// Credit-note acknowledgment applier (AC 6)
// ---------------------------------------------------------------------------

export async function applyJobworkCreditNoteAcknowledged(
  envelope: EventEnvelope,
  client: PoolClient,
  _eventId: string,
  // Story 9.7 code review (2026-09-06): self-audited refusals - see the disposal applier's comment.
  auditCtx?: ApplierAuditCtx,
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

  // P8 (code review 2026-09-06): a revaluation delta SUPERSEDES the document it corrects, so an
  // acknowledgment must target the holding's LATEST document. Acknowledging a superseded original
  // or earlier delta would mark a document that no longer carries the commercial value as the one
  // ERP ingested - while the delta that does carry it stays pending. Serialized with revaluations
  // by the order advisory lock above.
  const supersedingResult = await client.query(
    `SELECT 1 FROM job_work_credit_note WHERE supersedes_credit_note_id = $1 LIMIT 1`,
    [note.credit_note_id],
  );
  if ((supersedingResult.rowCount ?? 0) > 0) {
    return auditedRefusal(
      auditCtx,
      'CREDIT_NOTE_SUPERSEDED',
      'This credit note has been superseded by a revaluation delta and is no longer the current document',
      {
        credit_note_id: note.credit_note_id,
        service_order_id: order.service_order_id,
        holding_id: note.holding_id,
      },
      409,
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
    return auditedRefusal(
      auditCtx,
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
