-- QC lot disposition (Story 8.1, FR-Q-05, AC 4; extended by Story 8.3). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.conditional_release_recorded domain
-- events (Story 8.3 adds the accept and reject events); mutation happens exclusively through
-- persistEvent inside the SAME transaction as the domain_events insert.
--
-- The SHARED one-row-per-unsplit-lot disposition grain (Binding Scope Decisions 3 and 4): Story
-- 8.1 writes only 'conditional_release'; Story 8.3 widens chk_qc_lot_disposition_disposition to
-- 'accept' and 'reject' and adds partial-split behaviour. uq_qc_lot_disposition_lot is the
-- concurrency backstop: a sequential or concurrent second disposition for the same lot resolves to
-- 409 DISPOSITION_EXISTS in the store's constraint chain (the pre-check returns the same code).
--
-- Attribution stored now for Story 8.2 and 8.3 segregation-of-duties enforcement: the requester,
-- the inspector when a result recorder is known, the DOA-resolved approver and the DOA entry.
-- A conditional release always references its immutable qc_deviation row
-- (chk_qc_lot_disposition_deviation_pairing); scope, conditions and expiry live THROUGH that row.
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
  doa_entry_id       UUID NOT NULL,
  decided_at         TIMESTAMPTZ NOT NULL,
  source_event_id    UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_qc_lot_disposition_lot UNIQUE (lot_id),
  CONSTRAINT chk_qc_lot_disposition_disposition CHECK (disposition IN ('conditional_release')),
  CONSTRAINT chk_qc_lot_disposition_quantity CHECK (quantity > 0),
  CONSTRAINT chk_qc_lot_disposition_deviation_pairing CHECK (disposition <> 'conditional_release' OR deviation_id IS NOT NULL)
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

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON qc_lot_disposition TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_lot_disposition TO readonly_user;
  END IF;
END $$;
