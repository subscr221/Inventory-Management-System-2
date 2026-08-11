-- BOM revision read model (Story 5.1, release status added in Story 5.2). This file is the
-- CANONICAL definition. See bom.sql for the canonical comment about source, grants, and idempotency.
--
-- A BOM revision captures a specific version of a bill of materials. Multiple revisions
-- can exist for the same BOM (parent_item_id) as the engineering change process evolves.
-- Revision status is 'draft' or 'released' (Story 5.2). Hold/obsolete live at the BOM
-- HEADER level only; a released revision is immutable (FR-B-03).

CREATE TABLE IF NOT EXISTS bom_revision (
  revision_id       UUID PRIMARY KEY,
  bom_id            UUID NOT NULL,
  revision_code     TEXT NOT NULL,
  revision_status   TEXT NOT NULL DEFAULT 'draft',
  drafted_by        UUID NOT NULL,
  drafted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at       TIMESTAMPTZ,
  released_by       UUID,
  source_event_id   UUID NOT NULL,
  CONSTRAINT chk_bom_revision_status CHECK (revision_status IN ('draft','released'))
);

-- Story 5.2 release columns for databases created before this story.
ALTER TABLE bom_revision ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;
ALTER TABLE bom_revision ADD COLUMN IF NOT EXISTS released_by UUID;

-- Story 5.3: the ECO (if any) whose implementation created this revision. The machine-checkable
-- evidence the AC 9 release-gate condition reads; "was this revision ECO-driven" is never
-- re-derived any other way.
ALTER TABLE bom_revision ADD COLUMN IF NOT EXISTS source_eco_id UUID;
CREATE INDEX IF NOT EXISTS idx_bom_revision_source_eco ON bom_revision (source_eco_id);

-- Story 5.2 widens chk_bom_revision_status on live databases. DROP + ADD wrapped in a DO block
-- for atomicity (migrate.ts runs the whole file as one transaction today; the DO block keeps the
-- pair atomic even if that ever changes, and mirrors deploy/compose/init-db.sql exactly).
DO $$
BEGIN
  ALTER TABLE bom_revision DROP CONSTRAINT IF EXISTS chk_bom_revision_status;
  ALTER TABLE bom_revision ADD CONSTRAINT chk_bom_revision_status CHECK (revision_status IN ('draft','released'));
END $$;

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
      ADD CONSTRAINT chk_bom_revision_status CHECK (revision_status IN ('draft','released'));
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
