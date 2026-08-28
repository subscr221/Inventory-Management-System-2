'use client';

import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/locale';

export interface FaultReportSubmitInput {
  assetTag: string;
  description: string;
  safetyFlag: boolean;
}

/**
 * Story 7.8 (FR-M-04 offline, Binding Decision 12): the scan-first fault report. The device has no
 * asset register, so only the scanned tag is captured; the server resolves the asset on replay.
 * The tag field is the 56px scan input (EXPERIENCE.md scan-input-screen).
 */
export function FaultReportCapture({
  onSubmit,
}: {
  onSubmit?: (input: FaultReportSubmitInput) => Promise<string>;
}) {
  const [assetTag, setAssetTag] = useState('');
  const [description, setDescription] = useState('');
  const [safetyFlag, setSafetyFlag] = useState(false);
  const [result, setResult] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const tagRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    tagRef.current?.focus();
  }, []);

  async function submit() {
    if (isSubmitting) return;
    if (!assetTag.trim() || !description.trim()) {
      setResult(t('maintenance.fault.correction'));
      return;
    }
    setIsSubmitting(true);
    try {
      const identifier = await onSubmit?.({
        assetTag: assetTag.trim(),
        description: description.trim(),
        safetyFlag,
      });
      setResult(`${t('sync.captured')}. ${identifier ?? ''}. ${t('maintenance.fault.nextAction')}`);
      setAssetTag('');
      setDescription('');
      setSafetyFlag(false);
      tagRef.current?.focus();
    } catch {
      setResult(t('maintenance.fault.correction'));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="edge-card fault-report-capture" aria-labelledby="fault-report-heading">
      <h2 id="fault-report-heading">{t('maintenance.fault.title')}</h2>
      <p>{t('maintenance.fault.description')}</p>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label htmlFor="fault-asset-tag">{t('maintenance.fault.assetTag')}</label>
        <input
          ref={tagRef}
          id="fault-asset-tag"
          className="scan-input"
          style={{ minHeight: '56px' }}
          value={assetTag}
          onChange={(event) => setAssetTag(event.target.value)}
          autoComplete="off"
          required
        />
        <label htmlFor="fault-description">{t('maintenance.fault.faultDescription')}</label>
        <textarea
          id="fault-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          required
        />
        <label htmlFor="fault-safety-flag">
          <input
            id="fault-safety-flag"
            type="checkbox"
            checked={safetyFlag}
            onChange={(event) => setSafetyFlag(event.target.checked)}
          />
          {t('maintenance.fault.safetyFlag')}
        </label>
        <button className="primary-action" type="submit" disabled={isSubmitting}>
          {t('maintenance.fault.submit')}
        </button>
      </form>
      <p role="status" aria-live="polite" aria-label={t('maintenance.fault.resultLabel')}>{result}</p>
    </section>
  );
}
