-- Payment clearance feed ledger (Story 4.5). CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate); deploy/compose/init-db.sql duplicates this content
-- for first-boot container init - change both files together. Every statement is idempotent.
--
-- Derived state ONLY: the row is written atomically with payment_clearance_feed.recorded inside the
-- SAME persistEvent transaction. This is the ERP adapter boundary record for AC3 - payment executes
-- in ERP, so "blocked from payment" is effected by OMITTING the invoice from this payload while its
-- three-way match is blocked. The adapter records the clearance payload durably; live transmission
-- is per-deployment configuration and is NOT implemented here (AD-4). Append-only ledger: app_user
-- gets INSERT, SELECT only (no UPDATE), mirroring msme_ageing_feed.

CREATE TABLE IF NOT EXISTS payment_clearance_feed (
  feed_id       UUID PRIMARY KEY,
  payload       JSONB NOT NULL,
  row_count     INTEGER NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON payment_clearance_feed TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON payment_clearance_feed TO readonly_user;
  END IF;
END $$;
