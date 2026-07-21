-- In-transit read model (Story 2.5). This file is the CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its own
-- grants (guarded DO blocks) so a migrate-provisioned database can serve reads as app_user without
-- depending on deploy/compose/init-db.sql.
--
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent so the file can be re-applied to a live database
-- safely.
--
-- In-transit is a stock state, not a separate entity. This projection denormalizes the in-transit
-- balance from stock_balance for query efficiency. The authoritative in-transit quantity lives in
-- stock_balance.in_transit.

CREATE TABLE IF NOT EXISTS in_transit (
  sku_id                TEXT NOT NULL,
  location_from         UUID NOT NULL,
  location_to           UUID NOT NULL,
  lot_id                TEXT,
  quantity              NUMERIC(18, 6) NOT NULL,
  transfer_request_id   UUID NOT NULL,
  correlation_id        UUID,
  ship_event_id         UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_in_transit_sku ON in_transit (sku_id);
CREATE INDEX IF NOT EXISTS idx_in_transit_from ON in_transit (location_from);
CREATE INDEX IF NOT EXISTS idx_in_transit_to ON in_transit (location_to);
CREATE INDEX IF NOT EXISTS idx_in_transit_lot ON in_transit (lot_id);
CREATE INDEX IF NOT EXISTS idx_in_transit_request ON in_transit (transfer_request_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON in_transit TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON in_transit TO readonly_user;
  END IF;
END $$;