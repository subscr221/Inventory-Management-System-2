import { t } from '../../i18n/locale';

/** Shown above every view that still reads mock-data.ts or hard-coded figures. */
export function SampleDataNotice() {
  return (
    <p className="sample-data-notice" role="note">
      <strong>{t('sampleData.label')}</strong> {t('sampleData.body')}
    </p>
  );
}
