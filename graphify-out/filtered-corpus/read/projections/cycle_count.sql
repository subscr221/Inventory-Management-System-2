-- Cycle count read model (Story 2.6). This file is the CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its own
-- grants (guarded DO blocks) so a migrate-provisioned database can serve reads as app_user without
-- depending on deploy/compose/init-db.sql.
--
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent so the file can be re-applied to a live database
-- safely.
--
-- Derived state ONLY: rows are rebuildable by replaying cycle_count.* and stock.adjusted domain
-- events; mutation happens exclusively through persistEvent, which applies this projection inside
-- the SAME transaction as the domain_events insert. cycle_count is the task header; cycle_count_line
-- is one row per counted (sku, lot_id, stock_class) with the computed book quantity, variance, and -
-- when the variance breaches tolerance - the DOA-gated adjustment lifecycle (pending_approval ->
-- approved/rejected -> applied). variance_value and book_quantity are stored (not client-supplied).

CREATE TABLE IF NOT EXISTS cycle_count (
  cycle_count_id        UUID PRIMARY KEY,
  location_id           UUID NOT NULL,
  zone_id               TEXT,
  sku_scope             TEXT[] NOT NULL,
  stock_class           TEXT,
  count_type            TEXT NOT NULL,
  business_date         DATE NOT NULL,
  business_stream       TEXT NOT NULL,
  tolerance_percent     NUMERIC(9, 4) NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'open',
  -- status values: open, submitted, completed
  created_by_actor_id   UUID,
  submitted_by_actor_id UUID,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cycle_count_location ON cycle_count (location_id);
CREATE INDEX IF NOT EXISTS idx_cycle_count_status ON cycle_count (status);

CREATE TABLE IF NOT EXISTS cycle_count_line (
  line_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_count_id     UUID NOT NULL,
  sku                TEXT NOT NULL,
  lot_id             TEXT,
  stock_class        TEXT NOT NULL DEFAULT 'owned',
  counted_quantity   NUMERIC(18, 6) NOT NULL,
  book_quantity      NUMERIC(18, 6) NOT NULL DEFAULT 0,
  allocated_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  in_transit_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  variance_quantity  NUMERIC(18, 6) NOT NULL DEFAULT 0,
  variance_value     NUMERIC(20, 6) NOT NULL DEFAULT 0,
  tolerance_breach   BOOLEAN NOT NULL DEFAULT false,
  adjustment_id      UUID,
  adjustment_status  TEXT,
  -- adjustment_status values: NULL (no adjustment), pending_approval, approved, rejected, applied
  approver_actor_id  UUID,
  reason_code        TEXT,
  applied_event_id   UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_cycle_count_line_grain UNIQUE NULLS NOT DISTINCT (cycle_count_id, sku, lot_id, stock_class),
  CONSTRAINT chk_cycle_count_line_counted_non_negative CHECK (counted_quantity >= 0)
);

CREATE INDEX IF NOT EXISTS idx_cycle_count_line_count ON cycle_count_line (cycle_count_id);
CREATE INDEX IF NOT EXISTS idx_cycle_count_line_adjustment ON cycle_count_line (adjustment_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_cycle_count_line_grain'
      AND conrelid = 'cycle_count_line'::regclass
  ) THEN
    ALTER TABLE cycle_count_line
      ADD CONSTRAINT uq_cycle_count_line_grain UNIQUE NULLS NOT DISTINCT (cycle_count_id, sku, lot_id, stock_class);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_cycle_count_line_counted_non_negative'
      AND conrelid = 'cycle_count_line'::regclass
  ) THEN
    ALTER TABLE cycle_count_line
      ADD CONSTRAINT chk_cycle_count_line_counted_non_negative CHECK (counted_quantity >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON cycle_count TO app_user;
    GRANT INSERT, SELECT, UPDATE ON cycle_count_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON cycle_count TO readonly_user;
    GRANT SELECT ON cycle_count_line TO readonly_user;
  END IF;
END $$;
