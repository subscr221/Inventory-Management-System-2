'use client';

import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/locale';

export interface IndentSubmitInput {
  sku: string;
  itemCategory: string;
  requestedQty: number;
  uom: string;
  unitPriceEstimate?: number;
  needByDate: string;
  departmentCode: string;
  businessStream: string;
  urgent: boolean;
  reason?: string;
  formOpenedAt: string;
  localCommitAt: string;
}

/**
 * UJ-IND-01 tap-count budget: the CI regression proxy for the 90-second capture target. The form
 * has 6 required inputs, 2 optional inputs, 1 checkbox, 1 optional free-text field, and 1 submit
 * button; on a scan-gun device the SKU arrives as a scan, so a full capture fits inside this
 * interaction budget. The edge unit test pins the rendered control count against it.
 */
export const INDENT_CAPTURE_TAP_BUDGET = 12;

export function IndentCapture({
  syncState: _syncState,
  onSubmit,
}: {
  syncState: string;
  onSubmit?: (input: IndentSubmitInput) => Promise<string>;
}) {
  const [sku, setSku] = useState('');
  const [itemCategory, setItemCategory] = useState('');
  const [quantity, setQuantity] = useState('');
  const [uom, setUom] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [needByDate, setNeedByDate] = useState('');
  const [departmentCode, setDepartmentCode] = useState('');
  const [businessStream, setBusinessStream] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [reason, setReason] = useState('');
  const [result, setResult] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const skuRef = useRef<HTMLInputElement>(null);
  // UJ-IND-01 instrumentation: form_opened is stamped once, when the form mounts.
  const formOpenedAt = useRef('');

  useEffect(() => {
    formOpenedAt.current = new Date().toISOString();
    skuRef.current?.focus();
  }, []);

  async function submit() {
    if (isSubmitting) return;
    const qty = Number(quantity);
    if (!sku.trim() || !Number.isFinite(qty) || qty <= 0) {
      setResult(t('indent.correction'));
      return;
    }
    const price = unitPrice.trim() === '' ? undefined : Number(unitPrice);
    if (price !== undefined && (!Number.isFinite(price) || price < 0)) {
      setResult(t('indent.correction'));
      return;
    }
    setIsSubmitting(true);
    try {
      // UJ-IND-01 instrumentation: local_commit is the instant the capture is handed to the
      // local outbox - the 90-second target is measured form_opened to local_commit.
      const localCommitAt = new Date().toISOString();
      const identifier = await onSubmit?.({
        sku: sku.trim(),
        itemCategory: itemCategory.trim(),
        requestedQty: qty,
        uom: uom.trim(),
        ...(price !== undefined ? { unitPriceEstimate: price } : {}),
        needByDate,
        departmentCode: departmentCode.trim(),
        businessStream: businessStream.trim(),
        urgent,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        formOpenedAt: formOpenedAt.current,
        localCommitAt,
      });
      setResult(`${t('sync.captured')}. ${identifier ?? ''}. ${t('indent.nextAction')}`);
    } catch {
      setResult(t('indent.correction'));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="edge-card indent-capture" aria-labelledby="indent-heading">
      <h2 id="indent-heading">{t('indent.title')}</h2>
      <p>{t('indent.description')}</p>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label htmlFor="indent-sku">{t('indent.sku')}</label>
        <input ref={skuRef} id="indent-sku" value={sku} onChange={(event) => setSku(event.target.value)} required />
        <label htmlFor="indent-item-category">{t('indent.itemCategory')}</label>
        <input id="indent-item-category" value={itemCategory} onChange={(event) => setItemCategory(event.target.value)} required />
        <label htmlFor="indent-quantity">{t('indent.quantity')}</label>
        <input id="indent-quantity" inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} required />
        <label htmlFor="indent-uom">{t('indent.uom')}</label>
        <input id="indent-uom" value={uom} onChange={(event) => setUom(event.target.value)} required />
        <label htmlFor="indent-unit-price">{t('indent.unitPriceEstimate')}</label>
        <input id="indent-unit-price" inputMode="decimal" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} />
        <label htmlFor="indent-need-by">{t('indent.needByDate')}</label>
        <input id="indent-need-by" type="date" value={needByDate} onChange={(event) => setNeedByDate(event.target.value)} required />
        <label htmlFor="indent-department">{t('indent.departmentCode')}</label>
        <input id="indent-department" value={departmentCode} onChange={(event) => setDepartmentCode(event.target.value)} required />
        <label htmlFor="indent-business-stream">{t('indent.businessStream')}</label>
        <input id="indent-business-stream" value={businessStream} onChange={(event) => setBusinessStream(event.target.value)} required />
        <label htmlFor="indent-urgent">
          <input id="indent-urgent" type="checkbox" checked={urgent} onChange={(event) => setUrgent(event.target.checked)} />
          {t('indent.urgent')}
        </label>
        <label htmlFor="indent-reason">{t('indent.reason')}</label>
        <input id="indent-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
        <button className="primary-action" type="submit" disabled={isSubmitting}>{t('indent.submit')}</button>
      </form>
      <p role="status" aria-live="polite" aria-label={t('indent.resultLabel')}>{result}</p>
    </section>
  );
}
