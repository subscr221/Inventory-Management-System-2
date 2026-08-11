-- ECO stock disposition read model (Story 5.3). This file is the CANONICAL definition.
-- See bom.sql for the canonical comment about source, grants, and idempotency.
--
-- One decision per affected on-hand lot of the superseded revision's parent SKU (AC 5): use_up,
-- scrap, or rework. Keyed on (eco_id, lot_id, location_id) so a corrected decision replaces
-- rather than duplicates (upsert, never a second row for the same lot).

CREATE TABLE IF NOT EXISTS eco_stock_disposition (
  disposition_id      UUID PRIMARY KEY,
  eco_id               UUID NOT NULL,
  lot_id               TEXT NOT NULL,
  sku                  TEXT NOT NULL,
  location_id          UUID NOT NULL,
  on_hand_qty          NUMERIC(18,6) NOT NULL,
  disposition          TEXT NOT NULL,
  rework_reference     TEXT,
  notes                TEXT,
  decided_at           TIMESTAMPTZ NOT NULL,
  decided_by           UUID NOT NULL,
  source_event_id      UUID NOT NULL,
  CONSTRAINT chk_eco_disposition CHECK (disposition IN ('use_up','scrap','rework')),
  CONSTRAINT chk_eco_disposition_rework_ref CHECK (
    (disposition = 'rework' AND rework_reference IS NOT NULL AND btrim(rework_reference) <> '') OR
    (disposition <> 'rework' AND rework_reference IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_eco_disposition_lot ON eco_stock_disposition (eco_id, lot_id, location_id);
CREATE INDEX IF NOT EXISTS idx_eco_disposition_eco_id ON eco_stock_disposition (eco_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_eco_disposition'
      AND conrelid = 'eco_stock_disposition'::regclass
  ) THEN
    ALTER TABLE eco_stock_disposition
      ADD CONSTRAINT chk_eco_disposition CHECK (disposition IN ('use_up','scrap','rework'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_eco_disposition_rework_ref'
      AND conrelid = 'eco_stock_disposition'::regclass
  ) THEN
    ALTER TABLE eco_stock_disposition
      ADD CONSTRAINT chk_eco_disposition_rework_ref CHECK (
        (disposition = 'rework' AND rework_reference IS NOT NULL AND btrim(rework_reference) <> '') OR
        (disposition <> 'rework' AND rework_reference IS NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON eco_stock_disposition TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON eco_stock_disposition TO readonly_user;
  END IF;
END $$;
