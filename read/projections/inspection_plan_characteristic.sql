-- Inspection plan characteristic (Story 8.1, FR-Q-01, Annex requirement 4). This file is the
-- CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.inspection_plan_created domain events
-- (one event carries the complete characteristic list of the version it creates); mutation happens
-- exclusively through persistEvent inside the SAME transaction as the domain_events insert.
--
-- One row per characteristic line of an immutable plan version: a stable line number, the class
-- (critical, major, minor), the test-method or IS/ISO/internal-SOP reference, an optional
-- instrument type, the result kind (numeric or attribute) with its MATCHING acceptance limits or
-- criteria, and the sample-handling instructions. chk_inspection_plan_characteristic_kind_pairing
-- is the kind/limit pairing rule: a numeric characteristic carries at least one bounded NUMERIC
-- limit (lower <= upper when both are present) and no textual criteria; an attribute
-- characteristic carries textual criteria and no numeric limits.
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE or DELETE (a version's lines are
-- as immutable as the version).

CREATE TABLE IF NOT EXISTS inspection_plan_characteristic (
  characteristic_id    UUID PRIMARY KEY,
  plan_version_id      UUID NOT NULL,
  line_no              INTEGER NOT NULL,
  characteristic_name  TEXT NOT NULL,
  characteristic_class TEXT NOT NULL,
  test_method_ref      TEXT NOT NULL,
  instrument_type      TEXT,
  result_kind          TEXT NOT NULL,
  lower_limit          NUMERIC(18, 6),
  upper_limit          NUMERIC(18, 6),
  limit_uom            TEXT,
  acceptance_criteria  TEXT,
  sample_handling      TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inspection_plan_characteristic_line UNIQUE (plan_version_id, line_no),
  CONSTRAINT chk_inspection_plan_characteristic_line_no CHECK (line_no > 0),
  CONSTRAINT chk_inspection_plan_characteristic_class CHECK (characteristic_class IN ('critical', 'major', 'minor')),
  CONSTRAINT chk_inspection_plan_characteristic_result_kind CHECK (result_kind IN ('numeric', 'attribute')),
  CONSTRAINT chk_inspection_plan_characteristic_text CHECK (
    btrim(characteristic_name) <> '' AND char_length(characteristic_name) <= 200
    AND btrim(test_method_ref) <> '' AND char_length(test_method_ref) <= 200
    AND (instrument_type IS NULL OR (btrim(instrument_type) <> '' AND char_length(instrument_type) <= 100))
    AND btrim(sample_handling) <> '' AND char_length(sample_handling) <= 1000
  ),
  CONSTRAINT chk_inspection_plan_characteristic_kind_pairing CHECK (
    (result_kind = 'numeric'
      AND (lower_limit IS NOT NULL OR upper_limit IS NOT NULL)
      AND (lower_limit IS NULL OR upper_limit IS NULL OR lower_limit <= upper_limit)
      AND acceptance_criteria IS NULL
      AND (limit_uom IS NULL OR (btrim(limit_uom) <> '' AND char_length(limit_uom) <= 32)))
    OR (result_kind = 'attribute'
      AND lower_limit IS NULL AND upper_limit IS NULL AND limit_uom IS NULL
      AND acceptance_criteria IS NOT NULL AND btrim(acceptance_criteria) <> '' AND char_length(acceptance_criteria) <= 1000)
  )
);

CREATE INDEX IF NOT EXISTS idx_inspection_plan_characteristic_version ON inspection_plan_characteristic (plan_version_id, line_no);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_inspection_plan_characteristic_line'
      AND conrelid = 'inspection_plan_characteristic'::regclass
  ) THEN
    ALTER TABLE inspection_plan_characteristic
      ADD CONSTRAINT uq_inspection_plan_characteristic_line UNIQUE (plan_version_id, line_no);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_characteristic_line_no'
      AND conrelid = 'inspection_plan_characteristic'::regclass
  ) THEN
    ALTER TABLE inspection_plan_characteristic
      ADD CONSTRAINT chk_inspection_plan_characteristic_line_no CHECK (line_no > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_characteristic_class'
      AND conrelid = 'inspection_plan_characteristic'::regclass
  ) THEN
    ALTER TABLE inspection_plan_characteristic
      ADD CONSTRAINT chk_inspection_plan_characteristic_class CHECK (characteristic_class IN ('critical', 'major', 'minor'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_characteristic_result_kind'
      AND conrelid = 'inspection_plan_characteristic'::regclass
  ) THEN
    ALTER TABLE inspection_plan_characteristic
      ADD CONSTRAINT chk_inspection_plan_characteristic_result_kind CHECK (result_kind IN ('numeric', 'attribute'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_characteristic_text'
      AND conrelid = 'inspection_plan_characteristic'::regclass
  ) THEN
    ALTER TABLE inspection_plan_characteristic
      ADD CONSTRAINT chk_inspection_plan_characteristic_text CHECK (
        btrim(characteristic_name) <> '' AND char_length(characteristic_name) <= 200
        AND btrim(test_method_ref) <> '' AND char_length(test_method_ref) <= 200
        AND (instrument_type IS NULL OR (btrim(instrument_type) <> '' AND char_length(instrument_type) <= 100))
        AND btrim(sample_handling) <> '' AND char_length(sample_handling) <= 1000
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_characteristic_kind_pairing'
      AND conrelid = 'inspection_plan_characteristic'::regclass
  ) THEN
    ALTER TABLE inspection_plan_characteristic
      ADD CONSTRAINT chk_inspection_plan_characteristic_kind_pairing CHECK (
        (result_kind = 'numeric'
          AND (lower_limit IS NOT NULL OR upper_limit IS NOT NULL)
          AND (lower_limit IS NULL OR upper_limit IS NULL OR lower_limit <= upper_limit)
          AND acceptance_criteria IS NULL
          AND (limit_uom IS NULL OR (btrim(limit_uom) <> '' AND char_length(limit_uom) <= 32)))
        OR (result_kind = 'attribute'
          AND lower_limit IS NULL AND upper_limit IS NULL AND limit_uom IS NULL
          AND acceptance_criteria IS NOT NULL AND btrim(acceptance_criteria) <> '' AND char_length(acceptance_criteria) <= 1000)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON inspection_plan_characteristic TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON inspection_plan_characteristic TO readonly_user;
  END IF;
END $$;
