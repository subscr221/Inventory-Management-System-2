-- QC inspection result (Story 8.2, FR-Q-03, FR-Q-04, AC 2, AC 4, AC 5). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.result_recorded (instrument-bound) and
-- qc.observation_recorded (instrument-less attribute) domain events; mutation happens exclusively
-- through persistEvent inside the SAME transaction as the domain_events insert.
--
-- One authoritative, immutable result per (task, characteristic, sample unit) (Annex requirement
-- 6): uq_qc_inspection_result_unit is the concurrency backstop and a 23505 resolves to 409
-- QC_RESULT_EXISTS in the store's constraint chain. conforms is derived on the server and stored
-- (Annex requirement 7). An instrument-bound result carries BOTH the register asset and the QC
-- instrument key the calibration gate reads; an observation carries neither
-- (chk_qc_inspection_result_instrument_pairing). recorded_by is the segregation-of-duties
-- substrate the conditional-release seam reads (Binding Scope Decision 12).
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE or DELETE.

CREATE TABLE IF NOT EXISTS qc_inspection_result (
  result_id             UUID PRIMARY KEY,
  task_id               UUID NOT NULL,
  lot_id                UUID NOT NULL,
  characteristic_id     UUID NOT NULL,
  characteristic_class  TEXT NOT NULL,
  sample_unit_no        INTEGER NOT NULL,
  result_kind           TEXT NOT NULL,
  measured_value        NUMERIC(18, 6),
  measured_uom          TEXT,
  attribute_conforms    BOOLEAN,
  conforms              BOOLEAN NOT NULL,
  instrument_asset_id   UUID,
  instrument_id         TEXT,
  recorded_by           UUID NOT NULL,
  recorded_at           TIMESTAMPTZ NOT NULL,
  source_event_id       UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_qc_inspection_result_unit UNIQUE (task_id, characteristic_id, sample_unit_no),
  CONSTRAINT chk_qc_inspection_result_class CHECK (characteristic_class IN ('critical', 'major', 'minor')),
  CONSTRAINT chk_qc_inspection_result_unit_no CHECK (sample_unit_no > 0),
  CONSTRAINT chk_qc_inspection_result_kind_pairing CHECK (
    (result_kind = 'numeric' AND measured_value IS NOT NULL AND measured_uom IS NOT NULL AND attribute_conforms IS NULL)
    OR (result_kind = 'attribute' AND measured_value IS NULL AND measured_uom IS NULL AND attribute_conforms IS NOT NULL)
  ),
  CONSTRAINT chk_qc_inspection_result_instrument_pairing CHECK (
    (instrument_asset_id IS NULL AND instrument_id IS NULL)
    OR (instrument_asset_id IS NOT NULL AND instrument_id IS NOT NULL AND btrim(instrument_id) <> '')
  )
);

CREATE INDEX IF NOT EXISTS idx_qc_inspection_result_task_characteristic ON qc_inspection_result (task_id, characteristic_id);
CREATE INDEX IF NOT EXISTS idx_qc_inspection_result_task_recorder ON qc_inspection_result (task_id, recorded_by);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_inspection_result_unit'
      AND conrelid = 'qc_inspection_result'::regclass
  ) THEN
    ALTER TABLE qc_inspection_result
      ADD CONSTRAINT uq_qc_inspection_result_unit UNIQUE (task_id, characteristic_id, sample_unit_no);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_inspection_result_class'
      AND conrelid = 'qc_inspection_result'::regclass
  ) THEN
    ALTER TABLE qc_inspection_result
      ADD CONSTRAINT chk_qc_inspection_result_class CHECK (characteristic_class IN ('critical', 'major', 'minor'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_inspection_result_unit_no'
      AND conrelid = 'qc_inspection_result'::regclass
  ) THEN
    ALTER TABLE qc_inspection_result
      ADD CONSTRAINT chk_qc_inspection_result_unit_no CHECK (sample_unit_no > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_inspection_result_kind_pairing'
      AND conrelid = 'qc_inspection_result'::regclass
  ) THEN
    ALTER TABLE qc_inspection_result
      ADD CONSTRAINT chk_qc_inspection_result_kind_pairing CHECK (
        (result_kind = 'numeric' AND measured_value IS NOT NULL AND measured_uom IS NOT NULL AND attribute_conforms IS NULL)
        OR (result_kind = 'attribute' AND measured_value IS NULL AND measured_uom IS NULL AND attribute_conforms IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_inspection_result_instrument_pairing'
      AND conrelid = 'qc_inspection_result'::regclass
  ) THEN
    ALTER TABLE qc_inspection_result
      ADD CONSTRAINT chk_qc_inspection_result_instrument_pairing CHECK (
        (instrument_asset_id IS NULL AND instrument_id IS NULL)
        OR (instrument_asset_id IS NOT NULL AND instrument_id IS NOT NULL AND btrim(instrument_id) <> '')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON qc_inspection_result TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_inspection_result TO readonly_user;
  END IF;
END $$;
