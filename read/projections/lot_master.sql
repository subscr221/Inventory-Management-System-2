-- Lot master read model (Story 2.3). This file is the CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its
-- OWN grants (guarded DO blocks) so a migrate-provisioned database can serve lot-master
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- lot_id is the internal UUID used as the lot_master event stream_id (EventEnvelope.stream_id
-- must remain UUID); lot_number is the unique API-facing identifier. expiry_date is used for
-- FEFO/FIFO selection. quality_hold_status and quality_hold_reason track quality holds.
-- sku is used to link to the item_master.

CREATE TABLE IF NOT EXISTS lot_master (
  lot_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_number           TEXT NOT NULL,
  sku                  TEXT NOT NULL,
  expiry_date          DATE,
  quality_hold_status  TEXT NOT NULL DEFAULT 'none',
  quality_hold_reason  TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_lot_master_lot_number_sku_expiry UNIQUE (lot_number, sku, expiry_date),
  CONSTRAINT chk_lot_master_quality_hold_status CHECK (quality_hold_status IN ('none', 'held'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_lot_master_quality_hold_status'
      AND conrelid = 'lot_master'::regclass
  ) THEN
    ALTER TABLE lot_master
      ADD CONSTRAINT chk_lot_master_quality_hold_status CHECK (quality_hold_status IN ('none', 'held'));
  END IF;
END $$;

-- Index for SKU + expiry lookups (used in FEFO/FIFO selection)
CREATE INDEX IF NOT EXISTS idx_lot_master_sku_expiry ON lot_master (sku, expiry_date);

-- Index for lot_id lookups
CREATE INDEX IF NOT EXISTS idx_lot_master_lot_id ON lot_master (lot_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON lot_master TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON lot_master TO readonly_user;
  END IF;
END $$;