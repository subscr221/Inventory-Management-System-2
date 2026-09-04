import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateFifo,
  calendarDaysUntil,
  deemedSupplyQty,
  dueClockSweepStage,
  returnClockDays,
  returnClockExpiryDate,
  returnClockStatusAfter,
} from '../../src/compliance/jobwork-return-clock.js';
import { agingBucketFor } from '../../src/api/v1/service-orders.js';

/**
 * Story 9.5 (Task 8.5): the pure predicates behind the Section 143 return clock, asserted in
 * isolation with EXACT dates and quantities - never Number(), never Date.now()-relative. Every
 * boundary the story discloses (365/1095 days, breached strictly after expiry, the 90/30-day stages
 * firing AT the boundary, tightest-stage-wins, FIFO by challan) is pinned in both directions, with
 * the lead days passed as PARAMETERS so the test cannot assert the config against itself.
 */

describe('Story 9.5 returnClockExpiryDate (AC1: 365 / 1095 calendar days from challan_date)', () => {
  it('adds exactly 365 days for an input challan', () => {
    assert.equal(returnClockDays('input'), 365);
    assert.equal(returnClockExpiryDate('2026-09-01', 'input'), '2027-09-01');
  });

  it('adds exactly 1095 days for capital goods (three years less the 2028 leap day)', () => {
    assert.equal(returnClockDays('capital_goods'), 1095);
    assert.equal(returnClockExpiryDate('2026-09-01', 'capital_goods'), '2029-08-31');
  });

  it('is calendar arithmetic, not "same date next year": a leap year shifts the input clock a day', () => {
    // 2024 is a leap year: 2024-02-28 + 365 days lands on 2025-02-27, not 2025-02-28.
    assert.equal(returnClockExpiryDate('2024-02-28', 'input'), '2025-02-27');
    assert.equal(returnClockExpiryDate('2023-02-28', 'input'), '2024-02-28');
  });

  it('crosses month and year ends without drift', () => {
    assert.equal(returnClockExpiryDate('2026-12-31', 'input'), '2027-12-31');
    assert.equal(returnClockExpiryDate('2026-01-01', 'input'), '2027-01-01');
  });
});

describe('Story 9.5 calendarDaysUntil (no DST / timezone drift)', () => {
  it('counts whole days across an Indian-clock-irrelevant DST boundary in UTC arithmetic', () => {
    assert.equal(calendarDaysUntil('2026-03-28', '2026-03-30'), 2);
    assert.equal(calendarDaysUntil('2026-10-24', '2026-10-26'), 2);
  });

  it('is signed: a past expiry is negative, the same day is zero', () => {
    assert.equal(calendarDaysUntil('2026-09-04', '2026-09-03'), -1);
    assert.equal(calendarDaysUntil('2026-09-04', '2026-09-04'), 0);
  });
});

describe('Story 9.5 dueClockSweepStage (AC3/AC5: tightest-stage-wins, boundaries disclosed)', () => {
  const live = {
    status: 'open' as const,
    alert90SentAt: null,
    alert30SentAt: null,
    leadDays1: 90,
    leadDays2: 30,
  };

  it('is breached STRICTLY after expiry - the goods may still come back on the last day', () => {
    assert.equal(
      dueClockSweepStage({ ...live, today: '2027-09-02', expiryDate: '2027-09-01' }),
      'breached',
    );
    assert.notEqual(
      dueClockSweepStage({ ...live, today: '2027-09-01', expiryDate: '2027-09-01' }),
      'breached',
    );
  });

  it('fires the 30-day stage AT the boundary and one day inside it', () => {
    assert.equal(
      dueClockSweepStage({ ...live, today: '2027-08-02', expiryDate: '2027-09-01' }),
      'alert_30',
    );
    assert.equal(
      dueClockSweepStage({ ...live, today: '2027-08-03', expiryDate: '2027-09-01' }),
      'alert_30',
    );
  });

  it('fires the 90-day stage one day outside the 30-day window, AT the 90-day boundary, and not a day before', () => {
    assert.equal(
      dueClockSweepStage({ ...live, today: '2027-08-01', expiryDate: '2027-09-01' }),
      'alert_90',
    );
    assert.equal(
      dueClockSweepStage({ ...live, today: '2027-06-03', expiryDate: '2027-09-01' }),
      'alert_90',
    );
    assert.equal(
      dueClockSweepStage({ ...live, today: '2027-06-02', expiryDate: '2027-09-01' }),
      null,
    );
  });

  it('a clock first seen inside the 30-day window fires the 30-day stage, never the 90-day one first', () => {
    // Eleven-months-late challan keyed in today: one alert (the tighter), not two in one second.
    assert.equal(
      dueClockSweepStage({ ...live, today: '2027-08-20', expiryDate: '2027-09-01' }),
      'alert_30',
    );
  });

  it('never re-fires a stamped tier', () => {
    assert.equal(
      dueClockSweepStage({
        ...live,
        today: '2027-07-01',
        expiryDate: '2027-09-01',
        alert90SentAt: '2027-06-03T00:00:00Z',
      }),
      null,
    );
    assert.equal(
      dueClockSweepStage({
        ...live,
        today: '2027-08-20',
        expiryDate: '2027-09-01',
        alert90SentAt: '2027-06-03T00:00:00Z',
        alert30SentAt: '2027-08-02T00:00:00Z',
      }),
      null,
    );
    // Stamped at 90 but now inside 30: the 30-day stage still fires once.
    assert.equal(
      dueClockSweepStage({
        ...live,
        today: '2027-08-20',
        expiryDate: '2027-09-01',
        alert90SentAt: '2027-06-03T00:00:00Z',
      }),
      'alert_30',
    );
    // Story 9.5 code review (chunks 3/4): the case that distinguishes the fixed predicate from the
    // broken one, and the only stamped-tier combination the suite was missing. With the TIGHTER tier
    // stamped and the looser one not, the old sequential form skipped the 30-day arm on its stamp
    // check and then satisfied the 90-day arm, sending a "90 days remaining" warning with twelve
    // days left. Once inside the tight window the looser stage must never fire.
    assert.equal(
      dueClockSweepStage({
        ...live,
        today: '2027-08-20',
        expiryDate: '2027-09-01',
        alert30SentAt: '2027-08-02T00:00:00Z',
      }),
      null,
    );
  });

  it('fires the 30-day stage on the expiry date itself, and only breaches strictly after it', () => {
    // The boundary was asserted with notEqual('breached'), which a predicate that silently stopped
    // alerting on the final day would also satisfy. The expected answer is exact.
    assert.equal(
      dueClockSweepStage({ ...live, today: '2027-09-01', expiryDate: '2027-09-01' }),
      'alert_30',
    );
    assert.equal(
      dueClockSweepStage({ ...live, today: '2027-09-02', expiryDate: '2027-09-01' }),
      'breached',
    );
    // A partially reconciled clock is live for the alert stages too, not only for breach.
    assert.equal(
      dueClockSweepStage({
        ...live,
        status: 'partially_reconciled',
        today: '2027-08-20',
        expiryDate: '2027-09-01',
      }),
      'alert_30',
    );
  });

  it('ignores reconciled and already-breached clocks entirely, even past expiry', () => {
    assert.equal(
      dueClockSweepStage({
        ...live,
        status: 'reconciled',
        today: '2028-01-01',
        expiryDate: '2027-09-01',
      }),
      null,
    );
    assert.equal(
      dueClockSweepStage({
        ...live,
        status: 'breached',
        today: '2028-01-01',
        expiryDate: '2027-09-01',
      }),
      null,
    );
    assert.equal(
      dueClockSweepStage({
        ...live,
        status: 'partially_reconciled',
        today: '2027-09-02',
        expiryDate: '2027-09-01',
      }),
      'breached',
    );
  });

  it('honours the lead days as parameters (not the config)', () => {
    assert.equal(
      dueClockSweepStage({
        ...live,
        leadDays1: 10,
        leadDays2: 5,
        today: '2027-08-25',
        expiryDate: '2027-09-01',
      }),
      'alert_90',
    );
    assert.equal(
      dueClockSweepStage({
        ...live,
        leadDays1: 10,
        leadDays2: 5,
        today: '2027-08-27',
        expiryDate: '2027-09-01',
      }),
      'alert_30',
    );
  });
});

describe('Story 9.5 deemedSupplyQty / returnClockStatusAfter (Binding decision 6)', () => {
  it('deemed supply is challan minus reconciled minus loss - loss is accounted waste, never deemed', () => {
    assert.equal(deemedSupplyQty('100.000', '30.000', '2.500'), '67.500');
    assert.equal(deemedSupplyQty('100.000', '100.000', '0.000'), '0.000');
  });

  it('never goes negative when an over-tolerance receipt was fully accounted', () => {
    assert.equal(deemedSupplyQty('100.000', '100.000', '0.001'), '0.000');
  });

  it('status flips open -> partially_reconciled -> reconciled on either counter', () => {
    assert.equal(returnClockStatusAfter('open', '100.000', '0.000', '0.000'), 'open');
    assert.equal(
      returnClockStatusAfter('open', '100.000', '0.000', '0.001'),
      'partially_reconciled',
    );
    assert.equal(
      returnClockStatusAfter('open', '100.000', '99.999', '0.000'),
      'partially_reconciled',
    );
    assert.equal(
      returnClockStatusAfter('partially_reconciled', '100.000', '98.000', '2.000'),
      'reconciled',
    );
  });

  it('a breached clock stays breached - the deemed supply is a recorded tax fact', () => {
    assert.equal(returnClockStatusAfter('breached', '100.000', '100.000', '0.000'), 'breached');
  });
});

describe('Story 9.5 allocateFifo (AC2: the older challan fills first)', () => {
  it('fills the first clock to capacity before touching the second', () => {
    const result = allocateFifo(
      [
        { clock_id: 'A', capacity: 300_000n },
        { clock_id: 'B', capacity: 5_000_000n },
      ],
      500_000n,
    );
    assert.deepEqual(result.allocations, [
      { clock_id: 'A', quantity: 300_000n },
      { clock_id: 'B', quantity: 200_000n },
    ]);
    assert.equal(result.unallocated, 0n);
  });

  it('reports the remainder when capacity runs out and skips exhausted clocks', () => {
    const result = allocateFifo(
      [
        { clock_id: 'A', capacity: 0n },
        { clock_id: 'B', capacity: 100_000n },
      ],
      105_000n,
    );
    assert.deepEqual(result.allocations, [{ clock_id: 'B', quantity: 100_000n }]);
    assert.equal(result.unallocated, 5_000n);
  });

  it('allocates nothing for a zero request', () => {
    const result = allocateFifo([{ clock_id: 'A', capacity: 10n }], 0n);
    assert.deepEqual(result.allocations, []);
    assert.equal(result.unallocated, 0n);
  });
});

describe('Story 9.5 agingBucketFor (AC6 aging report)', () => {
  it('buckets by days to expiry with breached overriding the count', () => {
    assert.equal(agingBucketFor('open', -1), 'breached');
    assert.equal(agingBucketFor('breached', 400), 'breached');
    assert.equal(agingBucketFor('open', 0), 'due_within_30');
    assert.equal(agingBucketFor('open', 30), 'due_within_30');
    assert.equal(agingBucketFor('partially_reconciled', 31), 'due_within_90');
    assert.equal(agingBucketFor('open', 90), 'due_within_90');
    assert.equal(agingBucketFor('open', 91), 'beyond_90');
  });
});
