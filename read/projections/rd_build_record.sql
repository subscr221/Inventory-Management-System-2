-- R&D draft-BOM build record read model (Story 5.4). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying rd_build.* domain events; mutation
-- happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert. A build record is created at status 'recorded'
-- (rd_build.recorded, FR-B-10) and becomes an immutable as-built snapshot at 'confirmed'
-- (rd_build.confirmed). 'confirmed' is TERMINAL - corrections are NEW snapshots under a new
-- build_ref (FR-AC-13). outcome exists for Epic 10 (FR-RD-08) failed/abandoned builds; it is
-- nullable and unenforced here.

CREATE TABLE IF NOT EXISTS rd_build_record (
  build_id          UUID PRIMARY KEY,
  bom_id            UUID NOT NULL,
  revision_id       UUID NOT NULL,
  build_ref         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'recorded',
  built_quantity    NUMERIC(18,6) NOT NULL,
  built_uom         TEXT NOT NULL,
  notes             TEXT,
  outcome           TEXT,
  recorded_by       UUID NOT NULL,
  recorded_at       TIMESTAMPTZ NOT NULL,
  confirmed_by      UUID,
  confirmed_at      TIMESTAMPTZ,
  correlation_id    UUID,
  source_event_id   UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rd_build_status CHECK (status IN ('recorded','confirmed')),
  CONSTRAINT chk_rd_build_quantity_positive CHECK (built_quantity > 0),
  CONSTRAINT chk_rd_build_outcome CHECK (outcome IS NULL OR outcome IN ('success','failed','abandoned'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rd_build_ref ON rd_build_record (bom_id, build_ref);
CREATE INDEX IF NOT EXISTS idx_rd_build_bom_id ON rd_build_record (bom_id);
CREATE INDEX IF NOT EXISTS idx_rd_build_status ON rd_build_record (status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_build_status'
      AND conrelid = 'rd_build_record'::regclass
  ) THEN
    ALTER TABLE rd_build_record
      ADD CONSTRAINT chk_rd_build_status CHECK (status IN ('recorded','confirmed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_build_quantity_positive'
      AND conrelid = 'rd_build_record'::regclass
  ) THEN
    ALTER TABLE rd_build_record
      ADD CONSTRAINT chk_rd_build_quantity_positive CHECK (built_quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_build_outcome'
      AND conrelid = 'rd_build_record'::regclass
  ) THEN
    ALTER TABLE rd_build_record
      ADD CONSTRAINT chk_rd_build_outcome CHECK (outcome IS NULL OR outcome IN ('success','failed','abandoned'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON rd_build_record TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON rd_build_record TO readonly_user;
  END IF;
END $$;
