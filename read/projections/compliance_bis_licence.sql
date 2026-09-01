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
-- integration fixtures seed rows through the admin pool. Story 8.7 grants app_user
-- INSERT/UPDATE (see the grants at the foot of this file); the Story 8.6 read-only posture no
-- longer holds.
--
-- Story 8.7 Binding Scope Decision 2: adds `status` ('active'/'expired') as the AC 2 "marked
-- invalid" artifact. Story 8.7 code review: status is an ALERTING ARTIFACT, never a release gate.
-- The valid_from/valid_to window is the only truth the release path reads, because an unconditional
-- status flip (a mis-dated sweep tick, a UTC-vs-IST boundary) would otherwise block every release
-- for a licence whose window is still valid, with no path back except a manual PATCH. Fail-closed
-- is right; unrecoverable fail-closed is not. The column is still written by the sweep and is what
-- the ledger and the notifications are derived from. The scope uniqueness index is replaced with
-- a case-folded, trimmed form (lower(btrim(licence_number))) closing the case-folding deferral;
-- write paths trim licence_number, preserving original case in the stored value. app_user gains
-- INSERT/UPDATE because Story 8.7 routes write through the app pool inside persistEvent
-- transactions.
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
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_compliance_bis_licence_number CHECK (btrim(licence_number) <> ''),
  CONSTRAINT chk_compliance_bis_licence_type CHECK (licence_type IN ('cml', 'r_number')),
  CONSTRAINT chk_compliance_bis_licence_window CHECK (valid_to >= valid_from)
);

-- ADD COLUMN IF NOT EXISTS rather than an information_schema probe: the probe filtered on
-- table_name alone, so a same-named table in ANY other schema (a bak, tenant or restore-staging
-- schema) satisfied it and the column was silently never added here.
ALTER TABLE compliance_bis_licence ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

-- The column defaults to 'active', which is wrong for any pre-existing row whose window has
-- already closed (every Story 8.6 fixture row with a past valid_to). Backfill once, idempotently.
UPDATE compliance_bis_licence SET status = 'expired'
 WHERE status = 'active' AND valid_to < CURRENT_DATE;

-- The scope index moved to a case-folded, trimmed body. CREATE INDEX IF NOT EXISTS matches on NAME
-- only, so an existing database would silently keep the old case-sensitive body - hence the drop.
-- It is guarded on the body actually differing so a routine re-migrate does not rebuild a large
-- unique index under ACCESS EXCLUSIVE, and does not leave a window with no uniqueness at all.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'uq_compliance_bis_licence_scope'
      AND indexdef NOT LIKE '%lower(btrim%'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM compliance_bis_licence
      GROUP BY lower(btrim(licence_number)), sku,
               COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid)
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'compliance_bis_licence holds rows that differ only by licence_number case or whitespace within one (sku, site) scope; dedupe them before migrating (SELECT lower(btrim(licence_number)), sku, site_id, count(*) FROM compliance_bis_licence GROUP BY 1,2,3 HAVING count(*) > 1)';
    END IF;
    DROP INDEX uq_compliance_bis_licence_scope;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_bis_licence_scope
  ON compliance_bis_licence (
    lower(btrim(licence_number)),
    sku,
    COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS idx_compliance_bis_licence_sku ON compliance_bis_licence (sku, valid_to);

-- The expiry sweep reads WHERE status = 'active' AND valid_to <= today + horizon ORDER BY valid_to;
-- without this partial index every tick seq-scans and sorts the whole register.
CREATE INDEX IF NOT EXISTS idx_compliance_bis_licence_expiry
  ON compliance_bis_licence (valid_to) WHERE status = 'active';

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
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_compliance_bis_licence_status'
      AND conrelid = 'compliance_bis_licence'::regclass
  ) THEN
    ALTER TABLE compliance_bis_licence
      ADD CONSTRAINT chk_compliance_bis_licence_status CHECK (status IN ('active', 'expired'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE ON compliance_bis_licence TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON compliance_bis_licence TO readonly_user;
  END IF;
END $$;
