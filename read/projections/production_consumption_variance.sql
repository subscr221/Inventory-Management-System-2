-- Consumption variance read model (Story 6.4, FR-B-08, AD-5). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying the production_order.state_changed event
-- that closed the order; mutation happens exclusively through persistEvent, which applies this
-- projection inside the SAME transaction as the domain_events insert.
--
-- The grain is ONE ROW PER (production_order_id, bom_line_id): the closure gate computes the whole
-- report in one pass, so a second row for a line would mean the report ran twice - which the
-- lifecycle forbids, because completed -> closed fires exactly once per order.
--
-- The table is APPEND-ONLY (app_user holds INSERT/SELECT only, the production_completion
-- precedent). A variance line is a posted measurement at the instant of closure; a correction is a
-- new closure of a new order, never an UPDATE of this row.
--
-- expected_quantity carries the BOM scrap-percent expectation (base_quantity_per inflated by
-- bom_scrap_percent); expected_base_quantity is the same requirement WITHOUT any scrap allowance.
-- implied_scrap_percent = (actual_quantity / expected_base_quantity - 1) * 100 is therefore the
-- scrap-percent recalibration signal FR-B-08 hands to the BOM module: the scrap percent this run
-- actually exhibited, against the one the BOM declared. Both are null when the basis is zero
-- (an order closed with no primary output has no per-unit expectation to divide by).

CREATE TABLE IF NOT EXISTS production_consumption_variance (
  variance_id               UUID PRIMARY KEY,
  production_order_id       UUID NOT NULL,
  bom_line_id               UUID NOT NULL,
  component_item_id         UUID NOT NULL,
  component_sku             TEXT NOT NULL,
  supply_method             TEXT NOT NULL,
  basis_quantity            NUMERIC(18,6) NOT NULL,
  expected_quantity         NUMERIC(18,6) NOT NULL,
  expected_base_quantity    NUMERIC(18,6) NOT NULL,
  actual_quantity           NUMERIC(18,6) NOT NULL,
  variance_quantity         NUMERIC(18,6) NOT NULL,
  variance_percent          NUMERIC(12,4),
  bom_scrap_percent         NUMERIC(7,4),
  implied_scrap_percent     NUMERIC(12,4),
  tolerance_percent         NUMERIC(7,4) NOT NULL,
  tolerance_breached        BOOLEAN NOT NULL,
  revision_id               UUID NOT NULL,
  source_event_id           UUID NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_production_consumption_variance_supply_method CHECK (supply_method IN ('directed_issue','backflush')),
  CONSTRAINT chk_production_consumption_variance_quantities_non_negative CHECK (basis_quantity >= 0 AND expected_quantity >= 0 AND expected_base_quantity >= 0 AND actual_quantity >= 0),
  CONSTRAINT chk_production_consumption_variance_tolerance_range CHECK (tolerance_percent >= 0 AND tolerance_percent < 100),
  CONSTRAINT uq_production_consumption_variance_grain UNIQUE (production_order_id, bom_line_id)
);

CREATE INDEX IF NOT EXISTS idx_production_consumption_variance_order ON production_consumption_variance (production_order_id);
CREATE INDEX IF NOT EXISTS idx_production_consumption_variance_breached ON production_consumption_variance (tolerance_breached) WHERE tolerance_breached = true;
CREATE INDEX IF NOT EXISTS idx_production_consumption_variance_line ON production_consumption_variance (bom_line_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_consumption_variance_supply_method'
      AND conrelid = 'production_consumption_variance'::regclass
  ) THEN
    ALTER TABLE production_consumption_variance
      ADD CONSTRAINT chk_production_consumption_variance_supply_method CHECK (supply_method IN ('directed_issue','backflush'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_consumption_variance_quantities_non_negative'
      AND conrelid = 'production_consumption_variance'::regclass
  ) THEN
    ALTER TABLE production_consumption_variance
      ADD CONSTRAINT chk_production_consumption_variance_quantities_non_negative CHECK (basis_quantity >= 0 AND expected_quantity >= 0 AND expected_base_quantity >= 0 AND actual_quantity >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_consumption_variance_tolerance_range'
      AND conrelid = 'production_consumption_variance'::regclass
  ) THEN
    ALTER TABLE production_consumption_variance
      ADD CONSTRAINT chk_production_consumption_variance_tolerance_range CHECK (tolerance_percent >= 0 AND tolerance_percent < 100);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_production_consumption_variance_grain'
      AND conrelid = 'production_consumption_variance'::regclass
  ) THEN
    ALTER TABLE production_consumption_variance
      ADD CONSTRAINT uq_production_consumption_variance_grain UNIQUE (production_order_id, bom_line_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON production_consumption_variance TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON production_consumption_variance TO readonly_user;
  END IF;
END $$;
