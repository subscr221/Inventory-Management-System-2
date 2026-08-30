-- QC lot disposition (Story 8.1, FR-Q-05, AC 4; extended by Story 8.3). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.conditional_release_recorded (Story
-- 8.1) and qc.lot_dispositioned / qc.lot_split_recorded (Story 8.3) domain events; mutation
-- happens exclusively through persistEvent inside the SAME transaction as the domain_events
-- insert.
--
-- The SHARED one-row-per-lot disposition grain (Binding Scope Decisions 3 and 4): Story 8.1 wrote
-- only 'conditional_release'; Story 8.3 widens chk_qc_lot_disposition_disposition to 'accept',
-- 'reject' and 'split'. 'split' is the split PARENT's authoritative terminal outcome - it is what
-- makes a second disposition attempt on a split parent 409 DISPOSITION_EXISTS; the children carry
-- their own independent rows. uq_qc_lot_disposition_lot is the concurrency backstop: a sequential
-- or concurrent second disposition for the same lot resolves to 409 DISPOSITION_EXISTS in the
-- store's constraint chain (the pre-check returns the same code).
--
-- Attribution stored now for Story 8.2 and 8.3 segregation-of-duties enforcement: the requester,
-- the inspector when a result recorder is known, the approver and (for the DOA-gated exception
-- path only) the DOA entry. A conditional release always references its immutable qc_deviation row
-- (chk_qc_lot_disposition_deviation_pairing); scope, conditions and expiry live THROUGH that row.
-- Story 8.3 Binding Scope Decision 5: accept, reject and split are the NORMAL path and carry no
-- DOA gate, so doa_entry_id is nullable and chk_qc_lot_disposition_doa_pairing requires it exactly
-- for 'conditional_release' - nothing may fabricate a DOA reference for an ordinary disposition.
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE or DELETE.

CREATE TABLE IF NOT EXISTS qc_lot_disposition (
  disposition_id     UUID PRIMARY KEY,
  lot_id             UUID NOT NULL,
  task_id            UUID NOT NULL,
  disposition        TEXT NOT NULL,
  deviation_id       UUID,
  plan_version_id    UUID NOT NULL,
  quantity           NUMERIC(18, 6) NOT NULL,
  requested_by       UUID NOT NULL,
  inspector_user_id  UUID,
  approved_by        UUID NOT NULL,
  doa_entry_id       UUID,
  decided_at         TIMESTAMPTZ NOT NULL,
  source_event_id    UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  sampling_outcome   TEXT,
  ncr_id             UUID,
  CONSTRAINT uq_qc_lot_disposition_lot UNIQUE (lot_id),
  CONSTRAINT chk_qc_lot_disposition_disposition CHECK (disposition IN ('conditional_release', 'accept', 'reject', 'split')),
  CONSTRAINT chk_qc_lot_disposition_quantity CHECK (quantity > 0),
  CONSTRAINT chk_qc_lot_disposition_deviation_pairing CHECK (disposition <> 'conditional_release' OR deviation_id IS NOT NULL),
  CONSTRAINT chk_qc_lot_disposition_doa_pairing CHECK ((disposition = 'conditional_release') = (doa_entry_id IS NOT NULL)),
  CONSTRAINT chk_qc_lot_disposition_sampling_outcome CHECK (sampling_outcome IS NULL OR sampling_outcome IN ('accepted', 'not_accepted')),
  CONSTRAINT chk_qc_lot_disposition_ncr_pairing CHECK ((disposition = 'reject') = (ncr_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_qc_lot_disposition_task ON qc_lot_disposition (task_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_lot_disposition_lot'
      AND conrelid = 'qc_lot_disposition'::regclass
  ) THEN
    ALTER TABLE qc_lot_disposition
      ADD CONSTRAINT uq_qc_lot_disposition_lot UNIQUE (lot_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_disposition_disposition'
      AND conrelid = 'qc_lot_disposition'::regclass
  ) THEN
    ALTER TABLE qc_lot_disposition
      ADD CONSTRAINT chk_qc_lot_disposition_disposition CHECK (disposition IN ('conditional_release'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_disposition_quantity'
      AND conrelid = 'qc_lot_disposition'::regclass
  ) THEN
    ALTER TABLE qc_lot_disposition
      ADD CONSTRAINT chk_qc_lot_disposition_quantity CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_disposition_deviation_pairing'
      AND conrelid = 'qc_lot_disposition'::regclass
  ) THEN
    ALTER TABLE qc_lot_disposition
      ADD CONSTRAINT chk_qc_lot_disposition_deviation_pairing CHECK (disposition <> 'conditional_release' OR deviation_id IS NOT NULL);
  END IF;
END $$;

-- Story 8.3 (Binding Scope Decision 2): widen the disposition vocabulary on a database created by
-- Story 8.1, where chk_qc_lot_disposition_disposition admits only 'conditional_release'. Guarded
-- on pg_get_constraintdef, dropping the narrow definition and re-adding the widened one; once the
-- definition names 'accept' the block is a no-op on every re-run. Same pattern Story 8.2 used for
-- chk_qc_inspection_task_status.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_disposition_disposition'
      AND conrelid = 'qc_lot_disposition'::regclass
      AND pg_get_constraintdef(oid) NOT LIKE '%accept%'
  ) THEN
    ALTER TABLE qc_lot_disposition DROP CONSTRAINT chk_qc_lot_disposition_disposition;
    ALTER TABLE qc_lot_disposition
      ADD CONSTRAINT chk_qc_lot_disposition_disposition CHECK (disposition IN ('conditional_release', 'accept', 'reject', 'split'));
  END IF;
END $$;

-- Story 8.3 (Binding Scope Decision 5): accept, reject and split carry no DOA gate, so
-- doa_entry_id becomes nullable and is paired to the conditional-release kind instead.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'qc_lot_disposition' AND column_name = 'doa_entry_id'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE qc_lot_disposition ALTER COLUMN doa_entry_id DROP NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'qc_lot_disposition' AND column_name = 'sampling_outcome'
  ) THEN
    ALTER TABLE qc_lot_disposition ADD COLUMN sampling_outcome TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'qc_lot_disposition' AND column_name = 'ncr_id'
  ) THEN
    ALTER TABLE qc_lot_disposition ADD COLUMN ncr_id UUID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_disposition_doa_pairing'
      AND conrelid = 'qc_lot_disposition'::regclass
  ) THEN
    ALTER TABLE qc_lot_disposition
      ADD CONSTRAINT chk_qc_lot_disposition_doa_pairing CHECK ((disposition = 'conditional_release') = (doa_entry_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_disposition_sampling_outcome'
      AND conrelid = 'qc_lot_disposition'::regclass
  ) THEN
    ALTER TABLE qc_lot_disposition
      ADD CONSTRAINT chk_qc_lot_disposition_sampling_outcome CHECK (sampling_outcome IS NULL OR sampling_outcome IN ('accepted', 'not_accepted'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_disposition_ncr_pairing'
      AND conrelid = 'qc_lot_disposition'::regclass
  ) THEN
    ALTER TABLE qc_lot_disposition
      ADD CONSTRAINT chk_qc_lot_disposition_ncr_pairing CHECK ((disposition = 'reject') = (ncr_id IS NOT NULL));
  END IF;
END $$;

-- Review patch (2026-08-30): the ncr_pairing check above shipped one-directional
-- (ncr_id IS NULL OR disposition = 'reject'), which forbade ncr_id on a non-reject row but never
-- required it on a reject row - a reject with ncr_id NULL passed. Widen any already-applied
-- one-directional definition to the symmetric biconditional, same guarded drop-then-add pattern as
-- the disposition vocabulary widening above.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_lot_disposition_ncr_pairing'
      AND conrelid = 'qc_lot_disposition'::regclass
      AND pg_get_constraintdef(oid) NOT LIKE '%= (ncr_id IS NOT NULL)%'
  ) THEN
    ALTER TABLE qc_lot_disposition DROP CONSTRAINT chk_qc_lot_disposition_ncr_pairing;
    ALTER TABLE qc_lot_disposition
      ADD CONSTRAINT chk_qc_lot_disposition_ncr_pairing CHECK ((disposition = 'reject') = (ncr_id IS NOT NULL));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON qc_lot_disposition TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_lot_disposition TO readonly_user;
  END IF;
END $$;
