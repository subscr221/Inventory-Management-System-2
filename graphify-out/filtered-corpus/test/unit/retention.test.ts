import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { retentionCutoff } from '../../src/config/audit.js';

// Task 5.5: retention boundary semantics. Eligibility in the archive CLI is `created_at < cutoff`
// (strict), so an entry created exactly `years` ago is NOT yet eligible; one moment older is.
describe('retentionCutoff (Task 5.5)', () => {
  const now = new Date('2034-07-18T12:00:00.000Z');

  it('an entry exactly 8 years old is not archived', () => {
    const cutoff = retentionCutoff(now, 8);
    const exactlyEightYears = new Date('2026-07-18T12:00:00.000Z');
    assert.strictEqual(cutoff.getTime(), exactlyEightYears.getTime(), 'cutoff is exactly now minus 8 years');
    // created_at < cutoff is FALSE for an entry created exactly at the boundary.
    assert.strictEqual(exactlyEightYears.getTime() < cutoff.getTime(), false);
  });

  it('an entry 8 years and 1 day old is eligible', () => {
    const cutoff = retentionCutoff(now, 8);
    const eightYearsOneDay = new Date('2026-07-17T12:00:00.000Z');
    assert.strictEqual(eightYearsOneDay.getTime() < cutoff.getTime(), true);
  });

  it('an entry 1 millisecond past the boundary is eligible', () => {
    const cutoff = retentionCutoff(now, 8);
    const justPast = new Date(cutoff.getTime() - 1);
    assert.strictEqual(justPast.getTime() < cutoff.getTime(), true);
  });

  it('respects a configured retention other than 8 years', () => {
    const cutoff = retentionCutoff(now, 10);
    assert.strictEqual(cutoff.toISOString(), '2024-07-18T12:00:00.000Z');
  });

  it('handles the Feb 29 leap-day edge without skipping into March incorrectly', () => {
    // JS Date semantics: Feb 29 minus N years lands on Mar 1 when the target year is not a leap
    // year - documented behavior, asserted here so a future change is caught.
    const leapNow = new Date('2032-02-29T00:00:00.000Z');
    const cutoff = retentionCutoff(leapNow, 8);
    assert.strictEqual(cutoff.toISOString(), '2024-02-29T00:00:00.000Z');
    const nonLeapTarget = retentionCutoff(new Date('2032-02-29T00:00:00.000Z'), 9);
    assert.strictEqual(nonLeapTarget.toISOString(), '2023-03-01T00:00:00.000Z');
  });
});
