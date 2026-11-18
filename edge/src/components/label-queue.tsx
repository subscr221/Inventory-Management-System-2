'use client';

import { useCallback, useEffect, useState } from 'react';
import qrcode from 'qrcode-generator';
import { t, type MessageKey } from '../i18n/locale';
import { labelStore } from '../local-db/label-queue';
import {
  labelLines,
  labelPill,
  qrPath,
  type QueuedLabel,
} from './label-queue-model';

/**
 * Story 3.15 (AC 5): the device-local label queue. One label per GRN line, printed through the
 * Story 4.11 print-only stylesheet. Printing never blocks the receipt or the putaway flow.
 */

const PRINT_CSS =
  '@media print { body * { visibility: hidden; } .label-printing, .label-printing * { visibility: visible; } .label-printing { position: absolute; left: 0; top: 0; width: 100%; } }';

const qrCache = new Map<string, string>();

function qrDataUrl(label: QueuedLabel): string {
  const cached = qrCache.get(label.grn_line_id);
  if (cached) return cached;
  const qr = qrcode(0, 'M');
  qr.addData(qrPath(label));
  qr.make();
  const dataUrl = qr.createDataURL(4, 0);
  qrCache.set(label.grn_line_id, dataUrl);
  return dataUrl;
}

export function LabelQueue({ grnId }: { grnId: string }) {
  const [labels, setLabels] = useState<QueuedLabel[]>([]);
  const [loadError, setLoadError] = useState('');
  const [printAvailable, setPrintAvailable] = useState(false);
  const [printingId, setPrintingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setLabels(await labelStore.listByGrn(grnId));
      setLoadError('');
    } catch {
      setLoadError(t('labels.unavailable'));
    }
  }, [grnId]);

  useEffect(() => {
    setPrintAvailable(typeof window !== 'undefined' && typeof window.print === 'function');
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!printingId) return;
    const labelId = printingId;
    const supportsPrintQuery = typeof window.matchMedia === 'function';
    let started = !supportsPrintQuery;
    const query = supportsPrintQuery ? window.matchMedia('print') : null;
    const onQueryChange = (event: MediaQueryListEvent) => {
      if (event.matches) started = true;
    };
    query?.addEventListener?.('change', onQueryChange);
    const done = () => {
      query?.removeEventListener?.('change', onQueryChange);
      setPrintingId(null);
      if (!started) return;
      void labelStore
        .markPrinted(labelId)
        .then(reload)
        .catch(() => {
          void reload();
        });
    };
    window.addEventListener('afterprint', done, { once: true });
    window.print();
    return () => {
      window.removeEventListener('afterprint', done);
      query?.removeEventListener?.('change', onQueryChange);
    };
  }, [printingId, reload]);

  if (loadError) {
    return (
      <section className="edge-card" aria-live="polite">
        <p>{loadError}</p>
      </section>
    );
  }

  return (
    <section className="edge-card" aria-labelledby="labels-heading">
      <style>{PRINT_CSS}</style>
      <h2 id="labels-heading">{t('labels.title')}</h2>
      {labels.length === 0 ? (
        <p>{t('labels.empty')}</p>
      ) : (
        <ul className="stores-summary" id="grn-label-print">
          {labels.map((label) => (
            <li
              key={label.grn_line_id}
              className={
                printingId === label.grn_line_id ? 'stores-label label-printing' : 'stores-label'
              }
            >
              <img src={qrDataUrl(label)} alt={t('labels.qrAlt')} width={72} height={72} />
              <dl>
                {labelLines(label).map((line) => (
                  <div key={line.key}>
                    <dt>{t(line.key as MessageKey)}</dt>
                    <dd>{line.value}</dd>
                  </div>
                ))}
              </dl>
              <span className="stores-pill">{t(labelPill(label, printAvailable))}</span>
              <button
                className="secondary-action"
                type="button"
                onClick={() => setPrintingId(label.grn_line_id)}
                disabled={!printAvailable}
              >
                {label.status === 'printed' ? t('labels.reprint') : t('labels.print')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
