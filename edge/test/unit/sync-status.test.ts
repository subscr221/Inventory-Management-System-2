import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSyncUiState, isPendingStatus } from '../../src/sync/sync-status';

describe('edge sync status model', () => {
  it('separates online, offline, syncing, pending, and failed states', () => {
    assert.equal(
      deriveSyncUiState({ online: true, pendingCount: 0, syncing: false, failedCount: 0 }),
      'online',
    );
    assert.equal(
      deriveSyncUiState({ online: false, pendingCount: 0, syncing: false, failedCount: 0 }),
      'offline',
    );
    assert.equal(
      deriveSyncUiState({ online: false, pendingCount: 1, syncing: false, failedCount: 0 }),
      'offline',
    );
    assert.equal(
      deriveSyncUiState({ online: true, pendingCount: 1, syncing: false, failedCount: 0 }),
      'captured',
    );
    assert.equal(
      deriveSyncUiState({ online: true, pendingCount: 1, syncing: true, failedCount: 0 }),
      'syncing',
    );
    assert.equal(
      deriveSyncUiState({ online: true, pendingCount: 1, syncing: true, failedCount: 1 }),
      'error',
    );
  });

  it('keeps permanent failures out of pending counts', () => {
    assert.equal(isPendingStatus('pending_sync'), true);
    assert.equal(isPendingStatus('syncing'), true);
    assert.equal(isPendingStatus('needs_attention'), false);
    assert.equal(isPendingStatus('auth_required'), false);
    assert.equal(isPendingStatus('synced'), false);
  });
});
