'use client';

import { useEffect, useRef, useState } from 'react';
import { errorMessage, t, type MessageKey } from '../i18n/locale';
import { authorizedFetch } from '../session/api-fetch';
import { ScanField } from './scan-field';
import {
  classHintKey,
  completionBody,
  needsOverride,
  OVERRIDE_REASONS,
  toSuggestion,
  type OverrideConfidence,
  type OverrideReason,
  type Suggestion,
} from './putaway-task-model';

/**
 * Story 3.15 (AC 3, 4, 6): directed putaway detail. Online-only for pilot; the suggestion route is
 * called before completion so the server's override rule keys on a stored directed location.
 */

interface Task {
  putaway_task_id: string;
  sku: string;
  lot_id: string | null;
  quantity: string;
  from_location_id: string;
  site_id: string;
  status: 'ready' | 'held' | 'completed';
  directed_location_code: string | null;
}

type Status = 'loading' | 'ready' | 'read-only' | 'reason' | 'submitting' | 'done' | 'failed';

const REOPEN_CODES = new Set([
  'PUTAWAY_OVERRIDE_REASON_REQUIRED',
  'PUTAWAY_OVERRIDE_CONFIDENCE_REQUIRED',
]);

export function PutawayTask({ online, ready }: { online: boolean; ready: boolean }) {
  const [taskId, setTaskId] = useState(() => {
    if (typeof window === 'undefined') return '';
    return new URLSearchParams(window.location.search).get('task') ?? '';
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setTaskId(new URLSearchParams(window.location.search).get('task') ?? '');
  }, [typeof window !== 'undefined' ? window.location.search : '']);
  const [task, setTask] = useState<Task | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [fromCode, setFromCode] = useState('-');
  const [status, setStatus] = useState<Status>('loading');
  const [message, setMessage] = useState('');
  const [scanned, setScanned] = useState('');
  const [scanning, setScanning] = useState(false);
  const [reason, setReason] = useState<OverrideReason | null>(null);
  const [confidence, setConfidence] = useState<OverrideConfidence | null>(null);
  const idempotencyKey = useRef('');
  const lastSubmit = useRef<string | null>(null);
  const [doneCode, setDoneCode] = useState('');

  useEffect(() => {
    if (!online) return;
    if (!ready) return;
    if (!taskId) {
      setStatus('failed');
      setMessage(t('putaway.missingTask'));
      return;
    }
    setTask(null);
    setSuggestion(null);
    setFromCode('-');
    setScanned('');
    setScanning(false);
    setReason(null);
    setConfidence(null);
    setMessage('');
    setStatus('loading');
    lastSubmit.current = null;
    let cancelled = false;
    async function load() {
      try {
        const taskRes = await authorizedFetch(
          `/api/v1/putaway-tasks/${encodeURIComponent(taskId)}`,
        );
        if (cancelled) return;
        if (!taskRes.ok) {
          const body = (await taskRes.json().catch(() => ({}))) as Record<string, unknown>;
          const code = typeof body['error_code'] === 'string' ? body['error_code'] : '';
          setStatus(code === 'FUNCTION_ACCESS_DENIED' || code === 'LOCATION_ACCESS_DENIED'
            ? 'read-only'
            : 'failed');
          setMessage(errorMessage(code || 'PUTAWAY_TASK_NOT_FOUND'));
          return;
        }
        const loaded = ((await taskRes.json()) as { task?: Task }).task ?? null;
        if (!loaded) {
          setStatus('failed');
          setMessage(t('putaway.failed'));
          return;
        }
        setTask(loaded);

        const [locationRes, suggestionRes] = await Promise.all([
          authorizedFetch(
            `/api/v1/locations/${encodeURIComponent(loaded.from_location_id)}`,
          ).catch(() => null),
          authorizedFetch(
            `/api/v1/putaway-tasks/${encodeURIComponent(taskId)}/suggestion`,
          ),
        ]);
        if (cancelled) return;
        if (locationRes?.ok) {
          const location = (await locationRes.json()) as Record<string, unknown>;
          if (typeof location['location_code'] === 'string') setFromCode(location['location_code']);
        }
        if (suggestionRes.status === 403) {
          const body = (await suggestionRes.json().catch(() => ({}))) as Record<string, unknown>;
          setStatus('read-only');
          setMessage(
            errorMessage(
              typeof body['error_code'] === 'string' ? body['error_code'] : 'FUNCTION_ACCESS_DENIED',
            ),
          );
          return;
        }
        if (!suggestionRes.ok) {
          const body = (await suggestionRes.json().catch(() => ({}))) as Record<string, unknown>;
          setStatus('failed');
          setMessage(
            errorMessage(
              typeof body['error_code'] === 'string' ? body['error_code'] : 'PUTAWAY_TASK_NOT_FOUND',
            ),
          );
          return;
        }
        setSuggestion(toSuggestion(await suggestionRes.json()));
        setStatus('ready');
      } catch {
        if (!cancelled) {
          setStatus('failed');
          setMessage(t('putaway.failed'));
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [online, ready, taskId]);

  async function submit(code: string, chosenReason?: OverrideReason, chosenConfidence?: OverrideConfidence) {
    if (!task) return;
    const signature = `${code.trim().toLowerCase()}|${chosenReason ?? ''}|${chosenConfidence ?? ''}`;
    if (lastSubmit.current !== signature) {
      lastSubmit.current = signature;
      idempotencyKey.current = crypto.randomUUID();
    }
    setStatus('submitting');
    setMessage('');
    try {
      const response = await authorizedFetch(
        `/api/v1/putaway-tasks/${encodeURIComponent(task.putaway_task_id)}/complete`,
        {
          method: 'POST',
          body: JSON.stringify(
            completionBody({
              scannedCode: code,
              directedCode: suggestion?.locationCode ?? task.directed_location_code,
              reason: chosenReason ?? null,
              confidence: chosenConfidence ?? null,
              idempotencyKey: idempotencyKey.current,
            }),
          ),
        },
      );
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.ok) {
        setDoneCode(code);
        setStatus('done');
        return;
      }
      const codeReturned = typeof body['error_code'] === 'string' ? body['error_code'] : '';
      setMessage(errorMessage(codeReturned || 'PUTAWAY_TASK_NOT_FOUND'));
      if (REOPEN_CODES.has(codeReturned)) {
        setScanned(code);
        setStatus('reason');
        return;
      }
      setStatus('ready');
    } catch {
      setStatus('ready');
      setMessage(t('putaway.failed'));
    }
  }

  function onScan(code: string): void {
    setScanned(code);
    const directed = suggestion?.locationCode ?? task?.directed_location_code ?? null;
    if (needsOverride(directed, code)) {
      setStatus('reason');
      return;
    }
    void submit(code);
  }

  if (status === 'done') {
    return (
      <section className="edge-card" id="putaway-done" aria-live="polite">
        <h1>{t('putaway.done.title')}</h1>
        <p>{t('putaway.done.body').replace('{code}', doneCode)}</p>
        <a className="primary-action" href="/stores">
          {t('putaway.done.back')}
        </a>
      </section>
    );
  }
  if (!online) {
    return (
      <section className="edge-card" aria-live="polite">
        <p>{t('putaway.needsConnection')}</p>
        <button
          className="secondary-action"
          type="button"
          onClick={() => window.location.reload()}
        >
          {t('stores.checkConnection')}
        </button>
      </section>
    );
  }
  if (status === 'loading') {
    return <p className="stores-status">{t('putaway.loading')}</p>;
  }
  if (!task && status !== 'failed' && status !== 'read-only') {
    return <p className="stores-status">{t('putaway.loading')}</p>;
  }
  if (status === 'failed') {
    return (
      <section className="edge-card" aria-live="polite">
        <p>{message || t('putaway.failed')}</p>
        <a className="secondary-action" href="/stores">
          {t('putaway.done.back')}
        </a>
      </section>
    );
  }
  if (status === 'read-only' && !task) {
    return (
      <section className="edge-card" role="alert">
        <p>{message || errorMessage('FUNCTION_ACCESS_DENIED')}</p>
        <a className="secondary-action" href="/stores">
          {t('putaway.done.back')}
        </a>
      </section>
    );
  }
  if (!task) {
    return <p className="stores-status">{t('putaway.loading')}</p>;
  }

  const readOnly = status === 'read-only';

  return (
    <div id="putaway-task" className="stores-accept">
      <h1>{t('putaway.detail.title').replace('{sku}', task.sku)}</h1>
      <section className="edge-card stores-header">
        <p>
          {t('putaway.detail.sku')}: {task.sku}
        </p>
        <p>
          {t('putaway.detail.lot')}: {task.lot_id ?? '-'}
        </p>
        <p>
          {t('putaway.detail.quantity')}: {task.quantity}
        </p>
        <p>
          {t('putaway.detail.from')}: {fromCode}
        </p>
      </section>

      {readOnly ? (
        <section className="edge-card" role="alert">
          <p>{message || errorMessage('FUNCTION_ACCESS_DENIED')}</p>
        </section>
      ) : suggestion?.locationId && suggestion.locationCode ? (
        <section className="edge-card" aria-live="polite">
          <p>{t('putaway.detail.suggested').replace('{code}', suggestion.locationCode)}</p>
          {classHintKey(suggestion.velocityClass) ? (
            <p>{t(classHintKey(suggestion.velocityClass) as MessageKey)}</p>
          ) : null}
          <button
            className="primary-action"
            type="button"
            disabled={status === 'submitting'}
            onClick={() => void submit(suggestion.locationCode as string)}
          >
            {t('putaway.detail.useSuggested').replace('{code}', suggestion.locationCode)}
          </button>{' '}
          <button
            className="secondary-action"
            type="button"
            disabled={status === 'submitting'}
            onClick={() => setScanning(true)}
          >
            {t('putaway.detail.chooseOther')}
          </button>
        </section>
      ) : (
        <section className="edge-card" aria-live="polite">
          <p>{suggestion?.reason ?? t('putaway.detail.noSuggestion')}</p>
          <button
            className="secondary-action"
            type="button"
            disabled={status === 'submitting'}
            onClick={() => setScanning(true)}
          >
            {t('putaway.detail.chooseOther')}
          </button>
        </section>
      )}

      {!readOnly && (scanning || status === 'reason' || status === 'submitting') ? (
        <section className="edge-card">
          <ScanField
            id="putaway-rack-scan"
            label={t('putaway.detail.scanLabel')}
            value={scanned}
            placeholder={t('putaway.detail.scanPlaceholder')}
            typeLabel={t('putaway.detail.typeRack')}
            disabled={status === 'submitting'}
            onScan={onScan}
            onChange={setScanned}
          />
        </section>
      ) : null}

      {status === 'reason' ? (
        <section className="edge-card" aria-live="polite">
          <h2>{t('putaway.override.title')}</h2>
          <div role="group" aria-label={t('putaway.override.title')}>
            {OVERRIDE_REASONS.map((code) => (
              <button
                key={code}
                className={reason === code ? 'primary-action' : 'secondary-action'}
                type="button"
                aria-pressed={reason === code}
                onClick={() => setReason(code)}
              >
                {t(`putaway.override.${code}` as MessageKey)}
              </button>
            ))}
          </div>
          <p>{t('putaway.override.confidence')}</p>
          <div role="group" aria-label={t('putaway.override.confidence')}>
            {(['certain', 'uncertain'] as const).map((value) => (
              <button
                key={value}
                className={confidence === value ? 'primary-action' : 'secondary-action'}
                type="button"
                aria-pressed={confidence === value}
                onClick={() => setConfidence(value)}
              >
                {t(`putaway.override.${value}` as MessageKey)}
              </button>
            ))}
          </div>
          <button
            className="primary-action"
            type="button"
            disabled={!reason || !confidence}
            onClick={() => void submit(scanned, reason ?? undefined, confidence ?? undefined)}
          >
            {t('putaway.override.submit')}
          </button>{' '}
          <button
            className="secondary-action"
            type="button"
            onClick={() => {
              setStatus('ready');
              setReason(null);
              setConfidence(null);
              setMessage('');
            }}
          >
            {t('putaway.override.cancel')}
          </button>
        </section>
      ) : null}

      {message && (status === 'ready' || status === 'reason') ? (
        <p role="alert" className="stores-announcement">
          {message}
        </p>
      ) : null}
    </div>
  );
}
