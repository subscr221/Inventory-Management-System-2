-- Canonical source for the users / user_role_assignments schema. deploy/compose/init-db.sql
-- mirrors these table definitions (plus grants) for first-time cluster init; keep the two in sync.
CREATE TABLE IF NOT EXISTS users (
  user_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id      TEXT NOT NULL UNIQUE,
  email            TEXT NOT NULL,
  display_name     TEXT,
  active           BOOLEAN NOT NULL DEFAULT true,
  provisioned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deprovisioned_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS user_role_assignments (
  assignment_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(user_id),
  role           TEXT NOT NULL,
  module         TEXT NOT NULL,
  function_scope TEXT NOT NULL CHECK (function_scope IN ('read', 'write')),
  location_id    TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_role_assignments_user ON user_role_assignments (user_id);
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON users TO app_user;
    GRANT INSERT, SELECT, DELETE ON user_role_assignments TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON users TO readonly_user;
    GRANT SELECT ON user_role_assignments TO readonly_user;
  END IF;
END $$;
