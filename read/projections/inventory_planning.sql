-- Inventory planning parameters read model (Story 2.7). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries
-- its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as
-- app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a live database
-- safely.
--
-- Derived state ONLY: rows are rebuildable by replaying inventory_planning.* domain events; mutation
-- happens exclusively through persistEvent, which applies this projection inside the SAME transaction
-- as the domain_events insert. Grain is (sku, location_id) with NULLS NOT DISTINCT - one config row
-- per SKU-location. safety_stock and reorder_point are STORED computation outputs, reproducible from
-- the computation_inputs JSONB snapshot. Planning params are location-aware and therefore live here,
-- NOT on the SKU-grain item_master.

CREATE TABLE IF NOT EXISTS inventory_planning_params (
  planning_params_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                         TEXT NOT NULL,
  location_id                 UUID NOT NULL,
  lead_time_days              NUMERIC(9, 3),
  lead_time_source            TEXT,
  service_level               NUMERIC(6, 4),
  avg_daily_demand            NUMERIC(18, 6),
  demand_std_dev              NUMERIC(18, 6),
  demand_window_days          INTEGER NOT NULL DEFAULT 90,
  obsolescence_threshold_days INTEGER,
  standard_order_qty          NUMERIC(18, 6),
  safety_stock                NUMERIC(18, 6),
  reorder_point               NUMERIC(18, 6),
  last_computed_at            TIMESTAMPTZ,
  computation_inputs          JSONB,
  business_stream             TEXT NOT NULL,
  set_by_actor_id             UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inventory_planning_params_grain UNIQUE NULLS NOT DISTINCT (sku, location_id),
  CONSTRAINT chk_inventory_planning_params_service_level CHECK (service_level IS NULL OR (service_level > 0 AND service_level < 1)),
  CONSTRAINT chk_inventory_planning_params_lead_time_non_negative CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  CONSTRAINT chk_inventory_planning_params_window_positive CHECK (demand_window_days > 0)
);

CREATE INDEX IF NOT EXISTS idx_inventory_planning_params_location ON inventory_planning_params (location_id);
CREATE INDEX IF NOT EXISTS idx_inventory_planning_params_sku ON inventory_planning_params (sku);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_inventory_planning_params_grain'
      AND conrelid = 'inventory_planning_params'::regclass
  ) THEN
    ALTER TABLE inventory_planning_params
      ADD CONSTRAINT uq_inventory_planning_params_grain UNIQUE NULLS NOT DISTINCT (sku, location_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_planning_params_service_level'
      AND conrelid = 'inventory_planning_params'::regclass
  ) THEN
    ALTER TABLE inventory_planning_params
      ADD CONSTRAINT chk_inventory_planning_params_service_level CHECK (service_level IS NULL OR (service_level > 0 AND service_level < 1));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_planning_params_lead_time_non_negative'
      AND conrelid = 'inventory_planning_params'::regclass
  ) THEN
    ALTER TABLE inventory_planning_params
      ADD CONSTRAINT chk_inventory_planning_params_lead_time_non_negative CHECK (lead_time_days IS NULL OR lead_time_days >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_planning_params_window_positive'
      AND conrelid = 'inventory_planning_params'::regclass
  ) THEN
    ALTER TABLE inventory_planning_params
      ADD CONSTRAINT chk_inventory_planning_params_window_positive CHECK (demand_window_days > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON inventory_planning_params TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON inventory_planning_params TO readonly_user;
  END IF;
END $$;
