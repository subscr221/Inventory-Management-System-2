CREATE TABLE IF NOT EXISTS instrument_calibration_statuses (
  instrument_uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id TEXT NOT NULL UNIQUE,
  calibration_status TEXT NOT NULL,
  status_event_id UUID,
  status_event_version INTEGER,
  status_changed_by UUID NOT NULL,
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_instrument_calibration_status CHECK (calibration_status IN ('calibrated', 'out_of_calibration'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_instrument_calibration_status'
      AND conrelid = 'instrument_calibration_statuses'::regclass
  ) THEN
    ALTER TABLE instrument_calibration_statuses
      ADD CONSTRAINT chk_instrument_calibration_status CHECK (calibration_status IN ('calibrated', 'out_of_calibration'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_instrument_calibration_statuses_instrument_id ON instrument_calibration_statuses (instrument_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON instrument_calibration_statuses TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON instrument_calibration_statuses TO readonly_user;
  END IF;
END $$;
