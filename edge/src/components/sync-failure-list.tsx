import { errorMessage, formatDateTime, t } from '../i18n/locale';

export interface SyncFailureItem {
  eventId: string;
  eventType: string;
  errorCode: string;
  failedAt: string;
}

export function SyncFailureList({
  failures,
  onRetry,
}: {
  failures: SyncFailureItem[];
  onRetry?: () => void;
}) {
  if (failures.length === 0) return null;
  return (
    <section className="edge-card" aria-labelledby="sync-failure-heading">
      <h2 id="sync-failure-heading">{t('sync.failedNeedsAttention')}</h2>
      <ul aria-live="assertive">
        {failures.map((failure) => (
          <li key={failure.eventId}>
            <strong>{failure.eventType}</strong>: {errorMessage(failure.errorCode)} (
            {failure.errorCode}) <span>{formatDateTime(failure.failedAt)}</span>
            {failure.eventType === 'cross_dock_task.completed' ? <p>{t('crossDock.correction')}</p> : null}
          </li>
        ))}
      </ul>
      <button className="secondary-action" type="button" onClick={onRetry}>
        {t('sync.retry')}
      </button>
    </section>
  );
}
