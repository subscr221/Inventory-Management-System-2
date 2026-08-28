import type { EdgeEventRecord } from './test-capture';
import { createOutboxEvent } from './outbox-event';
import { istCalendarDate } from './business-date';

/**
 * Story 7.8 (FR-M-17): the five technician builders, cloned from createIndentRaisedEvent. Every
 * builder produces ONE edge_outbox row on the `maintenance` stream with capture_method MANUAL, a
 * flow-prefixed idempotency key, and the version stamping of Binding Decision 2 (Table 4):
 *
 * - fault report: a NEW stream (fault_report_id), version 1
 * - status update / spares issue / closure: an EXISTING stream, `eventVersion` supplied by the
 *   caller from nextStreamVersion (local_head_version + 1)
 * - meter reading: the version is OMITTED (null) so the server assigns MAX + 1; readings are
 *   additive observations and never raise STREAM_CONFLICT
 *
 * Nothing in these payloads names the actor: every seam derives it from metadata.actor, which the
 * edge upload handler overwrites from auth.
 */
interface ActorInput {
  userId: string;
  role: string;
  siteId: string;
  deviceId: string;
  eventId?: string;
  idempotencyKey?: string;
  occurredAt?: string;
}

export interface FaultReportCaptureInput extends ActorInput {
  assetTag: string;
  description: string;
  safetyFlag: boolean;
  faultReportId?: string;
}

export function createFaultReportedEvent(input: FaultReportCaptureInput): EdgeEventRecord {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const eventId = input.eventId ?? globalThis.crypto.randomUUID();
  const faultReportId = input.faultReportId ?? globalThis.crypto.randomUUID();
  return createOutboxEvent({
    eventId,
    streamType: 'maintenance',
    streamId: faultReportId,
    eventType: 'maintenance.fault_reported',
    eventVersion: 1,
    payload: {
      fault_report_id: faultReportId,
      asset_tag: input.assetTag.trim(),
      description: input.description.trim(),
      safety_flag: input.safetyFlag,
      reported_at: occurredAt,
    },
    userId: input.userId,
    role: input.role,
    siteId: input.siteId,
    correlationId: globalThis.crypto.randomUUID(),
    deviceId: input.deviceId,
    idempotencyKey: input.idempotencyKey ?? `edge-fault-${eventId}`,
    occurredAt,
    captureMethod: 'MANUAL',
  });
}

export interface WorkOrderStatusCaptureInput extends ActorInput {
  workOrderId: string;
  assetId: string;
  newStatus: 'in_progress' | 'on_hold';
  note?: string | null;
  /** local_head_version + 1, from nextStreamVersion. */
  eventVersion: number;
}

export function createWorkOrderStatusUpdatedEvent(
  input: WorkOrderStatusCaptureInput,
): EdgeEventRecord {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const eventId = input.eventId ?? globalThis.crypto.randomUUID();
  return createOutboxEvent({
    eventId,
    streamType: 'maintenance',
    streamId: input.workOrderId,
    eventType: 'maintenance.work_order_status_updated',
    eventVersion: input.eventVersion,
    payload: {
      work_order_id: input.workOrderId,
      asset_id: input.assetId,
      new_status: input.newStatus,
      note: input.note?.trim() ? input.note.trim() : null,
      updated_at: occurredAt,
    },
    userId: input.userId,
    role: input.role,
    siteId: input.siteId,
    correlationId: globalThis.crypto.randomUUID(),
    deviceId: input.deviceId,
    idempotencyKey: input.idempotencyKey ?? `edge-wo-status-${eventId}`,
    occurredAt,
    captureMethod: 'MANUAL',
  });
}

export interface MeterReadingCaptureInput extends ActorInput {
  meterId: string;
  assetId: string;
  readingValue: number;
  readingId?: string;
}

export function createMeterReadingRecordedEvent(input: MeterReadingCaptureInput): EdgeEventRecord {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const eventId = input.eventId ?? globalThis.crypto.randomUUID();
  const readingId = input.readingId ?? globalThis.crypto.randomUUID();
  return createOutboxEvent({
    eventId,
    streamType: 'maintenance',
    streamId: input.meterId,
    eventType: 'maintenance.meter_reading_recorded',
    eventVersion: null,
    payload: {
      reading_id: readingId,
      meter_id: input.meterId,
      asset_id: input.assetId,
      reading_value: input.readingValue,
      reading_at: occurredAt,
      source: 'manual',
      capture_method: 'manual_entry',
    },
    userId: input.userId,
    role: input.role,
    siteId: input.siteId,
    correlationId: globalThis.crypto.randomUUID(),
    deviceId: input.deviceId,
    idempotencyKey: input.idempotencyKey ?? `edge-meter-${eventId}`,
    occurredAt,
    captureMethod: 'MANUAL',
  });
}

export interface SpareIssueCaptureInput extends ActorInput {
  reservationId: string;
  quantity: string;
  /** local_head_version + 1, from nextStreamVersion. */
  eventVersion: number;
}

export function createSpareIssuedEvent(input: SpareIssueCaptureInput): EdgeEventRecord {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const eventId = input.eventId ?? globalThis.crypto.randomUUID();
  return createOutboxEvent({
    eventId,
    streamType: 'maintenance',
    streamId: input.reservationId,
    eventType: 'maintenance.spare_issued',
    eventVersion: input.eventVersion,
    payload: {
      reservation_id: input.reservationId,
      quantity: input.quantity,
      issued_at: occurredAt,
      // return_due_date is OMITTED (Binding Decision 13): the server derives it from issued_at.
      business_date: istCalendarDate(occurredAt),
    },
    userId: input.userId,
    role: input.role,
    siteId: input.siteId,
    correlationId: globalThis.crypto.randomUUID(),
    deviceId: input.deviceId,
    idempotencyKey: input.idempotencyKey ?? `edge-spare-issue-${eventId}`,
    occurredAt,
    captureMethod: 'MANUAL',
  });
}

export interface WorkOrderClosureCaptureInput extends ActorInput {
  workOrderId: string;
  assetId: string;
  faultCode: string;
  causeCode: string;
  remedyCode: string;
  /** local_head_version + 1, from nextStreamVersion. */
  eventVersion: number;
}

export function createWorkOrderCompletedEvent(input: WorkOrderClosureCaptureInput): EdgeEventRecord {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const eventId = input.eventId ?? globalThis.crypto.randomUUID();
  const hasCodes = Boolean(
    input.faultCode.trim() || input.causeCode.trim() || input.remedyCode.trim(),
  );
  return createOutboxEvent({
    eventId,
    streamType: 'maintenance',
    streamId: input.workOrderId,
    eventType: 'maintenance.work_order_completed',
    eventVersion: input.eventVersion,
    payload: {
      work_order_id: input.workOrderId,
      asset_id: input.assetId,
      completed_at: occurredAt,
      // Binding Decision 8: preventive closures accept codes optionally on an all-or-none basis,
      // so a code-less preventive closure omits the three fields rather than sending empty strings.
      ...(hasCodes
        ? {
            fault_code: input.faultCode.trim(),
            cause_code: input.causeCode.trim(),
            remedy_code: input.remedyCode.trim(),
          }
        : {}),
    },
    userId: input.userId,
    role: input.role,
    siteId: input.siteId,
    correlationId: globalThis.crypto.randomUUID(),
    deviceId: input.deviceId,
    idempotencyKey: input.idempotencyKey ?? `edge-wo-close-${eventId}`,
    occurredAt,
    captureMethod: 'MANUAL',
  });
}
