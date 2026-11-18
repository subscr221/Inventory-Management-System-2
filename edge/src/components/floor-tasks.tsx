'use client';

import { useCallback, useEffect, useState } from 'react';
import { t, type MessageKey } from '../i18n/locale';
import { authorizedFetch } from '../session/api-fetch';
import { useDeviceClass } from '../lib/use-device-class';
import { PickLine, type PickLineProps } from './pick-line';
import { buildInbox, mergeTasks, pillKeyFor, type PickTaskRow } from './floor-tasks-model';

/**
 * Story 3.16 (AC 1, 2, 6, 7): the floor task inbox, which opens each pick list one line at a time.
 * On Handheld a selected task is its own page with Back; on Tablet and Desktop the inbox and the
 * active task render side by side.
 */

export interface FloorTasksProps {
  online: boolean;
  ready: boolean;
  siteId: string;
  userId: string;
  checkHeldLot?: (lotNumber: string) => Promise<string | null>;
  onConfirmPickLine?: PickLineProps['onConfirm'];
  settlementOf?: PickLineProps['settlementOf'];
  refusalCodeOf?: PickLineProps['refusalCodeOf'];
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; tasks: PickTaskRow[]; fetchedAt: string }
  | { kind: 'message'; text: string };

export function FloorTasks({
  online,
  ready,
  siteId,
  userId,
  checkHeldLot,
  onConfirmPickLine,
  settlementOf,
  refusalCodeOf,
}: FloorTasksProps) {
  const deviceClass = useDeviceClass();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [taskId, setTaskId] = useState(() => {
    if (typeof window === 'undefined') return '';
    return new URLSearchParams(window.location.search).get('task') ?? '';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setTaskId(new URLSearchParams(window.location.search).get('task') ?? '');
  }, [typeof window !== 'undefined' ? window.location.search : '']);

  const load = useCallback(async () => {
    if (!siteId) {
      setState({ kind: 'message', text: t('floor.noAccess') });
      return;
    }
    if (!online) return;
    // A refresh after a pick completes must not unmount the open PickLine (it holds the
    // device-confirmed lines the server may not have yet), so only the first load shows loading.
    setState((current) => (current.kind === 'ready' ? current : { kind: 'loading' }));
    try {
      const site = encodeURIComponent(siteId);
      const [pendingRes, inProgressRes] = await Promise.all([
        authorizedFetch(`/api/v1/pick-tasks?site=${site}&status=pending`),
        authorizedFetch(`/api/v1/pick-tasks?site=${site}&status=in_progress`),
      ]);
      const body = async (
        res: Response,
      ): Promise<{ ok: boolean; pick_tasks: PickTaskRow[] }> =>
        res.ok
          ? {
              ok: true,
              pick_tasks:
                ((await res.json()) as { pick_tasks?: PickTaskRow[] }).pick_tasks ?? [],
            }
          : { ok: false, pick_tasks: [] };
      const pendingBody = await body(pendingRes);
      const inProgressBody = await body(inProgressRes);
      if (!pendingBody.ok || !inProgressBody.ok) {
        setState({ kind: 'message', text: t('floor.failed') });
        return;
      }
      const pending = pendingBody.pick_tasks ?? [];
      const inProgress = inProgressBody.pick_tasks ?? [];
      setState({
        kind: 'ready',
        tasks: buildInbox(mergeTasks(pending, inProgress), userId),
        fetchedAt: new Date().toISOString(),
      });
    } catch {
      if (online) setState({ kind: 'message', text: t('floor.needsConnection') });
    }
  }, [online, siteId, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const pickLineProps = {
    online,
    ready,
    ...(checkHeldLot ? { checkHeldLot } : {}),
    ...(onConfirmPickLine ? { onConfirm: onConfirmPickLine } : {}),
    ...(settlementOf ? { settlementOf } : {}),
    ...(refusalCodeOf ? { refusalCodeOf } : {}),
  };

  // Offline: an in-progress pick can continue from cached state; otherwise keep the last list.
  if (!online) {
    if (taskId) {
      return (
        <div id="floor-tasks" className="floor-screen" data-device-class={deviceClass}>
          <PickLine
            key={taskId}
            taskId={taskId}
            {...pickLineProps}
            onComplete={() => void load()}
          />
        </div>
      );
    }
    if (state.kind === 'ready') {
      return (
        <div id="floor-tasks" className="floor-inbox">
          <p className="stores-status" role="status">
            {t('floor.offlineList').replace('{time}', formatShort(state.fetchedAt))}
          </p>
          <FloorList tasks={state.tasks} userId={userId} />
        </div>
      );
    }
    return (
      <section className="edge-card" aria-live="polite">
        <p>{t('floor.needsConnection')}</p>
        <button className="secondary-action" type="button" onClick={() => window.location.reload()}>
          {t('floor.checkConnection')}
        </button>
      </section>
    );
  }

  if (!ready) {
    return <p className="stores-status">{t('floor.loading')}</p>;
  }
  if (state.kind === 'loading') {
    return <p className="stores-status">{t('floor.loading')}</p>;
  }
  if (state.kind === 'message') {
    return (
      <section className="edge-card" aria-live="polite">
        <p>{state.text}</p>
        <button className="secondary-action" type="button" onClick={() => void load()}>
          {t('floor.checkConnection')}
        </button>
      </section>
    );
  }

  const wideTwoPane = deviceClass !== 'handheld' && Boolean(taskId);

  return (
    <div id="floor-tasks" className="floor-screen" data-device-class={deviceClass}>
      {wideTwoPane ? <FloorList tasks={state.tasks} userId={userId} /> : null}
      {taskId ? (
        <PickLine
          key={taskId}
          taskId={taskId}
          {...pickLineProps}
          onComplete={() => void load()}
        />
      ) : (
        <FloorList tasks={state.tasks} userId={userId} />
      )}
    </div>
  );
}

function FloorList({ tasks, userId }: { tasks: PickTaskRow[]; userId: string }) {
  const mine = tasks.filter(
    (row) => row.assigned_to === userId || row.assigned_to === null,
  );
  return (
    <section className="stores-group" aria-labelledby="floor-group-heading">
      <h2 id="floor-group-heading">{t('floor.group.salesOrders')}</h2>
      {mine.length === 0 ? (
        <div className="emptyst" role="status">
          <h3>{t('floor.empty')}</h3>
          <p>{t('floor.emptyHint')}</p>
        </div>
      ) : (
        <ul className="stores-cards">
          {mine.map((row) => {
            const picked = row.confirmed_line_count ?? 0;
            const total = row.line_count ?? 0;
            return (
              <li key={row.pick_task_id} className="stores-card">
                <div>
                  <h3>
                    <a href={`/floor/tasks?task=${encodeURIComponent(row.pick_task_id)}`}>
                      {row.pick_task_id}
                    </a>
                  </h3>
                  <p>
                    {row.so_number_ext ?? row.dispatch_order_id} ·{' '}
                    {t('floor.pickedOf').replace('{picked}', String(picked)).replace('{total}', String(total))}
                  </p>
                </div>
                <span className="stores-pill">{t(pillKeyFor(row.status) as MessageKey)}</span>
                <a className="primary-action" href={`/floor/tasks?task=${encodeURIComponent(row.pick_task_id)}`}>
                  {t('floor.action.open')}
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function formatShort(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    );
  } catch {
    return iso;
  }
}
