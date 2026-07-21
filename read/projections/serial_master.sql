-- Serial master read model (Story 2.3). This file is the CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its
-- OWN grants (guarded DO blocks) so a migrate-provisioned database can serve serial-master
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- serial_id is the internal UUID used as the serial_master event stream_id. serial_number is the
-- unique identifier for the serial. lot_id stores the API-facing lot number. current_location_id
-- tracks where the serial is currently located. current_quantity tracks the quantity for this serial.

CREATE TABLE IF NOT EXISTS serial_master (
  serial_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serial_number         TEXT NOT NULL,
  sku                   TEXT NOT NULL,
  lot_id                TEXT,
  current_location_id   UUID,
  current_location_code TEXT,
  current_quantity      NUMERIC(18, 6) NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_serial_master_sku_serial_number UNIQUE (sku, serial_number)
);

ALTER TABLE serial_master ADD COLUMN IF NOT EXISTS lot_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_serial_master_sku_serial_number'
      AND conrelid = 'serial_master'::regclass
  ) THEN
    ALTER TABLE serial_master
      ADD CONSTRAINT uq_serial_master_sku_serial_number UNIQUE (sku, serial_number);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_serial_master_sku_serial ON serial_master (sku, serial_number);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON serial_master TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON serial_master TO readonly_user;
  END IF;
END $$;
