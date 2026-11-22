-- Story 10.2 (FR-RD-04): R&D requisition lines. issued_quantity is the per-line issue lifecycle
-- counter: the issue seam refuses any issue exceeding requested_qty - issued_quantity with
-- RD_REQUISITION_LINE_EXCEEDED and increments it in the same transaction.

CREATE TABLE IF NOT EXISTS rd_requisition_line (
  requisition_line_id  UUID PRIMARY KEY,
  requisition_id       UUID NOT NULL,
  sku                  TEXT NOT NULL,
  requested_qty        NUMERIC(18,3) NOT NULL,
  issued_quantity      NUMERIC(18,3) NOT NULL DEFAULT 0,
  uom                  TEXT NOT NULL,
  unit_cost_estimate   NUMERIC(18,4) NOT NULL,
  line_value           NUMERIC(18,4) NOT NULL,
  issue_type           TEXT NOT NULL,
  source_event_id      UUID NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rd_requisition_line_qty CHECK (requested_qty > 0),
  CONSTRAINT chk_rd_requisition_line_issued CHECK (issued_quantity >= 0 AND issued_quantity <= requested_qty),
  CONSTRAINT chk_rd_requisition_line_value CHECK (line_value >= 0),
  CONSTRAINT chk_rd_requisition_line_value_fits CHECK (line_value < 100000000000000),
  CONSTRAINT chk_rd_requisition_line_issue_type CHECK (issue_type IN ('consumable', 'project_material', 'equipment_custody'))
);

CREATE INDEX IF NOT EXISTS idx_rd_requisition_line_requisition ON rd_requisition_line (requisition_id);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'rd_requisition_line'
      AND indexname = 'uq_rd_requisition_line_source_event'
      AND indexdef NOT LIKE '%(source_event_id, requisition_line_id)%'
  ) THEN
    DROP INDEX IF EXISTS uq_rd_requisition_line_source_event;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_rd_requisition_line_source_event ON rd_requisition_line (source_event_id, requisition_line_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_requisition_line_qty'
      AND conrelid = 'rd_requisition_line'::regclass
  ) THEN
    ALTER TABLE rd_requisition_line
      ADD CONSTRAINT chk_rd_requisition_line_qty CHECK (requested_qty > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_requisition_line_issued'
      AND conrelid = 'rd_requisition_line'::regclass
  ) THEN
    ALTER TABLE rd_requisition_line
      ADD CONSTRAINT chk_rd_requisition_line_issued CHECK (issued_quantity >= 0 AND issued_quantity <= requested_qty);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_requisition_line_value'
      AND conrelid = 'rd_requisition_line'::regclass
  ) THEN
    ALTER TABLE rd_requisition_line
      ADD CONSTRAINT chk_rd_requisition_line_value CHECK (line_value >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_requisition_line_value_fits'
      AND conrelid = 'rd_requisition_line'::regclass
  ) THEN
    ALTER TABLE rd_requisition_line
      ADD CONSTRAINT chk_rd_requisition_line_value_fits CHECK (line_value < 100000000000000);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_requisition_line_issue_type'
      AND conrelid = 'rd_requisition_line'::regclass
  ) THEN
    ALTER TABLE rd_requisition_line
      ADD CONSTRAINT chk_rd_requisition_line_issue_type CHECK (issue_type IN ('consumable', 'project_material', 'equipment_custody'));
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON rd_requisition_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON rd_requisition_line TO readonly_user;
  END IF;
END $$;
