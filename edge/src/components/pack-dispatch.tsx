'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { t, errorMessage, type MessageKey } from '../i18n/locale';
import { authorizedFetch } from '../session/api-fetch';
import { useDeviceClass } from '../lib/use-device-class';
import { ScanField } from './scan-field';
import {
  autoPackedKeys,
  buildPackingLines,
  canGenerate,
  canPrintDocument,
  groupDispatchRows,
  irnCoverageState,
  matchScan,
  remainingHints,
  waitPillFor,
  type DispatchGroup,
  type DispatchOrderRow,
  type PickedLineRow,
} from './pack-dispatch-model';

/**
 * Story 3.18 (AC 3, 4, 5, 6, 7, 8): the pack station list and dispatch screen. The list groups the
 * dispatch read into three buckets; a row opens the pack station, which scans picked lots into the
 * carton, records weight, generates shipping documents, records the IRN and confirms dispatch.
 * Online-only: offline renders the last list read-only and disables every write.
 */

export interface PackDispatchProps {
  online: boolean;
  ready: boolean;
  siteId: string;
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; rows: DispatchOrderRow[]; fetchedAt: string }
  | { kind: 'message'; text: string };

const PRINT_CSS = `@media print { body * { visibility: hidden; } #pack-station-doc, #pack-station-doc * { visibility: visible; } #pack-station-doc { position: absolute; left: 0; top: 0; width: 100%; } }`;

const DOC_LABEL_KEYS: Record<string, MessageKey> = {
  bol: 'packStation.doc.bol',
  packing_slip: 'packStation.doc.packing_slip',
  commercial_invoice: 'packStation.doc.commercial_invoice',
  label: 'packStation.doc.label',
};

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error_code?: unknown };
    return typeof body.error_code === 'string'
      ? errorMessage(body.error_code)
      : t('packStation.failed');
  } catch {
    return t('packStation.failed');
  }
}

function formatShort(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    );
  } catch {
    return iso;
  }
}

export function PackDispatch({ online, ready, siteId }: PackDispatchProps) {
  const deviceClass = useDeviceClass();
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [dispatchId, setDispatchId] = useState(() => {
    if (typeof window === 'undefined') return '';
    return new URLSearchParams(window.location.search).get('dispatch') ?? '';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setDispatchId(new URLSearchParams(window.location.search).get('dispatch') ?? '');
  }, [typeof window !== 'undefined' ? window.location.search : '']);

  const load = useCallback(async () => {
    if (!siteId) {
      setList({ kind: 'message', text: t('floor.noAccess') });
      return;
    }
    if (!online) return;
    setList((current) => (current.kind === 'ready' ? current : { kind: 'loading' }));
    try {
      const response = await authorizedFetch(`/api/v1/dispatch?site=${encodeURIComponent(siteId)}`);
      if (!response.ok) {
        setList({ kind: 'message', text: await readError(response) });
        return;
      }
      const body = (await response.json()) as { dispatchOrders?: DispatchOrderRow[] };
      setList({
        kind: 'ready',
        rows: Array.isArray(body.dispatchOrders) ? body.dispatchOrders : [],
        fetchedAt: new Date().toISOString(),
      });
    } catch {
      if (online) setList({ kind: 'message', text: t('packStation.needsConnection') });
    }
  }, [online, siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = list.kind === 'ready' ? groupDispatchRows(list.rows) : null;
  const selected =
    groups?.flatMap((g) => g.rows).find((r) => r.dispatch_order_id === dispatchId) ?? null;

  if (!siteId && ready) {
    return (
      <section className="edge-card" role="alert">
        <p>{t('floor.noAccess')}</p>
      </section>
    );
  }
  if (!online) {
    if (list.kind === 'ready' || dispatchId) {
      return (
        <div id="pack-dispatch" className="floor-inbox">
          {list.kind === 'ready' ? (
            <p className="stores-status" role="status">
              {t('packStation.offlineList').replace('{time}', formatShort(list.fetchedAt))}
            </p>
          ) : null}
          {dispatchId ? (
            <PackStation
              key={dispatchId}
              online={online}
              dispatchOrderId={dispatchId}
              row={selected}
              onChanged={() => void load()}
            />
          ) : list.kind === 'ready' ? (
            <PackList groups={groupDispatchRows(list.rows)} />
          ) : (
            <section className="edge-card" aria-live="polite">
              <p>{t('packStation.needsConnection')}</p>
              <button
                className="secondary-action"
                type="button"
                onClick={() => window.location.reload()}
              >
                {t('packStation.checkConnection')}
              </button>
            </section>
          )}
        </div>
      );
    }
    return (
      <section className="edge-card" aria-live="polite">
        <p>{t('packStation.needsConnection')}</p>
        <button className="secondary-action" type="button" onClick={() => window.location.reload()}>
          {t('packStation.checkConnection')}
        </button>
      </section>
    );
  }
  if (!ready) {
    return <p className="stores-status">{t('packStation.loading')}</p>;
  }
  if (list.kind === 'loading') {
    return <p className="stores-status">{t('packStation.loading')}</p>;
  }
  if (list.kind === 'message') {
    return (
      <section className="edge-card" aria-live="polite">
        <p>{list.text}</p>
        <button className="secondary-action" type="button" onClick={() => void load()}>
          {t('packStation.checkConnection')}
        </button>
      </section>
    );
  }
  if (!groups) return <p className="stores-status">{t('packStation.loading')}</p>;

  const wideTwoPane = deviceClass !== 'handheld' && Boolean(dispatchId);

  return (
    <div id="pack-dispatch" className="floor-screen" data-device-class={deviceClass}>
      <style>{PRINT_CSS}</style>
      {wideTwoPane ? <PackList groups={groups} /> : null}
      {dispatchId ? (
        <PackStation
          key={dispatchId}
          online={online}
          dispatchOrderId={dispatchId}
          row={selected}
          onChanged={() => void load()}
        />
      ) : (
        <PackList groups={groups} />
      )}
    </div>
  );
}

function PackList({ groups }: { groups: DispatchGroup[] }) {
  const hasWork = groups.some((g) => g.key !== 'dispatched' && g.rows.length > 0);
  return (
    <div>
      {!hasWork ? (
        <section className="stores-group" aria-labelledby="pack-empty-heading">
          <h2 id="pack-empty-heading" className="sr-only">
            {t('packStation.title')}
          </h2>
          <div className="emptyst" role="status">
            <h3>{t('floor.empty')}</h3>
            <p>{t('packStation.empty')}</p>
          </div>
        </section>
      ) : null}
      {groups.map((group) => {
        // The Dispatched today group always renders (with its rows, or "Nothing waiting" when
        // empty); the Ready and Waiting groups render only when they have rows.
        if (group.key !== 'dispatched' && group.rows.length === 0) return null;
        return (
          <section className="stores-group" key={group.key} aria-label={groupTitle(group.key)}>
            <h2>{groupTitle(group.key)}</h2>
            {group.rows.length === 0 ? (
              <p className="stores-status">{t('packStation.group.empty')}</p>
            ) : (
              <ul className="stores-cards">
                {group.rows.map((row) => {
                  const pill = group.key === 'waiting' ? waitPillFor(row) : null;
                  return (
                    <li key={row.dispatch_order_id} className="stores-card">
                      <div>
                        <h3>
                          <a
                            href={`/floor/pack?dispatch=${encodeURIComponent(row.dispatch_order_id)}`}
                          >
                            {row.so_number_ext}
                          </a>
                        </h3>
                        <p>{row.ship_to_ext ?? row.sku}</p>
                      </div>
                      {pill === 'cannot' ? (
                        <span className="state-pill state-pill-err">
                          {t('packStation.pill.cannotDispatch')}
                        </span>
                      ) : pill === 'ready' ? (
                        <span className="state-pill state-pill-ok">
                          {t('packStation.pill.ready')}
                        </span>
                      ) : null}
                      <a
                        className="primary-action"
                        href={`/floor/pack?dispatch=${encodeURIComponent(row.dispatch_order_id)}`}
                      >
                        {t('packStation.row.open')}
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function groupTitle(key: DispatchGroup['key']): string {
  if (key === 'ready') return t('packStation.group.ready');
  if (key === 'waiting') return t('packStation.group.waiting');
  return t('packStation.group.dispatched');
}

interface DispatchDocument {
  document_id: string;
  dispatch_order_id: string;
  document_type: string;
  document_content: string | null;
  generated_by: string;
  generated_at: string;
}

type Stage = 'picked' | 'packed' | 'documents_generated' | 'dispatched';

function PackStation({
  online,
  dispatchOrderId,
  row,
  onChanged,
}: {
  online: boolean;
  dispatchOrderId: string;
  row: DispatchOrderRow | null;
  onChanged: () => void;
}) {
  const [stage, setStage] = useState<Stage>(row?.stage ?? 'picked');
  const [pickedLines, setPickedLines] = useState<PickedLineRow[] | null>(null);
  const [documents, setDocuments] = useState<DispatchDocument[]>([]);
  const [irnCovered, setIrnCovered] = useState<boolean | null>(null);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [packedKeys, setPackedKeys] = useState<Set<string>>(new Set());
  const [weight, setWeight] = useState('');
  const [scanned, setScanned] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [view, setView] = useState<'loading' | 'ready' | 'failed'>('loading');
  const irnKey = useRef('');
  const [showIrnForm, setShowIrnForm] = useState(false);
  const [invoiceExt, setInvoiceExt] = useState('');
  const [irnExt, setIrnExt] = useState('');
  const [printDoc, setPrintDoc] = useState<DispatchDocument | null>(null);

  const loadPickedLines = useCallback(async () => {
    const response = await authorizedFetch(
      `/api/v1/dispatch/${encodeURIComponent(dispatchOrderId)}/picked-lines`,
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { pickedLines?: PickedLineRow[] };
    return Array.isArray(body.pickedLines) ? body.pickedLines : [];
  }, [dispatchOrderId]);

  const loadPackingRecords = useCallback(async (): Promise<Array<{
    sku: string;
    packed_qty: string | null;
    lot_id: string | null;
  }> | null> => {
    const response = await authorizedFetch(
      `/api/v1/dispatch/${encodeURIComponent(dispatchOrderId)}/packing-records`,
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      packingRecords?: Array<{ sku: string; packed_qty: string | null; lot_id: string | null }>;
    };
    return Array.isArray(body.packingRecords) ? body.packingRecords : [];
  }, [dispatchOrderId]);

  const loadDocuments = useCallback(async (): Promise<DispatchDocument[] | null> => {
    const response = await authorizedFetch(
      `/api/v1/dispatch/${encodeURIComponent(dispatchOrderId)}/documents`,
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { documents?: DispatchDocument[] };
    return Array.isArray(body.documents) ? body.documents : [];
  }, [dispatchOrderId]);

  const checkIrn = useCallback(async (): Promise<boolean | null> => {
    const response = await authorizedFetch(
      `/api/v1/dispatch/${encodeURIComponent(dispatchOrderId)}/irn`,
    );
    if (response.status === 404) return false;
    if (response.ok) return true;
    return null;
  }, [dispatchOrderId]);

  const load = useCallback(async () => {
    setView('loading');
    setMessage('');
    try {
      const lines = await loadPickedLines();
      if (lines === null) {
        setView('failed');
        return;
      }
      setPickedLines(lines);
      setPackedKeys(autoPackedKeys(lines));
      const docs = await loadDocuments();
      setDocuments(docs ?? []);
      if (docs && docs.length > 0) {
        setIrnCovered(await checkIrn());
      }
      setView('ready');
    } catch {
      setView('failed');
    }
  }, [checkIrn, loadDocuments, loadPickedLines]);

  useEffect(() => {
    void load();
  }, [load]);

  function openIrnForm() {
    irnKey.current = crypto.randomUUID();
    setShowIrnForm(true);
    setInvoiceExt('');
    setIrnExt('');
    setMessage('');
  }

  async function onScanLot(value: string) {
    if (!pickedLines) return;
    const outcome = matchScan(pickedLines, packedKeys, value);
    if (outcome.kind === 'packed') {
      setPackedKeys((current) => new Set(current).add(outcome.lineId));
      setAnnouncement(t('packStation.pill.inPackage'));
      setScanned('');
    } else if (outcome.kind === 'already') {
      setAnnouncement(t('packStation.alreadyPacked'));
      setScanned('');
    } else {
      setAnnouncement(t('packStation.unknownLot'));
      setScanned('');
    }
  }

  async function generate(): Promise<void> {
    if (submitting) return;
    setMessage('');
    setSubmitting(true);
    try {
      if (stage === 'picked' && pickedLines) {
        const built = buildPackingLines(pickedLines, packedKeys, weight);
        if (!built.ok) {
          const hints = remainingHints(pickedLines, packedKeys, weight);
          const parts: string[] = [];
          if (hints.itemsToScan > 0) {
            parts.push(
              t('packStation.generate.itemsToScan').replace('{count}', String(hints.itemsToScan)),
            );
          }
          if (hints.weightMissing) parts.push(t('packStation.generate.weightMissing'));
          setMessage(t('packStation.generate.left').replace('{left}', parts.join(', ')));
          setSubmitting(false);
          return;
        }
        const packRes = await authorizedFetch(
          `/api/v1/dispatch/${encodeURIComponent(dispatchOrderId)}/pack`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ packingLines: built.packingLines }),
          },
        );
        if (!packRes.ok) {
          const code = (await packRes.json().catch(() => ({}))) as { error_code?: unknown };
          // Pack is not idempotent: a prior attempt that packed but failed to generate leaves the
          // order packed, so re-posting pack is refused with PACKED_QTY_MISMATCH. A genuine
          // quantity mismatch carries the same code, so verify the order is actually packed (the
          // packing records fully cover the picked lines) before proceeding to generate documents.
          if (code.error_code !== 'PACKED_QTY_MISMATCH') {
            setMessage(
              typeof code.error_code === 'string'
                ? errorMessage(code.error_code)
                : t('packStation.failed'),
            );
            setSubmitting(false);
            return;
          }
          const records = await loadPackingRecords();
          const covered = records !== null && records.length >= (pickedLines?.length ?? 0);
          if (!covered) {
            setMessage(
              typeof code.error_code === 'string'
                ? errorMessage(code.error_code)
                : t('packStation.failed'),
            );
            setSubmitting(false);
            return;
          }
          // Verified packed: fall through and generate documents without re-packing.
        }
      }
      const genRes = await authorizedFetch(
        `/api/v1/dispatch/${encodeURIComponent(dispatchOrderId)}/generate-documents`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      if (!genRes.ok) {
        setMessage(await readError(genRes));
        setSubmitting(false);
        return;
      }
      setStage('documents_generated');
      setDocuments((await loadDocuments()) ?? []);
      setIrnCovered(await checkIrn());
      onChanged();
    } catch {
      setMessage(t('packStation.needsConnection'));
    } finally {
      setSubmitting(false);
    }
  }

  async function recordIrn(): Promise<void> {
    if (submitting || !invoiceExt.trim() || !/^[0-9a-f]{64}$/i.test(irnExt.trim())) return;
    setSubmitting(true);
    setMessage('');
    try {
      const response = await authorizedFetch(
        `/api/v1/dispatch/${encodeURIComponent(dispatchOrderId)}/irn`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            invoice_number_ext: invoiceExt.trim(),
            irn_ext: irnExt.trim().toLowerCase(),
            idempotency_key: irnKey.current,
          }),
        },
      );
      if (!response.ok) {
        setMessage(await readError(response));
        setSubmitting(false);
        return;
      }
      setIrnCovered(true);
      setShowIrnForm(false);
      setBlockedReason(null);
      onChanged();
    } catch {
      setMessage(t('packStation.needsConnection'));
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmDispatch(): Promise<void> {
    if (submitting) return;
    setSubmitting(true);
    setMessage('');
    try {
      const response = await authorizedFetch(
        `/api/v1/dispatch/${encodeURIComponent(dispatchOrderId)}/dispatch`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error_code?: unknown;
          details?: Record<string, unknown>;
        };
        const code = typeof body.error_code === 'string' ? body.error_code : '';
        if (code === 'IRN_MISSING') {
          setIrnCovered(false);
          const reason =
            typeof body.details?.['reason'] === 'string' ? body.details['reason'] : null;
          setBlockedReason(reason);
        } else if (code === 'DISPATCH_ORDER_ALREADY_DISPATCHED') {
          // Dispatch is not idempotent client-side: an ambiguous failure after a successful
          // dispatch surfaces already-dispatched on retry; reconcile to the dispatched state.
          setStage('dispatched');
          onChanged();
          setSubmitting(false);
          return;
        }
        setMessage(code ? errorMessage(code) : t('packStation.failed'));
        setSubmitting(false);
        return;
      }
      setStage('dispatched');
      onChanged();
    } catch {
      setMessage(t('packStation.needsConnection'));
    } finally {
      setSubmitting(false);
    }
  }

  async function retryIrnCheck(): Promise<void> {
    setMessage('');
    const covered = await checkIrn().catch(() => null);
    setIrnCovered(covered);
  }

  if (view === 'loading') {
    return <p className="stores-status">{t('packStation.loading')}</p>;
  }
  if (view === 'failed') {
    return (
      <section className="edge-card" aria-live="polite">
        <p>{t('packStation.failed')}</p>
        <a className="secondary-action" href="/floor/pack">
          {t('packStation.back')}
        </a>
      </section>
    );
  }

  const heading = (
    <div className="edge-card stores-header">
      <p>{row?.so_number_ext ?? ''}</p>
      <p>{row?.ship_to_ext ?? ''}</p>
      <a className="secondary-action" href="/floor/pack">
        {t('packStation.back')}
      </a>
    </div>
  );

  // AC 7: offline the pack station is read-only - the four write controls render disabled stating
  // needs a connection, and nothing is written to the outbox.
  if (!online) {
    return (
      <section id="pack-station-detail" className="floor-screen" aria-live="polite">
        {heading}
        <p className="stores-status" role="status">
          {t('packStation.needsConnection')}
        </p>
        <div className="edge-actions">
          <button className="primary-action" type="button" disabled>
            {t('packStation.generate')}
          </button>
          <button className="secondary-action" type="button" disabled>
            {t('packStation.irn.check')}
          </button>
          <button className="secondary-action" type="button" disabled>
            {t('packStation.irn.record')}
          </button>
          <button className="primary-action" type="button" disabled>
            {t('packStation.confirm')}
          </button>
        </div>
      </section>
    );
  }

  if (stage === 'dispatched') {
    return (
      <section className="edge-card floor-done" aria-live="polite">
        {heading}
        <h2>{t('packStation.dispatched.title')}</h2>
        <span className="state-pill state-pill-ok">{t('packStation.pill.dispatched')}</span>
        <a className="primary-action" href="/floor/pack">
          {t('packStation.back')}
        </a>
      </section>
    );
  }

  if (stage === 'documents_generated' || documents.length > 0) {
    return (
      <section id="pack-station-detail" className="floor-screen" aria-live="polite">
        {heading}
        {irnCoverageState(irnCovered) === 'blocked' ? (
          <PackIrnBlocked
            row={row}
            reason={blockedReason}
            showForm={showIrnForm}
            invoiceExt={invoiceExt}
            irnExt={irnExt}
            onInvoiceChange={setInvoiceExt}
            onIrnChange={setIrnExt}
            onOpenForm={openIrnForm}
            onSubmit={() => void recordIrn()}
            onCheck={() => void retryIrnCheck()}
            submitting={submitting}
          />
        ) : irnCoverageState(irnCovered) === 'ready' ? (
          <section className="edge-card stores-warning" role="status">
            <p>{t('packStation.docs.ready')}</p>
          </section>
        ) : (
          <section className="edge-card" aria-live="polite">
            <p>{t('packStation.irn.checkFailed')}</p>
            <button className="secondary-action" type="button" onClick={() => void retryIrnCheck()}>
              {t('packStation.irn.check')}
            </button>
          </section>
        )}
        <PackDocuments documents={documents} printDoc={printDoc} onPrint={setPrintDoc} />
        <button
          className="primary-action"
          type="button"
          disabled={submitting || irnCovered !== true || !online}
          onClick={() => void confirmDispatch()}
        >
          {t('packStation.confirm')}
        </button>
        <p className="stores-announcement" role="status" aria-live="polite">
          {message}
        </p>
      </section>
    );
  }

  const alreadyPacked = stage === 'packed';
  return (
    <section id="pack-station-detail" className="floor-screen" aria-live="polite">
      {heading}
      {alreadyPacked ? (
        <p className="stores-status" role="status">
          {t('packStation.packedNotice')}
        </p>
      ) : (
        <section aria-label={t('packStation.detail.packingTitle')}>
          <h2>{t('packStation.detail.packingTitle')}</h2>
          <ul className="stores-lines">
            {(pickedLines ?? []).map((line) => {
              const packed = packedKeys.has(line.pick_line_id);
              return (
                <li key={line.pick_line_id}>
                  <span>
                    {line.confirmed_quantity ?? ''} x {line.sku}
                  </span>
                  <span>{line.confirmed_lot_number ?? ''}</span>
                  {packed ? (
                    <span className="state-pill state-pill-ok">
                      {t('packStation.pill.inPackage')}
                    </span>
                  ) : (
                    <span className="state-pill state-pill-off">
                      {t('packStation.pill.scanToAdd')}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {!alreadyPacked ? (
        <section className="edge-card">
          <ScanField
            id="pack-lot-scan"
            label={t('packStation.scanLabel')}
            value={scanned}
            placeholder={t('packStation.scanPlaceholder')}
            typeLabel={t('packStation.scanTypeLabel')}
            disabled={!online}
            onScan={(value) => void onScanLot(value)}
            onChange={setScanned}
          />
          <p className="stores-status">{t('packStation.scanHint')}</p>
        </section>
      ) : null}
      <section className="edge-card">
        <label htmlFor="pack-weight">{t('packStation.weightLabel')}</label>
        <input
          id="pack-weight"
          className="scan-input"
          type="number"
          inputMode="decimal"
          step="0.1"
          placeholder={t('packStation.weightPlaceholder')}
          value={weight}
          disabled={alreadyPacked || !online}
          onChange={(event) => setWeight(event.target.value)}
        />
        <p className="stores-status">{t('packStation.weightHint')}</p>
      </section>
      <button
        className="primary-action"
        type="button"
        disabled={
          submitting ||
          !online ||
          alreadyPacked ||
          !canGenerate(pickedLines ?? [], packedKeys, weight)
        }
        onClick={() => void generate()}
      >
        {t('packStation.generate')}
      </button>
      {!alreadyPacked && !canGenerate(pickedLines ?? [], packedKeys, weight) ? (
        <p className="stores-status" role="status">
          {(() => {
            const hints = remainingHints(pickedLines ?? [], packedKeys, weight);
            const parts: string[] = [];
            if (hints.itemsToScan > 0) {
              parts.push(
                t('packStation.generate.itemsToScan').replace('{count}', String(hints.itemsToScan)),
              );
            }
            if (hints.weightMissing) parts.push(t('packStation.generate.weightMissing'));
            return parts.length > 0
              ? t('packStation.generate.left').replace('{left}', parts.join(', '))
              : '';
          })()}
        </p>
      ) : null}
      <p className="stores-announcement" role="status" aria-live="polite">
        {announcement}
      </p>
      <p className="stores-announcement" role="alert">
        {message}
      </p>
    </section>
  );
}

function PackIrnBlocked({
  row,
  reason,
  showForm,
  invoiceExt,
  irnExt,
  onInvoiceChange,
  onIrnChange,
  onOpenForm,
  onSubmit,
  onCheck,
  submitting,
}: {
  row: DispatchOrderRow | null;
  reason: string | null;
  showForm: boolean;
  invoiceExt: string;
  irnExt: string;
  onInvoiceChange: (value: string) => void;
  onIrnChange: (value: string) => void;
  onOpenForm: () => void;
  onSubmit: () => void;
  onCheck: () => void;
  submitting: boolean;
}) {
  const noErpLine = reason === 'no_erp_sales_order_line';
  const irnValid = invoiceExt.trim() !== '' && /^[0-9a-f]{64}$/i.test(irnExt.trim());
  return (
    <section className="edge-card stores-warning" role="alert">
      <h2>{t('packStation.irn.blockedTitle')}</h2>
      {row ? (
        <dl className="stores-facts">
          <div>
            <dt>{t('packStation.irn.summaryOrder')}</dt>
            <dd>{row.so_number_ext}</dd>
          </div>
          <div>
            <dt>{t('packStation.irn.summaryShipTo')}</dt>
            <dd>{row.ship_to_ext ?? row.sku}</dd>
          </div>
          <div>
            <dt>{t('packStation.irn.summaryQuantity')}</dt>
            <dd>
              {row.sku} x {row.quantity}
            </dd>
          </div>
        </dl>
      ) : null}
      {noErpLine ? <p>{t('packStation.irn.noErpLine')}</p> : null}
      <div className="edge-actions">
        <div>
          <button className="secondary-action" type="button" disabled>
            {t('packStation.irn.park')}
          </button>
          <p className="stores-status">{t('packStation.irn.parkReason')}</p>
        </div>
        <button className="primary-action" type="button" onClick={onCheck}>
          {t('packStation.irn.check')}
        </button>
        {!noErpLine && !showForm ? (
          <button className="secondary-action" type="button" onClick={onOpenForm}>
            {t('packStation.irn.record')}
          </button>
        ) : null}
      </div>
      {!noErpLine && showForm ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <label htmlFor="pack-irn-invoice">{t('packStation.irn.invoiceLabel')}</label>
          <input
            id="pack-irn-invoice"
            value={invoiceExt}
            onChange={(event) => onInvoiceChange(event.target.value)}
          />
          <label htmlFor="pack-irn-ext">{t('packStation.irn.irnLabel')}</label>
          <input
            id="pack-irn-ext"
            value={irnExt}
            onChange={(event) => onIrnChange(event.target.value)}
          />
          <button className="primary-action" type="submit" disabled={submitting || !irnValid}>
            {t('packStation.irn.submit')}
          </button>
        </form>
      ) : null}
    </section>
  );
}

function PackDocuments({
  documents,
  printDoc,
  onPrint,
}: {
  documents: DispatchDocument[];
  printDoc: DispatchDocument | null;
  onPrint: (doc: DispatchDocument | null) => void;
}) {
  return (
    <section aria-label={t('packStation.docs.title')}>
      <h2>{t('packStation.docs.title')}</h2>
      <ul className="stores-lines">
        {documents.map((doc) => {
          const labelKey = DOC_LABEL_KEYS[doc.document_type];
          return (
            <li key={doc.document_id}>
              <span>{labelKey ? t(labelKey) : doc.document_type}</span>
              <button
                className="secondary-action"
                type="button"
                disabled={!canPrintDocument(doc.document_content)}
                onClick={() => {
                  onPrint(doc);
                  // React commits the state before this macrotask fires, so the pre is painted.
                  // window.print() is synchronous, so clearing afterwards removes the content.
                  setTimeout(() => {
                    if (typeof window !== 'undefined' && typeof window.print === 'function') {
                      window.print();
                    }
                    onPrint(null);
                  }, 0);
                }}
              >
                {t('packStation.docs.print')}
              </button>
              {!canPrintDocument(doc.document_content) ? (
                <span className="stores-status">{t('packStation.docs.noContent')}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {printDoc ? (
        <pre id="pack-station-doc" aria-hidden="true">
          {printDoc.document_content ?? ''}
        </pre>
      ) : null}
    </section>
  );
}
