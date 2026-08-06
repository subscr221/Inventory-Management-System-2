import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertSupplierScorecardShape } from '../../src/compliance/supplier-scorecard.js';
import type { EventEnvelope } from '../../src/events/store.js';

/**
 * Story 4.2 Task 8.9: every rejection branch of the seam's pre-transaction shape validation
 * (AC6). One test per branch - the seam, not the route, is the enforcement layer.
 */

function envelope(payloadOverrides: Record<string, unknown>): EventEnvelope {
  return {
    stream_type: 'procurement',
    stream_id: randomUUID(),
    event_type: 'supplier_scorecard.metric_recorded',
    payload: {
      metric_id: randomUUID(),
      supplier_id: randomUUID(),
      metric_kind: 'on_time_delivery',
      reference_event_id: randomUUID(),
      reference_entity_id: randomUUID(),
      value_num: '2.500000',
      context: { received_date: '2026-08-01', promised_delivery_date: '2026-07-30' },
      business_date: '2026-08-01',
      ...payloadOverrides,
    },
    metadata: {
      correlation_id: randomUUID(),
      actor: { user_id: randomUUID(), role: 'r', location_id: randomUUID() },
      occurred_at: new Date().toISOString(),
    },
  } as EventEnvelope;
}

function assertRejects(payloadOverrides: Record<string, unknown>, expectedCode: string): void {
  assert.throws(
    () => assertSupplierScorecardShape(envelope(payloadOverrides)),
    (err: unknown) => (err as { errorCode?: string }).errorCode === expectedCode,
    `expected ${expectedCode} for ${JSON.stringify(payloadOverrides)}`,
  );
}

describe('Story 4.2 supplier scorecard shape validation', () => {
  it('accepts a well-formed on_time_delivery payload', () => {
    assert.doesNotThrow(() => assertSupplierScorecardShape(envelope({})));
  });

  it('ignores non-scorecard events entirely', () => {
    const other = envelope({});
    (other as { event_type: string }).event_type = 'purchase_order.issued';
    assert.doesNotThrow(() => assertSupplierScorecardShape(other));
  });

  it('rejects a malformed metric_id', () => {
    assertRejects({ metric_id: 'not-a-uuid' }, 'INVALID_PARAMS');
  });

  it('rejects the nil UUID for metric_id', () => {
    assertRejects({ metric_id: '00000000-0000-0000-0000-000000000000' }, 'INVALID_PARAMS');
  });

  it('rejects a malformed supplier_id', () => {
    assertRejects({ supplier_id: 42 }, 'INVALID_PARAMS');
  });

  it('rejects an unknown metric_kind', () => {
    assertRejects({ metric_kind: 'vibes' }, 'INVALID_PARAMS');
  });

  it('rejects a malformed reference_event_id and reference_entity_id', () => {
    assertRejects({ reference_event_id: 'x' }, 'INVALID_PARAMS');
    assertRejects({ reference_entity_id: 'x' }, 'INVALID_PARAMS');
  });

  it('rejects a non-numeric value_num', () => {
    assertRejects({ value_num: 'abc' }, 'INVALID_PARAMS');
    assertRejects({ value_num: 2.5 }, 'INVALID_PARAMS');
  });

  it('rejects an oversize NUMERIC value_num (more than 8 integer or 6 decimal digits)', () => {
    assertRejects({ value_num: '123456789.000000' }, 'INVALID_PARAMS');
    assertRejects({ value_num: '1.1234567' }, 'INVALID_PARAMS');
  });

  it('rejects calendar-date rollovers and sentinel years for business_date', () => {
    assertRejects({ business_date: '2026-02-31' }, 'INVALID_PARAMS');
    assertRejects({ business_date: '1970-01-01' }, 'INVALID_PARAMS');
    assertRejects({ business_date: '9999-12-31' }, 'INVALID_PARAMS');
    assertRejects({ business_date: '2026-8-1' }, 'INVALID_PARAMS');
  });

  it('rejects a malformed supersedes_metric_id when present', () => {
    assertRejects({ supersedes_metric_id: 'nope' }, 'INVALID_PARAMS');
  });

  it('rejects a non-object context', () => {
    assertRejects({ context: 'text' }, 'INVALID_PARAMS');
    assertRejects({ context: ['a'] }, 'INVALID_PARAMS');
  });

  it('rejects missing required context keys per metric kind', () => {
    assertRejects({ context: { promised_delivery_date: '2026-07-30' } }, 'INVALID_PARAMS');
    assertRejects(
      { metric_kind: 'price_variance', context: { po_id: randomUUID() } },
      'INVALID_PARAMS',
    );
    assertRejects(
      { metric_kind: 'responsiveness', context: { issued_at: new Date().toISOString() } },
      'INVALID_PARAMS',
    );
    assertRejects({ metric_kind: 'quality_acceptance', context: {} }, 'INVALID_PARAMS');
  });
});
