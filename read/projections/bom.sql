-- Bill of Materials (BOM) read model (Story 5.1). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries
-- its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as
-- app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a live database
-- safely.
--
-- Derived state ONLY: rows are rebuildable by replaying bom.* domain events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert. Status vocabulary is 'draft' in this story.
-- Story 5.2 widens the status vocabulary to include released, hold, obsolete states.

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
  created_by            UUID NOT NULL,
  correlation_id        UUID,
  source_event_id       UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bom_type CHECK (bom_type IN ('production','rnd','job_work_kit')),
  CONSTRAINT chk_bom_status CHECK (status IN ('draft'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_parent_item ON bom (parent_item_id);
CREATE INDEX IF NOT EXISTS idx_bom_status ON bom (status);
CREATE INDEX IF NOT EXISTS idx_bom_business_stream ON bom (business_stream);
CREATE INDEX IF NOT EXISTS idx_bom_parent_item_id ON bom (parent_item_id);
CREATE INDEX IF NOT EXISTS idx_bom_blocking ON bom (blocking_line_count) WHERE blocking_line_count > 0;

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
      ADD CONSTRAINT chk_bom_status CHECK (status IN ('draft'));
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
