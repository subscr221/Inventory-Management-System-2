-- BOM revision read model (Story 5.1). This file is the CANONICAL definition.
-- See bom.sql for the canonical comment about source, grants, and idempotency.
--
-- A BOM revision captures a specific version of a bill of materials. Multiple revisions
-- can exist for the same BOM (parent_item_id) as the engineering change process evolves.
-- Revision status is 'draft' in this story; Story 5.2 adds released, hold, obsolete states.

CREATE TABLE IF NOT EXISTS bom_revision (
  revision_id       UUID PRIMARY KEY,
  bom_id            UUID NOT NULL,
  revision_code     TEXT NOT NULL,
  revision_status   TEXT NOT NULL DEFAULT 'draft',
  drafted_by        UUID NOT NULL,
  drafted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_event_id   UUID NOT NULL,
  CONSTRAINT chk_bom_revision_status CHECK (revision_status IN ('draft'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_revision_code ON bom_revision (bom_id, revision_code);
CREATE INDEX IF NOT EXISTS idx_bom_revision_bom_id ON bom_revision (bom_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_revision_status'
      AND conrelid = 'bom_revision'::regclass
  ) THEN
    ALTER TABLE bom_revision
      ADD CONSTRAINT chk_bom_revision_status CHECK (revision_status IN ('draft'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON bom_revision TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON bom_revision TO readonly_user;
  END IF;
END $$;
