-- Integration sync-state heartbeat and exception queue (Story 2.9). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks). deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks).
--
-- erp_sync_state holds one heartbeat row per projection ('purchase_orders' | 'sales_orders'):
-- last_attempted_at is stamped before a sync cycle, last_successful_at only after it completes, so
-- freshness (AC3) is observable even when a projection has zero rows (never_synced). integration_
-- exception is the append-plus-resolve queue for malformed source records (AC5) and stale-sync
-- alerts (AC3). The partial unique index uq_integration_exception_open (NULLS NOT DISTINCT) plus the
-- adapter's ON CONFLICT ... DO UPDATE contract guarantees a repeated malformed record or a repeated
-- stale-sync failure never stacks duplicate OPEN rows - it refreshes raised_at/details on the single
-- open row instead. This mirrors the Story 2.7/2.8 "one open recommendation per grain" pattern.

CREATE TABLE IF NOT EXISTS erp_sync_state (
  projection_name    TEXT PRIMARY KEY,
  status             TEXT NOT NULL DEFAULT 'never_synced',
  last_attempted_at  TIMESTAMPTZ,
  last_successful_at TIMESTAMPTZ,
  last_error         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_erp_sync_state_status CHECK (status IN ('never_synced', 'success', 'failed'))
);

CREATE TABLE IF NOT EXISTS integration_exception (
  exception_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system     TEXT NOT NULL DEFAULT 'ERP',
  record_type       TEXT NOT NULL,
  source_record_ref TEXT,
  error_code        TEXT NOT NULL,
  reason            TEXT NOT NULL,
  details           JSONB,
  status            TEXT NOT NULL DEFAULT 'open',
  raised_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_integration_exception_record_type CHECK (record_type IN ('purchase_order', 'sales_order', 'sync_batch')),
  CONSTRAINT chk_integration_exception_status CHECK (status IN ('open', 'resolved'))
);

CREATE INDEX IF NOT EXISTS idx_integration_exception_status ON integration_exception (status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_exception_open ON integration_exception (source_system, record_type, source_record_ref, error_code) NULLS NOT DISTINCT WHERE status = 'open';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_erp_sync_state_status'
      AND conrelid = 'erp_sync_state'::regclass
  ) THEN
    ALTER TABLE erp_sync_state
      ADD CONSTRAINT chk_erp_sync_state_status CHECK (status IN ('never_synced', 'success', 'failed'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_integration_exception_record_type'
      AND conrelid = 'integration_exception'::regclass
  ) THEN
    ALTER TABLE integration_exception
      ADD CONSTRAINT chk_integration_exception_record_type CHECK (record_type IN ('purchase_order', 'sales_order', 'sync_batch'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_integration_exception_status'
      AND conrelid = 'integration_exception'::regclass
  ) THEN
    ALTER TABLE integration_exception
      ADD CONSTRAINT chk_integration_exception_status CHECK (status IN ('open', 'resolved'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON erp_sync_state TO app_user;
    GRANT INSERT, SELECT, UPDATE ON integration_exception TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON erp_sync_state TO readonly_user;
    GRANT SELECT ON integration_exception TO readonly_user;
  END IF;
END $$;
