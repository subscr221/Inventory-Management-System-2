'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { t, type MessageKey } from '../i18n/locale';
import {
  DAMAGE_REASON_CODES,
  MAX_DAMAGE_NOTE_LENGTH,
  missingDamageParts,
  type DamageFoundAt,
  type DamageMissingPart,
  type DamageReasonCode,
} from '../capture/damage';

export interface DamageSubmitInput {
  sku: string;
  lotNumber: string | null;
  quantity: string;
  foundAt: DamageFoundAt;
  binCode: string | null;
  reasonCode: DamageReasonCode;
  reasonNote: string | null;
  /** The photo exactly as taken (D14: no downscale). */
  photo: Blob;
  wholeLotRequested: boolean;
  replacement: {
    departmentCode: string;
    businessStream: string;
    itemCategory: string;
    uom: string;
  } | null;
}

export interface DamageSubmitResult {
  eventId: string;
  reportId: string;
  replacementIndentId: string | null;
}

/** Where the capture stands in the outbox: queued, accepted by the server, or refused. */
export type CaptureSettlement = 'pending' | 'synced' | 'refused';

export interface ReportDamageProps {
  onSubmit?: (input: DamageSubmitInput) => Promise<DamageSubmitResult>;
  /** Reads the outbox row of a submitted capture (Story 1.8 settlement). */
  settlementOf?: (eventId: string) => Promise<CaptureSettlement>;
  /** Changes whenever the outbox counts change, so the done screen re-reads its settlement. */
  outboxVersion?: string;
}

const REASON_LABEL: Record<DamageReasonCode, MessageKey> = {
  DEAD_ON_ARRIVAL: 'damage.reason.DEAD_ON_ARRIVAL',
  DAMAGED_COMPONENT: 'damage.reason.DAMAGED_COMPONENT',
  WRONG_ITEM_OR_SPEC: 'damage.reason.WRONG_ITEM_OR_SPEC',
  OTHER: 'damage.reason.OTHER',
};

const REASON_RULE: Record<DamageReasonCode, MessageKey> = {
  DEAD_ON_ARRIVAL: 'damage.reasonRule.DEAD_ON_ARRIVAL',
  DAMAGED_COMPONENT: 'damage.reasonRule.DAMAGED_COMPONENT',
  WRONG_ITEM_OR_SPEC: 'damage.reasonRule.WRONG_ITEM_OR_SPEC',
  OTHER: 'damage.reasonRule.OTHER',
};

const MISSING_LABEL: Record<DamageMissingPart, MessageKey> = {
  sku: 'damage.missing.sku',
  bin: 'damage.missing.bin',
  quantity: 'damage.missing.quantity',
  reason: 'damage.missing.reason',
  note: 'damage.missing.note',
  photo: 'damage.missing.photo',
  lot: 'damage.missing.lot',
  replacement: 'damage.missing.replacement',
};

/** The field each missing part sends focus to. */
const MISSING_FIELD: Record<DamageMissingPart, string> = {
  sku: 'damage-sku',
  bin: 'damage-bin',
  quantity: 'damage-quantity',
  reason: 'damage-reason-DEAD_ON_ARRIVAL',
  note: 'damage-reason-note',
  photo: 'damage-photo',
  lot: 'damage-lot',
  replacement: 'damage-department',
};

interface Done {
  eventId: string;
  wholeLot: boolean;
  replacement: boolean;
}

/**
 * Story 8.9 (AC 1, 2, 5; Table 13): report damage from any device, the base-hat capture. Scan the
 * item (keyboard wedge), say where it is and how many, pick a reason, take a photo. Works offline:
 * the report goes into the outbox and the photo into the pending-photo store; the done screen says
 * "Captured - pending sync" until the outbox row settles. The reporter never decides anything.
 */
export function ReportDamage({ onSubmit, settlementOf, outboxVersion = '' }: ReportDamageProps) {
  const [sku, setSku] = useState('');
  const [lotNumber, setLotNumber] = useState('');
  const [foundAt, setFoundAt] = useState<DamageFoundAt>('stock');
  const [binCode, setBinCode] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reasonCode, setReasonCode] = useState<DamageReasonCode | null>(null);
  const [reasonNote, setReasonNote] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [wholeLot, setWholeLot] = useState(false);
  const [replacement, setReplacement] = useState(false);
  const [departmentCode, setDepartmentCode] = useState('');
  const [businessStream, setBusinessStream] = useState('');
  const [itemCategory, setItemCategory] = useState('');
  const [uom, setUom] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [settlement, setSettlement] = useState<CaptureSettlement>('pending');
  // Story 4.3 lesson: a double tap must not capture twice; a ref closes the gap before re-render.
  const inFlight = useRef(false);
  const skuRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const doneHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!done) skuRef.current?.focus();
  }, [done]);

  useEffect(() => {
    if (done) doneHeading.current?.focus();
  }, [done]);

  // Re-read the outbox row whenever the outbox counts move.
  useEffect(() => {
    if (!done || !settlementOf) return;
    let cancelled = false;
    void settlementOf(done.eventId)
      .then((value) => {
        if (!cancelled) setSettlement(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [done, settlementOf, outboxVersion]);

  const missing = missingDamageParts({
    sku,
    foundAt,
    binCode,
    quantity,
    reasonCode,
    reasonNote,
    hasPhoto: photo !== null,
    wholeLotRequested: wholeLot,
    lotNumber,
    replacement,
    departmentCode,
    businessStream,
    itemCategory,
    uom,
  });

  const reset = useCallback(() => {
    setSku('');
    setLotNumber('');
    setFoundAt('stock');
    setBinCode('');
    setQuantity('');
    setReasonCode(null);
    setReasonNote('');
    setPhoto(null);
    if (photoRef.current) photoRef.current.value = '';
    setWholeLot(false);
    setReplacement(false);
    setDepartmentCode('');
    setBusinessStream('');
    setItemCategory('');
    setUom('');
    setNotice('');
    setSettlement('pending');
    setDone(null);
  }, []);

  async function submit() {
    if (inFlight.current) return;
    if (missing.length > 0 || !photo || !reasonCode) {
      setNotice(
        t('damage.stillNeeded').replace('{parts}', missing.map((part) => t(MISSING_LABEL[part])).join(', ')),
      );
      const first = missing[0];
      if (first) document.getElementById(MISSING_FIELD[first])?.focus();
      return;
    }
    if (!onSubmit) return;
    inFlight.current = true;
    setSubmitting(true);
    setNotice('');
    try {
      const result = await onSubmit({
        sku: sku.trim(),
        lotNumber: lotNumber.trim() || null,
        quantity: quantity.trim(),
        foundAt,
        binCode: foundAt === 'stock' ? binCode.trim() : null,
        reasonCode,
        reasonNote: reasonCode === 'OTHER' ? reasonNote.trim() : null,
        photo,
        wholeLotRequested: wholeLot,
        replacement: replacement
          ? {
              departmentCode: departmentCode.trim(),
              businessStream: businessStream.trim(),
              itemCategory: itemCategory.trim(),
              uom: uom.trim(),
            }
          : null,
      });
      setSettlement('pending');
      setDone({ eventId: result.eventId, wholeLot, replacement });
    } catch {
      setNotice(t('damage.captureFailed'));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="base-screen" id="report-damage">
        <section className="edge-card" aria-labelledby="damage-done-heading">
          <h2 id="damage-done-heading" ref={doneHeading} tabIndex={-1}>
            {settlement === 'synced'
              ? t('damage.doneReported')
              : settlement === 'refused'
                ? t('damage.doneRefused')
                : t('damage.doneCaptured')}
          </h2>
          <p>{t('damage.doneDecide')}</p>
          {done.wholeLot ? <p>{t('damage.doneWholeLot')}</p> : null}
          {done.replacement ? <p>{t('damage.doneReplacement')}</p> : null}
          <div className="edge-actions">
            <a className="secondary-action" href="/requests">
              {t('damage.backToRequests')}
            </a>
            <button className="primary-action" type="button" onClick={reset}>
              {t('damage.reportAnother')}
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="base-screen" id="report-damage">
      <h2 className="base-screen-title">{t('damage.title')}</h2>
      <form
        className="damage-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset className="edge-card damage-step">
          <legend>{t('damage.step1')}</legend>
          <label htmlFor="damage-sku">{t('damage.skuLabel')}</label>
          <input
            id="damage-sku"
            ref={skuRef}
            className="scan-input"
            name="sku"
            autoComplete="off"
            autoCapitalize="characters"
            maxLength={64}
            required
            value={sku}
            disabled={submitting}
            aria-describedby="damage-sku-hint"
            onChange={(event) => setSku(event.target.value)}
          />
          <p id="damage-sku-hint" className="base-hint">
            {t('damage.skuHint')}
          </p>
          <label htmlFor="damage-lot">{t('damage.lotLabel')}</label>
          <input
            id="damage-lot"
            className="scan-input"
            name="lot"
            autoComplete="off"
            maxLength={128}
            value={lotNumber}
            disabled={submitting}
            aria-describedby="damage-lot-hint"
            onChange={(event) => setLotNumber(event.target.value)}
          />
          <p id="damage-lot-hint" className="base-hint">
            {t('damage.lotHint')}
          </p>
          <fieldset className="damage-choice">
            <legend>{t('damage.whereLabel')}</legend>
            <label htmlFor="damage-found-stock">
              <input
                id="damage-found-stock"
                type="radio"
                name="found_at"
                value="stock"
                checked={foundAt === 'stock'}
                disabled={submitting}
                onChange={() => setFoundAt('stock')}
              />
              {t('damage.foundStock')}
            </label>
            <label htmlFor="damage-found-in-use">
              <input
                id="damage-found-in-use"
                type="radio"
                name="found_at"
                value="in_use"
                checked={foundAt === 'in_use'}
                disabled={submitting}
                onChange={() => setFoundAt('in_use')}
              />
              {t('damage.foundInUse')}
            </label>
          </fieldset>
          {foundAt === 'stock' ? (
            <>
              <label htmlFor="damage-bin">{t('damage.binLabel')}</label>
              <input
                id="damage-bin"
                className="scan-input"
                name="bin"
                autoComplete="off"
                maxLength={64}
                required
                value={binCode}
                disabled={submitting}
                onChange={(event) => setBinCode(event.target.value)}
              />
            </>
          ) : null}
        </fieldset>

        <fieldset className="edge-card damage-step">
          <legend>{t('damage.step2')}</legend>
          <label htmlFor="damage-quantity">{t('damage.quantityLabel')}</label>
          <input
            id="damage-quantity"
            name="quantity"
            inputMode="decimal"
            autoComplete="off"
            required
            value={quantity}
            disabled={submitting}
            aria-describedby="damage-quantity-hint"
            onChange={(event) => setQuantity(event.target.value)}
          />
          <p id="damage-quantity-hint" className="base-hint">
            {t('damage.quantityHint')}
          </p>
        </fieldset>

        <fieldset className="edge-card damage-step">
          <legend>{t('damage.step3')}</legend>
          <div className="damage-choice">
            {DAMAGE_REASON_CODES.map((code) => (
              <label key={code} htmlFor={`damage-reason-${code}`}>
                <input
                  id={`damage-reason-${code}`}
                  type="radio"
                  name="reason_code"
                  value={code}
                  checked={reasonCode === code}
                  disabled={submitting}
                  onChange={() => setReasonCode(code)}
                />
                <span>
                  <strong>{t(REASON_LABEL[code])}</strong>
                  <span className="damage-choice-rule">{t(REASON_RULE[code])}</span>
                </span>
              </label>
            ))}
          </div>
          {reasonCode === 'OTHER' ? (
            <>
              <label htmlFor="damage-reason-note">{t('damage.otherNoteLabel')}</label>
              <input
                id="damage-reason-note"
                name="reason_note"
                autoComplete="off"
                required
                maxLength={MAX_DAMAGE_NOTE_LENGTH}
                value={reasonNote}
                disabled={submitting}
                onChange={(event) => setReasonNote(event.target.value.replace(/[\r\n]+/g, ' '))}
              />
            </>
          ) : null}
        </fieldset>

        <fieldset className="edge-card damage-step">
          <legend>{t('damage.photoLegend')}</legend>
          <label htmlFor="damage-photo" className="damage-photo-label">
            {photo ? t('damage.retakePhoto') : t('damage.takePhoto')}
          </label>
          <input
            id="damage-photo"
            ref={photoRef}
            type="file"
            name="photo"
            accept="image/*"
            capture="environment"
            required
            disabled={submitting}
            aria-describedby="damage-photo-status"
            onChange={(event) => setPhoto(event.target.files?.[0] ?? null)}
          />
          <p id="damage-photo-status" className="base-hint">
            {photo ? t('damage.photoSaved') : t('damage.photoRequired')}
          </p>
        </fieldset>

        <fieldset className="edge-card damage-step">
          <legend>{t('damage.optionsLegend')}</legend>
          <label htmlFor="damage-whole-lot" className="damage-toggle">
            <input
              id="damage-whole-lot"
              type="checkbox"
              checked={wholeLot}
              disabled={submitting}
              onChange={(event) => setWholeLot(event.target.checked)}
            />
            <span>
              <strong>{t('damage.wholeLotLabel')}</strong>
              <span className="damage-choice-rule">{t('damage.wholeLotHint')}</span>
            </span>
          </label>
          <label htmlFor="damage-replacement" className="damage-toggle">
            <input
              id="damage-replacement"
              type="checkbox"
              checked={replacement}
              disabled={submitting}
              onChange={(event) => setReplacement(event.target.checked)}
            />
            <span>
              <strong>{t('damage.replacementLabel')}</strong>
              <span className="damage-choice-rule">{t('damage.replacementHint')}</span>
            </span>
          </label>
          {replacement ? (
            <div className="damage-replacement">
              <label htmlFor="damage-department">{t('damage.departmentLabel')}</label>
              <input
                id="damage-department"
                name="department_code"
                autoComplete="off"
                required
                value={departmentCode}
                disabled={submitting}
                onChange={(event) => setDepartmentCode(event.target.value)}
              />
              <label htmlFor="damage-business-stream">{t('damage.businessStreamLabel')}</label>
              <input
                id="damage-business-stream"
                name="business_stream"
                autoComplete="off"
                required
                value={businessStream}
                disabled={submitting}
                onChange={(event) => setBusinessStream(event.target.value)}
              />
              <label htmlFor="damage-item-category">{t('damage.itemCategoryLabel')}</label>
              <input
                id="damage-item-category"
                name="item_category"
                autoComplete="off"
                required
                value={itemCategory}
                disabled={submitting}
                onChange={(event) => setItemCategory(event.target.value)}
              />
              <label htmlFor="damage-uom">{t('damage.uomLabel')}</label>
              <input
                id="damage-uom"
                name="uom"
                autoComplete="off"
                required
                value={uom}
                disabled={submitting}
                onChange={(event) => setUom(event.target.value)}
              />
            </div>
          ) : null}
        </fieldset>

        <div className="edge-card damage-footer">
          <p id="damage-readiness">
            {missing.length === 0
              ? t('damage.ready')
              : t('damage.stillNeeded').replace(
                  '{parts}',
                  missing.map((part) => t(MISSING_LABEL[part])).join(', '),
                )}
          </p>
          <button
            className="primary-action"
            type="submit"
            disabled={submitting}
            aria-busy={submitting}
            aria-describedby="damage-readiness"
          >
            {submitting ? t('damage.sending') : t('damage.submit')}
          </button>
          {notice ? (
            <p className="base-notice" role="status" aria-live="polite" aria-label={t('damage.liveLabel')}>
              {notice}
            </p>
          ) : null}
        </div>
      </form>
    </div>
  );
}
