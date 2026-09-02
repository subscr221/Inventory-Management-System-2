import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  noticeRequirementSatisfied,
  mayClearQualityHoldFlag,
  WITNESS_HOLD_POINT_RAISED,
  WITNESS_NOTICE_RECORDED,
  WITNESSED_INSPECTION_SIGNED_OFF,
  WITNESSED_INSPECTION_WAIVED,
} from '../../src/compliance/qc-witness.js';
import { QUALITY_EVENT_TYPES, QC_CENTRAL_ONLY_EVENT_TYPES } from '../../src/compliance/quality.js';

/**
 * Story 8.8 (FR-Q-15) pure predicates, table-driven and without a database. Both are load-bearing:
 * mayClearQualityHoldFlag is the hold-bypass guard three prior reviews each found a variant of,
 * and noticeRequirementSatisfied carries the deliberate sign-off/waiver asymmetry of BSD-6.
 */

describe('Story 8.8 witness predicates', () => {
  it('BSD-1: every witness event type is in QUALITY_EVENT_TYPES and is central-only', () => {
    // quality.ts repeats these literals (it cannot import qc-witness.ts without a cycle), and the
    // Story 8.2 registry-drift guard only proves QUALITY_EVENT_TYPES matches the registry. This
    // pins the two spellings to each other, so a rename in one file fails here rather than
    // silently dropping an event out of the central-only set.
    for (const type of [
      WITNESS_HOLD_POINT_RAISED,
      WITNESS_NOTICE_RECORDED,
      WITNESSED_INSPECTION_SIGNED_OFF,
      WITNESSED_INSPECTION_WAIVED,
    ]) {
      assert.ok(QUALITY_EVENT_TYPES.has(type), `${type} missing from QUALITY_EVENT_TYPES`);
      assert.ok(QC_CENTRAL_ONLY_EVENT_TYPES.has(type), `${type} must be central-only`);
    }
  });

  it('BSD-6: a sign-off needs at least one notice; the count is the whole rule', () => {
    const cases: Array<{ count: number; expected: boolean }> = [
      { count: 0, expected: false },
      { count: 1, expected: true },
      { count: 7, expected: true },
    ];
    for (const { count, expected } of cases) {
      assert.strictEqual(noticeRequirementSatisfied(count), expected, `notice count ${count}`);
    }
  });

  it('BSD-4: the flag clears only when no other hold is open AND this hold set the reason', () => {
    const thisReason = 'Witnessed inspection pending';
    const cases: Array<{
      name: string;
      otherOpen: boolean;
      lotReason: string | null;
      expected: boolean;
    }> = [
      { name: 'sole owner clears', otherOpen: false, lotReason: thisReason, expected: true },
      {
        name: 'another open hold blocks the clear',
        otherOpen: true,
        lotReason: thisReason,
        expected: false,
      },
      {
        name: 'an independent containment owns the flag',
        otherOpen: false,
        lotReason: 'scrap_pending',
        expected: false,
      },
      {
        name: 'both conditions failing still blocks',
        otherOpen: true,
        lotReason: 'scrap_pending',
        expected: false,
      },
      {
        name: 'an unset flag reason is not ownership',
        otherOpen: false,
        lotReason: null,
        expected: false,
      },
    ];
    for (const { name, otherOpen, lotReason, expected } of cases) {
      assert.strictEqual(mayClearQualityHoldFlag(otherOpen, lotReason, thisReason), expected, name);
    }
  });
});
