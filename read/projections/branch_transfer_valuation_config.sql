-- Per-GSTIN-pair branch transfer valuation configuration (Story 11.5, FR-AC-10). This file is the
-- CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Binding decision 4: the four Rule 28 bases are exactly open_market_value, like_kind_quality,
-- cost_plus (Rules 30/31) and invoice_value_full_itc (the second proviso). A pair's default basis
-- is DATED configuration effective on the transfer's IST business date; a pair with no effective
-- row is refused VALUATION_CONFIG_MISSING at create (fail closed). invoice_value_full_itc is only
-- meaningful where the recipient GSTIN is eligible for full ITC, so a default of that basis
-- without the eligibility flag is refused by CHECK. Overlapping windows for one pair are refused
-- at write time (409 VALUATION_CONFIG_OVERLAP); the UNIQUE below is the backstop for the
-- exact-same-start-date case only.

-- P8: btree_gist supplies the gist opclass for the scalar GSTIN halves of the exclusion constraint
-- below (the supplier.sql pg_trgm precedent for an extension declared inside a projection file).
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS branch_transfer_valuation_config (
  config_id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_gstin_ext               TEXT NOT NULL,
  to_gstin_ext                 TEXT NOT NULL,
  default_basis                TEXT NOT NULL,
  recipient_full_itc_eligible  BOOLEAN NOT NULL DEFAULT false,
  cost_plus_percent            NUMERIC(7, 3) NOT NULL DEFAULT 110,
  effective_from               DATE NOT NULL,
  effective_to                 DATE,
  created_by                   UUID NOT NULL,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_branch_transfer_valuation_config_pair_from UNIQUE (from_gstin_ext, to_gstin_ext, effective_from)
);

-- Guarded DROP-then-ADD constraint blocks (the bom_line precedent).
DO $$
BEGIN
  ALTER TABLE branch_transfer_valuation_config DROP CONSTRAINT IF EXISTS chk_branch_transfer_valuation_config_basis;
  ALTER TABLE branch_transfer_valuation_config ADD CONSTRAINT chk_branch_transfer_valuation_config_basis CHECK (
    default_basis IN ('open_market_value', 'like_kind_quality', 'cost_plus', 'invoice_value_full_itc')
  );
END $$;

-- P14: the same GSTIN shape site_gstin pins in chk_site_gstin_format, which is the one GSTIN_REGEX
-- src/compliance/supplier.ts pins on the app side. A malformed or lower-cased seed here matches no
-- resolved registration, and every transfer on that pair then fails closed with an invisible cause.
DO $$
BEGIN
  ALTER TABLE branch_transfer_valuation_config DROP CONSTRAINT IF EXISTS chk_branch_transfer_valuation_config_gstin_format;
  ALTER TABLE branch_transfer_valuation_config ADD CONSTRAINT chk_branch_transfer_valuation_config_gstin_format CHECK (
    from_gstin_ext ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'
    AND to_gstin_ext ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'
  );
END $$;

DO $$
BEGIN
  ALTER TABLE branch_transfer_valuation_config DROP CONSTRAINT IF EXISTS chk_branch_transfer_valuation_config_pair;
  ALTER TABLE branch_transfer_valuation_config ADD CONSTRAINT chk_branch_transfer_valuation_config_pair CHECK (
    from_gstin_ext <> to_gstin_ext
  );
END $$;

DO $$
BEGIN
  ALTER TABLE branch_transfer_valuation_config DROP CONSTRAINT IF EXISTS chk_branch_transfer_valuation_config_cost_plus;
  ALTER TABLE branch_transfer_valuation_config ADD CONSTRAINT chk_branch_transfer_valuation_config_cost_plus CHECK (
    cost_plus_percent >= 100
  );
END $$;

DO $$
BEGIN
  ALTER TABLE branch_transfer_valuation_config DROP CONSTRAINT IF EXISTS chk_branch_transfer_valuation_config_window;
  ALTER TABLE branch_transfer_valuation_config ADD CONSTRAINT chk_branch_transfer_valuation_config_window CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  );
END $$;

DO $$
BEGIN
  ALTER TABLE branch_transfer_valuation_config DROP CONSTRAINT IF EXISTS chk_branch_transfer_valuation_config_itc_default;
  ALTER TABLE branch_transfer_valuation_config ADD CONSTRAINT chk_branch_transfer_valuation_config_itc_default CHECK (
    default_basis <> 'invoice_value_full_itc' OR recipient_full_itc_eligible
  );
END $$;

-- The real overlap bar for one GSTIN pair (the UNIQUE above catches identical start dates only,
-- and the app-side read-then-write can be interleaved past by two concurrent writers).
DO $$
BEGIN
  ALTER TABLE branch_transfer_valuation_config DROP CONSTRAINT IF EXISTS excl_branch_transfer_valuation_config_window;
  ALTER TABLE branch_transfer_valuation_config ADD CONSTRAINT excl_branch_transfer_valuation_config_window EXCLUDE USING gist (
    from_gstin_ext WITH =,
    to_gstin_ext WITH =,
    daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]') WITH &&
  );
END $$;

-- Resolution reads filter by the pair then apply the date-range predicate.
CREATE INDEX IF NOT EXISTS idx_branch_transfer_valuation_config_lookup ON branch_transfer_valuation_config (from_gstin_ext, to_gstin_ext, effective_from);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE ON branch_transfer_valuation_config TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON branch_transfer_valuation_config TO readonly_user;
  END IF;
END $$;
