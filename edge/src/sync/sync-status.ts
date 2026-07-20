import type { EdgeLocalStatus } from '../local-db/schema';

export type SyncUiState = 'online' | 'offline' | 'captured' | 'syncing' | 'error';

export interface SyncStatusInput {
  online: boolean;
  pendingCount: number;
  syncing: boolean;
  failedCount: number;
}

export function deriveSyncUiState(input: SyncStatusInput): SyncUiState {
  if (input.failedCount > 0) return 'error';
  if (input.syncing) return 'syncing';
  if (input.pendingCount > 0) return input.online ? 'captured' : 'offline';
  return input.online ? 'online' : 'offline';
}

export function isPendingStatus(status: EdgeLocalStatus): boolean {
  return status === 'pending_sync' || status === 'syncing';
}
