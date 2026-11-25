-- Story 10.4 (FR-RD-13/14): machine-time booking. customer_id is ONE NOT NULL column so a booking
-- can never reference more than one customer record.
CREATE TABLE IF NOT EXISTS hub_booking (
  booking_id UUID PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES hub_customer (customer_id),
  machine_id UUID NOT NULL REFERENCES hub_machine (machine_id),
  scheduled_start TIMESTAMPTZ,
  scheduled_end TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'open',
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  actual_minutes INTEGER,
  meter_reading_value NUMERIC(18,4),
  reading_id UUID,
  exception_raised_at TIMESTAMPTZ,
  backdate_reason TEXT,
  source_event_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_hub_booking_status CHECK (status IN ('open','closed')),
  CONSTRAINT chk_hub_booking_actual_minutes CHECK (actual_minutes IS NULL OR actual_minutes >= 0),
  CONSTRAINT chk_hub_booking_closed_actuals CHECK (status = 'open' OR (actual_minutes IS NOT NULL AND closed_at IS NOT NULL AND meter_reading_value IS NOT NULL)),
  CONSTRAINT chk_hub_booking_schedule CHECK (scheduled_end IS NULL OR scheduled_start IS NULL OR scheduled_end >= scheduled_start)
);

-- Second review X4: a late-logged (backdated) open carries its reason.
ALTER TABLE hub_booking ADD COLUMN IF NOT EXISTS backdate_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_hub_booking_open_unraised ON hub_booking (opened_at) WHERE status = 'open' AND exception_raised_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hub_booking_customer ON hub_booking (customer_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_hub_booking_status' AND conrelid = 'hub_booking'::regclass) THEN
    ALTER TABLE hub_booking ADD CONSTRAINT chk_hub_booking_status CHECK (status IN ('open','closed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_hub_booking_actual_minutes' AND conrelid = 'hub_booking'::regclass) THEN
    ALTER TABLE hub_booking ADD CONSTRAINT chk_hub_booking_actual_minutes CHECK (actual_minutes IS NULL OR actual_minutes >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_hub_booking_closed_actuals' AND conrelid = 'hub_booking'::regclass) THEN
    ALTER TABLE hub_booking ADD CONSTRAINT chk_hub_booking_closed_actuals CHECK (status = 'open' OR (actual_minutes IS NOT NULL AND closed_at IS NOT NULL AND meter_reading_value IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_hub_booking_schedule' AND conrelid = 'hub_booking'::regclass) THEN
    ALTER TABLE hub_booking ADD CONSTRAINT chk_hub_booking_schedule CHECK (scheduled_end IS NULL OR scheduled_start IS NULL OR scheduled_end >= scheduled_start);
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON hub_booking TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON hub_booking TO readonly_user;
  END IF;
END $$;
