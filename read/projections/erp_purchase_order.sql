-- ERP open purchase-order reference projection (Story 2.9). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries
-- its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as
-- app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a live database
-- safely.
--
-- Reference data ONLY (INT-ERP-01): unlike every other Epic 2 projection these tables are NOT
-- event-sourced. They are populated by the inbound ERP sync adapter (src/adapters/erp/sync.ts) via
-- direct SQL upsert; ERP remains the master for PO lifecycle. Nothing on this platform mutates PO
-- state, and a receipt recorded against a projected line never writes back here. The grain is the
-- ERP-external PO reference po_number_ext (header) and (po_number_ext, line_no) (line). source_system
-- is server-set to 'ERP' and never trusted from the source payload; last_synced_at is server-set to
-- now(). Close/removal is soft (status = 'closed'), never hard-delete, so downstream references
-- resolve. over/under-receipt tolerances are NOT capped at 100% because valid ERP over-receipt
-- tolerances may exceed 100%.

CREATE TABLE IF NOT EXISTS erp_purchase_order (
  po_number_ext          TEXT PRIMARY KEY,
  supplier_ref_ext       TEXT NOT NULL,
  currency               TEXT NOT NULL,
  expected_delivery_date DATE,
  status                 TEXT NOT NULL DEFAULT 'open',
  source_system          TEXT NOT NULL DEFAULT 'ERP',
  last_synced_at         TIMESTAMPTZ NOT NULL,
  source_snapshot        JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_erp_purchase_order_status CHECK (status IN ('open', 'closed')),
  CONSTRAINT chk_erp_purchase_order_source_system CHECK (source_system = 'ERP')
);

CREATE TABLE IF NOT EXISTS erp_purchase_order_line (
  po_number_ext              TEXT NOT NULL,
  line_no                    INTEGER NOT NULL,
  sku                        TEXT NOT NULL,
  ordered_qty                NUMERIC(18, 3) NOT NULL,
  open_qty                   NUMERIC(18, 3) NOT NULL,
  unit_price                 NUMERIC(18, 4) NOT NULL,
  over_receipt_tolerance_pct  NUMERIC(9, 3),
  under_receipt_tolerance_pct NUMERIC(9, 3),
  source_system              TEXT NOT NULL DEFAULT 'ERP',
  last_synced_at             TIMESTAMPTZ NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (po_number_ext, line_no),
  CONSTRAINT chk_erp_po_line_ordered_non_negative CHECK (ordered_qty >= 0),
  CONSTRAINT chk_erp_po_line_open_within_ordered CHECK (open_qty >= 0 AND open_qty <= ordered_qty),
  CONSTRAINT chk_erp_po_line_unit_price_non_negative CHECK (unit_price >= 0),
  CONSTRAINT chk_erp_po_line_tolerance_non_negative CHECK ((over_receipt_tolerance_pct IS NULL OR over_receipt_tolerance_pct >= 0) AND (under_receipt_tolerance_pct IS NULL OR under_receipt_tolerance_pct >= 0))
);

CREATE INDEX IF NOT EXISTS idx_erp_purchase_order_line_sku ON erp_purchase_order_line (sku);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_erp_purchase_order_status'
      AND conrelid = 'erp_purchase_order'::regclass
  ) THEN
    ALTER TABLE erp_purchase_order
      ADD CONSTRAINT chk_erp_purchase_order_status CHECK (status IN ('open', 'closed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_erp_purchase_order_source_system'
      AND conrelid = 'erp_purchase_order'::regclass
  ) THEN
    ALTER TABLE erp_purchase_order
      ADD CONSTRAINT chk_erp_purchase_order_source_system CHECK (source_system = 'ERP');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_erp_po_line_ordered_non_negative'
      AND conrelid = 'erp_purchase_order_line'::regclass
  ) THEN
    ALTER TABLE erp_purchase_order_line
      ADD CONSTRAINT chk_erp_po_line_ordered_non_negative CHECK (ordered_qty >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_erp_po_line_open_within_ordered'
      AND conrelid = 'erp_purchase_order_line'::regclass
  ) THEN
    ALTER TABLE erp_purchase_order_line
      ADD CONSTRAINT chk_erp_po_line_open_within_ordered CHECK (open_qty >= 0 AND open_qty <= ordered_qty);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_erp_po_line_unit_price_non_negative'
      AND conrelid = 'erp_purchase_order_line'::regclass
  ) THEN
    ALTER TABLE erp_purchase_order_line
      ADD CONSTRAINT chk_erp_po_line_unit_price_non_negative CHECK (unit_price >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_erp_po_line_tolerance_non_negative'
      AND conrelid = 'erp_purchase_order_line'::regclass
  ) THEN
    ALTER TABLE erp_purchase_order_line
      ADD CONSTRAINT chk_erp_po_line_tolerance_non_negative CHECK ((over_receipt_tolerance_pct IS NULL OR over_receipt_tolerance_pct >= 0) AND (under_receipt_tolerance_pct IS NULL OR under_receipt_tolerance_pct >= 0));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON erp_purchase_order TO app_user;
    GRANT INSERT, SELECT, UPDATE ON erp_purchase_order_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON erp_purchase_order TO readonly_user;
    GRANT SELECT ON erp_purchase_order_line TO readonly_user;
  END IF;
END $$;
