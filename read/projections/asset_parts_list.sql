-- Asset parts list, the maintenance-owned equipment BOM (Story 7.4, FR-M-07). This file is the
-- CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.asset_part_listed domain
-- events; mutation happens exclusively through persistEvent, which applies this projection inside
-- the SAME transaction as the domain_events insert.
--
-- This is NOT the Epic 5 manufacturing BOM and must never be confused with it. AD-4 makes the BOM
-- module the system of record for manufacturing structure, with a revision lifecycle, release
-- gates, immutability rules and an outbound-only ERP contract. An equipment parts list has none of
-- those: it answers exactly two questions, "which spares does this asset take" (grain lookup by
-- asset_id) and "which assets take this spare" (the reverse where-used read served by
-- idx_asset_parts_list_sku). One flat table, one row per (asset_id, sku), no header and no
-- revision. Amending or removing a line is out of scope for Phase 1 (see deferred-work.md).

CREATE TABLE IF NOT EXISTS asset_parts_list (
  part_line_id UUID PRIMARY KEY,
  asset_id     UUID NOT NULL,
  sku          TEXT NOT NULL,
  quantity_per NUMERIC(18, 6) NOT NULL,
  position_ref TEXT,
  created_by   UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_asset_parts_list_grain UNIQUE (asset_id, sku),
  CONSTRAINT chk_asset_parts_list_quantity_positive CHECK (quantity_per > 0)
);

CREATE INDEX IF NOT EXISTS idx_asset_parts_list_sku ON asset_parts_list (sku);
CREATE INDEX IF NOT EXISTS idx_asset_parts_list_asset ON asset_parts_list (asset_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_asset_parts_list_grain'
      AND conrelid = 'asset_parts_list'::regclass
  ) THEN
    ALTER TABLE asset_parts_list
      ADD CONSTRAINT uq_asset_parts_list_grain UNIQUE (asset_id, sku);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_asset_parts_list_quantity_positive'
      AND conrelid = 'asset_parts_list'::regclass
  ) THEN
    ALTER TABLE asset_parts_list
      ADD CONSTRAINT chk_asset_parts_list_quantity_positive CHECK (quantity_per > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON asset_parts_list TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON asset_parts_list TO readonly_user;
  END IF;
END $$;
