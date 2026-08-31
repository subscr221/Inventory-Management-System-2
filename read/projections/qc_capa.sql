-- QC corrective and preventive action record (Story 8.5, FR-Q-10, AC 3 and AC 4). This file is
-- the CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.capa_opened and qc.capa_closed domain
-- events; mutation happens exclusively through persistEvent inside the SAME transaction as the
-- domain_events insert.
--
-- Story 8.5 Binding Scope Decision 11: a CAPA is a first-class record with its own lifecycle
-- (open -> closed), owner, due date and closure evidence - AC 3's "linked to a CAPA record" is a
-- validated reference to a row here, never a free-text id. capa_number is minted server-side from
-- qc_capa_number_seq (the production_order_number_seq pattern); uq_qc_capa_number is the backstop
-- (a 23505 resolves to 409 CAPA_EXISTS in the store's constraint chain).
--
-- chk_qc_capa_closure_pairing is the FULL biconditional (the Story 8.4 one-directional CHECK
-- lesson): status = 'closed' exactly when all four closure columns are non-null, and
-- status = 'open' exactly when all four are null. There is no reopen.
--
-- app_user holds INSERT, SELECT and UPDATE (the one open -> closed transition) and never DELETE.

CREATE TABLE IF NOT EXISTS qc_capa (
  capa_id           UUID PRIMARY KEY,
  capa_number       TEXT NOT NULL,
  sku               TEXT NOT NULL,
  defect_code       TEXT NOT NULL,
  title             TEXT NOT NULL,
  root_cause        TEXT,
  corrective_action TEXT,
  preventive_action TEXT,
  owner_user_id     UUID NOT NULL,
  due_on            DATE NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open',
  opened_by         UUID NOT NULL,
  opened_at         TIMESTAMPTZ NOT NULL,
  closed_by         UUID,
  closed_at         TIMESTAMPTZ,
  closure_evidence  TEXT,
  source_event_id   UUID NOT NULL,
  close_event_id    UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_qc_capa_number UNIQUE (capa_number),
  CONSTRAINT chk_qc_capa_status CHECK (status IN ('open', 'closed')),
  CONSTRAINT chk_qc_capa_title CHECK (btrim(title) <> '' AND char_length(title) <= 2000),
  CONSTRAINT chk_qc_capa_closure_evidence CHECK (
    closure_evidence IS NULL OR (btrim(closure_evidence) <> '' AND char_length(closure_evidence) <= 2000)
  ),
  CONSTRAINT chk_qc_capa_closure_pairing CHECK (
    (status = 'closed') = (closed_by IS NOT NULL)
    AND (closed_by IS NOT NULL) = (closed_at IS NOT NULL)
    AND (closed_at IS NOT NULL) = (closure_evidence IS NOT NULL)
    AND (closure_evidence IS NOT NULL) = (close_event_id IS NOT NULL)
  )
);

CREATE SEQUENCE IF NOT EXISTS qc_capa_number_seq;

CREATE INDEX IF NOT EXISTS idx_qc_capa_sku_defect ON qc_capa (sku, defect_code, status);
CREATE INDEX IF NOT EXISTS idx_qc_capa_status ON qc_capa (status, due_on, capa_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_capa_number'
      AND conrelid = 'qc_capa'::regclass
  ) THEN
    ALTER TABLE qc_capa ADD CONSTRAINT uq_qc_capa_number UNIQUE (capa_number);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_capa_status'
      AND conrelid = 'qc_capa'::regclass
  ) THEN
    ALTER TABLE qc_capa ADD CONSTRAINT chk_qc_capa_status CHECK (status IN ('open', 'closed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_capa_title'
      AND conrelid = 'qc_capa'::regclass
  ) THEN
    ALTER TABLE qc_capa
      ADD CONSTRAINT chk_qc_capa_title CHECK (btrim(title) <> '' AND char_length(title) <= 2000);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_capa_closure_evidence'
      AND conrelid = 'qc_capa'::regclass
  ) THEN
    ALTER TABLE qc_capa
      ADD CONSTRAINT chk_qc_capa_closure_evidence CHECK (
        closure_evidence IS NULL OR (btrim(closure_evidence) <> '' AND char_length(closure_evidence) <= 2000)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_capa_closure_pairing'
      AND conrelid = 'qc_capa'::regclass
  ) THEN
    ALTER TABLE qc_capa
      ADD CONSTRAINT chk_qc_capa_closure_pairing CHECK (
        (status = 'closed') = (closed_by IS NOT NULL)
        AND (closed_by IS NOT NULL) = (closed_at IS NOT NULL)
        AND (closed_at IS NOT NULL) = (closure_evidence IS NOT NULL)
        AND (closure_evidence IS NOT NULL) = (close_event_id IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON qc_capa TO app_user;
    GRANT USAGE ON qc_capa_number_seq TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_capa TO readonly_user;
  END IF;
END $$;
