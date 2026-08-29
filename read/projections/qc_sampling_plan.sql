-- QC sampling plan (Story 8.2, FR-Q-03, AC 1). This file is the CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its OWN
-- grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as app_user
-- without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates this
-- content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a live database
-- safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.sampling_determined domain events;
-- mutation happens exclusively through persistEvent inside the SAME transaction as the
-- domain_events insert.
--
-- The plan FROZEN on a task: the IS 2500 (Part 1) / ISO 2859-1 single-sampling plan derived on the
-- server from the frozen plan version's AQL and inspection level, the lot size and the switching
-- state's severity at the moment of determination. Every later determination attempt for the same
-- task replays this row (uq_qc_sampling_plan_task is the concurrency backstop; a 23505 resolves to
-- 409 QC_SAMPLING_EXISTS in the store's constraint chain). A version with no AQL freezes a
-- full_inspection plan (sample_size = lot_size, no Ac/Re, no code letter).
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE or DELETE.

CREATE TABLE IF NOT EXISTS qc_sampling_plan (
  sampling_id                    UUID PRIMARY KEY,
  task_id                        UUID NOT NULL,
  lot_id                         UUID NOT NULL,
  lot_number                     TEXT NOT NULL,
  plan_version_id                UUID NOT NULL,
  plan_id                        UUID NOT NULL,
  site_id                        UUID NOT NULL,
  lot_size                       INTEGER NOT NULL,
  aql                            NUMERIC(7, 3),
  inspection_level               TEXT,
  severity                       TEXT NOT NULL,
  code_letter                    TEXT,
  resolved_code_letter           TEXT,
  sample_size                    INTEGER NOT NULL,
  acceptance_number              INTEGER,
  rejection_number               INTEGER,
  sampling_basis                 TEXT NOT NULL,
  standard_ref                   TEXT NOT NULL,
  critical_characteristic_count  INTEGER NOT NULL,
  determined_by                  UUID NOT NULL,
  determined_at                  TIMESTAMPTZ NOT NULL,
  source_event_id                UUID NOT NULL,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_qc_sampling_plan_task UNIQUE (task_id),
  CONSTRAINT chk_qc_sampling_plan_severity CHECK (severity IN ('normal', 'tightened', 'reduced')),
  CONSTRAINT chk_qc_sampling_plan_basis CHECK (sampling_basis IN ('aql_table', 'full_inspection')),
  CONSTRAINT chk_qc_sampling_plan_level CHECK (inspection_level IS NULL OR inspection_level IN ('I', 'II', 'III', 'S-1', 'S-2', 'S-3', 'S-4')),
  CONSTRAINT chk_qc_sampling_plan_sizes CHECK (lot_size > 0 AND sample_size > 0 AND sample_size <= lot_size AND critical_characteristic_count >= 0 AND (sampling_basis <> 'full_inspection' OR sample_size = lot_size)),
  CONSTRAINT chk_qc_sampling_plan_ac_re CHECK (
    (acceptance_number IS NULL AND rejection_number IS NULL)
    OR (acceptance_number IS NOT NULL AND rejection_number IS NOT NULL AND acceptance_number >= 0 AND rejection_number > acceptance_number)
  ),
  CONSTRAINT chk_qc_sampling_plan_basis_pairing CHECK (
    (sampling_basis = 'full_inspection' AND aql IS NULL AND inspection_level IS NULL AND code_letter IS NULL AND resolved_code_letter IS NULL AND acceptance_number IS NULL)
    OR (sampling_basis = 'aql_table' AND aql IS NOT NULL AND inspection_level IS NOT NULL AND code_letter IS NOT NULL AND resolved_code_letter IS NOT NULL AND acceptance_number IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_qc_sampling_plan_plan_site ON qc_sampling_plan (plan_id, site_id, determined_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_sampling_plan_task'
      AND conrelid = 'qc_sampling_plan'::regclass
  ) THEN
    ALTER TABLE qc_sampling_plan
      ADD CONSTRAINT uq_qc_sampling_plan_task UNIQUE (task_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_sampling_plan_severity'
      AND conrelid = 'qc_sampling_plan'::regclass
  ) THEN
    ALTER TABLE qc_sampling_plan
      ADD CONSTRAINT chk_qc_sampling_plan_severity CHECK (severity IN ('normal', 'tightened', 'reduced'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_sampling_plan_basis'
      AND conrelid = 'qc_sampling_plan'::regclass
  ) THEN
    ALTER TABLE qc_sampling_plan
      ADD CONSTRAINT chk_qc_sampling_plan_basis CHECK (sampling_basis IN ('aql_table', 'full_inspection'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_sampling_plan_level'
      AND conrelid = 'qc_sampling_plan'::regclass
  ) THEN
    ALTER TABLE qc_sampling_plan
      ADD CONSTRAINT chk_qc_sampling_plan_level CHECK (inspection_level IS NULL OR inspection_level IN ('I', 'II', 'III', 'S-1', 'S-2', 'S-3', 'S-4'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_sampling_plan_sizes'
      AND conrelid = 'qc_sampling_plan'::regclass
  ) THEN
    ALTER TABLE qc_sampling_plan
      ADD CONSTRAINT chk_qc_sampling_plan_sizes CHECK (lot_size > 0 AND sample_size > 0 AND sample_size <= lot_size AND critical_characteristic_count >= 0 AND (sampling_basis <> 'full_inspection' OR sample_size = lot_size));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_sampling_plan_ac_re'
      AND conrelid = 'qc_sampling_plan'::regclass
  ) THEN
    ALTER TABLE qc_sampling_plan
      ADD CONSTRAINT chk_qc_sampling_plan_ac_re CHECK (
        (acceptance_number IS NULL AND rejection_number IS NULL)
        OR (acceptance_number IS NOT NULL AND rejection_number IS NOT NULL AND acceptance_number >= 0 AND rejection_number > acceptance_number)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_sampling_plan_basis_pairing'
      AND conrelid = 'qc_sampling_plan'::regclass
  ) THEN
    ALTER TABLE qc_sampling_plan
      ADD CONSTRAINT chk_qc_sampling_plan_basis_pairing CHECK (
        (sampling_basis = 'full_inspection' AND aql IS NULL AND inspection_level IS NULL AND code_letter IS NULL AND resolved_code_letter IS NULL AND acceptance_number IS NULL)
        OR (sampling_basis = 'aql_table' AND aql IS NOT NULL AND inspection_level IS NOT NULL AND code_letter IS NOT NULL AND resolved_code_letter IS NOT NULL AND acceptance_number IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON qc_sampling_plan TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_sampling_plan TO readonly_user;
  END IF;
END $$;
