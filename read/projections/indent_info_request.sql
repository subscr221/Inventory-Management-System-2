-- Requisition ask-for-info read model (Story 4.13). CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate); deploy/compose/init-db.sql duplicates this content
-- for first-boot container init - change both files together. Every statement is idempotent.
--
-- Derived state ONLY: rows are rebuildable by replaying indent.info_requested domain events;
-- mutation happens exclusively through persistEvent inside the same transaction as the
-- domain_events insert. One row per event; every question is kept (history), the newest is shown.
-- No FK to indent (the indent.sql / indent_issue.sql precedent).

CREATE TABLE IF NOT EXISTS indent_info_request (
  info_request_id    UUID PRIMARY KEY,
  indent_id          UUID NOT NULL,
  line_ids           UUID[] NOT NULL,
  question           TEXT NOT NULL,
  asked_by_user_id   UUID NOT NULL,
  asked_at           TIMESTAMPTZ NOT NULL,
  source_event_id    UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_indent_info_request_source_event UNIQUE (source_event_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_indent_info_request_source_event' AND conrelid = 'indent_info_request'::regclass
  ) THEN
    ALTER TABLE indent_info_request ADD CONSTRAINT uq_indent_info_request_source_event UNIQUE (source_event_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_indent_info_request_indent ON indent_info_request (indent_id, asked_at);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON indent_info_request TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON indent_info_request TO readonly_user;
  END IF;
END $$;
