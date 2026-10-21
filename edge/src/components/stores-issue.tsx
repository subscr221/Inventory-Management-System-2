'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, t } from '../i18n/locale';
import { authorizedFetch } from '../session/api-fetch';
import {
  buildIssueBody,
  emptyForm,
  isIssuableIndentRow,
  isIssuableLineRow,
  openApprovedLines,
  type IssuableIndentRow,
  type IssuableLineRow,
  type IssueLineForm,
} from './stores-issue-model';

/**
 * Story 4.11 (AC 9, D11): the storekeeper's online "Issues pending" page. Lists the requisitions
 * with an approved open line at the caller's site, takes quantity, bin, lot and serials per line,
 * posts the issue and shows the slip text with a Print button. No offline queueing (deferred).
 */

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; rows: IssuableIndentRow[] }
  | { kind: 'message'; text: string };

type DetailState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'ready';
      indent: IssuableIndentRow;
      lines: IssuableLineRow[];
      forms: IssueLineForm[];
      /** Fixed once per opened form so a retry returns the slip already written. */
      issueId: string;
    }
  | { kind: 'slip'; indent: IssuableIndentRow; slip: string; slipNumber: string };

const PRINT_CSS = `@media print { body * { visibility: hidden; } #stores-issue-slip, #stores-issue-slip * { visibility: visible; } #stores-issue-slip { position: absolute; left: 0; top: 0; width: 100%; } }`;

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error_code?: unknown };
    return typeof body.error_code === 'string'
      ? errorMessage(body.error_code)
      : t('storesIssue.failed');
  } catch {
    return t('storesIssue.failed');
  }
}

export function StoresIssue() {
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [detail, setDetail] = useState<DetailState>({ kind: 'idle' });
  const [message, setMessage] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const openToken = useRef(0);

  const loadList = useCallback(async () => {
    setList({ kind: 'loading' });
    try {
      const response = await authorizedFetch('/api/v1/indents?issuable=true&limit=100');
      if (!response.ok) {
        setList({ kind: 'message', text: await readError(response) });
        return;
      }
      const body = (await response.json()) as { indents?: unknown };
      const rows = Array.isArray(body.indents) ? body.indents.filter(isIssuableIndentRow) : [];
      setList({ kind: 'ready', rows });
    } catch {
      setList({ kind: 'message', text: t('storesIssue.offline') });
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const open = useCallback(async (indent: IssuableIndentRow) => {
    setMessage('');
    setDetail({ kind: 'loading' });
    const token = ++openToken.current;
    try {
      const response = await authorizedFetch(`/api/v1/indents/${indent.indent_id}`);
      if (token !== openToken.current) return;
      if (!response.ok) {
        setMessage(await readError(response));
        setDetail({ kind: 'idle' });
        return;
      }
      const body = (await response.json()) as { lines?: unknown };
      const lines = Array.isArray(body.lines) ? body.lines.filter(isIssuableLineRow) : [];
      if (token !== openToken.current) return;
      const issuable = openApprovedLines(lines);
      setDetail({
        kind: 'ready',
        indent,
        lines: issuable,
        forms: issuable.map(emptyForm),
        issueId: crypto.randomUUID(),
      });
    } catch {
      if (token !== openToken.current) return;
      setMessage(t('storesIssue.offline'));
      setDetail({ kind: 'idle' });
    }
  }, []);

  const update = (lineId: string, patch: Partial<IssueLineForm>) => {
    setDetail((current) =>
      current.kind === 'ready'
        ? {
            ...current,
            forms: current.forms.map((f) => (f.indent_line_id === lineId ? { ...f, ...patch } : f)),
          }
        : current,
    );
  };

  const submit = async () => {
    if (detail.kind !== 'ready' || submittingRef.current) return;
    const built = buildIssueBody(detail.lines, detail.forms);
    if (!built.ok) {
      const key =
        built.reason === 'no_lines'
          ? 'storesIssue.noLines'
          : built.reason === 'bad_quantity'
            ? 'storesIssue.badQuantity'
            : built.reason === 'over_open'
              ? 'storesIssue.overOpen'
              : built.reason === 'bad_serials'
                ? 'storesIssue.badSerials'
                : 'storesIssue.noBin';
      setMessage(`${t(key)}${built.line_no ? ` (${t('storesIssue.line')} ${built.line_no})` : ''}`);
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setMessage('');
    try {
      const response = await authorizedFetch(`/api/v1/indents/${detail.indent.indent_id}/issue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue_id: detail.issueId, lines: built.lines }),
      });
      if (!response.ok) {
        const text = await readError(response);
        // A 409 means the open quantities moved under us; show the fresh ones, keep the reason.
        if (response.status === 409) await open(detail.indent);
        setMessage(text);
        return;
      }
      const body = (await response.json()) as {
        slip_text?: unknown;
        issue?: { issue_number_ext?: unknown };
      };
      const slip = typeof body.slip_text === 'string' ? body.slip_text : '';
      const slipNumber =
        typeof body.issue?.issue_number_ext === 'string' ? body.issue.issue_number_ext : '';
      setDetail({ kind: 'slip', indent: detail.indent, slip, slipNumber });
      if (slip === '') setMessage(`${t('storesIssue.slipMissing')} ${slipNumber}`.trim());
      void loadList();
    } catch {
      setMessage(t('storesIssue.offline'));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const print = () => {
    if (typeof window !== 'undefined' && typeof window.print === 'function') window.print();
  };

  return (
    <section className="card" aria-labelledby="stores-issue-heading">
      <style>{PRINT_CSS}</style>
      <h1 id="stores-issue-heading">{t('storesIssue.title')}</h1>
      <p>
        <a className="secondary-action" href="/">
          {t('storesIssue.back')}
        </a>
      </p>
      {list.kind === 'loading' ? (
        <p role="status">{t('storesIssue.loading')}</p>
      ) : list.kind === 'message' ? (
        <p role="alert">{list.text}</p>
      ) : list.rows.length === 0 ? (
        <p>{t('storesIssue.empty')}</p>
      ) : (
        <ul className="stores-issue-list">
          {list.rows.map((row) => (
            <li key={row.indent_id}>
              <button type="button" className="secondary-action" onClick={() => void open(row)}>
                {row.indent_number_ext} · {row.requester_user_id} ({row.department_code}) ·{' '}
                {t('storesIssue.approvedOf')} {row.approved_line_count ?? 0}/{row.line_count ?? 0}
              </button>
            </li>
          ))}
        </ul>
      )}

      {detail.kind === 'loading' ? (
        <p role="status">{t('storesIssue.loading')}</p>
      ) : detail.kind === 'ready' ? (
        <form
          className="stores-issue-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h2>{detail.indent.indent_number_ext}</h2>
          {detail.lines.length === 0 ? <p>{t('storesIssue.nothingOpen')}</p> : null}
          {detail.lines.map((line) => {
            const form = detail.forms.find((f) => f.indent_line_id === line.indent_line_id);
            if (!form) return null;
            const id = `stores-issue-${line.indent_line_id}`;
            return (
              <fieldset key={line.indent_line_id}>
                <legend>
                  {t('storesIssue.line')} {line.line_no} · {line.sku} · {t('storesIssue.open')}{' '}
                  {line.open_qty} {line.uom}
                </legend>
                {line.standing_approval_text ? <p>{line.standing_approval_text}</p> : null}
                <label htmlFor={`${id}-qty`}>{t('storesIssue.quantity')}</label>
                <input
                  id={`${id}-qty`}
                  inputMode="decimal"
                  value={form.quantity}
                  onChange={(e) => update(line.indent_line_id, { quantity: e.target.value })}
                />
                <label htmlFor={`${id}-bin`}>{t('storesIssue.bin')}</label>
                <input
                  id={`${id}-bin`}
                  value={form.location_code}
                  onChange={(e) => update(line.indent_line_id, { location_code: e.target.value })}
                />
                <label htmlFor={`${id}-lot`}>{t('storesIssue.lot')}</label>
                <input
                  id={`${id}-lot`}
                  value={form.lot_id}
                  onChange={(e) => update(line.indent_line_id, { lot_id: e.target.value })}
                />
                <label htmlFor={`${id}-serials`}>{t('storesIssue.serials')}</label>
                <input
                  id={`${id}-serials`}
                  value={form.serials}
                  onChange={(e) => update(line.indent_line_id, { serials: e.target.value })}
                />
                <label htmlFor={`${id}-override`}>
                  <input
                    id={`${id}-override`}
                    type="checkbox"
                    checked={form.override_expired_lot}
                    onChange={(e) =>
                      update(line.indent_line_id, { override_expired_lot: e.target.checked })
                    }
                  />{' '}
                  {t('storesIssue.overrideExpired')}
                </label>
              </fieldset>
            );
          })}
          <button
            className="primary-action"
            type="submit"
            disabled={submitting || detail.lines.length === 0}
          >
            {t('storesIssue.submit')}
          </button>
        </form>
      ) : detail.kind === 'slip' ? (
        <div>
          <h2>
            {t('storesIssue.issued')} {detail.slipNumber}
          </h2>
          <pre id="stores-issue-slip">{detail.slip}</pre>
          <button className="primary-action" type="button" onClick={print}>
            {t('storesIssue.print')}
          </button>{' '}
          <button
            className="secondary-action"
            type="button"
            onClick={() => setDetail({ kind: 'idle' })}
          >
            {t('storesIssue.done')}
          </button>
        </div>
      ) : null}
      <p role="status" aria-live="polite">
        {message}
      </p>
    </section>
  );
}
