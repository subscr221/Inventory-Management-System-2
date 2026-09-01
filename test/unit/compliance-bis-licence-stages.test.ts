import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  dueBisLicenceExpiryStages,
  mostUrgentDueBisLicenceExpiryStage,
} from '../../src/compliance/master-data.js';
import { calendarDaysBetween } from '../../src/compliance/bis-licence-expiry.js';

/**
 * Story 8.7 code review (Group 4): the 90/60/30/0 stage arithmetic is pure, but until now it was
 * only exercised transitively through a PostgreSQL-backed integration test, at roughly thirty
 * seconds per assertion. The boundaries that actually matter - 91 vs 90, 61 vs 60, 31 vs 30, and
 * the 0/-1 expiry edge - are table-driven here, where they cost nothing and name the failure.
 */
describe('Story 8.7 BIS licence expiry stage arithmetic', () => {
  describe('dueBisLicenceExpiryStages', () => {
    const cases: Array<{ days: number; expected: number[]; why: string }> = [
      { days: 365, expected: [], why: 'a year out, nothing is due' },
      { days: 91, expected: [], why: 'one day before the 90-day window opens' },
      { days: 90, expected: [90], why: 'the 90-day stage opens exactly at 90' },
      { days: 61, expected: [90], why: 'one day before the 60-day window opens' },
      { days: 60, expected: [90, 60], why: 'the 60-day stage opens exactly at 60' },
      { days: 31, expected: [90, 60], why: 'one day before the 30-day window opens' },
      { days: 30, expected: [90, 60, 30], why: 'the 30-day stage opens exactly at 30' },
      { days: 1, expected: [90, 60, 30], why: 'the day before expiry is still a live window' },
      { days: 0, expected: [90, 60, 30], why: 'valid_to = today still COVERS today' },
      { days: -1, expected: [0], why: 'a closed window flags the expiry stage ALONE' },
      { days: -400, expected: [0], why: 'long expired is still just the expiry stage' },
    ];

    for (const { days, expected, why } of cases) {
      it(`${days} days to expiry yields [${expected.join(', ')}] - ${why}`, () => {
        assert.deepStrictEqual(dueBisLicenceExpiryStages(days), expected);
      });
    }

    it('never mixes the expiry stage with the day-count stages', () => {
      for (let days = -5; days <= 120; days += 1) {
        const stages = dueBisLicenceExpiryStages(days);
        if (stages.includes(0)) {
          assert.deepStrictEqual(
            stages,
            [0],
            `day ${days}: an expired window must flag stage 0 alone, or "Expiring soon" lands after "Expired"`,
          );
        }
      }
    });

    it('is ordered most-urgent-last', () => {
      for (let days = -5; days <= 120; days += 1) {
        const stages = dueBisLicenceExpiryStages(days);
        const descending = [...stages].sort((a, b) => b - a);
        assert.deepStrictEqual(stages, descending, `day ${days} is not ordered most-urgent-last`);
      }
    });
  });

  describe('mostUrgentDueBisLicenceExpiryStage', () => {
    it('returns null when no stage is due', () => {
      assert.strictEqual(mostUrgentDueBisLicenceExpiryStage(91), null);
    });

    it('returns the smallest due day-count stage', () => {
      assert.strictEqual(mostUrgentDueBisLicenceExpiryStage(90), 90);
      assert.strictEqual(mostUrgentDueBisLicenceExpiryStage(60), 60);
      assert.strictEqual(mostUrgentDueBisLicenceExpiryStage(29), 30);
      assert.strictEqual(mostUrgentDueBisLicenceExpiryStage(0), 30);
    });

    it('returns the expiry stage once the window has closed', () => {
      assert.strictEqual(mostUrgentDueBisLicenceExpiryStage(-1), 0);
    });

    it('always agrees with the last element of the due list', () => {
      for (let days = -5; days <= 120; days += 1) {
        const due = dueBisLicenceExpiryStages(days);
        const expected = due.length > 0 ? due[due.length - 1] : null;
        assert.strictEqual(mostUrgentDueBisLicenceExpiryStage(days), expected, `day ${days}`);
      }
    });
  });

  describe('calendarDaysBetween', () => {
    it('counts whole calendar days, not elapsed time', () => {
      assert.strictEqual(calendarDaysBetween('2026-09-02', '2026-09-02'), 0);
      assert.strictEqual(calendarDaysBetween('2026-09-02', '2026-09-03'), 1);
      assert.strictEqual(calendarDaysBetween('2026-09-02', '2026-09-01'), -1);
    });

    it('crosses month and year boundaries', () => {
      assert.strictEqual(calendarDaysBetween('2026-01-31', '2026-02-01'), 1);
      assert.strictEqual(calendarDaysBetween('2026-12-31', '2027-01-01'), 1);
      assert.strictEqual(calendarDaysBetween('2026-09-02', '2026-12-01'), 90);
    });

    it('handles a leap day', () => {
      assert.strictEqual(calendarDaysBetween('2028-02-28', '2028-03-01'), 2);
      assert.strictEqual(calendarDaysBetween('2027-02-28', '2027-03-01'), 1);
    });

    it('is immune to the DST-style shifts that break elapsed-millisecond math', () => {
      // The dates are parsed as UTC midnights and differenced, so no local offset can move the
      // boundary by a day - the failure mode that would flip a licence a day early or late.
      assert.strictEqual(calendarDaysBetween('2026-03-28', '2026-03-30'), 2);
      assert.strictEqual(calendarDaysBetween('2026-10-24', '2026-10-26'), 2);
    });
  });
});
