-- Story 3.14: inspection-on-opening evidence and the general material photo on a GRN line.
-- The storekeeper can note that damage was suspected or observed while unloading, with an optional
-- photo and one-line note, and always attaches one material photo of what arrived. Both are NOTES
-- for the inspector, never a QC verdict - QC disposition remains Epic 8. Forward-only and
-- idempotent: tail-appended in src/events/migrate.ts after grn_line_condition.sql; grn_line.sql is
-- NOT edited. MIRRORED verbatim at the tail of deploy/compose/init-db.sql - change both together.
--
-- Guarded to run ONCE (adding a CHECK scans the table under ACCESS EXCLUSIVE): the constraint block
-- is skipped when its last constraint is already in place.

ALTER TABLE grn_line ADD COLUMN IF NOT EXISTS inspect_on_opening TEXT;
ALTER TABLE grn_line ADD COLUMN IF NOT EXISTS inspect_note TEXT;
ALTER TABLE grn_line ADD COLUMN IF NOT EXISTS inspect_photo_ref TEXT;
ALTER TABLE grn_line ADD COLUMN IF NOT EXISTS material_photo_ref TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_grn_line_inspect_evidence'
      AND conrelid = 'grn_line'::regclass
  ) THEN
    ALTER TABLE grn_line DROP CONSTRAINT IF EXISTS chk_grn_line_inspect_on_opening;
    ALTER TABLE grn_line
      ADD CONSTRAINT chk_grn_line_inspect_on_opening
      CHECK (inspect_on_opening IS NULL OR inspect_on_opening IN ('suspected', 'observed'));

    ALTER TABLE grn_line
      ADD CONSTRAINT chk_grn_line_inspect_evidence
      CHECK (
        inspect_on_opening IS NOT NULL
        OR (inspect_note IS NULL AND inspect_photo_ref IS NULL)
      );
  END IF;
END $$;
