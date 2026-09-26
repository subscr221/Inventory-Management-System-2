-- Story 3.11: GRN line condition and reason codes. Every GRN line carries the physical condition of
-- its quantity as reported at the dock (a report, not a verdict - QC decides) and, when the line is
-- not clean, exactly one fixed grouped reason code (SHORT, DAMAGED, REJECTED, OTHER) with its
-- fixed sub-reason, or for OTHER a photo reference plus a one-line note. The catalogue lives in
-- src/compliance/receiving-reasons.ts; these CHECKs are the backstop behind the seam's clean
-- error codes. The short-line rule (a GOOD line that leaves the PO line short needs SHORT or
-- OTHER) depends on the PO band at posting time and is NOT a CHECK - it lives in the applier.
--
-- Forward-only and idempotent: tail-appended in src/events/migrate.ts after grn_jobwork_challan.sql;
-- grn_line.sql is NOT edited. Existing rows backfill to 'GOOD' with no reason and satisfy every
-- CHECK. The column is line_condition, not condition (an SQL keyword). MIRRORED verbatim at the
-- tail of deploy/compose/init-db.sql for first-boot container init - change both files together.
--
-- Guarded to run ONCE: adding a CHECK scans the table under ACCESS EXCLUSIVE, so the constraint
-- block is skipped when its LAST constraint is already in place (the grn.sql constraint-name idiom).

ALTER TABLE grn_line ADD COLUMN IF NOT EXISTS line_condition TEXT NOT NULL DEFAULT 'GOOD';
ALTER TABLE grn_line ADD COLUMN IF NOT EXISTS reason_code TEXT;
ALTER TABLE grn_line ADD COLUMN IF NOT EXISTS reason_detail TEXT;
ALTER TABLE grn_line ADD COLUMN IF NOT EXISTS reason_note TEXT;
ALTER TABLE grn_line ADD COLUMN IF NOT EXISTS reason_photo_ref TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_grn_line_other_evidence'
      AND conrelid = 'grn_line'::regclass
  ) THEN
    ALTER TABLE grn_line DROP CONSTRAINT IF EXISTS chk_grn_line_condition;
    ALTER TABLE grn_line
      ADD CONSTRAINT chk_grn_line_condition
      CHECK (line_condition IN ('GOOD', 'DAMAGED', 'REJECTED'));

    ALTER TABLE grn_line DROP CONSTRAINT IF EXISTS chk_grn_line_reason_code;
    ALTER TABLE grn_line
      ADD CONSTRAINT chk_grn_line_reason_code
      CHECK (reason_code IS NULL OR reason_code IN ('SHORT', 'DAMAGED', 'REJECTED', 'OTHER'));

    ALTER TABLE grn_line DROP CONSTRAINT IF EXISTS chk_grn_line_condition_needs_reason;
    ALTER TABLE grn_line
      ADD CONSTRAINT chk_grn_line_condition_needs_reason
      CHECK (line_condition = 'GOOD' OR reason_code IS NOT NULL);

    ALTER TABLE grn_line
      ADD CONSTRAINT chk_grn_line_other_evidence
      CHECK (
        reason_code IS DISTINCT FROM 'OTHER'
        OR (COALESCE(btrim(reason_photo_ref), '') <> '' AND COALESCE(btrim(reason_note), '') <> '')
      );
  END IF;
END $$;
