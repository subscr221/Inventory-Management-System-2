-- Ownership agreement read model (Story 2.8). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries
-- its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as
-- app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a live database
-- safely.
--
-- Derived state ONLY: rows are rebuildable by replaying ownership.agreement_set domain events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert. Grain is (sku, location_id, stock_class) restricted to
-- the non-owned supplier classes ('consignment', 'vmi'); at most ONE ACTIVE agreement per grain is
-- enforced by the partial unique index uq_ownership_agreement_active, so the owner party for a
-- consignment/vmi balance is always resolvable from its grain. owner_party_code is an owner-party
-- supplier code (validated shape-wise here; referential validation against ERP inbound projections
-- arrives with Story 2.9, and the governed supplier registry with Epic 4 Story 4.1 - codes are
-- superseded without renumbering). vmi_min_qty is the VMI agreement minimum owned by this story;
-- it is required (positive) for 'vmi' agreements and NULL for 'consignment'.

CREATE TABLE IF NOT EXISTS ownership_agreement (
  agreement_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku              TEXT NOT NULL,
  location_id      UUID NOT NULL,
  stock_class      TEXT NOT NULL,
  owner_party_code TEXT NOT NULL,
  vmi_min_qty      NUMERIC(14, 3),
  active           BOOLEAN NOT NULL DEFAULT true,
  business_stream  TEXT NOT NULL,
  set_by_actor_id  UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_ownership_agreement_stock_class CHECK (stock_class IN ('consignment', 'vmi')),
  CONSTRAINT chk_ownership_agreement_vmi_min_positive CHECK (vmi_min_qty IS NULL OR vmi_min_qty > 0),
  CONSTRAINT chk_ownership_agreement_vmi_min_required CHECK (stock_class <> 'vmi' OR active IS FALSE OR vmi_min_qty IS NOT NULL),
  CONSTRAINT chk_ownership_agreement_owner_party_code CHECK (owner_party_code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$')
);

ALTER TABLE ownership_agreement ALTER COLUMN vmi_min_qty TYPE NUMERIC(14, 3);

CREATE INDEX IF NOT EXISTS idx_ownership_agreement_location ON ownership_agreement (location_id);
CREATE INDEX IF NOT EXISTS idx_ownership_agreement_sku ON ownership_agreement (sku);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ownership_agreement_active ON ownership_agreement (sku, location_id, stock_class) WHERE active;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_ownership_agreement_stock_class'
      AND conrelid = 'ownership_agreement'::regclass
  ) THEN
    ALTER TABLE ownership_agreement
      ADD CONSTRAINT chk_ownership_agreement_stock_class CHECK (stock_class IN ('consignment', 'vmi'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_ownership_agreement_vmi_min_positive'
      AND conrelid = 'ownership_agreement'::regclass
  ) THEN
    ALTER TABLE ownership_agreement
      ADD CONSTRAINT chk_ownership_agreement_vmi_min_positive CHECK (vmi_min_qty IS NULL OR vmi_min_qty > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_ownership_agreement_vmi_min_required'
      AND conrelid = 'ownership_agreement'::regclass
  ) THEN
    ALTER TABLE ownership_agreement
      ADD CONSTRAINT chk_ownership_agreement_vmi_min_required CHECK (stock_class <> 'vmi' OR active IS FALSE OR vmi_min_qty IS NOT NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_ownership_agreement_owner_party_code'
      AND conrelid = 'ownership_agreement'::regclass
  ) THEN
    ALTER TABLE ownership_agreement
      ADD CONSTRAINT chk_ownership_agreement_owner_party_code CHECK (owner_party_code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON ownership_agreement TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON ownership_agreement TO readonly_user;
  END IF;
END $$;
