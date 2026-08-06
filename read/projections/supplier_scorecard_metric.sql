-- Supplier scorecard metric read model (Story 4.2). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Append-only metric history: one row per supplier_scorecard.metric_recorded event, derived
-- exclusively at persist time through persistEvent inside the SAME transaction as the
-- domain_events insert. Rows are NEVER updated or deleted; a correction is a NEW row carrying a
-- supersedes_metric_id pointer to the row it supersedes. The partial unique index on
-- (reference_event_id, metric_kind) is the replay guard: a duplicate metric for the same source
-- event is a no-op at the seam. All metric arithmetic runs in PostgreSQL NUMERIC - never
-- floating point. No UPDATE or DELETE grant exists for app_user by design.

CREATE TABLE IF NOT EXISTS supplier_scorecard_metric (
  metric_id             UUID PRIMARY KEY,
  supplier_id           UUID NOT NULL,
  metric_kind           TEXT NOT NULL,
  reference_event_id    UUID NOT NULL,
  reference_entity_id   UUID NOT NULL,
  value_num             NUMERIC(14,6) NOT NULL,
  context               JSONB NOT NULL DEFAULT '{}'::jsonb,
  business_date         DATE NOT NULL,
  source_event_id       UUID NOT NULL,
  supersedes_metric_id  UUID,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by           UUID NOT NULL,
  CONSTRAINT chk_supplier_scorecard_metric_kind CHECK (
    metric_kind IN ('on_time_delivery','quality_acceptance','price_variance','responsiveness')
  )
);

CREATE INDEX IF NOT EXISTS idx_supplier_scorecard_supplier_kind
  ON supplier_scorecard_metric (supplier_id, metric_kind, business_date DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_scorecard_reference
  ON supplier_scorecard_metric (reference_entity_id);
CREATE INDEX IF NOT EXISTS idx_supplier_scorecard_supersedes
  ON supplier_scorecard_metric (supersedes_metric_id) WHERE supersedes_metric_id IS NOT NULL;
-- The replay guard is PARTIAL (supersedes_metric_id IS NULL): ordinary rows are unique per
-- (reference_event_id, metric_kind), while a correction row - which carries supersedes_metric_id
-- and re-measures the SAME source event - is admitted alongside the row it supersedes. The
-- drop-then-create pair keeps re-application idempotent and converges databases that carried the
-- earlier full index onto the partial definition.
DROP INDEX IF EXISTS uq_supplier_scorecard_reference_kind;
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_scorecard_reference_kind
  ON supplier_scorecard_metric (reference_event_id, metric_kind)
  WHERE supersedes_metric_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_supplier_scorecard_metric_kind'
      AND conrelid = 'supplier_scorecard_metric'::regclass
  ) THEN
    ALTER TABLE supplier_scorecard_metric
      ADD CONSTRAINT chk_supplier_scorecard_metric_kind CHECK (
        metric_kind IN ('on_time_delivery','quality_acceptance','price_variance','responsiveness')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON supplier_scorecard_metric TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON supplier_scorecard_metric TO readonly_user;
  END IF;
END $$;
