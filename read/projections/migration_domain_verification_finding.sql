-- Domain verification findings (Story 13.2, FR-DM-02). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks). deploy/compose/init-db.sql duplicates this content
-- for first-boot container init - change both files together. Every statement is idempotent
-- (IF NOT EXISTS / guarded DO blocks).
--
-- One row per finding of one run. `kind` 'unknown_reference' (error_code UNKNOWN_REFERENCE) is a
-- QUARANTINE: the platform document's item, location or source-document reference does not
-- resolve, it does not count as migrated, and it can never be waived (Binding Decision 5). The
-- other four kinds carry RECONCILIATION_MISMATCH and may be waived by the department head with a
-- narrative at sign-off; the `migration.domain.verified` applier flips them to 'waived'. UPDATE is
-- granted for exactly that flip. `platform_ref` is the platform row's id (bom_id, po line key,
-- receipt_id, service_order_id) as text; `source_value` / `platform_value` are NUMERIC strings or
-- text, never JS floats.

CREATE TABLE IF NOT EXISTS migration_domain_verification_finding (
  finding_id        UUID PRIMARY KEY,
  run_id            UUID NOT NULL,
  site_id           UUID NOT NULL,
  domain            TEXT NOT NULL,
  kind              TEXT NOT NULL,
  error_code        TEXT NOT NULL,
  document_ref_ext  TEXT NOT NULL,
  line_ref          TEXT NOT NULL,
  platform_ref      TEXT,
  field             TEXT,
  source_value      TEXT,
  platform_value    TEXT,
  details           JSONB NOT NULL,
  status            TEXT NOT NULL,
  waiver_narrative  TEXT,
  waived_event_id   UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_migration_domain_verification_finding_kind CHECK (kind IN ('unknown_reference', 'missing_in_platform', 'missing_in_source', 'field_mismatch', 'state_mismatch')),
  CONSTRAINT chk_migration_domain_verification_finding_error_code CHECK (error_code IN ('UNKNOWN_REFERENCE', 'RECONCILIATION_MISMATCH')),
  CONSTRAINT chk_migration_domain_verification_finding_status CHECK (status IN ('open', 'waived'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_migration_domain_verification_finding_key ON migration_domain_verification_finding (run_id, kind, document_ref_ext, line_ref, field) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS idx_migration_domain_verification_finding_run ON migration_domain_verification_finding (run_id, status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_migration_domain_verification_finding_kind'
      AND conrelid = 'migration_domain_verification_finding'::regclass
  ) THEN
    ALTER TABLE migration_domain_verification_finding
      ADD CONSTRAINT chk_migration_domain_verification_finding_kind CHECK (kind IN ('unknown_reference', 'missing_in_platform', 'missing_in_source', 'field_mismatch', 'state_mismatch'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_migration_domain_verification_finding_error_code'
      AND conrelid = 'migration_domain_verification_finding'::regclass
  ) THEN
    ALTER TABLE migration_domain_verification_finding
      ADD CONSTRAINT chk_migration_domain_verification_finding_error_code CHECK (error_code IN ('UNKNOWN_REFERENCE', 'RECONCILIATION_MISMATCH'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_migration_domain_verification_finding_status'
      AND conrelid = 'migration_domain_verification_finding'::regclass
  ) THEN
    ALTER TABLE migration_domain_verification_finding
      ADD CONSTRAINT chk_migration_domain_verification_finding_status CHECK (status IN ('open', 'waived'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON migration_domain_verification_finding TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON migration_domain_verification_finding TO readonly_user;
  END IF;
END $$;
