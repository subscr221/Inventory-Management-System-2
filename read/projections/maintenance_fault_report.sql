-- Maintenance fault report (Story 7.3, FR-M-04). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.fault_reported,
-- maintenance.fault_rejected and maintenance.breakdown_work_order_created domain events; mutation
-- happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert.
--
-- chk_maintenance_fault_report_accept_link keeps the accepted row honest: an accepted report must
-- name the work order that triaged it. chk_maintenance_fault_report_reject_reason forces a
-- non-blank reason on rejection. status moves reported -> accepted|rejected exactly once, and the
-- anti-double-acceptance backstop lives on the work-order table (uq_maintenance_work_order_fault).

CREATE TABLE IF NOT EXISTS maintenance_fault_report (
  fault_report_id  UUID PRIMARY KEY,
  asset_id         UUID NOT NULL,
  asset_tag        TEXT NOT NULL,
  reported_by      UUID NOT NULL,
  reported_at      TIMESTAMPTZ NOT NULL,
  location_id      UUID NOT NULL,
  description      TEXT NOT NULL,
  safety_flag      BOOLEAN NOT NULL DEFAULT false,
  status           TEXT NOT NULL DEFAULT 'reported',
  work_order_id    UUID,
  triaged_at       TIMESTAMPTZ,
  triaged_by       UUID,
  rejection_reason TEXT,
  notified_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_maintenance_fault_report_status CHECK (status IN ('reported', 'accepted', 'rejected')),
  CONSTRAINT chk_maintenance_fault_report_accept_link CHECK (status <> 'accepted' OR work_order_id IS NOT NULL),
  CONSTRAINT chk_maintenance_fault_report_reject_reason CHECK (status <> 'rejected' OR (rejection_reason IS NOT NULL AND length(btrim(rejection_reason)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_fault_report_asset ON maintenance_fault_report (asset_id, reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_maintenance_fault_report_triage ON maintenance_fault_report (status, reported_at);
CREATE INDEX IF NOT EXISTS idx_maintenance_fault_report_location ON maintenance_fault_report (location_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_fault_report_status'
      AND conrelid = 'maintenance_fault_report'::regclass
  ) THEN
    ALTER TABLE maintenance_fault_report
      ADD CONSTRAINT chk_maintenance_fault_report_status CHECK (status IN ('reported', 'accepted', 'rejected'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_fault_report_accept_link'
      AND conrelid = 'maintenance_fault_report'::regclass
  ) THEN
    ALTER TABLE maintenance_fault_report
      ADD CONSTRAINT chk_maintenance_fault_report_accept_link CHECK (status <> 'accepted' OR work_order_id IS NOT NULL);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_fault_report_reject_reason'
      AND conrelid = 'maintenance_fault_report'::regclass
  ) THEN
    ALTER TABLE maintenance_fault_report
      ADD CONSTRAINT chk_maintenance_fault_report_reject_reason CHECK (status <> 'rejected' OR (rejection_reason IS NOT NULL AND length(btrim(rejection_reason)) > 0));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON maintenance_fault_report TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_fault_report TO readonly_user;
  END IF;
END $$;
