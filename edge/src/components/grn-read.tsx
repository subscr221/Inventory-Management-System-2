'use client';

import { useEffect, useState } from 'react';
import { errorMessage, formatDateTime, t } from '../i18n/locale';
import { authorizedFetch } from '../session/api-fetch';
import { LabelQueue } from './label-queue';

/**
 * Story 3.15 (AC 5): the GRN read card reached from Done today and from a label QR. Query string
 * selects the record; the edge app has no dynamic route segments.
 */

interface GrnLine {
  grn_line_id: string;
  po_ref_ext: string | null;
  line_no: number | null;
  sku: string;
  lot_id: string | null;
  received_qty: string;
  line_condition: 'GOOD' | 'DAMAGED' | 'REJECTED';
}

interface GrnView {
  grn_id: string;
  po_ref_ext: string | null;
  site_code_ext: string;
  status: string;
  received_at: string | null;
  business_date: string;
  lines: GrnLine[];
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; grn: GrnView; supplier: string | null }
  | { kind: 'message'; text: string };

export function GrnRead({ online, ready }: { online: boolean; ready: boolean }) {
  const [query, setQuery] = useState(() => {
    if (typeof window === 'undefined') return { grn: '', line: '' };
    const params = new URLSearchParams(window.location.search);
    return { grn: params.get('grn') ?? '', line: params.get('line') ?? '' };
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    setQuery({ grn: params.get('grn') ?? '', line: params.get('line') ?? '' });
  }, [window.location.search]);
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    if (!ready) return;
    if (!query.grn) {
      setState({ kind: 'message', text: t('grn.missing') });
      return;
    }
    if (!online) {
      setState({ kind: 'message', text: t('stores.needsConnection') });
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const res = await authorizedFetch(`/api/v1/grns/${encodeURIComponent(query.grn)}`);
        if (cancelled) return;
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          const code = typeof body['error_code'] === 'string' ? body['error_code'] : '';
          const text =
            code === 'FUNCTION_ACCESS_DENIED' || code === 'LOCATION_ACCESS_DENIED'
              ? `${t('nav.deniedTitle')} ${errorMessage(code)}`
              : errorMessage(code || 'GRN_NOT_FOUND');
          setState({ kind: 'message', text });
          return;
        }
        const grn = (await res.json()) as GrnView;
        let supplier: string | null = null;
        if (grn.po_ref_ext) {
          const poRes = await authorizedFetch(
            `/api/v1/erp/purchase-orders/${encodeURIComponent(grn.po_ref_ext)}`,
          );
          if (poRes.ok) {
            const po = (await poRes.json()) as Record<string, unknown>;
            if (typeof po['supplier_ref_ext'] === 'string') supplier = po['supplier_ref_ext'];
          }
        }
        if (!cancelled) setState({ kind: 'ready', grn, supplier });
      } catch {
        if (!cancelled) setState({ kind: 'message', text: t('grn.failed') });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [online, query.grn, ready]);

  if (state.kind === 'loading') {
    return <p className="stores-status">{t('stores.loading')}</p>;
  }
  if (state.kind === 'message') {
    return (
      <section className="edge-card" aria-live="polite">
        <p>{state.text}</p>
        <a className="secondary-action" href="/stores">
          {t('grn.back')}
        </a>
      </section>
    );
  }

  const { grn, supplier } = state;
  return (
    <div id="grn-read" className="stores-accept">
      <h1>{t('grn.title').replace('{grn}', grn.grn_id)}</h1>
      <section className="edge-card stores-header">
        <p>
          {t('grn.reference')}: {grn.grn_id}
        </p>
        <p>
          {t('grn.po')}: {grn.po_ref_ext ?? '-'}
        </p>
        <p>
          {t('grn.supplier')}: {supplier ?? '-'}
        </p>
        <p>
          {t('grn.site')}: {grn.site_code_ext}
        </p>
        <p>
          {t('grn.received')}:{' '}
          {grn.received_at ? formatDateTime(grn.received_at) : grn.business_date}
        </p>
        <p>
          {t('grn.status')}: {grn.status}
        </p>
      </section>

      <section className="edge-card" aria-labelledby="grn-lines-heading">
        <h2 id="grn-lines-heading">{t('grn.lines')}</h2>
        <ul className="stores-summary">
          {grn.lines.map((line) => (
            <li
              key={line.grn_line_id}
              className={line.grn_line_id === query.line ? 'stores-label stores-card-highlight' : ''}
            >
              <p>
                {t('grn.line')}: {line.po_ref_ext ?? '-'} / {line.line_no ?? '-'}
                {line.grn_line_id === query.line ? ` (${t('grn.highlighted')})` : ''}
              </p>
              <dl>
                <div>
                  <dt>{t('grn.sku')}</dt>
                  <dd>{line.sku}</dd>
                </div>
                <div>
                  <dt>{t('grn.quantity')}</dt>
                  <dd>{line.received_qty}</dd>
                </div>
                <div>
                  <dt>{t('grn.condition')}</dt>
                  <dd>{line.line_condition}</dd>
                </div>
                <div>
                  <dt>{t('grn.lot')}</dt>
                  <dd>{line.lot_id ?? '-'}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      </section>

      <LabelQueue grnId={grn.grn_id} />
    </div>
  );
}
