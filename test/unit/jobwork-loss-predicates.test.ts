import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lossExceedsNorm, lossPercentOf } from '../../src/compliance/custody-ledger.js';
import { apportionDispatchScaled } from '../../src/compliance/jobwork-dispatch.js';
import { qtyToScaled, qtyFromScaled } from '../../src/compliance/custody-statement.js';

/**
 * Story 9.4 (Task 6.5): the two pure predicates behind the AC1 over-norm gate and the AC5 custody
 * apportionment, asserted in isolation with EXACT values - never Number(). The at-exactly-norm
 * boundary is pinned here in both directions, and the apportionment residual property (the balance
 * MUST reach exactly zero, or Story 9.5's CUSTODY_NOT_ZERO can never close the order) is pinned as
 * a sum over a whole dispatch sequence, not a single call.
 */

describe('Story 9.4 lossExceedsNorm (AC1 over-norm boundary)', () => {
  it('does not flag a loss exactly at the norm (the 9.2 exactly-at-boundary convention)', () => {
    // 5.000 of 100.000 consumed is exactly 5% against a 5% norm.
    assert.equal(lossExceedsNorm('5.000', '100.000', '5'), false);
  });

  it('flags one scaled unit above the norm', () => {
    assert.equal(lossExceedsNorm('5.001', '100.000', '5'), true);
  });

  it('does not flag one scaled unit below the norm', () => {
    assert.equal(lossExceedsNorm('4.999', '100.000', '5'), false);
  });

  it('honours a fractional norm at full 3-decimal precision', () => {
    // 0.5% of 100 is 0.500 exactly.
    assert.equal(lossExceedsNorm('0.500', '100.000', '0.5'), false);
    assert.equal(lossExceedsNorm('0.501', '100.000', '0.5'), true);
    // 0.125 of 100.000 is exactly 0.125% - equal to the norm, so not over it.
    assert.equal(lossExceedsNorm('0.125', '100.000', '0.125'), false);
    assert.equal(lossExceedsNorm('0.126', '100.000', '0.125'), true);
  });

  it('treats any positive loss against a zero consumption basis as over-norm', () => {
    assert.equal(lossExceedsNorm('0.001', '0.000', '5'), true);
    assert.equal(lossExceedsNorm('0.000', '0.000', '5'), false);
  });

  it('a norm of 0 makes every positive loss over-norm', () => {
    assert.equal(lossExceedsNorm('0.001', '1000.000', '0'), true);
    assert.equal(lossExceedsNorm('0.000', '1000.000', '0'), false);
  });

  it('CUMULATIVE loss defeats the split-evasion the per-declaration test allowed', () => {
    // Ten 4-unit losses against 100 consumed: each is 4% (under a 5% norm) on its own, but the
    // running total crosses the norm on the second declaration and never comes back under it.
    const consumed = '100.000';
    const declarations = Array.from({ length: 10 }, () => '4.000');
    let cumulative = 0n;
    const flagged: boolean[] = [];
    for (const declared of declarations) {
      cumulative += qtyToScaled(declared);
      flagged.push(lossExceedsNorm(qtyFromScaled(cumulative), consumed, '5'));
    }
    assert.deepEqual(flagged.slice(0, 1), [false], 'the first 4% declaration is within norm');
    assert.ok(
      flagged.slice(1).every((f) => f === true),
      'every declaration from the second on is over the cumulative norm',
    );
    assert.equal(qtyFromScaled(cumulative), '40.000');
  });

  it('the consumption-only basis does not ratchet as losses accumulate', () => {
    // Prior losses must NOT enlarge the denominator: 4 of 100 stays 4%, never 4 of 104.
    assert.equal(lossExceedsNorm('4.000', '100.000', '3.9'), true);
    assert.equal(lossExceedsNorm('4.000', '104.000', '3.9'), false);
  });
});

describe('Story 9.4 lossPercentOf (AC1 refusal detail)', () => {
  it('reports the percentage to 3 decimals', () => {
    assert.equal(lossPercentOf('5.000', '100.000'), '5.000');
    assert.equal(lossPercentOf('1.000', '3.000'), '33.333');
    assert.equal(lossPercentOf('40.000', '100.000'), '40.000');
  });

  it('reports 100 percent against a zero basis, and 0 for a zero loss', () => {
    assert.equal(lossPercentOf('1.000', '0.000'), '100.000');
    assert.equal(lossPercentOf('0.000', '0.000'), '0.000');
  });
});

describe('Story 9.4 apportionDispatchScaled (AC5 custody apportionment)', () => {
  const s = qtyToScaled;

  it('apportions pro-rata over the ORDER total, not the lot quantity', () => {
    // 100 consumed, order total output 10, this dispatch 5 => half of consumption released.
    const result = apportionDispatchScaled({
      skuConsumed: s('100.000'),
      alreadyReleased: 0n,
      dispatchedQuantity: s('5.000'),
      orderOutputTotal: s('10.000'),
      isFinalDispatch: false,
    });
    assert.equal(qtyFromScaled(result), '50.000');
  });

  it('two output lots on one order release 100 percent in total, never 100 percent each', () => {
    // The pre-review bug: denominator = the lot's OWN quantity released ~100% per lot, driving
    // the balance to -100%. Order total output is 20 (two 10-unit lots), consumption 100.
    const first = apportionDispatchScaled({
      skuConsumed: s('100.000'),
      alreadyReleased: 0n,
      dispatchedQuantity: s('10.000'),
      orderOutputTotal: s('20.000'),
      isFinalDispatch: false,
    });
    const second = apportionDispatchScaled({
      skuConsumed: s('100.000'),
      alreadyReleased: first,
      dispatchedQuantity: s('10.000'),
      orderOutputTotal: s('20.000'),
      isFinalDispatch: true,
    });
    assert.equal(qtyFromScaled(first), '50.000');
    assert.equal(qtyFromScaled(second), '50.000');
    assert.equal(qtyFromScaled(first + second), '100.000');
  });

  it('the closing dispatch trues up the truncation residual to EXACTLY zero', () => {
    // 100.000 consumed over three 1.000 dispatches of a 3.000 total: pro-rata truncates to
    // 33.333 each (99.999 total), which would strand 0.001 and block CUSTODY_NOT_ZERO forever.
    const consumed = s('100.000');
    const total = s('3.000');
    let released = 0n;
    const posted: string[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const apportioned = apportionDispatchScaled({
        skuConsumed: consumed,
        alreadyReleased: released,
        dispatchedQuantity: s('1.000'),
        orderOutputTotal: total,
        isFinalDispatch: i === 3,
      });
      released += apportioned;
      posted.push(qtyFromScaled(apportioned));
    }
    assert.deepEqual(posted, ['33.333', '33.333', '33.334']);
    assert.equal(released, consumed, 'the ledger balance reaches exactly zero');
  });

  it('consumption posted BETWEEN partial dispatches is still released in full by the last one', () => {
    // Dispatch 1 of 2 against 100 consumed, then another 100 consumed, then the closing dispatch.
    const first = apportionDispatchScaled({
      skuConsumed: s('100.000'),
      alreadyReleased: 0n,
      dispatchedQuantity: s('1.000'),
      orderOutputTotal: s('2.000'),
      isFinalDispatch: false,
    });
    const second = apportionDispatchScaled({
      skuConsumed: s('200.000'),
      alreadyReleased: first,
      dispatchedQuantity: s('1.000'),
      orderOutputTotal: s('2.000'),
      isFinalDispatch: true,
    });
    assert.equal(qtyFromScaled(first), '50.000');
    assert.equal(qtyFromScaled(first + second), '200.000');
  });

  it('never releases more than the outstanding balance', () => {
    const result = apportionDispatchScaled({
      skuConsumed: s('100.000'),
      alreadyReleased: s('99.000'),
      dispatchedQuantity: s('10.000'),
      orderOutputTotal: s('10.000'),
      isFinalDispatch: false,
    });
    assert.equal(qtyFromScaled(result), '1.000');
  });

  it('returns zero for a fully released, zero-consumption, or zero-output case', () => {
    const base = {
      skuConsumed: s('100.000'),
      alreadyReleased: s('100.000'),
      dispatchedQuantity: s('1.000'),
      orderOutputTotal: s('10.000'),
      isFinalDispatch: true,
    };
    assert.equal(apportionDispatchScaled(base), 0n);
    assert.equal(apportionDispatchScaled({ ...base, alreadyReleased: 0n, skuConsumed: 0n }), 0n);
    assert.equal(
      apportionDispatchScaled({ ...base, alreadyReleased: 0n, orderOutputTotal: 0n }),
      0n,
    );
  });
});
