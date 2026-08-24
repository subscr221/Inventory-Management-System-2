-- Maintenance downtime window (Story 7.3, FR-M-06). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.breakdown_work_order_created
-- (which opens the window) and maintenance.downtime_closed domain events; mutation happens
-- exclusively through persistEvent, which applies this projection inside the SAME transaction as
-- the domain_events insert.
--
-- uq_maintenance_downtime_work_order enforces the Phase-1 binding decision: exactly ONE downtime
-- window per breakdown work order. The seam pre-check returns the stable DOWNTIME_NOT_OPEN; this
-- unique index is the concurrency backstop and the 23505 mapper resolves the winner as
-- DOWNTIME_ALREADY_OPEN.

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
