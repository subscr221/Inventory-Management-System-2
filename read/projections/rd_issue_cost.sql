-- Story 10.2 (FR-AC-02/03): the immutable R&D issue costing record. Append-only (app_user holds
-- INSERT, SELECT): a cost row is written once per issued line and is never flipped between
-- expensed and capitalized, which makes retroactive reinstatement structurally impossible.

CREATE TABLE IF NOT EXISTS rd_issue_cost (
  issue_cost_id                 UUID PRIMARY KEY,
  issue_id                      UUID NOT NULL,
  requisition_id                UUID NOT NULL,
  requisition_line_id           UUID NOT NULL,
  project_code                  TEXT NOT NULL,
  issue_type                    TEXT NOT NULL,
  phase                         TEXT NOT NULL,
  capitalization                TEXT NOT NULL,
  capitalization_blocked_reason TEXT,
  checklist_reference           TEXT,
  cost_amount                   NUMERIC(18,4) NOT NULL,
  unit_cost                     NUMERIC(18,6),
  business_date                 DATE NOT NULL,
  source_event_id               UUID NOT NULL,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rd_issue_cost_capitalization CHECK (capitalization IN ('expensed', 'capitalized')),
  CONSTRAINT chk_rd_issue_cost_issue_type CHECK (issue_type IN ('consumable', 'project_material')),
  CONSTRAINT chk_rd_issue_cost_phase CHECK (phase IN ('research', 'development')),
  CONSTRAINT chk_rd_issue_cost_amount CHECK (cost_amount >= 0)
);

CREATE INDEX IF NOT EXISTS idx_rd_issue_cost_project ON rd_issue_cost (project_code);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'rd_issue_cost'
      AND indexname = 'uq_rd_issue_cost_source_event'
      AND indexdef NOT LIKE '%(source_event_id, issue_cost_id)%'
  ) THEN
    DROP INDEX IF EXISTS uq_rd_issue_cost_source_event;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_rd_issue_cost_source_event ON rd_issue_cost (source_event_id, issue_cost_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rd_issue_cost_issue_line ON rd_issue_cost (issue_id, requisition_line_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_issue_cost_capitalization'
      AND conrelid = 'rd_issue_cost'::regclass
  ) THEN
    ALTER TABLE rd_issue_cost
      ADD CONSTRAINT chk_rd_issue_cost_capitalization CHECK (capitalization IN ('expensed', 'capitalized'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_issue_cost_issue_type'
      AND conrelid = 'rd_issue_cost'::regclass
  ) THEN
    ALTER TABLE rd_issue_cost
      ADD CONSTRAINT chk_rd_issue_cost_issue_type CHECK (issue_type IN ('consumable', 'project_material'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_issue_cost_phase'
      AND conrelid = 'rd_issue_cost'::regclass
  ) THEN
    ALTER TABLE rd_issue_cost
      ADD CONSTRAINT chk_rd_issue_cost_phase CHECK (phase IN ('research', 'development'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_issue_cost_amount'
      AND conrelid = 'rd_issue_cost'::regclass
  ) THEN
    ALTER TABLE rd_issue_cost
      ADD CONSTRAINT chk_rd_issue_cost_amount CHECK (cost_amount >= 0);
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON rd_issue_cost TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON rd_issue_cost TO readonly_user;
  END IF;
END $$;
