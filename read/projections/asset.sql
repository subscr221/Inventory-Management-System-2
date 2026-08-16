-- Asset register read model (Story 7.1, FR-M-01, AD-9). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying asset.registered domain events; mutation
-- happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert. The AC 3 one-asset-one-record key is the partial
-- unique index uq_asset_serial (serialized assets only - a non-serialized asset has no duplicate
-- key). asset_tag is the value encoded in the physical scannable QR label and is unique across
-- the register. fixed_asset_ref is a FREE identifier with no lookup (AC 2).
--
-- Both uniqueness keys are canonicalized with lower() (code review 2026-08-16): keyboard entry
-- and barcode scan may differ in case, and a case variant of an existing serial or tag is the
-- same physical asset. The guarded DO block below drops a previous exact-match index so a
-- re-applied file self-heals to the lower() definition; the seam pre-checks and the race
-- resolver compare lower(column) = lower($1) to match.

CREATE TABLE IF NOT EXISTS asset (
  asset_id           UUID PRIMARY KEY,
  asset_tag          TEXT NOT NULL,
  asset_name         TEXT NOT NULL,
  criticality_class  TEXT NOT NULL,
  serial_number      TEXT,
  manufacturer       TEXT,
  model              TEXT,
  fixed_asset_ref    TEXT,
  created_by         UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_asset_criticality_class CHECK (criticality_class IN ('critical', 'high', 'medium', 'low'))
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'uq_asset_tag'
      AND indexdef NOT LIKE '%lower(asset_tag)%'
  ) THEN
    DROP INDEX uq_asset_tag;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'uq_asset_serial'
      AND indexdef NOT LIKE '%lower(serial_number)%'
  ) THEN
    DROP INDEX uq_asset_serial;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_tag ON asset (lower(asset_tag));
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_serial ON asset (lower(serial_number)) WHERE serial_number IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_criticality_class'
      AND conrelid = 'asset'::regclass
  ) THEN
    ALTER TABLE asset
      ADD CONSTRAINT chk_asset_criticality_class CHECK (criticality_class IN ('critical', 'high', 'medium', 'low'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON asset TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON asset TO readonly_user;
  END IF;
END $$;
