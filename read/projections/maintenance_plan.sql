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
