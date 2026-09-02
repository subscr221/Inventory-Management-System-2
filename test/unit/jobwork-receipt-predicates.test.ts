import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  receiptVarianceQty,
  receiptVarianceFlagged,
  firstReceiptTransitionRequired,
  orderAcceptsReceipt,
  isPositiveQtyString,
  assertJobworkMaterialReceivedShape,
  JOBWORK_MATERIAL_RECEIVED,
} from '../../src/compliance/jobwork-receipt.js';
import type { EventEnvelope } from '../../src/events/store.js';
import { AppError } from '../../src/middleware/error.js';

/**
 * Story 9.2 (Task 7.3): the tolerance predicate takes the tolerance as a PARAMETER (the 8.4
 * tautological-config lesson), so these tests exercise real boundaries with literal expectations,
 * never the config against itself. The transition and receivability predicates are the two arms
 * the custody applier consults; the shape assert is the closed-shape pre-DB gate.
 */

describe('Story 9.2 receipt variance arithmetic', () => {
  it('computes the signed variance received - challan as a 3-decimal NUMERIC string', () => {
    assert.strictEqual(receiptVarianceQty('100.000', '100.000'), '0.000');
    assert.strictEqual(receiptVarianceQty('102.5', '100'), '2.500');
    assert.strictEqual(receiptVarianceQty('99.25', '100.000'), '-0.750');
    assert.strictEqual(receiptVarianceQty('0.001', '0.002'), '-0.001');
    assert.strictEqual(receiptVarianceQty('123456789012345', '1'), '123456789012344.000');
  });

  it('accepts only strictly positive NUMERIC(18,3) strings', () => {
    for (const ok of ['1', '0.001', '100.5', '123456789012345.999']) {
      assert.strictEqual(isPositiveQtyString(ok), true, ok);
    }
    for (const bad of ['0', '0.000', '-1', '1.0000', '1e3', ' 1', '', 1, null, undefined, '.5']) {
      assert.strictEqual(isPositiveQtyString(bad), false, String(bad));
    }
  });
});

describe('Story 9.2 receipt tolerance predicate (FR-JW-05)', () => {
  it('flags a deviation strictly above the band, on both signs', () => {
    // 0.5 percent of 1000 is 5.000
    assert.strictEqual(receiptVarianceFlagged('5.001', '1000', '0.5'), true);
    assert.strictEqual(receiptVarianceFlagged('-5.001', '1000', '0.5'), true);
    assert.strictEqual(receiptVarianceFlagged('50', '1000', '0.5'), true);
  });

  it('does not flag a deviation inside the band, on both signs', () => {
    assert.strictEqual(receiptVarianceFlagged('4.999', '1000', '0.5'), false);
    assert.strictEqual(receiptVarianceFlagged('-4.999', '1000', '0.5'), false);
    assert.strictEqual(receiptVarianceFlagged('0.000', '1000', '0.5'), false);
  });

  it('does not flag exactly at the band (strict comparison)', () => {
    assert.strictEqual(receiptVarianceFlagged('5.000', '1000', '0.5'), false);
    assert.strictEqual(receiptVarianceFlagged('-5.000', '1000', '0.5'), false);
    // 2.5 percent of 40 is exactly 1.000
    assert.strictEqual(receiptVarianceFlagged('1.000', '40', '2.5'), false);
    assert.strictEqual(receiptVarianceFlagged('1.001', '40', '2.5'), true);
  });

  it('a zero tolerance flags ANY non-zero deviation and never a zero one', () => {
    assert.strictEqual(receiptVarianceFlagged('0.001', '1000', '0'), true);
    assert.strictEqual(receiptVarianceFlagged('-0.001', '1000', '0'), true);
    assert.strictEqual(receiptVarianceFlagged('0.000', '1000', '0'), false);
  });

  it('settles in exact decimal arithmetic where a float comparison would be wrong', () => {
    // 0.1 percent of 3 is 0.003; a float product gives 0.0030000000000000005
    assert.strictEqual(receiptVarianceFlagged('0.003', '3', '0.1'), false);
    assert.strictEqual(receiptVarianceFlagged('0.004', '3', '0.1'), true);
    // four-decimal tolerance times three-decimal quantity: 0.0001% of 1234.567 = 0.001234567
    assert.strictEqual(receiptVarianceFlagged('0.001', '1234.567', '0.0001'), false);
    assert.strictEqual(receiptVarianceFlagged('0.002', '1234.567', '0.0001'), true);
  });

  it('is a function of the tolerance argument, not of any ambient value', () => {
    const variance = '7.000';
    assert.strictEqual(receiptVarianceFlagged(variance, '1000', '0.5'), true);
    assert.strictEqual(receiptVarianceFlagged(variance, '1000', '1'), false);
  });
});

describe('Story 9.2 order receivability and first-receipt transition predicates', () => {
  it('a receipt may post only against a confirmed or in_process order', () => {
    assert.strictEqual(orderAcceptsReceipt('confirmed'), true);
    assert.strictEqual(orderAcceptsReceipt('in_process'), true);
    assert.strictEqual(orderAcceptsReceipt('draft'), false);
    assert.strictEqual(orderAcceptsReceipt('closed'), false);
  });

  it('only the FIRST receipt (order still confirmed) fires the in_process transition', () => {
    assert.strictEqual(firstReceiptTransitionRequired('confirmed'), true);
    assert.strictEqual(firstReceiptTransitionRequired('in_process'), false);
    assert.strictEqual(firstReceiptTransitionRequired('draft'), false);
    assert.strictEqual(firstReceiptTransitionRequired('closed'), false);
  });
});

describe('Story 9.2 jobwork.material_received closed-shape assert', () => {
  const serviceOrderId = randomUUID();

  function envelopeWith(
    payload: Record<string, unknown>,
    streamType = 'jobwork',
    streamId: string = serviceOrderId,
  ): EventEnvelope {
    return {
      stream_type: streamType,
      stream_id: streamId,
      event_type: JOBWORK_MATERIAL_RECEIVED,
      payload,
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: randomUUID(), role: 'store_assistant', location_id: randomUUID() },
        occurred_at: new Date().toISOString(),
      },
    } as unknown as EventEnvelope;
  }

  function validPayload(): Record<string, unknown> {
    return {
      service_order_id: serviceOrderId,
      receipt_id: randomUUID(),
      grn_line_id: randomUUID(),
      challan_number_ext: 'CH-2026-0001',
      challan_date: '2026-09-03',
      sku: 'SKU-CUST-1',
      lot_id: 'LOT-CUST-1',
      received_qty: '100.000',
      challan_qty: '100.000',
      uom: 'KG',
      site_id: randomUUID(),
      received_by: randomUUID(),
    };
  }

  function codeOf(fn: () => void): string {
    try {
      fn();
    } catch (err) {
      if (err instanceof AppError) return err.errorCode;
      throw err;
    }
    return 'NO_ERROR';
  }

  it('accepts the documented payload and trims text fields', () => {
    const env = envelopeWith({ ...validPayload(), sku: '  SKU-CUST-1 ' });
    assertJobworkMaterialReceivedShape(env);
    assert.strictEqual(env.payload['sku'], 'SKU-CUST-1');
  });

  it('is a no-op for other event types', () => {
    const env = envelopeWith({ anything: true });
    env.event_type = 'jobwork.order_confirmed';
    assertJobworkMaterialReceivedShape(env);
  });

  it('rejects an unknown key (closed shape) and the two server-derived fields', () => {
    assert.strictEqual(
      codeOf(() => assertJobworkMaterialReceivedShape(envelopeWith({ ...validPayload(), foo: 1 }))),
      'INVALID_PARAMS',
    );
    assert.strictEqual(
      codeOf(() =>
        assertJobworkMaterialReceivedShape(envelopeWith({ ...validPayload(), variance_qty: '0' })),
      ),
      'INVALID_PARAMS',
    );
    assert.strictEqual(
      codeOf(() =>
        assertJobworkMaterialReceivedShape(
          envelopeWith({ ...validPayload(), variance_flagged: false }),
        ),
      ),
      'INVALID_PARAMS',
    );
  });

  it('rejects the event name on a foreign stream and a stream_id that is not the order', () => {
    assert.strictEqual(
      codeOf(() => assertJobworkMaterialReceivedShape(envelopeWith(validPayload(), 'inventory'))),
      'INVALID_EVENT_ENVELOPE',
    );
    assert.strictEqual(
      codeOf(() =>
        assertJobworkMaterialReceivedShape(envelopeWith(validPayload(), 'jobwork', randomUUID())),
      ),
      'INVALID_EVENT_ENVELOPE',
    );
  });

  it('rejects a zero, negative, numeric-typed, or over-precise challan_qty (division-by-zero closure)', () => {
    for (const bad of ['0', '0.000', '-5', 5, '1.0000', '']) {
      assert.strictEqual(
        codeOf(() =>
          assertJobworkMaterialReceivedShape(envelopeWith({ ...validPayload(), challan_qty: bad })),
        ),
        'INVALID_PARAMS',
        `challan_qty ${String(bad)}`,
      );
    }
    assert.strictEqual(
      codeOf(() =>
        assertJobworkMaterialReceivedShape(envelopeWith({ ...validPayload(), received_qty: '0' })),
      ),
      'INVALID_PARAMS',
    );
  });

  it('rejects a missing challan reference or a non-calendar challan_date', () => {
    for (const field of ['challan_number_ext', 'challan_date', 'sku', 'uom']) {
      const p = validPayload();
      delete p[field];
      assert.strictEqual(
        codeOf(() => assertJobworkMaterialReceivedShape(envelopeWith(p))),
        'INVALID_PARAMS',
        field,
      );
    }
    for (const bad of ['2026-02-30', '2026-13-01', '03-09-2026', 20260903]) {
      assert.strictEqual(
        codeOf(() =>
          assertJobworkMaterialReceivedShape(
            envelopeWith({ ...validPayload(), challan_date: bad }),
          ),
        ),
        'INVALID_PARAMS',
        String(bad),
      );
    }
  });

  it('rejects malformed UUID identifiers', () => {
    for (const field of [
      'service_order_id',
      'receipt_id',
      'grn_line_id',
      'site_id',
      'received_by',
    ]) {
      const p = { ...validPayload(), [field]: 'not-a-uuid' };
      const env = envelopeWith(
        p,
        'jobwork',
        field === 'service_order_id' ? 'not-a-uuid' : undefined,
      );
      assert.strictEqual(
        codeOf(() => assertJobworkMaterialReceivedShape(env)),
        'INVALID_PARAMS',
        field,
      );
    }
  });
});
