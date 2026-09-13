import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertRegisteredStream, validateEnvelope } from '../../src/events/store.js';
import { SUPPORTED_EVENT_TYPES } from '../../src/events/schema.js';

/**
 * Deferred-work 285 (pilot triage rank 5, applied 2026-09-13): a registered event_type on any
 * stream_type other than its registered one is INVALID_EVENT_STREAM. Pure check, pinned here;
 * the doors and persistEvent all call it.
 */
function envelope(streamType: string, eventType: string) {
  return {
    stream_type: streamType,
    stream_id: randomUUID(),
    event_type: eventType,
    payload: { site_id: randomUUID() },
    metadata: {
      correlation_id: randomUUID(),
      causation_id: null,
      actor: { user_id: randomUUID(), role: 'warehouse_manager', location_id: randomUUID() },
      occurred_at: new Date().toISOString(),
    },
    idempotency_key: randomUUID(),
  };
}

describe('assertRegisteredStream', () => {
  it('refuses a registered event type on a stream other than its registered one', () => {
    assert.throws(
      () => assertRegisteredStream({ stream_type: 'warehouse', event_type: 'gate.entered' }),
      (err: unknown) => {
        const e = err as { errorCode?: string; details?: Record<string, unknown> };
        return (
          e.errorCode === 'INVALID_EVENT_STREAM' && e.details?.['registered_stream_type'] === 'gate'
        );
      },
    );
  });

  it('accepts a registered event type on its own stream and leaves unregistered types alone', () => {
    assert.doesNotThrow(() =>
      assertRegisteredStream({ stream_type: 'gate', event_type: 'gate.entered' }),
    );
    assert.doesNotThrow(() =>
      assertRegisteredStream({ stream_type: 'anything', event_type: 'never.registered' }),
    );
  });

  it('is wired into validateEnvelope ahead of the payload checks', () => {
    assert.throws(
      () => validateEnvelope(envelope('warehouse', 'gate.entered')),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'INVALID_EVENT_STREAM',
    );
    assert.doesNotThrow(() => validateEnvelope(envelope('gate', 'gate.entered')));
  });

  it('every registered event names exactly one stream (the invariant the check relies on)', () => {
    for (const [type, entry] of Object.entries(SUPPORTED_EVENT_TYPES)) {
      assert.equal(typeof (entry as { streamType: unknown }).streamType, 'string', type);
    }
  });
});
