-- Story 9.4 (FR-JW-11): job-work output tracking. This file is the CANONICAL definition, applied
-- by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its
-- OWN grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as
-- app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a live database
-- safely.
--
-- Derived state ONLY: one row per jobwork.output_recorded event, rebuildable by replaying the
-- jobwork stream. dispatched_quantity accumulates as jobwork.output_dispatched events post against
-- the lot; it is the "open-to-dispatch quantity" tracking AC5 requires. No FK is declared (the
-- Epic 9 house convention: FK-shaped reference to service_order, no declared FK) - this is a
-- derived, rebuildable projection in the same style as production_scrap_declaration.

CREATE TABLE IF NOT EXISTS job_work_output (
  output_id            UUID PRIMARY KEY,
  service_order_id     UUID NOT NULL,
  lot_id               TEXT NOT NULL,
  lot_number           TEXT NOT NULL,
  sku                  TEXT NOT NULL,
  quantity             NUMERIC(18,3) NOT NULL,
  dispatched_quantity  NUMERIC(18,3) NOT NULL DEFAULT 0,
  uom                  TEXT NOT NULL,
  site_id              UUID NOT NULL,
  recorded_by          UUID NOT NULL,
  source_event_id      UUID NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_job_work_output_quantity_positive CHECK (quantity > 0),
  CONSTRAINT chk_job_work_output_dispatched_bounds CHECK (
    dispatched_quantity >= 0 AND dispatched_quantity <= quantity
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_work_output_source_event ON job_work_output (source_event_id);
CREATE INDEX IF NOT EXISTS idx_job_work_output_order ON job_work_output (service_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_work_output_lot ON job_work_output (lot_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_job_work_output_quantity_positive'
      AND conrelid = 'job_work_output'::regclass
  ) THEN
    ALTER TABLE job_work_output
      ADD CONSTRAINT chk_job_work_output_quantity_positive CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_job_work_output_dispatched_bounds'
      AND conrelid = 'job_work_output'::regclass
  ) THEN
    ALTER TABLE job_work_output
      ADD CONSTRAINT chk_job_work_output_dispatched_bounds CHECK (
        dispatched_quantity >= 0 AND dispatched_quantity <= quantity
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON job_work_output TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON job_work_output TO readonly_user;
  END IF;
END $$;

-- One row per jobwork.output_dispatched event: the dispatch_id the caller minted is the projection
-- anchor, so a replay (or a retry that re-mints the idempotency key) collides here instead of
-- silently incrementing dispatched_quantity a second time, and a physical shipment can be traced
-- back to its dispatch_id.
CREATE TABLE IF NOT EXISTS job_work_dispatch (
  dispatch_id          UUID PRIMARY KEY,
  service_order_id     UUID NOT NULL,
  output_id            UUID NOT NULL,
  lot_number           TEXT NOT NULL,
  sku                  TEXT NOT NULL,
  dispatched_quantity  NUMERIC(18,3) NOT NULL,
  uom                  TEXT NOT NULL,
  site_id              UUID NOT NULL,
  dispatched_by        UUID NOT NULL,
  dispatched_at        TIMESTAMPTZ NOT NULL,
  source_event_id      UUID NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_job_work_dispatch_qty_positive CHECK (dispatched_quantity > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_work_dispatch_source_event ON job_work_dispatch (source_event_id);
CREATE INDEX IF NOT EXISTS idx_job_work_dispatch_order ON job_work_dispatch (service_order_id);
CREATE INDEX IF NOT EXISTS idx_job_work_dispatch_output ON job_work_dispatch (output_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_job_work_dispatch_qty_positive'
      AND conrelid = 'job_work_dispatch'::regclass
  ) THEN
    ALTER TABLE job_work_dispatch
      ADD CONSTRAINT chk_job_work_dispatch_qty_positive CHECK (dispatched_quantity > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON job_work_dispatch TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON job_work_dispatch TO readonly_user;
  END IF;
END $$;
