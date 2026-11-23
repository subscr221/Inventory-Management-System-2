CREATE TABLE IF NOT EXISTS rd_project_wip_ledger (
  posting_id UUID PRIMARY KEY,
  project_code TEXT NOT NULL,
  posting_type TEXT NOT NULL,
  issue_cost_id UUID NOT NULL,
  rd_issue_id UUID NOT NULL,
  requisition_id UUID NOT NULL,
  requisition_line_id UUID NOT NULL,
  sku TEXT NOT NULL,
  quantity NUMERIC(18,6) NOT NULL,
  open_quantity NUMERIC(18,6),
  unit_cost NUMERIC(18,6),
  posting_value NUMERIC(18,4) NOT NULL,
  reason_code TEXT,
  source_posting_id UUID,
  source_event_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rd_project_wip_posting_type CHECK (posting_type IN ('issue','return')),
  CONSTRAINT chk_rd_project_wip_quantity_positive CHECK (quantity > 0),
  CONSTRAINT chk_rd_project_wip_posting_pairing CHECK (
    (posting_type = 'issue' AND source_posting_id IS NULL AND reason_code IS NULL AND open_quantity IS NOT NULL)
    OR
    (posting_type = 'return' AND source_posting_id IS NOT NULL AND reason_code IS NOT NULL AND open_quantity IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_rd_project_wip_project ON rd_project_wip_ledger (project_code, sku);
CREATE INDEX IF NOT EXISTS idx_rd_project_wip_source_posting ON rd_project_wip_ledger (source_posting_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rd_project_wip_issue_cost ON rd_project_wip_ledger (issue_cost_id) WHERE posting_type = 'issue';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_rd_project_wip_posting_type' AND conrelid = 'rd_project_wip_ledger'::regclass) THEN
    ALTER TABLE rd_project_wip_ledger ADD CONSTRAINT chk_rd_project_wip_posting_type CHECK (posting_type IN ('issue','return'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_rd_project_wip_quantity_positive' AND conrelid = 'rd_project_wip_ledger'::regclass) THEN
    ALTER TABLE rd_project_wip_ledger ADD CONSTRAINT chk_rd_project_wip_quantity_positive CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_rd_project_wip_posting_pairing' AND conrelid = 'rd_project_wip_ledger'::regclass) THEN
    ALTER TABLE rd_project_wip_ledger ADD CONSTRAINT chk_rd_project_wip_posting_pairing CHECK (
      (posting_type = 'issue' AND source_posting_id IS NULL AND reason_code IS NULL AND open_quantity IS NOT NULL)
      OR
      (posting_type = 'return' AND source_posting_id IS NOT NULL AND reason_code IS NOT NULL AND open_quantity IS NULL)
    );
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON rd_project_wip_ledger TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON rd_project_wip_ledger TO readonly_user;
  END IF;
END $$;
