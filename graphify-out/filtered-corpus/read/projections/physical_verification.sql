-- Physical verification read model (Story 2.6). This file is the CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its own
-- grants (guarded DO blocks) so a migrate-provisioned database can serve reads as app_user without
-- depending on deploy/compose/init-db.sql.
--
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent so the file can be re-applied to a live database
-- safely.
--
-- These rows are CARO 2020 clause 3(i) physical-verification evidence consumed by Epic 11
-- (FR-AC-15). physical_verification is the report header (coverage, sign-off, period lock);
-- physical_verification_line is the APPEND-ONLY evidence snapshot taken at completion time - one row
-- per counted (sku, lot) with book vs counted quantity, variance, variance value, and the applied
-- adjustment event reference. Corrections after sign-off or period lock must be NEW events, never
-- updates or deletes of these rows; app_user therefore gets no UPDATE/DELETE grant on the line table.

CREATE TABLE IF NOT EXISTS physical_verification (
  physical_verification_id  UUID PRIMARY KEY,
  location_id               UUID NOT NULL,
  coverage_percentage       NUMERIC(9, 4) NOT NULL DEFAULT 0,
  period_start              DATE,
  period_end                DATE,
  business_date             DATE,
  count_refs                UUID[] NOT NULL DEFAULT '{}',
  completed_by_actor_id     UUID,
  management_signoff_actor_id UUID,
  signed_off_at             TIMESTAMPTZ,
  period_locked             BOOLEAN NOT NULL DEFAULT false,
  source_event_id           UUID,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_physical_verification_location ON physical_verification (location_id);

CREATE TABLE IF NOT EXISTS physical_verification_line (
  pv_line_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  physical_verification_id  UUID NOT NULL,
  cycle_count_id            UUID NOT NULL,
  count_date                DATE,
  sku                       TEXT NOT NULL,
  lot_id                    TEXT,
  stock_class               TEXT NOT NULL DEFAULT 'owned',
  book_quantity             NUMERIC(18, 6) NOT NULL DEFAULT 0,
  counted_quantity          NUMERIC(18, 6) NOT NULL DEFAULT 0,
  variance_quantity         NUMERIC(18, 6) NOT NULL DEFAULT 0,
  variance_value            NUMERIC(20, 6) NOT NULL DEFAULT 0,
  adjustment_event_ref      UUID,
  counter_actor_id          UUID,
  approver_actor_id         UUID,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_physical_verification_line_pv ON physical_verification_line (physical_verification_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON physical_verification TO app_user;
    GRANT INSERT, SELECT ON physical_verification_line TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON physical_verification TO readonly_user;
    GRANT SELECT ON physical_verification_line TO readonly_user;
  END IF;
END $$;
