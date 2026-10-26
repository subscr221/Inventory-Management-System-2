import { t, type MessageKey } from '../i18n/locale';
import type { SyncUiState } from '../sync/sync-status';

const CLASS_BY_STATE: Record<SyncUiState, string> = {
  online: 'sync-online',
  offline: 'sync-offline',
  captured: 'sync-captured',
  syncing: 'sync-syncing',
  error: 'sync-error',
  unavailable: 'sync-unavailable',
};

const LABEL_BY_STATE: Record<SyncUiState, MessageKey> = {
  online: 'sync.online',
  offline: 'sync.offline',
  captured: 'sync.captured',
  syncing: 'sync.syncing',
  error: 'sync.error',
  unavailable: 'sync.unavailable',
};

export function syncStatusMessage(state: SyncUiState): MessageKey {
  return LABEL_BY_STATE[state];
}

export function SyncStatusBadge({ state }: { state: SyncUiState }) {
  const label = t(syncStatusMessage(state));
  return (
    <div
      className={`sync-badge ${CLASS_BY_STATE[state]}`}
      role="status"
      aria-live="polite"
      aria-label={t('sync.liveLabel')}
    >
      <span aria-hidden="true">●</span>
      <span>{label}</span>
    </div>
  );
}
