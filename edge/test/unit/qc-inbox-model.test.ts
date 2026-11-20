import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupQcInbox,
  localDateString,
  mergeQcTasks,
  resolveScannedLot,
  type QcTaskListItem,
} from '../../src/components/qc-inbox-model';

const task = (
  overrides: Partial<QcTaskListItem> & Pick<QcTaskListItem, 'task_id' | 'lot_number'>,
): QcTaskListItem => ({
  task_id: overrides.task_id,
  lot_id: overrides.lot_id ?? `lot-${overrides.task_id}`,
  lot_number: overrides.lot_number,
  sku: overrides.sku ?? 'SKU-1',
  quantity: overrides.quantity ?? '10',
  uom: overrides.uom ?? 'EA',
  site_id: overrides.site_id ?? 'site-1',
  source_completion_type: overrides.source_completion_type ?? 'goods_receipt',
  task_status: overrides.task_status ?? 'open',
  gate_status: overrides.gate_status ?? 'qc_hold',
  disposition: overrides.disposition ?? null,
  disposition_at: overrides.disposition_at ?? null,
  released_at: overrides.released_at ?? null,
  ...(overrides.inspect_on_opening !== undefined
    ? { inspect_on_opening: overrides.inspect_on_opening }
    : {}),
});

describe('Story 8.11 QC inbox model', () => {
  it('groups the five buckets in AC 2 order with scalar sentOnCount', () => {
    const today = localDateString(new Date());
    const groups = groupQcInbox(
      [
        task({ task_id: 'a', lot_number: 'LOT-1', gate_status: 'qc_hold', task_status: 'open' }),
        task({
          task_id: 'b',
          lot_number: 'LOT-2',
          gate_status: 'qc_hold',
          task_status: 'sampling_determined',
        }),
        task({ task_id: 'c', lot_number: 'LOT-3', task_status: 'inspected', disposition: null }),
        task({
          task_id: 'd',
          lot_number: 'LOT-4',
          task_status: 'inspected',
          gate_status: 'accepted',
          disposition: 'accept',
          disposition_at: `${today}T10:00:00.000Z`,
          released_at: `${today}T10:01:00.000Z`,
        }),
      ],
      {
        toInspect: [{ report_id: 'r1', lot_number: 'LOT-9', whole_lot_requested: false }],
        wholeLot: [{ report_id: 'r2', lot_number: 'LOT-8', whole_lot_requested: true }],
        sentOnCount: 3,
      },
      today,
    );
    assert.deepEqual(
      groups.map((g) => g.group),
      ['bay', 'damage', 'awaitingDisposition', 'sentOn', 'doneToday'],
    );
    assert.deepEqual(
      groups.find((g) => g.group === 'bay')!.tasks.map((t) => t.task_id),
      ['a', 'b'],
    );
    assert.equal(groups.find((g) => g.group === 'damage')!.damage.length, 2);
    assert.deepEqual(
      groups.find((g) => g.group === 'awaitingDisposition')!.tasks.map((t) => t.task_id),
      ['c'],
    );
    const sentOn = groups.find((g) => g.group === 'sentOn')!;
    assert.equal(sentOn.sentOnCount, 3);
    assert.equal(sentOn.damage.length, 0);
    assert.deepEqual(
      groups.find((g) => g.group === 'doneToday')!.tasks.map((t) => t.task_id),
      ['d'],
    );
  });

  it('clamps negative sentOnCount to 0 and keeps disposed tasks out of Awaiting disposition', () => {
    const groups = groupQcInbox(
      [task({ task_id: 'x', lot_number: 'LOT-X', task_status: 'inspected', disposition: 'reject' })],
      { toInspect: [], wholeLot: [], sentOnCount: -4 },
      localDateString(new Date()),
    );
    assert.equal(groups.find((g) => g.group === 'awaitingDisposition')!.tasks.length, 0);
    assert.equal(groups.find((g) => g.group === 'sentOn')!.sentOnCount, 0);
  });

  it('merges scoped task lists without duplicates and resolves scanned lot numbers', () => {
    const a = task({ task_id: 'a', lot_number: 'LOT-1' });
    const b = task({ task_id: 'b', lot_number: 'LOT-2' });
    const merged = mergeQcTasks([[a], [a, b]]);
    assert.deepEqual(
      merged.map((t) => t.task_id),
      ['a', 'b'],
    );
    assert.equal(resolveScannedLot(merged, '  LOT-2  ')?.task_id, 'b');
    assert.equal(resolveScannedLot(merged, 'LOT-3'), null);
    assert.equal(resolveScannedLot(merged, '   '), null);
  });

  it('computes the local date as YYYY-MM-DD', () => {
    assert.match(localDateString(new Date('2026-11-20T23:59:00Z')), /^\d{4}-\d{2}-\d{2}$/);
  });
});
