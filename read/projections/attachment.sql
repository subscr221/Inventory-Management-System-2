-- Attachment store (Story 8.9, AC 7: photos are stored as taken, with no application size cap).
-- This file is the CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and
-- the integration-test harness. It carries its OWN grants (guarded DO blocks). deploy/compose/
-- init-db.sql duplicates this content for first-boot container init - change both files together.
-- Every statement is idempotent.
--
-- One row per client-minted attachment_id. The bytes live here, never on an event: the
-- attachment.uploaded event carries metadata only (content type, size, sha256), so the domain
-- event log stays small and the upload is still edit-logged (AD-12). A re-upload of the same id
-- with the same sha256 is an idempotent replay; different bytes under a taken id are refused.
-- There is deliberately no byte_size CHECK (D14): the only ceiling is the server-wide request
-- limit every request already has. app_user holds INSERT and SELECT only: an attachment is never
-- rewritten or deleted.

CREATE TABLE IF NOT EXISTS attachment (
  attachment_id    UUID PRIMARY KEY,
  content_type     TEXT NOT NULL,
  byte_size        BIGINT NOT NULL,
  sha256           TEXT NOT NULL,
  data             BYTEA NOT NULL,
  uploaded_by      UUID NOT NULL,
  uploaded_at      TIMESTAMPTZ NOT NULL,
  source_event_id  UUID NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_attachment_content_type CHECK (
    content_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')
  ),
  CONSTRAINT chk_attachment_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_attachment_uploaded_by ON attachment (uploaded_by, uploaded_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON attachment TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON attachment TO readonly_user;
  END IF;
END $$;
