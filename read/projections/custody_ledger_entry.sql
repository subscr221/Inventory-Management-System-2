-- Job-work custody ledger read model (Story 9.3). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: one append-only ledger per (service_order_id, customer_party_code) with a
-- SIGNED quantity_delta per sku. Rows are rebuildable by replaying jobwork.material_received
-- (receipt rows, written by the Story 9.2 applier in the same transaction) and custody.* domain
-- events (consumption and own_material in 9.3). The running customer-owned balance is DERIVED:
-- SUM(quantity_delta) WHERE ownership = 'customer' under the order advisory lock for gates, a
-- window over rows for the statement. No balance table exists (Story 9.3 decision 1).
-- return, loss, offcut, dispatch and count_adjustment are forward-declared for Stories 9.4-9.6 so
-- they post into this table without a migration; no 9.3 path produces them. own_material is the
-- processor's own addition: ownership = 'processor', billable = true, never in the customer
-- balance (FR-JW-07). One ledger row per source event PER (sku, lot) - uq_custody_ledger_source_event
-- on (source_event_id, sku, lot_id) NULLS NOT DISTINCT - makes replay safe while letting one event
-- post several rows: a Story 9.4 dispatch apportions across every customer-supplied sku, and a
-- Story 9.5 physical-verification sign-off posts one count_adjustment per verified line (Story 9.5
-- Task 0 widened the original single-column index; the name is kept so the 23505 classification
-- arms still resolve). business_date is the IST calendar date of occurred_at (9.5 aging and ITC-04).

CREATE TABLE IF NOT EXISTS custody_ledger_entry (
  entry_id             UUID PRIMARY KEY,
  service_order_id     UUID NOT NULL,
  customer_party_code  TEXT NOT NULL,
  movement_category    TEXT NOT NULL,
  ownership            TEXT NOT NULL,
  sku                  TEXT NOT NULL,
  lot_id               TEXT,
  location_id          UUID,
  quantity_delta       NUMERIC(18,3) NOT NULL,
  uom                  TEXT NOT NULL,
  billable             BOOLEAN NOT NULL DEFAULT false,
  bom_line_id          UUID,
  kit_bom_revision_id  UUID,
  receipt_id           UUID,
  variance_qty         NUMERIC(18,3),
  variance_flagged     BOOLEAN,
  site_id              UUID NOT NULL,
  posted_by            UUID NOT NULL,
  occurred_at          TIMESTAMPTZ NOT NULL,
  business_date        DATE NOT NULL,
  source_event_id      UUID NOT NULL,
  source_event_type    TEXT NOT NULL,
  correlation_id       UUID,
  -- Story 9.5 code review (chunk 2): the external document number a movement cites. Populated
  -- for `return` with the mandatory return_challan_number_ext the shape assert already demands
  -- (goods leaving the job worker without a delivery challan is a GST offence), which was
  -- otherwise validated and then discarded into the raw event payload where no read model
  -- could see it. Nullable and free for other categories to adopt.
  reference_ext        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_custody_ledger_category CHECK (movement_category IN ('receipt','consumption','return','loss','offcut','dispatch','count_adjustment','own_material')),
  CONSTRAINT chk_custody_ledger_ownership_vocab CHECK (ownership IN ('customer','processor')),
  CONSTRAINT chk_custody_ledger_sign CHECK (
    (movement_category IN ('receipt','own_material') AND quantity_delta > 0)
    OR (movement_category IN ('consumption','return','loss','offcut','dispatch') AND quantity_delta < 0)
    OR (movement_category = 'count_adjustment' AND quantity_delta <> 0)
  ),
  CONSTRAINT chk_custody_ledger_ownership CHECK (
    (movement_category = 'own_material' AND ownership = 'processor' AND billable = true)
    OR (movement_category <> 'own_material' AND ownership = 'customer')
  )
);

-- Story 9.5 code review (chunk 2): additive upgrade path for a live database.
ALTER TABLE custody_ledger_entry ADD COLUMN IF NOT EXISTS reference_ext TEXT;

-- Story 9.5 Task 0: widen the replay key from (source_event_id) to (source_event_id, sku, lot_id).
-- Guarded: the DROP only fires while the OLD single-column definition is in place, so a re-apply
-- on an already-widened database is a no-op (migrate-twice idempotency).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'custody_ledger_entry'
      AND indexname = 'uq_custody_ledger_source_event'
      AND indexdef NOT LIKE '%(source_event_id, sku, lot_id)%'
  ) THEN
    DROP INDEX IF EXISTS uq_custody_ledger_source_event;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_custody_ledger_source_event ON custody_ledger_entry (source_event_id, sku, lot_id) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS idx_custody_ledger_order_time ON custody_ledger_entry (service_order_id, occurred_at, created_at);
CREATE INDEX IF NOT EXISTS idx_custody_ledger_order_sku ON custody_ledger_entry (service_order_id, ownership, sku);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_custody_ledger_category'
      AND conrelid = 'custody_ledger_entry'::regclass
  ) THEN
    ALTER TABLE custody_ledger_entry
      ADD CONSTRAINT chk_custody_ledger_category CHECK (movement_category IN ('receipt','consumption','return','loss','offcut','dispatch','count_adjustment','own_material'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_custody_ledger_ownership_vocab'
      AND conrelid = 'custody_ledger_entry'::regclass
  ) THEN
    ALTER TABLE custody_ledger_entry
      ADD CONSTRAINT chk_custody_ledger_ownership_vocab CHECK (ownership IN ('customer','processor'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_custody_ledger_sign'
      AND conrelid = 'custody_ledger_entry'::regclass
  ) THEN
    ALTER TABLE custody_ledger_entry
      ADD CONSTRAINT chk_custody_ledger_sign CHECK (
        (movement_category IN ('receipt','own_material') AND quantity_delta > 0)
        OR (movement_category IN ('consumption','return','loss','offcut','dispatch') AND quantity_delta < 0)
        OR (movement_category = 'count_adjustment' AND quantity_delta <> 0)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_custody_ledger_ownership'
      AND conrelid = 'custody_ledger_entry'::regclass
  ) THEN
    ALTER TABLE custody_ledger_entry
      ADD CONSTRAINT chk_custody_ledger_ownership CHECK (
        (movement_category = 'own_material' AND ownership = 'processor' AND billable = true)
        OR (movement_category <> 'own_material' AND ownership = 'customer')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON custody_ledger_entry TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON custody_ledger_entry TO readonly_user;
  END IF;
END $$;
