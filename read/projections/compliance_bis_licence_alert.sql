-- BIS licence expiry alert ledger (Story 8.7, FR-Q-11, AC 2). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads as app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql
-- duplicates this content for first-boot container init - change both files together. Every
-- statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be re-applied to a
-- live database safely.
--
-- One row per (licence_id, valid_to, stage_days) is the idempotency ledger for the 90/60/30-day
-- expiry sweep (the asset_coverage_alert grain from Story 7.7). stage_days = 0 records the expiry
-- flip.
--
-- Story 8.7 code review: valid_to is IN THE KEY deliberately. The ledger is APPEND-ONLY - an alert
-- that fired is a posted regulatory fact and is never erased, exactly as production_consumption
-- _variance is append-only for a posted measurement. Renewal therefore re-arms the alerts by
-- construction: an in-place window update changes valid_to, the new window has no ledger rows, and
-- the 90/60/30 stages fire again for it while the history of the old window survives. An earlier
-- revision keyed on (licence_id, stage_days) alone and DELETEd the rows on renewal; that was a
-- workaround for the wrong key, and app_user held DELETE on compliance data to support it. Both
-- are gone.
--
-- No FK to compliance_bis_licence: Binding Scope Decision 8 forbids cross-projection foreign keys,
-- so referential integrity is the applier's job (it loads the licence FOR UPDATE before writing a
-- ledger row). Unlike a derived, rebuildable projection this table is NOT rebuildable - it is the
-- record of which notifications were actually raised - so it is never truncated on a replay.

CREATE TABLE IF NOT EXISTS compliance_bis_licence_alert (
  licence_id  UUID NOT NULL,
  valid_to    DATE NOT NULL,
  stage_days  INTEGER NOT NULL,
  flagged_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_compliance_bis_licence_alert_stage CHECK (stage_days IN (90, 60, 30, 0)),
  CONSTRAINT pk_compliance_bis_licence_alert PRIMARY KEY (licence_id, valid_to, stage_days)
);

-- Upgrade path for a database carrying the pre-review (licence_id, stage_days) form: add the
-- window column, backfill it from the register, and swap the UNIQUE constraint for the primary key.
ALTER TABLE compliance_bis_licence_alert ADD COLUMN IF NOT EXISTS valid_to DATE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM compliance_bis_licence_alert WHERE valid_to IS NULL
  ) THEN
    UPDATE compliance_bis_licence_alert a
       SET valid_to = l.valid_to
      FROM compliance_bis_licence l
     WHERE a.licence_id = l.licence_id AND a.valid_to IS NULL;
    -- A row whose licence no longer exists cannot be attributed to a window. It is left NULL on
    -- purpose: the NOT NULL promotion below is skipped rather than deleting audit history, so the
    -- operator sees the un-backfilled rows instead of losing them.
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'compliance_bis_licence_alert'
      AND column_name = 'valid_to'
      AND is_nullable = 'YES'
  ) AND NOT EXISTS (
    SELECT 1 FROM compliance_bis_licence_alert WHERE valid_to IS NULL
  ) THEN
    ALTER TABLE compliance_bis_licence_alert ALTER COLUMN valid_to SET NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_compliance_bis_licence_alert'
      AND conrelid = 'compliance_bis_licence_alert'::regclass
  ) THEN
    ALTER TABLE compliance_bis_licence_alert DROP CONSTRAINT uq_compliance_bis_licence_alert;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pk_compliance_bis_licence_alert'
      AND conrelid = 'compliance_bis_licence_alert'::regclass
  ) THEN
    ALTER TABLE compliance_bis_licence_alert
      ADD CONSTRAINT pk_compliance_bis_licence_alert PRIMARY KEY (licence_id, valid_to, stage_days);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_compliance_bis_licence_alert_stage'
      AND conrelid = 'compliance_bis_licence_alert'::regclass
  ) THEN
    ALTER TABLE compliance_bis_licence_alert
      ADD CONSTRAINT chk_compliance_bis_licence_alert_stage CHECK (stage_days IN (90, 60, 30, 0));
  END IF;
END $$;

-- No separate licence_id index: the primary key leads with licence_id and serves every lookup this
-- table performs, so a second index would be pure write amplification on the sweep insert path.

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    -- INSERT and SELECT only. The ledger is append-only: no UPDATE, and deliberately no DELETE.
    GRANT SELECT, INSERT ON compliance_bis_licence_alert TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON compliance_bis_licence_alert TO readonly_user;
  END IF;
END $$;
