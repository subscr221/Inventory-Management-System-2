-- Reason-coded warranty overrides on breakdown work orders (Story 7.7, FR-M-11, AC 3 and AC 4).
-- This file is the CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and
-- the integration-test harness. It carries its OWN grants (guarded DO blocks) so a
-- migrate-provisioned database can serve reads/writes as app_user without depending on
-- deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates this content for first-boot
-- container init - change both files together. Every statement is idempotent (IF NOT EXISTS /
-- guarded DO blocks) so the file can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.warranty_override_recorded
-- domain events; mutation happens exclusively through persistEvent, which applies this projection
-- inside the SAME transaction as the domain_events insert.
--
-- The grain is ONE override per work order (Binding Decision 11): a reason-coded override is a
-- one-time supervisor decision, and uq_maintenance_warranty_override_work_order is the concurrency
-- backstop behind the sequential pre-check (a 23505 on it resolves to 409
-- WARRANTY_OVERRIDE_ALREADY_RECORDED with the existing override id, so the race path and the
-- sequential path return the same shape).
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE (the maintenance_reliability_
-- metric precedent). An override is never mutated; a mistaken one stands in the record.

CREATE TABLE IF NOT EXISTS maintenance_warranty_override (
  override_id          UUID PRIMARY KEY,
  work_order_id        UUID NOT NULL,
  warranty_coverage_id UUID NOT NULL,
  reason_code          TEXT NOT NULL,
  overridden_by        UUID NOT NULL,
  overridden_at        TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_maintenance_warranty_override_work_order UNIQUE (work_order_id),
  CONSTRAINT chk_maintenance_warranty_override_reason CHECK (btrim(reason_code) <> '')
);

CREATE INDEX IF NOT EXISTS idx_maintenance_warranty_override_coverage ON maintenance_warranty_override (warranty_coverage_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_maintenance_warranty_override_work_order'
      AND conrelid = 'maintenance_warranty_override'::regclass
  ) THEN
    ALTER TABLE maintenance_warranty_override
      ADD CONSTRAINT uq_maintenance_warranty_override_work_order UNIQUE (work_order_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_warranty_override_reason'
      AND conrelid = 'maintenance_warranty_override'::regclass
  ) THEN
    ALTER TABLE maintenance_warranty_override
      ADD CONSTRAINT chk_maintenance_warranty_override_reason CHECK (btrim(reason_code) <> '');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON maintenance_warranty_override TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_warranty_override TO readonly_user;
  END IF;
END $$;
