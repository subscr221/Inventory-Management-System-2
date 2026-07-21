-- Stock balance read model (Story 2.2). This file is the CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its
-- OWN grants (guarded DO blocks) so a migrate-provisioned database can serve stock-balance
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying stock.* domain events; source-of-truth
-- mutation happens exclusively through persistEvent, which applies this projection inside the
-- SAME transaction as the domain_events insert. Grain is (sku, location_id, lot_id) with
-- NULLS NOT DISTINCT so un-lotted stock occupies exactly one row per sku+location; the Story 2.2
-- stock query aggregates rows per location. `available` is a generated column (on_hand -
-- allocated) so it can never be written directly - clients never post an available value.
-- lot_id (Story 2.3), stock_class (Story 2.8) and in_transit (Story 2.5) are carried for
-- downstream stories; only receipt/allocation mutate rows in Story 2.2.

CREATE TABLE IF NOT EXISTS stock_balance (
  balance_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku           TEXT NOT NULL,
  location_id   UUID NOT NULL,
  location_code TEXT,
  lot_id        TEXT,
  stock_class   TEXT NOT NULL DEFAULT 'owned',
  on_hand       NUMERIC(18, 6) NOT NULL DEFAULT 0,
  allocated     NUMERIC(18, 6) NOT NULL DEFAULT 0,
  in_transit    NUMERIC(18, 6) NOT NULL DEFAULT 0,
  available     NUMERIC(18, 6) GENERATED ALWAYS AS (on_hand - allocated) STORED,
  last_issue_at TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_stock_balance_grain UNIQUE NULLS NOT DISTINCT (sku, location_id, lot_id, stock_class),
  CONSTRAINT chk_stock_balance_on_hand_non_negative CHECK (on_hand >= 0),
  CONSTRAINT chk_stock_balance_allocated_non_negative CHECK (allocated >= 0),
  CONSTRAINT chk_stock_balance_allocated_within_on_hand CHECK (allocated <= on_hand),
  CONSTRAINT chk_stock_balance_in_transit_non_negative CHECK (in_transit >= 0)
);

-- Story 2.7: last_issue_at tracks the most recent outbound consumption (stock.issued only) per
-- (sku, location_id, lot_id, stock_class); the obsolescence scan reads MAX(last_issue_at) across
-- lots at (sku, location_id). Added idempotently so a live Story 2.2 database gains the column
-- without a table rebuild. It is nullable and independent of the generated `available` column and
-- the grain, so the Story 2.2 on_hand/allocated/available/in_transit invariants are unchanged.
ALTER TABLE stock_balance ADD COLUMN IF NOT EXISTS last_issue_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_stock_balance_on_hand_non_negative'
      AND conrelid = 'stock_balance'::regclass
  ) THEN
    ALTER TABLE stock_balance
      ADD CONSTRAINT chk_stock_balance_on_hand_non_negative CHECK (on_hand >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_stock_balance_allocated_non_negative'
      AND conrelid = 'stock_balance'::regclass
  ) THEN
    ALTER TABLE stock_balance
      ADD CONSTRAINT chk_stock_balance_allocated_non_negative CHECK (allocated >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_stock_balance_allocated_within_on_hand'
      AND conrelid = 'stock_balance'::regclass
  ) THEN
    ALTER TABLE stock_balance
      ADD CONSTRAINT chk_stock_balance_allocated_within_on_hand CHECK (allocated <= on_hand);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_stock_balance_in_transit_non_negative'
      AND conrelid = 'stock_balance'::regclass
  ) THEN
    ALTER TABLE stock_balance
      ADD CONSTRAINT chk_stock_balance_in_transit_non_negative CHECK (in_transit >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_stock_balance_grain'
      AND conrelid = 'stock_balance'::regclass
  ) THEN
    ALTER TABLE stock_balance DROP CONSTRAINT uq_stock_balance_grain;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_stock_balance_grain'
      AND conrelid = 'stock_balance'::regclass
  ) THEN
    ALTER TABLE stock_balance
      ADD CONSTRAINT uq_stock_balance_grain UNIQUE NULLS NOT DISTINCT (sku, location_id, lot_id, stock_class);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON stock_balance TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON stock_balance TO readonly_user;
  END IF;
END $$;
