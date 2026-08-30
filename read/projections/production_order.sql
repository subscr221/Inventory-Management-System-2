-- Production order read model (Story 6.1, FR-MO-01/02/03, AD-5). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying production_order.* domain events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert. status is the six-state lifecycle machine (Table 2):
-- planned -> released -> in_process -> completed -> closed, with planned|released -> cancelled.
-- order_number_ext is server-allocated from production_order_number_seq in the MO-YYYY-NNNN format
-- (the IND-YYYY-NNNN pattern, with an MO- prefix so the PO- namespace owned by purchase orders is
-- never entered) and immutable thereafter: the applier allocates the number and writes it back onto
-- the persisted payload, and any declared number that disagrees rejects ORDER_NUMBER_IMMUTABLE.
--
-- chk_production_order_expediting_pairing makes an expediting flag without a recorded overrider and
-- reason structurally impossible (AC6 enforced by the database). chk_production_order_unreversed_non_
-- negative makes a decrement below zero fail loudly in Story 6.2 rather than silently unlocking a
-- cancel that AC4 forbids. released_revision_id is deliberately nullable and set only at release:
-- the revision is pinned from the explosion result so a BOM released after creation cannot
-- retroactively change what a released order was gated against.

CREATE TABLE IF NOT EXISTS production_order (
  production_order_id       UUID PRIMARY KEY,
  order_number_ext          TEXT NOT NULL,
  output_item_id            UUID NOT NULL,
  output_sku                TEXT NOT NULL,
  order_quantity            NUMERIC(18,6) NOT NULL,
  order_uom                 TEXT NOT NULL,
  plant_location_id         UUID NOT NULL,
  bom_id                    UUID NOT NULL,
  released_revision_id      UUID,
  business_stream           TEXT NOT NULL,
  source_reference_type     TEXT NOT NULL,
  source_reference_id       TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'planned',
  expediting_flag           BOOLEAN NOT NULL DEFAULT false,
  override_by               UUID,
  override_reason           TEXT,
  released_at               TIMESTAMPTZ,
  released_by               UUID,
  cancelled_at              TIMESTAMPTZ,
  cancelled_by              UUID,
  unreversed_transaction_count INTEGER NOT NULL DEFAULT 0,
  created_by                UUID NOT NULL,
  correlation_id            UUID,
  source_event_id           UUID NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_production_order_status CHECK (status IN ('planned','released','in_process','completed','closed','cancelled')),
  CONSTRAINT chk_production_order_quantity_positive CHECK (order_quantity > 0),
  CONSTRAINT chk_production_order_source_reference_type CHECK (source_reference_type IN ('erp_sales_order','indent','rd_project','manual')),
  CONSTRAINT chk_production_order_unreversed_non_negative CHECK (unreversed_transaction_count >= 0),
  CONSTRAINT chk_production_order_expediting_pairing CHECK ((expediting_flag = true AND override_by IS NOT NULL AND override_reason IS NOT NULL AND btrim(override_reason) <> '') OR (expediting_flag = false AND override_by IS NULL AND override_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_production_order_number_ext ON production_order (order_number_ext);
CREATE INDEX IF NOT EXISTS idx_production_order_status ON production_order (status);
CREATE INDEX IF NOT EXISTS idx_production_order_plant ON production_order (plant_location_id);
CREATE INDEX IF NOT EXISTS idx_production_order_output_item ON production_order (output_item_id);
CREATE INDEX IF NOT EXISTS idx_production_order_bom ON production_order (bom_id);
CREATE INDEX IF NOT EXISTS idx_production_order_business_stream ON production_order (business_stream);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_status'
      AND conrelid = 'production_order'::regclass
  ) THEN
    ALTER TABLE production_order
      ADD CONSTRAINT chk_production_order_status CHECK (status IN ('planned','released','in_process','completed','closed','cancelled'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_quantity_positive'
      AND conrelid = 'production_order'::regclass
  ) THEN
    ALTER TABLE production_order
      ADD CONSTRAINT chk_production_order_quantity_positive CHECK (order_quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_source_reference_type'
      AND conrelid = 'production_order'::regclass
  ) THEN
    ALTER TABLE production_order
      ADD CONSTRAINT chk_production_order_source_reference_type CHECK (source_reference_type IN ('erp_sales_order','indent','rd_project','manual'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_unreversed_non_negative'
      AND conrelid = 'production_order'::regclass
  ) THEN
    ALTER TABLE production_order
      ADD CONSTRAINT chk_production_order_unreversed_non_negative CHECK (unreversed_transaction_count >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_expediting_pairing'
      AND conrelid = 'production_order'::regclass
  ) THEN
    ALTER TABLE production_order
      ADD CONSTRAINT chk_production_order_expediting_pairing CHECK ((expediting_flag = true AND override_by IS NOT NULL AND override_reason IS NOT NULL AND btrim(override_reason) <> '') OR (expediting_flag = false AND override_by IS NULL AND override_reason IS NULL));
  END IF;
END $$;

-- Story 6.3 (FR-MO-07/09/10) column upgrade. These columns are added by a GUARDED ALTER rather
-- than being written into the CREATE TABLE above, so the file stays re-appliable against a live
-- database provisioned before Story 6.3 (the Story 8.4 review lesson: an unguarded ADD COLUMN
-- breaks re-application). completed_quantity accumulates the PRIMARY output only - co-products and
-- by-products are separate outputs and never count toward the ordered quantity. The three
-- short_close_* columns are the FR-MO-09 close-short decision Story 6.4's closure gate reads; the
-- pairing CHECK makes a half-recorded decision structurally impossible. source_rework_event_id and
-- source_lot_id are the FR-MO-10 rework linkage: a rework order is an ordinary production order
-- (Binding Decision 9), and the partial unique index makes one rework order per qc.rework_requested
-- event a database fact rather than a check-then-act race.
ALTER TABLE production_order ADD COLUMN IF NOT EXISTS completed_quantity     NUMERIC(18,6) NOT NULL DEFAULT 0;
ALTER TABLE production_order ADD COLUMN IF NOT EXISTS scrapped_quantity      NUMERIC(18,6) NOT NULL DEFAULT 0;
ALTER TABLE production_order ADD COLUMN IF NOT EXISTS short_close_reason     TEXT;
ALTER TABLE production_order ADD COLUMN IF NOT EXISTS short_closed_at        TIMESTAMPTZ;
ALTER TABLE production_order ADD COLUMN IF NOT EXISTS short_closed_by        UUID;
ALTER TABLE production_order ADD COLUMN IF NOT EXISTS source_rework_event_id UUID;
ALTER TABLE production_order ADD COLUMN IF NOT EXISTS source_lot_id          UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_completed_non_negative'
      AND conrelid = 'production_order'::regclass
  ) THEN
    ALTER TABLE production_order
      ADD CONSTRAINT chk_production_order_completed_non_negative CHECK (completed_quantity >= 0 AND scrapped_quantity >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_short_close_pairing'
      AND conrelid = 'production_order'::regclass
  ) THEN
    ALTER TABLE production_order
      ADD CONSTRAINT chk_production_order_short_close_pairing CHECK ((short_close_reason IS NOT NULL AND btrim(short_close_reason) <> '' AND short_closed_at IS NOT NULL AND short_closed_by IS NOT NULL) OR (short_close_reason IS NULL AND short_closed_at IS NULL AND short_closed_by IS NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_order_rework_pairing'
      AND conrelid = 'production_order'::regclass
  ) THEN
    ALTER TABLE production_order
      ADD CONSTRAINT chk_production_order_rework_pairing CHECK ((source_rework_event_id IS NOT NULL AND source_lot_id IS NOT NULL) OR (source_rework_event_id IS NULL AND source_lot_id IS NULL));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_production_order_source_rework_event ON production_order (source_rework_event_id) WHERE source_rework_event_id IS NOT NULL;

-- Server-side human-ID allocation for the MO-YYYY-NNNN format. A sequence is the only lock-free
-- allocator that survives concurrent creations; the year prefix is applied in the applier. Gaps on
-- rolled-back creates are acceptable - uniqueness is what matters (the indent_number_seq precedent).
CREATE SEQUENCE IF NOT EXISTS production_order_number_seq;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON production_order TO app_user;
    GRANT USAGE ON SEQUENCE production_order_number_seq TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON production_order TO readonly_user;
  END IF;
END $$;
