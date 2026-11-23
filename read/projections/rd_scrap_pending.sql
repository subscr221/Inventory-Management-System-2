CREATE TABLE IF NOT EXISTS rd_scrap_pending (
  scrap_pending_id UUID PRIMARY KEY,
  disposition_id UUID NOT NULL,
  disposition_line_id UUID NOT NULL,
  prototype_id UUID NOT NULL,
  project_code TEXT NOT NULL,
  sku TEXT NOT NULL,
  quantity NUMERIC(18,6) NOT NULL,
  condition_code TEXT NOT NULL,
  source_prototype_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  source_event_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rd_scrap_pending_quantity_positive CHECK (quantity > 0),
  CONSTRAINT chk_rd_scrap_pending_status CHECK (status = 'pending')
);

CREATE INDEX IF NOT EXISTS idx_rd_scrap_pending_prototype ON rd_scrap_pending (prototype_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rd_scrap_pending_project ON rd_scrap_pending (project_code, created_at);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_rd_scrap_pending_quantity_positive' AND conrelid = 'rd_scrap_pending'::regclass) THEN
    ALTER TABLE rd_scrap_pending ADD CONSTRAINT chk_rd_scrap_pending_quantity_positive CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_rd_scrap_pending_status' AND conrelid = 'rd_scrap_pending'::regclass) THEN
    ALTER TABLE rd_scrap_pending ADD CONSTRAINT chk_rd_scrap_pending_status CHECK (status = 'pending');
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON rd_scrap_pending TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON rd_scrap_pending TO readonly_user;
  END IF;
END $$;
