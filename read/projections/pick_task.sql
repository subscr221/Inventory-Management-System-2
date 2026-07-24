-- Story 3.6: Pick Task Generation and Execution (FR-W-04). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate). deploy/compose/init-db.sql duplicates this
-- content for first-boot container init - change both files together. Every statement is idempotent.
--
-- Grain is (pick_task_id). dispatch_order_id references the Story 2.9 erp_sales_order.id surrogate
-- (added below as an additive column on the reference projection - the ERP feed's natural key stays
-- (so_number_ext, line_no); the surrogate exists so warehouse rows can carry a stable UUID).

-- Story 3.6 additive migration: a stable UUID surrogate on the Story 2.9 sales-order reference
-- projection, used as the dispatch-order identifier by pick tasks (the projection previously had
-- only the composite (so_number_ext, line_no) natural key).
ALTER TABLE IF EXISTS erp_sales_order ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_sales_order_id ON erp_sales_order (id);

-- Story 3.6 additive migration: bin pick-sequence on the warehouse topology master (AC1 requires
-- ascending bin pick-sequence within each zone; the sequence originates on the bin itself).
ALTER TABLE IF EXISTS location_register ADD COLUMN IF NOT EXISTS pick_sequence INTEGER;

CREATE TABLE IF NOT EXISTS pick_task (
  pick_task_id      UUID PRIMARY KEY,
  dispatch_order_id UUID NOT NULL,
  sku               TEXT NOT NULL,
  total_quantity    NUMERIC(14,3) NOT NULL,
  strategy          TEXT NOT NULL,
  wave_id           UUID,
  batch_id          UUID,
  zone_id           UUID NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  assigned_to       UUID,
  created_by        UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  completed_by      UUID,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_pick_task_strategy CHECK (strategy IN ('single', 'batch', 'wave', 'zone')),
  CONSTRAINT chk_pick_task_status CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_pick_task_strategy'
      AND conrelid = 'pick_task'::regclass
  ) THEN
    ALTER TABLE pick_task
      ADD CONSTRAINT chk_pick_task_strategy CHECK (strategy IN ('single', 'batch', 'wave', 'zone'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_pick_task_status'
      AND conrelid = 'pick_task'::regclass
  ) THEN
    ALTER TABLE pick_task
      ADD CONSTRAINT chk_pick_task_status CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pick_task_dispatch_order ON pick_task (dispatch_order_id);
CREATE INDEX IF NOT EXISTS idx_pick_task_zone_status ON pick_task (zone_id, status);
CREATE INDEX IF NOT EXISTS idx_pick_task_assigned_status ON pick_task (assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_pick_task_wave ON pick_task (wave_id);
CREATE INDEX IF NOT EXISTS idx_pick_task_batch ON pick_task (batch_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON pick_task TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON pick_task TO readonly_user;
  END IF;
END $$;

-- Story 3.6 (AC4 scope extension): minimal dispatch-order picked flag. No dispatch-order status
-- projection existed before this story; Story 3.7 (packing) may extend or replace it.
CREATE TABLE IF NOT EXISTS dispatch_order_status (
  dispatch_order_id UUID PRIMARY KEY,
  picked_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  picked_by         UUID NOT NULL
);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON dispatch_order_status TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON dispatch_order_status TO readonly_user;
  END IF;
END $$;
