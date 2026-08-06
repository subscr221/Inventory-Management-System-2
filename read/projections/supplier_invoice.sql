-- Supplier invoice header read model (Story 4.7). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries
-- its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as
-- app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a live database
-- safely.
--
-- Derived state ONLY: rows are derived exclusively at persist time from supplier_invoice.* and
-- invoice_ingestion.* domain events; mutation happens exclusively through persistEvent, which
-- applies this projection inside the SAME transaction as the domain_events insert. Status
-- vocabulary is the two AC values (unmatched, captured). uq_supplier_invoice_duplicate_grain is
-- the final concurrency guard for AC3's ordinary-path duplicate block: it is a PARTIAL unique
-- index (only rows with duplicate_of_invoice_id IS NULL participate), so an evidenced override
-- row never collides with the original it overrides. GST/monetary columns are exact NUMERIC -
-- never floating point.

CREATE TABLE IF NOT EXISTS supplier_invoice (
  invoice_id                     UUID PRIMARY KEY,
  supplier_id                    UUID NOT NULL,
  supplier_gstin_ext             TEXT NOT NULL,
  invoice_number_ext             TEXT NOT NULL,
  invoice_number_normalized      TEXT NOT NULL,
  invoice_date                   DATE NOT NULL,
  financial_year_start           INTEGER NOT NULL,
  po_id                          UUID,
  site_id                        UUID,
  business_stream                TEXT,
  status                         TEXT NOT NULL DEFAULT 'unmatched',
  currency                       TEXT NOT NULL DEFAULT 'INR',
  recipient_gstin_ext            TEXT,
  irn_ext                        TEXT,
  subtotal                       NUMERIC(14,2),
  cgst_total                     NUMERIC(14,2),
  sgst_total                     NUMERIC(14,2),
  igst_total                     NUMERIC(14,2),
  cess_total                     NUMERIC(14,2),
  total_value                    NUMERIC(14,2),
  msme_classification_at_capture TEXT,
  statutory_due_date             DATE,
  statutory_due_rule_version     TEXT,
  duplicate_of_invoice_id        UUID,
  duplicate_override_reason      TEXT,
  capture_method                 TEXT,
  ingestion_id                   UUID,
  captured_by                    UUID NOT NULL,
  captured_at                    TIMESTAMPTZ NOT NULL,
  correlation_id                 UUID,
  source_event_id                UUID NOT NULL,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_supplier_invoice_status CHECK (status IN ('unmatched','captured')),
  CONSTRAINT chk_supplier_invoice_capture_method CHECK (capture_method IN ('manual','file')),
  CONSTRAINT chk_supplier_invoice_status_po_pairing CHECK (
    (status = 'unmatched' AND po_id IS NULL AND site_id IS NULL AND business_stream IS NULL)
    OR (status = 'captured' AND po_id IS NOT NULL AND site_id IS NOT NULL AND business_stream IS NOT NULL)
  ),
  CONSTRAINT chk_supplier_invoice_duplicate_pairing CHECK (
    (duplicate_of_invoice_id IS NULL AND duplicate_override_reason IS NULL)
    OR (duplicate_of_invoice_id IS NOT NULL AND duplicate_override_reason IS NOT NULL AND btrim(duplicate_override_reason) <> '')
  ),
  CONSTRAINT chk_supplier_invoice_subtotal_non_negative CHECK (subtotal IS NULL OR subtotal >= 0),
  CONSTRAINT chk_supplier_invoice_cgst_non_negative CHECK (cgst_total IS NULL OR cgst_total >= 0),
  CONSTRAINT chk_supplier_invoice_sgst_non_negative CHECK (sgst_total IS NULL OR sgst_total >= 0),
  CONSTRAINT chk_supplier_invoice_igst_non_negative CHECK (igst_total IS NULL OR igst_total >= 0),
  CONSTRAINT chk_supplier_invoice_cess_non_negative CHECK (cess_total IS NULL OR cess_total >= 0),
  CONSTRAINT chk_supplier_invoice_total_non_negative CHECK (total_value IS NULL OR total_value >= 0),
  CONSTRAINT chk_supplier_invoice_msme_classification CHECK (
    msme_classification_at_capture IS NULL
    OR msme_classification_at_capture IN ('micro','small','medium','not_msme')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_invoice_duplicate_grain
  ON supplier_invoice (supplier_gstin_ext, invoice_number_normalized, financial_year_start)
  WHERE duplicate_of_invoice_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_unmatched ON supplier_invoice (status) WHERE status = 'unmatched';
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_supplier_date ON supplier_invoice (supplier_id, invoice_date);
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_po ON supplier_invoice (po_id);
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_site_status ON supplier_invoice (site_id, status);
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_gst_recon ON supplier_invoice (supplier_gstin_ext, financial_year_start);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_status'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_status CHECK (status IN ('unmatched','captured'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_capture_method'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_capture_method CHECK (capture_method IN ('manual','file'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_status_po_pairing'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_status_po_pairing CHECK (
        (status = 'unmatched' AND po_id IS NULL AND site_id IS NULL AND business_stream IS NULL)
        OR (status = 'captured' AND po_id IS NOT NULL AND site_id IS NOT NULL AND business_stream IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_duplicate_pairing'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_duplicate_pairing CHECK (
        (duplicate_of_invoice_id IS NULL AND duplicate_override_reason IS NULL)
        OR (duplicate_of_invoice_id IS NOT NULL AND duplicate_override_reason IS NOT NULL AND btrim(duplicate_override_reason) <> '')
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_subtotal_non_negative'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_subtotal_non_negative CHECK (subtotal IS NULL OR subtotal >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_cgst_non_negative'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_cgst_non_negative CHECK (cgst_total IS NULL OR cgst_total >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_sgst_non_negative'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_sgst_non_negative CHECK (sgst_total IS NULL OR sgst_total >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_igst_non_negative'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_igst_non_negative CHECK (igst_total IS NULL OR igst_total >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_cess_non_negative'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_cess_non_negative CHECK (cess_total IS NULL OR cess_total >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_total_non_negative'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_total_non_negative CHECK (total_value IS NULL OR total_value >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_msme_classification'
      AND conrelid = 'supplier_invoice'::regclass
  ) THEN
    ALTER TABLE supplier_invoice
      ADD CONSTRAINT chk_supplier_invoice_msme_classification CHECK (
        msme_classification_at_capture IS NULL
        OR msme_classification_at_capture IN ('micro','small','medium','not_msme')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON supplier_invoice TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON supplier_invoice TO readonly_user;
  END IF;
END $$;

-- Story 4.6 additive migration: statutory breach marker set by the daily compliance check when an
-- MSME invoice passes its statutory due date unpaid. Orthogonal to the unmatched/captured status
-- lifecycle - chk_supplier_invoice_status is untouched.
ALTER TABLE IF EXISTS supplier_invoice ADD COLUMN IF NOT EXISTS statutory_breach BOOLEAN NOT NULL DEFAULT false;
