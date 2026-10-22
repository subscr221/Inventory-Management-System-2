import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  confirmPayload,
  directedLot,
  evaluateBin,
  evaluateLot,
  nextLine,
  PICK_STEPS,
  quantityReady,
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

  it('names the directed lot on a wrong unheld lot and stays on step 2', () => {
    const result = evaluateLot('LOT-OTHER', line(), null);
    assert.equal(result.ok, false);
    assert.equal(result.step, 'lot');
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

  it('builds the pick_line.confirmed payload with PWA capture', () => {
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
  });

  it('recognises completion only when every active line is confirmed', () => {
    assert.equal(taskComplete([line({ status: 'pending' })]), false);
    assert.equal(taskComplete([line({ status: 'confirmed' }), line({ status: 'confirmed' })]), true);
    assert.equal(
      taskComplete([line({ status: 'confirmed' }), line({ status: 'cancelled' })]),
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
