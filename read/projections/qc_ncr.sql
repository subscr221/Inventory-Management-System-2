-- QC non-conformance report (Story 8.3, FR-Q-06, AC 3, AC 4 and AC 5). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.lot_dispositioned (the reject that
-- raises the NCR) and qc.ncr_outcome_recorded (the once-only outcome) domain events; mutation
-- happens exclusively through persistEvent inside the SAME transaction as the domain_events
-- insert.
--
-- Story 8.3 Annex requirement 8: the NCR is created BY the reject disposition, not by a separate
-- raise command, so a rejected lot can never exist without its NCR record. uq_qc_ncr_lot is the
-- one-per-lot backstop (a 23505 resolves to 409 NCR_EXISTS in the store's constraint chain).
--
-- Annex requirement 9: the outcome is set exactly once. outcome IS NULL means open. The outcome
-- UPDATE is guarded by WHERE outcome IS NULL, so a concurrent second command updates zero rows and
-- raises 409 NCR_OUTCOME_EXISTS. There is no reopen and no second outcome.
--
-- chk_qc_ncr_outcome_pairing keeps the five outcome columns null together and non-null together,
-- and pairs the route-specific columns to their outcome: downgrade_sku and downgrade_lot_id exist
-- exactly for 'downgrade', rework_requested_event_id exactly for 'rework'. A 'scrap' outcome
-- carries none of them - it parks the quantity on lot_master.quality_hold_status ('held', reason
-- scrap_pending) and retains this row plus its event as the AD-10 source document for the Phase 2
-- (Epic 16) FR-SC intake.
--
-- app_user holds INSERT, SELECT and UPDATE (the one outcome transition) and never DELETE.

CREATE TABLE IF NOT EXISTS qc_ncr (
  ncr_id                    UUID PRIMARY KEY,
  lot_id                    UUID NOT NULL,
  lot_number                TEXT NOT NULL,
  task_id                   UUID NOT NULL,
  disposition_id            UUID NOT NULL,
  site_id                   UUID NOT NULL,
  sku                       TEXT NOT NULL,
  quantity                  NUMERIC(18, 6) NOT NULL,
  justification             TEXT NOT NULL,
  raised_by                 UUID NOT NULL,
  raised_at                 TIMESTAMPTZ NOT NULL,
  source_event_id           UUID NOT NULL,
  outcome                   TEXT,
  outcome_reason            TEXT,
  outcome_by                UUID,
  outcome_at                TIMESTAMPTZ,
  outcome_event_id          UUID,
  downgrade_sku             TEXT,
  downgrade_lot_id          UUID,
  rework_requested_event_id UUID,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_qc_ncr_lot UNIQUE (lot_id),
  CONSTRAINT uq_qc_ncr_disposition UNIQUE (disposition_id),
  CONSTRAINT chk_qc_ncr_quantity CHECK (quantity > 0),
  CONSTRAINT chk_qc_ncr_justification CHECK (btrim(justification) <> '' AND char_length(justification) <= 2000),
  CONSTRAINT chk_qc_ncr_outcome CHECK (outcome IS NULL OR outcome IN ('rework', 'downgrade', 'scrap')),
  CONSTRAINT chk_qc_ncr_outcome_pairing CHECK (
    (outcome IS NULL AND outcome_reason IS NULL AND outcome_by IS NULL AND outcome_at IS NULL AND outcome_event_id IS NULL)
    OR (outcome IS NOT NULL AND outcome_reason IS NOT NULL AND btrim(outcome_reason) <> '' AND char_length(outcome_reason) <= 2000
        AND outcome_by IS NOT NULL AND outcome_at IS NOT NULL AND outcome_event_id IS NOT NULL)
  ),
  CONSTRAINT chk_qc_ncr_downgrade_pairing CHECK (
    (outcome IS NOT DISTINCT FROM 'downgrade') = (downgrade_sku IS NOT NULL)
    AND (downgrade_sku IS NOT NULL) = (downgrade_lot_id IS NOT NULL)
    AND (downgrade_sku IS NULL OR (btrim(downgrade_sku) <> '' AND downgrade_sku <> sku))
    AND (downgrade_lot_id IS NULL OR downgrade_lot_id <> lot_id)
  ),
  CONSTRAINT chk_qc_ncr_rework_pairing CHECK (
    (outcome IS NOT DISTINCT FROM 'rework') = (rework_requested_event_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_qc_ncr_site ON qc_ncr (site_id, raised_at, ncr_id);
CREATE INDEX IF NOT EXISTS idx_qc_ncr_task ON qc_ncr (task_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_ncr_lot'
      AND conrelid = 'qc_ncr'::regclass
  ) THEN
    ALTER TABLE qc_ncr ADD CONSTRAINT uq_qc_ncr_lot UNIQUE (lot_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_ncr_disposition'
      AND conrelid = 'qc_ncr'::regclass
  ) THEN
    ALTER TABLE qc_ncr ADD CONSTRAINT uq_qc_ncr_disposition UNIQUE (disposition_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_ncr_quantity'
      AND conrelid = 'qc_ncr'::regclass
  ) THEN
    ALTER TABLE qc_ncr ADD CONSTRAINT chk_qc_ncr_quantity CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_ncr_justification'
      AND conrelid = 'qc_ncr'::regclass
  ) THEN
    ALTER TABLE qc_ncr
      ADD CONSTRAINT chk_qc_ncr_justification CHECK (btrim(justification) <> '' AND char_length(justification) <= 2000);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_ncr_outcome'
      AND conrelid = 'qc_ncr'::regclass
  ) THEN
    ALTER TABLE qc_ncr
      ADD CONSTRAINT chk_qc_ncr_outcome CHECK (outcome IS NULL OR outcome IN ('rework', 'downgrade', 'scrap'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_ncr_outcome_pairing'
      AND conrelid = 'qc_ncr'::regclass
  ) THEN
    ALTER TABLE qc_ncr
      ADD CONSTRAINT chk_qc_ncr_outcome_pairing CHECK (
        (outcome IS NULL AND outcome_reason IS NULL AND outcome_by IS NULL AND outcome_at IS NULL AND outcome_event_id IS NULL)
        OR (outcome IS NOT NULL AND outcome_reason IS NOT NULL AND btrim(outcome_reason) <> '' AND char_length(outcome_reason) <= 2000
            AND outcome_by IS NOT NULL AND outcome_at IS NOT NULL AND outcome_event_id IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_ncr_downgrade_pairing'
      AND conrelid = 'qc_ncr'::regclass
  ) THEN
    ALTER TABLE qc_ncr
      ADD CONSTRAINT chk_qc_ncr_downgrade_pairing CHECK (
        (outcome IS NOT DISTINCT FROM 'downgrade') = (downgrade_sku IS NOT NULL)
        AND (downgrade_sku IS NOT NULL) = (downgrade_lot_id IS NOT NULL)
        AND (downgrade_sku IS NULL OR (btrim(downgrade_sku) <> '' AND downgrade_sku <> sku))
        AND (downgrade_lot_id IS NULL OR downgrade_lot_id <> lot_id)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_ncr_rework_pairing'
      AND conrelid = 'qc_ncr'::regclass
  ) THEN
    ALTER TABLE qc_ncr
      ADD CONSTRAINT chk_qc_ncr_rework_pairing CHECK (
        (outcome IS NOT DISTINCT FROM 'rework') = (rework_requested_event_id IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON qc_ncr TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_ncr TO readonly_user;
  END IF;
END $$;
