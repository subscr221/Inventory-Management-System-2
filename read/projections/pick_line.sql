-- Story 3.6: Pick lines - one row per directed lot within a pick task (FR-W-04). This file is the
-- CANONICAL definition, applied by src/events/migrate.ts. deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent. directed_lot_id/confirmed_lot_id are lot_master.lot_id UUIDs (NOT lot_number - the
-- stock_balance.lot_id TEXT column carries lot_number; the apply functions bridge via lot_master).

CREATE TABLE IF NOT EXISTS pick_line (
  pick_line_id           UUID PRIMARY KEY,
  pick_task_id           UUID NOT NULL REFERENCES pick_task(pick_task_id),
  dispatch_order_line_id UUID NOT NULL,
  sku                    TEXT NOT NULL,
  directed_lot_id        UUID NOT NULL,
  confirmed_lot_id       UUID,
  directed_quantity      NUMERIC(14,3) NOT NULL,
  confirmed_quantity     NUMERIC(14,3),
  location_id            UUID NOT NULL,
  pick_sequence          INTEGER NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'pending',
  override_reason        TEXT,
  capture_method         TEXT,
  confirmed_by           UUID,
  confirmed_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_pick_line_status CHECK (status IN ('pending', 'confirmed', 'cancelled', 'substituted')),
  CONSTRAINT chk_pick_line_capture_method CHECK (capture_method IS NULL OR capture_method IN ('PWA', 'PAPER'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_pick_line_status'
      AND conrelid = 'pick_line'::regclass
  ) THEN
    ALTER TABLE pick_line
      ADD CONSTRAINT chk_pick_line_status CHECK (status IN ('pending', 'confirmed', 'cancelled', 'substituted'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_pick_line_capture_method'
      AND conrelid = 'pick_line'::regclass
  ) THEN
    ALTER TABLE pick_line
      ADD CONSTRAINT chk_pick_line_capture_method CHECK (capture_method IS NULL OR capture_method IN ('PWA', 'PAPER'));
  END IF;
END $$;

-- Story 3.6 (review pass 2): the bin a confirmation actually allocated at. Completion moves stock
-- from `allocated` to `picked` at THIS bin instead of re-deriving it with a different predicate
-- than confirmation used, which could resolve to another bin (and another task's allocation) when
-- a lot is allocated across several bins. Null until the line is confirmed.
ALTER TABLE IF EXISTS pick_line ADD COLUMN IF NOT EXISTS confirmed_location_id UUID;

CREATE INDEX IF NOT EXISTS idx_pick_line_task ON pick_line (pick_task_id);
CREATE INDEX IF NOT EXISTS idx_pick_line_location_status ON pick_line (location_id, status);
CREATE INDEX IF NOT EXISTS idx_pick_line_directed_lot ON pick_line (directed_lot_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON pick_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON pick_line TO readonly_user;
  END IF;
END $$;
