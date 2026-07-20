import { AppShell } from '../../src/components/app-shell';
import { t } from '../../src/i18n/locale';

export default function SyncErrorPage() {
  return (
    <AppShell
      userName={t('app.defaultUserName')}
      siteName={t('app.defaultSiteName')}
      syncState="error"
      failures={[
        {
          eventId: '11111111-1111-4111-8111-111111111111',
          eventType: 'edge.test_capture_recorded',
          errorCode: 'UNTAGGED_TRANSACTION',
          failedAt: '2026-07-20T03:30:00.000Z',
        },
      ]}
    />
  );
}
