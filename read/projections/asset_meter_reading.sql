-- Asset meter reading ledger (Story 7.2, FR-M-03). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.meter_reading_recorded domain
-- events; mutation happens exclusively through persistEvent, which applies this projection inside
-- the SAME transaction as the domain_events insert. Append-only: a reading is an observation and
-- is never updated or deleted.
--
-- AC 4: a reading is applied identically regardless of where it came from, and every row records
-- its source and capture method. Phase 1 populates 'manual' / 'manual_entry'; 'hub_booking'
-- (Epic 10 Story 10.4) and 'station_equipment' (Phase 2, INT-MTR-01) are already accepted so those
-- feeds need no schema change when they come online.

CREATE TABLE IF NOT EXISTS asset_meter_reading (
  reading_id     UUID PRIMARY KEY,
  meter_id       UUID NOT NULL,
  asset_id       UUID NOT NULL,
  reading_value  NUMERIC(18,4) NOT NULL,
  reading_at     TIMESTAMPTZ NOT NULL,
  source         TEXT NOT NULL,
  capture_method TEXT NOT NULL,
  recorded_by    UUID NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_asset_meter_reading_source CHECK (source IN ('manual', 'hub_booking', 'station_equipment')),
  CONSTRAINT chk_asset_meter_reading_capture_method CHECK (capture_method IN ('manual_entry', 'api', 'device_feed')),
  CONSTRAINT chk_asset_meter_reading_value CHECK (reading_value >= 0)
);

CREATE INDEX IF NOT EXISTS idx_asset_meter_reading_meter ON asset_meter_reading (meter_id, reading_at DESC, reading_id ASC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_meter_reading_source'
      AND conrelid = 'asset_meter_reading'::regclass
  ) THEN
    ALTER TABLE asset_meter_reading
      ADD CONSTRAINT chk_asset_meter_reading_source CHECK (source IN ('manual', 'hub_booking', 'station_equipment'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_meter_reading_capture_method'
      AND conrelid = 'asset_meter_reading'::regclass
  ) THEN
    ALTER TABLE asset_meter_reading
      ADD CONSTRAINT chk_asset_meter_reading_capture_method CHECK (capture_method IN ('manual_entry', 'api', 'device_feed'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_meter_reading_value'
      AND conrelid = 'asset_meter_reading'::regclass
  ) THEN
    ALTER TABLE asset_meter_reading
      ADD CONSTRAINT chk_asset_meter_reading_value CHECK (reading_value >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON asset_meter_reading TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON asset_meter_reading TO readonly_user;
  END IF;
END $$;
