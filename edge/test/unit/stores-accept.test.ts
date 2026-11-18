import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReceiptRows,
  fromMicros,
  goodQuantity,
  lineChip,
  lineIsShort,
  remainingBand,
  toMicros,
  type ReceiptLineDraft,
  type ReceiptSubmission,
} from '../../src/capture/receiving';

function draft(overrides: Partial<ReceiptLineDraft> = {}): ReceiptLineDraft {
  return {
    poRefExt: 'PO-1',
    lineNo: 10,
    sku: 'SKU-1',
    uom: 'EA',
    ordered: '100',
    cumulativeReceived: '90',
    overReceiptTolerancePct: 10,
    good: '5',
    damaged: '0',
    rejected: '0',
    ...overrides,
  };
}

function submission(lines: ReceiptLineDraft[]): ReceiptSubmission {
  return {
    grnId: 'grn-1',
    bindingToken: 'token-1',
    inspectionBayCode: 'IB-01',
    materialPhotoRef: 'photo-1',
    lines,
  };
}

test('quantities are exact decimal strings, never floats', () => {
  assert.equal(fromMicros(toMicros('0.1') + toMicros('0.2')), '0.3');
  assert.equal(fromMicros(toMicros('100')), '100');
  assert.equal(fromMicros(toMicros('12.345678')), '12.345678');
  assert.equal(toMicros('not-a-number'), 0n);
});

test('the cap is ordered plus tolerance minus cumulative receipts', () => {
  assert.equal(
    fromMicros(
      remainingBand({ ordered: '100', cumulativeReceived: '95', overReceiptTolerancePct: 10 }),
    ),
    '15',
  );
  assert.equal(
    fromMicros(
      remainingBand({ ordered: '100', cumulativeReceived: '120', overReceiptTolerancePct: 10 }),
    ),
    '0',
  );
  const capped = goodQuantity(draft({ good: '20', cumulativeReceived: '95' }));
  assert.equal(fromMicros(capped.posted), '15');
  assert.equal(fromMicros(capped.excess), '5');
  assert.equal(lineChip(draft({ good: '25' })), 'excess');
});

test('a REJECTED quantity does not count toward the band but a DAMAGED one does', () => {
  const rejectedOnly = draft({ good: '0', rejected: '30', cumulativeReceived: '90' });
  assert.equal(fromMicros(goodQuantity(rejectedOnly).posted), '0');
  assert.equal(lineIsShort(rejectedOnly), true);
  const damaged = draft({ good: '0', damaged: '10', cumulativeReceived: '90' });
  assert.equal(lineIsShort(damaged), false);
  assert.equal(lineChip(draft({ good: '10' })), 'matches');
});

test('one row per non-zero condition, non-GOOD before GOOD, ids injected', () => {
  let next = 0;
  const rows = buildReceiptRows(
    submission([
      draft({ good: '4', damaged: '2', rejected: '1', shortDetail: 'SUPPLIER_SHORT_SHIPPED' }),
    ]),
    () => `id-${++next}`,
  );
  assert.deepEqual(
    rows.map((row) => row.condition),
    ['REJECTED', 'DAMAGED', 'GOOD'],
  );
  assert.deepEqual(
    rows.map((row) => row.grn_line_id),
    ['id-1', 'id-2', 'id-3'],
  );
  assert.equal(rows[0]!.body['reason_detail'], 'WRONG_ITEM');
  assert.equal(rows[1]!.body['reason_detail'], 'TRANSIT_DAMAGE');
  assert.equal(rows[2]!.body['reason_code'], 'SHORT');
  assert.equal(rows[2]!.body['material_photo_ref'], 'photo-1');
  assert.equal(rows[2]!.body['target_location_code'], 'IB-01');
});

test('a short line with OTHER carries the photo and note', () => {
  const rows = buildReceiptRows(
    submission([
      draft({
        ordered: '10',
        cumulativeReceived: '0',
        good: '4',
        shortDetail: 'OTHER',
        otherPhotoRef: 'photo-2',
        otherNote: 'three cartons missing',
      }),
    ]),
    (() => {
      let n = 0;
      return () => `row-${++n}`;
    })(),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.body['reason_code'], 'OTHER');
  assert.equal(rows[0]!.body['reason_photo_ref'], 'photo-2');
  assert.equal(rows[0]!.body['reason_note'], 'three cartons missing');
});

test('inspect-on-opening fields travel only when set', () => {
  const plain = buildReceiptRows(submission([draft()]), () => 'a');
  assert.equal(plain[0]!.body['inspect_on_opening'], undefined);
  const inspected = buildReceiptRows(
    {
      ...submission([draft()]),
      inspectOnOpening: 'observed',
      inspectNote: 'dent on the side',
      inspectPhotoRef: 'photo-3',
    },
    () => 'b',
  );
  assert.equal(inspected[0]!.body['inspect_on_opening'], 'observed');
  assert.equal(inspected[0]!.body['inspect_note'], 'dent on the side');
  assert.equal(inspected[0]!.body['inspect_photo_ref'], 'photo-3');
});
