import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../src/middleware/error.js';
import {
  billableValueOf,
  billingFeedRetryWindowElapsed,
  moneyAdd,
  moneyFromScaled,
  moneyToScaled,
  priceBasisRateAsMoney,
  resolveMeasuredBasis,
} from '../../src/adapters/erp/job-work-billing-feed.js';
import {
  acknowledgmentSodViolation,
  billingNotReadyReason,
  orderAcceptsBilling,
} from '../../src/compliance/jobwork-billing.js';
import { offcutCaptureOpen } from '../../src/compliance/jobwork-offcut.js';
import { isOffcutRateString } from '../../src/compliance/service-order.js';

/**
 * Story 9.6 Task 10.7: the pure predicates behind the billing feed and the offcut election, each
 * parameterised so a test can FAIL it (the 8.4 tautological-config lesson) - measured-basis
 * resolution, the retry-window boundary, the scaled-integer money arithmetic, the two
 * BILLING_NOT_READY legs, the SoD comparison, the election gate and the Task 0 rate shape.
 */
describe('Story 9.6 billing and offcut predicates', () => {
  // -------------------------------------------------------------------------
  // Money arithmetic (Task 5.5): scaled integers, never a float
  // -------------------------------------------------------------------------

  it('moneyToScaled / moneyFromScaled round-trip at four decimals and refuse a fifth', () => {
    assert.strictEqual(moneyFromScaled(moneyToScaled('18.5')), '18.5000');
    assert.strictEqual(moneyFromScaled(moneyToScaled('0')), '0.0000');
    assert.strictEqual(moneyFromScaled(moneyToScaled('-3.25')), '-3.2500');
    assert.throws(() => moneyToScaled('1.00001'), TypeError);
    assert.throws(() => moneyToScaled('abc'), TypeError);
  });

  it('billableValueOf multiplies a 3-decimal quantity by a 4-decimal rate exactly, rounding half up', () => {
    assert.strictEqual(billableValueOf('100.000', '18.5000'), '1850.0000');
    // 0.001 x 0.0001 = 0.0000001 -> rounds to 0.0000; 0.005 x 0.1 = 0.0005 exactly.
    assert.strictEqual(billableValueOf('0.001', '0.0001'), '0.0000');
    assert.strictEqual(billableValueOf('0.005', '0.1'), '0.0005');
    // 1.234 x 1.2345 = 1.5233730 -> 1.5234 (half up on the 7th decimal digit 3? no: 1.523373 -> 1.5234)
    assert.strictEqual(billableValueOf('1.234', '1.2345'), '1.5234');
    // 0.333 x 0.0005 = 0.0001665 -> 0.0002 (half up)
    assert.strictEqual(billableValueOf('0.333', '0.0005'), '0.0002');
    // The classic float trap: 0.1 + 0.2 style products stay exact.
    assert.strictEqual(billableValueOf('3.000', '0.1'), '0.3000');
    assert.strictEqual(moneyAdd('0.1', '0.2'), '0.3000');
  });

  it('priceBasisRateAsMoney re-serialises the JSON number through the exact path', () => {
    assert.strictEqual(priceBasisRateAsMoney(12.5), '12.5000');
    assert.strictEqual(priceBasisRateAsMoney(0), '0.0000');
    assert.throws(() => priceBasisRateAsMoney(-1), AppError);
    assert.throws(() => priceBasisRateAsMoney(1.23456), TypeError);
  });

  // -------------------------------------------------------------------------
  // Measured basis (Binding decision 12)
  // -------------------------------------------------------------------------

  it('resolveMeasuredBasis: per_piece and per_kg bill the dispatched total, lumpsum bills one unit', () => {
    assert.deepStrictEqual(
      resolveMeasuredBasis({ basisType: 'per_piece', dispatchedTotal: '50.000' }),
      { measured_basis: 'per_piece', measured_quantity: '50.000' },
    );
    assert.deepStrictEqual(
      resolveMeasuredBasis({ basisType: 'per_kg', dispatchedTotal: '1234.500' }),
      { measured_basis: 'per_kg', measured_quantity: '1234.500' },
    );
    assert.deepStrictEqual(
      resolveMeasuredBasis({ basisType: 'lumpsum', dispatchedTotal: '999.000' }),
      { measured_basis: 'lumpsum', measured_quantity: '1.000' },
    );
  });

  it('resolveMeasuredBasis: per_hour needs caller-supplied measured_hours and refuses INVALID_PARAMS without one', () => {
    assert.deepStrictEqual(
      resolveMeasuredBasis({
        basisType: 'per_hour',
        dispatchedTotal: '50.000',
        measuredHours: '7.5',
      }),
      { measured_basis: 'per_hour', measured_quantity: '7.5' },
    );
    for (const bad of [undefined, '', '0', '0.000', '-1', 'abc', '1.2345']) {
      assert.throws(
        () =>
          resolveMeasuredBasis({
            basisType: 'per_hour',
            dispatchedTotal: '50.000',
            measuredHours: bad,
          }),
        (err: unknown) =>
          err instanceof AppError && err.errorCode === 'INVALID_PARAMS' && err.statusCode === 400,
        `measured_hours=${String(bad)} should be refused`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // Retry window (AC 5): strictly-older-than flips, exactly-at does not
  // -------------------------------------------------------------------------

  it('billingFeedRetryWindowElapsed flips only when the age STRICTLY exceeds the window', () => {
    const sent = '2026-09-04T00:00:00.000Z';
    const window = 86_400_000;
    assert.strictEqual(
      billingFeedRetryWindowElapsed({
        firstSentAt: sent,
        now: '2026-09-04T23:59:59.999Z',
        retryWindowMs: window,
      }),
      false,
    );
    assert.strictEqual(
      billingFeedRetryWindowElapsed({
        firstSentAt: sent,
        now: '2026-09-05T00:00:00.000Z',
        retryWindowMs: window,
      }),
      false,
      'exactly at the window does not flip',
    );
    assert.strictEqual(
      billingFeedRetryWindowElapsed({
        firstSentAt: sent,
        now: '2026-09-05T00:00:00.001Z',
        retryWindowMs: window,
      }),
      true,
    );
    // A different window is honoured - the predicate is not pinned to the default.
    assert.strictEqual(
      billingFeedRetryWindowElapsed({
        firstSentAt: sent,
        now: '2026-09-04T00:00:01.000Z',
        retryWindowMs: 500,
      }),
      true,
    );
  });

  // -------------------------------------------------------------------------
  // BILLING_NOT_READY legs (Binding decisions 15 and 18)
  // -------------------------------------------------------------------------

  it('orderAcceptsBilling: in_process and closed bill; draft and confirmed do not', () => {
    assert.strictEqual(orderAcceptsBilling('in_process'), true);
    assert.strictEqual(orderAcceptsBilling('closed'), true);
    assert.strictEqual(orderAcceptsBilling('draft'), false);
    assert.strictEqual(orderAcceptsBilling('confirmed'), false);
  });

  it('billingNotReadyReason: no dispatch refuses, one dispatch with open output does NOT (decision 18)', () => {
    assert.strictEqual(
      billingNotReadyReason({
        status: 'in_process',
        dispatchCount: 0,
      }),
      'no_dispatch',
    );
    assert.strictEqual(
      billingNotReadyReason({
        status: 'in_process',
        dispatchCount: 1,
      }),
      null,
    );
    assert.strictEqual(
      billingNotReadyReason({
        status: 'confirmed',
        dispatchCount: 1,
      }),
      'order_not_started',
    );
  });

  it('billingNotReadyReason: a contractual offcut no longer blocks billing (revised 2026-09-05)', () => {
    // The offcut precondition was withdrawn: offcut is captured unvalued and disposed of later, so
    // holding the service invoice for it would block a delivered job for months.
    assert.strictEqual(
      billingNotReadyReason({ status: 'in_process', dispatchCount: 1 }),
      null,
      'a dispatched order bills regardless of any outstanding offcut',
    );
  });

  it('acknowledgmentSodViolation bars the generator AND the offcut settler', () => {
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    const c = '33333333-3333-4333-8333-333333333333';
    assert.strictEqual(
      acknowledgmentSodViolation({ generatedBy: a, offcutSettledBy: b, actingUserId: a }),
      'generator',
    );
    // Story 9.6 code review: the actor who priced the scrap may not sign off the invoice for it.
    assert.strictEqual(
      acknowledgmentSodViolation({ generatedBy: a, offcutSettledBy: b, actingUserId: b }),
      'offcut_settler',
    );
    assert.strictEqual(
      acknowledgmentSodViolation({ generatedBy: a, offcutSettledBy: b, actingUserId: c }),
      null,
    );
    // An order with no contractual offcut has no settler, and that must not bar anyone.
    assert.strictEqual(
      acknowledgmentSodViolation({ generatedBy: a, offcutSettledBy: null, actingUserId: b }),
      null,
    );
  });

  // -------------------------------------------------------------------------
  // Offcut election gate (Binding decisions 1, 4, 15)
  // -------------------------------------------------------------------------

  it('offcutCaptureOpen: only a contractual order may have offcut captured against it', () => {
    // Revised 2026-09-05: no election check and no settled check. The disposition is decided at
    // disposal, and an order may produce offcut in several batches over its life.
    assert.deepStrictEqual(offcutCaptureOpen({ has_contractual_offcut: true }), { open: true });
    assert.deepStrictEqual(offcutCaptureOpen({ has_contractual_offcut: false }), {
      open: false,
      reason: 'not_contractual',
    });
  });

  // -------------------------------------------------------------------------
  // Task 0: the contracted rate shape
  // -------------------------------------------------------------------------

  it('isOffcutRateString accepts a positive exact decimal string with at most four decimals only', () => {
    for (const ok of ['1', '18.5', '18.5000', '0.0001', '12345678901234.1234']) {
      assert.strictEqual(isOffcutRateString(ok), true, ok);
    }
    for (const bad of [18.5, '0', '0.0000', '-1', '1.00001', '', ' 1', '1e3', null, undefined]) {
      assert.strictEqual(isOffcutRateString(bad), false, String(bad));
    }
  });
});
