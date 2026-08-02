'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PowerSyncDatabase } from '@powersync/web';
import { createTestCaptureEvent } from '../capture/test-capture';
import { createCrossDockCompletionEvent } from '../capture/cross-dock';
import { createIndentRaisedEvent } from '../capture/indent';
import { AppShell } from './app-shell';
import type { CrossDockTaskContext } from './cross-dock-capture';
import type { IndentSubmitInput } from './indent-capture';
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
import { EdgePowerSyncConnector } from '../sync/connector';
import { deriveSyncUiState, type SyncUiState } from '../sync/sync-status';

interface BootstrapResponse {
  user_id: string;
  user_name: string;
  site_id: string;
  site_name: string;
  role: string;
  navigation: string[];
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
};

function deviceId(): string {
  const key = 'inventory-edge-device-id';
  const current = localStorage.getItem(key);
  if (current) return current;
  const created = crypto.randomUUID();
  localStorage.setItem(key, created);
  return created;
}

export function EdgeClient() {
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

    window.addEventListener('online', refreshConnectivity);
    window.addEventListener('offline', refreshConnectivity);
    void start();
    return () => {
      cancelled = true;
      window.removeEventListener('online', refreshConnectivity);
      window.removeEventListener('offline', refreshConnectivity);
      stopWatching?.();
    };
  }, [refreshLocalState]);

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
    />
  );
}
