'use client';

import { t } from '../i18n/locale';
import type { CachedWorkOrderRow, WorklistClosure } from '../local-db/worklist';
import type { SyncUiState } from '../sync/sync-status';
import { SyncStatusBadge } from './sync-status-badge';

export interface MaintenanceWorklistProps {
  syncState: SyncUiState;
  workOrders: CachedWorkOrderRow[];
  total: number;
  truncated: boolean;
  fetchedAt: string | null;
  selectedWorkOrderId: string | null;
  onSelect?: (workOrderId: string) => void;
  onRefresh?: () => void;
}

function parseClosures(raw: string): WorklistClosure[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as WorklistClosure[]) : [];
  } catch {
    return [];
  }
}

/**
 * Story 7.8 (FR-M-17, FR-M-18, Binding Decisions 9 and 11): the cached work-order cards. The
 * "N more work orders not loaded" line renders whenever the cached snapshot was truncated, so a
 * work order that is not on the device can never be silently absent. The last-five closures panel
 * opens WITH the selected work order (AC 4).
 */
export function MaintenanceWorklist({
  syncState,
  workOrders,
  total,
  truncated,
  fetchedAt,
  selectedWorkOrderId,
  onSelect,
  onRefresh,
}: MaintenanceWorklistProps) {
  const notLoaded = Math.max(total - workOrders.length, 0);
  const selected = workOrders.find((row) => row.work_order_id === selectedWorkOrderId) ?? null;
  const closures = selected ? parseClosures(selected.recent_closures) : [];

  return (
    <section className="edge-card maintenance-worklist" aria-labelledby="maintenance-worklist-heading">
      <header className="maintenance-worklist-header">
        <h2 id="maintenance-worklist-heading">{t('maintenance.worklist.title')}</h2>
        <SyncStatusBadge state={syncState} />
      </header>
      <p>{t('maintenance.description')}</p>
      {fetchedAt ? (
        <p className="maintenance-fetched-at">
          {t('maintenance.worklist.fetchedAt')}: {fetchedAt}
        </p>
      ) : null}
      {truncated ? (
        <p className="maintenance-truncated" role="status">
          {notLoaded} {t('maintenance.worklist.truncated')}
        </p>
      ) : null}
      <button className="secondary-action" type="button" onClick={() => onRefresh?.()}>
        {t('maintenance.worklist.refresh')}
      </button>
      {workOrders.length === 0 ? (
        <p>{t('maintenance.worklist.empty')}</p>
      ) : (
        <ul className="maintenance-work-orders">
          {workOrders.map((row) => (
            <li key={row.work_order_id} className="maintenance-work-order">
              <div>
                <strong>{row.asset_tag}</strong> · {row.asset_name}
              </div>
              <dl className="maintenance-work-order-facts">
                <div>
                  <dt>{t('maintenance.worklist.origin')}</dt>
                  <dd>{row.origin}</dd>
                </div>
                <div>
                  <dt>{t('maintenance.worklist.status')}</dt>
                  <dd>{row.status}</dd>
                </div>
                <div>
                  <dt>{t('maintenance.worklist.priority')}</dt>
                  <dd>{row.priority ?? '-'}</dd>
                </div>
                <div>
                  <dt>{t('maintenance.worklist.dueDate')}</dt>
                  <dd>{row.due_date}</dd>
                </div>
                {row.warranty_flagged ? (
                  <div>
                    <dt>{t('maintenance.worklist.warranty')}</dt>
                    <dd>{row.warranty_flagged}</dd>
                  </div>
                ) : null}
              </dl>
              <button
                className={row.work_order_id === selectedWorkOrderId ? 'primary-action' : 'secondary-action'}
                type="button"
                aria-pressed={row.work_order_id === selectedWorkOrderId}
                onClick={() => onSelect?.(row.work_order_id)}
              >
                {t('maintenance.worklist.select')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected ? (
        <section className="maintenance-closures" aria-labelledby="maintenance-closures-heading">
          <h3 id="maintenance-closures-heading">{t('maintenance.closures.title')}</h3>
          {closures.length === 0 ? (
            <p>{t('maintenance.closures.empty')}</p>
          ) : (
            <ol>
              {closures.map((closure) => (
                <li key={closure.work_order_id}>
                  <span>
                    {t('maintenance.closures.fault')}: {closure.fault_code}
                  </span>
                  {' · '}
                  <span>
                    {t('maintenance.closures.cause')}: {closure.cause_code}
                  </span>
                  {' · '}
                  <span>
                    {t('maintenance.closures.remedy')}: {closure.remedy_code}
                  </span>
                  {' · '}
                  <span>
                    {t('maintenance.closures.closedAt')}: {closure.closed_at}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}
    </section>
  );
}
