CREATE TABLE IF NOT EXISTS asn (
  asn_number_ext   TEXT PRIMARY KEY,
  po_ref_ext       TEXT NOT NULL,
  supplier_ref_ext TEXT NOT NULL,
  site_id          UUID NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open',
  source_snapshot  JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_asn_status CHECK (status IN ('open', 'closed'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asn_status'
      AND conrelid = 'asn'::regclass
  ) THEN
    ALTER TABLE asn
      ADD CONSTRAINT chk_asn_status CHECK (status IN ('open', 'closed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_asn_po_ref ON asn (po_ref_ext);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON asn TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON asn TO readonly_user;
  END IF;
END $$;
