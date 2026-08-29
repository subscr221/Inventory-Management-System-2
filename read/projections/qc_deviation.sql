-- QC deviation evidence (Story 8.1, FR-Q-02 and FR-Q-05, AC 4). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.conditional_release_recorded domain
-- events; mutation happens exclusively through persistEvent inside the SAME transaction as the
-- domain_events insert (the deviation, the shared disposition, the gate transition, the event, the
-- audit entry and the decision notification commit together or not at all).
--
-- An IMMUTABLE deviation record (AC 4): justification, explicit conditions, bounded scope and a
-- future expiry date, plus the requester, the DOA-resolved approver and the DOA entry that governed
-- qc.conditional_release. decided_on is the IST business date of the decision, so
-- chk_qc_deviation_expiry (expires_on > decided_on) is a database-enforced "valid future expiry".
--
-- scope_kind: internal_movement is the only scope this story makes operationally usable (to the
-- named location or process in scope_ref, while unexpired); order_allocation and dispatch may be
-- stored for future Story 8.4 activation but remain blocked until the batch release record exists
-- (Binding Scope Decisions 5 and 6).
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE or DELETE.

CREATE TABLE IF NOT EXISTS qc_deviation (
  deviation_id     UUID PRIMARY KEY,
  task_id          UUID NOT NULL,
  lot_id           UUID NOT NULL,
  deviation_type   TEXT NOT NULL,
  justification    TEXT NOT NULL,
  conditions       TEXT NOT NULL,
  scope_kind       TEXT NOT NULL,
  scope_ref        TEXT NOT NULL,
  decided_on       DATE NOT NULL,
  expires_on       DATE NOT NULL,
  requested_by     UUID NOT NULL,
  approved_by      UUID NOT NULL,
  doa_entry_id     UUID NOT NULL,
  decided_at       TIMESTAMPTZ NOT NULL,
  source_event_id  UUID NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_qc_deviation_task_type UNIQUE (task_id, deviation_type),
  CONSTRAINT chk_qc_deviation_type CHECK (deviation_type IN ('conditional_release')),
  CONSTRAINT chk_qc_deviation_scope_kind CHECK (scope_kind IN ('internal_movement', 'order_allocation', 'dispatch')),
  CONSTRAINT chk_qc_deviation_text CHECK (
    btrim(justification) <> '' AND char_length(justification) <= 2000
    AND btrim(conditions) <> '' AND char_length(conditions) <= 2000
    AND btrim(scope_ref) <> '' AND char_length(scope_ref) <= 128
  ),
  CONSTRAINT chk_qc_deviation_expiry CHECK (expires_on > decided_on)
);

CREATE INDEX IF NOT EXISTS idx_qc_deviation_lot ON qc_deviation (lot_id, expires_on);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_deviation_task_type'
      AND conrelid = 'qc_deviation'::regclass
  ) THEN
    ALTER TABLE qc_deviation
      ADD CONSTRAINT uq_qc_deviation_task_type UNIQUE (task_id, deviation_type);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_deviation_type'
      AND conrelid = 'qc_deviation'::regclass
  ) THEN
    ALTER TABLE qc_deviation
      ADD CONSTRAINT chk_qc_deviation_type CHECK (deviation_type IN ('conditional_release'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_deviation_scope_kind'
      AND conrelid = 'qc_deviation'::regclass
  ) THEN
    ALTER TABLE qc_deviation
      ADD CONSTRAINT chk_qc_deviation_scope_kind CHECK (scope_kind IN ('internal_movement', 'order_allocation', 'dispatch'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_deviation_text'
      AND conrelid = 'qc_deviation'::regclass
  ) THEN
    ALTER TABLE qc_deviation
      ADD CONSTRAINT chk_qc_deviation_text CHECK (
        btrim(justification) <> '' AND char_length(justification) <= 2000
        AND btrim(conditions) <> '' AND char_length(conditions) <= 2000
        AND btrim(scope_ref) <> '' AND char_length(scope_ref) <= 128
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_deviation_expiry'
      AND conrelid = 'qc_deviation'::regclass
  ) THEN
    ALTER TABLE qc_deviation
      ADD CONSTRAINT chk_qc_deviation_expiry CHECK (expires_on > decided_on);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON qc_deviation TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_deviation TO readonly_user;
  END IF;
END $$;
