import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  assertPickTaskCreatedShape,
  assertPickLineConfirmedShape,
  assertPickTaskCompletedShape,
} from '../../src/compliance/pick.js';
import type {
  PickTaskCreatedEnvelope,
  PickLineConfirmedEnvelope,
  PickTaskCompletedEnvelope,
} from '../../src/events/schema.js';
import { AppError } from '../../src/middleware/error.js';

/**
 * Story 3.6 Task 8.2: envelope validation for the three pick event types. These asserts are the
 * envelope validators for edge-originated pick events - they run pre-transaction inside
 * persistEvent, so a malformed upload is rejected without consuming an idempotency key. The
 * coverage lives here rather than in edge/test/unit because the edge workspace has no envelope
 * validator of its own to import; its unit tests cover the permanent-code classification and the
 * operator-facing i18n strings for these same codes.
 */

function metadata(): PickTaskCreatedEnvelope['metadata'] {
  return {
    correlation_id: randomUUID(),
    actor: { user_id: randomUUID(), role: 'store_assistant', location_id: randomUUID() },
    occurred_at: '2026-07-27T10:00:00.000Z',
  };
}

function taskCreated(overrides: Record<string, unknown> = {}): PickTaskCreatedEnvelope {
  return {
    stream_type: 'warehouse',
    stream_id: randomUUID(),
    event_type: 'pick_task.created',
    metadata: metadata(),
    payload: {
      pick_task_id: randomUUID(),
      dispatch_order_id: randomUUID(),
      sku: 'SKU-1',
      quantity: '10.000',
      lot_id: randomUUID(),
      location_id: randomUUID(),
      pick_sequence: 1,
      strategy: 'single',
      zone_id: randomUUID(),
      pick_lines: [
        {
          pick_line_id: randomUUID(),
          dispatch_order_line_id: randomUUID(),
          sku: 'SKU-1',
          directed_lot_id: randomUUID(),
          directed_quantity: '10.000',
          location_id: randomUUID(),
          pick_sequence: 1,
        },
      ],
      ...overrides,
    },
  } as PickTaskCreatedEnvelope;
}

function lineConfirmed(overrides: Record<string, unknown> = {}): PickLineConfirmedEnvelope {
  return {
    stream_type: 'warehouse',
    stream_id: randomUUID(),
    event_type: 'pick_line.confirmed',
    metadata: metadata(),
    payload: {
      pick_task_id: randomUUID(),
      pick_line_id: randomUUID(),
      confirmed_lot_id: randomUUID(),
      confirmed_quantity: '10.000',
      capture_method: 'PWA',
      ...overrides,
    },
  } as PickLineConfirmedEnvelope;
}

function taskCompleted(overrides: Record<string, unknown> = {}): PickTaskCompletedEnvelope {
  return {
    stream_type: 'warehouse',
    stream_id: randomUUID(),
    event_type: 'pick_task.completed',
    metadata: metadata(),
    payload: { pick_task_id: randomUUID(), dispatch_order_id: randomUUID(), ...overrides },
  } as PickTaskCompletedEnvelope;
}

function expectInvalid(fn: () => void, label: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof AppError, `${label}: expected an AppError`);
    assert.strictEqual(err.errorCode, 'PICK_TASK_INVALID_PAYLOAD', label);
    assert.strictEqual(err.statusCode, 400, label);
    return true;
  }, label);
}

describe('Story 3.6: pick event envelope validation', () => {
  it('accepts well-formed envelopes for all three pick event types', () => {
    assert.doesNotThrow(() => assertPickTaskCreatedShape(taskCreated()));
    assert.doesNotThrow(() => assertPickLineConfirmedShape(lineConfirmed()));
    assert.doesNotThrow(() => assertPickTaskCompletedShape(taskCompleted()));
  });

  it('pick_task.created rejects every missing or malformed required field', () => {
    expectInvalid(() => assertPickTaskCreatedShape(taskCreated({ pick_task_id: 'not-a-uuid' })), 'pick_task_id');
    expectInvalid(() => assertPickTaskCreatedShape(taskCreated({ dispatch_order_id: undefined })), 'dispatch_order_id');
    expectInvalid(() => assertPickTaskCreatedShape(taskCreated({ sku: '' })), 'sku');
    expectInvalid(() => assertPickTaskCreatedShape(taskCreated({ lot_id: undefined })), 'lot_id');
    expectInvalid(() => assertPickTaskCreatedShape(taskCreated({ pick_sequence: 1.5 })), 'pick_sequence');
    expectInvalid(() => assertPickTaskCreatedShape(taskCreated({ strategy: 'express' })), 'strategy');
    expectInvalid(() => assertPickTaskCreatedShape(taskCreated({ zone_id: undefined })), 'zone_id');
    expectInvalid(() => assertPickTaskCreatedShape(taskCreated({ wave_id: 'not-a-uuid' })), 'wave_id');
    expectInvalid(() => assertPickTaskCreatedShape(taskCreated({ batch_id: 'not-a-uuid' })), 'batch_id');
    expectInvalid(() => assertPickTaskCreatedShape(taskCreated({ pick_lines: [] })), 'empty pick_lines');
  });

  it('pick_task.created rejects a malformed pick line', () => {
    const badLine = { pick_line_id: 'nope', dispatch_order_line_id: randomUUID(), sku: 'SKU-1', directed_lot_id: randomUUID(), directed_quantity: '1.000', location_id: randomUUID(), pick_sequence: 1 };
    expectInvalid(() => assertPickTaskCreatedShape(taskCreated({ pick_lines: [badLine] })), 'pick_lines[].pick_line_id');
  });

  it('rejects non-positive and non-numeric quantities', () => {
    expectInvalid(() => assertPickTaskCreatedShape(taskCreated({ quantity: '0' })), 'zero quantity');
    expectInvalid(() => assertPickTaskCreatedShape(taskCreated({ quantity: '-5.000' })), 'negative quantity');
    expectInvalid(() => assertPickTaskCreatedShape(taskCreated({ quantity: 'abc' })), 'non-numeric quantity');
    expectInvalid(() => assertPickLineConfirmedShape(lineConfirmed({ confirmed_quantity: '0' })), 'zero confirmed quantity');
    expectInvalid(() => assertPickLineConfirmedShape(lineConfirmed({ confirmed_quantity: -1 })), 'negative confirmed quantity');
  });

  it('rejects quantities finer than the NUMERIC(14,3) column, including beyond 6 decimal places', () => {
    // Values that would round on write must fail closed: a later replay would otherwise compare
    // the truncated stored value and be misjudged either a duplicate or a conflict.
    expectInvalid(() => assertPickLineConfirmedShape(lineConfirmed({ confirmed_quantity: '5.0001' })), '4 decimal places');
    expectInvalid(() => assertPickLineConfirmedShape(lineConfirmed({ confirmed_quantity: '5.000001' })), '6 decimal places');
    // Regression guard: the truncating micro conversion used to let this through.
    expectInvalid(() => assertPickLineConfirmedShape(lineConfirmed({ confirmed_quantity: '5.0000009' })), '7 decimal places');
    // Trailing zeros beyond 3 places are still fine - they do not lose information.
    assert.doesNotThrow(() => assertPickLineConfirmedShape(lineConfirmed({ confirmed_quantity: '5.000000' })));
  });

  it('pick_line.confirmed requires the identifiers and a known capture method', () => {
    expectInvalid(() => assertPickLineConfirmedShape(lineConfirmed({ pick_task_id: undefined })), 'pick_task_id');
    expectInvalid(() => assertPickLineConfirmedShape(lineConfirmed({ pick_line_id: 'nope' })), 'pick_line_id');
    expectInvalid(() => assertPickLineConfirmedShape(lineConfirmed({ confirmed_lot_id: undefined })), 'confirmed_lot_id');
    expectInvalid(() => assertPickLineConfirmedShape(lineConfirmed({ capture_method: 'SMS' })), 'capture_method');
  });

  it('pick_task.completed requires a pick_task_id', () => {
    expectInvalid(() => assertPickTaskCompletedShape(taskCompleted({ pick_task_id: undefined })), 'pick_task_id');
    expectInvalid(() => assertPickTaskCompletedShape(taskCompleted({ pick_task_id: 'not-a-uuid' })), 'malformed pick_task_id');
  });
});
