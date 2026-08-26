-- Statutory examination records (Story 7.6, FR-M-14). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.statutory_examination_recorded
-- domain events; mutation happens exclusively through persistEvent, which applies this projection
-- inside the SAME transaction as the domain_events insert.
--
-- Each row is one examination event (the certificate-style evidence record) against a statutory
-- examination register row. One examination can be recorded many times (re-stamping); the register
-- row carries the CURRENT compliance state while this table keeps the immutable history.
-- certificate_number_ext is canonicalized with lower() for the unique index, matching the
-- instrument_calibration_certificate precedent: a case variant of a recorded certificate number is
-- the same document.

CREATE TABLE IF NOT EXISTS statutory_examination_record (
  record_id              UUID PRIMARY KEY,
  examination_id         UUID NOT NULL,
  examined_on            DATE NOT NULL,
  next_due_date          DATE NOT NULL,
  certificate_number_ext TEXT,
  examined_by            UUID,
  examined_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_statutory_examination_record_dates CHECK (next_due_date >= examined_on)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_statutory_examination_record_number ON statutory_examination_record (examination_id, lower(certificate_number_ext)) WHERE certificate_number_ext IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_statutory_examination_record_examination ON statutory_examination_record (examination_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_statutory_examination_record_dates'
      AND conrelid = 'statutory_examination_record'::regclass
  ) THEN
    ALTER TABLE statutory_examination_record
      ADD CONSTRAINT chk_statutory_examination_record_dates CHECK (next_due_date >= examined_on);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON statutory_examination_record TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON statutory_examination_record TO readonly_user;
  END IF;
END $$;
