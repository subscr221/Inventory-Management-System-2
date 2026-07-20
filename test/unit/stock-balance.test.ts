import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertStockBalanceShape, stockBalanceEventKind } from '../../src/compliance/stock-balance.js';
import type { EventEnvelope } from '../../src/events/store.js';
import { AppError } from '../../src/middleware/error.js';

const STREAM_ID = '11111111-1111-4111-8111-111111111111';
const LOCATION_ID = '55555555-5555-4555-8555-555555555555';

function makeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    stream_type: 'inventory',
    stream_id: STREAM_ID,
    event_type: 'stock.received',
    payload: {
      business_stream: 'production',
      sku: 'RM-0042',
      target_location_id: LOCATION_ID,
      quantity: 10,
    },
    metadata: {
      correlation_id: '33333333-3333-4333-8333-333333333333',
      actor: {
        user_id: '44444444-4444-4444-8444-444444444444',
        role: 'warehouse_operator',
        location_id: LOCATION_ID,
      },
      occurred_at: '2026-07-21T00:00:00.000Z',
    },
    ...overrides,
  };
}

function expectInvalidParams(envelope: EventEnvelope): void {
  assert.throws(
    () => assertStockBalanceShape(envelope),
    (err: unknown) => err instanceof AppError && err.statusCode === 400 && err.errorCode === 'INVALID_PARAMS',
  );
}

describe('stock-balance seam gating (Story 2.2)', () => {
  it('ignores non-inventory stream types', () => {
    assert.strictEqual(stockBalanceEventKind(makeEnvelope({ stream_type: 'doa_registry_entry' })), null);
  });

  it('ignores inventory events that are not stock-balance event types (e.g. stock.moved)', () => {
    assert.strictEqual(stockBalanceEventKind(makeEnvelope({ event_type: 'stock.moved' })), null);
  });

  it('ignores legacy spine-shape stock events without master references', () => {
    assert.strictEqual(
      stockBalanceEventKind(makeEnvelope({ payload: { business_stream: 'production', quantity: 1 } })),
      null,
      'a stock.received with neither sku nor target location must pass through untouched',
    );
  });

  it('ignores Story 1.1-shape stock events with a sku but no target location', () => {
    assert.strictEqual(
      stockBalanceEventKind(makeEnvelope({ payload: { business_stream: 'production', sku: 'RM-0042', quantity: 100 } })),
      null,
    );
  });

  it('gates stock.received and stock.allocated referencing both sku and a target location', () => {
    assert.strictEqual(stockBalanceEventKind(makeEnvelope()), 'receipt');
    assert.strictEqual(stockBalanceEventKind(makeEnvelope({ event_type: 'stock.allocated' })), 'allocation');
    assert.strictEqual(
      stockBalanceEventKind(
        makeEnvelope({ payload: { business_stream: 'production', sku: 'RM-0042', target_location_code: 'SITE-A', quantity: 1 } }),
      ),
      'receipt',
      'target_location_code alone must also gate',
    );
  });
});

describe('assertStockBalanceShape (Story 2.2)', () => {
  it('accepts a minimal valid receipt and a minimal valid allocation', () => {
    assertStockBalanceShape(makeEnvelope());
    assertStockBalanceShape(
      makeEnvelope({
        event_type: 'stock.allocated',
        payload: {
          business_stream: 'production',
          sku: 'RM-0042',
          target_location_id: LOCATION_ID,
          quantity: 2,
          lot_id: 'LOT-001',
          allocation_ref: 'SO-1001',
        },
      }),
    );
  });

  it('does not validate ungated shapes at all', () => {
    // Missing quantity on a legacy shape must NOT throw - the seam is gated off.
    assertStockBalanceShape(makeEnvelope({ payload: { business_stream: 'production', sku: 'RM-0042' } }));
  });

  it('rejects a gated event with missing, zero, negative, or non-numeric quantity', () => {
    for (const quantity of [undefined, 0, -5, 'ten', Number.NaN, Number.POSITIVE_INFINITY]) {
      expectInvalidParams(
        makeEnvelope({
          payload: {
            business_stream: 'production',
            sku: 'RM-0042',
            target_location_id: LOCATION_ID,
            ...(quantity !== undefined ? { quantity } : {}),
          },
        }),
      );
    }
  });

  it('rejects a client-supplied available value - available is always derived', () => {
    expectInvalidParams(
      makeEnvelope({
        payload: { business_stream: 'production', sku: 'RM-0042', target_location_id: LOCATION_ID, quantity: 1, available: 99 },
      }),
    );
  });

  it('rejects an empty lot_id and a negative or non-numeric unit_cost when supplied', () => {
    expectInvalidParams(
      makeEnvelope({
        payload: { business_stream: 'production', sku: 'RM-0042', target_location_id: LOCATION_ID, quantity: 1, lot_id: '  ' },
      }),
    );
    expectInvalidParams(
      makeEnvelope({
        payload: { business_stream: 'production', sku: 'RM-0042', target_location_id: LOCATION_ID, quantity: 1, unit_cost: -2 },
      }),
    );
    expectInvalidParams(
      makeEnvelope({
        payload: { business_stream: 'production', sku: 'RM-0042', target_location_id: LOCATION_ID, quantity: 1, unit_cost: 'costly' },
      }),
    );
  });
});
