-- BIS licence register - minimal enforcement contract (Story 8.6, FR-Q-11, AC 1 and AC 2). This
-- file is the CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Story 8.6 Binding Scope Decision 1: this table carries ONLY the columns the statutory release
-- block reads. Story 8.7 adds the CRUD routes, approval workflow, edit-logging, expiry alerts and
-- any additional columns. Story 8.6 ships NO write routes and NO event types for this table;
-- integration fixtures seed rows through the admin pool, so app_user holds SELECT only.
--
-- Binding Scope Decision 5: a row covers a release when sku matches, the site scope admits the
-- task's site, and valid_from <= asOf <= valid_to (asOf is the IST calendar date derived from the
-- server-stamped release time). licence_type distinguishes a CM/L number from an R-number under
-- the BIS Conformity Assessment Regulations 2018.
--
-- Binding Scope Decision 6: site_id NULL means the licence covers ALL sites; the resolver prefers
-- a site-specific row over a global row when both are valid. The uniqueness grain
-- (licence_number, sku, site scope) treats all-NULL site rows as equal, which a plain UNIQUE
-- constraint would not (NULLs compare distinct), so it is a unique expression index over
-- COALESCE(site_id, zero-uuid).

CREATE TABLE IF NOT EXISTS compliance_bis_licence (
  licence_id     UUID PRIMARY KEY,
  licence_number TEXT NOT NULL,
  licence_type   TEXT NOT NULL,
  sku            TEXT NOT NULL,
  site_id        UUID,
  valid_from     DATE NOT NULL,
  valid_to       DATE NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_compliance_bis_licence_number CHECK (btrim(licence_number) <> ''),
  CONSTRAINT chk_compliance_bis_licence_type CHECK (licence_type IN ('cml', 'r_number')),
  CONSTRAINT chk_compliance_bis_licence_window CHECK (valid_to >= valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_bis_licence_scope
  ON compliance_bis_licence (
    licence_number,
    sku,
    COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS idx_compliance_bis_licence_sku ON compliance_bis_licence (sku, valid_to);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_compliance_bis_licence_number'
      AND conrelid = 'compliance_bis_licence'::regclass
  ) THEN
    ALTER TABLE compliance_bis_licence
      ADD CONSTRAINT chk_compliance_bis_licence_number CHECK (btrim(licence_number) <> '');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_compliance_bis_licence_type'
      AND conrelid = 'compliance_bis_licence'::regclass
  ) THEN
    ALTER TABLE compliance_bis_licence
      ADD CONSTRAINT chk_compliance_bis_licence_type CHECK (licence_type IN ('cml', 'r_number'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_compliance_bis_licence_window'
      AND conrelid = 'compliance_bis_licence'::regclass
  ) THEN
    ALTER TABLE compliance_bis_licence
      ADD CONSTRAINT chk_compliance_bis_licence_window CHECK (valid_to >= valid_from);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT ON compliance_bis_licence TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON compliance_bis_licence TO readonly_user;
  END IF;
END $$;
