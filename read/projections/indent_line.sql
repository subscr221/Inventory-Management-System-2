-- Purchase requisition (indent) line read model (Story 4.3). CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate); deploy/compose/init-db.sql duplicates this content
-- for first-boot container init - change both files together. Every statement is idempotent.
--
-- Derived state ONLY: rows are rebuildable by replaying indent.* domain events; mutation happens
-- exclusively through persistEvent inside the same transaction as the domain_events insert.
-- Follows the grn.sql / grn_line.sql header-plus-line precedent.

CREATE TABLE IF NOT EXISTS indent_line (
  indent_line_id       UUID PRIMARY KEY,
  indent_id            UUID NOT NULL,
  line_no              INTEGER NOT NULL,
  sku                  TEXT NOT NULL,
  item_category        TEXT NOT NULL,
  requested_qty        NUMERIC(18,3) NOT NULL,
  uom                  TEXT NOT NULL,
  unit_price_estimate  NUMERIC(18,4),
  line_value           NUMERIC(18,4) NOT NULL DEFAULT 0,
  CONSTRAINT uq_indent_line_no UNIQUE (indent_id, line_no),
  CONSTRAINT chk_indent_line_qty_positive CHECK (requested_qty > 0)
);

CREATE INDEX IF NOT EXISTS idx_indent_line_sku ON indent_line (sku);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_indent_line_qty_positive'
      AND conrelid = 'indent_line'::regclass
  ) THEN
    ALTER TABLE indent_line
      ADD CONSTRAINT chk_indent_line_qty_positive CHECK (requested_qty > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_indent_line_no'
      AND conrelid = 'indent_line'::regclass
  ) THEN
    ALTER TABLE indent_line
      ADD CONSTRAINT uq_indent_line_no UNIQUE (indent_id, line_no);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON indent_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON indent_line TO readonly_user;
  END IF;
END $$;
