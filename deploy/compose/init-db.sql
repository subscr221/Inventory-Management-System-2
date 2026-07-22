CREATE USER app_user WITH PASSWORD 'app_password';
CREATE USER readonly_user WITH PASSWORD 'readonly_password';
CREATE USER replication_user WITH REPLICATION PASSWORD 'replication_password';
-- REPLICATION is required for PowerSync's logical-replication (pgoutput) source connection,
-- separate from the SELECT grant below (which alone is insufficient for CDC streaming).
CREATE USER svc_powersync WITH REPLICATION PASSWORD 'svc_powersync_password';

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
GRANT SELECT ON domain_events TO svc_powersync;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'powersync_publication') THEN
    CREATE PUBLICATION powersync_publication FOR TABLE domain_events;
  END IF;
END $$;


-- -----------------------------------------------------------------------------------------------
-- Transfer request (Story 2.5). The section below MUST stay identical to the canonical
-- read/projections/transfer_request.sql (applied by src/events/migrate.ts and the
-- integration-test harness); that file is the source of truth for tables, indexes, AND grants.
-- Change both files together.
-- -----------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS transfer_request (
  transfer_request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id              TEXT NOT NULL,
  quantity            NUMERIC(18, 6) NOT NULL,
  from_location_id    UUID NOT NULL,
  to_location_id      UUID NOT NULL,
  lot_id              TEXT,
  serial_ids          TEXT[],
  business_stream     TEXT NOT NULL,
  notes               TEXT,
  status              TEXT NOT NULL DEFAULT 'pending_approval',
  approver_actor_id   UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  shipped_at          TIMESTAMPTZ,
  received_at         TIMESTAMPTZ,
  correlation_id      UUID
);

CREATE INDEX IF NOT EXISTS idx_transfer_request_status ON transfer_request (status);
CREATE INDEX IF NOT EXISTS idx_transfer_request_sku ON transfer_request (sku_id);
CREATE INDEX IF NOT EXISTS idx_transfer_request_from_loc ON transfer_request (from_location_id);
CREATE INDEX IF NOT EXISTS idx_transfer_request_to_loc ON transfer_request (to_location_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON transfer_request TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON transfer_request TO readonly_user;
  END IF;
END $$;


-- In-transit projection (Story 2.5). The section below MUST stay identical to the canonical
-- read/projections/in_transit.sql (applied by src/events/migrate.ts and the
-- integration-test harness); that file is the source of truth for tables, indexes, AND grants.
-- Change both files together.
-- -----------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS in_transit (
  sku_id                TEXT NOT NULL,
  location_from         UUID NOT NULL,
  location_to           UUID NOT NULL,
  lot_id                TEXT,
  quantity              NUMERIC(18, 6) NOT NULL,
  transfer_request_id   UUID NOT NULL,
  correlation_id        UUID,
  ship_event_id         UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_in_transit_sku ON in_transit (sku_id);
CREATE INDEX IF NOT EXISTS idx_in_transit_from ON in_transit (location_from);
CREATE INDEX IF NOT EXISTS idx_in_transit_to ON in_transit (location_to);
CREATE INDEX IF NOT EXISTS idx_in_transit_lot ON in_transit (lot_id);
CREATE INDEX IF NOT EXISTS idx_in_transit_request ON in_transit (transfer_request_id);

-- One in-transit row per transfer request (Story 2.5 review): guards against concurrent
-- double-ship inserting two rows for the same transfer.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_in_transit_transfer_request'
      AND conrelid = 'in_transit'::regclass
  ) THEN
    ALTER TABLE in_transit ADD CONSTRAINT uq_in_transit_transfer_request UNIQUE (transfer_request_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE, DELETE ON in_transit TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON in_transit TO readonly_user;
  END IF;
END $$;

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


-- ---------------------------------------------------------------------------
-- Notification and Alerting Foundation (Story 1.11). The section below MUST stay identical to
-- the canonical read/projections/notification.sql (applied by src/events/migrate.ts and the
-- test harness); that file is the source of truth for tables, indexes, AND grants.
-- Change both together.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  notification_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_event_id       UUID NOT NULL,
  target_user_id        UUID NOT NULL REFERENCES users(user_id),
  target_role           TEXT NOT NULL,
  target_location_id    UUID,
  event_type            TEXT NOT NULL,
  status_verb            TEXT NOT NULL,
  object_type            TEXT NOT NULL,
  object_id              TEXT NOT NULL,
  actor_label            TEXT,
  next_step              TEXT,
  status                 TEXT NOT NULL DEFAULT 'created',
  occurred_at            TIMESTAMPTZ NOT NULL,
  read_at                TIMESTAMPTZ,
  acted_upon_at          TIMESTAMPTZ,
  expired_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_notifications_event_user UNIQUE (source_event_id, target_user_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_notifications_status'
      AND conrelid = 'notifications'::regclass
  ) THEN
    ALTER TABLE notifications
      ADD CONSTRAINT chk_notifications_status CHECK (status IN ('created', 'read', 'acted_upon', 'expired'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notifications_target_user ON notifications (target_user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_event_type ON notifications (target_user_id, event_type);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  delivery_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id   UUID NOT NULL REFERENCES notifications(notification_id),
  channel           TEXT NOT NULL,
  outcome           TEXT NOT NULL,
  trace_id          TEXT NOT NULL,
  failure_reason    TEXT,
  delivered_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_notification_deliveries_channel'
      AND conrelid = 'notification_deliveries'::regclass
  ) THEN
    ALTER TABLE notification_deliveries
      ADD CONSTRAINT chk_notification_deliveries_channel CHECK (channel IN ('in_app', 'web_push'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_notification_deliveries_outcome'
      AND conrelid = 'notification_deliveries'::regclass
  ) THEN
    ALTER TABLE notification_deliveries
      ADD CONSTRAINT chk_notification_deliveries_outcome CHECK (outcome IN ('delivered', 'failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_notification ON notification_deliveries (notification_id);

CREATE TABLE IF NOT EXISTS notification_dispatch_log (
  source_event_id   UUID PRIMARY KEY,
  dispatched_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_dispatch_attempts (
  source_event_id   UUID PRIMARY KEY,
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  dead              BOOLEAN NOT NULL DEFAULT false,
  last_error        TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_escalation_defs (
  source_event_id                UUID PRIMARY KEY,
  origin_target_role             TEXT NOT NULL,
  escalation_target_role        TEXT NOT NULL,
  acknowledgment_window_seconds INTEGER NOT NULL,
  deadline_at                   TIMESTAMPTZ NOT NULL,
  resolved                      BOOLEAN NOT NULL DEFAULT false,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_notification_escalation_defs_window'
      AND conrelid = 'notification_escalation_defs'::regclass
  ) THEN
    ALTER TABLE notification_escalation_defs
      ADD CONSTRAINT chk_notification_escalation_defs_window CHECK (acknowledgment_window_seconds > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notification_escalation_defs_due
  ON notification_escalation_defs (deadline_at)
  WHERE resolved = false;

CREATE TABLE IF NOT EXISTS notification_escalations (
  escalation_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_event_id           UUID NOT NULL,
  from_target                TEXT NOT NULL,
  to_target                  TEXT NOT NULL,
  resolved_via                TEXT NOT NULL,
  escalated_source_event_id UUID,
  escalated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_escalations_source_event ON notification_escalations (source_event_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  subscription_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(user_id),
  endpoint          TEXT NOT NULL,
  p256dh            TEXT NOT NULL,
  auth              TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_push_subscriptions_user_endpoint UNIQUE (user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id       UUID NOT NULL REFERENCES users(user_id),
  event_type    TEXT NOT NULL,
  opted_in      BOOLEAN NOT NULL DEFAULT false,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_type)
);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON notifications TO app_user;
    GRANT INSERT, SELECT ON notification_deliveries TO app_user;
    GRANT INSERT, SELECT ON notification_dispatch_log TO app_user;
    GRANT INSERT, SELECT, UPDATE, DELETE ON notification_dispatch_attempts TO app_user;
    GRANT INSERT, SELECT, UPDATE ON notification_escalation_defs TO app_user;
    GRANT INSERT, SELECT ON notification_escalations TO app_user;
    GRANT INSERT, SELECT, UPDATE, DELETE ON push_subscriptions TO app_user;
    GRANT INSERT, SELECT, UPDATE ON notification_preferences TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON notifications TO readonly_user;
    GRANT SELECT ON notification_deliveries TO readonly_user;
    GRANT SELECT ON notification_dispatch_log TO readonly_user;
    GRANT SELECT ON notification_dispatch_attempts TO readonly_user;
    GRANT SELECT ON notification_escalation_defs TO readonly_user;
    GRANT SELECT ON notification_escalations TO readonly_user;
    GRANT SELECT ON push_subscriptions TO readonly_user;
    GRANT SELECT ON notification_preferences TO readonly_user;
  END IF;
END $$;

-- -------------------------------------------------------------------------------------------
-- Item master (Story 2.1). The section below MUST stay identical to the canonical
-- read/projections/item_master.sql (applied by src/events/migrate.ts and the integration-test
-- harness) - change both files together.
-- -------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS item_master (
  item_id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                         TEXT NOT NULL,
  uom                         TEXT NOT NULL,
  lot_controlled              BOOLEAN NOT NULL DEFAULT false,
  serial_controlled           BOOLEAN NOT NULL DEFAULT false,
  hazmat                      BOOLEAN NOT NULL DEFAULT false,
  quarantine_required         BOOLEAN NOT NULL DEFAULT false,
  bis_licence_required        BOOLEAN NOT NULL DEFAULT false,
  valuation_method            TEXT NOT NULL,
  business_stream             TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'active',
  -- Story 2.4: standard cost is NOT a fourth valuation_method - it is an Ind AS 2 paragraph 21
  -- measurement technique layered on top of the actual valuation_method above. It is only
  -- effective once standard_cost_designation carries the exact literal below (enforced by
  -- chk_item_master_standard_cost_designation and re-checked in src/api/v1/items.ts).
  standard_cost_designation   TEXT,
  standard_cost_amount        NUMERIC(18, 6),
  variance_review_cadence     TEXT,
  variance_tolerance_percent  NUMERIC(7, 4),
  count_variance_tolerance_percent NUMERIC(7, 4),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_item_master_sku UNIQUE (sku),
  CONSTRAINT chk_item_master_valuation_method CHECK (valuation_method IN ('fifo', 'weighted_average', 'specific_identification')),
  CONSTRAINT chk_item_master_status CHECK (status IN ('active', 'inactive')),
  CONSTRAINT chk_item_master_standard_cost_designation CHECK (
    standard_cost_designation IS NULL OR standard_cost_designation = 'ind_as_2_para_21_measurement_technique'
  ),
  CONSTRAINT chk_item_master_standard_cost_requires_designation CHECK (
    standard_cost_amount IS NULL OR standard_cost_designation = 'ind_as_2_para_21_measurement_technique'
  ),
  CONSTRAINT chk_item_master_standard_cost_amount_non_negative CHECK (standard_cost_amount IS NULL OR standard_cost_amount >= 0),
  CONSTRAINT chk_item_master_variance_tolerance_percent CHECK (
    variance_tolerance_percent IS NULL OR (variance_tolerance_percent >= 0 AND variance_tolerance_percent <= 100)
  ),
  CONSTRAINT chk_item_master_count_variance_tolerance_percent CHECK (
    count_variance_tolerance_percent IS NULL OR (count_variance_tolerance_percent >= 0 AND count_variance_tolerance_percent <= 100)
  )
);

ALTER TABLE item_master ADD COLUMN IF NOT EXISTS standard_cost_designation TEXT;
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS standard_cost_amount NUMERIC(18, 6);
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS variance_review_cadence TEXT;
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS variance_tolerance_percent NUMERIC(7, 4);
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS count_variance_tolerance_percent NUMERIC(7, 4);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_item_master_valuation_method'
      AND conrelid = 'item_master'::regclass
  ) THEN
    ALTER TABLE item_master
      ADD CONSTRAINT chk_item_master_valuation_method CHECK (valuation_method IN ('fifo', 'weighted_average', 'specific_identification'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_item_master_status'
      AND conrelid = 'item_master'::regclass
  ) THEN
    ALTER TABLE item_master
      ADD CONSTRAINT chk_item_master_status CHECK (status IN ('active', 'inactive'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_item_master_standard_cost_designation'
      AND conrelid = 'item_master'::regclass
  ) THEN
    ALTER TABLE item_master
      ADD CONSTRAINT chk_item_master_standard_cost_designation CHECK (
        standard_cost_designation IS NULL OR standard_cost_designation = 'ind_as_2_para_21_measurement_technique'
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_item_master_standard_cost_requires_designation'
      AND conrelid = 'item_master'::regclass
  ) THEN
    ALTER TABLE item_master
      ADD CONSTRAINT chk_item_master_standard_cost_requires_designation CHECK (
        standard_cost_amount IS NULL OR standard_cost_designation = 'ind_as_2_para_21_measurement_technique'
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_item_master_standard_cost_amount_non_negative'
      AND conrelid = 'item_master'::regclass
  ) THEN
    ALTER TABLE item_master
      ADD CONSTRAINT chk_item_master_standard_cost_amount_non_negative CHECK (standard_cost_amount IS NULL OR standard_cost_amount >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_item_master_variance_tolerance_percent'
      AND conrelid = 'item_master'::regclass
  ) THEN
    ALTER TABLE item_master
      ADD CONSTRAINT chk_item_master_variance_tolerance_percent CHECK (
        variance_tolerance_percent IS NULL OR (variance_tolerance_percent >= 0 AND variance_tolerance_percent <= 100)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_item_master_count_variance_tolerance_percent'
      AND conrelid = 'item_master'::regclass
  ) THEN
    ALTER TABLE item_master
      ADD CONSTRAINT chk_item_master_count_variance_tolerance_percent CHECK (
        count_variance_tolerance_percent IS NULL OR (count_variance_tolerance_percent >= 0 AND count_variance_tolerance_percent <= 100)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON item_master TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON item_master TO readonly_user;
  END IF;
END $$;

-- -------------------------------------------------------------------------------------------
-- Location register (Story 2.1). The section below MUST stay identical to the canonical
-- read/projections/location_register.sql (applied by src/events/migrate.ts and the
-- integration-test harness) - change both files together.
-- -------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS location_register (
  location_id        UUID PRIMARY KEY,
  location_code      TEXT NOT NULL,
  level              TEXT NOT NULL,
  parent_location_id UUID REFERENCES location_register(location_id),
  site_id            UUID NOT NULL,
  zone_type          TEXT NOT NULL DEFAULT 'general',
  temperature_class  TEXT NOT NULL DEFAULT 'ambient',
  size_class         TEXT NOT NULL DEFAULT 'standard',
  hazmat_allowed     BOOLEAN NOT NULL DEFAULT false,
  quarantine         BOOLEAN NOT NULL DEFAULT false,
  access_restricted  BOOLEAN NOT NULL DEFAULT false,
  status             TEXT NOT NULL DEFAULT 'active',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_location_register_code UNIQUE (location_code),
  CONSTRAINT chk_location_register_level CHECK (level IN ('site', 'zone', 'aisle', 'rack', 'bin')),
  CONSTRAINT chk_location_register_zone_type CHECK (zone_type IN ('general', 'hazmat', 'quarantine', 'staging')),
  CONSTRAINT chk_location_register_temperature_class CHECK (temperature_class IN ('ambient', 'cold', 'frozen')),
  CONSTRAINT chk_location_register_status CHECK (status IN ('active', 'inactive'))
);

ALTER TABLE location_register ADD COLUMN IF NOT EXISTS size_class TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE location_register ADD COLUMN IF NOT EXISTS access_restricted BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_location_register_level'
      AND conrelid = 'location_register'::regclass
  ) THEN
    ALTER TABLE location_register
      ADD CONSTRAINT chk_location_register_level CHECK (level IN ('site', 'zone', 'aisle', 'rack', 'bin'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_location_register_zone_type'
      AND conrelid = 'location_register'::regclass
  ) THEN
    ALTER TABLE location_register
      ADD CONSTRAINT chk_location_register_zone_type CHECK (zone_type IN ('general', 'hazmat', 'quarantine', 'staging'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_location_register_temperature_class'
      AND conrelid = 'location_register'::regclass
  ) THEN
    ALTER TABLE location_register
      ADD CONSTRAINT chk_location_register_temperature_class CHECK (temperature_class IN ('ambient', 'cold', 'frozen'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_location_register_status'
      AND conrelid = 'location_register'::regclass
  ) THEN
    ALTER TABLE location_register
      ADD CONSTRAINT chk_location_register_status CHECK (status IN ('active', 'inactive'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_location_register_parent ON location_register (parent_location_id);
CREATE INDEX IF NOT EXISTS idx_location_register_site ON location_register (site_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON location_register TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON location_register TO readonly_user;
  END IF;
END $$;

-- -------------------------------------------------------------------------------------------
-- Stock balance (Story 2.2). The section below MUST stay identical to the canonical
-- read/projections/stock_balance.sql (applied by src/events/migrate.ts and the
-- integration-test harness) - change both files together.
-- -------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stock_balance (
  balance_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku           TEXT NOT NULL,
  location_id   UUID NOT NULL,
  location_code TEXT,
  lot_id        TEXT,
  stock_class   TEXT NOT NULL DEFAULT 'owned',
  on_hand       NUMERIC(18, 6) NOT NULL DEFAULT 0,
  allocated     NUMERIC(18, 6) NOT NULL DEFAULT 0,
  in_transit    NUMERIC(18, 6) NOT NULL DEFAULT 0,
  available     NUMERIC(18, 6) GENERATED ALWAYS AS (on_hand - allocated) STORED,
  last_issue_at TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_stock_balance_grain UNIQUE NULLS NOT DISTINCT (sku, location_id, lot_id, stock_class),
  CONSTRAINT chk_stock_balance_on_hand_non_negative CHECK (on_hand >= 0),
  CONSTRAINT chk_stock_balance_allocated_non_negative CHECK (allocated >= 0),
  CONSTRAINT chk_stock_balance_allocated_within_on_hand CHECK (allocated <= on_hand),
  CONSTRAINT chk_stock_balance_in_transit_non_negative CHECK (in_transit >= 0)
);

-- Story 2.7: last_issue_at tracks the most recent outbound consumption (stock.issued only) per
-- (sku, location_id, lot_id, stock_class); the obsolescence scan reads MAX(last_issue_at) across
-- lots at (sku, location_id). Added idempotently so a live Story 2.2 database gains the column
-- without a table rebuild. It is nullable and independent of the generated `available` column and
-- the grain, so the Story 2.2 on_hand/allocated/available/in_transit invariants are unchanged.
ALTER TABLE stock_balance ADD COLUMN IF NOT EXISTS last_issue_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_stock_balance_on_hand_non_negative'
      AND conrelid = 'stock_balance'::regclass
  ) THEN
    ALTER TABLE stock_balance
      ADD CONSTRAINT chk_stock_balance_on_hand_non_negative CHECK (on_hand >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_stock_balance_allocated_non_negative'
      AND conrelid = 'stock_balance'::regclass
  ) THEN
    ALTER TABLE stock_balance
      ADD CONSTRAINT chk_stock_balance_allocated_non_negative CHECK (allocated >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_stock_balance_allocated_within_on_hand'
      AND conrelid = 'stock_balance'::regclass
  ) THEN
    ALTER TABLE stock_balance
      ADD CONSTRAINT chk_stock_balance_allocated_within_on_hand CHECK (allocated <= on_hand);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_stock_balance_in_transit_non_negative'
      AND conrelid = 'stock_balance'::regclass
  ) THEN
    ALTER TABLE stock_balance
      ADD CONSTRAINT chk_stock_balance_in_transit_non_negative CHECK (in_transit >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_stock_balance_grain'
      AND conrelid = 'stock_balance'::regclass
  ) THEN
    ALTER TABLE stock_balance DROP CONSTRAINT uq_stock_balance_grain;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_stock_balance_grain'
      AND conrelid = 'stock_balance'::regclass
  ) THEN
    ALTER TABLE stock_balance
      ADD CONSTRAINT uq_stock_balance_grain UNIQUE NULLS NOT DISTINCT (sku, location_id, lot_id, stock_class);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON stock_balance TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON stock_balance TO readonly_user;
  END IF;
END $$;


-- -------------------------------------------------------------------------------------------
-- Lot master (Story 2.3). The section below MUST stay identical to the canonical
-- read/projections/lot_master.sql (applied by src/events/migrate.ts and the
-- integration-test harness) - change both files together.
-- -------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lot_master (
  lot_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_number           TEXT NOT NULL,
  sku                  TEXT NOT NULL,
  expiry_date          DATE,
  quality_hold_status  TEXT NOT NULL DEFAULT 'none',
  quality_hold_reason  TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_lot_master_lot_number UNIQUE (lot_number),
  CONSTRAINT chk_lot_master_quality_hold_status CHECK (quality_hold_status IN ('none', 'held'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_lot_master_lot_number'
      AND conrelid = 'lot_master'::regclass
  ) THEN
    ALTER TABLE lot_master
      ADD CONSTRAINT uq_lot_master_lot_number UNIQUE (lot_number);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_lot_master_quality_hold_status'
      AND conrelid = 'lot_master'::regclass
  ) THEN
    ALTER TABLE lot_master
      ADD CONSTRAINT chk_lot_master_quality_hold_status CHECK (quality_hold_status IN ('none', 'held'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_lot_master_sku_expiry ON lot_master (sku, expiry_date);
CREATE INDEX IF NOT EXISTS idx_lot_master_lot_id ON lot_master (lot_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON lot_master TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON lot_master TO readonly_user;
  END IF;
END $$;


-- -------------------------------------------------------------------------------------------
-- Serial master (Story 2.3). The section below MUST stay identical to the canonical
-- read/projections/serial_master.sql (applied by src/events/migrate.ts and the
-- integration-test harness) - change both files together.
-- -------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS serial_master (
  serial_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serial_number         TEXT NOT NULL,
  sku                   TEXT NOT NULL,
  lot_id                TEXT,
  current_location_id   UUID,
  current_location_code TEXT,
  current_quantity      NUMERIC(18, 6) NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_serial_master_sku_serial_number UNIQUE (sku, serial_number)
);

ALTER TABLE serial_master ADD COLUMN IF NOT EXISTS lot_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_serial_master_sku_serial_number'
      AND conrelid = 'serial_master'::regclass
  ) THEN
    ALTER TABLE serial_master
      ADD CONSTRAINT uq_serial_master_sku_serial_number UNIQUE (sku, serial_number);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_serial_master_sku_serial ON serial_master (sku, serial_number);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON serial_master TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON serial_master TO readonly_user;
  END IF;
END $$;


-- -------------------------------------------------------------------------------------------
-- Lot trace (Story 2.3). The section below MUST stay identical to the canonical
-- read/projections/lot_trace.sql (applied by src/events/migrate.ts and the
-- integration-test harness) - change both files together.
-- -------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lot_trace (
  trace_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id            UUID NOT NULL,
  event_id          UUID NOT NULL,
  event_type        TEXT NOT NULL,
  sku               TEXT NOT NULL,
  location_id       UUID,
  location_code     TEXT,
  quantity_change   NUMERIC(18, 6) NOT NULL,
  business_stream   TEXT NOT NULL,
  timestamp         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lot_trace_lot_timestamp ON lot_trace (lot_id, timestamp);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_lot_trace_event_id' AND schemaname = current_schema()
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'idx_lot_trace_event_id' AND schemaname = current_schema() AND indexdef ILIKE '%UNIQUE%'
  ) THEN
    DROP INDEX idx_lot_trace_event_id;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_lot_trace_event_id ON lot_trace (event_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON lot_trace TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON lot_trace TO readonly_user;
  END IF;
END $$;

-- -------------------------------------------------------------------------------------------
-- Inventory valuation read models (Story 2.4). The section below MUST stay identical to the
-- canonical read/projections/inventory_valuation.sql (applied by src/events/migrate.ts and the
-- integration-test harness) - change both files together.
-- -------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS inventory_valuation (
  sku                   TEXT PRIMARY KEY,
  quantity_on_hand      NUMERIC(18, 6) NOT NULL DEFAULT 0,
  running_average_cost  NUMERIC(18, 6),
  carrying_value        NUMERIC(20, 6) NOT NULL DEFAULT 0,
  pre_writedown_cost    NUMERIC(20, 6),
  cumulative_write_down NUMERIC(20, 6) NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_inventory_valuation_quantity_non_negative CHECK (quantity_on_hand >= 0),
  CONSTRAINT chk_inventory_valuation_carrying_value_non_negative CHECK (carrying_value >= 0),
  -- AC4 recovery cap, enforced at the database as a second line of defense independent of the
  -- compliance seam's own JS-side comparison (src/compliance/inventory-valuation.ts).
  CONSTRAINT chk_inventory_valuation_recovery_cap CHECK (pre_writedown_cost IS NULL OR carrying_value <= pre_writedown_cost)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_valuation_quantity_non_negative'
      AND conrelid = 'inventory_valuation'::regclass
  ) THEN
    ALTER TABLE inventory_valuation
      ADD CONSTRAINT chk_inventory_valuation_quantity_non_negative CHECK (quantity_on_hand >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_valuation_carrying_value_non_negative'
      AND conrelid = 'inventory_valuation'::regclass
  ) THEN
    ALTER TABLE inventory_valuation
      ADD CONSTRAINT chk_inventory_valuation_carrying_value_non_negative CHECK (carrying_value >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_valuation_recovery_cap'
      AND conrelid = 'inventory_valuation'::regclass
  ) THEN
    ALTER TABLE inventory_valuation
      ADD CONSTRAINT chk_inventory_valuation_recovery_cap CHECK (pre_writedown_cost IS NULL OR carrying_value <= pre_writedown_cost);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON inventory_valuation TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON inventory_valuation TO readonly_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS inventory_valuation_fifo_layer (
  layer_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                 TEXT NOT NULL,
  sequence_no         BIGSERIAL,
  unit_cost           NUMERIC(18, 6) NOT NULL,
  original_quantity   NUMERIC(18, 6) NOT NULL,
  remaining_quantity  NUMERIC(18, 6) NOT NULL,
  event_id            UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_inventory_valuation_fifo_layer_remaining_bounds CHECK (remaining_quantity >= 0 AND remaining_quantity <= original_quantity)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_valuation_fifo_layer_remaining_bounds'
      AND conrelid = 'inventory_valuation_fifo_layer'::regclass
  ) THEN
    ALTER TABLE inventory_valuation_fifo_layer
      ADD CONSTRAINT chk_inventory_valuation_fifo_layer_remaining_bounds CHECK (remaining_quantity >= 0 AND remaining_quantity <= original_quantity);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inventory_valuation_fifo_layer_sku_sequence ON inventory_valuation_fifo_layer (sku, sequence_no);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON inventory_valuation_fifo_layer TO app_user;
    GRANT USAGE, SELECT ON SEQUENCE inventory_valuation_fifo_layer_sequence_no_seq TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON inventory_valuation_fifo_layer TO readonly_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS inventory_valuation_serial_cost (
  sku            TEXT NOT NULL,
  serial_number  TEXT NOT NULL,
  unit_cost      NUMERIC(18, 6) NOT NULL,
  consumed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_inventory_valuation_serial_cost PRIMARY KEY (sku, serial_number)
);

ALTER TABLE inventory_valuation_serial_cost ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON inventory_valuation_serial_cost TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON inventory_valuation_serial_cost TO readonly_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS inventory_valuation_nrv_adjustment (
  adjustment_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                       TEXT NOT NULL,
  adjustment_type           TEXT NOT NULL,
  effective_date            DATE NOT NULL,
  authoriser_actor_id       UUID NOT NULL,
  original_cost             NUMERIC(20, 6) NOT NULL,
  carrying_value_before     NUMERIC(20, 6) NOT NULL,
  carrying_value_after      NUMERIC(20, 6) NOT NULL,
  amount                    NUMERIC(20, 6) NOT NULL,
  cumulative_write_down_after NUMERIC(20, 6) NOT NULL,
  reason                    TEXT NOT NULL,
  evidence_ref              TEXT,
  event_id                  UUID NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_inventory_valuation_nrv_adjustment_type CHECK (adjustment_type IN ('write_down', 'recovery'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_valuation_nrv_adjustment_type'
      AND conrelid = 'inventory_valuation_nrv_adjustment'::regclass
  ) THEN
    ALTER TABLE inventory_valuation_nrv_adjustment
      ADD CONSTRAINT chk_inventory_valuation_nrv_adjustment_type CHECK (adjustment_type IN ('write_down', 'recovery'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inventory_valuation_nrv_adjustment_sku ON inventory_valuation_nrv_adjustment (sku, created_at);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON inventory_valuation_nrv_adjustment TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON inventory_valuation_nrv_adjustment TO readonly_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS inventory_valuation_standard_cost_variance (
  variance_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku               TEXT NOT NULL,
  period            TEXT NOT NULL,
  standard_cost     NUMERIC(18, 6) NOT NULL,
  actual_cost       NUMERIC(18, 6) NOT NULL,
  variance_amount   NUMERIC(18, 6) NOT NULL,
  variance_percent  NUMERIC(9, 4),
  tolerance_percent NUMERIC(7, 4),
  breached          BOOLEAN NOT NULL DEFAULT false,
  event_id          UUID NOT NULL,
  reviewed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inventory_valuation_standard_cost_variance_sku_period UNIQUE (sku, period)
);

CREATE INDEX IF NOT EXISTS idx_inventory_valuation_standard_cost_variance_sku ON inventory_valuation_standard_cost_variance (sku, reviewed_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_inventory_valuation_standard_cost_variance_sku_period'
      AND conrelid = 'inventory_valuation_standard_cost_variance'::regclass
  ) THEN
    ALTER TABLE inventory_valuation_standard_cost_variance
      ADD CONSTRAINT uq_inventory_valuation_standard_cost_variance_sku_period UNIQUE (sku, period);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON inventory_valuation_standard_cost_variance TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON inventory_valuation_standard_cost_variance TO readonly_user;
  END IF;
END $$;

-- -------------------------------------------------------------------------------------------
-- Cycle count (Story 2.6). The section below MUST stay identical to the canonical
-- read/projections/cycle_count.sql (applied by src/events/migrate.ts and the integration-test
-- harness) - change both files together.
-- -------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cycle_count (
  cycle_count_id        UUID PRIMARY KEY,
  location_id           UUID NOT NULL,
  zone_id               TEXT,
  sku_scope             TEXT[] NOT NULL,
  stock_class           TEXT,
  count_type            TEXT NOT NULL,
  business_date         DATE NOT NULL,
  business_stream       TEXT NOT NULL,
  tolerance_percent     NUMERIC(9, 4) NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'open',
  created_by_actor_id   UUID,
  submitted_by_actor_id UUID,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cycle_count_location ON cycle_count (location_id);
CREATE INDEX IF NOT EXISTS idx_cycle_count_status ON cycle_count (status);

CREATE TABLE IF NOT EXISTS cycle_count_line (
  line_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_count_id     UUID NOT NULL,
  sku                TEXT NOT NULL,
  lot_id             TEXT,
  stock_class        TEXT NOT NULL DEFAULT 'owned',
  counted_quantity   NUMERIC(18, 6) NOT NULL,
  book_quantity      NUMERIC(18, 6) NOT NULL DEFAULT 0,
  allocated_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  in_transit_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  variance_quantity  NUMERIC(18, 6) NOT NULL DEFAULT 0,
  variance_value     NUMERIC(20, 6) NOT NULL DEFAULT 0,
  tolerance_breach   BOOLEAN NOT NULL DEFAULT false,
  adjustment_id      UUID,
  adjustment_status  TEXT,
  approver_actor_id  UUID,
  reason_code        TEXT,
  applied_event_id   UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_cycle_count_line_grain UNIQUE NULLS NOT DISTINCT (cycle_count_id, sku, lot_id, stock_class),
  CONSTRAINT chk_cycle_count_line_counted_non_negative CHECK (counted_quantity >= 0)
);

CREATE INDEX IF NOT EXISTS idx_cycle_count_line_count ON cycle_count_line (cycle_count_id);
CREATE INDEX IF NOT EXISTS idx_cycle_count_line_adjustment ON cycle_count_line (adjustment_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_cycle_count_line_grain'
      AND conrelid = 'cycle_count_line'::regclass
  ) THEN
    ALTER TABLE cycle_count_line
      ADD CONSTRAINT uq_cycle_count_line_grain UNIQUE NULLS NOT DISTINCT (cycle_count_id, sku, lot_id, stock_class);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_cycle_count_line_counted_non_negative'
      AND conrelid = 'cycle_count_line'::regclass
  ) THEN
    ALTER TABLE cycle_count_line
      ADD CONSTRAINT chk_cycle_count_line_counted_non_negative CHECK (counted_quantity >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON cycle_count TO app_user;
    GRANT INSERT, SELECT, UPDATE ON cycle_count_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON cycle_count TO readonly_user;
    GRANT SELECT ON cycle_count_line TO readonly_user;
  END IF;
END $$;

-- -------------------------------------------------------------------------------------------
-- Physical verification (Story 2.6). The section below MUST stay identical to the canonical
-- read/projections/physical_verification.sql (applied by src/events/migrate.ts and the
-- integration-test harness) - change both files together.
-- -------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS physical_verification (
  physical_verification_id  UUID PRIMARY KEY,
  location_id               UUID NOT NULL,
  coverage_percentage       NUMERIC(9, 4) NOT NULL DEFAULT 0,
  period_start              DATE,
  period_end                DATE,
  business_date             DATE,
  count_refs                UUID[] NOT NULL DEFAULT '{}',
  completed_by_actor_id     UUID,
  management_signoff_actor_id UUID,
  signed_off_at             TIMESTAMPTZ,
  period_locked             BOOLEAN NOT NULL DEFAULT false,
  source_event_id           UUID,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_physical_verification_location ON physical_verification (location_id);

CREATE TABLE IF NOT EXISTS physical_verification_line (
  pv_line_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  physical_verification_id  UUID NOT NULL,
  cycle_count_id            UUID NOT NULL,
  count_date                DATE,
  sku                       TEXT NOT NULL,
  lot_id                    TEXT,
  stock_class               TEXT NOT NULL DEFAULT 'owned',
  book_quantity             NUMERIC(18, 6) NOT NULL DEFAULT 0,
  counted_quantity          NUMERIC(18, 6) NOT NULL DEFAULT 0,
  variance_quantity         NUMERIC(18, 6) NOT NULL DEFAULT 0,
  variance_value            NUMERIC(20, 6) NOT NULL DEFAULT 0,
  adjustment_event_ref      UUID,
  counter_actor_id          UUID,
  approver_actor_id         UUID,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_physical_verification_line_pv ON physical_verification_line (physical_verification_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON physical_verification TO app_user;
    GRANT INSERT, SELECT ON physical_verification_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON physical_verification TO readonly_user;
    GRANT SELECT ON physical_verification_line TO readonly_user;
  END IF;
END $$;

-- -------------------------------------------------------------------------------------------
-- Inventory planning parameters (Story 2.7). The section below MUST stay identical to the
-- canonical read/projections/inventory_planning.sql (applied by src/events/migrate.ts and the
-- integration-test harness) - change both files together.
-- -------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS inventory_planning_params (
  planning_params_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                         TEXT NOT NULL,
  location_id                 UUID NOT NULL,
  lead_time_days              NUMERIC(9, 3),
  lead_time_source            TEXT,
  service_level               NUMERIC(6, 4),
  avg_daily_demand            NUMERIC(18, 6),
  demand_std_dev              NUMERIC(18, 6),
  demand_window_days          INTEGER NOT NULL DEFAULT 90,
  obsolescence_threshold_days INTEGER,
  standard_order_qty          NUMERIC(18, 6),
  safety_stock                NUMERIC(18, 6),
  reorder_point               NUMERIC(18, 6),
  last_computed_at            TIMESTAMPTZ,
  computation_inputs          JSONB,
  business_stream             TEXT NOT NULL,
  set_by_actor_id             UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inventory_planning_params_grain UNIQUE NULLS NOT DISTINCT (sku, location_id),
  CONSTRAINT chk_inventory_planning_params_service_level CHECK (service_level IS NULL OR (service_level > 0 AND service_level < 1)),
  CONSTRAINT chk_inventory_planning_params_lead_time_non_negative CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  CONSTRAINT chk_inventory_planning_params_window_positive CHECK (demand_window_days > 0)
);

CREATE INDEX IF NOT EXISTS idx_inventory_planning_params_location ON inventory_planning_params (location_id);
CREATE INDEX IF NOT EXISTS idx_inventory_planning_params_sku ON inventory_planning_params (sku);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_inventory_planning_params_grain'
      AND conrelid = 'inventory_planning_params'::regclass
  ) THEN
    ALTER TABLE inventory_planning_params
      ADD CONSTRAINT uq_inventory_planning_params_grain UNIQUE NULLS NOT DISTINCT (sku, location_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_planning_params_service_level'
      AND conrelid = 'inventory_planning_params'::regclass
  ) THEN
    ALTER TABLE inventory_planning_params
      ADD CONSTRAINT chk_inventory_planning_params_service_level CHECK (service_level IS NULL OR (service_level > 0 AND service_level < 1));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_planning_params_lead_time_non_negative'
      AND conrelid = 'inventory_planning_params'::regclass
  ) THEN
    ALTER TABLE inventory_planning_params
      ADD CONSTRAINT chk_inventory_planning_params_lead_time_non_negative CHECK (lead_time_days IS NULL OR lead_time_days >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_planning_params_window_positive'
      AND conrelid = 'inventory_planning_params'::regclass
  ) THEN
    ALTER TABLE inventory_planning_params
      ADD CONSTRAINT chk_inventory_planning_params_window_positive CHECK (demand_window_days > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON inventory_planning_params TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON inventory_planning_params TO readonly_user;
  END IF;
END $$;

-- -------------------------------------------------------------------------------------------
-- Replenishment recommendation (Story 2.7). The section below MUST stay identical to the
-- canonical read/projections/replenishment_recommendation.sql (applied by src/events/migrate.ts
-- and the integration-test harness) - change both files together.
-- -------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS replenishment_recommendation (
  recommendation_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                   TEXT NOT NULL,
  location_id           UUID NOT NULL,
  on_hand_at_check      NUMERIC(18, 6) NOT NULL,
  reorder_point         NUMERIC(18, 6) NOT NULL,
  recommended_order_qty NUMERIC(18, 6) NOT NULL,
  status                TEXT NOT NULL DEFAULT 'open',
  signal_type           TEXT NOT NULL DEFAULT 'internal',
  owner_party_code      TEXT,
  triggered_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_event_id       UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_replenishment_recommendation_status CHECK (status IN ('open', 'superseded', 'fulfilled')),
  CONSTRAINT chk_replenishment_recommendation_signal_type CHECK (signal_type IN ('internal', 'vmi_replenishment'))
);

ALTER TABLE replenishment_recommendation ADD COLUMN IF NOT EXISTS signal_type TEXT NOT NULL DEFAULT 'internal';
ALTER TABLE replenishment_recommendation ADD COLUMN IF NOT EXISTS owner_party_code TEXT;

CREATE INDEX IF NOT EXISTS idx_replenishment_recommendation_sku ON replenishment_recommendation (sku);
CREATE INDEX IF NOT EXISTS idx_replenishment_recommendation_location ON replenishment_recommendation (location_id);
DROP INDEX IF EXISTS uq_replenishment_recommendation_open;
CREATE UNIQUE INDEX IF NOT EXISTS uq_replenishment_recommendation_open_signal ON replenishment_recommendation (sku, location_id, signal_type) WHERE status = 'open';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_replenishment_recommendation_status'
      AND conrelid = 'replenishment_recommendation'::regclass
  ) THEN
    ALTER TABLE replenishment_recommendation
      ADD CONSTRAINT chk_replenishment_recommendation_status CHECK (status IN ('open', 'superseded', 'fulfilled'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_replenishment_recommendation_signal_type'
      AND conrelid = 'replenishment_recommendation'::regclass
  ) THEN
    ALTER TABLE replenishment_recommendation
      ADD CONSTRAINT chk_replenishment_recommendation_signal_type CHECK (signal_type IN ('internal', 'vmi_replenishment'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON replenishment_recommendation TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON replenishment_recommendation TO readonly_user;
  END IF;
END $$;

-- -------------------------------------------------------------------------------------------
-- Obsolescence flag (Story 2.7). The section below MUST stay identical to the canonical
-- read/projections/obsolescence_flag.sql (applied by src/events/migrate.ts and the
-- integration-test harness) - change both files together.
-- -------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS obsolescence_flag (
  obsolescence_flag_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                   TEXT NOT NULL,
  location_id           UUID NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active',
  last_issue_at         TIMESTAMPTZ,
  days_since_issue      INTEGER,
  threshold_days        INTEGER,
  disposition_status    TEXT,
  nrv_testing_triggered BOOLEAN NOT NULL DEFAULT false,
  flagged_at            TIMESTAMPTZ,
  cleared_at            TIMESTAMPTZ,
  source_event_id       UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_obsolescence_flag_grain UNIQUE NULLS NOT DISTINCT (sku, location_id),
  CONSTRAINT chk_obsolescence_flag_status CHECK (status IN ('active', 'aging'))
);

CREATE INDEX IF NOT EXISTS idx_obsolescence_flag_location ON obsolescence_flag (location_id);
CREATE INDEX IF NOT EXISTS idx_obsolescence_flag_status ON obsolescence_flag (status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_obsolescence_flag_grain'
      AND conrelid = 'obsolescence_flag'::regclass
  ) THEN
    ALTER TABLE obsolescence_flag
      ADD CONSTRAINT uq_obsolescence_flag_grain UNIQUE NULLS NOT DISTINCT (sku, location_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_obsolescence_flag_status'
      AND conrelid = 'obsolescence_flag'::regclass
  ) THEN
    ALTER TABLE obsolescence_flag
      ADD CONSTRAINT chk_obsolescence_flag_status CHECK (status IN ('active', 'aging'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON obsolescence_flag TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON obsolescence_flag TO readonly_user;
  END IF;
END $$;

-- -------------------------------------------------------------------------------------------
-- Ownership agreement (Story 2.8). The section below MUST stay identical to the canonical
-- read/projections/ownership_agreement.sql (applied by src/events/migrate.ts and the
-- integration-test harness) - change both files together.
-- -------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ownership_agreement (
  agreement_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku              TEXT NOT NULL,
  location_id      UUID NOT NULL,
  stock_class      TEXT NOT NULL,
  owner_party_code TEXT NOT NULL,
  vmi_min_qty      NUMERIC(14, 3),
  active           BOOLEAN NOT NULL DEFAULT true,
  business_stream  TEXT NOT NULL,
  set_by_actor_id  UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_ownership_agreement_stock_class CHECK (stock_class IN ('consignment', 'vmi')),
  CONSTRAINT chk_ownership_agreement_vmi_min_positive CHECK (vmi_min_qty IS NULL OR vmi_min_qty > 0),
  CONSTRAINT chk_ownership_agreement_vmi_min_required CHECK (stock_class <> 'vmi' OR active IS FALSE OR vmi_min_qty IS NOT NULL),
  CONSTRAINT chk_ownership_agreement_owner_party_code CHECK (owner_party_code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$')
);

ALTER TABLE ownership_agreement ALTER COLUMN vmi_min_qty TYPE NUMERIC(14, 3);

CREATE INDEX IF NOT EXISTS idx_ownership_agreement_location ON ownership_agreement (location_id);
CREATE INDEX IF NOT EXISTS idx_ownership_agreement_sku ON ownership_agreement (sku);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ownership_agreement_active ON ownership_agreement (sku, location_id, stock_class) WHERE active;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_ownership_agreement_stock_class'
      AND conrelid = 'ownership_agreement'::regclass
  ) THEN
    ALTER TABLE ownership_agreement
      ADD CONSTRAINT chk_ownership_agreement_stock_class CHECK (stock_class IN ('consignment', 'vmi'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_ownership_agreement_vmi_min_positive'
      AND conrelid = 'ownership_agreement'::regclass
  ) THEN
    ALTER TABLE ownership_agreement
      ADD CONSTRAINT chk_ownership_agreement_vmi_min_positive CHECK (vmi_min_qty IS NULL OR vmi_min_qty > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_ownership_agreement_vmi_min_required'
      AND conrelid = 'ownership_agreement'::regclass
  ) THEN
    ALTER TABLE ownership_agreement
      ADD CONSTRAINT chk_ownership_agreement_vmi_min_required CHECK (stock_class <> 'vmi' OR active IS FALSE OR vmi_min_qty IS NOT NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_ownership_agreement_owner_party_code'
      AND conrelid = 'ownership_agreement'::regclass
  ) THEN
    ALTER TABLE ownership_agreement
      ADD CONSTRAINT chk_ownership_agreement_owner_party_code CHECK (owner_party_code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON ownership_agreement TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON ownership_agreement TO readonly_user;
  END IF;
END $$;

-- -------------------------------------------------------------------------------------------
-- ERP open purchase-order reference projection (Story 2.9). The section below MUST stay identical
-- to the canonical read/projections/erp_purchase_order.sql (applied by src/events/migrate.ts and the
-- integration-test harness) - change both files together. Reference data only (INT-ERP-01):
-- populated by the ERP sync adapter via direct upsert, NOT event-sourced.
-- -------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS erp_purchase_order (
  po_number_ext          TEXT PRIMARY KEY,
  supplier_ref_ext       TEXT NOT NULL,
  currency               TEXT NOT NULL,
  expected_delivery_date DATE,
  status                 TEXT NOT NULL DEFAULT 'open',
  source_system          TEXT NOT NULL DEFAULT 'ERP',
  last_synced_at         TIMESTAMPTZ NOT NULL,
  source_snapshot        JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_erp_purchase_order_status CHECK (status IN ('open', 'closed')),
  CONSTRAINT chk_erp_purchase_order_source_system CHECK (source_system = 'ERP')
);

CREATE TABLE IF NOT EXISTS erp_purchase_order_line (
  po_number_ext              TEXT NOT NULL,
  line_no                    INTEGER NOT NULL,
  sku                        TEXT NOT NULL,
  ordered_qty                NUMERIC(18, 3) NOT NULL,
  open_qty                   NUMERIC(18, 3) NOT NULL,
  unit_price                 NUMERIC(18, 4) NOT NULL,
  over_receipt_tolerance_pct  NUMERIC(9, 3),
  under_receipt_tolerance_pct NUMERIC(9, 3),
  source_system              TEXT NOT NULL DEFAULT 'ERP',
  last_synced_at             TIMESTAMPTZ NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (po_number_ext, line_no),
  CONSTRAINT chk_erp_po_line_ordered_non_negative CHECK (ordered_qty >= 0),
  CONSTRAINT chk_erp_po_line_open_within_ordered CHECK (open_qty >= 0 AND open_qty <= ordered_qty),
  CONSTRAINT chk_erp_po_line_unit_price_non_negative CHECK (unit_price >= 0),
  CONSTRAINT chk_erp_po_line_tolerance_non_negative CHECK ((over_receipt_tolerance_pct IS NULL OR over_receipt_tolerance_pct >= 0) AND (under_receipt_tolerance_pct IS NULL OR under_receipt_tolerance_pct >= 0))
);

CREATE INDEX IF NOT EXISTS idx_erp_purchase_order_line_sku ON erp_purchase_order_line (sku);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_erp_purchase_order_status'
      AND conrelid = 'erp_purchase_order'::regclass
  ) THEN
    ALTER TABLE erp_purchase_order
      ADD CONSTRAINT chk_erp_purchase_order_status CHECK (status IN ('open', 'closed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_erp_purchase_order_source_system'
      AND conrelid = 'erp_purchase_order'::regclass
  ) THEN
    ALTER TABLE erp_purchase_order
      ADD CONSTRAINT chk_erp_purchase_order_source_system CHECK (source_system = 'ERP');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_erp_po_line_ordered_non_negative'
      AND conrelid = 'erp_purchase_order_line'::regclass
  ) THEN
    ALTER TABLE erp_purchase_order_line
      ADD CONSTRAINT chk_erp_po_line_ordered_non_negative CHECK (ordered_qty >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_erp_po_line_open_within_ordered'
      AND conrelid = 'erp_purchase_order_line'::regclass
  ) THEN
    ALTER TABLE erp_purchase_order_line
      ADD CONSTRAINT chk_erp_po_line_open_within_ordered CHECK (open_qty >= 0 AND open_qty <= ordered_qty);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_erp_po_line_unit_price_non_negative'
      AND conrelid = 'erp_purchase_order_line'::regclass
  ) THEN
    ALTER TABLE erp_purchase_order_line
      ADD CONSTRAINT chk_erp_po_line_unit_price_non_negative CHECK (unit_price >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_erp_po_line_tolerance_non_negative'
      AND conrelid = 'erp_purchase_order_line'::regclass
  ) THEN
    ALTER TABLE erp_purchase_order_line
      ADD CONSTRAINT chk_erp_po_line_tolerance_non_negative CHECK ((over_receipt_tolerance_pct IS NULL OR over_receipt_tolerance_pct >= 0) AND (under_receipt_tolerance_pct IS NULL OR under_receipt_tolerance_pct >= 0));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON erp_purchase_order TO app_user;
    GRANT INSERT, SELECT, UPDATE ON erp_purchase_order_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON erp_purchase_order TO readonly_user;
    GRANT SELECT ON erp_purchase_order_line TO readonly_user;
  END IF;
END $$;

-- -------------------------------------------------------------------------------------------
-- ERP open sales-order (dispatch-demand) reference projection (Story 2.9). The section below MUST
-- stay identical to the canonical read/projections/erp_sales_order.sql - change both files together.
-- -------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS erp_sales_order (
  so_number_ext           TEXT NOT NULL,
  line_no                 INTEGER NOT NULL,
  sku                     TEXT NOT NULL,
  quantity                NUMERIC(18, 3) NOT NULL,
  required_by             DATE,
  ship_to_ext             TEXT,
  ship_from_site_id       UUID NOT NULL,
  ship_from_site_code_ext TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'open',
  source_system           TEXT NOT NULL DEFAULT 'ERP',
  last_synced_at          TIMESTAMPTZ NOT NULL,
  source_snapshot         JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (so_number_ext, line_no),
  CONSTRAINT chk_erp_so_quantity_non_negative CHECK (quantity >= 0),
  CONSTRAINT chk_erp_sales_order_status CHECK (status IN ('open', 'closed')),
  CONSTRAINT chk_erp_sales_order_source_system CHECK (source_system = 'ERP')
);

CREATE INDEX IF NOT EXISTS idx_erp_sales_order_site_status ON erp_sales_order (ship_from_site_id, status);
CREATE INDEX IF NOT EXISTS idx_erp_sales_order_site_code_status ON erp_sales_order (ship_from_site_code_ext, status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_erp_so_quantity_non_negative'
      AND conrelid = 'erp_sales_order'::regclass
  ) THEN
    ALTER TABLE erp_sales_order
      ADD CONSTRAINT chk_erp_so_quantity_non_negative CHECK (quantity >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_erp_sales_order_status'
      AND conrelid = 'erp_sales_order'::regclass
  ) THEN
    ALTER TABLE erp_sales_order
      ADD CONSTRAINT chk_erp_sales_order_status CHECK (status IN ('open', 'closed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_erp_sales_order_source_system'
      AND conrelid = 'erp_sales_order'::regclass
  ) THEN
    ALTER TABLE erp_sales_order
      ADD CONSTRAINT chk_erp_sales_order_source_system CHECK (source_system = 'ERP');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON erp_sales_order TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON erp_sales_order TO readonly_user;
  END IF;
END $$;

-- -------------------------------------------------------------------------------------------
-- Integration sync-state heartbeat and exception queue (Story 2.9). The section below MUST stay
-- identical to the canonical read/projections/integration_exception.sql - change both files together.
-- -------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS erp_sync_state (
  projection_name    TEXT PRIMARY KEY,
  status             TEXT NOT NULL DEFAULT 'never_synced',
  last_attempted_at  TIMESTAMPTZ,
  last_successful_at TIMESTAMPTZ,
  last_error         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_erp_sync_state_status CHECK (status IN ('never_synced', 'success', 'failed'))
);

CREATE TABLE IF NOT EXISTS integration_exception (
  exception_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system     TEXT NOT NULL DEFAULT 'ERP',
  record_type       TEXT NOT NULL,
  source_record_ref TEXT,
  error_code        TEXT NOT NULL,
  reason            TEXT NOT NULL,
  details           JSONB,
  status            TEXT NOT NULL DEFAULT 'open',
  raised_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_integration_exception_record_type CHECK (record_type IN ('purchase_order', 'sales_order', 'sync_batch')),
  CONSTRAINT chk_integration_exception_status CHECK (status IN ('open', 'resolved'))
);

CREATE INDEX IF NOT EXISTS idx_integration_exception_status ON integration_exception (status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_exception_open ON integration_exception (source_system, record_type, source_record_ref, error_code) NULLS NOT DISTINCT WHERE status = 'open';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_erp_sync_state_status'
      AND conrelid = 'erp_sync_state'::regclass
  ) THEN
    ALTER TABLE erp_sync_state
      ADD CONSTRAINT chk_erp_sync_state_status CHECK (status IN ('never_synced', 'success', 'failed'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_integration_exception_record_type'
      AND conrelid = 'integration_exception'::regclass
  ) THEN
    ALTER TABLE integration_exception
      ADD CONSTRAINT chk_integration_exception_record_type CHECK (record_type IN ('purchase_order', 'sales_order', 'sync_batch'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_integration_exception_status'
      AND conrelid = 'integration_exception'::regclass
  ) THEN
    ALTER TABLE integration_exception
      ADD CONSTRAINT chk_integration_exception_status CHECK (status IN ('open', 'resolved'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON erp_sync_state TO app_user;
    GRANT INSERT, SELECT, UPDATE ON integration_exception TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON erp_sync_state TO readonly_user;
    GRANT SELECT ON integration_exception TO readonly_user;
  END IF;
END $$;

-- -------------------------------------------------------------------------------------------
-- Gate event projection (Story 3.2). The section below MUST stay identical to the canonical
-- read/projections/gate_event.sql (applied by src/events/migrate.ts and the integration-test
-- harness) - change both files together.
-- -------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS gate_event (
  gate_event_id     UUID PRIMARY KEY,
  site_id           UUID NOT NULL,
  site_code_ext     TEXT NOT NULL,
  po_ref_ext        TEXT,
  binding_status    TEXT NOT NULL,
  vehicle_reg_ext   TEXT NOT NULL,
  driver_name       TEXT,
  challan_number_ext TEXT,
  challan_photo_ref TEXT NOT NULL,
  gate_id           TEXT NOT NULL,
  gate_officer_id   UUID NOT NULL,
  correlation_id    UUID NOT NULL,
  entered_at        TIMESTAMPTZ NOT NULL,
  business_date     DATE NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open',
  reversal_reason   TEXT,
  source_event_id   UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_gate_event_binding_status CHECK (binding_status IN ('matched', 'unmatched')),
  CONSTRAINT chk_gate_event_status CHECK (status IN ('open', 'reversed')),
  CONSTRAINT chk_gate_event_vehicle_reg_nonempty CHECK (length(trim(vehicle_reg_ext)) > 0),
  CONSTRAINT chk_gate_event_challan_photo_nonempty CHECK (length(trim(challan_photo_ref)) > 0)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_gate_event_binding_status'
      AND conrelid = 'gate_event'::regclass
  ) THEN
    ALTER TABLE gate_event
      ADD CONSTRAINT chk_gate_event_binding_status CHECK (binding_status IN ('matched', 'unmatched'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_gate_event_status'
      AND conrelid = 'gate_event'::regclass
  ) THEN
    ALTER TABLE gate_event
      ADD CONSTRAINT chk_gate_event_status CHECK (status IN ('open', 'reversed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_gate_event_vehicle_reg_nonempty'
      AND conrelid = 'gate_event'::regclass
  ) THEN
    ALTER TABLE gate_event
      ADD CONSTRAINT chk_gate_event_vehicle_reg_nonempty CHECK (length(trim(vehicle_reg_ext)) > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_gate_event_challan_photo_nonempty'
      AND conrelid = 'gate_event'::regclass
  ) THEN
    ALTER TABLE gate_event
      ADD CONSTRAINT chk_gate_event_challan_photo_nonempty CHECK (length(trim(challan_photo_ref)) > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_gate_event_site_status ON gate_event (site_id, status);
CREATE INDEX IF NOT EXISTS idx_gate_event_po_ref ON gate_event (po_ref_ext);
CREATE INDEX IF NOT EXISTS idx_gate_event_binding_status ON gate_event (binding_status, status);
CREATE INDEX IF NOT EXISTS idx_gate_event_correlation ON gate_event (correlation_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON gate_event TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON gate_event TO readonly_user;
  END IF;
END $$;
