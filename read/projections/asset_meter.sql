-- Asset usage-meter register (Story 7.2, FR-M-03). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.meter_registered,
-- maintenance.meter_reading_recorded and maintenance.meter_silent_flagged domain events; mutation
-- happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert.
--
-- One asset can carry more than one meter (running hours AND cycle count), so the meter - not the
-- asset - is the target of a reading. current_reading is the latest accepted reading and never
-- decreases (the seam rejects a regression with METER_READING_REGRESSION). silent_after_days is
-- the per-meter configured interval the monthly reconciliation checks (AC 5), and alert_role
-- carries the notification target as DATA so no role name is branched on in code.
--
-- meter_code is canonicalized with lower() in the unique index (the Story 7.1 review lesson):
-- keyboard entry and barcode scan may differ in case and a case variant is the same meter. The
-- guarded DO block below drops a previous exact-match index so a re-applied file self-heals.

CREATE TABLE IF NOT EXISTS asset_meter (
  meter_id           UUID PRIMARY KEY,
  asset_id           UUID NOT NULL,
  meter_code         TEXT NOT NULL,
  unit               TEXT NOT NULL,
  current_reading    NUMERIC(18,4) NOT NULL DEFAULT 0,
  last_reading_at    TIMESTAMPTZ,
  silent_after_days  INTEGER NOT NULL DEFAULT 30,
  alert_role         TEXT NOT NULL,
  silent_flagged_at  TIMESTAMPTZ,
  last_reconciled_at TIMESTAMPTZ,
  created_by         UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_asset_meter_unit CHECK (unit IN ('hours', 'cycles', 'km', 'units')),
  CONSTRAINT chk_asset_meter_silent_after_days CHECK (silent_after_days > 0),
  CONSTRAINT chk_asset_meter_current_reading CHECK (current_reading >= 0)
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'uq_asset_meter_code'
      AND indexdef NOT LIKE '%lower(meter_code)%'
  ) THEN
    DROP INDEX uq_asset_meter_code;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_meter_code ON asset_meter (asset_id, lower(meter_code));
CREATE INDEX IF NOT EXISTS idx_asset_meter_asset ON asset_meter (asset_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_meter_unit'
      AND conrelid = 'asset_meter'::regclass
  ) THEN
    ALTER TABLE asset_meter
      ADD CONSTRAINT chk_asset_meter_unit CHECK (unit IN ('hours', 'cycles', 'km', 'units'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_meter_silent_after_days'
      AND conrelid = 'asset_meter'::regclass
  ) THEN
    ALTER TABLE asset_meter
      ADD CONSTRAINT chk_asset_meter_silent_after_days CHECK (silent_after_days > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_meter_current_reading'
      AND conrelid = 'asset_meter'::regclass
  ) THEN
    ALTER TABLE asset_meter
      ADD CONSTRAINT chk_asset_meter_current_reading CHECK (current_reading >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON asset_meter TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON asset_meter TO readonly_user;
  END IF;
END $$;
