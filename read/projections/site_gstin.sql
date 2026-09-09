-- Site GSTIN registration (Story 11.5, FR-AC-10). This file is the CANONICAL definition, applied
-- by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its
-- OWN grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as
-- app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a live database.
--
-- Binding decision 2: the site GSTIN is a DATED REGISTRATION TABLE, not a column on
-- location_register. location_register is edge-synced, its site_id is a bare UUID with no site row
-- behind it (a site "is" a level = 'site' row by convention only), and a GSTIN can change on
-- re-registration. A row keyed by site_id with a validity window follows the
-- compliance_bis_licence / transaction_tagging_rules dated-config shape and leaves the pinned
-- Story 2.5 and location DDL untouched. site_id has no FK because there is no site table.
--
-- Binding decision 1: a cross-site transfer resolves BOTH sites through this table on the IST
-- business date. A missing registration on either side is refused SITE_GSTIN_MISSING (the Story
-- 8.6 default-enforce rule), so every site that ships or receives a transfer needs a row here.
-- Overlapping windows for one site are refused at write time (409 GSTIN_CONFIG_OVERLAP); the
-- UNIQUE below is the backstop for the exact-same-start-date case only.

-- P8: overlapping windows for one site are refused by the DATABASE too, not only by the app-side
-- read-then-write two concurrent writers can interleave past. btree_gist supplies the gist opclass
-- for the scalar site_id half of the exclusion constraint below (the supplier.sql pg_trgm
-- precedent for an extension declared inside a projection file).
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS site_gstin (
  registration_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id          UUID NOT NULL,
  gstin_ext        TEXT NOT NULL,
  legal_name_ext   TEXT,
  state_code_ext   TEXT,
  effective_from   DATE NOT NULL,
  effective_to     DATE,
  created_by       UUID NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_site_gstin_site_from UNIQUE (site_id, effective_from)
);

-- Guarded DROP-then-ADD constraint blocks (the bom_line precedent): the DROP + ADD pair is kept
-- atomic in a DO block so a re-apply is idempotent and a drift in the CHECK body is corrected.
-- The GSTIN shape is the one GSTIN_REGEX in src/compliance/supplier.ts pins on the app side.
DO $$
BEGIN
  ALTER TABLE site_gstin DROP CONSTRAINT IF EXISTS chk_site_gstin_format;
  ALTER TABLE site_gstin ADD CONSTRAINT chk_site_gstin_format CHECK (
    gstin_ext ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'
  );
END $$;

DO $$
BEGIN
  ALTER TABLE site_gstin DROP CONSTRAINT IF EXISTS chk_site_gstin_window;
  ALTER TABLE site_gstin ADD CONSTRAINT chk_site_gstin_window CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  );
END $$;

-- The real overlap bar (the UNIQUE above catches identical start dates only). A NULL effective_to
-- is open-ended, so it coalesces to 'infinity'; the range is inclusive at both ends because a
-- registration is valid ON its effective_to date.
DO $$
BEGIN
  ALTER TABLE site_gstin DROP CONSTRAINT IF EXISTS excl_site_gstin_window;
  ALTER TABLE site_gstin ADD CONSTRAINT excl_site_gstin_window EXCLUDE USING gist (
    site_id WITH =,
    daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]') WITH &&
  );
END $$;

-- Resolution reads filter by site_id then apply the date-range predicate.
CREATE INDEX IF NOT EXISTS idx_site_gstin_lookup ON site_gstin (site_id, effective_from);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE ON site_gstin TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON site_gstin TO readonly_user;
  END IF;
END $$;
