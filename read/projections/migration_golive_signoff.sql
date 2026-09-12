-- Per-site final go-live sign-offs (Story 13.3, FR-DM-03 AC 2 / AC 4; access matrix section 3.7).
-- This file is the CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate)
-- and the integration-test harness. It carries its OWN grants (guarded DO blocks).
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks).
--
-- One row per sign-off EVENT, written by the `migration.signoff.recorded` applier and never
-- updated or deleted (app_user holds INSERT and SELECT only): a sign-off is a durable attestation,
-- and a mistaken one is corrected by the audit trail, not by editing the record. `signoff_type` is
-- 'department_head_final' ("Sign off domain balances: A") or 'finance_final' ("Final go-live
-- financial sign-off: A"). The EFFECTIVE sign-off of a type is the latest row (occurred_at, then
-- created_at); an earlier row is superseded, never deleted. A new row of a type is admitted only
-- when the effective one is STALE - it predates the site's latest migration load or ERP snapshot
-- (code review 2026-09-12, decision 2) - so the attestation always describes the data that is
-- actually being released. The go-live gate (evaluateGoLiveGate) requires BOTH effective rows to
-- exist and be fresh before it reads the opening-stock variances; migration_golive_status holds
-- the unblock itself.

CREATE TABLE IF NOT EXISTS migration_golive_signoff (
  site_id                UUID NOT NULL,
  signoff_type           TEXT NOT NULL,
  signed_off_by_actor_id UUID NOT NULL,
  signed_off_role        TEXT NOT NULL,
  source_event_id        UUID NOT NULL,
  occurred_at            TIMESTAMPTZ NOT NULL,
  business_date          DATE NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_migration_golive_signoff PRIMARY KEY (site_id, signoff_type, source_event_id),
  CONSTRAINT chk_migration_golive_signoff_type CHECK (signoff_type IN ('department_head_final', 'finance_final'))
);

-- Code review 2026-09-12: the first cut keyed the table on (site_id, signoff_type), which made a
-- stale attestation permanent. Widen an existing two-column key in place (no deployed database
-- carries rows yet; the guard is for local and test databases created from the first cut).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pk_migration_golive_signoff'
      AND conrelid = 'migration_golive_signoff'::regclass
      AND array_length(conkey, 1) = 2
  ) THEN
    ALTER TABLE migration_golive_signoff DROP CONSTRAINT pk_migration_golive_signoff;
    ALTER TABLE migration_golive_signoff
      ADD CONSTRAINT pk_migration_golive_signoff PRIMARY KEY (site_id, signoff_type, source_event_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_migration_golive_signoff_type'
      AND conrelid = 'migration_golive_signoff'::regclass
  ) THEN
    ALTER TABLE migration_golive_signoff
      ADD CONSTRAINT chk_migration_golive_signoff_type CHECK (signoff_type IN ('department_head_final', 'finance_final'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON migration_golive_signoff TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON migration_golive_signoff TO readonly_user;
  END IF;
END $$;
