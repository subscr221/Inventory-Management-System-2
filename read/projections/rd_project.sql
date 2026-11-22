-- R&D project master (Story 10.1, FR-RD-03). Canonical definition, applied by
-- src/events/migrate.ts and the integration-test harness. Idempotent; carries its own grants.
-- A project code is required (and must be active) on every R&D material issue.

CREATE TABLE IF NOT EXISTS rd_project (
  project_code   TEXT PRIMARY KEY,
  owner_user_id  UUID NOT NULL,
  phase          TEXT NOT NULL,
  budget_amount  NUMERIC(18,2) NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rd_project_phase CHECK (phase IN ('research', 'development')),
  CONSTRAINT chk_rd_project_budget CHECK (budget_amount >= 0),
  CONSTRAINT chk_rd_project_status CHECK (status IN ('active', 'on_hold', 'closed'))
);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON rd_project TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON rd_project TO readonly_user;
  END IF;
END $$;
