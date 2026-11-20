-- Story 8.10: QC-governed putaway release. A receipt line held in ZONE-QC-HOLD whose inspection
-- task could not be opened keeps its putaway held AND records why (D7's closed vocabulary: the
-- human wording lives in the qc_hold_placed notification and the edge i18n, never in this column).
-- released_at is the accept-release timestamp the QC workbench reads; the existing released_by,
-- release_reason_code and released_event_id columns carry the rest of the release record.
-- Forward-only and idempotent: tail-appended in src/events/migrate.ts after the Story 8.9 files;
-- putaway_task.sql is NOT edited. MIRRORED verbatim at the tail of deploy/compose/init-db.sql -
-- change both together.
--
-- Guarded to run ONCE: adding a CHECK scans the table under ACCESS EXCLUSIVE, so the constraint
-- block is skipped when its constraint is already in place.

ALTER TABLE putaway_task ADD COLUMN IF NOT EXISTS hold_reason TEXT;
ALTER TABLE putaway_task ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_putaway_task_hold_reason'
      AND conrelid = 'putaway_task'::regclass
  ) THEN
    ALTER TABLE putaway_task
      ADD CONSTRAINT chk_putaway_task_hold_reason
      CHECK (
        hold_reason IS NULL
        OR hold_reason IN ('no_inspection_plan', 'no_lot', 'duplicate_lot')
      );
  END IF;
END $$;
