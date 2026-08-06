-- Supplier registry read model (Story 4.1). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries
-- its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as
-- app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a live database
-- safely.
--
-- Derived state ONLY: rows are rebuildable by replaying supplier.* domain events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert. GSTIN uniqueness is enforced by the partial unique index
-- uq_supplier_gstin which covers only onboarding and active suppliers so a deactivated supplier's
-- GSTIN does not block a corrected re-registration. owner_party_code is the supplier's governed
-- short-code, unique across all statuses, validated by the same regex as ownership agreement codes
-- (Story 2.8). PAN format is not validated in Phase 1.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS supplier (
  supplier_id                  UUID PRIMARY KEY,
  legal_name                   TEXT NOT NULL,
  owner_party_code             TEXT NOT NULL,
  gstin_ext                    TEXT,
  pan_ext                      TEXT,
  contacts                     JSONB NOT NULL DEFAULT '[]'::jsonb,
  credit_period_days           INTEGER NOT NULL DEFAULT 0,
  commercial_terms             TEXT,
  freight_terms                TEXT,
  delivery_terms               TEXT,
  certification_references     JSONB NOT NULL DEFAULT '[]'::jsonb,
  status                       TEXT NOT NULL DEFAULT 'onboarding',
  deactivation_reason_code     TEXT,
  deactivated_at               TIMESTAMPTZ,
  onboarding_submitted_at      TIMESTAMPTZ,
  onboarding_approved_at       TIMESTAMPTZ,
  onboarding_approved_by       UUID,
  onboarding_rejection_reason  TEXT,
  created_by                   UUID NOT NULL,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_supplier_status CHECK (status IN ('onboarding', 'active', 'inactive')),
  CONSTRAINT chk_supplier_credit_period_non_negative CHECK (credit_period_days >= 0),
  CONSTRAINT chk_supplier_deactivation_reason CHECK (
    deactivation_reason_code IS NULL
    OR deactivation_reason_code IN ('fraud', 'business_closure', 'duplicate', 'compliance_failure', 'voluntary')
  ),
  CONSTRAINT chk_supplier_owner_party_code CHECK (owner_party_code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_gstin ON supplier (gstin_ext) WHERE status IN ('onboarding', 'active');
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_owner_party_code ON supplier (owner_party_code);
CREATE INDEX IF NOT EXISTS idx_supplier_legal_name_trgm ON supplier USING gin (legal_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_supplier_owner_party_code_trgm ON supplier USING gin (owner_party_code gin_trgm_ops);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_status'
      AND conrelid = 'supplier'::regclass
  ) THEN
    ALTER TABLE supplier
      ADD CONSTRAINT chk_supplier_status CHECK (status IN ('onboarding', 'active', 'inactive'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_credit_period_non_negative'
      AND conrelid = 'supplier'::regclass
  ) THEN
    ALTER TABLE supplier
      ADD CONSTRAINT chk_supplier_credit_period_non_negative CHECK (credit_period_days >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_deactivation_reason'
      AND conrelid = 'supplier'::regclass
  ) THEN
    ALTER TABLE supplier
      ADD CONSTRAINT chk_supplier_deactivation_reason CHECK (
        deactivation_reason_code IS NULL
        OR deactivation_reason_code IN ('fraud', 'business_closure', 'duplicate', 'compliance_failure', 'voluntary')
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_owner_party_code'
      AND conrelid = 'supplier'::regclass
  ) THEN
    ALTER TABLE supplier
      ADD CONSTRAINT chk_supplier_owner_party_code CHECK (owner_party_code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON supplier TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON supplier TO readonly_user;
  END IF;
END $$;

-- Story 4.6 additive migration: MSME compliance fields (Udyam registration, classification,
-- revalidation lifecycle). msme_status is a SEPARATE axis from supplier.status - the supplier
-- lifecycle gates (SUPPLIER_NOT_ACTIVE) never read it and chk_supplier_status is untouched.
-- Set exclusively by supplier.msme_verified / supplier.msme_suspended events via persistEvent.
-- Note: supplier.msme_classification is restricted to ('micro','small','medium') because the
-- column is null when the supplier is not currently MSME-flagged. supplier_invoice carries
-- 'not_msme' as a fourth value to preserve the capture-time classification when a supplier
-- loses MSME status after invoicing; do not align these vocabularies.
ALTER TABLE IF EXISTS supplier ADD COLUMN IF NOT EXISTS udyam_number_ext TEXT;
ALTER TABLE IF EXISTS supplier ADD COLUMN IF NOT EXISTS msme_classification TEXT;
ALTER TABLE IF EXISTS supplier ADD COLUMN IF NOT EXISTS msme_certificate_reference TEXT;
ALTER TABLE IF EXISTS supplier ADD COLUMN IF NOT EXISTS msme_status TEXT;
ALTER TABLE IF EXISTS supplier ADD COLUMN IF NOT EXISTS udyam_verified_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS supplier ADD COLUMN IF NOT EXISTS udyam_revalidation_due_date DATE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_msme_classification'
      AND conrelid = 'supplier'::regclass
  ) THEN
    ALTER TABLE supplier
      ADD CONSTRAINT chk_supplier_msme_classification CHECK (
        msme_classification IS NULL OR msme_classification IN ('micro', 'small', 'medium')
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_msme_status'
      AND conrelid = 'supplier'::regclass
  ) THEN
    ALTER TABLE supplier
      ADD CONSTRAINT chk_supplier_msme_status CHECK (
        msme_status IS NULL OR msme_status IN ('active', 'suspended-pending-reverification')
      );
  END IF;
END $$;
