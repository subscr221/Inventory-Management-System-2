-- Instrument calibration certificates (Story 7.5, FR-M-12, AD-8). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying
-- maintenance.calibration_certificate_recorded / maintenance.calibration_expired domain events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the
-- SAME transaction as the domain_events insert.
--
-- Certificate validity is the ONLY source of calibrated status for a registered instrument:
-- calibration_status = 'calibrated' if and only if an 'active' certificate exists whose
-- valid_until >= business_date. Exactly one active certificate per instrument is enforced by the
-- partial unique index uq_instrument_calibration_certificate_active, not only by the seam's
-- pre-check (the Story 7.1 one-record lesson) - a pre-check alone loses the concurrent race, and
-- the row that would win here is the one that unlocks an instrument.
--
-- History is RETAINED: a superseded or expired certificate keeps its row and changes status, it is
-- never deleted, so the register can always answer what the instrument was calibrated under on any
-- past date. certificate_number is unique per instrument case-insensitively, matching the register's
-- lower() canonicalization of human-entered keys.

CREATE TABLE IF NOT EXISTS instrument_calibration_certificate (
  certificate_id       UUID PRIMARY KEY,
  instrument_record_id UUID NOT NULL,
  instrument_id        TEXT NOT NULL,
  calibration_type     TEXT NOT NULL,
  certificate_number   TEXT NOT NULL,
  issuing_lab          TEXT,
  calibrated_on        DATE NOT NULL,
  valid_until          DATE NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active',
  recorded_by          UUID NOT NULL,
  recorded_at          TIMESTAMPTZ NOT NULL,
  superseded_at        TIMESTAMPTZ,
  expired_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_instrument_calibration_certificate_type CHECK (calibration_type IN ('in_house', 'iso_17025')),
  CONSTRAINT chk_instrument_calibration_certificate_status CHECK (status IN ('active', 'superseded', 'expired')),
  CONSTRAINT chk_instrument_calibration_certificate_validity CHECK (valid_until >= calibrated_on),
  CONSTRAINT chk_instrument_calibration_certificate_iso_lab CHECK (calibration_type <> 'iso_17025' OR issuing_lab IS NOT NULL)
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'uq_instrument_calibration_certificate_number'
      AND indexdef NOT LIKE '%lower(certificate_number)%'
  ) THEN
    DROP INDEX uq_instrument_calibration_certificate_number;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_instrument_calibration_certificate_active ON instrument_calibration_certificate (instrument_record_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_instrument_calibration_certificate_number ON instrument_calibration_certificate (instrument_record_id, lower(certificate_number));
CREATE INDEX IF NOT EXISTS idx_instrument_calibration_certificate_valid_until ON instrument_calibration_certificate (valid_until) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_instrument_calibration_certificate_instrument ON instrument_calibration_certificate (instrument_record_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_instrument_calibration_certificate_type'
      AND conrelid = 'instrument_calibration_certificate'::regclass
  ) THEN
    ALTER TABLE instrument_calibration_certificate
      ADD CONSTRAINT chk_instrument_calibration_certificate_type CHECK (calibration_type IN ('in_house', 'iso_17025'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_instrument_calibration_certificate_status'
      AND conrelid = 'instrument_calibration_certificate'::regclass
  ) THEN
    ALTER TABLE instrument_calibration_certificate
      ADD CONSTRAINT chk_instrument_calibration_certificate_status CHECK (status IN ('active', 'superseded', 'expired'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_instrument_calibration_certificate_validity'
      AND conrelid = 'instrument_calibration_certificate'::regclass
  ) THEN
    ALTER TABLE instrument_calibration_certificate
      ADD CONSTRAINT chk_instrument_calibration_certificate_validity CHECK (valid_until >= calibrated_on);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_instrument_calibration_certificate_iso_lab'
      AND conrelid = 'instrument_calibration_certificate'::regclass
  ) THEN
    ALTER TABLE instrument_calibration_certificate
      ADD CONSTRAINT chk_instrument_calibration_certificate_iso_lab CHECK (calibration_type <> 'iso_17025' OR issuing_lab IS NOT NULL);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON instrument_calibration_certificate TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON instrument_calibration_certificate TO readonly_user;
  END IF;
END $$;
