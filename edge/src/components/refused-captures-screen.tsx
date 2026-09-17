'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, formatDateTime, t, type MessageKey } from '../i18n/locale';
import { authorizedFetch } from '../session/api-fetch';

/** Story 1.13 Table 2: the row columns this screen reads. Every other column comes back and is ignored. */
export interface RefusedCaptureRow {
  refusal_id: string;
  event_id: string;
  stream_type: string;
  event_type: string | null;
  device_id: string | null;
  captured_by: string;
  captured_role: string | null;
  location_id: string | null;
  error_code: string;
  refused_at: string;
  status: 'open' | 'resolved';
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
}

export interface RefusedCapturesScreenProps {
  /** The operating site from bootstrap; every list call passes it (Binding Decision 3). */
  siteId: string;
  /** The signed-in user; resolving is closed while nobody is signed in (Story 1.12 sign-out). */
  userId: string;
  /** From the shell: false hides every row and shows the needs-connection card (AC 5). */
  online: boolean;
}

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'ready'; open: RefusedCaptureRow[]; resolved: RefusedCaptureRow[]; openTruncated: boolean; resolvedTruncated: boolean }
  | { kind: 'needs-connection' }
  | { kind: 'no-access' };

const OPEN_LIMIT = 100;
const RESOLVED_LIMIT = 50;
const MAX_NOTE_LENGTH = 1000;

interface ErrorEnvelope {
  error_code?: unknown;
  details?: { resolved_by?: unknown; resolved_at?: unknown };
  refusal?: RefusedCaptureRow;
}

/** Reject a row whose required render fields are missing or malformed instead of crashing the screen. */
function isRefusedCaptureRow(value: unknown): value is RefusedCaptureRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.refusal_id === 'string' &&
    typeof row.error_code === 'string' &&
    typeof row.stream_type === 'string' &&
    typeof row.refused_at === 'string' &&
    !Number.isNaN(Date.parse(row.refused_at))
  );
}

async function fetchList(
  siteId: string,
  status: 'open' | 'resolved',
  limit: number,
): Promise<{ status: number; rows: RefusedCaptureRow[] }> {
  const query = new URLSearchParams({ status, location_id: siteId, limit: String(limit) });
  const response = await authorizedFetch(`/api/v1/edge/refused-captures?${query.toString()}`, {
    credentials: 'include',
  });
  if (!response.ok) return { status: response.status, rows: [] };
  const body = (await response.json()) as { refusals?: unknown };
  return { status: response.status, rows: Array.isArray(body.refusals) ? body.refusals.filter(isRefusedCaptureRow) : [] };
}

function Fact({ label, value }: { label: MessageKey; value: string }) {
  return (
    <div>
      <dt>{t(label)}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function captureType(row: RefusedCaptureRow): string {
  return `${row.event_type ?? '-'} (${row.stream_type})`;
}

function reason(row: RefusedCaptureRow): string {
  return `${errorMessage(row.error_code)} (${row.error_code})`;
}

/**
 * Story 1.14: the site's refused captures, read live from the Story 1.13 API and never stored on
 * the device (Binding Decision 5). Two sections of cards (Binding Decision 7): open refusals with a
 * two-tap resolve, and the resolutions already recorded. The API decides who may see and resolve
 * what; the screen only maps its `error_code` to operator copy.
 */
export function RefusedCapturesScreen({ siteId, userId, online }: RefusedCapturesScreenProps) {
  const [screen, setScreen] = useState<ScreenState>({ kind: 'loading' });
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [cardMessages, setCardMessages] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  // A stale response (from before the network changed or a resolve) must never overwrite a newer one.
  const requestSequence = useRef(0);
  const noteField = useRef<HTMLTextAreaElement | null>(null);
  const resolveButtonRef = useRef<HTMLButtonElement | null>(null);
  const resolvedHeadingRef = useRef<HTMLHeadingElement | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      const sequence = ++requestSequence.current;
      if (!online) {
        setScreen({ kind: 'needs-connection' });
        return;
      }
      if (!siteId) {
        setScreen({ kind: 'loading' });
        return;
      }
      if (!quiet) setScreen({ kind: 'loading' });
      try {
        const [open, resolved] = await Promise.all([
          fetchList(siteId, 'open', OPEN_LIMIT),
          fetchList(siteId, 'resolved', RESOLVED_LIMIT),
        ]);
        if (sequence !== requestSequence.current) return;
        if (open.status === 403 || resolved.status === 403) {
          if (!quiet) setScreen({ kind: 'no-access' });
          return;
        }
        if (open.status !== 200 || resolved.status !== 200) {
          // A quiet refetch must not tear down a screen the operator just acted on: keep the
          // current lists and let the next online event or retry recover.
          if (!quiet) setScreen({ kind: 'needs-connection' });
          return;
        }
        // Newest first is the API order (refused_at DESC, refusal_id ASC); never re-sorted here.
        setScreen({
          kind: 'ready',
          open: open.rows,
          resolved: resolved.rows,
          openTruncated: open.rows.length === OPEN_LIMIT,
          resolvedTruncated: resolved.rows.length === RESOLVED_LIMIT,
        });
      } catch {
        if (sequence === requestSequence.current && !quiet) setScreen({ kind: 'needs-connection' });
      }
    },
    [online, siteId],
  );

  // Fetch on mount, when the site becomes known, and on every online/offline change; no timer.
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (resolvingId !== null) noteField.current?.focus();
  }, [resolvingId]);

  const openForm = useCallback((refusalId: string, button: HTMLButtonElement) => {
    resolveButtonRef.current = button;
    setResolvingId(refusalId);
    setCardMessages((current) => ({ ...current, [refusalId]: '' }));
  }, []);

  const closeForm = useCallback(() => {
    const id = resolvingId;
    setResolvingId(null);
    setNotes((current) => {
      if (id === null || !(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    resolveButtonRef.current?.focus();
    resolveButtonRef.current = null;
  }, [resolvingId]);

  const moveToResolved = useCallback((refusalId: string, resolvedRow: RefusedCaptureRow) => {
    setScreen((current) =>
      current.kind === 'ready'
        ? {
            ...current,
            open: current.open.filter((row) => row.refusal_id !== refusalId),
            resolved: [resolvedRow, ...current.resolved],
          }
        : current,
    );
    setResolvingId(null);
    resolveButtonRef.current = null;
    setNotes((current) => {
      if (!(refusalId in current)) return current;
      const next = { ...current };
      delete next[refusalId];
      return next;
    });
    requestAnimationFrame(() => resolvedHeadingRef.current?.focus());
  }, []);

  const resolve = useCallback(
    async (row: RefusedCaptureRow) => {
      if (submitting) return;
      const trimmed = (notes[row.refusal_id] ?? '').trim();
      if (trimmed.length < 1 || trimmed.length > MAX_NOTE_LENGTH) {
        setCardMessages((current) => ({ ...current, [row.refusal_id]: errorMessage('VALIDATION_ERROR') }));
        noteField.current?.focus();
        return;
      }
      setSubmitting(true);
      setCardMessages((current) => ({ ...current, [row.refusal_id]: '' }));
      try {
        const response = await authorizedFetch(
          `/api/v1/edge/refused-captures/${encodeURIComponent(row.refusal_id)}/resolve`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              note: trimmed,
              idempotency_key: `edge-refusal-resolve-${row.refusal_id}`,
            }),
          },
        );
        const body = (await response.json().catch(() => ({}))) as ErrorEnvelope;
        if (response.ok && body.refusal) {
          moveToResolved(row.refusal_id, body.refusal);
          setNotice(t('refused.resolvedNotice'));
          void load(true);
          return;
        }
        const code = typeof body.error_code === 'string' ? body.error_code : null;
        if (response.status === 409 && code === 'REFUSED_CAPTURE_ALREADY_RESOLVED') {
          // Someone else got there first: the card still leaves the open list, with what the API said.
          const details = body.details ?? {};
          moveToResolved(row.refusal_id, {
            ...row,
            status: 'resolved',
            resolved_by: typeof details.resolved_by === 'string' ? details.resolved_by : null,
            resolved_at: typeof details.resolved_at === 'string' ? details.resolved_at : null,
            resolution_note: null,
          });
          setNotice(errorMessage(code));
          void load(true);
          return;
        }
        setCardMessages((current) => ({
          ...current,
          [row.refusal_id]: code ? errorMessage(code) : t('refused.needsConnection'),
        }));
      } catch {
        setCardMessages((current) => ({ ...current, [row.refusal_id]: t('refused.needsConnection') }));
      } finally {
        setSubmitting(false);
      }
    },
    [load, moveToResolved, notes, submitting],
  );

  if (screen.kind === 'needs-connection') {
    return (
      <section className="edge-card" id="refused-captures" aria-labelledby="refused-connection-heading">
        <h2 id="refused-connection-heading">{t('refused.title')}</h2>
        <p role="status">{t('refused.needsConnection')}</p>
        <button className="secondary-action" type="button" onClick={() => void load()}>
          {t('refused.checkConnection')}
        </button>
      </section>
    );
  }

  if (screen.kind === 'no-access') {
    return (
      <section className="edge-card" id="refused-captures" aria-labelledby="refused-no-access-heading">
        <h2 id="refused-no-access-heading">{t('refused.title')}</h2>
        <p role="status">{t('refused.noAccess')}</p>
      </section>
    );
  }

  const loading = screen.kind === 'loading';
  const open = screen.kind === 'ready' ? screen.open : [];
  const resolved = screen.kind === 'ready' ? screen.resolved : [];
  const openTruncated = screen.kind === 'ready' ? screen.openTruncated : false;
  const resolvedTruncated = screen.kind === 'ready' ? screen.resolvedTruncated : false;

  return (
    <div className="refused-screen" id="refused-captures" aria-busy={loading}>
      {loading || notice ? (
        <p className="refused-notice" role="status" aria-live="polite" aria-label={t('refused.liveLabel')}>
          {loading ? t('refused.loading') : notice}
        </p>
      ) : null}
      <section className="edge-card" aria-labelledby="refused-open-heading">
        <h2 id="refused-open-heading">{t('refused.openHeading')}</h2>
        {!loading && open.length === 0 ? <p>{t('refused.emptyOpen')}</p> : null}
        {open.length > 0 ? (
          <ul className="refused-list">
            {open.map((row) => (
              <li key={row.refusal_id} className="refused-card">
                <dl className="refused-facts">
                  <Fact label="refused.refusedAt" value={formatDateTime(row.refused_at)} />
                  <Fact
                    label="refused.capturedBy"
                    value={row.captured_role ? `${row.captured_by} (${row.captured_role})` : row.captured_by}
                  />
                  <Fact label="refused.device" value={row.device_id ?? '-'} />
                  <Fact label="refused.captureType" value={captureType(row)} />
                  <Fact label="refused.reason" value={reason(row)} />
                </dl>
                {resolvingId === row.refusal_id ? (
                  <form
                    className="refused-resolve-form"
                    noValidate
                    onSubmit={(event) => {
                      event.preventDefault();
                      void resolve(row);
                    }}
                  >
                    <label htmlFor={`refused-note-${row.refusal_id}`}>{t('refused.noteLabel')}</label>
                    <textarea
                      id={`refused-note-${row.refusal_id}`}
                      ref={noteField}
                      name="note"
                      rows={3}
                      required
                      maxLength={MAX_NOTE_LENGTH}
                      value={notes[row.refusal_id] ?? ''}
                      disabled={submitting}
                      aria-describedby={`refused-note-hint-${row.refusal_id}`}
                      onChange={(event) =>
                        setNotes((current) => ({ ...current, [row.refusal_id]: event.target.value }))
                      }
                    />
                    <p id={`refused-note-hint-${row.refusal_id}`} className="refused-note-hint">
                      {t('refused.noteHint')}
                    </p>
                    <div className="edge-actions">
                      <button className="primary-action" type="submit" disabled={submitting} aria-busy={submitting}>
                        {submitting ? t('refused.resolving') : t('refused.confirmResolve')}
                      </button>
                      <button className="secondary-action" type="button" disabled={submitting} onClick={closeForm}>
                        {t('refused.cancel')}
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="edge-actions">
                    <button
                      className="secondary-action"
                      type="button"
                      disabled={!userId}
                      onClick={(event) => openForm(row.refusal_id, event.currentTarget)}
                    >
                      {t('refused.resolve')}
                    </button>
                  </div>
                )}
                {cardMessages[row.refusal_id] ? (
                  <p className="refused-card-status" role="status">
                    {cardMessages[row.refusal_id]}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {openTruncated ? <p className="refused-truncated">{t('refused.truncatedOpen')}</p> : null}
      </section>
      <section className="edge-card" aria-labelledby="refused-resolved-heading">
        <h2 id="refused-resolved-heading" tabIndex={-1} ref={resolvedHeadingRef}>
          {t('refused.resolvedHeading')}
        </h2>
        {!loading && resolved.length === 0 ? <p>{t('refused.emptyResolved')}</p> : null}
        {resolved.length > 0 ? (
          <ul className="refused-list">
            {resolved.map((row) => (
              <li key={row.refusal_id} className="refused-card">
                <dl className="refused-facts">
                  <Fact label="refused.resolvedBy" value={row.resolved_by ?? '-'} />
                  <Fact label="refused.resolvedAt" value={row.resolved_at ? formatDateTime(row.resolved_at) : '-'} />
                  <Fact label="refused.note" value={row.resolution_note ?? '-'} />
                  <Fact label="refused.captureType" value={captureType(row)} />
                  <Fact label="refused.reason" value={reason(row)} />
                </dl>
              </li>
            ))}
          </ul>
        ) : null}
        {resolvedTruncated ? <p className="refused-truncated">{t('refused.truncatedResolved')}</p> : null}
      </section>
    </div>
  );
}
