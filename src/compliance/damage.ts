import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { persistEvent } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { config } from '../config/index.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import type { NotificationTarget } from '../notify/emit.js';
import { toIstCalendarDate, isValidCalendarDate } from '../lib/business-days.js';
import { getItemBySku } from '../read/projections/item_master.js';
import { getLocationByCode } from '../read/projections/location_register.js';
import { getLotByNumberAndSku } from '../read/projections/lot_master.js';
import { getOpenQcQualityHoldByLotId } from '../read/projections/qc_quality_hold.js';
import { applyStockIssue, applyStockReceipt } from '../read/projections/stock_balance.js';
import {
  findMatchingDoaEntry,
  findRoleHolder,
  findActiveDelegation,
  listActiveDoaEntries,
} from '../read/projections/doa_registry.js';
import {
  allocateDamageReportNumber,
  getDamageReportById,
  getDamageReportByGrnLine,
  insertDamageAction,
  insertDamageReport,
  updateDamageReport,
} from '../read/projections/damage_report.js';
import type {
  DamageKeyStatus,
  DamagePhysicalState,
  DamageReportRow,
  DamageStatus,
} from '../read/projections/damage_report.js';
import {
  DAMAGE_OTHER_REASON,
  DAMAGE_OUTCOMES,
  DAMAGE_REASON_CODES,
  MAX_DAMAGE_NOTE_LENGTH,
  PRICE_REDUCTION_OUTCOME,
  RECEIPT_CONDITION_TO_DAMAGE_REASON,
} from './damage-reasons.js';
import {
  assertKnownDefectCode,
  buildQcHoldPlacedEnvelope,
  compareDecimalStrings,
  isBoundedText,
} from './quality.js';
import { isQuarantineLocation, lotRelocationHold } from './stock-relocation.js';
import { QC_HOLD_ZONE_CODE } from './receiving.js';

// ---------------------------------------------------------------------------
// Story 8.9: report damage - universal capture, QC task and commercial outcome.
//
// A damage case is its own aggregate on the 'damage' stream (D1, D2). Every guard lives in the
// appliers below, never only in a route (AD-12): the routes in src/api/v1/damage-reports.ts are
// thin shells that authorize the hat, shape the body and call persistEvent.
// ---------------------------------------------------------------------------

export const DAMAGE_STREAM_TYPE = 'damage';
export const ATTACHMENT_STREAM_TYPE = 'attachment';

export const DAMAGE_REPORTED = 'damage.reported';
export const DAMAGE_UNITS_ARRIVED = 'damage.units_arrived';
export const DAMAGE_SENT_FOR_EXTERNAL_CHECK = 'damage.sent_for_external_check';
export const DAMAGE_RETURNED_FROM_EXTERNAL_CHECK = 'damage.returned_from_external_check';
export const DAMAGE_INSPECTED = 'damage.inspected';
export const DAMAGE_WHOLE_LOT_DECIDED = 'damage.whole_lot_decided';
export const DAMAGE_KEY_TURNED = 'damage.key_turned';
export const DAMAGE_KEY_WITHDRAWN = 'damage.key_withdrawn';
export const DAMAGE_DISAGREED = 'damage.disagreed';
export const DAMAGE_ESCALATION_DECIDED = 'damage.escalation_decided';
export const DAMAGE_OUTCOME_RECORDED = 'damage.outcome_recorded';
export const ATTACHMENT_UPLOADED = 'attachment.uploaded';

export const DAMAGE_EVENT_TYPES: readonly string[] = [
  DAMAGE_REPORTED,
  DAMAGE_UNITS_ARRIVED,
  DAMAGE_SENT_FOR_EXTERNAL_CHECK,
  DAMAGE_RETURNED_FROM_EXTERNAL_CHECK,
  DAMAGE_INSPECTED,
  DAMAGE_WHOLE_LOT_DECIDED,
  DAMAGE_KEY_TURNED,
  DAMAGE_KEY_WITHDRAWN,
  DAMAGE_DISAGREED,
  DAMAGE_ESCALATION_DECIDED,
  DAMAGE_OUTCOME_RECORDED,
];

/**
 * D9: the modules a decision route accepts. Authority comes from the DOA registry (D7); this list
 * only decides which hat stamps the audit actor - the QC head through 'qc', the finance controller
 * through 'compliance', the CEO through the 'employee' module row.
 */
export const DAMAGE_DECISION_MODULES: readonly string[] = ['qc', 'compliance', 'employee'];
/** Custody marks (AC 10): stores or QC at the case site. */
export const DAMAGE_CUSTODY_MODULES: readonly string[] = ['warehouse', 'qc'];
/** Inspection is the ad-hoc QC task (D8): QC write at the case site. */
export const DAMAGE_INSPECTION_MODULES: readonly string[] = ['qc'];

/** D7: the three DOA transaction types; the registry names who holds each. */
export const DAMAGE_QC_CONCURRENCE = 'damage.qc_concurrence';
export const DAMAGE_FINANCE_CONCURRENCE = 'damage.finance_concurrence';
export const DAMAGE_ESCALATION = 'damage.escalation';

export type DamageKey = 'qc' | 'finance';
export type DamageOutcome =
  'debit_note' | 'return_for_replacement' | 'write_off' | 'accept_as_is_price_reduction';

export const DAMAGE_KEY_DOA_TYPE: Readonly<Record<DamageKey, string>> = {
  qc: DAMAGE_QC_CONCURRENCE,
  finance: DAMAGE_FINANCE_CONCURRENCE,
};

/** Table 11: the action names allowed_actions may carry, in their fixed display order. */
export const DAMAGE_ACTION_NAMES = [
  'inspect',
  'decide_whole_lot',
  'mark_arrived',
  'send_external',
  'mark_returned',
  'turn_qc_key',
  'withdraw_qc_key',
  'disagree_qc',
  'turn_finance_key',
  'withdraw_finance_key',
  'disagree_finance',
  'decide_escalation',
  'record_outcome',
] as const;
export type DamageActionName = (typeof DAMAGE_ACTION_NAMES)[number];

/** Bounded text fields (Task 6.4). */
export const MAX_DAMAGE_REF_LENGTH = 64;
export const MAX_DAMAGE_DESTINATION_LENGTH = 120;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A non-negative decimal string: at most 12 integer and 6 fraction digits (NUMERIC(18,6)). */
const QUANTITY_REGEX = /^(0|[1-9]\d{0,11})(\.\d{1,6})?$/;
/** A percentage: at most 3 integer and 4 fraction digits (NUMERIC(7,4)). */
const PCT_REGEX = /^(0|[1-9]\d{0,2})(\.\d{1,4})?$/;

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

function isZero(decimal: string): boolean {
  return compareDecimalStrings(decimal, '0') === 0;
}

// ---------------------------------------------------------------------------
// Pure rules (unit-tested in test/unit/damage-rules.test.ts)
// ---------------------------------------------------------------------------

export interface DamageKeyState {
  status: DamageKeyStatus;
  user_id: string | null;
  outcome: string | null;
  price_reduction_pct: string | null;
}

export interface DamageCaseState {
  status: DamageStatus;
  physical_state: DamagePhysicalState;
  hold_mode: 'quarantined' | 'record_only';
  quantity: string;
  confirmed_quantity: string | null;
  reporter_user_id: string;
  whole_lot_requested: boolean;
  whole_lot_decision: string | null;
  qc_key: DamageKeyState;
  finance_key: DamageKeyState;
  final_outcome: string | null;
}

export function caseStateFromRow(row: DamageReportRow): DamageCaseState {
  return {
    status: row.status,
    physical_state: row.physical_state,
    hold_mode: row.hold_mode,
    quantity: row.quantity,
    confirmed_quantity: row.confirmed_quantity,
    reporter_user_id: row.reporter_user_id,
    whole_lot_requested: row.whole_lot_requested,
    whole_lot_decision: row.whole_lot_decision,
    qc_key: {
      status: row.qc_key_status,
      user_id: row.qc_key_user_id,
      outcome: row.qc_key_outcome,
      price_reduction_pct: row.qc_key_price_reduction_pct,
    },
    finance_key: {
      status: row.finance_key_status,
      user_id: row.finance_key_user_id,
      outcome: row.finance_key_outcome,
      price_reduction_pct: row.finance_key_price_reduction_pct,
    },
    final_outcome: row.final_outcome,
  };
}

/** Table 5: a known code; OTHER carries a one-line note of at most 200 characters, nothing else does. */
export function assertDamageReason(
  code: unknown,
  note: unknown,
): { reason_code: string; reason_note: string | null } {
  if (typeof code !== 'string' || !DAMAGE_REASON_CODES.includes(code)) {
    reject('DAMAGE_REASON_INVALID', 'reason_code is not in the damage reason catalogue', {
      reason_code: code ?? null,
      allowed: [...DAMAGE_REASON_CODES],
    });
  }
  const hasNote = typeof note === 'string' && note.trim() !== '';
  if (code !== DAMAGE_OTHER_REASON) {
    if (note !== undefined && note !== null && note !== '') {
      reject('DAMAGE_REASON_INVALID', 'reason_note may only be supplied with reason_code OTHER', {
        reason_code: code,
      });
    }
    return { reason_code: code, reason_note: null };
  }
  if (!hasNote) {
    reject('DAMAGE_OTHER_NOTE_REQUIRED', 'reason_code OTHER requires a one-line reason_note');
  }
  const trimmed = (note as string).trim();
  if (trimmed.length > MAX_DAMAGE_NOTE_LENGTH || /[\r\n]/.test(trimmed)) {
    reject(
      'DAMAGE_REASON_INVALID',
      `reason_note must be one line of at most ${MAX_DAMAGE_NOTE_LENGTH} characters`,
    );
  }
  return { reason_code: code, reason_note: trimmed };
}

/** Table 6: one of the four outcomes; a price reduction rides exactly accept-as-is, above 0, at most 100. */
export function assertDamageOutcome(
  outcome: unknown,
  pct: unknown,
): { outcome: DamageOutcome; price_reduction_pct: string | null } {
  if (typeof outcome !== 'string' || !DAMAGE_OUTCOMES.includes(outcome)) {
    reject('DAMAGE_OUTCOME_INVALID', 'outcome is not one of the four commercial outcomes', {
      outcome: outcome ?? null,
      allowed: [...DAMAGE_OUTCOMES],
    });
  }
  const hasPct = pct !== undefined && pct !== null;
  if (outcome !== PRICE_REDUCTION_OUTCOME) {
    if (hasPct) {
      reject('DAMAGE_OUTCOME_INVALID', 'price_reduction_pct is only allowed with accept as-is', {
        outcome,
      });
    }
    return { outcome: outcome as DamageOutcome, price_reduction_pct: null };
  }
  if (
    typeof pct !== 'string' ||
    !PCT_REGEX.test(pct) ||
    isZero(pct) ||
    compareDecimalStrings(pct, '100') > 0
  ) {
    reject(
      'DAMAGE_OUTCOME_INVALID',
      'accept as-is requires price_reduction_pct as a decimal string above 0 and at most 100',
      { price_reduction_pct: pct ?? null },
    );
  }
  return { outcome: PRICE_REDUCTION_OUTCOME as DamageOutcome, price_reduction_pct: pct };
}

/** Table 3: inspection only on an on_hold case; 0 clears, anything above awaits the keys. */
export function assertInspectable(
  state: DamageCaseState,
  confirmedQuantity: string,
): 'cleared' | 'awaiting_keys' {
  if (state.status !== 'on_hold') {
    reject(
      'DAMAGE_CASE_STATE_INVALID',
      `This case is ${state.status}; only an on_hold case can be inspected`,
      { status: state.status },
      409,
    );
  }
  if (
    typeof confirmedQuantity !== 'string' ||
    !QUANTITY_REGEX.test(confirmedQuantity) ||
    compareDecimalStrings(confirmedQuantity, state.quantity) > 0
  ) {
    reject(
      'DAMAGE_QUANTITY_INVALID',
      'confirmed_quantity must be a decimal string from 0 up to the reported quantity',
      { confirmed_quantity: confirmedQuantity ?? null, reported_quantity: state.quantity },
    );
  }
  return isZero(confirmedQuantity) ? 'cleared' : 'awaiting_keys';
}

const LOCKED_STATUSES: ReadonlySet<DamageStatus> = new Set([
  'escalated',
  'outcome_final',
  'closed',
]);

/** Table 3: a pending whole-lot request, decided while the case is on_hold, cleared or awaiting_keys. */
export function assertWholeLotDecidable(state: DamageCaseState): void {
  if (LOCKED_STATUSES.has(state.status)) {
    reject(
      'DAMAGE_CASE_STATE_INVALID',
      `This case is ${state.status}; the whole-lot decision is no longer open`,
      { status: state.status },
      409,
    );
  }
  if (!state.whole_lot_requested || state.whole_lot_decision !== null) {
    reject(
      'DAMAGE_WHOLE_LOT_NOT_PENDING',
      'This case has no pending whole-lot request',
      { whole_lot_requested: state.whole_lot_requested, decision: state.whole_lot_decision },
      409,
    );
  }
}

/** Table 3: key actions only while awaiting the keys; after both keys or escalation the case is locked. */
export function assertKeyActionState(
  state: DamageCaseState,
  action: 'turn' | 'withdraw' | 'disagree',
): void {
  if (LOCKED_STATUSES.has(state.status)) {
    reject(
      'DAMAGE_CASE_LOCKED',
      `This case is ${state.status}; the keys are locked`,
      { status: state.status, action },
      409,
    );
  }
  if (state.status !== 'awaiting_keys') {
    reject(
      'DAMAGE_CASE_STATE_INVALID',
      `This case is ${state.status}; keys open only after QC confirms damage`,
      { status: state.status, action },
      409,
    );
  }
}

function keyOf(state: DamageCaseState, key: DamageKey): DamageKeyState {
  return key === 'qc' ? state.qc_key : state.finance_key;
}

function otherKey(key: DamageKey): DamageKey {
  return key === 'qc' ? 'finance' : 'qc';
}

/** D10: the reporter never holds a key, and the two keys are two different people. */
export function assertKeySeparation(
  state: DamageCaseState,
  key: DamageKey,
  actorUserId: string,
): void {
  if (actorUserId === state.reporter_user_id) {
    reject(
      'SOD_VIOLATION',
      'The reporter of a damage case cannot turn a key on it',
      { key, reason: 'reporter' },
      403,
    );
  }
  const other = keyOf(state, otherKey(key));
  if (other.status !== 'pending' && other.user_id === actorUserId) {
    reject(
      'SOD_VIOLATION',
      'The two concurrence keys must be turned by two different people',
      { key, reason: 'same_person_both_keys' },
      403,
    );
  }
}

function sameOutcome(
  a: { outcome: string | null; price_reduction_pct: string | null },
  b: { outcome: string | null; price_reduction_pct: string | null },
): boolean {
  if (a.outcome !== b.outcome) return false;
  if (a.price_reduction_pct === null || b.price_reduction_pct === null) {
    return a.price_reduction_pct === b.price_reduction_pct;
  }
  return compareDecimalStrings(a.price_reduction_pct, b.price_reduction_pct) === 0;
}

/**
 * D12: either key goes first; the second must name the same outcome (and reduction). Returns the
 * case status after the turn and, when both keys now agree, the final outcome.
 */
export function planKeyTurn(
  state: DamageCaseState,
  key: DamageKey,
  _actorUserId: string,
  outcome: string,
  pct: string | null,
): { status: DamageStatus; final_outcome: string | null } {
  const own = keyOf(state, key);
  if (own.status !== 'pending') {
    reject(
      'DAMAGE_KEY_ALREADY_TURNED',
      `The ${key} key is already ${own.status}`,
      { key, key_status: own.status },
      409,
    );
  }
  const other = keyOf(state, otherKey(key));
  if (other.status !== 'turned') return { status: 'awaiting_keys', final_outcome: null };
  if (!sameOutcome(other, { outcome, price_reduction_pct: pct })) {
    reject(
      'DAMAGE_OUTCOME_MISMATCH',
      `The ${otherKey(key)} key concurred on ${other.outcome}; concur on the same outcome or disagree`,
      {
        key,
        other_outcome: other.outcome,
        other_price_reduction_pct: other.price_reduction_pct,
        outcome,
        price_reduction_pct: pct,
      },
      409,
    );
  }
  return { status: 'outcome_final', final_outcome: outcome };
}

/** D12: a turned key is withdrawn by the person who turned it, until both keys have turned. */
export function assertKeyWithdrawable(
  state: DamageCaseState,
  key: DamageKey,
  actorUserId: string,
): void {
  const own = keyOf(state, key);
  if (own.status !== 'turned') {
    reject('DAMAGE_KEY_NOT_TURNED', `The ${key} key has not been turned`, { key }, 409);
  }
  if (own.user_id !== actorUserId) {
    reject(
      'APPROVAL_REQUIRED',
      'Only the person who turned this key can withdraw it',
      { key },
      403,
    );
  }
}

/** D12: a key disagrees only while its own key is pending and the other key has turned. */
export function assertDisagreeable(state: DamageCaseState, key: DamageKey): void {
  const own = keyOf(state, key);
  if (own.status !== 'pending') {
    reject(
      'DAMAGE_KEY_ALREADY_TURNED',
      `The ${key} key is already ${own.status}; withdraw it before disagreeing`,
      { key, key_status: own.status },
      409,
    );
  }
  if (keyOf(state, otherKey(key)).status !== 'turned') {
    reject(
      'DAMAGE_CASE_STATE_INVALID',
      `Disagreement escalates the ${otherKey(key)} key's outcome, which has not been turned yet`,
      { key },
      409,
    );
  }
}

/** Table 3 and D10: only an escalated case; the decider is neither the reporter nor a key holder. */
export function assertEscalationDecidable(state: DamageCaseState, actorUserId: string): void {
  if (state.status !== 'escalated') {
    reject(
      'DAMAGE_CASE_STATE_INVALID',
      `This case is ${state.status}; only an escalated case is decided by escalation`,
      { status: state.status },
      409,
    );
  }
  if (actorUserId === state.reporter_user_id) {
    reject(
      'SOD_VIOLATION',
      'The reporter cannot decide the escalation',
      { reason: 'reporter' },
      403,
    );
  }
  if (actorUserId === state.qc_key.user_id || actorUserId === state.finance_key.user_id) {
    reject(
      'SOD_VIOLATION',
      'A key holder on this case cannot decide its escalation',
      { reason: 'key_holder' },
      403,
    );
  }
}

/** Table 3 and D6: the ERP reference is recorded once the outcome is final and no units are out. */
export function assertOutcomeRecordable(state: DamageCaseState): void {
  if (state.status !== 'outcome_final') {
    reject(
      'DAMAGE_CASE_STATE_INVALID',
      `This case is ${state.status}; the ERP reference is recorded once the outcome is final`,
      { status: state.status },
      409,
    );
  }
  if (state.physical_state === 'at_external_check') {
    reject(
      'DAMAGE_UNITS_OUT',
      'The units are out for an external check; record the outcome once they are back',
      { physical_state: state.physical_state },
      409,
    );
  }
}

/** Table 4: the physical custody machine. No transition moves the ledger (D6). */
export function nextPhysicalState(
  state: DamageCaseState,
  action: 'arrive' | 'send_external' | 'return',
): DamagePhysicalState {
  const from = state.physical_state;
  const invalid = (): never =>
    reject(
      'DAMAGE_PHYSICAL_STATE_INVALID',
      `The units are ${from}; "${action}" is not possible now`,
      { physical_state: from, action, status: state.status },
      409,
    );
  if (action === 'arrive') {
    return from === 'awaiting_arrival' || from === 'with_reporter' || from === 'not_held'
      ? 'in_qc_hold'
      : invalid();
  }
  if (action === 'send_external') {
    return from === 'in_qc_hold' && state.status !== 'closed' ? 'at_external_check' : invalid();
  }
  return from === 'at_external_check' ? 'in_qc_hold' : invalid();
}

/**
 * D5: the units a case keeps in quarantine - the reported quantity before inspection, the confirmed
 * quantity after, 0 once cleared or closed as accept-as-is. A record-only case holds nothing. The
 * SQL twin is HELD_QUANTITY_SQL in src/read/projections/damage_report.ts.
 */
export function heldQuantity(state: DamageCaseState): string {
  if (state.hold_mode !== 'quarantined') return '0';
  if (state.status === 'cleared') return '0';
  if (state.status === 'closed' && state.final_outcome === PRICE_REDUCTION_OUTCOME) return '0';
  return state.confirmed_quantity ?? state.quantity;
}

// ---------------------------------------------------------------------------
// Shape asserts (non-DB, before any idempotency key is consumed)
// ---------------------------------------------------------------------------

function optionalBoundedText(
  p: Record<string, unknown>,
  field: string,
  max: number,
  context: string,
): void {
  const value = p[field];
  if (value === undefined || value === null) {
    p[field] = null;
    return;
  }
  if (!isBoundedText(value, max) || /[\r\n]/.test(value)) {
    reject(
      'INVALID_PAYLOAD',
      `${field} must be one line of at most ${max} characters on ${context}`,
    );
  }
  p[field] = value.trim();
}

function requiredBoundedText(
  p: Record<string, unknown>,
  field: string,
  max: number,
  context: string,
): void {
  const value = p[field];
  if (!isBoundedText(value, max) || /[\r\n]/.test(value)) {
    reject(
      'INVALID_PAYLOAD',
      `${field} is required, one line of at most ${max} characters, on ${context}`,
    );
  }
  p[field] = value.trim();
}

function assertStreamIsReport(envelope: EventEnvelope): Record<string, unknown> {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['report_id'])) reject('INVALID_PAYLOAD', 'report_id must be a UUID');
  if (envelope.stream_id !== p['report_id']) {
    reject('INVALID_PAYLOAD', `stream_id must be the report_id for ${envelope.event_type}`, {
      stream_id: envelope.stream_id,
      report_id: p['report_id'],
    });
  }
  return p;
}

function assertKeyField(p: Record<string, unknown>): DamageKey {
  const key = p['key'];
  if (key !== 'qc' && key !== 'finance') reject('INVALID_PAYLOAD', 'key must be qc or finance');
  return key;
}

/** Fields the server derives onto a damage payload; refused on input (the 4.5/8.1 precedent). */
const DERIVED_REPORT_FIELDS = [
  'report_number',
  'hold_mode',
  'hold_note',
  'status',
  'physical_state',
];

export function assertDamageShape(envelope: EventEnvelope): void {
  const type = envelope.event_type;
  // A damage.* name on any other stream is refused by assertRegisteredStream in the store.
  if (envelope.stream_type !== DAMAGE_STREAM_TYPE || !DAMAGE_EVENT_TYPES.includes(type)) return;
  const p = assertStreamIsReport(envelope);
  switch (type) {
    case DAMAGE_REPORTED: {
      if (!isUuid(p['site_id'])) reject('INVALID_PAYLOAD', 'site_id must be a UUID');
      if (p['reporter_user_id'] !== undefined && !isUuid(p['reporter_user_id'])) {
        reject('INVALID_PAYLOAD', 'reporter_user_id must be a UUID');
      }
      requiredBoundedText(p, 'sku', 64, type);
      if (p['lot_number'] === undefined || p['lot_number'] === null || p['lot_number'] === '') {
        p['lot_number'] = null;
      } else {
        requiredBoundedText(p, 'lot_number', 128, type);
      }
      if (
        typeof p['quantity'] !== 'string' ||
        !QUANTITY_REGEX.test(p['quantity']) ||
        isZero(p['quantity'])
      ) {
        reject('DAMAGE_QUANTITY_INVALID', 'quantity must be a positive decimal string', {
          quantity: p['quantity'] ?? null,
        });
      }
      if (p['found_at'] !== 'stock' && p['found_at'] !== 'in_use') {
        reject('INVALID_PAYLOAD', 'found_at must be stock or in_use');
      }
      if (p['found_at'] === 'stock') {
        requiredBoundedText(p, 'bin_code', 64, type);
      } else if (p['bin_code'] !== undefined && p['bin_code'] !== null) {
        reject('INVALID_PAYLOAD', 'bin_code is only supplied for material found in stock');
      } else {
        p['bin_code'] = null;
      }
      const reason = assertDamageReason(p['reason_code'], p['reason_note']);
      p['reason_code'] = reason.reason_code;
      p['reason_note'] = reason.reason_note;
      if (!isUuid(p['photo_attachment_id'])) {
        reject('DAMAGE_PHOTO_REQUIRED', 'A photo is required: photo_attachment_id must be a UUID');
      }
      if (p['whole_lot_requested'] === undefined) p['whole_lot_requested'] = false;
      if (typeof p['whole_lot_requested'] !== 'boolean') {
        reject('INVALID_PAYLOAD', 'whole_lot_requested must be a boolean');
      }
      if (p['whole_lot_requested'] === true && p['lot_number'] === null) {
        reject('DAMAGE_LOT_REQUIRED', 'Suspecting the whole lot requires the lot to be named');
      }
      if (p['replacement_indent_id'] === undefined) p['replacement_indent_id'] = null;
      if (p['replacement_indent_id'] !== null && !isUuid(p['replacement_indent_id'])) {
        reject('INVALID_PAYLOAD', 'replacement_indent_id must be a UUID or null');
      }
      for (const field of DERIVED_REPORT_FIELDS) {
        if (p[field] !== undefined) {
          reject('INVALID_PAYLOAD', `${field} is derived by the server and may not be supplied`);
        }
      }
      return;
    }
    case DAMAGE_UNITS_ARRIVED:
      optionalBoundedText(p, 'note', MAX_DAMAGE_NOTE_LENGTH, type);
      return;
    case DAMAGE_SENT_FOR_EXTERNAL_CHECK:
      requiredBoundedText(p, 'destination', MAX_DAMAGE_DESTINATION_LENGTH, type);
      requiredBoundedText(p, 'reason', MAX_DAMAGE_NOTE_LENGTH, type);
      if (p['expected_return_date'] === undefined || p['expected_return_date'] === null) {
        p['expected_return_date'] = null;
      } else if (
        typeof p['expected_return_date'] !== 'string' ||
        !isValidCalendarDate(p['expected_return_date'])
      ) {
        reject('INVALID_PAYLOAD', 'expected_return_date must be a YYYY-MM-DD date');
      }
      optionalBoundedText(p, 'gate_pass_ref_ext', MAX_DAMAGE_REF_LENGTH, type);
      return;
    case DAMAGE_RETURNED_FROM_EXTERNAL_CHECK:
      optionalBoundedText(p, 'note', MAX_DAMAGE_NOTE_LENGTH, type);
      optionalBoundedText(p, 'external_result_ref_ext', MAX_DAMAGE_REF_LENGTH, type);
      return;
    case DAMAGE_INSPECTED: {
      if (
        typeof p['confirmed_quantity'] !== 'string' ||
        !QUANTITY_REGEX.test(p['confirmed_quantity'])
      ) {
        reject(
          'DAMAGE_QUANTITY_INVALID',
          'confirmed_quantity must be a non-negative decimal string',
        );
      }
      if (isZero(p['confirmed_quantity'])) {
        if (p['defect_code'] !== undefined && p['defect_code'] !== null) {
          assertKnownDefectCode(p['defect_code'], type);
        } else {
          p['defect_code'] = null;
        }
      } else {
        assertKnownDefectCode(p['defect_code'], type);
      }
      optionalBoundedText(p, 'note', MAX_DAMAGE_NOTE_LENGTH, type);
      return;
    }
    case DAMAGE_WHOLE_LOT_DECIDED:
      if (p['decision'] !== 'hold_lot' && p['decision'] !== 'keep_local') {
        reject('INVALID_PAYLOAD', 'decision must be hold_lot or keep_local');
      }
      requiredBoundedText(p, 'reason', MAX_DAMAGE_NOTE_LENGTH, type);
      for (const field of ['hold_id', 'lot_already_held']) {
        if (p[field] !== undefined) {
          reject('INVALID_PAYLOAD', `${field} is derived by the server and may not be supplied`);
        }
      }
      return;
    case DAMAGE_KEY_TURNED: {
      assertKeyField(p);
      const outcome = assertDamageOutcome(p['outcome'], p['price_reduction_pct']);
      p['price_reduction_pct'] = outcome.price_reduction_pct;
      optionalBoundedText(p, 'note', MAX_DAMAGE_NOTE_LENGTH, type);
      if (p['doa_entry_id'] !== undefined) {
        reject('INVALID_PAYLOAD', 'doa_entry_id is derived by the server and may not be supplied');
      }
      return;
    }
    case DAMAGE_KEY_WITHDRAWN:
      assertKeyField(p);
      requiredBoundedText(p, 'reason', MAX_DAMAGE_NOTE_LENGTH, type);
      return;
    case DAMAGE_DISAGREED: {
      assertKeyField(p);
      const outcome = assertDamageOutcome(p['proposed_outcome'], p['price_reduction_pct']);
      p['price_reduction_pct'] = outcome.price_reduction_pct;
      requiredBoundedText(p, 'reason', MAX_DAMAGE_NOTE_LENGTH, type);
      if (p['doa_entry_id'] !== undefined) {
        reject('INVALID_PAYLOAD', 'doa_entry_id is derived by the server and may not be supplied');
      }
      return;
    }
    case DAMAGE_ESCALATION_DECIDED: {
      const outcome = assertDamageOutcome(p['outcome'], p['price_reduction_pct']);
      p['price_reduction_pct'] = outcome.price_reduction_pct;
      requiredBoundedText(p, 'reason', MAX_DAMAGE_NOTE_LENGTH, type);
      if (p['doa_entry_id'] !== undefined) {
        reject('INVALID_PAYLOAD', 'doa_entry_id is derived by the server and may not be supplied');
      }
      return;
    }
    case DAMAGE_OUTCOME_RECORDED:
      requiredBoundedText(p, 'erp_document_ref_ext', MAX_DAMAGE_REF_LENGTH, type);
      optionalBoundedText(p, 'note', MAX_DAMAGE_NOTE_LENGTH, type);
      return;
  }
}

/** The metadata-only photo upload record (D14). */
export function assertAttachmentShape(envelope: EventEnvelope): void {
  if (envelope.event_type !== ATTACHMENT_UPLOADED) return;
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['attachment_id'])) reject('INVALID_PAYLOAD', 'attachment_id must be a UUID');
  if (envelope.stream_id !== p['attachment_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must be the attachment_id');
  }
  if (typeof p['content_type'] !== 'string') reject('INVALID_PAYLOAD', 'content_type is required');
  if (!Number.isSafeInteger(p['byte_size']) || (p['byte_size'] as number) <= 0) {
    reject('INVALID_PAYLOAD', 'byte_size must be a positive integer');
  }
  if (typeof p['sha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(p['sha256'])) {
    reject('INVALID_PAYLOAD', 'sha256 must be 64 lowercase hex characters');
  }
}

// ---------------------------------------------------------------------------
// DOA authority (D7): fail-closed wrapper around the resolveApprover ladder
// ---------------------------------------------------------------------------

export interface DamageAuthority {
  entry_id: string;
  role: string;
  /** The resolved holder and, when a vacation delegation covers today, the delegate. */
  user_ids: string[];
}

/**
 * The DOA entry governing `transactionType` at `value`, the oldest active holder of its role and
 * that holder's active delegate. A missing entry or no holder anywhere is 409 APPROVAL_UNRESOLVED:
 * unlike the indent resolver, "no band" never means "no approval needed" here.
 */
export async function resolveDamageAuthority(
  transactionType: string,
  value: string,
  client?: PoolClient,
): Promise<DamageAuthority> {
  const entry = await findMatchingDoaEntry(transactionType, value, client);
  if (!entry) {
    reject(
      'APPROVAL_UNRESOLVED',
      `No DOA entry governs ${transactionType}`,
      { transaction_type: transactionType },
      409,
    );
  }
  const today = toIstCalendarDate(new Date());
  const tryHolder = async (role: string): Promise<string[] | null> => {
    const holder = await findRoleHolder(role, client);
    if (!holder) return null;
    const delegation = await findActiveDelegation(holder.user_id, today, client);
    return delegation ? [holder.user_id, delegation.delegate_user_id] : [holder.user_id];
  };
  let users = await tryHolder(entry.role);
  let used = entry;
  if (!users) {
    for (const candidate of await listActiveDoaEntries(transactionType, client)) {
      if (candidate.role === entry.role) continue;
      users = await tryHolder(candidate.role);
      if (users) {
        used = candidate;
        break;
      }
    }
  }
  if (!users) {
    reject(
      'APPROVAL_UNRESOLVED',
      `No active holder of the role governing ${transactionType}`,
      { transaction_type: transactionType, governing_role: entry.role },
      409,
    );
  }
  return { entry_id: used.entry_id, role: used.role, user_ids: users };
}

async function assertDamageAuthority(
  transactionType: string,
  value: string,
  actorUserId: string,
  client: PoolClient,
): Promise<DamageAuthority> {
  const authority = await resolveDamageAuthority(transactionType, value, client);
  if (!authority.user_ids.includes(actorUserId)) {
    reject(
      'APPROVAL_REQUIRED',
      `This decision needs the DOA authority for ${transactionType}`,
      {
        transaction_type: transactionType,
        governing_role: authority.role,
        // The same disclosure the indent approval makes (approver_actor_id), so an operator - or
        // the rehearsal's approveAs - can see who the registry resolved.
        resolved_approver_user_id: authority.user_ids[0],
      },
      403,
    );
  }
  return authority;
}

/** True when `userId` is the resolved authority for `transactionType`; never throws. */
export async function isDamageAuthority(
  transactionType: string,
  value: string,
  userId: string,
  client?: PoolClient,
): Promise<boolean> {
  try {
    const authority = await resolveDamageAuthority(transactionType, value, client);
    return authority.user_ids.includes(userId);
  } catch (err) {
    if (err instanceof AppError) return false;
    throw err;
  }
}

/** The role of the DOA entry for a type, for notification targets (AD-3). Null when unbanded. */
async function doaRoleFor(
  transactionType: string,
  value: string,
  client: PoolClient,
): Promise<string | null> {
  const entry = await findMatchingDoaEntry(transactionType, value, client);
  return entry?.role ?? null;
}

// ---------------------------------------------------------------------------
// Appliers (inside the persistEvent transaction)
// ---------------------------------------------------------------------------

async function loadCaseForUpdate(reportId: string, client: PoolClient): Promise<DamageReportRow> {
  const row = await getDamageReportById(reportId, client, 'update');
  if (!row) {
    reject(
      'DAMAGE_REPORT_NOT_FOUND',
      'The damage report does not resolve',
      { report_id: reportId },
      404,
    );
  }
  return row;
}

function caseLabel(row: Pick<DamageReportRow, 'report_number' | 'sku' | 'quantity'>): string {
  return `${row.report_number} - ${row.sku} x ${row.quantity}`;
}

async function notify(
  envelope: EventEnvelope,
  client: PoolClient,
  target: NotificationTarget,
  input: {
    event_type: string;
    status_verb: string;
    report: Pick<DamageReportRow, 'report_id' | 'report_number' | 'sku' | 'quantity'>;
    next_step: string;
  },
): Promise<void> {
  await emitNotificationInTransaction(
    {
      target,
      event_type: input.event_type,
      status_verb: input.status_verb,
      object_type: 'damage_report',
      object_id: input.report.report_id,
      actor_label: caseLabel(input.report),
      next_step: input.next_step,
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
    },
    client,
  );
}

async function recordAction(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  reportId: string,
  action: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await insertDamageAction(
    {
      report_id: reportId,
      action,
      actor_user_id: envelope.metadata.actor.user_id,
      actor_role: envelope.metadata.actor.role,
      at: envelope.metadata.occurred_at,
      detail,
      source_event_id: eventId,
    },
    client,
  );
}

/** The site's QC hold area: the literal ZONE-QC-HOLD, active, a quarantine location, at this site. */
async function siteQcHoldZone(
  siteId: string,
  client: PoolClient,
): Promise<{ location_id: string; location_code: string } | null> {
  const zone = await getLocationByCode(QC_HOLD_ZONE_CODE, client);
  if (!zone || zone.status !== 'active' || zone.quarantine !== true || zone.site_id !== siteId) {
    return null;
  }
  return { location_id: zone.location_id, location_code: zone.location_code };
}

type HoldPlan =
  | {
      hold_mode: 'quarantined';
      hold_note: null;
      physical_state: 'awaiting_arrival';
      zone: { location_id: string; location_code: string };
      qcHeldLot: boolean;
    }
  | {
      hold_mode: 'record_only';
      hold_note: string;
      physical_state: 'with_reporter' | 'not_held';
    };

/**
 * D4: book the reported units into the QC hold area when that is safe - owned, non-serial stock at
 * a non-quarantine location whose available balance covers the quantity. Anything else is recorded
 * with a note and never refused: an offline capture replayed after the stock moved still lands.
 */
async function planHold(
  input: {
    siteId: string;
    sku: string;
    lotNumber: string | null;
    quantity: string;
    foundAt: 'stock' | 'in_use';
    binLocationId: string | null;
    serialControlled: boolean;
  },
  client: PoolClient,
): Promise<HoldPlan> {
  const recordOnly = (note: string): HoldPlan => ({
    hold_mode: 'record_only',
    hold_note: note,
    physical_state: note === 'in_use' ? 'with_reporter' : 'not_held',
  });
  if (input.foundAt === 'in_use' || input.binLocationId === null) return recordOnly('in_use');
  if (input.serialControlled) return recordOnly('serial_controlled');
  if (await isQuarantineLocation(input.binLocationId, client))
    return recordOnly('already_quarantined');
  const zone = await siteQcHoldZone(input.siteId, client);
  if (!zone) return recordOnly('no_qc_hold_zone');
  const balance = await client.query(
    `SELECT COALESCE(SUM(available) FILTER (WHERE stock_class = 'owned'), 0) >= $4::numeric AS owned_covers,
            COALESCE(SUM(available) FILTER (WHERE stock_class <> 'owned'), 0) >= $4::numeric AS other_covers
       FROM (SELECT available, stock_class FROM stock_balance
              WHERE sku = $1 AND location_id = $2 AND lot_id IS NOT DISTINCT FROM $3::text
              FOR UPDATE) grain`,
    [input.sku, input.binLocationId, input.lotNumber, input.quantity],
  );
  const row = balance.rows[0]!;
  if (row['owned_covers'] !== true) {
    return recordOnly(
      row['other_covers'] === true ? 'not_owned_stock' : 'insufficient_stock_at_bin',
    );
  }
  let qcHeldLot = false;
  if (input.lotNumber !== null) {
    const hold = await lotRelocationHold(input.sku, input.lotNumber, client);
    qcHeldLot = hold.qcGated || hold.manuallyHeld;
  }
  return {
    hold_mode: 'quarantined',
    hold_note: null,
    physical_state: 'awaiting_arrival',
    zone,
    qcHeldLot,
  };
}

async function applyDamageReported(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  // D3: the reporter is always the authenticated actor, whichever door the report came through.
  p['reporter_user_id'] = envelope.metadata.actor.user_id;
  const reportId = p['report_id'] as string;
  const siteId = p['site_id'] as string;
  const sku = p['sku'] as string;
  const lotNumber = (p['lot_number'] as string | null) ?? null;
  const quantity = p['quantity'] as string;
  const foundAt = p['found_at'] as 'stock' | 'in_use';

  if (await getDamageReportById(reportId, client)) {
    reject(
      'DUPLICATE_EVENT',
      'A damage report with this report_id already exists',
      { report_id: reportId },
      409,
    );
  }

  const item = await getItemBySku(sku, client);
  if (!item || item.status !== 'active') {
    reject('ITEM_NOT_FOUND', `No active item master record exists for sku "${sku}"`, { sku }, 404);
  }
  if (item.lot_controlled && lotNumber === null) {
    reject('DAMAGE_LOT_REQUIRED', `Item ${sku} is lot-controlled: scan the lot`, { sku });
  }
  if (lotNumber !== null && !(await getLotByNumberAndSku(lotNumber, sku, client))) {
    reject(
      'DAMAGE_LOT_NOT_FOUND',
      `Lot ${lotNumber} not found for ${sku}`,
      { sku, lot_number: lotNumber },
      404,
    );
  }

  let bin: { location_id: string; location_code: string } | null = null;
  if (foundAt === 'stock') {
    const binCode = p['bin_code'] as string;
    const found = await client.query(
      `SELECT location_id, location_code FROM location_register
        WHERE location_code = $1 AND site_id = $2 AND status = 'active'`,
      [binCode, siteId],
    );
    if (found.rows.length === 0) {
      reject(
        'DAMAGE_LOCATION_NOT_FOUND',
        `No active location "${binCode}" exists at this site`,
        { bin_code: binCode, site_id: siteId },
        404,
      );
    }
    bin = found.rows[0] as { location_id: string; location_code: string };
  }

  const plan = await planHold(
    {
      siteId,
      sku,
      lotNumber,
      quantity,
      foundAt,
      binLocationId: bin?.location_id ?? null,
      serialControlled: item.serial_controlled,
    },
    client,
  );

  if (plan.hold_mode === 'quarantined') {
    // The putaway and bin-move pair: the report's own relocation into the QC hold area (AD-15: the
    // report's site is the asserted location), valuation-neutral and clock-neutral.
    await applyStockIssue(
      {
        sku,
        location_id: bin!.location_id,
        lot_id: lotNumber,
        stock_class: 'owned',
        quantity,
        relocation: true,
        relocation_target_location_id: plan.zone.location_id,
        ...(plan.qcHeldLot ? { qc_gate_relocation: true } : {}),
      },
      client,
    );
    await applyStockReceipt(
      {
        sku,
        location_id: plan.zone.location_id,
        location_code: plan.zone.location_code,
        lot_id: lotNumber,
        stock_class: 'owned',
        quantity,
      },
      client,
    );
  }

  const year = toIstCalendarDate(new Date(envelope.metadata.occurred_at)).slice(0, 4);
  const reportNumber = await allocateDamageReportNumber(year, client);
  await insertDamageReport(
    {
      report_id: reportId,
      report_number: reportNumber,
      site_id: siteId,
      reporter_user_id: envelope.metadata.actor.user_id,
      reported_at: envelope.metadata.occurred_at,
      source_event_id: eventId,
      source: 'report',
      source_grn_line_id: null,
      source_reason_code: null,
      source_photo_ref: null,
      sku,
      lot_number: lotNumber,
      quantity,
      uom: item.uom,
      found_at: foundAt,
      bin_location_id: bin?.location_id ?? null,
      bin_code: bin?.location_code ?? null,
      reason_code: p['reason_code'] as string,
      reason_note: (p['reason_note'] as string | null) ?? null,
      photo_attachment_id: p['photo_attachment_id'] as string,
      hold_mode: plan.hold_mode,
      hold_note: plan.hold_note,
      quarantine_location_id: plan.hold_mode === 'quarantined' ? plan.zone.location_id : null,
      physical_state: plan.physical_state,
      whole_lot_requested: p['whole_lot_requested'] === true,
      replacement_indent_id: (p['replacement_indent_id'] as string | null) ?? null,
    },
    client,
  );
  await recordAction(envelope, client, eventId, reportId, 'reported', {
    quantity,
    hold_mode: plan.hold_mode,
    hold_note: plan.hold_note,
    bin_code: bin?.location_code ?? null,
  });

  const report = { report_id: reportId, report_number: reportNumber, sku, quantity };
  const where = bin ? `at ${bin.location_code}` : '(in use)';
  await notify(
    envelope,
    client,
    { role: config.quality.inspectionTaskNotificationRole, location_id: siteId },
    {
      event_type: 'damage_reported',
      status_verb: 'Damage reported',
      report,
      next_step: `Inspect the reported units ${where}`,
    },
  );
  if (plan.hold_mode === 'quarantined') {
    await notify(
      envelope,
      client,
      { role: config.damage.storesNotificationRole, location_id: siteId },
      {
        event_type: 'damage_units_to_move',
        status_verb: 'Units booked into QC hold',
        report,
        next_step: `Bring the units from ${bin!.location_code} to ${plan.zone.location_code} and mark them arrived`,
      },
    );
  }
  if (p['whole_lot_requested'] === true) {
    const role = await doaRoleFor(DAMAGE_QC_CONCURRENCE, '0', client);
    if (role) {
      await notify(
        envelope,
        client,
        { role, location_id: siteId },
        {
          event_type: 'damage_whole_lot_requested',
          status_verb: 'Whole-lot hold requested',
          report,
          next_step: `Decide whether to hold all of lot ${lotNumber as string}`,
        },
      );
    }
  }

  // Server-derived facts written back before the domain_events insert (the 4.5 precedent), so the
  // stored event says what this process decided.
  p['report_number'] = reportNumber;
  p['hold_mode'] = plan.hold_mode;
  p['hold_note'] = plan.hold_note;
}

async function applyCustody(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  action: 'arrive' | 'send_external' | 'return',
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const row = await loadCaseForUpdate(p['report_id'] as string, client);
  const next = nextPhysicalState(caseStateFromRow(row), action);
  const actorId = envelope.metadata.actor.user_id;
  const at = envelope.metadata.occurred_at;
  if (action === 'arrive') {
    await updateDamageReport(
      row.report_id,
      { physical_state: next, arrived_by: actorId, arrived_at: at },
      client,
    );
    await recordAction(envelope, client, eventId, row.report_id, 'units_arrived', {
      note: p['note'] ?? null,
      from: row.physical_state,
    });
    return;
  }
  if (action === 'send_external') {
    await updateDamageReport(
      row.report_id,
      {
        physical_state: next,
        external_destination: p['destination'],
        external_sent_by: actorId,
        external_sent_at: at,
        external_expected_return_date: p['expected_return_date'] ?? null,
        external_gate_pass_ref_ext: p['gate_pass_ref_ext'] ?? null,
        external_returned_at: null,
        external_result_ref_ext: null,
      },
      client,
    );
    await recordAction(envelope, client, eventId, row.report_id, 'sent_for_external_check', {
      destination: p['destination'],
      reason: p['reason'],
      expected_return_date: p['expected_return_date'] ?? null,
      gate_pass_ref_ext: p['gate_pass_ref_ext'] ?? null,
    });
    return;
  }
  await updateDamageReport(
    row.report_id,
    {
      physical_state: next,
      external_returned_at: at,
      external_result_ref_ext: p['external_result_ref_ext'] ?? null,
    },
    client,
  );
  await recordAction(envelope, client, eventId, row.report_id, 'returned_from_external_check', {
    note: p['note'] ?? null,
    external_result_ref_ext: p['external_result_ref_ext'] ?? null,
  });
}

async function applyDamageInspected(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const row = await loadCaseForUpdate(p['report_id'] as string, client);
  const confirmed = p['confirmed_quantity'] as string;
  const status = assertInspectable(caseStateFromRow(row), confirmed);
  // D7: the case value the DOA bands are matched against - confirmed quantity at standard cost.
  const value = await client.query(
    `SELECT ($1::numeric * COALESCE(standard_cost_amount, 0))::numeric(18,4)::text AS value
       FROM item_master WHERE sku = $2`,
    [confirmed, row.sku],
  );
  const caseValue = (value.rows[0]?.['value'] as string | undefined) ?? '0';
  await updateDamageReport(
    row.report_id,
    {
      status,
      confirmed_quantity: confirmed,
      defect_code: (p['defect_code'] as string | null) ?? null,
      inspected_by: envelope.metadata.actor.user_id,
      inspected_at: envelope.metadata.occurred_at,
      case_value: caseValue,
    },
    client,
  );
  await recordAction(envelope, client, eventId, row.report_id, 'inspected', {
    confirmed_quantity: confirmed,
    defect_code: p['defect_code'] ?? null,
    note: p['note'] ?? null,
  });
  if (status === 'cleared') {
    await notify(
      envelope,
      client,
      { role: 'reporter', user_id: row.reporter_user_id },
      {
        event_type: 'damage_cleared',
        status_verb: 'Cleared - no damage',
        report: row,
        next_step: 'QC found no damage; nothing more is needed from you',
      },
    );
    await notify(
      envelope,
      client,
      { role: config.damage.storesNotificationRole, location_id: row.site_id },
      {
        event_type: 'damage_units_released',
        status_verb: 'Units released',
        report: row,
        next_step: 'QC found no damage; move the released units back to stock',
      },
    );
    return;
  }
  for (const type of [DAMAGE_QC_CONCURRENCE, DAMAGE_FINANCE_CONCURRENCE]) {
    const role = await doaRoleFor(type, caseValue, client);
    if (!role) continue;
    await notify(
      envelope,
      client,
      { role, location_id: null },
      {
        event_type: 'damage_key_required',
        status_verb: 'Damage confirmed',
        report: row,
        next_step: `Damage confirmed: ${confirmed} of ${row.quantity}. Turn your key`,
      },
    );
  }
}

async function applyWholeLotDecided(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const row = await loadCaseForUpdate(p['report_id'] as string, client);
  const state = caseStateFromRow(row);
  assertWholeLotDecidable(state);
  const actorId = envelope.metadata.actor.user_id;
  if (actorId === row.reporter_user_id) {
    reject(
      'SOD_VIOLATION',
      'The reporter cannot decide the whole-lot hold on their own report',
      { reason: 'reporter' },
      403,
    );
  }
  await assertDamageAuthority(DAMAGE_QC_CONCURRENCE, row.case_value ?? '0', actorId, client);

  let holdId: string | null = null;
  let alreadyHeld = false;
  if (p['decision'] === 'hold_lot') {
    const lot = await getLotByNumberAndSku(row.lot_number as string, row.sku, client);
    if (!lot) {
      reject(
        'DAMAGE_LOT_NOT_FOUND',
        `Lot ${row.lot_number ?? ''} not found for ${row.sku}`,
        {},
        404,
      );
    }
    const open = await getOpenQcQualityHoldByLotId(lot.lot_id, client, true);
    if (open) {
      alreadyHeld = true;
      holdId = open.hold_id;
    } else {
      // The governed Story 8.5 hold, on this decision's own transaction (the nested-persistEvent
      // precedent of the job-work receipt): its applier locks the lot, sets the one enforcement
      // flag and notifies the inspector.
      holdId = randomUUID();
      await persistEvent(
        buildQcHoldPlacedEnvelope({
          holdId,
          lotId: lot.lot_id,
          holdReason: 'damage_report',
          actor: envelope.metadata.actor,
          occurredAt: envelope.metadata.occurred_at,
          idempotencyKey: `damage-whole-lot-hold:${row.report_id}`,
          correlationId: envelope.metadata.correlation_id,
          causationId: eventId,
        }),
        undefined,
        client,
      );
    }
  }
  await updateDamageReport(
    row.report_id,
    {
      whole_lot_decision: p['decision'],
      whole_lot_hold_id: holdId,
      whole_lot_already_held: alreadyHeld,
      whole_lot_decided_by: actorId,
      whole_lot_decided_at: envelope.metadata.occurred_at,
    },
    client,
  );
  await recordAction(envelope, client, eventId, row.report_id, 'whole_lot_decided', {
    decision: p['decision'],
    reason: p['reason'],
    hold_id: holdId,
    lot_already_held: alreadyHeld,
  });
  p['hold_id'] = holdId;
  p['lot_already_held'] = alreadyHeld;
}

function keyColumns(
  key: DamageKey,
  value: {
    status: DamageKeyStatus;
    user_id: string | null;
    outcome: string | null;
    price_reduction_pct: string | null;
    at: string | null;
  },
): Record<string, unknown> {
  return {
    [`${key}_key_status`]: value.status,
    [`${key}_key_user_id`]: value.user_id,
    [`${key}_key_outcome`]: value.outcome,
    [`${key}_key_price_reduction_pct`]: value.price_reduction_pct,
    [`${key}_key_at`]: value.at,
  };
}

async function notifyOutcomeFinal(
  envelope: EventEnvelope,
  client: PoolClient,
  row: DamageReportRow,
  outcome: string,
): Promise<void> {
  const role = await doaRoleFor(DAMAGE_FINANCE_CONCURRENCE, row.case_value ?? '0', client);
  if (role) {
    await notify(
      envelope,
      client,
      { role, location_id: null },
      {
        event_type: 'damage_outcome_final',
        status_verb: 'Outcome final',
        report: row,
        next_step: `Outcome ${outcome}: execute it in ERP and record the ERP reference`,
      },
    );
  }
  await notify(
    envelope,
    client,
    { role: 'reporter', user_id: row.reporter_user_id },
    {
      event_type: 'damage_outcome_final',
      status_verb: 'Outcome decided',
      report: row,
      next_step: `QC and finance decided: ${outcome}`,
    },
  );
}

async function applyKeyTurned(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const key = p['key'] as DamageKey;
  const row = await loadCaseForUpdate(p['report_id'] as string, client);
  const state = caseStateFromRow(row);
  const actorId = envelope.metadata.actor.user_id;
  assertKeyActionState(state, 'turn');
  assertKeySeparation(state, key, actorId);
  const authority = await assertDamageAuthority(
    DAMAGE_KEY_DOA_TYPE[key],
    row.case_value ?? '0',
    actorId,
    client,
  );
  const outcome = p['outcome'] as string;
  const pct = (p['price_reduction_pct'] as string | null) ?? null;
  const plan = planKeyTurn(state, key, actorId, outcome, pct);
  const at = envelope.metadata.occurred_at;
  await updateDamageReport(
    row.report_id,
    {
      ...keyColumns(key, {
        status: 'turned',
        user_id: actorId,
        outcome,
        price_reduction_pct: pct,
        at,
      }),
      status: plan.status,
      ...(plan.status === 'outcome_final'
        ? {
            final_outcome: outcome,
            final_price_reduction_pct: pct,
            decided_by: 'concurrence',
            decided_at: at,
          }
        : {}),
    },
    client,
  );
  await recordAction(envelope, client, eventId, row.report_id, 'key_turned', {
    key,
    outcome,
    price_reduction_pct: pct,
    note: p['note'] ?? null,
    outcome_final: plan.status === 'outcome_final',
  });
  p['doa_entry_id'] = authority.entry_id;
  if (plan.status === 'outcome_final') {
    await notifyOutcomeFinal(envelope, client, row, outcome);
    return;
  }
  const otherRole = await doaRoleFor(
    DAMAGE_KEY_DOA_TYPE[otherKey(key)],
    row.case_value ?? '0',
    client,
  );
  if (otherRole) {
    await notify(
      envelope,
      client,
      { role: otherRole, location_id: null },
      {
        event_type: 'damage_key_required',
        status_verb: `${key === 'qc' ? 'QC' : 'Finance'} concurred`,
        report: row,
        next_step: `Concur on ${outcome} or disagree`,
      },
    );
  }
}

async function applyKeyWithdrawn(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const key = p['key'] as DamageKey;
  const row = await loadCaseForUpdate(p['report_id'] as string, client);
  const state = caseStateFromRow(row);
  assertKeyActionState(state, 'withdraw');
  assertKeyWithdrawable(state, key, envelope.metadata.actor.user_id);
  await updateDamageReport(
    row.report_id,
    keyColumns(key, {
      status: 'pending',
      user_id: null,
      outcome: null,
      price_reduction_pct: null,
      at: null,
    }),
    client,
  );
  await recordAction(envelope, client, eventId, row.report_id, 'key_withdrawn', {
    key,
    reason: p['reason'],
  });
}

async function applyDisagreed(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const key = p['key'] as DamageKey;
  const row = await loadCaseForUpdate(p['report_id'] as string, client);
  const state = caseStateFromRow(row);
  const actorId = envelope.metadata.actor.user_id;
  assertKeyActionState(state, 'disagree');
  assertDisagreeable(state, key);
  assertKeySeparation(state, key, actorId);
  const authority = await assertDamageAuthority(
    DAMAGE_KEY_DOA_TYPE[key],
    row.case_value ?? '0',
    actorId,
    client,
  );
  const outcome = p['proposed_outcome'] as string;
  const pct = (p['price_reduction_pct'] as string | null) ?? null;
  await updateDamageReport(
    row.report_id,
    {
      ...keyColumns(key, {
        status: 'disagreed',
        user_id: actorId,
        outcome,
        price_reduction_pct: pct,
        at: envelope.metadata.occurred_at,
      }),
      status: 'escalated',
    },
    client,
  );
  await recordAction(envelope, client, eventId, row.report_id, 'disagreed', {
    key,
    proposed_outcome: outcome,
    price_reduction_pct: pct,
    reason: p['reason'],
  });
  p['doa_entry_id'] = authority.entry_id;
  const role = await doaRoleFor(DAMAGE_ESCALATION, row.case_value ?? '0', client);
  if (role) {
    await notify(
      envelope,
      client,
      { role, location_id: null },
      {
        event_type: 'damage_escalated',
        status_verb: 'QC and finance disagree',
        report: row,
        next_step: 'Decide the outcome',
      },
    );
  }
}

async function applyEscalationDecided(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const row = await loadCaseForUpdate(p['report_id'] as string, client);
  const actorId = envelope.metadata.actor.user_id;
  assertEscalationDecidable(caseStateFromRow(row), actorId);
  const authority = await assertDamageAuthority(
    DAMAGE_ESCALATION,
    row.case_value ?? '0',
    actorId,
    client,
  );
  const outcome = p['outcome'] as string;
  const pct = (p['price_reduction_pct'] as string | null) ?? null;
  await updateDamageReport(
    row.report_id,
    {
      status: 'outcome_final',
      final_outcome: outcome,
      final_price_reduction_pct: pct,
      decided_by: 'escalation',
      escalation_user_id: actorId,
      decided_at: envelope.metadata.occurred_at,
    },
    client,
  );
  await recordAction(envelope, client, eventId, row.report_id, 'escalation_decided', {
    outcome,
    price_reduction_pct: pct,
    reason: p['reason'],
  });
  p['doa_entry_id'] = authority.entry_id;
  await notifyOutcomeFinal(envelope, client, row, outcome);
}

async function applyOutcomeRecorded(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const row = await loadCaseForUpdate(p['report_id'] as string, client);
  assertOutcomeRecordable(caseStateFromRow(row));
  const actorId = envelope.metadata.actor.user_id;
  await assertDamageAuthority(DAMAGE_FINANCE_CONCURRENCE, row.case_value ?? '0', actorId, client);
  await updateDamageReport(
    row.report_id,
    {
      status: 'closed',
      erp_document_ref_ext: p['erp_document_ref_ext'],
      outcome_recorded_by: actorId,
      outcome_recorded_at: envelope.metadata.occurred_at,
    },
    client,
  );
  await recordAction(envelope, client, eventId, row.report_id, 'outcome_recorded', {
    erp_document_ref_ext: p['erp_document_ref_ext'],
    note: p['note'] ?? null,
  });
  const released = row.final_outcome === PRICE_REDUCTION_OUTCOME;
  await notify(
    envelope,
    client,
    { role: 'reporter', user_id: row.reporter_user_id },
    {
      event_type: 'damage_closed',
      status_verb: 'Closed',
      report: row,
      next_step: `Closed: ${row.final_outcome as string}, ERP ${p['erp_document_ref_ext'] as string}`,
    },
  );
  if (row.hold_mode === 'quarantined') {
    await notify(
      envelope,
      client,
      { role: config.damage.storesNotificationRole, location_id: row.site_id },
      {
        event_type: released ? 'damage_units_released' : 'damage_units_stay_held',
        status_verb: 'Damage case closed',
        report: row,
        next_step: released
          ? 'Accepted as-is: move the released units back to stock'
          : 'Keep the held units in quarantine until they are disposed of',
      },
    );
  }
}

export async function applyDamageProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (envelope.stream_type !== DAMAGE_STREAM_TYPE) return;
  switch (envelope.event_type) {
    case DAMAGE_REPORTED:
      return applyDamageReported(envelope, client, eventId);
    case DAMAGE_UNITS_ARRIVED:
      return applyCustody(envelope, client, eventId, 'arrive');
    case DAMAGE_SENT_FOR_EXTERNAL_CHECK:
      return applyCustody(envelope, client, eventId, 'send_external');
    case DAMAGE_RETURNED_FROM_EXTERNAL_CHECK:
      return applyCustody(envelope, client, eventId, 'return');
    case DAMAGE_INSPECTED:
      return applyDamageInspected(envelope, client, eventId);
    case DAMAGE_WHOLE_LOT_DECIDED:
      return applyWholeLotDecided(envelope, client, eventId);
    case DAMAGE_KEY_TURNED:
      return applyKeyTurned(envelope, client, eventId);
    case DAMAGE_KEY_WITHDRAWN:
      return applyKeyWithdrawn(envelope, client, eventId);
    case DAMAGE_DISAGREED:
      return applyDisagreed(envelope, client, eventId);
    case DAMAGE_ESCALATION_DECIDED:
      return applyEscalationDecided(envelope, client, eventId);
    case DAMAGE_OUTCOME_RECORDED:
      return applyOutcomeRecorded(envelope, client, eventId);
  }
}

// ---------------------------------------------------------------------------
// Receipt damage (AC 9) and the held putaway it gates
// ---------------------------------------------------------------------------

/**
 * AC 9: a DAMAGED or REJECTED GRN line opens a damage case inside the goods.received transaction.
 * The line's units are already booked into the QC hold area by the receipt itself, so the case
 * starts in_qc_hold with no photo attachment (the 3.11 dock photo reference, if any, rides along).
 * One case per GRN line: a replayed receipt inserts nothing.
 */
export async function openReceiptDamageCase(
  input: {
    envelope: EventEnvelope;
    eventId: string;
    grnLineId: string;
    siteId: string;
    receivedBy: string;
    sku: string;
    lotNumber: string | null;
    quantity: string;
    uom: string;
    lineCondition: string;
    sourceReasonCode: string | null;
    sourcePhotoRef: string | null;
    quarantineLocation: { location_id: string; location_code: string };
  },
  client: PoolClient,
): Promise<void> {
  const reasonCode = RECEIPT_CONDITION_TO_DAMAGE_REASON.get(input.lineCondition);
  if (!reasonCode) return;
  if (await getDamageReportByGrnLine(input.grnLineId, client)) return;
  const occurredAt = input.envelope.metadata.occurred_at ?? new Date().toISOString();
  const reportId = randomUUID();
  const year = toIstCalendarDate(new Date(occurredAt)).slice(0, 4);
  const reportNumber = await allocateDamageReportNumber(year, client);
  await insertDamageReport(
    {
      report_id: reportId,
      report_number: reportNumber,
      site_id: input.siteId,
      reporter_user_id: input.receivedBy,
      reported_at: occurredAt,
      source_event_id: input.eventId,
      source: 'receipt',
      source_grn_line_id: input.grnLineId,
      source_reason_code: input.sourceReasonCode,
      source_photo_ref: input.sourcePhotoRef,
      sku: input.sku,
      lot_number: input.lotNumber,
      quantity: input.quantity,
      uom: input.uom,
      found_at: 'stock',
      bin_location_id: input.quarantineLocation.location_id,
      bin_code: input.quarantineLocation.location_code,
      reason_code: reasonCode,
      reason_note: null,
      photo_attachment_id: null,
      hold_mode: 'quarantined',
      hold_note: null,
      quarantine_location_id: input.quarantineLocation.location_id,
      physical_state: 'in_qc_hold',
      whole_lot_requested: false,
      replacement_indent_id: null,
    },
    client,
  );
  await insertDamageAction(
    {
      report_id: reportId,
      action: 'reported',
      actor_user_id: input.receivedBy,
      actor_role: input.envelope.metadata.actor.role,
      at: occurredAt,
      detail: {
        source: 'receipt',
        grn_line_id: input.grnLineId,
        line_condition: input.lineCondition,
        quantity: input.quantity,
      },
      source_event_id: input.eventId,
    },
    client,
  );
}

/**
 * AC 9 (closes deferred-work L1157): a held putaway of a damaged or rejected GRN line is released
 * to a shelf only once its case allows it - cleared by QC, or closed as accept-as-is - and its units
 * are physically in the QC hold area. The case row is read FOR SHARE so a concurrent decision
 * serializes against the release.
 */
export async function assertDamageCaseAllowsRelease(
  grnLineId: string,
  client: PoolClient,
): Promise<void> {
  const row = await getDamageReportByGrnLine(grnLineId, client, 'share');
  if (!row) return;
  const released =
    row.status === 'cleared' ||
    (row.status === 'closed' && row.final_outcome === PRICE_REDUCTION_OUTCOME);
  if (!released || row.physical_state !== 'in_qc_hold') {
    reject(
      'DAMAGE_CASE_BLOCKS_RELEASE',
      `Damage case ${row.report_number} holds this line's units; release it once QC clears the case or it closes accepted as-is`,
      {
        report_id: row.report_id,
        report_number: row.report_number,
        status: row.status,
        final_outcome: row.final_outcome,
        physical_state: row.physical_state,
      },
      409,
    );
  }
}

/**
 * AC 5 (D15): an indent raised as a damage replacement must name a case whose reporter raised it
 * and which names this indent back. A forged or mismatched link is refused.
 */
export async function assertReplacementLink(
  input: { indentId: string; damageReportId: string; requesterUserId: string },
  client: PoolClient,
): Promise<void> {
  const row = await getDamageReportById(input.damageReportId, client, 'share');
  if (
    !row ||
    row.replacement_indent_id !== input.indentId ||
    row.reporter_user_id !== input.requesterUserId
  ) {
    reject(
      'DAMAGE_REPLACEMENT_LINK_INVALID',
      'damage_report_id does not name a damage report you raised for this replacement requisition',
      { damage_report_id: input.damageReportId, indent_id: input.indentId },
      409,
    );
  }
}

// ---------------------------------------------------------------------------
// Server-computed actions (D11): the same predicates the appliers enforce
// ---------------------------------------------------------------------------

export interface DamageCaller {
  userId: string;
  roles: { role: string; module: string; functionScope: 'read' | 'write'; locationId: string }[];
  coversLocation: (
    assignment: {
      role: string;
      module: string;
      functionScope: 'read' | 'write';
      locationId: string;
    },
    locationId: string,
  ) => boolean;
}

/** A write assignment on one of `modules` covering `siteId` (the route gates, restated). */
export function hasModuleWriteAt(
  caller: DamageCaller,
  modules: readonly string[],
  siteId: string,
): boolean {
  return caller.roles.some(
    (r) =>
      (modules.includes(r.module) || r.module === '*') &&
      r.functionScope === 'write' &&
      caller.coversLocation(r, siteId),
  );
}

function passes(check: () => void): boolean {
  try {
    check();
    return true;
  } catch (err) {
    if (err instanceof AppError) return false;
    throw err;
  }
}

/**
 * The action names (Table 11) this caller may take on this case now, in display order. Each name is
 * the conjunction of the route's module gate and the applier's own state, separation and DOA
 * checks, so the edge never offers an action the API would refuse (1.14 pattern).
 */
export async function allowedDamageActions(
  row: DamageReportRow,
  caller: DamageCaller,
  client?: PoolClient,
): Promise<DamageActionName[]> {
  const state = caseStateFromRow(row);
  const value = row.case_value ?? '0';
  const actor = caller.userId;
  // The decision routes gate on the hat alone (D9); the DOA registry is the authority (D7).
  const decisionHat = caller.roles.some(
    (r) =>
      (DAMAGE_DECISION_MODULES.includes(r.module) || r.module === '*') &&
      r.functionScope === 'write',
  );
  const authority = new Map<string, boolean>();
  const isAuthority = async (type: string): Promise<boolean> => {
    if (!authority.has(type)) {
      authority.set(type, decisionHat && (await isDamageAuthority(type, value, actor, client)));
    }
    return authority.get(type)!;
  };
  const allowed = new Set<DamageActionName>();

  if (
    hasModuleWriteAt(caller, DAMAGE_INSPECTION_MODULES, row.site_id) &&
    state.status === 'on_hold'
  ) {
    allowed.add('inspect');
  }
  if (
    actor !== row.reporter_user_id &&
    passes(() => assertWholeLotDecidable(state)) &&
    (await isAuthority(DAMAGE_QC_CONCURRENCE))
  ) {
    allowed.add('decide_whole_lot');
  }
  if (hasModuleWriteAt(caller, DAMAGE_CUSTODY_MODULES, row.site_id)) {
    if (passes(() => nextPhysicalState(state, 'arrive'))) allowed.add('mark_arrived');
    if (passes(() => nextPhysicalState(state, 'send_external'))) allowed.add('send_external');
    if (passes(() => nextPhysicalState(state, 'return'))) allowed.add('mark_returned');
  }
  for (const key of ['qc', 'finance'] as const) {
    if (!passes(() => assertKeyActionState(state, 'turn'))) break;
    const own = keyOf(state, key);
    if (own.status === 'turned' && own.user_id === actor) {
      allowed.add(key === 'qc' ? 'withdraw_qc_key' : 'withdraw_finance_key');
      continue;
    }
    if (own.status !== 'pending') continue;
    if (!passes(() => assertKeySeparation(state, key, actor))) continue;
    if (!(await isAuthority(DAMAGE_KEY_DOA_TYPE[key]))) continue;
    allowed.add(key === 'qc' ? 'turn_qc_key' : 'turn_finance_key');
    if (passes(() => assertDisagreeable(state, key))) {
      allowed.add(key === 'qc' ? 'disagree_qc' : 'disagree_finance');
    }
  }
  if (
    passes(() => assertEscalationDecidable(state, actor)) &&
    (await isAuthority(DAMAGE_ESCALATION))
  ) {
    allowed.add('decide_escalation');
  }
  if (
    passes(() => assertOutcomeRecordable(state)) &&
    (await isAuthority(DAMAGE_FINANCE_CONCURRENCE))
  ) {
    allowed.add('record_outcome');
  }
  return DAMAGE_ACTION_NAMES.filter((name) => allowed.has(name));
}

/** D11: the caller is the resolved authority of some step still pending on this case. */
export async function isPendingStepAuthority(
  row: DamageReportRow,
  userId: string,
  client?: PoolClient,
): Promise<boolean> {
  const value = row.case_value ?? '0';
  const types: string[] = [];
  if (
    row.whole_lot_requested &&
    row.whole_lot_decision === null &&
    !LOCKED_STATUSES.has(row.status)
  ) {
    types.push(DAMAGE_QC_CONCURRENCE);
  }
  if (row.status === 'awaiting_keys') types.push(DAMAGE_QC_CONCURRENCE, DAMAGE_FINANCE_CONCURRENCE);
  if (row.status === 'escalated') {
    types.push(DAMAGE_ESCALATION);
    if (row.qc_key_user_id === userId || row.finance_key_user_id === userId) return true;
  }
  if (row.status === 'outcome_final') types.push(DAMAGE_FINANCE_CONCURRENCE);
  for (const type of new Set(types)) {
    if (await isDamageAuthority(type, value, userId, client)) return true;
  }
  return false;
}

/** D11: every damage DOA type this user currently resolves as the authority for, at value 0. */
export async function damageAuthorityTypesFor(
  userId: string,
  client?: PoolClient,
): Promise<string[]> {
  const out: string[] = [];
  for (const type of [DAMAGE_QC_CONCURRENCE, DAMAGE_FINANCE_CONCURRENCE, DAMAGE_ESCALATION]) {
    if (await isDamageAuthority(type, '0', userId, client)) out.push(type);
  }
  return out;
}
