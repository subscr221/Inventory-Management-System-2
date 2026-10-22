'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage, t, type MessageKey } from '../i18n/locale';
import { authorizedFetch } from '../session/api-fetch';
import { labelStore } from '../local-db/label-queue';
import { buildLabels } from './label-queue-model';
import { LabelQueue } from './label-queue';
import { acceptanceMissing, type ArrivalRow } from './stores-inbox-model';
import {
  buildReceiptRows,
  fromMicros,
  goodQuantity,
  lineChip,
  lineIsShort,
  toMicros,
  type ReceiptLineDraft,
  type ReceiptRow,
  type ReceiptSubmission,
} from '../capture/receiving';

export type ReceiptSubmitResult =
  | { kind: 'posted'; grnId: string }
  | { kind: 'pending'; grnId: string }
  | { kind: 'error'; errorCode: string };

export interface StoresAcceptProps {
  online: boolean;
  siteCodeExt: string | null;
  inspectionBayCode: string | null;
  onSubmitReceipt: (submission: ReceiptSubmission, rows: ReceiptRow[]) => Promise<ReceiptSubmitResult>;
  storePhoto: (file: File) => Promise<string>;
}

interface PoLine {
  line_no: number;
  sku: string;
  ordered_qty: number;
  open_qty: number;
  over_receipt_tolerance_pct: number | null;
}

interface PoView {
  po_number_ext: string;
  supplier_ref_ext: string;
  lines: PoLine[];
}

interface LineState {
  counted: string;
  good: string;
  damaged: string;
  rejected: string;
  shortDetail: string;
  otherNote: string;
  otherPhotoRef: string;
  damagedDetail: string;
  rejectedDetail: string;
}

const SHORT_DETAILS = [
  'SUPPLIER_SHORT_SHIPPED',
  'PART_DELIVERY_BALANCE_TO_FOLLOW',
  'COUNT_MISMATCH_WITH_CHALLAN',
  'OTHER',
] as const;

const DAMAGED_DETAILS = ['TRANSIT_DAMAGE', 'PACKING_DAMAGE', 'RUST_OR_CORROSION'] as const;
const REJECTED_DETAILS = ['WRONG_ITEM', 'WRONG_SPEC'] as const;

function emptyLine(): LineState {
  return {
    counted: '',
    good: '',
    damaged: '',
    rejected: '',
    shortDetail: '',
    otherNote: '',
    otherPhotoRef: '',
    damagedDetail: 'TRANSIT_DAMAGE',
    rejectedDetail: 'WRONG_ITEM',
  };
}

function quantity(value: string): string {
  return value.trim() || '0';
}

function sum(good: string, damaged: string, rejected: string): string {
  return fromMicros(
    toMicros(quantity(good)) + toMicros(quantity(damaged)) + toMicros(quantity(rejected)),
  );
}

export function StoresAccept({
  online,
  siteCodeExt,
  inspectionBayCode,
  onSubmitReceipt,
  storePhoto,
}: StoresAcceptProps) {
  const [arrival, setArrival] = useState<ArrivalRow | null>(null);
  const [po, setPo] = useState<PoView | null>(null);
  const [lines, setLines] = useState<Record<number, LineState>>({});
  const [uoms, setUoms] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [materialPhotoRef, setMaterialPhotoRef] = useState('');
  const [inspectOnOpening, setInspectOnOpening] = useState<'' | 'suspected' | 'observed'>('');
  const [inspectNote, setInspectNote] = useState('');
  const [inspectPhotoRef, setInspectPhotoRef] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ReceiptRow[] | null>(null);
  const [submittedGrnId, setSubmittedGrnId] = useState('');
  const submissionRef = useRef<{ submission: ReceiptSubmission; rows: ReceiptRow[] } | null>(null);

  const gateId = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return new URLSearchParams(window.location.search).get('gate') ?? '';
  }, []);

  useEffect(() => {
    if (!online) {
      setLoading(false);
      setMessage(t('stores.needsConnection'));
      return;
    }
    if (!siteCodeExt) {
      setLoading(false);
      setMessage(t('stores.noSite'));
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const arrivalsRes = await authorizedFetch(
          `/api/v1/receiving/arrivals?site=${encodeURIComponent(siteCodeExt as string)}`,
        );
        if (!arrivalsRes.ok) throw new Error('arrivals');
        const arrivals = ((await arrivalsRes.json()) as { arrivals?: ArrivalRow[] }).arrivals ?? [];
        const hit = arrivals.find((row) => row.gate_event_id === gateId) ?? null;
        if (!hit || !hit.po_ref_ext) {
          if (!cancelled) {
            setLoading(false);
            setMessage(t('stores.accept.notFound'));
          }
          return;
        }
        const poRes = await authorizedFetch(
          `/api/v1/erp/purchase-orders/${encodeURIComponent(hit.po_ref_ext)}`,
        );
        if (!poRes.ok) throw new Error('po');
        const poBody = (await poRes.json()) as PoView;
        const skus = [
          ...new Set(poBody.lines.filter((line) => line.open_qty > 0).map((line) => line.sku)),
        ];
        const uomPairs = await Promise.all(
          skus.map(async (sku) => {
            const itemRes = await authorizedFetch(`/api/v1/items/${encodeURIComponent(sku)}`);
            if (!itemRes.ok) return [sku, 'EA'] as const;
            const item = (await itemRes.json()) as { item?: { uom?: unknown }; uom?: unknown };
            const uom = item.item?.uom ?? item.uom;
            return [sku, typeof uom === 'string' && uom ? uom : 'EA'] as const;
          }),
        );
        if (!cancelled) {
          setUoms(Object.fromEntries(uomPairs));
          setArrival(hit);
          setPo(poBody);
          setLines(
            Object.fromEntries(
              poBody.lines
                .filter((line) => line.open_qty > 0)
                .map((line) => [line.line_no, emptyLine()]),
            ),
          );
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setLoading(false);
          setMessage(t('stores.failed'));
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [gateId, online, siteCodeExt]);

  const openLines = po?.lines.filter((line) => line.open_qty > 0) ?? [];

  function update(lineNo: number, patch: Partial<LineState>) {
    setLines((current) => ({ ...current, [lineNo]: { ...current[lineNo]!, ...patch } }));
  }

  function draftFor(line: PoLine): ReceiptLineDraft {
    const state = lines[line.line_no] ?? emptyLine();
    return {
      poRefExt: po?.po_number_ext ?? '',
      lineNo: line.line_no,
      sku: line.sku,
      uom: uoms[line.sku] ?? 'EA',
      ordered: line.ordered_qty,
      cumulativeReceived: Math.max(line.ordered_qty - line.open_qty, 0),
      overReceiptTolerancePct: line.over_receipt_tolerance_pct,
      good: quantity(state.good),
      damaged: quantity(state.damaged),
      rejected: quantity(state.rejected),
      damagedDetail: state.damagedDetail,
      rejectedDetail: state.rejectedDetail,
      shortDetail: state.shortDetail,
      otherPhotoRef: state.otherPhotoRef,
      otherNote: state.otherNote,
    };
  }

  const shortMissing = openLines.some((line) => {
    const state = lines[line.line_no] ?? emptyLine();
    if (state.counted === '') return false;
    const draft = draftFor(line);
    if (!lineIsShort(draft)) return false;
    if (!state.shortDetail) return true;
    if (state.shortDetail === 'OTHER') return !state.otherPhotoRef || !state.otherNote.trim();
    return false;
  });
  const countedLines = openLines.filter(
    (line) => (lines[line.line_no]?.counted ?? '') !== '',
  ).length;
  const missing = acceptanceMissing({
    countedLines,
    openLines: openLines.length,
    materialPhoto: Boolean(materialPhotoRef),
    shortDetailsComplete: !shortMissing,
    otherEvidenceComplete: true,
  });
  const canSubmit =
    !submitting &&
    Boolean(arrival) &&
    Boolean(inspectionBayCode) &&
    Boolean(po) &&
    missing.length === 0;

  async function pickPhoto(target: 'material' | 'other' | 'inspect', lineNo?: number) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp,image/heic,image/heif';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      void storePhoto(file).then((ref) => {
        if (target === 'material') setMaterialPhotoRef(ref);
        else if (target === 'inspect') setInspectPhotoRef(ref);
        else if (lineNo !== undefined) update(lineNo, { otherPhotoRef: ref });
      });
    };
    input.click();
  }

async function submit() {
    if (!arrival || !po || !inspectionBayCode) return;
    setSubmitting(true);
    setMessage('');
    try {
      // Build the rows once so a retry after a partial online failure replays the same GRN line ids
      // and the same material/inspection evidence instead of minting new ones.
      let prepared = submissionRef.current;
      if (!prepared) {
        const submission: ReceiptSubmission = {
          grnId: crypto.randomUUID(),
          bindingToken: arrival.binding_token,
          inspectionBayCode,
          materialPhotoRef,
          ...(inspectOnOpening ? { inspectOnOpening } : {}),
          ...(inspectNote.trim() ? { inspectNote: inspectNote.trim() } : {}),
          ...(inspectPhotoRef ? { inspectPhotoRef } : {}),
          lines: openLines.map(draftFor),
        };
        prepared = { submission, rows: buildReceiptRows(submission) };
        submissionRef.current = prepared;
      }
setSubmittedGrnId(prepared.submission.grnId);
  const response = await onSubmitReceipt(prepared.submission, prepared.rows);
  if (response.kind === 'error') {
    setMessage(errorMessage(response.errorCode));
    return;
  }
  try {
    await labelStore.putMany(buildLabels(prepared.submission.grnId, prepared.rows));
  } catch {
    setMessage(t('labels.queuedFailed'));
  }
  setResult(prepared.rows);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <p className="stores-status">{t('stores.loading')}</p>;
  if (result) {
    const summary = {
      lines: result.length,
      good: result.filter((row) => row.condition === 'GOOD').length,
      damaged: result.filter((row) => row.condition === 'DAMAGED').length,
      rejected: result.filter((row) => row.condition === 'REJECTED').length,
    };
    return (
      <section className="edge-card" id="stores-completion" aria-live="polite">
        <h1>{t('stores.done.title')}</h1>
        <p>{t('stores.done.grn').replace('{grn}', submittedGrnId)}</p>
        <ul className="stores-summary">
          <li>{t('stores.done.lines').replace('{count}', String(summary.lines))}</li>
          <li>{t('stores.done.good').replace('{count}', String(summary.good))}</li>
          <li>{t('stores.done.damaged').replace('{count}', String(summary.damaged))}</li>
          <li>{t('stores.done.rejected').replace('{count}', String(summary.rejected))}</li>
        </ul>
        <p>{online ? t('stores.done.synced') : t('stores.done.pending')}</p>
        <LabelQueue grnId={submittedGrnId} />
        <a className="primary-action" href="/stores">
          {t('stores.done.back')}
        </a>
      </section>
    );
  }
  if (!arrival || !po) {
    return (
      <section className="edge-card" aria-live="polite">
        <p>{message || t('stores.accept.notFound')}</p>
        <a className="secondary-action" href="/stores">
          {t('stores.back')}
        </a>
      </section>
    );
  }

  return (
    <div id="stores-accept" className="stores-accept">
      <h1>{t('stores.accept.title')}</h1>
      <section className="edge-card stores-header">
        <p>
          {t('stores.accept.challan')}: {arrival.challan_number_ext ?? '—'}
        </p>
        <p>
          {t('stores.accept.supplier')}:{' '}
          {arrival.supplier_unlisted
            ? arrival.supplier_name_unlisted
            : (arrival.supplier_ref_ext ?? po.supplier_ref_ext)}
        </p>
        <p>
          {t('stores.accept.po')}: {po.po_number_ext}
        </p>
        <p>
          {t('stores.accept.vehicle')}: {arrival.vehicle_reg_ext}
        </p>
        <p>
          {t('stores.accept.arrived')}: {new Date(arrival.entered_at).toLocaleString()}
        </p>
        <a href={`/api/v1/attachments/${encodeURIComponent(arrival.challan_photo_ref)}`}>
          {t('stores.accept.gatePhoto')}
        </a>
        <p className="stores-banner">
          {t('stores.accept.bayBanner').replace('{bay}', inspectionBayCode ?? '—')}
        </p>
      </section>

      {openLines.length === 0 ? (
        <p>{t('stores.accept.noOpenLines')}</p>
      ) : (
        <ul className="stores-lines">
          {openLines.map((line) => {
            const state = lines[line.line_no] ?? emptyLine();
            const draft = draftFor(line);
            const chip = lineChip(draft);
            const capped = goodQuantity(draft);
            const short = lineIsShort(draft);
            return (
              <li key={line.line_no} className="edge-card stores-line">
                <h2>
                  {line.sku} · {t('stores.accept.line')} {line.line_no}
                </h2>
                <p>
                  {t('stores.accept.ordered')}: {line.ordered_qty}
                </p>
                <div className="stores-condition-row">
                  <label>
                    {t('stores.accept.good')}
                    <input
                      type="number"
                      min="0"
                      step="0.001"
                      value={state.good}
                      onChange={(event) => {
                        const next = event.target.value;
                        update(line.line_no, {
                          good: next,
                          counted: sum(next, state.damaged, state.rejected),
                        });
                      }}
                    />
                  </label>
                  <label>
                    {t('stores.accept.damaged')}
                    <input
                      type="number"
                      min="0"
                      step="0.001"
                      value={state.damaged}
                      onChange={(event) => {
                        const next = event.target.value;
                        update(line.line_no, {
                          damaged: next,
                          counted: sum(state.good, next, state.rejected),
                        });
                      }}
                    />
                  </label>
                  <label>
                    {t('stores.accept.rejected')}
                    <input
                      type="number"
                      min="0"
                      step="0.001"
                      value={state.rejected}
                      onChange={(event) => {
                        const next = event.target.value;
                        update(line.line_no, {
                          rejected: next,
                          counted: sum(state.good, state.damaged, next),
                        });
                      }}
                    />
                  </label>
                </div>
                <p>
                  {t('stores.accept.counted')}: {state.counted || '0'}{' '}
                  <span className="stores-pill">{t(`stores.chip.${chip}`)}</span>
                </p>
                <button
                  className="secondary-action"
                  type="button"
                  onClick={() => {
                    const remaining = fromMicros(
                      toMicros(line.ordered_qty) -
                        toMicros(quantity(state.damaged)) -
                        toMicros(quantity(state.rejected)),
                    );
                    update(line.line_no, {
                      good: remaining,
                      counted: sum(remaining, state.damaged, state.rejected),
                    });
                  }}
                >
                  {t('stores.accept.countOrdered')}
                </button>
                {capped.excess > 0n ? (
                  <p className="stores-warning">
                    {t('stores.accept.excess').replace('{qty}', fromMicros(capped.excess))}
                  </p>
                ) : null}
                {toMicros(quantity(state.damaged)) > 0n ? (
                  <label>
                    {t('stores.accept.damagedReason')}
                    <select
                      value={state.damagedDetail}
                      onChange={(event) =>
                        update(line.line_no, { damagedDetail: event.target.value })
                      }
                    >
                      {DAMAGED_DETAILS.map((detail) => (
                        <option key={detail} value={detail}>
                          {t(`stores.reason.${detail}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {toMicros(quantity(state.rejected)) > 0n ? (
                  <label>
                    {t('stores.accept.rejectedReason')}
                    <select
                      value={state.rejectedDetail}
                      onChange={(event) =>
                        update(line.line_no, { rejectedDetail: event.target.value })
                      }
                    >
                      {REJECTED_DETAILS.map((detail) => (
                        <option key={detail} value={detail}>
                          {t(`stores.reason.${detail}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {short ? (
                  <fieldset>
                    <legend>{t('stores.accept.shortReason')}</legend>
                    {SHORT_DETAILS.map((detail) => (
                      <label key={detail}>
                        <input
                          type="radio"
                          name={`short-${line.line_no}`}
                          value={detail}
                          checked={state.shortDetail === detail}
                          onChange={() => update(line.line_no, { shortDetail: detail })}
                        />
                        {t(`stores.reason.${detail}`)}
                      </label>
                    ))}
                    {state.shortDetail === 'OTHER' ? (
                      <>
                        <label>
                          {t('stores.accept.otherNote')}
                          <input
                            type="text"
                            maxLength={200}
                            value={state.otherNote}
                            onChange={(event) =>
                              update(line.line_no, { otherNote: event.target.value })
                            }
                          />
                        </label>
                        <button
                          className="secondary-action"
                          type="button"
                          onClick={() => void pickPhoto('other', line.line_no)}
                        >
                          {state.otherPhotoRef
                            ? t('stores.accept.photoSaved')
                            : t('stores.accept.addPhoto')}
                        </button>
                      </>
                    ) : null}
                  </fieldset>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <section className="edge-card">
        <h2>{t('stores.accept.evidence')}</h2>
        <button
          className="secondary-action"
          type="button"
          onClick={() => void pickPhoto('material')}
        >
          {materialPhotoRef ? t('stores.accept.photoSaved') : t('stores.accept.materialPhoto')}
        </button>
        <label>
          <input
            type="checkbox"
            checked={inspectOnOpening !== ''}
            onChange={(event) => setInspectOnOpening(event.target.checked ? 'suspected' : '')}
          />
          {t('stores.accept.inspectToggle')}
        </label>
        {inspectOnOpening ? (
          <>
            <label>
              {t('stores.accept.inspectLevel')}
              <select
                value={inspectOnOpening}
                onChange={(event) =>
                  setInspectOnOpening(event.target.value as 'suspected' | 'observed')
                }
              >
                <option value="suspected">{t('stores.inspect.suspected')}</option>
                <option value="observed">{t('stores.inspect.observed')}</option>
              </select>
            </label>
            <label>
              {t('stores.accept.inspectNote')}
              <input
                type="text"
                maxLength={200}
                value={inspectNote}
                onChange={(event) => setInspectNote(event.target.value)}
              />
            </label>
            <p>{t('stores.accept.inspectHelper')}</p>
            <button
              className="secondary-action"
              type="button"
              onClick={() => void pickPhoto('inspect')}
            >
              {inspectPhotoRef ? t('stores.accept.photoSaved') : t('stores.accept.inspectPhoto')}
            </button>
          </>
        ) : null}
      </section>

      {message ? (
        <p role="alert" className="stores-warning">
          {message}
        </p>
      ) : null}
      {!online ? <p className="stores-warning">{t('stores.accept.openedOnlineOnly')}</p> : null}
      <div className="stores-footer">
        {missing.length > 0 ? <p>{missing.map((key) => t(key as MessageKey)).join(' ')}</p> : null}
        <button
          className="primary-action"
          type="button"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {submitting ? t('stores.accept.submitting') : t('stores.accept.complete')}
        </button>
      </div>
    </div>
  );
}
