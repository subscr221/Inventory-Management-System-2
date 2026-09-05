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
-- confirm (Story 9.1 BSD-6, gated on has_contractual_offcut by Story 9.4); Story 9.6 attaches the
-- settlement and billing behavior to it, so it is no longer an inert capture.

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

-- Story 9.6 Task 0 (Binding decision 16): the CONTRACTED offcut rate lives on the order, captured at
-- confirmation beside offcut_election and mandatory whenever has_contractual_offcut is true. It is
-- money per unit of the customer material in offcut_currency (which must equal the price-basis
-- currency), NOT the service price basis. Guarded additive columns, the reference_ext precedent.
ALTER TABLE service_order ADD COLUMN IF NOT EXISTS offcut_rate NUMERIC(18,4);
ALTER TABLE service_order ADD COLUMN IF NOT EXISTS offcut_currency TEXT;
-- Story 9.6 Task 6.4 (Binding decisions 9 and 15): "invoiced" and "offcut settled" are column pairs,
-- never a fifth status - the four-state machine and the reserved closure seam stay untouched.
-- invoiced_at/invoiced_feed_id are stamped only by jobwork.billing_feed_acknowledged;
-- offcut_settled_at/offcut_settled_by by the custody.offcut_recorded posting that declares
-- settles_offcut, after which no further offcut may post and billing may generate.
ALTER TABLE service_order ADD COLUMN IF NOT EXISTS invoiced_at TIMESTAMPTZ;
ALTER TABLE service_order ADD COLUMN IF NOT EXISTS invoiced_feed_id UUID;
ALTER TABLE service_order ADD COLUMN IF NOT EXISTS offcut_settled_at TIMESTAMPTZ;
ALTER TABLE service_order ADD COLUMN IF NOT EXISTS offcut_settled_by UUID;

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

-- Story 9.6 code review 2026-09-05: the column PAIRS this file's comments describe are now enforced
-- in the database, not only at the confirm seam and the appliers. offcut_rate and offcut_currency
-- travel together and the rate is money, so it must be strictly positive; invoiced_at is meaningless
-- without the feed that caused it; offcut_settled_at without offcut_settled_by is an unattributed
-- settlement that gates billing. DROP-then-ADD, the bom_line precedent, so a later widening is not
-- silently skipped on an already-migrated database.
DO $$
BEGIN
  ALTER TABLE service_order DROP CONSTRAINT IF EXISTS chk_service_order_offcut_rate_pair;
  ALTER TABLE service_order
    ADD CONSTRAINT chk_service_order_offcut_rate_pair CHECK (
      (offcut_rate IS NULL) = (offcut_currency IS NULL)
      AND (offcut_rate IS NULL OR offcut_rate > 0)
    );
  ALTER TABLE service_order DROP CONSTRAINT IF EXISTS chk_service_order_invoiced_pair;
  ALTER TABLE service_order
    ADD CONSTRAINT chk_service_order_invoiced_pair CHECK (
      (invoiced_at IS NULL) = (invoiced_feed_id IS NULL)
    );
  ALTER TABLE service_order DROP CONSTRAINT IF EXISTS chk_service_order_offcut_settled_pair;
  ALTER TABLE service_order
    ADD CONSTRAINT chk_service_order_offcut_settled_pair CHECK (
      (offcut_settled_at IS NULL) = (offcut_settled_by IS NULL)
    );
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
