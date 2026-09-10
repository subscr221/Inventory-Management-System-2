-- Opening-stock migration rejected-row report (Story 13.1, FR-DM-01 AC 4 / AC 5). This file is
-- the CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks). deploy/compose/
-- init-db.sql duplicates this content for first-boot container init - change both files together.
-- Every statement is idempotent (IF NOT EXISTS / guarded DO blocks).
--
-- One row per REJECTED import line, written by the `migration.import.completed` applier from the
-- rejections[] array the event carries. `error_code` is one of MALFORMED_ROW, UNKNOWN_REFERENCE,
-- DUPLICATE_LOT_SERIAL; `details` carries the code-specific keys (column, reference,
-- first_line_no, existing_row_id); `raw_row` is the source line verbatim so the migration lead can
-- find it in the file. Append-only: a re-submitted file mints a new load_id and its own rows.

CREATE TABLE IF NOT EXISTS migration_import_rejection (
  rejection_id UUID PRIMARY KEY,
  load_id      UUID NOT NULL,
  line_no      INTEGER NOT NULL,
  error_code   TEXT NOT NULL,
  details      JSONB NOT NULL,
  raw_row      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_migration_import_rejection_error_code CHECK (error_code IN ('MALFORMED_ROW', 'UNKNOWN_REFERENCE', 'DUPLICATE_LOT_SERIAL'))
);

CREATE INDEX IF NOT EXISTS idx_migration_import_rejection_load ON migration_import_rejection (load_id, line_no);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_migration_import_rejection_error_code'
      AND conrelid = 'migration_import_rejection'::regclass
  ) THEN
    ALTER TABLE migration_import_rejection
      ADD CONSTRAINT chk_migration_import_rejection_error_code CHECK (error_code IN ('MALFORMED_ROW', 'UNKNOWN_REFERENCE', 'DUPLICATE_LOT_SERIAL'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON migration_import_rejection TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON migration_import_rejection TO readonly_user;
  END IF;
END $$;
