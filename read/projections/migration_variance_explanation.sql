-- Opening-stock variance explanations (Story 13.1, FR-DM-01 AC 3, SM-48). This file is the
-- CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks). deploy/compose/
-- init-db.sql duplicates this content for first-boot container init - change both files together.
-- Every statement is idempotent (IF NOT EXISTS / guarded DO blocks).
--
-- Variances are COMPUTED, never stored (Binding Decision 7); explanations are stored and keyed by
-- the deterministic variance_key '{source_system}|{location_code}|{sku}|{lot or -}|{serial or -}'
-- and record the quantity delta they explain. An explanation whose explained_quantity_delta no
-- longer equals the live delta reports `stale` and the promotion gate blocks again: SM-48 says
-- unexplained, not once-explained. The approver is resolved server-side from the DOA registry
-- (transaction type `migration.variance_explanation`) and FROZEN on the row (Binding Decision 8);
-- approval is a second event by that actor, who must not be the explainer. The partial unique
-- index allows one APPROVED explanation per variance key; when a later explanation for the same
-- key is approved the earlier approved row is flipped to 'superseded' in the same transaction
-- (app_user holds no DELETE), so the history stays readable and the live answer stays unique.

CREATE TABLE IF NOT EXISTS migration_variance_explanation (
  explanation_id           UUID PRIMARY KEY,
  site_id                  UUID NOT NULL,
  variance_key             TEXT NOT NULL,
  source_system            TEXT NOT NULL,
  cause_code               TEXT NOT NULL,
  narrative                TEXT NOT NULL,
  explained_quantity_delta NUMERIC(18, 6) NOT NULL,
  explained_value          NUMERIC(18, 2) NOT NULL,
  explained_by_actor_id    UUID NOT NULL,
  approver_actor_id        UUID NOT NULL,
  doa_entry_id             UUID,
  status                   TEXT NOT NULL,
  approved_at              TIMESTAMPTZ,
  approved_event_id        UUID,
  source_event_id          UUID NOT NULL,
  occurred_at              TIMESTAMPTZ NOT NULL,
  business_date            DATE NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_migration_variance_explanation_cause_code CHECK (cause_code IN ('legacy_unrecorded_receipt', 'legacy_unrecorded_issue', 'count_correction', 'unrecorded_scrap', 'lot_merge_or_split', 'uom_conversion', 'other')),
  CONSTRAINT chk_migration_variance_explanation_status CHECK (status IN ('pending_approval', 'approved', 'superseded'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_migration_variance_explanation_approved ON migration_variance_explanation (site_id, variance_key) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_migration_variance_explanation_key ON migration_variance_explanation (site_id, variance_key, status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_migration_variance_explanation_cause_code'
      AND conrelid = 'migration_variance_explanation'::regclass
  ) THEN
    ALTER TABLE migration_variance_explanation
      ADD CONSTRAINT chk_migration_variance_explanation_cause_code CHECK (cause_code IN ('legacy_unrecorded_receipt', 'legacy_unrecorded_issue', 'count_correction', 'unrecorded_scrap', 'lot_merge_or_split', 'uom_conversion', 'other'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_migration_variance_explanation_status'
      AND conrelid = 'migration_variance_explanation'::regclass
  ) THEN
    ALTER TABLE migration_variance_explanation
      ADD CONSTRAINT chk_migration_variance_explanation_status CHECK (status IN ('pending_approval', 'approved', 'superseded'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON migration_variance_explanation TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON migration_variance_explanation TO readonly_user;
  END IF;
END $$;
