-- Purchase order read model (Story 4.4). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries
-- its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as
-- app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a live database
-- safely.
--
-- Derived state ONLY: rows are rebuildable by replaying purchase_order.* domain events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert. Status vocabulary is the six AC values
-- (draft, pending-approval, approved, rejected, issued, confirmed). The ceiling_value column is
-- required for blanket/contract POs (PO_CEILING_REQUIRED enforced in the seam). released_value
-- tracks cumulative releases against the ceiling (PO_CEILING_EXCEEDED). Payment terms default
-- from the supplier record at draft (Story 4.1 contract).

CREATE TABLE IF NOT EXISTS purchase_order (
  po_id                  UUID PRIMARY KEY,
  po_number_ext          TEXT NOT NULL,
  po_type                TEXT NOT NULL,
  supplier_id            UUID NOT NULL,
  indent_id              UUID NOT NULL,
  site_id                UUID NOT NULL,
  business_stream        TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'draft',
  total_value            NUMERIC(14,2) NOT NULL DEFAULT 0,
  ceiling_value          NUMERIC(14,2),
  released_value         NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency               TEXT NOT NULL DEFAULT 'INR',
  payment_terms          TEXT,
  created_by             UUID NOT NULL,
  approver_actor_id      UUID,
  doa_entry_id           UUID,
  decided_at             TIMESTAMPTZ,
  decided_by             UUID,
  rejection_reason       TEXT,
  issued_at              TIMESTAMPTZ,
  confirmed_at           TIMESTAMPTZ,
  promised_delivery_date DATE,
  correlation_id         UUID,
  source_event_id        UUID NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_po_type CHECK (po_type IN ('standard','blanket','contract')),
  CONSTRAINT chk_po_status CHECK (status IN ('draft','pending-approval','approved','rejected','issued','confirmed')),
  CONSTRAINT chk_po_total_value_non_negative CHECK (total_value >= 0),
  CONSTRAINT chk_po_released_value_non_negative CHECK (released_value >= 0),
  CONSTRAINT chk_po_ceiling_covers_released CHECK (ceiling_value IS NULL OR ceiling_value >= released_value),
  CONSTRAINT chk_po_rejection_reason CHECK (status <> 'rejected' OR (rejection_reason IS NOT NULL AND btrim(rejection_reason) <> ''))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_po_number_ext ON purchase_order (po_number_ext);
CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_order (supplier_id);
CREATE INDEX IF NOT EXISTS idx_po_indent ON purchase_order (indent_id);
CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_order (status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_po_type'
      AND conrelid = 'purchase_order'::regclass
  ) THEN
    ALTER TABLE purchase_order
      ADD CONSTRAINT chk_po_type CHECK (po_type IN ('standard','blanket','contract'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_po_status'
      AND conrelid = 'purchase_order'::regclass
  ) THEN
    ALTER TABLE purchase_order
      ADD CONSTRAINT chk_po_status CHECK (status IN ('draft','pending-approval','approved','rejected','issued','confirmed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_po_total_value_non_negative'
      AND conrelid = 'purchase_order'::regclass
  ) THEN
    ALTER TABLE purchase_order
      ADD CONSTRAINT chk_po_total_value_non_negative CHECK (total_value >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_po_released_value_non_negative'
      AND conrelid = 'purchase_order'::regclass
  ) THEN
    ALTER TABLE purchase_order
      ADD CONSTRAINT chk_po_released_value_non_negative CHECK (released_value >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_po_ceiling_covers_released'
      AND conrelid = 'purchase_order'::regclass
  ) THEN
    ALTER TABLE purchase_order
      ADD CONSTRAINT chk_po_ceiling_covers_released CHECK (ceiling_value IS NULL OR ceiling_value >= released_value);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_po_rejection_reason'
      AND conrelid = 'purchase_order'::regclass
  ) THEN
    ALTER TABLE purchase_order
      ADD CONSTRAINT chk_po_rejection_reason CHECK (status <> 'rejected' OR (rejection_reason IS NOT NULL AND btrim(rejection_reason) <> ''));
  END IF;
END $$;

CREATE SEQUENCE IF NOT EXISTS po_number_seq;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON purchase_order TO app_user;
    GRANT USAGE ON SEQUENCE po_number_seq TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON purchase_order TO readonly_user;
  END IF;
END $$;
