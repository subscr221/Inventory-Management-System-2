'use client';

import { useEffect, useRef, useState } from 'react';
import { t, type MessageKey } from '../i18n/locale';

const SYNC_LABELS: Record<string, MessageKey> = {
  online: 'sync.online',
  offline: 'sync.offline',
  captured: 'sync.captured',
  syncing: 'sync.syncing',
  error: 'sync.error',
};

export interface CrossDockTaskContext {
  cross_dock_task_id: string;
  grn_line_id: string;
  grn_line_no: number;
  po_ref_ext: string;
  sku: string;
  lot_number: string | null;
  quantity: string;
  uom: string;
  dispatch_order_line_id: string;
  sales_order_number: string;
  sales_order_line_no: number;
  staging_zone_id: string;
  staging_zone_code: string;
  correlation_id: string;
}

export function CrossDockCapture({
  syncState,
  onLoad,
  onConfirm,
}: {
  syncState: string;
  onLoad?: (taskId: string) => Promise<CrossDockTaskContext | null>;
  onConfirm?: (task: CrossDockTaskContext, stagingBinCode: string) => Promise<string>;
}) {
  const [taskId, setTaskId] = useState('');
  const [task, setTask] = useState<CrossDockTaskContext | null>(null);
  const [stagingBin, setStagingBin] = useState('');
  const [result, setResult] = useState('');
  const scanRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (task) scanRef.current?.focus();
  }, [task]);

  async function load() {
    setResult('');
    const loaded = await onLoad?.(taskId.trim());
    setTask(loaded ?? null);
    if (!loaded) setResult(t('crossDock.loadError'));
  }

  async function confirm() {
    if (!task || !stagingBin.trim()) return;
    const identifier = await onConfirm?.(task, stagingBin.trim());
    setResult(`${t('crossDock.pendingResult')} ${t('crossDock.scannedBin')}: ${stagingBin.trim()}. ${identifier ?? task.cross_dock_task_id}. ${t('crossDock.nextAction')}`);
  }

  return (
    <section className="edge-card cross-dock-capture" aria-labelledby="cross-dock-heading">
      <h2 id="cross-dock-heading">{t('crossDock.title')}</h2>
      <p>{t('crossDock.description')}</p>
      <form onSubmit={(event) => { event.preventDefault(); void load(); }}>
        <label htmlFor="cross-dock-task-id">{t('crossDock.taskId')}</label>
        <input id="cross-dock-task-id" value={taskId} onChange={(event) => setTaskId(event.target.value)} required />
        <button className="secondary-action" type="submit">{t('crossDock.load')}</button>
      </form>
      {task ? (
        <div className="cross-dock-context">
          <dl>
            <div><dt>{t('crossDock.taskId')}</dt><dd>{task.cross_dock_task_id}</dd></div>
            <div><dt>{t('crossDock.grnLine')}</dt><dd>{task.grn_line_id} / {task.grn_line_no}</dd></div>
            <div><dt>{t('crossDock.sku')}</dt><dd>{task.sku}</dd></div>
            <div><dt>{t('crossDock.lot')}</dt><dd>{task.lot_number ?? '-'}</dd></div>
            <div><dt>{t('crossDock.quantity')}</dt><dd>{task.quantity} {task.uom}</dd></div>
            <div><dt>{t('crossDock.salesOrderLine')}</dt><dd>{task.sales_order_number} / {task.sales_order_line_no}</dd></div>
            <div><dt>{t('crossDock.expectedZone')}</dt><dd>{task.staging_zone_code}</dd></div>
            <div><dt>{t('crossDock.scannedBin')}</dt><dd>{stagingBin || '-'}</dd></div>
            <div><dt>{t('crossDock.syncState')}</dt><dd><span className="operator-status">{t(SYNC_LABELS[syncState] ?? 'sync.offline')}</span></dd></div>
            <div><dt>{t('crossDock.durationLabel')}</dt><dd>{t('crossDock.durationInterval')}</dd></div>
          </dl>
          <form onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
            <label htmlFor="cross-dock-staging-bin">{t('crossDock.scanBin')}</label>
            <input ref={scanRef} id="cross-dock-staging-bin" value={stagingBin} onChange={(event) => setStagingBin(event.target.value)} required />
            <button className="primary-action" type="submit">{t('crossDock.confirm')}</button>
          </form>
        </div>
      ) : null}
      <p role="status" aria-live="polite" aria-label={t('crossDock.resultLabel')}>{result}</p>
    </section>
  );
}
