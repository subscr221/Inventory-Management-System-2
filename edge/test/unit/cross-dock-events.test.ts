import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCrossDockCompletionEvent } from '../../src/capture/cross-dock';
import { createOutboxEvent } from '../../src/capture/outbox-event';
import { classifyServerUploadFailure } from '../../src/sync/connector';
import { errorMessage } from '../../src/i18n/locale';

const PERMANENT_CODES = [
  'INVALID_PARAMS',
  'CROSS_DOCK_TASK_NOT_FOUND',
  'CROSS_DOCK_TASK_NOT_READY',
  'CROSS_DOCK_TASK_ALREADY_COMPLETED',
  'CROSS_DOCK_STAGING_INVALID',
  'CROSS_DOCK_DESTINATION_OUTSIDE_STAGING',
  'CROSS_DOCK_SITE_MISMATCH',
  'CROSS_DOCK_ORDER_NOT_OPEN',
  'CROSS_DOCK_DEMAND_ALREADY_ALLOCATED',
  'CROSS_DOCK_QUANTITY_MISMATCH',
];

describe('Story 3.10 Task 7 known-task cross-dock capture', () => {
  it('builds the generic pending outbox shape', () => {
    const event = createOutboxEvent({
      eventId: '11111111-1111-4111-8111-111111111111',
      streamType: 'warehouse',
      streamId: '22222222-2222-4222-8222-222222222222',
      eventType: 'test.completed',
      payload: { ok: true },
      userId: '33333333-3333-4333-8333-333333333333',
      role: 'warehouse_operator',
      siteId: '44444444-4444-4444-8444-444444444444',
      correlationId: '55555555-5555-4555-8555-555555555555',
      deviceId: 'EDGE-TAB-01',
      idempotencyKey: 'known-key',
      occurredAt: '2026-07-31T10:00:00.000Z',
    });
    assert.equal(event.event_id, '11111111-1111-4111-8111-111111111111');
    assert.equal(event.idempotency_key, 'known-key');
    assert.equal(event.local_status, 'pending_sync');
  });

  it('uses the supplied event ID and idempotency key with deterministic projection IDs and scanned destination', () => {
    const event = createCrossDockCompletionEvent({
      taskId: '11111111-1111-4111-8111-111111111111',
      stagingBinCode: 'STAGE-BIN-01',
      userId: '22222222-2222-4222-8222-222222222222',
      role: 'warehouse_operator',
      siteId: '33333333-3333-4333-8333-333333333333',
      correlationId: '44444444-4444-4444-8444-444444444444',
      deviceId: 'EDGE-TAB-01',
      eventId: '55555555-5555-4555-8555-555555555555',
      idempotencyKey: 'cross-dock-confirmation-1',
      occurredAt: '2026-07-31T10:00:00.000Z',
    });

    assert.equal(event.event_id, '55555555-5555-4555-8555-555555555555');
    assert.equal(event.idempotency_key, 'cross-dock-confirmation-1');
    assert.equal(event.stream_type, 'warehouse');
    assert.equal(event.stream_id, '11111111-1111-4111-8111-111111111111');
    assert.equal(event.event_type, 'cross_dock_task.completed');
    assert.equal(event.payload['cross_dock_task_id'], event.stream_id);
    assert.equal(event.payload['to_location_code'], 'STAGE-BIN-01');
    assert.match(String(event.payload['pick_task_id']), /^[0-9a-f-]{36}$/i);
    assert.match(String(event.payload['pick_line_id']), /^[0-9a-f-]{36}$/i);
    assert.equal(event.local_status, 'pending_sync');
    assert.equal(event.metadata.device_id, 'EDGE-TAB-01');
  });

  it('localizes and permanently settles every correctable cross-dock error', () => {
    for (const code of PERMANENT_CODES) {
      assert.equal(classifyServerUploadFailure(403, { error_code: code }).localStatus, 'needs_attention');
      assert.notEqual(errorMessage(code), code);
    }
  });
});
