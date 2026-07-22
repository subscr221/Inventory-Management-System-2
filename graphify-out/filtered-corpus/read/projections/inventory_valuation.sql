-- Inventory valuation read models (Story 2.4). This file is the CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its OWN
-- grants (guarded DO blocks) so a migrate-provisioned database can serve valuation reads/writes as
-- app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a live database
-- safely.
--
-- Valuation is tracked at SKU grain (NOT sku+location): Ind AS 2 costing pools apply per item, and
-- Story 2.3 already established that FIFO/FEFO physical lot selection cannot split a request
-- across lots while valuation costing still must be able to split across cost layers - so the
-- valuation layer is deliberately decoupled from stock_balance's sku+location+lot grain. All
-- monetary and quantity columns are NUMERIC; no valuation math is done in JavaScript floating
-- point (Dev Notes: Valuation Design Guardrails).

-- inventory_valuation: one row per SKU - the authoritative current carrying value regardless of
-- valuation_method. running_average_cost is populated for every method as a byproduct of the
-- additive update below but is only method-meaningful for weighted_average; FIFO and
-- specific_identification report cost from their own detail tables (layers / serial costs).
-- pre_writedown_cost is the cost the item was carried at immediately before its most recent
-- (still-open) write-down - the Ind AS 2 recovery ceiling - and is cleared once fully recovered.
CREATE TABLE IF NOT EXISTS inventory_valuation (
  sku                   TEXT PRIMARY KEY,
  quantity_on_hand      NUMERIC(18, 6) NOT NULL DEFAULT 0,
  running_average_cost  NUMERIC(18, 6),
  carrying_value        NUMERIC(20, 6) NOT NULL DEFAULT 0,
  pre_writedown_cost    NUMERIC(20, 6),
  cumulative_write_down NUMERIC(20, 6) NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_inventory_valuation_quantity_non_negative CHECK (quantity_on_hand >= 0),
  CONSTRAINT chk_inventory_valuation_carrying_value_non_negative CHECK (carrying_value >= 0),
  -- AC4 recovery cap, enforced at the database as a second line of defense independent of the
  -- compliance seam's own JS-side comparison (src/compliance/inventory-valuation.ts).
  CONSTRAINT chk_inventory_valuation_recovery_cap CHECK (pre_writedown_cost IS NULL OR carrying_value <= pre_writedown_cost)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_valuation_quantity_non_negative'
      AND conrelid = 'inventory_valuation'::regclass
  ) THEN
    ALTER TABLE inventory_valuation
      ADD CONSTRAINT chk_inventory_valuation_quantity_non_negative CHECK (quantity_on_hand >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_valuation_carrying_value_non_negative'
      AND conrelid = 'inventory_valuation'::regclass
  ) THEN
    ALTER TABLE inventory_valuation
      ADD CONSTRAINT chk_inventory_valuation_carrying_value_non_negative CHECK (carrying_value >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_valuation_recovery_cap'
      AND conrelid = 'inventory_valuation'::regclass
  ) THEN
    ALTER TABLE inventory_valuation
      ADD CONSTRAINT chk_inventory_valuation_recovery_cap CHECK (pre_writedown_cost IS NULL OR carrying_value <= pre_writedown_cost);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON inventory_valuation TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON inventory_valuation TO readonly_user;
  END IF;
END $$;

-- inventory_valuation_fifo_layer: one row per priced receipt for a FIFO-valued sku.
-- sequence_no is a single global monotonic counter (not per-sku) so "earliest received" ordering
-- is deterministic even when two layers share a created_at timestamp.
CREATE TABLE IF NOT EXISTS inventory_valuation_fifo_layer (
  layer_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                 TEXT NOT NULL,
  sequence_no         BIGSERIAL,
  unit_cost           NUMERIC(18, 6) NOT NULL,
  original_quantity   NUMERIC(18, 6) NOT NULL,
  remaining_quantity  NUMERIC(18, 6) NOT NULL,
  event_id            UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_inventory_valuation_fifo_layer_remaining_bounds CHECK (remaining_quantity >= 0 AND remaining_quantity <= original_quantity)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_valuation_fifo_layer_remaining_bounds'
      AND conrelid = 'inventory_valuation_fifo_layer'::regclass
  ) THEN
    ALTER TABLE inventory_valuation_fifo_layer
      ADD CONSTRAINT chk_inventory_valuation_fifo_layer_remaining_bounds CHECK (remaining_quantity >= 0 AND remaining_quantity <= original_quantity);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inventory_valuation_fifo_layer_sku_sequence ON inventory_valuation_fifo_layer (sku, sequence_no);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON inventory_valuation_fifo_layer TO app_user;
    GRANT USAGE, SELECT ON SEQUENCE inventory_valuation_fifo_layer_sequence_no_seq TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON inventory_valuation_fifo_layer TO readonly_user;
  END IF;
END $$;

-- inventory_valuation_serial_cost: received cost for a specific_identification serial, keyed by
-- (sku, serial_number) exactly like serial_master. `consumed_at` is stamped (not deleted) when the
-- serial is issued, so the sum of unconsumed rows for a sku is that sku's specific-identification
-- carrying value while the received-cost history stays queryable.
CREATE TABLE IF NOT EXISTS inventory_valuation_serial_cost (
  sku            TEXT NOT NULL,
  serial_number  TEXT NOT NULL,
  unit_cost      NUMERIC(18, 6) NOT NULL,
  consumed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_inventory_valuation_serial_cost PRIMARY KEY (sku, serial_number)
);

ALTER TABLE inventory_valuation_serial_cost ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON inventory_valuation_serial_cost TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON inventory_valuation_serial_cost TO readonly_user;
  END IF;
END $$;

-- inventory_valuation_nrv_adjustment: append-only NRV write-down/recovery ledger (AC4). Every row
-- is a full snapshot of the carrying-value transition it caused, so "recorded with date and
-- authoriser" and the recovery cap are both directly auditable without replaying events.
CREATE TABLE IF NOT EXISTS inventory_valuation_nrv_adjustment (
  adjustment_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                       TEXT NOT NULL,
  adjustment_type           TEXT NOT NULL,
  effective_date            DATE NOT NULL,
  authoriser_actor_id       UUID NOT NULL,
  original_cost             NUMERIC(20, 6) NOT NULL,
  carrying_value_before     NUMERIC(20, 6) NOT NULL,
  carrying_value_after      NUMERIC(20, 6) NOT NULL,
  amount                    NUMERIC(20, 6) NOT NULL,
  cumulative_write_down_after NUMERIC(20, 6) NOT NULL,
  reason                    TEXT NOT NULL,
  evidence_ref              TEXT,
  event_id                  UUID NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_inventory_valuation_nrv_adjustment_type CHECK (adjustment_type IN ('write_down', 'recovery'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_valuation_nrv_adjustment_type'
      AND conrelid = 'inventory_valuation_nrv_adjustment'::regclass
  ) THEN
    ALTER TABLE inventory_valuation_nrv_adjustment
      ADD CONSTRAINT chk_inventory_valuation_nrv_adjustment_type CHECK (adjustment_type IN ('write_down', 'recovery'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inventory_valuation_nrv_adjustment_sku ON inventory_valuation_nrv_adjustment (sku, created_at);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON inventory_valuation_nrv_adjustment TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON inventory_valuation_nrv_adjustment TO readonly_user;
  END IF;
END $$;

-- inventory_valuation_standard_cost_variance: period-end standard-versus-actual variance history
-- for items configured with the AC6 standard-cost measurement technique.
CREATE TABLE IF NOT EXISTS inventory_valuation_standard_cost_variance (
  variance_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku               TEXT NOT NULL,
  period            TEXT NOT NULL,
  standard_cost     NUMERIC(18, 6) NOT NULL,
  actual_cost       NUMERIC(18, 6) NOT NULL,
  variance_amount   NUMERIC(18, 6) NOT NULL,
  variance_percent  NUMERIC(9, 4),
  tolerance_percent NUMERIC(7, 4),
  breached          BOOLEAN NOT NULL DEFAULT false,
  event_id          UUID NOT NULL,
  reviewed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inventory_valuation_standard_cost_variance_sku_period UNIQUE (sku, period)
);

CREATE INDEX IF NOT EXISTS idx_inventory_valuation_standard_cost_variance_sku ON inventory_valuation_standard_cost_variance (sku, reviewed_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_inventory_valuation_standard_cost_variance_sku_period'
      AND conrelid = 'inventory_valuation_standard_cost_variance'::regclass
  ) THEN
    ALTER TABLE inventory_valuation_standard_cost_variance
      ADD CONSTRAINT uq_inventory_valuation_standard_cost_variance_sku_period UNIQUE (sku, period);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON inventory_valuation_standard_cost_variance TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON inventory_valuation_standard_cost_variance TO readonly_user;
  END IF;
END $$;
