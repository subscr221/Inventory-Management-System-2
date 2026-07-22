-- ERP open sales-order (dispatch-demand) reference projection (Story 2.9). This file is the
-- CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks).
--
-- Reference data ONLY (INT-ERP-01): NOT event-sourced. Populated by the inbound ERP sync adapter
-- (src/adapters/erp/sync.ts) via direct SQL upsert; ERP remains master for sales-order lifecycle.
-- This is the Phase-1 outbound-demand source referenced by pick, dispatch, and IRN flows (Epics 3,
-- 9, 11). Grain is (so_number_ext, line_no). Site identity uses two namespaces deliberately:
-- ship_from_site_code_ext preserves the ERP/API code ('site-A') used by ?site=site-A, while
-- ship_from_site_id resolves to the internal location_register.location_id UUID used by RBAC - the
-- adapter resolves the code through getLocationByCode and requires an active level = 'site' row; an
-- unknown or non-site code is a malformed record routed to the integration exception queue. Never
-- compare a role-assignment UUID directly with the external site code. source_system is server-set
-- to 'ERP'; last_synced_at is server-set to now(). Close/removal is soft (status = 'closed').

CREATE TABLE IF NOT EXISTS erp_sales_order (
  so_number_ext           TEXT NOT NULL,
  line_no                 INTEGER NOT NULL,
  sku                     TEXT NOT NULL,
  quantity                NUMERIC(18, 3) NOT NULL,
  required_by             DATE,
  ship_to_ext             TEXT,
  ship_from_site_id       UUID NOT NULL,
  ship_from_site_code_ext TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'open',
  source_system           TEXT NOT NULL DEFAULT 'ERP',
  last_synced_at          TIMESTAMPTZ NOT NULL,
  source_snapshot         JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (so_number_ext, line_no),
  CONSTRAINT chk_erp_so_quantity_non_negative CHECK (quantity >= 0),
  CONSTRAINT chk_erp_sales_order_status CHECK (status IN ('open', 'closed')),
  CONSTRAINT chk_erp_sales_order_source_system CHECK (source_system = 'ERP')
);

CREATE INDEX IF NOT EXISTS idx_erp_sales_order_site_status ON erp_sales_order (ship_from_site_id, status);
CREATE INDEX IF NOT EXISTS idx_erp_sales_order_site_code_status ON erp_sales_order (ship_from_site_code_ext, status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_erp_so_quantity_non_negative'
      AND conrelid = 'erp_sales_order'::regclass
  ) THEN
    ALTER TABLE erp_sales_order
      ADD CONSTRAINT chk_erp_so_quantity_non_negative CHECK (quantity >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_erp_sales_order_status'
      AND conrelid = 'erp_sales_order'::regclass
  ) THEN
    ALTER TABLE erp_sales_order
      ADD CONSTRAINT chk_erp_sales_order_status CHECK (status IN ('open', 'closed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_erp_sales_order_source_system'
      AND conrelid = 'erp_sales_order'::regclass
  ) THEN
    ALTER TABLE erp_sales_order
      ADD CONSTRAINT chk_erp_sales_order_source_system CHECK (source_system = 'ERP');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON erp_sales_order TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON erp_sales_order TO readonly_user;
  END IF;
END $$;
