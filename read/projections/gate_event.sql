CREATE TABLE IF NOT EXISTS gate_event (
  gate_event_id     UUID PRIMARY KEY,
  site_id           UUID NOT NULL,
  site_code_ext     TEXT NOT NULL,
  po_ref_ext        TEXT,
  binding_status    TEXT NOT NULL,
  vehicle_reg_ext   TEXT NOT NULL,
  driver_name       TEXT,
  challan_number_ext TEXT,
  challan_photo_ref TEXT NOT NULL,
  gate_id           TEXT NOT NULL,
  gate_officer_id   UUID NOT NULL,
  correlation_id    UUID NOT NULL UNIQUE,
  entered_at        TIMESTAMPTZ NOT NULL,
  business_date     DATE NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open',
  reversal_reason   TEXT,
  source_event_id   UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_gate_event_binding_status CHECK (binding_status IN ('matched', 'unmatched')),
  CONSTRAINT chk_gate_event_status CHECK (status IN ('open', 'reversed')),
  CONSTRAINT chk_gate_event_vehicle_reg_nonempty CHECK (length(trim(vehicle_reg_ext)) > 0),
  CONSTRAINT chk_gate_event_challan_photo_nonempty CHECK (length(trim(challan_photo_ref)) > 0)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_gate_event_binding_status'
      AND conrelid = 'gate_event'::regclass
  ) THEN
    ALTER TABLE gate_event
      ADD CONSTRAINT chk_gate_event_binding_status CHECK (binding_status IN ('matched', 'unmatched'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_gate_event_status'
      AND conrelid = 'gate_event'::regclass
  ) THEN
    ALTER TABLE gate_event
      ADD CONSTRAINT chk_gate_event_status CHECK (status IN ('open', 'reversed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_gate_event_vehicle_reg_nonempty'
      AND conrelid = 'gate_event'::regclass
  ) THEN
    ALTER TABLE gate_event
      ADD CONSTRAINT chk_gate_event_vehicle_reg_nonempty CHECK (length(trim(vehicle_reg_ext)) > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_gate_event_challan_photo_nonempty'
      AND conrelid = 'gate_event'::regclass
  ) THEN
    ALTER TABLE gate_event
      ADD CONSTRAINT chk_gate_event_challan_photo_nonempty CHECK (length(trim(challan_photo_ref)) > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_gate_event_site_status ON gate_event (site_id, status);
CREATE INDEX IF NOT EXISTS idx_gate_event_po_ref ON gate_event (po_ref_ext);
CREATE INDEX IF NOT EXISTS idx_gate_event_binding_status ON gate_event (binding_status, status);
CREATE INDEX IF NOT EXISTS idx_gate_event_correlation ON gate_event (correlation_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON gate_event TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON gate_event TO readonly_user;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_gate_event_correlation_id'
      AND conrelid = 'gate_event'::regclass
  ) THEN
    ALTER TABLE gate_event
      ADD CONSTRAINT uq_gate_event_correlation_id UNIQUE (correlation_id);
  END IF;
END $$;
