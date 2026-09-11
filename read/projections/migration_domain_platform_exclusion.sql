-- Domain verification platform exclusions (Story 13.2 review round, FR-DM-02). This file is the
-- CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks). deploy/compose/init-db.sql
-- duplicates this content for first-boot container init - change both files together. Every
-- statement is idempotent (IF NOT EXISTS / guarded DO blocks).
--
-- A platform-only referential problem (a pre-existing platform row that was never part of any
-- manifest, so the department head has no source-side lever to "fix and re-run") would otherwise
-- quarantine its domain forever, since UNKNOWN_REFERENCE can never be waived (Binding Decision 5)
-- and app_user has no DELETE. This table is the operational fix route: a migration_lead registers
-- the platform row's exclusion with a mandatory reason, and computeDomainFindings (in
-- src/read/projections/migration_domain_verification.ts) downgrades a matching finding from
-- 'unknown_reference' to a waivable 'state_mismatch' on every later run, so the domain can still be
-- signed off. No UPDATE, no DELETE: an exclusion is registered once (INSERT ... ON CONFLICT DO
-- NOTHING) and stands; the exclusion event itself is the durable audit trail either way.

CREATE TABLE IF NOT EXISTS migration_domain_platform_exclusion (
  exclusion_id      UUID PRIMARY KEY,
  site_id           UUID NOT NULL,
  domain            TEXT NOT NULL,
  platform_ref      TEXT NOT NULL,
  reason            TEXT NOT NULL,
  created_by_actor_id UUID NOT NULL,
  source_event_id   UUID NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL,
  business_date     DATE NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_migration_domain_platform_exclusion_domain CHECK (domain IN ('active_boms', 'open_pos', 'jobwork_challans', 'custody_registers'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_migration_domain_platform_exclusion_key ON migration_domain_platform_exclusion (site_id, domain, platform_ref);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_migration_domain_platform_exclusion_domain'
      AND conrelid = 'migration_domain_platform_exclusion'::regclass
  ) THEN
    ALTER TABLE migration_domain_platform_exclusion
      ADD CONSTRAINT chk_migration_domain_platform_exclusion_domain CHECK (domain IN ('active_boms', 'open_pos', 'jobwork_challans', 'custody_registers'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON migration_domain_platform_exclusion TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON migration_domain_platform_exclusion TO readonly_user;
  END IF;
END $$;
