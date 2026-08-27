-- Production order staging read model (Story 6.2, FR-MO-04, AD-5). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying production_order.material_staged /
-- production_order.material_issued domain events, and mutation happens exclusively through
-- persistEvent, which applies this projection inside the SAME transaction as the domain_events
-- insert. Grain is (production_order_id, bom_line_id): one row per directed-issue requirement
-- line. AC1's "pick tasks" ARE these rows - they are deliberately NOT Epic 3 pick_task rows, which
-- are dispatch-demand-scoped (ERP sales-order lines, allocated -> picked toward shipping). Staging
-- holds stock in `allocated` at the operator-named source bin until ISSUE drains it; the `picked`
-- bucket is never used here.
--
-- The UNIQUE (production_order_id, bom_line_id) grain is the replay/duplicate guard: a second
-- staging of the same line surfaces a 23505 mapped to 409 DUPLICATE_EVENT in the persistEvent
-- seam. status is 'allocated' -> 'issued' (full issues only transition; partial issues stay
-- 'allocated'), and chk_production_order_stage_issue_bound keeps issued_quantity within
-- required_quantity in the database - the same bound the issue applier enforces in SQL NUMERIC.
-- Recorded deviation (code-review decision 2026-08-28): app_user additionally carries DELETE so
-- the cancel applier can roll staged-but-unissued stock back to `available` and clear the stage
-- rows inside the production_order.cancelled transaction; nothing else deletes rows.

CREATE TABLE IF NOT EXISTS production_order_stage (
  stage_id             UUID PRIMARY KEY,
  production_order_id  UUID NOT NULL,
  bom_line_id          UUID NOT NULL,
  component_item_id    UUID NOT NULL,
  component_sku        TEXT NOT NULL,
  supply_method        TEXT NOT NULL,
  required_quantity    NUMERIC(18,6) NOT NULL,
  issued_quantity      NUMERIC(18,6) NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'allocated',
  source_location_id   UUID NOT NULL,
  lot_number           TEXT,
  source_event_id      UUID NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_production_order_stage_line UNIQUE (production_order_id, bom_line_id),
  CONSTRAINT chk_production_order_stage_supply_method CHECK (supply_method = 'directed_issue'),
  CONSTRAINT chk_production_order_stage_status CHECK (status IN ('allocated','issued')),
  CONSTRAINT chk_production_order_stage_required_positive CHECK (required_quantity > 0),
  CONSTRAINT chk_production_order_stage_issued_non_negative CHECK (issued_quantity >= 0),
  CONSTRAINT chk_production_order_stage_issue_bound CHECK (issued_quantity <= required_quantity)
);

CREATE INDEX IF NOT EXISTS idx_production_order_stage_order ON production_order_stage (production_order_id);
CREATE INDEX IF NOT EXISTS idx_production_order_stage_status ON production_order_stage (status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_stage_supply_method'
      AND conrelid = 'production_order_stage'::regclass
  ) THEN
    ALTER TABLE production_order_stage
      ADD CONSTRAINT chk_production_order_stage_supply_method CHECK (supply_method = 'directed_issue');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_stage_status'
      AND conrelid = 'production_order_stage'::regclass
  ) THEN
    ALTER TABLE production_order_stage
      ADD CONSTRAINT chk_production_order_stage_status CHECK (status IN ('allocated','issued'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_stage_required_positive'
      AND conrelid = 'production_order_stage'::regclass
  ) THEN
    ALTER TABLE production_order_stage
      ADD CONSTRAINT chk_production_order_stage_required_positive CHECK (required_quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_stage_issued_non_negative'
      AND conrelid = 'production_order_stage'::regclass
  ) THEN
    ALTER TABLE production_order_stage
      ADD CONSTRAINT chk_production_order_stage_issued_non_negative CHECK (issued_quantity >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_stage_issue_bound'
      AND conrelid = 'production_order_stage'::regclass
  ) THEN
    ALTER TABLE production_order_stage
      ADD CONSTRAINT chk_production_order_stage_issue_bound CHECK (issued_quantity <= required_quantity);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE, DELETE ON production_order_stage TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON production_order_stage TO readonly_user;
  END IF;
END $$;
