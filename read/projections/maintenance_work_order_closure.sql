-- Three-part closure coding ledger (Story 7.8, FR-M-18, AC 3 and AC 4). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.work_order_completed domain
-- events that carry fault_code, cause_code and remedy_code; mutation happens exclusively through
-- persistEvent, which applies this projection inside the SAME transaction as the domain_events
-- insert (the closure insert rides the completion transaction under the work order's lock).
--
-- The grain is ONE closure per work order (Binding Decision 9): the closure id IS the work order
-- id, so replay mints nothing random and the primary key is the concurrency backstop (a 23505 on
-- it resolves to 409 WORK_ORDER_ALREADY_COMPLETED in the store's pkey chain).
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE (the maintenance_warranty_
-- override precedent). A recorded closure is failure history and is never amended.
--
-- idx_maintenance_work_order_closure_asset serves the "last five closures" read verbatim:
-- WHERE asset_id = $1 ORDER BY closed_at DESC, work_order_id ASC LIMIT 5.

CREATE TABLE IF NOT EXISTS maintenance_work_order_closure (
  work_order_id UUID PRIMARY KEY,
  asset_id      UUID NOT NULL,
  origin        TEXT NOT NULL,
  fault_code    TEXT NOT NULL,
  cause_code    TEXT NOT NULL,
  remedy_code   TEXT NOT NULL,
  closed_by     UUID NOT NULL,
  closed_at     TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_maintenance_work_order_closure_origin CHECK (origin IN ('preventive', 'breakdown')),
  CONSTRAINT chk_maintenance_work_order_closure_codes CHECK (btrim(fault_code) <> '' AND char_length(fault_code) <= 64 AND btrim(cause_code) <> '' AND char_length(cause_code) <= 64 AND btrim(remedy_code) <> '' AND char_length(remedy_code) <= 64)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_work_order_closure_asset ON maintenance_work_order_closure (asset_id, closed_at DESC, work_order_id ASC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_work_order_closure_origin'
      AND conrelid = 'maintenance_work_order_closure'::regclass
  ) THEN
    ALTER TABLE maintenance_work_order_closure
      ADD CONSTRAINT chk_maintenance_work_order_closure_origin CHECK (origin IN ('preventive', 'breakdown'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_work_order_closure_codes'
      AND conrelid = 'maintenance_work_order_closure'::regclass
  ) THEN
    ALTER TABLE maintenance_work_order_closure
      ADD CONSTRAINT chk_maintenance_work_order_closure_codes CHECK (btrim(fault_code) <> '' AND char_length(fault_code) <= 64 AND btrim(cause_code) <> '' AND char_length(cause_code) <= 64 AND btrim(remedy_code) <> '' AND char_length(remedy_code) <= 64);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON maintenance_work_order_closure TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_work_order_closure TO readonly_user;
  END IF;
END $$;
