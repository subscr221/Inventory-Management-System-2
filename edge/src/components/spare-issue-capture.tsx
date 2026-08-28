'use client';

import { useState } from 'react';
import { t } from '../i18n/locale';
import type { CachedReservationRow } from '../local-db/worklist';

export interface SpareIssueSubmitInput {
  reservationId: string;
}

/** Story 7.8 (Binding Decision 13): confirms a CACHED reservation as issued; quantity is the reserved amount, return clock is server-derived. */
export function SpareIssueCapture({
  reservations,
  onSubmit,
}: {
  reservations: CachedReservationRow[];
  onSubmit?: (input: SpareIssueSubmitInput) => Promise<string>;
}) {
  const [reservationId, setReservationId] = useState('');
  const [result, setResult] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const selected = reservations.find((row) => row.reservation_id === reservationId) ?? null;

  async function submit() {
    if (isSubmitting) return;
    if (!selected) {
      setResult(t('maintenance.spare.correction'));
      return;
    }
    setIsSubmitting(true);
    try {
      const identifier = await onSubmit?.({ reservationId: selected.reservation_id });
      setResult(`${t('sync.captured')}. ${identifier ?? ''}. ${t('maintenance.spare.nextAction')}`);
      setReservationId('');
    } catch {
      setResult(t('maintenance.spare.correction'));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="edge-card spare-issue-capture" aria-labelledby="spare-issue-heading">
      <h2 id="spare-issue-heading">{t('maintenance.spare.title')}</h2>
      {reservations.length === 0 ? <p>{t('maintenance.spare.empty')}</p> : null}
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label htmlFor="spare-issue-reservation">{t('maintenance.spare.reservation')}</label>
        <select
          id="spare-issue-reservation"
          value={reservationId}
          onChange={(event) => setReservationId(event.target.value)}
          required
        >
          <option value="">{t('maintenance.closure.choose')}</option>
          {reservations.map((row) => (
            <option key={row.reservation_id} value={row.reservation_id}>
              {row.sku} · {t('maintenance.spare.quantity')} {row.quantity}
            </option>
          ))}
        </select>
        <button
          className="primary-action"
          type="submit"
          disabled={isSubmitting || reservations.length === 0}
        >
          {t('maintenance.spare.submit')}
        </button>
      </form>
      <p role="status" aria-live="polite" aria-label={t('maintenance.spare.resultLabel')}>{result}</p>
    </section>
  );
}
