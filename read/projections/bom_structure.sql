-- BOM structure read model (Story 5.1). This file is the CANONICAL definition.
-- See bom.sql for the canonical comment about source, grants, and idempotency.
--
-- The bom_structure is the phantom-resolved, depth-annotated structure read model.
-- It represents the flat list of all BOM rows after phantom expansion: the phantom's
-- children are materialized at the parent level with multiplied quantities and
-- accumulated scrap. The phantom item itself never appears as a structure row.
-- This is the substrate that Story 5.3 (where-used) and Story 5.5 (explosion)
-- will read from.
--
-- path holds the dot-separated line-number path from root (e.g., "1.2.3" means
-- line 1 of the root BOM, line 2 of its first phantom child, line 3 of the next).
-- depth starts at 0 for top-level components.

CREATE TABLE IF NOT EXISTS bom_structure (
  structure_id           UUID PRIMARY KEY,
  bom_id                UUID NOT NULL,
  revision_id           UUID NOT NULL,
  root_bom_line_id      UUID,
  path                  TEXT NOT NULL,
  depth                 INTEGER NOT NULL,
  component_item_id     UUID NOT NULL,
  component_sku         TEXT NOT NULL,
  output_class          TEXT NOT NULL DEFAULT 'component',
  effective_quantity_per NUMERIC(18,6) NOT NULL,
  effective_scrap_percent NUMERIC(9,6),
  via_phantom           BOOLEAN NOT NULL DEFAULT false,
  effective_from        DATE NOT NULL,
  effective_to          DATE,
  source_event_id       UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bom_structure_depth CHECK (depth >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_structure_path ON bom_structure (revision_id, path);
CREATE INDEX IF NOT EXISTS idx_bom_structure_component ON bom_structure (component_item_id);
CREATE INDEX IF NOT EXISTS idx_bom_structure_bom_id ON bom_structure (bom_id);
CREATE INDEX IF NOT EXISTS idx_bom_structure_revision ON bom_structure (revision_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_structure_depth'
      AND conrelid = 'bom_structure'::regclass
  ) THEN
    ALTER TABLE bom_structure
      ADD CONSTRAINT chk_bom_structure_depth CHECK (depth >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE, DELETE ON bom_structure TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON bom_structure TO readonly_user;
  END IF;
END $$;
