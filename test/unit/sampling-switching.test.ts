import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { determineSampling, parseLotSize } from '../../src/quality/sampling.js';
import {
  INITIAL_SWITCHING_SNAPSHOT,
  advanceSwitchingState,
  applyAuthorizeReduced,
  applyResumeInspection,
  evaluateOutcome,
} from '../../src/quality/switching.js';
import type { OutcomePlan, SwitchingSnapshot } from '../../src/quality/switching.js';

/** Story 8.2 Tasks 5 and 7: the pure determination and switching functions, no database. */

const chars = [
  { characteristic_id: 'c1', characteristic_class: 'critical' },
  { characteristic_id: 'c2', characteristic_class: 'minor' },
];

function code(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as { errorCode?: string }).errorCode;
  }
}

describe('Story 8.2 determineSampling', () => {
  it('derives the AC1 anchors and resolves a null level to II', () => {
    const h = determineSampling({
      quantity: '500.000000',
      aql: '1.000',
      inspection_level: null,
      characteristics: chars,
      severity: 'normal',
    });
    assert.deepStrictEqual(
      [
        h.code_letter,
        h.resolved_code_letter,
        h.sample_size,
        h.acceptance_number,
        h.rejection_number,
      ],
      ['H', 'H', 50, 1, 2],
    );
    assert.strictEqual(h.inspection_level, 'II');
    assert.strictEqual(h.aql, '1.0');
    assert.deepStrictEqual(h.critical_characteristic_ids, ['c1']);
    const j = determineSampling({
      quantity: '1000',
      aql: '1.0',
      inspection_level: 'II',
      characteristics: [],
      severity: 'normal',
    });
    assert.deepStrictEqual([j.code_letter, j.sample_size, j.acceptance_number], ['J', 80, 2]);
    const l = determineSampling({
      quantity: '5000.000000',
      aql: '2.500',
      inspection_level: 'II',
      characteristics: [],
      severity: 'normal',
    });
    assert.deepStrictEqual(
      [l.code_letter, l.sample_size, l.acceptance_number, l.rejection_number],
      ['L', 200, 10, 11],
    );
    const f = determineSampling({
      quantity: '100.000000',
      aql: '1.000',
      inspection_level: 'II',
      characteristics: [],
      severity: 'normal',
    });
    assert.deepStrictEqual(
      [f.code_letter, f.resolved_code_letter, f.sample_size, f.acceptance_number],
      ['F', 'G', 32, 0],
    );
    const whole = determineSampling({
      quantity: '5.000000',
      aql: '1.000',
      inspection_level: 'II',
      characteristics: [],
      severity: 'normal',
    });
    assert.strictEqual(whole.sample_size, 5);
    assert.strictEqual(whole.lot_size, 5);
    const one = determineSampling({
      quantity: '1.000000',
      aql: '1.000',
      inspection_level: 'II',
      characteristics: [],
      severity: 'normal',
    });
    assert.deepStrictEqual([one.code_letter, one.sample_size], ['A', 1]);
    const tightened = determineSampling({
      quantity: '500.000000',
      aql: '1.000',
      inspection_level: 'II',
      characteristics: [],
      severity: 'tightened',
    });
    assert.deepStrictEqual([tightened.acceptance_number, tightened.rejection_number], [0, 1]);
    const reduced = determineSampling({
      quantity: '500.000000',
      aql: '1.000',
      inspection_level: 'II',
      characteristics: [],
      severity: 'reduced',
    });
    assert.deepStrictEqual(
      [reduced.sample_size, reduced.acceptance_number, reduced.rejection_number],
      [20, 0, 2],
    );
  });

  it('fails closed on fractional lots, non-preferred AQLs and unknown levels; null AQL is full inspection', () => {
    const base = { characteristics: chars, severity: 'normal' as const };
    assert.strictEqual(
      code(() =>
        determineSampling({
          ...base,
          quantity: '100.500000',
          aql: '1.000',
          inspection_level: 'II',
        }),
      ),
      'SAMPLING_LOT_SIZE_INVALID',
    );
    assert.strictEqual(
      code(() =>
        determineSampling({ ...base, quantity: '0.000000', aql: '1.000', inspection_level: 'II' }),
      ),
      'SAMPLING_LOT_SIZE_INVALID',
    );
    assert.strictEqual(
      code(() =>
        determineSampling({ ...base, quantity: '100', aql: '1.200', inspection_level: 'II' }),
      ),
      'AQL_NOT_IN_STANDARD',
    );
    assert.strictEqual(
      code(() =>
        determineSampling({ ...base, quantity: '100', aql: '1.000', inspection_level: 'IV' }),
      ),
      'INSPECTION_LEVEL_INVALID',
    );
    // Deferred-work ledger ref 534: the tightest AQL columns resolve into supplementary code
    // letter S at its own sample size (3150 normal and tightened, 1250 reduced), not into letter
    // R's n = 2000. A smaller sample at the same acceptance number accepts lots the standard
    // rejects, and the whole column is one down-arrow chain, so every lot size was affected.
    const tiny = determineSampling({
      ...base,
      quantity: '100',
      aql: '0.010',
      inspection_level: 'I',
    });
    assert.deepStrictEqual(
      [tiny.code_letter, tiny.resolved_code_letter, tiny.sample_size, tiny.acceptance_number],
      // sample_size is capped at the lot size: a 100-unit lot under an n = 3150 plan is 100 % inspected.
      ['D', 'S', 100, 0],
    );
    const big = determineSampling({
      ...base,
      quantity: '1000000',
      aql: '0.010',
      inspection_level: 'III',
    });
    assert.deepStrictEqual(
      [big.code_letter, big.resolved_code_letter, big.sample_size, big.acceptance_number],
      ['R', 'S', 3150, 0],
    );
    const reduced = determineSampling({
      characteristics: chars,
      severity: 'reduced',
      quantity: '1000000',
      aql: '0.010',
      inspection_level: 'III',
    });
    assert.strictEqual(reduced.sample_size, 1250);
    assert.strictEqual(reduced.resolved_code_letter, 'S');
    // Tightened runs one letter lower, so AQL 0.015 resolves to S and AQL 0.010 has no plan at any
    // row: the standard's tables end at S. That combination is refused, not silently substituted.
    const tightened = determineSampling({
      characteristics: chars,
      severity: 'tightened',
      quantity: '1000000',
      aql: '0.015',
      inspection_level: 'III',
    });
    assert.deepStrictEqual(
      [tightened.resolved_code_letter, tightened.sample_size, tightened.acceptance_number],
      ['S', 3150, 0],
    );
    assert.strictEqual(
      code(() =>
        determineSampling({
          characteristics: chars,
          severity: 'tightened',
          quantity: '1000000',
          aql: '0.010',
          inspection_level: 'III',
        }),
      ),
      'AQL_NOT_IN_STANDARD',
    );
    // The cells that were already on the diagonal are unchanged: R at its own n = 2000.
    const onDiagonal = determineSampling({
      ...base,
      quantity: '1000000',
      aql: '0.015',
      inspection_level: 'III',
    });
    assert.deepStrictEqual([onDiagonal.resolved_code_letter, onDiagonal.sample_size], ['R', 2000]);
    const full = determineSampling({
      ...base,
      quantity: '37.000000',
      aql: null,
      inspection_level: null,
    });
    assert.strictEqual(full.sampling_basis, 'full_inspection');
    assert.strictEqual(full.sample_size, 37);
    assert.strictEqual(full.acceptance_number, null);
    assert.strictEqual(full.code_letter, null);
    assert.strictEqual(parseLotSize('000123.000000'), 123);
    assert.strictEqual(parseLotSize('-1'), null);
  });
});

const normalPlan: OutcomePlan = {
  sampling_basis: 'aql_table',
  sample_size: 50,
  acceptance_number: 1,
  rejection_number: 2,
  severity: 'normal',
};

function run(
  state: SwitchingSnapshot,
  accepted: boolean,
  plan: OutcomePlan = normalPlan,
  tighter = false,
): SwitchingSnapshot {
  const units = accepted
    ? []
    : [
        { sample_unit_no: 1, critical: false },
        { sample_unit_no: 2, critical: false },
      ];
  return advanceSwitchingState(state, evaluateOutcome(plan, units), plan, tighter);
}

describe('Story 8.2 evaluateOutcome and switching rules', () => {
  it('outcome: critical anywhere rejects; Re reached rejects; between Ac and Re on reduced accepts and flags', () => {
    const critical = evaluateOutcome(normalPlan, [{ sample_unit_no: 400, critical: true }]);
    assert.deepStrictEqual(
      [
        critical.sampling_outcome,
        critical.nonconforming_sample_units,
        critical.critical_nonconformities,
      ],
      ['not_accepted', 0, 1],
    );
    const underAc = evaluateOutcome(normalPlan, [{ sample_unit_no: 3, critical: false }]);
    assert.strictEqual(underAc.sampling_outcome, 'accepted');
    const atRe = evaluateOutcome(normalPlan, [
      { sample_unit_no: 3, critical: false },
      { sample_unit_no: 4, critical: false },
    ]);
    assert.strictEqual(atRe.sampling_outcome, 'not_accepted');
    const reduced: OutcomePlan = {
      ...normalPlan,
      sample_size: 20,
      acceptance_number: 1,
      rejection_number: 3,
      severity: 'reduced',
    };
    const between = evaluateOutcome(reduced, [
      { sample_unit_no: 1, critical: false },
      { sample_unit_no: 2, critical: false },
    ]);
    assert.strictEqual(between.sampling_outcome, 'accepted');
    assert.strictEqual(between.between_ac_and_re, true);
    const full: OutcomePlan = {
      sampling_basis: 'full_inspection',
      sample_size: 10,
      acceptance_number: null,
      rejection_number: null,
      severity: 'normal',
    };
    assert.strictEqual(
      evaluateOutcome(full, [{ sample_unit_no: 7, critical: false }]).sampling_outcome,
      'not_accepted',
    );
    assert.strictEqual(evaluateOutcome(full, []).sampling_outcome, 'accepted');
  });

  it('normal to tightened after 2 of at most 5 not accepted; tightened to normal after 5 accepted; discontinued after 5 not accepted', () => {
    let s = INITIAL_SWITCHING_SNAPSHOT;
    s = run(s, true);
    s = run(s, false);
    s = run(s, true);
    assert.strictEqual(s.severity, 'normal');
    s = run(s, false);
    assert.strictEqual(s.severity, 'tightened');
    assert.strictEqual(s.switching_score, 0);
    for (let i = 0; i < 4; i += 1) s = run(s, true);
    assert.strictEqual(s.severity, 'tightened');
    assert.strictEqual(s.consecutive_accepted_on_tightened, 4);
    s = run(s, true);
    assert.strictEqual(s.severity, 'normal');
    assert.strictEqual(s.consecutive_accepted_on_tightened, 0);
    // Back to tightened, then five cumulative not-accepted lots (not consecutive) discontinue.
    s = run(s, false);
    s = run(s, false);
    assert.strictEqual(s.severity, 'tightened');
    for (let i = 0; i < 4; i += 1) {
      s = run(s, false);
      s = run(s, true);
    }
    assert.strictEqual(s.inspection_discontinued, false);
    s = run(s, false);
    assert.strictEqual(s.inspection_discontinued, true);
    assert.strictEqual(s.severity, 'tightened');
    const resumed = applyResumeInspection(s);
    assert.strictEqual(resumed.severity, 'tightened');
    assert.strictEqual(resumed.inspection_discontinued, false);
    assert.strictEqual(resumed.not_accepted_on_tightened, 0);
  });

  it('switching score: +2 on Ac 0/1 accepted, +3 on Ac >= 2 when tighter AQL accepts, reset on not accepted; 30 sets reduced_eligible only', () => {
    let s = INITIAL_SWITCHING_SNAPSHOT;
    s = run(s, true);
    s = run(s, true);
    assert.strictEqual(s.switching_score, 4);
    s = run(s, false);
    assert.strictEqual(s.switching_score, 0);
    const ac2: OutcomePlan = { ...normalPlan, acceptance_number: 2, rejection_number: 3 };
    for (let i = 0; i < 10; i += 1) s = run(s, true, ac2, true);
    assert.strictEqual(s.switching_score, 30);
    assert.strictEqual(s.reduced_eligible, true);
    assert.strictEqual(s.severity, 'normal');
    // Ac >= 2 with the tighter cell not acceptable (or an arrow) resets to zero.
    assert.strictEqual(run(s, true, ac2, false).switching_score, 0);
    const reduced = applyAuthorizeReduced(s);
    assert.strictEqual(reduced.severity, 'reduced');
    assert.strictEqual(reduced.reduced_eligible, false);
    const reducedPlan: OutcomePlan = {
      sampling_basis: 'aql_table',
      sample_size: 20,
      acceptance_number: 1,
      rejection_number: 3,
      severity: 'reduced',
    };
    const stayed = advanceSwitchingState(
      reduced,
      evaluateOutcome(reducedPlan, []),
      reducedPlan,
      false,
    );
    assert.strictEqual(stayed.severity, 'reduced');
    const between = advanceSwitchingState(
      reduced,
      evaluateOutcome(reducedPlan, [
        { sample_unit_no: 1, critical: false },
        { sample_unit_no: 2, critical: false },
      ]),
      reducedPlan,
      false,
    );
    assert.strictEqual(between.severity, 'normal');
    const rejected = advanceSwitchingState(
      reduced,
      evaluateOutcome(reducedPlan, [{ sample_unit_no: 1, critical: true }]),
      reducedPlan,
      false,
    );
    assert.strictEqual(rejected.severity, 'normal');
    // full_inspection keeps no state.
    const full: OutcomePlan = {
      sampling_basis: 'full_inspection',
      sample_size: 10,
      acceptance_number: null,
      rejection_number: null,
      severity: 'normal',
    };
    assert.deepStrictEqual(advanceSwitchingState(s, evaluateOutcome(full, []), full, false), s);
  });
});
