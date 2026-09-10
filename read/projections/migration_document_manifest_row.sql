-- Document-domain migration manifest rows (Story 13.2, FR-DM-02). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks). deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks).
--
-- A manifest is the SOURCE side of a domain verification: the legacy extract listing what the
-- module epic's migration path should have produced (legacy-kit BOMs, ERP open-PO lines, job-work
-- challans, custody balances). One file is one `migration.document_manifest.loaded` event whose
-- applier inserts every accepted row here (Binding Decision 3: no per-row events - nothing keys on
-- a manifest row). A manifest is immutable once loaded and is REPLACED by a later load (the stage
-- row's latest_load_id moves); earlier loads stay queryable by load_id. `document_ref_ext` and
-- `line_ref` are the per-domain match keys (Table 2 of the story); `attributes` carries the typed
-- template cells the verification SQL compares. app_user has no UPDATE and no DELETE.

CREATE TABLE IF NOT EXISTS migration_document_manifest_row (
  row_id           UUID PRIMARY KEY,
  load_id          UUID NOT NULL,
  site_id          UUID NOT NULL,
  domain           TEXT NOT NULL,
  line_no          INTEGER NOT NULL,
  document_ref_ext TEXT NOT NULL,
  line_ref         TEXT NOT NULL,
  sku              TEXT,
  quantity         NUMERIC(18,6),
  attributes       JSONB NOT NULL,
  content_hash     TEXT NOT NULL,
  source_event_id  UUID NOT NULL,
  occurred_at      TIMESTAMPTZ NOT NULL,
  business_date    DATE NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_migration_document_manifest_row_key UNIQUE (load_id, document_ref_ext, line_ref),
  CONSTRAINT chk_migration_document_manifest_row_domain CHECK (domain IN ('active_boms', 'open_pos', 'jobwork_challans', 'custody_registers'))
);

CREATE INDEX IF NOT EXISTS idx_migration_document_manifest_row_load ON migration_document_manifest_row (site_id, domain, load_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_migration_document_manifest_row_domain'
      AND conrelid = 'migration_document_manifest_row'::regclass
  ) THEN
    ALTER TABLE migration_document_manifest_row
      ADD CONSTRAINT chk_migration_document_manifest_row_domain CHECK (domain IN ('active_boms', 'open_pos', 'jobwork_challans', 'custody_registers'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON migration_document_manifest_row TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON migration_document_manifest_row TO readonly_user;
  END IF;
END $$;
