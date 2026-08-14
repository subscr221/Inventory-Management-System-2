-- BOM outbound message record (Story 5.6, FR-B-17). CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate); deploy/compose/init-db.sql duplicates this content
-- for first-boot container init - change both files together. Every statement is idempotent.
--
-- Derived state ONLY: the row is written atomically with bom.released inside the SAME persistEvent
-- transaction. This is the INT-ERP-01 adapter boundary record - the adapter records the payload
-- durably; live transmission is per-deployment configuration and is NOT implemented here.
-- BOM structure is OUTBOUND-only: inbound ERP BOM records never mutate bom/bom_revision/bom_line,
-- they raise an integration_exception for the BOM Administrator instead.

CREATE TABLE IF NOT EXISTS bom_outbound_message (
  message_id    UUID PRIMARY KEY,
  bom_id        UUID NOT NULL,
  revision_id   UUID NOT NULL,
  payload       JSONB NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bom_outbound_bom_id ON bom_outbound_message (bom_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON bom_outbound_message TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON bom_outbound_message TO readonly_user;
  END IF;
END $$;
