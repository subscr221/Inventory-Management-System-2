-- Story 3.7: packing record projection
-- Grain: (packing_record_id)

CREATE TABLE IF NOT EXISTS packing_record (
  packing_record_id UUID PRIMARY KEY,
  dispatch_order_id UUID NOT NULL,
  sku TEXT NOT NULL,
  packed_qty NUMERIC(14,3) NOT NULL,
  lot_id UUID,
  actual_weight_kg NUMERIC(12,3),
  label_ref TEXT,
  carton_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'packed',
  packed_by UUID NOT NULL,
  packed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_packing_record_status'
  ) THEN
    ALTER TABLE packing_record ADD CONSTRAINT chk_packing_record_status
      CHECK (status IN ('packed', 'documents_generated', 'dispatched'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_packing_record_qty'
  ) THEN
    ALTER TABLE packing_record ADD CONSTRAINT chk_packing_record_qty
      CHECK (packed_qty > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_packing_record_carton'
  ) THEN
    ALTER TABLE packing_record ADD CONSTRAINT chk_packing_record_carton
      CHECK (carton_count >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_packing_record_dispatch_order ON packing_record (dispatch_order_id);
CREATE INDEX IF NOT EXISTS idx_packing_record_lot ON packing_record (lot_id);

-- Story 3.7: extend dispatch_order_status (created by Story 3.6) additively
ALTER TABLE dispatch_order_status ADD COLUMN IF NOT EXISTS packed_at TIMESTAMPTZ;
ALTER TABLE dispatch_order_status ADD COLUMN IF NOT EXISTS packed_by UUID;
ALTER TABLE dispatch_order_status ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
ALTER TABLE dispatch_order_status ADD COLUMN IF NOT EXISTS dispatched_by UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    RETURN;
  END IF;
  GRANT INSERT, SELECT, UPDATE ON packing_record TO app_user;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'readonly_user') THEN
    RETURN;
  END IF;
  GRANT SELECT ON packing_record TO readonly_user;
END
$$;
