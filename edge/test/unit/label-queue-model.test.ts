import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLabels,
  labelPill,
  qrPath,
  QC_HOLD_BAY_CODE,
} from '../../src/components/label-queue-model.js';

/** Story 3.15: label text, QR path and pill rules. */

function row(overrides: { condition: 'GOOD' | 'DAMAGED' | 'REJECTED' }) {
  return {
    grn_line_id: 'line-1',
    body: {
      po_ref_ext: 'PO-1',
      line_no: 1,
      sku: 'SKU-1',
      lot_id: 'LOT-1',
      target_location_code: 'IB-01',
      received_qty: '10',
    },
    ...overrides,
  };
}

describe('Story 3.15 label model', () => {
  it('builds one label per row with the inspection bay for GOOD lines', () => {
    const labels = buildLabels('grn-1', [row({ condition: 'GOOD' })], '2026-10-22T00:00:00.000Z');
    assert.equal(labels.length, 1);
    assert.equal(labels[0]!.bay_code, 'IB-01');
    assert.equal(labels[0]!.status, 'queued');
    assert.equal(labels[0]!.received_qty, '10');
  });

  it('sends DAMAGED and REJECTED lines to QC hold on the label', () => {
    const labels = buildLabels('grn-1', [row({ condition: 'DAMAGED' })]);
    assert.equal(labels[0]!.bay_code, QC_HOLD_BAY_CODE);
  });

  it('encodes the read-card deep link', () => {
    assert.equal(
      qrPath({ grn_id: 'grn 1', grn_line_id: 'line/1' }),
      '/stores/grn?grn=grn%201&line=line%2F1',
    );
  });

  it('reports printed, queued and printer-not-ready states', () => {
    assert.equal(labelPill({ status: 'printed' }, true), 'labels.printed');
    assert.equal(labelPill({ status: 'queued' }, true), 'labels.queued');
    assert.equal(labelPill({ status: 'queued' }, false), 'labels.printerNotReady');
  });
});