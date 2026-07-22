-- Transfer request read model (Story 2.5). This file is the CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its own
-- grants (guarded DO blocks) so a migrate-provisioned database can serve reads as app_user without
-- depending on deploy/compose/init-db.sql.
--
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent so the file can be re-applied to a live database
-- safely.

CREATE TABLE IF NOT EXISTS transfer_request (
  transfer_request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id              TEXT NOT NULL,
  quantity            NUMERIC(18, 6) NOT NULL,
  from_location_id    UUID NOT NULL,
  to_location_id      UUID NOT NULL,
  lot_id              TEXT,
  serial_ids          TEXT[],
  business_stream     TEXT NOT NULL,
  notes               TEXT,
  status              TEXT NOT NULL DEFAULT 'pending_approval',
  -- status values: pending_approval, approved, rejected, pending_shipment, shipped,
  --                partially_received, received
  approver_actor_id   UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  shipped_at          TIMESTAMPTZ,
  received_at         TIMESTAMPTZ,
  correlation_id      UUID
);

CREATE INDEX IF NOT EXISTS idx_transfer_request_status ON transfer_request (status);
CREATE INDEX IF NOT EXISTS idx_transfer_request_sku ON transfer_request (sku_id);
CREATE INDEX IF NOT EXISTS idx_transfer_request_from_loc ON transfer_request (from_location_id);
CREATE INDEX IF NOT EXISTS idx_transfer_request_to_loc ON transfer_request (to_location_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON transfer_request TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON transfer_request TO readonly_user;
  END IF;
END $$;