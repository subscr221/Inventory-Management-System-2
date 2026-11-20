'use client';

import { useCallback, useEffect, useState } from 'react';
import { t, type MessageKey } from '../i18n/locale';
import { authorizedFetch } from '../session/api-fetch';
import { useDeviceClass } from '../lib/use-device-class';
import {
  groupQcInbox,
  localDateString,
  mergeQcTasks,
  resolveScannedLot,
  type QcInboxGroupKey,
  type QcTaskListItem,
} from './qc-inbox-model';
import { groupWorkbench, type DamageReport } from './damage-case-view';
import { QcTaskDetail } from './qc-task-detail';

// Story 8.11 (AC 2): the QC inspector's inbox. Five groups in AC order, an always-armed scan bar,
// a header link to /qc/holds (D11), and the ?task= detail. Online-only (D1).

export interface QcInboxProps {
  online: boolean;
  ready: boolean;
  siteId: string;
  userId: string;
  role: string;
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; tasks: QcTaskListItem[]; reports: DamageReport[] }
  | { kind: 'message'; text: string };

const EMPTY_MESSAGE: Record<QcInboxGroupKey, MessageKey> = {
  bay: 'qc.group.emptyBay',
  damage: 'qc.group.emptyDamage',
  awaitingDisposition: 'qc.group.emptyAwaiting',
  sentOn: 'qc.group.emptySentOn',
  doneToday: 'qc.group.emptyDoneToday',
};

const GROUP_LABEL: Record<QcInboxGroupKey, MessageKey> = {
  bay: 'qc.group.bay',
  damage: 'qc.group.damage',
  awaitingDisposition: 'qc.group.awaitingDisposition',
  sentOn: 'qc.group.sentOn',
  doneToday: 'qc.group.doneToday',
};

function readTaskParam(): string | null {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.search).get('task');
  return value && value.trim() ? value.trim() : null;
}

export function QcInbox({ online, ready, siteId, userId, role }: QcInboxProps) {
  const deviceClass = useDeviceClass();
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [taskId, setTaskId] = useState<string | null>(readTaskParam);
  const [scan, setScan] = useState('');
  const [scanNotice, setScanNotice] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPopState = () => setTaskId(readTaskParam());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const openTask = useCallback((id: string) => {
    setTaskId(id);
    if (typeof window !== 'undefined') {
      window.history.pushState({}, '', `/qc/tasks?task=${encodeURIComponent(id)}`);
    }
  }, []);

  const closeTask = useCallback(() => {
    setTaskId(null);
    if (typeof window !== 'undefined') {
      window.history.pushState({}, '', '/qc/tasks');
    }
  }, []);

  const load = useCallback(async () => {
    if (!ready) return;
    if (!siteId) {
      setState({ kind: 'message', text: t('qc.noAccess') });
      return;
    }
    if (!online) return;
    setState((current) => (current.kind === 'ready' ? current : { kind: 'loading' }));
    try {
      const site = encodeURIComponent(siteId);
      const [openRes, samplingRes, inspectedRes, doneRes, damageRes] = await Promise.all([
        authorizedFetch(`/api/v1/qc/tasks?site_id=${site}&gate_status=qc_hold&task_status=open`, {
          credentials: 'include',
        }),
        authorizedFetch(
          `/api/v1/qc/tasks?site_id=${site}&gate_status=qc_hold&task_status=sampling_determined`,
          { credentials: 'include' },
        ),
        authorizedFetch(`/api/v1/qc/tasks?site_id=${site}&task_status=inspected`, {
          credentials: 'include',
        }),
        authorizedFetch(`/api/v1/qc/tasks?site_id=${site}&limit=200`, {
          credentials: 'include',
        }),
        authorizedFetch('/api/v1/damage-reports?view=workbench&limit=200', {
          credentials: 'include',
        }),
      ]);
      const responses = [openRes, samplingRes, inspectedRes, doneRes, damageRes];
      const failed = responses.find((res) => !res.ok);
      if (failed) {
        setState({
          kind: 'message',
          text: t(failed.status === 403 ? 'qc.noAccess' : 'qc.failed'),
        });
        return;
      }
      const parseTasks = async (res: Response): Promise<QcTaskListItem[]> =>
        (((await res.json()) as { tasks?: QcTaskListItem[] }).tasks ?? []) as QcTaskListItem[];
      const [openTasks, samplingTasks, inspectedTasks, allTasks, damageBody] = await Promise.all([
        parseTasks(openRes),
        parseTasks(samplingRes),
        parseTasks(inspectedRes),
        parseTasks(doneRes),
        damageRes.json() as Promise<{ reports?: DamageReport[] }>,
      ]);
      setState({
        kind: 'ready',
        tasks: mergeQcTasks([openTasks, samplingTasks, inspectedTasks, allTasks]),
        reports: (damageBody.reports ?? []) as DamageReport[],
      });
    } catch {
      if (online) setState({ kind: 'message', text: t('qc.failed') });
    }
  }, [online, ready, siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  function submitScan(): void {
    if (state.kind !== 'ready') return;
    const trimmed = scan.trim();
    if (!trimmed) return;
    const matched = resolveScannedLot(state.tasks, trimmed);
    if (!matched) {
      setScanNotice(t('qc.scan.notFound').replace('{lot}', trimmed));
      return;
    }
    setScanNotice(t('qc.scan.announce').replace('{value}', matched.lot_number));
    setScan('');
    openTask(matched.task_id);
  }

  if (!online) {
    return (
      <section className="edge-card" id="qc-tasks" aria-live="polite">
        <header className="qc-inbox-header">
          <h1>{t('qc.title')}</h1>
          <a className="secondary-action" href="/qc/holds">
            {t('qc.holdsLink')}
          </a>
        </header>
        <p>{t('qc.needsConnection')}</p>
        <button className="secondary-action" type="button" onClick={() => window.location.reload()}>
          {t('qc.checkConnection')}
        </button>
      </section>
    );
  }
  if (!ready || state.kind === 'loading') {
    return (
      <div id="qc-tasks" className="qc-inbox">
        <p className="stores-status">{t('qc.loading')}</p>
      </div>
    );
  }
  if (state.kind === 'message') {
    return (
      <section className="edge-card" id="qc-tasks" aria-live="polite">
        <p>{state.text}</p>
        <button className="secondary-action" type="button" onClick={() => void load()}>
          {t('qc.checkConnection')}
        </button>
      </section>
    );
  }

  const wideTwoPane = deviceClass !== 'handheld' && Boolean(taskId);
  const scanBar = (
    <div className="qc-scan" role="search">
      <label className="qc-scan-label" htmlFor="qc-scan-input">
        {t('qc.scan.label')}
      </label>
      <input
        id="qc-scan-input"
        value={scan}
        placeholder={t('qc.scan.placeholder')}
        onChange={(e) => setScan(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submitScan();
        }}
      />
      <p className={scanNotice ? 'qc-scan-notice' : 'qc-scan-hint'} role="status" aria-live="polite">
        {scanNotice ?? t('qc.scan.armed')}
      </p>
    </div>
  );

  const inboxHeader = (
    <header className="qc-inbox-header">
      <h1>{t('qc.title')}</h1>
      <a className="secondary-action" href="/qc/holds">
        {t('qc.holdsLink')}
      </a>
    </header>
  );

  if (taskId) {
    if (wideTwoPane) {
      return (
        <div id="qc-tasks" className="qc-screen" data-device-class={deviceClass}>
          <div className="qc-inbox-pane">
            {inboxHeader}
            {scanBar}
            <QcList state={state} onOpen={openTask} userId={userId} />
          </div>
          <QcTaskDetail
            key={taskId}
            taskId={taskId}
            online={online}
            siteId={siteId}
            userId={userId}
            role={role}
            onComplete={() => void load()}
            onBack={closeTask}
          />
        </div>
      );
    }
    return (
      <div id="qc-tasks" className="qc-screen" data-device-class={deviceClass}>
        <QcTaskDetail
          key={taskId}
          taskId={taskId}
          online={online}
          siteId={siteId}
          userId={userId}
          role={role}
          onComplete={() => void load()}
          onBack={closeTask}
        />
      </div>
    );
  }

  return (
    <div id="qc-tasks" className="qc-inbox" data-device-class={deviceClass}>
      {inboxHeader}
      {scanBar}
      <QcList state={state} onOpen={openTask} userId={userId} />
    </div>
  );
}

function taskCardPill(task: QcTaskListItem, groupKey: QcInboxGroupKey): string {
  if (groupKey === 'doneToday') {
    if (task.released_at && task.gate_status !== 'qc_hold') return t('qc.disposition.released');
    if (task.gate_status === 'qc_hold') return t('qc.pill.hold');
    if (task.disposition === 'reject') return t('qc.disposition.reject');
    if (task.disposition === 'accept') return t('qc.disposition.released');
  }
  return t('qc.pill.hold');
}

function QcList({
  state,
  onOpen,
  userId,
}: {
  state: { kind: 'ready'; tasks: QcTaskListItem[]; reports: DamageReport[] };
  onOpen: (taskId: string) => void;
  userId: string;
}) {
  const today = localDateString(new Date());
  const damageGroups = groupWorkbench(state.reports, userId, today);
  const damageToInspect = (damageGroups.find((g) => g.group === 'to_inspect')?.reports ?? []).map(
    (r) => ({
      report_id: r.report_id,
      lot_number: r.lot_number ?? null,
      whole_lot_requested: r.whole_lot_requested,
    }),
  );
  const damageWholeLot = (damageGroups.find((g) => g.group === 'whole_lot')?.reports ?? []).map(
    (r) => ({
      report_id: r.report_id,
      lot_number: r.lot_number ?? null,
      whole_lot_requested: r.whole_lot_requested,
    }),
  );
  const sentOnCount =
    (damageGroups.find((g) => g.group === 'sent_on')?.reports.length ?? 0) +
    (damageGroups.find((g) => g.group === 'with_ceo')?.reports.length ?? 0);
  const groups = groupQcInbox(
    state.tasks,
    { toInspect: damageToInspect, wholeLot: damageWholeLot, sentOnCount },
    today,
  );

  return (
    <>
      {groups.map((group) => {
        const count =
          group.group === 'sentOn'
            ? group.sentOnCount
            : group.tasks.length + group.damage.length;
        return (
          <section
            className="stores-group"
            aria-labelledby={`qc-group-${group.group}`}
            key={group.group}
          >
            <h2 id={`qc-group-${group.group}`}>{t(GROUP_LABEL[group.group])}</h2>
            {count === 0 ? (
              <div className="emptyst" role="status">
                <p>{t(EMPTY_MESSAGE[group.group])}</p>
              </div>
            ) : group.group === 'sentOn' ? (
              <div className="stores-card qc-sent-on-card">
                <div>
                  <h3>
                    {t('qc.group.sentOnCount').replace('{count}', String(group.sentOnCount))}
                  </h3>
                </div>
                <a className="secondary-action" href="/damage/cases">
                  {t('qc.action.open')}
                </a>
              </div>
            ) : (
              <ul className="stores-cards">
                {group.tasks.map((task) => (
                  <li key={`${group.group}-${task.task_id}`} className="stores-card">
                    <div>
                      <h3>
                        <a
                          href={`/qc/tasks?task=${encodeURIComponent(task.task_id)}`}
                          onClick={(e) => {
                            e.preventDefault();
                            onOpen(task.task_id);
                          }}
                        >
                          {t('qc.card.lot').replace('{lot}', task.lot_number)}
                        </a>
                      </h3>
                      <p>
                        {t('qc.card.sku')
                          .replace('{sku}', task.sku)
                          .replace('{quantity}', task.quantity)}
                      </p>
                      {task.inspect_on_opening ? (
                        <span className="qc-chip">{t('qc.chip.inspectOnOpening')}</span>
                      ) : null}
                    </div>
                    <span className="stores-pill">{taskCardPill(task, group.group)}</span>
                    <a
                      className="primary-action"
                      href={`/qc/tasks?task=${encodeURIComponent(task.task_id)}`}
                      onClick={(e) => {
                        e.preventDefault();
                        onOpen(task.task_id);
                      }}
                    >
                      {t('qc.action.open')}
                    </a>
                  </li>
                ))}
                {group.damage.map((item) => (
                  <li key={item.report_id} className="stores-card">
                    <div>
                      <h3>
                        <a href={`/damage/cases?case=${encodeURIComponent(item.report_id)}`}>
                          {item.lot_number
                            ? t('qc.card.lot').replace('{lot}', item.lot_number)
                            : t('qc.group.damage')}
                        </a>
                      </h3>
                    </div>
                    <span className="stores-pill">{t('qc.pill.hold')}</span>
                    {item.whole_lot_requested ? (
                      <span className="stores-pill">{t('qc.pill.wholeLotRequested')}</span>
                    ) : null}
                    <a
                      className="primary-action"
                      href={`/damage/cases?case=${encodeURIComponent(item.report_id)}`}
                    >
                      {t('qc.action.open')}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </>
  );
}
