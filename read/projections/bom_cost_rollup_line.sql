-- BOM cost rollup snapshot line read model (Story 5.6, FR-B-15). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks). deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks).
--
-- One row per costed BOM line occurrence in the walk, keyed by (rollup_id, path, line_no).
-- effective_quantity_per is scrap-adjusted quantity per ONE parent unit (Story 5.4 per-unit
-- semantics). extended_cost is zero on a line with no usable rate (rate_missing) and on a parent
-- node whose costed children carry the cost (has_child_bom) - only leaves contribute to the
-- header's total_cost, which is what keeps a multi-level rollup from double counting.
--
-- effective_quantity_per and extended_cost are unbounded NUMERIC deliberately: multi-level
-- quantity-times-rate products exceed NUMERIC(18,6) scale and PostgreSQL 18 silently rounds
-- excess scale. unit_cost stays NUMERIC(18,6) because it mirrors item_master.standard_cost_amount
-- exactly.

CREATE TABLE IF NOT EXISTS bom_cost_rollup_line (
  rollup_line_id        UUID PRIMARY KEY,
  rollup_id             UUID NOT NULL,
  depth                 INTEGER NOT NULL,
  path                  TEXT NOT NULL,
  source_bom_id         UUID,
  source_revision_id    UUID,
  bom_line_id           UUID NOT NULL,
  line_no               INTEGER NOT NULL,
  component_item_id     UUID,
  component_sku         TEXT,
  effective_quantity_per NUMERIC NOT NULL,
  scrap_percent         NUMERIC(9,6),
  unit_cost             NUMERIC(18,6),
  extended_cost         NUMERIC NOT NULL DEFAULT 0,
  rate_missing          BOOLEAN NOT NULL DEFAULT false,
  via_phantom           BOOLEAN NOT NULL DEFAULT false,
  has_child_bom         BOOLEAN NOT NULL DEFAULT false,
  source_event_id       UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bom_cost_rollup_line_depth CHECK (depth >= 0),
  CONSTRAINT chk_bom_cost_rollup_line_quantity_positive CHECK (effective_quantity_per > 0),
  CONSTRAINT chk_bom_cost_rollup_line_extended_non_negative CHECK (extended_cost >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_cost_rollup_line_no ON bom_cost_rollup_line (rollup_id, path, line_no);
CREATE INDEX IF NOT EXISTS idx_bom_cost_rollup_line_rollup ON bom_cost_rollup_line (rollup_id);
CREATE INDEX IF NOT EXISTS idx_bom_cost_rollup_line_component ON bom_cost_rollup_line (component_item_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_cost_rollup_line_depth'
      AND conrelid = 'bom_cost_rollup_line'::regclass
  ) THEN
    ALTER TABLE bom_cost_rollup_line
      ADD CONSTRAINT chk_bom_cost_rollup_line_depth CHECK (depth >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_cost_rollup_line_quantity_positive'
      AND conrelid = 'bom_cost_rollup_line'::regclass
  ) THEN
    ALTER TABLE bom_cost_rollup_line
      ADD CONSTRAINT chk_bom_cost_rollup_line_quantity_positive CHECK (effective_quantity_per > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_cost_rollup_line_extended_non_negative'
      AND conrelid = 'bom_cost_rollup_line'::regclass
  ) THEN
    ALTER TABLE bom_cost_rollup_line
      ADD CONSTRAINT chk_bom_cost_rollup_line_extended_non_negative CHECK (extended_cost >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON bom_cost_rollup_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON bom_cost_rollup_line TO readonly_user;
  END IF;
END $$;
