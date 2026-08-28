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
