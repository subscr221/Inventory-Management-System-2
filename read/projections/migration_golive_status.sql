-- Per-site go-live unblock record (Story 13.3, FR-DM-03 AC 4, SM-48). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks). deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks).
--
-- A row exists iff the `migration.golive.unblocked` applier accepted the gate for the site: both
-- effective final sign-offs recorded and fresh (migration_golive_signoff), zero unexplained
-- opening-stock variances, opening stock promoted, and every document domain in the wave verified
-- at the moment of unblock (code review 2026-09-12, decision 2 widened the gate from the first
-- two checks). The row is the durable record auditors check; it is written once and
-- never updated or deleted (app_user holds INSERT and SELECT only). Nothing else in the system
-- reads this flag yet (Story 13.1 Open Question 1): activating transactional posting on the
-- strength of it is a later story's integration, not this table's job.

CREATE TABLE IF NOT EXISTS migration_golive_status (
  site_id                          UUID NOT NULL,
  unblocked_at                     TIMESTAMPTZ NOT NULL,
  unblocked_event_id               UUID NOT NULL,
  unblocked_by_actor_id            UUID NOT NULL,
  unblocked_by_role                TEXT NOT NULL,
  department_head_signoff_event_id UUID NOT NULL,
  finance_signoff_event_id         UUID NOT NULL,
  business_date                    DATE NOT NULL,
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_migration_golive_status PRIMARY KEY (site_id)
);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON migration_golive_status TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON migration_golive_status TO readonly_user;
  END IF;
END $$;
