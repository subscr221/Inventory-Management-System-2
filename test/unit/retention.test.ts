import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { retentionCutoff } from '../../src/config/audit.js';

// Task 5.5: retention boundary semantics. Eligibility in the archive CLI is `created_at < cutoff`
// (strict). Retention counts in Indian financial years (1 April - 31 March, UTC): the cutoff is
// 1 April of the FY `years` before the FY containing `now`.
describe('retentionCutoff (Task 5.5)', () => {
  const now = new Date('2034-07-18T12:00:00.000Z'); // FY 2034-35

  it('the cutoff is 1 April of the FY 8 years back, and an entry on the boundary is not archived', () => {
    const cutoff = retentionCutoff(now, 8);
    assert.strictEqual(cutoff.toISOString(), '2026-04-01T00:00:00.000Z');
    // created_at < cutoff is FALSE for an entry created exactly at the boundary.
    assert.strictEqual(cutoff.getTime() < cutoff.getTime(), false);
  });

  it('an entry from the previous FY is eligible', () => {
    const cutoff = retentionCutoff(now, 8);
    const lastDayOfPriorFy = new Date('2026-03-31T12:00:00.000Z');
    assert.strictEqual(lastDayOfPriorFy.getTime() < cutoff.getTime(), true);
  });

  it('an entry 1 millisecond past the boundary is eligible', () => {
    const cutoff = retentionCutoff(now, 8);
    const justPast = new Date(cutoff.getTime() - 1);
    assert.strictEqual(justPast.getTime() < cutoff.getTime(), true);
  });

  it('respects a configured retention other than 8 years', () => {
    const cutoff = retentionCutoff(now, 10);
    assert.strictEqual(cutoff.toISOString(), '2024-04-01T00:00:00.000Z');
  });

  it('a date before 1 April belongs to the previous financial year', () => {
    // 2032-02-29 is in FY 2031-32, so 8 FYs back is FY 2023-24, starting 1 April 2023.
    const cutoff = retentionCutoff(new Date('2032-02-29T00:00:00.000Z'), 8);
    assert.strictEqual(cutoff.toISOString(), '2023-04-01T00:00:00.000Z');
    // 1 April itself already belongs to the new FY.
    const onBoundary = retentionCutoff(new Date('2032-04-01T00:00:00.000Z'), 8);
    assert.strictEqual(onBoundary.toISOString(), '2024-04-01T00:00:00.000Z');
  });
});
