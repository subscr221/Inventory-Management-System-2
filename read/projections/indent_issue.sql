-- Stores counter issue slip read model (Story 4.11). CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate); deploy/compose/init-db.sql duplicates this content
-- for first-boot container init - change both files together. Every statement is idempotent.
--
-- Derived state ONLY: rows are rebuildable by replaying indent.issued domain events; mutation
-- happens exclusively through persistEvent inside the same transaction as the domain_events
-- insert. One slip per indent.issued event; the slip text is immutable once written. Follows the
-- indent.sql / indent_line.sql header-plus-line precedent (no FK to indent, same-transaction
-- inserts).

CREATE TABLE IF NOT EXISTS indent_issue (
  issue_id          UUID PRIMARY KEY,
  issue_number_ext  TEXT NOT NULL,
  indent_id         UUID NOT NULL,
  site_id           UUID NOT NULL,
  issued_by         TEXT NOT NULL,
  issued_at         TIMESTAMPTZ NOT NULL,
  slip_content      TEXT NOT NULL DEFAULT '',
  source_event_id   UUID NOT NULL,
  correlation_id    UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_indent_issue_number_ext UNIQUE (issue_number_ext),
  CONSTRAINT uq_indent_issue_source_event UNIQUE (source_event_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_indent_issue_number_ext' AND conrelid = 'indent_issue'::regclass
  ) THEN
    ALTER TABLE indent_issue ADD CONSTRAINT uq_indent_issue_number_ext UNIQUE (issue_number_ext);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_indent_issue_source_event' AND conrelid = 'indent_issue'::regclass
  ) THEN
    ALTER TABLE indent_issue ADD CONSTRAINT uq_indent_issue_source_event UNIQUE (source_event_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_indent_issue_indent ON indent_issue (indent_id, issued_at);

CREATE TABLE IF NOT EXISTS indent_issue_line (
  issue_line_id          UUID PRIMARY KEY,
  issue_id               UUID NOT NULL,
  indent_id              UUID NOT NULL,
  indent_line_id         UUID NOT NULL,
  line_no                INTEGER NOT NULL,
  sku                    TEXT NOT NULL,
  quantity               NUMERIC(18,3) NOT NULL,
  uom                    TEXT NOT NULL,
  location_id            UUID NOT NULL,
  location_code          TEXT NOT NULL,
  lot_id                 TEXT,
  serials                JSONB,
  stock_issued_event_id  UUID NOT NULL,
  approval_basis         TEXT NOT NULL,
  -- Story 4.8 seam: the standing approval a line rode on; null until that story lands.
  standing_grant_id      UUID,
  CONSTRAINT chk_indent_issue_line_qty_positive CHECK (quantity > 0)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_indent_issue_line_qty_positive' AND conrelid = 'indent_issue_line'::regclass
  ) THEN
    ALTER TABLE indent_issue_line ADD CONSTRAINT chk_indent_issue_line_qty_positive CHECK (quantity > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_indent_issue_line_issue ON indent_issue_line (issue_id);
CREATE INDEX IF NOT EXISTS idx_indent_issue_line_indent_line ON indent_issue_line (indent_line_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_indent_issue_line_issue_line ON indent_issue_line (issue_id, indent_line_id);

-- Server-side human-ID allocation for the ISS-YYYY-NNNN format (the indent_number_seq idiom).
CREATE SEQUENCE IF NOT EXISTS indent_issue_number_seq;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON indent_issue TO app_user;
    GRANT INSERT, SELECT ON indent_issue_line TO app_user;
    GRANT USAGE ON SEQUENCE indent_issue_number_seq TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON indent_issue TO readonly_user;
    GRANT SELECT ON indent_issue_line TO readonly_user;
  END IF;
END $$;
