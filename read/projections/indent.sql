-- Purchase requisition (indent) read model (Story 4.3). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries
-- its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as
-- app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a live database
-- safely.
--
-- Derived state ONLY: rows are rebuildable by replaying indent.* domain events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert. Status vocabulary is the six AC-4 values plus
-- 'pending-confirmation' (AC 3 duplicate hold, hyphenated exactly as the AC spells it). The
-- rejection-reason CHECK enforces AC 5's mandatory reason at the database level. The partial
-- duplicate-detection index idx_indent_dup_window serves the AC 2 / AC 3 open-window lookup by
-- requester over open statuses only.

CREATE TABLE IF NOT EXISTS indent (
  indent_id                UUID PRIMARY KEY,
  indent_number_ext        TEXT NOT NULL,
  requester_user_id        UUID NOT NULL,
  department_code          TEXT NOT NULL,
  site_id                  UUID NOT NULL,
  business_stream          TEXT NOT NULL,
  need_by_date             DATE NOT NULL,
  urgent                   BOOLEAN NOT NULL DEFAULT false,
  reason                   TEXT,
  estimated_value          NUMERIC(18,4) NOT NULL DEFAULT 0,
  status                   TEXT NOT NULL DEFAULT 'raised',
  approver_actor_id        UUID,
  doa_entry_id             UUID,
  decided_at               TIMESTAMPTZ,
  decided_by               UUID,
  rejection_reason         TEXT,
  duplicate_of_indent_id   UUID,
  cancelled_reason         TEXT,
  expected_delivery_date   DATE,
  purchase_order_id        UUID,
  correlation_id           UUID,
  source_event_id          UUID NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_indent_status CHECK (status IN ('raised','pending-confirmation','approved','rejected','ordered','cancelled','closed')),
  CONSTRAINT chk_indent_rejection_reason CHECK (status <> 'rejected' OR (rejection_reason IS NOT NULL AND btrim(rejection_reason) <> '')),
  CONSTRAINT chk_indent_estimated_value_non_negative CHECK (estimated_value >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_indent_number_ext ON indent (indent_number_ext);
CREATE INDEX IF NOT EXISTS idx_indent_dup_window ON indent (requester_user_id, created_at DESC) WHERE status IN ('raised','pending-confirmation','approved');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_indent_status'
      AND conrelid = 'indent'::regclass
  ) THEN
    ALTER TABLE indent
      ADD CONSTRAINT chk_indent_status CHECK (status IN ('raised','pending-confirmation','approved','rejected','ordered','cancelled','closed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_indent_rejection_reason'
      AND conrelid = 'indent'::regclass
  ) THEN
    ALTER TABLE indent
      ADD CONSTRAINT chk_indent_rejection_reason CHECK (status <> 'rejected' OR (rejection_reason IS NOT NULL AND btrim(rejection_reason) <> ''));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_indent_estimated_value_non_negative'
      AND conrelid = 'indent'::regclass
  ) THEN
    ALTER TABLE indent
      ADD CONSTRAINT chk_indent_estimated_value_non_negative CHECK (estimated_value >= 0);
  END IF;
END $$;

-- Server-side human-ID allocation for the IND-YYYY-NNNN format (Task 5). A sequence is the only
-- lock-free allocator that survives concurrent raises; the year prefix is applied in the raise
-- handler. Gaps on rolled-back raises are acceptable - uniqueness is what matters.
CREATE SEQUENCE IF NOT EXISTS indent_number_seq;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON indent TO app_user;
    GRANT USAGE ON SEQUENCE indent_number_seq TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON indent TO readonly_user;
  END IF;
END $$;
