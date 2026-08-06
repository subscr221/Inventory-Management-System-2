-- MSME ageing feed ledger (Story 4.6). CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate); deploy/compose/init-db.sql duplicates this content
-- for first-boot container init - change both files together. Every statement is idempotent.
--
-- Derived state ONLY: the row is written atomically with msme_ageing_feed.recorded inside the SAME
-- persistEvent transaction. This is the ERP adapter boundary record (AC4 verification contract) -
-- the adapter records the ageing payload durably; live transmission is per-deployment configuration
-- and is NOT implemented here. Append-only ledger: app_user gets INSERT, SELECT only (no UPDATE),
-- mirroring po_outbound_message.

CREATE TABLE IF NOT EXISTS msme_ageing_feed (
  feed_id       UUID PRIMARY KEY,
  payload       JSONB NOT NULL,
  row_count     INTEGER NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON msme_ageing_feed TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON msme_ageing_feed TO readonly_user;
  END IF;
END $$;
