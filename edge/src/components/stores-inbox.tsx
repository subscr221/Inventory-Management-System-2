'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { t, errorMessage, type MessageKey } from '../i18n/locale';
import { authorizedFetch } from '../session/api-fetch';
import { ScanField } from './scan-field';
import {
  acceptedToday,
  buildInbox,
  resolveScan,
  type ArrivalRow,
  type DoneRow,
  type InboxCard,
  type IssueRow,
  type PutawayRow,
} from './stores-inbox-model';

export interface StoresInboxProps {
  online: boolean;
  siteCodeExt: string | null;
  siteId: string;
  navigation: string[];
  pendingReceipts?: DoneRow[];
}

interface GrnRow {
  grn_id: string;
  grn_number?: string | null;
  created_at?: string | null;
  received_at?: string | null;
}

type LoadState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      arrivals: ArrivalRow[];
      putaway: PutawayRow[];
      issues: IssueRow[];
      grns: GrnRow[];
    }
  | { kind: 'message'; text: string };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isToday(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.slice(0, 10) === today();
}

export function StoresInbox({
  online,
  siteCodeExt,
  siteId,
  navigation,
  pendingReceipts = [],
}: StoresInboxProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [scanValue, setScanValue] = useState<string>('');
  const [announcement, setAnnouncement] = useState<string>('');
  const [doneHighlight, setDoneHighlight] = useState<string | null>(null);
  const [lotSheet, setLotSheet] = useState<string | null>(null);
  const mounted = useRef(true);
const locationCodes = useRef(new Map<string, string | null>());
  const putawayError = useRef('');

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const load = useCallback(async () => {
    putawayError.current = '';
    if (!siteCodeExt) {
      setState({ kind: 'message', text: t('stores.noSite') });
      return;
    }
    if (!online) {
      setState({ kind: 'message', text: t('stores.needsConnection') });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const site = encodeURIComponent(siteCodeExt);
      const [arrivalsRes, putawayRes, issuesRes, grnsRes] = await Promise.all([
        authorizedFetch(`/api/v1/receiving/arrivals?site=${site}`),
        authorizedFetch(`/api/v1/putaway-tasks?site=${encodeURIComponent(siteId)}&status=ready`),
        authorizedFetch('/api/v1/indents?issuable=true&limit=100'),
        authorizedFetch(`/api/v1/grns?site=${site}&status=posted`),
      ]);
      if (!mounted.current) return;
      if (!arrivalsRes.ok) {
        setState({ kind: 'message', text: t('stores.failed') });
        return;
      }
      const arrivals = ((await arrivalsRes.json()) as { arrivals?: ArrivalRow[] }).arrivals ?? [];
      let putawayRaw: PutawayRow[] = [];
      if (putawayRes.ok) {
        putawayRaw = (((await putawayRes.json()) as { tasks?: PutawayRow[] }).tasks ?? []);
      } else {
        const body = (await putawayRes.json().catch(() => ({}))) as Record<string, unknown>;
        const code = typeof body['error_code'] === 'string' ? body['error_code'] : '';
        putawayError.current = code ? errorMessage(code) : t('stores.failed');
      }
      const putaway = await Promise.all(
        putawayRaw.map(async (task) => {
          let code = locationCodes.current.get(task.from_location_id);
          if (code === undefined) {
            try {
              const locRes = await authorizedFetch(
                `/api/v1/locations/${encodeURIComponent(task.from_location_id)}`,
              );
              if (locRes.ok) {
                const location = (await locRes.json()) as Record<string, unknown>;
                if (typeof location['location_code'] === 'string') {
                  code = location['location_code'];
                  locationCodes.current.set(task.from_location_id, code);
                } else {
                  code = null;
                }
              } else {
                code = null;
              }
            } catch {
              code = null;
            }
          }
          return { ...task, from_location_code: code };
        }),
      );
      const issues = issuesRes.ok
        ? (((await issuesRes.json()) as { indents?: IssueRow[] }).indents ?? [])
        : [];
      const grns = grnsRes.ok ? (((await grnsRes.json()) as { grns?: GrnRow[] }).grns ?? []) : [];
      if (
        putawayError.current &&
        putawayRaw.length === 0 &&
        arrivals.length === 0 &&
        issues.length === 0 &&
        grns.length === 0
      ) {
        setState({ kind: 'message', text: putawayError.current });
        return;
      }
      setState({ kind: 'ready', arrivals, putaway, issues, grns });
    } catch {
      if (mounted.current) setState({ kind: 'message', text: t('stores.needsConnection') });
    }
  }, [online, siteCodeExt, siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onScan(code: string) {
    if (state.kind !== 'ready') return;
    const result = resolveScan(code, state.arrivals);
    if (result.kind === 'accept') {
      window.location.assign(
        `/stores/accept?gate=${encodeURIComponent(result.arrival.gate_event_id)}`,
      );
      return;
    }
    if (result.kind === 'done') {
      setDoneHighlight(result.arrival.grn_id);
      setAnnouncement(t('stores.scan.doneToday'));
      return;
    }
    try {
      const res = await authorizedFetch(`/api/v1/lots/${encodeURIComponent(code)}/location`);
      if (res.ok) {
        setLotSheet(code);
        setAnnouncement(t('stores.scan.lotSheet'));
        return;
      }
    } catch {
      // fall through to not recognised
    }
    setAnnouncement(t('stores.scan.notRecognised').replace('{code}', code));
  }

  if (state.kind === 'loading') {
    return <p className="stores-status">{t('stores.loading')}</p>;
  }
  if (state.kind === 'message') {
    return (
      <section className="edge-card" aria-live="polite">
        <p>{state.text}</p>
        <button className="secondary-action" type="button" onClick={() => void load()}>
          {t('stores.checkConnection')}
        </button>
      </section>
    );
  }

  const doneFromServer: DoneRow[] = [
    ...acceptedToday(state.arrivals).map((row) => ({
      ...row,
      href: `/stores/grn?grn=${encodeURIComponent(row.id)}`,
    })),
    ...state.grns
      .filter((grn) => isToday(grn.received_at ?? grn.created_at))
      .map((grn) => ({
        id: grn.grn_id,
        title: grn.grn_number ?? grn.grn_id,
        statusKey: 'stores.done.synced' as const,
        href: `/stores/grn?grn=${encodeURIComponent(grn.grn_id)}`,
      })),
  ];
  const doneIds = new Set(doneFromServer.map((row) => row.id));
  const done = [...pendingReceipts.filter((row) => !doneIds.has(row.id)), ...doneFromServer];

  const groups = buildInbox({
    arrivals: state.arrivals,
    putaway: state.putaway,
    issues: state.issues,
    showIssues: navigation.includes('Issues pending') || navigation.includes('Stores issue'),
    showPutaway: navigation.includes('Stores'),
  });

  return (
    <div id="stores-inbox" className="stores-inbox">
      <section className="stores-scan" aria-label={t('stores.scan.label')}>
        <ScanField
          id="stores-scan"
          label={t('stores.scan.label')}
          value={scanValue}
          placeholder={t('stores.scan.placeholder')}
          onScan={(value) => void onScan(value)}
          onChange={setScanValue}
        />
        <p role="status" aria-live="polite" className="stores-announcement">
          {announcement}
        </p>
      </section>

      {groups.map((group) => (
        <section
          key={group.key}
          className="stores-group"
          aria-labelledby={`stores-group-${group.key}`}
        >
          <h2 id={`stores-group-${group.key}`}>{t(group.titleKey as MessageKey)}</h2>
          {group.cards.length === 0 ? (
            <p className="stores-empty">{t('stores.nothingWaiting')}</p>
          ) : (
            <ul className="stores-cards">
              {group.cards.map((card) => (
                <li key={card.id} className="stores-card">
                  <div>
                    <h3>{card.title}</h3>
                    <p>{card.detail}</p>
                  </div>
                  <span className="stores-pill">
                    {t(card.pillKey as MessageKey).replace('{code}', card.pillValue ?? '')}
                  </span>
                  <CardAction card={card} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      {done.length > 0 ? (
        <section className="stores-group" aria-labelledby="stores-group-done">
          <h2 id="stores-group-done">{t('stores.group.doneToday')}</h2>
          <ul className="stores-cards">
            {done.map((row) => (
              <li
                key={row.id}
                className={
                  doneHighlight === row.id ? 'stores-card stores-card-highlight' : 'stores-card'
                }
              >
                <div>
                  <h3>
                    <a href={row.href ?? `/stores/grn?grn=${encodeURIComponent(row.id)}`}>
                      {row.title}
                    </a>
                  </h3>
                  <p>{t(row.statusKey as MessageKey)}</p>
                </div>
                <span className="stores-pill">{t(row.statusKey as MessageKey)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {lotSheet ? (
        <section className="edge-card" role="dialog" aria-labelledby="stores-lot-heading">
          <h2 id="stores-lot-heading">{t('stores.lotSheet.title').replace('{lot}', lotSheet)}</h2>
          <p>{t('stores.lotSheet.body')}</p>
          <a className="primary-action" href={`/damage/new?lot=${encodeURIComponent(lotSheet)}`}>
            {t('stores.lotSheet.reportDamage')}
          </a>
          <button className="secondary-action" type="button" onClick={() => setLotSheet(null)}>
            {t('stores.cancel')}
          </button>
        </section>
      ) : null}
    </div>
  );
}

function CardAction({ card }: { card: InboxCard }) {
  if (card.actionHref && !card.disabledReasonKey) {
    return (
      <a className="primary-action" href={card.actionHref}>
        {t(card.actionKey as MessageKey)}
      </a>
    );
  }
  return (
    <div>
      <button className="primary-action" type="button" disabled>
        {t(card.actionKey as MessageKey)}
      </button>
      {card.disabledReasonKey ? <p>{t(card.disabledReasonKey as MessageKey)}</p> : null}
    </div>
  );
}
