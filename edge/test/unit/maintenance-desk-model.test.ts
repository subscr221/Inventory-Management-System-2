import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  attentionCounts,
  canReject,
  canResolveConflict,
  canSign,
  classifyBoard,
  disabledReason,
  firstWarrantyCard,
  hitListLimit,
  priorityLabel,
  type AssetStatusRow,
  type FaultRow,
  type OverrideRow,
  type WorkOrderRow,
} from '../../src/components/maintenance-desk-model';

const fault = (id: string, status: FaultRow['status'] = 'reported'): FaultRow => ({
  fault_report_id: id,
  asset_id: `a-${id}`,
  asset_tag: `TAG-${id}`,
  description: 'x',
  safety_flag: false,
  status,
});
const wo = (
  id: string,
  status: WorkOrderRow['status'],
  extra: Partial<WorkOrderRow> = {},
): WorkOrderRow => ({
  work_order_id: id,
  asset_id: `a-${id}`,
  asset_tag: `TAG-${id}`,
  status,
  priority: null,
  warranty_flagged: false,
  status_note: null,
  fault_report_id: null,
  ...extra,
});
const st = (id: string, status: AssetStatusRow['status']): AssetStatusRow => ({
  asset_id: `a-${id}`,
  status,
});

describe('Story 7.11 desk model', () => {
  const groups = classifyBoard(
    [fault('f1'), fault('f2', 'accepted')],
    [
      wo('w1', 'open'),
      wo('w2', 'overdue'),
      wo('w3', 'in_progress'),
      wo('w4', 'on_hold', { status_note: 'Waiting bearing' }),
      wo('w5', 'completed'),
      wo('w6', 'completed'),
      wo('w7', 'completed'),
    ],
    [st('w5', 'breakdown'), st('w6', 'maintenance'), st('w7', 'running')],
  );

  it('classifies the five groups', () => {
    assert.deepEqual(
      groups.triage.map((c) => c.id),
      ['f1'],
    );
    assert.deepEqual(
      groups.assigned.map((c) => c.id),
      ['w1', 'w2'],
    );
    assert.deepEqual(
      groups.progress.map((c) => c.id),
      ['w3'],
    );
    assert.deepEqual(
      groups.waiting.map((c) => c.id),
      ['w4'],
    );
    // Completed work orders whose asset is back to running are not awaiting a signature.
    assert.deepEqual(
      groups.done.map((c) => c.id),
      ['w5', 'w6'],
    );
  });

  it('titles cards by asset tag', () => {
    assert.equal(groups.triage[0]!.title, 'TAG-f1');
    assert.equal(groups.assigned[0]!.title, 'TAG-w1');
  });

  it('counts attention buttons; a warranty pill needs a flagged work order with no override', () => {
    const flagged = classifyBoard(
      [],
      [wo('w1', 'open', { warranty_flagged: true }), wo('w2', 'open', { warranty_flagged: true })],
      [],
    );
    const overrides = new Map<string, OverrideRow | null>([
      ['w1', null],
      ['w2', { reason_code: 'X', overridden_by: 'u', overridden_at: '2026-11-22T00:00:00Z' }],
    ]);
    assert.deepEqual(attentionCounts(flagged, 3, overrides), {
      awaitingSignature: 0,
      syncConflicts: 3,
      warrantyFlagged: 1,
    });
    assert.equal(firstWarrantyCard(flagged, overrides)?.id, 'w1');
    assert.equal(firstWarrantyCard(groups, new Map()), null);
    assert.equal(attentionCounts(groups, 0, new Map()).awaitingSignature, 2);
  });

  it('gates actions: offline wins over busy, and every action needs its precondition', () => {
    assert.equal(disabledReason(false, true), 'offline');
    assert.equal(disabledReason(true, true), 'busy');
    assert.equal(disabledReason(true, false), null);
    assert.equal(canReject('   '), false);
    assert.equal(canReject(' broken '), true);
    assert.equal(canSign([true, true, false]), false);
    assert.equal(canSign([true, true, true]), true);
    assert.equal(canResolveConflict(null, ''), false);
    assert.equal(canResolveConflict('discarded', 'a'.repeat(1000)), true);
    assert.equal(canResolveConflict('discarded', 'a'.repeat(1001)), false);
  });

  it('flags a full list and formats priority', () => {
    assert.equal(hitListLimit([499, 500]), true);
    assert.equal(hitListLimit([10]), false);
    assert.equal(priorityLabel('p2'), 'P2');
    assert.equal(priorityLabel(null), null);
  });
});
