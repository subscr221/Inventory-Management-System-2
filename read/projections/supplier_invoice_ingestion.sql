-- Supplier invoice ingestion (file-review) read model (Story 4.7). CANONICAL definition, applied
-- by src/events/migrate.ts (npm run db:migrate); deploy/compose/init-db.sql duplicates this
-- content for first-boot container init - change both files together. Every statement is
-- idempotent.
--
-- Derived state ONLY: rows are derived exclusively at persist time from invoice_ingestion.* domain events.
-- Binary bytes never enter this table - only an immutable attachment reference, its SHA-256
-- hash, detected MIME, byte size, and the trusted extraction boundary's draft JSON (Binding
-- Scope Decisions: no binary attachment store is invented here). The attachment_ref unique index
-- guards against re-ingesting the SAME uploaded artifact twice; it is NOT a business duplicate
-- decision (that is the supplier_invoice duplicate grain) - a genuinely reused attachment
-- reference belongs to the SAME ingestion attempt, never a second one.

CREATE TABLE IF NOT EXISTS supplier_invoice_ingestion (
  ingestion_id        UUID PRIMARY KEY,
  source_format       TEXT NOT NULL,
  attachment_ref       TEXT NOT NULL,
  sha256_hash         TEXT NOT NULL,
  detected_mime       TEXT NOT NULL,
  byte_size           BIGINT NOT NULL,
  extracted_draft     JSONB NOT NULL,
  review_status       TEXT NOT NULL DEFAULT 'review-required',
  uploaded_by         UUID NOT NULL,
  uploaded_at         TIMESTAMPTZ NOT NULL,
  reviewed_by         UUID,
  reviewed_at         TIMESTAMPTZ,
  correction_summary  JSONB,
  resulting_invoice_id UUID,
  correlation_id      UUID,
  source_event_id     UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_supplier_invoice_ingestion_format CHECK (source_format IN ('pdf','csv','xml')),
  CONSTRAINT chk_supplier_invoice_ingestion_review_status CHECK (review_status IN ('review-required','reviewed')),
  CONSTRAINT chk_supplier_invoice_ingestion_byte_size_positive CHECK (byte_size > 0),
  CONSTRAINT chk_supplier_invoice_ingestion_reviewed_pairing CHECK (
    (review_status = 'review-required' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (review_status = 'reviewed' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_invoice_ingestion_attachment_ref
  ON supplier_invoice_ingestion (attachment_ref);
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_ingestion_review_status ON supplier_invoice_ingestion (review_status);
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_ingestion_resulting_invoice ON supplier_invoice_ingestion (resulting_invoice_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_ingestion_format'
      AND conrelid = 'supplier_invoice_ingestion'::regclass
  ) THEN
    ALTER TABLE supplier_invoice_ingestion
      ADD CONSTRAINT chk_supplier_invoice_ingestion_format CHECK (source_format IN ('pdf','csv','xml'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_ingestion_review_status'
      AND conrelid = 'supplier_invoice_ingestion'::regclass
  ) THEN
    ALTER TABLE supplier_invoice_ingestion
      ADD CONSTRAINT chk_supplier_invoice_ingestion_review_status CHECK (review_status IN ('review-required','reviewed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_ingestion_byte_size_positive'
      AND conrelid = 'supplier_invoice_ingestion'::regclass
  ) THEN
    ALTER TABLE supplier_invoice_ingestion
      ADD CONSTRAINT chk_supplier_invoice_ingestion_byte_size_positive CHECK (byte_size > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_invoice_ingestion_reviewed_pairing'
      AND conrelid = 'supplier_invoice_ingestion'::regclass
  ) THEN
    ALTER TABLE supplier_invoice_ingestion
      ADD CONSTRAINT chk_supplier_invoice_ingestion_reviewed_pairing CHECK (
        (review_status = 'review-required' AND reviewed_by IS NULL AND reviewed_at IS NULL)
        OR (review_status = 'reviewed' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON supplier_invoice_ingestion TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON supplier_invoice_ingestion TO readonly_user;
  END IF;
END $$;
