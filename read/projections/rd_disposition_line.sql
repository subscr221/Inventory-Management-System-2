CREATE TABLE IF NOT EXISTS rd_disposition_line (
  line_id UUID PRIMARY KEY,
  disposition_id UUID NOT NULL,
  line_no INTEGER NOT NULL,
  component_sku TEXT NOT NULL,
  quantity NUMERIC(18,6) NOT NULL,
  condition_code TEXT NOT NULL,
  source_event_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rd_disposition_line_no CHECK (line_no > 0),
  CONSTRAINT chk_rd_disposition_line_quantity_positive CHECK (quantity > 0),
  CONSTRAINT uq_rd_disposition_line_no UNIQUE (disposition_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_rd_disposition_line_disposition ON rd_disposition_line (disposition_id, line_no);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_rd_disposition_line_no' AND conrelid = 'rd_disposition_line'::regclass) THEN
    ALTER TABLE rd_disposition_line ADD CONSTRAINT chk_rd_disposition_line_no CHECK (line_no > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_rd_disposition_line_quantity_positive' AND conrelid = 'rd_disposition_line'::regclass) THEN
    ALTER TABLE rd_disposition_line ADD CONSTRAINT chk_rd_disposition_line_quantity_positive CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_rd_disposition_line_no' AND conrelid = 'rd_disposition_line'::regclass) THEN
    ALTER TABLE rd_disposition_line ADD CONSTRAINT uq_rd_disposition_line_no UNIQUE (disposition_id, line_no);
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON rd_disposition_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON rd_disposition_line TO readonly_user;
  END IF;
END $$;
