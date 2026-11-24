import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  confirmPayload,
  directedLot,
  evaluateBin,
  evaluateLot,
  evaluateShortPick,
  isShortQuantity,
  nextLine,
  PICK_STEPS,
  quantityReady,
  shortPickPayload,
  taskComplete,
  type PickLineRow,
} from '../../src/components/pick-line-model.js';

/** Story 3.16 (AC 4, 5, 6): pure pick-line execution rules. */

const line = (over: Partial<PickLineRow> = {}): PickLineRow => ({
  pick_line_id: 'line-1',
  pick_task_id: 'task-1',
  dispatch_order_line_id: 'order-line-1',
  sku: 'SKU-1',
  directed_lot_id: 'lot-uuid-1',
  confirmed_lot_id: null,
  directed_quantity: '10.000',
  confirmed_quantity: null,
  location_id: 'loc-uuid-1',
  pick_sequence: 1,
  status: 'pending',
  capture_method: null,
  location_code: 'BIN-A-01',
  directed_lot_number: 'LOT-1',
  uom: 'EA',
  ...over,
});

describe('Story 3.16 pick-line model', () => {
  it('keeps the directed bin on step 1 when the wrong bin is scanned', () => {
    const result = evaluateBin('BIN-Z-99', line());
    assert.equal(result.ok, false);
    assert.equal(result.step, 'bin');
    assert.equal(result.messageKey, 'floor.wrongBin');
    assert.equal(result.messageParams?.code, 'BIN-Z-99');
  });

  it('advances to the lot step on a matching bin, case-insensitive', () => {
    const result = evaluateBin('bin-a-01', line());
    assert.equal(result.ok, true);
    assert.equal(result.step, 'lot');
  });

  it('blocks a held lot without advancing, online or offline', () => {
    const result = evaluateLot('LOT-HOLD', line(), 'LOT-HOLD');
    assert.equal(result.ok, false);
    assert.equal(result.step, 'lot');
    assert.equal(result.held, true);
    assert.equal(result.messageKey, 'floor.onHold');
  });

  it('does not instruct picking the directed lot when that lot itself is held', () => {
    const result = evaluateLot('LOT-1', line(), 'LOT-1');
    assert.equal(result.ok, false);
    assert.equal(result.step, 'lot');
    assert.equal(result.held, true);
    assert.equal(result.messageKey, 'floor.onHoldDirected');
    assert.equal(result.messageParams?.lot, 'LOT-1');
    assert.equal(result.messageParams?.directed, undefined);
  });

  it('names the directed lot on a wrong unheld lot, allows substitution, and stays on step 2', () => {
    const result = evaluateLot('LOT-OTHER', line(), null);
    assert.equal(result.ok, false);
    assert.equal(result.step, 'lot');
    assert.equal(result.canSubstitute, true);
    assert.equal(result.scannedLot, 'LOT-OTHER');
    assert.equal(result.messageKey, 'floor.wrongLot');
    assert.equal(result.messageParams?.lot, 'LOT-1');
  });

  it('advances to confirm when the directed lot is scanned', () => {
    const result = evaluateLot('lot-1', line(), null);
    assert.equal(result.ok, true);
    assert.equal(result.step, 'qty');
  });

  it('reads the directed lot number as the human lot code', () => {
    assert.equal(directedLot(line()), 'LOT-1');
  });

  it('gates the confirm on the quantity equalling the directed quantity', () => {
    assert.equal(quantityReady('10.000', line()), true);
    assert.equal(quantityReady('9.000', line()), false);
  });

  it('builds the pick_line.confirmed payload with PWA capture and optional override_reason', () => {
    const payload = confirmPayload({
      pickTaskId: 'task-1',
      pickLineId: 'line-1',
      confirmedLotId: 'lot-uuid-1',
      confirmedQuantity: '10.000',
    });
    assert.deepEqual(payload, {
      pick_task_id: 'task-1',
      pick_line_id: 'line-1',
      confirmed_lot_id: 'lot-uuid-1',
      confirmed_quantity: '10.000',
      capture_method: 'PWA',
    });

    const subPayload = confirmPayload({
      pickTaskId: 'task-1',
      pickLineId: 'line-1',
      confirmedLotId: 'lot-uuid-2',
      confirmedQuantity: '10.000',
      overrideReason: 'Different lot used',
    });
    assert.deepEqual(subPayload, {
      pick_task_id: 'task-1',
      pick_line_id: 'line-1',
      confirmed_lot_id: 'lot-uuid-2',
      confirmed_quantity: '10.000',
      override_reason: 'Different lot used',
      capture_method: 'PWA',
    });

    // Story 3.17 (Task 6.5): a lot substitution from the edge carries the scanned lot number
    // (confirmed_lot_id null); the server resolves it to a UUID for the SKU.
    const numSubPayload = confirmPayload({
      pickTaskId: 'task-1',
      pickLineId: 'line-1',
      confirmedLotId: null,
      confirmedQuantity: '10.000',
      directedLotNumber: 'LOT-SUB-2',
      overrideReason: 'Different lot used',
    });
    assert.deepEqual(numSubPayload, {
      pick_task_id: 'task-1',
      pick_line_id: 'line-1',
      confirmed_lot_id: null,
      confirmed_lot_number: 'LOT-SUB-2',
      confirmed_quantity: '10.000',
      override_reason: 'Different lot used',
      capture_method: 'PWA',
    });
  });

  it('builds the pick_line.short_picked payload with PWA capture', () => {
    const payload = shortPickPayload({
      pickTaskId: 'task-1',
      pickLineId: 'line-1',
      foundQuantity: '4.000',
      reason: 'LESS_IN_BIN',
    });
    assert.deepEqual(payload, {
      pick_task_id: 'task-1',
      pick_line_id: 'line-1',
      found_quantity: '4.000',
      reason: 'LESS_IN_BIN',
      capture_method: 'PWA',
    });

    const otherPayload = shortPickPayload({
      pickTaskId: 'task-1',
      pickLineId: 'line-1',
      foundQuantity: '0.000',
      reason: 'OTHER',
      note: 'Water damage on shelf',
    });
    assert.deepEqual(otherPayload, {
      pick_task_id: 'task-1',
      pick_line_id: 'line-1',
      found_quantity: '0.000',
      reason: 'OTHER',
      note: 'Water damage on shelf',
      capture_method: 'PWA',
    });
  });

  it('validates short pick quantity and reason states', () => {
    assert.equal(isShortQuantity('9.999', line()), true);
    assert.equal(isShortQuantity('0', line()), true);
    assert.equal(isShortQuantity('10.000', line()), false);
    assert.equal(isShortQuantity('12.000', line()), false);

    // Invalid quantity
    const invQty = evaluateShortPick('10.000', 'BIN_EMPTY', '', line());
    assert.equal(invQty.ready, false);
    assert.equal(invQty.footerKey, 'floor.short.invalidQuantity');

    // Missing reason
    const noReason = evaluateShortPick('5.000', null, '', line());
    assert.equal(noReason.ready, false);
    assert.equal(noReason.footerKey, 'floor.short.leftReason');

    // OTHER with empty note
    const noNote = evaluateShortPick('5.000', 'OTHER', '   ', line());
    assert.equal(noNote.ready, false);
    assert.equal(noNote.footerKey, 'floor.short.leftNote');

    // Valid cases
    const readyOther = evaluateShortPick('5.000', 'OTHER', 'Found damaged packaging', line());
    assert.equal(readyOther.ready, true);
    assert.equal(readyOther.footerKey, 'floor.short.ready');

    const readyBinEmpty = evaluateShortPick('0', 'BIN_EMPTY', '', line());
    assert.equal(readyBinEmpty.ready, true);
    assert.equal(readyBinEmpty.footerKey, 'floor.short.ready');
  });

  it('recognises completion when active lines are confirmed or short', () => {
    assert.equal(taskComplete([line({ status: 'pending' })]), false);
    assert.equal(taskComplete([line({ status: 'confirmed' }), line({ status: 'confirmed' })]), true);
    assert.equal(taskComplete([line({ status: 'confirmed' }), line({ status: 'short' })]), true);
    assert.equal(taskComplete([line({ status: 'short' }), line({ status: 'short' })]), true);
    assert.equal(
      taskComplete([line({ status: 'short' }), line({ status: 'cancelled' })]),
      true,
    );
    assert.equal(taskComplete([]), false);
  });

  it('walks to the next pending line in pick-path order', () => {
    const confirmed = line({ status: 'confirmed' });
    const pending = line({ status: 'pending', pick_sequence: 2, pick_line_id: 'line-2' });
    assert.equal(nextLine([pending, confirmed])?.pick_line_id, 'line-2');
    assert.equal(nextLine([confirmed, confirmed]), null);
  });

  it('keeps the three-step vocabulary in order', () => {
    assert.deepEqual(PICK_STEPS, ['bin', 'lot', 'qty']);
  });
});
