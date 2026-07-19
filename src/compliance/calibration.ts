import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getCalibrationStatus } from '../read/projections/instrument_calibration.js';
import type { CalibrationStatus } from '../read/projections/instrument_calibration.js';

const QC_STREAM_TYPES = new Set(['qc']);
const QC_RESULT_RECORDED = 'qc.result_recorded';

export interface CalibrationDeps {
  getCalibrationStatus: (instrumentId: string) => Promise<CalibrationStatus | null>;
}

const defaultDeps: CalibrationDeps = {
  getCalibrationStatus,
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function assertCalibrationLockout(envelope: EventEnvelope, deps: CalibrationDeps = defaultDeps): Promise<void> {
  if (!QC_STREAM_TYPES.has(envelope.stream_type)) return;
  if (envelope.event_type !== QC_RESULT_RECORDED) return;

  const instrumentId = envelope.payload['instrument_id'];
  if (!isNonEmptyString(instrumentId)) {
    throw new AppError(400, 'INVALID_PARAMS', 'qc.result_recorded payload is missing instrument_id', {
      missing_field: 'instrument_id',
    });
  }

  const status = await deps.getCalibrationStatus(instrumentId);
  if (status !== 'calibrated') {
    throw new AppError(423, 'CALIBRATION_LOCKOUT', 'Instrument calibration status blocks QC result persistence', {
      instrument_id: instrumentId,
    });
  }
}
