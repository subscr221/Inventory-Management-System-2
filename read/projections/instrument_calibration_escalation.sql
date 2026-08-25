-- Calibration lockout escalations (Story 7.5, FR-M-13, AC 3, AD-8). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying
-- maintenance.calibration_escalation_raised / maintenance.calibration_escalation_resolved domain
-- events; mutation happens exclusively through persistEvent, which applies this projection inside
-- the SAME transaction as the domain_events insert.
--
-- This table is STATUS-NEUTRAL BY CONSTRUCTION (AC 3): it carries no calibration_status column and
-- no expiry field, so an escalation expedites re-calibration without any structural way to bypass
-- the lockout. Resolution requires a resolving_certificate_id, enforced by
-- chk_instrument_calibration_escalation_resolution, so an escalation cannot be closed without the
-- re-calibration it exists to expedite.
--
-- At most one OPEN escalation per instrument, enforced by the partial unique index
-- uq_instrument_calibration_escalation_open rather than only by the seam's pre-check. The DOA route
-- is the Story 1.7 calibration.escalation entry; doa_entry_id and routed_approver_user_id record
-- which entry and which approver the raise resolved to, so the routing is auditable after the fact.

CREATE TABLE IF NOT EXISTS instrument_calibration_escalation (
  escalation_id            UUID PRIMARY KEY,
  instrument_record_id     UUID NOT NULL,
  instrument_id            TEXT NOT NULL,
  doa_entry_id             UUID NOT NULL,
  routed_approver_user_id  UUID NOT NULL,
  reason                   TEXT,
  status                   TEXT NOT NULL DEFAULT 'open',
  raised_by                UUID NOT NULL,
  raised_at                TIMESTAMPTZ NOT NULL,
  resolved_at              TIMESTAMPTZ,
  resolving_certificate_id UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_instrument_calibration_escalation_status CHECK (status IN ('open', 'resolved')),
  CONSTRAINT chk_instrument_calibration_escalation_resolution CHECK (status = 'open' OR (resolved_at IS NOT NULL AND resolving_certificate_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_instrument_calibration_escalation_open ON instrument_calibration_escalation (instrument_record_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_instrument_calibration_escalation_approver ON instrument_calibration_escalation (routed_approver_user_id);
CREATE INDEX IF NOT EXISTS idx_instrument_calibration_escalation_instrument ON instrument_calibration_escalation (instrument_record_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_instrument_calibration_escalation_status'
      AND conrelid = 'instrument_calibration_escalation'::regclass
  ) THEN
    ALTER TABLE instrument_calibration_escalation
      ADD CONSTRAINT chk_instrument_calibration_escalation_status CHECK (status IN ('open', 'resolved'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_instrument_calibration_escalation_resolution'
      AND conrelid = 'instrument_calibration_escalation'::regclass
  ) THEN
    ALTER TABLE instrument_calibration_escalation
      ADD CONSTRAINT chk_instrument_calibration_escalation_resolution CHECK (status = 'open' OR (resolved_at IS NOT NULL AND resolving_certificate_id IS NOT NULL));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON instrument_calibration_escalation TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON instrument_calibration_escalation TO readonly_user;
  END IF;
END $$;
