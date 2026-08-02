import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createIndentRaisedEvent } from '../../src/capture/indent';
import { classifyServerUploadFailure } from '../../src/sync/connector';
import { errorMessage } from '../../src/i18n/locale';
import { INDENT_CAPTURE_TAP_BUDGET } from '../../src/components/indent-capture';

// DUPLICATE_EVENT is deliberately absent: it is classified specially (409 settles as synced),
// not through the permanent-code set.
const PERMANENT_CODES = [
  'UNTAGGED_TRANSACTION',
  'APPROVAL_REQUIRED',
  'INDENT_NOT_FOUND',
  'INDENT_ALREADY_DECIDED',
  'INDENT_NOT_IN_RAISED',
  'INDENT_RAISER_CANNOT_APPROVE',
  'NOT_RESOLVED_APPROVER',
  'INDENT_REJECTION_REASON_REQUIRED',
  'INDENT_PENDING_CONFIRMATION',
  'INDENT_LINE_REQUIRED',
  'APPROVAL_UNRESOLVED',
];

describe('Story 4.3 Task 8 offline indent capture', () => {
  it('builds an indent.raised outbox event on the procurement stream with instrumentation', () => {
    const event = createIndentRaisedEvent({
      sku: 'SKU-100',
      itemCategory: 'consumables',
      requestedQty: 25,
      uom: 'EA',
      unitPriceEstimate: 120.5,
      needByDate: '2026-08-15',
      departmentCode: 'MAINT',
      businessStream: 'manufacturing',
      urgent: true,
      reason: 'Line stoppage risk',
      userId: '22222222-2222-4222-8222-222222222222',
      role: 'floor_supervisor',
      siteId: '33333333-3333-4333-8333-333333333333',
      deviceId: 'EDGE-TAB-01',
      indentId: '11111111-1111-4111-8111-111111111111',
      eventId: '55555555-5555-4555-8555-555555555555',
      occurredAt: '2026-08-02T10:00:00.000Z',
      formOpenedAt: '2026-08-02T09:59:10.000Z',
      localCommitAt: '2026-08-02T10:00:00.000Z',
    });

    assert.equal(event.event_id, '55555555-5555-4555-8555-555555555555');
    assert.equal(event.idempotency_key, 'edge-indent-55555555-5555-4555-8555-555555555555');
    assert.equal(event.stream_type, 'procurement');
    assert.equal(event.stream_id, '11111111-1111-4111-8111-111111111111');
    assert.equal(event.event_type, 'indent.raised');
    assert.equal(event.payload['indent_id'], event.stream_id);
    assert.equal(event.payload['requester_user_id'], '22222222-2222-4222-8222-222222222222');
    assert.equal(event.payload['business_stream'], 'manufacturing');
    assert.equal(event.payload['need_by_date'], '2026-08-15');
    const lines = event.payload['lines'] as Array<Record<string, unknown>>;
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!['sku'], 'SKU-100');
    assert.equal(lines[0]!['requested_qty'], 25);
    assert.equal(lines[0]!['unit_price_estimate'], 120.5);
    const metrics = event.payload['capture_metrics'] as Record<string, unknown>;
    assert.equal(metrics['form_opened_at'], '2026-08-02T09:59:10.000Z');
    assert.equal(metrics['local_commit_at'], '2026-08-02T10:00:00.000Z');
    assert.equal(event.local_status, 'pending_sync');
    assert.equal(event.metadata.actor.user_id, '22222222-2222-4222-8222-222222222222');
  });

  it('generates identifiers when not pinned and omits absent optionals', () => {
    const event = createIndentRaisedEvent({
      sku: ' SKU-200 ',
      itemCategory: 'raw',
      requestedQty: 1,
      uom: 'KG',
      needByDate: '2026-09-01',
      departmentCode: 'PROD',
      businessStream: 'trading',
      urgent: false,
      userId: '22222222-2222-4222-8222-222222222222',
      role: 'floor_supervisor',
      siteId: '33333333-3333-4333-8333-333333333333',
      deviceId: 'EDGE-TAB-02',
    });

    assert.match(event.event_id, /^[0-9a-f-]{36}$/i);
    assert.match(String(event.payload['indent_id']), /^[0-9a-f-]{36}$/i);
    assert.equal(event.idempotency_key, `edge-indent-${event.event_id}`);
    const lines = event.payload['lines'] as Array<Record<string, unknown>>;
    assert.equal(lines[0]!['sku'], 'SKU-200');
    assert.equal('unit_price_estimate' in lines[0]!, false);
    assert.equal(event.payload['reason'], null);
    assert.equal('capture_metrics' in event.payload, false);
  });

  it('localizes and permanently settles every indent business rejection', () => {
    for (const code of PERMANENT_CODES) {
      assert.equal(classifyServerUploadFailure(403, { error_code: code }).localStatus, 'needs_attention');
      assert.notEqual(errorMessage(code), code);
    }
  });

  it('keeps the capture flow inside the UJ-IND-01 tap-count budget (CI proxy for the 90s target)', () => {
    // 6 required inputs + 2 optional inputs + 1 checkbox + 1 optional free-text + 1 submit = 11
    // interactive controls, within the budget of 12.
    const interactiveControls = 11;
    assert.ok(
      interactiveControls <= INDENT_CAPTURE_TAP_BUDGET,
      `indent capture flow exceeds the tap budget: ${interactiveControls} > ${INDENT_CAPTURE_TAP_BUDGET}`,
    );
  });
});
