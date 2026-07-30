-- Replenishment task-board row (Story 3.9, FR-W-08). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate). deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent.
--
-- A SKU-zone internal-movement task, distinct from replenishment_recommendation (Story 2.7/2.8),
-- a SKU-location reorder/VMI signal with no zone concept that is never itself an executable task.
-- zone_id is already zone-level at creation time (the destination forward-pick zone), so - unlike
-- pick_task/putaway_task - the task board needs no ancestor-walk denormalization for this source.
--
-- uq_replenishment_task_open_signal mirrors replenishment_recommendation's
-- uq_replenishment_recommendation_open_signal: a re-run of the replenishment trigger job cannot
-- stack a second open task for the same SKU/zone/signal while one is still outstanding.
--
-- Rows are written ONLY through persistEvent's replenishment_task.created/.completed seam
-- (src/compliance/replenishment.ts), so every task replays, audits, and passes through the same
-- seam as every other Story 3.5-3.8 warehouse write.

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
