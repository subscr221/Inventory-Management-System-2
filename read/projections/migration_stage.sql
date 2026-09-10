-- Per-site, per-domain migration stage (Story 13.1, FR-DM-01 AC 3; consumed by Stories 13.2 and
-- 13.3). This file is the CANONICAL definition, applied by src/events/migrate.ts (npm run
-- db:migrate) and the integration-test harness. It carries its OWN grants (guarded DO blocks).
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks).
--
-- Promotion is the boundary between "data under review" (staging) and "data the system runs on"
-- (dry_run). A row is inserted as 'staging' the first time a domain is promoted or locked and
-- moves to 'dry_run' by the `migration.stage.promoted` applier, which also posts the domain's
-- accepted rows to the live ledger in the same transaction. No row means 'staging' (the read
-- route defaults it). `domain` is deliberately NOT constrained to 'opening_stock': Story 13.2 adds
-- active_boms, open_pos, jobwork_challans and custody_registers, and Story 13.3 reads all of them
-- for the go-live gate. Reverse promotion is unsupported (Open Question 5): a site promoted in
-- error is a restore of the disposable staging environment.

CREATE TABLE IF NOT EXISTS migration_stage (
  site_id              UUID NOT NULL,
  domain               TEXT NOT NULL,
  stage                TEXT NOT NULL,
  promoted_at          TIMESTAMPTZ,
  promoted_event_id    UUID,
  promoted_by_actor_id UUID,
  posted_row_count     INTEGER,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_migration_stage PRIMARY KEY (site_id, domain),
  CONSTRAINT chk_migration_stage_stage CHECK (stage IN ('staging', 'dry_run'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_migration_stage_stage'
      AND conrelid = 'migration_stage'::regclass
  ) THEN
    ALTER TABLE migration_stage
      ADD CONSTRAINT chk_migration_stage_stage CHECK (stage IN ('staging', 'dry_run'));
  END IF;
END $$;

-- Story 13.2 (FR-DM-02): document-domain verification state. `stage` keeps its 13.1 meaning and
-- document domains never promote (they stay 'staging'); verification is derived, not flagged:
-- a domain is `verified` iff verified_run_id = latest_run_id AND that run's load_id =
-- latest_load_id (src/read/projections/migration_domain_verification.ts, the ONE derivation
-- Story 13.3 imports). A new manifest load or a new run after sign-off makes it `unverified`.
ALTER TABLE migration_stage ADD COLUMN IF NOT EXISTS latest_load_id UUID;
ALTER TABLE migration_stage ADD COLUMN IF NOT EXISTS latest_run_id UUID;
ALTER TABLE migration_stage ADD COLUMN IF NOT EXISTS verified_run_id UUID;
ALTER TABLE migration_stage ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE migration_stage ADD COLUMN IF NOT EXISTS verified_event_id UUID;
ALTER TABLE migration_stage ADD COLUMN IF NOT EXISTS verified_by_actor_id UUID;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON migration_stage TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON migration_stage TO readonly_user;
  END IF;
END $$;
