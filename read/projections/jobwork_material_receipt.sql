-- Job-work customer-material receipt read model (Story 9.2). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying jobwork.material_received domain events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the
-- SAME transaction as the domain_events insert (and, for the GRN path, the same transaction as
-- the grn_line and stock_balance writes). One GRN line yields exactly one custody receipt row
-- (uq_jobwork_receipt_grn_line). service_order_id is FK-shaped, not an FK: projections are
-- rebuildable independently (the Story 9.1 BSD-8 idiom). challan_date is the IST business date
-- the Story 9.5 Rule 45 return clock counts from. variance_qty is SIGNED (received - challan);
-- variance_flagged records whether its absolute value exceeded the configured receipt tolerance
-- (JOBWORK_RECEIPT_TOLERANCE_PCT) at receipt time, attributed to received_by.

CREATE TABLE IF NOT EXISTS jobwork_material_receipt (
  receipt_id         UUID PRIMARY KEY,
  service_order_id   UUID NOT NULL,
  grn_line_id        UUID NOT NULL,
  challan_number_ext TEXT NOT NULL,
  challan_date       DATE NOT NULL,
  sku                TEXT NOT NULL,
  lot_id             TEXT,
  received_qty       NUMERIC(18,3) NOT NULL,
  challan_qty        NUMERIC(18,3) NOT NULL,
  uom                TEXT NOT NULL,
  variance_qty       NUMERIC(18,3) NOT NULL,
  variance_flagged   BOOLEAN NOT NULL DEFAULT false,
  received_by        UUID NOT NULL,
  site_id            UUID NOT NULL,
  correlation_id     UUID,
  source_event_id    UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_jobwork_receipt_received_positive CHECK (received_qty > 0),
  CONSTRAINT chk_jobwork_receipt_challan_positive CHECK (challan_qty > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_jobwork_receipt_grn_line ON jobwork_material_receipt (grn_line_id);
CREATE INDEX IF NOT EXISTS idx_jobwork_receipt_order ON jobwork_material_receipt (service_order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jobwork_receipt_site ON jobwork_material_receipt (site_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_jobwork_receipt_received_positive'
      AND conrelid = 'jobwork_material_receipt'::regclass
  ) THEN
    ALTER TABLE jobwork_material_receipt
      ADD CONSTRAINT chk_jobwork_receipt_received_positive CHECK (received_qty > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_jobwork_receipt_challan_positive'
      AND conrelid = 'jobwork_material_receipt'::regclass
  ) THEN
    ALTER TABLE jobwork_material_receipt
      ADD CONSTRAINT chk_jobwork_receipt_challan_positive CHECK (challan_qty > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON jobwork_material_receipt TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON jobwork_material_receipt TO readonly_user;
  END IF;
END $$;
