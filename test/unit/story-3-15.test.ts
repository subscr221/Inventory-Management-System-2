import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../src/middleware/error.js';
import type { EventEnvelope } from '../../src/events/store.js';
import { assertEdgePutawayEventRefused } from '../../src/sync/upload.js';

/** Story 3.15 (AC 6): putaway completion and location override never travel the edge door. */

function envelope(streamType: string, eventType: string): EventEnvelope {
  return {
    stream_type: streamType,
    stream_id: randomUUID(),
    event_type: eventType,
    payload: {},
    metadata: {
      correlation_id: randomUUID(),
      actor: { user_id: randomUUID(), role: 'store_assistant', location_id: randomUUID() },
      occurred_at: new Date().toISOString(),
    },
  };
}

describe('Story 3.15 edge putaway refusal', () => {
  for (const eventType of ['putaway.completed', 'location.override']) {
    it(`refuses ${eventType}`, () => {
      assert.throws(
        () => assertEdgePutawayEventRefused(envelope('putaway', eventType)),
        (err: unknown) =>
          err instanceof AppError &&
          err.statusCode === 403 &&
          err.errorCode === 'CENTRAL_ONLY_OPERATION',
      );
    });
  }

  it('leaves other events on the putaway stream alone', () => {
    assert.doesNotThrow(() =>
      assertEdgePutawayEventRefused(envelope('putaway', 'putaway.started')),
    );
  });

  it('refuses a central-only event whatever its stream', () => {
    assert.throws(
      () => assertEdgePutawayEventRefused(envelope('receiving', 'location.override')),
      (err: unknown) =>
        err instanceof AppError &&
        err.statusCode === 403 &&
        err.errorCode === 'CENTRAL_ONLY_OPERATION',
    );
  });

  it('leaves other warehouse captures alone', () => {
    assert.doesNotThrow(() =>
      assertEdgePutawayEventRefused(envelope('warehouse', 'cross_dock_task.completed')),
    );
  });
});
