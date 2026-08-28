'use client';

import { useState } from 'react';
import { t } from '../i18n/locale';

export interface WorkOrderClosureSubmitInput {
  workOrderId: string;
  faultCode: string;
  causeCode: string;
  remedyCode: string;
}

export interface ClosureCatalogue {
  fault: string[];
  cause: string[];
  remedy: string[];
}

/**
 * Story 7.8 (FR-M-18, AC 3): three-part closure coding. Breakdown work orders require all three
 * codes before submit (mirroring the server gate, 422 CLOSURE_CODES_REQUIRED); preventive work
 * orders accept the codes optionally on an all-or-none basis (Binding Decision 8). The server
 * remains authoritative.
 */
export function WorkOrderClosureCapture({
  workOrderId,
  origin,
  catalogue,
  onSubmit,
}: {
  workOrderId: string | null;
  origin?: string | null;
  catalogue: ClosureCatalogue;
  onSubmit?: (input: WorkOrderClosureSubmitInput) => Promise<string>;
}) {
  const [faultCode, setFaultCode] = useState('');
  const [causeCode, setCauseCode] = useState('');
  const [remedyCode, setRemedyCode] = useState('');
  const [result, setResult] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const hasAllCodes = Boolean(faultCode && causeCode && remedyCode);
  const hasAnyCode = Boolean(faultCode || causeCode || remedyCode);
  const codesRequired = origin === 'breakdown';
  const complete = Boolean(workOrderId) && (hasAllCodes || (!codesRequired && !hasAnyCode));

  async function submit() {
    if (isSubmitting) return;
    if (!workOrderId || !complete) {
      setResult(t('maintenance.closure.correction'));
      return;
    }
    setIsSubmitting(true);
    try {
      const identifier = await onSubmit?.({ workOrderId, faultCode, causeCode, remedyCode });
      setResult(`${t('sync.captured')}. ${identifier ?? ''}. ${t('maintenance.closure.nextAction')}`);
      setFaultCode('');
      setCauseCode('');
      setRemedyCode('');
    } catch {
      setResult(t('maintenance.closure.correction'));
    } finally {
      setIsSubmitting(false);
    }
  }

  const select = (
    id: string,
    label: string,
    value: string,
    options: string[],
    onChange: (next: string) => void,
  ) => (
    <>
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} required>
        <option value="">{t('maintenance.closure.choose')}</option>
        {options.map((code) => (
          <option key={code} value={code}>
            {code}
          </option>
        ))}
      </select>
    </>
  );

  return (
    <section className="edge-card work-order-closure-capture" aria-labelledby="wo-closure-heading">
      <h2 id="wo-closure-heading">{t('maintenance.closure.title')}</h2>
      <p>{t('maintenance.closure.description')}</p>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {select('wo-closure-fault', t('maintenance.closure.faultCode'), faultCode, catalogue.fault, setFaultCode)}
        {select('wo-closure-cause', t('maintenance.closure.causeCode'), causeCode, catalogue.cause, setCauseCode)}
        {select('wo-closure-remedy', t('maintenance.closure.remedyCode'), remedyCode, catalogue.remedy, setRemedyCode)}
        <button className="primary-action" type="submit" disabled={isSubmitting || !complete}>
          {t('maintenance.closure.submit')}
        </button>
      </form>
      <p role="status" aria-live="polite" aria-label={t('maintenance.closure.resultLabel')}>{result}</p>
    </section>
  );
}
