-- Story 3.8: Warehouse Task Management and Productivity Tracking (FR-W-07). This file is the
-- CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate).
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent.
--
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
  -- The capture instant of the event that last wrote this row, used as the replay-ordering guard in
  -- the compliance seam's upsert. updated_at is now() and therefore records when the row was
  -- WRITTEN, which says nothing about which event is authoritative when two threshold changes commit
  -- out of order or a stream is replayed. Comparing against this column is what stops an older event
  -- reinstating a superseded threshold and silently changing which live tasks read as breached.
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

-- Upgrade path for databases provisioned from the pre-review revision of this story, where the
-- table exists without site_id and carries the deployment-wide grain. The table is unreleased, so
-- any row present is development or test data with no recoverable site attribution: it is discarded
-- rather than guessed at, which converges the upgraded and freshly-created schemas on exactly the
-- same shape. The stale index must be dropped before the new one can be built, because the old
-- grain permits rows the new grain also permits - it is the narrower index that has to win.
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

-- NULLS NOT DISTINCT (the Story 2.9 uq_integration_exception_open convention) is what makes the
-- site-wide default row enforceable: without it, PostgreSQL treats every NULL zone_id as distinct
-- and an unbounded number of "site-wide" rows could coexist for the same (site_id, task_type). This
-- index is also the ON CONFLICT target of the compliance seam's upsert. It is deliberately
-- unqualified rather than partial - task_sla_config carries no active/superseded lifecycle column,
-- so there is no predicate to make it partial by, and one row per grain unconditionally is the
-- stronger rule.
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
