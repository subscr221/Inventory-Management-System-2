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
  CONSTRAINT chk_maintenance_work_order_status CHECK (status IN ('open', 'overdue', 'completed')),
  CONSTRAINT chk_maintenance_work_order_origin CHECK (origin IN ('preventive', 'breakdown')),
  CONSTRAINT chk_maintenance_work_order_plan_link CHECK (origin <> 'preventive' OR plan_id IS NOT NULL),
  CONSTRAINT chk_maintenance_work_order_grace CHECK (grace_until_date >= due_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_work_order_cycle ON maintenance_work_order (plan_id, generated_for_cycle) WHERE plan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_maintenance_work_order_asset ON maintenance_work_order (asset_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_work_order_sweep ON maintenance_work_order (status, grace_until_date);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_work_order_status'
      AND conrelid = 'maintenance_work_order'::regclass
  ) THEN
    ALTER TABLE maintenance_work_order
      ADD CONSTRAINT chk_maintenance_work_order_status CHECK (status IN ('open', 'overdue', 'completed'));
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
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON maintenance_work_order TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_work_order TO readonly_user;
  END IF;
END $$;
