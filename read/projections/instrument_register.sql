-- Instrument register (Story 7.5, FR-M-12, FR-M-13, AD-8, AD-9). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.instrument_registered domain
-- events; mutation happens exclusively through persistEvent, which applies this projection inside
-- the SAME transaction as the domain_events insert.
--
-- An instrument IS an asset (AD-9): asset_id references the single Story 7.1 register and is
-- unique on it, so one asset is at most one instrument record. There is deliberately no
-- is_instrument flag on the asset table - that would push maintenance state into a shared
-- projection every module reads.
--
-- instrument_id is the QC-facing TEXT key that qc.result_recorded carries and that the Story 1.7
-- lockout gate looks up in instrument_calibration_statuses. This table is the ONE row where the
-- text key and the asset id meet. Uniqueness on it is canonicalized with lower() (the Story 7.1
-- asset-tag precedent and the Story 7.2 scanned-versus-typed lesson): a case variant of an
-- existing instrument id is the same physical instrument. The guarded DO block below drops a
-- previous exact-match index so a re-applied file self-heals to the lower() definition.
--
-- There is NO calibration status column here. Certificate validity is the only source of
-- calibrated status for a registered instrument, and two places holding the same fact is how a
-- lockout gets defeated. calibration_interval_days is captured for the alert horizon only; no
-- scheduling surface is built on it in this story.

CREATE TABLE IF NOT EXISTS instrument_register (
  instrument_record_id      UUID PRIMARY KEY,
  asset_id                  UUID NOT NULL,
  instrument_id             TEXT NOT NULL,
  location_id               UUID NOT NULL,
  calibration_interval_days INTEGER NOT NULL,
  registered_by             UUID NOT NULL,
  registered_at             TIMESTAMPTZ NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_instrument_register_asset UNIQUE (asset_id),
  CONSTRAINT chk_instrument_register_interval CHECK (calibration_interval_days > 0 AND calibration_interval_days <= 3650)
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'uq_instrument_register_instrument_id'
      AND indexdef NOT LIKE '%lower(instrument_id)%'
  ) THEN
    DROP INDEX uq_instrument_register_instrument_id;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_instrument_register_instrument_id ON instrument_register (lower(instrument_id));
CREATE INDEX IF NOT EXISTS idx_instrument_register_location ON instrument_register (location_id);
CREATE INDEX IF NOT EXISTS idx_instrument_register_asset ON instrument_register (asset_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_instrument_register_asset'
      AND conrelid = 'instrument_register'::regclass
  ) THEN
    ALTER TABLE instrument_register
      ADD CONSTRAINT uq_instrument_register_asset UNIQUE (asset_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_instrument_register_interval'
      AND conrelid = 'instrument_register'::regclass
  ) THEN
    ALTER TABLE instrument_register
      ADD CONSTRAINT chk_instrument_register_interval CHECK (calibration_interval_days > 0 AND calibration_interval_days <= 3650);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON instrument_register TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON instrument_register TO readonly_user;
  END IF;
END $$;
