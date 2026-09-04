-- Asset coverage register: AMC, warranty, and insurance contracts (Story 7.7, FR-M-10/11, AD-9).
-- This file is the CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and
-- the integration-test harness. It carries its OWN grants (guarded DO blocks) so a
-- migrate-provisioned database can serve reads/writes as app_user without depending on
-- deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates this content for first-boot
-- container init - change both files together. Every statement is idempotent (IF NOT EXISTS /
-- guarded DO blocks) so the file can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.coverage_recorded domain
-- events; mutation happens exclusively through persistEvent, which applies this projection inside
-- the SAME transaction as the domain_events insert.
--
-- One table serves all three coverage kinds (Binding Decision 13): AMC, warranty, and insurance
-- rows differ only in coverage_type and in the fact that only 'warranty' drives the Story 7.7
-- work-order check. asset_id references the single Story 7.1 company-wide asset register (AD-9),
-- so there is no location column and no site scoping.
--
-- Records are APPEND-ONLY with no amendment, void, or supersede path in Phase 1 (Binding
-- Decision 5): a renewal is a NEW row with a new coverage_id, which earns a fresh set of 90/60/30
-- alert stages. The uniqueness grain is (asset_id, coverage_type, lower(reference_number_ext)),
-- expressed as a UNIQUE INDEX because it contains an expression - never a table-level UNIQUE on an
-- expression (the Story 7.5 rule). Case canonicalization matches the Story 7.1 asset-tag and Story
-- 7.5 instrument-id precedent: a case variant of a contract reference is the same contract.

CREATE TABLE IF NOT EXISTS asset_coverage (
  coverage_id          UUID PRIMARY KEY,
  asset_id             UUID NOT NULL,
  coverage_type        TEXT NOT NULL,
  provider_name        TEXT NOT NULL,
  reference_number_ext TEXT NOT NULL,
  start_date           DATE NOT NULL,
  expiry_date          DATE NOT NULL,
  contract_value       NUMERIC(14,3),
  recorded_by          UUID NOT NULL,
  recorded_at          TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_asset_coverage_type CHECK (coverage_type IN ('amc', 'warranty', 'insurance')),
  CONSTRAINT chk_asset_coverage_provider_name CHECK (btrim(provider_name) <> ''),
  CONSTRAINT chk_asset_coverage_reference_ext CHECK (btrim(reference_number_ext) <> ''),
  CONSTRAINT chk_asset_coverage_dates CHECK (expiry_date >= start_date),
  CONSTRAINT chk_asset_coverage_value_non_negative CHECK (contract_value IS NULL OR contract_value >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_coverage_reference ON asset_coverage (asset_id, coverage_type, lower(reference_number_ext));
CREATE INDEX IF NOT EXISTS idx_asset_coverage_asset ON asset_coverage (asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_coverage_expiry ON asset_coverage (expiry_date);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_coverage_type'
      AND conrelid = 'asset_coverage'::regclass
  ) THEN
    ALTER TABLE asset_coverage
      ADD CONSTRAINT chk_asset_coverage_type CHECK (coverage_type IN ('amc', 'warranty', 'insurance'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_coverage_provider_name'
      AND conrelid = 'asset_coverage'::regclass
  ) THEN
    ALTER TABLE asset_coverage
      ADD CONSTRAINT chk_asset_coverage_provider_name CHECK (btrim(provider_name) <> '');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_coverage_reference_ext'
      AND conrelid = 'asset_coverage'::regclass
  ) THEN
    ALTER TABLE asset_coverage
      ADD CONSTRAINT chk_asset_coverage_reference_ext CHECK (btrim(reference_number_ext) <> '');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_coverage_dates'
      AND conrelid = 'asset_coverage'::regclass
  ) THEN
    ALTER TABLE asset_coverage
      ADD CONSTRAINT chk_asset_coverage_dates CHECK (expiry_date >= start_date);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_coverage_value_non_negative'
      AND conrelid = 'asset_coverage'::regclass
  ) THEN
    ALTER TABLE asset_coverage
      ADD CONSTRAINT chk_asset_coverage_value_non_negative CHECK (contract_value IS NULL OR contract_value >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON asset_coverage TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON asset_coverage TO readonly_user;
  END IF;
END $$;

-- Review decision D2: warranty_flagged is derived exactly once, at breakdown work-order creation,
-- so every breakdown work order still OPEN when this migration runs would keep the false default
-- permanently and complete without ever demanding an override. AC 2 and AC 3 would silently not
-- apply to the whole pre-migration backlog. This one-shot pass re-derives the pair for those rows
-- with the SAME single-winner rule getActiveWarrantyForAsset applies (coverage_type 'warranty', in
-- force on the date, latest expiry wins, lowest coverage_id breaks the tie).
--
-- It lives in asset_coverage.sql, not in maintenance_work_order.sql, because the work-order file
-- migrates FIRST and the coverage register does not exist yet at that point.
--
-- The column comment is the one-shot marker: a re-run returns before touching a row, so a coverage
-- recorded after the backfill can never retroactively flag a work order (the replay-determinism
-- class logged under review decision D4). CURRENT_DATE is read deliberately and is the only clock
-- read on the Story 7.7 path: a migration has no payload business_date to derive from.
DO $$
DECLARE
  marker_attnum SMALLINT;
BEGIN
  IF to_regclass('maintenance_work_order') IS NULL THEN
    RETURN;
  END IF;
  SELECT attnum INTO marker_attnum
    FROM pg_attribute
   WHERE attrelid = 'maintenance_work_order'::regclass
     AND attname = 'warranty_flagged'
     AND NOT attisdropped;
  IF marker_attnum IS NULL THEN
    RETURN;
  END IF;
  IF col_description('maintenance_work_order'::regclass, marker_attnum) IS NOT NULL THEN
    RETURN;
  END IF;

  UPDATE maintenance_work_order w
     SET warranty_flagged = true,
         warranty_coverage_id = cur.coverage_id,
         updated_at = now()
    FROM (
      SELECT DISTINCT ON (asset_id) asset_id, coverage_id
        FROM asset_coverage
       WHERE coverage_type = 'warranty'
         AND start_date <= CURRENT_DATE
         AND expiry_date >= CURRENT_DATE
       ORDER BY asset_id, expiry_date DESC, coverage_id ASC
    ) cur
   WHERE w.asset_id = cur.asset_id
     AND w.origin = 'breakdown'
     AND w.status IN ('open', 'overdue')
     AND w.warranty_flagged = false
     AND w.warranty_coverage_id IS NULL;

  EXECUTE 'COMMENT ON COLUMN maintenance_work_order.warranty_flagged IS ' ||
    quote_literal('Story 7.7 AC 2: server-derived at breakdown work-order creation; rows open at migration time backfilled once by asset_coverage.sql');
END $$;
