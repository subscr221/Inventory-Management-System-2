-- BOM line read model (Story 5.1). This file is the CANONICAL definition.
-- See bom.sql for the canonical comment about source, grants, and idempotency.
--
-- A BOM line represents a single component input or co-product/by-product output
-- in a BOM revision. Lines carry effectivity dates for time-based configuration,
-- scrap percentages for yield loss, and unit-of-measure conversion factors.
-- The output_class distinguishes consumed components from co-products/by-products.

CREATE TABLE IF NOT EXISTS bom_line (
  bom_line_id              UUID PRIMARY KEY,
  revision_id              UUID NOT NULL,
  bom_id                   UUID NOT NULL,
  line_no                  INTEGER NOT NULL,
  component_item_id        UUID NOT NULL,
  component_sku            TEXT NOT NULL,
  output_class             TEXT NOT NULL DEFAULT 'component',
  quantity_per             NUMERIC(18,6) NOT NULL,
  line_uom                 TEXT NOT NULL,
  uom_conversion_factor    NUMERIC(18,8) NOT NULL,
  base_quantity_per        NUMERIC(18,6) NOT NULL,
  scrap_percent            NUMERIC(7,4),
  expected_yield_percent   NUMERIC(7,4),
  is_phantom               BOOLEAN NOT NULL DEFAULT false,
  phantom_source_bom_id    UUID,
  effective_from           DATE NOT NULL,
  effective_to            DATE,
  blocking_release         BOOLEAN NOT NULL DEFAULT false,
  blocking_reason          TEXT,
  amended_at               TIMESTAMPTZ,
  source_event_id         UUID NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bom_line_output_class CHECK (output_class IN ('component','co_product','by_product')),
  CONSTRAINT chk_bom_line_scrap_percent CHECK (scrap_percent IS NULL OR (scrap_percent >= 0 AND scrap_percent <= 100)),
  CONSTRAINT chk_bom_line_quantity_positive CHECK (quantity_per > 0),
  CONSTRAINT chk_bom_line_conversion_positive CHECK (uom_conversion_factor > 0),
  CONSTRAINT chk_bom_line_yield_required CHECK (
    (output_class = 'component' AND expected_yield_percent IS NULL) OR
    (output_class IN ('co_product','by_product') AND expected_yield_percent IS NOT NULL)
  ),
  CONSTRAINT chk_bom_line_effectivity_order CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT chk_bom_line_phantom_pairing CHECK (
    (is_phantom = true AND phantom_source_bom_id IS NOT NULL) OR
    (is_phantom = false AND phantom_source_bom_id IS NULL)
  ),
  CONSTRAINT chk_bom_line_blocking_reason CHECK (
    (blocking_release = true AND blocking_reason IS NOT NULL AND btrim(blocking_reason) <> '') OR
    (blocking_release = false AND blocking_reason IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_line_no ON bom_line (revision_id, line_no);
CREATE INDEX IF NOT EXISTS idx_bom_line_component_item ON bom_line (component_item_id);
CREATE INDEX IF NOT EXISTS idx_bom_line_bom_id ON bom_line (bom_id);
CREATE INDEX IF NOT EXISTS idx_bom_line_blocking ON bom_line (blocking_release) WHERE blocking_release = true;
CREATE INDEX IF NOT EXISTS idx_bom_line_effective ON bom_line (component_item_id, effective_from, effective_to);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_line_output_class'
      AND conrelid = 'bom_line'::regclass
  ) THEN
    ALTER TABLE bom_line
      ADD CONSTRAINT chk_bom_line_output_class CHECK (output_class IN ('component','co_product','by_product'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_line_scrap_percent'
      AND conrelid = 'bom_line'::regclass
  ) THEN
    ALTER TABLE bom_line
      ADD CONSTRAINT chk_bom_line_scrap_percent CHECK (scrap_percent IS NULL OR (scrap_percent >= 0 AND scrap_percent <= 100));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_line_quantity_positive'
      AND conrelid = 'bom_line'::regclass
  ) THEN
    ALTER TABLE bom_line
      ADD CONSTRAINT chk_bom_line_quantity_positive CHECK (quantity_per > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_line_conversion_positive'
      AND conrelid = 'bom_line'::regclass
  ) THEN
    ALTER TABLE bom_line
      ADD CONSTRAINT chk_bom_line_conversion_positive CHECK (uom_conversion_factor > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_line_yield_required'
      AND conrelid = 'bom_line'::regclass
  ) THEN
    ALTER TABLE bom_line
      ADD CONSTRAINT chk_bom_line_yield_required CHECK (
        (output_class = 'component' AND expected_yield_percent IS NULL) OR
        (output_class IN ('co_product','by_product') AND expected_yield_percent IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_line_effectivity_order'
      AND conrelid = 'bom_line'::regclass
  ) THEN
    ALTER TABLE bom_line
      ADD CONSTRAINT chk_bom_line_effectivity_order CHECK (effective_to IS NULL OR effective_to >= effective_from);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_line_phantom_pairing'
      AND conrelid = 'bom_line'::regclass
  ) THEN
    ALTER TABLE bom_line
      ADD CONSTRAINT chk_bom_line_phantom_pairing CHECK (
        (is_phantom = true AND phantom_source_bom_id IS NOT NULL) OR
        (is_phantom = false AND phantom_source_bom_id IS NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_line_blocking_reason'
      AND conrelid = 'bom_line'::regclass
  ) THEN
    ALTER TABLE bom_line
      ADD CONSTRAINT chk_bom_line_blocking_reason CHECK (
        (blocking_release = true AND blocking_reason IS NOT NULL AND btrim(blocking_reason) <> '') OR
        (blocking_release = false AND blocking_reason IS NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON bom_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON bom_line TO readonly_user;
  END IF;
END $$;
