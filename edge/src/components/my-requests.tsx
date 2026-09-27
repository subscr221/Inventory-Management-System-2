'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDateTime, t, type MessageKey } from '../i18n/locale';
import { authorizedFetch } from '../session/api-fetch';

/** The indent columns this screen reads; every other column comes back and is ignored. */
export interface MyIndentRow {
  indent_id: string;
  indent_number_ext: string;
  status: string;
  need_by_date: string | null;
  approver_actor_id: string | null;
  created_at: string;
}

const REQUISITION_LIMIT = 50;

/**
 * Story 1.15 (AC 4, D6): one entry per kind of request the base role can make. Requisitions now;
 * Story 8.9 appends `damage_reports` here instead of adding a second screen.
 */
const SECTIONS: ReadonlyArray<{ key: 'requisitions'; heading: MessageKey }> = [
  { key: 'requisitions', heading: 'myRequests.requisitionsHeading' },
];

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'ready'; requisitions: MyIndentRow[]; truncated: boolean }
  | { kind: 'needs-connection' }
  | { kind: 'no-access' };

function isIndentRow(value: unknown): value is MyIndentRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.indent_id === 'string' &&
    typeof row.indent_number_ext === 'string' &&
    typeof row.status === 'string' &&
    typeof row.created_at === 'string' &&
    !Number.isNaN(Date.parse(row.created_at))
  );
}

const STATUS_KEYS: Record<string, MessageKey> = {
  raised: 'myRequests.status.raised',
  'pending-confirmation': 'myRequests.status.pending-confirmation',
  approved: 'myRequests.status.approved',
  rejected: 'myRequests.status.rejected',
  ordered: 'myRequests.status.ordered',
  cancelled: 'myRequests.status.cancelled',
  closed: 'myRequests.status.closed',
};

function Fact({ label, value }: { label: MessageKey; value: string }) {
  return (
    <div>
      <dt>{t(label)}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * Story 1.15 (AC 4): the signed-in person's own requests, live from `GET /api/v1/indents?mine=true`.
 * The API returns only the caller's rows, newest first; this screen never filters or re-sorts.
 * Online only, like the refused-captures screen (Story 1.14).
 */
export function MyRequests({ online }: { online: boolean }) {
  const [screen, setScreen] = useState<ScreenState>({ kind: 'loading' });
  const requestSequence = useRef(0);
  const ready = useRef(false);

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    // A refetch (online event) must not wipe rows already on screen (Story 1.14 review).
    const quiet = ready.current;
    if (!online) {
      ready.current = false;
      setScreen({ kind: 'needs-connection' });
      return;
    }
    if (!quiet) setScreen({ kind: 'loading' });
    try {
      // Code review 2026-09-27: fetch one more row than shown so "exactly REQUISITION_LIMIT total"
      // can be told apart from "more than REQUISITION_LIMIT total" - length === limit could not.
      const response = await authorizedFetch(
        `/api/v1/indents?mine=true&limit=${REQUISITION_LIMIT + 1}`,
        { credentials: 'include' },
      );
      if (sequence !== requestSequence.current) return;
      if (response.status === 403) {
        ready.current = false;
        setScreen({ kind: 'no-access' });
        return;
      }
      if (!response.ok) {
        if (!quiet) setScreen({ kind: 'needs-connection' });
        return;
      }
      const body = (await response.json()) as { indents?: unknown };
      if (sequence !== requestSequence.current) return;
      const rawRows = Array.isArray(body.indents) ? body.indents.filter(isIndentRow) : [];
      ready.current = true;
      setScreen({
        kind: 'ready',
        requisitions: rawRows.slice(0, REQUISITION_LIMIT),
        truncated: rawRows.length > REQUISITION_LIMIT,
      });
    } catch {
      if (sequence === requestSequence.current && !quiet) setScreen({ kind: 'needs-connection' });
    }
  }, [online]);

  useEffect(() => {
    void load();
  }, [load]);

  if (screen.kind === 'needs-connection') {
    return (
      <section
        className="edge-card"
        id="my-requests"
        aria-labelledby="my-requests-connection-heading"
      >
        <h2 id="my-requests-connection-heading">{t('myRequests.title')}</h2>
        <p role="status">{t('myRequests.needsConnection')}</p>
        <button className="secondary-action" type="button" onClick={() => void load()}>
          {t('myRequests.checkConnection')}
        </button>
      </section>
    );
  }

  if (screen.kind === 'no-access') {
    return (
      <section
        className="edge-card"
        id="my-requests"
        aria-labelledby="my-requests-no-access-heading"
      >
        <h2 id="my-requests-no-access-heading">{t('myRequests.title')}</h2>
        <p role="status">{t('myRequests.noAccess')}</p>
      </section>
    );
  }

  const loading = screen.kind === 'loading';
  return (
    <div className="base-screen" id="my-requests" aria-busy={loading}>
      <h2 className="base-screen-title">{t('myRequests.title')}</h2>
      {loading ? (
        <p
          className="base-notice"
          role="status"
          aria-live="polite"
          aria-label={t('myRequests.liveLabel')}
        >
          {t('myRequests.loading')}
        </p>
      ) : null}
      {SECTIONS.map((section) => {
        const rows = screen.kind === 'ready' ? screen[section.key] : [];
        const truncated = screen.kind === 'ready' ? screen.truncated : false;
        return (
          <section
            key={section.key}
            className="edge-card"
            aria-labelledby={`my-requests-${section.key}-heading`}
          >
            <h3 id={`my-requests-${section.key}-heading`}>{t(section.heading)}</h3>
            {!loading && rows.length === 0 ? <p>{t('myRequests.empty')}</p> : null}
            {rows.length > 0 ? (
              <ul className="base-list">
                {rows.map((row) => (
                  <li key={row.indent_id} className="base-card base-card-stacked">
                    <span className="base-card-title">{row.indent_number_ext}</span>
                    <dl className="base-facts">
                      <Fact
                        label="myRequests.statusLabel"
                        value={STATUS_KEYS[row.status] ? t(STATUS_KEYS[row.status]!) : row.status}
                      />
                      <Fact label="myRequests.raisedAt" value={formatDateTime(row.created_at)} />
                      <Fact label="myRequests.needBy" value={row.need_by_date ?? '-'} />
                      <Fact
                        label="myRequests.approval"
                        value={
                          row.approver_actor_id
                            ? t('myRequests.awaitingApproval')
                            : t('myRequests.noApproval')
                        }
                      />
                    </dl>
                  </li>
                ))}
              </ul>
            ) : null}
            {truncated ? <p className="base-hint">{t('myRequests.truncated')}</p> : null}
          </section>
        );
      })}
    </div>
  );
}
