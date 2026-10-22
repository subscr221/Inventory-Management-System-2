import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  completionBody,
  needsOverride,
  toSuggestion,
} from '../../src/components/putaway-task-model.js';

/** Story 3.15: pure putaway detail rules. */

describe('Story 3.15 putaway model', () => {
  it('needs an override only when a directed rack exists and differs', () => {
    assert.equal(needsOverride('A-01', 'A-01'), false);
    assert.equal(needsOverride('A-01', 'a-01'), false);
    assert.equal(needsOverride('A-01', 'B-02'), true);
    assert.equal(needsOverride(null, 'B-02'), false);
  });

  it('omits override fields when the scan matches the suggestion', () => {
    const body = completionBody({
      scannedCode: 'A-01',
      directedCode: 'A-01',
      reason: 'RACK_FULL',
      confidence: 'certain',
      idempotencyKey: 'key-1',
    });
    assert.deepEqual(body, { actual_location_code: 'A-01', idempotency_key: 'key-1' });
  });

  it('carries the fixed reason and confidence on a real override', () => {
    const body = completionBody({
      scannedCode: 'B-02',
      directedCode: 'A-01',
      reason: 'NEARER_BAY',
      confidence: 'uncertain',
      idempotencyKey: 'key-2',
    });
    assert.equal(body['override_reason_code'], 'NEARER_BAY');
    assert.equal(body['override_confidence'], 'uncertain');
  });

  it('normalises both suggestion shapes', () => {
    assert.deepEqual(
      toSuggestion({
        suggestion: { locationId: 'id', locationCode: 'A-01', velocityClass: 'A' },
      }),
      { locationId: 'id', locationCode: 'A-01', velocityClass: 'A', reason: null },
    );
    assert.deepEqual(toSuggestion({ suggestion: { locationId: null, reason: 'no bins' } }), {
      locationId: null,
      locationCode: null,
      velocityClass: null,
      reason: 'no bins',
    });
  });
});
