-- Legal Metrology label master - minimal enforcement contract (Story 8.6, FR-Q-14, AC 3). This
-- file is the CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Story 8.6 Binding Scope Decision 1: this table carries ONLY the columns the statutory release
-- block reads (the LABEL_VERSION_MISSING check passes when an 'approved' row exists for the
-- task's sku). Story 8.7 adds the version-control CRUD, approval workflow (DOA) and edit-logging.
-- Story 8.6 ships NO write routes and NO event types for this table; integration fixtures seed
-- rows through the admin pool, so app_user holds SELECT only.
--
-- Binding Scope Decision 8: "current approved label version" is a partial-unique row -
-- uq_label_master_current enforces the single-current-version invariant structurally from day
-- one. chk_label_master_approval_pairing is the FULL biconditional (the Story 8.4 one-directional
-- CHECK lesson): a row is approved-or-superseded exactly when it carries approval metadata, and
-- approved_by pairs with approved_at in both directions.

CREATE TABLE IF NOT EXISTS label_master (
  label_id      UUID PRIMARY KEY,
  sku           TEXT NOT NULL,
  label_version TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',
  approved_by   UUID,
  approved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_label_master_sku CHECK (btrim(sku) <> ''),
  CONSTRAINT chk_label_master_version CHECK (btrim(label_version) <> ''),
  CONSTRAINT chk_label_master_status CHECK (status IN ('draft', 'approved', 'superseded')),
  CONSTRAINT chk_label_master_approval_pairing CHECK (
    (status = 'approved' OR status = 'superseded') = (approved_at IS NOT NULL)
    AND (approved_at IS NOT NULL) = (approved_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_label_master_current
  ON label_master (sku) WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS idx_label_master_sku ON label_master (sku, status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_label_master_sku'
      AND conrelid = 'label_master'::regclass
  ) THEN
    ALTER TABLE label_master ADD CONSTRAINT chk_label_master_sku CHECK (btrim(sku) <> '');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_label_master_version'
      AND conrelid = 'label_master'::regclass
  ) THEN
    ALTER TABLE label_master
      ADD CONSTRAINT chk_label_master_version CHECK (btrim(label_version) <> '');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_label_master_status'
      AND conrelid = 'label_master'::regclass
  ) THEN
    ALTER TABLE label_master
      ADD CONSTRAINT chk_label_master_status CHECK (status IN ('draft', 'approved', 'superseded'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_label_master_approval_pairing'
      AND conrelid = 'label_master'::regclass
  ) THEN
    ALTER TABLE label_master
      ADD CONSTRAINT chk_label_master_approval_pairing CHECK (
        (status = 'approved' OR status = 'superseded') = (approved_at IS NOT NULL)
        AND (approved_at IS NOT NULL) = (approved_by IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT ON label_master TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON label_master TO readonly_user;
  END IF;
END $$;
