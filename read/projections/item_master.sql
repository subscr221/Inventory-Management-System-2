-- Item master read model (Story 2.1). This file is the CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its
-- OWN grants (guarded DO blocks) so a migrate-provisioned database can serve item-master
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- item_id is the internal UUID used as the item_master event stream_id (EventEnvelope.stream_id
-- must remain UUID); sku is the unique API-facing identifier. valuation_method deliberately has
-- NO 'lifo' option (Ind AS 2 prohibits it). business_stream is validated in code against the
-- Story 1.5 business_streams vocabulary - no second enum or CHECK constraint here.

CREATE TABLE IF NOT EXISTS item_master (
  item_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                  TEXT NOT NULL,
  uom                  TEXT NOT NULL,
  lot_controlled       BOOLEAN NOT NULL DEFAULT false,
  serial_controlled    BOOLEAN NOT NULL DEFAULT false,
  hazmat               BOOLEAN NOT NULL DEFAULT false,
  quarantine_required  BOOLEAN NOT NULL DEFAULT false,
  bis_licence_required BOOLEAN NOT NULL DEFAULT false,
  valuation_method     TEXT NOT NULL,
  business_stream      TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_item_master_sku UNIQUE (sku),
  CONSTRAINT chk_item_master_valuation_method CHECK (valuation_method IN ('fifo', 'weighted_average', 'specific_identification')),
  CONSTRAINT chk_item_master_status CHECK (status IN ('active', 'inactive'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_item_master_valuation_method'
      AND conrelid = 'item_master'::regclass
  ) THEN
    ALTER TABLE item_master
      ADD CONSTRAINT chk_item_master_valuation_method CHECK (valuation_method IN ('fifo', 'weighted_average', 'specific_identification'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_item_master_status'
      AND conrelid = 'item_master'::regclass
  ) THEN
    ALTER TABLE item_master
      ADD CONSTRAINT chk_item_master_status CHECK (status IN ('active', 'inactive'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON item_master TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON item_master TO readonly_user;
  END IF;
END $$;
