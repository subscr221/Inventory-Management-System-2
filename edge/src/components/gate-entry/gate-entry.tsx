'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { t, type MessageKey } from '../../i18n/locale';
import { ScanField } from '../scan-field';
import { authorizedFetch } from '../../session/api-fetch';
import { ACCEPTED_PHOTO_TYPES } from '../../sync/attachment-uploader';
import {
  computeWeighment,
  createGateLookup,
  fetchPoLineBand,
  gateChallanBinding,
  GATE_STEPS,
  isGateReady,
  isGateStepReady,
  isGateSupplierReady,
  isToleranceBreach,
  missingGateParts,
  photoProblem,
  validateWeighForm,
  type GateChallanMatch,
  type GateFormSnapshot,
  type GateLookupResult,
  type GateMissingPart,
  type GateStep,
  type PoLineBand,
  type WeighFormProblem,
} from '../../capture/gate';

/**
 * Story 3.13 (Tasks 3 and 5): the gate entry stepper (Challan, Photo, Vehicle, Supplier, Submit) and
 * the Trucks on site / weigh-in / weigh-out tab. Every string resolves from en.json. The component
 * looks up challans online; the edge client injects the submit callbacks that write the outbox.
 */

export interface GateSubmitInput {
  challanNumberExt: string | null;
  poRefExt: string;
  vehicleRegExt: string;
  driverName: string | null;
  /** The matched PO vendor code, or null when the supplier is unlisted. */
  supplierRefExt: string | null;
  supplierUnlisted: boolean;
  supplierNameUnlisted: string | null;
  photo: Blob;
}

export interface GateSubmitResult {
  eventId: string;
  correlationId: string;
}

export interface WeighmentSubmitInput {
  correlationId: string;
  poRefExt: string;
  lineNo: number;
  grossKg: string;
  tareKg: string;
  captureMethod: 'AUTO' | 'MANUAL';
}

export interface WeighmentSubmitResult {
  eventId: string;
}

export interface OpenTruck {
  correlationId: string;
  vehicleRegExt: string;
  poRefExt: string;
  lineNo: number;
  status: string;
}

export interface StampState {
  deviceKey: string;
  status: 'compliant' | 'overdue';
  nextDueDate: string;
}

export type FetchPoLineBand = (poRef: string, lineNo: number) => Promise<PoLineBand | null>;

export interface GateEntryProps {
  /** Null or empty when bootstrap carries no site: capture is disabled rather than guessed. */
  siteCodeExt?: string | null;
  gateId?: string | null;
  openTrucks?: OpenTruck[];
  stamp?: StampState | null;
  /** True when the stamp status could not be read; weighing is allowed and the server confirms. */
  stampUnverified?: boolean;
  onSubmitGate?: (input: GateSubmitInput) => Promise<GateSubmitResult>;
  onSubmitWeighment?: (
    input: WeighmentSubmitInput,
  ) => Promise<WeighmentSubmitResult | { errorCode: string }>;
  /** Test seam for the PO line tolerance band; must be referentially stable. */
  fetchBand?: FetchPoLineBand;
}

const MISSING_LABEL: Record<GateMissingPart, MessageKey> = {
  challan: 'gate.missing.challan',
  photo: 'gate.missing.photo',
  vehicle: 'gate.missing.vehicle',
  supplier: 'gate.missing.supplier',
};

const STEP_LABEL: Record<GateStep, MessageKey> = {
  challan: 'gate.stepChallan',
  photo: 'gate.stepPhoto',
  vehicle: 'gate.stepVehicle',
  supplier: 'gate.stepSupplier',
};

const WEIGH_PROBLEM_LABEL: Record<WeighFormProblem, MessageKey> = {
  token: 'gate.missing.token',
  po: 'gate.weighPoRequired',
  line: 'gate.weighLineInvalid',
  gross: 'gate.weighGrossRequired',
  tare: 'gate.weighTareRequired',
  'gross-format': 'gate.weighInvalid',
  'tare-format': 'gate.weighInvalid',
  'net-negative': 'gate.weighNetNegative',
};

const WEIGH_ERROR_LABEL: Record<string, MessageKey> = {
  WEIGHBRIDGE_TARE_REQUIRED: 'gate.weighTareRequired',
  WEIGHBRIDGE_GROSS_REQUIRED: 'gate.weighGrossRequired',
  WEIGHBRIDGE_NET_NEGATIVE: 'gate.weighNetNegative',
};

const TABS = ['entry', 'trucks'] as const;
type TabName = (typeof TABS)[number];

const defaultFetchBand: FetchPoLineBand = (poRef, lineNo) =>
  fetchPoLineBand(authorizedFetch, poRef, lineNo);

export function GateEntry({
  siteCodeExt,
  gateId,
  openTrucks = [],
  stamp,
  stampUnverified = false,
  onSubmitGate,
  onSubmitWeighment,
  fetchBand = defaultFetchBand,
}: GateEntryProps) {
  const noSite = !siteCodeExt || !siteCodeExt.trim();
  const noGate = !gateId || !gateId.trim();
  const [tab, setTab] = useState<TabName>('entry');
  const [step, setStep] = useState(0);
  const [coarsePointer, setCoarsePointer] = useState(false);
  const [challanNumber, setChallanNumber] = useState('');
  const [challanResolved, setChallanResolved] = useState(false);
  const [lookupResult, setLookupResult] = useState<GateLookupResult | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const lookupRef = useRef<ReturnType<typeof createGateLookup> | null>(null);
  if (!lookupRef.current) lookupRef.current = createGateLookup(authorizedFetch);
  const [poRef, setPoRef] = useState('UNKNOWN');
  const [photo, setPhoto] = useState<File | null>(null);
  const [vehicleReg, setVehicleReg] = useState('');
  const [driverName, setDriverName] = useState('');
  const [supplierMode, setSupplierMode] = useState<'matched' | 'unlisted'>('matched');
  const [supplierRef, setSupplierRef] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ correlationId: string } | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const stepHeading = useRef<HTMLLegendElement>(null);
  const doneHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const pointer = window.matchMedia('(pointer: coarse)');
    const update = () => setCoarsePointer(pointer.matches);
    update();
    if (typeof pointer.addEventListener !== 'function') return;
    pointer.addEventListener('change', update);
    return () => pointer.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (done) doneHeading.current?.focus();
    else if (step > 0) stepHeading.current?.focus();
  }, [step, done]);

  useEffect(() => () => lookupRef.current?.invalidate(), []);

  /** Drops everything a previous challan resolution set, so no stale supplier or PO survives an edit. */
  function clearResolution() {
    setChallanResolved(false);
    setLookupResult(null);
    setLookingUp(false);
    setPoRef('UNKNOWN');
    setSupplierMode('matched');
    setSupplierRef('');
    setSupplierName('');
    setNotice('');
  }

  function changeChallan(value: string) {
    lookupRef.current?.invalidate();
    setChallanNumber(value);
    clearResolution();
  }

  async function scanChallan(value: string) {
    setLookupResult(null);
    setNotice('');
    setLookingUp(true);
    try {
      const result = await lookupRef.current!.resolve(value);
      // null means a newer edit or lookup superseded this one; that path owns the state now.
      if (!result || !mounted.current) return;
      setLookupResult(result);
    } catch {
      if (!mounted.current) return;
      setLookupResult({ kind: 'unavailable' });
    }
    if (mounted.current) setLookingUp(false);
  }

  function resolveChallan(resolution: GateChallanMatch | 'typed' | 'rejected') {
    lookupRef.current?.invalidate();
    const binding = gateChallanBinding(resolution);
    setPoRef(binding.poRefExt);
    setSupplierRef(binding.supplierRefExt);
    setSupplierMode(binding.supplierRefExt ? 'matched' : 'unlisted');
    setChallanResolved(true);
    setLookingUp(false);
    setLookupResult(null);
    setNotice(
      t(
        typeof resolution === 'string'
          ? resolution === 'typed'
            ? 'gate.typedChallan'
            : 'gate.rejectedChallan'
          : 'gate.acceptedChallan',
      ),
    );
  }

  const snapshot: GateFormSnapshot = {
    challanResolved,
    challanNumber,
    hasPhoto: photo !== null,
    vehicleReg,
    supplierResolved: isGateSupplierReady(supplierMode, supplierRef, supplierName),
    supplierNameUnlisted: supplierName,
  };
  const missing = missingGateParts(snapshot);
  const ready = isGateReady(snapshot);

  async function submitGate() {
    if (noSite || noGate) {
      setNotice(t(noSite ? 'gate.noSite' : 'gate.noGate'));
      return;
    }
    if (
      inFlight.current ||
      done ||
      step !== GATE_STEPS.length - 1 ||
      !ready ||
      !photo ||
      !onSubmitGate
    ) {
      if (!ready) {
        setNotice(
          t('gate.stillNeeded').replace(
            '{parts}',
            missing.map((part) => t(MISSING_LABEL[part])).join(', '),
          ),
        );
      }
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setNotice('');
    try {
      const result = await onSubmitGate({
        challanNumberExt: challanNumber.trim() || null,
        poRefExt: poRef.trim() || 'UNKNOWN',
        vehicleRegExt: vehicleReg.trim().toUpperCase(),
        driverName: driverName.trim() || null,
        supplierRefExt: supplierMode === 'matched' ? supplierRef.trim() : null,
        supplierUnlisted: supplierMode === 'unlisted',
        supplierNameUnlisted: supplierMode === 'unlisted' ? supplierName.trim() || null : null,
        photo,
      });
      if (mounted.current) setDone({ correlationId: result.correlationId });
    } catch {
      inFlight.current = false;
      if (mounted.current) setNotice(t('gate.captureFailed'));
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  function reset() {
    inFlight.current = false;
    lookupRef.current?.invalidate();
    setChallanNumber('');
    clearResolution();
    setStep(0);
    setPhoto(null);
    setVehicleReg('');
    setDriverName('');
    setDone(null);
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = TABS.indexOf(tab);
    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    const target = TABS[next]!;
    setTab(target);
    document.getElementById(`gate-tab-${target}`)?.focus();
  }

  if (done) {
    return (
      <div className="base-screen" id="gate-entry">
        <section className="edge-card" aria-labelledby="gate-done-heading">
          <h2 id="gate-done-heading" ref={doneHeading} tabIndex={-1}>
            {t('gate.doneTitle')}
          </h2>
          <p>{t('gate.doneBody')}</p>
          <p role="status">{t('sync.captured')}</p>
          <p className="base-hint">{t('gate.doneToken').replace('{token}', done.correlationId)}</p>
          <div className="edge-actions">
            <button className="primary-action" type="button" onClick={reset}>
              {t('gate.enterAnother')}
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="base-screen" id="gate-entry">
      <h2 className="base-screen-title">{t('gate.title')}</h2>
      <p className="base-hint">
        {t('gate.siteLine')
          .replace('{site}', noSite ? '-' : siteCodeExt!.trim())
          .replace('{gate}', gateId?.trim() || '-')}
      </p>
      {noSite || noGate ? (
        <p className="base-notice" role="alert">
          {t(noSite ? 'gate.noSite' : 'gate.noGate')}
        </p>
      ) : null}
      <div
        className="gate-tabs"
        role="tablist"
        aria-label={t('gate.tabsLabel')}
        onKeyDown={onTabKeyDown}
      >
        <button
          type="button"
          role="tab"
          id="gate-tab-entry"
          aria-selected={tab === 'entry'}
          aria-controls="gate-panel-entry"
          tabIndex={tab === 'entry' ? 0 : -1}
          className={tab === 'entry' ? 'primary-action' : 'secondary-action'}
          onClick={() => setTab('entry')}
        >
          {t('gate.tabEntry')}
        </button>
        <button
          type="button"
          role="tab"
          id="gate-tab-trucks"
          aria-selected={tab === 'trucks'}
          aria-controls="gate-panel-trucks"
          tabIndex={tab === 'trucks' ? 0 : -1}
          className={tab === 'trucks' ? 'primary-action' : 'secondary-action'}
          onClick={() => setTab('trucks')}
        >
          {t('gate.tabTrucks')}
        </button>
      </div>

      {tab === 'entry' ? (
        <div
          className="gate-stepper"
          role="tabpanel"
          id="gate-panel-entry"
          aria-labelledby="gate-tab-entry"
        >
          <ol className="gate-step-list" aria-label={t('gate.stepsLabel')}>
            {GATE_STEPS.map((part, index) => (
              <li key={part} aria-current={index === step ? 'step' : undefined}>
                <span className="gate-step-number" aria-hidden="true">
                  {index + 1}
                </span>
                {t(STEP_LABEL[part])}
              </li>
            ))}
          </ol>
          <form
            className="gate-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (step < GATE_STEPS.length - 1) {
                if (isGateStepReady(GATE_STEPS[step]!, snapshot)) setStep(step + 1);
              } else {
                void submitGate();
              }
            }}
          >
            {step === 0 ? (
              <fieldset className="edge-card gate-step">
                <legend ref={stepHeading} tabIndex={-1}>
                  {t('gate.stepChallan')}
                </legend>
                <ScanField
                  id="gate-challan"
                  label={t('gate.challanLabel')}
                  value={challanNumber}
                  placeholder={t('gate.challanPlaceholder')}
                  disabled={submitting}
                  onChange={changeChallan}
                  onScan={(value) => void scanChallan(value)}
                />
                <p className="base-hint" role="status" aria-live="polite">
                  {lookingUp
                    ? t('gate.lookupLoading')
                    : lookupResult?.kind === 'not-found'
                      ? t('gate.lookupNotFound')
                      : lookupResult?.kind === 'unavailable'
                        ? t('gate.lookupUnavailable')
                        : lookupResult?.kind === 'match'
                          ? t('gate.matchHint').replace('{value}', lookupResult.poRefExt)
                          : notice}
                </p>
                {lookupResult?.kind === 'match' ? (
                  <div
                    className="edge-card gate-match"
                    role="group"
                    aria-label={t('gate.matchCard')}
                  >
                    <p>
                      {t('gate.poLabel')}: {lookupResult.poRefExt}
                    </p>
                    <p>
                      {t('gate.matchedSupplierCode').replace(
                        '{supplier}',
                        lookupResult.supplierRefExt || t('gate.noMatchedSupplier'),
                      )}
                    </p>
                    <div className="edge-actions">
                      <button
                        type="button"
                        className="primary-action"
                        disabled={submitting}
                        onClick={() => resolveChallan(lookupResult)}
                      >
                        {t('gate.accept')}
                      </button>
                      <button
                        type="button"
                        className="secondary-action"
                        disabled={submitting}
                        onClick={() => resolveChallan('rejected')}
                      >
                        {t('gate.notThis')}
                      </button>
                    </div>
                  </div>
                ) : null}
                {!challanResolved && challanNumber.trim() ? (
                  <div className="edge-actions">
                    <button
                      type="button"
                      className="secondary-action"
                      disabled={submitting || lookingUp}
                      onClick={() => void scanChallan(challanNumber)}
                    >
                      {t('gate.findMatch')}
                    </button>
                    <button
                      type="button"
                      className="secondary-action"
                      disabled={submitting}
                      onClick={() => resolveChallan('typed')}
                    >
                      {t('gate.useTypedChallan')}
                    </button>
                  </div>
                ) : null}
              </fieldset>
            ) : null}
            {step === 1 ? (
              <fieldset className="edge-card gate-step">
                <legend ref={stepHeading} tabIndex={-1}>
                  {t('gate.stepPhoto')}
                </legend>
                <label htmlFor="gate-photo">
                  {photo ? t('gate.retakePhoto') : t('gate.takePhoto')}
                </label>
                <input
                  id="gate-photo"
                  type="file"
                  accept={ACCEPTED_PHOTO_TYPES.join(',')}
                  capture={coarsePointer ? 'environment' : undefined}
                  required
                  disabled={submitting}
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    const problem = file ? photoProblem(file, ACCEPTED_PHOTO_TYPES) : null;
                    if (problem) {
                      setPhoto(null);
                      event.target.value = '';
                      setNotice(
                        t(
                          problem === 'empty'
                            ? 'gate.photoEmpty'
                            : problem === 'size'
                              ? 'gate.photoTooLarge'
                              : 'gate.photoUnsupported',
                        ),
                      );
                      return;
                    }
                    setPhoto(file);
                    setNotice('');
                  }}
                />
                <p className="base-hint">
                  {photo ? t('gate.photoSaved') : t('gate.photoRequired')}
                </p>
              </fieldset>
            ) : null}
            {step === 2 ? (
              <fieldset className="edge-card gate-step">
                <legend ref={stepHeading} tabIndex={-1}>
                  {t('gate.stepVehicle')}
                </legend>
                <label htmlFor="gate-vehicle">{t('gate.vehicleLabel')}</label>
                <input
                  id="gate-vehicle"
                  name="vehicle"
                  autoComplete="off"
                  autoCapitalize="characters"
                  required
                  value={vehicleReg}
                  disabled={submitting}
                  onChange={(event) => setVehicleReg(event.target.value.toUpperCase())}
                />
                <label htmlFor="gate-driver">{t('gate.driverLabel')}</label>
                <input
                  id="gate-driver"
                  name="driver"
                  autoComplete="off"
                  value={driverName}
                  disabled={submitting}
                  onChange={(event) => setDriverName(event.target.value)}
                />
              </fieldset>
            ) : null}
            {step === 3 ? (
              <fieldset className="edge-card gate-step">
                <legend ref={stepHeading} tabIndex={-1}>
                  {t('gate.stepSupplier')}
                </legend>
                <div className="gate-choice">
                  <label htmlFor="gate-supplier-matched">
                    <input
                      id="gate-supplier-matched"
                      type="radio"
                      name="supplier_mode"
                      checked={supplierMode === 'matched'}
                      disabled={submitting || !supplierRef.trim()}
                      onChange={() => setSupplierMode('matched')}
                    />
                    {t('gate.supplierMatched')}
                  </label>
                  <label htmlFor="gate-supplier-unlisted">
                    <input
                      id="gate-supplier-unlisted"
                      type="radio"
                      name="supplier_mode"
                      checked={supplierMode === 'unlisted'}
                      disabled={submitting}
                      onChange={() => setSupplierMode('unlisted')}
                    />
                    {t('gate.supplierUnlisted')}
                  </label>
                </div>
                {supplierMode === 'matched' ? (
                  <p>
                    {t('gate.matchedSupplierCode').replace(
                      '{supplier}',
                      supplierRef || t('gate.noMatchedSupplier'),
                    )}
                  </p>
                ) : (
                  <>
                    <label htmlFor="gate-supplier-name">{t('gate.supplierNameLabel')}</label>
                    <input
                      id="gate-supplier-name"
                      name="supplier_name"
                      autoComplete="off"
                      value={supplierName}
                      required
                      disabled={submitting}
                      onChange={(event) => setSupplierName(event.target.value)}
                    />
                    <p className="base-hint">{t('gate.unlistedNote')}</p>
                  </>
                )}
              </fieldset>
            ) : null}
            <div className="edge-card gate-footer">
              {step > 0 ? (
                <button
                  type="button"
                  className="secondary-action"
                  disabled={submitting}
                  onClick={() => {
                    setNotice('');
                    setStep(step - 1);
                  }}
                >
                  {t('gate.back')}
                </button>
              ) : null}
              {step < GATE_STEPS.length - 1 ? (
                <button
                  type="submit"
                  className="primary-action"
                  disabled={submitting || !isGateStepReady(GATE_STEPS[step]!, snapshot)}
                >
                  {t('gate.next')}
                </button>
              ) : (
                <>
                  <p id="gate-readiness" role="status" aria-live="polite">
                    {ready
                      ? t('gate.ready')
                      : t('gate.stillNeeded').replace(
                          '{parts}',
                          missing.map((part) => t(MISSING_LABEL[part])).join(', '),
                        )}
                  </p>
                  <button
                    className="primary-action"
                    type="submit"
                    disabled={submitting || !ready || noSite || noGate}
                    aria-busy={submitting}
                    aria-describedby="gate-readiness"
                  >
                    {submitting ? t('gate.submitting') : t('gate.submit')}
                  </button>
                </>
              )}
              {notice && step !== 0 ? (
                <p className="base-notice" role="status" aria-live="polite">
                  {notice}
                </p>
              ) : null}
            </div>
          </form>
        </div>
      ) : (
        <div role="tabpanel" id="gate-panel-trucks" aria-labelledby="gate-tab-trucks">
          <WeighbridgeTab
            openTrucks={openTrucks}
            stamp={stamp ?? null}
            stampUnverified={stampUnverified}
            disabled={submitting || noSite}
            fetchBand={fetchBand}
            onSubmitWeighment={onSubmitWeighment}
          />
        </div>
      )}
    </div>
  );
}

const BAND_DEBOUNCE_MS = 400;

function WeighbridgeTab({
  openTrucks,
  stamp,
  stampUnverified,
  disabled,
  fetchBand,
  onSubmitWeighment,
}: {
  openTrucks: OpenTruck[];
  stamp: StampState | null;
  stampUnverified: boolean;
  disabled: boolean;
  fetchBand: FetchPoLineBand;
  onSubmitWeighment?: GateEntryProps['onSubmitWeighment'];
}) {
  const [correlationId, setCorrelationId] = useState(openTrucks[0]?.correlationId ?? '');
  const [poRef, setPoRef] = useState(openTrucks[0]?.poRefExt ?? '');
  const [lineNo, setLineNo] = useState(String(openTrucks[0]?.lineNo ?? 1));
  const [gross, setGross] = useState('');
  const [tare, setTare] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [band, setBand] = useState<PoLineBand | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const touched = useRef(false);
  const fetchBandRef = useRef(fetchBand);
  fetchBandRef.current = fetchBand;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The truck list loads after mount; preselect the first truck unless the operator already typed.
  const firstTruck = openTrucks[0];
  useEffect(() => {
    if (touched.current || !firstTruck) return;
    setCorrelationId(firstTruck.correlationId);
    setPoRef(firstTruck.poRefExt);
    setLineNo(String(firstTruck.lineNo));
  }, [firstTruck]);

  // Optional tolerance band for the banner (AC 8); every failure just leaves the banner off.
  useEffect(() => {
    const po = poRef.trim();
    const line = lineNo.trim();
    if (!po || !/^\d{1,10}$/.test(line) || Number(line) < 1 || Number(line) > 2147483647) {
      setBand(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchBandRef
        .current(po, Number(line))
        .then((next) => {
          if (!cancelled) setBand(next);
        })
        .catch(() => {
          if (!cancelled) setBand(null);
        });
    }, BAND_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [poRef, lineNo]);

  const outOfStamp = stamp?.status === 'overdue';
  const weighment = computeWeighment(gross, tare);
  const breach =
    band !== null && weighment.ok
      ? isToleranceBreach({ netKg: weighment.weighment.netKg, ...band }) === true
      : false;

  function edit(setter: (value: string) => void, value: string) {
    touched.current = true;
    setter(value);
  }

  async function submit() {
    if (!onSubmitWeighment || outOfStamp || inFlight.current) return;
    const form = validateWeighForm({ correlationId, poRef, lineNo, gross, tare });
    if (!form.ok) {
      setNotice(t(WEIGH_PROBLEM_LABEL[form.problem]));
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setNotice('');
    try {
      const result = await onSubmitWeighment({
        correlationId: correlationId.trim(),
        poRefExt: poRef.trim(),
        lineNo: form.lineNo,
        grossKg: form.weighment.grossKg,
        tareKg: form.weighment.tareKg,
        captureMethod: 'MANUAL',
      });
      if (!mounted.current) return;
      if ('errorCode' in result) {
        setNotice(t(WEIGH_ERROR_LABEL[result.errorCode] ?? 'gate.weighFailed'));
        return;
      }
      setDone(true);
    } catch {
      if (mounted.current) setNotice(t('gate.weighFailed'));
    } finally {
      inFlight.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }

  function weighAnother() {
    touched.current = false;
    setCorrelationId('');
    setPoRef('');
    setLineNo('1');
    setGross('');
    setTare('');
    setNotice('');
    setBand(null);
    setDone(false);
  }

  const busy = disabled || submitting;

  return (
    <div className="base-screen" id="gate-weighbridge">
      <h3>{t('gate.trucksTitle')}</h3>
      {outOfStamp ? (
        <p className="base-notice" role="alert">
          {t('gate.outOfStamp').replace('{device}', stamp?.deviceKey ?? '')}
        </p>
      ) : stampUnverified ? (
        <p className="base-hint" role="status">
          {t('gate.stampNotVerified')}
        </p>
      ) : null}
      {openTrucks.length === 0 ? (
        <p className="base-hint">{t('gate.noTrucks')}</p>
      ) : (
        <ul className="gate-truck-list">
          {openTrucks.map((truck) => (
            <li key={truck.correlationId}>
              <button
                type="button"
                className="secondary-action"
                onClick={() => {
                  touched.current = true;
                  setCorrelationId(truck.correlationId);
                  setPoRef(truck.poRefExt);
                  setLineNo(String(truck.lineNo));
                }}
              >
                {truck.vehicleRegExt} - {truck.status}
              </button>
            </li>
          ))}
        </ul>
      )}
      {done ? (
        <>
          <p className="base-notice" role="status">
            {t('gate.weighDone')}
          </p>
          <div className="edge-actions">
            <button type="button" className="primary-action" onClick={weighAnother}>
              {t('gate.weighAnother')}
            </button>
          </div>
        </>
      ) : (
        <form
          className="gate-weigh-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="weigh-token">{t('gate.bindingTokenLabel')}</label>
          <input
            id="weigh-token"
            name="binding_token"
            autoComplete="off"
            value={correlationId}
            disabled={busy}
            onChange={(event) => edit(setCorrelationId, event.target.value)}
          />
          <label htmlFor="weigh-po">{t('gate.poLabel')}</label>
          <input
            id="weigh-po"
            name="po_ref"
            autoComplete="off"
            value={poRef}
            disabled={busy}
            onChange={(event) => edit(setPoRef, event.target.value)}
          />
          <label htmlFor="weigh-line">{t('gate.lineLabel')}</label>
          <input
            id="weigh-line"
            name="line_no"
            inputMode="numeric"
            value={lineNo}
            disabled={busy}
            onChange={(event) => edit(setLineNo, event.target.value)}
          />
          <label htmlFor="weigh-gross">{t('gate.grossLabel')}</label>
          <input
            id="weigh-gross"
            name="gross_kg"
            inputMode="decimal"
            value={gross}
            disabled={busy}
            onChange={(event) => edit(setGross, event.target.value)}
          />
          <label htmlFor="weigh-tare">{t('gate.tareLabel')}</label>
          <input
            id="weigh-tare"
            name="tare_kg"
            inputMode="decimal"
            value={tare}
            disabled={busy}
            onChange={(event) => edit(setTare, event.target.value)}
          />
          <p className="base-hint" role="status" aria-live="polite">
            {weighment.ok ? t('gate.netKg').replace('{net}', weighment.weighment.netKg) : ''}
          </p>
          {breach ? (
            <p className="base-notice" role="alert">
              {t('gate.toleranceBreach')}
            </p>
          ) : null}
          <button
            type="button"
            className="secondary-action"
            disabled
            aria-describedby="weigh-indicator-reason"
          >
            {t('gate.readIndicator')}
          </button>
          <p id="weigh-indicator-reason" className="base-hint">
            {t('gate.noIndicator')}
          </p>
          <button
            className="primary-action"
            type="submit"
            disabled={busy || outOfStamp || !weighment.ok}
            aria-busy={submitting}
          >
            {t('gate.weighSubmit')}
          </button>
          {notice ? (
            <p className="base-notice" role="status" aria-live="polite">
              {notice}
            </p>
          ) : null}
        </form>
      )}
    </div>
  );
}
