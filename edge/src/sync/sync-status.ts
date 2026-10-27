import type { EdgeLocalStatus } from '../local-db/schema';

export type SyncUiState = 'online' | 'offline' | 'captured' | 'syncing' | 'error' | 'unavailable';

export interface SyncStatusInput {
  online: boolean;
  pendingCount: number;
  syncing: boolean;
  failedCount: number;
  authRequiredCount?: number;
  /**
   * The browser can reach the network, but the last PowerSync connection attempt failed.
   * Omitted until the client has a status to report, so a first connect is not called a failure.
   */
  syncServiceDown?: boolean;
}

/** The PowerSync stream is down: not connected, and the last attempt recorded a download error. */
export function syncServiceIsDown(status: {
  connected: boolean;
  dataFlowStatus: { downloadError?: unknown };
}): boolean {
  return !status.connected && status.dataFlowStatus.downloadError != null;
}

export function deriveSyncUiState(input: SyncStatusInput): SyncUiState {
  if ((input.authRequiredCount ?? 0) > 0 || input.failedCount > 0) return 'error';
  if (input.syncing) return 'syncing';
  if (!input.online) return 'offline';
  if (input.syncServiceDown) return 'unavailable';
  if (input.pendingCount > 0) return 'captured';
  return 'online';
}

export function isPendingStatus(status: EdgeLocalStatus): boolean {
  return status === 'pending_sync' || status === 'syncing';
}
