-- Job-work service order read model (Story 9.1). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying jobwork.* domain events; mutation happens
-- exclusively through persistEvent, which applies this projection inside the SAME transaction as
-- the domain_events insert. Status vocabulary is the four FR-JW-02 states
-- (draft, confirmed, in_process, closed); the in_process transition is fired by Story 9.2's first
-- customer-material receipt and closed only by the Story 9.5 closure gate. There is no customer
-- master table in this system (Story 9.1 BSD-4): the order carries a governed
-- customer_party_code short code plus customer_name. price_basis is JSONB
-- ({basis_type, rate, currency}); basis_type vocabulary is enforced in the seam, not a CHECK,
-- because FR-JW-01 does not close the vocabulary. offcut_election is captured optionally at
-- confirm for Story 9.4 (BSD-6), no behavior attached in 9.1.

CREATE TABLE IF NOT EXISTS service_order (
  service_order_id       UUID PRIMARY KEY,
  order_number_ext       TEXT NOT NULL,
  customer_party_code    TEXT NOT NULL,
  customer_name          TEXT NOT NULL,
  spec_reference_ext     TEXT,
  promised_start_date    DATE,
  promised_delivery_date DATE,
  price_basis            JSONB,
  kit_bom_id             UUID,
  status                 TEXT NOT NULL DEFAULT 'draft',
  offcut_election        TEXT,
  has_contractual_offcut BOOLEAN NOT NULL DEFAULT false,
  site_id                UUID NOT NULL,
  business_stream        TEXT NOT NULL,
  created_by             UUID NOT NULL,
  confirmed_at           TIMESTAMPTZ,
  confirmed_by           UUID,
  in_process_at          TIMESTAMPTZ,
  closed_at              TIMESTAMPTZ,
  closed_by              UUID,
  correlation_id         UUID,
  source_event_id        UUID NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_service_order_status CHECK (status IN ('draft','confirmed','in_process','closed')),
  CONSTRAINT chk_service_order_offcut_election CHECK (
    offcut_election IS NULL
    OR offcut_election IN ('return','retain_and_buy','retain_free')
  ),
  CONSTRAINT chk_service_order_customer_party_code CHECK (customer_party_code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$')
);

-- Story 9.4 (FR-JW-09/10): additive column for a database that ran CREATE TABLE before this column
-- existed. Guarded so a live re-apply is safe.
ALTER TABLE service_order ADD COLUMN IF NOT EXISTS has_contractual_offcut BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_order_number_site ON service_order (order_number_ext, site_id);
CREATE INDEX IF NOT EXISTS idx_service_order_status ON service_order (status);
CREATE INDEX IF NOT EXISTS idx_service_order_customer ON service_order (customer_party_code);
CREATE INDEX IF NOT EXISTS idx_service_order_site ON service_order (site_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_service_order_status'
      AND conrelid = 'service_order'::regclass
  ) THEN
    ALTER TABLE service_order
      ADD CONSTRAINT chk_service_order_status CHECK (status IN ('draft','confirmed','in_process','closed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_service_order_offcut_election'
      AND conrelid = 'service_order'::regclass
  ) THEN
    ALTER TABLE service_order
      ADD CONSTRAINT chk_service_order_offcut_election CHECK (
        offcut_election IS NULL
        OR offcut_election IN ('return','retain_and_buy','retain_free')
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_service_order_customer_party_code'
      AND conrelid = 'service_order'::regclass
  ) THEN
    ALTER TABLE service_order
      ADD CONSTRAINT chk_service_order_customer_party_code CHECK (customer_party_code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$');
  END IF;
END $$;

CREATE SEQUENCE IF NOT EXISTS service_order_number_seq;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON service_order TO app_user;
    GRANT USAGE ON SEQUENCE service_order_number_seq TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON service_order TO readonly_user;
  END IF;
END $$;
