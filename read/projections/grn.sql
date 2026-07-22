CREATE TABLE IF NOT EXISTS grn (
  grn_id          UUID PRIMARY KEY,
  correlation_id  UUID NOT NULL,
  po_ref_ext      TEXT NOT NULL,
  source_document TEXT NOT NULL,
  source_ref_ext  TEXT,
  site_id         UUID NOT NULL,
  site_code_ext   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  received_by     UUID NOT NULL,
  business_date   DATE NOT NULL,
  source_event_id UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_grn_source_document CHECK (source_document IN ('PO', 'ASN')),
  CONSTRAINT chk_grn_status CHECK (status IN ('open', 'posted'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_grn_source_document'
      AND conrelid = 'grn'::regclass
  ) THEN
    ALTER TABLE grn
      ADD CONSTRAINT chk_grn_source_document CHECK (source_document IN ('PO', 'ASN'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_grn_status'
      AND conrelid = 'grn'::regclass
  ) THEN
    ALTER TABLE grn
      ADD CONSTRAINT chk_grn_status CHECK (status IN ('open', 'posted'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_grn_correlation ON grn (correlation_id);
CREATE INDEX IF NOT EXISTS idx_grn_po_ref ON grn (po_ref_ext);
CREATE INDEX IF NOT EXISTS idx_grn_site_status ON grn (site_id, status);
CREATE INDEX IF NOT EXISTS idx_grn_business_date ON grn (business_date);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON grn TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON grn TO readonly_user;
  END IF;
END $$;
