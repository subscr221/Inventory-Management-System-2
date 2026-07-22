CREATE TABLE IF NOT EXISTS weighbridge_event (
  weighbridge_event_id    UUID PRIMARY KEY,
  correlation_id          UUID NOT NULL,
  gate_event_id           UUID NOT NULL,
  site_id                 UUID NOT NULL,
  site_code_ext           TEXT NOT NULL,
  po_ref_ext              TEXT NOT NULL,
  line_no                 INTEGER NOT NULL,
  tare_kg                 NUMERIC(12,3) NOT NULL,
  gross_kg                NUMERIC(12,3) NOT NULL,
  net_kg                  NUMERIC(12,3) NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'accepted',
  tolerance_breach_reason TEXT,
  device_id               TEXT NOT NULL,
  capture_method          TEXT NOT NULL,
  weighed_by              UUID NOT NULL,
  business_date           DATE NOT NULL,
  source_event_id         UUID NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_weighbridge_event_status CHECK (status IN ('accepted', 'tolerance_breach')),
  CONSTRAINT chk_weighbridge_event_tare_non_negative CHECK (tare_kg >= 0),
  CONSTRAINT chk_weighbridge_event_gross_non_negative CHECK (gross_kg >= 0),
  CONSTRAINT chk_weighbridge_event_net_non_negative CHECK (net_kg >= 0),
  CONSTRAINT chk_weighbridge_event_capture_method CHECK (capture_method IN ('AUTO', 'MANUAL'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_weighbridge_event_status'
      AND conrelid = 'weighbridge_event'::regclass
  ) THEN
    ALTER TABLE weighbridge_event
      ADD CONSTRAINT chk_weighbridge_event_status CHECK (status IN ('accepted', 'tolerance_breach'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_weighbridge_event_tare_non_negative'
      AND conrelid = 'weighbridge_event'::regclass
  ) THEN
    ALTER TABLE weighbridge_event
      ADD CONSTRAINT chk_weighbridge_event_tare_non_negative CHECK (tare_kg >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_weighbridge_event_gross_non_negative'
      AND conrelid = 'weighbridge_event'::regclass
  ) THEN
    ALTER TABLE weighbridge_event
      ADD CONSTRAINT chk_weighbridge_event_gross_non_negative CHECK (gross_kg >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_weighbridge_event_net_non_negative'
      AND conrelid = 'weighbridge_event'::regclass
  ) THEN
    ALTER TABLE weighbridge_event
      ADD CONSTRAINT chk_weighbridge_event_net_non_negative CHECK (net_kg >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_weighbridge_event_capture_method'
      AND conrelid = 'weighbridge_event'::regclass
  ) THEN
    ALTER TABLE weighbridge_event
      ADD CONSTRAINT chk_weighbridge_event_capture_method CHECK (capture_method IN ('AUTO', 'MANUAL'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_weighbridge_event_correlation ON weighbridge_event (correlation_id);
CREATE INDEX IF NOT EXISTS idx_weighbridge_event_site_status ON weighbridge_event (site_id, status);
CREATE INDEX IF NOT EXISTS idx_weighbridge_event_po_line ON weighbridge_event (po_ref_ext, line_no);
CREATE INDEX IF NOT EXISTS idx_weighbridge_event_business_date ON weighbridge_event (business_date);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON weighbridge_event TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON weighbridge_event TO readonly_user;
  END IF;
END $$;
