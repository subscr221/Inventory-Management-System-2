-- QC governed quality hold (Story 8.5, FR-Q-09, AC 1 and AC 2). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.hold_placed and qc.hold_released domain
-- events; mutation happens exclusively through persistEvent inside the SAME transaction as the
-- domain_events insert.
--
-- Story 8.5 Binding Scope Decision 1: this table is the governed RECORD of the hold decision, not
-- a second enforcement axis. The applier that inserts a row here sets
-- lot_master.quality_hold_status = 'held' inside the SAME transaction; every enforcement site
-- (assertQcGateAllows, dispatch, cross-dock, lot-serial-validation, receiving, the Story 8.4
-- release path) keeps reading that one flag and is untouched by this story.
--
-- uq_qc_quality_hold_open is the one-OPEN-hold-per-lot backstop (a 23505 resolves to 409
-- HOLD_EXISTS in the store's constraint chain). Released holds are history and do not count
-- against the grain, hence the partial predicate - the UNIQUE keyword plus the WHERE clause ARE
-- the semantics, exactly like uq_production_order_source_rework_event.
--
-- chk_qc_quality_hold_release_pairing is the FULL biconditional (the Story 8.4 one-directional
-- CHECK lesson): status = 'released' exactly when all four release columns are non-null, and
-- status = 'open' exactly when all four are null. There is no reopen; release is terminal.
--
-- app_user holds INSERT, SELECT and UPDATE (the one open -> released transition) and never DELETE.

CREATE TABLE IF NOT EXISTS qc_quality_hold (
  hold_id          UUID PRIMARY KEY,
  lot_id           UUID NOT NULL,
  lot_number       TEXT NOT NULL,
  sku              TEXT NOT NULL,
  site_id          UUID NOT NULL,
  hold_reason      TEXT NOT NULL,
  defect_code      TEXT,
  status           TEXT NOT NULL DEFAULT 'open',
  placed_by        UUID NOT NULL,
  placed_at        TIMESTAMPTZ NOT NULL,
  source_event_id  UUID NOT NULL,
  released_by      UUID,
  released_at      TIMESTAMPTZ,
  release_reason   TEXT,
  release_event_id UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_qc_quality_hold_status CHECK (status IN ('open', 'released')),
  CONSTRAINT chk_qc_quality_hold_reason CHECK (btrim(hold_reason) <> '' AND char_length(hold_reason) <= 2000),
  CONSTRAINT chk_qc_quality_hold_release_reason CHECK (
    release_reason IS NULL OR (btrim(release_reason) <> '' AND char_length(release_reason) <= 2000)
  ),
  CONSTRAINT chk_qc_quality_hold_release_pairing CHECK (
    (status = 'released') = (released_by IS NOT NULL)
    AND (released_by IS NOT NULL) = (released_at IS NOT NULL)
    AND (released_at IS NOT NULL) = (release_reason IS NOT NULL)
    AND (release_reason IS NOT NULL) = (release_event_id IS NOT NULL)
  )
);

-- One OPEN hold per lot; released holds are retained history and never block a new hold.
CREATE UNIQUE INDEX IF NOT EXISTS uq_qc_quality_hold_open ON qc_quality_hold (lot_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_qc_quality_hold_site ON qc_quality_hold (site_id, placed_at, hold_id);
CREATE INDEX IF NOT EXISTS idx_qc_quality_hold_lot ON qc_quality_hold (lot_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_quality_hold_status'
      AND conrelid = 'qc_quality_hold'::regclass
  ) THEN
    ALTER TABLE qc_quality_hold
      ADD CONSTRAINT chk_qc_quality_hold_status CHECK (status IN ('open', 'released'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_quality_hold_reason'
      AND conrelid = 'qc_quality_hold'::regclass
  ) THEN
    ALTER TABLE qc_quality_hold
      ADD CONSTRAINT chk_qc_quality_hold_reason CHECK (btrim(hold_reason) <> '' AND char_length(hold_reason) <= 2000);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_quality_hold_release_reason'
      AND conrelid = 'qc_quality_hold'::regclass
  ) THEN
    ALTER TABLE qc_quality_hold
      ADD CONSTRAINT chk_qc_quality_hold_release_reason CHECK (
        release_reason IS NULL OR (btrim(release_reason) <> '' AND char_length(release_reason) <= 2000)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_quality_hold_release_pairing'
      AND conrelid = 'qc_quality_hold'::regclass
  ) THEN
    ALTER TABLE qc_quality_hold
      ADD CONSTRAINT chk_qc_quality_hold_release_pairing CHECK (
        (status = 'released') = (released_by IS NOT NULL)
        AND (released_by IS NOT NULL) = (released_at IS NOT NULL)
        AND (released_at IS NOT NULL) = (release_reason IS NOT NULL)
        AND (release_reason IS NOT NULL) = (release_event_id IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON qc_quality_hold TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_quality_hold TO readonly_user;
  END IF;
END $$;
