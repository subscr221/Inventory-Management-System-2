-- Maintenance spare reservation (Story 7.4, FR-M-07, FR-M-08). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying the maintenance.spare_reserved /
-- spare_issued / spare_returned / spare_reservation_cancelled domain events; mutation happens
-- exclusively through persistEvent, which applies this projection inside the SAME transaction as
-- the domain_events insert.
--
-- The AUTHORITATIVE reservation quantity lives in stock_balance.allocated (Epic 2), not here.
-- This table records the maintenance-side facts only: which work order, which asset, who, when,
-- and when the spare is due back. A parallel authoritative quantity here would double-count
-- against the generated stock_balance.available = on_hand - allocated column.
--
-- return_due_date is the FR-M-08 three-working-day clock, computed ONCE inside the issue applier
-- via addBusinessDays (src/lib/business-days.ts) and frozen: recomputing it on read would move a
-- deadline the storekeeper was already given. idx_maintenance_spare_reservation_due is partial on
-- the two open states so runOverdueReturnSweep narrows its scope in SQL rather than in a JS
-- filter, keeping its counters honest about what was actually evaluated.

CREATE TABLE IF NOT EXISTS maintenance_spare_reservation (
  reservation_id      UUID PRIMARY KEY,
  work_order_id       UUID NOT NULL,
  asset_id            UUID NOT NULL,
  sku                 TEXT NOT NULL,
  location_id         UUID NOT NULL,
  lot_id              TEXT,
  quantity            NUMERIC(18, 6) NOT NULL,
  quantity_returned   NUMERIC(18, 6) NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'reserved',
  reserved_at         TIMESTAMPTZ NOT NULL,
  issued_at           TIMESTAMPTZ,
  return_due_date     DATE,
  returned_at         TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  cancellation_reason TEXT,
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_maintenance_spare_reservation_status CHECK (status IN ('reserved', 'issued', 'partially_returned', 'returned', 'cancelled')),
  CONSTRAINT chk_maintenance_spare_reservation_quantity_positive CHECK (quantity > 0),
  CONSTRAINT chk_maintenance_spare_reservation_returned_non_negative CHECK (quantity_returned >= 0),
  CONSTRAINT chk_maintenance_spare_reservation_returned_bound CHECK (quantity_returned <= quantity),
  CONSTRAINT chk_maintenance_spare_reservation_issue_fields CHECK (
    status IN ('reserved', 'cancelled') OR (issued_at IS NOT NULL AND return_due_date IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_maintenance_spare_reservation_work_order ON maintenance_spare_reservation (work_order_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_spare_reservation_grain ON maintenance_spare_reservation (sku, location_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_spare_reservation_due ON maintenance_spare_reservation (return_due_date) WHERE status IN ('issued', 'partially_returned');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_reservation_status'
      AND conrelid = 'maintenance_spare_reservation'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_reservation
      ADD CONSTRAINT chk_maintenance_spare_reservation_status CHECK (status IN ('reserved', 'issued', 'partially_returned', 'returned', 'cancelled'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_reservation_quantity_positive'
      AND conrelid = 'maintenance_spare_reservation'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_reservation
      ADD CONSTRAINT chk_maintenance_spare_reservation_quantity_positive CHECK (quantity > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_reservation_returned_non_negative'
      AND conrelid = 'maintenance_spare_reservation'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_reservation
      ADD CONSTRAINT chk_maintenance_spare_reservation_returned_non_negative CHECK (quantity_returned >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_reservation_returned_bound'
      AND conrelid = 'maintenance_spare_reservation'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_reservation
      ADD CONSTRAINT chk_maintenance_spare_reservation_returned_bound CHECK (quantity_returned <= quantity);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_reservation_issue_fields'
      AND conrelid = 'maintenance_spare_reservation'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_reservation
      ADD CONSTRAINT chk_maintenance_spare_reservation_issue_fields CHECK (
        status IN ('reserved', 'cancelled') OR (issued_at IS NOT NULL AND return_due_date IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON maintenance_spare_reservation TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_spare_reservation TO readonly_user;
  END IF;
END $$;
