-- Supplier invoice line read model (Story 4.7). CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate); deploy/compose/init-db.sql duplicates this content
-- for first-boot container init - change both files together. Every statement is idempotent.
--
-- Derived state ONLY: rows are derived exclusively at persist time from supplier_invoice.* domain events;
-- mutation happens exclusively through persistEvent inside the same transaction as the
-- domain_events insert. Follows the purchase_order.sql / purchase_order_line.sql header-plus-line
-- precedent. No FK to supplier_invoice (same-transaction inserts).

CREATE TABLE IF NOT EXISTS supplier_invoice_line (
  invoice_line_id   UUID PRIMARY KEY,
  invoice_id        UUID NOT NULL,
  line_no           INTEGER NOT NULL,
  po_line_id        UUID,
  sku               TEXT NOT NULL,
  quantity          NUMERIC(14,3) NOT NULL,
  uom               TEXT NOT NULL,
  unit_price        NUMERIC(14,4) NOT NULL,
  taxable_value     NUMERIC(14,2) NOT NULL,
  cgst_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  cess_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  line_total        NUMERIC(14,2) NOT NULL,
  CONSTRAINT uq_supplier_invoice_line_no UNIQUE (invoice_id, line_no),
  CONSTRAINT chk_supplier_invoice_line_qty_positive CHECK (quantity > 0),
  CONSTRAINT chk_supplier_invoice_line_amounts_non_negative CHECK (
    unit_price >= 0 AND taxable_value >= 0 AND cgst_amount >= 0 AND sgst_amount >= 0
    AND igst_amount >= 0 AND cess_amount >= 0 AND line_total >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_supplier_invoice_line_sku ON supplier_invoice_line (sku);
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_line_po_line ON supplier_invoice_line (po_line_id);
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_line_invoice_id ON supplier_invoice_line (invoice_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_supplier_invoice_line_no'
      AND conrelid = 'supplier_invoice_line'::regclass
  ) THEN
    ALTER TABLE supplier_invoice_line
      ADD CONSTRAINT uq_supplier_invoice_line_no UNIQUE (invoice_id, line_no);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_line_qty_positive'
      AND conrelid = 'supplier_invoice_line'::regclass
  ) THEN
    ALTER TABLE supplier_invoice_line
      ADD CONSTRAINT chk_supplier_invoice_line_qty_positive CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_line_amounts_non_negative'
      AND conrelid = 'supplier_invoice_line'::regclass
  ) THEN
    ALTER TABLE supplier_invoice_line
      ADD CONSTRAINT chk_supplier_invoice_line_amounts_non_negative CHECK (
        unit_price >= 0 AND taxable_value >= 0 AND cgst_amount >= 0 AND sgst_amount >= 0
        AND igst_amount >= 0 AND cess_amount >= 0 AND line_total >= 0
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON supplier_invoice_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON supplier_invoice_line TO readonly_user;
  END IF;
END $$;
