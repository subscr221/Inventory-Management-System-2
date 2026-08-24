import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addBusinessDays,
  businessDaysBetween,
  toIstCalendarDate,
} from '../../src/lib/business-days.js';

/**
 * Story 4.2 Task 5.4: the single correctness oracle for business-day arithmetic (AC4).
 * Fixed calendar facts used below: 2026-08-14 is a Friday, 2026-08-15 a Saturday, 2026-08-16 a
 * Sunday, 2026-08-17 a Monday (IST calendar).
 */
describe('Story 4.2 business-days helper', () => {
  it('toIstCalendarDate: classifies IST Saturday and Sunday correctly across UTC midnight', () => {
    // 2026-08-15T10:00Z is 15:30 IST Saturday.
    assert.equal(toIstCalendarDate(new Date('2026-08-15T10:00:00Z')), '2026-08-15');
    // 2026-08-15T18:30Z is exactly 00:00 IST on the 16th (Sunday) - the rollover boundary.
    assert.equal(toIstCalendarDate(new Date('2026-08-15T18:30:00Z')), '2026-08-16');
    // Just before the boundary stays on the 15th.
    assert.equal(toIstCalendarDate(new Date('2026-08-15T18:29:59Z')), '2026-08-15');
  });

  it('same IST calendar day returns 0 (confirmed on the day of issuance)', () => {
    assert.equal(
      businessDaysBetween(new Date('2026-08-14T04:00:00Z'), new Date('2026-08-14T11:00:00Z'), []),
      0,
    );
  });

  it('weekend-only gap returns 0 (issued Saturday, confirmed Monday - only Sunday between)', () => {
    assert.equal(
      businessDaysBetween(new Date('2026-08-15T04:00:00Z'), new Date('2026-08-17T04:00:00Z'), []),
      0,
    );
  });

  it('issued Friday, confirmed Monday is 1 business day (the Saturday counts, Sunday does not)', () => {
    assert.equal(
      businessDaysBetween(new Date('2026-08-14T04:00:00Z'), new Date('2026-08-17T04:00:00Z'), []),
      1,
    );
  });

  it('two-business-day gap (issued Monday, confirmed Thursday - Tuesday and Wednesday count)', () => {
    assert.equal(
      businessDaysBetween(new Date('2026-08-17T04:00:00Z'), new Date('2026-08-20T04:00:00Z'), []),
      2,
    );
  });

  it('a configured holiday removes that business day from the count', () => {
    // Friday 14th to Monday 17th is 1 business day (Saturday 15th); declaring the 15th a
    // holiday removes it.
    assert.equal(
      businessDaysBetween(new Date('2026-08-14T04:00:00Z'), new Date('2026-08-17T04:00:00Z'), [
        '2026-08-15',
      ]),
      0,
    );
    // Monday 17th to Thursday 20th with Wednesday 19th a holiday leaves only Tuesday 18th.
    assert.equal(
      businessDaysBetween(new Date('2026-08-17T04:00:00Z'), new Date('2026-08-20T04:00:00Z'), [
        '2026-08-19',
      ]),
      1,
    );
  });

  it('IST midnight rollover: UTC 18:30 timestamps land on the NEXT IST calendar day', () => {
    // 2026-08-15T18:30Z is IST Sunday the 16th; 2026-08-17T18:30Z is IST Tuesday the 18th.
    // Strictly between lies only Monday the 17th - one business day, not two.
    assert.equal(
      businessDaysBetween(new Date('2026-08-15T18:30:00Z'), new Date('2026-08-17T18:30:00Z'), []),
      1,
    );
  });

  it('clock-skew negative gap returns 0, never a negative number', () => {
    assert.equal(
      businessDaysBetween(new Date('2026-08-17T04:00:00Z'), new Date('2026-08-14T04:00:00Z'), []),
      0,
    );
  });
});

/**
 * Story 7.4 Task 5.3: the addBusinessDays oracle for the FR-M-08 three-working-day spare return
 * clock. Fixed calendar facts used below: 2026-08-27 is a Thursday, 2026-08-28 a Friday,
 * 2026-08-29 a Saturday, 2026-08-30 a Sunday, 2026-08-31 a Monday, 2026-09-01 a Tuesday.
 */
describe('Story 7.4 addBusinessDays helper', () => {
  it('three business days from a Thursday lands on the following Monday (Sunday skipped)', () => {
    // Fri = 1, Sat = 2, Sun skipped, Mon = 3. Saturday IS a working day in this calendar.
    assert.equal(addBusinessDays('2026-08-27', 3, []), '2026-08-31');
  });

  it('skips a configured holiday exactly like businessDaysBetween does', () => {
    // Friday 2026-08-28 is a declared holiday, so the count shifts one calendar day later.
    assert.equal(addBusinessDays('2026-08-27', 3, ['2026-08-28']), '2026-09-01');
  });

  it('skips Sunday when the start date is a Saturday', () => {
    // Sat start: Sun skipped, Mon = 1.
    assert.equal(addBusinessDays('2026-08-29', 1, []), '2026-08-31');
  });

  it('never counts the start date itself', () => {
    // One business day from a Thursday is the Friday, not the Thursday.
    assert.equal(addBusinessDays('2026-08-27', 1, []), '2026-08-28');
  });

  it('zero days returns the start date unchanged', () => {
    assert.equal(addBusinessDays('2026-08-30', 0, []), '2026-08-30');
  });

  it('agrees with businessDaysBetween on the working week, offset by the endpoint convention', () => {
    // The two functions share one definition of a business day but differ on endpoints, and that
    // difference is deliberate: businessDaysBetween is STRICT-between (both endpoints excluded, so
    // an elapsed-time metric never counts the day a document was issued), while addBusinessDays
    // returns the Nth business day itself as the due date. So the elapsed count between the start
    // and the due date is always N - 1. Asserting the exact offset here is what stops a future
    // change to either function from silently shifting the FR-M-08 return deadline by a day.
    for (const n of [1, 2, 3, 5]) {
      const due = addBusinessDays('2026-08-27', n, []);
      assert.equal(
        businessDaysBetween(new Date('2026-08-27T06:00:00Z'), new Date(`${due}T06:00:00Z`), []),
        n - 1,
        `elapsed business days to the ${n}-day due date`,
      );
    }
  });

  it('rejects a malformed start date rather than silently shifting the clock', () => {
    assert.throws(() => addBusinessDays('2026-8-27', 3, []), /must be YYYY-MM-DD/);
  });

  it('rejects a non-integer or out-of-range day count rather than looping', () => {
    assert.throws(() => addBusinessDays('2026-08-27', 1.5, []), /must be an integer/);
    assert.throws(() => addBusinessDays('2026-08-27', -1, []), /must be an integer/);
    assert.throws(() => addBusinessDays('2026-08-27', 4000, []), /must be an integer/);
  });
});
