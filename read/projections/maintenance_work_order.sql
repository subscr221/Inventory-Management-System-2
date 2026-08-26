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

-- Story 7.3 breakdown arm (FR-M-04, FR-M-05): additive columns on the SAME table so a breakdown
-- work order shares the work-order register instead of creating a second table. The guarded
-- ALTER blocks re-apply harmlessly on an existing database. fault_report_id and sla_policy_id are
-- references without FKs (projections are event-rebuildable read models; referential integrity is
-- asserted in the seam). priority is a TABLE LOOKUP result from the active SLA policy, never a
-- hardcoded ladder. The existing chk_maintenance_work_order_plan_link already permits plan_id NULL
-- for a non-preventive row, so it stays untouched.
ALTER TABLE maintenance_work_order ADD COLUMN IF NOT EXISTS fault_report_id UUID;
ALTER TABLE maintenance_work_order ADD COLUMN IF NOT EXISTS priority TEXT;
ALTER TABLE maintenance_work_order ADD COLUMN IF NOT EXISTS sla_policy_id UUID;
ALTER TABLE maintenance_work_order ADD COLUMN IF NOT EXISTS sla_response_due_at TIMESTAMPTZ;
ALTER TABLE maintenance_work_order ADD COLUMN IF NOT EXISTS sla_resolution_due_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_work_order_cycle ON maintenance_work_order (plan_id, generated_for_cycle) WHERE plan_id IS NOT NULL;
-- Story 7.3: the anti-double-acceptance key. A fault report may be accepted exactly once; the
-- seam pre-check returns the stable FAULT_ALREADY_TRIAGED and this partial unique index is the
-- concurrency backstop (23505 mapper resolves it to FAULT_ALREADY_TRIAGED).
CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_work_order_fault ON maintenance_work_order (fault_report_id) WHERE fault_report_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_maintenance_work_order_priority ON maintenance_work_order (origin, priority, status);
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

-- Story 7.7 warranty arm (FR-M-11): two additive columns on the SAME work-order register so the
-- warranty check rides the existing row instead of a side table. Both are SERVER-DERIVED in
-- applyBreakdownWorkOrderCreated from the active-warranty lookup against the payload business_date
-- (Binding Decisions 3 and 4): a declared warranty_flagged or warranty_coverage_id in the envelope
-- is rejected with WORK_ORDER_DERIVATION_MISMATCH, so there is no client write path. Preventive
-- work orders are never checked and keep the false default (Binding Decision 2). No CHECK
-- constraint is needed: a defaulted boolean and a nullable UUID are self-validating. The existing
-- columns, constraints and indexes are untouched.
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
