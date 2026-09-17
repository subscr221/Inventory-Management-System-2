'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PowerSyncDatabase } from '@powersync/web';
import { createTestCaptureEvent } from '../capture/test-capture';
import { createCrossDockCompletionEvent } from '../capture/cross-dock';
import { assertLotNotHeld } from '../capture/held-lot';
import { createIndentRaisedEvent } from '../capture/indent';
import {
  createFaultReportedEvent,
  createMeterReadingRecordedEvent,
  createSpareIssuedEvent,
  createWorkOrderCompletedEvent,
  createWorkOrderStatusUpdatedEvent,
} from '../capture/maintenance';
import { AppShell } from './app-shell';
import type { CrossDockTaskContext } from './cross-dock-capture';
import type { IndentSubmitInput } from './indent-capture';
import type { FaultReportSubmitInput } from './fault-report-capture';
import type { WorkOrderStatusSubmitInput } from './work-order-status-capture';
import type { MeterReadingSubmitInput } from './meter-reading-capture';
import type { SpareIssueSubmitInput } from './spare-issue-capture';
import type { WorkOrderClosureSubmitInput } from './work-order-closure-capture';
import { t } from '../i18n/locale';
import { createEdgeDatabase } from '../local-db/database';
import {
  cacheContext,
  clearCachedUserContext,
  countUnsettled,
  dismissRetainedRow,
  hasAuthRequired,
  insertCaptureEvent,
  readCachedContext,
  readFailures,
  readOutboxCounts,
  readWaitingForOtherOwners,
  resetAuthRequired,
  salvageUnheldOutboxRows,
} from '../local-db/outbox';
import {
  applyWorklistSnapshot,
  nextStreamVersion,
  readCachedReservations,
  readCachedWorkOrders,
  readClosureCatalogue,
  type CachedReservationRow,
  type CachedWorkOrderRow,
  type WorklistMeter,
} from '../local-db/worklist';
import { EdgePowerSyncConnector } from '../sync/connector';
import { deriveSyncUiState, type SyncUiState } from '../sync/sync-status';
import { refreshWorklist } from '../sync/worklist-refresh';
import { authorizedFetch } from '../session/api-fetch';
import { AuthConfigUnavailableError, loadAuthConfig } from '../session/auth-config';
import { createBrowserSession, setActiveSession, type EdgeSession } from '../session/session';

interface BootstrapResponse {
  user_id: string;
  user_name: string;
  site_id: string;
  site_name: string;
  role: string;
  navigation: string[];
}

interface WorklistMeta {
  total: number;
  truncated: boolean;
  fetchedAt: string | null;
}

interface RuntimeState {
  userId: string;
  userName: string;
  siteId: string;
  siteName: string;
  role: string;
  navigation: string[];
  pendingCount: number;
  failedCount: number;
  failures: Array<{ eventId: string; eventType: string; errorCode: string; failedAt: string }>;
  authRequired: boolean;
  firstSyncRequired: boolean;
  setupError: boolean;
  // Story 1.12: offline with no cached sign-in; unsettled captures that blocked a sign-out.
  offlineNoSession: boolean;
  signOutBlockedCount: number;
  signOutAvailable: boolean;
  signingOut: boolean;
  signOutIncomplete: boolean;
  // Story 1.12 (review decision 1): captures parked for people other than the signed-in user.
  waitingForOthers: Array<{ userName: string; count: number }>;
  syncState: SyncUiState;
  // Story 1.14 (AC 5): navigator.onLine as of the last outbox refresh or online/offline event.
  online: boolean;
  // Story 7.8: the cached technician worklist.
  workOrders: CachedWorkOrderRow[];
  worklistMeta: WorklistMeta;
  closureCatalogue: { fault: string[]; cause: string[]; remedy: string[] };
  selectedWorkOrderId: string | null;
  selectedReservations: CachedReservationRow[];
}

const initialState: RuntimeState = {
  userId: '',
  userName: '',
  siteId: '',
  siteName: '',
  role: '',
  navigation: [],
  pendingCount: 0,
  failedCount: 0,
  failures: [],
  authRequired: false,
  firstSyncRequired: false,
  setupError: false,
  offlineNoSession: false,
  signOutBlockedCount: 0,
  signOutAvailable: false,
  signingOut: false,
  signOutIncomplete: false,
  waitingForOthers: [],
  syncState: 'offline',
  online: true,
  workOrders: [],
  worklistMeta: { total: 0, truncated: false, fetchedAt: null },
  closureCatalogue: { fault: [], cause: [], remedy: [] },
  selectedWorkOrderId: null,
  selectedReservations: [],
};

const WORKLIST_META_KEY = 'inventory-edge-worklist-meta';
// Story 1.12: display names of everyone who has signed in on this device, so captures parked for
// another person can say whose they are after that person's cached context was replaced.
const KNOWN_USERS_KEY = 'inventory-edge-known-users';

function readKnownUsers(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KNOWN_USERS_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function rememberKnownUser(userId: string, userName: string): void {
  try {
    localStorage.setItem(KNOWN_USERS_KEY, JSON.stringify({ ...readKnownUsers(), [userId]: userName }));
  } catch {
    // Storage unavailable: the notice falls back to a generic owner label.
  }
}

function deviceId(): string {
  const key = 'inventory-edge-device-id';
  const current = localStorage.getItem(key);
  if (current) return current;
  const created = crypto.randomUUID();
  localStorage.setItem(key, created);
  return created;
}

function readWorklistMeta(): WorklistMeta {
  try {
    const raw = localStorage.getItem(WORKLIST_META_KEY);
    if (!raw) return { total: 0, truncated: false, fetchedAt: null };
    const parsed = JSON.parse(raw) as Partial<WorklistMeta>;
    return {
      total: typeof parsed.total === 'number' ? parsed.total : 0,
      truncated: parsed.truncated === true,
      fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : null,
    };
  } catch {
    return { total: 0, truncated: false, fetchedAt: null };
  }
}

function parseMeters(raw: string | undefined): WorklistMeter[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as WorklistMeter[]) : [];
  } catch {
    return [];
  }
}

export function EdgeClient({
  view = 'frontline',
}: {
  view?:
    | 'frontline'
    | 'maintenance'
    | 'refused-captures'
    | 'workflows'
    | 'access-control'
    | 'reports';
}) {
  const database = useRef<PowerSyncDatabase | null>(null);
  // Story 1.12: the sign-in session and a guard so a burst of 401s issues one login redirect.
  const session = useRef<EdgeSession | null>(null);
  const redirecting = useRef(false);
  // Story 1.12: the user the API confirmed at bootstrap; the connector uploads only their rows.
  const signedInUserId = useRef<string | null>(null);
  // Story 1.12: the API rejected the token (survives outbox-driven recomputes of `authRequired`).
  const sessionAuthLost = useRef(false);
  // Story 1.12: no capture may start between the sign-out count and the identity being cleared.
  const signingOut = useRef(false);
  const [state, setState] = useState(initialState);

  const insertOwnCapture = useCallback(async (db: PowerSyncDatabase, event: Parameters<typeof insertCaptureEvent>[1]) => {
    if (signingOut.current) throw new Error('Signing out: capture is closed');
    await insertCaptureEvent(db, event);
  }, []);

  const refreshLocalState = useCallback(async (db: PowerSyncDatabase) => {
    const currentUser = signedInUserId.current;
    const [counts, failures, rowsAuthRequired, waiting, ownUnsettled] = await Promise.all([
      readOutboxCounts(db),
      readFailures(db),
      hasAuthRequired(db, currentUser ?? undefined),
      currentUser ? readWaitingForOtherOwners(db, currentUser) : Promise.resolve([]),
      currentUser ? countUnsettled(db, currentUser) : Promise.resolve(0),
    ]);
    const authRequired = rowsAuthRequired || sessionAuthLost.current;
    const knownUsers = readKnownUsers();
    const online = navigator.onLine;
    const syncing = Boolean(db.currentStatus.dataFlowStatus.uploading);
    setState((current) => ({
      ...current,
      ...counts,
      failures: failures.map((failure) => ({
        eventId: failure.id,
        eventType: failure.event_type,
        errorCode: failure.server_error_code ?? 'INVALID_EVENT_ENVELOPE',
        failedAt: failure.created_at,
      })),
      authRequired,
      waitingForOthers: waiting.map((entry) => ({
        userName: knownUsers[entry.userId] ?? '',
        count: entry.count,
      })),
      // Story 1.12 (AC4): once nothing is left to upload, the sign-out gate notice goes away.
      signOutBlockedCount: ownUnsettled === 0 ? 0 : current.signOutBlockedCount,
      online,
      syncState: authRequired
        ? 'error'
        : deriveSyncUiState({ online, syncing, ...counts }),
    }));
  }, []);

  // Story 7.8: read the cached worklist (survives restarts; the snapshot meta lives in localStorage).
  const loadWorklistFromCache = useCallback(async (db: PowerSyncDatabase) => {
    const [workOrders, closureCatalogue] = await Promise.all([
      readCachedWorkOrders(db),
      readClosureCatalogue(db),
    ]);
    const meta = readWorklistMeta();
    setState((current) => {
      const selectedStillCached =
        current.selectedWorkOrderId !== null &&
        workOrders.some((row) => row.work_order_id === current.selectedWorkOrderId);
      return {
        ...current,
        workOrders,
        closureCatalogue,
        worklistMeta: meta,
        selectedWorkOrderId: selectedStillCached ? current.selectedWorkOrderId : null,
        selectedReservations: selectedStillCached ? current.selectedReservations : [],
      };
    });
  }, []);

  // Story 7.8 (Binding Decision 11): fetch on app start when online and on the `online` event,
  // never on a timer. A failed fetch leaves the cached snapshot in place.
  const refreshWorklistNow = useCallback(
    async (db: PowerSyncDatabase) => {
      const snapshot = await refreshWorklist();
      if (!snapshot) return;
      await applyWorklistSnapshot(db, snapshot);
      localStorage.setItem(
        WORKLIST_META_KEY,
        JSON.stringify({
          total: snapshot.total,
          truncated: snapshot.truncated,
          fetchedAt: snapshot.fetched_at,
        }),
      );
      await loadWorklistFromCache(db);
    },
    [loadWorklistFromCache],
  );

  useEffect(() => {
    let cancelled = false;
    let stopWatching: (() => void) | undefined;
    let stopAuthLost: (() => void) | undefined;

    // Story 1.12 (AC3): the API rejected the token after a refresh, or the refresh itself failed.
    // Online: back to the login page, remembering this screen; the outbox keeps every capture
    // (nothing here touches edge_outbox). Offline: only the sync banner changes; capture continues
    // and the parked rows are re-queued after the next sign-in.
    function redirectToSignIn() {
      const current = session.current;
      if (!current || current.mode !== 'oidc' || !navigator.onLine || redirecting.current) return;
      redirecting.current = true;
      void current
        .requestSignIn(window.location.pathname + window.location.search)
        .catch(() => {
          redirecting.current = false;
        });
    }

    function onAuthLost() {
      // Local mode has no sign-in page to recover through; a rejected dev token is not a banner.
      if (session.current?.mode !== 'oidc') return;
      sessionAuthLost.current = true;
      setState((current) => ({ ...current, authRequired: true, syncState: 'error' }));
      redirectToSignIn();
    }

    async function start() {
      try {
        const db = createEdgeDatabase();
        database.current = db;
        await db.init();
        if (cancelled) return;

        const cached = await readCachedContext(db);
        if (cached) {
          setState((current) => ({
            ...current,
            userId: cached.user.userId,
            userName: cached.user.userName,
            role: cached.user.role,
            siteId: cached.site.siteId,
            siteName: cached.site.siteName,
            navigation: ['Dashboard', 'Frontline'],
          }));
        }
        await loadWorklistFromCache(db);

        // Story 1.12: sign in AFTER the cached context has rendered and BEFORE any API call, so an
        // offline start never blocks on auth (AC5) and every call below carries the bearer (AC2).
        let sessionReady = false;
        try {
          const config = await loadAuthConfig();
          const edgeSession = await createBrowserSession(config);
          if (cancelled) {
            edgeSession.dispose();
            return;
          }
          session.current = edgeSession;
          setActiveSession(edgeSession);
          stopAuthLost = edgeSession.onAuthLost(onAuthLost);
          const outcome = await edgeSession.ensureSignedIn(
            window.location.pathname + window.location.search,
          );
          if (cancelled) return;
          if (outcome.kind === 'redirecting') {
            redirecting.current = true;
            return; // the page is leaving for the login screen
          }
          if (outcome.kind === 'offline_no_session') {
            setState((current) => ({ ...current, offlineNoSession: true }));
          } else {
            sessionReady = (await edgeSession.getAccessToken()) !== null;
          }
        } catch (error) {
          if (cancelled) return;
          if (error instanceof AuthConfigUnavailableError) {
            // No config and nothing cached: only possible on a first-ever offline open.
            if (!cached) setState((current) => ({ ...current, offlineNoSession: true }));
          } else {
            // The login redirect itself failed (IdP unreachable while online): say so, and retry
            // the redirect when connectivity changes, instead of running silently unauthenticated.
            sessionAuthLost.current = true;
            setState((current) => ({ ...current, authRequired: true, syncState: 'error' }));
          }
        }

        try {
          const response = await authorizedFetch('/api/v1/edge/bootstrap', { credentials: 'include' });
          if (!response.ok) throw new Error('bootstrap unavailable');
          const bootstrap = (await response.json()) as BootstrapResponse;
          await cacheContext(
            db,
            {
              userId: bootstrap.user_id,
              userName: bootstrap.user_name,
              role: bootstrap.role,
            },
            { siteId: bootstrap.site_id, siteName: bootstrap.site_name },
          );
          if (cancelled) return;
          // Story 1.12 (review decision 1): the API has confirmed who is signed in. Only THEIR
          // rows parked on an earlier 401 are re-queued; anyone else's wait for that person.
          signedInUserId.current = bootstrap.user_id;
          sessionAuthLost.current = false;
          rememberKnownUser(bootstrap.user_id, bootstrap.user_name);
          // Story 1.13: rescue rows an older build left unretained, before anything is re-queued.
          // Review fix: a salvage failure must not skip db.connect below, or the session never
          // uploads and the unretained rows stay exposed to the next checkpoint.
          await salvageUnheldOutboxRows(db, bootstrap.user_id).catch((error: unknown) => {
            console.warn('salvageUnheldOutboxRows failed; continuing to connect', error);
          });
          await resetAuthRequired(db, bootstrap.user_id);
          setState((current) => ({
            ...current,
            userId: bootstrap.user_id,
            userName: bootstrap.user_name,
            role: bootstrap.role,
            siteId: bootstrap.site_id,
            siteName: bootstrap.site_name,
            navigation: bootstrap.navigation,
            firstSyncRequired: false,
            authRequired: false,
            signOutAvailable: sessionReady,
          }));
          void db
            .connect(new EdgePowerSyncConnector('', () => signedInUserId.current))
            .catch(() => undefined);
          if (navigator.onLine) void refreshWorklistNow(db).catch(() => undefined);
        } catch {
          if (!cached) setState((current) => ({ ...current, firstSyncRequired: true }));
        }

        // Story 1.13: one watch over both the outbox and the local-only retention table.
        const watchAbort = new AbortController();
        db.watch(
          `SELECT id, local_status, server_error_code, updated_at FROM edge_outbox
           UNION ALL
           SELECT id, retained_reason, server_error_code, retained_at FROM edge_outbox_retained`,
          [],
          { onResult: () => void refreshLocalState(db) },
          { signal: watchAbort.signal },
        );
        stopWatching = () => {
          watchAbort.abort();
          void db.disconnect().catch(() => undefined);
        };
        await refreshLocalState(db);
      } catch {
        if (!cancelled) setState((current) => ({ ...current, setupError: true }));
      }
    }

    function refreshConnectivity() {
      const db = database.current;
      if (db) void refreshLocalState(db);
    }

    function onOnline() {
      refreshConnectivity();
      // Story 1.12: an auth loss that happened offline redirects once the network is back.
      if (sessionAuthLost.current) redirectToSignIn();
      const db = database.current;
      if (db) void refreshWorklistNow(db).catch(() => undefined);
    }

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', refreshConnectivity);
    void start();
    return () => {
      cancelled = true;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', refreshConnectivity);
      stopWatching?.();
      stopAuthLost?.();
      session.current?.dispose();
      session.current = null;
      setActiveSession(null);
    };
  }, [loadWorklistFromCache, refreshLocalState, refreshWorklistNow]);

  // Story 1.12 (AC4): shared-tablet sign-out. Refused while captures would still upload (the
  // server attributes uploads to the bearer, not to the device-stamped actor); when online the
  // parked rows are re-queued so the live connection drains them, and the notice clears itself
  // once the outbox watch sees nothing pending.
  const signOut = useCallback(async () => {
    const db = database.current;
    const current = session.current;
    const userId = signedInUserId.current;
    if (!db || !current || !userId || signingOut.current) return;
    signingOut.current = true;
    setState((prev) => ({ ...prev, signingOut: true }));
    let result: Awaited<ReturnType<EdgeSession['signOut']>>;
    try {
      result = await current.signOut({
        countUnsettled: () => countUnsettled(db, userId),
        clearCachedUser: () => clearCachedUserContext(db),
      });
    } catch {
      signingOut.current = false;
      setState((prev) => ({ ...prev, signingOut: false }));
      return;
    }
    if (result.blocked) {
      signingOut.current = false;
      setState((prev) => ({ ...prev, signingOut: false, signOutBlockedCount: result.count }));
      if (navigator.onLine) {
        await resetAuthRequired(db, userId);
        await refreshLocalState(db);
      }
      return;
    }
    // Signed out. In oidc mode the page is normally leaving for Keycloak; local mode, or a logout
    // redirect that could not reach the IdP, stays here, so the shell must stop showing this user.
    // Capture stays closed (signingOut) until the next start signs somebody in.
    signedInUserId.current = null;
    sessionAuthLost.current = false;
    setActiveSession(null);
    setState((prev) => ({
      ...prev,
      userId: '',
      userName: '',
      role: '',
      signOutAvailable: false,
      signingOut: false,
      signOutBlockedCount: 0,
      signOutIncomplete: result.redirectFailed === true,
    }));
  }, [refreshLocalState]);

  // Story 1.14 (AC 6): drop the device's retained copy of one refused capture, then recompute the
  // counts and failure list from the tables (the STREAM_CONFLICT park is read from the same table).
  const dismissFailure = useCallback(async (eventId: string) => {
    const db = database.current;
    if (!db) throw new Error('Database not available');
    await dismissRetainedRow(db, eventId);
    await refreshLocalState(db);
  }, [refreshLocalState]);

  const capture = useCallback(async () => {
    const db = database.current;
    if (!db || !state.userId || !state.siteId) return;
    await insertOwnCapture(
      db,
      createTestCaptureEvent({
        userId: state.userId,
        role: state.role,
        siteId: state.siteId,
        deviceId: deviceId(),
      }),
    );
    await refreshLocalState(db);
  }, [refreshLocalState, state.role, state.siteId, state.userId]);

  const loadCrossDockTask = useCallback(async (taskId: string): Promise<CrossDockTaskContext | null> => {
    const response = await authorizedFetch(`/api/v1/cross-dock-tasks/${encodeURIComponent(taskId)}`, { credentials: 'include' });
    if (!response.ok) return null;
    const body = (await response.json()) as { task?: CrossDockTaskContext };
    return body.task ?? null;
  }, []);

  const confirmCrossDock = useCallback(async (task: CrossDockTaskContext, stagingBinCode: string): Promise<string> => {
    const db = database.current;
    if (!db || !state.userId || !state.siteId) {
      throw new Error('Database or authentication state not available. Ensure the device is synced and logged in.');
    }
    // Story 8.5 (AC 2): pre-capture held-lot guard - the technician is told BEFORE capture; the
    // central LOT_ON_HOLD rejection plus needs_attention/syncFailures remains the authority.
    if (task.lot_number) {
      await assertLotNotHeld(db, task.lot_number);
    }
    const event = createCrossDockCompletionEvent({
      taskId: task.cross_dock_task_id,
      stagingBinCode,
      userId: state.userId,
      role: state.role,
      siteId: state.siteId,
      correlationId: task.correlation_id,
      deviceId: deviceId(),
    });
    await insertOwnCapture(db, event);
    await refreshLocalState(db);
    return event.event_id;
  }, [refreshLocalState, state.role, state.siteId, state.userId]);

  const submitIndent = useCallback(async (input: IndentSubmitInput): Promise<string> => {
    const db = database.current;
    if (!db || !state.userId || !state.siteId) {
      throw new Error('Database or authentication state not available. Ensure the device is synced and logged in.');
    }
    const event = createIndentRaisedEvent({
      ...input,
      userId: state.userId,
      role: state.role,
      siteId: state.siteId,
      deviceId: deviceId(),
    });
    await insertOwnCapture(db, event);
    await refreshLocalState(db);
    return event.event_id;
  }, [refreshLocalState, state.role, state.siteId, state.userId]);

  // --- Story 7.8: the five technician flows (the submitIndent pattern) ---------------------------

  const requireReady = useCallback((): PowerSyncDatabase => {
    const db = database.current;
    if (!db || !state.userId || !state.siteId) {
      throw new Error('Database or authentication state not available. Ensure the device is synced and logged in.');
    }
    return db;
  }, [state.siteId, state.userId]);

  const actor = useCallback(
    () => ({ userId: state.userId, role: state.role, siteId: state.siteId, deviceId: deviceId() }),
    [state.role, state.siteId, state.userId],
  );

  const selectWorkOrder = useCallback(async (workOrderId: string) => {
    const db = database.current;
    const reservations = db ? await readCachedReservations(db, workOrderId) : [];
    setState((current) => ({
      ...current,
      selectedWorkOrderId: workOrderId,
      selectedReservations: reservations,
    }));
  }, []);

  const submitFaultReport = useCallback(async (input: FaultReportSubmitInput): Promise<string> => {
    const db = requireReady();
    const event = createFaultReportedEvent({ ...input, ...actor() });
    await insertOwnCapture(db, event);
    await refreshLocalState(db);
    return event.event_id;
  }, [actor, refreshLocalState, requireReady]);

  const submitStatusUpdate = useCallback(async (input: WorkOrderStatusSubmitInput): Promise<string> => {
    const db = requireReady();
    const workOrder = state.workOrders.find((row) => row.work_order_id === input.workOrderId);
    if (!workOrder) throw new Error('Work order is not cached on this device');
    const eventVersion = await nextStreamVersion(db, 'cached_work_order', input.workOrderId);
    const event = createWorkOrderStatusUpdatedEvent({
      workOrderId: input.workOrderId,
      assetId: workOrder.asset_id,
      newStatus: input.newStatus,
      note: input.note,
      eventVersion,
      ...actor(),
    });
    await insertOwnCapture(db, event);
    await refreshLocalState(db);
    return event.event_id;
  }, [actor, refreshLocalState, requireReady, state.workOrders]);

  const submitMeterReading = useCallback(async (input: MeterReadingSubmitInput): Promise<string> => {
    const db = requireReady();
    const workOrder = state.workOrders.find((row) => row.work_order_id === state.selectedWorkOrderId);
    if (!workOrder) throw new Error('Work order is not cached on this device');
    const event = createMeterReadingRecordedEvent({
      meterId: input.meterId,
      assetId: workOrder.asset_id,
      readingValue: input.readingValue,
      ...actor(),
    });
    await insertOwnCapture(db, event);
    await refreshLocalState(db);
    return event.event_id;
  }, [actor, refreshLocalState, requireReady, state.selectedWorkOrderId, state.workOrders]);

  const submitSpareIssue = useCallback(async (input: SpareIssueSubmitInput): Promise<string> => {
    const db = requireReady();
    const reservation = state.selectedReservations.find(
      (row) => row.reservation_id === input.reservationId,
    );
    if (!reservation) throw new Error('Reservation is not cached on this device');
    const eventVersion = await nextStreamVersion(db, 'cached_spare_reservation', input.reservationId);
    const event = createSpareIssuedEvent({
      reservationId: input.reservationId,
      quantity: reservation.quantity,
      eventVersion,
      ...actor(),
    });
    await insertOwnCapture(db, event);
    await refreshLocalState(db);
    return event.event_id;
  }, [actor, refreshLocalState, requireReady, state.selectedReservations]);

  const submitClosure = useCallback(async (input: WorkOrderClosureSubmitInput): Promise<string> => {
    const db = requireReady();
    const workOrder = state.workOrders.find((row) => row.work_order_id === input.workOrderId);
    if (!workOrder) throw new Error('Work order is not cached on this device');
    const eventVersion = await nextStreamVersion(db, 'cached_work_order', input.workOrderId);
    const event = createWorkOrderCompletedEvent({
      workOrderId: input.workOrderId,
      assetId: workOrder.asset_id,
      faultCode: input.faultCode,
      causeCode: input.causeCode,
      remedyCode: input.remedyCode,
      eventVersion,
      ...actor(),
    });
    await insertOwnCapture(db, event);
    await refreshLocalState(db);
    return event.event_id;
  }, [actor, refreshLocalState, requireReady, state.workOrders]);

  const selectedWorkOrder =
    state.workOrders.find((row) => row.work_order_id === state.selectedWorkOrderId) ?? null;

  return (
    <AppShell
      userName={state.userName || t('app.defaultUserName')}
      siteName={state.siteName || t('app.defaultSiteName')}
      syncState={state.syncState}
      firstSyncRequired={state.firstSyncRequired}
      failures={state.failures}
      navigation={state.navigation}
      pendingCount={state.pendingCount}
      failedCount={state.failedCount}
      authRequired={state.authRequired}
      setupError={state.setupError}
      offlineNoSession={state.offlineNoSession}
      signOutBlockedCount={state.signOutBlockedCount}
      signingOut={state.signingOut}
      signOutIncomplete={state.signOutIncomplete}
      waitingForOthers={state.waitingForOthers}
      {...(state.signOutAvailable ? { onSignOut: () => void signOut() } : {})}
      onCapture={() => void capture()}
      onLoadCrossDockTask={loadCrossDockTask}
      onConfirmCrossDock={confirmCrossDock}
      onSubmitIndent={submitIndent}
      onRetry={() => {
        const db = database.current;
        if (db) void refreshLocalState(db);
      }}
      view={view}
      refusedCaptures={{ siteId: state.siteId, userId: state.userId, online: state.online }}
      onDismissFailure={dismissFailure}
      maintenance={{
        workOrders: state.workOrders,
        total: state.worklistMeta.total,
        truncated: state.worklistMeta.truncated,
        fetchedAt: state.worklistMeta.fetchedAt,
        selectedWorkOrderId: state.selectedWorkOrderId,
        selectedMeters: parseMeters(selectedWorkOrder?.meters),
        selectedReservations: state.selectedReservations,
        closureCatalogue: state.closureCatalogue,
        onSelectWorkOrder: (workOrderId) => void selectWorkOrder(workOrderId),
        onRefreshWorklist: () => {
          const db = database.current;
          if (db) void refreshWorklistNow(db).catch(() => undefined);
        },
        onSubmitFaultReport: submitFaultReport,
        onSubmitStatusUpdate: submitStatusUpdate,
        onSubmitMeterReading: submitMeterReading,
        onSubmitSpareIssue: submitSpareIssue,
        onSubmitClosure: submitClosure,
      }}
    />
  );
}
