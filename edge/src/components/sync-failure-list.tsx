'use client';

import { useEffect, useRef, useState } from 'react';
import { errorMessage, formatDateTime, t } from '../i18n/locale';

export interface SyncFailureItem {
  eventId: string;
  eventType: string;
  errorCode: string;
  failedAt: string;
}

/**
 * Story 1.13: the device's retained refusals. Story 1.14 (AC 6, Binding Decision 8) adds the
 * two-tap dismiss: it drops the device's copy only, the central record is untouched, and a
 * dismissed STREAM_CONFLICT head lets the rest of its stream upload on the next sync.
 */
export function SyncFailureList({
  failures,
  onRetry,
  onDismiss,
}: {
  failures: SyncFailureItem[];
  onRetry?: () => void;
  onDismiss?: (eventId: string) => Promise<void>;
}) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [notice, setNotice] = useState('');
  const noticeRef = useRef<HTMLParagraphElement | null>(null);
  const retryButtonRef = useRef<HTMLButtonElement | null>(null);
  const prevCount = useRef(failures.length);
  const pendingFocus = useRef(false);

  // A stale "Removed from this device" notice must not sit above a list that has repopulated.
  useEffect(() => {
    if (failures.length > prevCount.current) setNotice('');
    prevCount.current = failures.length;
  }, [failures.length]);

  // Return focus after a dismiss unmounts the Confirm button (WCAG 2.4.3): prefer Retry, else the notice.
  useEffect(() => {
    if (!pendingFocus.current) return;
    (retryButtonRef.current ?? noticeRef.current)?.focus();
    pendingFocus.current = false;
  }, [failures, notice]);

  async function confirmDismiss(eventId: string): Promise<void> {
    if (!onDismiss || dismissing) return;
    setDismissing(true);
    try {
      await onDismiss(eventId);
      setNotice(t('refused.dismissed'));
    } catch {
      setNotice(t('refused.dismissFailed'));
    } finally {
      setDismissing(false);
      setConfirmingId(null);
      pendingFocus.current = true;
    }
  }

  if (failures.length === 0) {
    // The last row was just dismissed: keep the announcement, drop the heading.
    return notice ? (
      <p className="refused-notice" role="status" aria-live="polite" ref={noticeRef}>
        {notice}
      </p>
    ) : null;
  }
  return (
    <section className="edge-card" aria-labelledby="sync-failure-heading">
      <h2 id="sync-failure-heading">{t('sync.failedNeedsAttention')}</h2>
      <ul aria-live="assertive">
        {failures.map((failure) => (
          <li key={failure.eventId}>
            <strong>{failure.eventType}</strong>: {errorMessage(failure.errorCode)} (
            {failure.errorCode}) <span>{formatDateTime(failure.failedAt)}</span>
            {failure.eventType === 'cross_dock_task.completed' ? <p>{t('crossDock.correction')}</p> : null}
            {onDismiss ? (
              confirmingId === failure.eventId ? (
                <div className="edge-actions">
                  <button
                    className="primary-action"
                    type="button"
                    disabled={dismissing}
                    aria-busy={dismissing}
                    onClick={() => void confirmDismiss(failure.eventId)}
                  >
                    {t('refused.confirmDismiss')}
                  </button>
                  <button
                    className="secondary-action"
                    type="button"
                    disabled={dismissing}
                    onClick={() => setConfirmingId(null)}
                  >
                    {t('refused.cancel')}
                  </button>
                </div>
              ) : (
                <div className="edge-actions">
                  <button
                    className="secondary-action"
                    type="button"
                    disabled={dismissing}
                    onClick={() => setConfirmingId(failure.eventId)}
                  >
                    {t('refused.dismiss')}
                  </button>
                </div>
              )
            ) : null}
          </li>
        ))}
      </ul>
      <p className="refused-notice" role="status" aria-live="polite" ref={noticeRef}>
        {notice}
      </p>
      <button className="secondary-action" type="button" onClick={onRetry} ref={retryButtonRef}>
        {t('sync.retry')}
      </button>
    </section>
  );
}
