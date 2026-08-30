-- QC batch release record (Story 8.4, FR-Q-07, AC 1, AC 3, AC 6 and AC 7). This file is the
-- CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying the qc.batch_release_recorded domain event;
-- mutation happens exclusively through persistEvent inside the SAME transaction as the
-- domain_events insert.
--
-- Story 8.4 Binding Scope Decision 1: release is a DOWNSTREAM step on top of an already-decided
-- disposition, not a rename of it. A row exists only when qc_lot_disposition.disposition is
-- 'accept' or 'conditional_release' for the same lot; uq_qc_batch_release_lot and
-- uq_qc_batch_release_disposition are the one-per-lot backstops (a 23505 resolves to 409
-- RELEASE_EXISTS in the store's constraint chain), the same shape uq_qc_lot_disposition_lot has.
--
-- Binding Scope Decision 4: document_kind is DERIVED from the released item's
-- item_master.bis_licence_required - 'coc' for a BIS-covered product (the regulatory conformance
-- format, which is where AC 3's CM/L or R-number is printed), 'coa' otherwise.
--
-- Binding Scope Decision 5: no physical document is generated or stored by this story. document_ref
-- is the future document-store key and is left NULL here, following the reference-not-bytes
-- precedent of supplier_invoice's attachment_ref. THIS ROW plus its event IS the retained record
-- for the retention_years window today (ARCHITECTURE-SPINE.md Retention Policy).
--
-- Binding Scope Decision 2: bis_licence_number carries whatever resolveBisLicenceNumber returns and
-- is NULL until Story 8.7's BIS licence register lands. A null NEVER blocks release - AC 3 only
-- requires printing the number when one is available.
--
-- chk_qc_batch_release_bis_licence_pairing states the full invariant AC 3 actually claims: a licence
-- number may exist ONLY on a CoC (it is the BIS conformance format), and when present it must be
-- non-blank. Without it a CoA carrying a CM/L number, and an empty-string number that a certificate
-- would print as a blank licence field rather than omitting it, are both representable rows.
--
-- app_user holds INSERT and SELECT only: there is no revision, amendment or retraction concept in
-- this story, so the table is append-only and never DELETE.

CREATE TABLE IF NOT EXISTS qc_batch_release (
  release_id            UUID PRIMARY KEY,
  lot_id                UUID NOT NULL,
  task_id               UUID NOT NULL,
  disposition_id        UUID NOT NULL,
  document_kind         TEXT NOT NULL,
  document_ref          TEXT,
  retention_years       INTEGER NOT NULL,
  retention_expires_on  DATE NOT NULL,
  bis_licence_number    TEXT,
  released_by           UUID NOT NULL,
  released_at           TIMESTAMPTZ NOT NULL,
  source_event_id       UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_qc_batch_release_lot UNIQUE (lot_id),
  CONSTRAINT uq_qc_batch_release_disposition UNIQUE (disposition_id),
  CONSTRAINT chk_qc_batch_release_document_kind CHECK (document_kind IN ('coa', 'coc')),
  CONSTRAINT chk_qc_batch_release_retention_years CHECK (retention_years > 0),
  CONSTRAINT chk_qc_batch_release_bis_licence_pairing CHECK (
    bis_licence_number IS NULL
    OR (document_kind = 'coc' AND btrim(bis_licence_number) <> '')
  )
);

CREATE INDEX IF NOT EXISTS idx_qc_batch_release_task ON qc_batch_release (task_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_batch_release_lot'
      AND conrelid = 'qc_batch_release'::regclass
  ) THEN
    ALTER TABLE qc_batch_release ADD CONSTRAINT uq_qc_batch_release_lot UNIQUE (lot_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_qc_batch_release_disposition'
      AND conrelid = 'qc_batch_release'::regclass
  ) THEN
    ALTER TABLE qc_batch_release ADD CONSTRAINT uq_qc_batch_release_disposition UNIQUE (disposition_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_batch_release_document_kind'
      AND conrelid = 'qc_batch_release'::regclass
  ) THEN
    ALTER TABLE qc_batch_release
      ADD CONSTRAINT chk_qc_batch_release_document_kind CHECK (document_kind IN ('coa', 'coc'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_batch_release_retention_years'
      AND conrelid = 'qc_batch_release'::regclass
  ) THEN
    ALTER TABLE qc_batch_release
      ADD CONSTRAINT chk_qc_batch_release_retention_years CHECK (retention_years > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_batch_release_bis_licence_pairing'
      AND conrelid = 'qc_batch_release'::regclass
  ) THEN
    ALTER TABLE qc_batch_release
      ADD CONSTRAINT chk_qc_batch_release_bis_licence_pairing CHECK (
        bis_licence_number IS NULL
        OR (document_kind = 'coc' AND btrim(bis_licence_number) <> '')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON qc_batch_release TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_batch_release TO readonly_user;
  END IF;
END $$;
