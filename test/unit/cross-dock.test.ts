import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertGoodsReceivedShape } from '../../src/compliance/receiving.js';
import {
  assertCrossDockTaskAssignedShape,
  assertCrossDockTaskCompletedShape,
  CROSS_DOCK_ERROR_CODES,
  isCrossDockQuantityCapacity,
} from '../../src/compliance/cross-dock.js';
import { findCrossDockDemandMatch, lockSalesOrderDemandLine } from '../../src/read/projections/erp_sales_order.js';
import type {
  CrossDockTaskAssignedEnvelope,
  CrossDockTaskCompletedEnvelope,
  GoodsReceivedEnvelope,
} from '../../src/events/schema.js';
import type { EventEnvelope } from '../../src/events/store.js';
import { SUPPORTED_EVENT_TYPES } from '../../src/events/schema.js';
import { AppError } from '../../src/middleware/error.js';

function metadata(): GoodsReceivedEnvelope['metadata'] {
  return {
    correlation_id: randomUUID(),
    actor: { user_id: randomUUID(), role: 'warehouse_operator', location_id: randomUUID() },
    occurred_at: '2026-07-31T08:00:00.000Z',
  };
}

function goodsReceived(overrides: Record<string, unknown> = {}): EventEnvelope {
  return {
    stream_type: 'receiving',
    stream_id: randomUUID(),
    event_type: 'goods.received',
    metadata: metadata(),
    payload: {
      grn_id: randomUUID(),
      grn_line_id: randomUUID(),
      correlation_id: randomUUID(),
      po_ref_ext: 'PO-310',
      line_no: 1,
      source_document: 'PO',
      sku: 'SKU-310',
      target_location_id: randomUUID(),
      received_qty: '10.125',
      ...overrides,
    },
  } as EventEnvelope;
}

function assigned(overrides: Record<string, unknown> = {}): CrossDockTaskAssignedEnvelope {
  return {
    stream_type: 'warehouse',
    stream_id: randomUUID(),
    event_type: 'cross_dock_task.assigned',
    metadata: metadata(),
    payload: {
      cross_dock_task_id: randomUUID(),
      assigned_to: randomUUID(),
      ...overrides,
    },
  } as CrossDockTaskAssignedEnvelope;
}

function completed(overrides: Record<string, unknown> = {}): CrossDockTaskCompletedEnvelope {
  return {
    stream_type: 'warehouse',
    stream_id: randomUUID(),
    event_type: 'cross_dock_task.completed',
    metadata: metadata(),
    payload: {
      cross_dock_task_id: randomUUID(),
      to_location_id: randomUUID(),
      pick_task_id: randomUUID(),
      pick_line_id: randomUUID(),
      ...overrides,
    },
  } as CrossDockTaskCompletedEnvelope;
}

function expectInvalid(fn: () => void, label: string): void {
  assert.throws(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof AppError, `${label}: expected AppError`);
      assert.strictEqual(error.statusCode, 400, label);
      assert.strictEqual(error.errorCode, 'INVALID_PARAMS', label);
      return true;
    },
    label,
  );
}

describe('Story 3.10 Task 2 cross-dock event contracts', () => {
  it('registers assignment and completion on the warehouse stream without business-stream tagging', () => {
    assert.deepStrictEqual(SUPPORTED_EVENT_TYPES['cross_dock_task.assigned'], {
      streamType: 'warehouse',
      requiresBusinessStream: false,
    });
    assert.deepStrictEqual(SUPPORTED_EVENT_TYPES['cross_dock_task.completed'], {
      streamType: 'warehouse',
      requiresBusinessStream: false,
    });
  });

  it('accepts an explicit cross-dock receipt with one staging selector and deterministic task id', () => {
    assert.doesNotThrow(() =>
      assertGoodsReceivedShape(
        goodsReceived({
          cross_dock: true,
          staging_zone_id: randomUUID(),
          cross_dock_task_id: randomUUID(),
        }),
      ),
    );
  });

  it('rejects malformed or contradictory cross-dock receipt shapes', () => {
    expectInvalid(() => assertGoodsReceivedShape(goodsReceived({ cross_dock: 'true' })), 'non-boolean flag');
    expectInvalid(() => assertGoodsReceivedShape(goodsReceived({ staging_zone_code: 'STAGE-1' })), 'selector without flag');
    expectInvalid(() => assertGoodsReceivedShape(goodsReceived({ cross_dock: false, cross_dock_task_id: randomUUID() })), 'task id with false flag');
    expectInvalid(() => assertGoodsReceivedShape(goodsReceived({ cross_dock: true, cross_dock_task_id: randomUUID() })), 'missing selector');
    expectInvalid(
      () =>
        assertGoodsReceivedShape(
          goodsReceived({
            cross_dock: true,
            staging_zone_id: randomUUID(),
            staging_zone_code: 'STAGE-1',
            cross_dock_task_id: randomUUID(),
          }),
        ),
      'two selectors',
    );
    expectInvalid(
      () => assertGoodsReceivedShape(goodsReceived({ cross_dock: true, staging_zone_id: 'bad', cross_dock_task_id: randomUUID() })),
      'malformed staging UUID',
    );
    expectInvalid(
      () => assertGoodsReceivedShape(goodsReceived({ cross_dock: true, staging_zone_code: 'STAGE-1', cross_dock_task_id: 'bad' })),
      'malformed task UUID',
    );
    assert.throws(
      () => assertGoodsReceivedShape(goodsReceived({ received_qty: '10.0001' })),
      (error: unknown) => error instanceof AppError && error.statusCode === 400 && error.errorCode === 'RECEIVING_QTY_REQUIRED',
      'inexact receipt quantity',
    );
  });

  it('validates assignment identifiers and priority', () => {
    assert.doesNotThrow(() => assertCrossDockTaskAssignedShape(assigned({ priority: 'urgent' })));
    expectInvalid(() => assertCrossDockTaskAssignedShape(assigned({ cross_dock_task_id: 'bad' })), 'assignment task id');
    expectInvalid(() => assertCrossDockTaskAssignedShape(assigned({ assigned_to: 'bad' })), 'assignment assignee');
    expectInvalid(() => assertCrossDockTaskAssignedShape(assigned({ priority: 'rush' })), 'assignment priority');
  });

  it('requires deterministic fulfillment ids and exactly one completion destination selector', () => {
    assert.doesNotThrow(() => assertCrossDockTaskCompletedShape(completed()));
    assert.doesNotThrow(() => assertCrossDockTaskCompletedShape(completed({ to_location_id: undefined, to_location_code: 'STAGE-BIN-1' })));
    expectInvalid(() => assertCrossDockTaskCompletedShape(completed({ cross_dock_task_id: 'bad' })), 'completion task id');
    expectInvalid(() => assertCrossDockTaskCompletedShape(completed({ pick_task_id: 'bad' })), 'synthetic pick task id');
    expectInvalid(() => assertCrossDockTaskCompletedShape(completed({ pick_line_id: 'bad' })), 'synthetic pick line id');
    expectInvalid(() => assertCrossDockTaskCompletedShape(completed({ to_location_id: undefined })), 'missing destination');
    expectInvalid(() => assertCrossDockTaskCompletedShape(completed({ to_location_code: 'STAGE-BIN-1' })), 'two destinations');
  });

  it('exposes only the bounded stable cross-dock failure vocabulary', () => {
    assert.deepStrictEqual(Object.values(CROSS_DOCK_ERROR_CODES), [
      'CROSS_DOCK_TASK_NOT_FOUND',
      'CROSS_DOCK_TASK_NOT_READY',
      'CROSS_DOCK_TASK_ALREADY_COMPLETED',
      'CROSS_DOCK_STAGING_INVALID',
      'CROSS_DOCK_DESTINATION_OUTSIDE_STAGING',
      'CROSS_DOCK_SITE_MISMATCH',
      'CROSS_DOCK_ORDER_NOT_OPEN',
      'CROSS_DOCK_DEMAND_ALREADY_ALLOCATED',
      'CROSS_DOCK_QUANTITY_MISMATCH',
    ]);
  });
});

describe('Story 3.10 Tasks 3-5 exact demand contracts', () => {
  it('enforces NUMERIC(14,3) capacity without JavaScript number coercion', () => {
    assert.strictEqual(isCrossDockQuantityCapacity('99999999999.999'), true);
    assert.strictEqual(isCrossDockQuantityCapacity('100000000000.000'), false);
    assert.strictEqual(isCrossDockQuantityCapacity('0.001'), true);
    assert.strictEqual(isCrossDockQuantityCapacity('0'), false);
    assert.strictEqual(isCrossDockQuantityCapacity('1.0001'), false);
    assert.strictEqual(isCrossDockQuantityCapacity('1e3'), false);
  });

  it('matches demand in deterministic SQL order and subtracts non-cancelled picks plus ready reservations', async () => {
    const calls: Array<{ text: string; values: unknown[] | undefined }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.includes('AS enough')) return { rows: [{ enough: true }] };
        if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
        if (text.startsWith('SELECT id FROM')) return { rows: [{ id: randomUUID() }] };
        return {
          rows: [
            {
              id: randomUUID(),
              so_number_ext: 'SO-1',
              line_no: 1,
              sku: 'SKU-310',
              quantity: '10.000',
              remaining_demand: '4.000',
              required_by: '2026-08-01',
              ship_to_ext: null,
              ship_from_site_id: values?.[1],
              ship_from_site_code_ext: 'SITE',
              status: 'open',
              source_system: 'ERP',
              last_synced_at: '2026-07-31T00:00:00.000Z',
            },
          ],
        };
      },
    };

    const match = await findCrossDockDemandMatch('SKU-310', randomUUID(), '4.000', client as never);
    assert.ok(match);
    assert.strictEqual(match.remaining_demand, '4.000');
    const sql = calls.map((call) => call.text).join('\n');
    assert.match(sql, /pl\.status <> 'cancelled'/);
    assert.match(sql, /cdt\.status = 'ready'/);
    assert.match(sql, /required_by ASC NULLS LAST,\s*eso\.so_number_ext ASC,\s*eso\.line_no ASC,\s*eso\.id ASC/);
    assert.match(sql, /FOR UPDATE OF eso/);
    assert.doesNotMatch(sql, /::float|double precision/i);
  });

  it('shares one transaction advisory-lock grain with normal pick generation', async () => {
    const calls: Array<{ text: string; values: unknown[] | undefined }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rows: [] };
      },
    };
    const lineId = randomUUID();
    await lockSalesOrderDemandLine(lineId, client as never);
    assert.match(calls[0]!.text, /pg_advisory_xact_lock/);
    assert.deepStrictEqual(calls[0]!.values, [lineId]);
  });
});
