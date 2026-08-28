import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createFaultReportedEvent,
  createMeterReadingRecordedEvent,
  createSpareIssuedEvent,
  createWorkOrderCompletedEvent,
  createWorkOrderStatusUpdatedEvent,
} from '../../src/capture/maintenance';
import { istCalendarDate } from '../../src/capture/business-date';
import { createIndentRaisedEvent } from '../../src/capture/indent';
import { createTestCaptureEvent } from '../../src/capture/test-capture';
import { classifyServerUploadFailure } from '../../src/sync/connector';
import { errorMessage } from '../../src/i18n/locale';
import { EdgeSchema } from '../../src/local-db/schema';

const ACTOR = {
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'maintenance_technician',
  siteId: '33333333-3333-4333-8333-333333333333',
  deviceId: 'EDGE-TAB-07',
  occurredAt: '2026-08-28T09:15:00.000Z',
};
const WORK_ORDER_ID = '11111111-1111-4111-8111-111111111111';
const ASSET_ID = '44444444-4444-4444-8444-444444444444';
const EVENT_ID = '55555555-5555-4555-8555-555555555555';

// The Story 7.8 Task 6.1 block: every code mirrored into both PERMANENT_ERROR_CODES twins. Each
// must settle needs_attention (never halt the outbox as an auth failure at 403) and carry a
// localized message. DUPLICATE_EVENT is deliberately absent (409 settles as synced).
const MAINTENANCE_PERMANENT_CODES = [
  'CENTRAL_ONLY_OPERATION',
  'INVALID_STATUS_TRANSITION',
  'WORK_ORDER_NOT_FOUND',
  'WORK_ORDER_ALREADY_COMPLETED',
  'WORK_ORDER_DERIVATION_MISMATCH',
  'CLOSURE_CODES_REQUIRED',
  'CLOSURE_CODE_INVALID',
  'ASSET_NOT_FOUND',
  'ASSET_TAG_MISMATCH',
  'METER_NOT_FOUND',
  'METER_READING_REGRESSION',
  'RESERVATION_NOT_FOUND',
  'RESERVATION_NOT_RESERVED',
  'SPARE_DERIVATION_MISMATCH',
  'COST_DERIVATION_MISMATCH',
  'INVALID_PAYLOAD',
  'STREAM_CONFLICT',
];

describe('Story 7.8 offline technician capture builders', () => {
  it('builds a fault report on a NEW stream at version 1 with the tag only', () => {
    const event = createFaultReportedEvent({
      ...ACTOR,
      assetTag: ' CNC-01 ',
      description: ' Spindle noise ',
      safetyFlag: true,
      faultReportId: WORK_ORDER_ID,
      eventId: EVENT_ID,
    });
    assert.equal(event.stream_type, 'maintenance');
    assert.equal(event.stream_id, WORK_ORDER_ID);
    assert.equal(event.event_type, 'maintenance.fault_reported');
    assert.equal(event.event_version, 1);
    assert.equal(event.idempotency_key, `edge-fault-${EVENT_ID}`);
    assert.equal(event.metadata.capture_method, 'MANUAL');
    assert.deepEqual(event.payload, {
      fault_report_id: WORK_ORDER_ID,
      asset_tag: 'CNC-01',
      description: 'Spindle noise',
      safety_flag: true,
      reported_at: ACTOR.occurredAt,
    });
    assert.equal('asset_id' in event.payload, false);
    assert.equal(event.metadata.actor.user_id, ACTOR.userId);
    assert.equal(event.metadata.device_id, ACTOR.deviceId);
  });

  it('builds a status update on the work-order stream at the supplied head + 1', () => {
    const event = createWorkOrderStatusUpdatedEvent({
      ...ACTOR,
      workOrderId: WORK_ORDER_ID,
      assetId: ASSET_ID,
      newStatus: 'on_hold',
      note: '  waiting for spares ',
      eventVersion: 4,
      eventId: EVENT_ID,
    });
    assert.equal(event.stream_id, WORK_ORDER_ID);
    assert.equal(event.event_type, 'maintenance.work_order_status_updated');
    assert.equal(event.event_version, 4);
    assert.equal(event.idempotency_key, `edge-wo-status-${EVENT_ID}`);
    assert.deepEqual(event.payload, {
      work_order_id: WORK_ORDER_ID,
      asset_id: ASSET_ID,
      new_status: 'on_hold',
      note: 'waiting for spares',
      updated_at: ACTOR.occurredAt,
    });
    assert.equal('previous_status' in event.payload, false);
  });

  it('builds a meter reading with the version OMITTED (null) so the server assigns it', () => {
    const event = createMeterReadingRecordedEvent({
      ...ACTOR,
      meterId: ASSET_ID,
      assetId: WORK_ORDER_ID,
      readingValue: 1234.5,
      readingId: EVENT_ID,
      eventId: EVENT_ID,
    });
    assert.equal(event.stream_id, ASSET_ID);
    assert.equal(event.event_type, 'maintenance.meter_reading_recorded');
    assert.equal(event.event_version, null);
    assert.equal(event.idempotency_key, `edge-meter-${EVENT_ID}`);
    assert.deepEqual(event.payload, {
      reading_id: EVENT_ID,
      meter_id: ASSET_ID,
      asset_id: WORK_ORDER_ID,
      reading_value: 1234.5,
      reading_at: ACTOR.occurredAt,
      source: 'manual',
      capture_method: 'manual_entry',
    });
  });

  it('builds a spares issue on the reservation stream, omits return_due_date and stamps the IST business date', () => {
    const event = createSpareIssuedEvent({
      ...ACTOR,
      reservationId: ASSET_ID,
      quantity: '2.000000',
      eventVersion: 2,
      eventId: EVENT_ID,
      occurredAt: '2026-08-28T19:30:00.000Z',
    });
    assert.equal(event.stream_id, ASSET_ID);
    assert.equal(event.event_type, 'maintenance.spare_issued');
    assert.equal(event.event_version, 2);
    assert.equal(event.idempotency_key, `edge-spare-issue-${EVENT_ID}`);
    assert.deepEqual(event.payload, {
      reservation_id: ASSET_ID,
      quantity: '2.000000',
      issued_at: '2026-08-28T19:30:00.000Z',
      business_date: '2026-08-29',
    });
    assert.equal('return_due_date' in event.payload, false);
  });

  it('builds a closure on the work-order stream carrying all three codes', () => {
    const event = createWorkOrderCompletedEvent({
      ...ACTOR,
      workOrderId: WORK_ORDER_ID,
      assetId: ASSET_ID,
      faultCode: 'MECHANICAL',
      causeCode: 'WEAR',
      remedyCode: 'REPLACED',
      eventVersion: 3,
      eventId: EVENT_ID,
    });
    assert.equal(event.stream_id, WORK_ORDER_ID);
    assert.equal(event.event_type, 'maintenance.work_order_completed');
    assert.equal(event.event_version, 3);
    assert.equal(event.idempotency_key, `edge-wo-close-${EVENT_ID}`);
    assert.deepEqual(event.payload, {
      work_order_id: WORK_ORDER_ID,
      asset_id: ASSET_ID,
      completed_at: ACTOR.occurredAt,
      fault_code: 'MECHANICAL',
      cause_code: 'WEAR',
      remedy_code: 'REPLACED',
    });
  });

  it('builds a code-less closure for a preventive work order, omitting the three code fields', () => {
    const event = createWorkOrderCompletedEvent({
      ...ACTOR,
      workOrderId: WORK_ORDER_ID,
      assetId: ASSET_ID,
      faultCode: '',
      causeCode: '',
      remedyCode: '',
      eventVersion: 3,
      eventId: EVENT_ID,
    });
    assert.equal(event.event_type, 'maintenance.work_order_completed');
    assert.equal('fault_code' in event.payload, false);
    assert.equal('cause_code' in event.payload, false);
    assert.equal('remedy_code' in event.payload, false);
    assert.deepEqual(event.payload, {
      work_order_id: WORK_ORDER_ID,
      asset_id: ASSET_ID,
      completed_at: ACTOR.occurredAt,
    });
  });

  it('keeps the existing builders at version 1 (createOutboxEvent default unchanged)', () => {
    const indent = createIndentRaisedEvent({
      sku: 'SKU-1',
      itemCategory: 'raw',
      requestedQty: 1,
      uom: 'EA',
      needByDate: '2026-09-01',
      departmentCode: 'PROD',
      businessStream: 'trading',
      urgent: false,
      userId: ACTOR.userId,
      role: ACTOR.role,
      siteId: ACTOR.siteId,
      deviceId: ACTOR.deviceId,
    });
    assert.equal(indent.event_version, 1);
    assert.equal(createTestCaptureEvent(ACTOR).event_version, 1);
  });

  it('istCalendarDate rolls to the next IST day at 18:30 UTC', () => {
    assert.equal(istCalendarDate('2026-08-28T18:29:59.999Z'), '2026-08-28');
    assert.equal(istCalendarDate('2026-08-28T18:30:00.000Z'), '2026-08-29');
    assert.equal(istCalendarDate('2026-12-31T18:30:00.000Z'), '2027-01-01');
    assert.throws(() => istCalendarDate('not-a-date'));
  });

  it('localizes and permanently settles every maintenance business rejection at 409 and 403', () => {
    for (const code of MAINTENANCE_PERMANENT_CODES) {
      assert.equal(
        classifyServerUploadFailure(409, { error_code: code }).localStatus,
        'needs_attention',
        code,
      );
      assert.equal(
        classifyServerUploadFailure(403, { error_code: code }).localStatus,
        'needs_attention',
        code,
      );
      assert.notEqual(errorMessage(code), code, `errors.${code} is missing from en.json`);
    }
  });

  it('registers the three localOnly worklist cache tables and no new synced table', () => {
    const tables = EdgeSchema.tables;
    for (const name of ['cached_work_order', 'cached_spare_reservation', 'cached_closure_code']) {
      const table = tables.find((candidate) => candidate.name === name);
      assert.ok(table, `${name} is not in the edge schema`);
      assert.equal(table.localOnly, true, `${name} must be localOnly`);
    }
    assert.equal(
      tables.filter((table) => !table.localOnly).map((table) => table.name).sort().join(','),
      'bom,bom_alternate,bom_line,bom_revision,edge_outbox',
    );
  });
});
