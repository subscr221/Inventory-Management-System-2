-- Bill of Materials (BOM) read model (Story 5.1, lifecycle widened in Story 5.2). This file is the
-- CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks / DROP-ADD
-- constraint pairs) so the file can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying bom.* domain events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert. Status vocabulary (Story 5.2):
-- draft | released | on_hold | obsolete. origin distinguishes native BOMs from legacy kit
-- migrations (FR-B-02); remediation_flag marks migrated kits that landed as Draft for remediation.

CREATE TABLE IF NOT EXISTS bom (
  bom_id                UUID PRIMARY KEY,
  parent_item_id        UUID NOT NULL,
  parent_sku            TEXT NOT NULL,
  parent_uom            TEXT NOT NULL,
  business_stream       TEXT NOT NULL,
  bom_type              TEXT NOT NULL DEFAULT 'production',
  status                TEXT NOT NULL DEFAULT 'draft',
  current_revision_id   UUID,
  blocking_line_count   INTEGER NOT NULL DEFAULT 0,
  status_changed_at     TIMESTAMPTZ,
  status_changed_by     UUID,
  origin                TEXT NOT NULL DEFAULT 'native',
  remediation_flag      BOOLEAN NOT NULL DEFAULT false,
  kit_ref               TEXT,
  created_by            UUID NOT NULL,
  correlation_id        UUID,
  source_event_id       UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bom_type CHECK (bom_type IN ('production','rnd','job_work_kit')),
  CONSTRAINT chk_bom_status CHECK (status IN ('draft','released','on_hold','obsolete')),
  CONSTRAINT chk_bom_origin CHECK (origin IN ('native','legacy_kit'))
);

-- Story 5.2 lifecycle/migration columns for databases created before this story
-- (CREATE TABLE IF NOT EXISTS alone will not add columns to an existing table).
ALTER TABLE bom ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;
ALTER TABLE bom ADD COLUMN IF NOT EXISTS status_changed_by UUID;
ALTER TABLE bom ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'native';
ALTER TABLE bom ADD COLUMN IF NOT EXISTS remediation_flag BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE bom ADD COLUMN IF NOT EXISTS kit_ref TEXT;

-- Story 5.4 R&D provenance columns: cloned_from_bom_id records the production (or R&D) BOM an R&D
-- draft was cloned from (FR-B-10); productized_from_bom_id records the R&D draft a production BOM
-- was productized from (FR-B-11). These are the machine-checkable lineage the tests assert.
ALTER TABLE bom ADD COLUMN IF NOT EXISTS cloned_from_bom_id UUID;
ALTER TABLE bom ADD COLUMN IF NOT EXISTS productized_from_bom_id UUID;

-- Story 5.2 widens chk_bom_status on live databases: drop the Story 5.1 single-value CHECK and
-- re-add with the full lifecycle vocabulary. Wrapped in a DO block so the DROP + ADD pair is
-- atomic (migrate.ts runs the whole file as one transaction today; the DO block keeps the pair
-- atomic even if that ever changes, and mirrors deploy/compose/init-db.sql exactly).
DO $$
BEGIN
  ALTER TABLE bom DROP CONSTRAINT IF EXISTS chk_bom_status;
  ALTER TABLE bom ADD CONSTRAINT chk_bom_status CHECK (status IN ('draft','released','on_hold','obsolete'));
END $$;

-- Story 5.4 swaps uq_bom_parent_item to a PARTIAL unique index: production and job_work_kit BOMs
-- keep one-per-item uniqueness; R&D drafts (bom_type = 'rnd') may be many per item, which is what
-- makes cloning (FR-B-10) and parallel draft iteration possible. DROP + CREATE pair is re-runnable.
DROP INDEX IF EXISTS uq_bom_parent_item;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_parent_item ON bom (parent_item_id) WHERE bom_type <> 'rnd';
CREATE INDEX IF NOT EXISTS idx_bom_status ON bom (status);
CREATE INDEX IF NOT EXISTS idx_bom_business_stream ON bom (business_stream);
CREATE INDEX IF NOT EXISTS idx_bom_parent_item_id ON bom (parent_item_id);
CREATE INDEX IF NOT EXISTS idx_bom_blocking ON bom (blocking_line_count) WHERE blocking_line_count > 0;
CREATE INDEX IF NOT EXISTS idx_bom_cloned_from ON bom (cloned_from_bom_id);
CREATE INDEX IF NOT EXISTS idx_bom_productized_from ON bom (productized_from_bom_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_type'
      AND conrelid = 'bom'::regclass
  ) THEN
    ALTER TABLE bom
      ADD CONSTRAINT chk_bom_type CHECK (bom_type IN ('production','rnd','job_work_kit'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_status'
      AND conrelid = 'bom'::regclass
  ) THEN
    ALTER TABLE bom
      ADD CONSTRAINT chk_bom_status CHECK (status IN ('draft','released','on_hold','obsolete'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_origin'
      AND conrelid = 'bom'::regclass
  ) THEN
    ALTER TABLE bom
      ADD CONSTRAINT chk_bom_origin CHECK (origin IN ('native','legacy_kit'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON bom TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON bom TO readonly_user;
  END IF;
END $$;
