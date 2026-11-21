import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
  type DispatchOrderRow,
  type PickedLineRow,
} from '../../src/components/pack-dispatch-model.js';

/** Story 3.18 (AC 3, AC 4): pure list grouping and the pack body derivation. */

const row = (over: Partial<DispatchOrderRow>): DispatchOrderRow => ({
  dispatch_order_id: 'o1',
  so_number_ext: 'SO-1',
  line_no: 1,
  ship_to_ext: null,
  sku: 'SKU-1',
  quantity: '10',
  picked_at: '2026-11-20T00:00:00Z',
  packed_at: null,
  dispatched_at: null,
  stage: 'picked',
  irn_recorded: false,
  ...over,
});

const line = (over: Partial<PickedLineRow>): PickedLineRow => ({
  pick_line_id: 'pl1',
  sku: 'SKU-1',
  confirmed_lot_id: 'lot-1',
  confirmed_lot_number: 'L-1',
  confirmed_quantity: '6',
  uom: 'EA',
  ...over,
});

describe('Story 3.18 pack-dispatch model', () => {
  it('groups rows into the three fixed buckets in order', () => {
    const groups = groupDispatchRows([
      row({ dispatch_order_id: 'd', stage: 'dispatched' }),
      row({ dispatch_order_id: 'p', stage: 'picked' }),
      row({ dispatch_order_id: 'w', stage: 'packed' }),
      row({ dispatch_order_id: 'g', stage: 'documents_generated' }),
    ]);
    assert.deepEqual(
      groups.map((g) => g.key),
      ['ready', 'waiting', 'dispatched'],
    );
    assert.deepEqual(
      groups[0]!.rows.map((r) => r.dispatch_order_id),
      ['p'],
    );
    assert.deepEqual(
      groups[1]!.rows.map((r) => r.dispatch_order_id),
      ['w', 'g'],
    );
    assert.deepEqual(
      groups[2]!.rows.map((r) => r.dispatch_order_id),
      ['d'],
    );
  });

  it('pills the waiting bucket on IRN coverage, not the stage', () => {
    assert.equal(waitPillFor(row({ irn_recorded: false })), 'cannot');
    assert.equal(waitPillFor(row({ irn_recorded: true })), 'ready');
  });

  it('builds one packing line per picked lot with the weight on the first', () => {
    const lines = [
      line({ pick_line_id: 'a', confirmed_quantity: '6' }),
      line({ pick_line_id: 'b', confirmed_quantity: '4' }),
    ];
    const built = buildPackingLines(lines, new Set(['a', 'b']), '2.5');
    assert.ok(built.ok);
    assert.deepEqual(built.packingLines, [
      {
        sku: 'SKU-1',
        packed_qty: '6',
        lot_id: 'lot-1',
        carton_count: 1,
        actual_weight_kg: 2.5,
        label_ref: null,
      },
      {
        sku: 'SKU-1',
        packed_qty: '4',
        lot_id: 'lot-1',
        carton_count: 0,
        actual_weight_kg: null,
        label_ref: null,
      },
    ]);
  });

  it('refuses to build the body until every lot is packed and a weight is entered', () => {
    const lines = [line({ pick_line_id: 'a' }), line({ pick_line_id: 'b' })];
    assert.deepEqual(buildPackingLines(lines, new Set(['a']), '2.5'), {
      ok: false,
      reason: 'lines',
    });
    assert.deepEqual(buildPackingLines(lines, new Set(['a', 'b']), '  '), {
      ok: false,
      reason: 'weight',
    });
  });

  it('matches a scan to a not-yet-packed line and refuses unknown lots', () => {
    const lines = [
      line({ pick_line_id: 'a', confirmed_lot_number: 'L-1' }),
      line({ pick_line_id: 'b', confirmed_lot_number: 'L-2' }),
    ];
    assert.deepEqual(matchScan(lines, new Set(), ' L-1 '), { kind: 'packed', lineId: 'a' });
    assert.deepEqual(matchScan(lines, new Set(['a']), 'L-1'), { kind: 'already', lineId: 'a' });
    assert.deepEqual(matchScan(lines, new Set(['a']), 'L-99'), { kind: 'unknown' });
  });

  it('tracks the remaining lots and weight in the generate hint', () => {
    const lines = [line({ pick_line_id: 'a' }), line({ pick_line_id: 'b' })];
    assert.deepEqual(remainingHints(lines, new Set(['a']), '1'), {
      itemsToScan: 1,
      weightMissing: false,
    });
    assert.deepEqual(remainingHints(lines, new Set(['a', 'b']), ''), {
      itemsToScan: 0,
      weightMissing: true,
    });
  });

  it('auto-packs lot-less picked lines', () => {
    const lines = [
      line({ pick_line_id: 'a', confirmed_lot_number: null }),
      line({ pick_line_id: 'b' }),
    ];
    assert.deepEqual([...autoPackedKeys(lines)], ['a']);
  });

  it('canGenerate is true only when every lot is packed and a positive finite weight is entered', () => {
    const lines = [line({ pick_line_id: 'a' }), line({ pick_line_id: 'b' })];
    assert.equal(canGenerate(lines, new Set(['a']), '2.5'), false);
    assert.equal(canGenerate(lines, new Set(['a', 'b']), '2.5'), true);
    assert.equal(canGenerate(lines, new Set(['a', 'b']), ''), false);
  });

  it('rejects NaN, zero, negative and infinite weights', () => {
    const lines = [line({ pick_line_id: 'a' })];
    for (const bad of ['abc', '0', '-1', 'Infinity', '']) {
      assert.deepEqual(
        buildPackingLines(lines, new Set(['a']), bad),
        { ok: false, reason: 'weight' },
        `weight ${bad}`,
      );
    }
  });

  it('fails closed on a packed line with a null confirmed quantity', () => {
    const lines = [line({ pick_line_id: 'a', confirmed_quantity: null })];
    assert.deepEqual(buildPackingLines(lines, new Set(['a']), '2'), { ok: false, reason: 'lines' });
  });

  it('skips an already-packed match so a second line sharing the lot can be scanned in', () => {
    const lines = [
      line({ pick_line_id: 'a', confirmed_lot_number: 'L-1' }),
      line({ pick_line_id: 'b', confirmed_lot_number: 'L-1' }),
    ];
    assert.deepEqual(matchScan(lines, new Set(['a']), 'L-1'), { kind: 'packed', lineId: 'b' });
    assert.deepEqual(matchScan(lines, new Set(['a', 'b']), 'L-1'), {
      kind: 'already',
      lineId: 'a',
    });
  });

  it('derives the IRN coverage state', () => {
    assert.equal(irnCoverageState(true), 'ready');
    assert.equal(irnCoverageState(false), 'blocked');
    assert.equal(irnCoverageState(null), 'unknown');
  });

  it('gates printing on document content', () => {
    assert.equal(canPrintDocument('PACKING SLIP'), true);
    assert.equal(canPrintDocument(null), false);
  });
});
