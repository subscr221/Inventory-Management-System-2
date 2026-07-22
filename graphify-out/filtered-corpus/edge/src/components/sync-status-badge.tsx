import { t, type MessageKey } from '../i18n/locale';
import type { SyncUiState } from '../sync/sync-status';

const CLASS_BY_STATE: Record<SyncUiState, string> = {
  online: 'sync-online',
  offline: 'sync-offline',
  captured: 'sync-captured',
  syncing: 'sync-syncing',
  error: 'sync-error',
};

const LABEL_BY_STATE: Record<SyncUiState, MessageKey> = {
  online: 'sync.online',
  offline: 'sync.offline',
  captured: 'sync.captured',
  syncing: 'sync.syncing',
  error: 'sync.error',
};

export function SyncStatusBadge({ state }: { state: SyncUiState }) {
  const label = t(LABEL_BY_STATE[state]);
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
