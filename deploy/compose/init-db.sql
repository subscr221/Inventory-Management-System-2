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
CREATE UNIQUE INDEX IF NOT EXISTS uq_po_release_reference
  ON domain_events (stream_id, (payload->>'release_reference'))
  WHERE event_type = 'purchase_order.release_recorded';

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

-- Story 7.5 (Status Write-Through Contract): the calibration register writes and reads this row by
-- the instrument id AS STORED in instrument_register, and instrument ids are canonicalized with
-- lower() everywhere they are human-entered. Without a lower() index the lookup either scans or
-- misses: an instrument stored as 'ins-42' and queried as 'INS-42' returns null, and null is
-- treated as locked, so the failure mode is a spurious lockout rather than a bypass. Fail-closed
-- is correct but wrong for the operator, and the repo convention (Story 7.1 asset tags, Story 7.2
-- scanned-versus-typed keys) is to canonicalize. The guarded DO block makes a re-applied file
-- self-heal; no existing column or constraint on this table is changed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'idx_instrument_calibration_statuses_instrument_id_lower'
  ) THEN
    CREATE INDEX idx_instrument_calibration_statuses_instrument_id_lower
      ON instrument_calibration_statuses (lower(instrument_id));
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
  legal_metrology_required    BOOLEAN NOT NULL DEFAULT false,
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
  size_class                  TEXT NOT NULL DEFAULT 'standard',
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
  ),
  CONSTRAINT chk_item_master_size_class CHECK (size_class IN ('small', 'standard', 'large', 'oversized'))
);

ALTER TABLE item_master ADD COLUMN IF NOT EXISTS standard_cost_designation TEXT;
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS standard_cost_amount NUMERIC(18, 6);
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS variance_review_cadence TEXT;
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS variance_tolerance_percent NUMERIC(7, 4);
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS count_variance_tolerance_percent NUMERIC(7, 4);
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS size_class TEXT NOT NULL DEFAULT 'standard';

-- Story 8.6 (FR-Q-14): Legal Metrology packaged-commodity flag, mirroring bis_licence_required.
-- Default false keeps the LABEL_VERSION_MISSING release block inert for every existing item until
-- the flag is deliberately set (Binding Scope Decision 7).
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS legal_metrology_required BOOLEAN NOT NULL DEFAULT false;

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
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_item_master_size_class'
      AND conrelid = 'item_master'::regclass
  ) THEN
    ALTER TABLE item_master
      ADD CONSTRAINT chk_item_master_size_class CHECK (
        size_class IN ('small', 'standard', 'large', 'oversized')
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

-- Story 3.6: picked tracks stock that has left the `allocated` bucket because a pick line was
-- confirmed (AC7 "stock status moves from allocated to picked"), but has not yet shipped/
-- dispatched (Story 3.7 will introduce that transition). Added idempotently so a live database
-- gains the column without a table rebuild. `available` is redefined below to also subtract
-- `picked` so picked stock is not offered to new allocations, exactly like allocated stock.
ALTER TABLE stock_balance ADD COLUMN IF NOT EXISTS picked NUMERIC(18, 6) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'stock_balance'
      AND column_name = 'available'
      AND generation_expression ILIKE '%picked%'
  ) THEN
    ALTER TABLE stock_balance DROP COLUMN IF EXISTS available;
    ALTER TABLE stock_balance ADD COLUMN available NUMERIC(18, 6) GENERATED ALWAYS AS (on_hand - allocated - picked) STORED;
  END IF;
END $$;

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
    WHERE conname = 'chk_stock_balance_picked_non_negative'
      AND conrelid = 'stock_balance'::regclass
  ) THEN
    ALTER TABLE stock_balance
      ADD CONSTRAINT chk_stock_balance_picked_non_negative CHECK (picked >= 0);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_stock_balance_allocated_within_on_hand'
      AND conrelid = 'stock_balance'::regclass
  ) THEN
    ALTER TABLE stock_balance DROP CONSTRAINT chk_stock_balance_allocated_within_on_hand;
  END IF;
  ALTER TABLE stock_balance
    ADD CONSTRAINT chk_stock_balance_allocated_within_on_hand CHECK (allocated + picked <= on_hand);
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
  id                      UUID NOT NULL DEFAULT gen_random_uuid(),
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

-- Story 3.6: the `id` surrogate must be added BEFORE the unique index that references it. A
-- database created before Story 3.6 has an erp_sales_order without `id`, so CREATE TABLE IF NOT
-- EXISTS above is a no-op there and indexing `id` first aborts the whole migration run.
ALTER TABLE erp_sales_order ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_sales_order_id ON erp_sales_order (id);

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
  CONSTRAINT chk_integration_exception_record_type CHECK (record_type IN ('purchase_order', 'sales_order', 'sync_batch', 'bom')),
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

-- Story 5.6 widens the record-type vocabulary with 'bom' (FR-B-17 inbound BOM rejection). The
-- DROP + ADD pair is kept atomic in a DO block so a database created before Story 5.6 picks the
-- new value up on re-migrate; uq_integration_exception_open is deliberately untouched - the
-- one-open-row-per-grain contract carries over to BOM conflicts unchanged.
DO $$
BEGIN
  ALTER TABLE integration_exception DROP CONSTRAINT IF EXISTS chk_integration_exception_record_type;
  ALTER TABLE integration_exception
    ADD CONSTRAINT chk_integration_exception_record_type CHECK (record_type IN ('purchase_order', 'sales_order', 'sync_batch', 'bom'));
END $$;

DO $$
BEGIN
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

DO $$
BEGIN
  -- Databases created while correlation_id carried an inline UNIQUE keyword hold an auto-named
  -- duplicate of uq_gate_event_correlation_id; drop it so exactly one unique index remains.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'gate_event_correlation_id_key'
      AND conrelid = 'gate_event'::regclass
  ) THEN
    ALTER TABLE gate_event
      DROP CONSTRAINT gate_event_correlation_id_key;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_gate_event_correlation_id'
      AND conrelid = 'gate_event'::regclass
  ) THEN
    ALTER TABLE gate_event
      ADD CONSTRAINT uq_gate_event_correlation_id UNIQUE (correlation_id);
  END IF;
END $$;

-- -------------------------------------------------------------------------------------------
-- Weighbridge event projection (Story 3.3). The section below MUST stay identical to the
-- canonical read/projections/weighbridge_event.sql (applied by src/events/migrate.ts and the
-- integration-test harness) - change both files together.
-- -------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS weighbridge_event (
  weighbridge_event_id    UUID PRIMARY KEY,
  correlation_id          UUID NOT NULL,
  gate_event_id           UUID NOT NULL,
  site_id                 UUID NOT NULL,
  site_code_ext           TEXT NOT NULL,
  po_ref_ext              TEXT NOT NULL,
  line_no                 INTEGER NOT NULL,
  tare_kg                 NUMERIC(12,3) NOT NULL,
  gross_kg                NUMERIC(12,3) NOT NULL,
  net_kg                  NUMERIC(12,3) NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'accepted',
  tolerance_breach_reason TEXT,
  device_id               TEXT NOT NULL,
  capture_method          TEXT NOT NULL,
  weighed_by              UUID NOT NULL,
  business_date           DATE NOT NULL,
  source_event_id         UUID NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_weighbridge_event_status CHECK (status IN ('accepted', 'tolerance_breach')),
  CONSTRAINT chk_weighbridge_event_tare_non_negative CHECK (tare_kg >= 0),
  CONSTRAINT chk_weighbridge_event_gross_non_negative CHECK (gross_kg >= 0),
  CONSTRAINT chk_weighbridge_event_net_non_negative CHECK (net_kg >= 0),
  CONSTRAINT chk_weighbridge_event_capture_method CHECK (capture_method IN ('AUTO', 'MANUAL'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_weighbridge_event_status'
      AND conrelid = 'weighbridge_event'::regclass
  ) THEN
    ALTER TABLE weighbridge_event
      ADD CONSTRAINT chk_weighbridge_event_status CHECK (status IN ('accepted', 'tolerance_breach'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_weighbridge_event_tare_non_negative'
      AND conrelid = 'weighbridge_event'::regclass
  ) THEN
    ALTER TABLE weighbridge_event
      ADD CONSTRAINT chk_weighbridge_event_tare_non_negative CHECK (tare_kg >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_weighbridge_event_gross_non_negative'
      AND conrelid = 'weighbridge_event'::regclass
  ) THEN
    ALTER TABLE weighbridge_event
      ADD CONSTRAINT chk_weighbridge_event_gross_non_negative CHECK (gross_kg >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_weighbridge_event_net_non_negative'
      AND conrelid = 'weighbridge_event'::regclass
  ) THEN
    ALTER TABLE weighbridge_event
      ADD CONSTRAINT chk_weighbridge_event_net_non_negative CHECK (net_kg >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_weighbridge_event_capture_method'
      AND conrelid = 'weighbridge_event'::regclass
  ) THEN
    ALTER TABLE weighbridge_event
      ADD CONSTRAINT chk_weighbridge_event_capture_method CHECK (capture_method IN ('AUTO', 'MANUAL'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_weighbridge_event_correlation ON weighbridge_event (correlation_id);
CREATE INDEX IF NOT EXISTS idx_weighbridge_event_site_status ON weighbridge_event (site_id, status);
CREATE INDEX IF NOT EXISTS idx_weighbridge_event_po_line ON weighbridge_event (po_ref_ext, line_no);
CREATE INDEX IF NOT EXISTS idx_weighbridge_event_business_date ON weighbridge_event (business_date);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON weighbridge_event TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON weighbridge_event TO readonly_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS grn (
  grn_id          UUID PRIMARY KEY,
  correlation_id  UUID NOT NULL,
  po_ref_ext      TEXT NOT NULL,
  source_document TEXT NOT NULL,
  source_ref_ext  TEXT,
  site_id         UUID NOT NULL,
  site_code_ext   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  received_by     UUID NOT NULL,
  business_date   DATE NOT NULL,
  source_event_id UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_grn_source_document CHECK (source_document IN ('PO', 'ASN')),
  CONSTRAINT chk_grn_status CHECK (status IN ('open', 'posted'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_grn_source_document'
      AND conrelid = 'grn'::regclass
  ) THEN
    ALTER TABLE grn
      ADD CONSTRAINT chk_grn_source_document CHECK (source_document IN ('PO', 'ASN'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_grn_status'
      AND conrelid = 'grn'::regclass
  ) THEN
    ALTER TABLE grn
      ADD CONSTRAINT chk_grn_status CHECK (status IN ('open', 'posted'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_grn_correlation ON grn (correlation_id);
CREATE INDEX IF NOT EXISTS idx_grn_po_ref ON grn (po_ref_ext);
CREATE INDEX IF NOT EXISTS idx_grn_site_status ON grn (site_id, status);
CREATE INDEX IF NOT EXISTS idx_grn_business_date ON grn (business_date);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON grn TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON grn TO readonly_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS grn_line (
  grn_line_id                UUID PRIMARY KEY,
  grn_id                     UUID NOT NULL,
  po_ref_ext                 TEXT NOT NULL,
  line_no                    INTEGER NOT NULL,
  sku                        TEXT NOT NULL,
  lot_id                     TEXT,
  expiry_date                DATE,
  received_qty               NUMERIC(18,3) NOT NULL,
  uom                        TEXT NOT NULL,
  stock_class                TEXT NOT NULL DEFAULT 'owned',
  weighbridge_correlation_id UUID NOT NULL,
  qc_hold                    BOOLEAN NOT NULL DEFAULT false,
  shortage_variance_qty      NUMERIC(18,3) NOT NULL DEFAULT 0,
  target_location_id         UUID,
  status                     TEXT NOT NULL DEFAULT 'posted',
  rejection_reason           TEXT,
  source_event_id            UUID NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_grn_line_received_positive CHECK (received_qty > 0),
  CONSTRAINT chk_grn_line_status CHECK (status IN ('posted', 'quarantined', 'rejected')),
  CONSTRAINT chk_grn_line_shortage_non_negative CHECK (shortage_variance_qty >= 0)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_grn_line_received_positive'
      AND conrelid = 'grn_line'::regclass
  ) THEN
    ALTER TABLE grn_line
      ADD CONSTRAINT chk_grn_line_received_positive CHECK (received_qty > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_grn_line_status'
      AND conrelid = 'grn_line'::regclass
  ) THEN
    ALTER TABLE grn_line
      ADD CONSTRAINT chk_grn_line_status CHECK (status IN ('posted', 'quarantined', 'rejected'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_grn_line_shortage_non_negative'
      AND conrelid = 'grn_line'::regclass
  ) THEN
    ALTER TABLE grn_line
      ADD CONSTRAINT chk_grn_line_shortage_non_negative CHECK (shortage_variance_qty >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_grn_line_grn ON grn_line (grn_id);
CREATE INDEX IF NOT EXISTS idx_grn_line_po_line ON grn_line (po_ref_ext, line_no);
CREATE INDEX IF NOT EXISTS idx_grn_line_sku ON grn_line (sku);
CREATE INDEX IF NOT EXISTS idx_grn_line_shortage ON grn_line (shortage_variance_qty);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON grn_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON grn_line TO readonly_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS putaway_task (
  putaway_task_id     UUID PRIMARY KEY,
  grn_line_id         UUID NOT NULL,
  sku                 TEXT NOT NULL,
  lot_id              TEXT,
  quantity            NUMERIC(18,3) NOT NULL,
  from_location_id    UUID NOT NULL,
  site_id             UUID NOT NULL,
  status              TEXT NOT NULL DEFAULT 'ready',
  owner_role          TEXT,
  released_by         UUID,
  release_reason_code TEXT,
  released_event_id   UUID,
  source_event_id     UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_putaway_task_status CHECK (status IN ('ready', 'held', 'completed'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_putaway_task_status'
      AND conrelid = 'putaway_task'::regclass
  ) THEN
    ALTER TABLE putaway_task
      ADD CONSTRAINT chk_putaway_task_status CHECK (status IN ('ready', 'held', 'completed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_putaway_task_grn_line ON putaway_task (grn_line_id);
CREATE INDEX IF NOT EXISTS idx_putaway_task_site_status ON putaway_task (site_id, status);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON putaway_task TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON putaway_task TO readonly_user;
  END IF;
END $$;

-- Story 3.5: Directed Putaway and Location Override - additive columns for Task 2
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS directed_location_id UUID;
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS directed_location_code TEXT;
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS velocity_class_at_suggestion TEXT;
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS actual_location_id UUID;
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS actual_location_code TEXT;
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS override_reason_code TEXT;
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS override_confidence TEXT;
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS completed_by UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_putaway_task_velocity_class_value'
      AND conrelid = 'putaway_task'::regclass
  ) THEN
    ALTER TABLE putaway_task
      ADD CONSTRAINT chk_putaway_task_velocity_class_value
      CHECK (velocity_class_at_suggestion IS NULL OR velocity_class_at_suggestion IN ('A','B','C'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_putaway_task_override_confidence'
      AND conrelid = 'putaway_task'::regclass
  ) THEN
    ALTER TABLE putaway_task
      ADD CONSTRAINT chk_putaway_task_override_confidence
      CHECK (override_confidence IS NULL OR override_confidence IN ('certain','uncertain'));
  END IF;
END $$;

-- Story 3.5: Velocity Classification for Putaway Optimization
CREATE TABLE IF NOT EXISTS velocity_class (
  sku                    TEXT NOT NULL,
  site_id                UUID NOT NULL,
  velocity_class         TEXT NOT NULL DEFAULT 'C',
  putaway_count_30d      INTEGER NOT NULL DEFAULT 0,
  override_count_30d     INTEGER NOT NULL DEFAULT 0,
  preferred_location_id  UUID,
  preferred_location_code TEXT,
  computed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_event_id        UUID,
  PRIMARY KEY (sku, site_id),
  CONSTRAINT chk_velocity_class_value CHECK (velocity_class IN ('A','B','C'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_velocity_class_value'
      AND conrelid = 'velocity_class'::regclass
  ) THEN
    ALTER TABLE velocity_class
      ADD CONSTRAINT chk_velocity_class_value CHECK (velocity_class IN ('A','B','C'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_velocity_class_site_class ON velocity_class (site_id, velocity_class);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON velocity_class TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON velocity_class TO readonly_user;
  END IF;
END $$;

-- Story 3.6: Pick Task Generation and Execution (FR-W-04). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate). deploy/compose/init-db.sql duplicates this
-- content for first-boot container init - change both files together. Every statement is idempotent.
--
-- Grain is (pick_task_id). dispatch_order_id references the Story 2.9 erp_sales_order.id surrogate
-- (added below as an additive column on the reference projection - the ERP feed's natural key stays
-- (so_number_ext, line_no); the surrogate exists so warehouse rows can carry a stable UUID).

-- Story 3.6 additive migration: a stable UUID surrogate on the Story 2.9 sales-order reference
-- projection, used as the dispatch-order identifier by pick tasks (the projection previously had
-- only the composite (so_number_ext, line_no) natural key).
ALTER TABLE IF EXISTS erp_sales_order ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_sales_order_id ON erp_sales_order (id);

-- Story 3.6 additive migration: bin pick-sequence on the warehouse topology master (AC1 requires
-- ascending bin pick-sequence within each zone; the sequence originates on the bin itself).
ALTER TABLE IF EXISTS location_register ADD COLUMN IF NOT EXISTS pick_sequence INTEGER;

CREATE TABLE IF NOT EXISTS pick_task (
  pick_task_id      UUID PRIMARY KEY,
  dispatch_order_id UUID NOT NULL,
  sku               TEXT NOT NULL,
  total_quantity    NUMERIC(14,3) NOT NULL,
  strategy          TEXT NOT NULL,
  wave_id           UUID,
  batch_id          UUID,
  zone_id           UUID NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  assigned_to       UUID,
  created_by        UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  completed_by      UUID,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_pick_task_strategy CHECK (strategy IN ('single', 'batch', 'wave', 'zone')),
  CONSTRAINT chk_pick_task_status CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_pick_task_strategy'
      AND conrelid = 'pick_task'::regclass
  ) THEN
    ALTER TABLE pick_task
      ADD CONSTRAINT chk_pick_task_strategy CHECK (strategy IN ('single', 'batch', 'wave', 'zone'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_pick_task_status'
      AND conrelid = 'pick_task'::regclass
  ) THEN
    ALTER TABLE pick_task
      ADD CONSTRAINT chk_pick_task_status CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pick_task_dispatch_order ON pick_task (dispatch_order_id);
CREATE INDEX IF NOT EXISTS idx_pick_task_zone_status ON pick_task (zone_id, status);
CREATE INDEX IF NOT EXISTS idx_pick_task_assigned_status ON pick_task (assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_pick_task_wave ON pick_task (wave_id);
CREATE INDEX IF NOT EXISTS idx_pick_task_batch ON pick_task (batch_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON pick_task TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON pick_task TO readonly_user;
  END IF;
END $$;

-- Story 3.6 (AC4 scope extension): minimal dispatch-order picked flag. No dispatch-order status
-- projection existed before this story; Story 3.7 (packing) may extend or replace it.
CREATE TABLE IF NOT EXISTS dispatch_order_status (
  dispatch_order_id UUID PRIMARY KEY,
  picked_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  picked_by         UUID NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dispatch_order_status_picked ON dispatch_order_status (picked_at);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON dispatch_order_status TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON dispatch_order_status TO readonly_user;
  END IF;
END $$;

-- Story 3.6: Pick lines - one row per directed lot within a pick task (FR-W-04). This file is the
-- CANONICAL definition, applied by src/events/migrate.ts. deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent. directed_lot_id/confirmed_lot_id are lot_master.lot_id UUIDs (NOT lot_number - the
-- stock_balance.lot_id TEXT column carries lot_number; the apply functions bridge via lot_master).

CREATE TABLE IF NOT EXISTS pick_line (
  pick_line_id           UUID PRIMARY KEY,
  pick_task_id           UUID NOT NULL REFERENCES pick_task(pick_task_id),
  dispatch_order_line_id UUID NOT NULL,
  sku                    TEXT NOT NULL,
  directed_lot_id        UUID NOT NULL,
  confirmed_lot_id       UUID,
  directed_quantity      NUMERIC(14,3) NOT NULL,
  confirmed_quantity     NUMERIC(14,3),
  location_id            UUID NOT NULL,
  pick_sequence          INTEGER NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'pending',
  override_reason        TEXT,
  capture_method         TEXT,
  confirmed_by           UUID,
  confirmed_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_pick_line_status CHECK (status IN ('pending', 'confirmed', 'cancelled', 'substituted')),
  CONSTRAINT chk_pick_line_capture_method CHECK (capture_method IS NULL OR capture_method IN ('PWA', 'PAPER'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_pick_line_status'
      AND conrelid = 'pick_line'::regclass
  ) THEN
    ALTER TABLE pick_line
      ADD CONSTRAINT chk_pick_line_status CHECK (status IN ('pending', 'confirmed', 'cancelled', 'substituted'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_pick_line_capture_method'
      AND conrelid = 'pick_line'::regclass
  ) THEN
    ALTER TABLE pick_line
      ADD CONSTRAINT chk_pick_line_capture_method CHECK (capture_method IS NULL OR capture_method IN ('PWA', 'PAPER'));
  END IF;
END $$;

-- Story 3.6 (review pass 2): the bin a confirmation actually allocated at. Completion moves stock
-- from `allocated` to `picked` at THIS bin instead of re-deriving it with a different predicate
-- than confirmation used, which could resolve to another bin (and another task's allocation) when
-- a lot is allocated across several bins. Null until the line is confirmed.
ALTER TABLE IF EXISTS pick_line ADD COLUMN IF NOT EXISTS confirmed_location_id UUID;

CREATE INDEX IF NOT EXISTS idx_pick_line_task ON pick_line (pick_task_id);
CREATE INDEX IF NOT EXISTS idx_pick_line_location_status ON pick_line (location_id, status);
CREATE INDEX IF NOT EXISTS idx_pick_line_directed_lot ON pick_line (directed_lot_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON pick_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON pick_line TO readonly_user;
  END IF;
END $$;

-- Story 3.7: packing record, dispatch document, and dispatch_order_status extension
CREATE TABLE IF NOT EXISTS packing_record (
  packing_record_id UUID PRIMARY KEY,
  dispatch_order_id UUID NOT NULL,
  sku TEXT NOT NULL,
  packed_qty NUMERIC(14,3) NOT NULL,
  lot_id UUID,
  actual_weight_kg NUMERIC(12,3),
  label_ref TEXT,
  carton_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'packed',
  packed_by UUID NOT NULL,
  packed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_packing_record_status'
  ) THEN
    ALTER TABLE packing_record ADD CONSTRAINT chk_packing_record_status
      CHECK (status IN ('packed', 'documents_generated', 'dispatched'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_packing_record_qty'
  ) THEN
    ALTER TABLE packing_record ADD CONSTRAINT chk_packing_record_qty
      CHECK (packed_qty > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_packing_record_carton'
  ) THEN
    ALTER TABLE packing_record ADD CONSTRAINT chk_packing_record_carton
      CHECK (carton_count >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_packing_record_dispatch_order ON packing_record (dispatch_order_id);
CREATE INDEX IF NOT EXISTS idx_packing_record_lot ON packing_record (lot_id);

ALTER TABLE dispatch_order_status ADD COLUMN IF NOT EXISTS packed_at TIMESTAMPTZ;
ALTER TABLE dispatch_order_status ADD COLUMN IF NOT EXISTS packed_by UUID;
ALTER TABLE dispatch_order_status ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
ALTER TABLE dispatch_order_status ADD COLUMN IF NOT EXISTS dispatched_by UUID;

CREATE TABLE IF NOT EXISTS dispatch_document (
  document_id UUID PRIMARY KEY,
  dispatch_order_id UUID NOT NULL,
  document_type TEXT NOT NULL,
  document_content TEXT,
  generated_by UUID NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_dispatch_document_type'
  ) THEN
    ALTER TABLE dispatch_document ADD CONSTRAINT chk_dispatch_document_type
      CHECK (document_type IN ('bol', 'packing_slip', 'commercial_invoice', 'label'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_dispatch_document_order ON dispatch_document (dispatch_order_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON packing_record TO app_user;
    GRANT INSERT, SELECT, UPDATE, DELETE ON dispatch_document TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON packing_record TO readonly_user;
    GRANT SELECT ON dispatch_document TO readonly_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS asn (
  asn_number_ext   TEXT PRIMARY KEY,
  po_ref_ext       TEXT NOT NULL,
  supplier_ref_ext TEXT NOT NULL,
  site_id          UUID NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open',
  source_snapshot  JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_asn_status CHECK (status IN ('open', 'closed'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asn_status'
      AND conrelid = 'asn'::regclass
  ) THEN
    ALTER TABLE asn
      ADD CONSTRAINT chk_asn_status CHECK (status IN ('open', 'closed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_asn_po_ref ON asn (po_ref_ext);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON asn TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON asn TO readonly_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS asn_line (
  asn_number_ext TEXT NOT NULL,
  line_no        INTEGER NOT NULL,
  sku            TEXT NOT NULL,
  expected_qty   NUMERIC(18,3) NOT NULL,
  lot_number     TEXT,
  serial_number  TEXT,
  expiry_date    DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (asn_number_ext, line_no)
);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON asn_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON asn_line TO readonly_user;
  END IF;
END $$;

-- ===========================================================================
-- Story 3.8: Warehouse Task Management and Productivity Tracking (FR-W-07)
-- Mirrors read/projections/weighbridge_event.sql, grn.sql, pick_task.sql,
-- putaway_task.sql, task_sla_config.sql and gate_dwell_metric.sql.
-- ===========================================================================

-- Story 3.8 additive migration: the capture instant of the weighment (AC3 gate dwell). business_date
-- is a calendar DATE and cannot express a sub-day interval; Story 3.3 already computed this instant
-- from metadata.occurred_at purely to derive business_date and then discarded it. Persisting it here
-- makes the gate-entry-to-weighbridge-acceptance dwell computable without re-reading domain_events.
-- Nullable by design: rows written before this story have no recoverable capture instant, and the
-- gate_dwell_metric view excludes them rather than inventing one.
ALTER TABLE IF EXISTS weighbridge_event ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_weighbridge_event_occurred_at ON weighbridge_event (occurred_at);

-- Story 3.8 additive migration: the capture instant of the receipt (AC3 gate dwell, GRN-fallback
-- leg). Mirrors weighbridge_event.occurred_at - business_date is a calendar DATE and cannot express
-- a sub-day interval. Set once by the header-creating line and never overwritten, exactly like every
-- other header-identity column on this table.
ALTER TABLE IF EXISTS grn ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_grn_received_at ON grn (received_at);

-- Story 4.5 additive migration: binding to a NATIVE Story 4.4 purchase order. Story 3.4 physical
-- capture only knows the Story 2.9 ERP reference (po_ref_ext matching erp_purchase_order
-- .po_number_ext), which stays authoritative for ERP-originated receipts; a GRN may carry both.
-- Nullable and first-stamp-wins (COALESCE) - a GRN never re-links to a different PO.
ALTER TABLE IF EXISTS grn ADD COLUMN IF NOT EXISTS po_id UUID;
CREATE INDEX IF NOT EXISTS idx_grn_po_id ON grn (po_id);

-- Story 3.8 additive migration: supervisor-assignable priority (AC1 requires the task board to show
-- priority alongside age and zone). Added as an ALTER rather than inside the CREATE TABLE above so
-- databases provisioned before this story gain the column too. NOT NULL with a default keeps every
-- pre-existing row valid without a backfill pass.
ALTER TABLE IF EXISTS pick_task ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';

-- Story 3.8 code review: assignment audit columns mirroring putaway_task, for the pick assign route.
ALTER TABLE IF EXISTS pick_task ADD COLUMN IF NOT EXISTS assigned_by UUID;
ALTER TABLE IF EXISTS pick_task ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_pick_task_priority'
      AND conrelid = 'pick_task'::regclass
  ) THEN
    ALTER TABLE pick_task
      ADD CONSTRAINT chk_pick_task_priority CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pick_task_priority_status ON pick_task (priority, status);

-- Story 3.8: Warehouse Task Management - additive columns for the unified task board (AC1).
-- `zone_id` is denormalized here, resolved once at suggestion time by walking
-- location_register.parent_location_id up from directed_location_id to the ancestor at level 'zone'.
-- The dashboard therefore never pays for a recursive topology join on every read. It stays nullable:
-- a putaway task has no zone until a bin has been directed for it.
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS assigned_to UUID;
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS assigned_by UUID;
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS zone_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_putaway_task_priority'
      AND conrelid = 'putaway_task'::regclass
  ) THEN
    ALTER TABLE putaway_task
      ADD CONSTRAINT chk_putaway_task_priority CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_putaway_task_priority_status ON putaway_task (priority, status);
CREATE INDEX IF NOT EXISTS idx_putaway_task_assigned_status ON putaway_task (assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_putaway_task_zone_status ON putaway_task (zone_id, status);

-- Configurable per-task-type SLA thresholds (AC1: "tasks that breach a configurable SLA threshold
-- are visually highlighted with the breached threshold shown"). Grain is
-- (site_id, task_type, zone_id), where a NULL zone_id is the site-wide default for that task type;
-- resolution is zone-specific first, site-wide fallback second, both within one site (see
-- getSlaConfig in src/read/projections/task_sla_config.ts).
--
-- site_id is part of the grain, not decoration. Code review of this story found that without it the
-- NULLS NOT DISTINCT index below permits exactly ONE null-zone row per task type for the entire
-- deployment, so a supervisor scoped to one site who omitted zone_id silently changed what counts as
-- a breach at every other site. The "site-wide default" must be scoped to an actual site to mean
-- what its name says.
--
-- Rows are written ONLY through persistEvent's task_sla_config.updated seam
-- (src/compliance/warehouse-task.ts), never by a direct handler UPDATE, so every threshold change
-- carries a domain event, an audit entry, and a server-set updated_by. No DELETE grant: a threshold
-- is superseded by a new value at the same grain, never removed.

CREATE TABLE IF NOT EXISTS task_sla_config (
  id                UUID PRIMARY KEY,
  site_id           UUID NOT NULL,
  task_type         TEXT NOT NULL,
  zone_id           UUID REFERENCES location_register(location_id),
  threshold_minutes NUMERIC(9,2) NOT NULL,
  updated_by        UUID NOT NULL,
  source_event_id   UUID,
  -- Capture instant of the event that last wrote this row; the compliance seam's upsert uses it as a
  -- replay-ordering guard so an older event cannot reinstate a superseded threshold. updated_at
  -- records when the row was written, which is a different question.
  event_occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_task_sla_config_task_type CHECK (task_type IN ('receiving', 'putaway', 'picking', 'packing')),
  CONSTRAINT chk_task_sla_config_threshold_positive CHECK (threshold_minutes > 0)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_task_sla_config_task_type'
      AND conrelid = 'task_sla_config'::regclass
  ) THEN
    ALTER TABLE task_sla_config
      ADD CONSTRAINT chk_task_sla_config_task_type CHECK (task_type IN ('receiving', 'putaway', 'picking', 'packing'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_task_sla_config_threshold_positive'
      AND conrelid = 'task_sla_config'::regclass
  ) THEN
    ALTER TABLE task_sla_config
      ADD CONSTRAINT chk_task_sla_config_threshold_positive CHECK (threshold_minutes > 0);
  END IF;
END $$;

-- NULLS NOT DISTINCT (the Story 2.9 uq_integration_exception_open convention) is what makes the
-- site-wide default row enforceable: without it, PostgreSQL treats every NULL zone_id as distinct
-- and an unbounded number of "site-wide" rows could coexist for the same task_type. This index is
-- also the ON CONFLICT target of the compliance seam's upsert. It is deliberately unqualified
-- rather than partial - task_sla_config carries no active/superseded lifecycle column, so there is
-- no predicate to make it partial by, and one row per grain unconditionally is the stronger rule.
--
-- Upgrade path for databases provisioned from the pre-review revision of this story, where the
-- table exists without site_id and carries the deployment-wide grain. The table is unreleased, so
-- any row present is development or test data with no recoverable site attribution: it is discarded
-- rather than guessed at, which converges the upgraded and freshly-created schemas on exactly the
-- same shape. The stale index must be dropped before the new one can be built.
ALTER TABLE IF EXISTS task_sla_config ADD COLUMN IF NOT EXISTS site_id UUID;
ALTER TABLE IF EXISTS task_sla_config
  ADD COLUMN IF NOT EXISTS event_occurred_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'task_sla_config'
      AND column_name = 'site_id'
      AND is_nullable = 'YES'
  ) THEN
    DELETE FROM task_sla_config WHERE site_id IS NULL;
    ALTER TABLE task_sla_config ALTER COLUMN site_id SET NOT NULL;
  END IF;
END $$;

DROP INDEX IF EXISTS uq_task_sla_config_grain;

CREATE UNIQUE INDEX IF NOT EXISTS uq_task_sla_config_grain
  ON task_sla_config (site_id, task_type, zone_id) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_task_sla_config_zone ON task_sla_config (zone_id);
CREATE INDEX IF NOT EXISTS idx_task_sla_config_site_type ON task_sla_config (site_id, task_type);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON task_sla_config TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON task_sla_config TO readonly_user;
  END IF;
END $$;

--
-- AC3 gate dwell (SM-13). Deliberately a VIEW, not a table: every column is derivable from data
-- already materialized by Stories 3.2 (gate_event), 3.3 (weighbridge_event) and 3.4 (grn), so it
-- carries no independent state, needs no apply*Projection hook, and can never drift out of sync
-- with its sources. This is the one documented exception to the projection-trio table pattern.
--
-- Dwell is measured from the gate-entry instant to the FIRST accepted weighment for the same Story
-- 3.2 binding token (correlation_id); where no weighment applies, it falls back to the first GRN
-- confirmation for that token. A reversed gate event is excluded - a reversal means the entry never
-- stood, so counting its dwell would pollute the shift median.
--
-- Rows whose token has neither an accepted weighment nor a GRN yet are still emitted, with a NULL
-- resolved_at and dwell_interval: a vehicle still in the yard is exactly the case a dwell dashboard
-- must not silently drop. percentile_cont ignores those NULLs when the median is computed.
--
-- The capture-completeness columns (challan_photo_present, weighment_present, grn_fallback_used)
-- exist for SM-C2: a dwell figure that improved because mandatory capture was skipped must be
-- visible on the same row that reports the improvement, never hidden behind it.

-- dwell_open marks a vehicle still in the yard: those rows carry an OPEN dwell measured against
-- now() so a shift of stuck vehicles breaches rather than reporting a null median and "not
-- exceeded". clock_skew_detected marks a resolved_at preceding the gate entry; that row's
-- dwell_interval is NULL so a negative interval can never drag the median down.
--
-- weighment_present asks whether an accepted weighment EXISTS, independent of whether it carries an
-- occurred_at, so a pre-migration weighment is never misreported as a skipped one. grn_fallback_used
-- means only that the dwell was RESOLVED from the GRN.
--
-- challan_photo_present is always true given gate_event's NOT NULL plus non-empty CHECK. It is kept
-- as an invariant tripwire: if either constraint is relaxed it starts varying on its own.
-- Dropped and recreated rather than CREATE OR REPLACE'd: PostgreSQL only lets CREATE OR REPLACE
-- VIEW append columns to the end of the select list, and this story's review inserted dwell_open and
-- clock_skew_detected mid-list, which fails with 42P16. The GRANT block below restores privileges.
DROP VIEW IF EXISTS gate_dwell_metric;

CREATE VIEW gate_dwell_metric AS
SELECT
  ge.gate_event_id,
  ge.correlation_id,
  ge.site_id,
  ge.site_code_ext,
  ge.business_date,
  ge.vehicle_reg_ext,
  ge.po_ref_ext,
  ge.entered_at AS gate_entered_at,
  COALESCE(wb.occurred_at, gr.received_at) AS resolved_at,
  CASE
    WHEN wb.occurred_at IS NOT NULL THEN 'weighbridge'
    WHEN gr.received_at IS NOT NULL THEN 'grn'
    ELSE NULL
  END AS resolution_source,
  CASE
    -- Truly resolved: a real resolution timestamp at or after entry.
    WHEN COALESCE(wb.occurred_at, gr.received_at) IS NOT NULL
         AND COALESCE(wb.occurred_at, gr.received_at) >= ge.entered_at
      THEN COALESCE(wb.occurred_at, gr.received_at) - ge.entered_at
    -- Clock skew: a resolution timestamp predates entry; emit NULL so the median cannot go
    -- negative, and let clock_skew_detected flag the row.
    WHEN COALESCE(wb.occurred_at, gr.received_at) IS NOT NULL
         AND COALESCE(wb.occurred_at, gr.received_at) < ge.entered_at
      THEN NULL
    -- Legacy accepted weighment with no capture instant: counted as resolved with no interval.
    -- The visit completed in the yard; reporting it as open would let a growing false breach
    -- dominate the shift median. A future entry is similarly a NULL dwell, never a negative one.
    WHEN wb.accepted_exists OR ge.entered_at > now() THEN NULL
    -- Genuinely open: no resolution, no legacy weighment, entry in the past, clamped at zero.
    ELSE GREATEST(now() - ge.entered_at, interval '0')
  END AS dwell_interval,
  -- Open only when there is no resolution at all and the entry is in the past, so an historical
  -- vehicle with a weighment row but no capture instant does not become a growing breach.
  (COALESCE(wb.occurred_at, gr.received_at) IS NULL
    AND NOT wb.accepted_exists
    AND ge.entered_at <= now()) AS dwell_open,
  (COALESCE(wb.occurred_at, gr.received_at) IS NOT NULL
    AND COALESCE(wb.occurred_at, gr.received_at) < ge.entered_at) AS clock_skew_detected,
  COALESCE(wb.accepted_exists, false) AS weighment_present,
  (wb.occurred_at IS NULL AND gr.received_at IS NOT NULL) AS grn_fallback_used,
  (ge.challan_photo_ref IS NOT NULL AND length(trim(ge.challan_photo_ref)) > 0) AS challan_photo_present
FROM gate_event ge
LEFT JOIN LATERAL (
  SELECT min(w.occurred_at) AS occurred_at,
         count(*) > 0       AS accepted_exists
    FROM weighbridge_event w
   WHERE w.correlation_id = ge.correlation_id
     AND w.status = 'accepted'
) wb ON true
LEFT JOIN LATERAL (
  SELECT g.received_at
    FROM grn g
   WHERE g.correlation_id = ge.correlation_id
     AND g.received_at IS NOT NULL
   ORDER BY g.received_at ASC
   LIMIT 1
) gr ON true
WHERE ge.status = 'open';

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT ON gate_dwell_metric TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON gate_dwell_metric TO readonly_user;
  END IF;
END $$;

-- ===========================================================================
-- Story 3.9: Forward-Pick Replenishment (FR-W-08)
-- Mirrors read/projections/location_register.sql, task_sla_config.sql,
-- forward_pick_config.sql, and replenishment_task.sql.
-- ===========================================================================

-- Widens zone_type to admit 'forward_pick' (topped-up zone) and 'reserve' (source zone). Guarded
-- DROP-then-ADD, mirroring stock_balance.sql's chk_stock_balance_allocated_within_on_hand pattern.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_location_register_zone_type'
      AND conrelid = 'location_register'::regclass
  ) THEN
    ALTER TABLE location_register DROP CONSTRAINT chk_location_register_zone_type;
  END IF;
  ALTER TABLE location_register
    ADD CONSTRAINT chk_location_register_zone_type
    CHECK (zone_type IN ('general', 'hazmat', 'quarantine', 'staging', 'forward_pick', 'reserve'));
END $$;

-- Widens task_type to admit 'replenishment', so a supervisor can configure an SLA threshold for
-- replenishment tasks through the existing PUT /api/v1/warehouse-tasks/sla-config endpoint.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_task_sla_config_task_type'
      AND conrelid = 'task_sla_config'::regclass
  ) THEN
    ALTER TABLE task_sla_config DROP CONSTRAINT chk_task_sla_config_task_type;
  END IF;
  ALTER TABLE task_sla_config
    ADD CONSTRAINT chk_task_sla_config_task_type
    CHECK (task_type IN ('receiving', 'putaway', 'picking', 'packing', 'replenishment'));
END $$;

-- SKU-per-forward-pick-zone min/max configuration. site_id is denormalized at write time from the
-- zone's own site_id (never accepted from the client) - forward_pick_config and task_sla_config are
-- twin projections, both keyed by a grain that includes a zone, both needing site_id in the grain
-- for the same reason task_sla_config's review added it there.
CREATE TABLE IF NOT EXISTS forward_pick_config (
  config_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku        TEXT NOT NULL,
  zone_id    UUID NOT NULL REFERENCES location_register(location_id),
  site_id    UUID NOT NULL,
  min_qty    NUMERIC(18,3) NOT NULL,
  max_qty    NUMERIC(18,3) NOT NULL,
  updated_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_forward_pick_config_min_non_negative CHECK (min_qty >= 0),
  CONSTRAINT chk_forward_pick_config_max_gt_min CHECK (max_qty > min_qty)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_forward_pick_config_min_non_negative'
      AND conrelid = 'forward_pick_config'::regclass
  ) THEN
    ALTER TABLE forward_pick_config
      ADD CONSTRAINT chk_forward_pick_config_min_non_negative CHECK (min_qty >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_forward_pick_config_max_gt_min'
      AND conrelid = 'forward_pick_config'::regclass
  ) THEN
    ALTER TABLE forward_pick_config
      ADD CONSTRAINT chk_forward_pick_config_max_gt_min CHECK (max_qty > min_qty);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_forward_pick_config_sku_zone ON forward_pick_config (sku, zone_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON forward_pick_config TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON forward_pick_config TO readonly_user;
  END IF;
END $$;

-- The replenishment task-board row: a SKU-zone internal-movement task, distinct from the SKU-
-- location replenishment_recommendation (Story 2.7/2.8), which has no zone concept and is never
-- itself an executable task. zone_id is already zone-level at creation time, so (unlike
-- pick_task/putaway_task) no ancestor-walk denormalization is needed for the task board.
CREATE TABLE IF NOT EXISTS replenishment_task (
  replenishment_task_id UUID PRIMARY KEY,
  sku                    TEXT NOT NULL,
  zone_id                UUID NOT NULL,
  site_id                UUID NOT NULL,
  from_location_id       UUID,
  to_location_id         UUID,
  quantity               NUMERIC(18,3) NOT NULL,
  signal_type            TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'ready',
  priority               TEXT NOT NULL DEFAULT 'normal',
  assigned_to            UUID,
  assigned_by            UUID,
  assigned_at            TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  completed_by           UUID,
  correlation_id         UUID NOT NULL,
  source_event_id        UUID NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_replenishment_task_status CHECK (status IN ('ready', 'completed', 'cancelled')),
  CONSTRAINT chk_replenishment_task_priority CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT chk_replenishment_task_signal_type CHECK (signal_type IN ('min_max', 'demand_signal')),
  CONSTRAINT chk_replenishment_task_quantity_positive CHECK (quantity > 0)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_replenishment_task_status'
      AND conrelid = 'replenishment_task'::regclass
  ) THEN
    ALTER TABLE replenishment_task
      ADD CONSTRAINT chk_replenishment_task_status CHECK (status IN ('ready', 'completed', 'cancelled'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_replenishment_task_priority'
      AND conrelid = 'replenishment_task'::regclass
  ) THEN
    ALTER TABLE replenishment_task
      ADD CONSTRAINT chk_replenishment_task_priority CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_replenishment_task_signal_type'
      AND conrelid = 'replenishment_task'::regclass
  ) THEN
    ALTER TABLE replenishment_task
      ADD CONSTRAINT chk_replenishment_task_signal_type CHECK (signal_type IN ('min_max', 'demand_signal'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_replenishment_task_quantity_positive'
      AND conrelid = 'replenishment_task'::regclass
  ) THEN
    ALTER TABLE replenishment_task
      ADD CONSTRAINT chk_replenishment_task_quantity_positive CHECK (quantity > 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_replenishment_task_open_signal
  ON replenishment_task (sku, zone_id, signal_type) WHERE status = 'ready';
CREATE INDEX IF NOT EXISTS idx_replenishment_task_site_status ON replenishment_task (site_id, status);
CREATE INDEX IF NOT EXISTS idx_replenishment_task_zone_status ON replenishment_task (zone_id, status);
CREATE INDEX IF NOT EXISTS idx_replenishment_task_assigned_status ON replenishment_task (assigned_to, status);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON replenishment_task TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON replenishment_task TO readonly_user;
  END IF;
END $$;

ALTER TABLE IF EXISTS grn_line ADD COLUMN IF NOT EXISTS cross_dock BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE IF EXISTS grn_line ADD COLUMN IF NOT EXISTS matched_dispatch_order_line_id UUID;
ALTER TABLE IF EXISTS grn_line ADD COLUMN IF NOT EXISTS cross_dock_nonqualification_reason TEXT;

ALTER TABLE IF EXISTS pick_task ADD COLUMN IF NOT EXISTS fulfillment_source TEXT NOT NULL DEFAULT 'standard';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_pick_task_fulfillment_source'
      AND conrelid = 'pick_task'::regclass
  ) THEN
    ALTER TABLE pick_task
      ADD CONSTRAINT chk_pick_task_fulfillment_source CHECK (fulfillment_source IN ('standard', 'cross_dock'));
  END IF;
END $$;

ALTER TABLE IF EXISTS pick_line ADD COLUMN IF NOT EXISTS cross_dock_task_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pick_line_cross_dock_task
  ON pick_line (cross_dock_task_id) WHERE cross_dock_task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS cross_dock_task (
  cross_dock_task_id      UUID PRIMARY KEY,
  grn_line_id             UUID NOT NULL REFERENCES grn_line(grn_line_id),
  dispatch_order_line_id  UUID NOT NULL REFERENCES erp_sales_order(id),
  sku                     TEXT NOT NULL,
  lot_id                  UUID NOT NULL REFERENCES lot_master(lot_id),
  quantity                NUMERIC(14,3) NOT NULL,
  site_id                 UUID NOT NULL REFERENCES location_register(location_id),
  from_location_id        UUID NOT NULL REFERENCES location_register(location_id),
  staging_zone_id         UUID NOT NULL REFERENCES location_register(location_id),
  to_location_id          UUID REFERENCES location_register(location_id),
  status                  TEXT NOT NULL DEFAULT 'ready',
  priority                TEXT NOT NULL DEFAULT 'normal',
  assigned_to             UUID REFERENCES users(user_id),
  assigned_by             UUID REFERENCES users(user_id),
  assigned_at             TIMESTAMPTZ,
  created_by              UUID NOT NULL REFERENCES users(user_id),
  created_at              TIMESTAMPTZ NOT NULL,
  completed_by            UUID REFERENCES users(user_id),
  completed_at            TIMESTAMPTZ,
  correlation_id          UUID NOT NULL,
  source_event_id         UUID NOT NULL,
  completion_event_id     UUID,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_cross_dock_task_grn_line UNIQUE (grn_line_id),
  CONSTRAINT chk_cross_dock_task_status CHECK (status IN ('ready', 'completed')),
  CONSTRAINT chk_cross_dock_task_priority CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT chk_cross_dock_task_quantity_positive CHECK (quantity > 0),
  CONSTRAINT chk_cross_dock_task_completion_fields CHECK (
    (status = 'ready' AND to_location_id IS NULL AND completed_by IS NULL AND completed_at IS NULL AND completion_event_id IS NULL)
    OR
    (status = 'completed' AND to_location_id IS NOT NULL AND completed_by IS NOT NULL AND completed_at IS NOT NULL AND completion_event_id IS NOT NULL)
  )
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_cross_dock_task_grn_line' AND conrelid = 'cross_dock_task'::regclass) THEN
    ALTER TABLE cross_dock_task ADD CONSTRAINT uq_cross_dock_task_grn_line UNIQUE (grn_line_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_cross_dock_task_status' AND conrelid = 'cross_dock_task'::regclass) THEN
    ALTER TABLE cross_dock_task ADD CONSTRAINT chk_cross_dock_task_status CHECK (status IN ('ready', 'completed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_cross_dock_task_priority' AND conrelid = 'cross_dock_task'::regclass) THEN
    ALTER TABLE cross_dock_task ADD CONSTRAINT chk_cross_dock_task_priority CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_cross_dock_task_quantity_positive' AND conrelid = 'cross_dock_task'::regclass) THEN
    ALTER TABLE cross_dock_task ADD CONSTRAINT chk_cross_dock_task_quantity_positive CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_cross_dock_task_completion_fields' AND conrelid = 'cross_dock_task'::regclass) THEN
    ALTER TABLE cross_dock_task ADD CONSTRAINT chk_cross_dock_task_completion_fields CHECK (
      (status = 'ready' AND to_location_id IS NULL AND completed_by IS NULL AND completed_at IS NULL AND completion_event_id IS NULL)
      OR
      (status = 'completed' AND to_location_id IS NOT NULL AND completed_by IS NOT NULL AND completed_at IS NOT NULL AND completion_event_id IS NOT NULL)
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cross_dock_task_site_status ON cross_dock_task (site_id, status);
CREATE INDEX IF NOT EXISTS idx_cross_dock_task_staging_status ON cross_dock_task (staging_zone_id, status);
CREATE INDEX IF NOT EXISTS idx_cross_dock_task_assigned_status ON cross_dock_task (assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_cross_dock_task_dispatch_status ON cross_dock_task (dispatch_order_line_id, status);
CREATE INDEX IF NOT EXISTS idx_cross_dock_task_correlation ON cross_dock_task (correlation_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON cross_dock_task TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON cross_dock_task TO readonly_user;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_pick_line_cross_dock_task'
      AND conrelid = 'pick_line'::regclass
  ) THEN
    ALTER TABLE pick_line
      ADD CONSTRAINT fk_pick_line_cross_dock_task
      FOREIGN KEY (cross_dock_task_id) REFERENCES cross_dock_task(cross_dock_task_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_task_sla_config_task_type'
      AND conrelid = 'task_sla_config'::regclass
  ) THEN
    ALTER TABLE task_sla_config DROP CONSTRAINT chk_task_sla_config_task_type;
  END IF;
  ALTER TABLE task_sla_config
    ADD CONSTRAINT chk_task_sla_config_task_type
    CHECK (task_type IN ('receiving', 'putaway', 'picking', 'packing', 'replenishment', 'cross_docking'));
END $$;

-- ============================================================================
-- Story 4.1: Supplier Registry and Onboarding
-- MUST stay identical to read/projections/supplier.sql (canonical source).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS supplier (
  supplier_id                  UUID PRIMARY KEY,
  legal_name                   TEXT NOT NULL,
  owner_party_code             TEXT NOT NULL,
  gstin_ext                    TEXT,
  pan_ext                      TEXT,
  contacts                     JSONB NOT NULL DEFAULT '[]'::jsonb,
  credit_period_days           INTEGER NOT NULL DEFAULT 0,
  commercial_terms             TEXT,
  freight_terms                TEXT,
  delivery_terms               TEXT,
  certification_references     JSONB NOT NULL DEFAULT '[]'::jsonb,
  status                       TEXT NOT NULL DEFAULT 'onboarding',
  deactivation_reason_code     TEXT,
  deactivated_at               TIMESTAMPTZ,
  onboarding_submitted_at      TIMESTAMPTZ,
  onboarding_approved_at       TIMESTAMPTZ,
  onboarding_approved_by       UUID,
  onboarding_rejection_reason  TEXT,
  created_by                   UUID NOT NULL,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_supplier_status CHECK (status IN ('onboarding', 'active', 'inactive')),
  CONSTRAINT chk_supplier_credit_period_non_negative CHECK (credit_period_days >= 0),
  CONSTRAINT chk_supplier_deactivation_reason CHECK (
    deactivation_reason_code IS NULL
    OR deactivation_reason_code IN ('fraud', 'business_closure', 'duplicate', 'compliance_failure', 'voluntary')
  ),
  CONSTRAINT chk_supplier_owner_party_code CHECK (owner_party_code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_gstin ON supplier (gstin_ext) WHERE status IN ('onboarding', 'active');
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_owner_party_code ON supplier (owner_party_code);
CREATE INDEX IF NOT EXISTS idx_supplier_legal_name_trgm ON supplier USING gin (legal_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_supplier_owner_party_code_trgm ON supplier USING gin (owner_party_code gin_trgm_ops);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_status'
      AND conrelid = 'supplier'::regclass
  ) THEN
    ALTER TABLE supplier
      ADD CONSTRAINT chk_supplier_status CHECK (status IN ('onboarding', 'active', 'inactive'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_credit_period_non_negative'
      AND conrelid = 'supplier'::regclass
  ) THEN
    ALTER TABLE supplier
      ADD CONSTRAINT chk_supplier_credit_period_non_negative CHECK (credit_period_days >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_deactivation_reason'
      AND conrelid = 'supplier'::regclass
  ) THEN
    ALTER TABLE supplier
      ADD CONSTRAINT chk_supplier_deactivation_reason CHECK (
        deactivation_reason_code IS NULL
        OR deactivation_reason_code IN ('fraud', 'business_closure', 'duplicate', 'compliance_failure', 'voluntary')
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_owner_party_code'
      AND conrelid = 'supplier'::regclass
  ) THEN
    ALTER TABLE supplier
      ADD CONSTRAINT chk_supplier_owner_party_code CHECK (owner_party_code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON supplier TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON supplier TO readonly_user;
  END IF;
END $$;

-- Story 4.6 additive migration: MSME compliance fields (Udyam registration, classification,
-- revalidation lifecycle). msme_status is a SEPARATE axis from supplier.status - the supplier
-- lifecycle gates (SUPPLIER_NOT_ACTIVE) never read it and chk_supplier_status is untouched.
-- Set exclusively by supplier.msme_verified / supplier.msme_suspended events via persistEvent.
-- Note: supplier.msme_classification is restricted to ('micro','small','medium') because the
-- column is null when the supplier is not currently MSME-flagged. supplier_invoice carries
-- 'not_msme' as a fourth value to preserve the capture-time classification when a supplier
-- loses MSME status after invoicing; do not align these vocabularies.
ALTER TABLE IF EXISTS supplier ADD COLUMN IF NOT EXISTS udyam_number_ext TEXT;
ALTER TABLE IF EXISTS supplier ADD COLUMN IF NOT EXISTS msme_classification TEXT;
ALTER TABLE IF EXISTS supplier ADD COLUMN IF NOT EXISTS msme_certificate_reference TEXT;
ALTER TABLE IF EXISTS supplier ADD COLUMN IF NOT EXISTS msme_status TEXT;
ALTER TABLE IF EXISTS supplier ADD COLUMN IF NOT EXISTS udyam_verified_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS supplier ADD COLUMN IF NOT EXISTS udyam_revalidation_due_date DATE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_msme_classification'
      AND conrelid = 'supplier'::regclass
  ) THEN
    ALTER TABLE supplier
      ADD CONSTRAINT chk_supplier_msme_classification CHECK (
        msme_classification IS NULL OR msme_classification IN ('micro', 'small', 'medium')
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_msme_status'
      AND conrelid = 'supplier'::regclass
  ) THEN
    ALTER TABLE supplier
      ADD CONSTRAINT chk_supplier_msme_status CHECK (
        msme_status IS NULL OR msme_status IN ('active', 'suspended-pending-reverification')
      );
  END IF;
END $$;

-- MUST stay identical to read/projections/indent.sql (canonical source).
-- Purchase requisition (indent) read model (Story 4.3). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries
-- its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as
-- app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a live database
-- safely.
--
-- Derived state ONLY: rows are rebuildable by replaying indent.* domain events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert. Status vocabulary is the six AC-4 values plus
-- 'pending-confirmation' (AC 3 duplicate hold, hyphenated exactly as the AC spells it). The
-- rejection-reason CHECK enforces AC 5's mandatory reason at the database level. The partial
-- duplicate-detection index idx_indent_dup_window serves the AC 2 / AC 3 open-window lookup by
-- requester over open statuses only.

CREATE TABLE IF NOT EXISTS indent (
  indent_id                UUID PRIMARY KEY,
  indent_number_ext        TEXT NOT NULL,
  requester_user_id        UUID NOT NULL,
  department_code          TEXT NOT NULL,
  site_id                  UUID NOT NULL,
  business_stream          TEXT NOT NULL,
  need_by_date             DATE NOT NULL,
  urgent                   BOOLEAN NOT NULL DEFAULT false,
  reason                   TEXT,
  estimated_value          NUMERIC(18,4) NOT NULL DEFAULT 0,
  status                   TEXT NOT NULL DEFAULT 'raised',
  approver_actor_id        UUID,
  doa_entry_id             UUID,
  decided_at               TIMESTAMPTZ,
  decided_by               UUID,
  rejection_reason         TEXT,
  duplicate_of_indent_id   UUID,
  cancelled_reason         TEXT,
  expected_delivery_date   DATE,
  purchase_order_id        UUID,
  correlation_id           UUID,
  source_event_id          UUID NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_indent_status CHECK (status IN ('raised','pending-confirmation','approved','rejected','ordered','cancelled','closed')),
  CONSTRAINT chk_indent_rejection_reason CHECK (status <> 'rejected' OR (rejection_reason IS NOT NULL AND btrim(rejection_reason) <> '')),
  CONSTRAINT chk_indent_estimated_value_non_negative CHECK (estimated_value >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_indent_number_ext ON indent (indent_number_ext);
CREATE INDEX IF NOT EXISTS idx_indent_dup_window ON indent (requester_user_id, created_at DESC) WHERE status IN ('raised','pending-confirmation','approved');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_indent_status'
      AND conrelid = 'indent'::regclass
  ) THEN
    ALTER TABLE indent
      ADD CONSTRAINT chk_indent_status CHECK (status IN ('raised','pending-confirmation','approved','rejected','ordered','cancelled','closed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_indent_rejection_reason'
      AND conrelid = 'indent'::regclass
  ) THEN
    ALTER TABLE indent
      ADD CONSTRAINT chk_indent_rejection_reason CHECK (status <> 'rejected' OR (rejection_reason IS NOT NULL AND btrim(rejection_reason) <> ''));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_indent_estimated_value_non_negative'
      AND conrelid = 'indent'::regclass
  ) THEN
    ALTER TABLE indent
      ADD CONSTRAINT chk_indent_estimated_value_non_negative CHECK (estimated_value >= 0);
  END IF;
END $$;

-- Server-side human-ID allocation for the IND-YYYY-NNNN format (Task 5). A sequence is the only
-- lock-free allocator that survives concurrent raises; the year prefix is applied in the raise
-- handler. Gaps on rolled-back raises are acceptable - uniqueness is what matters.
CREATE SEQUENCE IF NOT EXISTS indent_number_seq;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON indent TO app_user;
    GRANT USAGE ON SEQUENCE indent_number_seq TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON indent TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/indent_line.sql (canonical source).
-- Purchase requisition (indent) line read model (Story 4.3). CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate); deploy/compose/init-db.sql duplicates this content
-- for first-boot container init - change both files together. Every statement is idempotent.
--
-- Derived state ONLY: rows are rebuildable by replaying indent.* domain events; mutation happens
-- exclusively through persistEvent inside the same transaction as the domain_events insert.
-- Follows the grn.sql / grn_line.sql header-plus-line precedent.

CREATE TABLE IF NOT EXISTS indent_line (
  indent_line_id       UUID PRIMARY KEY,
  indent_id            UUID NOT NULL,
  line_no              INTEGER NOT NULL,
  sku                  TEXT NOT NULL,
  item_category        TEXT NOT NULL,
  requested_qty        NUMERIC(18,3) NOT NULL,
  uom                  TEXT NOT NULL,
  unit_price_estimate  NUMERIC(18,4),
  line_value           NUMERIC(18,4) NOT NULL DEFAULT 0,
  CONSTRAINT uq_indent_line_no UNIQUE (indent_id, line_no),
  CONSTRAINT chk_indent_line_qty_positive CHECK (requested_qty > 0)
);

CREATE INDEX IF NOT EXISTS idx_indent_line_sku ON indent_line (sku);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_indent_line_qty_positive'
      AND conrelid = 'indent_line'::regclass
  ) THEN
    ALTER TABLE indent_line
      ADD CONSTRAINT chk_indent_line_qty_positive CHECK (requested_qty > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_indent_line_no'
      AND conrelid = 'indent_line'::regclass
  ) THEN
    ALTER TABLE indent_line
      ADD CONSTRAINT uq_indent_line_no UNIQUE (indent_id, line_no);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON indent_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON indent_line TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/purchase_order.sql (canonical source).
-- Purchase order read model (Story 4.4). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries
-- its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as
-- app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a live database
-- safely.
--
-- Derived state ONLY: rows are rebuildable by replaying purchase_order.* domain events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert. Status vocabulary is the six AC values
-- (draft, pending-approval, approved, rejected, issued, confirmed). The ceiling_value column is
-- required for blanket/contract POs (PO_CEILING_REQUIRED enforced in the seam). released_value
-- tracks cumulative releases against the ceiling (PO_CEILING_EXCEEDED). Payment terms default
-- from the supplier record at draft (Story 4.1 contract).

CREATE TABLE IF NOT EXISTS purchase_order (
  po_id                  UUID PRIMARY KEY,
  po_number_ext          TEXT NOT NULL,
  po_type                TEXT NOT NULL,
  supplier_id            UUID NOT NULL,
  indent_id              UUID NOT NULL,
  site_id                UUID NOT NULL,
  business_stream        TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'draft',
  total_value            NUMERIC(14,2) NOT NULL DEFAULT 0,
  ceiling_value          NUMERIC(14,2),
  released_value         NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency               TEXT NOT NULL DEFAULT 'INR',
  payment_terms          TEXT,
  created_by             UUID NOT NULL,
  approver_actor_id      UUID,
  doa_entry_id           UUID,
  decided_at             TIMESTAMPTZ,
  decided_by             UUID,
  rejection_reason       TEXT,
  issued_at              TIMESTAMPTZ,
  confirmed_at           TIMESTAMPTZ,
  promised_delivery_date DATE,
  correlation_id         UUID,
  source_event_id        UUID NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_po_type CHECK (po_type IN ('standard','blanket','contract')),
  CONSTRAINT chk_po_status CHECK (status IN ('draft','pending-approval','approved','rejected','issued','confirmed')),
  CONSTRAINT chk_po_total_value_non_negative CHECK (total_value >= 0),
  CONSTRAINT chk_po_released_value_non_negative CHECK (released_value >= 0),
  CONSTRAINT chk_po_ceiling_covers_released CHECK (ceiling_value IS NULL OR ceiling_value >= released_value),
  CONSTRAINT chk_po_rejection_reason CHECK (status <> 'rejected' OR (rejection_reason IS NOT NULL AND btrim(rejection_reason) <> ''))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_po_number_ext ON purchase_order (po_number_ext);
CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_order (supplier_id);
CREATE INDEX IF NOT EXISTS idx_po_indent ON purchase_order (indent_id);
CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_order (status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_po_type'
      AND conrelid = 'purchase_order'::regclass
  ) THEN
    ALTER TABLE purchase_order
      ADD CONSTRAINT chk_po_type CHECK (po_type IN ('standard','blanket','contract'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_po_status'
      AND conrelid = 'purchase_order'::regclass
  ) THEN
    ALTER TABLE purchase_order
      ADD CONSTRAINT chk_po_status CHECK (status IN ('draft','pending-approval','approved','rejected','issued','confirmed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_po_total_value_non_negative'
      AND conrelid = 'purchase_order'::regclass
  ) THEN
    ALTER TABLE purchase_order
      ADD CONSTRAINT chk_po_total_value_non_negative CHECK (total_value >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_po_released_value_non_negative'
      AND conrelid = 'purchase_order'::regclass
  ) THEN
    ALTER TABLE purchase_order
      ADD CONSTRAINT chk_po_released_value_non_negative CHECK (released_value >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_po_ceiling_covers_released'
      AND conrelid = 'purchase_order'::regclass
  ) THEN
    ALTER TABLE purchase_order
      ADD CONSTRAINT chk_po_ceiling_covers_released CHECK (ceiling_value IS NULL OR ceiling_value >= released_value);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_po_rejection_reason'
      AND conrelid = 'purchase_order'::regclass
  ) THEN
    ALTER TABLE purchase_order
      ADD CONSTRAINT chk_po_rejection_reason CHECK (status <> 'rejected' OR (rejection_reason IS NOT NULL AND btrim(rejection_reason) <> ''));
  END IF;
END $$;

CREATE SEQUENCE IF NOT EXISTS po_number_seq;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON purchase_order TO app_user;
    GRANT USAGE ON SEQUENCE po_number_seq TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON purchase_order TO readonly_user;
  END IF;
END $$;

-- Story 4.6 additive migration: statutory MSME payment due date stamped at PO confirmation
-- (MSMED 2006 s.15: earlier of the agreed date and 45 days; 15-day appointed-day rule when no
-- agreement exists). Null for non-MSME suppliers. statutory_due_rule_version records the dated
-- statutory configuration the stamp was computed under. Header only - lines carry no due date.
ALTER TABLE IF EXISTS purchase_order ADD COLUMN IF NOT EXISTS statutory_due_date DATE;
ALTER TABLE IF EXISTS purchase_order ADD COLUMN IF NOT EXISTS statutory_due_rule_version TEXT;

-- MUST stay identical to read/projections/purchase_order_line.sql (canonical source).
-- Purchase order line read model (Story 4.4). CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate); deploy/compose/init-db.sql duplicates this content
-- for first-boot container init - change both files together. Every statement is idempotent.
--
-- Derived state ONLY: rows are rebuildable by replaying purchase_order.* domain events; mutation happens
-- exclusively through persistEvent inside the same transaction as the domain_events insert.
-- Follows the indent.sql / indent_line.sql header-plus-line precedent. No FK to purchase_order
-- (same-transaction inserts; matches the indent_line design decision on the deferred ledger).

CREATE TABLE IF NOT EXISTS purchase_order_line (
  po_line_id             UUID PRIMARY KEY,
  po_id                  UUID NOT NULL,
  line_no                INTEGER NOT NULL,
  sku                    TEXT NOT NULL,
  item_category          TEXT NOT NULL,
  ordered_qty            NUMERIC(14,3) NOT NULL,
  uom                    TEXT NOT NULL,
  unit_price             NUMERIC(14,4) NOT NULL,
  tax_rate_pct           NUMERIC(5,2),
  line_value             NUMERIC(14,2) NOT NULL DEFAULT 0,
  promised_delivery_date DATE,
  CONSTRAINT uq_po_line_no UNIQUE (po_id, line_no),
  CONSTRAINT chk_po_line_qty_positive CHECK (ordered_qty > 0),
  CONSTRAINT chk_po_line_unit_price_non_negative CHECK (unit_price >= 0)
);

CREATE INDEX IF NOT EXISTS idx_po_line_sku ON purchase_order_line (sku);
CREATE INDEX IF NOT EXISTS idx_po_line_po_id ON purchase_order_line (po_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_po_line_qty_positive'
      AND conrelid = 'purchase_order_line'::regclass
  ) THEN
    ALTER TABLE purchase_order_line
      ADD CONSTRAINT chk_po_line_qty_positive CHECK (ordered_qty > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_po_line_no'
      AND conrelid = 'purchase_order_line'::regclass
  ) THEN
    ALTER TABLE purchase_order_line
      ADD CONSTRAINT uq_po_line_no UNIQUE (po_id, line_no);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_po_line_unit_price_non_negative'
      AND conrelid = 'purchase_order_line'::regclass
  ) THEN
    ALTER TABLE purchase_order_line
      ADD CONSTRAINT chk_po_line_unit_price_non_negative CHECK (unit_price >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON purchase_order_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON purchase_order_line TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/po_outbound_message.sql (canonical source).
-- PO outbound message record (Story 4.4). CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate); deploy/compose/init-db.sql duplicates this content
-- for first-boot container init - change both files together. Every statement is idempotent.
--
-- Derived state ONLY: the row is written atomically with purchase_order.issued inside the SAME
-- persistEvent transaction. This is the ERP adapter boundary record (AC3 verification contract) -
-- the adapter records the payload durably; live transmission is per-deployment configuration and
-- is NOT implemented here. Distinct from erp_purchase_order (Story 2.9 read-only inbound reference).

CREATE TABLE IF NOT EXISTS po_outbound_message (
  message_id    UUID PRIMARY KEY,
  po_id         UUID NOT NULL,
  payload       JSONB NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_outbound_po_id ON po_outbound_message (po_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON po_outbound_message TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON po_outbound_message TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/bom.sql (canonical source).
-- Bill of Materials (BOM) read model (Story 5.1). CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate); deploy/compose/init-db.sql duplicates this content
-- for first-boot container init - change both files together. Every statement is idempotent.

CREATE TABLE IF NOT EXISTS bom (
  bom_id                UUID PRIMARY KEY,
  parent_item_id        UUID NOT NULL,
  parent_sku            TEXT NOT NULL,
  parent_uom            TEXT NOT NULL,
  business_stream       TEXT NOT NULL,
  bom_type              TEXT NOT NULL DEFAULT 'production',
  status                TEXT NOT NULL DEFAULT 'draft',
  current_revision_id   UUID,
  blocking_line_count   INTEGER NOT NULL DEFAULT 0,
  status_changed_at     TIMESTAMPTZ,
  status_changed_by     UUID,
  origin                TEXT NOT NULL DEFAULT 'native',
  remediation_flag      BOOLEAN NOT NULL DEFAULT false,
  kit_ref               TEXT,
  created_by            UUID NOT NULL,
  correlation_id        UUID,
  source_event_id       UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bom_type CHECK (bom_type IN ('production','rnd','job_work_kit')),
  CONSTRAINT chk_bom_status CHECK (status IN ('draft','released','on_hold','obsolete')),
  CONSTRAINT chk_bom_origin CHECK (origin IN ('native','legacy_kit'))
);

-- Story 5.2 lifecycle/migration columns for databases created before this story
-- (CREATE TABLE IF NOT EXISTS alone will not add columns to an existing table).
ALTER TABLE bom ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;
ALTER TABLE bom ADD COLUMN IF NOT EXISTS status_changed_by UUID;
ALTER TABLE bom ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'native';
ALTER TABLE bom ADD COLUMN IF NOT EXISTS remediation_flag BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE bom ADD COLUMN IF NOT EXISTS kit_ref TEXT;

-- Story 5.4 R&D provenance columns: cloned_from_bom_id records the production (or R&D) BOM an R&D
-- draft was cloned from (FR-B-10); productized_from_bom_id records the R&D draft a production BOM
-- was productized from (FR-B-11). These are the machine-checkable lineage the tests assert.
ALTER TABLE bom ADD COLUMN IF NOT EXISTS cloned_from_bom_id UUID;
ALTER TABLE bom ADD COLUMN IF NOT EXISTS productized_from_bom_id UUID;

-- Story 5.2 widens chk_bom_status on live databases: drop the Story 5.1 single-value CHECK and
-- re-add with the full lifecycle vocabulary. Wrapped in a DO block so the DROP + ADD pair is
-- atomic - init-db.sql runs statement-by-statement under autocommit, and a failure between the
-- two would otherwise leave the status column unconstrained until a re-run.
DO $$
BEGIN
  ALTER TABLE bom DROP CONSTRAINT IF EXISTS chk_bom_status;
  ALTER TABLE bom ADD CONSTRAINT chk_bom_status CHECK (status IN ('draft','released','on_hold','obsolete'));
END $$;

-- Story 5.4 swaps uq_bom_parent_item to a PARTIAL unique index: production and job_work_kit BOMs
-- keep one-per-item uniqueness; R&D drafts (bom_type = 'rnd') may be many per item, which is what
-- makes cloning (FR-B-10) and parallel draft iteration possible. DROP + CREATE pair is re-runnable.
DROP INDEX IF EXISTS uq_bom_parent_item;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_parent_item ON bom (parent_item_id) WHERE bom_type <> 'rnd';
CREATE INDEX IF NOT EXISTS idx_bom_status ON bom (status);
CREATE INDEX IF NOT EXISTS idx_bom_business_stream ON bom (business_stream);
CREATE INDEX IF NOT EXISTS idx_bom_parent_item_id ON bom (parent_item_id);
CREATE INDEX IF NOT EXISTS idx_bom_blocking ON bom (blocking_line_count) WHERE blocking_line_count > 0;
CREATE INDEX IF NOT EXISTS idx_bom_cloned_from ON bom (cloned_from_bom_id);
CREATE INDEX IF NOT EXISTS idx_bom_productized_from ON bom (productized_from_bom_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_type'
      AND conrelid = 'bom'::regclass
  ) THEN
    ALTER TABLE bom
      ADD CONSTRAINT chk_bom_type CHECK (bom_type IN ('production','rnd','job_work_kit'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_status'
      AND conrelid = 'bom'::regclass
  ) THEN
    ALTER TABLE bom
      ADD CONSTRAINT chk_bom_status CHECK (status IN ('draft','released','on_hold','obsolete'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_origin'
      AND conrelid = 'bom'::regclass
  ) THEN
    ALTER TABLE bom
      ADD CONSTRAINT chk_bom_origin CHECK (origin IN ('native','legacy_kit'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON bom TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON bom TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/bom_revision.sql (canonical source).

CREATE TABLE IF NOT EXISTS bom_revision (
  revision_id       UUID PRIMARY KEY,
  bom_id            UUID NOT NULL,
  revision_code     TEXT NOT NULL,
  revision_status   TEXT NOT NULL DEFAULT 'draft',
  drafted_by        UUID NOT NULL,
  drafted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at       TIMESTAMPTZ,
  released_by       UUID,
  source_event_id   UUID NOT NULL,
  CONSTRAINT chk_bom_revision_status CHECK (revision_status IN ('draft','released'))
);

-- Story 5.2 release columns for databases created before this story.
ALTER TABLE bom_revision ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;
ALTER TABLE bom_revision ADD COLUMN IF NOT EXISTS released_by UUID;

-- Story 5.3: the ECO (if any) whose implementation created this revision.
ALTER TABLE bom_revision ADD COLUMN IF NOT EXISTS source_eco_id UUID;
CREATE INDEX IF NOT EXISTS idx_bom_revision_source_eco ON bom_revision (source_eco_id);

-- Story 5.2 widens chk_bom_revision_status on live databases. DROP + ADD wrapped in a DO block
-- for atomicity - init-db.sql runs statement-by-statement under autocommit.
DO $$
BEGIN
  ALTER TABLE bom_revision DROP CONSTRAINT IF EXISTS chk_bom_revision_status;
  ALTER TABLE bom_revision ADD CONSTRAINT chk_bom_revision_status CHECK (revision_status IN ('draft','released'));
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_revision_code ON bom_revision (bom_id, revision_code);
CREATE INDEX IF NOT EXISTS idx_bom_revision_bom_id ON bom_revision (bom_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_revision_status'
      AND conrelid = 'bom_revision'::regclass
  ) THEN
    ALTER TABLE bom_revision
      ADD CONSTRAINT chk_bom_revision_status CHECK (revision_status IN ('draft','released'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON bom_revision TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON bom_revision TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/bom_line.sql (canonical source).

CREATE TABLE IF NOT EXISTS bom_line (
  bom_line_id              UUID PRIMARY KEY,
  revision_id              UUID NOT NULL,
  bom_id                   UUID NOT NULL,
  line_no                  INTEGER NOT NULL,
  component_item_id        UUID,
  component_sku            TEXT,
  is_placeholder           BOOLEAN NOT NULL DEFAULT false,
  free_text                TEXT,
  output_class             TEXT NOT NULL DEFAULT 'component',
  quantity_per             NUMERIC(18,6) NOT NULL,
  line_uom                 TEXT NOT NULL,
  uom_conversion_factor    NUMERIC(18,8) NOT NULL,
  base_quantity_per        NUMERIC(18,6) NOT NULL,
  scrap_percent            NUMERIC(7,4),
  expected_yield_percent   NUMERIC(7,4),
  is_phantom               BOOLEAN NOT NULL DEFAULT false,
  phantom_source_bom_id    UUID,
  supply_method            TEXT NOT NULL DEFAULT 'directed_issue',
  supply_source            TEXT,
  is_released_structure    BOOLEAN NOT NULL DEFAULT false,
  effective_from           DATE NOT NULL,
  effective_to            DATE,
  blocking_release         BOOLEAN NOT NULL DEFAULT false,
  blocking_reason          TEXT,
  amended_at               TIMESTAMPTZ,
  source_event_id          UUID NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bom_line_output_class CHECK (output_class IN ('component','co_product','by_product')),
  CONSTRAINT chk_bom_line_scrap_percent CHECK (scrap_percent IS NULL OR (scrap_percent >= 0 AND scrap_percent <= 100)),
  CONSTRAINT chk_bom_line_quantity_positive CHECK (quantity_per > 0),
  CONSTRAINT chk_bom_line_conversion_positive CHECK (uom_conversion_factor > 0),
  CONSTRAINT chk_bom_line_yield_required CHECK (
    (output_class = 'component' AND expected_yield_percent IS NULL) OR
    (output_class IN ('co_product','by_product') AND expected_yield_percent IS NOT NULL)
  ),
  CONSTRAINT chk_bom_line_effectivity_order CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT chk_bom_line_phantom_pairing CHECK (
    (is_phantom = true AND phantom_source_bom_id IS NOT NULL) OR
    (is_phantom = false AND phantom_source_bom_id IS NULL)
  ),
  CONSTRAINT chk_bom_line_blocking_reason CHECK (
    (blocking_release = true AND blocking_reason IS NOT NULL AND btrim(blocking_reason) <> '') OR
    (blocking_release = false AND blocking_reason IS NULL)
  ),
  CONSTRAINT chk_bom_line_placeholder_pairing CHECK (
    (is_placeholder = true AND component_item_id IS NULL AND component_sku IS NULL AND free_text IS NOT NULL AND btrim(free_text) <> '') OR
    (is_placeholder = false AND component_item_id IS NOT NULL AND component_sku IS NOT NULL)
  ),
  CONSTRAINT chk_bom_line_supply_method CHECK (supply_method IN ('directed_issue','backflush')),
  CONSTRAINT chk_bom_line_supply_source CHECK (supply_source IS NULL OR supply_source IN ('company','customer','job_worker'))
);

-- Story 5.4 placeholder/free-text columns for databases created before this story. The NOT NULL
-- drop on component identity is DB-wide because a CHECK cannot see bom.bom_type; the applier guard
-- (RD_PLACEHOLDER_NOT_PERMITTED in src/compliance/bom.ts) is what keeps placeholders off
-- production BOMs. quantity_per / line_uom / uom_conversion_factor / base_quantity_per stay
-- NOT NULL - a placeholder still consumes a quantity in a unit; only item identity is unknown.
ALTER TABLE bom_line ALTER COLUMN component_item_id DROP NOT NULL;
ALTER TABLE bom_line ALTER COLUMN component_sku DROP NOT NULL;
ALTER TABLE bom_line ADD COLUMN IF NOT EXISTS is_placeholder BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE bom_line ADD COLUMN IF NOT EXISTS free_text TEXT;

-- Story 5.4 placeholder pairing: DROP + ADD pair kept atomic in a DO block, mirroring the
-- chk_bom_status swap pattern in bom.sql.
DO $$
BEGIN
  ALTER TABLE bom_line DROP CONSTRAINT IF EXISTS chk_bom_line_placeholder_pairing;
  ALTER TABLE bom_line ADD CONSTRAINT chk_bom_line_placeholder_pairing CHECK (
    (is_placeholder = true AND component_item_id IS NULL AND component_sku IS NULL AND free_text IS NOT NULL AND btrim(free_text) <> '') OR
    (is_placeholder = false AND component_item_id IS NOT NULL AND component_sku IS NOT NULL)
  );
END $$;

-- Story 5.5 supply method: how execution consumes this component (FR-B-07). 'directed_issue' is
-- the default so every pre-5.5 line keeps its existing behaviour; 'backflush' lines are consumed
-- implicitly at completion. The DROP + ADD pair is kept atomic in a DO block, mirroring the
-- chk_bom_line_placeholder_pairing swap above.
ALTER TABLE bom_line ADD COLUMN IF NOT EXISTS supply_method TEXT NOT NULL DEFAULT 'directed_issue';

DO $$
BEGIN
  ALTER TABLE bom_line DROP CONSTRAINT IF EXISTS chk_bom_line_supply_method;
  ALTER TABLE bom_line ADD CONSTRAINT chk_bom_line_supply_method CHECK (supply_method IN ('directed_issue','backflush'));
END $$;

-- Story 5.6 supply source: who owns the material on a job-work kit BOM (FR-B-16) - 'company',
-- 'customer' or 'job_worker'. A DIFFERENT axis from supply_method (how execution consumes the
-- component); never derive one from the other. NULL is legal at the column level because only
-- bom_type = 'job_work_kit' BOMs carry supply-source tags; the not-null requirement for kit BOMs
-- is enforced by the release gate (supply_source_missing), not by this constraint. The DROP + ADD
-- pair is kept atomic in a DO block, mirroring the chk_bom_line_supply_method swap above.
ALTER TABLE bom_line ADD COLUMN IF NOT EXISTS supply_source TEXT;

DO $$
BEGIN
  ALTER TABLE bom_line DROP CONSTRAINT IF EXISTS chk_bom_line_supply_source;
  ALTER TABLE bom_line ADD CONSTRAINT chk_bom_line_supply_source CHECK (supply_source IS NULL OR supply_source IN ('company','customer','job_worker'));
END $$;

-- Story 5.5 review (sync scoping): released_bom_structure PowerSync bucket filter marker, mirroring
-- read/projections/bom_line.sql. Maintained by updateBomStatus; backfill keeps released structure
-- visible on upgraded deployments.
ALTER TABLE bom_line ADD COLUMN IF NOT EXISTS is_released_structure BOOLEAN NOT NULL DEFAULT false;

UPDATE bom_line SET is_released_structure = true, updated_at = now()
 WHERE revision_id IN (
   SELECT br.revision_id FROM bom_revision br JOIN bom b ON b.bom_id = br.bom_id
    WHERE br.revision_status = 'released' AND b.status = 'released'
 );

CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_line_no ON bom_line (revision_id, line_no);
CREATE INDEX IF NOT EXISTS idx_bom_line_component_item ON bom_line (component_item_id);
CREATE INDEX IF NOT EXISTS idx_bom_line_bom_id ON bom_line (bom_id);
CREATE INDEX IF NOT EXISTS idx_bom_line_blocking ON bom_line (blocking_release) WHERE blocking_release = true;
CREATE INDEX IF NOT EXISTS idx_bom_line_effective ON bom_line (component_item_id, effective_from, effective_to);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_line_output_class'
      AND conrelid = 'bom_line'::regclass
  ) THEN
    ALTER TABLE bom_line
      ADD CONSTRAINT chk_bom_line_output_class CHECK (output_class IN ('component','co_product','by_product'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_line_scrap_percent'
      AND conrelid = 'bom_line'::regclass
  ) THEN
    ALTER TABLE bom_line
      ADD CONSTRAINT chk_bom_line_scrap_percent CHECK (scrap_percent IS NULL OR (scrap_percent >= 0 AND scrap_percent <= 100));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_line_quantity_positive'
      AND conrelid = 'bom_line'::regclass
  ) THEN
    ALTER TABLE bom_line
      ADD CONSTRAINT chk_bom_line_quantity_positive CHECK (quantity_per > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_line_conversion_positive'
      AND conrelid = 'bom_line'::regclass
  ) THEN
    ALTER TABLE bom_line
      ADD CONSTRAINT chk_bom_line_conversion_positive CHECK (uom_conversion_factor > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_line_yield_required'
      AND conrelid = 'bom_line'::regclass
  ) THEN
    ALTER TABLE bom_line
      ADD CONSTRAINT chk_bom_line_yield_required CHECK (
        (output_class = 'component' AND expected_yield_percent IS NULL) OR
        (output_class IN ('co_product','by_product') AND expected_yield_percent IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_line_effectivity_order'
      AND conrelid = 'bom_line'::regclass
  ) THEN
    ALTER TABLE bom_line
      ADD CONSTRAINT chk_bom_line_effectivity_order CHECK (effective_to IS NULL OR effective_to >= effective_from);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_line_phantom_pairing'
      AND conrelid = 'bom_line'::regclass
  ) THEN
    ALTER TABLE bom_line
      ADD CONSTRAINT chk_bom_line_phantom_pairing CHECK (
        (is_phantom = true AND phantom_source_bom_id IS NOT NULL) OR
        (is_phantom = false AND phantom_source_bom_id IS NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_line_blocking_reason'
      AND conrelid = 'bom_line'::regclass
  ) THEN
    ALTER TABLE bom_line
      ADD CONSTRAINT chk_bom_line_blocking_reason CHECK (
        (blocking_release = true AND blocking_reason IS NOT NULL AND btrim(blocking_reason) <> '') OR
        (blocking_release = false AND blocking_reason IS NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON bom_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON bom_line TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/bom_structure.sql (canonical source).

CREATE TABLE IF NOT EXISTS bom_structure (
  structure_id           UUID PRIMARY KEY,
  bom_id                 UUID NOT NULL,
  revision_id            UUID NOT NULL,
  root_bom_line_id       UUID,
  path                   TEXT NOT NULL,
  depth                  INTEGER NOT NULL,
  component_item_id      UUID NOT NULL,
  component_sku          TEXT NOT NULL,
  output_class           TEXT NOT NULL DEFAULT 'component',
  effective_quantity_per NUMERIC(18,6) NOT NULL,
  effective_scrap_percent NUMERIC(9,6),
  via_phantom            BOOLEAN NOT NULL DEFAULT false,
  effective_from         DATE NOT NULL,
  effective_to           DATE,
  source_event_id        UUID NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bom_structure_depth CHECK (depth >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_structure_path ON bom_structure (revision_id, path);
CREATE INDEX IF NOT EXISTS idx_bom_structure_component ON bom_structure (component_item_id);
CREATE INDEX IF NOT EXISTS idx_bom_structure_bom_id ON bom_structure (bom_id);
CREATE INDEX IF NOT EXISTS idx_bom_structure_revision ON bom_structure (revision_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_structure_depth'
      AND conrelid = 'bom_structure'::regclass
  ) THEN
    ALTER TABLE bom_structure
      ADD CONSTRAINT chk_bom_structure_depth CHECK (depth >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE, DELETE ON bom_structure TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON bom_structure TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/supplier_invoice.sql (canonical source).
-- Supplier invoice header read model (Story 4.7). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries
-- its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as
-- app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a live database
-- safely.
--
-- Derived state ONLY: rows are derived exclusively at persist time from supplier_invoice.* and
-- invoice_ingestion.* domain events; mutation happens exclusively through persistEvent, which
-- applies this projection inside the SAME transaction as the domain_events insert. Status
-- vocabulary is the two AC values (unmatched, captured). uq_supplier_invoice_duplicate_grain is
-- the final concurrency guard for AC3's ordinary-path duplicate block: it is a PARTIAL unique
-- index (only rows with duplicate_of_invoice_id IS NULL participate), so an evidenced override
-- row never collides with the original it overrides. GST/monetary columns are exact NUMERIC -
-- never floating point.

CREATE TABLE IF NOT EXISTS supplier_invoice (
  invoice_id                     UUID PRIMARY KEY,
  supplier_id                    UUID NOT NULL,
  supplier_gstin_ext             TEXT NOT NULL,
  invoice_number_ext             TEXT NOT NULL,
  invoice_number_normalized      TEXT NOT NULL,
  invoice_date                   DATE NOT NULL,
  financial_year_start           INTEGER NOT NULL,
  po_id                          UUID,
  site_id                        UUID,
  business_stream                TEXT,
  status                         TEXT NOT NULL DEFAULT 'unmatched',
  currency                       TEXT NOT NULL DEFAULT 'INR',
  recipient_gstin_ext            TEXT,
  irn_ext                        TEXT,
  subtotal                       NUMERIC(14,2),
  cgst_total                     NUMERIC(14,2),
  sgst_total                     NUMERIC(14,2),
  igst_total                     NUMERIC(14,2),
  cess_total                     NUMERIC(14,2),
  total_value                    NUMERIC(14,2),
  msme_classification_at_capture TEXT,
  statutory_due_date             DATE,
  statutory_due_rule_version     TEXT,
  duplicate_of_invoice_id        UUID,
  duplicate_override_reason      TEXT,
  capture_method                 TEXT,
  ingestion_id                   UUID,
  captured_by                    UUID NOT NULL,
  captured_at                    TIMESTAMPTZ NOT NULL,
  correlation_id                 UUID,
  source_event_id                UUID NOT NULL,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_supplier_invoice_status CHECK (status IN ('unmatched','captured')),
  CONSTRAINT chk_supplier_invoice_capture_method CHECK (capture_method IN ('manual','file')),
  CONSTRAINT chk_supplier_invoice_status_po_pairing CHECK (
    (status = 'unmatched' AND po_id IS NULL AND site_id IS NULL AND business_stream IS NULL)
    OR (status = 'captured' AND po_id IS NOT NULL AND site_id IS NOT NULL AND business_stream IS NOT NULL)
  ),
  CONSTRAINT chk_supplier_invoice_duplicate_pairing CHECK (
    (duplicate_of_invoice_id IS NULL AND duplicate_override_reason IS NULL)
    OR (duplicate_of_invoice_id IS NOT NULL AND duplicate_override_reason IS NOT NULL AND btrim(duplicate_override_reason) <> '')
  ),
  CONSTRAINT chk_supplier_invoice_subtotal_non_negative CHECK (subtotal IS NULL OR subtotal >= 0),
  CONSTRAINT chk_supplier_invoice_cgst_non_negative CHECK (cgst_total IS NULL OR cgst_total >= 0),
  CONSTRAINT chk_supplier_invoice_sgst_non_negative CHECK (sgst_total IS NULL OR sgst_total >= 0),
  CONSTRAINT chk_supplier_invoice_igst_non_negative CHECK (igst_total IS NULL OR igst_total >= 0),
  CONSTRAINT chk_supplier_invoice_cess_non_negative CHECK (cess_total IS NULL OR cess_total >= 0),
  CONSTRAINT chk_supplier_invoice_total_non_negative CHECK (total_value IS NULL OR total_value >= 0),
  CONSTRAINT chk_supplier_invoice_msme_classification CHECK (
    msme_classification_at_capture IS NULL
    OR msme_classification_at_capture IN ('micro','small','medium','not_msme')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_invoice_duplicate_grain
  ON supplier_invoice (supplier_gstin_ext, invoice_number_normalized, financial_year_start)
  WHERE duplicate_of_invoice_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_unmatched ON supplier_invoice (status) WHERE status = 'unmatched';
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_supplier_date ON supplier_invoice (supplier_id, invoice_date);
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_po ON supplier_invoice (po_id);
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_site_status ON supplier_invoice (site_id, status);
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_gst_recon ON supplier_invoice (supplier_gstin_ext, financial_year_start);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_status'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_status CHECK (status IN ('unmatched','captured'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_capture_method'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_capture_method CHECK (capture_method IN ('manual','file'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_status_po_pairing'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_status_po_pairing CHECK (
        (status = 'unmatched' AND po_id IS NULL AND site_id IS NULL AND business_stream IS NULL)
        OR (status = 'captured' AND po_id IS NOT NULL AND site_id IS NOT NULL AND business_stream IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_duplicate_pairing'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_duplicate_pairing CHECK (
        (duplicate_of_invoice_id IS NULL AND duplicate_override_reason IS NULL)
        OR (duplicate_of_invoice_id IS NOT NULL AND duplicate_override_reason IS NOT NULL AND btrim(duplicate_override_reason) <> '')
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_subtotal_non_negative'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_subtotal_non_negative CHECK (subtotal IS NULL OR subtotal >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_cgst_non_negative'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_cgst_non_negative CHECK (cgst_total IS NULL OR cgst_total >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_sgst_non_negative'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_sgst_non_negative CHECK (sgst_total IS NULL OR sgst_total >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_igst_non_negative'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_igst_non_negative CHECK (igst_total IS NULL OR igst_total >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_cess_non_negative'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_cess_non_negative CHECK (cess_total IS NULL OR cess_total >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_total_non_negative'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_total_non_negative CHECK (total_value IS NULL OR total_value >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_msme_classification'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_msme_classification CHECK (
        msme_classification_at_capture IS NULL
        OR msme_classification_at_capture IN ('micro','small','medium','not_msme')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON supplier_invoice TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON supplier_invoice TO readonly_user;
  END IF;
END $$;

-- Story 4.6 additive migration: statutory breach marker set by the daily compliance check when an
-- MSME invoice passes its statutory due date unpaid. Orthogonal to the unmatched/captured status
-- lifecycle - chk_supplier_invoice_status is untouched.
ALTER TABLE IF EXISTS supplier_invoice ADD COLUMN IF NOT EXISTS statutory_breach BOOLEAN NOT NULL DEFAULT false;

-- Story 4.5 additive migration: three-way match outcome. Orthogonal to the unmatched/captured
-- capture lifecycle - chk_supplier_invoice_status is untouched. NULL means never matched, and a
-- never-matched invoice is NOT clearance-eligible. Mirrors the latest three_way_match row for this
-- invoice so the payment-clearance feed can filter without a correlated subquery.
ALTER TABLE IF EXISTS supplier_invoice ADD COLUMN IF NOT EXISTS match_status TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_match_status'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_match_status CHECK (
        match_status IS NULL OR match_status IN ('passed','blocked','lifted')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_supplier_invoice_match_blocked
  ON supplier_invoice (match_status) WHERE match_status = 'blocked';

-- MUST stay identical to read/projections/supplier_invoice_line.sql (canonical source).
-- Supplier invoice line read model (Story 4.7). CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate); deploy/compose/init-db.sql duplicates this content
-- for first-boot container init - change both files together. Every statement is idempotent.
--
-- Derived state ONLY: rows are derived exclusively at persist time from supplier_invoice.* domain events;
-- mutation happens exclusively through persistEvent inside the same transaction as the
-- domain_events insert. Follows the purchase_order.sql / purchase_order_line.sql header-plus-line
-- precedent. No FK to supplier_invoice (same-transaction inserts).

CREATE TABLE IF NOT EXISTS supplier_invoice_line (
  invoice_line_id   UUID PRIMARY KEY,
  invoice_id        UUID NOT NULL,
  line_no           INTEGER NOT NULL,
  po_line_id        UUID,
  sku               TEXT NOT NULL,
  quantity          NUMERIC(14,3) NOT NULL,
  uom               TEXT NOT NULL,
  unit_price        NUMERIC(14,4) NOT NULL,
  taxable_value     NUMERIC(14,2) NOT NULL,
  cgst_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  cess_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  line_total        NUMERIC(14,2) NOT NULL,
  CONSTRAINT uq_supplier_invoice_line_no UNIQUE (invoice_id, line_no),
  CONSTRAINT chk_supplier_invoice_line_qty_positive CHECK (quantity > 0),
  CONSTRAINT chk_supplier_invoice_line_amounts_non_negative CHECK (
    unit_price >= 0 AND taxable_value >= 0 AND cgst_amount >= 0 AND sgst_amount >= 0
    AND igst_amount >= 0 AND cess_amount >= 0 AND line_total >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_supplier_invoice_line_sku ON supplier_invoice_line (sku);
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_line_po_line ON supplier_invoice_line (po_line_id);
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_line_invoice_id ON supplier_invoice_line (invoice_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_supplier_invoice_line_no'
      AND conrelid = 'supplier_invoice_line'::regclass
  ) THEN
    ALTER TABLE supplier_invoice_line
      ADD CONSTRAINT uq_supplier_invoice_line_no UNIQUE (invoice_id, line_no);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_line_qty_positive'
      AND conrelid = 'supplier_invoice_line'::regclass
  ) THEN
    ALTER TABLE supplier_invoice_line
      ADD CONSTRAINT chk_supplier_invoice_line_qty_positive CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_line_amounts_non_negative'
      AND conrelid = 'supplier_invoice_line'::regclass
  ) THEN
    ALTER TABLE supplier_invoice_line
      ADD CONSTRAINT chk_supplier_invoice_line_amounts_non_negative CHECK (
        unit_price >= 0 AND taxable_value >= 0 AND cgst_amount >= 0 AND sgst_amount >= 0
        AND igst_amount >= 0 AND cess_amount >= 0 AND line_total >= 0
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON supplier_invoice_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON supplier_invoice_line TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/supplier_invoice_ingestion.sql (canonical source).
-- Supplier invoice ingestion (file-review) read model (Story 4.7). CANONICAL definition, applied
-- by src/events/migrate.ts (npm run db:migrate); deploy/compose/init-db.sql duplicates this
-- content for first-boot container init - change both files together. Every statement is
-- idempotent.
--
-- Derived state ONLY: rows are derived exclusively at persist time from invoice_ingestion.* domain events.
-- Binary bytes never enter this table - only an immutable attachment reference, its SHA-256
-- hash, detected MIME, byte size, and the trusted extraction boundary's draft JSON (Binding
-- Scope Decisions: no binary attachment store is invented here). The attachment_ref unique index
-- guards against re-ingesting the SAME uploaded artifact twice; it is NOT a business duplicate
-- decision (that is the supplier_invoice duplicate grain) - a genuinely reused attachment
-- reference belongs to the SAME ingestion attempt, never a second one.

CREATE TABLE IF NOT EXISTS supplier_invoice_ingestion (
  ingestion_id        UUID PRIMARY KEY,
  source_format       TEXT NOT NULL,
  attachment_ref       TEXT NOT NULL,
  sha256_hash         TEXT NOT NULL,
  detected_mime       TEXT NOT NULL,
  byte_size           BIGINT NOT NULL,
  extracted_draft     JSONB NOT NULL,
  review_status       TEXT NOT NULL DEFAULT 'review-required',
  uploaded_by         UUID NOT NULL,
  uploaded_at         TIMESTAMPTZ NOT NULL,
  reviewed_by         UUID,
  reviewed_at         TIMESTAMPTZ,
  correction_summary  JSONB,
  resulting_invoice_id UUID,
  correlation_id      UUID,
  source_event_id     UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_supplier_invoice_ingestion_format CHECK (source_format IN ('pdf','csv','xml')),
  CONSTRAINT chk_supplier_invoice_ingestion_review_status CHECK (review_status IN ('review-required','reviewed')),
  CONSTRAINT chk_supplier_invoice_ingestion_byte_size_positive CHECK (byte_size > 0),
  CONSTRAINT chk_supplier_invoice_ingestion_reviewed_pairing CHECK (
    (review_status = 'review-required' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (review_status = 'reviewed' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_invoice_ingestion_attachment_ref
  ON supplier_invoice_ingestion (attachment_ref);
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_ingestion_review_status ON supplier_invoice_ingestion (review_status);
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_ingestion_resulting_invoice ON supplier_invoice_ingestion (resulting_invoice_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_ingestion_format'
      AND conrelid = 'supplier_invoice_ingestion'::regclass
  ) THEN
    ALTER TABLE supplier_invoice_ingestion
      ADD CONSTRAINT chk_supplier_invoice_ingestion_format CHECK (source_format IN ('pdf','csv','xml'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_ingestion_review_status'
      AND conrelid = 'supplier_invoice_ingestion'::regclass
  ) THEN
    ALTER TABLE supplier_invoice_ingestion
      ADD CONSTRAINT chk_supplier_invoice_ingestion_review_status CHECK (review_status IN ('review-required','reviewed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_ingestion_byte_size_positive'
      AND conrelid = 'supplier_invoice_ingestion'::regclass
  ) THEN
    ALTER TABLE supplier_invoice_ingestion
      ADD CONSTRAINT chk_supplier_invoice_ingestion_byte_size_positive CHECK (byte_size > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_ingestion_reviewed_pairing'
      AND conrelid = 'supplier_invoice_ingestion'::regclass
  ) THEN
    ALTER TABLE supplier_invoice_ingestion
      ADD CONSTRAINT chk_supplier_invoice_ingestion_reviewed_pairing CHECK (
        (review_status = 'review-required' AND reviewed_by IS NULL AND reviewed_at IS NULL)
        OR (review_status = 'reviewed' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON supplier_invoice_ingestion TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON supplier_invoice_ingestion TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/msme_ageing_feed.sql (canonical source).
-- MSME ageing feed ledger (Story 4.6). CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate); deploy/compose/init-db.sql duplicates this content
-- for first-boot container init - change both files together. Every statement is idempotent.
--
-- Derived state ONLY: the row is written atomically with msme_ageing_feed.recorded inside the SAME
-- persistEvent transaction. This is the ERP adapter boundary record (AC4 verification contract) -
-- the adapter records the ageing payload durably; live transmission is per-deployment configuration
-- and is NOT implemented here. Append-only ledger: app_user gets INSERT, SELECT only (no UPDATE),
-- mirroring po_outbound_message.

CREATE TABLE IF NOT EXISTS msme_ageing_feed (
  feed_id       UUID PRIMARY KEY,
  payload       JSONB NOT NULL,
  row_count     INTEGER NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON msme_ageing_feed TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON msme_ageing_feed TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/three_way_match.sql (canonical source).
-- Three-way match read model (Story 4.5). This file is the CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its OWN
-- grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as app_user
-- without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates this
-- content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a live database
-- safely.
--
-- Derived state ONLY: rows are derived exclusively at persist time from three_way_match.* and
-- supplier_invoice.*_note_recorded domain events; mutation happens exclusively through
-- persistEvent, which applies this projection inside the SAME transaction as the domain_events
-- insert. One row per match RUN (match_id): a blocked match that is later lifted by a credit or
-- debit note keeps its row and flips to 'lifted'; a fresh match run after a lift is a NEW match_id,
-- never an overwrite. variance_detail carries the per-line quantity/price comparison plus the
-- tolerance snapshot actually applied, so a historical match stays explainable after the
-- configured tolerances change. All comparison arithmetic runs in PostgreSQL NUMERIC - never
-- floating point.

CREATE TABLE IF NOT EXISTS three_way_match (
  match_id              UUID PRIMARY KEY,
  invoice_id            UUID NOT NULL,
  po_id                 UUID NOT NULL,
  site_id               UUID,
  business_stream       TEXT,
  status                TEXT NOT NULL,
  error_code            TEXT,
  variance_detail       JSONB NOT NULL,
  tolerance_rule_version TEXT NOT NULL,
  lifted_note_id        UUID,
  lifted_note_type      TEXT,
  run_by                UUID NOT NULL,
  recorded_at           TIMESTAMPTZ NOT NULL,
  lifted_at             TIMESTAMPTZ,
  source_event_id       UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_three_way_match_status CHECK (status IN ('passed','blocked','lifted')),
  CONSTRAINT chk_three_way_match_note_type CHECK (
    lifted_note_type IS NULL OR lifted_note_type IN ('credit_note','debit_note')
  ),
  CONSTRAINT chk_three_way_match_lift_pairing CHECK (
    (status = 'lifted' AND lifted_note_id IS NOT NULL AND lifted_note_type IS NOT NULL AND lifted_at IS NOT NULL)
    OR (status <> 'lifted' AND lifted_note_id IS NULL AND lifted_note_type IS NULL AND lifted_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_three_way_match_invoice ON three_way_match (invoice_id);
CREATE INDEX IF NOT EXISTS idx_three_way_match_po ON three_way_match (po_id);
CREATE INDEX IF NOT EXISTS idx_three_way_match_blocked ON three_way_match (status) WHERE status = 'blocked';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_three_way_match_status'
      AND conrelid = 'three_way_match'::regclass
  ) THEN
    ALTER TABLE three_way_match
      ADD CONSTRAINT chk_three_way_match_status CHECK (status IN ('passed','blocked','lifted'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_three_way_match_note_type'
      AND conrelid = 'three_way_match'::regclass
  ) THEN
    ALTER TABLE three_way_match
      ADD CONSTRAINT chk_three_way_match_note_type CHECK (
        lifted_note_type IS NULL OR lifted_note_type IN ('credit_note','debit_note')
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_three_way_match_lift_pairing'
      AND conrelid = 'three_way_match'::regclass
  ) THEN
    ALTER TABLE three_way_match
      ADD CONSTRAINT chk_three_way_match_lift_pairing CHECK (
        (status = 'lifted' AND lifted_note_id IS NOT NULL AND lifted_note_type IS NOT NULL AND lifted_at IS NOT NULL)
        OR (status <> 'lifted' AND lifted_note_id IS NULL AND lifted_note_type IS NULL AND lifted_at IS NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON three_way_match TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON three_way_match TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/payment_clearance_feed.sql (canonical source).
-- Payment clearance feed ledger (Story 4.5). CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate); deploy/compose/init-db.sql duplicates this content
-- for first-boot container init - change both files together. Every statement is idempotent.
--
-- Derived state ONLY: the row is written atomically with payment_clearance_feed.recorded inside the
-- SAME persistEvent transaction. This is the ERP adapter boundary record for AC3 - payment executes
-- in ERP, so "blocked from payment" is effected by OMITTING the invoice from this payload while its
-- three-way match is blocked. The adapter records the clearance payload durably; live transmission
-- is per-deployment configuration and is NOT implemented here (AD-4). Append-only ledger: app_user
-- gets INSERT, SELECT only (no UPDATE), mirroring msme_ageing_feed.

CREATE TABLE IF NOT EXISTS payment_clearance_feed (
  feed_id       UUID PRIMARY KEY,
  payload       JSONB NOT NULL,
  row_count     INTEGER NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON payment_clearance_feed TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON payment_clearance_feed TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/supplier_scorecard_metric.sql (canonical source).
-- Supplier scorecard metric read model (Story 4.2). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Append-only metric history: one row per supplier_scorecard.metric_recorded event, derived
-- exclusively at persist time through persistEvent inside the SAME transaction as the
-- domain_events insert. Rows are NEVER updated or deleted; a correction is a NEW row carrying a
-- supersedes_metric_id pointer to the row it supersedes. The partial unique index on
-- (reference_event_id, metric_kind) is the replay guard: a duplicate metric for the same source
-- event is a no-op at the seam. All metric arithmetic runs in PostgreSQL NUMERIC - never
-- floating point. No UPDATE or DELETE grant exists for app_user by design.

CREATE TABLE IF NOT EXISTS supplier_scorecard_metric (
  metric_id             UUID PRIMARY KEY,
  supplier_id           UUID NOT NULL,
  metric_kind           TEXT NOT NULL,
  reference_event_id    UUID NOT NULL,
  reference_entity_id   UUID NOT NULL,
  value_num             NUMERIC(14,6) NOT NULL,
  context               JSONB NOT NULL DEFAULT '{}'::jsonb,
  business_date         DATE NOT NULL,
  source_event_id       UUID NOT NULL,
  supersedes_metric_id  UUID,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by           UUID NOT NULL,
  CONSTRAINT chk_supplier_scorecard_metric_kind CHECK (
    metric_kind IN ('on_time_delivery','quality_acceptance','price_variance','responsiveness')
  )
);

CREATE INDEX IF NOT EXISTS idx_supplier_scorecard_supplier_kind
  ON supplier_scorecard_metric (supplier_id, metric_kind, business_date DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_scorecard_reference
  ON supplier_scorecard_metric (reference_entity_id);
CREATE INDEX IF NOT EXISTS idx_supplier_scorecard_supersedes
  ON supplier_scorecard_metric (supersedes_metric_id) WHERE supersedes_metric_id IS NOT NULL;
-- The replay guard is PARTIAL (supersedes_metric_id IS NULL): ordinary rows are unique per
-- (reference_event_id, metric_kind), while a correction row - which carries supersedes_metric_id
-- and re-measures the SAME source event - is admitted alongside the row it supersedes. The
-- drop-then-create pair keeps re-application idempotent and converges databases that carried the
-- earlier full index onto the partial definition.
DROP INDEX IF EXISTS uq_supplier_scorecard_reference_kind;
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_scorecard_reference_kind
  ON supplier_scorecard_metric (reference_event_id, metric_kind)
  WHERE supersedes_metric_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_scorecard_metric_kind'
      AND conrelid = 'supplier_scorecard_metric'::regclass
  ) THEN
    ALTER TABLE supplier_scorecard_metric
      ADD CONSTRAINT chk_supplier_scorecard_metric_kind CHECK (
        metric_kind IN ('on_time_delivery','quality_acceptance','price_variance','responsiveness')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON supplier_scorecard_metric TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON supplier_scorecard_metric TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/eco.sql (canonical source).

CREATE TABLE IF NOT EXISTS eco (
  eco_id                UUID PRIMARY KEY,
  eco_number            TEXT NOT NULL,
  bom_id                UUID NOT NULL,
  target_revision_id    UUID NOT NULL,
  business_stream       TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'draft',
  reason                TEXT NOT NULL,
  raised_by             UUID NOT NULL,
  approver_actor_id     UUID,
  doa_entry_id          UUID,
  review_started_at     TIMESTAMPTZ,
  approved_at           TIMESTAMPTZ,
  approved_by           UUID,
  implemented_at        TIMESTAMPTZ,
  implemented_by        UUID,
  new_revision_id       UUID,
  cancelled_at          TIMESTAMPTZ,
  cancelled_by          UUID,
  cancel_reason         TEXT,
  status_changed_at     TIMESTAMPTZ,
  status_changed_by     UUID,
  correlation_id        UUID,
  source_event_id       UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_eco_status CHECK (status IN ('draft','under_review','approved','implemented','cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_eco_number ON eco (eco_number);
CREATE INDEX IF NOT EXISTS idx_eco_bom_id ON eco (bom_id);
CREATE INDEX IF NOT EXISTS idx_eco_status ON eco (status);
CREATE INDEX IF NOT EXISTS idx_eco_approver ON eco (approver_actor_id) WHERE status = 'under_review';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_eco_status'
      AND conrelid = 'eco'::regclass
  ) THEN
    ALTER TABLE eco
      ADD CONSTRAINT chk_eco_status CHECK (status IN ('draft','under_review','approved','implemented','cancelled'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON eco TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON eco TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/eco_change_line.sql (canonical source).

CREATE TABLE IF NOT EXISTS eco_change_line (
  eco_change_id            UUID PRIMARY KEY,
  eco_id                   UUID NOT NULL,
  change_no                INTEGER NOT NULL,
  change_type              TEXT NOT NULL,
  target_bom_line_id       UUID,
  component_item_id        UUID,
  component_sku            TEXT,
  output_class             TEXT NOT NULL DEFAULT 'component',
  quantity_per             NUMERIC(18,6),
  line_uom                 TEXT,
  uom_conversion_factor    NUMERIC(18,8),
  base_quantity_per        NUMERIC(18,6),
  scrap_percent            NUMERIC(7,4),
  expected_yield_percent   NUMERIC(7,4),
  is_phantom               BOOLEAN NOT NULL DEFAULT false,
  phantom_source_bom_id    UUID,
  effective_from           DATE,
  effective_to             DATE,
  source_event_id          UUID NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_eco_change_type CHECK (change_type IN ('add','amend','retire')),
  CONSTRAINT chk_eco_change_target CHECK (
    (change_type = 'add' AND target_bom_line_id IS NULL AND component_item_id IS NOT NULL) OR
    (change_type IN ('amend','retire') AND target_bom_line_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_eco_change_no ON eco_change_line (eco_id, change_no);
CREATE INDEX IF NOT EXISTS idx_eco_change_eco_id ON eco_change_line (eco_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_eco_change_type'
      AND conrelid = 'eco_change_line'::regclass
  ) THEN
    ALTER TABLE eco_change_line
      ADD CONSTRAINT chk_eco_change_type CHECK (change_type IN ('add','amend','retire'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_eco_change_target'
      AND conrelid = 'eco_change_line'::regclass
  ) THEN
    ALTER TABLE eco_change_line
      ADD CONSTRAINT chk_eco_change_target CHECK (
        (change_type = 'add' AND target_bom_line_id IS NULL AND component_item_id IS NOT NULL) OR
        (change_type IN ('amend','retire') AND target_bom_line_id IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON eco_change_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON eco_change_line TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/eco_stock_disposition.sql (canonical source).

CREATE TABLE IF NOT EXISTS eco_stock_disposition (
  disposition_id      UUID PRIMARY KEY,
  eco_id               UUID NOT NULL,
  lot_id               TEXT NOT NULL,
  sku                  TEXT NOT NULL,
  location_id          UUID NOT NULL,
  on_hand_qty          NUMERIC(18,6) NOT NULL,
  disposition          TEXT NOT NULL,
  rework_reference     TEXT,
  notes                TEXT,
  decided_at           TIMESTAMPTZ NOT NULL,
  decided_by           UUID NOT NULL,
  source_event_id      UUID NOT NULL,
  CONSTRAINT chk_eco_disposition CHECK (disposition IN ('use_up','scrap','rework')),
  CONSTRAINT chk_eco_disposition_rework_ref CHECK (
    (disposition = 'rework' AND rework_reference IS NOT NULL AND btrim(rework_reference) <> '') OR
    (disposition <> 'rework' AND rework_reference IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_eco_disposition_lot ON eco_stock_disposition (eco_id, lot_id, location_id);
CREATE INDEX IF NOT EXISTS idx_eco_disposition_eco_id ON eco_stock_disposition (eco_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_eco_disposition'
      AND conrelid = 'eco_stock_disposition'::regclass
  ) THEN
    ALTER TABLE eco_stock_disposition
      ADD CONSTRAINT chk_eco_disposition CHECK (disposition IN ('use_up','scrap','rework'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_eco_disposition_rework_ref'
      AND conrelid = 'eco_stock_disposition'::regclass
  ) THEN
    ALTER TABLE eco_stock_disposition
      ADD CONSTRAINT chk_eco_disposition_rework_ref CHECK (
        (disposition = 'rework' AND rework_reference IS NOT NULL AND btrim(rework_reference) <> '') OR
        (disposition <> 'rework' AND rework_reference IS NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON eco_stock_disposition TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON eco_stock_disposition TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/rd_build_record.sql (canonical source).

CREATE TABLE IF NOT EXISTS rd_build_record (
  build_id          UUID PRIMARY KEY,
  bom_id            UUID NOT NULL,
  revision_id       UUID NOT NULL,
  build_ref         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'recorded',
  built_quantity    NUMERIC(18,6) NOT NULL,
  built_uom         TEXT NOT NULL,
  notes             TEXT,
  outcome           TEXT,
  recorded_by       UUID NOT NULL,
  recorded_at       TIMESTAMPTZ NOT NULL,
  confirmed_by      UUID,
  confirmed_at      TIMESTAMPTZ,
  correlation_id    UUID,
  source_event_id   UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rd_build_status CHECK (status IN ('recorded','confirmed')),
  CONSTRAINT chk_rd_build_quantity_positive CHECK (built_quantity > 0),
  CONSTRAINT chk_rd_build_outcome CHECK (outcome IS NULL OR outcome IN ('success','failed','abandoned'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rd_build_ref ON rd_build_record (bom_id, build_ref);
CREATE INDEX IF NOT EXISTS idx_rd_build_bom_id ON rd_build_record (bom_id);
CREATE INDEX IF NOT EXISTS idx_rd_build_status ON rd_build_record (status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_build_status'
      AND conrelid = 'rd_build_record'::regclass
  ) THEN
    ALTER TABLE rd_build_record
      ADD CONSTRAINT chk_rd_build_status CHECK (status IN ('recorded','confirmed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_build_quantity_positive'
      AND conrelid = 'rd_build_record'::regclass
  ) THEN
    ALTER TABLE rd_build_record
      ADD CONSTRAINT chk_rd_build_quantity_positive CHECK (built_quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_build_outcome'
      AND conrelid = 'rd_build_record'::regclass
  ) THEN
    ALTER TABLE rd_build_record
      ADD CONSTRAINT chk_rd_build_outcome CHECK (outcome IS NULL OR outcome IN ('success','failed','abandoned'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON rd_build_record TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON rd_build_record TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/rd_as_built_line.sql (canonical source).

CREATE TABLE IF NOT EXISTS rd_as_built_line (
  as_built_line_id    UUID PRIMARY KEY,
  build_id            UUID NOT NULL,
  line_no             INTEGER NOT NULL,
  draft_bom_line_id   UUID,
  component_item_id   UUID,
  component_sku       TEXT,
  is_placeholder      BOOLEAN NOT NULL DEFAULT false,
  free_text           TEXT,
  quantity_used       NUMERIC(18,6) NOT NULL,
  line_uom            TEXT NOT NULL,
  deviation_flag      BOOLEAN NOT NULL DEFAULT false,
  deviation_kind      TEXT,
  deviation_detail    TEXT,
  source_event_id     UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rd_as_built_quantity_positive CHECK (quantity_used > 0),
  CONSTRAINT chk_rd_as_built_identity CHECK (
    (is_placeholder = true AND component_item_id IS NULL AND free_text IS NOT NULL AND btrim(free_text) <> '') OR
    (is_placeholder = false AND component_item_id IS NOT NULL AND component_sku IS NOT NULL)
  ),
  CONSTRAINT chk_rd_as_built_deviation CHECK (
    (deviation_flag = true AND deviation_kind IS NOT NULL) OR
    (deviation_flag = false AND deviation_kind IS NULL AND deviation_detail IS NULL)
  ),
  CONSTRAINT chk_rd_as_built_deviation_kind CHECK (
    deviation_kind IS NULL OR deviation_kind IN ('quantity','substitution','extra','missing','placeholder')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rd_as_built_line_no ON rd_as_built_line (build_id, line_no);
CREATE INDEX IF NOT EXISTS idx_rd_as_built_build_id ON rd_as_built_line (build_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_as_built_quantity_positive'
      AND conrelid = 'rd_as_built_line'::regclass
  ) THEN
    ALTER TABLE rd_as_built_line
      ADD CONSTRAINT chk_rd_as_built_quantity_positive CHECK (quantity_used > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_as_built_identity'
      AND conrelid = 'rd_as_built_line'::regclass
  ) THEN
    ALTER TABLE rd_as_built_line
      ADD CONSTRAINT chk_rd_as_built_identity CHECK (
        (is_placeholder = true AND component_item_id IS NULL AND free_text IS NOT NULL AND btrim(free_text) <> '') OR
        (is_placeholder = false AND component_item_id IS NOT NULL AND component_sku IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_as_built_deviation'
      AND conrelid = 'rd_as_built_line'::regclass
  ) THEN
    ALTER TABLE rd_as_built_line
      ADD CONSTRAINT chk_rd_as_built_deviation CHECK (
        (deviation_flag = true AND deviation_kind IS NOT NULL) OR
        (deviation_flag = false AND deviation_kind IS NULL AND deviation_detail IS NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_as_built_deviation_kind'
      AND conrelid = 'rd_as_built_line'::regclass
  ) THEN
    ALTER TABLE rd_as_built_line
      ADD CONSTRAINT chk_rd_as_built_deviation_kind CHECK (
        deviation_kind IS NULL OR deviation_kind IN ('quantity','substitution','extra','missing','placeholder')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON rd_as_built_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON rd_as_built_line TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/rd_productization_signoff.sql (canonical source).

CREATE TABLE IF NOT EXISTS rd_productization_signoff (
  signoff_id          UUID PRIMARY KEY,
  bom_id              UUID NOT NULL,
  gate_function       TEXT NOT NULL,
  signed_by           UUID NOT NULL,
  signed_at           TIMESTAMPTZ NOT NULL,
  approver_actor_id   UUID NOT NULL,
  doa_entry_id        UUID,
  notes               TEXT,
  source_event_id     UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rd_signoff_function CHECK (gate_function IN ('engineering','procurement','qc'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rd_signoff_function ON rd_productization_signoff (bom_id, gate_function);
CREATE INDEX IF NOT EXISTS idx_rd_signoff_bom_id ON rd_productization_signoff (bom_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_signoff_function'
      AND conrelid = 'rd_productization_signoff'::regclass
  ) THEN
    ALTER TABLE rd_productization_signoff
      ADD CONSTRAINT chk_rd_signoff_function CHECK (gate_function IN ('engineering','procurement','qc'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON rd_productization_signoff TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON rd_productization_signoff TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/bom_alternate.sql (canonical source).

CREATE TABLE IF NOT EXISTS bom_alternate (
  bom_alternate_id    UUID PRIMARY KEY,
  bom_id              UUID NOT NULL,
  revision_id         UUID NOT NULL,
  bom_line_id         UUID NOT NULL,
  line_no             INTEGER NOT NULL,
  component_item_id   UUID NOT NULL,
  alternate_item_id   UUID NOT NULL,
  alternate_sku       TEXT,
  priority            INTEGER NOT NULL,
  effective_from      DATE NOT NULL,
  effective_to        DATE,
  origin              TEXT NOT NULL,
  doa_entry_id        UUID,
  approver_actor_id   UUID,
  is_released_structure BOOLEAN NOT NULL DEFAULT false,
  defined_by          UUID NOT NULL,
  source_event_id     UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bom_alternate_origin CHECK (origin IN ('approved','ad_hoc')),
  CONSTRAINT chk_bom_alternate_priority CHECK (priority >= 1),
  CONSTRAINT chk_bom_alternate_effectivity_order CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT chk_bom_alternate_not_self CHECK (alternate_item_id <> component_item_id),
  CONSTRAINT chk_bom_alternate_doa_pairing CHECK (
    (origin = 'ad_hoc' AND doa_entry_id IS NOT NULL AND approver_actor_id IS NOT NULL) OR
    (origin = 'approved' AND doa_entry_id IS NULL AND approver_actor_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_alternate_entry
  ON bom_alternate (bom_line_id, alternate_item_id, effective_from);
CREATE INDEX IF NOT EXISTS idx_bom_alternate_bom_id ON bom_alternate (bom_id);
CREATE INDEX IF NOT EXISTS idx_bom_alternate_line ON bom_alternate (bom_line_id, priority);
CREATE INDEX IF NOT EXISTS idx_bom_alternate_effective
  ON bom_alternate (bom_line_id, effective_from, effective_to);

-- Story 5.5 review (sync scoping): released_bom_structure bucket filter marker, mirroring
-- read/projections/bom_alternate.sql.
ALTER TABLE bom_alternate ADD COLUMN IF NOT EXISTS is_released_structure BOOLEAN NOT NULL DEFAULT false;

UPDATE bom_alternate SET is_released_structure = true, updated_at = now()
 WHERE revision_id IN (
   SELECT br.revision_id FROM bom_revision br JOIN bom b ON b.bom_id = br.bom_id
    WHERE br.revision_status = 'released' AND b.status = 'released'
 );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_alternate_origin'
      AND conrelid = 'bom_alternate'::regclass
  ) THEN
    ALTER TABLE bom_alternate
      ADD CONSTRAINT chk_bom_alternate_origin CHECK (origin IN ('approved','ad_hoc'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_alternate_priority'
      AND conrelid = 'bom_alternate'::regclass
  ) THEN
    ALTER TABLE bom_alternate
      ADD CONSTRAINT chk_bom_alternate_priority CHECK (priority >= 1);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_alternate_effectivity_order'
      AND conrelid = 'bom_alternate'::regclass
  ) THEN
    ALTER TABLE bom_alternate
      ADD CONSTRAINT chk_bom_alternate_effectivity_order CHECK (effective_to IS NULL OR effective_to >= effective_from);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_alternate_not_self'
      AND conrelid = 'bom_alternate'::regclass
  ) THEN
    ALTER TABLE bom_alternate
      ADD CONSTRAINT chk_bom_alternate_not_self CHECK (alternate_item_id <> component_item_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_alternate_doa_pairing'
      AND conrelid = 'bom_alternate'::regclass
  ) THEN
    ALTER TABLE bom_alternate
      ADD CONSTRAINT chk_bom_alternate_doa_pairing CHECK (
        (origin = 'ad_hoc' AND doa_entry_id IS NOT NULL AND approver_actor_id IS NOT NULL) OR
        (origin = 'approved' AND doa_entry_id IS NULL AND approver_actor_id IS NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON bom_alternate TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON bom_alternate TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/bom_explosion.sql (canonical source).

CREATE TABLE IF NOT EXISTS bom_explosion (
  explosion_id      UUID PRIMARY KEY,
  bom_id            UUID NOT NULL,
  revision_id       UUID NOT NULL,
  order_quantity    NUMERIC NOT NULL,
  business_date     DATE NOT NULL,
  depth_truncated   BOOLEAN NOT NULL DEFAULT false,
  requirement_count INTEGER NOT NULL,
  exploded_by       UUID NOT NULL,
  correlation_id    UUID,
  source_event_id   UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bom_explosion_quantity_positive CHECK (order_quantity > 0),
  CONSTRAINT chk_bom_explosion_requirement_count CHECK (requirement_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_explosion_source_event ON bom_explosion (source_event_id);
CREATE INDEX IF NOT EXISTS idx_bom_explosion_bom_id ON bom_explosion (bom_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_explosion_quantity_positive'
      AND conrelid = 'bom_explosion'::regclass
  ) THEN
    ALTER TABLE bom_explosion
      ADD CONSTRAINT chk_bom_explosion_quantity_positive CHECK (order_quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_explosion_requirement_count'
      AND conrelid = 'bom_explosion'::regclass
  ) THEN
    ALTER TABLE bom_explosion
      ADD CONSTRAINT chk_bom_explosion_requirement_count CHECK (requirement_count >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON bom_explosion TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON bom_explosion TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to read/projections/bom_explosion_line.sql (canonical source).

CREATE TABLE IF NOT EXISTS bom_explosion_line (
  explosion_line_id   UUID PRIMARY KEY,
  explosion_id        UUID NOT NULL,
  depth               INTEGER NOT NULL,
  path                TEXT NOT NULL,
  source_bom_id       UUID NOT NULL,
  source_revision_id  UUID NOT NULL,
  bom_line_id         UUID NOT NULL,
  line_no             INTEGER NOT NULL,
  component_item_id   UUID NOT NULL,
  component_sku       TEXT,
  supply_method       TEXT NOT NULL,
  required_quantity   NUMERIC NOT NULL,
  scrap_percent       NUMERIC(9,6),
  base_quantity_per   NUMERIC(18,8) NOT NULL,
  has_child_bom       BOOLEAN NOT NULL DEFAULT false,
  via_phantom         BOOLEAN NOT NULL DEFAULT false,
  alternates          JSONB NOT NULL DEFAULT '[]',
  source_event_id     UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bom_explosion_line_depth CHECK (depth >= 0),
  CONSTRAINT chk_bom_explosion_line_supply_method CHECK (supply_method IN ('directed_issue','backflush')),
  CONSTRAINT chk_bom_explosion_line_quantity_positive CHECK (required_quantity > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_explosion_line_no
  ON bom_explosion_line (explosion_id, path, line_no);
CREATE INDEX IF NOT EXISTS idx_bom_explosion_line_explosion ON bom_explosion_line (explosion_id);
CREATE INDEX IF NOT EXISTS idx_bom_explosion_line_component ON bom_explosion_line (component_item_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_explosion_line_depth'
      AND conrelid = 'bom_explosion_line'::regclass
  ) THEN
    ALTER TABLE bom_explosion_line
      ADD CONSTRAINT chk_bom_explosion_line_depth CHECK (depth >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_explosion_line_supply_method'
      AND conrelid = 'bom_explosion_line'::regclass
  ) THEN
    ALTER TABLE bom_explosion_line
      ADD CONSTRAINT chk_bom_explosion_line_supply_method CHECK (supply_method IN ('directed_issue','backflush'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_explosion_line_quantity_positive'
      AND conrelid = 'bom_explosion_line'::regclass
  ) THEN
    ALTER TABLE bom_explosion_line
      ADD CONSTRAINT chk_bom_explosion_line_quantity_positive CHECK (required_quantity > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON bom_explosion_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON bom_explosion_line TO readonly_user;
  END IF;
END $$;

-- MUST stay identical to sync/migrations/powersync-bom.sql (canonical source). Placed at the END
-- of this file because it publishes and grants the bom tables created above (Story 5.5, AC 4).

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_powersync') THEN
    GRANT SELECT ON bom, bom_revision, bom_line, bom_alternate TO svc_powersync;
  END IF;
END $$;

DO $$
DECLARE
  target_table text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'powersync_publication') THEN
    RETURN;
  END IF;
  FOREACH target_table IN ARRAY ARRAY['bom', 'bom_revision', 'bom_line', 'bom_alternate'] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'powersync_publication'
        AND schemaname = 'public'
        AND tablename = target_table
    ) THEN
      EXECUTE format('ALTER PUBLICATION powersync_publication ADD TABLE %I', target_table);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Story 5.6: BOM cost rollup snapshots and the ERP outbound boundary record.
-- MUST stay identical to read/projections/bom_cost_rollup.sql,
-- read/projections/bom_cost_rollup_line.sql and read/projections/bom_outbound_message.sql
-- (canonical sources).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bom_cost_rollup (
  rollup_id          UUID PRIMARY KEY,
  bom_id             UUID NOT NULL,
  revision_id        UUID NOT NULL,
  rollup_date        DATE NOT NULL,
  rate_basis         TEXT NOT NULL,
  total_cost         NUMERIC NOT NULL,
  line_count         INTEGER NOT NULL,
  missing_rate_count INTEGER NOT NULL,
  depth_truncated    BOOLEAN NOT NULL DEFAULT false,
  rolled_up_by       UUID,
  correlation_id     UUID,
  source_event_id    UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bom_cost_rollup_rate_basis CHECK (rate_basis IN ('item_master_standard_cost')),
  CONSTRAINT chk_bom_cost_rollup_counts CHECK (line_count >= 0 AND missing_rate_count >= 0 AND missing_rate_count <= line_count)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_cost_rollup_source_event ON bom_cost_rollup (source_event_id);
CREATE INDEX IF NOT EXISTS idx_bom_cost_rollup_bom ON bom_cost_rollup (bom_id, rollup_date DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_cost_rollup_rate_basis'
      AND conrelid = 'bom_cost_rollup'::regclass
  ) THEN
    ALTER TABLE bom_cost_rollup
      ADD CONSTRAINT chk_bom_cost_rollup_rate_basis CHECK (rate_basis IN ('item_master_standard_cost'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_cost_rollup_counts'
      AND conrelid = 'bom_cost_rollup'::regclass
  ) THEN
    ALTER TABLE bom_cost_rollup
      ADD CONSTRAINT chk_bom_cost_rollup_counts CHECK (line_count >= 0 AND missing_rate_count >= 0 AND missing_rate_count <= line_count);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON bom_cost_rollup TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON bom_cost_rollup TO readonly_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS bom_cost_rollup_line (
  rollup_line_id        UUID PRIMARY KEY,
  rollup_id             UUID NOT NULL,
  depth                 INTEGER NOT NULL,
  path                  TEXT NOT NULL,
  source_bom_id         UUID,
  source_revision_id    UUID,
  bom_line_id           UUID NOT NULL,
  line_no               INTEGER NOT NULL,
  component_item_id     UUID,
  component_sku         TEXT,
  effective_quantity_per NUMERIC NOT NULL,
  scrap_percent         NUMERIC(9,6),
  unit_cost             NUMERIC(18,6),
  extended_cost         NUMERIC NOT NULL DEFAULT 0,
  rate_missing          BOOLEAN NOT NULL DEFAULT false,
  via_phantom           BOOLEAN NOT NULL DEFAULT false,
  has_child_bom         BOOLEAN NOT NULL DEFAULT false,
  source_event_id       UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bom_cost_rollup_line_depth CHECK (depth >= 0),
  CONSTRAINT chk_bom_cost_rollup_line_quantity_positive CHECK (effective_quantity_per > 0),
  CONSTRAINT chk_bom_cost_rollup_line_extended_non_negative CHECK (extended_cost >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_cost_rollup_line_no ON bom_cost_rollup_line (rollup_id, path, line_no);
CREATE INDEX IF NOT EXISTS idx_bom_cost_rollup_line_rollup ON bom_cost_rollup_line (rollup_id);
CREATE INDEX IF NOT EXISTS idx_bom_cost_rollup_line_component ON bom_cost_rollup_line (component_item_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_cost_rollup_line_depth'
      AND conrelid = 'bom_cost_rollup_line'::regclass
  ) THEN
    ALTER TABLE bom_cost_rollup_line
      ADD CONSTRAINT chk_bom_cost_rollup_line_depth CHECK (depth >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_cost_rollup_line_quantity_positive'
      AND conrelid = 'bom_cost_rollup_line'::regclass
  ) THEN
    ALTER TABLE bom_cost_rollup_line
      ADD CONSTRAINT chk_bom_cost_rollup_line_quantity_positive CHECK (effective_quantity_per > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_cost_rollup_line_extended_non_negative'
      AND conrelid = 'bom_cost_rollup_line'::regclass
  ) THEN
    ALTER TABLE bom_cost_rollup_line
      ADD CONSTRAINT chk_bom_cost_rollup_line_extended_non_negative CHECK (extended_cost >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON bom_cost_rollup_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON bom_cost_rollup_line TO readonly_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS bom_outbound_message (
  message_id    UUID PRIMARY KEY,
  bom_id        UUID NOT NULL,
  revision_id   UUID NOT NULL,
  payload       JSONB NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bom_outbound_bom_id ON bom_outbound_message (bom_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON bom_outbound_message TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON bom_outbound_message TO readonly_user;
  END IF;
END $$;

-- Story 7.1: Asset register (mirror of read/projections/asset.sql)

CREATE TABLE IF NOT EXISTS asset (
  asset_id           UUID PRIMARY KEY,
  asset_tag          TEXT NOT NULL,
  asset_name         TEXT NOT NULL,
  criticality_class  TEXT NOT NULL,
  serial_number      TEXT,
  manufacturer       TEXT,
  model              TEXT,
  fixed_asset_ref    TEXT,
  created_by         UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_asset_criticality_class CHECK (criticality_class IN ('critical', 'high', 'medium', 'low'))
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'uq_asset_tag'
      AND indexdef NOT LIKE '%lower(asset_tag)%'
  ) THEN
    DROP INDEX uq_asset_tag;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'uq_asset_serial'
      AND indexdef NOT LIKE '%lower(serial_number)%'
  ) THEN
    DROP INDEX uq_asset_serial;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_tag ON asset (lower(asset_tag));
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_serial ON asset (lower(serial_number)) WHERE serial_number IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_criticality_class'
      AND conrelid = 'asset'::regclass
  ) THEN
    ALTER TABLE asset
      ADD CONSTRAINT chk_asset_criticality_class CHECK (criticality_class IN ('critical', 'high', 'medium', 'low'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON asset TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON asset TO readonly_user;
  END IF;
END $$;

-- Asset usage-meter register (Story 7.2, FR-M-03). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.meter_registered,
-- maintenance.meter_reading_recorded and maintenance.meter_silent_flagged domain events; mutation
-- happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert.
--
-- One asset can carry more than one meter (running hours AND cycle count), so the meter - not the
-- asset - is the target of a reading. current_reading is the latest accepted reading and never
-- decreases (the seam rejects a regression with METER_READING_REGRESSION). silent_after_days is
-- the per-meter configured interval the monthly reconciliation checks (AC 5), and alert_role
-- carries the notification target as DATA so no role name is branched on in code.
--
-- meter_code is canonicalized with lower() in the unique index (the Story 7.1 review lesson):
-- keyboard entry and barcode scan may differ in case and a case variant is the same meter. The
-- guarded DO block below drops a previous exact-match index so a re-applied file self-heals.

CREATE TABLE IF NOT EXISTS asset_meter (
  meter_id           UUID PRIMARY KEY,
  asset_id           UUID NOT NULL,
  meter_code         TEXT NOT NULL,
  unit               TEXT NOT NULL,
  current_reading    NUMERIC(18,4) NOT NULL DEFAULT 0,
  last_reading_at    TIMESTAMPTZ,
  silent_after_days  INTEGER NOT NULL DEFAULT 30,
  alert_role         TEXT NOT NULL,
  silent_flagged_at  TIMESTAMPTZ,
  last_reconciled_at TIMESTAMPTZ,
  created_by         UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_asset_meter_unit CHECK (unit IN ('hours', 'cycles', 'km', 'units')),
  CONSTRAINT chk_asset_meter_silent_after_days CHECK (silent_after_days > 0),
  CONSTRAINT chk_asset_meter_current_reading CHECK (current_reading >= 0)
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'uq_asset_meter_code'
      AND indexdef NOT LIKE '%lower(meter_code)%'
  ) THEN
    DROP INDEX uq_asset_meter_code;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_meter_code ON asset_meter (asset_id, lower(meter_code));
CREATE INDEX IF NOT EXISTS idx_asset_meter_asset ON asset_meter (asset_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_meter_unit'
      AND conrelid = 'asset_meter'::regclass
  ) THEN
    ALTER TABLE asset_meter
      ADD CONSTRAINT chk_asset_meter_unit CHECK (unit IN ('hours', 'cycles', 'km', 'units'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_meter_silent_after_days'
      AND conrelid = 'asset_meter'::regclass
  ) THEN
    ALTER TABLE asset_meter
      ADD CONSTRAINT chk_asset_meter_silent_after_days CHECK (silent_after_days > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_meter_current_reading'
      AND conrelid = 'asset_meter'::regclass
  ) THEN
    ALTER TABLE asset_meter
      ADD CONSTRAINT chk_asset_meter_current_reading CHECK (current_reading >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON asset_meter TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON asset_meter TO readonly_user;
  END IF;
END $$;

-- Asset meter reading ledger (Story 7.2, FR-M-03). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.meter_reading_recorded domain
-- events; mutation happens exclusively through persistEvent, which applies this projection inside
-- the SAME transaction as the domain_events insert. Append-only: a reading is an observation and
-- is never updated or deleted.
--
-- AC 4: a reading is applied identically regardless of where it came from, and every row records
-- its source and capture method. Phase 1 populates 'manual' / 'manual_entry'; 'hub_booking'
-- (Epic 10 Story 10.4) and 'station_equipment' (Phase 2, INT-MTR-01) are already accepted so those
-- feeds need no schema change when they come online.

CREATE TABLE IF NOT EXISTS asset_meter_reading (
  reading_id     UUID PRIMARY KEY,
  meter_id       UUID NOT NULL,
  asset_id       UUID NOT NULL,
  reading_value  NUMERIC(18,4) NOT NULL,
  reading_at     TIMESTAMPTZ NOT NULL,
  source         TEXT NOT NULL,
  capture_method TEXT NOT NULL,
  recorded_by    UUID NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_asset_meter_reading_source CHECK (source IN ('manual', 'hub_booking', 'station_equipment')),
  CONSTRAINT chk_asset_meter_reading_capture_method CHECK (capture_method IN ('manual_entry', 'api', 'device_feed')),
  CONSTRAINT chk_asset_meter_reading_value CHECK (reading_value >= 0)
);

CREATE INDEX IF NOT EXISTS idx_asset_meter_reading_meter ON asset_meter_reading (meter_id, reading_at DESC, reading_id ASC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_meter_reading_source'
      AND conrelid = 'asset_meter_reading'::regclass
  ) THEN
    ALTER TABLE asset_meter_reading
      ADD CONSTRAINT chk_asset_meter_reading_source CHECK (source IN ('manual', 'hub_booking', 'station_equipment'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_meter_reading_capture_method'
      AND conrelid = 'asset_meter_reading'::regclass
  ) THEN
    ALTER TABLE asset_meter_reading
      ADD CONSTRAINT chk_asset_meter_reading_capture_method CHECK (capture_method IN ('manual_entry', 'api', 'device_feed'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_meter_reading_value'
      AND conrelid = 'asset_meter_reading'::regclass
  ) THEN
    ALTER TABLE asset_meter_reading
      ADD CONSTRAINT chk_asset_meter_reading_value CHECK (reading_value >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON asset_meter_reading TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON asset_meter_reading TO readonly_user;
  END IF;
END $$;

-- Preventive maintenance plan register (Story 7.2, FR-M-02). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.plan_defined and
-- maintenance.work_order_generated domain events (the latter advances the plan's next-due
-- cursor); mutation happens exclusively through persistEvent, which applies this projection
-- inside the SAME transaction as the domain_events insert.
--
-- A plan is EITHER calendar-based (interval_days plus next_due_date) OR meter-based (meter_id,
-- interval_meter_units plus next_due_meter); the two guarded CHECKs make the unused half of the
-- pair NULL so a plan can never carry a half-configured schedule. grace_period_days is the AC 2
-- window measured from due_date, and escalation_role carries the notification target as DATA so
-- no role name is branched on in code. plan_name is canonicalized with lower() in the unique
-- index per asset (the Story 7.1 review lesson).

CREATE TABLE IF NOT EXISTS maintenance_plan (
  plan_id              UUID PRIMARY KEY,
  asset_id             UUID NOT NULL,
  plan_name            TEXT NOT NULL,
  plan_type            TEXT NOT NULL,
  interval_days        INTEGER,
  meter_id             UUID,
  interval_meter_units NUMERIC(18,4),
  grace_period_days    INTEGER NOT NULL,
  escalation_role      TEXT NOT NULL,
  anchor_date          DATE NOT NULL,
  next_due_date        DATE,
  next_due_meter       NUMERIC(18,4),
  status               TEXT NOT NULL DEFAULT 'active',
  created_by           UUID NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_maintenance_plan_type CHECK (plan_type IN ('calendar', 'meter')),
  CONSTRAINT chk_maintenance_plan_status CHECK (status IN ('active', 'inactive')),
  CONSTRAINT chk_maintenance_plan_grace CHECK (grace_period_days >= 0),
  CONSTRAINT chk_maintenance_plan_calendar_fields CHECK (plan_type <> 'calendar' OR (interval_days IS NOT NULL AND interval_days > 0 AND next_due_date IS NOT NULL AND meter_id IS NULL AND interval_meter_units IS NULL AND next_due_meter IS NULL)),
  CONSTRAINT chk_maintenance_plan_meter_fields CHECK (plan_type <> 'meter' OR (meter_id IS NOT NULL AND interval_meter_units IS NOT NULL AND interval_meter_units > 0 AND next_due_meter IS NOT NULL AND interval_days IS NULL AND next_due_date IS NULL))
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'uq_maintenance_plan_name'
      AND indexdef NOT LIKE '%lower(plan_name)%'
  ) THEN
    DROP INDEX uq_maintenance_plan_name;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_plan_name ON maintenance_plan (asset_id, lower(plan_name));
CREATE INDEX IF NOT EXISTS idx_maintenance_plan_asset ON maintenance_plan (asset_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_plan_due ON maintenance_plan (status, next_due_date);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_plan_type'
      AND conrelid = 'maintenance_plan'::regclass
  ) THEN
    ALTER TABLE maintenance_plan
      ADD CONSTRAINT chk_maintenance_plan_type CHECK (plan_type IN ('calendar', 'meter'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_plan_status'
      AND conrelid = 'maintenance_plan'::regclass
  ) THEN
    ALTER TABLE maintenance_plan
      ADD CONSTRAINT chk_maintenance_plan_status CHECK (status IN ('active', 'inactive'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_plan_grace'
      AND conrelid = 'maintenance_plan'::regclass
  ) THEN
    ALTER TABLE maintenance_plan
      ADD CONSTRAINT chk_maintenance_plan_grace CHECK (grace_period_days >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_plan_calendar_fields'
      AND conrelid = 'maintenance_plan'::regclass
  ) THEN
    ALTER TABLE maintenance_plan
      ADD CONSTRAINT chk_maintenance_plan_calendar_fields CHECK (plan_type <> 'calendar' OR (interval_days IS NOT NULL AND interval_days > 0 AND next_due_date IS NOT NULL AND meter_id IS NULL AND interval_meter_units IS NULL AND next_due_meter IS NULL));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_plan_meter_fields'
      AND conrelid = 'maintenance_plan'::regclass
  ) THEN
    ALTER TABLE maintenance_plan
      ADD CONSTRAINT chk_maintenance_plan_meter_fields CHECK (plan_type <> 'meter' OR (meter_id IS NOT NULL AND interval_meter_units IS NOT NULL AND interval_meter_units > 0 AND next_due_meter IS NOT NULL AND interval_days IS NULL AND next_due_date IS NULL));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON maintenance_plan TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_plan TO readonly_user;
  END IF;
END $$;

-- Maintenance work order register (Story 7.2, FR-M-02). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.work_order_generated,
-- maintenance.work_order_overdue and maintenance.work_order_completed domain events; mutation
-- happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert.
--
-- uq_maintenance_work_order_cycle is the anti-double-generation key: the generation job is
-- re-runnable and two runs over the same due cycle (or two concurrent runs) must produce exactly
-- ONE work order. The seam pre-check returns the stable DUPLICATE_WORK_ORDER; this partial unique
-- index is the concurrency backstop and the 23505 mapper resolves the winner.
--
-- origin already admits 'breakdown' and plan_id is nullable so Story 7.3 (fault reporting) can
-- share this table without an ALTER; chk_maintenance_work_order_plan_link keeps every preventive
-- work order bound to the plan that generated it. Story 7.2 only ever writes 'preventive'.

CREATE TABLE IF NOT EXISTS maintenance_work_order (
  work_order_id       UUID PRIMARY KEY,
  plan_id             UUID,
  asset_id            UUID NOT NULL,
  origin              TEXT NOT NULL DEFAULT 'preventive',
  due_date            DATE NOT NULL,
  grace_until_date    DATE NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open',
  generated_for_cycle TEXT NOT NULL,
  completed_at        TIMESTAMPTZ,
  completed_by        UUID,
  overdue_at          TIMESTAMPTZ,
  escalated_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_maintenance_work_order_status CHECK (status IN ('open', 'overdue', 'in_progress', 'on_hold', 'completed')),
  CONSTRAINT chk_maintenance_work_order_origin CHECK (origin IN ('preventive', 'breakdown')),
  CONSTRAINT chk_maintenance_work_order_plan_link CHECK (origin <> 'preventive' OR plan_id IS NOT NULL),
  CONSTRAINT chk_maintenance_work_order_grace CHECK (grace_until_date >= due_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_work_order_cycle ON maintenance_work_order (plan_id, generated_for_cycle) WHERE plan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_maintenance_work_order_asset ON maintenance_work_order (asset_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_work_order_sweep ON maintenance_work_order (status, grace_until_date);

-- Story 7.3 breakdown arm (FR-M-04, FR-M-05): additive columns on the SAME table so a breakdown
-- work order shares the work-order register instead of creating a second table. The guarded
-- ALTER blocks re-apply harmlessly on an existing database. fault_report_id and sla_policy_id are
-- references without FKs (projections are event-rebuildable read models; referential integrity is
-- asserted in the seam). priority is a TABLE LOOKUP result from the active SLA policy, never a
-- hardcoded ladder.
ALTER TABLE maintenance_work_order ADD COLUMN IF NOT EXISTS fault_report_id UUID;
ALTER TABLE maintenance_work_order ADD COLUMN IF NOT EXISTS priority TEXT;
ALTER TABLE maintenance_work_order ADD COLUMN IF NOT EXISTS sla_policy_id UUID;
ALTER TABLE maintenance_work_order ADD COLUMN IF NOT EXISTS sla_response_due_at TIMESTAMPTZ;
ALTER TABLE maintenance_work_order ADD COLUMN IF NOT EXISTS sla_resolution_due_at TIMESTAMPTZ;

-- Story 7.3: the anti-double-acceptance key. A fault report may be accepted exactly once; the
-- seam pre-check returns the stable FAULT_ALREADY_TRIAGED and this partial unique index is the
-- concurrency backstop (23505 mapper resolves it to FAULT_ALREADY_TRIAGED). These two indexes
-- reference the columns added above, so they must be created AFTER the ALTER block (a fresh
-- container boot runs the whole file with ON_ERROR_STOP=1).
CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_work_order_fault ON maintenance_work_order (fault_report_id) WHERE fault_report_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_maintenance_work_order_priority ON maintenance_work_order (origin, priority, status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_work_order_status'
      AND conrelid = 'maintenance_work_order'::regclass
  ) THEN
    ALTER TABLE maintenance_work_order
      ADD CONSTRAINT chk_maintenance_work_order_status CHECK (status IN ('open', 'overdue', 'in_progress', 'on_hold', 'completed'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_work_order_origin'
      AND conrelid = 'maintenance_work_order'::regclass
  ) THEN
    ALTER TABLE maintenance_work_order
      ADD CONSTRAINT chk_maintenance_work_order_origin CHECK (origin IN ('preventive', 'breakdown'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_work_order_plan_link'
      AND conrelid = 'maintenance_work_order'::regclass
  ) THEN
    ALTER TABLE maintenance_work_order
      ADD CONSTRAINT chk_maintenance_work_order_plan_link CHECK (origin <> 'preventive' OR plan_id IS NOT NULL);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_work_order_grace'
      AND conrelid = 'maintenance_work_order'::regclass
  ) THEN
    ALTER TABLE maintenance_work_order
      ADD CONSTRAINT chk_maintenance_work_order_grace CHECK (grace_until_date >= due_date);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_work_order_priority'
      AND conrelid = 'maintenance_work_order'::regclass
  ) THEN
    ALTER TABLE maintenance_work_order
      ADD CONSTRAINT chk_maintenance_work_order_priority CHECK (priority IS NULL OR priority IN ('p1', 'p2', 'p3', 'p4'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_work_order_breakdown_link'
      AND conrelid = 'maintenance_work_order'::regclass
  ) THEN
    ALTER TABLE maintenance_work_order
      ADD CONSTRAINT chk_maintenance_work_order_breakdown_link CHECK (origin <> 'breakdown' OR (fault_report_id IS NOT NULL AND priority IS NOT NULL AND sla_policy_id IS NOT NULL));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON maintenance_work_order TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_work_order TO readonly_user;
  END IF;
END $$;

-- Maintenance SLA policy (Story 7.3, FR-M-05). Mirror of read/projections/maintenance_sla_policy.sql
-- for first-boot container init - change both files together. Every statement is idempotent.
-- uq_maintenance_sla_policy_key is the whole configurability contract: exactly ONE active policy
-- per (criticality_class, safety_flag) pair.

CREATE TABLE IF NOT EXISTS maintenance_sla_policy (
  policy_id        UUID PRIMARY KEY,
  criticality_class TEXT NOT NULL,
  safety_flag      BOOLEAN NOT NULL,
  priority         TEXT NOT NULL,
  response_minutes INTEGER NOT NULL,
  resolution_hours INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',
  created_by       UUID NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_maintenance_sla_policy_criticality CHECK (criticality_class IN ('critical', 'high', 'medium', 'low')),
  CONSTRAINT chk_maintenance_sla_policy_priority CHECK (priority IN ('p1', 'p2', 'p3', 'p4')),
  CONSTRAINT chk_maintenance_sla_policy_status CHECK (status IN ('active', 'inactive')),
  CONSTRAINT chk_maintenance_sla_policy_response CHECK (response_minutes > 0 AND response_minutes <= 100000),
  CONSTRAINT chk_maintenance_sla_policy_resolution CHECK (resolution_hours > 0 AND resolution_hours <= 100000)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_sla_policy_key ON maintenance_sla_policy (criticality_class, safety_flag) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_maintenance_sla_policy_status ON maintenance_sla_policy (status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_sla_policy_criticality'
      AND conrelid = 'maintenance_sla_policy'::regclass
  ) THEN
    ALTER TABLE maintenance_sla_policy
      ADD CONSTRAINT chk_maintenance_sla_policy_criticality CHECK (criticality_class IN ('critical', 'high', 'medium', 'low'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_sla_policy_priority'
      AND conrelid = 'maintenance_sla_policy'::regclass
  ) THEN
    ALTER TABLE maintenance_sla_policy
      ADD CONSTRAINT chk_maintenance_sla_policy_priority CHECK (priority IN ('p1', 'p2', 'p3', 'p4'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_sla_policy_status'
      AND conrelid = 'maintenance_sla_policy'::regclass
  ) THEN
    ALTER TABLE maintenance_sla_policy
      ADD CONSTRAINT chk_maintenance_sla_policy_status CHECK (status IN ('active', 'inactive'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_sla_policy_response'
      AND conrelid = 'maintenance_sla_policy'::regclass
  ) THEN
    ALTER TABLE maintenance_sla_policy
      ADD CONSTRAINT chk_maintenance_sla_policy_response CHECK (response_minutes > 0 AND response_minutes <= 100000);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_sla_policy_resolution'
      AND conrelid = 'maintenance_sla_policy'::regclass
  ) THEN
    ALTER TABLE maintenance_sla_policy
      ADD CONSTRAINT chk_maintenance_sla_policy_resolution CHECK (resolution_hours > 0 AND resolution_hours <= 100000);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON maintenance_sla_policy TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_sla_policy TO readonly_user;
  END IF;
END $$;

-- Maintenance fault report (Story 7.3, FR-M-04). Mirror of
-- read/projections/maintenance_fault_report.sql for first-boot container init - change both files
-- together. Every statement is idempotent.

CREATE TABLE IF NOT EXISTS maintenance_fault_report (
  fault_report_id  UUID PRIMARY KEY,
  asset_id         UUID NOT NULL,
  asset_tag        TEXT NOT NULL,
  reported_by      UUID NOT NULL,
  reported_at      TIMESTAMPTZ NOT NULL,
  location_id      UUID NOT NULL,
  description      TEXT NOT NULL,
  safety_flag      BOOLEAN NOT NULL DEFAULT false,
  status           TEXT NOT NULL DEFAULT 'reported',
  work_order_id    UUID,
  triaged_at       TIMESTAMPTZ,
  triaged_by       UUID,
  rejection_reason TEXT,
  notified_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_maintenance_fault_report_status CHECK (status IN ('reported', 'accepted', 'rejected')),
  CONSTRAINT chk_maintenance_fault_report_accept_link CHECK (status <> 'accepted' OR work_order_id IS NOT NULL),
  CONSTRAINT chk_maintenance_fault_report_reject_reason CHECK (status <> 'rejected' OR (rejection_reason IS NOT NULL AND length(btrim(rejection_reason)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_fault_report_asset ON maintenance_fault_report (asset_id, reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_maintenance_fault_report_triage ON maintenance_fault_report (status, reported_at);
CREATE INDEX IF NOT EXISTS idx_maintenance_fault_report_location ON maintenance_fault_report (location_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_fault_report_status'
      AND conrelid = 'maintenance_fault_report'::regclass
  ) THEN
    ALTER TABLE maintenance_fault_report
      ADD CONSTRAINT chk_maintenance_fault_report_status CHECK (status IN ('reported', 'accepted', 'rejected'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_fault_report_accept_link'
      AND conrelid = 'maintenance_fault_report'::regclass
  ) THEN
    ALTER TABLE maintenance_fault_report
      ADD CONSTRAINT chk_maintenance_fault_report_accept_link CHECK (status <> 'accepted' OR work_order_id IS NOT NULL);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_fault_report_reject_reason'
      AND conrelid = 'maintenance_fault_report'::regclass
  ) THEN
    ALTER TABLE maintenance_fault_report
      ADD CONSTRAINT chk_maintenance_fault_report_reject_reason CHECK (status <> 'rejected' OR (rejection_reason IS NOT NULL AND length(btrim(rejection_reason)) > 0));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON maintenance_fault_report TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_fault_report TO readonly_user;
  END IF;
END $$;

-- Maintenance downtime window (Story 7.3, FR-M-06). Mirror of
-- read/projections/maintenance_downtime.sql for first-boot container init - change both files
-- together. Every statement is idempotent. uq_maintenance_downtime_work_order enforces the
-- Phase-1 binding decision: exactly ONE downtime window per breakdown work order.

CREATE TABLE IF NOT EXISTS maintenance_downtime (
  downtime_id      UUID PRIMARY KEY,
  work_order_id    UUID NOT NULL,
  asset_id         UUID NOT NULL,
  started_at       TIMESTAMPTZ NOT NULL,
  ended_at         TIMESTAMPTZ,
  duration_minutes NUMERIC(18,4),
  closed_by        UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_maintenance_downtime_window CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT chk_maintenance_downtime_closure CHECK ((ended_at IS NULL AND duration_minutes IS NULL AND closed_by IS NULL) OR (ended_at IS NOT NULL AND duration_minutes IS NOT NULL AND closed_by IS NOT NULL)),
  CONSTRAINT chk_maintenance_downtime_duration CHECK (duration_minutes IS NULL OR duration_minutes >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_downtime_work_order ON maintenance_downtime (work_order_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_downtime_open ON maintenance_downtime (asset_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_maintenance_downtime_period ON maintenance_downtime (asset_id, ended_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_downtime_window'
      AND conrelid = 'maintenance_downtime'::regclass
  ) THEN
    ALTER TABLE maintenance_downtime
      ADD CONSTRAINT chk_maintenance_downtime_window CHECK (ended_at IS NULL OR ended_at >= started_at);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_downtime_closure'
      AND conrelid = 'maintenance_downtime'::regclass
  ) THEN
    ALTER TABLE maintenance_downtime
      ADD CONSTRAINT chk_maintenance_downtime_closure CHECK ((ended_at IS NULL AND duration_minutes IS NULL AND closed_by IS NULL) OR (ended_at IS NOT NULL AND duration_minutes IS NOT NULL AND closed_by IS NOT NULL));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_downtime_duration'
      AND conrelid = 'maintenance_downtime'::regclass
  ) THEN
    ALTER TABLE maintenance_downtime
      ADD CONSTRAINT chk_maintenance_downtime_duration CHECK (duration_minutes IS NULL OR duration_minutes >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON maintenance_downtime TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_downtime TO readonly_user;
  END IF;
END $$;

-- Maintenance reliability metric snapshot (Story 7.3, FR-M-06). Mirror of
-- read/projections/maintenance_reliability_metric.sql for first-boot container init - change both
-- files together. Every statement is idempotent. uq_maintenance_reliability_metric_scope is the
-- anti-double-report key: a re-run of the same period/scope must not write a second snapshot.
-- Append-only per report (INSERT, SELECT grants only).

CREATE TABLE IF NOT EXISTS maintenance_reliability_metric (
  metric_id         UUID PRIMARY KEY,
  report_id         UUID NOT NULL,
  period_start      DATE NOT NULL,
  period_end        DATE NOT NULL,
  scope_type        TEXT NOT NULL,
  scope_key         TEXT NOT NULL,
  breakdown_count   INTEGER NOT NULL,
  downtime_minutes  NUMERIC(18,4) NOT NULL,
  mttr_minutes      NUMERIC(18,4),
  mtbf_minutes      NUMERIC(18,4),
  generated_by      UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_maintenance_reliability_metric_scope CHECK (scope_type IN ('asset', 'criticality_class')),
  CONSTRAINT chk_maintenance_reliability_metric_period CHECK (period_end >= period_start),
  CONSTRAINT chk_maintenance_reliability_metric_counts CHECK (breakdown_count >= 0 AND downtime_minutes >= 0),
  CONSTRAINT chk_maintenance_reliability_metric_rates CHECK ((mttr_minutes IS NULL OR mttr_minutes >= 0) AND (mtbf_minutes IS NULL OR mtbf_minutes >= 0))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_reliability_metric_scope ON maintenance_reliability_metric (period_start, period_end, scope_type, scope_key);
CREATE INDEX IF NOT EXISTS idx_maintenance_reliability_metric_report ON maintenance_reliability_metric (report_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_reliability_metric_scope'
      AND conrelid = 'maintenance_reliability_metric'::regclass
  ) THEN
    ALTER TABLE maintenance_reliability_metric
      ADD CONSTRAINT chk_maintenance_reliability_metric_scope CHECK (scope_type IN ('asset', 'criticality_class'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_reliability_metric_period'
      AND conrelid = 'maintenance_reliability_metric'::regclass
  ) THEN
    ALTER TABLE maintenance_reliability_metric
      ADD CONSTRAINT chk_maintenance_reliability_metric_period CHECK (period_end >= period_start);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_reliability_metric_counts'
      AND conrelid = 'maintenance_reliability_metric'::regclass
  ) THEN
    ALTER TABLE maintenance_reliability_metric
      ADD CONSTRAINT chk_maintenance_reliability_metric_counts CHECK (breakdown_count >= 0 AND downtime_minutes >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_reliability_metric_rates'
      AND conrelid = 'maintenance_reliability_metric'::regclass
  ) THEN
    ALTER TABLE maintenance_reliability_metric
      ADD CONSTRAINT chk_maintenance_reliability_metric_rates CHECK ((mttr_minutes IS NULL OR mttr_minutes >= 0) AND (mtbf_minutes IS NULL OR mtbf_minutes >= 0));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON maintenance_reliability_metric TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_reliability_metric TO readonly_user;
  END IF;
END $$;

-- Maintenance spare catalogue (Story 7.4, FR-M-07, FR-M-09). Mirror of
-- read/projections/maintenance_spare_catalogue.sql for first-boot container init - change both
-- files together. Every statement is idempotent. Grain is (sku, location_id); this is NOT
-- inventory_planning_params, whose levels are computed outputs of the Story 2.7 jobs.

CREATE TABLE IF NOT EXISTS maintenance_spare_catalogue (
  catalogue_id UUID PRIMARY KEY,
  sku          TEXT NOT NULL,
  location_id  UUID NOT NULL,
  is_critical  BOOLEAN NOT NULL DEFAULT false,
  min_level    NUMERIC(18, 6),
  max_level    NUMERIC(18, 6),
  created_by   UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_maintenance_spare_catalogue_grain UNIQUE (sku, location_id),
  CONSTRAINT chk_maintenance_spare_catalogue_levels CHECK (min_level IS NULL OR max_level IS NULL OR max_level >= min_level),
  CONSTRAINT chk_maintenance_spare_catalogue_min_non_negative CHECK (min_level IS NULL OR min_level >= 0),
  CONSTRAINT chk_maintenance_spare_catalogue_max_non_negative CHECK (max_level IS NULL OR max_level >= 0),
  CONSTRAINT chk_maintenance_spare_catalogue_critical_needs_min CHECK (is_critical = false OR min_level IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_spare_catalogue_location ON maintenance_spare_catalogue (location_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_spare_catalogue_critical ON maintenance_spare_catalogue (is_critical);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_maintenance_spare_catalogue_grain'
      AND conrelid = 'maintenance_spare_catalogue'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_catalogue
      ADD CONSTRAINT uq_maintenance_spare_catalogue_grain UNIQUE (sku, location_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_catalogue_levels'
      AND conrelid = 'maintenance_spare_catalogue'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_catalogue
      ADD CONSTRAINT chk_maintenance_spare_catalogue_levels CHECK (min_level IS NULL OR max_level IS NULL OR max_level >= min_level);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_catalogue_min_non_negative'
      AND conrelid = 'maintenance_spare_catalogue'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_catalogue
      ADD CONSTRAINT chk_maintenance_spare_catalogue_min_non_negative CHECK (min_level IS NULL OR min_level >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_catalogue_max_non_negative'
      AND conrelid = 'maintenance_spare_catalogue'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_catalogue
      ADD CONSTRAINT chk_maintenance_spare_catalogue_max_non_negative CHECK (max_level IS NULL OR max_level >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_catalogue_critical_needs_min'
      AND conrelid = 'maintenance_spare_catalogue'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_catalogue
      ADD CONSTRAINT chk_maintenance_spare_catalogue_critical_needs_min CHECK (is_critical = false OR min_level IS NOT NULL);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON maintenance_spare_catalogue TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_spare_catalogue TO readonly_user;
  END IF;
END $$;

-- Asset parts list, the maintenance-owned equipment BOM (Story 7.4, FR-M-07). Mirror of
-- read/projections/asset_parts_list.sql for first-boot container init - change both files
-- together. Every statement is idempotent. This is NOT the Epic 5 manufacturing BOM (AD-4):
-- one flat row per (asset_id, sku), no header and no revision lifecycle.

CREATE TABLE IF NOT EXISTS asset_parts_list (
  part_line_id UUID PRIMARY KEY,
  asset_id     UUID NOT NULL,
  sku          TEXT NOT NULL,
  quantity_per NUMERIC(18, 6) NOT NULL,
  position_ref TEXT,
  created_by   UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_asset_parts_list_grain UNIQUE (asset_id, sku),
  CONSTRAINT chk_asset_parts_list_quantity_positive CHECK (quantity_per > 0)
);

CREATE INDEX IF NOT EXISTS idx_asset_parts_list_sku ON asset_parts_list (sku);
CREATE INDEX IF NOT EXISTS idx_asset_parts_list_asset ON asset_parts_list (asset_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_asset_parts_list_grain'
      AND conrelid = 'asset_parts_list'::regclass
  ) THEN
    ALTER TABLE asset_parts_list
      ADD CONSTRAINT uq_asset_parts_list_grain UNIQUE (asset_id, sku);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_parts_list_quantity_positive'
      AND conrelid = 'asset_parts_list'::regclass
  ) THEN
    ALTER TABLE asset_parts_list
      ADD CONSTRAINT chk_asset_parts_list_quantity_positive CHECK (quantity_per > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON asset_parts_list TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON asset_parts_list TO readonly_user;
  END IF;
END $$;

-- Maintenance spare reservation (Story 7.4, FR-M-07, FR-M-08). Mirror of
-- read/projections/maintenance_spare_reservation.sql for first-boot container init - change both
-- files together. Every statement is idempotent. The authoritative reserved quantity lives in
-- stock_balance.allocated; this table records the maintenance-side facts only.

CREATE TABLE IF NOT EXISTS maintenance_spare_reservation (
  reservation_id      UUID PRIMARY KEY,
  work_order_id       UUID NOT NULL,
  asset_id            UUID NOT NULL,
  sku                 TEXT NOT NULL,
  location_id         UUID NOT NULL,
  lot_id              TEXT,
  quantity            NUMERIC(18, 6) NOT NULL,
  quantity_returned   NUMERIC(18, 6) NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'reserved',
  reserved_at         TIMESTAMPTZ NOT NULL,
  issued_at           TIMESTAMPTZ,
  return_due_date     DATE,
  returned_at         TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  cancellation_reason TEXT,
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_maintenance_spare_reservation_status CHECK (status IN ('reserved', 'issued', 'partially_returned', 'returned', 'cancelled')),
  CONSTRAINT chk_maintenance_spare_reservation_quantity_positive CHECK (quantity > 0),
  CONSTRAINT chk_maintenance_spare_reservation_returned_non_negative CHECK (quantity_returned >= 0),
  CONSTRAINT chk_maintenance_spare_reservation_returned_bound CHECK (quantity_returned <= quantity),
  CONSTRAINT chk_maintenance_spare_reservation_issue_fields CHECK (
    status IN ('reserved', 'cancelled') OR (issued_at IS NOT NULL AND return_due_date IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_maintenance_spare_reservation_work_order ON maintenance_spare_reservation (work_order_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_spare_reservation_grain ON maintenance_spare_reservation (sku, location_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_spare_reservation_due ON maintenance_spare_reservation (return_due_date) WHERE status IN ('issued', 'partially_returned');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_reservation_status'
      AND conrelid = 'maintenance_spare_reservation'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_reservation
      ADD CONSTRAINT chk_maintenance_spare_reservation_status CHECK (status IN ('reserved', 'issued', 'partially_returned', 'returned', 'cancelled'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_reservation_quantity_positive'
      AND conrelid = 'maintenance_spare_reservation'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_reservation
      ADD CONSTRAINT chk_maintenance_spare_reservation_quantity_positive CHECK (quantity > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_reservation_returned_non_negative'
      AND conrelid = 'maintenance_spare_reservation'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_reservation
      ADD CONSTRAINT chk_maintenance_spare_reservation_returned_non_negative CHECK (quantity_returned >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_reservation_returned_bound'
      AND conrelid = 'maintenance_spare_reservation'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_reservation
      ADD CONSTRAINT chk_maintenance_spare_reservation_returned_bound CHECK (quantity_returned <= quantity);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_reservation_issue_fields'
      AND conrelid = 'maintenance_spare_reservation'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_reservation
      ADD CONSTRAINT chk_maintenance_spare_reservation_issue_fields CHECK (
        status IN ('reserved', 'cancelled') OR (issued_at IS NOT NULL AND return_due_date IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON maintenance_spare_reservation TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_spare_reservation TO readonly_user;
  END IF;
END $$;

-- Maintenance spare alert (Story 7.4, FR-M-08, FR-M-09). Mirror of
-- read/projections/maintenance_spare_alert.sql for first-boot container init - change both files
-- together. Every statement is idempotent. uq_maintenance_spare_alert_day is the same-day
-- contract: one alert per grain per business_date, NULLS NOT DISTINCT so a null reservation_id
-- on a min_breach row still collides.

CREATE TABLE IF NOT EXISTS maintenance_spare_alert (
  alert_id         UUID PRIMARY KEY,
  alert_type       TEXT NOT NULL,
  sku              TEXT NOT NULL,
  location_id      UUID NOT NULL,
  reservation_id   UUID,
  on_hand_at_check NUMERIC(18, 6),
  min_level        NUMERIC(18, 6),
  return_due_date  DATE,
  business_date    DATE NOT NULL,
  flagged_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_maintenance_spare_alert_type CHECK (alert_type IN ('min_breach', 'return_overdue')),
  CONSTRAINT uq_maintenance_spare_alert_day UNIQUE NULLS NOT DISTINCT (alert_type, sku, location_id, reservation_id, business_date),
  CONSTRAINT chk_maintenance_spare_alert_breach_fields CHECK (
    alert_type <> 'min_breach' OR (on_hand_at_check IS NOT NULL AND min_level IS NOT NULL)
  ),
  CONSTRAINT chk_maintenance_spare_alert_overdue_fields CHECK (
    alert_type <> 'return_overdue' OR (reservation_id IS NOT NULL AND return_due_date IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_maintenance_spare_alert_business_date ON maintenance_spare_alert (business_date);
CREATE INDEX IF NOT EXISTS idx_maintenance_spare_alert_grain ON maintenance_spare_alert (sku, location_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_alert_type'
      AND conrelid = 'maintenance_spare_alert'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_alert
      ADD CONSTRAINT chk_maintenance_spare_alert_type CHECK (alert_type IN ('min_breach', 'return_overdue'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_maintenance_spare_alert_day'
      AND conrelid = 'maintenance_spare_alert'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_alert
      ADD CONSTRAINT uq_maintenance_spare_alert_day UNIQUE NULLS NOT DISTINCT (alert_type, sku, location_id, reservation_id, business_date);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_alert_breach_fields'
      AND conrelid = 'maintenance_spare_alert'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_alert
      ADD CONSTRAINT chk_maintenance_spare_alert_breach_fields CHECK (
        alert_type <> 'min_breach' OR (on_hand_at_check IS NOT NULL AND min_level IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_alert_overdue_fields'
      AND conrelid = 'maintenance_spare_alert'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_alert
      ADD CONSTRAINT chk_maintenance_spare_alert_overdue_fields CHECK (
        alert_type <> 'return_overdue' OR (reservation_id IS NOT NULL AND return_due_date IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON maintenance_spare_alert TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_spare_alert TO readonly_user;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Story 7.5: Calibration Register and Non-Overridable Lockout (FR-M-12, FR-M-13, AD-8).
-- The four sections below MUST stay identical to their canonical files under
-- read/projections/ (applied by src/events/migrate.ts and the test harness); those files
-- are the source of truth for tables, indexes, constraints AND grants.
-- ---------------------------------------------------------------------------

-- Instrument register (Story 7.5, FR-M-12, FR-M-13, AD-8, AD-9). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.instrument_registered domain
-- events; mutation happens exclusively through persistEvent, which applies this projection inside
-- the SAME transaction as the domain_events insert.
--
-- An instrument IS an asset (AD-9): asset_id references the single Story 7.1 register and is
-- unique on it, so one asset is at most one instrument record. There is deliberately no
-- is_instrument flag on the asset table - that would push maintenance state into a shared
-- projection every module reads.
--
-- instrument_id is the QC-facing TEXT key that qc.result_recorded carries and that the Story 1.7
-- lockout gate looks up in instrument_calibration_statuses. This table is the ONE row where the
-- text key and the asset id meet. Uniqueness on it is canonicalized with lower() (the Story 7.1
-- asset-tag precedent and the Story 7.2 scanned-versus-typed lesson): a case variant of an
-- existing instrument id is the same physical instrument. The guarded DO block below drops a
-- previous exact-match index so a re-applied file self-heals to the lower() definition.
--
-- There is NO calibration status column here. Certificate validity is the only source of
-- calibrated status for a registered instrument, and two places holding the same fact is how a
-- lockout gets defeated. calibration_interval_days is captured for the alert horizon only; no
-- scheduling surface is built on it in this story.

CREATE TABLE IF NOT EXISTS instrument_register (
  instrument_record_id      UUID PRIMARY KEY,
  asset_id                  UUID NOT NULL,
  instrument_id             TEXT NOT NULL,
  location_id               UUID NOT NULL,
  calibration_interval_days INTEGER NOT NULL,
  registered_by             UUID NOT NULL,
  registered_at             TIMESTAMPTZ NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_instrument_register_asset UNIQUE (asset_id),
  CONSTRAINT chk_instrument_register_interval CHECK (calibration_interval_days > 0 AND calibration_interval_days <= 3650)
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'uq_instrument_register_instrument_id'
      AND indexdef NOT LIKE '%lower(instrument_id)%'
  ) THEN
    DROP INDEX uq_instrument_register_instrument_id;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_instrument_register_instrument_id ON instrument_register (lower(instrument_id));
CREATE INDEX IF NOT EXISTS idx_instrument_register_location ON instrument_register (location_id);
CREATE INDEX IF NOT EXISTS idx_instrument_register_asset ON instrument_register (asset_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_instrument_register_asset'
      AND conrelid = 'instrument_register'::regclass
  ) THEN
    ALTER TABLE instrument_register
      ADD CONSTRAINT uq_instrument_register_asset UNIQUE (asset_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_instrument_register_interval'
      AND conrelid = 'instrument_register'::regclass
  ) THEN
    ALTER TABLE instrument_register
      ADD CONSTRAINT chk_instrument_register_interval CHECK (calibration_interval_days > 0 AND calibration_interval_days <= 3650);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON instrument_register TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON instrument_register TO readonly_user;
  END IF;
END $$;

-- Instrument calibration certificates (Story 7.5, FR-M-12, AD-8). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying
-- maintenance.calibration_certificate_recorded / maintenance.calibration_expired domain events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the
-- SAME transaction as the domain_events insert.
--
-- Certificate validity is the ONLY source of calibrated status for a registered instrument:
-- calibration_status = 'calibrated' if and only if an 'active' certificate exists whose
-- valid_until >= business_date. Exactly one active certificate per instrument is enforced by the
-- partial unique index uq_instrument_calibration_certificate_active, not only by the seam's
-- pre-check (the Story 7.1 one-record lesson) - a pre-check alone loses the concurrent race, and
-- the row that would win here is the one that unlocks an instrument.
--
-- History is RETAINED: a superseded or expired certificate keeps its row and changes status, it is
-- never deleted, so the register can always answer what the instrument was calibrated under on any
-- past date. certificate_number is unique per instrument case-insensitively, matching the register's
-- lower() canonicalization of human-entered keys.

CREATE TABLE IF NOT EXISTS instrument_calibration_certificate (
  certificate_id       UUID PRIMARY KEY,
  instrument_record_id UUID NOT NULL,
  instrument_id        TEXT NOT NULL,
  calibration_type     TEXT NOT NULL,
  certificate_number   TEXT NOT NULL,
  issuing_lab          TEXT,
  calibrated_on        DATE NOT NULL,
  valid_until          DATE NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active',
  recorded_by          UUID NOT NULL,
  recorded_at          TIMESTAMPTZ NOT NULL,
  superseded_at        TIMESTAMPTZ,
  expired_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_instrument_calibration_certificate_type CHECK (calibration_type IN ('in_house', 'iso_17025')),
  CONSTRAINT chk_instrument_calibration_certificate_status CHECK (status IN ('active', 'superseded', 'expired')),
  CONSTRAINT chk_instrument_calibration_certificate_validity CHECK (valid_until >= calibrated_on),
  CONSTRAINT chk_instrument_calibration_certificate_iso_lab CHECK (calibration_type <> 'iso_17025' OR issuing_lab IS NOT NULL)
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'uq_instrument_calibration_certificate_number'
      AND indexdef NOT LIKE '%lower(certificate_number)%'
  ) THEN
    DROP INDEX uq_instrument_calibration_certificate_number;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_instrument_calibration_certificate_active ON instrument_calibration_certificate (instrument_record_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_instrument_calibration_certificate_number ON instrument_calibration_certificate (instrument_record_id, lower(certificate_number));
CREATE INDEX IF NOT EXISTS idx_instrument_calibration_certificate_valid_until ON instrument_calibration_certificate (valid_until) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_instrument_calibration_certificate_instrument ON instrument_calibration_certificate (instrument_record_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_instrument_calibration_certificate_type'
      AND conrelid = 'instrument_calibration_certificate'::regclass
  ) THEN
    ALTER TABLE instrument_calibration_certificate
      ADD CONSTRAINT chk_instrument_calibration_certificate_type CHECK (calibration_type IN ('in_house', 'iso_17025'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_instrument_calibration_certificate_status'
      AND conrelid = 'instrument_calibration_certificate'::regclass
  ) THEN
    ALTER TABLE instrument_calibration_certificate
      ADD CONSTRAINT chk_instrument_calibration_certificate_status CHECK (status IN ('active', 'superseded', 'expired'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_instrument_calibration_certificate_validity'
      AND conrelid = 'instrument_calibration_certificate'::regclass
  ) THEN
    ALTER TABLE instrument_calibration_certificate
      ADD CONSTRAINT chk_instrument_calibration_certificate_validity CHECK (valid_until >= calibrated_on);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_instrument_calibration_certificate_iso_lab'
      AND conrelid = 'instrument_calibration_certificate'::regclass
  ) THEN
    ALTER TABLE instrument_calibration_certificate
      ADD CONSTRAINT chk_instrument_calibration_certificate_iso_lab CHECK (calibration_type <> 'iso_17025' OR issuing_lab IS NOT NULL);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON instrument_calibration_certificate TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON instrument_calibration_certificate TO readonly_user;
  END IF;
END $$;

-- Staged calibration expiry alerts (Story 7.5, FR-M-12, AC 1). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.calibration_expiry_flagged
-- domain events; mutation happens exclusively through persistEvent, which applies this projection
-- inside the SAME transaction as the domain_events insert.
--
-- The grain is (certificate_id, stage_days), NOT (certificate_id, business_date): an expiry
-- countdown fires ONCE PER STAGE per certificate, unlike the Story 7.4 daily breach alert where a
-- persisting breach earns a daily nudge. uq_instrument_calibration_alert_stage is what makes a
-- same-day re-run a no-op and what makes a skipped day catch up rather than lose a stage - the
-- scan asks which stages are due and unfired, never whether the day count equals a stage exactly.
-- A renewal issues a NEW certificate_id and therefore a fresh set of three stages.

CREATE TABLE IF NOT EXISTS instrument_calibration_alert (
  alert_id             UUID PRIMARY KEY,
  certificate_id       UUID NOT NULL,
  instrument_record_id UUID NOT NULL,
  stage_days           INTEGER NOT NULL,
  valid_until          DATE NOT NULL,
  business_date        DATE NOT NULL,
  flagged_at           TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_instrument_calibration_alert_stage CHECK (stage_days IN (30, 14, 7)),
  CONSTRAINT uq_instrument_calibration_alert_stage UNIQUE (certificate_id, stage_days)
);

CREATE INDEX IF NOT EXISTS idx_instrument_calibration_alert_business_date ON instrument_calibration_alert (business_date);
CREATE INDEX IF NOT EXISTS idx_instrument_calibration_alert_instrument ON instrument_calibration_alert (instrument_record_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_instrument_calibration_alert_stage'
      AND conrelid = 'instrument_calibration_alert'::regclass
  ) THEN
    ALTER TABLE instrument_calibration_alert
      ADD CONSTRAINT chk_instrument_calibration_alert_stage CHECK (stage_days IN (30, 14, 7));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_instrument_calibration_alert_stage'
      AND conrelid = 'instrument_calibration_alert'::regclass
  ) THEN
    ALTER TABLE instrument_calibration_alert
      ADD CONSTRAINT uq_instrument_calibration_alert_stage UNIQUE (certificate_id, stage_days);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON instrument_calibration_alert TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON instrument_calibration_alert TO readonly_user;
  END IF;
END $$;

-- Calibration lockout escalations (Story 7.5, FR-M-13, AC 3, AD-8). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying
-- maintenance.calibration_escalation_raised / maintenance.calibration_escalation_resolved domain
-- events; mutation happens exclusively through persistEvent, which applies this projection inside
-- the SAME transaction as the domain_events insert.
--
-- This table is STATUS-NEUTRAL BY CONSTRUCTION (AC 3): it carries no calibration_status column and
-- no expiry field, so an escalation expedites re-calibration without any structural way to bypass
-- the lockout. Resolution requires a resolving_certificate_id, enforced by
-- chk_instrument_calibration_escalation_resolution, so an escalation cannot be closed without the
-- re-calibration it exists to expedite.
--
-- At most one OPEN escalation per instrument, enforced by the partial unique index
-- uq_instrument_calibration_escalation_open rather than only by the seam's pre-check. The DOA route
-- is the Story 1.7 calibration.escalation entry; doa_entry_id and routed_approver_user_id record
-- which entry and which approver the raise resolved to, so the routing is auditable after the fact.

CREATE TABLE IF NOT EXISTS instrument_calibration_escalation (
  escalation_id            UUID PRIMARY KEY,
  instrument_record_id     UUID NOT NULL,
  instrument_id            TEXT NOT NULL,
  doa_entry_id             UUID NOT NULL,
  routed_approver_user_id  UUID NOT NULL,
  reason                   TEXT,
  status                   TEXT NOT NULL DEFAULT 'open',
  raised_by                UUID NOT NULL,
  raised_at                TIMESTAMPTZ NOT NULL,
  resolved_at              TIMESTAMPTZ,
  resolving_certificate_id UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_instrument_calibration_escalation_status CHECK (status IN ('open', 'resolved')),
  CONSTRAINT chk_instrument_calibration_escalation_resolution CHECK (status = 'open' OR (resolved_at IS NOT NULL AND resolving_certificate_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_instrument_calibration_escalation_open ON instrument_calibration_escalation (instrument_record_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_instrument_calibration_escalation_approver ON instrument_calibration_escalation (routed_approver_user_id);
CREATE INDEX IF NOT EXISTS idx_instrument_calibration_escalation_instrument ON instrument_calibration_escalation (instrument_record_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_instrument_calibration_escalation_status'
      AND conrelid = 'instrument_calibration_escalation'::regclass
  ) THEN
    ALTER TABLE instrument_calibration_escalation
      ADD CONSTRAINT chk_instrument_calibration_escalation_status CHECK (status IN ('open', 'resolved'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_instrument_calibration_escalation_resolution'
      AND conrelid = 'instrument_calibration_escalation'::regclass
  ) THEN
    ALTER TABLE instrument_calibration_escalation
      ADD CONSTRAINT chk_instrument_calibration_escalation_resolution CHECK (status = 'open' OR (resolved_at IS NOT NULL AND resolving_certificate_id IS NOT NULL));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON instrument_calibration_escalation TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON instrument_calibration_escalation TO readonly_user;
  END IF;
END $$;
-- Statutory examination register (Story 7.6, FR-M-14, AD-9). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.statutory_examination_recorded,
-- maintenance.statutory_examination_overdue AND maintenance.work_order_completed domain events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert. work_order_completed belongs in that replay set because
-- the Binding Decision 6 stamp invalidation flips a weighbridge row to 'overdue' from the work
-- order applier, with no statutory event of its own: a rebuild that omits it resurrects every
-- work-order-invalidated stamp as 'compliant' and silently unlocks the device for trade weighment.
--
-- A statutory subject IS an asset (AD-9): asset_id references the single Story 7.1 register. The
-- grain is (asset_id, examination_type), so one asset carries at most one OSH Code examination and
-- at most one weighbridge legal-metrology stamp. The weighbridge device_id (free text on
-- weighbridge_event) is mapped via device_key, canonicalized with lower() to match the Story 7.1
-- asset-tag and Story 7.5 instrument-id precedent: a case variant of a registered device key is the
-- same physical weighbridge.
--
-- status is the lockout flag the Story 7.6 gates read: 'compliant' allows use, 'overdue' locks the
-- asset from use (AC1) and blocks trade weighment on the device (AC2). It is written only by the
-- examination applier and the overdue scan; no other surface flips it.

CREATE TABLE IF NOT EXISTS statutory_examination (
  examination_id    UUID PRIMARY KEY,
  asset_id          UUID NOT NULL,
  examination_type  TEXT NOT NULL,
  interval_months   INTEGER NOT NULL,
  next_due_date     DATE NOT NULL,
  status            TEXT NOT NULL DEFAULT 'compliant',
  device_key        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_statutory_examination_asset_type UNIQUE (asset_id, examination_type),
  CONSTRAINT chk_statutory_examination_type CHECK (examination_type IN ('osh_code', 'weighbridge_legal_metrology')),
  CONSTRAINT chk_statutory_examination_status CHECK (status IN ('compliant', 'overdue')),
  CONSTRAINT chk_statutory_examination_interval CHECK (interval_months > 0 AND interval_months <= 120)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_statutory_examination_device_key ON statutory_examination (lower(device_key)) WHERE device_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_statutory_examination_status_due ON statutory_examination (status, next_due_date);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_statutory_examination_asset_type'
      AND conrelid = 'statutory_examination'::regclass
  ) THEN
    ALTER TABLE statutory_examination
      ADD CONSTRAINT uq_statutory_examination_asset_type UNIQUE (asset_id, examination_type);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_statutory_examination_type'
      AND conrelid = 'statutory_examination'::regclass
  ) THEN
    ALTER TABLE statutory_examination
      ADD CONSTRAINT chk_statutory_examination_type CHECK (examination_type IN ('osh_code', 'weighbridge_legal_metrology'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_statutory_examination_status'
      AND conrelid = 'statutory_examination'::regclass
  ) THEN
    ALTER TABLE statutory_examination
      ADD CONSTRAINT chk_statutory_examination_status CHECK (status IN ('compliant', 'overdue'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_statutory_examination_interval'
      AND conrelid = 'statutory_examination'::regclass
  ) THEN
    ALTER TABLE statutory_examination
      ADD CONSTRAINT chk_statutory_examination_interval CHECK (interval_months > 0 AND interval_months <= 120);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON statutory_examination TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON statutory_examination TO readonly_user;
  END IF;
END $$;
-- Statutory examination records (Story 7.6, FR-M-14). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.statutory_examination_recorded
-- domain events; mutation happens exclusively through persistEvent, which applies this projection
-- inside the SAME transaction as the domain_events insert.
--
-- Each row is one examination event (the certificate-style evidence record) against a statutory
-- examination register row. One examination can be recorded many times (re-stamping); the register
-- row carries the CURRENT compliance state while this table keeps the immutable history.
-- certificate_number_ext is canonicalized with lower() for the unique index, matching the
-- instrument_calibration_certificate precedent: a case variant of a recorded certificate number is
-- the same document.

CREATE TABLE IF NOT EXISTS statutory_examination_record (
  record_id              UUID PRIMARY KEY,
  examination_id         UUID NOT NULL,
  examined_on            DATE NOT NULL,
  next_due_date          DATE NOT NULL,
  certificate_number_ext TEXT,
  examined_by            UUID,
  examined_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_statutory_examination_record_dates CHECK (next_due_date >= examined_on)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_statutory_examination_record_number ON statutory_examination_record (examination_id, lower(certificate_number_ext)) WHERE certificate_number_ext IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_statutory_examination_record_examination ON statutory_examination_record (examination_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_statutory_examination_record_dates'
      AND conrelid = 'statutory_examination_record'::regclass
  ) THEN
    ALTER TABLE statutory_examination_record
      ADD CONSTRAINT chk_statutory_examination_record_dates CHECK (next_due_date >= examined_on);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON statutory_examination_record TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON statutory_examination_record TO readonly_user;
  END IF;
END $$;
-- Asset operational status projection (Story 7.6, FR-M-16). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.asset_status_changed domain
-- events; mutation happens exclusively through persistEvent, which applies this projection inside
-- the SAME transaction as the domain_events insert.
--
-- The status vocabulary is the machine-status contract (Table 5): running, idle, breakdown,
-- maintenance. sign_off_by / sign_off_at are the return-to-service supervisor sign-off (AC5),
-- written back onto the payload by the applier from the resolved DOA approver under lock; they are
-- only ever set on a transition TO running from breakdown or maintenance.

CREATE TABLE IF NOT EXISTS asset_operational_status (
  asset_id     UUID PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'idle',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   UUID,
  sign_off_by  UUID,
  sign_off_at  TIMESTAMPTZ,
  CONSTRAINT chk_asset_operational_status CHECK (status IN ('running', 'idle', 'breakdown', 'maintenance'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_operational_status'
      AND conrelid = 'asset_operational_status'::regclass
  ) THEN
    ALTER TABLE asset_operational_status
      ADD CONSTRAINT chk_asset_operational_status CHECK (status IN ('running', 'idle', 'breakdown', 'maintenance'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON asset_operational_status TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON asset_operational_status TO readonly_user;
  END IF;
END $$;
-- Per-asset maintenance cost rollup (Story 7.6, FR-M-15). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.work_order_completed domain
-- events; mutation happens exclusively through persistEvent, which applies this projection inside
-- the SAME transaction as the domain_events insert.
--
-- The three totals are the SUM of the matching columns across all completed maintenance_work_order
-- rows for the asset (Story 5.6 BOM cost rollup pattern): all arithmetic runs in PostgreSQL
-- NUMERIC, costs enter and leave as exact decimal strings, and the applier ADDS the new costs to
-- the existing totals inside the same transaction. last_work_order_id / last_closed_at point at the
-- most recent completing work order for the lifecycle-costing read.

CREATE TABLE IF NOT EXISTS maintenance_asset_cost (
  asset_id            UUID PRIMARY KEY,
  total_labor_cost    NUMERIC(14,3) NOT NULL DEFAULT 0,
  total_parts_cost    NUMERIC(14,3) NOT NULL DEFAULT 0,
  total_cost          NUMERIC(14,3) NOT NULL DEFAULT 0,
  last_work_order_id  UUID,
  last_closed_at      TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_maintenance_asset_cost_labor_non_negative CHECK (total_labor_cost >= 0),
  CONSTRAINT chk_maintenance_asset_cost_parts_non_negative CHECK (total_parts_cost >= 0),
  CONSTRAINT chk_maintenance_asset_cost_total_non_negative CHECK (total_cost >= 0)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_asset_cost_labor_non_negative'
      AND conrelid = 'maintenance_asset_cost'::regclass
  ) THEN
    ALTER TABLE maintenance_asset_cost
      ADD CONSTRAINT chk_maintenance_asset_cost_labor_non_negative CHECK (total_labor_cost >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_asset_cost_parts_non_negative'
      AND conrelid = 'maintenance_asset_cost'::regclass
  ) THEN
    ALTER TABLE maintenance_asset_cost
      ADD CONSTRAINT chk_maintenance_asset_cost_parts_non_negative CHECK (total_parts_cost >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_asset_cost_total_non_negative'
      AND conrelid = 'maintenance_asset_cost'::regclass
  ) THEN
    ALTER TABLE maintenance_asset_cost
      ADD CONSTRAINT chk_maintenance_asset_cost_total_non_negative CHECK (total_cost >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON maintenance_asset_cost TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_asset_cost TO readonly_user;
  END IF;
END $$;
-- Story 7.6 cost arm (FR-M-15): additive cost columns on the SAME table so lifecycle costing rides
-- the existing work-order register instead of creating a second one. The guarded DO blocks
-- re-apply harmlessly on an existing database. Costs are NUMERIC(14,3) strings end to end (the
-- Story 5.6 BOM cost rollup pattern): total_cost = labor_cost + parts_cost is computed in SQL
-- NUMERIC by the applier, and capitalization_flagged is the server-derived strictly-greater-than
-- threshold comparison (config.maintenance.capitalizationThreshold), never client-entered. The
-- existing columns, constraints and indexes are untouched.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'maintenance_work_order' AND column_name = 'labor_cost'
  ) THEN
    ALTER TABLE maintenance_work_order ADD COLUMN labor_cost NUMERIC(14,3) NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'maintenance_work_order' AND column_name = 'parts_cost'
  ) THEN
    ALTER TABLE maintenance_work_order ADD COLUMN parts_cost NUMERIC(14,3) NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'maintenance_work_order' AND column_name = 'total_cost'
  ) THEN
    ALTER TABLE maintenance_work_order ADD COLUMN total_cost NUMERIC(14,3) NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'maintenance_work_order' AND column_name = 'capitalization_flagged'
  ) THEN
    ALTER TABLE maintenance_work_order ADD COLUMN capitalization_flagged BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_work_order_labor_non_negative'
      AND conrelid = 'maintenance_work_order'::regclass
  ) THEN
    ALTER TABLE maintenance_work_order
      ADD CONSTRAINT chk_maintenance_work_order_labor_non_negative CHECK (labor_cost >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_work_order_parts_non_negative'
      AND conrelid = 'maintenance_work_order'::regclass
  ) THEN
    ALTER TABLE maintenance_work_order
      ADD CONSTRAINT chk_maintenance_work_order_parts_non_negative CHECK (parts_cost >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_work_order_total_non_negative'
      AND conrelid = 'maintenance_work_order'::regclass
  ) THEN
    ALTER TABLE maintenance_work_order
      ADD CONSTRAINT chk_maintenance_work_order_total_non_negative CHECK (total_cost >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON maintenance_work_order TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_work_order TO readonly_user;
  END IF;
END $$;

-- Story 6.1: production order projection (FR-MO-01/02/03). Mirror of read/projections/production_order.sql.
-- Production order read model (Story 6.1, FR-MO-01/02/03, AD-5). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying production_order.* domain events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert. status is the six-state lifecycle machine (Table 2):
-- planned -> released -> in_process -> completed -> closed, with planned|released -> cancelled.
-- order_number_ext is server-allocated from production_order_number_seq in the MO-YYYY-NNNN format
-- (the IND-YYYY-NNNN pattern, with an MO- prefix so the PO- namespace owned by purchase orders is
-- never entered) and immutable thereafter: the applier allocates the number and writes it back onto
-- the persisted payload, and any declared number that disagrees rejects ORDER_NUMBER_IMMUTABLE.
--
-- chk_production_order_expediting_pairing makes an expediting flag without a recorded overrider and
-- reason structurally impossible (AC6 enforced by the database). chk_production_order_unreversed_non_
-- negative makes a decrement below zero fail loudly in Story 6.2 rather than silently unlocking a
-- cancel that AC4 forbids. released_revision_id is deliberately nullable and set only at release:
-- the revision is pinned from the explosion result so a BOM released after creation cannot
-- retroactively change what a released order was gated against.

CREATE TABLE IF NOT EXISTS production_order (
  production_order_id       UUID PRIMARY KEY,
  order_number_ext          TEXT NOT NULL,
  output_item_id            UUID NOT NULL,
  output_sku                TEXT NOT NULL,
  order_quantity            NUMERIC(18,6) NOT NULL,
  order_uom                 TEXT NOT NULL,
  plant_location_id         UUID NOT NULL,
  bom_id                    UUID NOT NULL,
  released_revision_id      UUID,
  business_stream           TEXT NOT NULL,
  source_reference_type     TEXT NOT NULL,
  source_reference_id       TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'planned',
  expediting_flag           BOOLEAN NOT NULL DEFAULT false,
  override_by               UUID,
  override_reason           TEXT,
  released_at               TIMESTAMPTZ,
  released_by               UUID,
  cancelled_at              TIMESTAMPTZ,
  cancelled_by              UUID,
  unreversed_transaction_count INTEGER NOT NULL DEFAULT 0,
  created_by                UUID NOT NULL,
  correlation_id            UUID,
  source_event_id           UUID NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_production_order_status CHECK (status IN ('planned','released','in_process','completed','closed','cancelled')),
  CONSTRAINT chk_production_order_quantity_positive CHECK (order_quantity > 0),
  CONSTRAINT chk_production_order_source_reference_type CHECK (source_reference_type IN ('erp_sales_order','indent','rd_project','manual')),
  CONSTRAINT chk_production_order_unreversed_non_negative CHECK (unreversed_transaction_count >= 0),
  CONSTRAINT chk_production_order_expediting_pairing CHECK ((expediting_flag = true AND override_by IS NOT NULL AND override_reason IS NOT NULL AND btrim(override_reason) <> '') OR (expediting_flag = false AND override_by IS NULL AND override_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_production_order_number_ext ON production_order (order_number_ext);
CREATE INDEX IF NOT EXISTS idx_production_order_status ON production_order (status);
CREATE INDEX IF NOT EXISTS idx_production_order_plant ON production_order (plant_location_id);
CREATE INDEX IF NOT EXISTS idx_production_order_output_item ON production_order (output_item_id);
CREATE INDEX IF NOT EXISTS idx_production_order_bom ON production_order (bom_id);
CREATE INDEX IF NOT EXISTS idx_production_order_business_stream ON production_order (business_stream);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_status'
      AND conrelid = 'production_order'::regclass
  ) THEN
    ALTER TABLE production_order
      ADD CONSTRAINT chk_production_order_status CHECK (status IN ('planned','released','in_process','completed','closed','cancelled'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_quantity_positive'
      AND conrelid = 'production_order'::regclass
  ) THEN
    ALTER TABLE production_order
      ADD CONSTRAINT chk_production_order_quantity_positive CHECK (order_quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_source_reference_type'
      AND conrelid = 'production_order'::regclass
  ) THEN
    ALTER TABLE production_order
      ADD CONSTRAINT chk_production_order_source_reference_type CHECK (source_reference_type IN ('erp_sales_order','indent','rd_project','manual'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_unreversed_non_negative'
      AND conrelid = 'production_order'::regclass
  ) THEN
    ALTER TABLE production_order
      ADD CONSTRAINT chk_production_order_unreversed_non_negative CHECK (unreversed_transaction_count >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_expediting_pairing'
      AND conrelid = 'production_order'::regclass
  ) THEN
    ALTER TABLE production_order
      ADD CONSTRAINT chk_production_order_expediting_pairing CHECK ((expediting_flag = true AND override_by IS NOT NULL AND override_reason IS NOT NULL AND btrim(override_reason) <> '') OR (expediting_flag = false AND override_by IS NULL AND override_reason IS NULL));
  END IF;
END $$;

-- Story 6.3 (FR-MO-07/09/10) column upgrade. These columns are added by a GUARDED ALTER rather
-- than being written into the CREATE TABLE above, so the file stays re-appliable against a live
-- database provisioned before Story 6.3 (the Story 8.4 review lesson: an unguarded ADD COLUMN
-- breaks re-application). completed_quantity accumulates the PRIMARY output only - co-products and
-- by-products are separate outputs and never count toward the ordered quantity. The three
-- short_close_* columns are the FR-MO-09 close-short decision Story 6.4's closure gate reads; the
-- pairing CHECK makes a half-recorded decision structurally impossible. source_rework_event_id and
-- source_lot_id are the FR-MO-10 rework linkage: a rework order is an ordinary production order
-- (Binding Decision 9), and the partial unique index makes one rework order per qc.rework_requested
-- event a database fact rather than a check-then-act race.
ALTER TABLE production_order ADD COLUMN IF NOT EXISTS completed_quantity     NUMERIC(18,6) NOT NULL DEFAULT 0;
ALTER TABLE production_order ADD COLUMN IF NOT EXISTS scrapped_quantity      NUMERIC(18,6) NOT NULL DEFAULT 0;
ALTER TABLE production_order ADD COLUMN IF NOT EXISTS short_close_reason     TEXT;
ALTER TABLE production_order ADD COLUMN IF NOT EXISTS short_closed_at        TIMESTAMPTZ;
ALTER TABLE production_order ADD COLUMN IF NOT EXISTS short_closed_by        UUID;
ALTER TABLE production_order ADD COLUMN IF NOT EXISTS source_rework_event_id UUID;
ALTER TABLE production_order ADD COLUMN IF NOT EXISTS source_lot_id          UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_completed_non_negative'
      AND conrelid = 'production_order'::regclass
  ) THEN
    ALTER TABLE production_order
      ADD CONSTRAINT chk_production_order_completed_non_negative CHECK (completed_quantity >= 0 AND scrapped_quantity >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_short_close_pairing'
      AND conrelid = 'production_order'::regclass
  ) THEN
    ALTER TABLE production_order
      ADD CONSTRAINT chk_production_order_short_close_pairing CHECK ((short_close_reason IS NOT NULL AND btrim(short_close_reason) <> '' AND short_closed_at IS NOT NULL AND short_closed_by IS NOT NULL) OR (short_close_reason IS NULL AND short_closed_at IS NULL AND short_closed_by IS NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_rework_pairing'
      AND conrelid = 'production_order'::regclass
  ) THEN
    ALTER TABLE production_order
      ADD CONSTRAINT chk_production_order_rework_pairing CHECK ((source_rework_event_id IS NOT NULL AND source_lot_id IS NOT NULL) OR (source_rework_event_id IS NULL AND source_lot_id IS NULL));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_production_order_source_rework_event ON production_order (source_rework_event_id) WHERE source_rework_event_id IS NOT NULL;

-- Server-side human-ID allocation for the MO-YYYY-NNNN format. A sequence is the only lock-free
-- allocator that survives concurrent creations; the year prefix is applied in the applier. Gaps on
-- rolled-back creates are acceptable - uniqueness is what matters (the indent_number_seq precedent).
CREATE SEQUENCE IF NOT EXISTS production_order_number_seq;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON production_order TO app_user;
    GRANT USAGE ON SEQUENCE production_order_number_seq TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON production_order TO readonly_user;
  END IF;
END $$;


-- Asset coverage register: AMC, warranty, and insurance contracts (Story 7.7, FR-M-10/11, AD-9).
-- This file is the CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and
-- the integration-test harness. It carries its OWN grants (guarded DO blocks) so a
-- migrate-provisioned database can serve reads/writes as app_user without depending on
-- deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates this content for first-boot
-- container init - change both files together. Every statement is idempotent (IF NOT EXISTS /
-- guarded DO blocks) so the file can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.coverage_recorded domain
-- events; mutation happens exclusively through persistEvent, which applies this projection inside
-- the SAME transaction as the domain_events insert.
--
-- One table serves all three coverage kinds (Binding Decision 13): AMC, warranty, and insurance
-- rows differ only in coverage_type and in the fact that only 'warranty' drives the Story 7.7
-- work-order check. asset_id references the single Story 7.1 company-wide asset register (AD-9),
-- so there is no location column and no site scoping.
--
-- Records are APPEND-ONLY with no amendment, void, or supersede path in Phase 1 (Binding
-- Decision 5): a renewal is a NEW row with a new coverage_id, which earns a fresh set of 90/60/30
-- alert stages. The uniqueness grain is (asset_id, coverage_type, lower(reference_number_ext)),
-- expressed as a UNIQUE INDEX because it contains an expression - never a table-level UNIQUE on an
-- expression (the Story 7.5 rule). Case canonicalization matches the Story 7.1 asset-tag and Story
-- 7.5 instrument-id precedent: a case variant of a contract reference is the same contract.

CREATE TABLE IF NOT EXISTS asset_coverage (
  coverage_id          UUID PRIMARY KEY,
  asset_id             UUID NOT NULL,
  coverage_type        TEXT NOT NULL,
  provider_name        TEXT NOT NULL,
  reference_number_ext TEXT NOT NULL,
  start_date           DATE NOT NULL,
  expiry_date          DATE NOT NULL,
  contract_value       NUMERIC(14,3),
  recorded_by          UUID NOT NULL,
  recorded_at          TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_asset_coverage_type CHECK (coverage_type IN ('amc', 'warranty', 'insurance')),
  CONSTRAINT chk_asset_coverage_provider_name CHECK (btrim(provider_name) <> ''),
  CONSTRAINT chk_asset_coverage_reference_ext CHECK (btrim(reference_number_ext) <> ''),
  CONSTRAINT chk_asset_coverage_dates CHECK (expiry_date >= start_date),
  CONSTRAINT chk_asset_coverage_value_non_negative CHECK (contract_value IS NULL OR contract_value >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_coverage_reference ON asset_coverage (asset_id, coverage_type, lower(reference_number_ext));
CREATE INDEX IF NOT EXISTS idx_asset_coverage_asset ON asset_coverage (asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_coverage_expiry ON asset_coverage (expiry_date);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_coverage_type'
      AND conrelid = 'asset_coverage'::regclass
  ) THEN
    ALTER TABLE asset_coverage
      ADD CONSTRAINT chk_asset_coverage_type CHECK (coverage_type IN ('amc', 'warranty', 'insurance'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_coverage_provider_name'
      AND conrelid = 'asset_coverage'::regclass
  ) THEN
    ALTER TABLE asset_coverage
      ADD CONSTRAINT chk_asset_coverage_provider_name CHECK (btrim(provider_name) <> '');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_coverage_reference_ext'
      AND conrelid = 'asset_coverage'::regclass
  ) THEN
    ALTER TABLE asset_coverage
      ADD CONSTRAINT chk_asset_coverage_reference_ext CHECK (btrim(reference_number_ext) <> '');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_coverage_dates'
      AND conrelid = 'asset_coverage'::regclass
  ) THEN
    ALTER TABLE asset_coverage
      ADD CONSTRAINT chk_asset_coverage_dates CHECK (expiry_date >= start_date);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_coverage_value_non_negative'
      AND conrelid = 'asset_coverage'::regclass
  ) THEN
    ALTER TABLE asset_coverage
      ADD CONSTRAINT chk_asset_coverage_value_non_negative CHECK (contract_value IS NULL OR contract_value >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON asset_coverage TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON asset_coverage TO readonly_user;
  END IF;
END $$;

-- Staged coverage expiry alerts (Story 7.7, FR-M-10, AC 1). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.coverage_expiry_flagged domain
-- events; mutation happens exclusively through persistEvent, which applies this projection inside
-- the SAME transaction as the domain_events insert.
--
-- The grain is (coverage_id, stage_days), NOT (coverage_id, business_date): an expiry countdown
-- fires ONCE PER STAGE per coverage. uq_asset_coverage_alert_stage is what makes a same-day re-run
-- a no-op and what makes a skipped day catch up rather than lose a stage - the scan asks which
-- stages are due AND unfired, never whether the day count equals a stage exactly. A renewal is a
-- NEW coverage_id and therefore earns a fresh set of three stages (Binding Decision 5 and 7).
-- The stages 90/60/30 are pinned by FR-M-10 itself, so they are a module constant and never
-- deployment configuration.

CREATE TABLE IF NOT EXISTS asset_coverage_alert (
  alert_id      UUID PRIMARY KEY,
  coverage_id   UUID NOT NULL,
  asset_id      UUID NOT NULL,
  stage_days    INTEGER NOT NULL,
  expiry_date   DATE NOT NULL,
  business_date DATE NOT NULL,
  flagged_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_asset_coverage_alert_stage CHECK (stage_days IN (90, 60, 30)),
  CONSTRAINT uq_asset_coverage_alert_stage UNIQUE (coverage_id, stage_days)
);

CREATE INDEX IF NOT EXISTS idx_asset_coverage_alert_business_date ON asset_coverage_alert (business_date);
CREATE INDEX IF NOT EXISTS idx_asset_coverage_alert_asset ON asset_coverage_alert (asset_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_coverage_alert_stage'
      AND conrelid = 'asset_coverage_alert'::regclass
  ) THEN
    ALTER TABLE asset_coverage_alert
      ADD CONSTRAINT chk_asset_coverage_alert_stage CHECK (stage_days IN (90, 60, 30));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_asset_coverage_alert_stage'
      AND conrelid = 'asset_coverage_alert'::regclass
  ) THEN
    ALTER TABLE asset_coverage_alert
      ADD CONSTRAINT uq_asset_coverage_alert_stage UNIQUE (coverage_id, stage_days);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON asset_coverage_alert TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON asset_coverage_alert TO readonly_user;
  END IF;
END $$;

-- Reason-coded warranty overrides on breakdown work orders (Story 7.7, FR-M-11, AC 3 and AC 4).
-- This file is the CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and
-- the integration-test harness. It carries its OWN grants (guarded DO blocks) so a
-- migrate-provisioned database can serve reads/writes as app_user without depending on
-- deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates this content for first-boot
-- container init - change both files together. Every statement is idempotent (IF NOT EXISTS /
-- guarded DO blocks) so the file can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.warranty_override_recorded
-- domain events; mutation happens exclusively through persistEvent, which applies this projection
-- inside the SAME transaction as the domain_events insert.
--
-- The grain is ONE override per work order (Binding Decision 11): a reason-coded override is a
-- one-time supervisor decision, and uq_maintenance_warranty_override_work_order is the concurrency
-- backstop behind the sequential pre-check (a 23505 on it resolves to 409
-- WARRANTY_OVERRIDE_ALREADY_RECORDED with the existing override id, so the race path and the
-- sequential path return the same shape).
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE (the maintenance_reliability_
-- metric precedent). An override is never mutated; a mistaken one stands in the record.

CREATE TABLE IF NOT EXISTS maintenance_warranty_override (
  override_id          UUID PRIMARY KEY,
  work_order_id        UUID NOT NULL,
  warranty_coverage_id UUID NOT NULL,
  reason_code          TEXT NOT NULL,
  overridden_by        UUID NOT NULL,
  overridden_at        TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_maintenance_warranty_override_work_order UNIQUE (work_order_id),
  CONSTRAINT chk_maintenance_warranty_override_reason CHECK (btrim(reason_code) <> '')
);

CREATE INDEX IF NOT EXISTS idx_maintenance_warranty_override_coverage ON maintenance_warranty_override (warranty_coverage_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_maintenance_warranty_override_work_order'
      AND conrelid = 'maintenance_warranty_override'::regclass
  ) THEN
    ALTER TABLE maintenance_warranty_override
      ADD CONSTRAINT uq_maintenance_warranty_override_work_order UNIQUE (work_order_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_warranty_override_reason'
      AND conrelid = 'maintenance_warranty_override'::regclass
  ) THEN
    ALTER TABLE maintenance_warranty_override
      ADD CONSTRAINT chk_maintenance_warranty_override_reason CHECK (btrim(reason_code) <> '');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON maintenance_warranty_override TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_warranty_override TO readonly_user;
  END IF;
END $$;

-- Story 7.7 warranty arm (FR-M-11): two additive columns on the SAME work-order register so the
-- warranty check rides the existing row instead of a side table. Both are SERVER-DERIVED in
-- applyBreakdownWorkOrderCreated from the active-warranty lookup against the payload business_date
-- (Binding Decisions 3 and 4): a declared warranty_flagged or warranty_coverage_id in the envelope
-- is rejected with WORK_ORDER_DERIVATION_MISMATCH, so there is no client write path. Preventive
-- work orders are never checked and keep the false default (Binding Decision 2). The two columns
-- are paired by chk_maintenance_work_order_warranty_pairing below, so a flagged row always carries
-- the coverage the override grain requires. The existing columns, constraints and indexes are
-- untouched.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'maintenance_work_order' AND column_name = 'warranty_flagged'
  ) THEN
    ALTER TABLE maintenance_work_order ADD COLUMN warranty_flagged BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'maintenance_work_order' AND column_name = 'warranty_coverage_id'
  ) THEN
    ALTER TABLE maintenance_work_order ADD COLUMN warranty_coverage_id UUID;
  END IF;
END $$;

-- Review decision D6: pair the two warranty columns at the database level. A row carrying
-- warranty_flagged = true with warranty_coverage_id IS NULL is otherwise structurally legal and can
-- NEVER be completed, because the override applier re-derives the coverage id from the locked work
-- order row and maintenance_warranty_override.warranty_coverage_id is NOT NULL, so the completion
-- raises SQLSTATE 23502 as an unmapped 500 forever. The seam always derives the pair together, so
-- the only writer that can produce the broken shape is direct SQL; Story 6.1 pins exactly this
-- class in the same migration batch with chk_production_order_expediting_pairing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_work_order_warranty_pairing'
      AND conrelid = 'maintenance_work_order'::regclass
  ) THEN
    ALTER TABLE maintenance_work_order
      ADD CONSTRAINT chk_maintenance_work_order_warranty_pairing CHECK ((warranty_flagged = false AND warranty_coverage_id IS NULL) OR (warranty_flagged = true AND warranty_coverage_id IS NOT NULL));
  END IF;
END $$;

-- Review decision D2: warranty_flagged is derived exactly once, at breakdown work-order creation,
-- so every breakdown work order still OPEN when this migration runs would keep the false default
-- permanently and complete without ever demanding an override. AC 2 and AC 3 would silently not
-- apply to the whole pre-migration backlog. This one-shot pass re-derives the pair for those rows
-- with the SAME single-winner rule getActiveWarrantyForAsset applies (coverage_type 'warranty', in
-- force on the date, latest expiry wins, lowest coverage_id breaks the tie).
--
-- It lives in asset_coverage.sql, not in maintenance_work_order.sql, because the work-order file
-- migrates FIRST and the coverage register does not exist yet at that point.
--
-- The column comment is the one-shot marker: a re-run returns before touching a row, so a coverage
-- recorded after the backfill can never retroactively flag a work order (the replay-determinism
-- class logged under review decision D4). CURRENT_DATE is read deliberately and is the only clock
-- read on the Story 7.7 path: a migration has no payload business_date to derive from.
DO $$
DECLARE
  marker_attnum SMALLINT;
BEGIN
  IF to_regclass('maintenance_work_order') IS NULL THEN
    RETURN;
  END IF;
  SELECT attnum INTO marker_attnum
    FROM pg_attribute
   WHERE attrelid = 'maintenance_work_order'::regclass
     AND attname = 'warranty_flagged'
     AND NOT attisdropped;
  IF marker_attnum IS NULL THEN
    RETURN;
  END IF;
  IF col_description('maintenance_work_order'::regclass, marker_attnum) IS NOT NULL THEN
    RETURN;
  END IF;

  UPDATE maintenance_work_order w
     SET warranty_flagged = true,
         warranty_coverage_id = cur.coverage_id,
         updated_at = now()
    FROM (
      SELECT DISTINCT ON (asset_id) asset_id, coverage_id
        FROM asset_coverage
       WHERE coverage_type = 'warranty'
         AND start_date <= CURRENT_DATE
         AND expiry_date >= CURRENT_DATE
       ORDER BY asset_id, expiry_date DESC, coverage_id ASC
    ) cur
   WHERE w.asset_id = cur.asset_id
     AND w.origin = 'breakdown'
     AND w.status IN ('open', 'overdue')
     AND w.warranty_flagged = false
     AND w.warranty_coverage_id IS NULL;

  EXECUTE 'COMMENT ON COLUMN maintenance_work_order.warranty_flagged IS ' ||
    quote_literal('Story 7.7 AC 2: server-derived at breakdown work-order creation; rows open at migration time backfilled once by asset_coverage.sql');
END $$;


-- Story 6.2: production order staging projection (FR-MO-04). Mirror of read/projections/production_order_stage.sql.
-- Production order staging read model (Story 6.2, FR-MO-04, AD-5). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying production_order.material_staged /
-- production_order.material_issued domain events, and mutation happens exclusively through
-- persistEvent, which applies this projection inside the SAME transaction as the domain_events
-- insert. Grain is (production_order_id, bom_line_id): one row per directed-issue requirement
-- line. AC1's "pick tasks" ARE these rows - they are deliberately NOT Epic 3 pick_task rows, which
-- are dispatch-demand-scoped (ERP sales-order lines, allocated -> picked toward shipping). Staging
-- holds stock in `allocated` at the operator-named source bin until ISSUE drains it; the `picked`
-- bucket is never used here.
--
-- The UNIQUE (production_order_id, bom_line_id) grain is the replay/duplicate guard: a second
-- staging of the same line surfaces a 23505 mapped to 409 DUPLICATE_EVENT in the persistEvent
-- seam. status is 'allocated' -> 'issued' (full issues only transition; partial issues stay
-- 'allocated'), and chk_production_order_stage_issue_bound keeps issued_quantity within
-- required_quantity in the database - the same bound the issue applier enforces in SQL NUMERIC.
-- Recorded deviation (code-review decision 2026-08-28): app_user additionally carries DELETE so
-- the cancel applier can roll staged-but-unissued stock back to `available` and clear the stage
-- rows inside the production_order.cancelled transaction; nothing else deletes rows.

CREATE TABLE IF NOT EXISTS production_order_stage (
  stage_id             UUID PRIMARY KEY,
  production_order_id  UUID NOT NULL,
  bom_line_id          UUID NOT NULL,
  component_item_id    UUID NOT NULL,
  component_sku        TEXT NOT NULL,
  supply_method        TEXT NOT NULL,
  required_quantity    NUMERIC(18,6) NOT NULL,
  issued_quantity      NUMERIC(18,6) NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'allocated',
  source_location_id   UUID NOT NULL,
  lot_number           TEXT,
  source_event_id      UUID NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_production_order_stage_line UNIQUE (production_order_id, bom_line_id),
  CONSTRAINT chk_production_order_stage_supply_method CHECK (supply_method = 'directed_issue'),
  CONSTRAINT chk_production_order_stage_status CHECK (status IN ('allocated','issued')),
  CONSTRAINT chk_production_order_stage_required_positive CHECK (required_quantity > 0),
  CONSTRAINT chk_production_order_stage_issued_non_negative CHECK (issued_quantity >= 0),
  CONSTRAINT chk_production_order_stage_issue_bound CHECK (issued_quantity <= required_quantity)
);

CREATE INDEX IF NOT EXISTS idx_production_order_stage_order ON production_order_stage (production_order_id);
CREATE INDEX IF NOT EXISTS idx_production_order_stage_status ON production_order_stage (status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_stage_supply_method'
      AND conrelid = 'production_order_stage'::regclass
  ) THEN
    ALTER TABLE production_order_stage
      ADD CONSTRAINT chk_production_order_stage_supply_method CHECK (supply_method = 'directed_issue');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_stage_status'
      AND conrelid = 'production_order_stage'::regclass
  ) THEN
    ALTER TABLE production_order_stage
      ADD CONSTRAINT chk_production_order_stage_status CHECK (status IN ('allocated','issued'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_stage_required_positive'
      AND conrelid = 'production_order_stage'::regclass
  ) THEN
    ALTER TABLE production_order_stage
      ADD CONSTRAINT chk_production_order_stage_required_positive CHECK (required_quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_stage_issued_non_negative'
      AND conrelid = 'production_order_stage'::regclass
  ) THEN
    ALTER TABLE production_order_stage
      ADD CONSTRAINT chk_production_order_stage_issued_non_negative CHECK (issued_quantity >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_stage_issue_bound'
      AND conrelid = 'production_order_stage'::regclass
  ) THEN
    ALTER TABLE production_order_stage
      ADD CONSTRAINT chk_production_order_stage_issue_bound CHECK (issued_quantity <= required_quantity);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE, DELETE ON production_order_stage TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON production_order_stage TO readonly_user;
  END IF;
END $$;


-- Story 6.2: production WIP ledger projection (FR-MO-05/06). Mirror of read/projections/production_wip_ledger.sql.
-- Production WIP ledger read model (Story 6.2, FR-MO-05/06, AD-5). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY, and APPEND-ONLY by construction: rows are rebuildable by replaying the
-- production_order.material_issued / confirmation_recorded / material_returned domain events, and
-- mutation happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert. Posting rows are never deleted or rewritten.
--
-- NOTE on the UPDATE grant (recorded deviation, 2026-08-28): the story's Table 2 says "INSERT,
-- SELECT only (append-only - the 7.7 precedent)". The Applier Contract overrides that line: AC6
-- requires a return to close its source posting, which the Counter Contract implements by
-- DECREMENTING open_quantity on the source issue/backflush row in the return's transaction - a
-- real UPDATE, and one the SELECT ... FOR UPDATE lock on the source posting also requires
-- (PostgreSQL refuses FOR UPDATE without UPDATE privilege). The rows stay append-only (never
-- deleted, never rewritten); only the open_quantity counter is decremented, and only by the seam
-- inside persistEvent. Granting UPDATE is the smallest change that satisfies AC5/AC6 and the
-- 6.1 cancel-guard contract.
--
-- One posting per DRAINED BALANCE ROW, not per requirement line (Binding Decision 7): a backflush
-- line can drain several bins/lots, and AC5 requires a return to restore the ORIGINAL lot identity,
-- which is only exact when each posting carries one (location, lot) grain. Issue/backflush postings
-- carry open_quantity (decremented by returns in the return posting's transaction); return postings
-- carry NULL open_quantity and reference their source posting. The pairing CHECK makes a return
-- without source_posting_id + reason_code structurally impossible, and an issue/backflush with
-- either structurally impossible.
--
-- The WIP read (AC4) is computed: net open quantity = SUM(open_quantity) over non-return postings;
-- net open value = SUM(open_quantity * unit_cost) in SQL NUMERIC. A Closed-order zero-WIP check
-- (Story 6.4's closure gate) will read the same accessor.

CREATE TABLE IF NOT EXISTS production_wip_ledger (
  posting_id           UUID PRIMARY KEY,
  production_order_id  UUID NOT NULL,
  posting_type         TEXT NOT NULL,
  bom_line_id          UUID NOT NULL,
  component_item_id    UUID NOT NULL,
  component_sku        TEXT NOT NULL,
  lot_number           TEXT,
  source_location_id   UUID NOT NULL,
  quantity             NUMERIC(18,6) NOT NULL,
  open_quantity        NUMERIC(18,6),
  unit_cost            NUMERIC(14,3) NOT NULL,
  posting_value        NUMERIC(14,3) NOT NULL,
  reason_code          TEXT,
  source_posting_id    UUID,
  source_event_id      UUID NOT NULL,
  occurred_at          TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_production_wip_posting_type CHECK (posting_type IN ('directed_issue','backflush','return','completion_relief','scrap_relief')),
  CONSTRAINT chk_production_wip_quantity_positive CHECK (quantity > 0),
  CONSTRAINT chk_production_wip_open_non_negative CHECK (open_quantity IS NULL OR open_quantity >= 0),
  CONSTRAINT chk_production_wip_posting_pairing CHECK (
    (posting_type = 'return' AND source_posting_id IS NOT NULL AND reason_code IS NOT NULL AND open_quantity IS NULL)
    OR
    (posting_type = 'scrap_relief' AND source_posting_id IS NOT NULL AND reason_code IS NOT NULL AND open_quantity IS NULL)
    OR
    (posting_type = 'completion_relief' AND source_posting_id IS NOT NULL AND reason_code IS NULL AND open_quantity IS NULL)
    OR
    (posting_type IN ('directed_issue','backflush') AND source_posting_id IS NULL AND reason_code IS NULL AND open_quantity IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_production_wip_ledger_order ON production_wip_ledger (production_order_id);
CREATE INDEX IF NOT EXISTS idx_production_wip_ledger_source_posting ON production_wip_ledger (source_posting_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_wip_posting_type'
      AND conrelid = 'production_wip_ledger'::regclass
  ) THEN
    ALTER TABLE production_wip_ledger
      ADD CONSTRAINT chk_production_wip_posting_type CHECK (posting_type IN ('directed_issue','backflush','return','completion_relief','scrap_relief'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_wip_quantity_positive'
      AND conrelid = 'production_wip_ledger'::regclass
  ) THEN
    ALTER TABLE production_wip_ledger
      ADD CONSTRAINT chk_production_wip_quantity_positive CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_wip_open_non_negative'
      AND conrelid = 'production_wip_ledger'::regclass
  ) THEN
    ALTER TABLE production_wip_ledger
      ADD CONSTRAINT chk_production_wip_open_non_negative CHECK (open_quantity IS NULL OR open_quantity >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_wip_posting_pairing'
      AND conrelid = 'production_wip_ledger'::regclass
  ) THEN
    ALTER TABLE production_wip_ledger
      ADD CONSTRAINT chk_production_wip_posting_pairing CHECK (
        (posting_type = 'return' AND source_posting_id IS NOT NULL AND reason_code IS NOT NULL AND open_quantity IS NULL)
        OR
        (posting_type = 'scrap_relief' AND source_posting_id IS NOT NULL AND reason_code IS NOT NULL AND open_quantity IS NULL)
        OR
        (posting_type = 'completion_relief' AND source_posting_id IS NOT NULL AND reason_code IS NULL AND open_quantity IS NULL)
        OR
        (posting_type IN ('directed_issue','backflush') AND source_posting_id IS NULL AND reason_code IS NULL AND open_quantity IS NOT NULL)
      );
  END IF;
END $$;

-- Story 6.3 (FR-MO-07/08) constraint widening. On a database provisioned BEFORE this story both
-- constraints already exist carrying the narrow Story 6.2 definitions, and an add-if-missing guard
-- cannot upgrade a constraint that already exists: they must be DROPPED first.
--
-- Code review 2026-08-31: the inline CREATE TABLE pairing CHECK and the add-if-missing guards above
-- were still stating the narrow Story 6.2 definitions, so this file carried two conflicting
-- authoritative texts under one constraint name. That was not cosmetic. The add-if-missing guard
-- runs BEFORE this block, so against a database where the constraint had been dropped while
-- completion_relief or scrap_relief rows already existed, it re-added the NARROW definition, failed
-- validation with check_violation and aborted the whole file before the widening could run. All
-- three copies now state the widened definition; this block remains because it is the only thing
-- that upgrades a database still carrying the narrow constraint from Story 6.2. The drop is itself guarded on the
-- constraint text, so re-applying this file to an already-upgraded database is a no-op.
--
-- 'completion_relief' and 'scrap_relief' are the two new relief postings. Like a return they close
-- open WIP on a named source posting (source_posting_id NOT NULL, open_quantity NULL) at that
-- posting's issued unit cost; unlike a return they move no stock. A scrap relief carries the
-- operator's reason code, a completion relief does not (the completion event is its own reason).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_wip_posting_type'
      AND conrelid = 'production_wip_ledger'::regclass
      AND (pg_get_constraintdef(oid) NOT LIKE '%completion_relief%'
        OR pg_get_constraintdef(oid) NOT LIKE '%scrap_relief%')
  ) THEN
    ALTER TABLE production_wip_ledger DROP CONSTRAINT chk_production_wip_posting_type;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_wip_posting_type'
      AND conrelid = 'production_wip_ledger'::regclass
  ) THEN
    ALTER TABLE production_wip_ledger
      ADD CONSTRAINT chk_production_wip_posting_type CHECK (posting_type IN ('directed_issue','backflush','return','completion_relief','scrap_relief'));
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_wip_posting_pairing'
      AND conrelid = 'production_wip_ledger'::regclass
      AND (pg_get_constraintdef(oid) NOT LIKE '%completion_relief%'
        OR pg_get_constraintdef(oid) NOT LIKE '%scrap_relief%')
  ) THEN
    ALTER TABLE production_wip_ledger DROP CONSTRAINT chk_production_wip_posting_pairing;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_wip_posting_pairing'
      AND conrelid = 'production_wip_ledger'::regclass
  ) THEN
    ALTER TABLE production_wip_ledger
      ADD CONSTRAINT chk_production_wip_posting_pairing CHECK (
        (posting_type = 'return' AND source_posting_id IS NOT NULL AND reason_code IS NOT NULL AND open_quantity IS NULL)
        OR
        (posting_type = 'scrap_relief' AND source_posting_id IS NOT NULL AND reason_code IS NOT NULL AND open_quantity IS NULL)
        OR
        (posting_type = 'completion_relief' AND source_posting_id IS NOT NULL AND reason_code IS NULL AND open_quantity IS NULL)
        OR
        (posting_type IN ('directed_issue','backflush') AND source_posting_id IS NULL AND reason_code IS NULL AND open_quantity IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON production_wip_ledger TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON production_wip_ledger TO readonly_user;
  END IF;
END $$;

-- Story 7.8: offline technician status machine columns on maintenance_work_order. Mirror of the Story 7.8 block in read/projections/maintenance_work_order.sql.
-- Story 7.8 offline technician arm (FR-M-17, Binding Decision 7): the technician-facing status
-- machine gains in_progress and on_hold, driven by maintenance.work_order_status_updated. The
-- inline CHECK above is already the five-value vocabulary for a fresh install; the guarded block
-- below UPGRADES a database that still carries the three-value Story 7.2 constraint by inspecting
-- pg_get_constraintdef, dropping the narrow definition and re-adding the widened one. It is
-- idempotent: once the definition names in_progress the block is a no-op on every re-run. The
-- three additive columns record the latest technician transition (who, when, an optional note of
-- at most 500 characters); the grace sweep and every other 7.2-7.7 accessor are untouched.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_work_order_status'
      AND conrelid = 'maintenance_work_order'::regclass
      AND pg_get_constraintdef(oid) NOT LIKE '%in_progress%'
  ) THEN
    ALTER TABLE maintenance_work_order DROP CONSTRAINT chk_maintenance_work_order_status;
    ALTER TABLE maintenance_work_order
      ADD CONSTRAINT chk_maintenance_work_order_status CHECK (status IN ('open', 'overdue', 'in_progress', 'on_hold', 'completed'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'maintenance_work_order' AND column_name = 'status_updated_at'
  ) THEN
    ALTER TABLE maintenance_work_order ADD COLUMN status_updated_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'maintenance_work_order' AND column_name = 'status_updated_by'
  ) THEN
    ALTER TABLE maintenance_work_order ADD COLUMN status_updated_by UUID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'maintenance_work_order' AND column_name = 'status_note'
  ) THEN
    ALTER TABLE maintenance_work_order ADD COLUMN status_note TEXT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_work_order_status_note'
      AND conrelid = 'maintenance_work_order'::regclass
  ) THEN
    ALTER TABLE maintenance_work_order
      ADD CONSTRAINT chk_maintenance_work_order_status_note CHECK (status_note IS NULL OR char_length(status_note) <= 500);
  END IF;
END $$;

-- Story 7.8: three-part closure coding ledger (FR-M-18). Mirror of read/projections/maintenance_work_order_closure.sql.
-- Three-part closure coding ledger (Story 7.8, FR-M-18, AC 3 and AC 4). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.work_order_completed domain
-- events that carry fault_code, cause_code and remedy_code; mutation happens exclusively through
-- persistEvent, which applies this projection inside the SAME transaction as the domain_events
-- insert (the closure insert rides the completion transaction under the work order's lock).
--
-- The grain is ONE closure per work order (Binding Decision 9): the closure id IS the work order
-- id, so replay mints nothing random and the primary key is the concurrency backstop (a 23505 on
-- it resolves to 409 WORK_ORDER_ALREADY_COMPLETED in the store's pkey chain).
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE (the maintenance_warranty_
-- override precedent). A recorded closure is failure history and is never amended.
--
-- idx_maintenance_work_order_closure_asset serves the "last five closures" read verbatim:
-- WHERE asset_id = $1 ORDER BY closed_at DESC, work_order_id ASC LIMIT 5.

CREATE TABLE IF NOT EXISTS maintenance_work_order_closure (
  work_order_id UUID PRIMARY KEY,
  asset_id      UUID NOT NULL,
  origin        TEXT NOT NULL,
  fault_code    TEXT NOT NULL,
  cause_code    TEXT NOT NULL,
  remedy_code   TEXT NOT NULL,
  closed_by     UUID NOT NULL,
  closed_at     TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_maintenance_work_order_closure_origin CHECK (origin IN ('preventive', 'breakdown')),
  CONSTRAINT chk_maintenance_work_order_closure_codes CHECK (btrim(fault_code) <> '' AND char_length(fault_code) <= 64 AND btrim(cause_code) <> '' AND char_length(cause_code) <= 64 AND btrim(remedy_code) <> '' AND char_length(remedy_code) <= 64)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_work_order_closure_asset ON maintenance_work_order_closure (asset_id, closed_at DESC, work_order_id ASC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_work_order_closure_origin'
      AND conrelid = 'maintenance_work_order_closure'::regclass
  ) THEN
    ALTER TABLE maintenance_work_order_closure
      ADD CONSTRAINT chk_maintenance_work_order_closure_origin CHECK (origin IN ('preventive', 'breakdown'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_work_order_closure_codes'
      AND conrelid = 'maintenance_work_order_closure'::regclass
  ) THEN
    ALTER TABLE maintenance_work_order_closure
      ADD CONSTRAINT chk_maintenance_work_order_closure_codes CHECK (btrim(fault_code) <> '' AND char_length(fault_code) <= 64 AND btrim(cause_code) <> '' AND char_length(cause_code) <= 64 AND btrim(remedy_code) <> '' AND char_length(remedy_code) <= 64);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON maintenance_work_order_closure TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_work_order_closure TO readonly_user;
  END IF;
END $$;

-- Story 7.8: maintenance sync-conflict queue (FR-M-17). Mirror of read/projections/maintenance_sync_conflict.sql.
-- Maintenance sync-conflict queue (Story 7.8, FR-M-17, AC 2). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY (AD-14): rows are rebuildable by replaying maintenance.sync_conflict_raised
-- (raised by the edge upload handler AFTER a failed persist has rolled back) and
-- maintenance.sync_conflict_resolved (the DOA-gated supervisor decision). Mutation happens
-- exclusively through persistEvent, which applies this projection inside the SAME transaction as
-- the domain_events insert. The shape mirrors integration_exception (status open/resolved).
--
-- The grain is ONE row per conflicting edge event (Binding Decision 4): uq_maintenance_sync_
-- conflict_event is the concurrency backstop behind the raise applier's sequential pre-check, so a
-- re-POST of the same conflicting envelope replays the raise and returns the SAME conflict_id.
--
-- reason is version_conflict (the AC 2 optimistic-concurrency case: expected_version and
-- head_version are both recorded, rejection_code is NULL) or safety_fault_rejected (a
-- safety-flagged fault report that met a permanent rejection on replay: rejection_code carries the
-- original code, the versions are NULL). chk_maintenance_sync_conflict_reason_pairing pins that
-- pairing at the database level. Resolution is a decision record only: the platform never replays
-- the conflicting payload, and chk_maintenance_sync_conflict_resolution_pairing keeps a resolved
-- row from ever lacking its code, resolver or timestamp.

CREATE TABLE IF NOT EXISTS maintenance_sync_conflict (
  conflict_id            UUID PRIMARY KEY,
  stream_id              UUID NOT NULL,
  conflicting_event_id   UUID NOT NULL,
  conflicting_event_type TEXT NOT NULL,
  idempotency_key        TEXT NOT NULL,
  device_id              TEXT NOT NULL,
  captured_by            UUID NOT NULL,
  location_id            UUID,
  reason                 TEXT NOT NULL,
  expected_version       INTEGER,
  head_version           INTEGER,
  rejection_code         TEXT,
  conflicting_payload    JSONB NOT NULL,
  occurred_at            TIMESTAMPTZ NOT NULL,
  raised_at              TIMESTAMPTZ NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'open',
  resolution_code        TEXT,
  resolution_note        TEXT,
  resolved_by            UUID,
  resolved_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_maintenance_sync_conflict_event UNIQUE (conflicting_event_id),
  CONSTRAINT chk_maintenance_sync_conflict_reason CHECK (reason IN ('version_conflict', 'safety_fault_rejected')),
  CONSTRAINT chk_maintenance_sync_conflict_reason_pairing CHECK ((reason = 'version_conflict' AND expected_version IS NOT NULL AND head_version IS NOT NULL AND rejection_code IS NULL) OR (reason = 'safety_fault_rejected' AND rejection_code IS NOT NULL)),
  CONSTRAINT chk_maintenance_sync_conflict_status CHECK (status IN ('open', 'resolved')),
  CONSTRAINT chk_maintenance_sync_conflict_resolution CHECK (resolution_code IS NULL OR resolution_code IN ('discarded', 'reapplied_centrally')),
  CONSTRAINT chk_maintenance_sync_conflict_resolution_note CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 1000),
  CONSTRAINT chk_maintenance_sync_conflict_resolution_pairing CHECK ((status = 'resolved' AND resolution_code IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL) OR (status = 'open' AND resolution_code IS NULL AND resolved_by IS NULL AND resolved_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_sync_conflict_status ON maintenance_sync_conflict (status, raised_at DESC);
CREATE INDEX IF NOT EXISTS idx_maintenance_sync_conflict_stream ON maintenance_sync_conflict (stream_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_sync_conflict_location ON maintenance_sync_conflict (location_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_maintenance_sync_conflict_event'
      AND conrelid = 'maintenance_sync_conflict'::regclass
  ) THEN
    ALTER TABLE maintenance_sync_conflict
      ADD CONSTRAINT uq_maintenance_sync_conflict_event UNIQUE (conflicting_event_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_sync_conflict_reason'
      AND conrelid = 'maintenance_sync_conflict'::regclass
  ) THEN
    ALTER TABLE maintenance_sync_conflict
      ADD CONSTRAINT chk_maintenance_sync_conflict_reason CHECK (reason IN ('version_conflict', 'safety_fault_rejected'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_sync_conflict_reason_pairing'
      AND conrelid = 'maintenance_sync_conflict'::regclass
  ) THEN
    ALTER TABLE maintenance_sync_conflict
      ADD CONSTRAINT chk_maintenance_sync_conflict_reason_pairing CHECK ((reason = 'version_conflict' AND expected_version IS NOT NULL AND head_version IS NOT NULL AND rejection_code IS NULL) OR (reason = 'safety_fault_rejected' AND rejection_code IS NOT NULL));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_sync_conflict_status'
      AND conrelid = 'maintenance_sync_conflict'::regclass
  ) THEN
    ALTER TABLE maintenance_sync_conflict
      ADD CONSTRAINT chk_maintenance_sync_conflict_status CHECK (status IN ('open', 'resolved'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_sync_conflict_resolution'
      AND conrelid = 'maintenance_sync_conflict'::regclass
  ) THEN
    ALTER TABLE maintenance_sync_conflict
      ADD CONSTRAINT chk_maintenance_sync_conflict_resolution CHECK (resolution_code IS NULL OR resolution_code IN ('discarded', 'reapplied_centrally'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_sync_conflict_resolution_note'
      AND conrelid = 'maintenance_sync_conflict'::regclass
  ) THEN
    ALTER TABLE maintenance_sync_conflict
      ADD CONSTRAINT chk_maintenance_sync_conflict_resolution_note CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 1000);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_sync_conflict_resolution_pairing'
      AND conrelid = 'maintenance_sync_conflict'::regclass
  ) THEN
    ALTER TABLE maintenance_sync_conflict
      ADD CONSTRAINT chk_maintenance_sync_conflict_resolution_pairing CHECK ((status = 'resolved' AND resolution_code IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL) OR (status = 'open' AND resolution_code IS NULL AND resolved_by IS NULL AND resolved_at IS NULL));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON maintenance_sync_conflict TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_sync_conflict TO readonly_user;
  END IF;
END $$;

-- Story 8.1: inspection_plan (FR-Q-01/FR-Q-02/FR-Q-05). Mirror of read/projections/inspection_plan.sql.
-- Inspection plan header (Story 8.1, FR-Q-01, AC 1 and AC 2). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.inspection_plan_created domain events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the
-- SAME transaction as the domain_events insert.
--
-- The header is the SCOPE GRAIN of a plan: one governed product item, one released production or
-- job-work-kit BOM revision used as the product-specification revision (Annex requirement 2 - QC
-- never mutates BOM data, it only references the revision), and either the standard scope or a
-- customer override scoped to an opaque job-work-order reference (Annex requirement 7). The
-- reference carries NO foreign key until Epic 9 exists; source_order_type is constrained to the
-- single literal 'job_work_order' so no arbitrary order type is exposed by this story.
--
-- uq_inspection_plan_grain is the concurrency backstop for two first-version creates racing on
-- the same grain (a 23505 on it resolves to 409 DUPLICATE_INSPECTION_PLAN_VERSION in the store's
-- constraint chain with the existing plan_id). Version numbers are allocated under the header
-- row's FOR UPDATE lock in src/compliance/quality.ts, never by an unlocked MAX(version) + 1.
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE or DELETE. A header's grain is
-- immutable; a new specification revision is a new header.

CREATE TABLE IF NOT EXISTS inspection_plan (
  plan_id            UUID PRIMARY KEY,
  scope              TEXT NOT NULL,
  item_id            UUID NOT NULL,
  sku                TEXT NOT NULL,
  bom_revision_id    UUID NOT NULL,
  source_order_type  TEXT,
  source_order_ref   TEXT,
  created_by         UUID NOT NULL,
  source_event_id    UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inspection_plan_grain UNIQUE NULLS NOT DISTINCT (item_id, bom_revision_id, scope, source_order_type, source_order_ref),
  CONSTRAINT chk_inspection_plan_scope CHECK (scope IN ('standard', 'customer_override')),
  CONSTRAINT chk_inspection_plan_source_order_type CHECK (source_order_type IS NULL OR source_order_type = 'job_work_order'),
  CONSTRAINT chk_inspection_plan_scope_pairing CHECK (
    (scope = 'standard' AND source_order_type IS NULL AND source_order_ref IS NULL)
    OR (scope = 'customer_override' AND source_order_type IS NOT NULL AND source_order_ref IS NOT NULL AND btrim(source_order_ref) <> '' AND char_length(source_order_ref) <= 128)
  )
);

CREATE INDEX IF NOT EXISTS idx_inspection_plan_item_revision ON inspection_plan (item_id, bom_revision_id, scope);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_inspection_plan_grain'
      AND conrelid = 'inspection_plan'::regclass
  ) THEN
    ALTER TABLE inspection_plan
      ADD CONSTRAINT uq_inspection_plan_grain UNIQUE NULLS NOT DISTINCT (item_id, bom_revision_id, scope, source_order_type, source_order_ref);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_scope'
      AND conrelid = 'inspection_plan'::regclass
  ) THEN
    ALTER TABLE inspection_plan
      ADD CONSTRAINT chk_inspection_plan_scope CHECK (scope IN ('standard', 'customer_override'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_source_order_type'
      AND conrelid = 'inspection_plan'::regclass
  ) THEN
    ALTER TABLE inspection_plan
      ADD CONSTRAINT chk_inspection_plan_source_order_type CHECK (source_order_type IS NULL OR source_order_type = 'job_work_order');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_scope_pairing'
      AND conrelid = 'inspection_plan'::regclass
  ) THEN
    ALTER TABLE inspection_plan
      ADD CONSTRAINT chk_inspection_plan_scope_pairing CHECK (
        (scope = 'standard' AND source_order_type IS NULL AND source_order_ref IS NULL)
        OR (scope = 'customer_override' AND source_order_type IS NOT NULL AND source_order_ref IS NOT NULL AND btrim(source_order_ref) <> '' AND char_length(source_order_ref) <= 128)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON inspection_plan TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON inspection_plan TO readonly_user;
  END IF;
END $$;

-- Story 8.1: inspection_plan_version (FR-Q-01/FR-Q-02/FR-Q-05). Mirror of read/projections/inspection_plan_version.sql.
-- Inspection plan version (Story 8.1, FR-Q-01, AC 1 and AC 2). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.inspection_plan_created domain events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the
-- SAME transaction as the domain_events insert.
--
-- A version is IMMUTABLE after creation (Annex requirement 1): a change is a new version and every
-- prior version is preserved. Approval is NOT a column here - it is the append-only
-- inspection_plan_approval row keyed to plan_version_id, so an approval can never be flipped by an
-- UPDATE. Each version carries effective_from (Annex requirement 3): resolution picks the approved
-- version with the greatest effective_from not after the lot's trusted business date.
--
-- uq_inspection_plan_version_no backs the version-number allocation done under the plan header's
-- FOR UPDATE lock (a 23505 resolves to 409 DUPLICATE_INSPECTION_PLAN_VERSION).
-- uq_inspection_plan_version_effective enforces one version per (plan, effective_from) so
-- resolution is deterministic by date; a 23505 resolves to 409 INSPECTION_PLAN_EFFECTIVITY_CONFLICT.
--
-- aql and inspection_level are the Story 8.2 sampling inputs, stored as an exact bounded NUMERIC and
-- a bounded text literal; this story performs NO sampling-table lookup. They pair all-or-none.
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE or DELETE.

CREATE TABLE IF NOT EXISTS inspection_plan_version (
  plan_version_id    UUID PRIMARY KEY,
  plan_id            UUID NOT NULL,
  version_no         INTEGER NOT NULL,
  effective_from     DATE NOT NULL,
  aql                NUMERIC(7, 3),
  inspection_level   TEXT,
  created_by         UUID NOT NULL,
  source_event_id    UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inspection_plan_version_no UNIQUE (plan_id, version_no),
  CONSTRAINT uq_inspection_plan_version_effective UNIQUE (plan_id, effective_from),
  CONSTRAINT chk_inspection_plan_version_no_positive CHECK (version_no > 0),
  CONSTRAINT chk_inspection_plan_version_aql CHECK (aql IS NULL OR (aql > 0 AND aql <= 1000)),
  CONSTRAINT chk_inspection_plan_version_sampling_pairing CHECK (
    (aql IS NULL AND inspection_level IS NULL)
    OR (aql IS NOT NULL AND inspection_level IS NOT NULL AND btrim(inspection_level) <> '' AND char_length(inspection_level) <= 16)
  ),
  CONSTRAINT chk_inspection_plan_version_level_vocab CHECK (inspection_level IS NULL OR inspection_level IN ('I', 'II', 'III', 'S-1', 'S-2', 'S-3', 'S-4'))
);

CREATE INDEX IF NOT EXISTS idx_inspection_plan_version_plan_effective ON inspection_plan_version (plan_id, effective_from DESC, version_no DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_inspection_plan_version_no'
      AND conrelid = 'inspection_plan_version'::regclass
  ) THEN
    ALTER TABLE inspection_plan_version
      ADD CONSTRAINT uq_inspection_plan_version_no UNIQUE (plan_id, version_no);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_inspection_plan_version_effective'
      AND conrelid = 'inspection_plan_version'::regclass
  ) THEN
    ALTER TABLE inspection_plan_version
      ADD CONSTRAINT uq_inspection_plan_version_effective UNIQUE (plan_id, effective_from);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_version_no_positive'
      AND conrelid = 'inspection_plan_version'::regclass
  ) THEN
    ALTER TABLE inspection_plan_version
      ADD CONSTRAINT chk_inspection_plan_version_no_positive CHECK (version_no > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_version_aql'
      AND conrelid = 'inspection_plan_version'::regclass
  ) THEN
    ALTER TABLE inspection_plan_version
      ADD CONSTRAINT chk_inspection_plan_version_aql CHECK (aql IS NULL OR (aql > 0 AND aql <= 1000));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_version_sampling_pairing'
      AND conrelid = 'inspection_plan_version'::regclass
  ) THEN
    ALTER TABLE inspection_plan_version
      ADD CONSTRAINT chk_inspection_plan_version_sampling_pairing CHECK (
        (aql IS NULL AND inspection_level IS NULL)
        OR (aql IS NOT NULL AND inspection_level IS NOT NULL AND btrim(inspection_level) <> '' AND char_length(inspection_level) <= 16)
      );
  END IF;
END $$;

-- Story 8.2 (Annex requirement 3): the inspection-level vocabulary of IS 2500 (Part 1) Table I,
-- guarded separately so a Story 8.1 database gains it on re-apply.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_version_level_vocab'
      AND conrelid = 'inspection_plan_version'::regclass
  ) THEN
    ALTER TABLE inspection_plan_version
      ADD CONSTRAINT chk_inspection_plan_version_level_vocab CHECK (inspection_level IS NULL OR inspection_level IN ('I', 'II', 'III', 'S-1', 'S-2', 'S-3', 'S-4')) NOT VALID;
    ALTER TABLE inspection_plan_version
      VALIDATE CONSTRAINT chk_inspection_plan_version_level_vocab;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON inspection_plan_version TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON inspection_plan_version TO readonly_user;
  END IF;
END $$;

-- Story 8.1: inspection_plan_characteristic (FR-Q-01/FR-Q-02/FR-Q-05). Mirror of read/projections/inspection_plan_characteristic.sql.
-- Inspection plan characteristic (Story 8.1, FR-Q-01, Annex requirement 4). This file is the
-- CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.inspection_plan_created domain events
-- (one event carries the complete characteristic list of the version it creates); mutation happens
-- exclusively through persistEvent inside the SAME transaction as the domain_events insert.
--
-- One row per characteristic line of an immutable plan version: a stable line number, the class
-- (critical, major, minor), the test-method or IS/ISO/internal-SOP reference, an optional
-- instrument type, the result kind (numeric or attribute) with its MATCHING acceptance limits or
-- criteria, and the sample-handling instructions. chk_inspection_plan_characteristic_kind_pairing
-- is the kind/limit pairing rule: a numeric characteristic carries at least one bounded NUMERIC
-- limit (lower <= upper when both are present) and no textual criteria; an attribute
-- characteristic carries textual criteria and no numeric limits.
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE or DELETE (a version's lines are
-- as immutable as the version).

CREATE TABLE IF NOT EXISTS inspection_plan_characteristic (
  characteristic_id    UUID PRIMARY KEY,
  plan_version_id      UUID NOT NULL,
  line_no              INTEGER NOT NULL,
  characteristic_name  TEXT NOT NULL,
  characteristic_class TEXT NOT NULL,
  test_method_ref      TEXT NOT NULL,
  instrument_type      TEXT,
  result_kind          TEXT NOT NULL,
  lower_limit          NUMERIC(18, 6),
  upper_limit          NUMERIC(18, 6),
  limit_uom            TEXT,
  acceptance_criteria  TEXT,
  sample_handling      TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inspection_plan_characteristic_line UNIQUE (plan_version_id, line_no),
  CONSTRAINT chk_inspection_plan_characteristic_line_no CHECK (line_no > 0),
  CONSTRAINT chk_inspection_plan_characteristic_class CHECK (characteristic_class IN ('critical', 'major', 'minor')),
  CONSTRAINT chk_inspection_plan_characteristic_result_kind CHECK (result_kind IN ('numeric', 'attribute')),
  CONSTRAINT chk_inspection_plan_characteristic_text CHECK (
    btrim(characteristic_name) <> '' AND char_length(characteristic_name) <= 200
    AND btrim(test_method_ref) <> '' AND char_length(test_method_ref) <= 200
    AND (instrument_type IS NULL OR (btrim(instrument_type) <> '' AND char_length(instrument_type) <= 100))
    AND btrim(sample_handling) <> '' AND char_length(sample_handling) <= 1000
  ),
  CONSTRAINT chk_inspection_plan_characteristic_kind_pairing CHECK (
    (result_kind = 'numeric'
      AND (lower_limit IS NOT NULL OR upper_limit IS NOT NULL)
      AND (lower_limit IS NULL OR upper_limit IS NULL OR lower_limit <= upper_limit)
      AND acceptance_criteria IS NULL
      AND (limit_uom IS NULL OR (btrim(limit_uom) <> '' AND char_length(limit_uom) <= 32)))
    OR (result_kind = 'attribute'
      AND lower_limit IS NULL AND upper_limit IS NULL AND limit_uom IS NULL
      AND acceptance_criteria IS NOT NULL AND btrim(acceptance_criteria) <> '' AND char_length(acceptance_criteria) <= 1000)
  )
);

CREATE INDEX IF NOT EXISTS idx_inspection_plan_characteristic_version ON inspection_plan_characteristic (plan_version_id, line_no);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_inspection_plan_characteristic_line'
      AND conrelid = 'inspection_plan_characteristic'::regclass
  ) THEN
    ALTER TABLE inspection_plan_characteristic
      ADD CONSTRAINT uq_inspection_plan_characteristic_line UNIQUE (plan_version_id, line_no);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_characteristic_line_no'
      AND conrelid = 'inspection_plan_characteristic'::regclass
  ) THEN
    ALTER TABLE inspection_plan_characteristic
      ADD CONSTRAINT chk_inspection_plan_characteristic_line_no CHECK (line_no > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_characteristic_class'
      AND conrelid = 'inspection_plan_characteristic'::regclass
  ) THEN
    ALTER TABLE inspection_plan_characteristic
      ADD CONSTRAINT chk_inspection_plan_characteristic_class CHECK (characteristic_class IN ('critical', 'major', 'minor'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_characteristic_result_kind'
      AND conrelid = 'inspection_plan_characteristic'::regclass
  ) THEN
    ALTER TABLE inspection_plan_characteristic
      ADD CONSTRAINT chk_inspection_plan_characteristic_result_kind CHECK (result_kind IN ('numeric', 'attribute'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_characteristic_text'
      AND conrelid = 'inspection_plan_characteristic'::regclass
  ) THEN
    ALTER TABLE inspection_plan_characteristic
      ADD CONSTRAINT chk_inspection_plan_characteristic_text CHECK (
        btrim(characteristic_name) <> '' AND char_length(characteristic_name) <= 200
        AND btrim(test_method_ref) <> '' AND char_length(test_method_ref) <= 200
        AND (instrument_type IS NULL OR (btrim(instrument_type) <> '' AND char_length(instrument_type) <= 100))
        AND btrim(sample_handling) <> '' AND char_length(sample_handling) <= 1000
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_characteristic_kind_pairing'
      AND conrelid = 'inspection_plan_characteristic'::regclass
  ) THEN
    ALTER TABLE inspection_plan_characteristic
      ADD CONSTRAINT chk_inspection_plan_characteristic_kind_pairing CHECK (
        (result_kind = 'numeric'
          AND (lower_limit IS NOT NULL OR upper_limit IS NOT NULL)
          AND (lower_limit IS NULL OR upper_limit IS NULL OR lower_limit <= upper_limit)
          AND acceptance_criteria IS NULL
          AND (limit_uom IS NULL OR (btrim(limit_uom) <> '' AND char_length(limit_uom) <= 32)))
        OR (result_kind = 'attribute'
          AND lower_limit IS NULL AND upper_limit IS NULL AND limit_uom IS NULL
          AND acceptance_criteria IS NOT NULL AND btrim(acceptance_criteria) <> '' AND char_length(acceptance_criteria) <= 1000)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON inspection_plan_characteristic TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON inspection_plan_characteristic TO readonly_user;
  END IF;
END $$;

-- Story 8.1: inspection_plan_approval (FR-Q-01/FR-Q-02/FR-Q-05). Mirror of read/projections/inspection_plan_approval.sql.
-- Inspection plan approval evidence (Story 8.1, FR-Q-01, AC 1). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.inspection_plan_approved domain events;
-- mutation happens exclusively through persistEvent inside the SAME transaction as the
-- domain_events insert.
--
-- Exactly ONE approval per plan version (Binding Scope Decision 10): the primary key IS the plan
-- version id, so concurrent approval attempts resolve to one record (a 23505 on the primary key
-- resolves to 409 INSPECTION_PLAN_ALREADY_APPROVED in the store's constraint chain). The row
-- carries the SERVER-derived authority: the DOA entry that governed qc.inspection_plan_approval,
-- its governing role (which must be QC Head-level), the resolved approver (holder or active
-- delegate), the acting user (who must equal the resolved approver) and the approval instant.
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE or DELETE. An approval is
-- never revoked by this story; a superseding plan is a new version with its own approval.

CREATE TABLE IF NOT EXISTS inspection_plan_approval (
  plan_version_id           UUID PRIMARY KEY,
  plan_id                   UUID NOT NULL,
  approved_by               UUID NOT NULL,
  resolved_approver_user_id UUID NOT NULL,
  doa_entry_id              UUID NOT NULL,
  governing_role            TEXT NOT NULL,
  approved_at               TIMESTAMPTZ NOT NULL,
  source_event_id           UUID NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_inspection_plan_approval_actor_pairing CHECK (approved_by = resolved_approver_user_id),
  CONSTRAINT chk_inspection_plan_approval_role CHECK (btrim(governing_role) <> '' AND char_length(governing_role) <= 100)
);

CREATE INDEX IF NOT EXISTS idx_inspection_plan_approval_plan ON inspection_plan_approval (plan_id, approved_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_approval_actor_pairing'
      AND conrelid = 'inspection_plan_approval'::regclass
  ) THEN
    ALTER TABLE inspection_plan_approval
      ADD CONSTRAINT chk_inspection_plan_approval_actor_pairing CHECK (approved_by = resolved_approver_user_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_approval_role'
      AND conrelid = 'inspection_plan_approval'::regclass
  ) THEN
    ALTER TABLE inspection_plan_approval
      ADD CONSTRAINT chk_inspection_plan_approval_role CHECK (btrim(governing_role) <> '' AND char_length(governing_role) <= 100);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON inspection_plan_approval TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON inspection_plan_approval TO readonly_user;
  END IF;
END $$;

-- Story 8.1: qc_inspection_task (FR-Q-01/FR-Q-02/FR-Q-05). Mirror of read/projections/qc_inspection_task.sql.
-- QC inspection task and QC-gate projection (Story 8.1, FR-Q-02, AC 3 and AC 4). This file is the
-- CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.completion_received (insert) and
-- qc.conditional_release_recorded (gate transition) domain events; mutation happens exclusively
-- through persistEvent inside the SAME transaction as the domain_events insert. The completion
-- insert rides the PRODUCER's transaction (the hand-off contract in src/compliance/quality.ts), so
-- the producer-owned lot and stock writes and this QC-owned task commit or roll back together.
--
-- This table is BOTH the durable inspection task (the authoritative inbox, Binding Scope Decision
-- 12 - notifications are not the queue) and the ONE authoritative QC-gate projection keyed by lot
-- (Binding Scope Decision 2). gate_status is a DISTINCT state axis from
-- lot_master.quality_hold_status (the manual or recall-hold axis), which this story never widens:
-- a lot may be conditionally released here and still manually held there, and both block.
--
-- gate_status vocabulary in this story: qc_hold (the entry state every completion posts into, no
-- bypass) and conditionally_released (the FR-Q-05 disposition state, distinct from a bypass).
-- Story 8.3 widens it for accept and reject. task_status is the INSPECTION axis, independent of
-- the gate: 'open' at creation, 'sampling_determined' once Story 8.2 freezes the sampling plan
-- (results are accepted only in this state), 'inspected' once inspection completes with its
-- sampling_outcome and counts (the Story 8.2 additive columns below; sampling_id references the
-- frozen qc_sampling_plan row). The frozen plan_version_id never changes after creation (Annex
-- requirement 6): later plan approvals must never alter the plan a held lot is inspected against.
--
-- uq_qc_inspection_task_lot and uq_qc_inspection_task_source make replay and concurrent delivery of
-- the same completion a single effect (a 23505 on either resolves to 409 DUPLICATE_QC_COMPLETION
-- with the existing task_id in the store's constraint chain).
--
-- app_user holds INSERT, SELECT, UPDATE (the gate transition) and never DELETE.

CREATE TABLE IF NOT EXISTS qc_inspection_task (
  task_id                 UUID PRIMARY KEY,
  lot_id                  UUID NOT NULL,
  lot_number              TEXT NOT NULL,
  source_completion_type  TEXT NOT NULL,
  source_completion_id    UUID NOT NULL,
  item_id                 UUID NOT NULL,
  sku                     TEXT NOT NULL,
  quantity                NUMERIC(18, 6) NOT NULL,
  uom                     TEXT NOT NULL,
  site_id                 UUID NOT NULL,
  bom_revision_id         UUID NOT NULL,
  plan_id                 UUID NOT NULL,
  plan_version_id         UUID NOT NULL,
  plan_scope              TEXT NOT NULL,
  source_order_type       TEXT,
  source_order_ref        TEXT,
  completed_at            TIMESTAMPTZ NOT NULL,
  business_date           DATE NOT NULL,
  task_status             TEXT NOT NULL DEFAULT 'open',
  gate_status             TEXT NOT NULL DEFAULT 'qc_hold',
  gate_changed_at         TIMESTAMPTZ NOT NULL,
  source_event_id         UUID NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  sampling_id             UUID,
  sampling_outcome        TEXT,
  nonconforming_sample_units INTEGER,
  critical_nonconformities   INTEGER,
  inspected_by            UUID,
  inspected_at            TIMESTAMPTZ,
  CONSTRAINT uq_qc_inspection_task_lot UNIQUE (lot_id),
  CONSTRAINT uq_qc_inspection_task_source UNIQUE (source_completion_type, source_completion_id),
  CONSTRAINT chk_qc_inspection_task_quantity CHECK (quantity > 0),
  CONSTRAINT chk_qc_inspection_task_source_type CHECK (source_completion_type IN ('synthetic_completion', 'production_order', 'job_work_order')),
  CONSTRAINT chk_qc_inspection_task_status CHECK (task_status IN ('open', 'sampling_determined', 'inspected')),
  CONSTRAINT chk_qc_inspection_task_gate_status CHECK (gate_status IN ('qc_hold', 'conditionally_released', 'accepted', 'rejected', 'split')),
  CONSTRAINT chk_qc_inspection_task_plan_scope CHECK (plan_scope IN ('standard', 'customer_override')),
  CONSTRAINT chk_qc_inspection_task_scope_pairing CHECK (
    (plan_scope = 'standard' AND source_order_type IS NULL AND source_order_ref IS NULL)
    OR (plan_scope = 'customer_override' AND source_order_type = 'job_work_order' AND source_order_ref IS NOT NULL AND btrim(source_order_ref) <> '')
  ),
  CONSTRAINT chk_qc_inspection_task_sampling_outcome CHECK (sampling_outcome IS NULL OR sampling_outcome IN ('accepted', 'not_accepted')),
  CONSTRAINT chk_qc_inspection_task_status_pairing CHECK (
    (task_status = 'open' AND sampling_id IS NULL AND sampling_outcome IS NULL AND inspected_by IS NULL AND inspected_at IS NULL)
    OR (task_status = 'sampling_determined' AND sampling_id IS NOT NULL AND sampling_outcome IS NULL AND inspected_by IS NULL AND inspected_at IS NULL)
    OR (task_status = 'inspected' AND sampling_id IS NOT NULL AND sampling_outcome IS NOT NULL AND inspected_by IS NOT NULL AND inspected_at IS NOT NULL)
  ),
  CONSTRAINT chk_qc_inspection_task_counts CHECK (
    (nonconforming_sample_units IS NULL OR nonconforming_sample_units >= 0)
    AND (critical_nonconformities IS NULL OR critical_nonconformities >= 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_qc_inspection_task_gate ON qc_inspection_task (gate_status, business_date, task_id);
CREATE INDEX IF NOT EXISTS idx_qc_inspection_task_lot_number ON qc_inspection_task (lot_number);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_inspection_task_lot'
      AND conrelid = 'qc_inspection_task'::regclass
  ) THEN
    ALTER TABLE qc_inspection_task
      ADD CONSTRAINT uq_qc_inspection_task_lot UNIQUE (lot_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_inspection_task_source'
      AND conrelid = 'qc_inspection_task'::regclass
  ) THEN
    ALTER TABLE qc_inspection_task
      ADD CONSTRAINT uq_qc_inspection_task_source UNIQUE (source_completion_type, source_completion_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_inspection_task_quantity'
      AND conrelid = 'qc_inspection_task'::regclass
  ) THEN
    ALTER TABLE qc_inspection_task
      ADD CONSTRAINT chk_qc_inspection_task_quantity CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_inspection_task_source_type'
      AND conrelid = 'qc_inspection_task'::regclass
  ) THEN
    ALTER TABLE qc_inspection_task
      ADD CONSTRAINT chk_qc_inspection_task_source_type CHECK (source_completion_type IN ('synthetic_completion', 'production_order', 'job_work_order'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_inspection_task_status'
      AND conrelid = 'qc_inspection_task'::regclass
  ) THEN
    ALTER TABLE qc_inspection_task
      ADD CONSTRAINT chk_qc_inspection_task_status CHECK (task_status IN ('open', 'sampling_determined', 'inspected'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_inspection_task_gate_status'
      AND conrelid = 'qc_inspection_task'::regclass
  ) THEN
    ALTER TABLE qc_inspection_task
      ADD CONSTRAINT chk_qc_inspection_task_gate_status CHECK (gate_status IN ('qc_hold', 'conditionally_released', 'accepted', 'rejected', 'split'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_inspection_task_plan_scope'
      AND conrelid = 'qc_inspection_task'::regclass
  ) THEN
    ALTER TABLE qc_inspection_task
      ADD CONSTRAINT chk_qc_inspection_task_plan_scope CHECK (plan_scope IN ('standard', 'customer_override'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_inspection_task_scope_pairing'
      AND conrelid = 'qc_inspection_task'::regclass
  ) THEN
    ALTER TABLE qc_inspection_task
      ADD CONSTRAINT chk_qc_inspection_task_scope_pairing CHECK (
        (plan_scope = 'standard' AND source_order_type IS NULL AND source_order_ref IS NULL)
        OR (plan_scope = 'customer_override' AND source_order_type = 'job_work_order' AND source_order_ref IS NOT NULL AND btrim(source_order_ref) <> '')
      );
  END IF;
END $$;

-- Story 8.2 (Binding Scope Decision 5): widen the task-status vocabulary on a database created by
-- Story 8.1, where chk_qc_inspection_task_status admits only 'open'. Guarded on
-- pg_get_constraintdef, dropping the narrow definition and re-adding the widened one; once the
-- definition names sampling_determined the block is a no-op on every re-run.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_inspection_task_status'
      AND conrelid = 'qc_inspection_task'::regclass
      AND pg_get_constraintdef(oid) NOT LIKE '%sampling_determined%'
  ) THEN
    ALTER TABLE qc_inspection_task DROP CONSTRAINT chk_qc_inspection_task_status;
    ALTER TABLE qc_inspection_task
      ADD CONSTRAINT chk_qc_inspection_task_status CHECK (task_status IN ('open', 'sampling_determined', 'inspected'));
  END IF;
END $$;

-- Story 8.3 (Binding Scope Decision 3): widen the gate vocabulary on a database created by Story
-- 8.1 or 8.2, where chk_qc_inspection_task_gate_status admits only the two Story 8.1 states.
-- Guarded on pg_get_constraintdef exactly like the task_status block above; once the definition
-- names 'accepted' the block is a no-op on every re-run.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_inspection_task_gate_status'
      AND conrelid = 'qc_inspection_task'::regclass
      AND pg_get_constraintdef(oid) NOT LIKE '%accepted%'
  ) THEN
    ALTER TABLE qc_inspection_task DROP CONSTRAINT chk_qc_inspection_task_gate_status;
    ALTER TABLE qc_inspection_task
      ADD CONSTRAINT chk_qc_inspection_task_gate_status CHECK (gate_status IN ('qc_hold', 'conditionally_released', 'accepted', 'rejected', 'split'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'qc_inspection_task' AND column_name = 'sampling_id'
  ) THEN
    ALTER TABLE qc_inspection_task ADD COLUMN sampling_id UUID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'qc_inspection_task' AND column_name = 'sampling_outcome'
  ) THEN
    ALTER TABLE qc_inspection_task ADD COLUMN sampling_outcome TEXT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'qc_inspection_task' AND column_name = 'nonconforming_sample_units'
  ) THEN
    ALTER TABLE qc_inspection_task ADD COLUMN nonconforming_sample_units INTEGER;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'qc_inspection_task' AND column_name = 'critical_nonconformities'
  ) THEN
    ALTER TABLE qc_inspection_task ADD COLUMN critical_nonconformities INTEGER;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'qc_inspection_task' AND column_name = 'inspected_by'
  ) THEN
    ALTER TABLE qc_inspection_task ADD COLUMN inspected_by UUID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'qc_inspection_task' AND column_name = 'inspected_at'
  ) THEN
    ALTER TABLE qc_inspection_task ADD COLUMN inspected_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_inspection_task_sampling_outcome'
      AND conrelid = 'qc_inspection_task'::regclass
  ) THEN
    ALTER TABLE qc_inspection_task
      ADD CONSTRAINT chk_qc_inspection_task_sampling_outcome CHECK (sampling_outcome IS NULL OR sampling_outcome IN ('accepted', 'not_accepted'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_inspection_task_status_pairing'
      AND conrelid = 'qc_inspection_task'::regclass
  ) THEN
    ALTER TABLE qc_inspection_task
      ADD CONSTRAINT chk_qc_inspection_task_status_pairing CHECK (
        (task_status = 'open' AND sampling_id IS NULL AND sampling_outcome IS NULL AND inspected_by IS NULL AND inspected_at IS NULL)
        OR (task_status = 'sampling_determined' AND sampling_id IS NOT NULL AND sampling_outcome IS NULL AND inspected_by IS NULL AND inspected_at IS NULL)
        OR (task_status = 'inspected' AND sampling_id IS NOT NULL AND sampling_outcome IS NOT NULL AND inspected_by IS NOT NULL AND inspected_at IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_inspection_task_counts'
      AND conrelid = 'qc_inspection_task'::regclass
  ) THEN
    ALTER TABLE qc_inspection_task
      ADD CONSTRAINT chk_qc_inspection_task_counts CHECK (
        (nonconforming_sample_units IS NULL OR nonconforming_sample_units >= 0)
        AND (critical_nonconformities IS NULL OR critical_nonconformities >= 0)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON qc_inspection_task TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_inspection_task TO readonly_user;
  END IF;
END $$;

-- Story 8.1: qc_deviation (FR-Q-01/FR-Q-02/FR-Q-05). Mirror of read/projections/qc_deviation.sql.
-- QC deviation evidence (Story 8.1, FR-Q-02 and FR-Q-05, AC 4). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.conditional_release_recorded domain
-- events; mutation happens exclusively through persistEvent inside the SAME transaction as the
-- domain_events insert (the deviation, the shared disposition, the gate transition, the event, the
-- audit entry and the decision notification commit together or not at all).
--
-- An IMMUTABLE deviation record (AC 4): justification, explicit conditions, bounded scope and a
-- future expiry date, plus the requester, the DOA-resolved approver and the DOA entry that governed
-- qc.conditional_release. decided_on is the IST business date of the decision, so
-- chk_qc_deviation_expiry (expires_on > decided_on) is a database-enforced "valid future expiry".
--
-- scope_kind: internal_movement is the only scope this story makes operationally usable (to the
-- named location or process in scope_ref, while unexpired); order_allocation and dispatch may be
-- stored for future Story 8.4 activation but remain blocked until the batch release record exists
-- (Binding Scope Decisions 5 and 6).
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE or DELETE.

CREATE TABLE IF NOT EXISTS qc_deviation (
  deviation_id     UUID PRIMARY KEY,
  task_id          UUID NOT NULL,
  lot_id           UUID NOT NULL,
  deviation_type   TEXT NOT NULL,
  justification    TEXT NOT NULL,
  conditions       TEXT NOT NULL,
  scope_kind       TEXT NOT NULL,
  scope_ref        TEXT NOT NULL,
  decided_on       DATE NOT NULL,
  expires_on       DATE NOT NULL,
  requested_by     UUID NOT NULL,
  approved_by      UUID NOT NULL,
  doa_entry_id     UUID NOT NULL,
  decided_at       TIMESTAMPTZ NOT NULL,
  source_event_id  UUID NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_qc_deviation_task_type UNIQUE (task_id, deviation_type),
  CONSTRAINT chk_qc_deviation_type CHECK (deviation_type IN ('conditional_release')),
  CONSTRAINT chk_qc_deviation_scope_kind CHECK (scope_kind IN ('internal_movement', 'order_allocation', 'dispatch')),
  CONSTRAINT chk_qc_deviation_text CHECK (
    btrim(justification) <> '' AND char_length(justification) <= 2000
    AND btrim(conditions) <> '' AND char_length(conditions) <= 2000
    AND btrim(scope_ref) <> '' AND char_length(scope_ref) <= 128
  ),
  CONSTRAINT chk_qc_deviation_expiry CHECK (expires_on > decided_on)
);

CREATE INDEX IF NOT EXISTS idx_qc_deviation_lot ON qc_deviation (lot_id, expires_on);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_deviation_task_type'
      AND conrelid = 'qc_deviation'::regclass
  ) THEN
    ALTER TABLE qc_deviation
      ADD CONSTRAINT uq_qc_deviation_task_type UNIQUE (task_id, deviation_type);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_deviation_type'
      AND conrelid = 'qc_deviation'::regclass
  ) THEN
    ALTER TABLE qc_deviation
      ADD CONSTRAINT chk_qc_deviation_type CHECK (deviation_type IN ('conditional_release'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_deviation_scope_kind'
      AND conrelid = 'qc_deviation'::regclass
  ) THEN
    ALTER TABLE qc_deviation
      ADD CONSTRAINT chk_qc_deviation_scope_kind CHECK (scope_kind IN ('internal_movement', 'order_allocation', 'dispatch'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_deviation_text'
      AND conrelid = 'qc_deviation'::regclass
  ) THEN
    ALTER TABLE qc_deviation
      ADD CONSTRAINT chk_qc_deviation_text CHECK (
        btrim(justification) <> '' AND char_length(justification) <= 2000
        AND btrim(conditions) <> '' AND char_length(conditions) <= 2000
        AND btrim(scope_ref) <> '' AND char_length(scope_ref) <= 128
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_deviation_expiry'
      AND conrelid = 'qc_deviation'::regclass
  ) THEN
    ALTER TABLE qc_deviation
      ADD CONSTRAINT chk_qc_deviation_expiry CHECK (expires_on > decided_on);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON qc_deviation TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_deviation TO readonly_user;
  END IF;
END $$;

-- Story 8.1: qc_lot_disposition (FR-Q-01/FR-Q-02/FR-Q-05). Mirror of read/projections/qc_lot_disposition.sql.
-- QC lot disposition (Story 8.1, FR-Q-05, AC 4; extended by Story 8.3). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.conditional_release_recorded domain
-- events (Story 8.3 adds the accept and reject events); mutation happens exclusively through
-- persistEvent inside the SAME transaction as the domain_events insert.
--
-- The SHARED one-row-per-unsplit-lot disposition grain (Binding Scope Decisions 3 and 4): Story
-- 8.1 writes only 'conditional_release'; Story 8.3 widens chk_qc_lot_disposition_disposition to
-- 'accept' and 'reject' and adds partial-split behaviour. uq_qc_lot_disposition_lot is the
-- concurrency backstop: a sequential or concurrent second disposition for the same lot resolves to
-- 409 DISPOSITION_EXISTS in the store's constraint chain (the pre-check returns the same code).
--
-- Attribution stored now for Story 8.2 and 8.3 segregation-of-duties enforcement: the requester,
-- the inspector when a result recorder is known, the DOA-resolved approver and the DOA entry.
-- A conditional release always references its immutable qc_deviation row
-- (chk_qc_lot_disposition_deviation_pairing); scope, conditions and expiry live THROUGH that row.
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE or DELETE.

CREATE TABLE IF NOT EXISTS qc_lot_disposition (
  disposition_id     UUID PRIMARY KEY,
  lot_id             UUID NOT NULL,
  task_id            UUID NOT NULL,
  disposition        TEXT NOT NULL,
  deviation_id       UUID,
  plan_version_id    UUID NOT NULL,
  quantity           NUMERIC(18, 6) NOT NULL,
  requested_by       UUID NOT NULL,
  inspector_user_id  UUID,
  approved_by        UUID NOT NULL,
  doa_entry_id       UUID,
  decided_at         TIMESTAMPTZ NOT NULL,
  source_event_id    UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  sampling_outcome   TEXT,
  ncr_id             UUID,
  CONSTRAINT uq_qc_lot_disposition_lot UNIQUE (lot_id),
  CONSTRAINT chk_qc_lot_disposition_disposition CHECK (disposition IN ('conditional_release', 'accept', 'reject', 'split')),
  CONSTRAINT chk_qc_lot_disposition_quantity CHECK (quantity > 0),
  CONSTRAINT chk_qc_lot_disposition_deviation_pairing CHECK (disposition <> 'conditional_release' OR deviation_id IS NOT NULL),
  CONSTRAINT chk_qc_lot_disposition_doa_pairing CHECK ((disposition = 'conditional_release') = (doa_entry_id IS NOT NULL)),
  CONSTRAINT chk_qc_lot_disposition_sampling_outcome CHECK (sampling_outcome IS NULL OR sampling_outcome IN ('accepted', 'not_accepted')),
  CONSTRAINT chk_qc_lot_disposition_ncr_pairing CHECK ((disposition = 'reject') = (ncr_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_qc_lot_disposition_task ON qc_lot_disposition (task_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_lot_disposition_lot'
      AND conrelid = 'qc_lot_disposition'::regclass
  ) THEN
    ALTER TABLE qc_lot_disposition
      ADD CONSTRAINT uq_qc_lot_disposition_lot UNIQUE (lot_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_disposition_disposition'
      AND conrelid = 'qc_lot_disposition'::regclass
  ) THEN
    ALTER TABLE qc_lot_disposition
      ADD CONSTRAINT chk_qc_lot_disposition_disposition CHECK (disposition IN ('conditional_release'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_disposition_quantity'
      AND conrelid = 'qc_lot_disposition'::regclass
  ) THEN
    ALTER TABLE qc_lot_disposition
      ADD CONSTRAINT chk_qc_lot_disposition_quantity CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_disposition_deviation_pairing'
      AND conrelid = 'qc_lot_disposition'::regclass
  ) THEN
    ALTER TABLE qc_lot_disposition
      ADD CONSTRAINT chk_qc_lot_disposition_deviation_pairing CHECK (disposition <> 'conditional_release' OR deviation_id IS NOT NULL);
  END IF;
END $$;

-- Story 8.3 (Binding Scope Decision 2): widen the disposition vocabulary on a database created by
-- Story 8.1, where chk_qc_lot_disposition_disposition admits only 'conditional_release'. Guarded
-- on pg_get_constraintdef, dropping the narrow definition and re-adding the widened one; once the
-- definition names 'accept' the block is a no-op on every re-run. Same pattern Story 8.2 used for
-- chk_qc_inspection_task_status.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_disposition_disposition'
      AND conrelid = 'qc_lot_disposition'::regclass
      AND pg_get_constraintdef(oid) NOT LIKE '%accept%'
  ) THEN
    ALTER TABLE qc_lot_disposition DROP CONSTRAINT chk_qc_lot_disposition_disposition;
    ALTER TABLE qc_lot_disposition
      ADD CONSTRAINT chk_qc_lot_disposition_disposition CHECK (disposition IN ('conditional_release', 'accept', 'reject', 'split'));
  END IF;
END $$;

-- Story 8.3 (Binding Scope Decision 5): accept, reject and split carry no DOA gate, so
-- doa_entry_id becomes nullable and is paired to the conditional-release kind instead.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'qc_lot_disposition' AND column_name = 'doa_entry_id'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE qc_lot_disposition ALTER COLUMN doa_entry_id DROP NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'qc_lot_disposition' AND column_name = 'sampling_outcome'
  ) THEN
    ALTER TABLE qc_lot_disposition ADD COLUMN sampling_outcome TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'qc_lot_disposition' AND column_name = 'ncr_id'
  ) THEN
    ALTER TABLE qc_lot_disposition ADD COLUMN ncr_id UUID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_disposition_doa_pairing'
      AND conrelid = 'qc_lot_disposition'::regclass
  ) THEN
    ALTER TABLE qc_lot_disposition
      ADD CONSTRAINT chk_qc_lot_disposition_doa_pairing CHECK ((disposition = 'conditional_release') = (doa_entry_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_disposition_sampling_outcome'
      AND conrelid = 'qc_lot_disposition'::regclass
  ) THEN
    ALTER TABLE qc_lot_disposition
      ADD CONSTRAINT chk_qc_lot_disposition_sampling_outcome CHECK (sampling_outcome IS NULL OR sampling_outcome IN ('accepted', 'not_accepted'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_disposition_ncr_pairing'
      AND conrelid = 'qc_lot_disposition'::regclass
  ) THEN
    ALTER TABLE qc_lot_disposition
      ADD CONSTRAINT chk_qc_lot_disposition_ncr_pairing CHECK ((disposition = 'reject') = (ncr_id IS NOT NULL));
  END IF;
END $$;

-- Review patch (2026-08-30): the ncr_pairing check above shipped one-directional
-- (ncr_id IS NULL OR disposition = 'reject'), which forbade ncr_id on a non-reject row but never
-- required it on a reject row - a reject with ncr_id NULL passed. Widen any already-applied
-- one-directional definition to the symmetric biconditional, same guarded drop-then-add pattern as
-- the disposition vocabulary widening above.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_disposition_ncr_pairing'
      AND conrelid = 'qc_lot_disposition'::regclass
      AND pg_get_constraintdef(oid) NOT LIKE '%= (ncr_id IS NOT NULL)%'
  ) THEN
    ALTER TABLE qc_lot_disposition DROP CONSTRAINT chk_qc_lot_disposition_ncr_pairing;
    ALTER TABLE qc_lot_disposition
      ADD CONSTRAINT chk_qc_lot_disposition_ncr_pairing CHECK ((disposition = 'reject') = (ncr_id IS NOT NULL));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON qc_lot_disposition TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_lot_disposition TO readonly_user;
  END IF;
END $$;

-- QC sampling plan (Story 8.2, FR-Q-03, AC 1). This file is the CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its OWN
-- grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as app_user
-- without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates this
-- content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a live database
-- safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.sampling_determined domain events;
-- mutation happens exclusively through persistEvent inside the SAME transaction as the
-- domain_events insert.
--
-- The plan FROZEN on a task: the IS 2500 (Part 1) / ISO 2859-1 single-sampling plan derived on the
-- server from the frozen plan version's AQL and inspection level, the lot size and the switching
-- state's severity at the moment of determination. Every later determination attempt for the same
-- task replays this row (uq_qc_sampling_plan_task is the concurrency backstop; a 23505 resolves to
-- 409 QC_SAMPLING_EXISTS in the store's constraint chain). A version with no AQL freezes a
-- full_inspection plan (sample_size = lot_size, no Ac/Re, no code letter).
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE or DELETE.

CREATE TABLE IF NOT EXISTS qc_sampling_plan (
  sampling_id                    UUID PRIMARY KEY,
  task_id                        UUID NOT NULL,
  lot_id                         UUID NOT NULL,
  lot_number                     TEXT NOT NULL,
  plan_version_id                UUID NOT NULL,
  plan_id                        UUID NOT NULL,
  site_id                        UUID NOT NULL,
  lot_size                       INTEGER NOT NULL,
  aql                            NUMERIC(7, 3),
  inspection_level               TEXT,
  severity                       TEXT NOT NULL,
  code_letter                    TEXT,
  resolved_code_letter           TEXT,
  sample_size                    INTEGER NOT NULL,
  acceptance_number              INTEGER,
  rejection_number               INTEGER,
  sampling_basis                 TEXT NOT NULL,
  standard_ref                   TEXT NOT NULL,
  critical_characteristic_count  INTEGER NOT NULL,
  determined_by                  UUID NOT NULL,
  determined_at                  TIMESTAMPTZ NOT NULL,
  source_event_id                UUID NOT NULL,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_qc_sampling_plan_task UNIQUE (task_id),
  CONSTRAINT chk_qc_sampling_plan_severity CHECK (severity IN ('normal', 'tightened', 'reduced')),
  CONSTRAINT chk_qc_sampling_plan_basis CHECK (sampling_basis IN ('aql_table', 'full_inspection')),
  CONSTRAINT chk_qc_sampling_plan_level CHECK (inspection_level IS NULL OR inspection_level IN ('I', 'II', 'III', 'S-1', 'S-2', 'S-3', 'S-4')),
  CONSTRAINT chk_qc_sampling_plan_sizes CHECK (lot_size > 0 AND sample_size > 0 AND sample_size <= lot_size AND critical_characteristic_count >= 0 AND (sampling_basis <> 'full_inspection' OR sample_size = lot_size)),
  CONSTRAINT chk_qc_sampling_plan_ac_re CHECK (
    (acceptance_number IS NULL AND rejection_number IS NULL)
    OR (acceptance_number IS NOT NULL AND rejection_number IS NOT NULL AND acceptance_number >= 0 AND rejection_number > acceptance_number)
  ),
  CONSTRAINT chk_qc_sampling_plan_basis_pairing CHECK (
    (sampling_basis = 'full_inspection' AND aql IS NULL AND inspection_level IS NULL AND code_letter IS NULL AND resolved_code_letter IS NULL AND acceptance_number IS NULL)
    OR (sampling_basis = 'aql_table' AND aql IS NOT NULL AND inspection_level IS NOT NULL AND code_letter IS NOT NULL AND resolved_code_letter IS NOT NULL AND acceptance_number IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_qc_sampling_plan_plan_site ON qc_sampling_plan (plan_id, site_id, determined_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_sampling_plan_task'
      AND conrelid = 'qc_sampling_plan'::regclass
  ) THEN
    ALTER TABLE qc_sampling_plan
      ADD CONSTRAINT uq_qc_sampling_plan_task UNIQUE (task_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_sampling_plan_severity'
      AND conrelid = 'qc_sampling_plan'::regclass
  ) THEN
    ALTER TABLE qc_sampling_plan
      ADD CONSTRAINT chk_qc_sampling_plan_severity CHECK (severity IN ('normal', 'tightened', 'reduced'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_sampling_plan_basis'
      AND conrelid = 'qc_sampling_plan'::regclass
  ) THEN
    ALTER TABLE qc_sampling_plan
      ADD CONSTRAINT chk_qc_sampling_plan_basis CHECK (sampling_basis IN ('aql_table', 'full_inspection'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_sampling_plan_level'
      AND conrelid = 'qc_sampling_plan'::regclass
  ) THEN
    ALTER TABLE qc_sampling_plan
      ADD CONSTRAINT chk_qc_sampling_plan_level CHECK (inspection_level IS NULL OR inspection_level IN ('I', 'II', 'III', 'S-1', 'S-2', 'S-3', 'S-4'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_sampling_plan_sizes'
      AND conrelid = 'qc_sampling_plan'::regclass
  ) THEN
    ALTER TABLE qc_sampling_plan
      ADD CONSTRAINT chk_qc_sampling_plan_sizes CHECK (lot_size > 0 AND sample_size > 0 AND sample_size <= lot_size AND critical_characteristic_count >= 0 AND (sampling_basis <> 'full_inspection' OR sample_size = lot_size));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_sampling_plan_ac_re'
      AND conrelid = 'qc_sampling_plan'::regclass
  ) THEN
    ALTER TABLE qc_sampling_plan
      ADD CONSTRAINT chk_qc_sampling_plan_ac_re CHECK (
        (acceptance_number IS NULL AND rejection_number IS NULL)
        OR (acceptance_number IS NOT NULL AND rejection_number IS NOT NULL AND acceptance_number >= 0 AND rejection_number > acceptance_number)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_sampling_plan_basis_pairing'
      AND conrelid = 'qc_sampling_plan'::regclass
  ) THEN
    ALTER TABLE qc_sampling_plan
      ADD CONSTRAINT chk_qc_sampling_plan_basis_pairing CHECK (
        (sampling_basis = 'full_inspection' AND aql IS NULL AND inspection_level IS NULL AND code_letter IS NULL AND resolved_code_letter IS NULL AND acceptance_number IS NULL)
        OR (sampling_basis = 'aql_table' AND aql IS NOT NULL AND inspection_level IS NOT NULL AND code_letter IS NOT NULL AND resolved_code_letter IS NOT NULL AND acceptance_number IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON qc_sampling_plan TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_sampling_plan TO readonly_user;
  END IF;
END $$;

-- QC inspection result (Story 8.2, FR-Q-03, FR-Q-04, AC 2, AC 4, AC 5). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.result_recorded (instrument-bound) and
-- qc.observation_recorded (instrument-less attribute) domain events; mutation happens exclusively
-- through persistEvent inside the SAME transaction as the domain_events insert.
--
-- One authoritative, immutable result per (task, characteristic, sample unit) (Annex requirement
-- 6): uq_qc_inspection_result_unit is the concurrency backstop and a 23505 resolves to 409
-- QC_RESULT_EXISTS in the store's constraint chain. conforms is derived on the server and stored
-- (Annex requirement 7). An instrument-bound result carries BOTH the register asset and the QC
-- instrument key the calibration gate reads; an observation carries neither
-- (chk_qc_inspection_result_instrument_pairing). recorded_by is the segregation-of-duties
-- substrate the conditional-release seam reads (Binding Scope Decision 12).
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE or DELETE.

CREATE TABLE IF NOT EXISTS qc_inspection_result (
  result_id             UUID PRIMARY KEY,
  task_id               UUID NOT NULL,
  lot_id                UUID NOT NULL,
  characteristic_id     UUID NOT NULL,
  characteristic_class  TEXT NOT NULL,
  sample_unit_no        INTEGER NOT NULL,
  result_kind           TEXT NOT NULL,
  measured_value        NUMERIC(18, 6),
  measured_uom          TEXT,
  attribute_conforms    BOOLEAN,
  conforms              BOOLEAN NOT NULL,
  instrument_asset_id   UUID,
  instrument_id         TEXT,
  recorded_by           UUID NOT NULL,
  recorded_at           TIMESTAMPTZ NOT NULL,
  source_event_id       UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_qc_inspection_result_unit UNIQUE (task_id, characteristic_id, sample_unit_no),
  CONSTRAINT chk_qc_inspection_result_class CHECK (characteristic_class IN ('critical', 'major', 'minor')),
  CONSTRAINT chk_qc_inspection_result_unit_no CHECK (sample_unit_no > 0),
  CONSTRAINT chk_qc_inspection_result_kind_pairing CHECK (
    (result_kind = 'numeric' AND measured_value IS NOT NULL AND measured_uom IS NOT NULL AND attribute_conforms IS NULL)
    OR (result_kind = 'attribute' AND measured_value IS NULL AND measured_uom IS NULL AND attribute_conforms IS NOT NULL)
  ),
  CONSTRAINT chk_qc_inspection_result_instrument_pairing CHECK (
    (instrument_asset_id IS NULL AND instrument_id IS NULL)
    OR (instrument_asset_id IS NOT NULL AND instrument_id IS NOT NULL AND btrim(instrument_id) <> '')
  )
);

CREATE INDEX IF NOT EXISTS idx_qc_inspection_result_task_characteristic ON qc_inspection_result (task_id, characteristic_id);
CREATE INDEX IF NOT EXISTS idx_qc_inspection_result_task_recorder ON qc_inspection_result (task_id, recorded_by);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_inspection_result_unit'
      AND conrelid = 'qc_inspection_result'::regclass
  ) THEN
    ALTER TABLE qc_inspection_result
      ADD CONSTRAINT uq_qc_inspection_result_unit UNIQUE (task_id, characteristic_id, sample_unit_no);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_inspection_result_class'
      AND conrelid = 'qc_inspection_result'::regclass
  ) THEN
    ALTER TABLE qc_inspection_result
      ADD CONSTRAINT chk_qc_inspection_result_class CHECK (characteristic_class IN ('critical', 'major', 'minor'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_inspection_result_unit_no'
      AND conrelid = 'qc_inspection_result'::regclass
  ) THEN
    ALTER TABLE qc_inspection_result
      ADD CONSTRAINT chk_qc_inspection_result_unit_no CHECK (sample_unit_no > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_inspection_result_kind_pairing'
      AND conrelid = 'qc_inspection_result'::regclass
  ) THEN
    ALTER TABLE qc_inspection_result
      ADD CONSTRAINT chk_qc_inspection_result_kind_pairing CHECK (
        (result_kind = 'numeric' AND measured_value IS NOT NULL AND measured_uom IS NOT NULL AND attribute_conforms IS NULL)
        OR (result_kind = 'attribute' AND measured_value IS NULL AND measured_uom IS NULL AND attribute_conforms IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_inspection_result_instrument_pairing'
      AND conrelid = 'qc_inspection_result'::regclass
  ) THEN
    ALTER TABLE qc_inspection_result
      ADD CONSTRAINT chk_qc_inspection_result_instrument_pairing CHECK (
        (instrument_asset_id IS NULL AND instrument_id IS NULL)
        OR (instrument_asset_id IS NOT NULL AND instrument_id IS NOT NULL AND btrim(instrument_id) <> '')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON qc_inspection_result TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_inspection_result TO readonly_user;
  END IF;
END $$;

-- QC sampling switching state (Story 8.2, FR-Q-03, AC 3). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.inspection_completed and
-- qc.sampling_state_adjusted domain events in stream order; mutation happens exclusively through
-- persistEvent inside the SAME transaction as the domain_events insert.
--
-- The ISO 2859-1 clause 9.3 switching state kept per (plan, site) (Binding Scope Decision 7): the
-- current severity, the clause 9.3.3.2 switching score, the window of at most five most recent
-- original-inspection outcomes (newest last), the tightened-inspection counters, the
-- reduced-eligibility flag that a QC Head-level command turns into reduced inspection, and the
-- discontinuation flag that a QC Head-level command resumes on tightened. The row is read under
-- lock at sampling determination and advanced under lock at inspection completion.
--
-- app_user holds INSERT, SELECT, UPDATE (the advance) and never DELETE.

CREATE TABLE IF NOT EXISTS qc_sampling_switching_state (
  plan_id                            UUID NOT NULL,
  site_id                            UUID NOT NULL,
  severity                           TEXT NOT NULL DEFAULT 'normal',
  switching_score                    INTEGER NOT NULL DEFAULT 0,
  recent_original_outcomes           JSONB NOT NULL DEFAULT '[]'::jsonb,
  consecutive_accepted_on_tightened  INTEGER NOT NULL DEFAULT 0,
  not_accepted_on_tightened          INTEGER NOT NULL DEFAULT 0,
  reduced_eligible                   BOOLEAN NOT NULL DEFAULT false,
  inspection_discontinued            BOOLEAN NOT NULL DEFAULT false,
  last_task_id                       UUID,
  lots_counted                       INTEGER NOT NULL DEFAULT 0,
  source_event_id                    UUID NOT NULL,
  created_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_qc_sampling_switching_state PRIMARY KEY (plan_id, site_id),
  CONSTRAINT chk_qc_sampling_switching_state_severity CHECK (severity IN ('normal', 'tightened', 'reduced')),
  CONSTRAINT chk_qc_sampling_switching_state_counters CHECK (switching_score >= 0 AND consecutive_accepted_on_tightened >= 0 AND not_accepted_on_tightened >= 0 AND lots_counted >= 0),
  CONSTRAINT chk_qc_sampling_switching_state_window CHECK (jsonb_typeof(recent_original_outcomes) = 'array' AND jsonb_array_length(recent_original_outcomes) <= 5 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(recent_original_outcomes) e WHERE jsonb_typeof(e) <> 'boolean'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_sampling_switching_state_severity'
      AND conrelid = 'qc_sampling_switching_state'::regclass
  ) THEN
    ALTER TABLE qc_sampling_switching_state
      ADD CONSTRAINT chk_qc_sampling_switching_state_severity CHECK (severity IN ('normal', 'tightened', 'reduced'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_sampling_switching_state_counters'
      AND conrelid = 'qc_sampling_switching_state'::regclass
  ) THEN
    ALTER TABLE qc_sampling_switching_state
      ADD CONSTRAINT chk_qc_sampling_switching_state_counters CHECK (switching_score >= 0 AND consecutive_accepted_on_tightened >= 0 AND not_accepted_on_tightened >= 0 AND lots_counted >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_sampling_switching_state_window'
      AND conrelid = 'qc_sampling_switching_state'::regclass
  ) THEN
    ALTER TABLE qc_sampling_switching_state
      ADD CONSTRAINT chk_qc_sampling_switching_state_window CHECK (jsonb_typeof(recent_original_outcomes) = 'array' AND jsonb_array_length(recent_original_outcomes) <= 5 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(recent_original_outcomes) e WHERE jsonb_typeof(e) <> 'boolean'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON qc_sampling_switching_state TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_sampling_switching_state TO readonly_user;
  END IF;
END $$;

-- QC partial lot split (Story 8.3, FR-Q-05, AC 2). This file is the CANONICAL definition, applied
-- by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its
-- OWN grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as
-- app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a live database
-- safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.lot_split_recorded domain events;
-- mutation happens exclusively through persistEvent inside the SAME transaction as the
-- domain_events insert.
--
-- One row per CHILD lot. It is the parent-to-child linkage that the parent's own
-- qc_inspection_task row cannot carry: uq_qc_inspection_task_source forbids reusing the parent's
-- (source_completion_type, source_completion_id) on a child, so each child task mints a fresh
-- source_completion_id and the real provenance lives here (Story 8.3 Annex requirement 7).
--
-- uq_qc_lot_split_child is the concurrency backstop for a replayed or raced split; the parent-side
-- backstop is uq_qc_lot_disposition_lot on the parent's 'split' disposition row, so a second split
-- of the same parent is 409 DISPOSITION_EXISTS, never a partial second set of children.
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE or DELETE.

CREATE TABLE IF NOT EXISTS qc_lot_split (
  split_id          UUID PRIMARY KEY,
  parent_lot_id     UUID NOT NULL,
  parent_lot_number TEXT NOT NULL,
  parent_task_id    UUID NOT NULL,
  disposition_id    UUID NOT NULL,
  child_lot_id      UUID NOT NULL,
  child_lot_number  TEXT NOT NULL,
  child_task_id     UUID NOT NULL,
  sequence          INTEGER NOT NULL,
  quantity          NUMERIC(18, 6) NOT NULL,
  source_event_id   UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_qc_lot_split_child UNIQUE (child_lot_id),
  CONSTRAINT uq_qc_lot_split_sequence UNIQUE (parent_lot_id, sequence),
  CONSTRAINT chk_qc_lot_split_quantity CHECK (quantity > 0),
  CONSTRAINT chk_qc_lot_split_sequence CHECK (sequence >= 1),
  CONSTRAINT chk_qc_lot_split_distinct CHECK (child_lot_id <> parent_lot_id)
);

CREATE INDEX IF NOT EXISTS idx_qc_lot_split_parent ON qc_lot_split (parent_lot_id, sequence);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_lot_split_child'
      AND conrelid = 'qc_lot_split'::regclass
  ) THEN
    ALTER TABLE qc_lot_split
      ADD CONSTRAINT uq_qc_lot_split_child UNIQUE (child_lot_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_lot_split_sequence'
      AND conrelid = 'qc_lot_split'::regclass
  ) THEN
    ALTER TABLE qc_lot_split
      ADD CONSTRAINT uq_qc_lot_split_sequence UNIQUE (parent_lot_id, sequence);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_split_quantity'
      AND conrelid = 'qc_lot_split'::regclass
  ) THEN
    ALTER TABLE qc_lot_split
      ADD CONSTRAINT chk_qc_lot_split_quantity CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_split_sequence'
      AND conrelid = 'qc_lot_split'::regclass
  ) THEN
    ALTER TABLE qc_lot_split
      ADD CONSTRAINT chk_qc_lot_split_sequence CHECK (sequence >= 1);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_split_distinct'
      AND conrelid = 'qc_lot_split'::regclass
  ) THEN
    ALTER TABLE qc_lot_split
      ADD CONSTRAINT chk_qc_lot_split_distinct CHECK (child_lot_id <> parent_lot_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON qc_lot_split TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_lot_split TO readonly_user;
  END IF;
END $$;

-- QC non-conformance report (Story 8.3, FR-Q-06, AC 3, AC 4 and AC 5). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.lot_dispositioned (the reject that
-- raises the NCR) and qc.ncr_outcome_recorded (the once-only outcome) domain events; mutation
-- happens exclusively through persistEvent inside the SAME transaction as the domain_events
-- insert.
--
-- Story 8.3 Annex requirement 8: the NCR is created BY the reject disposition, not by a separate
-- raise command, so a rejected lot can never exist without its NCR record. uq_qc_ncr_lot is the
-- one-per-lot backstop (a 23505 resolves to 409 NCR_EXISTS in the store's constraint chain).
--
-- Annex requirement 9: the outcome is set exactly once. outcome IS NULL means open. The outcome
-- UPDATE is guarded by WHERE outcome IS NULL, so a concurrent second command updates zero rows and
-- raises 409 NCR_OUTCOME_EXISTS. There is no reopen and no second outcome.
--
-- chk_qc_ncr_outcome_pairing keeps the five outcome columns null together and non-null together,
-- and pairs the route-specific columns to their outcome: downgrade_sku and downgrade_lot_id exist
-- exactly for 'downgrade', rework_requested_event_id exactly for 'rework'. A 'scrap' outcome
-- carries none of them - it parks the quantity on lot_master.quality_hold_status ('held', reason
-- scrap_pending) and retains this row plus its event as the AD-10 source document for the Phase 2
-- (Epic 16) FR-SC intake.
--
-- app_user holds INSERT, SELECT and UPDATE (the one outcome transition) and never DELETE.

CREATE TABLE IF NOT EXISTS qc_ncr (
  ncr_id                    UUID PRIMARY KEY,
  lot_id                    UUID NOT NULL,
  lot_number                TEXT NOT NULL,
  task_id                   UUID NOT NULL,
  disposition_id            UUID NOT NULL,
  site_id                   UUID NOT NULL,
  sku                       TEXT NOT NULL,
  quantity                  NUMERIC(18, 6) NOT NULL,
  justification             TEXT NOT NULL,
  raised_by                 UUID NOT NULL,
  raised_at                 TIMESTAMPTZ NOT NULL,
  source_event_id           UUID NOT NULL,
  outcome                   TEXT,
  outcome_reason            TEXT,
  outcome_by                UUID,
  outcome_at                TIMESTAMPTZ,
  outcome_event_id          UUID,
  downgrade_sku             TEXT,
  downgrade_lot_id          UUID,
  rework_requested_event_id UUID,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_qc_ncr_lot UNIQUE (lot_id),
  CONSTRAINT uq_qc_ncr_disposition UNIQUE (disposition_id),
  CONSTRAINT chk_qc_ncr_quantity CHECK (quantity > 0),
  CONSTRAINT chk_qc_ncr_justification CHECK (btrim(justification) <> '' AND char_length(justification) <= 2000),
  CONSTRAINT chk_qc_ncr_outcome CHECK (outcome IS NULL OR outcome IN ('rework', 'downgrade', 'scrap')),
  CONSTRAINT chk_qc_ncr_outcome_pairing CHECK (
    (outcome IS NULL AND outcome_reason IS NULL AND outcome_by IS NULL AND outcome_at IS NULL AND outcome_event_id IS NULL)
    OR (outcome IS NOT NULL AND outcome_reason IS NOT NULL AND btrim(outcome_reason) <> '' AND char_length(outcome_reason) <= 2000
        AND outcome_by IS NOT NULL AND outcome_at IS NOT NULL AND outcome_event_id IS NOT NULL)
  ),
  CONSTRAINT chk_qc_ncr_downgrade_pairing CHECK (
    (outcome IS NOT DISTINCT FROM 'downgrade') = (downgrade_sku IS NOT NULL)
    AND (downgrade_sku IS NOT NULL) = (downgrade_lot_id IS NOT NULL)
    AND (downgrade_sku IS NULL OR (btrim(downgrade_sku) <> '' AND downgrade_sku <> sku))
    AND (downgrade_lot_id IS NULL OR downgrade_lot_id <> lot_id)
  ),
  CONSTRAINT chk_qc_ncr_rework_pairing CHECK (
    (outcome IS NOT DISTINCT FROM 'rework') = (rework_requested_event_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_qc_ncr_site ON qc_ncr (site_id, raised_at, ncr_id);
CREATE INDEX IF NOT EXISTS idx_qc_ncr_task ON qc_ncr (task_id);

DO $$
BEGIN
  -- Story 8.5: the uq_qc_ncr_lot and uq_qc_ncr_disposition add-if-missing guards that used to
  -- open this block are REMOVED, not merely superseded. The widening section below drops both
  -- table constraints and replaces them with partial unique INDEXES (one of them under the SAME
  -- name), so a surviving guard here would re-add the constraint on the next re-apply and abort
  -- the file with "relation uq_qc_ncr_disposition already exists" - the exact narrow-guard
  -- re-application failure the Story 6.3 posting_type widening already taught. The inline CREATE
  -- TABLE constraints stay for a FRESH database; the widening section normalizes either starting
  -- point to the partial-index form.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_ncr_quantity'
      AND conrelid = 'qc_ncr'::regclass
  ) THEN
    ALTER TABLE qc_ncr ADD CONSTRAINT chk_qc_ncr_quantity CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_ncr_justification'
      AND conrelid = 'qc_ncr'::regclass
  ) THEN
    ALTER TABLE qc_ncr
      ADD CONSTRAINT chk_qc_ncr_justification CHECK (btrim(justification) <> '' AND char_length(justification) <= 2000);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_ncr_outcome'
      AND conrelid = 'qc_ncr'::regclass
  ) THEN
    ALTER TABLE qc_ncr
      ADD CONSTRAINT chk_qc_ncr_outcome CHECK (outcome IS NULL OR outcome IN ('rework', 'downgrade', 'scrap'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_ncr_outcome_pairing'
      AND conrelid = 'qc_ncr'::regclass
  ) THEN
    ALTER TABLE qc_ncr
      ADD CONSTRAINT chk_qc_ncr_outcome_pairing CHECK (
        (outcome IS NULL AND outcome_reason IS NULL AND outcome_by IS NULL AND outcome_at IS NULL AND outcome_event_id IS NULL)
        OR (outcome IS NOT NULL AND outcome_reason IS NOT NULL AND btrim(outcome_reason) <> '' AND char_length(outcome_reason) <= 2000
            AND outcome_by IS NOT NULL AND outcome_at IS NOT NULL AND outcome_event_id IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_ncr_downgrade_pairing'
      AND conrelid = 'qc_ncr'::regclass
  ) THEN
    ALTER TABLE qc_ncr
      ADD CONSTRAINT chk_qc_ncr_downgrade_pairing CHECK (
        (outcome IS NOT DISTINCT FROM 'downgrade') = (downgrade_sku IS NOT NULL)
        AND (downgrade_sku IS NOT NULL) = (downgrade_lot_id IS NOT NULL)
        AND (downgrade_sku IS NULL OR (btrim(downgrade_sku) <> '' AND downgrade_sku <> sku))
        AND (downgrade_lot_id IS NULL OR downgrade_lot_id <> lot_id)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_ncr_rework_pairing'
      AND conrelid = 'qc_ncr'::regclass
  ) THEN
    ALTER TABLE qc_ncr
      ADD CONSTRAINT chk_qc_ncr_rework_pairing CHECK (
        (outcome IS NOT DISTINCT FROM 'rework') = (rework_requested_event_id IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON qc_ncr TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_ncr TO readonly_user;
  END IF;
END $$;

-- Story 8.5 (FR-Q-10, Binding Scope Decision 9): the NCR gains a second ORIGIN. A hold-sourced NCR
-- is raised independently of any disposition, so disposition_id and task_id become nullable and
-- the one-per-lot backstop narrows to disposition-sourced rows only (a lot may accumulate several
-- hold-sourced NCRs over its life, but the Story 8.3 "created BY the reject" invariant is
-- unchanged for origin = 'disposition'). uq_qc_ncr_lot is REPLACED by the partial
-- uq_qc_ncr_lot_disposition_sourced and uq_qc_ncr_disposition is re-stated as a partial unique
-- index; BOTH keep resolving to 409 NCR_EXISTS in the store's constraint chain, byte-identical to
-- the Story 8.3 behaviour.
--
-- chk_qc_ncr_origin (as widened by Story 8.6 Binding Scope Decision 9): the origin enum, the
-- disposition biconditional ('disposition' exactly when disposition_id and task_id are both
-- non-null) and the hold_id pairing are unchanged from Story 8.5. ONLY the hold/defect conjunct
-- relaxed, from a biconditional to the one-way (origin = 'hold') implies (defect_code IS NOT NULL):
-- a hold-sourced NCR still ALWAYS carries a defect code (AC 3), and a disposition-origin NCR MAY
-- now carry one (the optional reject-path defect_code feeding the FR-Q-13 by-defect-code metric).
-- hold_id stays nullable because a lot may be flag-held by the Story 2.3 ad hoc route without a
-- governed qc_quality_hold row.
--
-- chk_qc_ncr_outcome is widened to admit 'closed_with_capa' (Binding Scope Decision 14): the
-- hold-sourced terminal outcome that moves no stock, so chk_qc_ncr_downgrade_pairing and
-- chk_qc_ncr_rework_pairing stay true unchanged.
ALTER TABLE qc_ncr ADD COLUMN IF NOT EXISTS origin TEXT;
UPDATE qc_ncr SET origin = 'disposition' WHERE origin IS NULL;
ALTER TABLE qc_ncr ALTER COLUMN origin SET NOT NULL;
ALTER TABLE qc_ncr ADD COLUMN IF NOT EXISTS hold_id UUID;
ALTER TABLE qc_ncr ADD COLUMN IF NOT EXISTS defect_code TEXT;
ALTER TABLE qc_ncr ADD COLUMN IF NOT EXISTS capa_id UUID;
ALTER TABLE qc_ncr ADD COLUMN IF NOT EXISTS capa_mandatory BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE qc_ncr ALTER COLUMN disposition_id DROP NOT NULL;
ALTER TABLE qc_ncr ALTER COLUMN task_id DROP NOT NULL;

ALTER TABLE qc_ncr DROP CONSTRAINT IF EXISTS uq_qc_ncr_lot;
ALTER TABLE qc_ncr DROP CONSTRAINT IF EXISTS uq_qc_ncr_disposition;
CREATE UNIQUE INDEX IF NOT EXISTS uq_qc_ncr_lot_disposition_sourced ON qc_ncr (lot_id) WHERE disposition_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_qc_ncr_disposition ON qc_ncr (disposition_id) WHERE disposition_id IS NOT NULL;

DO $$
BEGIN
  ALTER TABLE qc_ncr DROP CONSTRAINT IF EXISTS chk_qc_ncr_outcome;
  ALTER TABLE qc_ncr
    ADD CONSTRAINT chk_qc_ncr_outcome CHECK (outcome IS NULL OR outcome IN ('rework', 'downgrade', 'scrap', 'closed_with_capa'));
  -- Story 8.6 widening (Binding Scope Decision 9): drop-then-add keyed on pg_get_constraintdef
  -- (the Story 8.3 template). The Story 8.5 biconditional definition contains no '<>' operator
  -- while the widened one does, so the marker is unambiguous and the block is a no-op once the
  -- widened definition is in place (migrate-twice clean).
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_ncr_origin'
      AND conrelid = 'qc_ncr'::regclass
      AND pg_get_constraintdef(oid) NOT LIKE '%<>%'
  ) THEN
    ALTER TABLE qc_ncr DROP CONSTRAINT chk_qc_ncr_origin;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_ncr_origin'
      AND conrelid = 'qc_ncr'::regclass
  ) THEN
    ALTER TABLE qc_ncr
      ADD CONSTRAINT chk_qc_ncr_origin CHECK (
        origin IN ('disposition', 'hold')
        AND (origin = 'disposition') = (disposition_id IS NOT NULL AND task_id IS NOT NULL)
        AND (origin <> 'hold' OR defect_code IS NOT NULL)
        AND (hold_id IS NULL OR origin = 'hold')
      );
  END IF;
END $$;

-- QC batch release record (Story 8.4, FR-Q-07, AC 1, AC 3, AC 6 and AC 7). This file is the
-- CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying the qc.batch_release_recorded domain event;
-- mutation happens exclusively through persistEvent inside the SAME transaction as the
-- domain_events insert.
--
-- Story 8.4 Binding Scope Decision 1: release is a DOWNSTREAM step on top of an already-decided
-- disposition, not a rename of it. A row exists only when qc_lot_disposition.disposition is
-- 'accept' or 'conditional_release' for the same lot; uq_qc_batch_release_lot and
-- uq_qc_batch_release_disposition are the one-per-lot backstops (a 23505 resolves to 409
-- RELEASE_EXISTS in the store's constraint chain), the same shape uq_qc_lot_disposition_lot has.
--
-- Binding Scope Decision 4: document_kind is DERIVED from the released item's
-- item_master.bis_licence_required - 'coc' for a BIS-covered product (the regulatory conformance
-- format, which is where AC 3's CM/L or R-number is printed), 'coa' otherwise.
--
-- Binding Scope Decision 5: no physical document is generated or stored by this story. document_ref
-- is the future document-store key and is left NULL here, following the reference-not-bytes
-- precedent of supplier_invoice's attachment_ref. THIS ROW plus its event IS the retained record
-- for the retention_years window today (ARCHITECTURE-SPINE.md Retention Policy).
--
-- Story 8.6 Binding Scope Decision 2 (reversing Story 8.4 Decision 2): bis_licence_number carries
-- what the register-backed resolveBisLicence returns from compliance_bis_licence. Under `enforce`
-- mode (the QC_STATUTORY_RELEASE_BLOCKS default) a BIS-covered product with NO valid covering
-- licence is REJECTED with BIS_LICENCE_INVALID before this row is written; under `dormant` (the
-- A-13 licence-data load window) the Story 8.4 behaviour holds: number when the register has one,
-- null otherwise, and a null does not block.
--
-- chk_qc_batch_release_bis_licence_pairing states the full invariant AC 3 actually claims: a licence
-- number may exist ONLY on a CoC (it is the BIS conformance format), and when present it must be
-- non-blank. Without it a CoA carrying a CM/L number, and an empty-string number that a certificate
-- would print as a blank licence field rather than omitting it, are both representable rows.
--
-- app_user holds INSERT and SELECT only: there is no revision, amendment or retraction concept in
-- this story, so the table is append-only and never DELETE.

CREATE TABLE IF NOT EXISTS qc_batch_release (
  release_id            UUID PRIMARY KEY,
  lot_id                UUID NOT NULL,
  task_id               UUID NOT NULL,
  disposition_id        UUID NOT NULL,
  document_kind         TEXT NOT NULL,
  document_ref          TEXT,
  retention_years       INTEGER NOT NULL,
  retention_expires_on  DATE NOT NULL,
  bis_licence_number    TEXT,
  released_by           UUID NOT NULL,
  released_at           TIMESTAMPTZ NOT NULL,
  source_event_id       UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_qc_batch_release_lot UNIQUE (lot_id),
  CONSTRAINT uq_qc_batch_release_disposition UNIQUE (disposition_id),
  CONSTRAINT chk_qc_batch_release_document_kind CHECK (document_kind IN ('coa', 'coc')),
  CONSTRAINT chk_qc_batch_release_retention_years CHECK (retention_years > 0),
  CONSTRAINT chk_qc_batch_release_bis_licence_pairing CHECK (
    bis_licence_number IS NULL
    OR (document_kind = 'coc' AND btrim(bis_licence_number) <> '')
  )
);

CREATE INDEX IF NOT EXISTS idx_qc_batch_release_task ON qc_batch_release (task_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_batch_release_lot'
      AND conrelid = 'qc_batch_release'::regclass
  ) THEN
    ALTER TABLE qc_batch_release ADD CONSTRAINT uq_qc_batch_release_lot UNIQUE (lot_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_batch_release_disposition'
      AND conrelid = 'qc_batch_release'::regclass
  ) THEN
    ALTER TABLE qc_batch_release ADD CONSTRAINT uq_qc_batch_release_disposition UNIQUE (disposition_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_batch_release_document_kind'
      AND conrelid = 'qc_batch_release'::regclass
  ) THEN
    ALTER TABLE qc_batch_release
      ADD CONSTRAINT chk_qc_batch_release_document_kind CHECK (document_kind IN ('coa', 'coc'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_batch_release_retention_years'
      AND conrelid = 'qc_batch_release'::regclass
  ) THEN
    ALTER TABLE qc_batch_release
      ADD CONSTRAINT chk_qc_batch_release_retention_years CHECK (retention_years > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_batch_release_bis_licence_pairing'
      AND conrelid = 'qc_batch_release'::regclass
  ) THEN
    ALTER TABLE qc_batch_release
      ADD CONSTRAINT chk_qc_batch_release_bis_licence_pairing CHECK (
        bis_licence_number IS NULL
        OR (document_kind = 'coc' AND btrim(bis_licence_number) <> '')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON qc_batch_release TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_batch_release TO readonly_user;
  END IF;
END $$;

-- QC retention sample (Story 8.4, FR-Q-08, AC 4 and AC 5). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.retention_sample_logged (the log) and
-- qc.retention_sample_disposed (the one status transition); mutation happens exclusively through
-- persistEvent inside the SAME transaction as the domain_events insert.
--
-- Story 8.4 Binding Scope Decision 6: a retention sample is required for EVERY lot released via
-- accept or conditional_release, not only BIS-covered products. AC 4's gate lives in the release
-- applier, which refuses RETENTION_SAMPLE_REQUIRED unless a row exists here for the lot.
-- uq_qc_retention_sample_lot is the one-per-lot backstop (a 23505 resolves to 409
-- RETENTION_SAMPLE_EXISTS in the store's constraint chain).
--
-- Binding Scope Decision 8: location_id reuses the existing location vocabulary (the same UUID
-- space qc_inspection_task.site_id and stock_balance.location_id already use). A retention sample
-- is evidentiary, not consumable inventory - it is NOT a stock_balance or lot_trace entry, so
-- nothing here moves real stock.
--
-- AC 5 is a RECORDED transition only: the alert sweep (src/notify/retention-expiry.ts) flips
-- 'retained' -> 'disposal_pending' and emits one qc.retention_sample_disposed event per row.
-- Physical disposal is Phase 2 / Epic 16, so 'disposed' plus a non-null disposed_at is schema'd
-- here as a deliberate forward reference with NO code path reaching it in this story - the same
-- kind of documented hand-off as Binding Scope Decision 2's BIS-licence stub, not an oversight.
-- chk_qc_retention_sample_disposal_pairing states the FULL biconditional in both directions:
-- a row is 'retained' if and only if it carries NO disposal_event_id, and it carries a disposed_at
-- if and only if it is 'disposed'. So the reachable transition in this story ('retained' ->
-- 'disposal_pending', stamping the recorded qc.retention_sample_disposed event id) leaves
-- disposed_at null, and only the Phase 2 physical disposal stamps it.
--
-- app_user holds INSERT, SELECT and UPDATE (the one status transition) and never DELETE.

CREATE TABLE IF NOT EXISTS qc_retention_sample (
  retention_sample_id  UUID PRIMARY KEY,
  lot_id               UUID NOT NULL,
  task_id              UUID NOT NULL,
  quantity             NUMERIC(18, 6) NOT NULL,
  uom                  TEXT NOT NULL,
  location_id          UUID NOT NULL,
  status               TEXT NOT NULL,
  logged_by            UUID NOT NULL,
  logged_at            TIMESTAMPTZ NOT NULL,
  expires_on           DATE NOT NULL,
  disposal_event_id    UUID,
  disposed_at          TIMESTAMPTZ,
  source_event_id      UUID NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_qc_retention_sample_lot UNIQUE (lot_id),
  CONSTRAINT chk_qc_retention_sample_quantity CHECK (quantity > 0),
  CONSTRAINT chk_qc_retention_sample_uom CHECK (btrim(uom) <> '' AND char_length(uom) <= 32),
  CONSTRAINT chk_qc_retention_sample_status CHECK (status IN ('retained', 'disposal_pending', 'disposed')),
  CONSTRAINT chk_qc_retention_sample_disposal_pairing CHECK (
    (status = 'retained') = (disposal_event_id IS NULL)
    AND (status = 'disposed') = (disposed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_qc_retention_sample_task ON qc_retention_sample (task_id);
CREATE INDEX IF NOT EXISTS idx_qc_retention_sample_expiry ON qc_retention_sample (status, expires_on);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_retention_sample_lot'
      AND conrelid = 'qc_retention_sample'::regclass
  ) THEN
    ALTER TABLE qc_retention_sample ADD CONSTRAINT uq_qc_retention_sample_lot UNIQUE (lot_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_retention_sample_quantity'
      AND conrelid = 'qc_retention_sample'::regclass
  ) THEN
    ALTER TABLE qc_retention_sample
      ADD CONSTRAINT chk_qc_retention_sample_quantity CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_retention_sample_uom'
      AND conrelid = 'qc_retention_sample'::regclass
  ) THEN
    ALTER TABLE qc_retention_sample
      ADD CONSTRAINT chk_qc_retention_sample_uom CHECK (btrim(uom) <> '' AND char_length(uom) <= 32);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_retention_sample_status'
      AND conrelid = 'qc_retention_sample'::regclass
  ) THEN
    ALTER TABLE qc_retention_sample
      ADD CONSTRAINT chk_qc_retention_sample_status CHECK (status IN ('retained', 'disposal_pending', 'disposed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_retention_sample_disposal_pairing'
      AND conrelid = 'qc_retention_sample'::regclass
  ) THEN
    ALTER TABLE qc_retention_sample
      ADD CONSTRAINT chk_qc_retention_sample_disposal_pairing CHECK (
        (status = 'retained') = (disposal_event_id IS NULL)
        AND (status = 'disposed') = (disposed_at IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON qc_retention_sample TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_retention_sample TO readonly_user;
  END IF;
END $$;

-- Story 6.3: production completion projection (FR-MO-07/09). Mirror of read/projections/production_completion.sql.
-- Production completion read model (Story 6.3, FR-MO-07/09, AD-5). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying production_order.completion_posted events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert.
--
-- The grain is ONE ROW PER OUTPUT LOT, not one row per completion event: a single completion posts
-- the primary output plus every co-product and by-product line of the pinned released revision, and
-- each of those is its own lot with its own Story 8.1 inspection task (AC 3). completion_id is also
-- the source_completion_id handed to the QC gate, so the gate's unique-source guard and this table's
-- primary key are the same identity.
--
-- The table is APPEND-ONLY (app_user holds INSERT/SELECT only, the production_wip_ledger
-- precedent). A completion is a posted fact; a correction is a new event, never an UPDATE.
--
-- output_class 'primary' rows carry a NULL bom_line_id (the primary output is the order's own
-- output_item_id, not a BOM line), so the grain UNIQUE uses NULLS NOT DISTINCT - without it two
-- primary rows for the same event would both be admitted.

CREATE TABLE IF NOT EXISTS production_completion (
  completion_id             UUID PRIMARY KEY,
  production_order_id       UUID NOT NULL,
  output_class              TEXT NOT NULL,
  bom_line_id               UUID,
  output_item_id            UUID NOT NULL,
  output_sku                TEXT NOT NULL,
  lot_id                    UUID NOT NULL,
  lot_number                TEXT NOT NULL,
  quantity                  NUMERIC(18,6) NOT NULL,
  uom                       TEXT NOT NULL,
  qc_task_id                UUID NOT NULL,
  plant_location_id         UUID NOT NULL,
  business_date             DATE NOT NULL,
  over_completion_approved  BOOLEAN NOT NULL DEFAULT false,
  approved_by               UUID,
  completed_by              UUID NOT NULL,
  completed_at              TIMESTAMPTZ NOT NULL,
  source_event_id           UUID NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_production_completion_output_class CHECK (output_class IN ('primary','co_product','by_product')),
  CONSTRAINT chk_production_completion_quantity_positive CHECK (quantity > 0),
  CONSTRAINT chk_production_completion_line_pairing CHECK ((output_class = 'primary' AND bom_line_id IS NULL) OR (output_class IN ('co_product','by_product') AND bom_line_id IS NOT NULL)),
  CONSTRAINT chk_production_completion_approval_pairing CHECK ((over_completion_approved = true AND approved_by IS NOT NULL) OR (over_completion_approved = false AND approved_by IS NULL)),
  CONSTRAINT uq_production_completion_lot UNIQUE (lot_id),
  CONSTRAINT uq_production_completion_grain UNIQUE NULLS NOT DISTINCT (production_order_id, source_event_id, output_class, bom_line_id)
);

CREATE INDEX IF NOT EXISTS idx_production_completion_order ON production_completion (production_order_id);
CREATE INDEX IF NOT EXISTS idx_production_completion_task ON production_completion (qc_task_id);
CREATE INDEX IF NOT EXISTS idx_production_completion_item ON production_completion (output_item_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_completion_output_class'
      AND conrelid = 'production_completion'::regclass
  ) THEN
    ALTER TABLE production_completion
      ADD CONSTRAINT chk_production_completion_output_class CHECK (output_class IN ('primary','co_product','by_product'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_completion_quantity_positive'
      AND conrelid = 'production_completion'::regclass
  ) THEN
    ALTER TABLE production_completion
      ADD CONSTRAINT chk_production_completion_quantity_positive CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_completion_line_pairing'
      AND conrelid = 'production_completion'::regclass
  ) THEN
    ALTER TABLE production_completion
      ADD CONSTRAINT chk_production_completion_line_pairing CHECK ((output_class = 'primary' AND bom_line_id IS NULL) OR (output_class IN ('co_product','by_product') AND bom_line_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_completion_approval_pairing'
      AND conrelid = 'production_completion'::regclass
  ) THEN
    ALTER TABLE production_completion
      ADD CONSTRAINT chk_production_completion_approval_pairing CHECK ((over_completion_approved = true AND approved_by IS NOT NULL) OR (over_completion_approved = false AND approved_by IS NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_production_completion_lot'
      AND conrelid = 'production_completion'::regclass
  ) THEN
    ALTER TABLE production_completion
      ADD CONSTRAINT uq_production_completion_lot UNIQUE (lot_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_production_completion_grain'
      AND conrelid = 'production_completion'::regclass
  ) THEN
    ALTER TABLE production_completion
      ADD CONSTRAINT uq_production_completion_grain UNIQUE NULLS NOT DISTINCT (production_order_id, source_event_id, output_class, bom_line_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON production_completion TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON production_completion TO readonly_user;
  END IF;
END $$;

-- Story 6.3: production scrap declaration projection (FR-MO-08). Mirror of read/projections/production_scrap_declaration.sql.
-- Production scrap declaration read model (Story 6.3, FR-MO-08, AD-5). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying production_order.scrap_declared events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert.
--
-- A scrap declaration relieves WIP and moves NO stock (Story 6.3 Binding Decision 10): it creates
-- no lot, posts no stock row and never drives a balance negative. The physical scrap intake
-- (FR-SC) is Phase 2 (Epic 16); this row is the AD-10 source document for it, and it is also the
-- expected-versus-actual reconciliation input Story 6.4 (FR-B-08) reads.
--
-- The table is APPEND-ONLY (app_user holds INSERT/SELECT only, the production_wip_ledger
-- precedent). relieved_value is the WIP value actually drained by this declaration, settled in SQL
-- NUMERIC at the source postings' issued cost, never at today's average.
--
-- Code review 2026-08-31: uq_production_scrap_declaration_event is the replay and rebuild guard.
-- scrap_id is server-minted per call, so the primary key alone cannot make a second application of
-- the SAME domain event collide - which left the banner's "rebuildable by replaying" claim false
-- for this table while its sibling production_completion was already defended by
-- uq_production_completion_grain. One scrap_declared event yields exactly one declaration row, so
-- source_event_id IS the grain.

CREATE TABLE IF NOT EXISTS production_scrap_declaration (
  scrap_id             UUID PRIMARY KEY,
  production_order_id  UUID NOT NULL,
  scrap_quantity       NUMERIC(18,6) NOT NULL,
  uom                  TEXT NOT NULL,
  reason_code          TEXT NOT NULL,
  relieved_value       NUMERIC(14,3) NOT NULL,
  business_date        DATE NOT NULL,
  declared_by          UUID NOT NULL,
  declared_at          TIMESTAMPTZ NOT NULL,
  source_event_id      UUID NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_production_scrap_quantity_positive CHECK (scrap_quantity > 0),
  CONSTRAINT chk_production_scrap_relieved_non_negative CHECK (relieved_value >= 0),
  CONSTRAINT chk_production_scrap_reason_code_present CHECK (btrim(reason_code) <> ''),
  CONSTRAINT uq_production_scrap_declaration_event UNIQUE (source_event_id)
);

CREATE INDEX IF NOT EXISTS idx_production_scrap_declaration_order ON production_scrap_declaration (production_order_id);
CREATE INDEX IF NOT EXISTS idx_production_scrap_declaration_business_date ON production_scrap_declaration (business_date);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_scrap_quantity_positive'
      AND conrelid = 'production_scrap_declaration'::regclass
  ) THEN
    ALTER TABLE production_scrap_declaration
      ADD CONSTRAINT chk_production_scrap_quantity_positive CHECK (scrap_quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_scrap_relieved_non_negative'
      AND conrelid = 'production_scrap_declaration'::regclass
  ) THEN
    ALTER TABLE production_scrap_declaration
      ADD CONSTRAINT chk_production_scrap_relieved_non_negative CHECK (relieved_value >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_scrap_reason_code_present'
      AND conrelid = 'production_scrap_declaration'::regclass
  ) THEN
    ALTER TABLE production_scrap_declaration
      ADD CONSTRAINT chk_production_scrap_reason_code_present CHECK (btrim(reason_code) <> '');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_production_scrap_declaration_event'
      AND conrelid = 'production_scrap_declaration'::regclass
  ) THEN
    ALTER TABLE production_scrap_declaration
      ADD CONSTRAINT uq_production_scrap_declaration_event UNIQUE (source_event_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON production_scrap_declaration TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON production_scrap_declaration TO readonly_user;
  END IF;
END $$;

-- QC governed quality hold (Story 8.5, FR-Q-09, AC 1 and AC 2). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.hold_placed and qc.hold_released domain
-- events; mutation happens exclusively through persistEvent inside the SAME transaction as the
-- domain_events insert.
--
-- Story 8.5 Binding Scope Decision 1: this table is the governed RECORD of the hold decision, not
-- a second enforcement axis. The applier that inserts a row here sets
-- lot_master.quality_hold_status = 'held' inside the SAME transaction; every enforcement site
-- (assertQcGateAllows, dispatch, cross-dock, lot-serial-validation, receiving, the Story 8.4
-- release path) keeps reading that one flag and is untouched by this story.
--
-- uq_qc_quality_hold_open is the one-OPEN-hold-per-lot backstop (a 23505 resolves to 409
-- HOLD_EXISTS in the store's constraint chain). Released holds are history and do not count
-- against the grain, hence the partial predicate - the UNIQUE keyword plus the WHERE clause ARE
-- the semantics, exactly like uq_production_order_source_rework_event.
--
-- chk_qc_quality_hold_release_pairing is the FULL biconditional (the Story 8.4 one-directional
-- CHECK lesson): status = 'released' exactly when all four release columns are non-null, and
-- status = 'open' exactly when all four are null. There is no reopen; release is terminal.
--
-- app_user holds INSERT, SELECT and UPDATE (the one open -> released transition) and never DELETE.

CREATE TABLE IF NOT EXISTS qc_quality_hold (
  hold_id          UUID PRIMARY KEY,
  lot_id           UUID NOT NULL,
  lot_number       TEXT NOT NULL,
  sku              TEXT NOT NULL,
  site_id          UUID NOT NULL,
  hold_reason      TEXT NOT NULL,
  defect_code      TEXT,
  status           TEXT NOT NULL DEFAULT 'open',
  placed_by        UUID NOT NULL,
  placed_at        TIMESTAMPTZ NOT NULL,
  source_event_id  UUID NOT NULL,
  released_by      UUID,
  released_at      TIMESTAMPTZ,
  release_reason   TEXT,
  release_event_id UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_qc_quality_hold_status CHECK (status IN ('open', 'released')),
  CONSTRAINT chk_qc_quality_hold_reason CHECK (btrim(hold_reason) <> '' AND char_length(hold_reason) <= 2000),
  CONSTRAINT chk_qc_quality_hold_release_reason CHECK (
    release_reason IS NULL OR (btrim(release_reason) <> '' AND char_length(release_reason) <= 2000)
  ),
  CONSTRAINT chk_qc_quality_hold_release_pairing CHECK (
    (status = 'released') = (released_by IS NOT NULL)
    AND (released_by IS NOT NULL) = (released_at IS NOT NULL)
    AND (released_at IS NOT NULL) = (release_reason IS NOT NULL)
    AND (release_reason IS NOT NULL) = (release_event_id IS NOT NULL)
  )
);

-- One OPEN hold per lot; released holds are retained history and never block a new hold.
CREATE UNIQUE INDEX IF NOT EXISTS uq_qc_quality_hold_open ON qc_quality_hold (lot_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_qc_quality_hold_site ON qc_quality_hold (site_id, placed_at, hold_id);
CREATE INDEX IF NOT EXISTS idx_qc_quality_hold_lot ON qc_quality_hold (lot_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_quality_hold_status'
      AND conrelid = 'qc_quality_hold'::regclass
  ) THEN
    ALTER TABLE qc_quality_hold
      ADD CONSTRAINT chk_qc_quality_hold_status CHECK (status IN ('open', 'released'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_quality_hold_reason'
      AND conrelid = 'qc_quality_hold'::regclass
  ) THEN
    ALTER TABLE qc_quality_hold
      ADD CONSTRAINT chk_qc_quality_hold_reason CHECK (btrim(hold_reason) <> '' AND char_length(hold_reason) <= 2000);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_quality_hold_release_reason'
      AND conrelid = 'qc_quality_hold'::regclass
  ) THEN
    ALTER TABLE qc_quality_hold
      ADD CONSTRAINT chk_qc_quality_hold_release_reason CHECK (
        release_reason IS NULL OR (btrim(release_reason) <> '' AND char_length(release_reason) <= 2000)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_quality_hold_release_pairing'
      AND conrelid = 'qc_quality_hold'::regclass
  ) THEN
    ALTER TABLE qc_quality_hold
      ADD CONSTRAINT chk_qc_quality_hold_release_pairing CHECK (
        (status = 'released') = (released_by IS NOT NULL)
        AND (released_by IS NOT NULL) = (released_at IS NOT NULL)
        AND (released_at IS NOT NULL) = (release_reason IS NOT NULL)
        AND (release_reason IS NOT NULL) = (release_event_id IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON qc_quality_hold TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_quality_hold TO readonly_user;
  END IF;
END $$;

-- QC corrective and preventive action record (Story 8.5, FR-Q-10, AC 3 and AC 4). This file is
-- the CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.capa_opened and qc.capa_closed domain
-- events; mutation happens exclusively through persistEvent inside the SAME transaction as the
-- domain_events insert.
--
-- Story 8.5 Binding Scope Decision 11: a CAPA is a first-class record with its own lifecycle
-- (open -> closed), owner, due date and closure evidence - AC 3's "linked to a CAPA record" is a
-- validated reference to a row here, never a free-text id. capa_number is minted server-side from
-- qc_capa_number_seq (the production_order_number_seq pattern); uq_qc_capa_number is the backstop
-- (a 23505 resolves to 409 CAPA_EXISTS in the store's constraint chain).
--
-- chk_qc_capa_closure_pairing is the FULL biconditional (the Story 8.4 one-directional CHECK
-- lesson): status = 'closed' exactly when all four closure columns are non-null, and
-- status = 'open' exactly when all four are null. There is no reopen.
--
-- app_user holds INSERT, SELECT and UPDATE (the one open -> closed transition) and never DELETE.

CREATE TABLE IF NOT EXISTS qc_capa (
  capa_id           UUID PRIMARY KEY,
  capa_number       TEXT NOT NULL,
  sku               TEXT NOT NULL,
  defect_code       TEXT NOT NULL,
  title             TEXT NOT NULL,
  root_cause        TEXT,
  corrective_action TEXT,
  preventive_action TEXT,
  owner_user_id     UUID NOT NULL,
  due_on            DATE NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open',
  opened_by         UUID NOT NULL,
  opened_at         TIMESTAMPTZ NOT NULL,
  closed_by         UUID,
  closed_at         TIMESTAMPTZ,
  closure_evidence  TEXT,
  source_event_id   UUID NOT NULL,
  close_event_id    UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_qc_capa_number UNIQUE (capa_number),
  CONSTRAINT chk_qc_capa_status CHECK (status IN ('open', 'closed')),
  CONSTRAINT chk_qc_capa_title CHECK (btrim(title) <> '' AND char_length(title) <= 2000),
  CONSTRAINT chk_qc_capa_closure_evidence CHECK (
    closure_evidence IS NULL OR (btrim(closure_evidence) <> '' AND char_length(closure_evidence) <= 2000)
  ),
  CONSTRAINT chk_qc_capa_closure_pairing CHECK (
    (status = 'closed') = (closed_by IS NOT NULL)
    AND (closed_by IS NOT NULL) = (closed_at IS NOT NULL)
    AND (closed_at IS NOT NULL) = (closure_evidence IS NOT NULL)
    AND (closure_evidence IS NOT NULL) = (close_event_id IS NOT NULL)
  )
);

CREATE SEQUENCE IF NOT EXISTS qc_capa_number_seq;

CREATE INDEX IF NOT EXISTS idx_qc_capa_sku_defect ON qc_capa (sku, defect_code, status);
CREATE INDEX IF NOT EXISTS idx_qc_capa_status ON qc_capa (status, due_on, capa_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_capa_number'
      AND conrelid = 'qc_capa'::regclass
  ) THEN
    ALTER TABLE qc_capa ADD CONSTRAINT uq_qc_capa_number UNIQUE (capa_number);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_capa_status'
      AND conrelid = 'qc_capa'::regclass
  ) THEN
    ALTER TABLE qc_capa ADD CONSTRAINT chk_qc_capa_status CHECK (status IN ('open', 'closed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_capa_title'
      AND conrelid = 'qc_capa'::regclass
  ) THEN
    ALTER TABLE qc_capa
      ADD CONSTRAINT chk_qc_capa_title CHECK (btrim(title) <> '' AND char_length(title) <= 2000);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_capa_closure_evidence'
      AND conrelid = 'qc_capa'::regclass
  ) THEN
    ALTER TABLE qc_capa
      ADD CONSTRAINT chk_qc_capa_closure_evidence CHECK (
        closure_evidence IS NULL OR (btrim(closure_evidence) <> '' AND char_length(closure_evidence) <= 2000)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_capa_closure_pairing'
      AND conrelid = 'qc_capa'::regclass
  ) THEN
    ALTER TABLE qc_capa
      ADD CONSTRAINT chk_qc_capa_closure_pairing CHECK (
        (status = 'closed') = (closed_by IS NOT NULL)
        AND (closed_by IS NOT NULL) = (closed_at IS NOT NULL)
        AND (closed_at IS NOT NULL) = (closure_evidence IS NOT NULL)
        AND (closure_evidence IS NOT NULL) = (close_event_id IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON qc_capa TO app_user;
    GRANT USAGE ON qc_capa_number_seq TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_capa TO readonly_user;
  END IF;
END $$;

-- BIS licence register - minimal enforcement contract (Story 8.6, FR-Q-11, AC 1 and AC 2). This
-- file is the CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Story 8.6 Binding Scope Decision 1: this table carries ONLY the columns the statutory release
-- block reads. Story 8.7 adds the CRUD routes, approval workflow, edit-logging, expiry alerts and
-- any additional columns. Story 8.6 ships NO write routes and NO event types for this table;
-- integration fixtures seed rows through the admin pool. Story 8.7 grants app_user
-- INSERT/UPDATE (see the grants at the foot of this file); the Story 8.6 read-only posture no
-- longer holds.
--
-- Story 8.7 Binding Scope Decision 2: adds `status` ('active'/'expired') as the AC 2 "marked
-- invalid" artifact. Story 8.7 code review: status is an ALERTING ARTIFACT, never a release gate.
-- The valid_from/valid_to window is the only truth the release path reads, because an unconditional
-- status flip (a mis-dated sweep tick, a UTC-vs-IST boundary) would otherwise block every release
-- for a licence whose window is still valid, with no path back except a manual PATCH. Fail-closed
-- is right; unrecoverable fail-closed is not. The column is still written by the sweep and is what
-- the ledger and the notifications are derived from. The scope uniqueness index is replaced with
-- a case-folded, trimmed form (lower(btrim(licence_number))) closing the case-folding deferral;
-- write paths trim licence_number, preserving original case in the stored value. app_user gains
-- INSERT/UPDATE because Story 8.7 routes write through the app pool inside persistEvent
-- transactions.
--
-- Binding Scope Decision 5: a row covers a release when sku matches, the site scope admits the
-- task's site, and valid_from <= asOf <= valid_to (asOf is the IST calendar date derived from the
-- server-stamped release time). licence_type distinguishes a CM/L number from an R-number under
-- the BIS Conformity Assessment Regulations 2018.
--
-- Binding Scope Decision 6: site_id NULL means the licence covers ALL sites; the resolver prefers
-- a site-specific row over a global row when both are valid. The uniqueness grain
-- (licence_number, sku, site scope) treats all-NULL site rows as equal, which a plain UNIQUE
-- constraint would not (NULLs compare distinct), so it is a unique expression index over
-- COALESCE(site_id, zero-uuid).

CREATE TABLE IF NOT EXISTS compliance_bis_licence (
  licence_id     UUID PRIMARY KEY,
  licence_number TEXT NOT NULL,
  licence_type   TEXT NOT NULL,
  sku            TEXT NOT NULL,
  site_id        UUID,
  valid_from     DATE NOT NULL,
  valid_to       DATE NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_compliance_bis_licence_number CHECK (btrim(licence_number) <> ''),
  CONSTRAINT chk_compliance_bis_licence_type CHECK (licence_type IN ('cml', 'r_number')),
  CONSTRAINT chk_compliance_bis_licence_window CHECK (valid_to >= valid_from)
);

-- ADD COLUMN IF NOT EXISTS rather than an information_schema probe: the probe filtered on
-- table_name alone, so a same-named table in ANY other schema (a bak, tenant or restore-staging
-- schema) satisfied it and the column was silently never added here.
ALTER TABLE compliance_bis_licence ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

-- The column defaults to 'active', which is wrong for any pre-existing row whose window has
-- already closed (every Story 8.6 fixture row with a past valid_to). Backfill once, idempotently.
UPDATE compliance_bis_licence SET status = 'expired'
 WHERE status = 'active' AND valid_to < CURRENT_DATE;

-- The scope index moved to a case-folded, trimmed body. CREATE INDEX IF NOT EXISTS matches on NAME
-- only, so an existing database would silently keep the old case-sensitive body - hence the drop.
-- It is guarded on the body actually differing so a routine re-migrate does not rebuild a large
-- unique index under ACCESS EXCLUSIVE, and does not leave a window with no uniqueness at all.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'uq_compliance_bis_licence_scope'
      AND indexdef NOT LIKE '%lower(btrim%'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM compliance_bis_licence
      GROUP BY lower(btrim(licence_number)), sku,
               COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid)
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'compliance_bis_licence holds rows that differ only by licence_number case or whitespace within one (sku, site) scope; dedupe them before migrating (SELECT lower(btrim(licence_number)), sku, site_id, count(*) FROM compliance_bis_licence GROUP BY 1,2,3 HAVING count(*) > 1)';
    END IF;
    DROP INDEX uq_compliance_bis_licence_scope;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_bis_licence_scope
  ON compliance_bis_licence (
    lower(btrim(licence_number)),
    sku,
    COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS idx_compliance_bis_licence_sku ON compliance_bis_licence (sku, valid_to);

-- The expiry sweep reads WHERE status = 'active' AND valid_to <= today + horizon ORDER BY valid_to;
-- without this partial index every tick seq-scans and sorts the whole register.
CREATE INDEX IF NOT EXISTS idx_compliance_bis_licence_expiry
  ON compliance_bis_licence (valid_to) WHERE status = 'active';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_compliance_bis_licence_number'
      AND conrelid = 'compliance_bis_licence'::regclass
  ) THEN
    ALTER TABLE compliance_bis_licence
      ADD CONSTRAINT chk_compliance_bis_licence_number CHECK (btrim(licence_number) <> '');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_compliance_bis_licence_type'
      AND conrelid = 'compliance_bis_licence'::regclass
  ) THEN
    ALTER TABLE compliance_bis_licence
      ADD CONSTRAINT chk_compliance_bis_licence_type CHECK (licence_type IN ('cml', 'r_number'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_compliance_bis_licence_window'
      AND conrelid = 'compliance_bis_licence'::regclass
  ) THEN
    ALTER TABLE compliance_bis_licence
      ADD CONSTRAINT chk_compliance_bis_licence_window CHECK (valid_to >= valid_from);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_compliance_bis_licence_status'
      AND conrelid = 'compliance_bis_licence'::regclass
  ) THEN
    ALTER TABLE compliance_bis_licence
      ADD CONSTRAINT chk_compliance_bis_licence_status CHECK (status IN ('active', 'expired'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE ON compliance_bis_licence TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON compliance_bis_licence TO readonly_user;
  END IF;
END $$;

-- Legal Metrology label master - minimal enforcement contract (Story 8.6, FR-Q-14, AC 3). This
-- file is the CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Story 8.6 Binding Scope Decision 1: this table carries ONLY the columns the statutory release
-- block reads (the LABEL_VERSION_MISSING check passes when an 'approved' row exists for the
-- task's sku). Story 8.7 adds the version-control CRUD, approval workflow (DOA) and edit-logging.
-- Story 8.6 ships NO write routes and NO event types for this table; integration fixtures seed
-- rows through the admin pool, so app_user holds SELECT only.
--
-- Binding Scope Decision 8: "current approved label version" is a partial-unique row -
-- uq_label_master_current enforces the single-current-version invariant structurally from day
-- one. chk_label_master_approval_pairing is the FULL biconditional (the Story 8.4 one-directional
-- CHECK lesson): a row is approved-or-superseded exactly when it carries approval metadata, and
-- approved_by pairs with approved_at in both directions.
--
-- Story 8.7 Binding Scope Decision 2: adds uq_label_master_version (one row per (sku,
-- label_version)), case-folded and whitespace-trimmed to match uq_compliance_bis_licence_scope -
-- 'V1' and 'v1' are the same version of a label, not two. It also adds created_by (the drafting
-- actor), which the applier reads to enforce drafter-is-not-approver segregation of duties. The draft -> approved -> superseded transition is enforced in the applier, NOT
-- as a CHECK constraint, because PostgreSQL CHECK constraints cannot see OLD row values; the
-- transition is proven by integration tests instead. app_user gains INSERT/UPDATE because Story
-- 8.7 routes write through the app pool inside persistEvent transactions.

CREATE TABLE IF NOT EXISTS label_master (
  label_id      UUID PRIMARY KEY,
  sku           TEXT NOT NULL,
  label_version TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',
  created_by    UUID,
  approved_by   UUID,
  approved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_label_master_sku CHECK (btrim(sku) <> ''),
  CONSTRAINT chk_label_master_version CHECK (btrim(label_version) <> ''),
  CONSTRAINT chk_label_master_status CHECK (status IN ('draft', 'approved', 'superseded')),
  CONSTRAINT chk_label_master_approval_pairing CHECK (
    (status = 'approved' OR status = 'superseded') = (approved_at IS NOT NULL)
    AND (approved_at IS NOT NULL) = (approved_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_label_master_current
  ON label_master (sku) WHERE status = 'approved';

-- Recreated rather than IF NOT EXISTS alone: an 8.7 database that already carries the
-- case-sensitive (sku, label_version) form would silently keep it, since CREATE INDEX IF NOT
-- EXISTS matches on name, not on body. Guarded on the body actually differing so a routine
-- re-migrate does not rebuild the index under ACCESS EXCLUSIVE, and so a database holding
-- case-colliding versions fails with rows named rather than a bare 23505.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'uq_label_master_version'
      AND indexdef NOT LIKE '%lower(btrim%'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM label_master
      GROUP BY sku, lower(btrim(label_version))
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'label_master holds versions differing only by case or whitespace within one sku; dedupe them before migrating (SELECT sku, lower(btrim(label_version)), count(*) FROM label_master GROUP BY 1,2 HAVING count(*) > 1)';
    END IF;
    DROP INDEX uq_label_master_version;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_label_master_version
  ON label_master (sku, lower(btrim(label_version)));

CREATE INDEX IF NOT EXISTS idx_label_master_sku ON label_master (sku, status);

ALTER TABLE label_master ADD COLUMN IF NOT EXISTS created_by UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_label_master_sku'
      AND conrelid = 'label_master'::regclass
  ) THEN
    ALTER TABLE label_master ADD CONSTRAINT chk_label_master_sku CHECK (btrim(sku) <> '');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_label_master_version'
      AND conrelid = 'label_master'::regclass
  ) THEN
    ALTER TABLE label_master
      ADD CONSTRAINT chk_label_master_version CHECK (btrim(label_version) <> '');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_label_master_status'
      AND conrelid = 'label_master'::regclass
  ) THEN
    ALTER TABLE label_master
      ADD CONSTRAINT chk_label_master_status CHECK (status IN ('draft', 'approved', 'superseded'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_label_master_approval_pairing'
      AND conrelid = 'label_master'::regclass
  ) THEN
    ALTER TABLE label_master
      ADD CONSTRAINT chk_label_master_approval_pairing CHECK (
        (status = 'approved' OR status = 'superseded') = (approved_at IS NOT NULL)
        AND (approved_at IS NOT NULL) = (approved_by IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE ON label_master TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON label_master TO readonly_user;
  END IF;
END $$;

-- BIS licence expiry alert ledger (Story 8.7, FR-Q-11, AC 2). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads as app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql
-- duplicates this content for first-boot container init - change both files together. Every
-- statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a
-- live database safely.
--
-- One row per (licence_id, valid_to, stage_days) is the idempotency ledger for the 90/60/30-day
-- expiry sweep (the asset_coverage_alert grain from Story 7.7). stage_days = 0 records the expiry
-- flip.
--
-- Story 8.7 code review: valid_to is IN THE KEY deliberately. The ledger is APPEND-ONLY - an alert
-- that fired is a posted regulatory fact and is never erased, exactly as production_consumption
-- _variance is append-only for a posted measurement. Renewal therefore re-arms the alerts by
-- construction: an in-place window update changes valid_to, the new window has no ledger rows, and
-- the 90/60/30 stages fire again for it while the history of the old window survives. An earlier
-- revision keyed on (licence_id, stage_days) alone and DELETEd the rows on renewal; that was a
-- workaround for the wrong key, and app_user held DELETE on compliance data to support it. Both
-- are gone.
--
-- No FK to compliance_bis_licence: Binding Scope Decision 8 forbids cross-projection foreign keys,
-- so referential integrity is the applier's job (it loads the licence FOR UPDATE before writing a
-- ledger row). Unlike a derived, rebuildable projection this table is NOT rebuildable - it is the
-- record of which notifications were actually raised - so it is never truncated on a replay.

CREATE TABLE IF NOT EXISTS compliance_bis_licence_alert (
  licence_id  UUID NOT NULL,
  valid_to    DATE NOT NULL,
  stage_days  INTEGER NOT NULL,
  flagged_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_compliance_bis_licence_alert_stage CHECK (stage_days IN (90, 60, 30, 0)),
  CONSTRAINT pk_compliance_bis_licence_alert PRIMARY KEY (licence_id, valid_to, stage_days)
);

-- Upgrade path for a database carrying the pre-review (licence_id, stage_days) form: add the
-- window column, backfill it from the register, and swap the UNIQUE constraint for the primary key.
ALTER TABLE compliance_bis_licence_alert ADD COLUMN IF NOT EXISTS valid_to DATE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM compliance_bis_licence_alert WHERE valid_to IS NULL
  ) THEN
    UPDATE compliance_bis_licence_alert a
       SET valid_to = l.valid_to
      FROM compliance_bis_licence l
     WHERE a.licence_id = l.licence_id AND a.valid_to IS NULL;
    -- A row whose licence no longer exists cannot be attributed to a window. It is left NULL on
    -- purpose: the NOT NULL promotion below is skipped rather than deleting audit history, so the
    -- operator sees the un-backfilled rows instead of losing them.
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'compliance_bis_licence_alert'
      AND column_name = 'valid_to'
      AND is_nullable = 'YES'
  ) AND NOT EXISTS (
    SELECT 1 FROM compliance_bis_licence_alert WHERE valid_to IS NULL
  ) THEN
    ALTER TABLE compliance_bis_licence_alert ALTER COLUMN valid_to SET NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_compliance_bis_licence_alert'
      AND conrelid = 'compliance_bis_licence_alert'::regclass
  ) THEN
    ALTER TABLE compliance_bis_licence_alert DROP CONSTRAINT uq_compliance_bis_licence_alert;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pk_compliance_bis_licence_alert'
      AND conrelid = 'compliance_bis_licence_alert'::regclass
  ) THEN
    ALTER TABLE compliance_bis_licence_alert
      ADD CONSTRAINT pk_compliance_bis_licence_alert PRIMARY KEY (licence_id, valid_to, stage_days);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_compliance_bis_licence_alert_stage'
      AND conrelid = 'compliance_bis_licence_alert'::regclass
  ) THEN
    ALTER TABLE compliance_bis_licence_alert
      ADD CONSTRAINT chk_compliance_bis_licence_alert_stage CHECK (stage_days IN (90, 60, 30, 0));
  END IF;
END $$;

-- No separate licence_id index: the primary key leads with licence_id and serves every lookup this
-- table performs, so a second index would be pure write amplification on the sweep insert path.

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    -- INSERT and SELECT only. The ledger is append-only: no UPDATE, and deliberately no DELETE.
    GRANT SELECT, INSERT ON compliance_bis_licence_alert TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON compliance_bis_licence_alert TO readonly_user;
  END IF;
END $$;

-- Story 6.4: consumption variance read model (FR-B-08). Mirror of read/projections/production_consumption_variance.sql.
-- Consumption variance read model (Story 6.4, FR-B-08, AD-5). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying the production_order.state_changed event
-- that closed the order; mutation happens exclusively through persistEvent, which applies this
-- projection inside the SAME transaction as the domain_events insert.
--
-- The grain is ONE ROW PER (production_order_id, bom_line_id): the closure gate computes the whole
-- report in one pass, so a second row for a line would mean the report ran twice - which the
-- lifecycle forbids, because completed -> closed fires exactly once per order.
--
-- The table is APPEND-ONLY (app_user holds INSERT/SELECT only, the production_completion
-- precedent). A variance line is a posted measurement at the instant of closure; a correction is a
-- new closure of a new order, never an UPDATE of this row.
--
-- expected_quantity carries the BOM scrap-percent expectation (base_quantity_per inflated by
-- bom_scrap_percent); expected_base_quantity is the same requirement WITHOUT any scrap allowance.
-- implied_scrap_percent = (actual_quantity / expected_base_quantity - 1) * 100 is therefore the
-- scrap-percent recalibration signal FR-B-08 hands to the BOM module: the scrap percent this run
-- actually exhibited, against the one the BOM declared. Both are null when the basis is zero
-- (an order closed with no primary output has no per-unit expectation to divide by).

CREATE TABLE IF NOT EXISTS production_consumption_variance (
  variance_id               UUID PRIMARY KEY,
  production_order_id       UUID NOT NULL,
  bom_line_id               UUID NOT NULL,
  component_item_id         UUID NOT NULL,
  component_sku             TEXT NOT NULL,
  supply_method             TEXT NOT NULL,
  basis_quantity            NUMERIC(18,6) NOT NULL,
  expected_quantity         NUMERIC(18,6) NOT NULL,
  expected_base_quantity    NUMERIC(18,6) NOT NULL,
  actual_quantity           NUMERIC(18,6) NOT NULL,
  variance_quantity         NUMERIC(18,6) NOT NULL,
  variance_percent          NUMERIC(12,4),
  bom_scrap_percent         NUMERIC(7,4),
  implied_scrap_percent     NUMERIC(12,4),
  tolerance_percent         NUMERIC(7,4) NOT NULL,
  tolerance_breached        BOOLEAN NOT NULL,
  revision_id               UUID NOT NULL,
  source_event_id           UUID NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_production_consumption_variance_supply_method CHECK (supply_method IN ('directed_issue','backflush')),
  CONSTRAINT chk_production_consumption_variance_quantities_non_negative CHECK (basis_quantity >= 0 AND expected_quantity >= 0 AND expected_base_quantity >= 0 AND actual_quantity >= 0),
  CONSTRAINT chk_production_consumption_variance_tolerance_range CHECK (tolerance_percent >= 0 AND tolerance_percent < 100),
  CONSTRAINT uq_production_consumption_variance_grain UNIQUE (production_order_id, bom_line_id)
);

CREATE INDEX IF NOT EXISTS idx_production_consumption_variance_order ON production_consumption_variance (production_order_id);
CREATE INDEX IF NOT EXISTS idx_production_consumption_variance_breached ON production_consumption_variance (tolerance_breached) WHERE tolerance_breached = true;
CREATE INDEX IF NOT EXISTS idx_production_consumption_variance_line ON production_consumption_variance (bom_line_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_consumption_variance_supply_method'
      AND conrelid = 'production_consumption_variance'::regclass
  ) THEN
    ALTER TABLE production_consumption_variance
      ADD CONSTRAINT chk_production_consumption_variance_supply_method CHECK (supply_method IN ('directed_issue','backflush'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_consumption_variance_quantities_non_negative'
      AND conrelid = 'production_consumption_variance'::regclass
  ) THEN
    ALTER TABLE production_consumption_variance
      ADD CONSTRAINT chk_production_consumption_variance_quantities_non_negative CHECK (basis_quantity >= 0 AND expected_quantity >= 0 AND expected_base_quantity >= 0 AND actual_quantity >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_consumption_variance_tolerance_range'
      AND conrelid = 'production_consumption_variance'::regclass
  ) THEN
    ALTER TABLE production_consumption_variance
      ADD CONSTRAINT chk_production_consumption_variance_tolerance_range CHECK (tolerance_percent >= 0 AND tolerance_percent < 100);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_production_consumption_variance_grain'
      AND conrelid = 'production_consumption_variance'::regclass
  ) THEN
    ALTER TABLE production_consumption_variance
      ADD CONSTRAINT uq_production_consumption_variance_grain UNIQUE (production_order_id, bom_line_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON production_consumption_variance TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON production_consumption_variance TO readonly_user;
  END IF;
END $$;

-- QC witnessed / third-party inspection hold point (Story 8.8, FR-Q-15, AC 1 and AC 2). This file
-- is the CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.witness_hold_point_raised,
-- qc.witnessed_inspection_signed_off and qc.witnessed_inspection_waived; mutation happens
-- exclusively through persistEvent inside the SAME transaction as the domain_events insert.
--
-- Story 8.8 Binding Scope Decision 2: this table is the RECORD of the witnessed-inspection
-- obligation, not a second enforcement axis. The applier that inserts a row here ALSO inserts a
-- normal governed qc_quality_hold row and sets lot_master.quality_hold_status = 'held' in the same
-- transaction (qc_hold_id below points at that row), so the Story 3.7 dispatch gate refuses the
-- lot with LOT_ON_HOLD unchanged and the Story 2.3 ad hoc clear route still refuses to lift it
-- with QUALITY_HOLD_GOVERNED. Storing the hold anywhere else would re-open that bypass.
--
-- uq_qc_witness_hold_point_open is the one-OPEN-hold-point-per-lot backstop (a 23505 resolves to
-- 409 WITNESS_HOLD_POINT_EXISTS). Closed hold points are history and do not count against the
-- grain, hence the partial predicate - the UNIQUE keyword plus the WHERE clause ARE the semantics,
-- exactly like uq_qc_quality_hold_open.
--
-- chk_qc_witness_hold_point_closure_pairing is the FULL biconditional (the Story 8.4
-- one-directional CHECK lesson: a half-pairing admits rows nothing can interpret): status <> 'open'
-- exactly when closed_by, closed_at and close_event_id are all non-null, and waiver_doa_entry_id
-- AND waiver_reason are each non-null exactly when status = 'waived'. There is no reopen; closure
-- is terminal.
--
-- source_event_id is UNIQUE: the replay guard (the Story 8.7 lesson) - a redelivered raise event
-- cannot mint a second hold point.
--
-- app_user holds SELECT, INSERT and UPDATE (the one open -> signed_off/waived transition) and
-- never DELETE; fixtures that need to clear rows use the admin pool.

CREATE TABLE IF NOT EXISTS qc_witness_hold_point (
  hold_point_id        UUID PRIMARY KEY,
  lot_id               UUID NOT NULL,
  lot_number           TEXT NOT NULL,
  sku                  TEXT NOT NULL,
  site_id              UUID,
  inspection_type      TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'open',
  qc_hold_id           UUID NOT NULL,
  raised_by            UUID NOT NULL,
  raised_at            TIMESTAMPTZ NOT NULL,
  source_event_id      UUID NOT NULL,
  closed_by            UUID,
  closed_at            TIMESTAMPTZ,
  close_event_id       UUID,
  waiver_doa_entry_id  UUID,
  waiver_reason        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_qc_witness_hold_point_event UNIQUE (source_event_id),
  CONSTRAINT chk_qc_witness_hold_point_type CHECK (inspection_type IN ('customer_witnessed', 'third_party')),
  CONSTRAINT chk_qc_witness_hold_point_status CHECK (status IN ('open', 'signed_off', 'waived')),
  CONSTRAINT chk_qc_witness_hold_point_waiver_reason CHECK (
    waiver_reason IS NULL OR (btrim(waiver_reason) <> '' AND char_length(waiver_reason) <= 2000)
  ),
  CONSTRAINT chk_qc_witness_hold_point_closure_pairing CHECK (
    (status <> 'open') = (closed_by IS NOT NULL)
    AND (closed_by IS NOT NULL) = (closed_at IS NOT NULL)
    AND (closed_at IS NOT NULL) = (close_event_id IS NOT NULL)
    AND (status = 'waived') = (waiver_doa_entry_id IS NOT NULL)
    AND (status = 'waived') = (waiver_reason IS NOT NULL)
  )
);

-- One OPEN witness hold point per lot; closed hold points are retained history and never block a
-- new one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_qc_witness_hold_point_open
  ON qc_witness_hold_point (lot_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_qc_witness_hold_point_lot ON qc_witness_hold_point (lot_id);
CREATE INDEX IF NOT EXISTS idx_qc_witness_hold_point_site
  ON qc_witness_hold_point (site_id, raised_at, hold_point_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_witness_hold_point_event'
      AND conrelid = 'qc_witness_hold_point'::regclass
  ) THEN
    ALTER TABLE qc_witness_hold_point
      ADD CONSTRAINT uq_qc_witness_hold_point_event UNIQUE (source_event_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_witness_hold_point_type'
      AND conrelid = 'qc_witness_hold_point'::regclass
  ) THEN
    ALTER TABLE qc_witness_hold_point
      ADD CONSTRAINT chk_qc_witness_hold_point_type
      CHECK (inspection_type IN ('customer_witnessed', 'third_party'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_witness_hold_point_status'
      AND conrelid = 'qc_witness_hold_point'::regclass
  ) THEN
    ALTER TABLE qc_witness_hold_point
      ADD CONSTRAINT chk_qc_witness_hold_point_status
      CHECK (status IN ('open', 'signed_off', 'waived'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_witness_hold_point_waiver_reason'
      AND conrelid = 'qc_witness_hold_point'::regclass
  ) THEN
    ALTER TABLE qc_witness_hold_point
      ADD CONSTRAINT chk_qc_witness_hold_point_waiver_reason CHECK (
        waiver_reason IS NULL OR (btrim(waiver_reason) <> '' AND char_length(waiver_reason) <= 2000)
      );
  END IF;
  -- The code review 2026-09-02 widened the pairing to cover waiver_reason. Drop the constraint
  -- ONLY when a narrower (pre-widening) definition is installed, then add-if-missing as the
  -- siblings do - an unconditional drop-and-re-add would take an ACCESS EXCLUSIVE lock and a full
  -- validation scan on EVERY migrate run, forever (round-2 review).
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_witness_hold_point_closure_pairing'
      AND conrelid = 'qc_witness_hold_point'::regclass
      AND pg_get_constraintdef(oid) NOT LIKE '%waiver_reason%'
  ) THEN
    ALTER TABLE qc_witness_hold_point
      DROP CONSTRAINT chk_qc_witness_hold_point_closure_pairing;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_witness_hold_point_closure_pairing'
      AND conrelid = 'qc_witness_hold_point'::regclass
  ) THEN
    ALTER TABLE qc_witness_hold_point
      ADD CONSTRAINT chk_qc_witness_hold_point_closure_pairing CHECK (
        (status <> 'open') = (closed_by IS NOT NULL)
        AND (closed_by IS NOT NULL) = (closed_at IS NOT NULL)
        AND (closed_at IS NOT NULL) = (close_event_id IS NOT NULL)
        AND (status = 'waived') = (waiver_doa_entry_id IS NOT NULL)
        AND (status = 'waived') = (waiver_reason IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE ON qc_witness_hold_point TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_witness_hold_point TO readonly_user;
  END IF;
END $$;

-- QC witnessed-inspection notice ledger (Story 8.8, FR-Q-15, AC 2). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Story 8.8 Binding Scope Decision 5: the notice is a first-class RECORD, not a notification.
-- emitNotificationInTransaction is fire-and-forget and stores no recipient/method contract that
-- can be read back as evidence; AC 2 requires evidence. The outbound notification is emitted
-- ALONGSIDE this row (AD-17), never instead of it - the structural analogue is the Story 8.7
-- compliance_bis_licence_alert ledger.
--
-- APPEND-ONLY: a notice that was given is a posted contractual fact. app_user therefore holds
-- SELECT and INSERT only - no UPDATE, and deliberately no DELETE (the Story 8.7 alert-ledger
-- decision). Unlike a rebuildable derived projection this table is the record of what was actually
-- served on the customer or third party.
--
-- No FK to qc_witness_hold_point: cross-projection foreign keys are forbidden by the house rule,
-- so referential integrity is the applier's job - it loads the hold point FOR UPDATE before
-- inserting a notice row.
--
-- source_event_id is UNIQUE: the replay guard - a redelivered notice event cannot post a second
-- notice.

CREATE TABLE IF NOT EXISTS qc_witness_notice (
  notice_id        UUID PRIMARY KEY,
  hold_point_id    UUID NOT NULL,
  recipient        TEXT NOT NULL,
  notice_date      DATE NOT NULL,
  method           TEXT NOT NULL,
  recorded_by      UUID NOT NULL,
  recorded_at      TIMESTAMPTZ NOT NULL,
  source_event_id  UUID NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_qc_witness_notice_event UNIQUE (source_event_id),
  CONSTRAINT chk_qc_witness_notice_recipient CHECK (
    btrim(recipient) <> '' AND char_length(recipient) <= 512
  ),
  CONSTRAINT chk_qc_witness_notice_method CHECK (
    method IN ('email', 'letter', 'portal', 'in_person')
  )
);

CREATE INDEX IF NOT EXISTS idx_qc_witness_notice_hold_point
  ON qc_witness_notice (hold_point_id, notice_date);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_witness_notice_event'
      AND conrelid = 'qc_witness_notice'::regclass
  ) THEN
    ALTER TABLE qc_witness_notice
      ADD CONSTRAINT uq_qc_witness_notice_event UNIQUE (source_event_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_witness_notice_recipient'
      AND conrelid = 'qc_witness_notice'::regclass
  ) THEN
    ALTER TABLE qc_witness_notice
      ADD CONSTRAINT chk_qc_witness_notice_recipient CHECK (
        btrim(recipient) <> '' AND char_length(recipient) <= 512
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_witness_notice_method'
      AND conrelid = 'qc_witness_notice'::regclass
  ) THEN
    ALTER TABLE qc_witness_notice
      ADD CONSTRAINT chk_qc_witness_notice_method CHECK (
        method IN ('email', 'letter', 'portal', 'in_person')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    -- SELECT and INSERT only. The ledger is append-only: no UPDATE, and deliberately no DELETE.
    GRANT SELECT, INSERT ON qc_witness_notice TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_witness_notice TO readonly_user;
  END IF;
END $$;

-- Job-work service order read model (Story 9.1). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying jobwork.* domain events; mutation happens
-- exclusively through persistEvent, which applies this projection inside the SAME transaction as
-- the domain_events insert. Status vocabulary is the four FR-JW-02 states
-- (draft, confirmed, in_process, closed); the in_process transition is fired by Story 9.2's first
-- customer-material receipt and closed only by the Story 9.5 closure gate. There is no customer
-- master table in this system (Story 9.1 BSD-4): the order carries a governed
-- customer_party_code short code plus customer_name. price_basis is JSONB
-- ({basis_type, rate, currency}); basis_type vocabulary is enforced in the seam, not a CHECK,
-- because FR-JW-01 does not close the vocabulary. offcut_election is captured optionally at
-- confirm for Story 9.4 (BSD-6), no behavior attached in 9.1.

CREATE TABLE IF NOT EXISTS service_order (
  service_order_id       UUID PRIMARY KEY,
  order_number_ext       TEXT NOT NULL,
  customer_party_code    TEXT NOT NULL,
  customer_name          TEXT NOT NULL,
  spec_reference_ext     TEXT,
  promised_start_date    DATE,
  promised_delivery_date DATE,
  price_basis            JSONB,
  kit_bom_id             UUID,
  status                 TEXT NOT NULL DEFAULT 'draft',
  offcut_election        TEXT,
  has_contractual_offcut BOOLEAN NOT NULL DEFAULT false,
  site_id                UUID NOT NULL,
  business_stream        TEXT NOT NULL,
  created_by             UUID NOT NULL,
  confirmed_at           TIMESTAMPTZ,
  confirmed_by           UUID,
  in_process_at          TIMESTAMPTZ,
  closed_at              TIMESTAMPTZ,
  closed_by              UUID,
  correlation_id         UUID,
  source_event_id        UUID NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_service_order_status CHECK (status IN ('draft','confirmed','in_process','closed')),
  CONSTRAINT chk_service_order_offcut_election CHECK (
    offcut_election IS NULL
    OR offcut_election IN ('return','retain_and_buy','retain_free')
  ),
  CONSTRAINT chk_service_order_customer_party_code CHECK (customer_party_code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$')
);

ALTER TABLE service_order ADD COLUMN IF NOT EXISTS has_contractual_offcut BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_order_number_site ON service_order (order_number_ext, site_id);
CREATE INDEX IF NOT EXISTS idx_service_order_status ON service_order (status);
CREATE INDEX IF NOT EXISTS idx_service_order_customer ON service_order (customer_party_code);
CREATE INDEX IF NOT EXISTS idx_service_order_site ON service_order (site_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_service_order_status'
      AND conrelid = 'service_order'::regclass
  ) THEN
    ALTER TABLE service_order
      ADD CONSTRAINT chk_service_order_status CHECK (status IN ('draft','confirmed','in_process','closed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_service_order_offcut_election'
      AND conrelid = 'service_order'::regclass
  ) THEN
    ALTER TABLE service_order
      ADD CONSTRAINT chk_service_order_offcut_election CHECK (
        offcut_election IS NULL
        OR offcut_election IN ('return','retain_and_buy','retain_free')
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_service_order_customer_party_code'
      AND conrelid = 'service_order'::regclass
  ) THEN
    ALTER TABLE service_order
      ADD CONSTRAINT chk_service_order_customer_party_code CHECK (customer_party_code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$');
  END IF;
END $$;

CREATE SEQUENCE IF NOT EXISTS service_order_number_seq;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON service_order TO app_user;
    GRANT USAGE ON SEQUENCE service_order_number_seq TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON service_order TO readonly_user;
  END IF;
END $$;

-- Job-work customer-material receipt read model (Story 9.2). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying jobwork.material_received domain events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the
-- SAME transaction as the domain_events insert (and, for the GRN path, the same transaction as
-- the grn_line and stock_balance writes). One GRN line yields exactly one custody receipt row
-- (uq_jobwork_receipt_grn_line). service_order_id is FK-shaped, not an FK: projections are
-- rebuildable independently (the Story 9.1 BSD-8 idiom). challan_date is the IST business date
-- the Story 9.5 Rule 45 return clock counts from. variance_qty is SIGNED (received - challan);
-- variance_flagged records whether its absolute value exceeded the configured receipt tolerance
-- (JOBWORK_RECEIPT_TOLERANCE_PCT) at receipt time, attributed to received_by. challan_class
-- (Story 9.5, Binding decision 7) classifies the challan for the CGST Section 143 return clock:
-- 'input' (one year) or 'capital_goods' (three years); it defaults to 'input' so a misclassified
-- capital good alerts early, never late. Section 143(1)'s proviso exempts moulds, dies, jigs,
-- tools and fixtures from any return clock; that third value is deliberately absent in the pilot
-- (nothing on the kit-BOM receipt path can receive an asset) and the CHECK is where it slots in.

CREATE TABLE IF NOT EXISTS jobwork_material_receipt (
  receipt_id         UUID PRIMARY KEY,
  service_order_id   UUID NOT NULL,
  grn_line_id        UUID NOT NULL,
  challan_number_ext TEXT NOT NULL,
  challan_date       DATE NOT NULL,
  sku                TEXT NOT NULL,
  lot_id             TEXT,
  received_qty       NUMERIC(18,3) NOT NULL,
  challan_qty        NUMERIC(18,3) NOT NULL,
  uom                TEXT NOT NULL,
  variance_qty       NUMERIC(18,3) NOT NULL,
  variance_flagged   BOOLEAN NOT NULL DEFAULT false,
  received_by        UUID NOT NULL,
  site_id            UUID NOT NULL,
  correlation_id     UUID,
  source_event_id    UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  challan_class      TEXT NOT NULL DEFAULT 'input',
  CONSTRAINT chk_jobwork_receipt_received_positive CHECK (received_qty > 0),
  CONSTRAINT chk_jobwork_receipt_challan_positive CHECK (challan_qty > 0),
  CONSTRAINT chk_jobwork_receipt_challan_class CHECK (challan_class IN ('input','capital_goods'))
);

-- Story 9.5: additive on a live 9.2 table; every existing receipt is an 'input' challan.
ALTER TABLE jobwork_material_receipt ADD COLUMN IF NOT EXISTS challan_class TEXT NOT NULL DEFAULT 'input';

CREATE UNIQUE INDEX IF NOT EXISTS uq_jobwork_receipt_grn_line ON jobwork_material_receipt (grn_line_id);
CREATE INDEX IF NOT EXISTS idx_jobwork_receipt_order ON jobwork_material_receipt (service_order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jobwork_receipt_site ON jobwork_material_receipt (site_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_jobwork_receipt_received_positive'
      AND conrelid = 'jobwork_material_receipt'::regclass
  ) THEN
    ALTER TABLE jobwork_material_receipt
      ADD CONSTRAINT chk_jobwork_receipt_received_positive CHECK (received_qty > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_jobwork_receipt_challan_positive'
      AND conrelid = 'jobwork_material_receipt'::regclass
  ) THEN
    ALTER TABLE jobwork_material_receipt
      ADD CONSTRAINT chk_jobwork_receipt_challan_positive CHECK (challan_qty > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_jobwork_receipt_challan_class'
      AND conrelid = 'jobwork_material_receipt'::regclass
  ) THEN
    ALTER TABLE jobwork_material_receipt
      ADD CONSTRAINT chk_jobwork_receipt_challan_class CHECK (challan_class IN ('input','capital_goods'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON jobwork_material_receipt TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON jobwork_material_receipt TO readonly_user;
  END IF;
END $$;

-- Job-work custody ledger read model (Story 9.3). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: one append-only ledger per (service_order_id, customer_party_code) with a
-- SIGNED quantity_delta per sku. Rows are rebuildable by replaying jobwork.material_received
-- (receipt rows, written by the Story 9.2 applier in the same transaction) and custody.* domain
-- events (consumption and own_material in 9.3). The running customer-owned balance is DERIVED:
-- SUM(quantity_delta) WHERE ownership = 'customer' under the order advisory lock for gates, a
-- window over rows for the statement. No balance table exists (Story 9.3 decision 1).
-- return, loss, offcut, dispatch and count_adjustment are forward-declared for Stories 9.4-9.6 so
-- they post into this table without a migration; no 9.3 path produces them. own_material is the
-- processor's own addition: ownership = 'processor', billable = true, never in the customer
-- balance (FR-JW-07). One ledger row per source event PER (sku, lot) - uq_custody_ledger_source_event
-- on (source_event_id, sku, lot_id) NULLS NOT DISTINCT - makes replay safe while letting one event
-- post several rows: a Story 9.4 dispatch apportions across every customer-supplied sku, and a
-- Story 9.5 physical-verification sign-off posts one count_adjustment per verified line (Story 9.5
-- Task 0 widened the original single-column index; the name is kept so the 23505 classification
-- arms still resolve). business_date is the IST calendar date of occurred_at (9.5 aging and ITC-04).

CREATE TABLE IF NOT EXISTS custody_ledger_entry (
  entry_id             UUID PRIMARY KEY,
  service_order_id     UUID NOT NULL,
  customer_party_code  TEXT NOT NULL,
  movement_category    TEXT NOT NULL,
  ownership            TEXT NOT NULL,
  sku                  TEXT NOT NULL,
  lot_id               TEXT,
  location_id          UUID,
  quantity_delta       NUMERIC(18,3) NOT NULL,
  uom                  TEXT NOT NULL,
  billable             BOOLEAN NOT NULL DEFAULT false,
  bom_line_id          UUID,
  kit_bom_revision_id  UUID,
  receipt_id           UUID,
  variance_qty         NUMERIC(18,3),
  variance_flagged     BOOLEAN,
  site_id              UUID NOT NULL,
  posted_by            UUID NOT NULL,
  occurred_at          TIMESTAMPTZ NOT NULL,
  business_date        DATE NOT NULL,
  source_event_id      UUID NOT NULL,
  source_event_type    TEXT NOT NULL,
  correlation_id       UUID,
  -- Story 9.5 code review (chunk 2): the external document number a movement cites. Populated
  -- for `return` with the mandatory return_challan_number_ext the shape assert already demands
  -- (goods leaving the job worker without a delivery challan is a GST offence), which was
  -- otherwise validated and then discarded into the raw event payload where no read model
  -- could see it. Nullable and free for other categories to adopt.
  reference_ext        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_custody_ledger_category CHECK (movement_category IN ('receipt','consumption','return','loss','offcut','dispatch','count_adjustment','own_material')),
  CONSTRAINT chk_custody_ledger_ownership_vocab CHECK (ownership IN ('customer','processor')),
  CONSTRAINT chk_custody_ledger_sign CHECK (
    (movement_category IN ('receipt','own_material') AND quantity_delta > 0)
    OR (movement_category IN ('consumption','return','loss','offcut','dispatch') AND quantity_delta < 0)
    OR (movement_category = 'count_adjustment' AND quantity_delta <> 0)
  ),
  CONSTRAINT chk_custody_ledger_ownership CHECK (
    (movement_category = 'own_material' AND ownership = 'processor' AND billable = true)
    OR (movement_category <> 'own_material' AND ownership = 'customer')
  )
);

-- Story 9.5 code review (chunk 2): additive upgrade path for a live database.
ALTER TABLE custody_ledger_entry ADD COLUMN IF NOT EXISTS reference_ext TEXT;
-- Story 9.5 Task 0: widen the replay key from (source_event_id) to (source_event_id, sku, lot_id).
-- Guarded: the DROP only fires while the OLD single-column definition is in place, so a re-apply
-- on an already-widened database is a no-op (migrate-twice idempotency).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'custody_ledger_entry'
      AND indexname = 'uq_custody_ledger_source_event'
      AND indexdef NOT LIKE '%(source_event_id, sku, lot_id)%'
  ) THEN
    DROP INDEX IF EXISTS uq_custody_ledger_source_event;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_custody_ledger_source_event ON custody_ledger_entry (source_event_id, sku, lot_id) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS idx_custody_ledger_order_time ON custody_ledger_entry (service_order_id, occurred_at, created_at);
CREATE INDEX IF NOT EXISTS idx_custody_ledger_order_sku ON custody_ledger_entry (service_order_id, ownership, sku);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_custody_ledger_category'
      AND conrelid = 'custody_ledger_entry'::regclass
  ) THEN
    ALTER TABLE custody_ledger_entry
      ADD CONSTRAINT chk_custody_ledger_category CHECK (movement_category IN ('receipt','consumption','return','loss','offcut','dispatch','count_adjustment','own_material'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_custody_ledger_ownership_vocab'
      AND conrelid = 'custody_ledger_entry'::regclass
  ) THEN
    ALTER TABLE custody_ledger_entry
      ADD CONSTRAINT chk_custody_ledger_ownership_vocab CHECK (ownership IN ('customer','processor'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_custody_ledger_sign'
      AND conrelid = 'custody_ledger_entry'::regclass
  ) THEN
    ALTER TABLE custody_ledger_entry
      ADD CONSTRAINT chk_custody_ledger_sign CHECK (
        (movement_category IN ('receipt','own_material') AND quantity_delta > 0)
        OR (movement_category IN ('consumption','return','loss','offcut','dispatch') AND quantity_delta < 0)
        OR (movement_category = 'count_adjustment' AND quantity_delta <> 0)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_custody_ledger_ownership'
      AND conrelid = 'custody_ledger_entry'::regclass
  ) THEN
    ALTER TABLE custody_ledger_entry
      ADD CONSTRAINT chk_custody_ledger_ownership CHECK (
        (movement_category = 'own_material' AND ownership = 'processor' AND billable = true)
        OR (movement_category <> 'own_material' AND ownership = 'customer')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON custody_ledger_entry TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON custody_ledger_entry TO readonly_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS job_work_output (
  output_id            UUID PRIMARY KEY,
  service_order_id     UUID NOT NULL,
  lot_id               TEXT NOT NULL,
  lot_number           TEXT NOT NULL,
  sku                  TEXT NOT NULL,
  quantity             NUMERIC(18,3) NOT NULL,
  dispatched_quantity  NUMERIC(18,3) NOT NULL DEFAULT 0,
  uom                  TEXT NOT NULL,
  site_id              UUID NOT NULL,
  recorded_by          UUID NOT NULL,
  source_event_id      UUID NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_job_work_output_quantity_positive CHECK (quantity > 0),
  CONSTRAINT chk_job_work_output_dispatched_bounds CHECK (
    dispatched_quantity >= 0 AND dispatched_quantity <= quantity
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_work_output_source_event ON job_work_output (source_event_id);
CREATE INDEX IF NOT EXISTS idx_job_work_output_order ON job_work_output (service_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_work_output_lot ON job_work_output (lot_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_job_work_output_quantity_positive'
      AND conrelid = 'job_work_output'::regclass
  ) THEN
    ALTER TABLE job_work_output
      ADD CONSTRAINT chk_job_work_output_quantity_positive CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_job_work_output_dispatched_bounds'
      AND conrelid = 'job_work_output'::regclass
  ) THEN
    ALTER TABLE job_work_output
      ADD CONSTRAINT chk_job_work_output_dispatched_bounds CHECK (
        dispatched_quantity >= 0 AND dispatched_quantity <= quantity
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON job_work_output TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON job_work_output TO readonly_user;
  END IF;
END $$;

-- One row per jobwork.output_dispatched event: the dispatch_id the caller minted is the projection
-- anchor, so a replay (or a retry that re-mints the idempotency key) collides here instead of
-- silently incrementing dispatched_quantity a second time, and a physical shipment can be traced
-- back to its dispatch_id.
CREATE TABLE IF NOT EXISTS job_work_dispatch (
  dispatch_id          UUID PRIMARY KEY,
  service_order_id     UUID NOT NULL,
  output_id            UUID NOT NULL,
  lot_number           TEXT NOT NULL,
  sku                  TEXT NOT NULL,
  dispatched_quantity  NUMERIC(18,3) NOT NULL,
  uom                  TEXT NOT NULL,
  site_id              UUID NOT NULL,
  dispatched_by        UUID NOT NULL,
  dispatched_at        TIMESTAMPTZ NOT NULL,
  source_event_id      UUID NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_job_work_dispatch_qty_positive CHECK (dispatched_quantity > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_work_dispatch_source_event ON job_work_dispatch (source_event_id);
CREATE INDEX IF NOT EXISTS idx_job_work_dispatch_order ON job_work_dispatch (service_order_id);
CREATE INDEX IF NOT EXISTS idx_job_work_dispatch_output ON job_work_dispatch (output_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_job_work_dispatch_qty_positive'
      AND conrelid = 'job_work_dispatch'::regclass
  ) THEN
    ALTER TABLE job_work_dispatch
      ADD CONSTRAINT chk_job_work_dispatch_qty_positive CHECK (dispatched_quantity > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON job_work_dispatch TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON job_work_dispatch TO readonly_user;
  END IF;
END $$;

-- Job-work statutory return clock read model (Story 9.5, FR-AC-11, FR-JW-14). This file is the
-- CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: exactly one clock row per jobwork_material_receipt row (1:1, receipt_id is
-- FK-shaped, not an FK - the Story 9.1 BSD-8 rebuildable-projection idiom), inserted by the Story
-- 9.2 receipt applier in the SAME transaction as the receipt (Binding decision 1: the receipt is
-- 9.2's immutable capture of what arrived; the clock is the mutable statutory lifecycle row).
--
-- CGST Section 143(1): inputs sent to a job worker must come back (or be supplied from the job
-- worker's premises) within ONE year of the challan date, capital goods within THREE years;
-- otherwise the original dispatch is deemed a supply on the day the goods went out. expiry_date is
-- computed in SQL as challan_date + 365 / 1095 calendar days by challan_class, never by JS Date
-- arithmetic across DST/timezone (the 9.1 DATE-vs-timezone gotcha).
--
-- Two counters on purpose (Binding decision 6): reconciled_qty is material that went BACK to the
-- principal (dispatch, return, forward-declared offcut); loss_qty is waste and scrap accounted
-- under Section 143(5) - reported in its own ITC-04 column, never deemed supply. Consumption into
-- WIP moves NEITHER counter: the bracket is still on the job worker's floor and the clock is still
-- running. deemed_supply_qty is frozen at breach time (challan - reconciled - loss on the day the
-- limit passed); a late reconciliation against a breached clock reduces the outstanding capacity
-- but never rewrites the recorded deemed supply.
--
-- alert_90_sent_at / alert_30_sent_at are the two GLOBAL lead-day stage stamps (Story 9.5 Open
-- question 5): the sweep is single-pass, tightest-stage-wins, so a clock first seen inside the
-- 30-day window fires ONE alert and sets BOTH stamps. Named so per-class knobs slot in later.

CREATE TABLE IF NOT EXISTS jobwork_return_clock (
  clock_id                  UUID PRIMARY KEY,
  receipt_id                UUID NOT NULL,
  service_order_id          UUID NOT NULL,
  sku                       TEXT NOT NULL,
  challan_qty               NUMERIC(18,3) NOT NULL,
  reconciled_qty            NUMERIC(18,3) NOT NULL DEFAULT 0,
  loss_qty                  NUMERIC(18,3) NOT NULL DEFAULT 0,
  challan_class             TEXT NOT NULL,
  challan_date              DATE NOT NULL,
  expiry_date               DATE NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'open',
  deemed_supply_qty         NUMERIC(18,3) NOT NULL DEFAULT 0,
  deemed_supply_recorded_at TIMESTAMPTZ,
  alert_90_sent_at          TIMESTAMPTZ,
  alert_30_sent_at          TIMESTAMPTZ,
  site_id                   UUID NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_jobwork_return_clock_class CHECK (challan_class IN ('input','capital_goods')),
  CONSTRAINT chk_jobwork_return_clock_status CHECK (status IN ('open','partially_reconciled','reconciled','breached')),
  CONSTRAINT chk_jobwork_return_clock_counters CHECK (
    reconciled_qty >= 0 AND loss_qty >= 0 AND deemed_supply_qty >= 0
    AND reconciled_qty + loss_qty <= challan_qty
  ),
  CONSTRAINT chk_jobwork_return_clock_expiry CHECK (expiry_date > challan_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_jobwork_return_clock_receipt ON jobwork_return_clock (receipt_id);
CREATE INDEX IF NOT EXISTS idx_jobwork_return_clock_order_sku ON jobwork_return_clock (service_order_id, sku, challan_date, created_at);
CREATE INDEX IF NOT EXISTS idx_jobwork_return_clock_sweep ON jobwork_return_clock (status, expiry_date);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_jobwork_return_clock_class'
      AND conrelid = 'jobwork_return_clock'::regclass
  ) THEN
    ALTER TABLE jobwork_return_clock
      ADD CONSTRAINT chk_jobwork_return_clock_class CHECK (challan_class IN ('input','capital_goods'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_jobwork_return_clock_status'
      AND conrelid = 'jobwork_return_clock'::regclass
  ) THEN
    ALTER TABLE jobwork_return_clock
      ADD CONSTRAINT chk_jobwork_return_clock_status CHECK (status IN ('open','partially_reconciled','reconciled','breached'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_jobwork_return_clock_counters'
      AND conrelid = 'jobwork_return_clock'::regclass
  ) THEN
    ALTER TABLE jobwork_return_clock
      ADD CONSTRAINT chk_jobwork_return_clock_counters CHECK (
        reconciled_qty >= 0 AND loss_qty >= 0 AND deemed_supply_qty >= 0
        AND reconciled_qty + loss_qty <= challan_qty
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_jobwork_return_clock_expiry'
      AND conrelid = 'jobwork_return_clock'::regclass
  ) THEN
    ALTER TABLE jobwork_return_clock
      ADD CONSTRAINT chk_jobwork_return_clock_expiry CHECK (expiry_date > challan_date);
  END IF;
END $$;

-- Story 9.5 code review (chunk 1): BACKFILL. The 1:1 invariant above holds only for receipts taken
-- after this file first ran. On a database already carrying Story 9.2 or 9.4 receipts those challans
-- would be invisible to the sweep, to ITC-04 and to the aging report, and a return posted against one
-- would be refused by reconcileReturnClocks's strict mode for want of clock capacity - and they are
-- the OLDEST challans, the ones nearest their Section 143 limit. challan_class is read from the
-- receipt (which defaults it to 'input'), and expiry is computed by the same SQL date arithmetic the
-- insert path uses. NOT EXISTS on receipt_id makes every later apply a no-op (migrate-twice
-- idempotency), and this file runs after jobwork_material_receipt.sql in src/events/migrate.ts, so
-- challan_class is always present by the time this statement executes.
INSERT INTO jobwork_return_clock (
  clock_id, receipt_id, service_order_id, sku, challan_qty, challan_class, challan_date, expiry_date,
  site_id
)
SELECT gen_random_uuid(),
       r.receipt_id,
       r.service_order_id,
       r.sku,
       r.challan_qty,
       r.challan_class,
       r.challan_date,
       (r.challan_date + make_interval(days => CASE WHEN r.challan_class = 'capital_goods' THEN 1095 ELSE 365 END))::date,
       r.site_id
  FROM jobwork_material_receipt r
 WHERE NOT EXISTS (
   SELECT 1 FROM jobwork_return_clock c WHERE c.receipt_id = r.receipt_id
 );

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON jobwork_return_clock TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON jobwork_return_clock TO readonly_user;
  END IF;
END $$;
