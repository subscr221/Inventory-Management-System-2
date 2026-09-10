-- ERP / legacy stock-balance snapshot projection (Story 13.1, FR-DM-01 AC 2). This file is the
-- CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks).
--
-- Reference data ONLY (INT-ERP-01, Binding Decision 1): like erp_purchase_order and unlike every
-- event-sourced projection, this table is NOT event-sourced. It is populated by the inbound ERP
-- sync adapter (src/adapters/erp/sync.ts, record type `stock_balances`) via direct SQL upsert; the
-- ERP or legacy system remains the master of its own balance and nothing on this platform writes
-- back. The grain is the source's own external identity: (source_system, site_code_ext,
-- location_code, sku, lot_number_ext, serial_number_ext), NULLS NOT DISTINCT so an un-lotted
-- source row is one grain, not a new row per sync. A snapshot is replaced per grain, never
-- soft-closed: it is a point-in-time extract taken at the physical-count cut-off and `snapshot_at`
-- on each row is the freshness fact (the 15-minute staleness alarm does not attach to this key).
-- `site_id` / `location_id` are the platform's resolution of the external codes and stay NULL when
-- the code does not resolve; such a row is ALSO routed to integration_exception (UNKNOWN_REFERENCE)
-- and surfaces on the variance report as `unmapped_source_row`.

CREATE TABLE IF NOT EXISTS erp_stock_balance (
  balance_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system     TEXT NOT NULL,
  site_code_ext     TEXT NOT NULL,
  site_id           UUID,
  location_code     TEXT NOT NULL,
  location_id       UUID,
  sku               TEXT NOT NULL,
  lot_number_ext    TEXT,
  serial_number_ext TEXT,
  quantity          NUMERIC(18, 6) NOT NULL,
  unit_cost         NUMERIC(18, 6),
  snapshot_at       TIMESTAMPTZ NOT NULL,
  last_synced_at    TIMESTAMPTZ NOT NULL,
  source_snapshot   JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_erp_stock_balance_grain UNIQUE NULLS NOT DISTINCT (source_system, site_code_ext, location_code, sku, lot_number_ext, serial_number_ext),
  CONSTRAINT chk_erp_stock_balance_source_system CHECK (source_system IN ('ERP', 'LEGACY'))
);

CREATE INDEX IF NOT EXISTS idx_erp_stock_balance_site ON erp_stock_balance (site_id, source_system, sku);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_erp_stock_balance_source_system'
      AND conrelid = 'erp_stock_balance'::regclass
  ) THEN
    ALTER TABLE erp_stock_balance
      ADD CONSTRAINT chk_erp_stock_balance_source_system CHECK (source_system IN ('ERP', 'LEGACY'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON erp_stock_balance TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON erp_stock_balance TO readonly_user;
  END IF;
END $$;
