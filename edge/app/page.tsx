import { AppShell } from '../src/components/app-shell';
import { t } from '../src/i18n/locale';

export default function Home() {
  return (
    <AppShell
      userName={t('app.defaultUserName')}
      siteName={t('app.defaultSiteName')}
      syncState="offline"
    />
  );
}
