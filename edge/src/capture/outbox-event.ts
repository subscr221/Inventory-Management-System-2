import type { EdgeEventRecord } from './test-capture';

export function createOutboxEvent(input: {
  eventId: string;
  streamType: string;
  streamId: string;
  eventType: string;
  payload: Record<string, unknown>;
  userId: string;
  role: string;
  siteId: string;
  correlationId: string;
  deviceId: string;
  idempotencyKey: string;
  occurredAt: string;
  captureMethod?: 'AUTO' | 'MANUAL';
  /**
   * Story 7.8 (Binding Decision 2): the declared stream version. Absent means 1 (every existing
   * builder targets a fresh stream); a number is the device's local_head_version + 1 for a
   * capture on an EXISTING stream; null means "server assigns" (meter readings), and the
   * connector strips the field from the POST body.
   */
  eventVersion?: number | null;
}): EdgeEventRecord {
  return {
    event_id: input.eventId,
    stream_type: input.streamType,
    stream_id: input.streamId,
    event_type: input.eventType,
    event_version: input.eventVersion === undefined ? 1 : input.eventVersion,
    payload: input.payload,
    metadata: {
      correlation_id: input.correlationId,
      actor: { user_id: input.userId, role: input.role, location_id: input.siteId },
      device_id: input.deviceId,
      capture_method: input.captureMethod ?? 'AUTO',
      occurred_at: input.occurredAt,
    },
    schema_version: 1,
    idempotency_key: input.idempotencyKey,
    local_status: 'pending_sync',
    server_error_code: null,
    server_error_details: null,
    created_at: input.occurredAt,
    updated_at: input.occurredAt,
  };
}
