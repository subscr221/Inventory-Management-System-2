-- Maintenance spare alert (Story 7.4, FR-M-08, FR-M-09). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying the
-- maintenance.critical_spare_breach_flagged and maintenance.spare_return_overdue_flagged domain
-- events; mutation happens exclusively through persistEvent, which applies this projection inside
-- the SAME transaction as the domain_events insert.
--
-- uq_maintenance_spare_alert_day IS the "same-day" contract in FR-M-09: one alert per grain per
-- business_date, so re-running the POST-triggered scan on the same day is a no-op rather than a
-- duplicate. NULLS NOT DISTINCT is required because reservation_id is null on a min_breach row
-- and a plain UNIQUE would treat every such row as distinct, defeating the guard entirely.
-- A grain that recovers produces no row and no retraction event: the ABSENCE of an alert on a
-- later business_date is the recovery signal.

CREATE TABLE IF NOT EXISTS maintenance_spare_alert (
  alert_id         UUID PRIMARY KEY,
  alert_type       TEXT NOT NULL,
  sku              TEXT NOT NULL,
  location_id      UUID NOT NULL,
  reservation_id   UUID,
  on_hand_at_check NUMERIC(18, 6),
  min_level        NUMERIC(18, 6),
  return_due_date  DATE,
  business_date    DATE NOT NULL,
  flagged_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_maintenance_spare_alert_type CHECK (alert_type IN ('min_breach', 'return_overdue')),
  CONSTRAINT uq_maintenance_spare_alert_day UNIQUE NULLS NOT DISTINCT (alert_type, sku, location_id, reservation_id, business_date),
  CONSTRAINT chk_maintenance_spare_alert_breach_fields CHECK (
    alert_type <> 'min_breach' OR (on_hand_at_check IS NOT NULL AND min_level IS NOT NULL)
  ),
  CONSTRAINT chk_maintenance_spare_alert_overdue_fields CHECK (
    alert_type <> 'return_overdue' OR (reservation_id IS NOT NULL AND return_due_date IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_maintenance_spare_alert_business_date ON maintenance_spare_alert (business_date);
CREATE INDEX IF NOT EXISTS idx_maintenance_spare_alert_grain ON maintenance_spare_alert (sku, location_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_alert_type'
      AND conrelid = 'maintenance_spare_alert'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_alert
      ADD CONSTRAINT chk_maintenance_spare_alert_type CHECK (alert_type IN ('min_breach', 'return_overdue'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_maintenance_spare_alert_day'
      AND conrelid = 'maintenance_spare_alert'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_alert
      ADD CONSTRAINT uq_maintenance_spare_alert_day UNIQUE NULLS NOT DISTINCT (alert_type, sku, location_id, reservation_id, business_date);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_alert_breach_fields'
      AND conrelid = 'maintenance_spare_alert'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_alert
      ADD CONSTRAINT chk_maintenance_spare_alert_breach_fields CHECK (
        alert_type <> 'min_breach' OR (on_hand_at_check IS NOT NULL AND min_level IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_maintenance_spare_alert_overdue_fields'
      AND conrelid = 'maintenance_spare_alert'::regclass
  ) THEN
    ALTER TABLE maintenance_spare_alert
      ADD CONSTRAINT chk_maintenance_spare_alert_overdue_fields CHECK (
        alert_type <> 'return_overdue' OR (reservation_id IS NOT NULL AND return_due_date IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON maintenance_spare_alert TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON maintenance_spare_alert TO readonly_user;
  END IF;
END $$;
