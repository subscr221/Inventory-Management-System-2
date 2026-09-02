-- QC witnessed / third-party inspection hold point (Story 8.8, FR-Q-15, AC 1 and AC 2). This file
-- is the CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.witness_hold_point_raised,
-- qc.witnessed_inspection_signed_off and qc.witnessed_inspection_waived; mutation happens
-- exclusively through persistEvent inside the SAME transaction as the domain_events insert.
--
-- Story 8.8 Binding Scope Decision 2: this table is the RECORD of the witnessed-inspection
-- obligation, not a second enforcement axis. The applier that inserts a row here ALSO inserts a
-- normal governed qc_quality_hold row and sets lot_master.quality_hold_status = 'held' in the same
-- transaction (qc_hold_id below points at that row), so the Story 3.7 dispatch gate refuses the
-- lot with LOT_ON_HOLD unchanged and the Story 2.3 ad hoc clear route still refuses to lift it
-- with QUALITY_HOLD_GOVERNED. Storing the hold anywhere else would re-open that bypass.
--
-- uq_qc_witness_hold_point_open is the one-OPEN-hold-point-per-lot backstop (a 23505 resolves to
-- 409 WITNESS_HOLD_POINT_EXISTS). Closed hold points are history and do not count against the
-- grain, hence the partial predicate - the UNIQUE keyword plus the WHERE clause ARE the semantics,
-- exactly like uq_qc_quality_hold_open.
--
-- chk_qc_witness_hold_point_closure_pairing is the FULL biconditional (the Story 8.4
-- one-directional CHECK lesson: a half-pairing admits rows nothing can interpret): status <> 'open'
-- exactly when closed_by, closed_at and close_event_id are all non-null, and waiver_doa_entry_id
-- AND waiver_reason are each non-null exactly when status = 'waived'. There is no reopen; closure
-- is terminal.
--
-- source_event_id is UNIQUE: the replay guard (the Story 8.7 lesson) - a redelivered raise event
-- cannot mint a second hold point.
--
-- app_user holds SELECT, INSERT and UPDATE (the one open -> signed_off/waived transition) and
-- never DELETE; fixtures that need to clear rows use the admin pool.

CREATE TABLE IF NOT EXISTS qc_witness_hold_point (
  hold_point_id        UUID PRIMARY KEY,
  lot_id               UUID NOT NULL,
  lot_number           TEXT NOT NULL,
  sku                  TEXT NOT NULL,
  site_id              UUID,
  inspection_type      TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'open',
  qc_hold_id           UUID NOT NULL,
  raised_by            UUID NOT NULL,
  raised_at            TIMESTAMPTZ NOT NULL,
  source_event_id      UUID NOT NULL,
  closed_by            UUID,
  closed_at            TIMESTAMPTZ,
  close_event_id       UUID,
  waiver_doa_entry_id  UUID,
  waiver_reason        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_qc_witness_hold_point_event UNIQUE (source_event_id),
  CONSTRAINT chk_qc_witness_hold_point_type CHECK (inspection_type IN ('customer_witnessed', 'third_party')),
  CONSTRAINT chk_qc_witness_hold_point_status CHECK (status IN ('open', 'signed_off', 'waived')),
  CONSTRAINT chk_qc_witness_hold_point_waiver_reason CHECK (
    waiver_reason IS NULL OR (btrim(waiver_reason) <> '' AND char_length(waiver_reason) <= 2000)
  ),
  CONSTRAINT chk_qc_witness_hold_point_closure_pairing CHECK (
    (status <> 'open') = (closed_by IS NOT NULL)
    AND (closed_by IS NOT NULL) = (closed_at IS NOT NULL)
    AND (closed_at IS NOT NULL) = (close_event_id IS NOT NULL)
    AND (status = 'waived') = (waiver_doa_entry_id IS NOT NULL)
    AND (status = 'waived') = (waiver_reason IS NOT NULL)
  )
);

-- One OPEN witness hold point per lot; closed hold points are retained history and never block a
-- new one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_qc_witness_hold_point_open
  ON qc_witness_hold_point (lot_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_qc_witness_hold_point_lot ON qc_witness_hold_point (lot_id);
CREATE INDEX IF NOT EXISTS idx_qc_witness_hold_point_site
  ON qc_witness_hold_point (site_id, raised_at, hold_point_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_witness_hold_point_event'
      AND conrelid = 'qc_witness_hold_point'::regclass
  ) THEN
    ALTER TABLE qc_witness_hold_point
      ADD CONSTRAINT uq_qc_witness_hold_point_event UNIQUE (source_event_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_witness_hold_point_type'
      AND conrelid = 'qc_witness_hold_point'::regclass
  ) THEN
    ALTER TABLE qc_witness_hold_point
      ADD CONSTRAINT chk_qc_witness_hold_point_type
      CHECK (inspection_type IN ('customer_witnessed', 'third_party'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_witness_hold_point_status'
      AND conrelid = 'qc_witness_hold_point'::regclass
  ) THEN
    ALTER TABLE qc_witness_hold_point
      ADD CONSTRAINT chk_qc_witness_hold_point_status
      CHECK (status IN ('open', 'signed_off', 'waived'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_witness_hold_point_waiver_reason'
      AND conrelid = 'qc_witness_hold_point'::regclass
  ) THEN
    ALTER TABLE qc_witness_hold_point
      ADD CONSTRAINT chk_qc_witness_hold_point_waiver_reason CHECK (
        waiver_reason IS NULL OR (btrim(waiver_reason) <> '' AND char_length(waiver_reason) <= 2000)
      );
  END IF;
  -- The code review 2026-09-02 widened the pairing to cover waiver_reason. Drop the constraint
  -- ONLY when a narrower (pre-widening) definition is installed, then add-if-missing as the
  -- siblings do - an unconditional drop-and-re-add would take an ACCESS EXCLUSIVE lock and a full
  -- validation scan on EVERY migrate run, forever (round-2 review).
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_witness_hold_point_closure_pairing'
      AND conrelid = 'qc_witness_hold_point'::regclass
      AND pg_get_constraintdef(oid) NOT LIKE '%waiver_reason%'
  ) THEN
    ALTER TABLE qc_witness_hold_point
      DROP CONSTRAINT chk_qc_witness_hold_point_closure_pairing;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_witness_hold_point_closure_pairing'
      AND conrelid = 'qc_witness_hold_point'::regclass
  ) THEN
    ALTER TABLE qc_witness_hold_point
      ADD CONSTRAINT chk_qc_witness_hold_point_closure_pairing CHECK (
        (status <> 'open') = (closed_by IS NOT NULL)
        AND (closed_by IS NOT NULL) = (closed_at IS NOT NULL)
        AND (closed_at IS NOT NULL) = (close_event_id IS NOT NULL)
        AND (status = 'waived') = (waiver_doa_entry_id IS NOT NULL)
        AND (status = 'waived') = (waiver_reason IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE ON qc_witness_hold_point TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_witness_hold_point TO readonly_user;
  END IF;
END $$;
