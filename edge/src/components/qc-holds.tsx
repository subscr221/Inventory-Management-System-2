'use client';

import { useCallback, useEffect, useState } from 'react';
import { errorMessage, formatDateTime, t } from '../i18n/locale';
import { authorizedFetch } from '../session/api-fetch';
import type { HeldLotRow } from '../capture/held-lot';

// Story 8.11 (AC 6): the QC holds page. Online it lists the open governed holds with hold_id,
// placed_by, placed_at and a two-tap release; offline it renders the synced held_lot rows
// (all sites) with release disabled and the PowerSync sync as-of line.

export interface QcHoldsProps {
  online: boolean;
  siteId: string;
  /** The synced held_lot rows, read by the edge client from the local PowerSync table. */
  offlineHeldLots?: HeldLotRow[];
  /** Last PowerSync sync ISO timestamp, or null when never synced / unavailable. */
  offlineAsOf?: string | null;
}

interface QcHoldRow {
  hold_id: string;
  lot_id: string;
  lot_number: string;
  sku: string;
  placed_by: string | null;
  placed_at: string;
  status: string;
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; holds: QcHoldRow[] }
  | { kind: 'message'; text: string };

async function errorCodeFrom(response: Response): Promise<string | null> {
  try {
    const body = (await response.json().catch(() => null)) as { error_code?: unknown } | null;
    return typeof body?.error_code === 'string' ? body.error_code : null;
  } catch {
    return null;
  }
}

export function QcHolds({
  online,
  siteId,
  offlineHeldLots = [],
  offlineAsOf = null,
}: QcHoldsProps) {
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [armedHoldId, setArmedHoldId] = useState<string | null>(null);
  const [releasing, setReleasing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!online) return;
    if (!siteId) {
      setState({ kind: 'message', text: t('qc.holds.needsConnection') });
      return;
    }
    try {
      const res = await authorizedFetch(
        `/api/v1/qc/holds?site_id=${encodeURIComponent(siteId)}&status=open`,
        { credentials: 'include' },
      );
      if (!res.ok) {
        setState({ kind: 'message', text: t('qc.holds.failed') });
        return;
      }
      const body = (await res.json()) as { holds?: QcHoldRow[] };
      setState({ kind: 'ready', holds: body.holds ?? [] });
    } catch {
      if (online) setState({ kind: 'message', text: t('qc.holds.failed') });
    }
  }, [online, siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  function armRelease(holdId: string): void {
    const trimmed = (reasons[holdId] ?? '').trim();
    if (!trimmed) {
      setNotice(t('qc.holds.releaseReasonRequired'));
      return;
    }
    setNotice(null);
    setArmedHoldId(holdId);
  }

  async function confirmRelease(holdId: string): Promise<void> {
    const trimmed = (reasons[holdId] ?? '').trim();
    if (!trimmed) {
      setNotice(t('qc.holds.releaseReasonRequired'));
      return;
    }
    setReleasing(holdId);
    setNotice(null);
    try {
      const res = await authorizedFetch(`/api/v1/qc/holds/${encodeURIComponent(holdId)}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ release_reason: trimmed }),
        credentials: 'include',
      });
      if (!res.ok) {
        setNotice(errorMessage((await errorCodeFrom(res)) ?? 'INVALID_PARAMS'));
        return;
      }
      setReasons((prev) => {
        const next = { ...prev };
        delete next[holdId];
        return next;
      });
      setArmedHoldId(null);
      setNotice(t('qc.holds.released'));
      await load();
    } catch {
      setNotice(t('qc.holds.releaseFailed'));
    } finally {
      setReleasing(null);
    }
  }

  const header = (
    <header className="qc-inbox-header">
      <h1>{online ? t('qc.holds.title') : t('qc.holds.offlineTitle')}</h1>
      <a className="secondary-action" href="/qc/tasks">
        {t('qc.holds.back')}
      </a>
    </header>
  );

  if (!online) {
    return (
      <div id="qc-holds" className="qc-holds">
        {header}
        <p className="stores-status" role="status">
          {offlineAsOf
            ? t('qc.holds.asOf').replace('{time}', formatDateTime(offlineAsOf))
            : t('qc.holds.asOfGeneric')}
        </p>
        {offlineHeldLots.length === 0 ? (
          <div className="emptyst" role="status">
            <p>{t('qc.holds.empty')}</p>
          </div>
        ) : (
          <ul className="stores-cards">
            {offlineHeldLots.map((lot) => (
              <li key={lot.lot_id} className="stores-card">
                <div>
                  <h3>{lot.lot_number}</h3>
                  <p>{lot.sku}</p>
                  {lot.quality_hold_reason ? <p>{lot.quality_hold_reason}</p> : null}
                </div>
                <span className="stores-pill">{t('qc.pill.hold')}</span>
                <button type="button" className="secondary-action" disabled>
                  {t('qc.holds.releaseDisabledOffline')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (state.kind === 'loading') {
    return (
      <div id="qc-holds" className="qc-holds">
        {header}
        <p className="stores-status">{t('qc.holds.loading')}</p>
      </div>
    );
  }
  if (state.kind === 'message') {
    return (
      <section className="edge-card" id="qc-holds" aria-live="polite">
        {header}
        <p>{state.text}</p>
        <button className="secondary-action" type="button" onClick={() => void load()}>
          {t('qc.checkConnection')}
        </button>
      </section>
    );
  }

  return (
    <div id="qc-holds" className="qc-holds">
      {header}
      {state.holds.length === 0 ? (
        <div className="emptyst" role="status">
          <p>{t('qc.holds.empty')}</p>
        </div>
      ) : (
        <ul className="stores-cards">
          {state.holds.map((hold) => {
            const isArmed = armedHoldId === hold.hold_id;
            return (
              <li key={hold.hold_id} className="stores-card">
                <div>
                  <h3>
                    {t('qc.holds.lot')}: {hold.lot_number}
                  </h3>
                  <p>
                    {t('qc.holds.sku')}: {hold.sku}
                  </p>
                  <p>{t('qc.holds.holdId').replace('{id}', hold.hold_id)}</p>
                  {hold.placed_by ? (
                    <p>{t('qc.holds.placedBy').replace('{name}', hold.placed_by)}</p>
                  ) : null}
                  <p>{t('qc.holds.placedAt').replace('{time}', formatDateTime(hold.placed_at))}</p>
                </div>
                <span className="stores-pill">{t('qc.pill.hold')}</span>
                <div className="qc-hold-release">
                  <label>
                    {t('qc.holds.releaseReason')}
                    <input
                      value={reasons[hold.hold_id] ?? ''}
                      onChange={(e) =>
                        setReasons((prev) => ({ ...prev, [hold.hold_id]: e.target.value }))
                      }
                    />
                  </label>
                  {isArmed ? (
                    <button
                      type="button"
                      className="primary-action"
                      disabled={releasing === hold.hold_id}
                      onClick={() => void confirmRelease(hold.hold_id)}
                    >
                      {t('qc.holds.confirmRelease')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secondary-action"
                      disabled={releasing === hold.hold_id}
                      onClick={() => armRelease(hold.hold_id)}
                    >
                      {t('qc.holds.release')}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p
        className="qc-notice"
        role="status"
        aria-live="polite"
        aria-label={t('qc.holds.liveLabel')}
      >
        {notice ?? ''}
      </p>
    </div>
  );
}
