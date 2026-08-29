-- Inspection plan version (Story 8.1, FR-Q-01, AC 1 and AC 2). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.inspection_plan_created domain events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the
-- SAME transaction as the domain_events insert.
--
-- A version is IMMUTABLE after creation (Annex requirement 1): a change is a new version and every
-- prior version is preserved. Approval is NOT a column here - it is the append-only
-- inspection_plan_approval row keyed to plan_version_id, so an approval can never be flipped by an
-- UPDATE. Each version carries effective_from (Annex requirement 3): resolution picks the approved
-- version with the greatest effective_from not after the lot's trusted business date.
--
-- uq_inspection_plan_version_no backs the version-number allocation done under the plan header's
-- FOR UPDATE lock (a 23505 resolves to 409 DUPLICATE_INSPECTION_PLAN_VERSION).
-- uq_inspection_plan_version_effective enforces one version per (plan, effective_from) so
-- resolution is deterministic by date; a 23505 resolves to 409 INSPECTION_PLAN_EFFECTIVITY_CONFLICT.
--
-- aql and inspection_level are the Story 8.2 sampling inputs, stored as an exact bounded NUMERIC and
-- a bounded text literal; this story performs NO sampling-table lookup. They pair all-or-none.
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE or DELETE.

CREATE TABLE IF NOT EXISTS inspection_plan_version (
  plan_version_id    UUID PRIMARY KEY,
  plan_id            UUID NOT NULL,
  version_no         INTEGER NOT NULL,
  effective_from     DATE NOT NULL,
  aql                NUMERIC(7, 3),
  inspection_level   TEXT,
  created_by         UUID NOT NULL,
  source_event_id    UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inspection_plan_version_no UNIQUE (plan_id, version_no),
  CONSTRAINT uq_inspection_plan_version_effective UNIQUE (plan_id, effective_from),
  CONSTRAINT chk_inspection_plan_version_no_positive CHECK (version_no > 0),
  CONSTRAINT chk_inspection_plan_version_aql CHECK (aql IS NULL OR (aql > 0 AND aql <= 1000)),
  CONSTRAINT chk_inspection_plan_version_sampling_pairing CHECK (
    (aql IS NULL AND inspection_level IS NULL)
    OR (aql IS NOT NULL AND inspection_level IS NOT NULL AND btrim(inspection_level) <> '' AND char_length(inspection_level) <= 16)
  ),
  CONSTRAINT chk_inspection_plan_version_level_vocab CHECK (inspection_level IS NULL OR inspection_level IN ('I', 'II', 'III', 'S-1', 'S-2', 'S-3', 'S-4'))
);

CREATE INDEX IF NOT EXISTS idx_inspection_plan_version_plan_effective ON inspection_plan_version (plan_id, effective_from DESC, version_no DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_inspection_plan_version_no'
      AND conrelid = 'inspection_plan_version'::regclass
  ) THEN
    ALTER TABLE inspection_plan_version
      ADD CONSTRAINT uq_inspection_plan_version_no UNIQUE (plan_id, version_no);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_inspection_plan_version_effective'
      AND conrelid = 'inspection_plan_version'::regclass
  ) THEN
    ALTER TABLE inspection_plan_version
      ADD CONSTRAINT uq_inspection_plan_version_effective UNIQUE (plan_id, effective_from);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_version_no_positive'
      AND conrelid = 'inspection_plan_version'::regclass
  ) THEN
    ALTER TABLE inspection_plan_version
      ADD CONSTRAINT chk_inspection_plan_version_no_positive CHECK (version_no > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_version_aql'
      AND conrelid = 'inspection_plan_version'::regclass
  ) THEN
    ALTER TABLE inspection_plan_version
      ADD CONSTRAINT chk_inspection_plan_version_aql CHECK (aql IS NULL OR (aql > 0 AND aql <= 1000));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_version_sampling_pairing'
      AND conrelid = 'inspection_plan_version'::regclass
  ) THEN
    ALTER TABLE inspection_plan_version
      ADD CONSTRAINT chk_inspection_plan_version_sampling_pairing CHECK (
        (aql IS NULL AND inspection_level IS NULL)
        OR (aql IS NOT NULL AND inspection_level IS NOT NULL AND btrim(inspection_level) <> '' AND char_length(inspection_level) <= 16)
      );
  END IF;
END $$;

-- Story 8.2 (Annex requirement 3): the inspection-level vocabulary of IS 2500 (Part 1) Table I,
-- guarded separately so a Story 8.1 database gains it on re-apply.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_version_level_vocab'
      AND conrelid = 'inspection_plan_version'::regclass
  ) THEN
    ALTER TABLE inspection_plan_version
      ADD CONSTRAINT chk_inspection_plan_version_level_vocab CHECK (inspection_level IS NULL OR inspection_level IN ('I', 'II', 'III', 'S-1', 'S-2', 'S-3', 'S-4')) NOT VALID;
    ALTER TABLE inspection_plan_version
      VALIDATE CONSTRAINT chk_inspection_plan_version_level_vocab;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON inspection_plan_version TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON inspection_plan_version TO readonly_user;
  END IF;
END $$;
