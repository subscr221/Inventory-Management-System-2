-- Per-asset maintenance cost rollup (Story 7.6, FR-M-15). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.work_order_completed domain
-- events; mutation happens exclusively through persistEvent, which applies this projection inside
-- the SAME transaction as the domain_events insert.
--
-- The three totals are the SUM of the matching columns across all completed maintenance_work_order
-- rows for the asset (Story 5.6 BOM cost rollup pattern): all arithmetic runs in PostgreSQL
-- NUMERIC, costs enter and leave as exact decimal strings, and the applier ADDS the new costs to
-- the existing totals inside the same transaction. last_work_order_id / last_closed_at point at the
-- most recent completing work order for the lifecycle-costing read.

CREATE TABLE IF NOT EXISTS maintenance_asset_cost (
  asset_id            UUID PRIMARY KEY,
  total_labor_cost    NUMERIC(14,3) NOT NULL DEFAULT 0,
  total_parts_cost    NUMERIC(14,3) NOT NULL DEFAULT 0,
  total_cost          NUMERIC(14,3) NOT NULL DEFAULT 0,
  last_work_order_id  UUID,
  last_closed_at      TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_maintenance_asset_cost_labor_non_negative CHECK (total_labor_cost >= 0),
  CONSTRAINT chk_maintenance_asset_cost_parts_non_negative CHECK (total_parts_cost >= 0),
  CONSTRAINT chk_maintenance_asset_cost_total_non_negative CHECK (total_cost >= 0)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_asset_cost_labor_non_negative'
      AND conrelid = 'maintenance_asset_cost'::regclass
  ) THEN
    ALTER TABLE maintenance_asset_cost
      ADD CONSTRAINT chk_maintenance_asset_cost_labor_non_negative CHECK (total_labor_cost >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_asset_cost_parts_non_negative'
      AND conrelid = 'maintenance_asset_cost'::regclass
  ) THEN
    ALTER TABLE maintenance_asset_cost
      ADD CONSTRAINT chk_maintenance_asset_cost_parts_non_negative CHECK (total_parts_cost >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_asset_cost_total_non_negative'
      AND conrelid = 'maintenance_asset_cost'::regclass
  ) THEN
    ALTER TABLE maintenance_asset_cost
      ADD CONSTRAINT chk_maintenance_asset_cost_total_non_negative CHECK (total_cost >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON maintenance_asset_cost TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_asset_cost TO readonly_user;
  END IF;
END $$;
