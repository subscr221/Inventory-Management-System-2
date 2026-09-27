'use client';

import { useCallback, useRef, useState } from 'react';
import { t } from '../i18n/locale';
import { authorizedFetch } from '../session/api-fetch';

// Same rule as the API (src/api/v1/stock.ts SKU_REGEX): checked here only to save a round trip.
const SKU_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Story 1.15 Table 2: the availability response. No quantity is ever part of it. */
export interface Availability {
  sku: string;
  uom: string;
  in_stock: boolean;
  locations: { location_id: string; location_code: string; in_stock: boolean }[];
}

type CheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ready'; result: Availability }
  | { kind: 'message'; text: string };

/** Reject a malformed body instead of rendering it (Story 1.14 review: validate before keys). */
function isAvailability(value: unknown): value is Availability {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.sku === 'string' &&
    typeof body.uom === 'string' &&
    typeof body.in_stock === 'boolean' &&
    Array.isArray(body.locations) &&
    body.locations.every(
      (l: unknown) =>
        typeof l === 'object' &&
        l !== null &&
        typeof (l as Record<string, unknown>).location_id === 'string' &&
        typeof (l as Record<string, unknown>).location_code === 'string' &&
        typeof (l as Record<string, unknown>).in_stock === 'boolean',
    )
  );
}

function messageFor(errorCode: unknown): string {
  if (errorCode === 'ITEM_NOT_FOUND') return t('checkStock.notFound');
  if (errorCode === 'MODULE_ACCESS_DENIED') return t('checkStock.noAccess');
  if (errorCode === 'INVALID_PARAMS') return t('checkStock.invalidSku');
  return t('checkStock.unavailable');
}

/**
 * Story 1.15 (AC 2, D4, D5): whether an item can be requested and where from. The screen shows a
 * state per location, never a number; quantities stay behind inventory read on the API. Online
 * only: the answer is live, so an offline device gets the needs-connection card.
 */
export function CheckStock({ online }: { online: boolean }) {
  const [sku, setSku] = useState('');
  const [state, setState] = useState<CheckState>({ kind: 'idle' });
  const requestSequence = useRef(0);
  const field = useRef<HTMLInputElement | null>(null);

  const check = useCallback(async () => {
    const value = sku.trim();
    if (!SKU_REGEX.test(value)) {
      setState({ kind: 'message', text: t('checkStock.invalidSku') });
      field.current?.focus();
      return;
    }
    const sequence = ++requestSequence.current;
    setState({ kind: 'checking' });
    try {
      const response = await authorizedFetch(
        `/api/v1/stock/${encodeURIComponent(value)}/availability`,
        { credentials: 'include' },
      );
      const body: unknown = await response.json().catch(() => null);
      if (sequence !== requestSequence.current) return;
      if (response.ok && isAvailability(body)) {
        setState({ kind: 'ready', result: body });
        return;
      }
      const code = (body as { error_code?: unknown } | null)?.error_code;
      setState({ kind: 'message', text: messageFor(response.ok ? undefined : code) });
    } catch {
      if (sequence === requestSequence.current) {
        setState({ kind: 'message', text: t('checkStock.needsConnection') });
      }
    }
  }, [sku]);

  if (!online) {
    return (
      <section
        className="edge-card"
        id="check-stock"
        aria-labelledby="check-stock-connection-heading"
      >
        <h2 id="check-stock-connection-heading">{t('checkStock.title')}</h2>
        <p role="status">{t('checkStock.needsConnection')}</p>
      </section>
    );
  }

  const checking = state.kind === 'checking';
  return (
    <div className="base-screen" id="check-stock">
      <section className="edge-card" aria-labelledby="check-stock-heading">
        <h2 id="check-stock-heading">{t('checkStock.title')}</h2>
        <form
          className="base-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void check();
          }}
        >
          <label htmlFor="check-stock-sku">{t('checkStock.skuLabel')}</label>
          <input
            id="check-stock-sku"
            ref={field}
            name="sku"
            autoComplete="off"
            autoCapitalize="characters"
            maxLength={64}
            value={sku}
            disabled={checking}
            aria-describedby="check-stock-sku-hint"
            onChange={(event) => setSku(event.target.value)}
          />
          <p id="check-stock-sku-hint" className="base-hint">
            {t('checkStock.skuHint')}
          </p>
          <button className="primary-action" type="submit" disabled={checking} aria-busy={checking}>
            {checking ? t('checkStock.checking') : t('checkStock.submit')}
          </button>
        </form>
        {state.kind === 'message' ? (
          <p
            className="base-notice"
            role="status"
            aria-live="polite"
            aria-label={t('checkStock.liveLabel')}
          >
            {state.text}
          </p>
        ) : null}
      </section>
      {state.kind === 'ready' ? (
        <section className="edge-card" aria-labelledby="check-stock-result-heading">
          <h2 id="check-stock-result-heading">
            {t('checkStock.resultHeading')
              .replace('{sku}', state.result.sku)
              .replace('{uom}', state.result.uom)}
          </h2>
          <p role="status">
            {state.result.in_stock
              ? t('checkStock.summaryInStock')
              : t('checkStock.summaryOutOfStock')}
          </p>
          {state.result.locations.length === 0 ? (
            <p>{t('checkStock.noLocations')}</p>
          ) : (
            <ul className="base-list">
              {state.result.locations.map((location) => (
                <li key={location.location_id} className="base-card">
                  <span className="base-card-title">{location.location_code}</span>
                  <span className={location.in_stock ? 'state-pill state-pill-ok' : 'state-pill'}>
                    {location.in_stock ? t('checkStock.inStock') : t('checkStock.outOfStock')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
