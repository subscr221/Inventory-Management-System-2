CREATE TABLE IF NOT EXISTS grn_line (
  grn_line_id                UUID PRIMARY KEY,
  grn_id                     UUID NOT NULL,
  po_ref_ext                 TEXT NOT NULL,
  line_no                    INTEGER NOT NULL,
  sku                        TEXT NOT NULL,
  lot_id                     TEXT,
  expiry_date                DATE,
  received_qty               NUMERIC(18,3) NOT NULL,
  uom                        TEXT NOT NULL,
  stock_class                TEXT NOT NULL DEFAULT 'owned',
  weighbridge_correlation_id UUID NOT NULL,
  qc_hold                    BOOLEAN NOT NULL DEFAULT false,
  shortage_variance_qty      NUMERIC(18,3) NOT NULL DEFAULT 0,
  target_location_id         UUID,
  status                     TEXT NOT NULL DEFAULT 'posted',
  rejection_reason           TEXT,
  source_event_id            UUID NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_grn_line_received_positive CHECK (received_qty > 0),
  CONSTRAINT chk_grn_line_status CHECK (status IN ('posted', 'quarantined', 'rejected')),
  CONSTRAINT chk_grn_line_shortage_non_negative CHECK (shortage_variance_qty >= 0)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_grn_line_received_positive'
      AND conrelid = 'grn_line'::regclass
  ) THEN
    ALTER TABLE grn_line
      ADD CONSTRAINT chk_grn_line_received_positive CHECK (received_qty > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_grn_line_status'
      AND conrelid = 'grn_line'::regclass
  ) THEN
    ALTER TABLE grn_line
      ADD CONSTRAINT chk_grn_line_status CHECK (status IN ('posted', 'quarantined', 'rejected'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_grn_line_shortage_non_negative'
      AND conrelid = 'grn_line'::regclass
  ) THEN
    ALTER TABLE grn_line
      ADD CONSTRAINT chk_grn_line_shortage_non_negative CHECK (shortage_variance_qty >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_grn_line_grn ON grn_line (grn_id);
CREATE INDEX IF NOT EXISTS idx_grn_line_po_line ON grn_line (po_ref_ext, line_no);
CREATE INDEX IF NOT EXISTS idx_grn_line_sku ON grn_line (sku);
CREATE INDEX IF NOT EXISTS idx_grn_line_shortage ON grn_line (shortage_variance_qty);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON grn_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON grn_line TO readonly_user;
  END IF;
END $$;
