import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { businessDaysBetween, toIstCalendarDate } from '../../src/lib/business-days.js';

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
