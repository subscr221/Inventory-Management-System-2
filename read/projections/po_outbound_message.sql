-- PO outbound message record (Story 4.4). CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate); deploy/compose/init-db.sql duplicates this content
-- for first-boot container init - change both files together. Every statement is idempotent.
--
-- Derived state ONLY: the row is written atomically with purchase_order.issued inside the SAME
-- persistEvent transaction. This is the ERP adapter boundary record (AC3 verification contract) -
-- the adapter records the payload durably; live transmission is per-deployment configuration and
-- is NOT implemented here. Distinct from erp_purchase_order (Story 2.9 read-only inbound reference).

CREATE TABLE IF NOT EXISTS po_outbound_message (
  message_id    UUID PRIMARY KEY,
  po_id         UUID NOT NULL,
  payload       JSONB NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_outbound_po_id ON po_outbound_message (po_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON po_outbound_message TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON po_outbound_message TO readonly_user;
  END IF;
END $$;
