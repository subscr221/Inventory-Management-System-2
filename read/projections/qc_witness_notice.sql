-- QC witnessed-inspection notice ledger (Story 8.8, FR-Q-15, AC 2). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Story 8.8 Binding Scope Decision 5: the notice is a first-class RECORD, not a notification.
-- emitNotificationInTransaction is fire-and-forget and stores no recipient/method contract that
-- can be read back as evidence; AC 2 requires evidence. The outbound notification is emitted
-- ALONGSIDE this row (AD-17), never instead of it - the structural analogue is the Story 8.7
-- compliance_bis_licence_alert ledger.
--
-- APPEND-ONLY: a notice that was given is a posted contractual fact. app_user therefore holds
-- SELECT and INSERT only - no UPDATE, and deliberately no DELETE (the Story 8.7 alert-ledger
-- decision). Unlike a rebuildable derived projection this table is the record of what was actually
-- served on the customer or third party.
--
-- No FK to qc_witness_hold_point: cross-projection foreign keys are forbidden by the house rule,
-- so referential integrity is the applier's job - it loads the hold point FOR UPDATE before
-- inserting a notice row.
--
-- source_event_id is UNIQUE: the replay guard - a redelivered notice event cannot post a second
-- notice.

CREATE TABLE IF NOT EXISTS qc_witness_notice (
  notice_id        UUID PRIMARY KEY,
  hold_point_id    UUID NOT NULL,
  recipient        TEXT NOT NULL,
  notice_date      DATE NOT NULL,
  method           TEXT NOT NULL,
  recorded_by      UUID NOT NULL,
  recorded_at      TIMESTAMPTZ NOT NULL,
  source_event_id  UUID NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_qc_witness_notice_event UNIQUE (source_event_id),
  CONSTRAINT chk_qc_witness_notice_recipient CHECK (
    btrim(recipient) <> '' AND char_length(recipient) <= 512
  ),
  CONSTRAINT chk_qc_witness_notice_method CHECK (
    method IN ('email', 'letter', 'portal', 'in_person')
  )
);

CREATE INDEX IF NOT EXISTS idx_qc_witness_notice_hold_point
  ON qc_witness_notice (hold_point_id, notice_date);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_witness_notice_event'
      AND conrelid = 'qc_witness_notice'::regclass
  ) THEN
    ALTER TABLE qc_witness_notice
      ADD CONSTRAINT uq_qc_witness_notice_event UNIQUE (source_event_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_witness_notice_recipient'
      AND conrelid = 'qc_witness_notice'::regclass
  ) THEN
    ALTER TABLE qc_witness_notice
      ADD CONSTRAINT chk_qc_witness_notice_recipient CHECK (
        btrim(recipient) <> '' AND char_length(recipient) <= 512
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_witness_notice_method'
      AND conrelid = 'qc_witness_notice'::regclass
  ) THEN
    ALTER TABLE qc_witness_notice
      ADD CONSTRAINT chk_qc_witness_notice_method CHECK (
        method IN ('email', 'letter', 'portal', 'in_person')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    -- SELECT and INSERT only. The ledger is append-only: no UPDATE, and deliberately no DELETE.
    GRANT SELECT, INSERT ON qc_witness_notice TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_witness_notice TO readonly_user;
  END IF;
END $$;
