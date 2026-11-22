-- Story 10.2 (FR-RD-04): R&D requisition header. The budget check and the owner/head dual
-- approval live in the rd_requisition.raised/approved/rejected seams; this projection is the
-- durable read model those seams write. source_event_id is the replay grain.

CREATE TABLE IF NOT EXISTS rd_requisition (
  requisition_id     UUID PRIMARY KEY,
  project_code       TEXT NOT NULL,
  requester_user_id  UUID NOT NULL,
  business_stream    TEXT NOT NULL,
  estimated_value    NUMERIC(18,4) NOT NULL,
  status             TEXT NOT NULL DEFAULT 'approved',
  budget_breach      BOOLEAN NOT NULL DEFAULT false,
  approver_actor_id  UUID,
  doa_entry_id       UUID,
  owner_approver_id  UUID,
  owner_approved_at  TIMESTAMPTZ,
  head_approved_at   TIMESTAMPTZ,
  decided_at         TIMESTAMPTZ,
  decided_by         UUID,
  rejection_reason   TEXT,
  source_event_id    UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rd_requisition_status CHECK (status IN ('approved', 'approval_required', 'rejected')),
  CONSTRAINT chk_rd_requisition_value CHECK (estimated_value >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rd_requisition_source_event ON rd_requisition (source_event_id);
CREATE INDEX IF NOT EXISTS idx_rd_requisition_project ON rd_requisition (project_code, status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_requisition_status'
      AND conrelid = 'rd_requisition'::regclass
  ) THEN
    ALTER TABLE rd_requisition
      ADD CONSTRAINT chk_rd_requisition_status CHECK (status IN ('approved', 'approval_required', 'rejected'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_requisition_value'
      AND conrelid = 'rd_requisition'::regclass
  ) THEN
    ALTER TABLE rd_requisition
      ADD CONSTRAINT chk_rd_requisition_value CHECK (estimated_value >= 0);
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON rd_requisition TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON rd_requisition TO readonly_user;
  END IF;
END $$;
