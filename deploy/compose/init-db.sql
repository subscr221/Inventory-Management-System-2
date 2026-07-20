CREATE USER app_user WITH PASSWORD 'app_password';
CREATE USER readonly_user WITH PASSWORD 'readonly_password';
CREATE USER replication_user WITH REPLICATION PASSWORD 'replication_password';

CREATE TABLE IF NOT EXISTS domain_events (
  event_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_type     TEXT NOT NULL,
  stream_id       UUID NOT NULL,
  event_type      TEXT NOT NULL,
  event_version   INTEGER NOT NULL,
  payload         JSONB NOT NULL,
  metadata        JSONB NOT NULL,
  schema_version  INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_stream_version UNIQUE (stream_id, event_version),
  CONSTRAINT uq_idempotency UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_domain_events_stream ON domain_events (stream_type, stream_id, event_version);
CREATE INDEX IF NOT EXISTS idx_domain_events_type ON domain_events (event_type);
CREATE INDEX IF NOT EXISTS idx_domain_events_created ON domain_events (created_at);

GRANT INSERT, SELECT ON domain_events TO app_user;
GRANT SELECT ON domain_events TO readonly_user;

CREATE PUBLICATION powersync_publication FOR TABLE domain_events;

-- The users / user_role_assignments table definitions below MUST stay identical to the canonical
-- source in read/projections/users.sql (applied by src/events/migrate.ts and the test harness).
-- This file additionally issues the app_user / readonly_user grants that the migrate path does not
-- need (migrate runs as an admin role). Change both files together.
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

GRANT INSERT, SELECT, UPDATE ON users TO app_user;
GRANT INSERT, SELECT, DELETE ON user_role_assignments TO app_user;
GRANT SELECT ON users TO readonly_user;
GRANT SELECT ON user_role_assignments TO readonly_user;


-- ---------------------------------------------------------------------------
-- Statutory edit log (Story 1.3). The section below MUST stay identical to the canonical
-- read/projections/audit_log.sql (applied by src/events/migrate.ts and the test harness);
-- that file is the source of truth for tables, triggers, AND grants. Change both together.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  log_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Monotonic, system-assigned sequence for append-order verification.
  -- GENERATED ALWAYS (not BIGSERIAL) so an INSERT cannot forge or override the value.
  -- NOTE: identity sequences legitimately skip values on transaction rollback and crash
  -- recovery (up to the sequence cache size), so a seq_no gap is NOT by itself evidence of
  -- tampering - it may be a benign skip. Tamper evidence rests on range_digest plus the
  -- DB-level immutability triggers below; seq_no provides ordering and gap OBSERVATION only.
  seq_no            BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  trace_id          TEXT NOT NULL,
  user_id           UUID NOT NULL,
  role              TEXT NOT NULL,
  location_id       TEXT NOT NULL,
  timestamp         TIMESTAMPTZ NOT NULL DEFAULT now(),
  endpoint          TEXT NOT NULL,
  method            TEXT NOT NULL CHECK (method IN ('GET','POST','PUT','PATCH','DELETE')),
  event_id          UUID,
  http_status       INT,
  error_code        TEXT,
  details           JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The archived marker lives in audit_log_archive (row presence = archived); an archived column
-- on audit_log itself would be unsettable dead state since every UPDATE is trigger-rejected.
ALTER TABLE audit_log DROP COLUMN IF EXISTS archived;

CREATE TABLE IF NOT EXISTS audit_log_archive (
  archive_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_log_id   UUID NOT NULL,
  archive_path      TEXT NOT NULL,
  archived_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One archive marker per log row: lets concurrent/re-run archival use ON CONFLICT DO NOTHING
-- instead of silently double-counting (archived_entries_count JOINs this table).
-- REMEDIATION NOTE for databases that ran the pre-2026-07-18 archival CLI: the old race could
-- leave duplicate original_log_id markers, which make this CREATE UNIQUE INDEX fail on first
-- apply. Dedupe manually first (superuser, triggers disabled): keep the earliest marker per
-- original_log_id, delete the rest, then re-apply this file.
CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_log_archive_original ON audit_log_archive (original_log_id);

CREATE TABLE IF NOT EXISTS audit_log_tamper_attempt_log (
  attempt_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp         TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id           UUID,
  role              TEXT,
  location_id       TEXT,
  endpoint          TEXT,
  method            TEXT,
  error_code        TEXT NOT NULL,
  details           JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_timestamp ON audit_log (user_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_trace_id ON audit_log (trace_id);
-- Supports the auditor query's date-range scan when no user_id filter is supplied
-- (idx_audit_log_user_timestamp cannot serve a timestamp-only predicate).
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log (timestamp);

CREATE INDEX IF NOT EXISTS idx_audit_log_tamper_created_at ON audit_log_tamper_attempt_log (created_at DESC);

-- ---------------------------------------------------------------------------
-- Tamper protection (AC2). The triggers below reject UPDATE/DELETE/TRUNCATE on the audit tables
-- for EVERY role, including administrators, over any connection.
--
-- DURABLE RECORD OF DIRECT-DB TAMPER ATTEMPTS: the RAISE EXCEPTION below aborts the attacker's
-- transaction, which necessarily also rolls back any row this trigger could insert into
-- audit_log_tamper_attempt_log - an in-band tamper row is architecturally impossible here. The
-- durable record is the PostgreSQL SERVER ERROR LOG: every raise is written there with the
-- AUDIT_LOG_TAMPER_ATTEMPT marker, session user, database, timestamp, and offending statement.
-- Operations requirement: server log retention must meet the audit-trail retention policy.
-- (Decision 2026-07-18: server-log mechanism chosen over dblink autonomous transactions.)
-- API-layer tamper attempts ARE additionally recorded in audit_log_tamper_attempt_log by the
-- application (see src/api/v1/config.ts and src/middleware/audit-tamper-guard.ts).
-- ---------------------------------------------------------------------------

-- Attribution is embedded in the RAISE message itself (session_user, database) so the server-log
-- record identifies the actor even under the default log_line_prefix ('%m [%p] '), which logs
-- neither. The compose postgres command additionally sets an attributing log_line_prefix.
CREATE OR REPLACE FUNCTION audit_log_tamper_protection()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_LOG_TAMPER_ATTEMPT: Modification of audit log is forbidden (user=%, db=%)', session_user, current_database();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER audit_log_tamper_protection
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW
EXECUTE FUNCTION audit_log_tamper_protection();

CREATE OR REPLACE FUNCTION audit_log_tamper_attempt_protection()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_LOG_TAMPER_ATTEMPT: Modification of tamper attempt log is forbidden (user=%, db=%)', session_user, current_database();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER audit_log_tamper_attempt_protection
BEFORE UPDATE OR DELETE ON audit_log_tamper_attempt_log
FOR EACH ROW
EXECUTE FUNCTION audit_log_tamper_attempt_protection();

-- Archive markers are part of the statutory retention provenance chain (they map hot rows to
-- export files); protect them from silent alteration the same way.
CREATE OR REPLACE FUNCTION audit_log_archive_tamper_protection()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_LOG_TAMPER_ATTEMPT: Modification of audit log archive markers is forbidden (user=%, db=%)', session_user, current_database();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER audit_log_archive_tamper_protection
BEFORE UPDATE OR DELETE ON audit_log_archive
FOR EACH ROW
EXECUTE FUNCTION audit_log_archive_tamper_protection();

-- TRUNCATE does not fire row-level triggers, so it needs a statement-level guard. Unconditional:
-- a single-row DELETE and a full TRUNCATE are the same statutory violation, whoever issues them.
-- Maintenance that must legitimately reset these tables (test-harness cleanup, disaster recovery)
-- uses the explicit, superuser-only escape hatch: ALTER TABLE ... DISABLE TRIGGER ALL, which is
-- itself visible in the server log.
CREATE OR REPLACE FUNCTION audit_log_truncate_protection()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_LOG_TAMPER_ATTEMPT: Truncation of audit log is forbidden (user=%, db=%)', session_user, current_database();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER audit_log_truncate_protection
BEFORE TRUNCATE ON audit_log
FOR EACH STATEMENT
EXECUTE FUNCTION audit_log_truncate_protection();

CREATE OR REPLACE TRIGGER audit_log_tamper_attempt_truncate_protection
BEFORE TRUNCATE ON audit_log_tamper_attempt_log
FOR EACH STATEMENT
EXECUTE FUNCTION audit_log_truncate_protection();

CREATE OR REPLACE TRIGGER audit_log_archive_truncate_protection
BEFORE TRUNCATE ON audit_log_archive
FOR EACH STATEMENT
EXECUTE FUNCTION audit_log_truncate_protection();

-- ---------------------------------------------------------------------------
-- Grants. Guarded so this file also applies cleanly on databases where the runtime roles are
-- provisioned separately (the roles themselves are created by deploy/compose/init-db.sql or the
-- environment's own provisioning).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON audit_log TO app_user;
    GRANT INSERT, SELECT ON audit_log_archive TO app_user;
    GRANT INSERT, SELECT ON audit_log_tamper_attempt_log TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON audit_log TO readonly_user;
    GRANT SELECT ON audit_log_archive TO readonly_user;
    GRANT SELECT ON audit_log_tamper_attempt_log TO readonly_user;
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- Enterprise DOA registry (Story 1.4). The section below MUST stay identical to the canonical
-- read/projections/doa_registry.sql (applied by src/events/migrate.ts and the test harness);
-- that file is the source of truth for tables, indexes, AND grants. Change both together.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doa_registry_entries (
  entry_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role              TEXT NOT NULL,
  transaction_type  TEXT NOT NULL,
  -- value_min is an EXCLUSIVE lower bound, value_max an INCLUSIVE upper bound; NULL = unbounded.
  value_min         NUMERIC,
  value_max         NUMERIC,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_doa_registry_entries_value_band
    CHECK (value_min IS NULL OR value_max IS NULL OR value_min < value_max)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_doa_registry_entries_value_band'
      AND conrelid = 'doa_registry_entries'::regclass
  ) THEN
    ALTER TABLE doa_registry_entries
      ADD CONSTRAINT chk_doa_registry_entries_value_band
      CHECK (value_min IS NULL OR value_max IS NULL OR value_min < value_max);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS doa_vacation_delegations (
  delegation_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delegator_user_id UUID NOT NULL REFERENCES users(user_id),
  delegate_user_id  UUID NOT NULL REFERENCES users(user_id),
  start_date        DATE NOT NULL,
  end_date          DATE NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_doa_registry_entries_lookup ON doa_registry_entries (transaction_type, active);
CREATE INDEX IF NOT EXISTS idx_doa_vacation_delegations_delegator ON doa_vacation_delegations (delegator_user_id, active, start_date, end_date);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON doa_registry_entries TO app_user;
    GRANT INSERT, SELECT ON doa_vacation_delegations TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON doa_registry_entries TO readonly_user;
    GRANT SELECT ON doa_vacation_delegations TO readonly_user;
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- Business-stream tagging configuration (Story 1.5). The section below MUST stay identical to
-- the canonical read/projections/business_stream_config.sql (applied by src/events/migrate.ts
-- and the test harness); that file is the source of truth for tables, seeds, indexes, AND
-- grants. Change both together.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_streams (
  stream_code   TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO business_streams (stream_code, display_name) VALUES
  ('production', 'Production'),
  ('research',   'R&D'),
  ('maker_hub',  'Maker-Hub'),
  ('job_work',   'Job-Work')
ON CONFLICT (stream_code) DO NOTHING;

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

CREATE INDEX IF NOT EXISTS idx_transaction_tagging_rules_lookup
  ON transaction_tagging_rules (transaction_type, effective_from);

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


-- ---------------------------------------------------------------------------
-- Event-sourced location schema (Story 1.6). The section below MUST stay identical to
-- the canonical read/projections/location.sql (applied by src/events/migrate.ts and the
-- test harness); that file is the source of truth for tables, indexes, AND grants.
-- Change both together.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS location_asserted_facts (
  fact_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id             UUID NOT NULL,
  asserted_location  TEXT NOT NULL,
  recorded_by        UUID NOT NULL,
  device_id          TEXT,
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  confidence         TEXT NOT NULL DEFAULT 'none',
  source_event_id    UUID NOT NULL,
  source_event_version INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT uq_location_asserted_lot UNIQUE (lot_id)
);

CREATE TABLE IF NOT EXISTS location_expected_facts (
  fact_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id             UUID NOT NULL,
  expected_location  TEXT NOT NULL,
  source             TEXT NOT NULL,
  source_event_id    UUID NOT NULL,
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_location_expected_lot UNIQUE (lot_id)
);

CREATE TABLE IF NOT EXISTS location_current (
  lot_id            UUID PRIMARY KEY,
  location          TEXT,
  confidence        TEXT NOT NULL DEFAULT 'none',
  asserted_fact_id  UUID,
  source_event_version INTEGER NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS location_asserted_facts
  ADD COLUMN IF NOT EXISTS source_event_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE IF EXISTS location_current
  ADD COLUMN IF NOT EXISTS source_event_version INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_location_asserted_confidence'
      AND conrelid = 'location_asserted_facts'::regclass
  ) THEN
    ALTER TABLE location_asserted_facts
      ADD CONSTRAINT chk_location_asserted_confidence CHECK (confidence IN ('none', 'low', 'certain'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_location_current_confidence'
      AND conrelid = 'location_current'::regclass
  ) THEN
    ALTER TABLE location_current
      ADD CONSTRAINT chk_location_current_confidence CHECK (confidence IN ('none', 'low', 'certain'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_location_asserted_lot ON location_asserted_facts (lot_id);
CREATE INDEX IF NOT EXISTS idx_location_expected_lot ON location_expected_facts (lot_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON location_asserted_facts TO app_user;
    GRANT INSERT, SELECT, UPDATE ON location_expected_facts TO app_user;
    GRANT INSERT, SELECT, UPDATE ON location_current TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON location_asserted_facts TO readonly_user;
    GRANT SELECT ON location_expected_facts TO readonly_user;
    GRANT SELECT ON location_current TO readonly_user;
  END IF;
END $$;


-- Story 1.7: Calibration lockout enforcement.
CREATE TABLE IF NOT EXISTS instrument_calibration_statuses (
  instrument_uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id TEXT NOT NULL UNIQUE,
  calibration_status TEXT NOT NULL,
  status_event_id UUID,
  status_event_version INTEGER,
  status_changed_by UUID NOT NULL,
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_instrument_calibration_status CHECK (calibration_status IN ('calibrated', 'out_of_calibration'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_instrument_calibration_status'
      AND conrelid = 'instrument_calibration_statuses'::regclass
  ) THEN
    ALTER TABLE instrument_calibration_statuses
      ADD CONSTRAINT chk_instrument_calibration_status CHECK (calibration_status IN ('calibrated', 'out_of_calibration'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_instrument_calibration_statuses_instrument_id ON instrument_calibration_statuses (instrument_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON instrument_calibration_statuses TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON instrument_calibration_statuses TO readonly_user;
  END IF;
END $$;
