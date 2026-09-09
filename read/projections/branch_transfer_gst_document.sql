-- Branch transfer GST documents (Story 11.5, FR-AC-10). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql
-- duplicates this content for first-boot container init - change both files together. Every
-- statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a
-- live database safely.
--
-- INT-GST-01: the ERP remains the invoice issuer and this platform RECORDS the returned documents.
-- A gst_officer records the ERP-issued tax invoice (carrying the 64-hex IRN: every inter-GSTIN
-- supply is e-invoiceable, the Story 11.2 ruling) and, where the taxable value exceeds the
-- configured threshold, the e-way bill. One row per (transfer, kind); a replay with the SAME
-- document number is a no-op and a DIFFERENT number for the same kind is refused
-- GST_DOCUMENT_CONFLICT by the applier under the transfer row lock. The UNIQUE below is the
-- backstop, never the primary classifier (the 11.2 review "let the PK raise" note was rejected).
-- Document numbers are ERP-issued externals (_ext); the platform never mints them. recorded_by is
-- the authenticated actor pinned by both doors, never a payload field. A document row LOCKS the
-- valuation (the override is refused VALUATION_LOCKED once any row exists). GST documents are
-- retained for eight years (architecture spine); no DELETE grant.

CREATE TABLE IF NOT EXISTS branch_transfer_gst_document (
  document_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_request_id  UUID NOT NULL,
  document_kind        TEXT NOT NULL,
  document_number_ext  TEXT NOT NULL,
  irn_ext              TEXT,
  irp_acknowledged_at  TIMESTAMPTZ,
  ewb_valid_until      TIMESTAMPTZ,
  issued_at            TIMESTAMPTZ NOT NULL,
  site_id              UUID NOT NULL,
  recorded_by          UUID NOT NULL,
  source_event_id      UUID NOT NULL,
  correlation_id       UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_branch_transfer_gst_document_kind UNIQUE (transfer_request_id, document_kind)
);

-- Guarded DROP-then-ADD constraint blocks (the bom_line precedent).
DO $$
BEGIN
  ALTER TABLE branch_transfer_gst_document DROP CONSTRAINT IF EXISTS chk_branch_transfer_gst_document_kind;
  ALTER TABLE branch_transfer_gst_document ADD CONSTRAINT chk_branch_transfer_gst_document_kind CHECK (
    document_kind IN ('tax_invoice', 'e_way_bill')
  );
END $$;

DO $$
BEGIN
  ALTER TABLE branch_transfer_gst_document DROP CONSTRAINT IF EXISTS chk_branch_transfer_gst_document_number;
  ALTER TABLE branch_transfer_gst_document ADD CONSTRAINT chk_branch_transfer_gst_document_number CHECK (
    btrim(document_number_ext) <> ''
  );
END $$;

-- The dispatch_irn.sql precedent: a tax invoice carries the IRP's 64-character hexadecimal IRN,
-- lower-cased by both app doors.
DO $$
BEGIN
  ALTER TABLE branch_transfer_gst_document DROP CONSTRAINT IF EXISTS chk_branch_transfer_gst_document_irn;
  ALTER TABLE branch_transfer_gst_document ADD CONSTRAINT chk_branch_transfer_gst_document_irn CHECK (
    document_kind <> 'tax_invoice' OR (irn_ext IS NOT NULL AND irn_ext ~ '^[0-9a-f]{64}$')
  );
END $$;

DO $$
BEGIN
  ALTER TABLE branch_transfer_gst_document DROP CONSTRAINT IF EXISTS chk_branch_transfer_gst_document_ewb_validity;
  ALTER TABLE branch_transfer_gst_document ADD CONSTRAINT chk_branch_transfer_gst_document_ewb_validity CHECK (
    document_kind <> 'e_way_bill' OR ewb_valid_until IS NOT NULL
  );
END $$;

-- Both indexes are PLAIN (non-unique) by design. Source event: the applier writes one row per
-- event today and a later multi-document recording must not be broken by a UNIQUE. Document
-- number: this follows the Story 11.2 dispatch_irn COVERAGE grain (ruled 2026-09-09) - one ERP
-- tax invoice legitimately covers several movements (one invoice, three trucks, the same day), so
-- the same document_number_ext across different transfer requests is correct, not a defect.
CREATE INDEX IF NOT EXISTS idx_branch_transfer_gst_document_source_event ON branch_transfer_gst_document (source_event_id);
CREATE INDEX IF NOT EXISTS idx_branch_transfer_gst_document_number ON branch_transfer_gst_document (document_number_ext);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE ON branch_transfer_gst_document TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON branch_transfer_gst_document TO readonly_user;
  END IF;
END $$;
