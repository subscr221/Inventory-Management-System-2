import { t } from '../i18n/locale';

export function TestCaptureButton({ onCapture }: { onCapture?: () => void }) {
  return (
    <div className="edge-card">
      <h2>{t('capture.testAction')}</h2>
      <p>{t('capture.testDescription')}</p>
      <div className="edge-actions">
        <button className="primary-action" type="button" onClick={onCapture}>
          {t('capture.testAction')}
        </button>
      </div>
    </div>
  );
}
