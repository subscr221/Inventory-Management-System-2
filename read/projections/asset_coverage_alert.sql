-- Staged coverage expiry alerts (Story 7.7, FR-M-10, AC 1). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.coverage_expiry_flagged domain
-- events; mutation happens exclusively through persistEvent, which applies this projection inside
-- the SAME transaction as the domain_events insert.
--
-- The grain is (coverage_id, stage_days), NOT (coverage_id, business_date): an expiry countdown
-- fires ONCE PER STAGE per coverage. uq_asset_coverage_alert_stage is what makes a same-day re-run
-- a no-op and what makes a skipped day catch up rather than lose a stage - the scan asks which
-- stages are due AND unfired, never whether the day count equals a stage exactly. A renewal is a
-- NEW coverage_id and therefore earns a fresh set of three stages (Binding Decision 5 and 7).
-- The stages 90/60/30 are pinned by FR-M-10 itself, so they are a module constant and never
-- deployment configuration.

CREATE TABLE IF NOT EXISTS asset_coverage_alert (
  alert_id      UUID PRIMARY KEY,
  coverage_id   UUID NOT NULL,
  asset_id      UUID NOT NULL,
  stage_days    INTEGER NOT NULL,
  expiry_date   DATE NOT NULL,
  business_date DATE NOT NULL,
  flagged_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_asset_coverage_alert_stage CHECK (stage_days IN (90, 60, 30)),
  CONSTRAINT uq_asset_coverage_alert_stage UNIQUE (coverage_id, stage_days)
);

CREATE INDEX IF NOT EXISTS idx_asset_coverage_alert_business_date ON asset_coverage_alert (business_date);
CREATE INDEX IF NOT EXISTS idx_asset_coverage_alert_asset ON asset_coverage_alert (asset_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_coverage_alert_stage'
      AND conrelid = 'asset_coverage_alert'::regclass
  ) THEN
    ALTER TABLE asset_coverage_alert
      ADD CONSTRAINT chk_asset_coverage_alert_stage CHECK (stage_days IN (90, 60, 30));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_asset_coverage_alert_stage'
      AND conrelid = 'asset_coverage_alert'::regclass
  ) THEN
    ALTER TABLE asset_coverage_alert
      ADD CONSTRAINT uq_asset_coverage_alert_stage UNIQUE (coverage_id, stage_days);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON asset_coverage_alert TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON asset_coverage_alert TO readonly_user;
  END IF;
END $$;
