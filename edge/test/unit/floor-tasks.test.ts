import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInbox,
  mergeTasks,
  pillKeyFor,
  type PickTaskRow,
} from '../../src/components/floor-tasks-model.js';

/** Story 3.16 (AC 2): pure inbox merge, ownership ordering and pill keys. */

const row = (over: Partial<PickTaskRow>): PickTaskRow => ({
  pick_task_id: 'task-1',
  dispatch_order_id: 'order-1',
  so_number_ext: 'SO-1',
  status: 'pending',
  assigned_to: null,
  confirmed_line_count: 0,
  line_count: 2,
  ...over,
});

describe('Story 3.16 floor-tasks model', () => {
  it('merges the pending and in_progress reads, in_progress winning on ties', () => {
    const merged = mergeTasks(
      [row({ pick_task_id: 't1', status: 'pending' }), row({ pick_task_id: 't2', status: 'pending' })],
      [row({ pick_task_id: 't1', status: 'in_progress' })],
    );
    assert.deepEqual(
      merged.map((r) => [r.pick_task_id, r.status]),
      [
        ['t1', 'in_progress'],
        ['t2', 'pending'],
      ],
    );
  });

  it('orders the caller first, then unassigned, and hides someone else assignments', () => {
    const inbox = buildInbox(
      [
        row({ pick_task_id: 'other', assigned_to: 'user-b' }),
        row({ pick_task_id: 'unassigned', assigned_to: null }),
        row({ pick_task_id: 'mine', assigned_to: 'me' }),
      ],
      'me',
    );
    assert.deepEqual(
      inbox.map((r) => r.pick_task_id),
      ['mine', 'unassigned'],
    );
  });

  it('picks the In progress pill only when the task is in_progress', () => {
    assert.equal(pillKeyFor('in_progress'), 'floor.pill.inProgress');
    assert.equal(pillKeyFor('pending'), 'floor.pill.pending');
  });
});
