-- Domain verification run header (Story 13.2, FR-DM-02). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks). deploy/compose/init-db.sql duplicates this content
-- for first-boot container init - change both files together. Every statement is idempotent
-- (IF NOT EXISTS / guarded DO blocks).
--
-- One row per `migration.domain.verification_run` event: the manifest it compared (load_id), the
-- reconciliation counts the department head reviews (source records vs migrated records), and a
-- SHA-256 over the sorted findings so the event is the durable record of exactly what was signed
-- off. Findings live in migration_domain_verification_finding. The applier trusts the payload it
-- was given (Binding Decision 4); a re-run is a new event and a new row. UPDATE is granted for
-- waived_count, stamped by the `migration.domain.verified` applier.

CREATE TABLE IF NOT EXISTS migration_domain_verification (
  run_id            UUID PRIMARY KEY,
  site_id           UUID NOT NULL,
  domain            TEXT NOT NULL,
  load_id           UUID NOT NULL,
  source_count      INTEGER NOT NULL,
  migrated_count    INTEGER NOT NULL,
  quarantined_count INTEGER NOT NULL,
  mismatch_count    INTEGER NOT NULL,
  waived_count      INTEGER NOT NULL DEFAULT 0,
  run_by_actor_id   UUID NOT NULL,
  findings_sha256   TEXT NOT NULL,
  source_event_id   UUID NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL,
  business_date     DATE NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_migration_domain_verification_domain CHECK (domain IN ('active_boms', 'open_pos', 'jobwork_challans', 'custody_registers'))
);

CREATE INDEX IF NOT EXISTS idx_migration_domain_verification_site ON migration_domain_verification (site_id, domain, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_migration_domain_verification_domain'
      AND conrelid = 'migration_domain_verification'::regclass
  ) THEN
    ALTER TABLE migration_domain_verification
      ADD CONSTRAINT chk_migration_domain_verification_domain CHECK (domain IN ('active_boms', 'open_pos', 'jobwork_challans', 'custody_registers'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON migration_domain_verification TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON migration_domain_verification TO readonly_user;
  END IF;
END $$;
