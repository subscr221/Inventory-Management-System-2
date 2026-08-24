-- Maintenance spare catalogue (Story 7.4, FR-M-07, FR-M-09). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.spare_catalogued domain
-- events; mutation happens exclusively through persistEvent, which applies this projection inside
-- the SAME transaction as the domain_events insert.
--
-- Grain is (sku, location_id): min-max levels are per stocking location, because a spare can be
-- critical at the plant store and irrelevant at a hub. This table is NOT inventory_planning_params
-- (Story 2.7): those safety_stock/reorder_point values are COMPUTED outputs of
-- runSafetyStockComputation and an operator-typed min-max written there would be silently
-- overwritten by the next computation. is_critical + min_level is the FR-M-09 alerting contract;
-- chk_maintenance_spare_catalogue_critical_needs_min makes a critical spare without a minimum
-- impossible, so the breach scan can never silently skip a grain it was configured to watch.

CREATE TABLE IF NOT EXISTS maintenance_spare_catalogue (
  catalogue_id UUID PRIMARY KEY,
  sku          TEXT NOT NULL,
  location_id  UUID NOT NULL,
  is_critical  BOOLEAN NOT NULL DEFAULT false,
  min_level    NUMERIC(18, 6),
  max_level    NUMERIC(18, 6),
  created_by   UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_maintenance_spare_catalogue_grain UNIQUE (sku, location_id),
  CONSTRAINT chk_maintenance_spare_catalogue_levels CHECK (min_level IS NULL OR max_level IS NULL OR max_level >= min_level),
  CONSTRAINT chk_maintenance_spare_catalogue_min_non_negative CHECK (min_level IS NULL OR min_level >= 0),
  CONSTRAINT chk_maintenance_spare_catalogue_max_non_negative CHECK (max_level IS NULL OR max_level >= 0),
  CONSTRAINT chk_maintenance_spare_catalogue_critical_needs_min CHECK (is_critical = false OR min_level IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_spare_catalogue_location ON maintenance_spare_catalogue (location_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_spare_catalogue_critical ON maintenance_spare_catalogue (is_critical);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_maintenance_spare_catalogue_grain'
      AND conrelid = 'maintenance_spare_catalogue'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_catalogue
      ADD CONSTRAINT uq_maintenance_spare_catalogue_grain UNIQUE (sku, location_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_catalogue_levels'
      AND conrelid = 'maintenance_spare_catalogue'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_catalogue
      ADD CONSTRAINT chk_maintenance_spare_catalogue_levels CHECK (min_level IS NULL OR max_level IS NULL OR max_level >= min_level);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_catalogue_min_non_negative'
      AND conrelid = 'maintenance_spare_catalogue'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_catalogue
      ADD CONSTRAINT chk_maintenance_spare_catalogue_min_non_negative CHECK (min_level IS NULL OR min_level >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_catalogue_max_non_negative'
      AND conrelid = 'maintenance_spare_catalogue'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_catalogue
      ADD CONSTRAINT chk_maintenance_spare_catalogue_max_non_negative CHECK (max_level IS NULL OR max_level >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_catalogue_critical_needs_min'
      AND conrelid = 'maintenance_spare_catalogue'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_catalogue
      ADD CONSTRAINT chk_maintenance_spare_catalogue_critical_needs_min CHECK (is_critical = false OR min_level IS NOT NULL);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON maintenance_spare_catalogue TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_spare_catalogue TO readonly_user;
  END IF;
END $$;
