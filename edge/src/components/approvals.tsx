'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { errorMessage, t, type MessageKey } from '../i18n/locale';
import { authorizedFetch } from '../session/api-fetch';
import { useDeviceClass } from '../lib/use-device-class';
import {
  ageOf,
  bandLine,
  doaNote,
  formatRupees,
  isApprovalRow,
  matchesSearch,
  mergeAll,
  roleLabel,
  routeChip,
  rowStatus,
  totalValue,
  type ApprovalLine,
  type ApprovalRow,
  type ApproverBand,
  type RowStatus,
  type Tab,
} from './approvals-model';

/**
 * Story 4.12 (AC 4 to AC 8): the approvals inbox and requisition approval detail. Online only
 * (D6): decisions are checked live, nothing is queued, and the last fetched data stays readable
 * offline with its time. The record is selected by `?indent=` (no dynamic segments, D7).
 */

type ListState =
  | { kind: 'loading' }
  | { kind: 'needs-connection' }
  | { kind: 'no-access' }
  | { kind: 'failed' }
  | {
      kind: 'ready';
      waiting: ApprovalRow[];
      decided: ApprovalRow[];
      bands: ApproverBand[];
      fetchedAt: string;
    };

interface DetailData {
  indent: { indent_id: string; indent_number_ext: string; status: string; created_at: string };
  lines: ApprovalLine[];
  requester_display_name: string | null;
  pending_for_me_line_ids: string[];
}

type DetailState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'no-access' }
  | { kind: 'ready'; data: DetailData; fetchedAt: string };

interface Confirmation {
  kind: 'approved' | 'rejected';
  at: string;
  who: string;
  reason: string;
}

const STATUS_KEY: Record<RowStatus, MessageKey> = {
  waiting: 'approvals.status.waiting',
  approved: 'approvals.status.approved',
  rejected: 'approvals.status.rejected',
};
const STATUS_PILL: Record<RowStatus, string> = {
  waiting: 'state-pill state-pill-warn',
  approved: 'state-pill state-pill-ok',
  rejected: 'state-pill state-pill-err',
};
const LINE_STATUS_KEY: Record<ApprovalLine['line_status'], MessageKey> = {
  pending: 'approvals.line.status.pending',
  approved: 'approvals.line.status.approved',
  rejected: 'approvals.line.status.rejected',
};
const AGE_KEY: Record<'m' | 'h' | 'd', MessageKey> = {
  m: 'approvals.age.m',
  h: 'approvals.age.h',
  d: 'approvals.age.d',
};

function readIndentParam(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('indent') ?? '';
}

function formatTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    );
  } catch {
    return iso;
  }
}

async function errorCodeOf(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error_code?: unknown };
    return typeof body.error_code === 'string' ? body.error_code : null;
  } catch {
    return null;
  }
}

export interface ApprovalsProps {
  online: boolean;
  /** Handheld detail is task mode: the shell hides the bottom nav for the pinned footer. */
  onTaskModeChange?: (on: boolean) => void;
}

export function Approvals({ online, onTaskModeChange }: ApprovalsProps) {
  const deviceClass = useDeviceClass();
  const handheld = deviceClass === 'handheld';
  const tableLayout = deviceClass === 'desktop' || deviceClass === 'desktop-touch';

  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [tab, setTab] = useState<Tab>('waiting');
  const [query, setQuery] = useState('');
  const [indentId, setIndentId] = useState('');
  const [detail, setDetail] = useState<DetailState>({ kind: 'idle' });
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const listSeq = useRef(0);
  const detailSeq = useRef(0);
  const busyRef = useRef(false);
  const confirmationRef = useRef<HTMLDivElement>(null);

  // Read `?indent=` after mount and on browser Back/Forward (never during render, Story 3.15).
  useEffect(() => {
    const onPop = () => setIndentId(readIndentParam());
    onPop();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Task mode (no bottom nav) only while the detail pane, with its Back button, is on screen: the
  // loading, failed and needs-connection cards below render no way out of their own.
  const taskMode = handheld && indentId !== '' && list.kind === 'ready';
  useEffect(() => {
    onTaskModeChange?.(taskMode);
  }, [taskMode, onTaskModeChange]);
  useEffect(() => () => onTaskModeChange?.(false), [onTaskModeChange]);

  const loadList = useCallback(async () => {
    const seq = ++listSeq.current;
    if (!online) {
      setList((current) => (current.kind === 'ready' ? current : { kind: 'needs-connection' }));
      return;
    }
    setList((current) => (current.kind === 'ready' ? current : { kind: 'loading' }));
    try {
      // shortcut: one page of 200 (the server cap) with no "more" row, so the tab counts stop at
      // 200; page the lists when an approver can hold more than that.
      const [waitingRes, decidedRes] = await Promise.all([
        authorizedFetch('/api/v1/indents?pending_for_me=true&limit=200'),
        authorizedFetch('/api/v1/indents?decided_by_me=true&limit=200'),
      ]);
      if (seq !== listSeq.current) return;
      if (waitingRes.status === 403 || decidedRes.status === 403) {
        setList({ kind: 'no-access' });
        return;
      }
      // Story 3.16 review: one failed read is a failure, never an empty inbox.
      if (!waitingRes.ok || !decidedRes.ok) {
        setList((current) => (current.kind === 'ready' ? current : { kind: 'failed' }));
        return;
      }
      const waitingBody = (await waitingRes.json()) as {
        indents?: unknown;
        approver_bands?: unknown;
      };
      const decidedBody = (await decidedRes.json()) as { indents?: unknown };
      if (seq !== listSeq.current) return;
      const rows = (v: unknown) => (Array.isArray(v) ? v.filter(isApprovalRow) : []);
      setList({
        kind: 'ready',
        waiting: rows(waitingBody.indents),
        decided: rows(decidedBody.indents),
        bands: Array.isArray(waitingBody.approver_bands)
          ? (waitingBody.approver_bands as ApproverBand[])
          : [],
        fetchedAt: new Date().toISOString(),
      });
    } catch {
      if (seq === listSeq.current) {
        setList((current) => (current.kind === 'ready' ? current : { kind: 'needs-connection' }));
      }
    }
  }, [online]);

  const loadDetail = useCallback(async () => {
    const seq = ++detailSeq.current;
    if (!indentId) {
      setDetail({ kind: 'idle' });
      return;
    }
    if (!online) return;
    setDetail((current) => (current.kind === 'ready' ? current : { kind: 'loading' }));
    try {
      const res = await authorizedFetch(`/api/v1/indents/${encodeURIComponent(indentId)}`);
      if (seq !== detailSeq.current) return;
      if (res.status === 403 || res.status === 404) {
        setDetail({ kind: 'no-access' });
        return;
      }
      if (!res.ok) {
        setDetail({ kind: 'failed' });
        return;
      }
      const data = (await res.json()) as DetailData;
      if (seq !== detailSeq.current) return;
      setDetail({ kind: 'ready', data, fetchedAt: new Date().toISOString() });
    } catch {
      if (seq === detailSeq.current) {
        setDetail((current) => (current.kind === 'ready' ? current : { kind: 'failed' }));
      }
    }
  }, [indentId, online]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // Story 3.15 review: a new selection resets every piece of screen state before loading.
  useEffect(() => {
    setDetail({ kind: 'idle' });
    setRejectOpen(false);
    setReason('');
    setError(null);
    setConfirmation(null);
  }, [indentId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    if (confirmation) confirmationRef.current?.focus();
  }, [confirmation]);

  const select = (id: string) => {
    window.history.pushState(
      null,
      '',
      id ? `/approvals?indent=${encodeURIComponent(id)}` : '/approvals',
    );
    setIndentId(id);
  };

  const decide = async (kind: 'approve' | 'reject') => {
    if (busyRef.current || detail.kind !== 'ready' || !online) return;
    const data = detail.data;
    const trimmed = reason.trim();
    if (kind === 'reject' && !trimmed) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await authorizedFetch(
        `/api/v1/indents/${encodeURIComponent(data.indent.indent_id)}/${kind}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            kind === 'approve'
              ? { line_ids: data.pending_for_me_line_ids }
              : { line_ids: data.pending_for_me_line_ids, rejection_reason: trimmed },
          ),
        },
      );
      // The approver picked another requisition while this was in flight: the answer belongs to
      // the one they left, so only the lists refresh and nothing is painted on the new selection.
      if (readIndentParam() !== indentId) {
        if (res.ok) void loadList();
        return;
      }
      if (res.ok) {
        setConfirmation({
          kind: kind === 'approve' ? 'approved' : 'rejected',
          at: new Date().toISOString(),
          who: data.requester_display_name ?? t('approvals.confirm.requester'),
          reason: trimmed,
        });
        setRejectOpen(false);
        setReason('');
        await Promise.all([loadList(), loadDetail()]);
        return;
      }
      const code = await errorCodeOf(res);
      setError(code ? errorMessage(code) : t('approvals.decisionFailed'));
      if (res.status === 409) await loadDetail();
    } catch {
      if (readIndentParam() === indentId) setError(t('approvals.decisionFailed'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const fetchedAt =
    detail.kind === 'ready' ? detail.fetchedAt : list.kind === 'ready' ? list.fetchedAt : null;
  const offlineBlock = !online ? (
    <div className="approvals-block" role="status">
      {t('approvals.offline').replace('{time}', fetchedAt ? formatTime(fetchedAt) : '-')}
    </div>
  ) : null;

  if (list.kind === 'no-access') {
    return (
      <section className="edge-card" role="alert" aria-labelledby="approvals-denied-heading">
        <h2 id="approvals-denied-heading">{t('nav.deniedTitle')}</h2>
        <p>{t('approvals.noAccess')}</p>
      </section>
    );
  }
  if (list.kind === 'needs-connection' || list.kind === 'failed') {
    return (
      <section className="edge-card" id="approvals" aria-labelledby="approvals-connection-heading">
        <h2 id="approvals-connection-heading">{t('approvals.title')}</h2>
        <p role="status">
          {t(list.kind === 'failed' ? 'approvals.failed' : 'approvals.needsConnection')}
        </p>
        <button className="secondary-action" type="button" onClick={() => void loadList()}>
          {t('approvals.checkConnection')}
        </button>
      </section>
    );
  }
  if (list.kind === 'loading') {
    return (
      <p className="edge-card" role="status">
        {t('approvals.loading')}
      </p>
    );
  }

  const all = mergeAll(list.waiting, list.decided);
  const tabRows = tab === 'waiting' ? list.waiting : tab === 'decided' ? list.decided : all;
  const shown = tabRows.filter((r) => matchesSearch(r, query));
  const band = bandLine(list.bands, {
    upTo: t('approvals.band.upTo'),
    above: t('approvals.band.above'),
  });
  const roleName = list.bands[0] ? roleLabel(list.bands[0].role) : t('approvals.empty.you');
  const now = Date.now();

  const statusPill = (status: RowStatus) => (
    <span className={STATUS_PILL[status]}>{t(STATUS_KEY[status])}</span>
  );
  const ageText = (createdAt: string) => {
    const age = ageOf(createdAt, now);
    return t(AGE_KEY[age.unit]).replace('{n}', String(age.n));
  };
  const amountText = (value: string | null) =>
    value === null ? '' : t('approvals.amount').replace('{amount}', formatRupees(value));

  const emptyState =
    shown.length > 0 ? null : query.trim() && tabRows.length > 0 ? (
      <div className="emptyst" role="status">
        <h3>{t('approvals.empty.noMatchTitle')}</h3>
        <p>{t('approvals.empty.noMatchBody')}</p>
        <button className="secondary-action" type="button" onClick={() => setQuery('')}>
          {t('approvals.empty.clear')}
        </button>
      </div>
    ) : tab === 'waiting' ? (
      <div className="emptyst" role="status">
        <h3>{t('approvals.empty.waitingTitle')}</h3>
        <p>
          {t('approvals.empty.waitingBody')
            .replace('{role}', roleName)
            .replace('{time}', formatTime(list.fetchedAt))}
        </p>
        <button className="secondary-action" type="button" onClick={() => setTab('decided')}>
          {t('approvals.empty.seeDecided')}
        </button>
      </div>
    ) : (
      <div className="emptyst" role="status">
        <h3>{t('approvals.empty.decidedTitle')}</h3>
      </div>
    );

  const listSection = (
    <section className="approvals-list" aria-labelledby="approvals-heading">
      <h2 id="approvals-heading" className="base-screen-title">
        {t('approvals.title')}
      </h2>
      {/* With a selection the detail pane carries the block; one status, announced once. */}
      {indentId ? null : offlineBlock}
      {band ? <p className="approvals-band">{band}</p> : null}
      <label className="approvals-search">
        <span>{t('approvals.search.label')}</span>
        <input
          type="search"
          value={query}
          placeholder={t('approvals.search.placeholder')}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="approvals-tabs" role="group" aria-label={t('approvals.tabs.label')}>
        {(['waiting', 'decided', 'all'] as const).map((key) => (
          <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}>
            {key === 'all'
              ? t('approvals.tab.all')
              : t(key === 'waiting' ? 'approvals.tab.waiting' : 'approvals.tab.decided').replace(
                  '{n}',
                  String(key === 'waiting' ? list.waiting.length : list.decided.length),
                )}
          </button>
        ))}
      </div>
      {emptyState ??
        (tableLayout ? (
          <div className="approvals-table-wrap">
            <table className="approvals-table">
              <caption>{t('approvals.table.caption').replace('{role}', roleName)}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('approvals.col.typeRef')}</th>
                  <th scope="col">{t('approvals.col.requestedBy')}</th>
                  <th scope="col" className="num">
                    {t('approvals.col.amount')}
                  </th>
                  <th scope="col">{t('approvals.col.age')}</th>
                  <th scope="col">{t('approvals.col.status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.indent_id} data-selected={row.indent_id === indentId}>
                    <td>
                      <button
                        type="button"
                        className="approvals-row-button"
                        aria-current={row.indent_id === indentId ? 'true' : undefined}
                        onClick={() => select(row.indent_id)}
                      >
                        <b>{row.indent_number_ext}</b>
                        <span>{t('approvals.type.requisition')}</span>
                      </button>
                    </td>
                    <td>{row.requester_display_name ?? ''}</td>
                    <td className="num">{amountText(row.estimated_value)}</td>
                    <td>{ageText(row.created_at)}</td>
                    <td>{statusPill(rowStatus(row))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ul className="approvals-cards">
            {shown.map((row) => (
              <li key={row.indent_id}>
                <button
                  type="button"
                  className="approvals-card"
                  aria-current={row.indent_id === indentId ? 'true' : undefined}
                  onClick={() => select(row.indent_id)}
                >
                  <span className="approvals-card-type">{t('approvals.type.requisition')}</span>
                  <span className="approvals-card-title">
                    <b>{row.indent_number_ext}</b> {amountText(row.estimated_value)}
                  </span>
                  <span>{row.line_skus.join(', ')}</span>
                  <span>
                    {row.requester_display_name ?? ''} - {ageText(row.created_at)}
                  </span>
                  {statusPill(rowStatus(row))}
                </button>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );

  const detailSection = (
    <section className="approvals-detail" aria-label={t('approvals.detail.label')}>
      {handheld ? (
        <button type="button" className="secondary-action" onClick={() => select('')}>
          {t('approvals.back')}
        </button>
      ) : null}
      {!indentId ? (
        <div className="emptyst">
          <h3>{t('approvals.detail.pick')}</h3>
          <p>{t('approvals.detail.pickBody')}</p>
        </div>
      ) : detail.kind === 'ready' ? (
        <DetailBody
          data={detail.data}
          online={online}
          busy={busy}
          handheld={handheld}
          rejectOpen={rejectOpen}
          reason={reason}
          error={error}
          confirmation={confirmation}
          confirmationRef={confirmationRef}
          offlineBlock={offlineBlock}
          onApprove={() => void decide('approve')}
          onReject={() => void decide('reject')}
          onRejectOpen={setRejectOpen}
          onReason={setReason}
          onBack={() => select('')}
        />
      ) : detail.kind === 'no-access' ? (
        <p role="alert">{t('approvals.detail.noAccess')}</p>
      ) : detail.kind === 'failed' ? (
        <div role="status">
          <p>{t('approvals.detail.failed')}</p>
          <button className="secondary-action" type="button" onClick={() => void loadDetail()}>
            {t('approvals.checkConnection')}
          </button>
        </div>
      ) : !online ? (
        offlineBlock
      ) : (
        <p role="status">{t('approvals.detail.loading')}</p>
      )}
    </section>
  );

  return (
    <div
      id="approvals"
      className="approvals-screen"
      data-device-class={deviceClass}
      data-task-mode={taskMode ? 'true' : 'false'}
    >
      {handheld ? (
        indentId ? (
          detailSection
        ) : (
          listSection
        )
      ) : (
        <>
          {listSection}
          {detailSection}
        </>
      )}
    </div>
  );
}

interface DetailBodyProps {
  data: DetailData;
  online: boolean;
  busy: boolean;
  handheld: boolean;
  rejectOpen: boolean;
  reason: string;
  error: string | null;
  confirmation: Confirmation | null;
  confirmationRef: RefObject<HTMLDivElement | null>;
  offlineBlock: ReactNode;
  onApprove: () => void;
  onReject: () => void;
  onRejectOpen: (open: boolean) => void;
  onReason: (reason: string) => void;
  onBack: () => void;
}

function DetailBody(props: DetailBodyProps) {
  const { data, online, busy, rejectOpen, reason, error, confirmation } = props;
  const pending = data.pending_for_me_line_ids;
  const requester = data.requester_display_name ?? t('approvals.confirm.requester');
  const note = doaNote(data.lines, pending, {
    upTo: t('approvals.note.upTo'),
    above: t('approvals.note.above'),
    headRole: t('approvals.note.headRole'),
  });
  const chipTemplates = {
    standing: t('approvals.chip.standing'),
    standingCap: t('approvals.chip.standingCap'),
    selfLimit: t('approvals.chip.selfLimit'),
    doa: t('approvals.chip.doa'),
    doaUnknown: t('approvals.chip.doaUnknown'),
  };
  const decided = data.lines.filter((l) => l.line_status !== 'pending' && l.decided_at);
  const reasonId = 'approvals-reject-reason';
  const hintId = 'approvals-reject-hint';

  return (
    <div className="approvals-detail-body">
      <h2 className="base-screen-title">
        {t('approvals.type.requisition')} {data.indent.indent_number_ext}
      </h2>
      <p>{t('approvals.requestedBy').replace('{who}', requester)}</p>
      {note ? (
        <p className="approvals-note" role="note">
          {note}
        </p>
      ) : null}

      <h3>{t('approvals.lines.heading')}</h3>
      <ul className="approvals-lines">
        {data.lines.map((line) => {
          const chip = routeChip(line, chipTemplates);
          const mine = pending.includes(line.indent_line_id);
          return (
            <li key={line.indent_line_id}>
              <span>
                {line.line_no}. {line.sku}
              </span>
              <span className={`state-pill state-pill-${chip.kind}`}>{chip.text}</span>
              <span
                className={`state-pill ${
                  line.line_status === 'approved'
                    ? 'state-pill-ok'
                    : line.line_status === 'rejected'
                      ? 'state-pill-err'
                      : 'state-pill-off'
                }`}
              >
                {t(LINE_STATUS_KEY[line.line_status])}
              </span>
              {mine ? (
                <b>{t('approvals.line.waitingForYou')}</b>
              ) : line.decided_at ? (
                <span>
                  {t('approvals.line.decided')
                    .replace(
                      '{who}',
                      line.decided_by_display_name ?? t('approvals.history.someone'),
                    )
                    .replace('{time}', formatTime(line.decided_at))}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>

      <h3 id="approvals-evidence-heading">{t('approvals.evidence.heading')}</h3>
      <div className="approvals-table-wrap">
        <table className="approvals-table" aria-labelledby="approvals-evidence-heading">
          <thead>
            <tr>
              <th scope="col">{t('approvals.evidence.line')}</th>
              <th scope="col">{t('approvals.evidence.item')}</th>
              <th scope="col" className="num">
                {t('approvals.evidence.qty')}
              </th>
              <th scope="col" className="num">
                {t('approvals.evidence.value')}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((line) => (
              <tr key={line.indent_line_id}>
                <td>{line.line_no}</td>
                <td>{line.sku}</td>
                <td className="num">
                  {Number(line.requested_qty)} {line.uom}
                </td>
                <td className="num">{formatRupees(line.line_value)}</td>
              </tr>
            ))}
          </tbody>
          {data.lines.length > 1 ? (
            <tfoot>
              <tr>
                <th scope="row" colSpan={3}>
                  {t('approvals.evidence.total')}
                </th>
                <td className="num">{formatRupees(totalValue(data.lines))}</td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      <h3>{t('approvals.history.heading')}</h3>
      <ol className="approvals-history">
        <li>
          {t('approvals.history.raised')
            .replace('{who}', requester)
            .replace('{time}', formatTime(data.indent.created_at))}
        </li>
        {decided.map((line) => (
          <li key={line.indent_line_id}>
            {t(
              line.line_status === 'approved'
                ? 'approvals.history.approved'
                : 'approvals.history.rejected',
            )
              .replace('{n}', String(line.line_no))
              .replace('{who}', line.decided_by_display_name ?? t('approvals.history.someone'))
              .replace('{time}', formatTime(line.decided_at!))
              // A function replacer: typed text may hold `$&`, which a string replacement expands.
              .replace('{reason}', () => line.rejection_reason ?? '')}
          </li>
        ))}
      </ol>

      <div aria-live="polite">
        {confirmation ? (
          <div className="approvals-block" tabIndex={-1} ref={props.confirmationRef}>
            {confirmation.kind === 'approved'
              ? t('approvals.confirm.approved')
                  .replace('{time}', formatTime(confirmation.at))
                  .replace('{who}', confirmation.who)
              : t('approvals.confirm.rejected')
                  .replace('{time}', formatTime(confirmation.at))
                  .replace('{who}', confirmation.who)
                  .replace('{reason}', () => confirmation.reason)}
          </div>
        ) : null}
        {error ? (
          <p className="approvals-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      {props.offlineBlock}

      {pending.length > 0 && !confirmation ? (
        <div className="approvals-footer" data-pinned={props.handheld ? 'true' : 'false'}>
          {rejectOpen ? (
            <div className="approvals-reject">
              <label htmlFor={reasonId}>{t('approvals.reject.label')}</label>
              <textarea
                id={reasonId}
                value={reason}
                autoFocus
                aria-describedby={reason.trim() ? undefined : hintId}
                onChange={(e) => props.onReason(e.target.value)}
              />
              {reason.trim() ? null : (
                <p id={hintId} className="approvals-hint">
                  {t('approvals.reject.hint')}
                </p>
              )}
              <div className="approvals-actions">
                <button
                  type="button"
                  className="primary-action approvals-danger"
                  disabled={!online || busy || !reason.trim()}
                  onClick={props.onReject}
                >
                  {t('approvals.reject.confirm')}
                </button>
                <button
                  type="button"
                  className="secondary-action"
                  disabled={busy}
                  onClick={() => props.onRejectOpen(false)}
                >
                  {t('approvals.reject.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <div className="approvals-actions">
              <button
                type="button"
                className="primary-action"
                disabled={!online || busy}
                onClick={props.onApprove}
              >
                {t('approvals.action.approve')}
              </button>
              <button
                type="button"
                className="secondary-action"
                disabled={!online || busy}
                onClick={() => props.onRejectOpen(true)}
              >
                {t('approvals.action.reject')}
              </button>
            </div>
          )}
        </div>
      ) : null}
      {confirmation && props.handheld ? (
        <button type="button" className="secondary-action" onClick={props.onBack}>
          {t('approvals.back')}
        </button>
      ) : null}
    </div>
  );
}
