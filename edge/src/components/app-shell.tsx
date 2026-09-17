import { SyncStatusBadge } from './sync-status-badge';
import { TestCaptureButton } from './test-capture-button';
import { SyncFailureList, type SyncFailureItem } from './sync-failure-list';
import { ServiceWorkerRegistration } from './service-worker-registration';
import { CrossDockCapture, type CrossDockTaskContext } from './cross-dock-capture';
import { IndentCapture, type IndentSubmitInput } from './indent-capture';
import { MaintenanceWorklist } from './maintenance-worklist';
import { RefusedCapturesScreen, type RefusedCapturesScreenProps } from './refused-captures-screen';
import { FaultReportCapture, type FaultReportSubmitInput } from './fault-report-capture';
import {
  WorkOrderStatusCapture,
  type WorkOrderStatusSubmitInput,
} from './work-order-status-capture';
import { MeterReadingCapture, type MeterReadingSubmitInput } from './meter-reading-capture';
import { SpareIssueCapture, type SpareIssueSubmitInput } from './spare-issue-capture';
import {
  WorkOrderClosureCapture,
  type ClosureCatalogue,
  type WorkOrderClosureSubmitInput,
} from './work-order-closure-capture';
import { GlobalSearch } from './search/global-search';
import { EnhancedDashboard } from './dashboard/enhanced-dashboard';
import { WorkflowsView } from './enterprise/workflows-view';
import { AccessControlView } from './enterprise/access-control-view';
import { ReportsView } from './enterprise/reports-view';
import { entriesFor } from './navigation/nav-model';
import { t, type MessageKey } from '../i18n/locale';
import type { SyncUiState } from '../sync/sync-status';
import type { CachedReservationRow, CachedWorkOrderRow, WorklistMeter } from '../local-db/worklist';

/**
 * Story 7.8: everything the maintenance view needs, injected by the edge client. The bootstrap
 * `navigation` array is NOT extended; the /maintenance page is reached from a link in the
 * frontline section instead.
 */
export interface MaintenanceShellProps {
  workOrders: CachedWorkOrderRow[];
  total: number;
  truncated: boolean;
  fetchedAt: string | null;
  selectedWorkOrderId: string | null;
  selectedMeters: WorklistMeter[];
  selectedReservations: CachedReservationRow[];
  closureCatalogue: ClosureCatalogue;
  onSelectWorkOrder?: (workOrderId: string) => void;
  onRefreshWorklist?: () => void;
  onSubmitFaultReport?: (input: FaultReportSubmitInput) => Promise<string>;
  onSubmitStatusUpdate?: (input: WorkOrderStatusSubmitInput) => Promise<string>;
  onSubmitMeterReading?: (input: MeterReadingSubmitInput) => Promise<string>;
  onSubmitSpareIssue?: (input: SpareIssueSubmitInput) => Promise<string>;
  onSubmitClosure?: (input: WorkOrderClosureSubmitInput) => Promise<string>;
}

export interface AppShellProps {
  userName: string;
  siteName: string;
  role?: string;
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
  onLoadCrossDockTask?: (taskId: string) => Promise<CrossDockTaskContext | null>;
  onConfirmCrossDock?: (task: CrossDockTaskContext, stagingBinCode: string) => Promise<string>;
  onSubmitIndent?: (input: IndentSubmitInput) => Promise<string>;
  /**
   * Story 7.8: 'frontline' (default, the Story 1.8 shell) or 'maintenance' (the technician page).
   * Story 1.14: 'refused-captures' (the site supervisor's screen).
   * Enterprise: 'workflows', 'access-control', and 'reports' (Phase 3/4 management views).
   */
  view?:
    | 'frontline'
    | 'dashboard'
    | 'maintenance'
    | 'refused-captures'
    | 'workflows'
    | 'access-control'
    | 'reports';
  maintenance?: MaintenanceShellProps;
  /** Story 1.14: what the refused-captures screen needs, injected by the edge client. */
  refusedCaptures?: RefusedCapturesScreenProps;
  /** Story 1.14 (AC 6): drop the device's retained copy of one refused capture. */
  onDismissFailure?: (eventId: string) => Promise<void>;
  /** Story 1.12 (AC4): shared-tablet sign-out. Rendered only when the edge client provides it. */
  onSignOut?: () => void;
  /** Story 1.12 (AC4): unsettled captures that blocked the last sign-out attempt (0 = none). */
  signOutBlockedCount?: number;
  /** Story 1.12 (AC5): offline with no cached sign-in; nothing can be done until the network returns. */
  offlineNoSession?: boolean;
  /** Story 1.12: a sign-out is in progress (the button is disabled). */
  signingOut?: boolean;
  /** Story 1.12: tokens were cleared but the Keycloak logout redirect could not be reached. */
  signOutIncomplete?: boolean;
  /** Story 1.12: captures parked for people other than the signed-in user (userName '' = unknown). */
  waitingForOthers?: Array<{ userName: string; count: number }>;
}

function countMessage(count: number, one: MessageKey, many: MessageKey): string {
  return t(count === 1 ? one : many).replace('{count}', String(count));
}

export function AppShell({
  userName,
  siteName,
  role = '',
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
  onLoadCrossDockTask,
  onConfirmCrossDock,
  onSubmitIndent,
  view = 'frontline',
  maintenance,
  refusedCaptures,
  onDismissFailure,
  onSignOut,
  signOutBlockedCount = 0,
  offlineNoSession = false,
  signingOut = false,
  signOutIncomplete = false,
  waitingForOthers = [],
}: AppShellProps) {
  const navEntries = entriesFor(navigation);
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
        <div className="edge-header-actions">
          <GlobalSearch currentRole={role} navigation={navigation} />
          <SyncStatusBadge state={syncState} />
          {onSignOut ? (
            <button
              type="button"
              className="secondary-action"
              onClick={onSignOut}
              disabled={signingOut}
              aria-busy={signingOut}
            >
              {t('auth.signOut')}
            </button>
          ) : null}
        </div>
      </header>
      {signOutBlockedCount > 0 ? (
        <p className="auth-sign-out-blocked" role="status" aria-live="polite">
          {countMessage(signOutBlockedCount, 'auth.signOutBlockedOne', 'auth.signOutBlocked')}
        </p>
      ) : null}
      {signOutIncomplete ? (
        <p className="auth-sign-out-blocked" role="alert">
          {t('auth.signOutIncomplete')}
        </p>
      ) : null}
      {waitingForOthers.map((entry, index) => (
        <p key={`${entry.userName}-${index}`} className="auth-sign-out-blocked" role="status">
          {countMessage(entry.count, 'auth.waitingForOwnerOne', 'auth.waitingForOwner').replace(
            '{name}',
            entry.userName || t('auth.unknownOwner'),
          )}
        </p>
      ))}
      {navEntries.length > 0 ? (
        <nav className="edge-nav" aria-label={t('nav.label')}>
          {navEntries.map((link) => (
            <a key={link.href} href={link.href}>
              {t(link.label as MessageKey)}
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
        {offlineNoSession ? (
          <div className="auth-required" role="alert">
            {t('auth.offlineNoSession')}
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
        ) : view === 'refused-captures' ? (
          refusedCaptures ? (
            <RefusedCapturesScreen {...refusedCaptures} />
          ) : (
            <section className="edge-card" id="refused-captures" aria-labelledby="refused-unavailable-heading">
              <h2 id="refused-unavailable-heading">{t('refused.title')}</h2>
              <p>{t('refused.needsConnection')}</p>
            </section>
          )
        ) : view === 'maintenance' ? (
          <div className="card-grid" id="maintenance">
            {maintenance ? (
              <>
                <MaintenanceWorklist
                  syncState={syncState}
                  workOrders={maintenance.workOrders}
                  total={maintenance.total}
                  truncated={maintenance.truncated}
                  fetchedAt={maintenance.fetchedAt}
                  selectedWorkOrderId={maintenance.selectedWorkOrderId}
                  {...(maintenance.onSelectWorkOrder ? { onSelect: maintenance.onSelectWorkOrder } : {})}
                  {...(maintenance.onRefreshWorklist ? { onRefresh: maintenance.onRefreshWorklist } : {})}
                />
                <FaultReportCapture
                  {...(maintenance.onSubmitFaultReport ? { onSubmit: maintenance.onSubmitFaultReport } : {})}
                />
                <WorkOrderStatusCapture
                  key={maintenance.selectedWorkOrderId ?? 'none'}
                  workOrderId={maintenance.selectedWorkOrderId}
                  currentStatus={
                    maintenance.workOrders.find(
                      (row) => row.work_order_id === maintenance.selectedWorkOrderId,
                    )?.status ?? null
                  }
                  {...(maintenance.onSubmitStatusUpdate ? { onSubmit: maintenance.onSubmitStatusUpdate } : {})}
                />
                <MeterReadingCapture
                  key={maintenance.selectedWorkOrderId ?? 'none'}
                  meters={maintenance.selectedMeters}
                  {...(maintenance.onSubmitMeterReading ? { onSubmit: maintenance.onSubmitMeterReading } : {})}
                />
                <SpareIssueCapture
                  key={maintenance.selectedWorkOrderId ?? 'none'}
                  reservations={maintenance.selectedReservations}
                  {...(maintenance.onSubmitSpareIssue ? { onSubmit: maintenance.onSubmitSpareIssue } : {})}
                />
                <WorkOrderClosureCapture
                  key={maintenance.selectedWorkOrderId ?? 'none'}
                  workOrderId={maintenance.selectedWorkOrderId}
                  origin={
                    maintenance.workOrders.find(
                      (row) => row.work_order_id === maintenance.selectedWorkOrderId,
                    )?.origin ?? null
                  }
                  catalogue={maintenance.closureCatalogue}
                  {...(maintenance.onSubmitClosure ? { onSubmit: maintenance.onSubmitClosure } : {})}
                />
              </>
            ) : (
              <section className="edge-card" aria-labelledby="maintenance-unavailable-heading">
                <h2 id="maintenance-unavailable-heading">{t('maintenance.title')}</h2>
                <p>{t('maintenance.unavailable')}</p>
              </section>
            )}
          </div>
        ) : view === 'dashboard' ? (
          <EnhancedDashboard
            role={role}
            pendingCount={pendingCount}
            failedCount={failedCount}
          />
        ) : view === 'workflows' ? (
          <WorkflowsView currentUserName={userName} />
        ) : view === 'access-control' ? (
          <AccessControlView />
        ) : view === 'reports' ? (
          <ReportsView currentUserName={userName} />
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
              <CrossDockCapture
                syncState={syncState}
                {...(onLoadCrossDockTask ? { onLoad: onLoadCrossDockTask } : {})}
                {...(onConfirmCrossDock ? { onConfirm: onConfirmCrossDock } : {})}
              />
              <IndentCapture
                syncState={syncState}
                {...(onSubmitIndent ? { onSubmit: onSubmitIndent } : {})}
              />
              <TestCaptureButton {...(onCapture ? { onCapture } : {})} />
              <a className="secondary-action" href="/maintenance">
                {t('maintenance.nav')}
              </a>
            </section>
          </div>
        )}
        <SyncFailureList
          failures={failures}
          {...(onRetry ? { onRetry } : {})}
          {...(onDismissFailure ? { onDismiss: onDismissFailure } : {})}
        />
      </main>
    </div>
  );
}
