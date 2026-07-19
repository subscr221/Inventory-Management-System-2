import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertCalibrationLockout } from '../../src/compliance/calibration.js';
import type { CalibrationDeps } from '../../src/compliance/calibration.js';
import type { EventEnvelope } from '../../src/events/store.js';
import { AppError } from '../../src/middleware/error.js';

function makeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    stream_type: 'qc',
    stream_id: '11111111-1111-4111-8111-111111111111',
    event_type: 'qc.result_recorded',
    payload: { instrument_id: 'INS-0042', lot_id: 'LOT-1', parameter: 'weight', value: 42 },
    metadata: {
      correlation_id: '22222222-2222-4222-8222-222222222222',
      actor: {
        user_id: '33333333-3333-4333-8333-333333333333',
        role: 'qc_inspector',
        location_id: '44444444-4444-4444-8444-444444444444',
      },
      occurred_at: '2026-07-19T00:00:00.000Z',
    },
    ...overrides,
  };
}

function depsWith(status: 'calibrated' | 'out_of_calibration' | null): CalibrationDeps {
  return {
    getCalibrationStatus: async () => status,
  };
}

const unreachableDeps: CalibrationDeps = {
  getCalibrationStatus: () => {
    throw new Error('getCalibrationStatus must not be called');
  },
};

async function expectAppError(fn: () => Promise<void>, statusCode: number, errorCode: string): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof AppError);
    assert.strictEqual(err.statusCode, statusCode);
    assert.strictEqual(err.errorCode, errorCode);
    return true;
  });
}

describe('assertCalibrationLockout (Story 1.7, AD-8)', () => {
  it('passes non-QC stream types through with no projection lookup', async () => {
    await assertCalibrationLockout(
      makeEnvelope({ stream_type: 'inventory', event_type: 'stock.allocated', payload: { business_stream: 'production' } }),
      unreachableDeps,
    );
  });

  it('passes QC events that are not result capture through with no projection lookup', async () => {
    await assertCalibrationLockout(makeEnvelope({ event_type: 'qc.plan_created', payload: {} }), unreachableDeps);
  });

  it('rejects missing or empty instrument_id as INVALID_PARAMS', async () => {
    await expectAppError(
      () => assertCalibrationLockout(makeEnvelope({ payload: { lot_id: 'LOT-1', parameter: 'weight', value: 42 } }), unreachableDeps),
      400,
      'INVALID_PARAMS',
    );
    await expectAppError(
      () => assertCalibrationLockout(makeEnvelope({ payload: { instrument_id: ' ', lot_id: 'LOT-1', parameter: 'weight', value: 42 } }), unreachableDeps),
      400,
      'INVALID_PARAMS',
    );
  });

  it('blocks unknown instruments as CALIBRATION_LOCKOUT', async () => {
    await expectAppError(() => assertCalibrationLockout(makeEnvelope(), depsWith(null)), 423, 'CALIBRATION_LOCKOUT');
  });

  it('blocks out-of-calibration instruments as CALIBRATION_LOCKOUT', async () => {
    await expectAppError(() => assertCalibrationLockout(makeEnvelope(), depsWith('out_of_calibration')), 423, 'CALIBRATION_LOCKOUT');
  });

  it('does not allow qc_head role to bypass lockout', async () => {
    await expectAppError(
      () =>
        assertCalibrationLockout(
          makeEnvelope({
            metadata: {
              ...makeEnvelope().metadata,
              actor: { ...makeEnvelope().metadata.actor, role: 'qc_head' },
            },
          }),
          depsWith('out_of_calibration'),
        ),
      423,
      'CALIBRATION_LOCKOUT',
    );
  });

  it('passes calibrated instruments', async () => {
    await assertCalibrationLockout(makeEnvelope(), depsWith('calibrated'));
  });
});
