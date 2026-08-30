import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORTED_EVENT_TYPES } from '../../src/events/schema.js';
import {
  QC_CENTRAL_ONLY_EVENT_TYPES,
  QC_RESULT_RECORDED,
  QUALITY_EVENT_TYPES,
} from '../../src/compliance/quality.js';
import { EDGE_QC_EVENT_TYPES } from '../../src/sync/upload.js';

/**
 * Story 8.2 Task 4 (closing the Story 8.1 deferral): the seam's event-type set must equal every
 * registry entry on the `qc` stream, so a `qc.*` type can never be registered without a shape
 * assert and an applier (or vice versa). Story 8.3 registered qc.lot_dispositioned and its three
 * siblings, so the guard now asserts they are present rather than reserved.
 */
describe('Story 8.2 quality event registry drift', () => {
  const registered = Object.entries(SUPPORTED_EVENT_TYPES)
    .filter(([, def]) => (def as { streamType: string }).streamType === 'qc')
    .map(([name]) => name)
    .sort();

  it('QUALITY_EVENT_TYPES equals every registry entry with streamType qc', () => {
    assert.deepStrictEqual([...QUALITY_EVENT_TYPES].sort(), registered);
    for (const registeredByStory83 of [
      'qc.lot_dispositioned',
      'qc.lot_split_recorded',
      'qc.ncr_outcome_recorded',
      'qc.rework_requested',
    ]) {
      assert.ok(
        registered.includes(registeredByStory83),
        `${registeredByStory83} must be registered by Story 8.3`,
      );
    }
  });

  it('the central-only set is the whole family minus qc.result_recorded, and the edge allowlist is exactly that event', () => {
    assert.ok(QUALITY_EVENT_TYPES.has(QC_RESULT_RECORDED));
    assert.ok(!QC_CENTRAL_ONLY_EVENT_TYPES.has(QC_RESULT_RECORDED));
    assert.deepStrictEqual(
      [...QC_CENTRAL_ONLY_EVENT_TYPES].sort(),
      [...QUALITY_EVENT_TYPES].filter((t) => t !== QC_RESULT_RECORDED).sort(),
    );
    assert.deepStrictEqual([...EDGE_QC_EVENT_TYPES], [QC_RESULT_RECORDED]);
  });
});
