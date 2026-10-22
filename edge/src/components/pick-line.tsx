'use client';

import { useEffect, useRef, useState } from 'react';
import { t, errorMessage, type MessageKey } from '../i18n/locale';
import { authorizedFetch } from '../session/api-fetch';
import { ScanField } from './scan-field';
import {
  directedBin,
  directedLot,
  evaluateBin,
  evaluateLot,
  nextLine,
  PICK_STEP_KEYS,
  PICK_STEPS,
  quantityReady,
  taskComplete,
  type MessageResult,
  type PickLineConfirmInput,
  type PickLineRow,
  type PickStep,
  type PickTaskDetail,
} from './pick-line-model';

type PickView = 'loading' | 'ready' | 'read-only' | 'submitting' | 'failed';

/**
 * Story 3.16 (AC 4, 5, 6): the pick-line execution screen. Scans the bin, then the directed lot
 * (with the held-lot guard), then confirms the directed quantity. Confirmation writes one
 * `pick_line.confirmed` event to the edge outbox; the server finalizes the task inline when the
 * last line confirms. The picker never sends `pick_task.completed`.
 */

export interface PickLineProps {
  taskId: string;
  online: boolean;
  ready: boolean;
  checkHeldLot?: (lotNumber: string) => Promise<string | null>;
  onConfirm?: (input: PickLineConfirmInput) => Promise<string>;
  settlementOf?: (eventId: string) => Promise<'pending' | 'synced' | 'refused'>;
  refusalCodeOf?: (eventId: string) => Promise<string | null>;
  onComplete?: () => void;
}

export function PickLine({
  taskId,
  online,
  ready,
  checkHeldLot,
  onConfirm,
  settlementOf,
  refusalCodeOf,
  onComplete,
}: PickLineProps) {
  const [view, setView] = useState<PickView>('loading');
  const [task, setTask] = useState<PickTaskDetail | null>(null);
  const [lines, setLines] = useState<PickLineRow[]>([]);
  const [step, setStep] = useState<PickStep>('bin');
  const [scanned, setScanned] = useState('');
  const [message, setMessage] = useState<MessageResult | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [refusedCode, setRefusedCode] = useState('');
  const idempotencyKey = useRef('');
  const lastConfirmSignature = useRef('');
  // Lines the device has confirmed this session (offline or before the server ack). The effective
  // line set merges these so the completion decision reflects device confirmation even when a
  // re-fetch returns the line pending (3.16: offline confirm still advances the pick list).
  const confirmedRef = useRef(new Set<string>());

  const effectiveLines = lines.map((line) =>
    confirmedRef.current.has(line.pick_line_id) && line.status === 'pending'
      ? { ...line, status: 'confirmed' as const }
      : line,
  );
  const current = nextLine(effectiveLines);
  const activeCount = effectiveLines.filter((line) => line.status !== 'cancelled').length;
  const confirmedCount = effectiveLines.filter(
    (line) => line.status === 'confirmed' || line.status === 'substituted',
  ).length;

  useEffect(() => {
    if (!online) return;
    if (!ready) return;
    if (!taskId) {
      setView('failed');
      setMessage(null);
      setAnnouncement(t('floor.missingTask'));
      return;
    }
    // Reset all screen state when the task changes (3.15 rule).
    setTask(null);
    setLines([]);
    setStep('bin');
    setScanned('');
    setMessage(null);
    setRefusedCode('');
    idempotencyKey.current = '';
    lastConfirmSignature.current = '';
    confirmedRef.current = new Set<string>();
    setAnnouncement('');
    setView('loading');
    let cancelled = false;
    async function load() {
      try {
        const res = await authorizedFetch(
          `/api/v1/pick-tasks/${encodeURIComponent(taskId)}`,
        );
        if (cancelled) return;
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          const code = typeof body['error_code'] === 'string' ? body['error_code'] : '';
          if (code === 'FUNCTION_ACCESS_DENIED' || code === 'LOCATION_ACCESS_DENIED') {
            setView('read-only');
            setAnnouncement(errorMessage(code || 'FUNCTION_ACCESS_DENIED'));
          } else {
            setView('failed');
            setAnnouncement(errorMessage(code || 'PICK_TASK_NOT_FOUND'));
          }
          return;
        }
        const body = (await res.json()) as {
          task?: PickTaskDetail;
          lines?: PickLineRow[];
        };
        if (!body.task) {
          setView('failed');
          setAnnouncement(t('floor.failed'));
          return;
        }
        setTask(body.task);
        setLines(body.lines ?? []);
        setStep('bin');
        setView('ready');
      } catch {
        if (!cancelled) {
          setView('failed');
          setAnnouncement(t('floor.needsConnection'));
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [online, ready, taskId]);

  // A new line (or a re-fetch after a confirm) resets the current step to bin and the scan value.
  useEffect(() => {
    setStep('bin');
    setScanned('');
    setMessage(null);
  }, [current?.pick_line_id]);

  async function onScanBin(code: string): Promise<void> {
    if (!current) return;
    const result = evaluateBin(code, current);
    if (!result.ok) {
      setMessage(result);
      setAnnouncement(
        t('floor.announce.wrongBin').replace('{bin}', result.messageParams?.bin ?? ''),
      );
      return;
    }
    setMessage(null);
    setStep('lot');
    setScanned('');
    setAnnouncement(
      t('floor.announce.binConfirmed').replace('{code}', code.trim()),
    );
  }

  async function onScanLot(code: string): Promise<void> {
    if (!current) return;
    let held: string | null = null;
    if (checkHeldLot) {
      try {
        held = await checkHeldLot(code);
      } catch {
        held = null; // fail soft: the authoritative LOT_ON_HOLD refusal still catches it
      }
    }
    const result = evaluateLot(code, current, held);
    if (!result.ok) {
      setMessage(result);
    if (result.held) {
      setAnnouncement(
        result.messageKey === 'floor.onHoldDirected'
          ? t('floor.announce.onHoldDirected').replace('{lot}', result.messageParams?.lot ?? '')
          : t('floor.announce.onHold')
              .replace('{lot}', result.messageParams?.lot ?? '')
              .replace('{directed}', result.messageParams?.directed ?? ''),
      );
    } else {
        setAnnouncement(
          t('floor.announce.wrongLot')
            .replace('{code}', result.messageParams?.code ?? '')
            .replace('{lot}', result.messageParams?.lot ?? ''),
        );
      }
      return;
    }
    setMessage(null);
    setStep('qty');
    setAnnouncement(
      t('floor.announce.lotConfirmed')
        .replace('{code}', code.trim())
        .replace('{qty}', current.directed_quantity),
    );
  }

  async function confirm(): Promise<void> {
    if (!current || !onConfirm) return;
    // Idempotency: reuse the key across retries of the same line/quantity; mint fresh when it
    // changes (3.15 rule).
    const signature = `${current.pick_line_id}|${current.directed_quantity}`;
    if (lastConfirmSignature.current !== signature) {
      lastConfirmSignature.current = signature;
      idempotencyKey.current = crypto.randomUUID();
    }
    setView('submitting');
    setRefusedCode('');
    try {
      const eventId = await onConfirm({
        pickTaskId: current.pick_task_id,
        pickLineId: current.pick_line_id,
        confirmedLotId: current.directed_lot_id,
        confirmedQuantity: current.directed_quantity,
        directedLotNumber: current.directed_lot_number,
        idempotencyKey: idempotencyKey.current,
      });
      await refreshAfterConfirm(eventId);
    } catch (error) {
      setView('ready');
      if (error instanceof Error && error.message === 'LOT_ON_HOLD') {
        const lot = current.directed_lot_number ?? '';
        setAnnouncement(
          t('floor.announce.onHold').replace('{lot}', lot).replace('{directed}', lot),
        );
      } else {
        setAnnouncement(t('floor.needsConnection'));
      }
    }
  }

  async function refreshAfterConfirm(eventId: string): Promise<void> {
    // Surface the sync outcome; the server-finalized lines then drive the next step or completion.
    let settlement: 'pending' | 'synced' | 'refused' = 'pending';
    if (settlementOf) {
      try {
        settlement = await settlementOf(eventId);
      } catch {
        settlement = 'pending';
      }
    }
    if (settlement === 'refused') {
      // The event was refused: read the server code, drop the optimistic confirmation and rotate
      // the idempotency key so a retry re-evaluates instead of replaying the refusal.
      let code: string | null = null;
      if (refusalCodeOf) {
        try {
          code = await refusalCodeOf(eventId);
        } catch {
          code = null;
        }
      }
      setRefusedCode(code ?? '');
      if (current) confirmedRef.current.delete(current.pick_line_id);
      lastConfirmSignature.current = '';
      idempotencyKey.current = '';
      setView('ready');
      setAnnouncement(
        t('floor.refused').replace('{error}', code ? errorMessage(code) : t('floor.failed')),
      );
      await reload();
      return;
    }
    if (current) confirmedRef.current.add(current.pick_line_id);
    setAnnouncement(
      settlement === 'synced' ? t('floor.result.lineSynced') : t('floor.result.lineCaptured'),
    );
    const reloaded = await reload();
    if (reloaded) {
      const effective = reloaded.lines.map((line) =>
        confirmedRef.current.has(line.pick_line_id) && line.status === 'pending'
          ? { ...line, status: 'confirmed' as const }
          : line,
      );
      if (effective.every((line) => line.status !== 'pending')) onComplete?.();
    }
  }

  async function reload(): Promise<{ task: PickTaskDetail; lines: PickLineRow[] } | null> {
    try {
      const res = await authorizedFetch(`/api/v1/pick-tasks/${encodeURIComponent(taskId)}`);
      if (!res.ok) return null;
      const body = (await res.json()) as {
        task?: PickTaskDetail;
        lines?: PickLineRow[];
      };
      if (!body.task) return null;
      setTask(body.task);
      setLines(body.lines ?? []);
      setStep('bin');
      setScanned('');
      setMessage(null);
      setView('ready');
      return { task: body.task, lines: body.lines ?? [] };
    } catch {
      // Keep the current lines; the outbox watch will reconcile on the next sync pass.
      return null;
    }
  }

  // Offline with nothing cached yet: no data to render. Once the task is in memory, keep rendering
  // so an offline confirm still works (AC 4/5/6 offline behaviour).
  const needsConnection = !online && view === 'loading' && lines.length === 0 && !task;
  if (needsConnection) {
    return (
      <section className="edge-card" aria-live="polite">
        <p>{t('floor.needsConnection')}</p>
        <button className="secondary-action" type="button" onClick={() => window.location.reload()}>
          {t('floor.checkConnection')}
        </button>
      </section>
    );
  }

  if (view === 'loading') {
    return <p className="stores-status">{t('floor.loading')}</p>;
  }

  if (view === 'read-only') {
    return (
      <section className="edge-card" role="alert">
        <p>{announcement || errorMessage('FUNCTION_ACCESS_DENIED')}</p>
        <a className="secondary-action" href="/floor/tasks">
          {t('floor.done.back')}
        </a>
      </section>
    );
  }

  if (view === 'failed') {
    return (
      <section className="edge-card" aria-live="polite">
        <p>{announcement || t('floor.failed')}</p>
        <a className="secondary-action" href="/floor/tasks">
          {t('floor.done.back')}
        </a>
      </section>
    );
  }

  // Completion panel (AC 6): every non-cancelled line confirmed.
  if (taskComplete(effectiveLines) && !current) {
    return (
      <section className="edge-card floor-done" aria-live="polite">
        <h1>{t('floor.task.completedTitle')}</h1>
        <p>
          {t('floor.task.title').replace('{task}', task?.pick_task_id ?? taskId)} ·{' '}
          {t('floor.task.order').replace('{order}', task?.so_number_ext ?? task?.dispatch_order_id ?? '')}
        </p>
        <span className="stores-pill">
          {t('floor.task.lines').replace('{total}', String(activeCount))}
        </span>
        <p>{t('floor.task.allPicked')}</p>
        <a className="primary-action" href="/floor/tasks">
          {t('floor.done.back')}
        </a>
      </section>
    );
  }

  // Terminal empty task: every line was cancelled, so there is nothing left to pick.
  if (lines.length > 0 && activeCount === 0 && !current) {
    return (
      <section className="edge-card floor-done" aria-live="polite">
        <h1>{t('floor.task.completedTitle')}</h1>
        <p>{t('floor.noLines')}</p>
        <a className="primary-action" href="/floor/tasks">
          {t('floor.done.back')}
        </a>
      </section>
    );
  }

  if (!current) {
    return <p className="stores-status">{t('floor.loading')}</p>;
  }

  return (
    <section id="pick-line" className="floor-screen" aria-live="polite">
      <div className="edge-card stores-header">
        <p>{t('floor.task.title').replace('{task}', task?.pick_task_id ?? taskId)}</p>
        <p>{t('floor.task.order').replace('{order}', task?.so_number_ext ?? task?.dispatch_order_id ?? '')}</p>
        <p>
          {t('floor.task.lines').replace('{total}', String(activeCount))}{' '}
          · {t('floor.pickedOf').replace('{picked}', String(confirmedCount)).replace('{total}', String(activeCount))}
        </p>
      </div>

      <ol className="floor-steps" aria-label={t('floor.stepsLabel')}>
        {PICK_STEPS.map((stepKey, index) => (
          <li
            key={stepKey}
            aria-current={PICK_STEPS.indexOf(step) === index ? 'step' : undefined}
            className={PICK_STEPS.indexOf(step) === index ? 'floor-step active' : 'floor-step'}
          >
            {t(PICK_STEP_KEYS[stepKey] as MessageKey)}
          </li>
        ))}
      </ol>

      <section className="direct" aria-label={t('floor.directLabel')}>
        <span className="go">
          {step === 'bin' ? t('floor.direct.goTo') : t('floor.direct.atBin')}
        </span>
        <span className="bin">{directedBin(current)}</span>
        <span className="what">
          {t('floor.direct.pick').replace('{qty}', current.directed_quantity).replace('{item}', current.sku)}
        </span>
        <span className="lot">
          {t('floor.direct.lot').replace('{lot}', directedLot(current))}
        </span>
      </section>

      {step === 'bin' ? (
        <section className="edge-card">
          <ScanField
            id="pick-bin-scan"
            label={t('floor.bin.label')}
            value={scanned}
            placeholder={t('floor.bin.placeholder')}
            onScan={(value) => void onScanBin(value)}
            onChange={setScanned}
          />
        </section>
      ) : null}

      {step === 'lot' ? (
        <section className="edge-card">
          <ScanField
            id="pick-lot-scan"
            label={t('floor.lot.label')}
            value={scanned}
            placeholder={t('floor.lot.placeholder')}
            typeLabel={t('floor.lot.typeLabel')}
            onScan={(value) => void onScanLot(value)}
            onChange={setScanned}
          />
        </section>
      ) : null}

      {step === 'qty' ? (
        <section className="edge-card">
          <div className="qty">
            <label htmlFor="pick-qty">{t('floor.qty.label')}</label>
            <input
              id="pick-qty"
              className="scan-input"
              type="number"
              inputMode="numeric"
              readOnly
              value={current.directed_quantity}
            />
            <span className="of">
              {t('floor.qty.of').replace('{qty}', current.directed_quantity).replace('{uom}', current.uom ?? '')}
            </span>
          </div>
          <button
            className="primary-action"
            type="button"
            disabled={view === 'submitting' || !quantityReady(current.directed_quantity, current)}
            onClick={() => void confirm()}
          >
            {t('floor.confirm').replace('{qty}', current.directed_quantity)}
          </button>
          <button className="secondary-action" type="button" disabled>
            {t('floor.shortPick')}
          </button>
          <p>{t('floor.shortPickDisabled')}</p>
        </section>
      ) : null}

      {message?.messageKey ? (
        <p role="alert" className="stores-announcement">
          {messageKeyToText(message)}
        </p>
      ) : null}
      {refusedCode ? (
        <p role="alert" className="stores-announcement">
          {t('floor.refused').replace('{error}', errorMessage(refusedCode))}
        </p>
      ) : null}
      <p role="status" aria-live="polite" className="stores-announcement">
        {announcement}
      </p>
    </section>
  );
}

function messageKeyToText(message: MessageResult): string {
  let text = t(message.messageKey as MessageKey);
  if (message.messageParams) {
    for (const [key, value] of Object.entries(message.messageParams)) {
      text = text.replace(`{${key}}`, value);
    }
  }
  return text;
}
