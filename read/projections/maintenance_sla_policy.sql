-- Maintenance SLA policy (Story 7.3, FR-M-05). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.sla_policy_defined domain
-- events; mutation happens exclusively through persistEvent, which applies this projection inside
-- the SAME transaction as the domain_events insert.
--
-- uq_maintenance_sla_policy_key is the whole configurability contract: exactly ONE active policy
-- per (criticality_class, safety_flag) pair. The seam pre-check returns the stable
-- DUPLICATE_SLA_POLICY; this partial unique index is the concurrency backstop and the 23505 mapper
-- resolves the winner. Superseding an active policy (edit or deactivate) is out of scope for
-- Phase 1 (see the story's Binding Scope Decisions).

CREATE TABLE IF NOT EXISTS maintenance_sla_policy (
  policy_id        UUID PRIMARY KEY,
  criticality_class TEXT NOT NULL,
  safety_flag      BOOLEAN NOT NULL,
  priority         TEXT NOT NULL,
  response_minutes INTEGER NOT NULL,
  resolution_hours INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',
  created_by       UUID NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_maintenance_sla_policy_criticality CHECK (criticality_class IN ('critical', 'high', 'medium', 'low')),
  CONSTRAINT chk_maintenance_sla_policy_priority CHECK (priority IN ('p1', 'p2', 'p3', 'p4')),
  CONSTRAINT chk_maintenance_sla_policy_status CHECK (status IN ('active', 'inactive')),
  CONSTRAINT chk_maintenance_sla_policy_response CHECK (response_minutes > 0 AND response_minutes <= 100000),
  CONSTRAINT chk_maintenance_sla_policy_resolution CHECK (resolution_hours > 0 AND resolution_hours <= 100000)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_sla_policy_key ON maintenance_sla_policy (criticality_class, safety_flag) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_maintenance_sla_policy_status ON maintenance_sla_policy (status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_sla_policy_criticality'
      AND conrelid = 'maintenance_sla_policy'::regclass
  ) THEN
    ALTER TABLE maintenance_sla_policy
      ADD CONSTRAINT chk_maintenance_sla_policy_criticality CHECK (criticality_class IN ('critical', 'high', 'medium', 'low'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_sla_policy_priority'
      AND conrelid = 'maintenance_sla_policy'::regclass
  ) THEN
    ALTER TABLE maintenance_sla_policy
      ADD CONSTRAINT chk_maintenance_sla_policy_priority CHECK (priority IN ('p1', 'p2', 'p3', 'p4'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_sla_policy_status'
      AND conrelid = 'maintenance_sla_policy'::regclass
  ) THEN
    ALTER TABLE maintenance_sla_policy
      ADD CONSTRAINT chk_maintenance_sla_policy_status CHECK (status IN ('active', 'inactive'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_sla_policy_response'
      AND conrelid = 'maintenance_sla_policy'::regclass
  ) THEN
    ALTER TABLE maintenance_sla_policy
      ADD CONSTRAINT chk_maintenance_sla_policy_response CHECK (response_minutes > 0 AND response_minutes <= 100000);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_sla_policy_resolution'
      AND conrelid = 'maintenance_sla_policy'::regclass
  ) THEN
    ALTER TABLE maintenance_sla_policy
      ADD CONSTRAINT chk_maintenance_sla_policy_resolution CHECK (resolution_hours > 0 AND resolution_hours <= 100000);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON maintenance_sla_policy TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_sla_policy TO readonly_user;
  END IF;
END $$;
