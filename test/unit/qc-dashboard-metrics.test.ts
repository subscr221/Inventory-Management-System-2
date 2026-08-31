import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGING_BUCKETS,
  DASHBOARD_COVERAGE,
  DASHBOARD_SERIES_LIMIT,
  agingBucketFor,
  percent,
} from '../../src/quality/reporting.js';

/**
 * Story 8.6 (FR-Q-13, AC 5, Binding Scope Decision 11): the pure bucketing predicate behind the
 * NCR and CAPA aging metrics, exercised at every boundary. Parameterised - no config, no
 * database - so a boundary regression fails here before an integration fixture can mask it.
 */

describe('Story 8.6 dashboard metric predicates (AC 5)', () => {
  it('the aging buckets are the four fixed FR-Q-13 bands', () => {
    assert.deepStrictEqual([...AGING_BUCKETS], ['0-30', '31-60', '61-90', '90+']);
  });

  it('bucket boundaries: each band is inclusive of its upper edge', () => {
    assert.strictEqual(agingBucketFor(0), '0-30');
    assert.strictEqual(agingBucketFor(1), '0-30');
    assert.strictEqual(agingBucketFor(29), '0-30');
    assert.strictEqual(agingBucketFor(30), '0-30');
    assert.strictEqual(agingBucketFor(31), '31-60');
    assert.strictEqual(agingBucketFor(60), '31-60');
    assert.strictEqual(agingBucketFor(61), '61-90');
    assert.strictEqual(agingBucketFor(90), '61-90');
    assert.strictEqual(agingBucketFor(91), '90+');
    assert.strictEqual(agingBucketFor(365), '90+');
    assert.strictEqual(agingBucketFor(10000), '90+');
  });

  it('the drill-through bound and coverage caveat are the declared contract values', () => {
    // Binding Scope Decision 10 (limit 200) and Decision 12 (live-audit-log-only coverage).
    assert.strictEqual(DASHBOARD_SERIES_LIMIT, 200);
    assert.strictEqual(DASHBOARD_COVERAGE, 'live_audit_log_only');
  });

  it('percent: a zero denominator is no-data (null), never a fabricated 0% or 100% (AC 6)', () => {
    assert.strictEqual(percent(0, 0), null);
    assert.strictEqual(percent(5, 0), null);
  });

  it('percent: fixed-2-decimal rounding on non-zero denominators', () => {
    assert.strictEqual(percent(2, 3), '66.67');
    assert.strictEqual(percent(1, 3), '33.33');
    assert.strictEqual(percent(0, 5), '0.00');
    assert.strictEqual(percent(5, 5), '100.00');
  });
});
