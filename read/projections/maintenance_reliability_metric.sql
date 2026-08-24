-- Maintenance reliability metric snapshot (Story 7.3, FR-M-06). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.reliability_report_generated
-- domain events; mutation happens exclusively through persistEvent, which applies this projection
-- inside the SAME transaction as the domain_events insert.
--
-- uq_maintenance_reliability_metric_scope is the anti-double-report key: the monthly report is a
-- PERSISTED DATED SNAPSHOT, and a re-run of the same (period_start, period_end, scope_type,
-- scope_key) must not write a second snapshot. The seam pre-check returns the stable
-- DUPLICATE_RELIABILITY_REPORT; this unique index is the concurrency backstop and the 23505 mapper
-- resolves the winner. This table is append-only per report (INSERT, SELECT grants only - the
-- asset_meter_reading decision from the 7.2 Group 1 review).

CREATE TABLE IF NOT EXISTS maintenance_reliability_metric (
  metric_id         UUID PRIMARY KEY,
  report_id         UUID NOT NULL,
  period_start      DATE NOT NULL,
  period_end        DATE NOT NULL,
  scope_type        TEXT NOT NULL,
  scope_key         TEXT NOT NULL,
  breakdown_count   INTEGER NOT NULL,
  downtime_minutes  NUMERIC(18,4) NOT NULL,
  mttr_minutes      NUMERIC(18,4),
  mtbf_minutes      NUMERIC(18,4),
  generated_by      UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_maintenance_reliability_metric_scope CHECK (scope_type IN ('asset', 'criticality_class')),
  CONSTRAINT chk_maintenance_reliability_metric_period CHECK (period_end >= period_start),
  CONSTRAINT chk_maintenance_reliability_metric_counts CHECK (breakdown_count >= 0 AND downtime_minutes >= 0),
  CONSTRAINT chk_maintenance_reliability_metric_rates CHECK ((mttr_minutes IS NULL OR mttr_minutes >= 0) AND (mtbf_minutes IS NULL OR mtbf_minutes >= 0))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_reliability_metric_scope ON maintenance_reliability_metric (period_start, period_end, scope_type, scope_key);
CREATE INDEX IF NOT EXISTS idx_maintenance_reliability_metric_report ON maintenance_reliability_metric (report_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_reliability_metric_scope'
      AND conrelid = 'maintenance_reliability_metric'::regclass
  ) THEN
    ALTER TABLE maintenance_reliability_metric
      ADD CONSTRAINT chk_maintenance_reliability_metric_scope CHECK (scope_type IN ('asset', 'criticality_class'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_reliability_metric_period'
      AND conrelid = 'maintenance_reliability_metric'::regclass
  ) THEN
    ALTER TABLE maintenance_reliability_metric
      ADD CONSTRAINT chk_maintenance_reliability_metric_period CHECK (period_end >= period_start);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_reliability_metric_counts'
      AND conrelid = 'maintenance_reliability_metric'::regclass
  ) THEN
    ALTER TABLE maintenance_reliability_metric
      ADD CONSTRAINT chk_maintenance_reliability_metric_counts CHECK (breakdown_count >= 0 AND downtime_minutes >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_reliability_metric_rates'
      AND conrelid = 'maintenance_reliability_metric'::regclass
  ) THEN
    ALTER TABLE maintenance_reliability_metric
      ADD CONSTRAINT chk_maintenance_reliability_metric_rates CHECK ((mttr_minutes IS NULL OR mttr_minutes >= 0) AND (mtbf_minutes IS NULL OR mtbf_minutes >= 0));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON maintenance_reliability_metric TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_reliability_metric TO readonly_user;
  END IF;
END $$;
