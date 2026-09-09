-- Branch transfer valuation (Story 11.5, FR-AC-10). This file is the CANONICAL definition, applied
-- by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its
-- OWN grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as
-- app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a live database.
--
-- Binding decision 3: valuation lives in a SIBLING table keyed by transfer_request_id, not in new
-- columns on transfer_request, so the pinned Story 2.5 DDL is untouched. One row exists ONLY for
-- an inter-GSTIN transfer (a Schedule I supply between distinct persons, valued under Rule 28);
-- intra-site and intra-GSTIN transfers have no row. Legacy inter-GSTIN rows created before this
-- migration have no sibling either; the ship gate re-derives their class and refuses them as
-- not_valued rather than assuming they are safe.
--
-- Binding decision 5: the override is a separate gst_officer event, never a field on create.
-- basis_source records which path produced the value; overridden_by / override_reason_code are
-- both null (config_default) or both present (override). The actor is the authenticated identity
-- (metadata.actor.user_id), never a payload field - the Story 9.8-2 attribution class.
-- transfer_request_id and the site / config ids are FK-shaped with no declared FK (house convention).

CREATE TABLE IF NOT EXISTS branch_transfer_valuation (
  transfer_request_id   UUID PRIMARY KEY,
  from_site_id          UUID NOT NULL,
  to_site_id            UUID NOT NULL,
  from_gstin_ext        TEXT NOT NULL,
  to_gstin_ext          TEXT NOT NULL,
  business_date         DATE NOT NULL,
  valuation_config_id   UUID,
  valuation_basis       TEXT NOT NULL,
  basis_source          TEXT NOT NULL,
  cost_plus_percent     NUMERIC(7, 3),
  declared_unit_value   NUMERIC(18, 6),
  unit_value            NUMERIC(18, 6) NOT NULL,
  taxable_value         NUMERIC(18, 2) NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'INR',
  overridden_by         UUID,
  override_reason_code  TEXT,
  valued_at             TIMESTAMPTZ NOT NULL,
  source_event_id       UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Guarded DROP-then-ADD constraint blocks (the bom_line precedent).
DO $$
BEGIN
  ALTER TABLE branch_transfer_valuation DROP CONSTRAINT IF EXISTS chk_branch_transfer_valuation_basis;
  ALTER TABLE branch_transfer_valuation ADD CONSTRAINT chk_branch_transfer_valuation_basis CHECK (
    valuation_basis IN ('open_market_value', 'like_kind_quality', 'cost_plus', 'invoice_value_full_itc')
  );
END $$;

DO $$
BEGIN
  ALTER TABLE branch_transfer_valuation DROP CONSTRAINT IF EXISTS chk_branch_transfer_valuation_basis_source;
  ALTER TABLE branch_transfer_valuation ADD CONSTRAINT chk_branch_transfer_valuation_basis_source CHECK (
    basis_source IN ('config_default', 'declared', 'override')
  );
END $$;

DO $$
BEGIN
  ALTER TABLE branch_transfer_valuation DROP CONSTRAINT IF EXISTS chk_branch_transfer_valuation_taxable_value;
  ALTER TABLE branch_transfer_valuation ADD CONSTRAINT chk_branch_transfer_valuation_taxable_value CHECK (
    taxable_value > 0
  );
END $$;

-- P5: a Schedule I supply valued at zero is not a valuation, it is a missing one. The per-unit
-- figure and the resulting taxable value are both strictly positive; a nil-rated or exempt supply
-- is still valued under Rule 28 and taxed at its rate, never recorded here at zero.
DO $$
BEGIN
  ALTER TABLE branch_transfer_valuation DROP CONSTRAINT IF EXISTS chk_branch_transfer_valuation_unit_value;
  ALTER TABLE branch_transfer_valuation ADD CONSTRAINT chk_branch_transfer_valuation_unit_value CHECK (
    unit_value > 0
  );
END $$;

-- The override pair is all-or-nothing, and a present reason code is non-blank (the
-- maintenance_warranty_override shape).
DO $$
BEGIN
  ALTER TABLE branch_transfer_valuation DROP CONSTRAINT IF EXISTS chk_branch_transfer_valuation_override_pair;
  ALTER TABLE branch_transfer_valuation ADD CONSTRAINT chk_branch_transfer_valuation_override_pair CHECK (
    (overridden_by IS NULL AND override_reason_code IS NULL)
    OR (overridden_by IS NOT NULL AND override_reason_code IS NOT NULL AND btrim(override_reason_code) <> '')
  );
END $$;

-- D3 / P6: basis_source is tied to the attribution column at the storage layer. An override
-- REQUIRES the authenticated actor who made it (an unattributed override is the Story 9.8-2
-- attribution class one layer down), and any other source carries no actor at all. 'declared' is
-- the creator-supplied declared_unit_value path: a human's figure is recorded as declared, never
-- as config_default, so the audit trail never presents it as system-derived.
DO $$
BEGIN
  ALTER TABLE branch_transfer_valuation DROP CONSTRAINT IF EXISTS chk_branch_transfer_valuation_source_attribution;
  ALTER TABLE branch_transfer_valuation ADD CONSTRAINT chk_branch_transfer_valuation_source_attribution CHECK (
    (basis_source = 'override' AND overridden_by IS NOT NULL)
    OR (basis_source <> 'override' AND overridden_by IS NULL)
  );
END $$;

CREATE INDEX IF NOT EXISTS idx_branch_transfer_valuation_pair ON branch_transfer_valuation (from_gstin_ext, to_gstin_ext, business_date);
CREATE INDEX IF NOT EXISTS idx_branch_transfer_valuation_source_event ON branch_transfer_valuation (source_event_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE ON branch_transfer_valuation TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON branch_transfer_valuation TO readonly_user;
  END IF;
END $$;
