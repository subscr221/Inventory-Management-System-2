-- Three-way match read model (Story 4.5). This file is the CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its OWN
-- grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as app_user
-- without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates this
-- content for first-boot container init - change both files together. Every statement is
-- idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a live database
-- safely.
--
-- Derived state ONLY: rows are derived exclusively at persist time from three_way_match.* and
-- supplier_invoice.*_note_recorded domain events; mutation happens exclusively through
-- persistEvent, which applies this projection inside the SAME transaction as the domain_events
-- insert. One row per match RUN (match_id): a blocked match that is later lifted by a credit or
-- debit note keeps its row and flips to 'lifted'; a fresh match run after a lift is a NEW match_id,
-- never an overwrite. variance_detail carries the per-line quantity/price comparison plus the
-- tolerance snapshot actually applied, so a historical match stays explainable after the
-- configured tolerances change. All comparison arithmetic runs in PostgreSQL NUMERIC - never
-- floating point.

CREATE TABLE IF NOT EXISTS three_way_match (
  match_id              UUID PRIMARY KEY,
  invoice_id            UUID NOT NULL,
  po_id                 UUID NOT NULL,
  site_id               UUID,
  business_stream       TEXT,
  status                TEXT NOT NULL,
  error_code            TEXT,
  variance_detail       JSONB NOT NULL,
  tolerance_rule_version TEXT NOT NULL,
  lifted_note_id        UUID,
  lifted_note_type      TEXT,
  run_by                UUID NOT NULL,
  recorded_at           TIMESTAMPTZ NOT NULL,
  lifted_at             TIMESTAMPTZ,
  source_event_id       UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_three_way_match_status CHECK (status IN ('passed','blocked','lifted')),
  CONSTRAINT chk_three_way_match_note_type CHECK (
    lifted_note_type IS NULL OR lifted_note_type IN ('credit_note','debit_note')
  ),
  CONSTRAINT chk_three_way_match_lift_pairing CHECK (
    (status = 'lifted' AND lifted_note_id IS NOT NULL AND lifted_note_type IS NOT NULL AND lifted_at IS NOT NULL)
    OR (status <> 'lifted' AND lifted_note_id IS NULL AND lifted_note_type IS NULL AND lifted_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_three_way_match_invoice ON three_way_match (invoice_id);
CREATE INDEX IF NOT EXISTS idx_three_way_match_po ON three_way_match (po_id);
CREATE INDEX IF NOT EXISTS idx_three_way_match_blocked ON three_way_match (status) WHERE status = 'blocked';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_three_way_match_status'
      AND conrelid = 'three_way_match'::regclass
  ) THEN
    ALTER TABLE three_way_match
      ADD CONSTRAINT chk_three_way_match_status CHECK (status IN ('passed','blocked','lifted'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_three_way_match_note_type'
      AND conrelid = 'three_way_match'::regclass
  ) THEN
    ALTER TABLE three_way_match
      ADD CONSTRAINT chk_three_way_match_note_type CHECK (
        lifted_note_type IS NULL OR lifted_note_type IN ('credit_note','debit_note')
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_three_way_match_lift_pairing'
      AND conrelid = 'three_way_match'::regclass
  ) THEN
    ALTER TABLE three_way_match
      ADD CONSTRAINT chk_three_way_match_lift_pairing CHECK (
        (status = 'lifted' AND lifted_note_id IS NOT NULL AND lifted_note_type IS NOT NULL AND lifted_at IS NOT NULL)
        OR (status <> 'lifted' AND lifted_note_id IS NULL AND lifted_note_type IS NULL AND lifted_at IS NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON three_way_match TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON three_way_match TO readonly_user;
  END IF;
END $$;
