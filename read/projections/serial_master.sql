-- Serial master read model (Story 2.3). This file is the CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its
-- OWN grants (guarded DO blocks) so a migrate-provisioned database can serve serial-master
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- serial_id is the internal UUID used as the serial_master event stream_id (EventEnvelope.stream_id
-- must remain UUID); serial_number is the unique identifier for the serial. current_location_id
-- tracks where the serial is currently located. current_quantity tracks the quantity for this serial.
-- sku is used to link to the item_master.

CREATE TABLE IF NOT EXISTS serial_master (
  serial_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serial_number        TEXT NOT NULL,
  sku                  TEXT NOT NULL,
  current_location_id  UUID,
  current_location_code TEXT,
  current_quantity     NUMERIC(18, 6) NOT NULL DEFAULT 1,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_serial_master_sku_serial_number UNIQUE (sku, serial_number)
);

-- Index for SKU + serial_number lookups
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