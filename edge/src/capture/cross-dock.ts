import type { EdgeEventRecord } from './test-capture';
import { createOutboxEvent } from './outbox-event';

export function createCrossDockCompletionEvent(input: {
  taskId: string;
  stagingBinCode: string;
  userId: string;
  role: string;
  siteId: string;
  correlationId: string;
  deviceId: string;
  eventId?: string;
  idempotencyKey?: string;
  occurredAt?: string;
}): EdgeEventRecord {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const eventId = input.eventId ?? globalThis.crypto.randomUUID();
  return createOutboxEvent({
    eventId,
    streamType: 'warehouse',
    streamId: input.taskId,
    eventType: 'cross_dock_task.completed',
    payload: {
      cross_dock_task_id: input.taskId,
      to_location_code: input.stagingBinCode.trim(),
      pick_task_id: globalThis.crypto.randomUUID(),
      pick_line_id: globalThis.crypto.randomUUID(),
    },
    userId: input.userId,
    role: input.role,
    siteId: input.siteId,
    correlationId: input.correlationId,
    deviceId: input.deviceId,
    idempotencyKey: input.idempotencyKey ?? `edge-cross-dock-${eventId}`,
    occurredAt,
  });
}
