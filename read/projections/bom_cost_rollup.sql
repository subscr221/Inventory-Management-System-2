-- BOM cost rollup snapshot header read model (Story 5.6, FR-B-15). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks).
--
-- Derived state ONLY: rows are rebuildable by replaying bom.cost_rollup_snapshotted domain events.
-- The rollup math runs at CAPTURE time in src/engineering/bom-cost-rollup.ts and is embedded in the
-- event payload; the applier persists it verbatim so replay is byte-deterministic.
--
-- A rollup is a dated SIMULATION (C-10, FR-B-15 boundary): it posts no valuation, sets no standard
-- cost, and writes nothing back to item_master. Prior snapshots are never updated or deleted, so a
-- BOM accumulates a dated history that the comparison read walks.
--
-- total_cost is unbounded NUMERIC deliberately: the multi-level product
-- effective_quantity_per * unit_cost can exceed NUMERIC(18,6) scale and PostgreSQL 18 silently
-- rounds excess scale.

CREATE TABLE IF NOT EXISTS bom_cost_rollup (
  rollup_id          UUID PRIMARY KEY,
  bom_id             UUID NOT NULL,
  revision_id        UUID NOT NULL,
  rollup_date        DATE NOT NULL,
  rate_basis         TEXT NOT NULL,
  total_cost         NUMERIC NOT NULL,
  line_count         INTEGER NOT NULL,
  missing_rate_count INTEGER NOT NULL,
  depth_truncated    BOOLEAN NOT NULL DEFAULT false,
  rolled_up_by       UUID,
  correlation_id     UUID,
  source_event_id    UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bom_cost_rollup_rate_basis CHECK (rate_basis IN ('item_master_standard_cost')),
  CONSTRAINT chk_bom_cost_rollup_counts CHECK (line_count >= 0 AND missing_rate_count >= 0 AND missing_rate_count <= line_count)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_cost_rollup_source_event ON bom_cost_rollup (source_event_id);
CREATE INDEX IF NOT EXISTS idx_bom_cost_rollup_bom ON bom_cost_rollup (bom_id, rollup_date DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_cost_rollup_rate_basis'
      AND conrelid = 'bom_cost_rollup'::regclass
  ) THEN
    ALTER TABLE bom_cost_rollup
      ADD CONSTRAINT chk_bom_cost_rollup_rate_basis CHECK (rate_basis IN ('item_master_standard_cost'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_cost_rollup_counts'
      AND conrelid = 'bom_cost_rollup'::regclass
  ) THEN
    ALTER TABLE bom_cost_rollup
      ADD CONSTRAINT chk_bom_cost_rollup_counts CHECK (line_count >= 0 AND missing_rate_count >= 0 AND missing_rate_count <= line_count);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON bom_cost_rollup TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON bom_cost_rollup TO readonly_user;
  END IF;
END $$;
