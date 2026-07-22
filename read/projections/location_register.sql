-- Location register (warehouse topology master data, Story 2.1). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve location-register reads/writes as app_user without depending on
-- deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates this content for first-boot
-- container init - change both files together. Every statement is idempotent so the file can be
-- re-applied to a live database safely.
--
-- This table is SEPARATE from the Story 1.6 event-sourced lot-location projection
-- (location_asserted_facts / location_expected_facts / location_current): those hold derived
-- per-lot state keyed by opaque TEXT location values, which remain readable and untouched.
-- location_id is the internal UUID used as the location_register event stream_id; location_code
-- is the unique human-readable identifier (e.g. BIN-A43). site_id is the root site's location_id
-- (a site row references itself). Hierarchy: site > zone > aisle > rack > bin.

CREATE TABLE IF NOT EXISTS location_register (
  location_id        UUID PRIMARY KEY,
  location_code      TEXT NOT NULL,
  level              TEXT NOT NULL,
  parent_location_id UUID REFERENCES location_register(location_id),
  site_id            UUID NOT NULL,
  zone_type          TEXT NOT NULL DEFAULT 'general',
  temperature_class  TEXT NOT NULL DEFAULT 'ambient',
  size_class         TEXT NOT NULL DEFAULT 'standard',
  hazmat_allowed     BOOLEAN NOT NULL DEFAULT false,
  quarantine         BOOLEAN NOT NULL DEFAULT false,
  access_restricted  BOOLEAN NOT NULL DEFAULT false,
  status             TEXT NOT NULL DEFAULT 'active',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_location_register_code UNIQUE (location_code),
  CONSTRAINT chk_location_register_level CHECK (level IN ('site', 'zone', 'aisle', 'rack', 'bin')),
  CONSTRAINT chk_location_register_zone_type CHECK (zone_type IN ('general', 'hazmat', 'quarantine', 'staging')),
  CONSTRAINT chk_location_register_temperature_class CHECK (temperature_class IN ('ambient', 'cold', 'frozen')),
  CONSTRAINT chk_location_register_status CHECK (status IN ('active', 'inactive'))
);

ALTER TABLE location_register ADD COLUMN IF NOT EXISTS size_class TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE location_register ADD COLUMN IF NOT EXISTS access_restricted BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_location_register_level'
      AND conrelid = 'location_register'::regclass
  ) THEN
    ALTER TABLE location_register
      ADD CONSTRAINT chk_location_register_level CHECK (level IN ('site', 'zone', 'aisle', 'rack', 'bin'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_location_register_zone_type'
      AND conrelid = 'location_register'::regclass
  ) THEN
    ALTER TABLE location_register
      ADD CONSTRAINT chk_location_register_zone_type CHECK (zone_type IN ('general', 'hazmat', 'quarantine', 'staging'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_location_register_temperature_class'
      AND conrelid = 'location_register'::regclass
  ) THEN
    ALTER TABLE location_register
      ADD CONSTRAINT chk_location_register_temperature_class CHECK (temperature_class IN ('ambient', 'cold', 'frozen'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_location_register_status'
      AND conrelid = 'location_register'::regclass
  ) THEN
    ALTER TABLE location_register
      ADD CONSTRAINT chk_location_register_status CHECK (status IN ('active', 'inactive'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_location_register_parent ON location_register (parent_location_id);
CREATE INDEX IF NOT EXISTS idx_location_register_site ON location_register (site_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON location_register TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON location_register TO readonly_user;
  END IF;
END $$;
