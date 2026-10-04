'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDateTime, t, type MessageKey } from '../i18n/locale';
import { authorizedFetch } from '../session/api-fetch';
import { isDamageReport, type DamageReport } from './damage-case-view';

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
const DAMAGE_REPORT_LIMIT = 50;

type SectionKey = 'requisitions' | 'damage_reports';

/**
 * Story 1.15 (AC 4, D6): one entry per kind of request the base role can make. Story 8.9 (Task 9.4)
 * appends `damage_reports` here instead of adding a second screen.
 */
const SECTIONS: ReadonlyArray<{
  key: SectionKey;
  heading: MessageKey;
  empty: MessageKey;
  truncated: MessageKey;
}> = [
  {
    key: 'requisitions',
    heading: 'myRequests.requisitionsHeading',
    empty: 'myRequests.empty',
    truncated: 'myRequests.truncated',
  },
  {
    key: 'damage_reports',
    heading: 'myRequests.damageHeading',
    empty: 'myRequests.damageEmpty',
    truncated: 'myRequests.damageTruncated',
  },
];

/** A section whose own list could not be read says so; the other section still renders. */
interface SectionRows<T> {
  rows: T[];
  truncated: boolean;
  unavailable: boolean;
}

type ScreenState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      requisitions: SectionRows<MyIndentRow>;
      damage_reports: SectionRows<DamageReport>;
    }
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

/** Story 8.9 Task 9.4: the reporter-facing state of a damage case. */
const DAMAGE_STATUS_KEYS: Record<string, MessageKey> = {
  on_hold: 'myRequests.damageStatus.on_hold',
  cleared: 'myRequests.damageStatus.cleared',
  awaiting_keys: 'myRequests.damageStatus.awaiting_keys',
  escalated: 'myRequests.damageStatus.escalated',
  outcome_final: 'myRequests.damageStatus.outcome_final',
  closed: 'myRequests.damageStatus.closed',
};

const DAMAGE_OUTCOME_KEYS: Record<string, MessageKey> = {
  debit_note: 'damageCases.outcome.debit_note',
  return_for_replacement: 'damageCases.outcome.return_for_replacement',
  write_off: 'damageCases.outcome.write_off',
  accept_as_is_price_reduction: 'damageCases.outcome.accept_as_is_price_reduction',
};

/** "QC and finance will decide" until final; the outcome label once final. */
function damageDecision(row: DamageReport): string {
  if (row.status === 'cleared') return t('myRequests.damageCleared');
  if (!row.final_outcome) return t('myRequests.damageDecides');
  const key = DAMAGE_OUTCOME_KEYS[row.final_outcome];
  return key ? t(key) : row.final_outcome;
}

function Fact({ label, value }: { label: MessageKey; value: string }) {
  return (
    <div>
      <dt>{t(label)}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function RequisitionCard({ row }: { row: MyIndentRow }) {
  return (
    <li className="base-card base-card-stacked">
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
            row.approver_actor_id ? t('myRequests.awaitingApproval') : t('myRequests.noApproval')
          }
        />
      </dl>
    </li>
  );
}

function DamageCard({ row }: { row: DamageReport }) {
  const statusKey = DAMAGE_STATUS_KEYS[row.status];
  return (
    <li className="base-card base-card-stacked">
      <span className="base-card-title">{row.report_number}</span>
      <span>
        <span className="state-pill">{statusKey ? t(statusKey) : row.status}</span>
      </span>
      <dl className="base-facts">
        <Fact
          label="myRequests.damageItem"
          value={t('myRequests.damageItemValue')
            .replace('{sku}', row.sku)
            .replace('{quantity}', row.quantity)}
        />
        <Fact label="myRequests.damageLot" value={row.lot_number ?? '-'} />
        <Fact label="myRequests.raisedAt" value={formatDateTime(row.reported_at)} />
        <Fact label="myRequests.damageDecision" value={damageDecision(row)} />
        {row.replacement_indent_number ? (
          <Fact label="myRequests.damageReplacement" value={row.replacement_indent_number} />
        ) : null}
      </dl>
    </li>
  );
}

/**
 * Story 8.9 (Task 9.4): the caller's own damage reports, one more than shown so truncation is
 * exact. A failure here marks only this section unavailable; requisitions still render.
 */
async function loadDamageReports(): Promise<SectionRows<DamageReport>> {
  try {
    const response = await authorizedFetch(
      `/api/v1/damage-reports?view=mine&limit=${DAMAGE_REPORT_LIMIT + 1}`,
      { credentials: 'include' },
    );
    if (!response.ok) return { rows: [], truncated: false, unavailable: true };
    const body = (await response.json()) as { reports?: unknown };
    const rows = Array.isArray(body.reports) ? body.reports.filter(isDamageReport) : [];
    return {
      rows: rows.slice(0, DAMAGE_REPORT_LIMIT),
      truncated: rows.length > DAMAGE_REPORT_LIMIT,
      unavailable: false,
    };
  } catch {
    return { rows: [], truncated: false, unavailable: true };
  }
}

/**
 * Story 1.15 (AC 4): the signed-in person's own requests, live from `GET /api/v1/indents?mine=true`
 * and (Story 8.9) `GET /api/v1/damage-reports?view=mine`. The API returns only the caller's rows,
 * newest first; this screen never filters or re-sorts. Online only, like the refused-captures
 * screen (Story 1.14).
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
      const [response, damageReports] = await Promise.all([
        authorizedFetch(`/api/v1/indents?mine=true&limit=${REQUISITION_LIMIT + 1}`, {
          credentials: 'include',
        }),
        loadDamageReports(),
      ]);
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
        requisitions: {
          rows: rawRows.slice(0, REQUISITION_LIMIT),
          truncated: rawRows.length > REQUISITION_LIMIT,
          unavailable: false,
        },
        damage_reports: damageReports,
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
        const data = screen.kind === 'ready' ? screen[section.key] : null;
        const count = data ? data.rows.length : 0;
        return (
          <section
            key={section.key}
            className="edge-card"
            aria-labelledby={`my-requests-${section.key}-heading`}
          >
            <h3 id={`my-requests-${section.key}-heading`}>{t(section.heading)}</h3>
            {data?.unavailable ? <p role="status">{t('myRequests.sectionUnavailable')}</p> : null}
            {!loading && data && !data.unavailable && count === 0 ? (
              <p>{t(section.empty)}</p>
            ) : null}
            {screen.kind === 'ready' && count > 0 ? (
              <ul className="base-list">
                {section.key === 'requisitions'
                  ? screen.requisitions.rows.map((row) => (
                      <RequisitionCard key={row.indent_id} row={row} />
                    ))
                  : screen.damage_reports.rows.map((row) => (
                      <DamageCard key={row.report_id} row={row} />
                    ))}
              </ul>
            ) : null}
            {data?.truncated ? <p className="base-hint">{t(section.truncated)}</p> : null}
          </section>
        );
      })}
    </div>
  );
}
