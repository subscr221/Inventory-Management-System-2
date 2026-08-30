-- QC partial lot split (Story 8.3, FR-Q-05, AC 2). This file is the CANONICAL definition, applied
-- by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its
-- OWN grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as
-- app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a live database
-- safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.lot_split_recorded domain events;
-- mutation happens exclusively through persistEvent inside the SAME transaction as the
-- domain_events insert.
--
-- One row per CHILD lot. It is the parent-to-child linkage that the parent's own
-- qc_inspection_task row cannot carry: uq_qc_inspection_task_source forbids reusing the parent's
-- (source_completion_type, source_completion_id) on a child, so each child task mints a fresh
-- source_completion_id and the real provenance lives here (Story 8.3 Annex requirement 7).
--
-- uq_qc_lot_split_child is the concurrency backstop for a replayed or raced split; the parent-side
-- backstop is uq_qc_lot_disposition_lot on the parent's 'split' disposition row, so a second split
-- of the same parent is 409 DISPOSITION_EXISTS, never a partial second set of children.
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE or DELETE.

CREATE TABLE IF NOT EXISTS qc_lot_split (
  split_id          UUID PRIMARY KEY,
  parent_lot_id     UUID NOT NULL,
  parent_lot_number TEXT NOT NULL,
  parent_task_id    UUID NOT NULL,
  disposition_id    UUID NOT NULL,
  child_lot_id      UUID NOT NULL,
  child_lot_number  TEXT NOT NULL,
  child_task_id     UUID NOT NULL,
  sequence          INTEGER NOT NULL,
  quantity          NUMERIC(18, 6) NOT NULL,
  source_event_id   UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_qc_lot_split_child UNIQUE (child_lot_id),
  CONSTRAINT uq_qc_lot_split_sequence UNIQUE (parent_lot_id, sequence),
  CONSTRAINT chk_qc_lot_split_quantity CHECK (quantity > 0),
  CONSTRAINT chk_qc_lot_split_sequence CHECK (sequence >= 1),
  CONSTRAINT chk_qc_lot_split_distinct CHECK (child_lot_id <> parent_lot_id)
);

CREATE INDEX IF NOT EXISTS idx_qc_lot_split_parent ON qc_lot_split (parent_lot_id, sequence);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_lot_split_child'
      AND conrelid = 'qc_lot_split'::regclass
  ) THEN
    ALTER TABLE qc_lot_split
      ADD CONSTRAINT uq_qc_lot_split_child UNIQUE (child_lot_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_lot_split_sequence'
      AND conrelid = 'qc_lot_split'::regclass
  ) THEN
    ALTER TABLE qc_lot_split
      ADD CONSTRAINT uq_qc_lot_split_sequence UNIQUE (parent_lot_id, sequence);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_split_quantity'
      AND conrelid = 'qc_lot_split'::regclass
  ) THEN
    ALTER TABLE qc_lot_split
      ADD CONSTRAINT chk_qc_lot_split_quantity CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_split_sequence'
      AND conrelid = 'qc_lot_split'::regclass
  ) THEN
    ALTER TABLE qc_lot_split
      ADD CONSTRAINT chk_qc_lot_split_sequence CHECK (sequence >= 1);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_split_distinct'
      AND conrelid = 'qc_lot_split'::regclass
  ) THEN
    ALTER TABLE qc_lot_split
      ADD CONSTRAINT chk_qc_lot_split_distinct CHECK (child_lot_id <> parent_lot_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON qc_lot_split TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_lot_split TO readonly_user;
  END IF;
END $$;
