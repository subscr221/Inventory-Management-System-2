-- Opening-stock migration import header (Story 13.1, FR-DM-01). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks). deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks).
--
-- One row per submitted import FILE, written by the `migration.import.completed` applier after the
-- last row event of the file has been persisted. `load_id` is the stream_id every per-row
-- `migration.opening_stock.loaded` event of that file rides on; a crash before the completion
-- event leaves accepted rows queryable by load_id and NO header, which is the AC 6 resume signal.
-- `idempotency_key` is the caller's key for the whole file: a replay returns this row untouched.
-- `domain` was pinned to 'opening_stock' by Story 13.1; Story 13.2 widens it to the four document
-- domains (active_boms, open_pos, jobwork_challans, custody_registers) whose manifests share this
-- header, with the DROP-then-ADD block below (a plain CHECK edit never propagates to an existing
-- database - deferred-work 220).
-- `mode` is explicit per file (Binding Decision 5): 'initial' refuses a differing row on a live
-- grain (DUPLICATE_LOT_SERIAL), 'correction' supersedes it.

CREATE TABLE IF NOT EXISTS migration_import (
  load_id             UUID PRIMARY KEY,
  site_id             UUID NOT NULL,
  domain              TEXT NOT NULL,
  file_name           TEXT NOT NULL,
  file_sha256         TEXT NOT NULL,
  template_version    TEXT NOT NULL,
  mode                TEXT NOT NULL,
  row_count           INTEGER,
  accepted_count      INTEGER,
  rejected_count      INTEGER,
  suppressed_count    INTEGER,
  superseded_count    INTEGER,
  idempotency_key     TEXT NOT NULL,
  created_by_actor_id UUID NOT NULL,
  source_event_id     UUID,
  source_event_type   TEXT,
  occurred_at         TIMESTAMPTZ,
  business_date       DATE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_migration_import_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT chk_migration_import_domain CHECK (domain IN ('opening_stock', 'active_boms', 'open_pos', 'jobwork_challans', 'custody_registers')),
  CONSTRAINT chk_migration_import_mode CHECK (mode IN ('initial', 'correction'))
);

CREATE INDEX IF NOT EXISTS idx_migration_import_site ON migration_import (site_id, domain, created_at);

-- Story 13.2: widen the domain vocabulary on databases created by Story 13.1 (DROP-then-ADD).
DO $$
BEGIN
  ALTER TABLE migration_import DROP CONSTRAINT IF EXISTS chk_migration_import_domain;
  ALTER TABLE migration_import
    ADD CONSTRAINT chk_migration_import_domain CHECK (domain IN ('opening_stock', 'active_boms', 'open_pos', 'jobwork_challans', 'custody_registers'));
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_migration_import_mode'
      AND conrelid = 'migration_import'::regclass
  ) THEN
    ALTER TABLE migration_import
      ADD CONSTRAINT chk_migration_import_mode CHECK (mode IN ('initial', 'correction'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON migration_import TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON migration_import TO readonly_user;
  END IF;
END $$;
