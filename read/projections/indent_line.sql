-- Purchase requisition (indent) line read model (Story 4.3). CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate); deploy/compose/init-db.sql duplicates this content
-- for first-boot container init - change both files together. Every statement is idempotent.
--
-- Derived state ONLY: rows are rebuildable by replaying indent.* domain events; mutation happens
-- exclusively through persistEvent inside the same transaction as the domain_events insert.
-- Follows the grn.sql / grn_line.sql header-plus-line precedent.

CREATE TABLE IF NOT EXISTS indent_line (
  indent_line_id       UUID PRIMARY KEY,
  indent_id            UUID NOT NULL,
  line_no              INTEGER NOT NULL,
  sku                  TEXT NOT NULL,
  item_category        TEXT NOT NULL,
  requested_qty        NUMERIC(18,3) NOT NULL,
  uom                  TEXT NOT NULL,
  unit_price_estimate  NUMERIC(18,4),
  line_value           NUMERIC(18,4) NOT NULL DEFAULT 0,
  CONSTRAINT uq_indent_line_no UNIQUE (indent_id, line_no),
  CONSTRAINT chk_indent_line_qty_positive CHECK (requested_qty > 0)
);

CREATE INDEX IF NOT EXISTS idx_indent_line_sku ON indent_line (sku);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_indent_line_qty_positive'
      AND conrelid = 'indent_line'::regclass
  ) THEN
    ALTER TABLE indent_line
      ADD CONSTRAINT chk_indent_line_qty_positive CHECK (requested_qty > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_indent_line_no'
      AND conrelid = 'indent_line'::regclass
  ) THEN
    ALTER TABLE indent_line
      ADD CONSTRAINT uq_indent_line_no UNIQUE (indent_id, line_no);
  END IF;
END $$;

-- Story 4.10: per-line approval route and decision state. Header status derives from these.
ALTER TABLE indent_line ADD COLUMN IF NOT EXISTS approval_route TEXT NOT NULL DEFAULT 'doa';
ALTER TABLE indent_line ADD COLUMN IF NOT EXISTS line_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE indent_line ADD COLUMN IF NOT EXISTS approver_actor_id TEXT;
ALTER TABLE indent_line ADD COLUMN IF NOT EXISTS doa_entry_id UUID;
ALTER TABLE indent_line ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
ALTER TABLE indent_line ADD COLUMN IF NOT EXISTS decided_by TEXT;
ALTER TABLE indent_line ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_indent_line_route' AND conrelid = 'indent_line'::regclass
  ) THEN
    ALTER TABLE indent_line ADD CONSTRAINT chk_indent_line_route
      CHECK (approval_route IN ('doa', 'standing_approval', 'self_approval'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_indent_line_status' AND conrelid = 'indent_line'::regclass
  ) THEN
    ALTER TABLE indent_line ADD CONSTRAINT chk_indent_line_status
      CHECK (line_status IN ('pending', 'approved', 'rejected'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_indent_line_rejection_reason' AND conrelid = 'indent_line'::regclass
  ) THEN
    ALTER TABLE indent_line ADD CONSTRAINT chk_indent_line_rejection_reason
      CHECK (line_status <> 'rejected' OR (rejection_reason IS NOT NULL AND length(trim(rejection_reason)) > 0));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_indent_line_status ON indent_line (indent_id, line_status);

-- Story 4.10 backfill (idempotent): lines of indents decided before per-line state existed
-- inherit the header decision; undecided headers copy the routing only.
UPDATE indent_line l
SET line_status = CASE WHEN i.status = 'rejected' THEN 'rejected' ELSE 'approved' END,
    approver_actor_id = i.approver_actor_id::text,
    doa_entry_id = i.doa_entry_id,
    decided_at = i.decided_at,
    decided_by = i.decided_by::text,
    rejection_reason = i.rejection_reason
FROM indent i
WHERE l.indent_id = i.indent_id
  AND l.decided_at IS NULL
  AND i.decided_at IS NOT NULL
  AND i.status IN ('approved', 'ordered', 'closed', 'rejected');

UPDATE indent_line l
SET approver_actor_id = i.approver_actor_id::text,
    doa_entry_id = i.doa_entry_id
FROM indent i
WHERE l.indent_id = i.indent_id
  AND l.decided_at IS NULL
  AND l.approver_actor_id IS NULL
  AND i.approver_actor_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON indent_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON indent_line TO readonly_user;
  END IF;
END $$;
