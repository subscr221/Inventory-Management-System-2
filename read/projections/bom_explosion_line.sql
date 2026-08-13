-- BOM explosion requirement rows read model (Story 5.5). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks).
--
-- Derived state ONLY: one row per generated requirement, persisted verbatim from the
-- bom.exploded payload (capture-time computation, deterministic replay). Only component lines
-- generate requirements; co_product/by_product lines are outputs and never appear. Phantom lines
-- pass through: the phantom itself is absent and its children carry via_phantom = true.
--
-- required_quantity is unbounded NUMERIC deliberately (see bom_explosion.sql). alternates holds
-- the priority-ordered open alternates for the source bom_line on the explosion business_date.

CREATE TABLE IF NOT EXISTS bom_explosion_line (
  explosion_line_id   UUID PRIMARY KEY,
  explosion_id        UUID NOT NULL,
  depth               INTEGER NOT NULL,
  path                TEXT NOT NULL,
  source_bom_id       UUID NOT NULL,
  source_revision_id  UUID NOT NULL,
  bom_line_id         UUID NOT NULL,
  line_no             INTEGER NOT NULL,
  component_item_id   UUID NOT NULL,
  component_sku       TEXT,
  supply_method       TEXT NOT NULL,
  required_quantity   NUMERIC NOT NULL,
  scrap_percent       NUMERIC(9,6),
  base_quantity_per   NUMERIC(18,8) NOT NULL,
  has_child_bom       BOOLEAN NOT NULL DEFAULT false,
  via_phantom         BOOLEAN NOT NULL DEFAULT false,
  alternates          JSONB NOT NULL DEFAULT '[]',
  source_event_id     UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bom_explosion_line_depth CHECK (depth >= 0),
  CONSTRAINT chk_bom_explosion_line_supply_method CHECK (supply_method IN ('directed_issue','backflush')),
  CONSTRAINT chk_bom_explosion_line_quantity_positive CHECK (required_quantity > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_explosion_line_no
  ON bom_explosion_line (explosion_id, path, line_no);
CREATE INDEX IF NOT EXISTS idx_bom_explosion_line_explosion ON bom_explosion_line (explosion_id);
CREATE INDEX IF NOT EXISTS idx_bom_explosion_line_component ON bom_explosion_line (component_item_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_explosion_line_depth'
      AND conrelid = 'bom_explosion_line'::regclass
  ) THEN
    ALTER TABLE bom_explosion_line
      ADD CONSTRAINT chk_bom_explosion_line_depth CHECK (depth >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_explosion_line_supply_method'
      AND conrelid = 'bom_explosion_line'::regclass
  ) THEN
    ALTER TABLE bom_explosion_line
      ADD CONSTRAINT chk_bom_explosion_line_supply_method CHECK (supply_method IN ('directed_issue','backflush'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_explosion_line_quantity_positive'
      AND conrelid = 'bom_explosion_line'::regclass
  ) THEN
    ALTER TABLE bom_explosion_line
      ADD CONSTRAINT chk_bom_explosion_line_quantity_positive CHECK (required_quantity > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON bom_explosion_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON bom_explosion_line TO readonly_user;
  END IF;
END $$;
