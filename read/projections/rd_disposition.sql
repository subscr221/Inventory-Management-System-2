CREATE TABLE IF NOT EXISTS rd_disposition (
  disposition_id UUID PRIMARY KEY,
  prototype_id UUID NOT NULL,
  project_code TEXT NOT NULL,
  disposition_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approval_required',
  requester_actor_id UUID NOT NULL,
  approver_actor_id UUID NOT NULL,
  doa_entry_id UUID NOT NULL,
  approved_at TIMESTAMPTZ,
  approved_by UUID,
  rejected_at TIMESTAMPTZ,
  rejected_by UUID,
  rejection_reason TEXT,
  executed_at TIMESTAMPTZ,
  executed_by UUID,
  asset_id UUID,
  production_reference TEXT,
  source_event_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rd_disposition_type CHECK (disposition_type IN ('retain-as-asset','transfer-to-production','teardown','scrap')),
  CONSTRAINT chk_rd_disposition_status CHECK (status IN ('approval_required','approved','rejected','executed')),
  CONSTRAINT uq_rd_disposition_source_event UNIQUE (source_event_id, disposition_id)
);

CREATE INDEX IF NOT EXISTS idx_rd_disposition_prototype ON rd_disposition (prototype_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rd_disposition_project ON rd_disposition (project_code, created_at);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_rd_disposition_type' AND conrelid = 'rd_disposition'::regclass) THEN
    ALTER TABLE rd_disposition ADD CONSTRAINT chk_rd_disposition_type CHECK (disposition_type IN ('retain-as-asset','transfer-to-production','teardown','scrap'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_rd_disposition_status' AND conrelid = 'rd_disposition'::regclass) THEN
    ALTER TABLE rd_disposition ADD CONSTRAINT chk_rd_disposition_status CHECK (status IN ('approval_required','approved','rejected','executed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_rd_disposition_source_event' AND conrelid = 'rd_disposition'::regclass) THEN
    IF EXISTS (
      SELECT 1 FROM pg_class i
      JOIN pg_index ix ON ix.indexrelid = i.oid
      WHERE i.relname = 'uq_rd_disposition_source_event' AND ix.indrelid = 'rd_disposition'::regclass
    ) THEN
      DROP INDEX uq_rd_disposition_source_event;
    END IF;
    ALTER TABLE rd_disposition ADD CONSTRAINT uq_rd_disposition_source_event UNIQUE (source_event_id, disposition_id);
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON rd_disposition TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON rd_disposition TO readonly_user;
  END IF;
END $$;
