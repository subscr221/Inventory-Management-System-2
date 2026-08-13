-- Approved alternates and ad-hoc substitutions read model (Story 5.5). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks).
--
-- Derived state ONLY: rows are rebuildable by replaying bom.alternate_defined and
-- bom.substitution_approved domain events; mutation happens exclusively through persistEvent,
-- which applies this projection inside the SAME transaction as the domain_events insert.
--
-- One row per approved alternate (origin 'approved', FR-B-12) or DOA-approved ad-hoc substitution
-- (origin 'ad_hoc', FR-DOA-01). Both share this table so the alternates-by-component read model
-- serves execution as ONE priority-ordered stream. Alternates are keyed per BOM LINE, so an ECO
-- revision (Story 5.3 copies lines with fresh bom_line_id values) does not carry them over.

CREATE TABLE IF NOT EXISTS bom_alternate (
  bom_alternate_id    UUID PRIMARY KEY,
  bom_id              UUID NOT NULL,
  revision_id         UUID NOT NULL,
  bom_line_id         UUID NOT NULL,
  line_no             INTEGER NOT NULL,
  component_item_id   UUID NOT NULL,
  alternate_item_id   UUID NOT NULL,
  alternate_sku       TEXT,
  priority            INTEGER NOT NULL,
  effective_from      DATE NOT NULL,
  effective_to        DATE,
  origin              TEXT NOT NULL,
  doa_entry_id        UUID,
  approver_actor_id   UUID,
  is_released_structure BOOLEAN NOT NULL DEFAULT false,
  defined_by          UUID NOT NULL,
  source_event_id     UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bom_alternate_origin CHECK (origin IN ('approved','ad_hoc')),
  CONSTRAINT chk_bom_alternate_priority CHECK (priority >= 1),
  CONSTRAINT chk_bom_alternate_effectivity_order CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT chk_bom_alternate_not_self CHECK (alternate_item_id <> component_item_id),
  CONSTRAINT chk_bom_alternate_doa_pairing CHECK (
    (origin = 'ad_hoc' AND doa_entry_id IS NOT NULL AND approver_actor_id IS NOT NULL) OR
    (origin = 'approved' AND doa_entry_id IS NULL AND approver_actor_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_alternate_entry
  ON bom_alternate (bom_line_id, alternate_item_id, effective_from);
CREATE INDEX IF NOT EXISTS idx_bom_alternate_bom_id ON bom_alternate (bom_id);
CREATE INDEX IF NOT EXISTS idx_bom_alternate_line ON bom_alternate (bom_line_id, priority);
CREATE INDEX IF NOT EXISTS idx_bom_alternate_effective
  ON bom_alternate (bom_line_id, effective_from, effective_to);

-- Story 5.5 review (sync scoping): the released_bom_structure PowerSync bucket filters on this
-- denormalized marker because legacy Sync Rules support NO joins or subqueries. Alternates are
-- only ever created on released revisions of released BOMs (the compliance seam enforces both),
-- so insertBomAlternate stamps it true and updateBomStatus clears it on hold/obsolete. Backfill
-- keeps upgraded deployments' released structure visible.
ALTER TABLE bom_alternate ADD COLUMN IF NOT EXISTS is_released_structure BOOLEAN NOT NULL DEFAULT false;

UPDATE bom_alternate SET is_released_structure = true, updated_at = now()
 WHERE revision_id IN (
   SELECT br.revision_id FROM bom_revision br JOIN bom b ON b.bom_id = br.bom_id
    WHERE br.revision_status = 'released' AND b.status = 'released'
 );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_alternate_origin'
      AND conrelid = 'bom_alternate'::regclass
  ) THEN
    ALTER TABLE bom_alternate
      ADD CONSTRAINT chk_bom_alternate_origin CHECK (origin IN ('approved','ad_hoc'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_alternate_priority'
      AND conrelid = 'bom_alternate'::regclass
  ) THEN
    ALTER TABLE bom_alternate
      ADD CONSTRAINT chk_bom_alternate_priority CHECK (priority >= 1);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_alternate_effectivity_order'
      AND conrelid = 'bom_alternate'::regclass
  ) THEN
    ALTER TABLE bom_alternate
      ADD CONSTRAINT chk_bom_alternate_effectivity_order CHECK (effective_to IS NULL OR effective_to >= effective_from);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_alternate_not_self'
      AND conrelid = 'bom_alternate'::regclass
  ) THEN
    ALTER TABLE bom_alternate
      ADD CONSTRAINT chk_bom_alternate_not_self CHECK (alternate_item_id <> component_item_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_alternate_doa_pairing'
      AND conrelid = 'bom_alternate'::regclass
  ) THEN
    ALTER TABLE bom_alternate
      ADD CONSTRAINT chk_bom_alternate_doa_pairing CHECK (
        (origin = 'ad_hoc' AND doa_entry_id IS NOT NULL AND approver_actor_id IS NOT NULL) OR
        (origin = 'approved' AND doa_entry_id IS NULL AND approver_actor_id IS NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON bom_alternate TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON bom_alternate TO readonly_user;
  END IF;
END $$;
