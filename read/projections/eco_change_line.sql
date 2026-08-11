-- ECO change line read model (Story 5.3). This file is the CANONICAL definition.
-- See bom.sql for the canonical comment about source, grants, and idempotency.
--
-- A proposed change line on an ECO: add a new component, amend an existing bom_line, or retire
-- (close the effectivity of) an existing bom_line. change_no orders the changes as proposed;
-- the eco.implemented applier applies them in this order onto the new revision.

CREATE TABLE IF NOT EXISTS eco_change_line (
  eco_change_id            UUID PRIMARY KEY,
  eco_id                   UUID NOT NULL,
  change_no                INTEGER NOT NULL,
  change_type              TEXT NOT NULL,
  target_bom_line_id       UUID,
  component_item_id        UUID,
  component_sku            TEXT,
  output_class             TEXT NOT NULL DEFAULT 'component',
  quantity_per             NUMERIC(18,6),
  line_uom                 TEXT,
  uom_conversion_factor    NUMERIC(18,8),
  base_quantity_per        NUMERIC(18,6),
  scrap_percent            NUMERIC(7,4),
  expected_yield_percent   NUMERIC(7,4),
  is_phantom               BOOLEAN NOT NULL DEFAULT false,
  phantom_source_bom_id    UUID,
  effective_from           DATE,
  effective_to             DATE,
  source_event_id          UUID NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_eco_change_type CHECK (change_type IN ('add','amend','retire')),
  CONSTRAINT chk_eco_change_target CHECK (
    (change_type = 'add' AND target_bom_line_id IS NULL AND component_item_id IS NOT NULL) OR
    (change_type IN ('amend','retire') AND target_bom_line_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_eco_change_no ON eco_change_line (eco_id, change_no);
CREATE INDEX IF NOT EXISTS idx_eco_change_eco_id ON eco_change_line (eco_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_eco_change_type'
      AND conrelid = 'eco_change_line'::regclass
  ) THEN
    ALTER TABLE eco_change_line
      ADD CONSTRAINT chk_eco_change_type CHECK (change_type IN ('add','amend','retire'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_eco_change_target'
      AND conrelid = 'eco_change_line'::regclass
  ) THEN
    ALTER TABLE eco_change_line
      ADD CONSTRAINT chk_eco_change_target CHECK (
        (change_type = 'add' AND target_bom_line_id IS NULL AND component_item_id IS NOT NULL) OR
        (change_type IN ('amend','retire') AND target_bom_line_id IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON eco_change_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON eco_change_line TO readonly_user;
  END IF;
END $$;
