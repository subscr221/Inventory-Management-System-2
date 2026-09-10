-- Opening-stock staging rows (Story 13.1, FR-DM-01 AC 1 / AC 5 / AC 6). This file is the
-- CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks). deploy/compose/
-- init-db.sql duplicates this content for first-boot container init - change both files together.
-- Every statement is idempotent (IF NOT EXISTS / guarded DO blocks).
--
-- The staging load is its OWN projection, not stock_balance (Binding Decision 2). One row per
-- accepted import line, written by the `migration.opening_stock.loaded` applier. The live ledger
-- (stock_balance, lot_master, serial_master, inventory_valuation, lot_trace) is written exactly
-- once, by the `migration.stage.promoted` applier, which flips every accepted row to 'posted'.
--
-- `status` lifecycle: accepted (staging) -> superseded (a correction-mode row replaced it, see
-- superseded_by_row_id) -> posted (promotion posted it to the ledger). The partial unique index
-- uq_migration_os_row_live is the last line of defence against two LIVE rows on one physical
-- grain (site, bin, sku, lot, serial); NULLS NOT DISTINCT so two un-lotted rows on one bin+sku
-- collide too. `unit_cost` is populated only for stock_class 'owned' (Binding Decision 6); for
-- every other class the declared cell lands in declared_unit_cost and unit_cost stays NULL.
-- `pv_ref_ext` / `pv_line_ref_ext` are the physical-verification source references (Binding
-- Decision 9); `content_hash` is the SHA-256 of the normalised cells and is the row's idempotency
-- identity (Binding Decision 5).

CREATE TABLE IF NOT EXISTS migration_opening_stock_row (
  row_id               UUID PRIMARY KEY,
  load_id              UUID NOT NULL,
  site_id              UUID NOT NULL,
  location_id          UUID NOT NULL,
  location_code        TEXT NOT NULL,
  sku                  TEXT NOT NULL,
  lot_number           TEXT,
  serial_number        TEXT,
  stock_class          TEXT NOT NULL,
  quantity             NUMERIC(18, 6) NOT NULL,
  uom                  TEXT NOT NULL,
  unit_cost            NUMERIC(18, 6),
  declared_unit_cost   NUMERIC(18, 6),
  expiry_date          DATE,
  counted_on           DATE NOT NULL,
  pv_ref_ext           TEXT NOT NULL,
  pv_line_ref_ext      TEXT,
  line_no              INTEGER NOT NULL,
  content_hash         TEXT NOT NULL,
  status               TEXT NOT NULL,
  superseded_by_row_id UUID,
  posted_event_id      UUID,
  source_event_id      UUID NOT NULL,
  source_event_type    TEXT NOT NULL,
  occurred_at          TIMESTAMPTZ NOT NULL,
  business_date        DATE NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_migration_os_row_quantity_positive CHECK (quantity > 0),
  CONSTRAINT chk_migration_os_row_status CHECK (status IN ('accepted', 'superseded', 'posted'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_migration_os_row_live ON migration_opening_stock_row (site_id, location_id, sku, lot_number, serial_number) NULLS NOT DISTINCT WHERE status IN ('accepted', 'posted');
CREATE INDEX IF NOT EXISTS idx_migration_os_row_sku ON migration_opening_stock_row (site_id, sku, lot_number);
CREATE INDEX IF NOT EXISTS idx_migration_os_row_load ON migration_opening_stock_row (load_id, line_no);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_migration_os_row_quantity_positive'
      AND conrelid = 'migration_opening_stock_row'::regclass
  ) THEN
    ALTER TABLE migration_opening_stock_row
      ADD CONSTRAINT chk_migration_os_row_quantity_positive CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_migration_os_row_status'
      AND conrelid = 'migration_opening_stock_row'::regclass
  ) THEN
    ALTER TABLE migration_opening_stock_row
      ADD CONSTRAINT chk_migration_os_row_status CHECK (status IN ('accepted', 'superseded', 'posted'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON migration_opening_stock_row TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON migration_opening_stock_row TO readonly_user;
  END IF;
END $$;
