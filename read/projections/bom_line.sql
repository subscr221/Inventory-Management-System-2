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
  component_item_id        UUID,
  component_sku            TEXT,
  is_placeholder           BOOLEAN NOT NULL DEFAULT false,
  free_text                TEXT,
  output_class             TEXT NOT NULL DEFAULT 'component',
  quantity_per             NUMERIC(18,6) NOT NULL,
  line_uom                 TEXT NOT NULL,
  uom_conversion_factor    NUMERIC(18,8) NOT NULL,
  base_quantity_per        NUMERIC(18,6) NOT NULL,
  scrap_percent            NUMERIC(7,4),
  expected_yield_percent   NUMERIC(7,4),
  is_phantom               BOOLEAN NOT NULL DEFAULT false,
  phantom_source_bom_id    UUID,
  supply_method            TEXT NOT NULL DEFAULT 'directed_issue',
  is_released_structure    BOOLEAN NOT NULL DEFAULT false,
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
  ),
  CONSTRAINT chk_bom_line_placeholder_pairing CHECK (
    (is_placeholder = true AND component_item_id IS NULL AND component_sku IS NULL AND free_text IS NOT NULL AND btrim(free_text) <> '') OR
    (is_placeholder = false AND component_item_id IS NOT NULL AND component_sku IS NOT NULL)
  ),
  CONSTRAINT chk_bom_line_supply_method CHECK (supply_method IN ('directed_issue','backflush'))
);

-- Story 5.4 placeholder/free-text columns for databases created before this story. The NOT NULL
-- drop on component identity is DB-wide because a CHECK cannot see bom.bom_type; the applier guard
-- (RD_PLACEHOLDER_NOT_PERMITTED in src/compliance/bom.ts) is what keeps placeholders off
-- production BOMs. quantity_per / line_uom / uom_conversion_factor / base_quantity_per stay
-- NOT NULL - a placeholder still consumes a quantity in a unit; only item identity is unknown.
ALTER TABLE bom_line ALTER COLUMN component_item_id DROP NOT NULL;
ALTER TABLE bom_line ALTER COLUMN component_sku DROP NOT NULL;
ALTER TABLE bom_line ADD COLUMN IF NOT EXISTS is_placeholder BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE bom_line ADD COLUMN IF NOT EXISTS free_text TEXT;

-- Story 5.4 placeholder pairing: DROP + ADD pair kept atomic in a DO block, mirroring the
-- chk_bom_status swap pattern in bom.sql.
DO $$
BEGIN
  ALTER TABLE bom_line DROP CONSTRAINT IF EXISTS chk_bom_line_placeholder_pairing;
  ALTER TABLE bom_line ADD CONSTRAINT chk_bom_line_placeholder_pairing CHECK (
    (is_placeholder = true AND component_item_id IS NULL AND component_sku IS NULL AND free_text IS NOT NULL AND btrim(free_text) <> '') OR
    (is_placeholder = false AND component_item_id IS NOT NULL AND component_sku IS NOT NULL)
  );
END $$;

-- Story 5.5 supply method: how execution consumes this component (FR-B-07). 'directed_issue' is
-- the default so every pre-5.5 line keeps its existing behaviour; 'backflush' lines are consumed
-- implicitly at completion. The DROP + ADD pair is kept atomic in a DO block, mirroring the
-- chk_bom_line_placeholder_pairing swap above.
ALTER TABLE bom_line ADD COLUMN IF NOT EXISTS supply_method TEXT NOT NULL DEFAULT 'directed_issue';

DO $$
BEGIN
  ALTER TABLE bom_line DROP CONSTRAINT IF EXISTS chk_bom_line_supply_method;
  ALTER TABLE bom_line ADD CONSTRAINT chk_bom_line_supply_method CHECK (supply_method IN ('directed_issue','backflush'));
END $$;

-- Story 5.5 review (sync scoping): the released_bom_structure PowerSync bucket filters on this
-- denormalized marker because legacy Sync Rules support NO joins or subqueries (the pinned
-- PowerSync 1.23.x subset). It is a projection of "this line belongs to a released revision of a
-- released BOM", maintained in src/read/projections/bom.ts updateBomStatus (released -> true,
-- on_hold/obsolete -> false) and set explicitly by the legacy-kit migration path, which inserts
-- released structure directly. Alternates are only ever created on released revisions, so
-- insertBomAlternate stamps them true.
ALTER TABLE bom_line ADD COLUMN IF NOT EXISTS is_released_structure BOOLEAN NOT NULL DEFAULT false;

-- Backfill for deployments upgraded from before this marker: released revisions of currently
-- released BOMs keep their sync visibility; everything else stays false. Idempotent by nature.
UPDATE bom_line SET is_released_structure = true, updated_at = now()
 WHERE revision_id IN (
   SELECT br.revision_id FROM bom_revision br JOIN bom b ON b.bom_id = br.bom_id
    WHERE br.revision_status = 'released' AND b.status = 'released'
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
