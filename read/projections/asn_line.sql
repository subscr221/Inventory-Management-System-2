CREATE TABLE IF NOT EXISTS asn_line (
  asn_number_ext TEXT NOT NULL,
  line_no        INTEGER NOT NULL,
  sku            TEXT NOT NULL,
  expected_qty   NUMERIC(18,3) NOT NULL,
  lot_number     TEXT,
  serial_number  TEXT,
  expiry_date    DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (asn_number_ext, line_no)
);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON asn_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON asn_line TO readonly_user;
  END IF;
END $$;
