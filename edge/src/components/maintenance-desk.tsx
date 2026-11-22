'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { t, errorMessage, formatDateTime, type MessageKey } from '../i18n/locale';
import { authorizedFetch } from '../session/api-fetch';
import { useDeviceClass } from '../lib/use-device-class';
import {
  DESK_LIST_LIMIT,
  GROUP_ORDER,
  MAX_RESOLUTION_NOTE,
  SIGN_OFF_TICKS,
  attentionCounts,
  canReject,
  canResolveConflict,
  canSign,
  classifyBoard,
  countLabel,
  disabledReason,
  firstWarrantyCard,
  hitListLimit,
  isWarrantyOpen,
  isWarrantyUnknown,
  priorityLabel,
  type AssetStatusRow,
  type DeskCard,
  type FaultRow,
  type GroupId,
  type OverrideRow,
  type OverrideState,
  type WorkOrderRow,
} from './maintenance-desk-model';

/**
 * Story 7.11: the maintenance supervisor desk. A five-group board, fault triage, warranty override,
 * return-to-service sign-off and the sync-conflict panel. Online only: every action is a direct
 * API call, nothing is written to the outbox, and the server decides every authority question.
 */

export interface MaintenanceDeskProps {
  online: boolean;
  ready: boolean;
}

interface ConflictRow {
  conflict_id: string;
  stream_id: string;
  reason: string;
  conflicting_event_type: string;
  raised_at: string;
}

interface Board {
  faults: FaultRow[];
  workOrders: WorkOrderRow[];
  statuses: AssetStatusRow[];
  conflicts: ConflictRow[];
  reasonCodes: string[];
  overrides: Map<string, OverrideState>;
  limited: boolean;
  /** Areas whose read failed; the board shows what loaded (or the last good data) beside a notice. */
  failed: MessageKey[];
}

interface Notice {
  text: string;
  /** The card's group when the action ran; the notice is dropped once the card leaves it. */
  group?: GroupId;
}

type LoadState =
  { kind: 'loading' } | { kind: 'ready' } | { kind: 'needs-connection' } | { kind: 'no-access' };

// Completed work orders are read per out-of-service asset (the list is ordered by due date and
// capped, so one global read could cut off the newest completions).
const WORK_ORDER_STATUSES = ['open', 'overdue', 'in_progress', 'on_hold'] as const;
const RESOLUTION_CODES = ['discarded', 'reapplied_centrally'] as const;
const DESK_ERRORS: Record<string, MessageKey> = {
  APPROVAL_UNRESOLVED: 'maintenanceDesk.errors.APPROVAL_UNRESOLVED',
  INVALID_STATUS_TRANSITION: 'maintenanceDesk.errors.INVALID_STATUS_TRANSITION',
  ASSET_NOT_FOUND: 'maintenanceDesk.errors.ASSET_NOT_FOUND',
};

async function getJson(
  path: string,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  try {
    const response = await authorizedFetch(path);
    if (!response.ok) return { status: response.status, body: null };
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } catch {
    return { status: 0, body: null };
  }
}

async function readOverride(workOrderId: string): Promise<OverrideState> {
  const res = await getJson(`/api/v1/maintenance/work-orders/${workOrderId}/warranty-overrides`);
  return res.body ? ((res.body['override'] as OverrideRow | null) ?? null) : 'error';
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error_code?: unknown };
    if (typeof body.error_code !== 'string') return t('maintenanceDesk.commandFailed');
    const key = DESK_ERRORS[body.error_code];
    return key ? t(key) : errorMessage(body.error_code);
  } catch {
    return t('maintenanceDesk.commandFailed');
  }
}

export function MaintenanceDesk({ online, ready }: MaintenanceDeskProps) {
  const deviceClass = useDeviceClass();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [board, setBoard] = useState<Board | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const conflictsButton = useRef<HTMLButtonElement | null>(null);
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    if (!online) return;
    const sequence = ++loadSequence.current;
    try {
      const q = `limit=${DESK_LIST_LIMIT}`;
      const results = await Promise.all([
        getJson(`/api/v1/maintenance/fault-reports?status=reported&${q}`),
        ...WORK_ORDER_STATUSES.map((s) =>
          getJson(`/api/v1/maintenance/work-orders?status=${s}&${q}`),
        ),
        ...(['breakdown', 'maintenance'] as const).map((s) =>
          getJson(`/api/v1/maintenance/asset-status?status=${s}&${q}`),
        ),
        getJson(`/api/v1/maintenance/sync-conflicts?status=open&${q}`),
        getJson('/api/v1/maintenance/warranty-override-reason-codes'),
      ]);
      if (sequence !== loadSequence.current) return;
      if (results.some((r) => r.status === 403)) {
        setState({ kind: 'no-access' });
        return;
      }
      if (results.some((r) => r.body === null)) {
        setState((s) => (s.kind === 'ready' ? s : { kind: 'needs-connection' }));
        return;
      }
      const [faultRes, ...rest] = results as Array<{ body: Record<string, unknown> }>;
      const woRes = rest.slice(0, WORK_ORDER_STATUSES.length);
      const stRes = rest.slice(WORK_ORDER_STATUSES.length, WORK_ORDER_STATUSES.length + 2);
      const conflictRes = rest[WORK_ORDER_STATUSES.length + 2]!;
      const reasonRes = rest[WORK_ORDER_STATUSES.length + 3]!;
      const faults = (faultRes!.body.fault_reports ?? []) as FaultRow[];
      const workOrders = woRes.flatMap((r) => (r.body.work_orders ?? []) as WorkOrderRow[]);
      const statuses = stRes.flatMap((r) => (r.body.asset_statuses ?? []) as AssetStatusRow[]);
      const conflicts = (conflictRes.body.conflicts ?? []) as ConflictRow[];
      // One override read per flagged, uncompleted work order (pilot-sized board, Design Notes).
      const overrides = new Map<string, OverrideRow | null>();
      await Promise.all(
        workOrders
          .filter((w) => w.warranty_flagged && w.status !== 'completed')
          .map(async (w) => {
            const res = await getJson(
              `/api/v1/maintenance/work-orders/${w.work_order_id}/warranty-overrides`,
            );
            if (res.body)
              overrides.set(w.work_order_id, (res.body['override'] as OverrideRow | null) ?? null);
          }),
      );
      if (sequence !== loadSequence.current) return;
      setBoard({
        faults,
        workOrders,
        statuses,
        conflicts,
        reasonCodes: (reasonRes.body.reason_codes ?? []) as string[],
        overrides,
        limited: hitListLimit([
          faults.length,
          conflicts.length,
          ...woRes.map((r) => ((r.body.work_orders ?? []) as unknown[]).length),
          ...stRes.map((r) => ((r.body.asset_statuses ?? []) as unknown[]).length),
        ]),
      });
      setState({ kind: 'ready' });
    } catch {
      setState((s) => (s.kind === 'ready' ? s : { kind: 'needs-connection' }));
    }
  }, [online]);

  useEffect(() => {
    if (ready && online) void load();
  }, [ready, online, load]);

  async function run(
    key: string,
    path: string,
    body: Record<string, unknown>,
    onOk: (json: Record<string, unknown>) => string,
  ) {
    setBusy(true);
    setErrors((e) => ({ ...e, [key]: '' }));
    try {
      const response = await authorizedFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        const text = onOk((await response.json()) as Record<string, unknown>);
        setNotice((n) => ({ ...n, [key]: text }));
        setAnnouncement(text);
        await load();
        return;
      }
      const message = await readError(response);
      setErrors((e) => ({ ...e, [key]: message }));
      if (response.status === 409 || response.status === 404) void load();
    } catch {
      setErrors((e) => ({ ...e, [key]: t('maintenanceDesk.commandFailed') }));
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return <p className="stores-status">{t('maintenanceDesk.loading')}</p>;
  if (state.kind === 'no-access') {
    return (
      <section className="edge-card" role="alert" aria-labelledby="desk-denied-heading">
        <h2 id="desk-denied-heading">{t('nav.deniedTitle')}</h2>
        <p>{t('nav.deniedBody')}</p>
        <a className="secondary-action" href="/">
          {t('nav.home')}
        </a>
      </section>
    );
  }
  if (!board) {
    return (
      <div id="maintenance-desk" className="floor-screen" data-device-class={deviceClass}>
        {state.kind === 'loading' && online ? (
          <p className="stores-status">{t('maintenanceDesk.loading')}</p>
        ) : (
          <section className="edge-card" role="alert">
            <p>{t('maintenanceDesk.needsConnection')}</p>
            <button className="secondary-action" type="button" onClick={() => void load()}>
              {t('maintenanceDesk.retry')}
            </button>
          </section>
        )}
      </div>
    );
  }

  const groups = classifyBoard(board.faults, board.workOrders, board.statuses);
  const counts = attentionCounts(groups, board.conflicts.length, board.overrides);
  const reason = disabledReason(online, busy);
  const columns = deviceClass === 'desktop' || deviceClass === 'desktop-touch';

  function focusCard(card: DeskCard | undefined, none: MessageKey) {
    if (!card) {
      setAnnouncement(t(none));
      return;
    }
    const el = document.getElementById(`desk-card-${card.key.replace(':', '-')}`);
    el?.scrollIntoView?.({ block: 'center' });
    el?.focus();
  }

  return (
    <div id="maintenance-desk" className="floor-screen" data-device-class={deviceClass}>
      {!online ? (
        <section className="edge-card" role="status" aria-live="polite">
          <h2>{t('maintenanceDesk.offlineBanner')}</h2>
          <p>{t('maintenanceDesk.offlineBody')}</p>
        </section>
      ) : null}
      <p role="status" aria-live="polite" className="stores-announcement">
        {announcement}
      </p>
      {board.limited ? <p className="stores-status">{t('maintenanceDesk.limit')}</p> : null}
      <div className="desk-attention">
        <button
          className="secondary-action"
          type="button"
          onClick={() => focusCard(groups.done[0], 'maintenanceDesk.attention.nothingAwaiting')}
        >
          {t('maintenanceDesk.attention.awaiting').replace(
            '{count}',
            String(counts.awaitingSignature),
          )}
        </button>
        <button
          ref={conflictsButton}
          className="secondary-action"
          type="button"
          aria-expanded={conflictsOpen}
          onClick={() => setConflictsOpen(true)}
        >
          {t('maintenanceDesk.attention.conflicts').replace(
            '{count}',
            String(counts.syncConflicts),
          )}
        </button>
        <button
          className="secondary-action"
          type="button"
          onClick={() =>
            focusCard(
              firstWarrantyCard(groups, board.overrides) ?? undefined,
              'maintenanceDesk.attention.noWarranty',
            )
          }
        >
          {t('maintenanceDesk.attention.warranty').replace(
            '{count}',
            String(counts.warrantyFlagged),
          )}
        </button>
      </div>
      {conflictsOpen ? (
        <ConflictPanel
          conflicts={board.conflicts}
          reason={reason}
          errors={errors}
          notice={notice}
          onClose={() => {
            setConflictsOpen(false);
            // Focus returns to the control that opened the panel.
            setTimeout(() => conflictsButton.current?.focus(), 0);
          }}
          onResolve={(id, code, note) =>
            void run(
              `conflict:${id}`,
              `/api/v1/maintenance/sync-conflicts/${id}/resolve`,
              { resolution_code: code, ...(note ? { resolution_note: note } : {}) },
              () => t('maintenanceDesk.conflict.resolved'),
            )
          }
        />
      ) : null}
      <div className={columns ? 'desk-board desk-board-columns' : 'desk-board desk-board-list'}>
        {GROUP_ORDER.map((group) => (
          <section
            key={group}
            className="stores-group"
            aria-labelledby={`desk-group-${group}`}
            data-group={group}
          >
            <h2 id={`desk-group-${group}`}>
              {t(`maintenanceDesk.group.${group}` as MessageKey).replace(
                '{count}',
                String(groups[group].length),
              )}
            </h2>
            {groups[group].length === 0 ? (
              <p className="stores-status">{t('maintenanceDesk.empty')}</p>
            ) : (
              <ul className="stores-cards">
                {groups[group].map((card) => (
                  <DeskCardView
                    key={card.key}
                    card={card}
                    group={group}
                    board={board}
                    reason={reason}
                    error={errors[card.key] ?? ''}
                    notice={notice[card.key] ?? ''}
                    onAccept={() =>
                      void run(
                        card.key,
                        `/api/v1/maintenance/fault-reports/${card.id}/accept`,
                        {},
                        (json) => {
                          const wo = json['work_order'] as { priority?: string | null } | null;
                          return t('maintenanceDesk.triage.created').replace(
                            '{priority}',
                            priorityLabel((wo?.priority as WorkOrderRow['priority']) ?? null) ??
                              t('maintenanceDesk.pill.unset'),
                          );
                        },
                      )
                    }
                    onReject={(text) =>
                      void run(
                        card.key,
                        `/api/v1/maintenance/fault-reports/${card.id}/reject`,
                        { rejection_reason: text.trim() },
                        () => t('maintenanceDesk.triage.rejected'),
                      )
                    }
                    onOverride={(code) =>
                      void run(
                        card.key,
                        `/api/v1/maintenance/work-orders/${card.id}/warranty-overrides`,
                        { reason_code: code },
                        () => t('maintenanceDesk.warranty.recorded'),
                      )
                    }
                    onSign={() =>
                      card.kind === 'work-order' &&
                      void run(
                        card.key,
                        `/api/v1/maintenance/assets/${card.workOrder.asset_id}/status`,
                        { new_status: 'running' },
                        () => t('maintenanceDesk.sign.returned'),
                      )
                    }
                  />
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

function reasonText(reason: 'offline' | 'busy' | null): string {
  return reason === 'offline'
    ? t('maintenanceDesk.disabled.offline')
    : reason === 'busy'
      ? t('maintenanceDesk.disabled.busy')
      : '';
}

interface CardProps {
  card: DeskCard;
  group: (typeof GROUP_ORDER)[number];
  board: Board;
  reason: 'offline' | 'busy' | null;
  error: string;
  notice: string;
  onAccept: () => void;
  onReject: (text: string) => void;
  onOverride: (code: string) => void;
  onSign: () => void;
}

function DeskCardView(props: CardProps) {
  const { card, group, board, reason, error, notice } = props;
  const domId = `desk-card-${card.key.replace(':', '-')}`;
  const [rejectText, setRejectText] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [overrideCode, setOverrideCode] = useState<string | null>(null);
  const [ticks, setTicks] = useState<boolean[]>(Array(SIGN_OFF_TICKS).fill(false));
  const workOrder = card.kind === 'work-order' ? card.workOrder : null;
  const override = workOrder ? board.overrides.get(card.id) : undefined;
  const warrantyOpen = isWarrantyOpen(card, board.overrides);
  const priority = workOrder ? priorityLabel(workOrder.priority) : null;
  const why = reasonText(reason);
  const whyId = `${domId}-why`;
  const blocked = reason !== null;
  const returned = Boolean(notice) && group === 'done';

  return (
    <li
      id={domId}
      className="stores-card desk-card"
      tabIndex={-1}
      data-work-order-id={workOrder ? card.id : undefined}
      data-fault-report-id={card.kind === 'fault' ? card.id : undefined}
    >
      <div>
        <h3>{card.title}</h3>
        {card.kind === 'fault' ? <p>{card.fault.description}</p> : null}
        {workOrder?.status === 'on_hold' && workOrder.status_note ? (
          <p>
            <span className="state-pill state-pill-warn">{workOrder.status_note}</span>
          </p>
        ) : null}
        <p className="desk-pills">
          {card.kind === 'fault' ? (
            <span className="state-pill">{t('maintenanceDesk.pill.unset')}</span>
          ) : (
            <span className="state-pill">{priority ?? t('maintenanceDesk.pill.unset')}</span>
          )}
          {card.kind === 'fault' && card.fault.safety_flag ? (
            <span className="state-pill state-pill-err">{t('maintenanceDesk.pill.safety')}</span>
          ) : null}
          {warrantyOpen ? (
            <span className="state-pill state-pill-warn">{t('maintenanceDesk.pill.warranty')}</span>
          ) : null}
          {override ? (
            <span className="state-pill state-pill-ok">{t('maintenanceDesk.pill.overridden')}</span>
          ) : null}
          {group === 'done' && !returned ? (
            <span className="state-pill state-pill-warn">{t('maintenanceDesk.pill.awaiting')}</span>
          ) : null}
        </p>
        {override ? (
          <p>
            {t('maintenanceDesk.warranty.by')
              .replace('{who}', override.overridden_by)
              .replace('{time}', formatDateTime(override.overridden_at))}
          </p>
        ) : null}
      </div>

      {card.kind === 'fault' ? (
        <div className="desk-actions">
          <button
            className="primary-action"
            type="button"
            disabled={blocked}
            onClick={props.onAccept}
          >
            {t('maintenanceDesk.triage.create')}
          </button>
          {rejecting ? (
            <div>
              <label htmlFor={`${domId}-reject`}>{t('maintenanceDesk.triage.reasonLabel')}</label>
              <textarea
                id={`${domId}-reject`}
                value={rejectText}
                maxLength={500}
                disabled={blocked}
                onChange={(e) => setRejectText(e.target.value)}
              />
              <button
                className="secondary-action"
                type="button"
                disabled={blocked || !canReject(rejectText)}
                onClick={() => props.onReject(rejectText)}
              >
                {t('maintenanceDesk.triage.rejectConfirm')}
              </button>
            </div>
          ) : (
            <button
              className="secondary-action"
              type="button"
              disabled={blocked}
              onClick={() => setRejecting(true)}
            >
              {t('maintenanceDesk.triage.reject')}
            </button>
          )}
        </div>
      ) : null}

      {warrantyOpen ? (
        <fieldset className="desk-actions" disabled={blocked}>
          <legend>{t('maintenanceDesk.warranty.reasonLabel')}</legend>
          {board.reasonCodes.map((code) => (
            <label key={code} className="desk-tile">
              <input
                type="radio"
                name={`${domId}-reason`}
                checked={overrideCode === code}
                onChange={() => setOverrideCode(code)}
              />
              <span>{code}</span>
            </label>
          ))}
          <button
            className="secondary-action"
            type="button"
            disabled={blocked || overrideCode === null}
            onClick={() => overrideCode && props.onOverride(overrideCode)}
          >
            {t('maintenanceDesk.warranty.action')}
          </button>
        </fieldset>
      ) : null}

      {group === 'done' && !returned ? (
        <fieldset className="desk-actions" disabled={blocked}>
          <legend>{t('maintenanceDesk.sign.legend')}</legend>
          {ticks.map((checked, index) => (
            <label key={index} className="desk-tile">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) =>
                  setTicks((current) => current.map((v, i) => (i === index ? e.target.checked : v)))
                }
              />
              <span>{t(`maintenanceDesk.sign.tick${index}` as MessageKey)}</span>
            </label>
          ))}
          <button
            className="primary-action"
            type="button"
            disabled={blocked || !canSign(ticks)}
            onClick={props.onSign}
          >
            {t('maintenanceDesk.sign.action')}
          </button>
          {!canSign(ticks) ? (
            <p className="stores-status">{t('maintenanceDesk.sign.hint')}</p>
          ) : null}
        </fieldset>
      ) : null}

      {blocked && why ? (
        <p id={whyId} className="stores-status">
          {why}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </li>
  );
}

function ConflictPanel(props: {
  conflicts: ConflictRow[];
  reason: 'offline' | 'busy' | null;
  errors: Record<string, string>;
  notice: Record<string, string>;
  onClose: () => void;
  onResolve: (id: string, code: string, note: string) => void;
}) {
  const { conflicts, reason } = props;
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => headingRef.current?.focus(), []);
  return (
    <section
      className="edge-card desk-conflicts"
      aria-labelledby="desk-conflicts-heading"
      onKeyDown={(e) => {
        if (e.key === 'Escape') props.onClose();
      }}
    >
      <h2 id="desk-conflicts-heading" ref={headingRef} tabIndex={-1}>
        {t('maintenanceDesk.conflict.title')}
      </h2>
      {conflicts.length === 0 ? (
        <p className="stores-status">{t('maintenanceDesk.conflict.none')}</p>
      ) : (
        <ul className="stores-cards">
          {conflicts.map((c) => (
            <ConflictItem
              key={c.conflict_id}
              conflict={c}
              reason={reason}
              error={props.errors[`conflict:${c.conflict_id}`] ?? ''}
              onResolve={props.onResolve}
            />
          ))}
        </ul>
      )}
      <button className="secondary-action" type="button" onClick={props.onClose}>
        {t('maintenanceDesk.conflict.close')}
      </button>
    </section>
  );
}

function ConflictItem(props: {
  conflict: ConflictRow;
  reason: 'offline' | 'busy' | null;
  error: string;
  onResolve: (id: string, code: string, note: string) => void;
}) {
  const { conflict, reason } = props;
  const [code, setCode] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const blocked = reason !== null;
  const id = `desk-conflict-${conflict.conflict_id}`;
  return (
    <li className="stores-card">
      <div>
        <h3>{conflict.conflicting_event_type}</h3>
        <p>
          {conflict.reason} - {formatDateTime(conflict.raised_at)}
        </p>
        <fieldset disabled={blocked}>
          <legend>{t('maintenanceDesk.conflict.legend')}</legend>
          {RESOLUTION_CODES.map((c) => (
            <label key={c} className="desk-tile">
              <input
                type="radio"
                name={`${id}-code`}
                checked={code === c}
                onChange={() => setCode(c)}
              />
              <span>{t(`maintenanceDesk.conflict.code.${c}` as MessageKey)}</span>
            </label>
          ))}
        </fieldset>
        {code === 'reapplied_centrally' ? (
          <p className="stores-status">{t('maintenanceDesk.conflict.reappliedNote')}</p>
        ) : null}
        <label htmlFor={`${id}-note`}>{t('maintenanceDesk.conflict.noteLabel')}</label>
        <textarea
          id={`${id}-note`}
          value={note}
          maxLength={MAX_RESOLUTION_NOTE}
          disabled={blocked}
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          className="primary-action"
          type="button"
          disabled={blocked || !canResolveConflict(code, note)}
          onClick={() => code && props.onResolve(conflict.conflict_id, code, note.trim())}
        >
          {t('maintenanceDesk.conflict.resolve')}
        </button>
        {blocked ? <p className="stores-status">{reasonText(reason)}</p> : null}
        {props.error ? <p role="alert">{props.error}</p> : null}
      </div>
    </li>
  );
}
