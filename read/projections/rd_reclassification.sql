-- R&D lot reclassification requests (Story 10.1, FR-RD-02). An approved row whose approver differs
-- from the requester releases an R&D-designated lot to non-R&D demand. Idempotent; own grants.

CREATE TABLE IF NOT EXISTS rd_reclassification (
  reclassification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id              UUID NOT NULL,
  from_demand         TEXT NOT NULL DEFAULT 'rd',
  to_demand           TEXT NOT NULL DEFAULT 'non_rd',
  requested_by        UUID NOT NULL,
  approved_by         UUID,
  status              TEXT NOT NULL DEFAULT 'pending',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rd_reclassification_status CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT chk_rd_reclassification_approver CHECK (
    status <> 'approved' OR (approved_by IS NOT NULL AND approved_by <> requested_by)
  )
);

CREATE INDEX IF NOT EXISTS idx_rd_reclassification_lot ON rd_reclassification (lot_id, status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_rd_reclassification_lot'
      AND conrelid = 'rd_reclassification'::regclass
  ) THEN
    ALTER TABLE rd_reclassification
      ADD CONSTRAINT fk_rd_reclassification_lot FOREIGN KEY (lot_id) REFERENCES lot_master (lot_id);
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON rd_reclassification TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON rd_reclassification TO readonly_user;
  END IF;
END $$;
