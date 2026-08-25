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

-- Story 7.5 (Status Write-Through Contract): the calibration register writes and reads this row by
-- the instrument id AS STORED in instrument_register, and instrument ids are canonicalized with
-- lower() everywhere they are human-entered. Without a lower() index the lookup either scans or
-- misses: an instrument stored as 'ins-42' and queried as 'INS-42' returns null, and null is
-- treated as locked, so the failure mode is a spurious lockout rather than a bypass. Fail-closed
-- is correct but wrong for the operator, and the repo convention (Story 7.1 asset tags, Story 7.2
-- scanned-versus-typed keys) is to canonicalize. The guarded DO block makes a re-applied file
-- self-heal; no existing column or constraint on this table is changed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'idx_instrument_calibration_statuses_instrument_id_lower'
  ) THEN
    CREATE INDEX idx_instrument_calibration_statuses_instrument_id_lower
      ON instrument_calibration_statuses (lower(instrument_id));
  END IF;
END $$;
