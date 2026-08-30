-- Production scrap declaration read model (Story 6.3, FR-MO-08, AD-5). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying production_order.scrap_declared events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert.
--
-- A scrap declaration relieves WIP and moves NO stock (Story 6.3 Binding Decision 10): it creates
-- no lot, posts no stock row and never drives a balance negative. The physical scrap intake
-- (FR-SC) is Phase 2 (Epic 16); this row is the AD-10 source document for it, and it is also the
-- expected-versus-actual reconciliation input Story 6.4 (FR-B-08) reads.
--
-- The table is APPEND-ONLY (app_user holds INSERT/SELECT only, the production_wip_ledger
-- precedent). relieved_value is the WIP value actually drained by this declaration, settled in SQL
-- NUMERIC at the source postings' issued cost, never at today's average.
--
-- Code review 2026-08-31: uq_production_scrap_declaration_event is the replay and rebuild guard.
-- scrap_id is server-minted per call, so the primary key alone cannot make a second application of
-- the SAME domain event collide - which left the banner's "rebuildable by replaying" claim false
-- for this table while its sibling production_completion was already defended by
-- uq_production_completion_grain. One scrap_declared event yields exactly one declaration row, so
-- source_event_id IS the grain.

CREATE TABLE IF NOT EXISTS production_scrap_declaration (
  scrap_id             UUID PRIMARY KEY,
  production_order_id  UUID NOT NULL,
  scrap_quantity       NUMERIC(18,6) NOT NULL,
  uom                  TEXT NOT NULL,
  reason_code          TEXT NOT NULL,
  relieved_value       NUMERIC(14,3) NOT NULL,
  business_date        DATE NOT NULL,
  declared_by          UUID NOT NULL,
  declared_at          TIMESTAMPTZ NOT NULL,
  source_event_id      UUID NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_production_scrap_quantity_positive CHECK (scrap_quantity > 0),
  CONSTRAINT chk_production_scrap_relieved_non_negative CHECK (relieved_value >= 0),
  CONSTRAINT chk_production_scrap_reason_code_present CHECK (btrim(reason_code) <> ''),
  CONSTRAINT uq_production_scrap_declaration_event UNIQUE (source_event_id)
);

CREATE INDEX IF NOT EXISTS idx_production_scrap_declaration_order ON production_scrap_declaration (production_order_id);
CREATE INDEX IF NOT EXISTS idx_production_scrap_declaration_business_date ON production_scrap_declaration (business_date);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_scrap_quantity_positive'
      AND conrelid = 'production_scrap_declaration'::regclass
  ) THEN
    ALTER TABLE production_scrap_declaration
      ADD CONSTRAINT chk_production_scrap_quantity_positive CHECK (scrap_quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_scrap_relieved_non_negative'
      AND conrelid = 'production_scrap_declaration'::regclass
  ) THEN
    ALTER TABLE production_scrap_declaration
      ADD CONSTRAINT chk_production_scrap_relieved_non_negative CHECK (relieved_value >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_scrap_reason_code_present'
      AND conrelid = 'production_scrap_declaration'::regclass
  ) THEN
    ALTER TABLE production_scrap_declaration
      ADD CONSTRAINT chk_production_scrap_reason_code_present CHECK (btrim(reason_code) <> '');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_production_scrap_declaration_event'
      AND conrelid = 'production_scrap_declaration'::regclass
  ) THEN
    ALTER TABLE production_scrap_declaration
      ADD CONSTRAINT uq_production_scrap_declaration_event UNIQUE (source_event_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON production_scrap_declaration TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON production_scrap_declaration TO readonly_user;
  END IF;
END $$;
