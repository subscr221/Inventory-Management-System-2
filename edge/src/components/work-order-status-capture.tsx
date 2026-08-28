'use client';

import { useState } from 'react';
import { t } from '../i18n/locale';

export interface WorkOrderStatusSubmitInput {
  workOrderId: string;
  newStatus: 'in_progress' | 'on_hold';
  note: string | null;
}

/** Story 7.8 (Binding Decision 7): the "I am on it / I am blocked" transition for the selected work order. */
export function WorkOrderStatusCapture({
  workOrderId,
  currentStatus,
  onSubmit,
}: {
  workOrderId: string | null;
  currentStatus: string | null;
  onSubmit?: (input: WorkOrderStatusSubmitInput) => Promise<string>;
}) {
  const [newStatus, setNewStatus] = useState<'in_progress' | 'on_hold' | ''>('');
  const [note, setNote] = useState('');
  const [result, setResult] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit() {
    if (isSubmitting) return;
    if (!workOrderId || newStatus === '') {
      setResult(t('maintenance.status.correction'));
      return;
    }
    setIsSubmitting(true);
    try {
      const identifier = await onSubmit?.({
        workOrderId,
        newStatus,
        note: note.trim() ? note.trim() : null,
      });
      setResult(`${t('sync.captured')}. ${identifier ?? ''}. ${t('maintenance.status.nextAction')}`);
      setNote('');
    } catch {
      setResult(t('maintenance.status.correction'));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="edge-card work-order-status-capture" aria-labelledby="wo-status-heading">
      <h2 id="wo-status-heading">{t('maintenance.status.title')}</h2>
      {currentStatus ? (
        <p>
          {t('maintenance.worklist.status')}: {currentStatus}
        </p>
      ) : null}
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label htmlFor="wo-status-new">{t('maintenance.status.newStatus')}</label>
        <select
          id="wo-status-new"
          value={newStatus}
          onChange={(event) => setNewStatus(event.target.value as 'in_progress' | 'on_hold' | '')}
          required
        >
          <option value="">{t('maintenance.closure.choose')}</option>
          <option value="in_progress">{t('maintenance.status.inProgress')}</option>
          <option value="on_hold">{t('maintenance.status.onHold')}</option>
        </select>
        <label htmlFor="wo-status-note">{t('maintenance.status.note')}</label>
        <input
          id="wo-status-note"
          value={note}
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
        />
        <button className="primary-action" type="submit" disabled={isSubmitting || !workOrderId}>
          {t('maintenance.status.submit')}
        </button>
      </form>
      <p role="status" aria-live="polite" aria-label={t('maintenance.status.resultLabel')}>{result}</p>
    </section>
  );
}
