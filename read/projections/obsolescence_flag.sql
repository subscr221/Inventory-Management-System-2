-- Obsolescence flag read model (Story 2.7). This file is the CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its OWN
-- grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as app_user
-- without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates this content
-- for first-boot container init - change both files together. Every statement is idempotent so the
-- file can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying obsolescence.flagged / obsolescence.cleared
-- domain events; mutation happens exclusively through persistEvent inside the SAME transaction as the
-- domain_events insert. Grain is (sku, location_id) with NULLS NOT DISTINCT - one flag row per
-- SKU-location. status 'aging' carries disposition_status 'pending_disposition' and
-- nrv_testing_triggered = true; NRV testing here is a flag plus alert only - the DOA-gated write-down
-- stays in src/compliance/inventory-valuation.ts (Story 2.4). No stock leaves the ledger; disposition
-- is Epic 16.

CREATE TABLE IF NOT EXISTS obsolescence_flag (
  obsolescence_flag_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                   TEXT NOT NULL,
  location_id           UUID NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active',
  last_issue_at         TIMESTAMPTZ,
  days_since_issue      INTEGER,
  threshold_days        INTEGER,
  disposition_status    TEXT,
  nrv_testing_triggered BOOLEAN NOT NULL DEFAULT false,
  flagged_at            TIMESTAMPTZ,
  cleared_at            TIMESTAMPTZ,
  source_event_id       UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_obsolescence_flag_grain UNIQUE NULLS NOT DISTINCT (sku, location_id),
  CONSTRAINT chk_obsolescence_flag_status CHECK (status IN ('active', 'aging'))
);

CREATE INDEX IF NOT EXISTS idx_obsolescence_flag_location ON obsolescence_flag (location_id);
CREATE INDEX IF NOT EXISTS idx_obsolescence_flag_status ON obsolescence_flag (status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_obsolescence_flag_grain'
      AND conrelid = 'obsolescence_flag'::regclass
  ) THEN
    ALTER TABLE obsolescence_flag
      ADD CONSTRAINT uq_obsolescence_flag_grain UNIQUE NULLS NOT DISTINCT (sku, location_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_obsolescence_flag_status'
      AND conrelid = 'obsolescence_flag'::regclass
  ) THEN
    ALTER TABLE obsolescence_flag
      ADD CONSTRAINT chk_obsolescence_flag_status CHECK (status IN ('active', 'aging'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON obsolescence_flag TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON obsolescence_flag TO readonly_user;
  END IF;
END $$;
