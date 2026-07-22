-- CI-only role provisioning for a bare `postgres:18.4` service container.
--
-- GitHub Actions service containers do not mount `docker-entrypoint-initdb.d/`, so the roles
-- deploy/compose/init-db.sql creates via that mechanism (app_user, readonly_user,
-- replication_user, svc_powersync) do not exist yet when a CI job's postgres service starts.
-- This file creates exactly those roles, idempotently, so `npm run db:migrate` and the test
-- harness can run against a CI postgres service the same way they run against the Compose
-- stack. It intentionally does NOT create any tables - `npm run db:migrate` remains the single
-- source of truth for schema (Story 1.10 Task 2.3: no new migration framework).
--
-- Passwords match .env.test / deploy/compose/init-db.sql exactly; this file is CI-only and is
-- never applied to a staging or production database.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE USER app_user WITH PASSWORD 'app_password';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'readonly_user') THEN
    CREATE USER readonly_user WITH PASSWORD 'readonly_password';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'replication_user') THEN
    CREATE USER replication_user WITH REPLICATION PASSWORD 'replication_password';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_powersync') THEN
    CREATE USER svc_powersync WITH REPLICATION PASSWORD 'svc_powersync_password';
  END IF;
END $$;
