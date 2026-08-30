-- QC retention sample (Story 8.4, FR-Q-08, AC 4 and AC 5). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.retention_sample_logged (the log) and
-- qc.retention_sample_disposed (the one status transition); mutation happens exclusively through
-- persistEvent inside the SAME transaction as the domain_events insert.
--
-- Story 8.4 Binding Scope Decision 6: a retention sample is required for EVERY lot released via
-- accept or conditional_release, not only BIS-covered products. AC 4's gate lives in the release
-- applier, which refuses RETENTION_SAMPLE_REQUIRED unless a row exists here for the lot.
-- uq_qc_retention_sample_lot is the one-per-lot backstop (a 23505 resolves to 409
-- RETENTION_SAMPLE_EXISTS in the store's constraint chain).
--
-- Binding Scope Decision 8: location_id reuses the existing location vocabulary (the same UUID
-- space qc_inspection_task.site_id and stock_balance.location_id already use). A retention sample
-- is evidentiary, not consumable inventory - it is NOT a stock_balance or lot_trace entry, so
-- nothing here moves real stock.
--
-- AC 5 is a RECORDED transition only: the alert sweep (src/notify/retention-expiry.ts) flips
-- 'retained' -> 'disposal_pending' and emits one qc.retention_sample_disposed event per row.
-- Physical disposal is Phase 2 / Epic 16, so 'disposed' plus a non-null disposed_at is schema'd
-- here as a deliberate forward reference with NO code path reaching it in this story - the same
-- kind of documented hand-off as Binding Scope Decision 2's BIS-licence stub, not an oversight.
-- chk_qc_retention_sample_disposal_pairing states the FULL biconditional in both directions:
-- a row is 'retained' if and only if it carries NO disposal_event_id, and it carries a disposed_at
-- if and only if it is 'disposed'. So the reachable transition in this story ('retained' ->
-- 'disposal_pending', stamping the recorded qc.retention_sample_disposed event id) leaves
-- disposed_at null, and only the Phase 2 physical disposal stamps it.
--
-- app_user holds INSERT, SELECT and UPDATE (the one status transition) and never DELETE.

CREATE TABLE IF NOT EXISTS qc_retention_sample (
  retention_sample_id  UUID PRIMARY KEY,
  lot_id               UUID NOT NULL,
  task_id              UUID NOT NULL,
  quantity             NUMERIC(18, 6) NOT NULL,
  uom                  TEXT NOT NULL,
  location_id          UUID NOT NULL,
  status               TEXT NOT NULL,
  logged_by            UUID NOT NULL,
  logged_at            TIMESTAMPTZ NOT NULL,
  expires_on           DATE NOT NULL,
  disposal_event_id    UUID,
  disposed_at          TIMESTAMPTZ,
  source_event_id      UUID NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_qc_retention_sample_lot UNIQUE (lot_id),
  CONSTRAINT chk_qc_retention_sample_quantity CHECK (quantity > 0),
  CONSTRAINT chk_qc_retention_sample_uom CHECK (btrim(uom) <> '' AND char_length(uom) <= 32),
  CONSTRAINT chk_qc_retention_sample_status CHECK (status IN ('retained', 'disposal_pending', 'disposed')),
  CONSTRAINT chk_qc_retention_sample_disposal_pairing CHECK (
    (status = 'retained') = (disposal_event_id IS NULL)
    AND (status = 'disposed') = (disposed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_qc_retention_sample_task ON qc_retention_sample (task_id);
CREATE INDEX IF NOT EXISTS idx_qc_retention_sample_expiry ON qc_retention_sample (status, expires_on);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_retention_sample_lot'
      AND conrelid = 'qc_retention_sample'::regclass
  ) THEN
    ALTER TABLE qc_retention_sample ADD CONSTRAINT uq_qc_retention_sample_lot UNIQUE (lot_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_retention_sample_quantity'
      AND conrelid = 'qc_retention_sample'::regclass
  ) THEN
    ALTER TABLE qc_retention_sample
      ADD CONSTRAINT chk_qc_retention_sample_quantity CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_retention_sample_uom'
      AND conrelid = 'qc_retention_sample'::regclass
  ) THEN
    ALTER TABLE qc_retention_sample
      ADD CONSTRAINT chk_qc_retention_sample_uom CHECK (btrim(uom) <> '' AND char_length(uom) <= 32);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_retention_sample_status'
      AND conrelid = 'qc_retention_sample'::regclass
  ) THEN
    ALTER TABLE qc_retention_sample
      ADD CONSTRAINT chk_qc_retention_sample_status CHECK (status IN ('retained', 'disposal_pending', 'disposed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_retention_sample_disposal_pairing'
      AND conrelid = 'qc_retention_sample'::regclass
  ) THEN
    ALTER TABLE qc_retention_sample
      ADD CONSTRAINT chk_qc_retention_sample_disposal_pairing CHECK (
        (status = 'retained') = (disposal_event_id IS NULL)
        AND (status = 'disposed') = (disposed_at IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON qc_retention_sample TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_retention_sample TO readonly_user;
  END IF;
END $$;
