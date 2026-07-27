-- Story 3.7: dispatch document projection
-- Grain: (document_id)
-- Documents are regenerable renderings of the packing/shipping data; hard
-- deletion on re-generation is acceptable (the generation event's trace_id
-- in the edit log provides the audit trail).

CREATE TABLE IF NOT EXISTS dispatch_document (
  document_id UUID PRIMARY KEY,
  dispatch_order_id UUID NOT NULL,
  document_type TEXT NOT NULL,
  document_content TEXT,
  generated_by UUID NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_dispatch_document_type'
  ) THEN
    ALTER TABLE dispatch_document ADD CONSTRAINT chk_dispatch_document_type
      CHECK (document_type IN ('bol', 'packing_slip', 'commercial_invoice', 'label'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_dispatch_document_order ON dispatch_document (dispatch_order_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    RETURN;
  END IF;
  GRANT INSERT, SELECT, UPDATE, DELETE ON dispatch_document TO app_user;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'readonly_user') THEN
    RETURN;
  END IF;
  GRANT SELECT ON dispatch_document TO readonly_user;
END
$$;
