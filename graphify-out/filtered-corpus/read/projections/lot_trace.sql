-- Lot trace auxiliary table (Story 2.3). This file is the CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its
-- OWN grants (guarded DO blocks) so a migrate-provisioned database can serve lot-trace
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- This table captures every transaction touching a lot for fast recall traces.
-- Columns: lot_id, event_id, event_type, sku, location_id, quantity_change (signed),
-- business_stream, timestamp. Index on lot_id + timestamp for recall reporting.

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

-- Index on lot_id + timestamp for recall reporting
CREATE INDEX IF NOT EXISTS idx_lot_trace_lot_timestamp ON lot_trace (lot_id, timestamp);

-- UNIQUE index on event_id: this is the ON CONFLICT (event_id) DO NOTHING target in
-- appendTraceEntry, making dedup atomic under concurrent inserts for the same event_id. A
-- database provisioned before this guard carries idx_lot_trace_event_id as a PLAIN index (`CREATE
-- INDEX IF NOT EXISTS` below would then no-op forever against that name) - drop it first so the
-- unique version underneath actually gets created.
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