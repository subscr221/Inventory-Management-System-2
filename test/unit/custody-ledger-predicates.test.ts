import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  kitLineMatchesConsumption,
  kitLineMatchesOwnMaterial,
  custodyBalanceCovers,
  orderAcceptsCustodyPosting,
  assertCustodyConsumptionShape,
  assertCustodyOwnMaterialShape,
  isCustodyConsumptionHandoff,
  CUSTODY_CONSUMPTION,
  CUSTODY_CONSUMPTION_POSTED,
  CUSTODY_OWN_MATERIAL_ADDED,
} from '../../src/compliance/custody-ledger.js';
import {
  CUSTOMER_OWNED_PREDICATE,
  STATEMENT_ORDER_BY,
} from '../../src/read/projections/custody_ledger_entry.js';
import type { EventEnvelope } from '../../src/events/store.js';
import { AppError } from '../../src/middleware/error.js';

/**
 * Story 9.3 (Task 8.3): the seam's pure predicates take their inputs as PARAMETERS (the 8.4
 * tautological-config lesson) so every branch is exercised with literal expectations. The shape
 * asserts are the closed-shape pre-DB gates; the Symbol check is the gated door's only key.
 */

describe('Story 9.3 kit-line match predicate (FR-JW-06, FR-B-16)', () => {
  const line = (
    supply_source: 'company' | 'customer' | 'job_worker' | null,
    is_placeholder = false,
    component_sku: string | null = 'SKU-A',
  ) => ({ component_sku, is_placeholder, supply_source });

  it('matches a customer-tagged non-placeholder line for the sku', () => {
    assert.strictEqual(kitLineMatchesConsumption(line('customer'), 'SKU-A'), true);
  });
  it('matches an UNTAGGED (NULL supply_source) line - not yet reconciled, treated as customer', () => {
    assert.strictEqual(kitLineMatchesConsumption(line(null), 'SKU-A'), true);
  });
  it('refuses company- and job_worker-tagged lines', () => {
    assert.strictEqual(kitLineMatchesConsumption(line('company'), 'SKU-A'), false);
    assert.strictEqual(kitLineMatchesConsumption(line('job_worker'), 'SKU-A'), false);
  });
  it('refuses placeholder lines even when tagged customer', () => {
    assert.strictEqual(kitLineMatchesConsumption(line('customer', true, null), 'SKU-A'), false);
  });
  it('refuses a different sku', () => {
    assert.strictEqual(kitLineMatchesConsumption(line('customer'), 'SKU-B'), false);
  });

  it('own-material binding accepts company / job_worker lines only, never placeholder or customer', () => {
    assert.strictEqual(kitLineMatchesOwnMaterial(line('company')), true);
    assert.strictEqual(kitLineMatchesOwnMaterial(line('job_worker')), true);
    assert.strictEqual(kitLineMatchesOwnMaterial(line('customer')), false);
    assert.strictEqual(kitLineMatchesOwnMaterial(line(null)), false);
    assert.strictEqual(kitLineMatchesOwnMaterial(line('company', true, null)), false);
  });
});

describe('Story 9.3 custody balance predicate (exact strings, no Number())', () => {
  it('covers when balance >= requested, exactly at the boundary included', () => {
    assert.strictEqual(custodyBalanceCovers('100.000', '100'), true);
    assert.strictEqual(custodyBalanceCovers('100.000', '99.999'), true);
    assert.strictEqual(custodyBalanceCovers('100.000', '100.001'), false);
    assert.strictEqual(custodyBalanceCovers('0.000', '0.001'), false);
    assert.strictEqual(custodyBalanceCovers('-5.000', '1'), false);
  });
  it('stays exact beyond Number.MAX_SAFE_INTEGER precision', () => {
    assert.strictEqual(custodyBalanceCovers('123456789012345.678', '123456789012345.679'), false);
    assert.strictEqual(custodyBalanceCovers('123456789012345.679', '123456789012345.678'), true);
  });
  it('the balance SQL excludes processor-owned rows and the statement order is total', () => {
    assert.strictEqual(CUSTOMER_OWNED_PREDICATE, "ownership = 'customer'");
    assert.match(STATEMENT_ORDER_BY, /occurred_at ASC, created_at ASC, entry_id ASC/);
  });
});

describe('Story 9.3 order-state predicate (AC 7)', () => {
  it('in_process only', () => {
    assert.strictEqual(orderAcceptsCustodyPosting('in_process'), true);
    assert.strictEqual(orderAcceptsCustodyPosting('confirmed'), false);
    assert.strictEqual(orderAcceptsCustodyPosting('draft'), false);
    assert.strictEqual(orderAcceptsCustodyPosting('closed'), false);
  });
});

describe('Story 9.3 gated door Symbol', () => {
  it('is recognised only when the Symbol key is literally true', () => {
    const env = { payload: {} } as unknown as EventEnvelope;
    assert.strictEqual(isCustodyConsumptionHandoff(env), false);
    (env as unknown as Record<symbol, unknown>)[CUSTODY_CONSUMPTION] = true;
    assert.strictEqual(isCustodyConsumptionHandoff(env), true);
    // A JSON body cannot carry a Symbol; a same-named string key is not the door.
    const forged = { payload: {}, 'custody.consumption_handoff': true } as unknown as EventEnvelope;
    assert.strictEqual(isCustodyConsumptionHandoff(forged), false);
  });
});

function envelope(eventType: string, payload: Record<string, unknown>, streamType = 'custody') {
  return {
    stream_type: streamType,
    stream_id: payload['service_order_id'] as string,
    event_type: eventType,
    payload,
    metadata: {
      correlation_id: randomUUID(),
      actor: { user_id: randomUUID(), role: 'jobwork_coordinator', location_id: randomUUID() },
      occurred_at: new Date().toISOString(),
    },
  } as EventEnvelope;
}

function consumptionPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    service_order_id: randomUUID(),
    consumption_id: randomUUID(),
    sku: 'SKU-A',
    lot_id: 'LOT-1',
    location_id: randomUUID(),
    quantity: '10.500',
    uom: 'KG',
    site_id: randomUUID(),
    posted_by: randomUUID(),
    ...extra,
  };
}

function ownMaterialPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    service_order_id: randomUUID(),
    own_material_id: randomUUID(),
    sku: 'SKU-OWN',
    location_id: randomUUID(),
    quantity: '2',
    uom: 'EA',
    site_id: randomUUID(),
    posted_by: randomUUID(),
    ...extra,
  };
}

function expectReject(fn: () => void, code: string, fieldHint?: string): void {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    assert.strictEqual(err.errorCode, code);
    if (fieldHint) assert.ok(err.message.includes(fieldHint), err.message);
    return;
  }
  assert.fail(`expected ${code}`);
}

describe('Story 9.3 closed-shape asserts (pre-DB)', () => {
  it('accepts a well-formed consumption and trims text fields', () => {
    const env = envelope(
      CUSTODY_CONSUMPTION_POSTED,
      consumptionPayload({ sku: ' SKU-A ', lot_id: ' LOT-1 ' }),
    );
    assertCustodyConsumptionShape(env);
    assert.strictEqual(env.payload['sku'], 'SKU-A');
    assert.strictEqual(env.payload['lot_id'], 'LOT-1');
  });
  it('ignores other event types entirely', () => {
    assertCustodyConsumptionShape(
      envelope('jobwork.order_created', { service_order_id: randomUUID() }, 'jobwork'),
    );
    assertCustodyOwnMaterialShape(
      envelope('stock.issued', { service_order_id: randomUUID() }, 'inventory'),
    );
  });
  it('refuses custody.* names off the custody stream (the 8.1 stream-mismatch closure)', () => {
    expectReject(
      () =>
        assertCustodyConsumptionShape(
          envelope(CUSTODY_CONSUMPTION_POSTED, consumptionPayload(), 'jobwork'),
        ),
      'INVALID_EVENT_ENVELOPE',
    );
    expectReject(
      () =>
        assertCustodyOwnMaterialShape(
          envelope(CUSTODY_OWN_MATERIAL_ADDED, ownMaterialPayload(), 'inventory'),
        ),
      'INVALID_EVENT_ENVELOPE',
    );
  });
  it('refuses unknown keys (closed shape)', () => {
    expectReject(
      () =>
        assertCustodyConsumptionShape(
          envelope(CUSTODY_CONSUMPTION_POSTED, consumptionPayload({ extra: 1 })),
        ),
      'INVALID_PARAMS',
      'extra',
    );
    expectReject(
      () =>
        assertCustodyOwnMaterialShape(
          envelope(CUSTODY_OWN_MATERIAL_ADDED, ownMaterialPayload({ reason_note: 'x' })),
        ),
      'INVALID_PARAMS',
      'reason_note',
    );
  });
  it('refuses every server-derived field on input', () => {
    for (const field of [
      'bom_line_id',
      'kit_bom_revision_id',
      'custody_balance_after',
      'supply_source_untagged',
    ]) {
      expectReject(
        () =>
          assertCustodyConsumptionShape(
            envelope(CUSTODY_CONSUMPTION_POSTED, consumptionPayload({ [field]: randomUUID() })),
          ),
        'INVALID_PARAMS',
        field,
      );
    }
    for (const field of ['kit_bom_revision_id', 'custody_balance_after']) {
      expectReject(
        () =>
          assertCustodyOwnMaterialShape(
            envelope(CUSTODY_OWN_MATERIAL_ADDED, ownMaterialPayload({ [field]: randomUUID() })),
          ),
        'INVALID_PARAMS',
        field,
      );
    }
  });
  it('refuses a stream_id that is not the service_order_id', () => {
    const env = envelope(CUSTODY_CONSUMPTION_POSTED, consumptionPayload());
    env.stream_id = randomUUID();
    expectReject(() => assertCustodyConsumptionShape(env), 'INVALID_EVENT_ENVELOPE');
  });
  it('requires strictly positive NUMERIC-string quantities (no numbers, no zero, max 3 dp)', () => {
    for (const quantity of [10, '0', '0.000', '-1', '1.2345', '', 'abc', undefined]) {
      expectReject(
        () =>
          assertCustodyConsumptionShape(
            envelope(CUSTODY_CONSUMPTION_POSTED, consumptionPayload({ quantity })),
          ),
        'INVALID_PARAMS',
        'quantity',
      );
    }
  });
  it('consumption requires a named lot; own material accepts an absent lot and an optional bom_line_id', () => {
    expectReject(
      () =>
        assertCustodyConsumptionShape(
          envelope(CUSTODY_CONSUMPTION_POSTED, consumptionPayload({ lot_id: undefined })),
        ),
      'INVALID_PARAMS',
      'lot_id',
    );
    assertCustodyOwnMaterialShape(envelope(CUSTODY_OWN_MATERIAL_ADDED, ownMaterialPayload()));
    assertCustodyOwnMaterialShape(
      envelope(
        CUSTODY_OWN_MATERIAL_ADDED,
        ownMaterialPayload({ lot_id: 'LOT-X', bom_line_id: randomUUID() }),
      ),
    );
    expectReject(
      () =>
        assertCustodyOwnMaterialShape(
          envelope(CUSTODY_OWN_MATERIAL_ADDED, ownMaterialPayload({ bom_line_id: 'nope' })),
        ),
      'INVALID_PARAMS',
      'bom_line_id',
    );
  });
  it('requires UUIDs for every id field', () => {
    for (const field of [
      'service_order_id',
      'consumption_id',
      'location_id',
      'site_id',
      'posted_by',
    ]) {
      expectReject(
        () =>
          assertCustodyConsumptionShape(
            envelope(CUSTODY_CONSUMPTION_POSTED, consumptionPayload({ [field]: 'x' })),
          ),
        'INVALID_PARAMS',
      );
    }
  });
});
