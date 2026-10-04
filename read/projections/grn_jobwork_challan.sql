-- Pilot Ruling B: customer-owned job-work material is received against the job-work (service)
-- order plus the customer's challan - no purchase order, weighbridge optional. The receipt rides
-- the existing goods.received flow as a third source_document kind, 'JOBWORK_CHALLAN', so the GRN
-- header and line must be able to say "no purchase order", "no weighbridge ticket" and "no gate
-- correlation" honestly (NULL), never with a sentinel reference a PO number could collide with and
-- never with a caller-chosen correlation id the gate-dwell view would join on.
--
-- Forward-only and idempotent: tail-appended in src/events/migrate.ts after grn.sql and
-- grn_line.sql, which are NOT edited. Their guarded re-add of chk_grn_source_document is keyed on
-- the constraint NAME, so the widened constraint below survives a re-run of grn.sql, and their
-- CREATE TABLE IF NOT EXISTS never re-imposes the NOT NULLs dropped here. MIRRORED verbatim at the
-- tail of deploy/compose/init-db.sql for first-boot container init - change both files together.
--
-- Guarded to run ONCE: adding a CHECK scans the table under ACCESS EXCLUSIVE, so the whole block is
-- skipped when its LAST constraint is already in place (the grn.sql constraint-name idiom).
--
-- The new CHECKs keep every purchase-order and ASN receipt exactly as strict as before: only a
-- JOBWORK_CHALLAN header, and only a job_work line, may omit the purchase-order reference, the
-- weighbridge ticket or the correlation id.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_grn_correlation_by_source_document'
      AND conrelid = 'grn'::regclass
  ) THEN
    ALTER TABLE grn ALTER COLUMN po_ref_ext DROP NOT NULL;
    ALTER TABLE grn ALTER COLUMN correlation_id DROP NOT NULL;
    ALTER TABLE grn_line ALTER COLUMN po_ref_ext DROP NOT NULL;
    ALTER TABLE grn_line ALTER COLUMN line_no DROP NOT NULL;
    ALTER TABLE grn_line ALTER COLUMN weighbridge_correlation_id DROP NOT NULL;

    ALTER TABLE grn DROP CONSTRAINT IF EXISTS chk_grn_source_document;
    ALTER TABLE grn
      ADD CONSTRAINT chk_grn_source_document
      CHECK (source_document IN ('PO', 'ASN', 'JOBWORK_CHALLAN'));

    ALTER TABLE grn DROP CONSTRAINT IF EXISTS chk_grn_po_ref_by_source_document;
    ALTER TABLE grn
      ADD CONSTRAINT chk_grn_po_ref_by_source_document
      CHECK ((source_document = 'JOBWORK_CHALLAN') = (po_ref_ext IS NULL));

    ALTER TABLE grn_line DROP CONSTRAINT IF EXISTS chk_grn_line_po_ref_pair;
    ALTER TABLE grn_line
      ADD CONSTRAINT chk_grn_line_po_ref_pair
      CHECK ((po_ref_ext IS NULL) = (line_no IS NULL));

    ALTER TABLE grn_line DROP CONSTRAINT IF EXISTS chk_grn_line_no_po_job_work_only;
    ALTER TABLE grn_line
      ADD CONSTRAINT chk_grn_line_no_po_job_work_only
      CHECK (po_ref_ext IS NOT NULL OR stock_class = 'job_work');

    ALTER TABLE grn_line DROP CONSTRAINT IF EXISTS chk_grn_line_no_ticket_job_work_only;
    ALTER TABLE grn_line
      ADD CONSTRAINT chk_grn_line_no_ticket_job_work_only
      CHECK (weighbridge_correlation_id IS NOT NULL OR (po_ref_ext IS NULL AND stock_class = 'job_work'));

    ALTER TABLE grn
      ADD CONSTRAINT chk_grn_correlation_by_source_document
      CHECK (correlation_id IS NOT NULL OR source_document = 'JOBWORK_CHALLAN');
  END IF;
END $$;
