-- Business-stream tagging configuration schema (Story 1.5). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve tagging-config reads/writes as app_user without depending on deploy/compose/init-db.sql -
-- the split-brain class of bug logged for read/projections/users.sql (deferred-work.md) is
-- deliberately avoided here. deploy/compose/init-db.sql duplicates this content for first-boot
-- container init - change both files together. Every statement is idempotent (IF NOT EXISTS /
-- ON CONFLICT DO NOTHING / guarded DO blocks) so the file can be re-applied to a live database.

-- The closed pilot vocabulary of business streams (FR-AC-01). Reporting by stream (production,
-- R&D, maker-hub, job-work) is accurate by construction because every inventory movement event
-- must carry one of these codes. Adding a stream is a config insert, not a code change (NFR-E-03).
CREATE TABLE IF NOT EXISTS business_streams (
  stream_code   TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the four pilot streams (Epic 1 goal statement). ON CONFLICT keeps re-application safe.
INSERT INTO business_streams (stream_code, display_name) VALUES
  ('production', 'Production'),
  ('research',   'R&D'),
  ('maker_hub',  'Maker-Hub'),
  ('job_work',   'Job-Work')
ON CONFLICT (stream_code) DO NOTHING;

-- Dated tagging-applicability configuration (FR-AC-01: "applicability is dated configuration,
-- not code"). A rule says: events of this transaction_type (the envelope event_type) require a
-- cost_centre and/or project_code tag while the rule's date range is effective. effective_to NULL
-- means open-ended. Overlapping ranges for the same transaction_type are rejected at write time
-- by the application (409 TAGGING_RULE_CONFLICT); the UNIQUE constraint below is a backstop for
-- the exact-same-start-date case only.
CREATE TABLE IF NOT EXISTS transaction_tagging_rules (
  rule_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_type      TEXT NOT NULL,
  cost_centre_required  BOOLEAN NOT NULL DEFAULT false,
  project_code_required BOOLEAN NOT NULL DEFAULT false,
  effective_from        DATE NOT NULL,
  effective_to          DATE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_transaction_tagging_rules_type_from UNIQUE (transaction_type, effective_from)
);

-- Resolution reads filter by transaction_type then apply the date-range predicate.
CREATE INDEX IF NOT EXISTS idx_transaction_tagging_rules_lookup
  ON transaction_tagging_rules (transaction_type, effective_from);

-- ---------------------------------------------------------------------------
-- Grants. Guarded so this file also applies cleanly on databases where the runtime roles are
-- provisioned separately (the roles themselves are created by deploy/compose/init-db.sql or the
-- environment's own provisioning). business_streams is read-only for the app in this story (the
-- vocabulary is seeded by migration); transaction_tagging_rules gets INSERT for the admin
-- rule-creation endpoint. No UPDATE/DELETE grants: rules are dated configuration - corrections
-- are new rules with a new effective_from, never mutations (see Story 1.5 Task 3.4).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT ON business_streams TO app_user;
    GRANT INSERT, SELECT ON transaction_tagging_rules TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON business_streams TO readonly_user;
    GRANT SELECT ON transaction_tagging_rules TO readonly_user;
  END IF;
END $$;
