import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestCaptureEvent } from '../../src/capture/test-capture';

describe('edge test capture event', () => {
  it('creates a pending local event with idempotency and device identity', () => {
    const event = createTestCaptureEvent({
      userId: '11111111-1111-4111-8111-111111111111',
      role: 'gate_officer',
      siteId: '55555555-5555-4555-8555-555555555555',
      deviceId: 'EDGE-TAB-01',
      occurredAt: '2026-07-20T03:30:00.000Z',
    });

    assert.equal(event.local_status, 'pending_sync');
    assert.equal(event.metadata.device_id, 'EDGE-TAB-01');
    assert.equal(event.metadata.capture_method, 'MANUAL');
    assert.match(event.idempotency_key, /^edge-shell-test-/);
    assert.equal(event.event_type, 'edge.test_capture_recorded');
  });
});
