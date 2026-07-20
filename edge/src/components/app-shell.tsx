import { SyncStatusBadge } from './sync-status-badge';
import { TestCaptureButton } from './test-capture-button';
import { SyncFailureList, type SyncFailureItem } from './sync-failure-list';
import { ServiceWorkerRegistration } from './service-worker-registration';
import { t, type MessageKey } from '../i18n/locale';
import type { SyncUiState } from '../sync/sync-status';

const NAVIGATION: Record<string, { href: string; label: MessageKey }> = {
  Dashboard: { href: '#dashboard', label: 'nav.dashboard' },
  Frontline: { href: '#frontline', label: 'nav.frontline' },
};

export interface AppShellProps {
  userName: string;
  siteName: string;
  syncState: SyncUiState;
  firstSyncRequired?: boolean;
  failures?: SyncFailureItem[];
  navigation?: string[];
  pendingCount?: number;
  failedCount?: number;
  authRequired?: boolean;
  setupError?: boolean;
  onCapture?: () => void;
  onRetry?: () => void;
}

export function AppShell({
  userName,
  siteName,
  syncState,
  firstSyncRequired = false,
  failures = [],
  navigation = ['Dashboard', 'Frontline'],
  pendingCount = 0,
  failedCount = 0,
  authRequired = false,
  setupError = false,
  onCapture,
  onRetry,
}: AppShellProps) {
  const links = navigation.flatMap((item) => (NAVIGATION[item] ? [NAVIGATION[item]] : []));
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
      {links.length > 0 ? (
        <nav className="edge-nav" aria-label={t('nav.label')}>
          {links.map((link) => (
            <a key={link.href} href={link.href}>
              {t(link.label)}
            </a>
          ))}
        </nav>
      ) : null}
      <main id="main-content" className="edge-main" tabIndex={-1}>
        {authRequired ? (
          <div className="auth-required" role="alert">
            {t('sync.authRequired')}
          </div>
        ) : null}
        {setupError ? (
          <div className="auth-required" role="alert">
            {t('sync.setupError')}
          </div>
        ) : null}
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
            <section className="edge-card" id="dashboard" aria-labelledby="ready-heading">
              <h2 id="ready-heading">{t('bootstrap.readyTitle')}</h2>
              <p>{t('sync.offline')}</p>
              <dl className="sync-counts">
                <div>
                  <dt>{t('sync.pendingCount')}</dt>
                  <dd>{pendingCount}</dd>
                </div>
                <div>
                  <dt>{t('sync.failedCount')}</dt>
                  <dd>{failedCount}</dd>
                </div>
              </dl>
            </section>
            <section id="frontline">
              <TestCaptureButton {...(onCapture ? { onCapture } : {})} />
            </section>
          </div>
        )}
        <SyncFailureList failures={failures} {...(onRetry ? { onRetry } : {})} />
      </main>
    </div>
  );
}
