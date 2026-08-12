-- R&D as-built snapshot line read model (Story 5.4). This file is the CANONICAL definition.
-- See rd_build_record.sql for the canonical comment about source, grants, and idempotency.
--
-- One row per as-built line of a draft-BOM build record. Lines are inserted at rd_build.recorded
-- with deviation columns empty; rd_build.confirmed recomputes the deviation set INSIDE the persist
-- transaction against the draft revision's CURRENT bom_line rows and stamps deviation_flag,
-- deviation_kind, and deviation_detail. A 'missing' deviation is carried by a synthetic row
-- appended after the recorded lines with continuing line_no. After confirmation the snapshot is
-- immutable (SNAPSHOT_IMMUTABLE) - corrections are new builds.

CREATE TABLE IF NOT EXISTS rd_as_built_line (
  as_built_line_id    UUID PRIMARY KEY,
  build_id            UUID NOT NULL,
  line_no             INTEGER NOT NULL,
  draft_bom_line_id   UUID,
  component_item_id   UUID,
  component_sku       TEXT,
  is_placeholder      BOOLEAN NOT NULL DEFAULT false,
  free_text           TEXT,
  quantity_used       NUMERIC(18,6) NOT NULL,
  line_uom            TEXT NOT NULL,
  deviation_flag      BOOLEAN NOT NULL DEFAULT false,
  deviation_kind      TEXT,
  deviation_detail    TEXT,
  source_event_id     UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rd_as_built_quantity_positive CHECK (quantity_used > 0),
  CONSTRAINT chk_rd_as_built_identity CHECK (
    (is_placeholder = true AND component_item_id IS NULL AND free_text IS NOT NULL AND btrim(free_text) <> '') OR
    (is_placeholder = false AND component_item_id IS NOT NULL AND component_sku IS NOT NULL)
  ),
  CONSTRAINT chk_rd_as_built_deviation CHECK (
    (deviation_flag = true AND deviation_kind IS NOT NULL) OR
    (deviation_flag = false AND deviation_kind IS NULL AND deviation_detail IS NULL)
  ),
  CONSTRAINT chk_rd_as_built_deviation_kind CHECK (
    deviation_kind IS NULL OR deviation_kind IN ('quantity','substitution','extra','missing','placeholder')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rd_as_built_line_no ON rd_as_built_line (build_id, line_no);
CREATE INDEX IF NOT EXISTS idx_rd_as_built_build_id ON rd_as_built_line (build_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_as_built_quantity_positive'
      AND conrelid = 'rd_as_built_line'::regclass
  ) THEN
    ALTER TABLE rd_as_built_line
      ADD CONSTRAINT chk_rd_as_built_quantity_positive CHECK (quantity_used > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_as_built_identity'
      AND conrelid = 'rd_as_built_line'::regclass
  ) THEN
    ALTER TABLE rd_as_built_line
      ADD CONSTRAINT chk_rd_as_built_identity CHECK (
        (is_placeholder = true AND component_item_id IS NULL AND free_text IS NOT NULL AND btrim(free_text) <> '') OR
        (is_placeholder = false AND component_item_id IS NOT NULL AND component_sku IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_as_built_deviation'
      AND conrelid = 'rd_as_built_line'::regclass
  ) THEN
    ALTER TABLE rd_as_built_line
      ADD CONSTRAINT chk_rd_as_built_deviation CHECK (
        (deviation_flag = true AND deviation_kind IS NOT NULL) OR
        (deviation_flag = false AND deviation_kind IS NULL AND deviation_detail IS NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_as_built_deviation_kind'
      AND conrelid = 'rd_as_built_line'::regclass
  ) THEN
    ALTER TABLE rd_as_built_line
      ADD CONSTRAINT chk_rd_as_built_deviation_kind CHECK (
        deviation_kind IS NULL OR deviation_kind IN ('quantity','substitution','extra','missing','placeholder')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON rd_as_built_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON rd_as_built_line TO readonly_user;
  END IF;
END $$;
