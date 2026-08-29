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
-- Story 8.3 widens it for accept and reject. task_status is 'open' until Story 8.2 adds sampling
-- and result capture. The frozen plan_version_id never changes after creation (Annex requirement
-- 6): later plan approvals must never alter the plan a held lot is inspected against.
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
  CONSTRAINT uq_qc_inspection_task_lot UNIQUE (lot_id),
  CONSTRAINT uq_qc_inspection_task_source UNIQUE (source_completion_type, source_completion_id),
  CONSTRAINT chk_qc_inspection_task_quantity CHECK (quantity > 0),
  CONSTRAINT chk_qc_inspection_task_source_type CHECK (source_completion_type IN ('synthetic_completion', 'production_order', 'job_work_order')),
  CONSTRAINT chk_qc_inspection_task_status CHECK (task_status IN ('open')),
  CONSTRAINT chk_qc_inspection_task_gate_status CHECK (gate_status IN ('qc_hold', 'conditionally_released')),
  CONSTRAINT chk_qc_inspection_task_plan_scope CHECK (plan_scope IN ('standard', 'customer_override')),
  CONSTRAINT chk_qc_inspection_task_scope_pairing CHECK (
    (plan_scope = 'standard' AND source_order_type IS NULL AND source_order_ref IS NULL)
    OR (plan_scope = 'customer_override' AND source_order_type = 'job_work_order' AND source_order_ref IS NOT NULL AND btrim(source_order_ref) <> '')
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
      ADD CONSTRAINT chk_qc_inspection_task_status CHECK (task_status IN ('open'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_inspection_task_gate_status'
      AND conrelid = 'qc_inspection_task'::regclass
  ) THEN
    ALTER TABLE qc_inspection_task
      ADD CONSTRAINT chk_qc_inspection_task_gate_status CHECK (gate_status IN ('qc_hold', 'conditionally_released'));
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

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON qc_inspection_task TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_inspection_task TO readonly_user;
  END IF;
END $$;
