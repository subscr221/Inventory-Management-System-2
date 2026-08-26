-- Asset operational status projection (Story 7.6, FR-M-16). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.asset_status_changed domain
-- events; mutation happens exclusively through persistEvent, which applies this projection inside
-- the SAME transaction as the domain_events insert.
--
-- The status vocabulary is the machine-status contract (Table 5): running, idle, breakdown,
-- maintenance. sign_off_by / sign_off_at are the return-to-service supervisor sign-off (AC5),
-- written back onto the payload by the applier from the resolved DOA approver under lock; they are
-- only ever set on a transition TO running from breakdown or maintenance.

CREATE TABLE IF NOT EXISTS asset_operational_status (
  asset_id     UUID PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'idle',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   UUID,
  sign_off_by  UUID,
  sign_off_at  TIMESTAMPTZ,
  CONSTRAINT chk_asset_operational_status CHECK (status IN ('running', 'idle', 'breakdown', 'maintenance'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_operational_status'
      AND conrelid = 'asset_operational_status'::regclass
  ) THEN
    ALTER TABLE asset_operational_status
      ADD CONSTRAINT chk_asset_operational_status CHECK (status IN ('running', 'idle', 'breakdown', 'maintenance'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON asset_operational_status TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON asset_operational_status TO readonly_user;
  END IF;
END $$;
