import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findCaseByScan,
  mergeOpenCases,
  resolvedToday,
  type ExceptionRow,
  type GateEventRow,
} from '../../src/components/unloading-exceptions-model.js';

const gate = (over: Partial<GateEventRow> = {}): GateEventRow => ({
  gate_event_id: 'g1',
  vehicle_reg_ext: 'UP 80 AB 1234',
  driver_name: null,
  challan_number_ext: 'CH-77',
  challan_photo_ref: null,
  po_ref_ext: null,
  supplier_ref_ext: null,
  supplier_name_unlisted: null,
  entered_at: '2026-11-22T08:05:00Z',
  ...over,
});

const exc = (over: Partial<ExceptionRow> = {}): ExceptionRow => ({
  exception_id: 'e1',
  kind: 'over_tolerance',
  source_id: 'l1',
  status: 'open',
  resolution: null,
  resolved_at: null,
  po_ref_ext: 'PO-9',
  line_no: 1,
  sku: 'SKU-1',
  uom: 'EA',
  vehicle_reg_ext: null,
  ordered_qty: '100',
  already_received_qty: '90',
  tolerance_pct: '10',
  cap_qty: '20',
  counted_qty: '30',
  excess_qty: '10',
  created_at: '2026-11-22T07:40:00Z',
  ...over,
});

describe('Story 3.20 unloading exceptions model', () => {
  it('merges open cases oldest first and ignores non-open rows', () => {
    const cases = mergeOpenCases([gate()], [exc(), exc({ source_id: 'l2', status: 'resolved' })]);
    assert.deepEqual(
      cases.map((c) => c.key),
      ['line:l1', 'gate:g1'],
    );
  });

  it('keeps only rows resolved on the IST date of now', () => {
    const now = '2026-11-22T10:00:00Z';
    const rows = [
      exc({ status: 'resolved', resolved_at: '2026-11-22T05:00:00Z' }),
      exc({ source_id: 'l2', status: 'sent_to_procurement', resolved_at: '2026-11-21T05:00:00Z' }),
      // 19:00Z on the 21st is 00:30 IST on the 22nd.
      exc({ source_id: 'l3', status: 'resolved', resolved_at: '2026-11-21T19:00:00Z' }),
      exc({ source_id: 'l4' }),
    ];
    assert.deepEqual(
      resolvedToday(rows, now).map((r) => r.source_id),
      ['l1', 'l3'],
    );
  });

  it('matches a scan on reg, challan or PO ref ignoring case and spaces', () => {
    const cases = mergeOpenCases([gate()], [exc()]);
    assert.equal(findCaseByScan(cases, 'up80ab1234')?.key, 'gate:g1');
    assert.equal(findCaseByScan(cases, ' ch-77 ')?.key, 'gate:g1');
    assert.equal(findCaseByScan(cases, 'po-9')?.key, 'line:l1');
    assert.equal(findCaseByScan(cases, 'nope'), null);
    assert.equal(findCaseByScan(cases, '  '), null);
  });
});
