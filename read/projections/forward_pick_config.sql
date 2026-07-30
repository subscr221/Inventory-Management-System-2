-- Forward-pick replenishment configuration (Story 3.9, FR-W-08). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate). deploy/compose/init-db.sql
-- duplicates this content for first-boot container init - change both files together. Every
-- statement is idempotent.
--
-- SKU-per-forward-pick-zone min/max configuration. site_id is denormalized at write time from the
-- zone's own site_id (never accepted from the client) - forward_pick_config and task_sla_config are
-- twin projections, both keyed by a grain that includes a zone, both needing site_id in the grain
-- for the same reason task_sla_config's review added it there: a null-site config would let one
-- site's manager set another site's replenishment thresholds.
--
-- Rows are written ONLY through persistEvent's forward_pick_config.updated seam
-- (src/compliance/replenishment.ts), mirroring task_sla_config.updated. No DELETE grant: a
-- threshold is superseded by a new value at the same (sku, zone_id) grain, never removed.

CREATE TABLE IF NOT EXISTS forward_pick_config (
  config_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku        TEXT NOT NULL,
  zone_id    UUID NOT NULL REFERENCES location_register(location_id),
  site_id    UUID NOT NULL,
  min_qty    NUMERIC(18,3) NOT NULL,
  max_qty    NUMERIC(18,3) NOT NULL,
  updated_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_forward_pick_config_min_non_negative CHECK (min_qty >= 0),
  CONSTRAINT chk_forward_pick_config_max_gt_min CHECK (max_qty > min_qty)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_forward_pick_config_min_non_negative'
      AND conrelid = 'forward_pick_config'::regclass
  ) THEN
    ALTER TABLE forward_pick_config
      ADD CONSTRAINT chk_forward_pick_config_min_non_negative CHECK (min_qty >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_forward_pick_config_max_gt_min'
      AND conrelid = 'forward_pick_config'::regclass
  ) THEN
    ALTER TABLE forward_pick_config
      ADD CONSTRAINT chk_forward_pick_config_max_gt_min CHECK (max_qty > min_qty);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_forward_pick_config_sku_zone ON forward_pick_config (sku, zone_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON forward_pick_config TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON forward_pick_config TO readonly_user;
  END IF;
END $$;
