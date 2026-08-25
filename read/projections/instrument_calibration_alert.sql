-- Staged calibration expiry alerts (Story 7.5, FR-M-12, AC 1). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.calibration_expiry_flagged
-- domain events; mutation happens exclusively through persistEvent, which applies this projection
-- inside the SAME transaction as the domain_events insert.
--
-- The grain is (certificate_id, stage_days), NOT (certificate_id, business_date): an expiry
-- countdown fires ONCE PER STAGE per certificate, unlike the Story 7.4 daily breach alert where a
-- persisting breach earns a daily nudge. uq_instrument_calibration_alert_stage is what makes a
-- same-day re-run a no-op and what makes a skipped day catch up rather than lose a stage - the
-- scan asks which stages are due and unfired, never whether the day count equals a stage exactly.
-- A renewal issues a NEW certificate_id and therefore a fresh set of three stages.

CREATE TABLE IF NOT EXISTS instrument_calibration_alert (
  alert_id             UUID PRIMARY KEY,
  certificate_id       UUID NOT NULL,
  instrument_record_id UUID NOT NULL,
  stage_days           INTEGER NOT NULL,
  valid_until          DATE NOT NULL,
  business_date        DATE NOT NULL,
  flagged_at           TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_instrument_calibration_alert_stage CHECK (stage_days IN (30, 14, 7)),
  CONSTRAINT uq_instrument_calibration_alert_stage UNIQUE (certificate_id, stage_days)
);

CREATE INDEX IF NOT EXISTS idx_instrument_calibration_alert_business_date ON instrument_calibration_alert (business_date);
CREATE INDEX IF NOT EXISTS idx_instrument_calibration_alert_instrument ON instrument_calibration_alert (instrument_record_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_instrument_calibration_alert_stage'
      AND conrelid = 'instrument_calibration_alert'::regclass
  ) THEN
    ALTER TABLE instrument_calibration_alert
      ADD CONSTRAINT chk_instrument_calibration_alert_stage CHECK (stage_days IN (30, 14, 7));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_instrument_calibration_alert_stage'
      AND conrelid = 'instrument_calibration_alert'::regclass
  ) THEN
    ALTER TABLE instrument_calibration_alert
      ADD CONSTRAINT uq_instrument_calibration_alert_stage UNIQUE (certificate_id, stage_days);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON instrument_calibration_alert TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON instrument_calibration_alert TO readonly_user;
  END IF;
END $$;
