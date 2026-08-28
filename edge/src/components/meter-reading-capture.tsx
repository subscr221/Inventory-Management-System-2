'use client';

import { useState } from 'react';
import { t } from '../i18n/locale';
import type { WorklistMeter } from '../local-db/worklist';

export interface MeterReadingSubmitInput {
  meterId: string;
  readingValue: number;
}

/** Story 7.8 (Table 4): a meter reading against one of the selected work order's asset meters; the version is server-assigned. */
export function MeterReadingCapture({
  meters,
  onSubmit,
}: {
  meters: WorklistMeter[];
  onSubmit?: (input: MeterReadingSubmitInput) => Promise<string>;
}) {
  const [meterId, setMeterId] = useState('');
  const [reading, setReading] = useState('');
  const [result, setResult] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit() {
    if (isSubmitting) return;
    const value = Number(reading);
    if (!meterId || reading.trim() === '' || !Number.isFinite(value) || value < 0) {
      setResult(t('maintenance.meter.correction'));
      return;
    }
    setIsSubmitting(true);
    try {
      const identifier = await onSubmit?.({ meterId, readingValue: value });
      setResult(`${t('sync.captured')}. ${identifier ?? ''}. ${t('maintenance.meter.nextAction')}`);
      setReading('');
    } catch {
      setResult(t('maintenance.meter.correction'));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="edge-card meter-reading-capture" aria-labelledby="meter-reading-heading">
      <h2 id="meter-reading-heading">{t('maintenance.meter.title')}</h2>
      {meters.length === 0 ? <p>{t('maintenance.meter.empty')}</p> : null}
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label htmlFor="meter-reading-meter">{t('maintenance.meter.meter')}</label>
        <select
          id="meter-reading-meter"
          value={meterId}
          onChange={(event) => setMeterId(event.target.value)}
          required
        >
          <option value="">{t('maintenance.closure.choose')}</option>
          {meters.map((meter) => (
            <option key={meter.meter_id} value={meter.meter_id}>
              {meter.meter_code} ({meter.unit}) · {t('maintenance.meter.currentReading')} {meter.current_reading}
            </option>
          ))}
        </select>
        <label htmlFor="meter-reading-value">{t('maintenance.meter.reading')}</label>
        <input
          id="meter-reading-value"
          inputMode="decimal"
          value={reading}
          onChange={(event) => setReading(event.target.value)}
          required
        />
        <button className="primary-action" type="submit" disabled={isSubmitting || meters.length === 0}>
          {t('maintenance.meter.submit')}
        </button>
      </form>
      <p role="status" aria-live="polite" aria-label={t('maintenance.meter.resultLabel')}>{result}</p>
    </section>
  );
}
