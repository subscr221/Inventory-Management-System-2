-- Event-sourced location schema (Story 1.6). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness.
-- It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- location projection reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.

CREATE TABLE IF NOT EXISTS location_asserted_facts (
  fact_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id             UUID NOT NULL,
  asserted_location  TEXT NOT NULL,
  recorded_by        UUID NOT NULL,
  device_id          TEXT,
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  confidence         TEXT NOT NULL DEFAULT 'none',
  source_event_id    UUID NOT NULL,
  source_event_version INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT uq_location_asserted_lot UNIQUE (lot_id)
);

CREATE TABLE IF NOT EXISTS location_expected_facts (
  fact_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id             UUID NOT NULL,
  expected_location  TEXT NOT NULL,
  source             TEXT NOT NULL,
  source_event_id    UUID NOT NULL,
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_location_expected_lot UNIQUE (lot_id)
);

CREATE TABLE IF NOT EXISTS location_current (
  lot_id            UUID PRIMARY KEY,
  location          TEXT,
  confidence        TEXT NOT NULL DEFAULT 'none',
  asserted_fact_id  UUID,
  source_event_version INTEGER NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS location_asserted_facts
  ADD COLUMN IF NOT EXISTS source_event_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE IF EXISTS location_current
  ADD COLUMN IF NOT EXISTS source_event_version INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_location_asserted_confidence'
  ) THEN
    ALTER TABLE location_asserted_facts
      ADD CONSTRAINT chk_location_asserted_confidence CHECK (confidence IN ('none', 'low', 'certain'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_location_current_confidence'
  ) THEN
    ALTER TABLE location_current
      ADD CONSTRAINT chk_location_current_confidence CHECK (confidence IN ('none', 'low', 'certain'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_location_asserted_lot ON location_asserted_facts (lot_id);
CREATE INDEX IF NOT EXISTS idx_location_expected_lot ON location_expected_facts (lot_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON location_asserted_facts TO app_user;
    GRANT INSERT, SELECT, UPDATE ON location_expected_facts TO app_user;
    GRANT INSERT, SELECT, UPDATE ON location_current TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON location_asserted_facts TO readonly_user;
    GRANT SELECT ON location_expected_facts TO readonly_user;
    GRANT SELECT ON location_current TO readonly_user;
  END IF;
END $$;
