-- Outbound IRN coverage read model (Story 11.2). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Binding decision 2 (coverage grain): one row per DISPATCH ORDER, recording which invoice covers
-- it. A dispatch order IS an erp_sales_order row at (so_number_ext, line_no) grain, and ERP raises
-- MULTIPLE invoices against the same order (ruled 2026-09-07), so neither so_number_ext nor
-- invoice_number_ext is unique here. dispatch_order_id is the primary key. so_number_ext is
-- server-derived from erp_sales_order and stored for query convenience only, never the key.
-- One dispatch.irn_recorded event writes N coverage rows (one per listed dispatch order), so
-- idx_dispatch_irn_source_event is a PLAIN index, deliberately NOT unique: a UNIQUE on
-- source_event_id would let a single event cover only one dispatch order.
--
-- Code review 2026-09-09 (decisions D1/D2): a GST IRN is the IRP's 64-character hexadecimal
-- SHA-256, so chk_dispatch_irn_present pins that shape (lower-cased by both app doors) instead of
-- "non-blank". The SAME invoice re-recorded with a DIFFERENT IRN (ERP cancel-and-regenerate)
-- SUPERSEDES the stored IRN in place - the only UPDATE path, hence the UPDATE grant; a DIFFERENT
-- invoice is still refused DISPATCH_IRN_CONFLICT. updated_at moves only on supersession.

CREATE TABLE IF NOT EXISTS dispatch_irn (
  dispatch_order_id     UUID PRIMARY KEY,
  invoice_number_ext    TEXT NOT NULL,
  irn_ext               TEXT NOT NULL,
  so_number_ext         TEXT NOT NULL,
  irp_acknowledged_at   TIMESTAMPTZ,
  site_id               UUID NOT NULL,
  recorded_by           UUID NOT NULL,
  source_event_id       UUID NOT NULL,
  correlation_id        UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Guarded DROP-then-ADD constraint block (the bom_line precedent): the DROP + ADD pair is kept
-- atomic in a DO block so a re-apply is idempotent and a drift in the CHECK body is corrected.
DO $$
BEGIN
  ALTER TABLE dispatch_irn DROP CONSTRAINT IF EXISTS chk_dispatch_irn_present;
  ALTER TABLE dispatch_irn ADD CONSTRAINT chk_dispatch_irn_present CHECK (
    irn_ext ~ '^[0-9a-f]{64}$' AND btrim(invoice_number_ext) <> ''
  );
END $$;

CREATE INDEX IF NOT EXISTS idx_dispatch_irn_source_event ON dispatch_irn (source_event_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_irn_invoice ON dispatch_irn (invoice_number_ext);
CREATE INDEX IF NOT EXISTS idx_dispatch_irn_so ON dispatch_irn (so_number_ext);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON dispatch_irn TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON dispatch_irn TO readonly_user;
  END IF;
END $$;
