import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../src/middleware/error.js';
import {
  DAMAGE_REASON_CODES,
  DAMAGE_OUTCOMES,
  MAX_DAMAGE_NOTE_LENGTH,
  RECEIPT_CONDITION_TO_DAMAGE_REASON,
} from '../../src/compliance/damage-reasons.js';
import {
  assertDamageReason,
  assertDamageOutcome,
  assertInspectable,
  assertWholeLotDecidable,
  assertKeyActionState,
  assertKeySeparation,
  planKeyTurn,
  assertKeyWithdrawable,
  assertEscalationDecidable,
  assertOutcomeRecordable,
  nextPhysicalState,
  heldQuantity,
  type DamageCaseState,
} from '../../src/compliance/damage.js';

const REPORTER = '00000000-0000-4000-8000-000000000001';
const QC_HEAD = '00000000-0000-4000-8000-000000000002';
const FINANCE = '00000000-0000-4000-8000-000000000003';
const CEO = '00000000-0000-4000-8000-000000000004';

function pendingKey(): DamageCaseState['qc_key'] {
  return { status: 'pending', user_id: null, outcome: null, price_reduction_pct: null };
}

function baseCase(overrides: Partial<DamageCaseState> = {}): DamageCaseState {
  return {
    status: 'on_hold',
    physical_state: 'awaiting_arrival',
    hold_mode: 'quarantined',
    quantity: '4',
    confirmed_quantity: null,
    reporter_user_id: REPORTER,
    whole_lot_requested: false,
    whole_lot_decision: null,
    qc_key: pendingKey(),
    finance_key: pendingKey(),
    final_outcome: null,
    ...overrides,
  };
}

function throwsCode(fn: () => unknown, code: string, status?: number): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    assert.strictEqual(err.errorCode, code);
    if (status !== undefined) assert.strictEqual(err.statusCode, status);
    return true;
  });
}

describe('Story 8.9 damage catalogues (Tables 5 and 6)', () => {
  it('the reason catalogue is exactly the four codes', () => {
    assert.deepStrictEqual(
      [...DAMAGE_REASON_CODES],
      ['DEAD_ON_ARRIVAL', 'DAMAGED_COMPONENT', 'WRONG_ITEM_OR_SPEC', 'OTHER'],
    );
    assert.strictEqual(MAX_DAMAGE_NOTE_LENGTH, 200);
  });

  it('the outcome catalogue is exactly the four outcomes', () => {
    assert.deepStrictEqual(
      [...DAMAGE_OUTCOMES],
      ['debit_note', 'return_for_replacement', 'write_off', 'accept_as_is_price_reduction'],
    );
  });

  it('receipt conditions map DAMAGED and REJECTED only', () => {
    assert.deepStrictEqual(
      [...RECEIPT_CONDITION_TO_DAMAGE_REASON.entries()],
      [
        ['DAMAGED', 'DAMAGED_COMPONENT'],
        ['REJECTED', 'WRONG_ITEM_OR_SPEC'],
      ],
    );
  });
});

describe('Story 8.9 reason rule', () => {
  it('accepts every non-OTHER code without a note', () => {
    for (const code of ['DEAD_ON_ARRIVAL', 'DAMAGED_COMPONENT', 'WRONG_ITEM_OR_SPEC']) {
      assert.deepStrictEqual(assertDamageReason(code, null), {
        reason_code: code,
        reason_note: null,
      });
      assert.deepStrictEqual(assertDamageReason(code, undefined), {
        reason_code: code,
        reason_note: null,
      });
    }
  });

  it('OTHER requires a one-line note of at most 200 characters', () => {
    throwsCode(() => assertDamageReason('OTHER', null), 'DAMAGE_OTHER_NOTE_REQUIRED', 400);
    throwsCode(() => assertDamageReason('OTHER', '   '), 'DAMAGE_OTHER_NOTE_REQUIRED', 400);
    assert.deepStrictEqual(assertDamageReason('OTHER', '  bent pins  '), {
      reason_code: 'OTHER',
      reason_note: 'bent pins',
    });
    assert.deepStrictEqual(
      assertDamageReason('OTHER', 'x'.repeat(200)).reason_note,
      'x'.repeat(200),
    );
    throwsCode(() => assertDamageReason('OTHER', 'x'.repeat(201)), 'DAMAGE_REASON_INVALID', 400);
    throwsCode(() => assertDamageReason('OTHER', 'line one\nline two'), 'DAMAGE_REASON_INVALID');
  });

  it('a note on a non-OTHER code, or an unknown code, is refused', () => {
    throwsCode(() => assertDamageReason('DAMAGED_COMPONENT', 'cracked'), 'DAMAGE_REASON_INVALID');
    throwsCode(() => assertDamageReason('BROKEN', null), 'DAMAGE_REASON_INVALID');
    throwsCode(() => assertDamageReason(undefined, null), 'DAMAGE_REASON_INVALID');
  });
});

describe('Story 8.9 outcome and price-reduction pairing', () => {
  it('the three plain outcomes refuse a price reduction', () => {
    for (const outcome of ['debit_note', 'return_for_replacement', 'write_off']) {
      assert.deepStrictEqual(assertDamageOutcome(outcome, null), {
        outcome,
        price_reduction_pct: null,
      });
      throwsCode(() => assertDamageOutcome(outcome, '10'), 'DAMAGE_OUTCOME_INVALID', 400);
    }
  });

  it('accept as-is requires a percentage above 0 and at most 100', () => {
    throwsCode(
      () => assertDamageOutcome('accept_as_is_price_reduction', null),
      'DAMAGE_OUTCOME_INVALID',
    );
    throwsCode(
      () => assertDamageOutcome('accept_as_is_price_reduction', '0'),
      'DAMAGE_OUTCOME_INVALID',
    );
    throwsCode(
      () => assertDamageOutcome('accept_as_is_price_reduction', '0.000'),
      'DAMAGE_OUTCOME_INVALID',
    );
    throwsCode(
      () => assertDamageOutcome('accept_as_is_price_reduction', '100.01'),
      'DAMAGE_OUTCOME_INVALID',
    );
    throwsCode(
      () => assertDamageOutcome('accept_as_is_price_reduction', '-5'),
      'DAMAGE_OUTCOME_INVALID',
    );
    throwsCode(
      () => assertDamageOutcome('accept_as_is_price_reduction', 12),
      'DAMAGE_OUTCOME_INVALID',
    );
    assert.deepStrictEqual(assertDamageOutcome('accept_as_is_price_reduction', '100'), {
      outcome: 'accept_as_is_price_reduction',
      price_reduction_pct: '100',
    });
    assert.deepStrictEqual(assertDamageOutcome('accept_as_is_price_reduction', '12.5'), {
      outcome: 'accept_as_is_price_reduction',
      price_reduction_pct: '12.5',
    });
  });

  it('an unknown outcome is refused', () => {
    throwsCode(() => assertDamageOutcome('scrap', null), 'DAMAGE_OUTCOME_INVALID');
  });
});

describe('Story 8.9 case status machine (Table 3)', () => {
  it('inspection only on on_hold; 0 clears, above 0 awaits keys, above reported refused', () => {
    assert.strictEqual(assertInspectable(baseCase(), '0'), 'cleared');
    assert.strictEqual(assertInspectable(baseCase(), '3'), 'awaiting_keys');
    assert.strictEqual(assertInspectable(baseCase(), '4'), 'awaiting_keys');
    throwsCode(() => assertInspectable(baseCase(), '4.001'), 'DAMAGE_QUANTITY_INVALID', 400);
    throwsCode(() => assertInspectable(baseCase(), '-1'), 'DAMAGE_QUANTITY_INVALID', 400);
    for (const status of [
      'cleared',
      'awaiting_keys',
      'escalated',
      'outcome_final',
      'closed',
    ] as const) {
      throwsCode(
        () => assertInspectable(baseCase({ status }), '1'),
        'DAMAGE_CASE_STATE_INVALID',
        409,
      );
    }
  });

  it('the whole-lot decision needs a pending request and an on_hold, cleared or awaiting_keys case', () => {
    throwsCode(() => assertWholeLotDecidable(baseCase()), 'DAMAGE_WHOLE_LOT_NOT_PENDING', 409);
    for (const status of ['on_hold', 'cleared', 'awaiting_keys'] as const) {
      assertWholeLotDecidable(baseCase({ status, whole_lot_requested: true }));
    }
    throwsCode(
      () =>
        assertWholeLotDecidable(
          baseCase({ whole_lot_requested: true, whole_lot_decision: 'keep_local' }),
        ),
      'DAMAGE_WHOLE_LOT_NOT_PENDING',
    );
    for (const status of ['escalated', 'outcome_final', 'closed'] as const) {
      throwsCode(
        () => assertWholeLotDecidable(baseCase({ status, whole_lot_requested: true })),
        'DAMAGE_CASE_STATE_INVALID',
      );
    }
  });

  it('key actions: state invalid before inspection, locked after both keys or escalation', () => {
    for (const status of ['on_hold', 'cleared'] as const) {
      throwsCode(
        () => assertKeyActionState(baseCase({ status }), 'turn'),
        'DAMAGE_CASE_STATE_INVALID',
        409,
      );
    }
    for (const status of ['escalated', 'outcome_final', 'closed'] as const) {
      for (const action of ['turn', 'withdraw', 'disagree'] as const) {
        throwsCode(
          () => assertKeyActionState(baseCase({ status }), action),
          'DAMAGE_CASE_LOCKED',
          409,
        );
      }
    }
    assertKeyActionState(baseCase({ status: 'awaiting_keys' }), 'turn');
  });

  it('either key goes first; the second must name the same outcome', () => {
    const awaiting = baseCase({ status: 'awaiting_keys', confirmed_quantity: '3' });
    const first = planKeyTurn(awaiting, 'finance', FINANCE, 'write_off', null);
    assert.deepStrictEqual(first, { status: 'awaiting_keys', final_outcome: null });
    const afterFinance = baseCase({
      status: 'awaiting_keys',
      confirmed_quantity: '3',
      finance_key: {
        status: 'turned',
        user_id: FINANCE,
        outcome: 'write_off',
        price_reduction_pct: null,
      },
    });
    throwsCode(
      () => planKeyTurn(afterFinance, 'qc', QC_HEAD, 'debit_note', null),
      'DAMAGE_OUTCOME_MISMATCH',
      409,
    );
    assert.deepStrictEqual(planKeyTurn(afterFinance, 'qc', QC_HEAD, 'write_off', null), {
      status: 'outcome_final',
      final_outcome: 'write_off',
    });
    throwsCode(
      () => planKeyTurn(afterFinance, 'finance', FINANCE, 'write_off', null),
      'DAMAGE_KEY_ALREADY_TURNED',
      409,
    );
  });

  it('the price reduction must match too when accepting as-is', () => {
    const afterQc = baseCase({
      status: 'awaiting_keys',
      qc_key: {
        status: 'turned',
        user_id: QC_HEAD,
        outcome: 'accept_as_is_price_reduction',
        price_reduction_pct: '10',
      },
    });
    throwsCode(
      () => planKeyTurn(afterQc, 'finance', FINANCE, 'accept_as_is_price_reduction', '12'),
      'DAMAGE_OUTCOME_MISMATCH',
    );
    assert.deepStrictEqual(
      planKeyTurn(afterQc, 'finance', FINANCE, 'accept_as_is_price_reduction', '10.0'),
      { status: 'outcome_final', final_outcome: 'accept_as_is_price_reduction' },
    );
  });

  it('withdraw only by the key holder, only after turning, only before both keys', () => {
    const afterQc = baseCase({
      status: 'awaiting_keys',
      qc_key: {
        status: 'turned',
        user_id: QC_HEAD,
        outcome: 'write_off',
        price_reduction_pct: null,
      },
    });
    assertKeyWithdrawable(afterQc, 'qc', QC_HEAD);
    throwsCode(() => assertKeyWithdrawable(afterQc, 'qc', FINANCE), 'APPROVAL_REQUIRED', 403);
    throwsCode(
      () => assertKeyWithdrawable(afterQc, 'finance', FINANCE),
      'DAMAGE_KEY_NOT_TURNED',
      409,
    );
  });

  it('escalation is decided only in escalated; outcome recorded only in outcome_final with units in', () => {
    assertEscalationDecidable(baseCase({ status: 'escalated' }), CEO);
    throwsCode(
      () => assertEscalationDecidable(baseCase({ status: 'awaiting_keys' }), CEO),
      'DAMAGE_CASE_STATE_INVALID',
    );
    assertOutcomeRecordable(baseCase({ status: 'outcome_final', physical_state: 'in_qc_hold' }));
    throwsCode(
      () => assertOutcomeRecordable(baseCase({ status: 'awaiting_keys' })),
      'DAMAGE_CASE_STATE_INVALID',
    );
    throwsCode(
      () =>
        assertOutcomeRecordable(
          baseCase({ status: 'outcome_final', physical_state: 'at_external_check' }),
        ),
      'DAMAGE_UNITS_OUT',
      409,
    );
  });
});

describe('Story 8.9 separation of duties (D10)', () => {
  it('the reporter never turns a key or decides the whole lot or the escalation', () => {
    const awaiting = baseCase({ status: 'awaiting_keys' });
    throwsCode(() => assertKeySeparation(awaiting, 'qc', REPORTER), 'SOD_VIOLATION', 403);
    throwsCode(
      () => assertEscalationDecidable(baseCase({ status: 'escalated' }), REPORTER),
      'SOD_VIOLATION',
      403,
    );
  });

  it('the two keys are two different people', () => {
    const afterQc = baseCase({
      status: 'awaiting_keys',
      qc_key: {
        status: 'turned',
        user_id: QC_HEAD,
        outcome: 'write_off',
        price_reduction_pct: null,
      },
    });
    throwsCode(() => assertKeySeparation(afterQc, 'finance', QC_HEAD), 'SOD_VIOLATION', 403);
    assertKeySeparation(afterQc, 'finance', FINANCE);
  });

  it('the escalation decider is neither key holder', () => {
    const escalated = baseCase({
      status: 'escalated',
      qc_key: {
        status: 'turned',
        user_id: QC_HEAD,
        outcome: 'write_off',
        price_reduction_pct: null,
      },
      finance_key: {
        status: 'disagreed',
        user_id: FINANCE,
        outcome: 'debit_note',
        price_reduction_pct: null,
      },
    });
    throwsCode(() => assertEscalationDecidable(escalated, QC_HEAD), 'SOD_VIOLATION');
    throwsCode(() => assertEscalationDecidable(escalated, FINANCE), 'SOD_VIOLATION');
    assertEscalationDecidable(escalated, CEO);
  });
});

describe('Story 8.9 physical custody machine (Table 4)', () => {
  it('each mark is legal only from its listed states', () => {
    assert.strictEqual(nextPhysicalState(baseCase(), 'arrive'), 'in_qc_hold');
    assert.strictEqual(
      nextPhysicalState(baseCase({ physical_state: 'with_reporter' }), 'arrive'),
      'in_qc_hold',
    );
    assert.strictEqual(
      nextPhysicalState(baseCase({ physical_state: 'not_held' }), 'arrive'),
      'in_qc_hold',
    );
    throwsCode(
      () => nextPhysicalState(baseCase({ physical_state: 'in_qc_hold' }), 'arrive'),
      'DAMAGE_PHYSICAL_STATE_INVALID',
      409,
    );
    assert.strictEqual(
      nextPhysicalState(baseCase({ physical_state: 'in_qc_hold' }), 'send_external'),
      'at_external_check',
    );
    throwsCode(
      () => nextPhysicalState(baseCase(), 'send_external'),
      'DAMAGE_PHYSICAL_STATE_INVALID',
    );
    throwsCode(
      () =>
        nextPhysicalState(
          baseCase({ physical_state: 'in_qc_hold', status: 'closed' }),
          'send_external',
        ),
      'DAMAGE_PHYSICAL_STATE_INVALID',
    );
    assert.strictEqual(
      nextPhysicalState(baseCase({ physical_state: 'at_external_check' }), 'return'),
      'in_qc_hold',
    );
    throwsCode(
      () => nextPhysicalState(baseCase({ physical_state: 'in_qc_hold' }), 'return'),
      'DAMAGE_PHYSICAL_STATE_INVALID',
    );
  });
});

describe('Story 8.9 held quantity (D5)', () => {
  it('reported before inspection, confirmed after, 0 once cleared or accepted as-is', () => {
    assert.strictEqual(heldQuantity(baseCase()), '4');
    assert.strictEqual(
      heldQuantity(baseCase({ status: 'awaiting_keys', confirmed_quantity: '3' })),
      '3',
    );
    assert.strictEqual(heldQuantity(baseCase({ status: 'cleared', confirmed_quantity: '0' })), '0');
    assert.strictEqual(
      heldQuantity(
        baseCase({
          status: 'closed',
          confirmed_quantity: '3',
          final_outcome: 'accept_as_is_price_reduction',
        }),
      ),
      '0',
    );
    for (const outcome of ['debit_note', 'return_for_replacement', 'write_off'] as const) {
      assert.strictEqual(
        heldQuantity(
          baseCase({ status: 'closed', confirmed_quantity: '3', final_outcome: outcome }),
        ),
        '3',
      );
    }
    assert.strictEqual(
      heldQuantity(
        baseCase({
          status: 'outcome_final',
          confirmed_quantity: '3',
          final_outcome: 'accept_as_is_price_reduction',
        }),
      ),
      '3',
    );
    assert.strictEqual(heldQuantity(baseCase({ hold_mode: 'record_only' })), '0');
  });
});
