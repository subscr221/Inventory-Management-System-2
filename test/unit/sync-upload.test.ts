import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../src/middleware/error.js';
import {
  classifyUploadFailure,
  validateEdgeEnvelope,
  type UploadFailureClassification,
} from '../../src/sync/upload.js';
import type { EventEnvelope } from '../../src/events/store.js';

function assertClassification(
  actual: UploadFailureClassification,
  expected: UploadFailureClassification,
): void {
  assert.deepStrictEqual(actual, expected);
}

function edgeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: randomUUID(),
    stream_type: 'inventory',
    stream_id: randomUUID(),
    event_type: 'edge.test_capture_recorded',
    event_version: 1,
    payload: { business_stream: 'production', cost_center: 'CC-GATE', project_code: 'PILOT' },
    metadata: {
      correlation_id: randomUUID(),
      actor: {
        user_id: randomUUID(),
        role: 'gate_officer',
        location_id: '44444444-4444-4444-8444-444444444444',
      },
      device_id: 'EDGE-TAB-01',
      capture_method: 'MANUAL',
      occurred_at: new Date().toISOString(),
    },
    schema_version: 1,
    idempotency_key: `edge-test-${randomUUID()}`,
    ...overrides,
  };
}

describe('Story 1.8 sync upload classification', () => {
  it('treats duplicate events as idempotent convergence', () => {
    const error = new AppError(409, 'DUPLICATE_EVENT', 'Already uploaded', {
      existing_event_id: '11111111-1111-4111-8111-111111111111',
    });

    assertClassification(classifyUploadFailure(error), {
      action: 'complete',
      localStatus: 'synced',
      retryable: false,
      serverErrorCode: 'DUPLICATE_EVENT',
      existingEventId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('records permanent central validation failures and allows later queue items to continue', () => {
    for (const code of [
      'INVALID_EVENT_ENVELOPE',
      'UNTAGGED_TRANSACTION',
      'STREAM_CONFLICT',
      'CALIBRATION_LOCKOUT',
      'VALUATION_METHOD_NOT_PERMITTED',
      'NRV_RECOVERY_EXCEEDS_ORIGINAL_COST',
      // Story 2.6 cycle-count / physical-verification permanent business rejections
      'COUNT_TASK_LOCKED',
      'COUNT_ENTERER_CANNOT_APPROVE',
      'PERIOD_LOCKED',
      'COUNT_VARIANCE_REQUIRES_APPROVAL',
      'STOCK_ADJUSTMENT_NEGATIVE_BALANCE',
    ]) {
      assertClassification(classifyUploadFailure(new AppError(400, code, 'Permanent failure')), {
        action: 'complete',
        localStatus: 'needs_attention',
        retryable: false,
        serverErrorCode: code,
      });
    }
  });

  it('keeps transient network and server failures retryable', () => {
    assertClassification(
      classifyUploadFailure(new AppError(503, 'INTERNAL_ERROR', 'Unavailable')),
      {
        action: 'retry',
        localStatus: 'pending_sync',
        retryable: true,
        serverErrorCode: 'INTERNAL_ERROR',
      },
    );

    assertClassification(classifyUploadFailure(new Error('network down')), {
      action: 'retry',
      localStatus: 'pending_sync',
      retryable: true,
    });
  });

  it('halts only on a genuine authn failure (401), not on a business-rule 403', () => {
    // A 401 (expired/absent credentials) is an authentication failure: halt the whole outbox and
    // prompt re-auth, discarding no local evidence.
    assertClassification(classifyUploadFailure(new AppError(401, 'UNAUTHORIZED', 'Expired')), {
      action: 'halt',
      localStatus: 'auth_required',
      retryable: false,
      serverErrorCode: 'UNAUTHORIZED',
    });

    // A 403 carrying a permanent business error_code (LOCATION_ACCESS_DENIED / FUNCTION_ACCESS_DENIED /
    // LOT_REQUIRED) is a per-event authorization rejection, not an authentication failure: it settles
    // THAT event as needs_attention and lets the rest of the outbox continue, instead of halting all
    // sync as though the device signed out (Story 2.3 pass-3).
    assertClassification(
      classifyUploadFailure(new AppError(403, 'LOCATION_ACCESS_DENIED', 'Denied')),
      {
        action: 'complete',
        localStatus: 'needs_attention',
        retryable: false,
        serverErrorCode: 'LOCATION_ACCESS_DENIED',
      },
    );
  });

  it('requires edge-originated envelopes to have event_id, idempotency_key, and device_id', () => {
    assert.doesNotThrow(() => validateEdgeEnvelope(edgeEnvelope()));

    const missingEventId = edgeEnvelope();
    delete missingEventId.event_id;
    assert.throws(
      () => validateEdgeEnvelope(missingEventId),
      (error) => error instanceof AppError && error.errorCode === 'INVALID_EVENT_ENVELOPE',
    );

    assert.throws(
      () => validateEdgeEnvelope(edgeEnvelope({ idempotency_key: null })),
      (error) => error instanceof AppError && error.errorCode === 'INVALID_EVENT_ENVELOPE',
    );

    assert.throws(
      () =>
        validateEdgeEnvelope(
          edgeEnvelope({ metadata: { ...edgeEnvelope().metadata, device_id: null } }),
        ),
      (error) => error instanceof AppError && error.errorCode === 'INVALID_EVENT_ENVELOPE',
    );
  });
});
