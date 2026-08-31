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
  hasAuthRequired,
  insertCaptureEvent,
  readCachedContext,
  readFailures,
  readOutboxCounts,
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
  syncState: SyncUiState;
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
  syncState: 'offline',
  workOrders: [],
  worklistMeta: { total: 0, truncated: false, fetchedAt: null },
  closureCatalogue: { fault: [], cause: [], remedy: [] },
  selectedWorkOrderId: null,
  selectedReservations: [],
};

const WORKLIST_META_KEY = 'inventory-edge-worklist-meta';

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

export function EdgeClient({ view = 'frontline' }: { view?: 'frontline' | 'maintenance' }) {
  const database = useRef<PowerSyncDatabase | null>(null);
  const [state, setState] = useState(initialState);

  const refreshLocalState = useCallback(async (db: PowerSyncDatabase) => {
    const [counts, failures, authRequired] = await Promise.all([
      readOutboxCounts(db),
      readFailures(db),
      hasAuthRequired(db),
    ]);
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

        try {
          const response = await fetch('/api/v1/edge/bootstrap', { credentials: 'include' });
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
          setState((current) => ({
            ...current,
            userId: bootstrap.user_id,
            userName: bootstrap.user_name,
            role: bootstrap.role,
            siteId: bootstrap.site_id,
            siteName: bootstrap.site_name,
            navigation: bootstrap.navigation,
            firstSyncRequired: false,
          }));
          void db.connect(new EdgePowerSyncConnector()).catch(() => undefined);
          if (navigator.onLine) void refreshWorklistNow(db).catch(() => undefined);
        } catch {
          if (!cached) setState((current) => ({ ...current, firstSyncRequired: true }));
        }

        db.watch(
          `SELECT id, local_status, server_error_code, updated_at FROM edge_outbox`,
          [],
          { onResult: () => void refreshLocalState(db) },
        );
        stopWatching = () => db.disconnect().catch(() => undefined);
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
    };
  }, [loadWorklistFromCache, refreshLocalState, refreshWorklistNow]);

  const capture = useCallback(async () => {
    const db = database.current;
    if (!db || !state.userId || !state.siteId) return;
    await insertCaptureEvent(
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
    const response = await fetch(`/api/v1/cross-dock-tasks/${encodeURIComponent(taskId)}`, { credentials: 'include' });
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
    await insertCaptureEvent(db, event);
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
    await insertCaptureEvent(db, event);
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
    await insertCaptureEvent(db, event);
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
    await insertCaptureEvent(db, event);
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
    await insertCaptureEvent(db, event);
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
    await insertCaptureEvent(db, event);
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
    await insertCaptureEvent(db, event);
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
      onCapture={() => void capture()}
      onLoadCrossDockTask={loadCrossDockTask}
      onConfirmCrossDock={confirmCrossDock}
      onSubmitIndent={submitIndent}
      onRetry={() => {
        const db = database.current;
        if (db) void refreshLocalState(db);
      }}
      view={view}
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
