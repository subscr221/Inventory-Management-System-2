import { errorMessage, formatDateTime, t } from '../i18n/locale';

export interface SyncFailureItem {
  eventId: string;
  eventType: string;
  errorCode: string;
  failedAt: string;
}

export function SyncFailureList({ failures }: { failures: SyncFailureItem[] }) {
  if (failures.length === 0) return null;
  return (
    <section className="edge-card" aria-labelledby="sync-failure-heading">
      <h2 id="sync-failure-heading">{t('sync.failedNeedsAttention')}</h2>
      <ul>
        {failures.map((failure) => (
          <li key={failure.eventId}>
            <strong>{failure.eventType}</strong>: {errorMessage(failure.errorCode)} (
            {failure.errorCode}) <span>{formatDateTime(failure.failedAt)}</span>
          </li>
        ))}
      </ul>
      <button className="secondary-action" type="button">
        {t('sync.retry')}
      </button>
    </section>
  );
}
