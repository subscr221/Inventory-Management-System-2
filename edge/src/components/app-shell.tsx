import { SyncStatusBadge } from './sync-status-badge';
import { TestCaptureButton } from './test-capture-button';
import { SyncFailureList, type SyncFailureItem } from './sync-failure-list';
import { ServiceWorkerRegistration } from './service-worker-registration';
import { t } from '../i18n/locale';
import type { SyncUiState } from '../sync/sync-status';

export interface AppShellProps {
  userName: string;
  siteName: string;
  syncState: SyncUiState;
  firstSyncRequired?: boolean;
  failures?: SyncFailureItem[];
}

export function AppShell({
  userName,
  siteName,
  syncState,
  firstSyncRequired = false,
  failures = [],
}: AppShellProps) {
  return (
    <div className="edge-shell">
      <ServiceWorkerRegistration />
      <a className="skip-link" href="#main-content">
        {t('app.skipToContent')}
      </a>
      <header className="edge-header">
        <div className="edge-brand">
          <h1>{t('app.title')}</h1>
          <p>
            {userName} · {siteName}
          </p>
        </div>
        <SyncStatusBadge state={syncState} />
      </header>
      <main id="main-content" className="edge-main" tabIndex={-1}>
        {firstSyncRequired ? (
          <section className="edge-card" aria-labelledby="first-sync-heading">
            <h2 id="first-sync-heading">{t('bootstrap.firstSyncTitle')}</h2>
            <p>{t('bootstrap.firstSyncBody')}</p>
            <button className="secondary-action" type="button">
              {t('bootstrap.checkConnection')}
            </button>
          </section>
        ) : (
          <div className="card-grid">
            <section className="edge-card" aria-labelledby="ready-heading">
              <h2 id="ready-heading">{t('bootstrap.readyTitle')}</h2>
              <p>{t('sync.offline')}</p>
            </section>
            <TestCaptureButton />
          </div>
        )}
        <SyncFailureList failures={failures} />
      </main>
    </div>
  );
}
