'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { errorMessage, formatDateTime, t, type MessageKey } from '../i18n/locale';
import { authorizedFetch } from '../session/api-fetch';
import { istCalendarDate } from '../capture/business-date';
import {
  DAMAGE_OUTCOMES,
  DEFECT_CODES,
  actionPath,
  concurredCount,
  groupWorkbench,
  isDamageReport,
  isExternalCheckOverdue,
  isHistoryEntry,
  isPriceReductionPct,
  panelsFor,
  type DamageActionName,
  type DamageHistoryEntry,
  type DamageOutcome,
  type DamageReport,
  type KeyStatus,
  type WorkbenchGroup,
} from './damage-case-view';

export interface DamageCasesProps {
  /** From the shell: offline shows the needs-connection card and no rows (Task 10.4). */
  online: boolean;
  /** The signed-in user; tells "Awaiting your key" from "Sent on". */
  userId: string;
}

const WORKBENCH_LIMIT = 200;
const MAX_REASON_LENGTH = 200;
const MAX_ERP_REF_LENGTH = 64;
const MAX_DESTINATION_LENGTH = 120;

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; reports: DamageReport[] }
  | { kind: 'needs-connection' }
  | { kind: 'no-access' };

type DetailState =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'ready'; report: DamageReport; allowed: string[]; history: DamageHistoryEntry[] }
  | { kind: 'message'; text: string };

export const GROUP_LABEL: Record<WorkbenchGroup, MessageKey> = {
  to_inspect: 'damageCases.group.to_inspect',
  whole_lot: 'damageCases.group.whole_lot',
  awaiting_your_key: 'damageCases.group.awaiting_your_key',
  sent_on: 'damageCases.group.sent_on',
  with_ceo: 'damageCases.group.with_ceo',
  record_erp: 'damageCases.group.record_erp',
  units_to_move: 'damageCases.group.units_to_move',
  closed: 'damageCases.group.closed',
};

export const STATUS_LABEL: Record<string, MessageKey> = {
  on_hold: 'damageCases.status.on_hold',
  cleared: 'damageCases.status.cleared',
  awaiting_keys: 'damageCases.status.awaiting_keys',
  escalated: 'damageCases.status.escalated',
  outcome_final: 'damageCases.status.outcome_final',
  closed: 'damageCases.status.closed',
};

export const OUTCOME_LABEL: Record<DamageOutcome, MessageKey> = {
  debit_note: 'damageCases.outcome.debit_note',
  return_for_replacement: 'damageCases.outcome.return_for_replacement',
  write_off: 'damageCases.outcome.write_off',
  accept_as_is_price_reduction: 'damageCases.outcome.accept_as_is_price_reduction',
};

const REASON_LABEL: Record<string, MessageKey> = {
  DEAD_ON_ARRIVAL: 'damage.reason.DEAD_ON_ARRIVAL',
  DAMAGED_COMPONENT: 'damage.reason.DAMAGED_COMPONENT',
  WRONG_ITEM_OR_SPEC: 'damage.reason.WRONG_ITEM_OR_SPEC',
  OTHER: 'damage.reason.OTHER',
};

const HOLD_NOTE_LABEL: Record<string, MessageKey> = {
  in_use: 'damageCases.holdNote.in_use',
  insufficient_stock_at_bin: 'damageCases.holdNote.insufficient_stock_at_bin',
  serial_controlled: 'damageCases.holdNote.serial_controlled',
  not_owned_stock: 'damageCases.holdNote.not_owned_stock',
  already_quarantined: 'damageCases.holdNote.already_quarantined',
};

const HISTORY_LABEL: Record<string, MessageKey> = {
  reported: 'damageCases.history.reported',
  units_arrived: 'damageCases.history.units_arrived',
  sent_for_external_check: 'damageCases.history.sent_for_external_check',
  returned_from_external_check: 'damageCases.history.returned_from_external_check',
  inspected: 'damageCases.history.inspected',
  whole_lot_decided: 'damageCases.history.whole_lot_decided',
  key_turned: 'damageCases.history.key_turned',
  key_withdrawn: 'damageCases.history.key_withdrawn',
  disagreed: 'damageCases.history.disagreed',
  escalation_decided: 'damageCases.history.escalation_decided',
  outcome_recorded: 'damageCases.history.outcome_recorded',
};

const SUCCESS_LABEL: Record<DamageActionName, MessageKey> = {
  inspect: 'damageCases.done.inspect',
  decide_whole_lot: 'damageCases.done.decide_whole_lot',
  mark_arrived: 'damageCases.done.mark_arrived',
  send_external: 'damageCases.done.send_external',
  mark_returned: 'damageCases.done.mark_returned',
  turn_qc_key: 'damageCases.done.turn_key',
  withdraw_qc_key: 'damageCases.done.withdraw_key',
  disagree_qc: 'damageCases.done.disagree',
  turn_finance_key: 'damageCases.done.turn_key',
  withdraw_finance_key: 'damageCases.done.withdraw_key',
  disagree_finance: 'damageCases.done.disagree',
  decide_escalation: 'damageCases.done.decide_escalation',
  record_outcome: 'damageCases.done.record_outcome',
};

function fill(key: MessageKey, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (text, [name, value]) => text.split(`{${name}}`).join(value),
    t(key),
  );
}

function outcomeText(outcome: string | null | undefined, pct: string | null | undefined): string {
  if (!outcome) return '-';
  const label = OUTCOME_LABEL[outcome as DamageOutcome];
  const text = label ? t(label) : outcome;
  return outcome === 'accept_as_is_price_reduction' && pct
    ? fill('damageCases.outcomeWithPct', { outcome: text, pct })
    : text;
}

function caseTitle(report: DamageReport): string {
  return fill('damageCases.caseHeading', {
    number: report.report_number,
    sku: report.sku,
    quantity: report.quantity,
  });
}

function todayIst(): string {
  return istCalendarDate(new Date().toISOString());
}

function readCaseParam(): string | null {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.search).get('case');
  return value && value.trim() ? value.trim() : null;
}

function Fact({ label, value }: { label: MessageKey; value: string }) {
  return (
    <div>
      <dt>{t(label)}</dt>
      <dd>{value}</dd>
    </div>
  );
}

type Run = (action: DamageActionName, body: Record<string, unknown>) => Promise<boolean>;

interface PanelProps {
  report: DamageReport;
  allowed: string[];
  busy: boolean;
  inFlight: DamageActionName | null;
  run: Run;
}

function FieldError({ id, text }: { id: string; text: string }) {
  return text ? (
    <p id={id} className="damage-field-error" role="status">
      {text}
    </p>
  ) : null;
}

function ActionButton({
  action,
  inFlight,
  busy,
  onClick,
  children,
  primary = true,
}: {
  action: DamageActionName;
  inFlight: DamageActionName | null;
  busy: boolean;
  onClick: () => void;
  children: ReactNode;
  primary?: boolean;
}) {
  return (
    <button
      className={primary ? 'primary-action' : 'secondary-action'}
      type="button"
      disabled={busy}
      aria-busy={inFlight === action}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Outcome radios (Table 6) plus the price reduction for accept-as-is. */
function OutcomeChoice({
  idPrefix,
  legend,
  outcome,
  onOutcome,
  pct,
  onPct,
  busy,
}: {
  idPrefix: string;
  legend: MessageKey;
  outcome: DamageOutcome | null;
  onOutcome: (value: DamageOutcome) => void;
  pct: string;
  onPct: (value: string) => void;
  busy: boolean;
}) {
  return (
    <fieldset className="damage-choice">
      <legend>{t(legend)}</legend>
      {DAMAGE_OUTCOMES.map((code) => (
        <label key={code} htmlFor={`${idPrefix}-${code}`}>
          <input
            id={`${idPrefix}-${code}`}
            type="radio"
            name={`${idPrefix}-outcome`}
            value={code}
            checked={outcome === code}
            disabled={busy}
            onChange={() => onOutcome(code)}
          />
          {t(OUTCOME_LABEL[code])}
        </label>
      ))}
      {outcome === 'accept_as_is_price_reduction' ? (
        <>
          <label htmlFor={`${idPrefix}-pct`}>{t('damageCases.pctLabel')}</label>
          <input
            id={`${idPrefix}-pct`}
            inputMode="decimal"
            autoComplete="off"
            required
            value={pct}
            disabled={busy}
            onChange={(event) => onPct(event.target.value)}
          />
        </>
      ) : null}
    </fieldset>
  );
}

function outcomeBody(
  outcome: DamageOutcome | null,
  pct: string,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string; field: 'outcome' | 'pct' } {
  if (!outcome) return { ok: false, error: t('damageCases.outcomeRequired'), field: 'outcome' };
  if (outcome === 'accept_as_is_price_reduction') {
    const value = pct.trim();
    if (!isPriceReductionPct(value)) return { ok: false, error: t('damageCases.pctInvalid'), field: 'pct' };
    return { ok: true, body: { price_reduction_pct: value } };
  }
  return { ok: true, body: {} };
}

// --------------------------------------------------------------------------------------------
// Hold scope card (decide_whole_lot)
// --------------------------------------------------------------------------------------------

function HoldScopeCard({ report, allowed, busy, inFlight, run }: PanelProps) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const canDecide = allowed.includes('decide_whole_lot');

  async function decide(decision: 'hold_lot' | 'keep_local') {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError(t('damageCases.reasonRequired'));
      reasonRef.current?.focus();
      return;
    }
    setError('');
    await run('decide_whole_lot', { decision, reason: trimmed });
  }

  const scope =
    report.whole_lot_decision === 'hold_lot' && report.lot_number
      ? fill('damageCases.scopeWholeLot', { lot: report.lot_number })
      : t('damageCases.scopeLocal');
  return (
    <section className="edge-card damage-panel" aria-labelledby="damage-cases-scope-heading">
      <h3 id="damage-cases-scope-heading">{t('damageCases.scopeTitle')}</h3>
      <p>{scope}</p>
      {report.hold_mode === 'record_only' ? (
        <p>
          {fill('damageCases.recordOnly', {
            why: report.hold_note && HOLD_NOTE_LABEL[report.hold_note]
              ? t(HOLD_NOTE_LABEL[report.hold_note]!)
              : '-',
          })}
        </p>
      ) : null}
      {report.whole_lot_requested && report.whole_lot_decision === null ? (
        <p>
          <span className="state-pill state-pill-warn">{t('damageCases.wholeLotRequested')}</span>
        </p>
      ) : null}
      {report.whole_lot_decision === 'keep_local' ? <p>{t('damageCases.wholeLotKeptLocal')}</p> : null}
      {canDecide ? (
        <div className="damage-action-form">
          <p>{t('damageCases.wholeLotPrompt')}</p>
          <label htmlFor="damage-cases-whole-lot-reason">{t('damageCases.reasonLabel')}</label>
          <textarea
            id="damage-cases-whole-lot-reason"
            ref={reasonRef}
            required
            rows={2}
            maxLength={MAX_REASON_LENGTH}
            value={reason}
            disabled={busy}
            aria-describedby="damage-cases-whole-lot-error"
            onChange={(event) => setReason(event.target.value)}
          />
          <FieldError id="damage-cases-whole-lot-error" text={error} />
          <div className="edge-actions">
            <ActionButton action="decide_whole_lot" inFlight={inFlight} busy={busy} onClick={() => void decide('hold_lot')}>
              {t('damageCases.holdWholeLot')}
            </ActionButton>
            <ActionButton
              action="decide_whole_lot"
              inFlight={inFlight}
              busy={busy}
              primary={false}
              onClick={() => void decide('keep_local')}
            >
              {t('damageCases.keepLocal')}
            </ActionButton>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// --------------------------------------------------------------------------------------------
// Custody card (mark_arrived, send_external, mark_returned)
// --------------------------------------------------------------------------------------------

function CustodyCard({ report, allowed, busy, inFlight, run }: PanelProps) {
  const [destination, setDestination] = useState('');
  const [reason, setReason] = useState('');
  const [returnDate, setReturnDate] = useState('');
  const [gatePass, setGatePass] = useState('');
  const [resultRef, setResultRef] = useState('');
  const [error, setError] = useState('');
  const destinationRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  let state: string;
  switch (report.physical_state) {
    case 'awaiting_arrival':
      state = t('damageCases.custody.awaiting_arrival');
      break;
    case 'in_qc_hold':
      state = t('damageCases.custody.in_qc_hold');
      break;
    case 'at_external_check':
      state = fill('damageCases.custody.at_external_check', {
        destination: report.external_destination ?? '-',
        date: report.external_sent_at ? formatDateTime(report.external_sent_at) : '-',
      });
      break;
    case 'with_reporter':
      state = t('damageCases.custody.with_reporter');
      break;
    default:
      state = t('damageCases.custody.not_held');
  }

  async function sendExternal() {
    if (!destination.trim()) {
      setError(t('damageCases.destinationRequired'));
      destinationRef.current?.focus();
      return;
    }
    if (!reason.trim()) {
      setError(t('damageCases.reasonRequired'));
      reasonRef.current?.focus();
      return;
    }
    setError('');
    await run('send_external', {
      destination: destination.trim(),
      reason: reason.trim(),
      ...(returnDate ? { expected_return_date: returnDate } : {}),
      ...(gatePass.trim() ? { gate_pass_ref_ext: gatePass.trim() } : {}),
    });
  }

  return (
    <section className="edge-card damage-panel" aria-labelledby="damage-cases-custody-heading">
      <h3 id="damage-cases-custody-heading">{t('damageCases.custodyTitle')}</h3>
      <p>{state}</p>
      {isExternalCheckOverdue(report, todayIst()) && report.external_expected_return_date ? (
        <p>
          <span className="state-pill state-pill-err">
            {fill('damageCases.returnOverdue', { date: report.external_expected_return_date })}
          </span>
        </p>
      ) : null}
      {allowed.includes('mark_arrived') ? (
        <div className="edge-actions">
          <ActionButton action="mark_arrived" inFlight={inFlight} busy={busy} onClick={() => void run('mark_arrived', {})}>
            {t('damageCases.markArrived')}
          </ActionButton>
        </div>
      ) : null}
      {allowed.includes('send_external') ? (
        <div className="damage-action-form">
          <label htmlFor="damage-cases-destination">{t('damageCases.destinationLabel')}</label>
          <input
            id="damage-cases-destination"
            ref={destinationRef}
            required
            autoComplete="off"
            maxLength={MAX_DESTINATION_LENGTH}
            value={destination}
            disabled={busy}
            onChange={(event) => setDestination(event.target.value)}
          />
          <label htmlFor="damage-cases-external-reason">{t('damageCases.externalReasonLabel')}</label>
          <textarea
            id="damage-cases-external-reason"
            ref={reasonRef}
            required
            rows={2}
            maxLength={MAX_REASON_LENGTH}
            value={reason}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
          />
          <label htmlFor="damage-cases-return-date">{t('damageCases.returnDateLabel')}</label>
          <input
            id="damage-cases-return-date"
            type="date"
            value={returnDate}
            disabled={busy}
            onChange={(event) => setReturnDate(event.target.value)}
          />
          <label htmlFor="damage-cases-gate-pass">{t('damageCases.gatePassLabel')}</label>
          <input
            id="damage-cases-gate-pass"
            autoComplete="off"
            maxLength={MAX_ERP_REF_LENGTH}
            value={gatePass}
            disabled={busy}
            onChange={(event) => setGatePass(event.target.value)}
          />
          <FieldError id="damage-cases-custody-error" text={error} />
          <div className="edge-actions">
            <ActionButton action="send_external" inFlight={inFlight} busy={busy} onClick={() => void sendExternal()}>
              {t('damageCases.sendExternal')}
            </ActionButton>
          </div>
        </div>
      ) : null}
      {allowed.includes('mark_returned') ? (
        <div className="damage-action-form">
          <label htmlFor="damage-cases-result-ref">{t('damageCases.resultRefLabel')}</label>
          <input
            id="damage-cases-result-ref"
            autoComplete="off"
            maxLength={MAX_ERP_REF_LENGTH}
            value={resultRef}
            disabled={busy}
            onChange={(event) => setResultRef(event.target.value)}
          />
          <div className="edge-actions">
            <ActionButton
              action="mark_returned"
              inFlight={inFlight}
              busy={busy}
              onClick={() =>
                void run('mark_returned', resultRef.trim() ? { external_result_ref_ext: resultRef.trim() } : {})
              }
            >
              {t('damageCases.markReturned')}
            </ActionButton>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// --------------------------------------------------------------------------------------------
// Inspection card (inspect)
// --------------------------------------------------------------------------------------------

function InspectionCard({ report, allowed, busy, inFlight, run }: PanelProps) {
  const [confirmed, setConfirmed] = useState('');
  const [defect, setDefect] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const quantityRef = useRef<HTMLInputElement>(null);
  const defectRef = useRef<HTMLSelectElement>(null);

  let result: string;
  if (report.confirmed_quantity === null || report.confirmed_quantity === undefined) {
    result = t('damageCases.inspectionPending');
  } else if (Number(report.confirmed_quantity) === 0) {
    result = t('damageCases.inspectionCleared');
  } else {
    result = fill('damageCases.inspectionConfirmed', {
      confirmed: report.confirmed_quantity,
      quantity: report.quantity,
    });
  }

  async function inspect() {
    const value = confirmed.trim();
    if (!/^\d+(\.\d{1,6})?$/.test(value) || Number(value) > Number(report.quantity)) {
      setError(fill('damageCases.confirmedInvalid', { quantity: report.quantity }));
      quantityRef.current?.focus();
      return;
    }
    if (Number(value) > 0 && !defect) {
      setError(t('damageCases.defectRequired'));
      defectRef.current?.focus();
      return;
    }
    setError('');
    await run('inspect', {
      confirmed_quantity: value,
      ...(Number(value) > 0 ? { defect_code: defect } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
  }

  return (
    <section className="edge-card damage-panel" aria-labelledby="damage-cases-inspection-heading">
      <h3 id="damage-cases-inspection-heading">{t('damageCases.inspectionTitle')}</h3>
      <p>{result}</p>
      {report.defect_code ? (
        <p>{fill('damageCases.defectShown', { code: report.defect_code })}</p>
      ) : null}
      {allowed.includes('inspect') ? (
        <div className="damage-action-form">
          <label htmlFor="damage-cases-confirmed">
            {fill('damageCases.confirmedLabel', { quantity: report.quantity })}
          </label>
          <input
            id="damage-cases-confirmed"
            ref={quantityRef}
            inputMode="decimal"
            autoComplete="off"
            required
            value={confirmed}
            disabled={busy}
            onChange={(event) => setConfirmed(event.target.value)}
          />
          <label htmlFor="damage-cases-defect">{t('damageCases.defectLabel')}</label>
          <select
            id="damage-cases-defect"
            ref={defectRef}
            value={defect}
            disabled={busy}
            onChange={(event) => setDefect(event.target.value)}
          >
            <option value="">{t('damageCases.defectNone')}</option>
            {DEFECT_CODES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
          <label htmlFor="damage-cases-inspection-note">{t('damageCases.noteLabel')}</label>
          <textarea
            id="damage-cases-inspection-note"
            rows={2}
            maxLength={MAX_REASON_LENGTH}
            value={note}
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
          />
          <FieldError id="damage-cases-inspection-error" text={error} />
          <div className="edge-actions">
            <ActionButton action="inspect" inFlight={inFlight} busy={busy} onClick={() => void inspect()}>
              {t('damageCases.recordInspection')}
            </ActionButton>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// --------------------------------------------------------------------------------------------
// Concurrence card (keys) and CEO decision
// --------------------------------------------------------------------------------------------

const KEY_PILL: Record<KeyStatus, { label: MessageKey; className: string }> = {
  pending: { label: 'damageCases.keyPending', className: 'state-pill state-pill-warn' },
  turned: { label: 'damageCases.keyConcurred', className: 'state-pill state-pill-ok' },
  disagreed: { label: 'damageCases.keyDisagrees', className: 'state-pill state-pill-err' },
};

const KEY_ACTIONS: Record<'qc' | 'finance', readonly string[]> = {
  qc: ['turn_qc_key', 'withdraw_qc_key', 'disagree_qc'],
  finance: ['turn_finance_key', 'withdraw_finance_key', 'disagree_finance'],
};

function KeyRow({ report, which }: { report: DamageReport; which: 'qc' | 'finance' }) {
  const status = which === 'qc' ? report.qc_key_status : report.finance_key_status;
  const name = which === 'qc' ? report.qc_key_display_name : report.finance_key_display_name;
  const at = which === 'qc' ? report.qc_key_at : report.finance_key_at;
  const outcome = which === 'qc' ? report.qc_key_outcome : report.finance_key_outcome;
  const pct = which === 'qc' ? report.qc_key_price_reduction_pct : report.finance_key_price_reduction_pct;
  const pill = KEY_PILL[status] ?? KEY_PILL.pending;
  return (
    <li className="damage-key-row">
      <span className="base-card-title">
        {t(which === 'qc' ? 'damageCases.qcHead' : 'damageCases.financeController')}
      </span>
      <span className={pill.className}>{t(pill.label)}</span>
      {status !== 'pending' ? (
        <span>
          {fill('damageCases.keyDetail', {
            name: name ?? '-',
            when: at ? formatDateTime(at) : '-',
            outcome: outcomeText(outcome, pct),
          })}
        </span>
      ) : null}
    </li>
  );
}

function KeyActions({ report, allowed, busy, inFlight, run, which }: PanelProps & { which: 'qc' | 'finance' }) {
  const other = which === 'qc' ? 'finance' : 'qc';
  const otherOutcome = (other === 'qc' ? report.qc_key_outcome : report.finance_key_outcome) ?? null;
  const otherPct = (other === 'qc' ? report.qc_key_price_reduction_pct : report.finance_key_price_reduction_pct) ?? '';
  const [outcome, setOutcome] = useState<DamageOutcome | null>(
    (DAMAGE_OUTCOMES as readonly string[]).includes(otherOutcome ?? '') ? (otherOutcome as DamageOutcome) : null,
  );
  const [pct, setPct] = useState(otherPct);
  const [note, setNote] = useState('');
  const [disagreeing, setDisagreeing] = useState(false);
  const [proposed, setProposed] = useState<DamageOutcome | null>(null);
  const [proposedPct, setProposedPct] = useState('');
  const [reason, setReason] = useState('');
  const [withdrawReason, setWithdrawReason] = useState('');
  const [error, setError] = useState('');
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const withdrawRef = useRef<HTMLTextAreaElement>(null);
  const prefix = `damage-cases-${which}`;
  const turn: DamageActionName = which === 'qc' ? 'turn_qc_key' : 'turn_finance_key';
  const withdraw: DamageActionName = which === 'qc' ? 'withdraw_qc_key' : 'withdraw_finance_key';
  const disagree: DamageActionName = which === 'qc' ? 'disagree_qc' : 'disagree_finance';
  const otherName = t(other === 'qc' ? 'damageCases.qcShort' : 'damageCases.financeShort');
  const myAt = which === 'qc' ? report.qc_key_at : report.finance_key_at;

  async function concur() {
    const checked = outcomeBody(outcome, pct);
    if (!checked.ok) {
      setError(checked.error);
      document.getElementById(checked.field === 'pct' ? `${prefix}-turn-pct` : `${prefix}-turn-debit_note`)?.focus();
      return;
    }
    setError('');
    await run(turn, { outcome, ...checked.body, ...(note.trim() ? { note: note.trim() } : {}) });
  }

  async function sendDisagreement() {
    const checked = outcomeBody(proposed, proposedPct);
    if (!checked.ok) {
      setError(checked.error);
      document
        .getElementById(checked.field === 'pct' ? `${prefix}-disagree-pct` : `${prefix}-disagree-debit_note`)
        ?.focus();
      return;
    }
    if (!reason.trim()) {
      setError(t('damageCases.reasonRequired'));
      reasonRef.current?.focus();
      return;
    }
    setError('');
    await run(disagree, { proposed_outcome: proposed, ...checked.body, reason: reason.trim() });
  }

  async function withdrawKey() {
    if (!withdrawReason.trim()) {
      setError(t('damageCases.reasonRequired'));
      withdrawRef.current?.focus();
      return;
    }
    setError('');
    await run(withdraw, { reason: withdrawReason.trim() });
  }

  return (
    <div className="damage-action-form">
      {allowed.includes(turn) ? (
        <>
          <OutcomeChoice
            idPrefix={`${prefix}-turn`}
            legend="damageCases.outcomeLegend"
            outcome={outcome}
            onOutcome={setOutcome}
            pct={pct}
            onPct={setPct}
            busy={busy}
          />
          <label htmlFor={`${prefix}-note`}>{t('damageCases.noteLabel')}</label>
          <textarea
            id={`${prefix}-note`}
            rows={2}
            maxLength={MAX_REASON_LENGTH}
            value={note}
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="edge-actions">
            <ActionButton action={turn} inFlight={inFlight} busy={busy} onClick={() => void concur()}>
              {outcome
                ? fill('damageCases.concurWith', { outcome: t(OUTCOME_LABEL[outcome]) })
                : t('damageCases.concur')}
            </ActionButton>
          </div>
        </>
      ) : null}
      {allowed.includes(disagree) ? (
        disagreeing ? (
          <>
            <OutcomeChoice
              idPrefix={`${prefix}-disagree`}
              legend="damageCases.proposedLegend"
              outcome={proposed}
              onOutcome={setProposed}
              pct={proposedPct}
              onPct={setProposedPct}
              busy={busy}
            />
            <label htmlFor={`${prefix}-disagree-reason`}>{t('damageCases.disagreeReasonLabel')}</label>
            <textarea
              id={`${prefix}-disagree-reason`}
              ref={reasonRef}
              required
              rows={2}
              maxLength={MAX_REASON_LENGTH}
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
            />
            <div className="edge-actions">
              <ActionButton action={disagree} inFlight={inFlight} busy={busy} onClick={() => void sendDisagreement()}>
                {t('damageCases.disagreeEscalate')}
              </ActionButton>
            </div>
          </>
        ) : (
          <div className="edge-actions">
            <button className="secondary-action" type="button" disabled={busy} onClick={() => setDisagreeing(true)}>
              {fill('damageCases.disagreeWith', { other: otherName })}
            </button>
          </div>
        )
      ) : null}
      {allowed.includes(withdraw) ? (
        <>
          <p>
            {fill('damageCases.youConcurred', {
              when: myAt ? formatDateTime(myAt) : '-',
              other: otherName,
            })}
          </p>
          <label htmlFor={`${prefix}-withdraw-reason`}>{t('damageCases.withdrawReasonLabel')}</label>
          <textarea
            id={`${prefix}-withdraw-reason`}
            ref={withdrawRef}
            required
            rows={2}
            maxLength={MAX_REASON_LENGTH}
            value={withdrawReason}
            disabled={busy}
            onChange={(event) => setWithdrawReason(event.target.value)}
          />
          <div className="edge-actions">
            <ActionButton action={withdraw} inFlight={inFlight} busy={busy} primary={false} onClick={() => void withdrawKey()}>
              {t('damageCases.withdraw')}
            </ActionButton>
          </div>
        </>
      ) : null}
      <FieldError id={`${prefix}-error`} text={error} />
    </div>
  );
}

function ConcurrenceCard(props: PanelProps) {
  const { report, allowed } = props;
  const showKeys = report.status !== 'on_hold' && report.status !== 'cleared';
  if (!showKeys && !panelsFor(allowed).includes('keys')) return null;
  const locked =
    (report.status === 'outcome_final' || report.status === 'closed') && report.decided_by === 'concurrence';
  return (
    <section className="edge-card damage-panel" aria-labelledby="damage-cases-keys-heading">
      <h3 id="damage-cases-keys-heading">{t('damageCases.keysTitle')}</h3>
      <ul className="base-list">
        <KeyRow report={report} which="qc" />
        <KeyRow report={report} which="finance" />
      </ul>
      <p>{fill('damageCases.keysCounter', { n: String(concurredCount(report)) })}</p>
      {report.status === 'escalated' ? <p>{t('damageCases.ceoDecides')}</p> : null}
      {report.status === 'escalated' && !allowed.includes('decide_escalation') ? (
        <p>{t('damageCases.withCeo')}</p>
      ) : null}
      {locked ? <p>{t('damageCases.locked')}</p> : null}
      {report.final_outcome ? (
        <p>
          {fill(
            report.decided_by === 'escalation' ? 'damageCases.finalByCeo' : 'damageCases.finalOutcome',
            {
              outcome: outcomeText(report.final_outcome, report.final_price_reduction_pct),
              name: report.escalation_display_name ?? '-',
            },
          )}
        </p>
      ) : null}
      {(['qc', 'finance'] as const).map((which) =>
        allowed.some((name) => KEY_ACTIONS[which].includes(name)) ? (
          <KeyActions key={which} {...props} which={which} />
        ) : null,
      )}
    </section>
  );
}

function EscalationCard({ report, allowed, busy, inFlight, run }: PanelProps) {
  const [outcome, setOutcome] = useState<DamageOutcome | null>(null);
  const [pct, setPct] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  if (!allowed.includes('decide_escalation')) return null;

  async function decide() {
    const checked = outcomeBody(outcome, pct);
    if (!checked.ok) {
      setError(checked.error);
      document
        .getElementById(checked.field === 'pct' ? 'damage-cases-ceo-pct' : 'damage-cases-ceo-debit_note')
        ?.focus();
      return;
    }
    if (!reason.trim()) {
      setError(t('damageCases.reasonRequired'));
      reasonRef.current?.focus();
      return;
    }
    setError('');
    await run('decide_escalation', { outcome, ...checked.body, reason: reason.trim() });
  }

  return (
    <section className="edge-card damage-panel" aria-labelledby="damage-cases-ceo-heading">
      <h3 id="damage-cases-ceo-heading">{t('damageCases.ceoTitle')}</h3>
      <dl className="base-facts">
        <Fact label="damageCases.qcPosition" value={outcomeText(report.qc_key_outcome, report.qc_key_price_reduction_pct)} />
        <Fact
          label="damageCases.financePosition"
          value={outcomeText(report.finance_key_outcome, report.finance_key_price_reduction_pct)}
        />
      </dl>
      <div className="damage-action-form">
        <OutcomeChoice
          idPrefix="damage-cases-ceo"
          legend="damageCases.outcomeLegend"
          outcome={outcome}
          onOutcome={setOutcome}
          pct={pct}
          onPct={setPct}
          busy={busy}
        />
        <label htmlFor="damage-cases-ceo-reason">{t('damageCases.reasonLabel')}</label>
        <textarea
          id="damage-cases-ceo-reason"
          ref={reasonRef}
          required
          rows={2}
          maxLength={MAX_REASON_LENGTH}
          value={reason}
          disabled={busy}
          onChange={(event) => setReason(event.target.value)}
        />
        <FieldError id="damage-cases-ceo-error" text={error} />
        <div className="edge-actions">
          <ActionButton action="decide_escalation" inFlight={inFlight} busy={busy} onClick={() => void decide()}>
            {t('damageCases.recordCeoDecision')}
          </ActionButton>
        </div>
      </div>
    </section>
  );
}

function OutcomeCard({ report, allowed, busy, inFlight, run }: PanelProps) {
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const refField = useRef<HTMLInputElement>(null);
  const canRecord = allowed.includes('record_outcome');
  if (!canRecord && report.status !== 'closed') return null;

  async function record() {
    const value = ref.trim();
    if (!value || value.length > MAX_ERP_REF_LENGTH) {
      setError(t('damageCases.erpRefRequired'));
      refField.current?.focus();
      return;
    }
    setError('');
    await run('record_outcome', { erp_document_ref_ext: value, ...(note.trim() ? { note: note.trim() } : {}) });
  }

  return (
    <section className="edge-card damage-panel" aria-labelledby="damage-cases-outcome-heading">
      <h3 id="damage-cases-outcome-heading">{t('damageCases.outcomeTitle')}</h3>
      {report.status === 'closed' ? (
        <p>{fill('damageCases.closedWithRef', { ref: report.erp_document_ref_ext ?? '-' })}</p>
      ) : null}
      {canRecord ? (
        <div className="damage-action-form">
          <label htmlFor="damage-cases-erp-ref">{t('damageCases.erpRefLabel')}</label>
          <input
            id="damage-cases-erp-ref"
            ref={refField}
            required
            autoComplete="off"
            maxLength={MAX_ERP_REF_LENGTH}
            value={ref}
            disabled={busy}
            onChange={(event) => setRef(event.target.value)}
          />
          <label htmlFor="damage-cases-outcome-note">{t('damageCases.noteLabel')}</label>
          <textarea
            id="damage-cases-outcome-note"
            rows={2}
            maxLength={MAX_REASON_LENGTH}
            value={note}
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
          />
          <FieldError id="damage-cases-outcome-error" text={error} />
          <div className="edge-actions">
            <ActionButton action="record_outcome" inFlight={inFlight} busy={busy} onClick={() => void record()}>
              {t('damageCases.recordAndClose')}
            </ActionButton>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// --------------------------------------------------------------------------------------------
// Photo
// --------------------------------------------------------------------------------------------

function CasePhoto({ report }: { report: DamageReport }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const id = report.photo_attachment_id ?? null;
  const stored = report.photo_status === 'stored';

  useEffect(() => {
    if (!id || !stored) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setFailed(false);
    void (async () => {
      try {
        const response = await authorizedFetch(`/api/v1/attachments/${encodeURIComponent(id)}`, {
          credentials: 'include',
        });
        if (!response.ok) throw new Error(String(response.status));
        const blob = await response.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [id, stored]);

  if (!id) return <p>{t('damageCases.noPhoto')}</p>;
  if (!stored) return <p>{t('damageCases.photoPending')}</p>;
  if (failed) return <p>{t('damageCases.photoUnavailable')}</p>;
  if (!url) return <p>{t('damageCases.photoLoading')}</p>;
  return <img className="damage-photo" src={url} alt={t('damageCases.photoAlt')} />;
}

// --------------------------------------------------------------------------------------------
// The screen
// --------------------------------------------------------------------------------------------

/**
 * Story 8.9 (Task 10, Tables 11 and 14): the damage cases workbench for QC, stores, finance and the
 * CEO. List and case side by side on a wide pointer, stacked on touch. Online only. Every action
 * panel renders only when the server named it in `allowed_actions`; the API decides, the screen
 * obeys (D11). After an action the case refetches quietly and focus returns to its header.
 */
export function DamageCases({ online, userId }: DamageCasesProps) {
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ kind: 'none' });
  const [inFlight, setInFlight] = useState<DamageActionName | null>(null);
  const [notice, setNotice] = useState('');
  const [version, setVersion] = useState(0);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const listReady = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeading = useRef(false);
  // One idempotency key per action attempt, reused until the server answers definitively.
  const attemptKeys = useRef(new Map<string, string>());
  // A same-tick double click must not post twice (state disables the buttons only after render).
  const actionInFlight = useRef(false);

  useEffect(() => {
    setSelectedId(readCaseParam());
    const onPop = () => setSelectedId(readCaseParam());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const loadList = useCallback(async () => {
    const sequence = ++listSequence.current;
    const quiet = listReady.current;
    if (!online) {
      listReady.current = false;
      setList({ kind: 'needs-connection' });
      return;
    }
    if (!quiet) setList({ kind: 'loading' });
    try {
      const response = await authorizedFetch(
        `/api/v1/damage-reports?view=workbench&limit=${WORKBENCH_LIMIT}`,
        { credentials: 'include' },
      );
      if (sequence !== listSequence.current) return;
      if (response.status === 403) {
        listReady.current = false;
        setList({ kind: 'no-access' });
        return;
      }
      if (!response.ok) {
        if (!quiet) setList({ kind: 'needs-connection' });
        return;
      }
      const body = (await response.json()) as { reports?: unknown };
      if (sequence !== listSequence.current) return;
      listReady.current = true;
      setList({
        kind: 'ready',
        reports: Array.isArray(body.reports) ? body.reports.filter(isDamageReport) : [],
      });
    } catch {
      if (sequence === listSequence.current && !quiet) setList({ kind: 'needs-connection' });
    }
  }, [online]);

  const loadDetail = useCallback(
    async (id: string, quiet: boolean) => {
      const sequence = ++detailSequence.current;
      if (!online) return;
      if (!quiet) setDetail({ kind: 'loading' });
      try {
        const response = await authorizedFetch(`/api/v1/damage-reports/${encodeURIComponent(id)}`, {
          credentials: 'include',
        });
        if (sequence !== detailSequence.current) return;
        if (!response.ok) {
          if (quiet) return;
          setDetail({
            kind: 'message',
            text:
              response.status === 404
                ? t('damageCases.caseNotFound')
                : response.status === 403
                  ? t('damageCases.caseNoAccess')
                  : t('damageCases.needsConnection'),
          });
          return;
        }
        const body = (await response.json()) as {
          report?: unknown;
          allowed_actions?: unknown;
          history?: unknown;
        };
        if (sequence !== detailSequence.current) return;
        if (!isDamageReport(body.report)) {
          if (!quiet) setDetail({ kind: 'message', text: t('damageCases.caseNotFound') });
          return;
        }
        const allowed = Array.isArray(body.allowed_actions)
          ? body.allowed_actions.filter((name): name is string => typeof name === 'string')
          : [];
        const history = Array.isArray(body.history)
          ? body.history
              .filter(isHistoryEntry)
              .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
          : [];
        setDetail({ kind: 'ready', report: body.report, allowed, history });
      } catch {
        if (sequence === detailSequence.current && !quiet) {
          setDetail({ kind: 'message', text: t('damageCases.needsConnection') });
        }
      }
    },
    [online],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId, false);
    else setDetail({ kind: 'none' });
  }, [selectedId, loadDetail]);

  // Focus the case header once a newly selected case, or a case just acted on, has rendered.
  useEffect(() => {
    if (focusHeading.current && (detail.kind === 'ready' || detail.kind === 'message')) {
      focusHeading.current = false;
      headingRef.current?.focus();
    }
  }, [detail]);

  const select = useCallback((id: string) => {
    window.history.pushState(null, '', `/damage/cases?case=${encodeURIComponent(id)}`);
    focusHeading.current = true;
    setNotice('');
    setSelectedId(id);
  }, []);

  const run: Run = useCallback(
    async (action: DamageActionName, body: Record<string, unknown>): Promise<boolean> => {
      if (actionInFlight.current || detail.kind !== 'ready') return false;
      actionInFlight.current = true;
      const reportId = detail.report.report_id;
      const slot = `${reportId}:${action}`;
      const idempotencyKey = attemptKeys.current.get(slot) ?? `edge-damage-${action}-${crypto.randomUUID()}`;
      attemptKeys.current.set(slot, idempotencyKey);
      setInFlight(action);
      setNotice('');
      let succeeded = false;
      try {
        const response = await authorizedFetch(actionPath(reportId, action), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, idempotency_key: idempotencyKey }),
        });
        const answer = (await response.json().catch(() => ({}))) as { error_code?: unknown; report?: unknown };
        attemptKeys.current.delete(slot);
        if (response.ok) {
          succeeded = true;
          setNotice(t(SUCCESS_LABEL[action]));
          setVersion((current) => current + 1);
          if (isDamageReport(answer.report)) {
            const report = answer.report;
            setDetail((current) => (current.kind === 'ready' ? { ...current, report } : current));
          }
          await loadDetail(reportId, true);
          void loadList();
        } else {
          const code = typeof answer.error_code === 'string' ? answer.error_code : '';
          const message = code ? errorMessage(code) : '';
          setNotice(message && message !== code ? message : t('damageCases.actionFailed'));
          // The case may have moved on under someone else: show what it is now.
          void loadDetail(reportId, true);
        }
      } catch {
        // No answer: keep the key so a retry cannot record the action twice.
        setNotice(t('damageCases.needsConnection'));
      } finally {
        actionInFlight.current = false;
        setInFlight(null);
        headingRef.current?.focus();
      }
      return succeeded;
    },
    [detail, loadDetail, loadList],
  );

  if (list.kind === 'needs-connection' || !online) {
    return (
      <section className="edge-card" id="damage-cases" aria-labelledby="damage-cases-connection-heading">
        <h2 id="damage-cases-connection-heading">{t('damageCases.title')}</h2>
        <p role="status">{t('damageCases.needsConnection')}</p>
        <button className="secondary-action" type="button" onClick={() => void loadList()}>
          {t('damageCases.checkConnection')}
        </button>
      </section>
    );
  }

  if (list.kind === 'no-access') {
    return (
      <section className="edge-card" id="damage-cases" aria-labelledby="damage-cases-no-access-heading">
        <h2 id="damage-cases-no-access-heading">{t('damageCases.title')}</h2>
        <p role="status">{t('damageCases.noAccess')}</p>
      </section>
    );
  }

  const loading = list.kind === 'loading';
  const today = todayIst();
  const groups = list.kind === 'ready' ? groupWorkbench(list.reports, userId, today) : [];
  const nonEmpty = groups.filter((entry) => entry.reports.length > 0);
  const busy = inFlight !== null;

  return (
    <div className="damage-cases" id="damage-cases" aria-busy={loading}>
      <h2 className="base-screen-title">{t('damageCases.title')}</h2>
      {loading || notice ? (
        <p className="base-notice" role="status" aria-live="polite" aria-label={t('damageCases.liveLabel')}>
          {loading ? t('damageCases.loading') : notice}
        </p>
      ) : null}
      <div className="damage-cases-layout">
        <div className="damage-cases-list">
          {!loading && nonEmpty.length === 0 ? (
            <section className="edge-card" aria-labelledby="damage-cases-empty-heading">
              <h3 id="damage-cases-empty-heading">{t('damageCases.emptyTitle')}</h3>
              <p>{t('damageCases.empty')}</p>
            </section>
          ) : null}
          {nonEmpty.map(({ group, reports }) => (
            <section
              key={group}
              className="edge-card"
              aria-labelledby={`damage-cases-group-${group}`}
            >
              <h3 id={`damage-cases-group-${group}`}>{t(GROUP_LABEL[group])}</h3>
              <ul className="base-list">
                {reports.map((report) => (
                  <li key={report.report_id} className="base-card base-card-stacked">
                    <a
                      className="damage-case-link"
                      href={`/damage/cases?case=${encodeURIComponent(report.report_id)}`}
                      aria-current={report.report_id === selectedId ? 'true' : undefined}
                      onClick={(event) => {
                        event.preventDefault();
                        select(report.report_id);
                      }}
                    >
                      {caseTitle(report)}
                    </a>
                    <span className="damage-card-facts">
                      <span className="state-pill">
                        {STATUS_LABEL[report.status] ? t(STATUS_LABEL[report.status]!) : report.status}
                      </span>
                      {group === 'units_to_move' && isExternalCheckOverdue(report, today) ? (
                        <span className="state-pill state-pill-err">
                          {fill('damageCases.returnOverdue', {
                            date: report.external_expected_return_date ?? '-',
                          })}
                        </span>
                      ) : null}
                      <span>{formatDateTime(report.reported_at)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="damage-cases-detail">
          {detail.kind === 'none' ? (
            <section className="edge-card" aria-labelledby="damage-cases-pick-heading">
              <h3 id="damage-cases-pick-heading">{t('damageCases.pickTitle')}</h3>
              <p>{t('damageCases.pickBody')}</p>
            </section>
          ) : detail.kind === 'loading' ? (
            <section className="edge-card" aria-labelledby="damage-cases-case-heading">
              <h3 id="damage-cases-case-heading" ref={headingRef} tabIndex={-1}>
                {t('damageCases.caseLoading')}
              </h3>
            </section>
          ) : detail.kind === 'message' ? (
            <section className="edge-card" aria-labelledby="damage-cases-case-heading">
              <h3 id="damage-cases-case-heading" ref={headingRef} tabIndex={-1}>
                {t('damageCases.caseTitle')}
              </h3>
              <p role="status">{detail.text}</p>
            </section>
          ) : (
            <CaseDetail
              key={`${detail.report.report_id}:${version}`}
              report={detail.report}
              allowed={detail.allowed}
              history={detail.history}
              busy={busy}
              inFlight={inFlight}
              run={run}
              headingRef={headingRef}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function CaseDetail({
  report,
  allowed,
  history,
  busy,
  inFlight,
  run,
  headingRef,
}: PanelProps & {
  history: DamageHistoryEntry[];
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const reportedEntry = history.find((entry) => entry.action === 'reported');
  const reporter =
    report.source === 'receipt'
      ? fill('damageCases.foundAtReceipt', { line: report.source_grn_line_id ?? '-' })
      : fill(reportedEntry?.actor_role ? 'damageCases.reportedByRole' : 'damageCases.reportedBy', {
          name: report.reporter_display_name ?? '-',
          role: reportedEntry?.actor_role ?? '',
        });
  const reason = report.reason_code
    ? REASON_LABEL[report.reason_code]
      ? t(REASON_LABEL[report.reason_code]!)
      : report.reason_code
    : '-';
  const panels = panelsFor(allowed);
  const props: PanelProps = { report, allowed, busy, inFlight, run };
  return (
    <div className="damage-case">
      <section className="edge-card" aria-labelledby="damage-cases-case-heading">
        <h3 id="damage-cases-case-heading" ref={headingRef} tabIndex={-1}>
          {caseTitle(report)}
        </h3>
        <dl className="base-facts">
          <Fact label="damageCases.statusLabel" value={STATUS_LABEL[report.status] ? t(STATUS_LABEL[report.status]!) : report.status} />
          <Fact label="damageCases.lotLabel" value={report.lot_number ?? '-'} />
          <Fact label="damageCases.whereLabel" value={report.bin_code ?? t('damageCases.inUse')} />
          <Fact label="damageCases.reasonShown" value={report.reason_note ? `${reason}: ${report.reason_note}` : reason} />
          <Fact label="damageCases.reportedAt" value={formatDateTime(report.reported_at)} />
        </dl>
        <p>{reporter}</p>
        {report.replacement_indent_number ? (
          <p>{fill('damageCases.replacementRaised', { number: report.replacement_indent_number })}</p>
        ) : report.replacement_indent_id ? (
          <p>{t('damageCases.replacementPending')}</p>
        ) : null}
        <CasePhoto report={report} />
      </section>
      <HoldScopeCard {...props} />
      <CustodyCard {...props} />
      <InspectionCard {...props} />
      <ConcurrenceCard {...props} />
      {panels.includes('escalation') ? <EscalationCard {...props} /> : null}
      <OutcomeCard {...props} />
      <section className="edge-card" aria-labelledby="damage-cases-history-heading">
        <h3 id="damage-cases-history-heading">{t('damageCases.historyTitle')}</h3>
        {history.length === 0 ? (
          <p>{t('damageCases.historyEmpty')}</p>
        ) : (
          <ol className="base-list">
            {history.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="base-card">
                <span className="base-card-title">
                  {HISTORY_LABEL[entry.action] ? t(HISTORY_LABEL[entry.action]!) : entry.action}
                </span>
                <span>
                  {fill('damageCases.historyWho', {
                    name: entry.actor_display_name ?? '-',
                    role: entry.actor_role ?? '-',
                    when: formatDateTime(entry.at),
                  })}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
