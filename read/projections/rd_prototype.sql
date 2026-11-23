CREATE TABLE IF NOT EXISTS rd_prototype (
  prototype_id UUID PRIMARY KEY,
  build_id UUID NOT NULL,
  project_code TEXT NOT NULL,
  sku TEXT NOT NULL,
  serial_number TEXT NOT NULL,
  lot_id TEXT NOT NULL,
  location_id UUID NOT NULL,
  stock_class TEXT NOT NULL DEFAULT 'prototype',
  built_quantity NUMERIC(18,6) NOT NULL,
  uom TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered',
  source_event_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rd_prototype_stock_class CHECK (stock_class = 'prototype'),
  CONSTRAINT chk_rd_prototype_built_quantity_positive CHECK (built_quantity > 0),
  CONSTRAINT chk_rd_prototype_status CHECK (status IN ('registered','disposed')),
  CONSTRAINT uq_rd_prototype_serial_identity UNIQUE (sku, lot_id, location_id, serial_number, stock_class)
);

CREATE INDEX IF NOT EXISTS idx_rd_prototype_project ON rd_prototype (project_code, created_at);
CREATE INDEX IF NOT EXISTS idx_rd_prototype_build ON rd_prototype (build_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_rd_prototype_stock_class' AND conrelid = 'rd_prototype'::regclass) THEN
    ALTER TABLE rd_prototype ADD CONSTRAINT chk_rd_prototype_stock_class CHECK (stock_class = 'prototype');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_rd_prototype_built_quantity_positive' AND conrelid = 'rd_prototype'::regclass) THEN
    ALTER TABLE rd_prototype ADD CONSTRAINT chk_rd_prototype_built_quantity_positive CHECK (built_quantity > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_rd_prototype_status' AND conrelid = 'rd_prototype'::regclass) THEN
    ALTER TABLE rd_prototype ADD CONSTRAINT chk_rd_prototype_status CHECK (status IN ('registered','disposed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_rd_prototype_serial_identity' AND conrelid = 'rd_prototype'::regclass) THEN
    -- A database migrated from an earlier index-only definition keeps the unique index under the
    -- same name without a constraint behind it, so adding the constraint collides. Drop that index
    -- first so the constraint becomes the single canonical object.
    IF EXISTS (
      SELECT 1 FROM pg_class i
      JOIN pg_index ix ON ix.indexrelid = i.oid
      WHERE i.relname = 'uq_rd_prototype_serial_identity' AND ix.indrelid = 'rd_prototype'::regclass
    ) THEN
      DROP INDEX uq_rd_prototype_serial_identity;
    END IF;
    ALTER TABLE rd_prototype ADD CONSTRAINT uq_rd_prototype_serial_identity UNIQUE (sku, lot_id, location_id, serial_number, stock_class);
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON rd_prototype TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON rd_prototype TO readonly_user;
  END IF;
END $$;
