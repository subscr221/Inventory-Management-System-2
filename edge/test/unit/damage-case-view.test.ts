import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DAMAGE_ACTION_NAMES,
  WORKBENCH_GROUPS,
  actionPath,
  concurredCount,
  groupWorkbench,
  isDamageReport,
  isExternalCheckOverdue,
  panelsFor,
  type DamageReport,
} from '../../src/components/damage-case-view';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TODAY = '2026-09-27';

let counter = 0;
function report(overrides: Partial<DamageReport> = {}): DamageReport {
  counter += 1;
  return {
    report_id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    report_number: `DMG-2026-${String(counter).padStart(4, '0')}`,
    site_id: 'site',
    reporter_user_id: OTHER,
    reported_at: '2026-09-27T08:00:00.000Z',
    source: 'report',
    sku: 'PCB-CTRL-01',
    quantity: '4',
    status: 'on_hold',
    physical_state: 'in_qc_hold',
    hold_mode: 'quarantined',
    whole_lot_requested: false,
    whole_lot_decision: null,
    qc_key_status: 'pending',
    finance_key_status: 'pending',
    ...overrides,
  };
}

function groupsOf(reports: DamageReport[], caller = ME) {
  return Object.fromEntries(
    groupWorkbench(reports, caller, TODAY).map((g) => [g.group, g.reports.map((r) => r.report_number)]),
  );
}

describe('Story 8.9 Table 11 workbench grouping', () => {
  it('has the eight groups in the fixed order', () => {
    assert.deepEqual(WORKBENCH_GROUPS, [
      'to_inspect',
      'whole_lot',
      'awaiting_your_key',
      'sent_on',
      'with_ceo',
      'record_erp',
      'units_to_move',
      'closed',
    ]);
  });

  it('places each case by status, the caller key and custody', () => {
    const onHold = report({ status: 'on_hold', physical_state: 'awaiting_arrival' });
    const wholeLot = report({ status: 'on_hold', whole_lot_requested: true });
    const wholeLotDecided = report({
      status: 'on_hold',
      whole_lot_requested: true,
      whole_lot_decision: 'keep_local',
    });
    const mineToTurn = report({ status: 'awaiting_keys', qc_key_status: 'turned', qc_key_user_id: OTHER });
    const iTurned = report({ status: 'awaiting_keys', finance_key_status: 'turned', finance_key_user_id: ME });
    const escalatedMine = report({ status: 'escalated', qc_key_status: 'turned', qc_key_user_id: ME });
    const escalatedCeo = report({ status: 'escalated', qc_key_user_id: OTHER });
    const final = report({ status: 'outcome_final' });
    const out = report({
      status: 'awaiting_keys',
      physical_state: 'at_external_check',
      external_expected_return_date: '2026-09-30',
    });
    const overdue = report({
      status: 'awaiting_keys',
      physical_state: 'at_external_check',
      external_expected_return_date: '2026-09-20',
    });
    const cleared = report({ status: 'cleared' });
    const closedAccepted = report({ status: 'closed', final_outcome: 'accept_as_is_price_reduction' });
    const closedWriteOff = report({ status: 'closed', final_outcome: 'write_off' });
    const recordOnly = report({ status: 'cleared', hold_mode: 'record_only', physical_state: 'with_reporter' });

    const groups = groupsOf([
      onHold,
      wholeLot,
      wholeLotDecided,
      mineToTurn,
      iTurned,
      escalatedMine,
      escalatedCeo,
      final,
      out,
      overdue,
      cleared,
      closedAccepted,
      closedWriteOff,
      recordOnly,
    ]);
    assert.deepEqual(groups['to_inspect'], [
      onHold.report_number,
      wholeLot.report_number,
      wholeLotDecided.report_number,
    ]);
    assert.deepEqual(groups['whole_lot'], [wholeLot.report_number]);
    assert.deepEqual(groups['awaiting_your_key'], [
      mineToTurn.report_number,
      out.report_number,
      overdue.report_number,
    ]);
    assert.deepEqual(groups['sent_on'], [iTurned.report_number, escalatedMine.report_number]);
    assert.deepEqual(groups['with_ceo'], [escalatedCeo.report_number]);
    assert.deepEqual(groups['record_erp'], [final.report_number]);
    // Overdue external checks first, then arrivals and the rest in list order.
    assert.deepEqual(groups['units_to_move'], [
      overdue.report_number,
      onHold.report_number,
      out.report_number,
      cleared.report_number,
      closedAccepted.report_number,
    ]);
    assert.deepEqual(groups['closed'], [
      cleared.report_number,
      closedAccepted.report_number,
      closedWriteOff.report_number,
      recordOnly.report_number,
    ]);
  });

  it('returns every group, empty ones included, so the screen decides what to hide', () => {
    assert.deepEqual(
      groupWorkbench([], ME, TODAY).map((g) => [g.group, g.reports.length]),
      WORKBENCH_GROUPS.map((g) => [g, 0]),
    );
  });

  it('marks an external check overdue only after its expected return date', () => {
    const base = { status: 'awaiting_keys' as const, physical_state: 'at_external_check' };
    assert.equal(isExternalCheckOverdue(report({ ...base, external_expected_return_date: '2026-09-26' }), TODAY), true);
    assert.equal(isExternalCheckOverdue(report({ ...base, external_expected_return_date: '2026-09-27' }), TODAY), false);
    assert.equal(isExternalCheckOverdue(report({ ...base, external_expected_return_date: null }), TODAY), false);
    assert.equal(
      isExternalCheckOverdue(report({ physical_state: 'in_qc_hold', external_expected_return_date: '2026-01-01' }), TODAY),
      false,
    );
  });

  it('counts concurred keys', () => {
    assert.equal(concurredCount(report()), 0);
    assert.equal(concurredCount(report({ qc_key_status: 'turned' })), 1);
    assert.equal(concurredCount(report({ qc_key_status: 'turned', finance_key_status: 'turned' })), 2);
    assert.equal(concurredCount(report({ qc_key_status: 'turned', finance_key_status: 'disagreed' })), 1);
  });
});

describe('Story 8.9 allowed_actions to panels (the server decides, the edge renders)', () => {
  it('knows the fourteen action names of Table 11', () => {
    assert.deepEqual(DAMAGE_ACTION_NAMES, [
      'inspect',
      'decide_whole_lot',
      'mark_arrived',
      'send_external',
      'mark_returned',
      'mark_returned_to_stock',
      'turn_qc_key',
      'withdraw_qc_key',
      'disagree_qc',
      'turn_finance_key',
      'withdraw_finance_key',
      'disagree_finance',
      'decide_escalation',
      'record_outcome',
    ]);
  });

  it('maps allowed actions to panels in case-panel order and ignores unknown names', () => {
    assert.deepEqual(panelsFor([]), []);
    assert.deepEqual(panelsFor(['inspect', 'mark_arrived']), ['custody', 'inspection']);
    assert.deepEqual(panelsFor(['record_outcome', 'decide_whole_lot', 'bogus']), ['whole_lot', 'outcome']);
    assert.deepEqual(panelsFor(['turn_finance_key', 'disagree_finance']), ['keys']);
    assert.deepEqual(panelsFor(['withdraw_qc_key']), ['keys']);
    assert.deepEqual(panelsFor(['decide_escalation']), ['escalation']);
    assert.deepEqual(panelsFor(['send_external', 'mark_returned', 'mark_returned_to_stock']), ['custody']);
  });

  it('posts each action to its route', () => {
    const id = 'abc';
    const expected: Record<string, string> = {
      inspect: 'inspection',
      decide_whole_lot: 'whole-lot',
      mark_arrived: 'custody/arrived',
      send_external: 'custody/sent-external',
      mark_returned: 'custody/returned',
      mark_returned_to_stock: 'custody/returned-to-stock',
      turn_qc_key: 'keys/qc/turn',
      withdraw_qc_key: 'keys/qc/withdraw',
      disagree_qc: 'keys/qc/disagree',
      turn_finance_key: 'keys/finance/turn',
      withdraw_finance_key: 'keys/finance/withdraw',
      disagree_finance: 'keys/finance/disagree',
      decide_escalation: 'escalation/decide',
      record_outcome: 'outcome',
    };
    for (const name of DAMAGE_ACTION_NAMES) {
      assert.equal(actionPath(id, name), `/api/v1/damage-reports/${id}/${expected[name]}`);
    }
  });

  it('rejects a malformed report before it reaches a React key', () => {
    assert.equal(isDamageReport(report()), true);
    assert.equal(isDamageReport({ ...report(), report_id: 7 }), false);
    assert.equal(isDamageReport({ ...report(), reported_at: 'not a date' }), false);
    assert.equal(isDamageReport(null), false);
  });
});
