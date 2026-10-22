'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PowerSyncDatabase } from '@powersync/web';
import { createTestCaptureEvent } from '../capture/test-capture';
import { createCrossDockCompletionEvent } from '../capture/cross-dock';
import { assertLotNotHeld } from '../capture/held-lot';
import { createIndentRaisedEvent } from '../capture/indent';
import { createDamageCaptureEvents } from '../capture/damage';
import type { CaptureSettlement, DamageSubmitInput, DamageSubmitResult } from './report-damage';
import { createGateEnteredEvent, createWeighbridgeRecordedEvent } from '../capture/gate';
import type { ReceiptRow, ReceiptSubmission } from '../capture/receiving';
import type { DoneRow } from './stores-inbox-model';
import type { ReceiptSubmitResult } from './stores-accept';
import type {
  GateSubmitInput,
  GateSubmitResult,
  OpenTruck,
  StampState,
  WeighmentSubmitInput,
  WeighmentSubmitResult,
} from './gate-entry/gate-entry';
import { pendingPhotoStore } from '../local-db/pending-photos';
import { reencodeAsJpeg, uploadPendingPhotos } from '../sync/attachment-uploader';
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
  readCaptureSettlement,
  readFailures,
  readOutboxCounts,
  readPendingReceipts,
  readWaitingForOtherOwners,
  resetAuthRequired,
  salvageUnheldOutboxRows,
} from '../local-db/outbox';
import { createOutboxEvent } from '../capture/outbox-event';
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
import { classifyBootstrapRefusal } from '../session/bootstrap-refusal';
import { AuthConfigUnavailableError, loadAuthConfig } from '../session/auth-config';
import {
  createBrowserSession,
  getActiveSession,
  setActiveSession,
  type EdgeSession,
} from '../session/session';

interface BootstrapResponse {
  user_id: string;
  user_name: string;
  site_id: string;
  site_name: string;
  role: string;
  navigation: string[];
  // Story 3.13: the gate capture needs the operating site's external code and the gate id.
  site_code_ext?: string | null;
  gate_id?: string | null;
  inspection_bay_code?: string | null;
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
  // Story 3.13: bootstrap-supplied gate context (empty until a live bootstrap confirms it).
  siteCodeExt: string | null;
  gateId: string | null;
  // Story 3.14: the site's inspection bay for the acceptance screen, and the receipts still queued.
  inspectionBayCode: string | null;
  pendingReceipts: DoneRow[];
  role: string;
  navigation: string[];
  pendingCount: number;
  failedCount: number;
  failures: Array<{ eventId: string; eventType: string; errorCode: string; failedAt: string }>;
  authRequired: boolean;
  firstSyncRequired: boolean;
  // The account has no single concrete site, so bootstrap is refused and nothing will sync.
  siteRefusal: 'no_site' | 'ambiguous_site' | null;
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
  // Story 1.15 (Task 3.6): `navigation` came from a live bootstrap, not the offline placeholder.
  navigationConfirmed: boolean;
  // Story 7.8: the cached technician worklist.
  workOrders: CachedWorkOrderRow[];
  worklistMeta: WorklistMeta;
  closureCatalogue: { fault: string[]; cause: string[]; remedy: string[] };
  selectedWorkOrderId: string | null;
  selectedReservations: CachedReservationRow[];
}

/** Bootstrap refused for the account's site assignment: already shown, not a sync failure. */
class SiteRefusedError extends Error {}

const initialState: RuntimeState = {
  userId: '',
  userName: '',
  siteId: '',
  siteName: '',
  siteCodeExt: null,
  gateId: null,
  inspectionBayCode: null,
  pendingReceipts: [],
  role: '',
  navigation: [],
  pendingCount: 0,
  failedCount: 0,
  failures: [],
  authRequired: false,
  firstSyncRequired: false,
  siteRefusal: null,
  setupError: false,
  offlineNoSession: false,
  signOutBlockedCount: 0,
  signOutAvailable: false,
  signingOut: false,
  signOutIncomplete: false,
  waitingForOthers: [],
  syncState: 'offline',
  online: true,
  navigationConfirmed: false,
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
    localStorage.setItem(
      KNOWN_USERS_KEY,
      JSON.stringify({ ...readKnownUsers(), [userId]: userName }),
    );
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
    | 'dashboard'
    | 'maintenance'
    | 'refused-captures'
    | 'workflows'
    | 'access-control'
    | 'reports'
    | 'new-requisition'
    | 'check-stock'
    | 'my-requests'
    | 'report-damage'
    | 'damage-cases'
    | 'standing-grants'
    | 'gate'
    | 'stores'
    | 'stores-accept'
    | 'stores-issue';
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
  // Bootstrap refused the site (no concrete site assignment): the API never named the user, and
  // capture never opened, so this person owns no outbox rows but must still be able to sign out.
  const siteRefused = useRef(false);
  const [state, setState] = useState(initialState);
  // Story 8.9 (Task 9.2): one photo upload pass at a time.
  const uploadingPhotos = useRef(false);

  // Story 8.9 (Task 9.2): PUT pending damage photos when online, on bootstrap and after each
  // refreshLocalState. Only the signed-in person's photos go out under their session.
  const uploadPhotos = useCallback(() => {
    const owner = signedInUserId.current;
    if (!owner || uploadingPhotos.current || !navigator.onLine) return;
    uploadingPhotos.current = true;
    void uploadPendingPhotos({
      store: pendingPhotoStore,
      ownerUserId: owner,
      fetch: authorizedFetch,
      reencode: reencodeAsJpeg,
    })
      .catch(() => undefined)
      .finally(() => {
        uploadingPhotos.current = false;
      });
  }, []);

  const insertOwnCapture = useCallback(
    async (db: PowerSyncDatabase, event: Parameters<typeof insertCaptureEvent>[1]) => {
      if (signingOut.current) throw new Error('Signing out: capture is closed');
      await insertCaptureEvent(db, event);
    },
    [],
  );

  const refreshLocalState = useCallback(
    async (db: PowerSyncDatabase) => {
      const currentUser = signedInUserId.current;
      const [counts, failures, rowsAuthRequired, waiting, ownUnsettled, pendingReceipts] =
        await Promise.all([
          readOutboxCounts(db),
          readFailures(db),
          hasAuthRequired(db, currentUser ?? undefined),
          currentUser ? readWaitingForOtherOwners(db, currentUser) : Promise.resolve([]),
          currentUser ? countUnsettled(db, currentUser) : Promise.resolve(0),
          currentUser ? readPendingReceipts(db, currentUser) : Promise.resolve([]),
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
        pendingReceipts: pendingReceipts.map((row) => ({
          id: row.grnId,
          title: row.challan ?? row.grnId,
          statusKey: 'stores.done.captured' as const,
        })),
        // Story 1.12 (AC4): once nothing is left to upload, the sign-out gate notice goes away.
        signOutBlockedCount: ownUnsettled === 0 ? 0 : current.signOutBlockedCount,
        online,
        syncState: authRequired ? 'error' : deriveSyncUiState({ online, syncing, ...counts }),
      }));
      uploadPhotos();
    },
    [uploadPhotos],
  );

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
      void current.requestSignIn(window.location.pathname + window.location.search).catch(() => {
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
          const response = await authorizedFetch('/api/v1/edge/bootstrap', {
            credentials: 'include',
          });
          if (!response.ok) {
            const refusal = await classifyBootstrapRefusal(response);
            if (refusal === 'unavailable') throw new Error('bootstrap unavailable');
            // Not a sync problem: tell the person their account has no usable site, name them from
            // the sign-in token, and show no cached identity from an earlier assignment.
            const signedInName = (await getActiveSession()?.getDisplayName()) ?? null;
            siteRefused.current = true;
            if (!cancelled)
              setState((current) => ({
                ...current,
                siteRefusal: refusal,
                firstSyncRequired: false,
                userName: signedInName ?? '',
                siteName: '',
                signOutAvailable: sessionReady,
              }));
            throw new SiteRefusedError();
          }
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
            siteCodeExt: bootstrap.site_code_ext?.trim() || null,
            gateId: bootstrap.gate_id?.trim() || null,
            inspectionBayCode: bootstrap.inspection_bay_code?.trim() || null,
            // No site on the bootstrap: gate capture is closed, so hide its nav row.
            navigation: bootstrap.site_code_ext?.trim()
              ? bootstrap.navigation
              : bootstrap.navigation.filter((name) => name !== 'Gate entry'),
            navigationConfirmed: true,
            firstSyncRequired: false,
            siteRefusal: null,
            authRequired: false,
            signOutAvailable: sessionReady,
          }));
          void db
            .connect(new EdgePowerSyncConnector('', () => signedInUserId.current))
            .catch(() => undefined);
          if (navigator.onLine) void refreshWorklistNow(db).catch(() => undefined);
          uploadPhotos();
        } catch (error) {
          if (!(error instanceof SiteRefusedError) && !cached)
            setState((current) => ({ ...current, firstSyncRequired: true }));
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
  }, [loadWorklistFromCache, refreshLocalState, refreshWorklistNow, uploadPhotos]);

  // Story 1.12 (AC4): shared-tablet sign-out. Refused while captures would still upload (the
  // server attributes uploads to the bearer, not to the device-stamped actor); when online the
  // parked rows are re-queued so the live connection drains them, and the notice clears itself
  // once the outbox watch sees nothing pending.
  const signOut = useCallback(async () => {
    const db = database.current;
    const current = session.current;
    const userId = signedInUserId.current;
    if (!db || !current || (!userId && !siteRefused.current) || signingOut.current) return;
    signingOut.current = true;
    setState((prev) => ({ ...prev, signingOut: true }));
    let result: Awaited<ReturnType<EdgeSession['signOut']>>;
    try {
      result = await current.signOut({
        countUnsettled: () => (userId ? countUnsettled(db, userId) : Promise.resolve(0)),
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
      if (navigator.onLine && userId) {
        await resetAuthRequired(db, userId);
        await refreshLocalState(db);
      }
      return;
    }
    // Signed out. In oidc mode the page is normally leaving for Keycloak; local mode, or a logout
    // redirect that could not reach the IdP, stays here, so the shell must stop showing this user.
    // Capture stays closed (signingOut) until the next start signs somebody in.
    signedInUserId.current = null;
    siteRefused.current = false;
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
  const dismissFailure = useCallback(
    async (eventId: string) => {
      const db = database.current;
      if (!db) throw new Error('Database not available');
      await dismissRetainedRow(db, eventId);
      await refreshLocalState(db);
    },
    [refreshLocalState],
  );

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

  const loadCrossDockTask = useCallback(
    async (taskId: string): Promise<CrossDockTaskContext | null> => {
      const response = await authorizedFetch(
        `/api/v1/cross-dock-tasks/${encodeURIComponent(taskId)}`,
        { credentials: 'include' },
      );
      if (!response.ok) return null;
      const body = (await response.json()) as { task?: CrossDockTaskContext };
      return body.task ?? null;
    },
    [],
  );

  const confirmCrossDock = useCallback(
    async (task: CrossDockTaskContext, stagingBinCode: string): Promise<string> => {
      const db = database.current;
      if (!db || !state.userId || !state.siteId) {
        throw new Error(
          'Database or authentication state not available. Ensure the device is synced and logged in.',
        );
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
    },
    [refreshLocalState, state.role, state.siteId, state.userId],
  );

  const submitIndent = useCallback(
    async (input: IndentSubmitInput): Promise<string> => {
      const db = database.current;
      if (!db || !state.userId || !state.siteId) {
        throw new Error(
          'Database or authentication state not available. Ensure the device is synced and logged in.',
        );
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
    },
    [refreshLocalState, state.role, state.siteId, state.userId],
  );

  // --- Story 8.9: report damage (the submitIndent pattern) ---------------------------------------

  const submitDamage = useCallback(
    async (input: DamageSubmitInput): Promise<DamageSubmitResult> => {
      const db = database.current;
      if (!db || !state.userId || !state.siteId) {
        throw new Error(
          'Database or authentication state not available. Ensure the device is synced and logged in.',
        );
      }
      if (signingOut.current) throw new Error('Signing out: capture is closed');
      const occurredAt = new Date().toISOString();
      const reportId = crypto.randomUUID();
      const photoAttachmentId = crypto.randomUUID();
      // The photo first: a report whose photo was never stored would wait forever for it.
      await pendingPhotoStore.put({
        attachmentId: photoAttachmentId,
        blob: input.photo,
        contentType: input.photo.type,
        ownerUserId: state.userId,
        createdAt: occurredAt,
      });
      const events = createDamageCaptureEvents({
        sku: input.sku,
        lotNumber: input.lotNumber,
        quantity: input.quantity,
        foundAt: input.foundAt,
        binCode: input.binCode,
        reasonCode: input.reasonCode,
        reasonNote: input.reasonNote,
        photoAttachmentId,
        wholeLotRequested: input.wholeLotRequested,
        replacement: input.replacement
          ? { ...input.replacement, reason: t('damage.replacementReason') }
          : null,
        userId: state.userId,
        role: state.role,
        siteId: state.siteId,
        deviceId: deviceId(),
        reportId,
        occurredAt,
      });
      // One local transaction, damage event first: the outbox uploads it before the linked indent.
      const insertAll = async (tx: Parameters<typeof insertCaptureEvent>[0]) => {
        for (const event of events) await insertCaptureEvent(tx, event);
      };
      try {
        if (db.writeTransaction) await db.writeTransaction(insertAll);
        else await insertAll(db);
      } catch (err) {
        // Code review 2026-09-28: the photo above is already stored under photoAttachmentId; if the
        // event insert that would reference it never lands, remove it rather than leave an orphaned
        // blob with no owning report.
        await pendingPhotoStore.remove(photoAttachmentId).catch(() => undefined);
        throw err;
      }
      await refreshLocalState(db);
      const damage = events[0]!;
      return {
        eventId: damage.event_id,
        reportId,
        replacementIndentId: (damage.payload['replacement_indent_id'] as string | null) ?? null,
      };
    },
    [refreshLocalState, state.role, state.siteId, state.userId],
  );

  const damageSettlement = useCallback(async (eventId: string): Promise<CaptureSettlement> => {
    const db = database.current;
    if (!db) return 'pending';
    return readCaptureSettlement(db, eventId);
  }, []);

  // --- Story 7.8: the five technician flows (the submitIndent pattern) ---------------------------

  const requireReady = useCallback((): PowerSyncDatabase => {
    const db = database.current;
    if (!db || !state.userId || !state.siteId) {
      throw new Error(
        'Database or authentication state not available. Ensure the device is synced and logged in.',
      );
    }
    return db;
  }, [state.siteId, state.userId]);

  const actor = useCallback(
    () => ({ userId: state.userId, role: state.role, siteId: state.siteId, deviceId: deviceId() }),
    [state.role, state.siteId, state.userId],
  );

  // --- Story 3.13: gate entry and weighbridge capture -------------------------------------------

  // Trucks on site and weighbridge stamp state. Fail soft: offline or any fetch failure leaves the
  // stamp unknown ("not verified, server will confirm") and the operator types the truck. Only an
  // explicit server `overdue` blocks weighing (AC 9).
  const [gateLookups, setGateLookups] = useState<{
    openTrucks: OpenTruck[];
    stamp: StampState | null;
    stampUnverified: boolean;
  }>({ openTrucks: [], stamp: null, stampUnverified: false });
  useEffect(() => {
    const site = state.siteCodeExt;
    if (!site || !state.online) {
      setGateLookups({ openTrucks: [], stamp: null, stampUnverified: Boolean(site) });
      return;
    }
    let cancelled = false;
    const query = `site=${encodeURIComponent(site)}`;
    void (async () => {
      let openTrucks: OpenTruck[] = [];
      let stamp: StampState | null = null;
      let stampUnverified = false;
      try {
        const res = await authorizedFetch(`/api/v1/gate-events?${query}&status=open`, {
          credentials: 'include',
        });
        if (res.ok) {
          const body = (await res.json()) as { gate_events?: Array<Record<string, unknown>> };
          openTrucks = (body.gate_events ?? []).flatMap((row) => {
            const correlationId =
              typeof row['correlation_id'] === 'string' ? row['correlation_id'] : '';
            const poRef = typeof row['po_ref_ext'] === 'string' ? row['po_ref_ext'] : '';
            if (!correlationId) return [];
            return [
              {
                correlationId,
                vehicleRegExt:
                  typeof row['vehicle_reg_ext'] === 'string' ? row['vehicle_reg_ext'] : '',
                poRefExt: poRef === 'UNKNOWN' ? '' : poRef,
                lineNo: 1,
                status: typeof row['binding_status'] === 'string' ? row['binding_status'] : '',
              },
            ];
          });
        }
      } catch {
        /* fail soft: the operator types the truck */
      }
      try {
        const res = await authorizedFetch(`/api/v1/weighbridge-events/stamp-status?${query}`, {
          credentials: 'include',
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as {
          stamp_status?: Array<{ device_key?: string; status?: string; next_due_date?: string }>;
        };
        const rows = (body.stamp_status ?? []).filter(
          (r) => r.status === 'overdue' || r.status === 'compliant',
        );
        const pick = rows.find((r) => r.status === 'overdue') ?? rows[0];
        if (pick) {
          stamp = {
            deviceKey: pick.device_key ?? '',
            status: pick.status as 'compliant' | 'overdue',
            nextDueDate: pick.next_due_date ?? '',
          };
        } else {
          stampUnverified = true;
        }
      } catch {
        stampUnverified = true;
      }
      if (!cancelled) setGateLookups({ openTrucks, stamp, stampUnverified });
    })();
    return () => {
      cancelled = true;
    };
    // pendingCount: refresh the truck list after the outbox changes (a gate entry or weighment).
  }, [state.siteCodeExt, state.online, state.pendingCount]);

  const submitGate = useCallback(
    async (input: GateSubmitInput): Promise<GateSubmitResult> => {
      const db = database.current;
      if (!db || !state.userId || !state.siteId) {
        throw new Error(
          'Database or authentication state not available. Ensure the device is synced and logged in.',
        );
      }
      if (signingOut.current) throw new Error('Signing out: capture is closed');
      if (!state.siteCodeExt || !state.gateId) {
        throw new Error('No site or gate is assigned to this device; gate capture is closed.');
      }
      const occurredAt = new Date().toISOString();
      const photoAttachmentId = crypto.randomUUID();
      await pendingPhotoStore.put({
        attachmentId: photoAttachmentId,
        blob: input.photo,
        contentType: input.photo.type,
        ownerUserId: state.userId,
        createdAt: occurredAt,
      });
      const event = createGateEnteredEvent({
        challanNumberExt: input.challanNumberExt,
        poRefExt: input.poRefExt,
        vehicleRegExt: input.vehicleRegExt,
        driverName: input.driverName,
        supplierRefExt: input.supplierRefExt,
        supplierUnlisted: input.supplierUnlisted,
        supplierNameUnlisted: input.supplierNameUnlisted,
        challanPhotoRef: photoAttachmentId,
        siteCodeExt: state.siteCodeExt,
        gateId: state.gateId,
        userId: state.userId,
        role: state.role,
        siteId: state.siteId,
        deviceId: deviceId(),
        occurredAt,
      });
      try {
        await insertCaptureEvent(db, event);
      } catch (error) {
        // No event row will reference the blob, so drop it rather than leave an orphan.
        await pendingPhotoStore.remove(photoAttachmentId).catch(() => undefined);
        throw error;
      }
      await refreshLocalState(db);
      return { eventId: event.event_id, correlationId: event.metadata.correlation_id };
    },
    [refreshLocalState, state.gateId, state.role, state.siteCodeExt, state.siteId, state.userId],
  );

  const submitWeighment = useCallback(
    async (input: WeighmentSubmitInput): Promise<WeighmentSubmitResult | { errorCode: string }> => {
      const db = requireReady();
      if (!state.siteCodeExt)
        throw new Error('No site is assigned to this device; weighing is closed.');
      const event = createWeighbridgeRecordedEvent({
        ...input,
        siteCodeExt: state.siteCodeExt,
        deviceId: deviceId(),
        userId: state.userId,
        role: state.role,
        siteId: state.siteId,
      });
      if ('errorCode' in event) return { errorCode: event.errorCode };
      await insertCaptureEvent(db, event);
      await refreshLocalState(db);
      return { eventId: event.event_id };
    },
    [refreshLocalState, requireReady, state.role, state.siteCodeExt, state.siteId, state.userId],
  );

  const submitReceipt = useCallback(
    async (submission: ReceiptSubmission, rows: ReceiptRow[]): Promise<ReceiptSubmitResult> => {
      if (navigator.onLine) {
        for (const row of rows) {
          const response = await authorizedFetch('/api/v1/grn-lines', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...row.body,
              idempotency_key: `stores-receipt-${row.grn_line_id}`,
            }),
          }).catch(() => null);
          if (!response) return { kind: 'error', errorCode: 'STORES_OFFLINE' };
          if (response.ok) continue;
          const body = (await response.json().catch(() => null)) as {
            error_code?: unknown;
          } | null;
          return {
            kind: 'error',
            errorCode:
              typeof body?.error_code === 'string' ? body.error_code : 'INVALID_EVENT_ENVELOPE',
          };
        }
        const current = database.current;
        if (current) await refreshLocalState(current);
        return { kind: 'posted', grnId: submission.grnId };
      }
      const db = requireReady();
      const occurredAt = new Date().toISOString();
      for (const row of rows) {
        const eventId = crypto.randomUUID();
        await insertCaptureEvent(
          db,
          createOutboxEvent({
            eventId,
            streamType: 'receiving',
            streamId: row.grn_line_id,
            eventType: 'goods.received',
            payload: row.body,
            userId: state.userId,
            role: state.role,
            siteId: state.siteId,
            correlationId: submission.bindingToken,
            deviceId: deviceId(),
            idempotencyKey: `edge-receipt-${row.grn_line_id}`,
            occurredAt,
            captureMethod: 'MANUAL',
          }),
        );
      }
      await refreshLocalState(db);
      return { kind: 'pending', grnId: submission.grnId };
    },
    [refreshLocalState, requireReady, state.role, state.siteId, state.userId],
  );

  const storeReceiptPhoto = useCallback(
    async (file: File): Promise<string> => {
      if (signingOut.current) throw new Error('Signing out: capture is closed');
      if (!state.userId) throw new Error('Sign-in is not ready');
      const attachmentId = crypto.randomUUID();
      await pendingPhotoStore.put({
        attachmentId,
        blob: file,
        contentType: file.type || 'image/jpeg',
        ownerUserId: state.userId,
        createdAt: new Date().toISOString(),
      });
      return attachmentId;
    },
    [state.userId],
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

  const submitFaultReport = useCallback(
    async (input: FaultReportSubmitInput): Promise<string> => {
      const db = requireReady();
      const event = createFaultReportedEvent({ ...input, ...actor() });
      await insertOwnCapture(db, event);
      await refreshLocalState(db);
      return event.event_id;
    },
    [actor, refreshLocalState, requireReady],
  );

  const submitStatusUpdate = useCallback(
    async (input: WorkOrderStatusSubmitInput): Promise<string> => {
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
    },
    [actor, refreshLocalState, requireReady, state.workOrders],
  );

  const submitMeterReading = useCallback(
    async (input: MeterReadingSubmitInput): Promise<string> => {
      const db = requireReady();
      const workOrder = state.workOrders.find(
        (row) => row.work_order_id === state.selectedWorkOrderId,
      );
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
    },
    [actor, refreshLocalState, requireReady, state.selectedWorkOrderId, state.workOrders],
  );

  const submitSpareIssue = useCallback(
    async (input: SpareIssueSubmitInput): Promise<string> => {
      const db = requireReady();
      const reservation = state.selectedReservations.find(
        (row) => row.reservation_id === input.reservationId,
      );
      if (!reservation) throw new Error('Reservation is not cached on this device');
      const eventVersion = await nextStreamVersion(
        db,
        'cached_spare_reservation',
        input.reservationId,
      );
      const event = createSpareIssuedEvent({
        reservationId: input.reservationId,
        quantity: reservation.quantity,
        eventVersion,
        ...actor(),
      });
      await insertOwnCapture(db, event);
      await refreshLocalState(db);
      return event.event_id;
    },
    [actor, refreshLocalState, requireReady, state.selectedReservations],
  );

  const submitClosure = useCallback(
    async (input: WorkOrderClosureSubmitInput): Promise<string> => {
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
    },
    [actor, refreshLocalState, requireReady, state.workOrders],
  );

  const selectedWorkOrder =
    state.workOrders.find((row) => row.work_order_id === state.selectedWorkOrderId) ?? null;

  return (
    <AppShell
      userName={state.userName || t('app.defaultUserName')}
      siteName={state.siteName || t('app.defaultSiteName')}
      role={state.role}
      syncState={state.syncState}
      firstSyncRequired={state.firstSyncRequired}
      siteRefusal={state.siteRefusal}
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
      reportDamage={{
        onSubmit: submitDamage,
        settlementOf: damageSettlement,
        outboxVersion: `${state.pendingCount}:${state.failedCount}`,
      }}
      gateCapture={{
        siteCodeExt: state.siteCodeExt,
        gateId: state.gateId,
        openTrucks: gateLookups.openTrucks,
        stamp: gateLookups.stamp,
        stampUnverified: gateLookups.stampUnverified,
        onSubmitGate: submitGate,
        onSubmitWeighment: submitWeighment,
      }}
      storesInbox={{
        online: state.online,
        siteCodeExt: state.siteCodeExt,
        siteId: state.siteId,
        navigation: state.navigation,
        pendingReceipts: state.pendingReceipts,
      }}
      storesAccept={{
        online: state.online,
        siteCodeExt: state.siteCodeExt,
        inspectionBayCode: state.inspectionBayCode,
        onSubmitReceipt: submitReceipt,
        storePhoto: storeReceiptPhoto,
      }}
      userId={state.userId}
      onRetry={() => {
        const db = database.current;
        if (db) void refreshLocalState(db);
      }}
      view={view}
      online={state.online}
      navigationConfirmed={state.navigationConfirmed}
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
