-- Purchase order line read model (Story 4.4). CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate); deploy/compose/init-db.sql duplicates this content
-- for first-boot container init - change both files together. Every statement is idempotent.
--
-- Derived state ONLY: rows are rebuildable by replaying purchase_order.* domain events; mutation happens
-- exclusively through persistEvent inside the same transaction as the domain_events insert.
-- Follows the indent.sql / indent_line.sql header-plus-line precedent. No FK to purchase_order
-- (same-transaction inserts; matches the indent_line design decision on the deferred ledger).

CREATE TABLE IF NOT EXISTS purchase_order_line (
  po_line_id             UUID PRIMARY KEY,
  po_id                  UUID NOT NULL,
  line_no                INTEGER NOT NULL,
  sku                    TEXT NOT NULL,
  item_category          TEXT NOT NULL,
  ordered_qty            NUMERIC(14,3) NOT NULL,
  uom                    TEXT NOT NULL,
  unit_price             NUMERIC(14,4) NOT NULL,
  tax_rate_pct           NUMERIC(5,2),
  line_value             NUMERIC(14,2) NOT NULL DEFAULT 0,
  promised_delivery_date DATE,
  CONSTRAINT uq_po_line_no UNIQUE (po_id, line_no),
  CONSTRAINT chk_po_line_qty_positive CHECK (ordered_qty > 0),
  CONSTRAINT chk_po_line_unit_price_non_negative CHECK (unit_price >= 0)
);

CREATE INDEX IF NOT EXISTS idx_po_line_sku ON purchase_order_line (sku);
CREATE INDEX IF NOT EXISTS idx_po_line_po_id ON purchase_order_line (po_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_po_line_qty_positive'
      AND conrelid = 'purchase_order_line'::regclass
  ) THEN
    ALTER TABLE purchase_order_line
      ADD CONSTRAINT chk_po_line_qty_positive CHECK (ordered_qty > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_po_line_no'
      AND conrelid = 'purchase_order_line'::regclass
  ) THEN
    ALTER TABLE purchase_order_line
      ADD CONSTRAINT uq_po_line_no UNIQUE (po_id, line_no);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_po_line_unit_price_non_negative'
      AND conrelid = 'purchase_order_line'::regclass
  ) THEN
    ALTER TABLE purchase_order_line
      ADD CONSTRAINT chk_po_line_unit_price_non_negative CHECK (unit_price >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON purchase_order_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON purchase_order_line TO readonly_user;
  END IF;
END $$;
