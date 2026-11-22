-- Story 10.2 (FR-RD-06): the R&D equipment custody register. An equipment loan drains stock via
-- applyStockIssue but writes no cost row and relieves no valuation (the loan keeps its value).
-- Overdue ageing is derived from expected_return_date, never stored. The return and custodian
-- confirmation flow is Story 10.5.

CREATE TABLE IF NOT EXISTS rd_equipment_custody (
  custody_id           UUID PRIMARY KEY,
  issue_id             UUID NOT NULL,
  requisition_id       UUID NOT NULL,
  requisition_line_id  UUID NOT NULL,
  project_code         TEXT NOT NULL,
  custodian_user_id    UUID NOT NULL,
  asset_id             UUID,
  sku                  TEXT NOT NULL,
  quantity             NUMERIC(18,3) NOT NULL,
  expected_return_date DATE NOT NULL,
  condition_codes      TEXT[] NOT NULL,
  status               TEXT NOT NULL DEFAULT 'on_loan',
  source_event_id      UUID NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rd_equipment_custody_status CHECK (status IN ('on_loan', 'returned')),
  CONSTRAINT chk_rd_equipment_custody_qty CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_rd_equipment_custody_custodian ON rd_equipment_custody (custodian_user_id, status);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'rd_equipment_custody'
      AND indexname = 'uq_rd_equipment_custody_source_event'
      AND indexdef NOT LIKE '%(source_event_id, custody_id)%'
  ) THEN
    DROP INDEX IF EXISTS uq_rd_equipment_custody_source_event;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_rd_equipment_custody_source_event ON rd_equipment_custody (source_event_id, custody_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rd_equipment_custody_issue_line ON rd_equipment_custody (issue_id, requisition_line_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_equipment_custody_status'
      AND conrelid = 'rd_equipment_custody'::regclass
  ) THEN
    ALTER TABLE rd_equipment_custody
      ADD CONSTRAINT chk_rd_equipment_custody_status CHECK (status IN ('on_loan', 'returned'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_equipment_custody_qty'
      AND conrelid = 'rd_equipment_custody'::regclass
  ) THEN
    ALTER TABLE rd_equipment_custody
      ADD CONSTRAINT chk_rd_equipment_custody_qty CHECK (quantity > 0);
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON rd_equipment_custody TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON rd_equipment_custody TO readonly_user;
  END IF;
END $$;
