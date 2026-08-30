-- Production completion read model (Story 6.3, FR-MO-07/09, AD-5). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying production_order.completion_posted events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert.
--
-- The grain is ONE ROW PER OUTPUT LOT, not one row per completion event: a single completion posts
-- the primary output plus every co-product and by-product line of the pinned released revision, and
-- each of those is its own lot with its own Story 8.1 inspection task (AC 3). completion_id is also
-- the source_completion_id handed to the QC gate, so the gate's unique-source guard and this table's
-- primary key are the same identity.
--
-- The table is APPEND-ONLY (app_user holds INSERT/SELECT only, the production_wip_ledger
-- precedent). A completion is a posted fact; a correction is a new event, never an UPDATE.
--
-- output_class 'primary' rows carry a NULL bom_line_id (the primary output is the order's own
-- output_item_id, not a BOM line), so the grain UNIQUE uses NULLS NOT DISTINCT - without it two
-- primary rows for the same event would both be admitted.

CREATE TABLE IF NOT EXISTS production_completion (
  completion_id             UUID PRIMARY KEY,
  production_order_id       UUID NOT NULL,
  output_class              TEXT NOT NULL,
  bom_line_id               UUID,
  output_item_id            UUID NOT NULL,
  output_sku                TEXT NOT NULL,
  lot_id                    UUID NOT NULL,
  lot_number                TEXT NOT NULL,
  quantity                  NUMERIC(18,6) NOT NULL,
  uom                       TEXT NOT NULL,
  qc_task_id                UUID NOT NULL,
  plant_location_id         UUID NOT NULL,
  business_date             DATE NOT NULL,
  over_completion_approved  BOOLEAN NOT NULL DEFAULT false,
  approved_by               UUID,
  completed_by              UUID NOT NULL,
  completed_at              TIMESTAMPTZ NOT NULL,
  source_event_id           UUID NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_production_completion_output_class CHECK (output_class IN ('primary','co_product','by_product')),
  CONSTRAINT chk_production_completion_quantity_positive CHECK (quantity > 0),
  CONSTRAINT chk_production_completion_line_pairing CHECK ((output_class = 'primary' AND bom_line_id IS NULL) OR (output_class IN ('co_product','by_product') AND bom_line_id IS NOT NULL)),
  CONSTRAINT chk_production_completion_approval_pairing CHECK ((over_completion_approved = true AND approved_by IS NOT NULL) OR (over_completion_approved = false AND approved_by IS NULL)),
  CONSTRAINT uq_production_completion_lot UNIQUE (lot_id),
  CONSTRAINT uq_production_completion_grain UNIQUE NULLS NOT DISTINCT (production_order_id, source_event_id, output_class, bom_line_id)
);

CREATE INDEX IF NOT EXISTS idx_production_completion_order ON production_completion (production_order_id);
CREATE INDEX IF NOT EXISTS idx_production_completion_task ON production_completion (qc_task_id);
CREATE INDEX IF NOT EXISTS idx_production_completion_item ON production_completion (output_item_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_completion_output_class'
      AND conrelid = 'production_completion'::regclass
  ) THEN
    ALTER TABLE production_completion
      ADD CONSTRAINT chk_production_completion_output_class CHECK (output_class IN ('primary','co_product','by_product'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_completion_quantity_positive'
      AND conrelid = 'production_completion'::regclass
  ) THEN
    ALTER TABLE production_completion
      ADD CONSTRAINT chk_production_completion_quantity_positive CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_completion_line_pairing'
      AND conrelid = 'production_completion'::regclass
  ) THEN
    ALTER TABLE production_completion
      ADD CONSTRAINT chk_production_completion_line_pairing CHECK ((output_class = 'primary' AND bom_line_id IS NULL) OR (output_class IN ('co_product','by_product') AND bom_line_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_completion_approval_pairing'
      AND conrelid = 'production_completion'::regclass
  ) THEN
    ALTER TABLE production_completion
      ADD CONSTRAINT chk_production_completion_approval_pairing CHECK ((over_completion_approved = true AND approved_by IS NOT NULL) OR (over_completion_approved = false AND approved_by IS NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_production_completion_lot'
      AND conrelid = 'production_completion'::regclass
  ) THEN
    ALTER TABLE production_completion
      ADD CONSTRAINT uq_production_completion_lot UNIQUE (lot_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_production_completion_grain'
      AND conrelid = 'production_completion'::regclass
  ) THEN
    ALTER TABLE production_completion
      ADD CONSTRAINT uq_production_completion_grain UNIQUE NULLS NOT DISTINCT (production_order_id, source_event_id, output_class, bom_line_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON production_completion TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON production_completion TO readonly_user;
  END IF;
END $$;
