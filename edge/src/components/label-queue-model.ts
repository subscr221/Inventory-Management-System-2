import type { ReceiptRow } from '../capture/receiving';

/**
 * Story 3.15: labels are built from the 3.14 completion rows and kept device-local. The model is
 * pure so text, QR path and status rules are unit tested without IndexedDB.
 */

export interface QueuedLabel {
  grn_line_id: string;
  grn_id: string;
  po_ref_ext: string | null;
  line_no: number | null;
  sku: string;
  lot_id: string | null;
  bay_code: string;
  received_qty: string;
  status: 'queued' | 'printed';
  created_at: string;
  printed_at: string | null;
}

/** Internal zone name for non-GOOD lines. Rendered through `labels.bay.qcHold` so it is localized. */
export const QC_HOLD_BAY_CODE = 'ZONE-QC-HOLD';

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function buildLabels(
  grnId: string,
  rows: ReceiptRow[],
  createdAt = new Date().toISOString(),
): QueuedLabel[] {
  return rows.map((row) => {
    const body = row.body;
    return {
      grn_line_id: row.grn_line_id,
      grn_id: grnId,
      po_ref_ext: text(body['po_ref_ext']),
      line_no: numberOrNull(body['line_no']),
      sku: String(body['sku'] ?? ''),
      lot_id: text(body['lot_id']),
      bay_code:
        row.condition === 'GOOD'
          ? (text(body['target_location_code']) ?? '-')
          : 'ZONE-QC-HOLD',
      received_qty: String(body['received_qty'] ?? '0'),
      status: 'queued',
      created_at: createdAt,
      printed_at: null,
    };
  });
}

export function qrPath(label: Pick<QueuedLabel, 'grn_id' | 'grn_line_id'>): string {
  return `/stores/grn?grn=${encodeURIComponent(label.grn_id)}&line=${encodeURIComponent(
    label.grn_line_id,
  )}`;
}

export function labelLines(label: QueuedLabel): Array<{ key: string; value: string }> {
  return [
    { key: 'labels.grn', value: label.grn_id },
    { key: 'labels.poLine', value: label.po_ref_ext ?? (label.line_no ?? '-').toString() },
    { key: 'labels.sku', value: label.sku },
    { key: 'labels.lot', value: label.lot_id ?? '-' },
    { key: label.bay_code === QC_HOLD_BAY_CODE ? 'labels.bay.qcHold' : 'labels.bay', value: label.bay_code },
    { key: 'labels.quantity', value: label.received_qty },
  ];
}

export type LabelPill = 'labels.queued' | 'labels.printed' | 'labels.printerNotReady';

export function labelPill(
  label: Pick<QueuedLabel, 'status'>,
  printAvailable: boolean,
): LabelPill {
  if (label.status === 'printed') return 'labels.printed';
  return printAvailable ? 'labels.queued' : 'labels.printerNotReady';
}
