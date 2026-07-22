import type { EdgeLocalStatus } from '../local-db/schema';

function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

export interface EdgeEventRecord {
  event_id: string;
  stream_type: string;
  stream_id: string;
  event_type: string;
  event_version: number;
  payload: Record<string, unknown>;
  metadata: {
    correlation_id: string;
    actor: { user_id: string; role: string; location_id: string };
    device_id: string;
    capture_method: 'AUTO' | 'MANUAL';
    occurred_at: string;
  };
  schema_version: number;
  idempotency_key: string;
  local_status: EdgeLocalStatus;
  server_error_code: string | null;
  server_error_details: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export function createGateEnteredEvent(input: {
  userId: string;
  role: string;
  siteId: string;
  siteCodeExt: string;
  poRefExt: string;
  vehicleRegExt: string;
  challanNumberExt?: string;
  challanPhotoRef: string;
  driverName?: string;
  gateId: string;
  deviceId: string;
  occurredAt?: string;
}): EdgeEventRecord {
  const now = input.occurredAt ?? new Date().toISOString();
  const gateEventId = randomUUID();
  return {
    event_id: randomUUID(),
    stream_type: 'gate',
    stream_id: gateEventId,
    event_type: 'gate.entered',
    event_version: 1,
    payload: {
      gate_event_id: gateEventId,
      site_code_ext: input.siteCodeExt,
      po_ref_ext: input.poRefExt,
      vehicle_reg_ext: input.vehicleRegExt,
      ...(input.challanNumberExt !== undefined ? { challan_number_ext: input.challanNumberExt } : {}),
      challan_photo_ref: input.challanPhotoRef,
      ...(input.driverName !== undefined ? { driver_name: input.driverName } : {}),
      gate_id: input.gateId,
      gate_officer_id: input.userId,
      entered_at: now,
    },
    metadata: {
      correlation_id: randomUUID(),
      actor: { user_id: input.userId, role: input.role, location_id: input.siteId },
      device_id: input.deviceId,
      capture_method: 'MANUAL',
      occurred_at: now,
    },
    schema_version: 1,
    idempotency_key: `edge-gate-entered-${gateEventId}`,
    local_status: 'pending_sync',
    server_error_code: null,
    server_error_details: null,
    created_at: now,
    updated_at: now,
  };
}

export function createTestCaptureEvent(input: {
  userId: string;
  role: string;
  siteId: string;
  deviceId: string;
  occurredAt?: string;
}): EdgeEventRecord {
  const now = input.occurredAt ?? new Date().toISOString();
  const eventId = randomUUID();
  return {
    event_id: eventId,
    stream_type: 'maintenance',
    stream_id: randomUUID(),
    event_type: 'edge.test_capture_recorded',
    event_version: 1,
    payload: { capture_kind: 'shell_test' },
    metadata: {
      correlation_id: randomUUID(),
      actor: { user_id: input.userId, role: input.role, location_id: input.siteId },
      device_id: input.deviceId,
      capture_method: 'MANUAL',
      occurred_at: now,
    },
    schema_version: 1,
    idempotency_key: `edge-shell-test-${eventId}`,
    local_status: 'pending_sync',
    server_error_code: null,
    server_error_details: null,
    created_at: now,
    updated_at: now,
  };
}
