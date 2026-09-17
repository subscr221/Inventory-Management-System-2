-- Edge refused-captures queue (Story 1.13, AD-18, AC 2). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve reads and
-- writes as app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql
-- duplicates this content for first-boot container init - change both files together. Every
-- statement is idempotent (IF NOT EXISTS / guarded DO blocks).
--
-- Derived state ONLY (AD-14): rows are rebuildable by replaying sync.refused_capture_recorded
-- (written by the edge upload wrapper AFTER a permanently refused upload has rolled back) and
-- sync.refused_capture_resolved (the DOA-gated supervisor decision). Mutation happens exclusively
-- through persistEvent, inside the same transaction as the domain_events insert.
--
-- The grain is ONE row per refused capture event_id (AD-16): uq_edge_refused_capture_event is the
-- race backstop behind the record applier's sequential pre-check. Resolution is a decision record
-- only: nothing is replayed, re-queued or deleted on the device.

CREATE TABLE IF NOT EXISTS edge_refused_capture (
  refusal_id          UUID PRIMARY KEY,
  event_id            UUID NOT NULL,
  stream_type         TEXT NOT NULL,
  stream_id           TEXT,
  event_type          TEXT,
  idempotency_key     TEXT,
  device_id           TEXT,
  captured_by         UUID NOT NULL,
  captured_role       TEXT,
  location_id         UUID,
  location_source     TEXT NOT NULL,
  http_status         INTEGER NOT NULL,
  error_code          TEXT NOT NULL,
  error_details       JSONB,
  envelope            JSONB,
  envelope_truncated  BOOLEAN NOT NULL DEFAULT false,
  trace_id            TEXT NOT NULL,
  occurred_at         TIMESTAMPTZ,
  refused_at          TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open',
  resolved_by         UUID,
  resolved_at         TIMESTAMPTZ,
  resolution_note     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_edge_refused_capture_event ON edge_refused_capture (event_id);
CREATE INDEX IF NOT EXISTS idx_edge_refused_capture_location ON edge_refused_capture (location_id, status, refused_at DESC);
CREATE INDEX IF NOT EXISTS idx_edge_refused_capture_stream ON edge_refused_capture (stream_type, status);
-- Story 1.14 (Task 1.4): the list's ORDER BY (refused_at DESC, refusal_id) under a status filter
-- with no site narrowing (wildcard-site callers), found missing by the Story 1.13 review.
CREATE INDEX IF NOT EXISTS idx_edge_refused_capture_status_refused_at ON edge_refused_capture (status, refused_at DESC, refusal_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_edge_refused_capture_status'
      AND conrelid = 'edge_refused_capture'::regclass
  ) THEN
    ALTER TABLE edge_refused_capture
      ADD CONSTRAINT chk_edge_refused_capture_status CHECK (status IN ('open', 'resolved'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_edge_refused_capture_location_source'
      AND conrelid = 'edge_refused_capture'::regclass
  ) THEN
    ALTER TABLE edge_refused_capture
      ADD CONSTRAINT chk_edge_refused_capture_location_source CHECK (location_source IN ('authorized', 'declared', 'none'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_edge_refused_capture_resolution_note'
      AND conrelid = 'edge_refused_capture'::regclass
  ) THEN
    ALTER TABLE edge_refused_capture
      ADD CONSTRAINT chk_edge_refused_capture_resolution_note CHECK (resolution_note IS NULL OR char_length(resolution_note) BETWEEN 1 AND 1000);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON edge_refused_capture TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON edge_refused_capture TO readonly_user;
  END IF;
END $$;
