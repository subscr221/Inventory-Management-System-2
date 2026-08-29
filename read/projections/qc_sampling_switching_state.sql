-- QC sampling switching state (Story 8.2, FR-Q-03, AC 3). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.inspection_completed and
-- qc.sampling_state_adjusted domain events in stream order; mutation happens exclusively through
-- persistEvent inside the SAME transaction as the domain_events insert.
--
-- The ISO 2859-1 clause 9.3 switching state kept per (plan, site) (Binding Scope Decision 7): the
-- current severity, the clause 9.3.3.2 switching score, the window of at most five most recent
-- original-inspection outcomes (newest last), the tightened-inspection counters, the
-- reduced-eligibility flag that a QC Head-level command turns into reduced inspection, and the
-- discontinuation flag that a QC Head-level command resumes on tightened. The row is read under
-- lock at sampling determination and advanced under lock at inspection completion.
--
-- app_user holds INSERT, SELECT, UPDATE (the advance) and never DELETE.

CREATE TABLE IF NOT EXISTS qc_sampling_switching_state (
  plan_id                            UUID NOT NULL,
  site_id                            UUID NOT NULL,
  severity                           TEXT NOT NULL DEFAULT 'normal',
  switching_score                    INTEGER NOT NULL DEFAULT 0,
  recent_original_outcomes           JSONB NOT NULL DEFAULT '[]'::jsonb,
  consecutive_accepted_on_tightened  INTEGER NOT NULL DEFAULT 0,
  not_accepted_on_tightened          INTEGER NOT NULL DEFAULT 0,
  reduced_eligible                   BOOLEAN NOT NULL DEFAULT false,
  inspection_discontinued            BOOLEAN NOT NULL DEFAULT false,
  last_task_id                       UUID,
  lots_counted                       INTEGER NOT NULL DEFAULT 0,
  source_event_id                    UUID NOT NULL,
  created_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_qc_sampling_switching_state PRIMARY KEY (plan_id, site_id),
  CONSTRAINT chk_qc_sampling_switching_state_severity CHECK (severity IN ('normal', 'tightened', 'reduced')),
  CONSTRAINT chk_qc_sampling_switching_state_counters CHECK (switching_score >= 0 AND consecutive_accepted_on_tightened >= 0 AND not_accepted_on_tightened >= 0 AND lots_counted >= 0),
  CONSTRAINT chk_qc_sampling_switching_state_window CHECK (jsonb_typeof(recent_original_outcomes) = 'array' AND jsonb_array_length(recent_original_outcomes) <= 5 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(recent_original_outcomes) e WHERE jsonb_typeof(e) <> 'boolean'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_sampling_switching_state_severity'
      AND conrelid = 'qc_sampling_switching_state'::regclass
  ) THEN
    ALTER TABLE qc_sampling_switching_state
      ADD CONSTRAINT chk_qc_sampling_switching_state_severity CHECK (severity IN ('normal', 'tightened', 'reduced'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_sampling_switching_state_counters'
      AND conrelid = 'qc_sampling_switching_state'::regclass
  ) THEN
    ALTER TABLE qc_sampling_switching_state
      ADD CONSTRAINT chk_qc_sampling_switching_state_counters CHECK (switching_score >= 0 AND consecutive_accepted_on_tightened >= 0 AND not_accepted_on_tightened >= 0 AND lots_counted >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_sampling_switching_state_window'
      AND conrelid = 'qc_sampling_switching_state'::regclass
  ) THEN
    ALTER TABLE qc_sampling_switching_state
      ADD CONSTRAINT chk_qc_sampling_switching_state_window CHECK (jsonb_typeof(recent_original_outcomes) = 'array' AND jsonb_array_length(recent_original_outcomes) <= 5 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(recent_original_outcomes) e WHERE jsonb_typeof(e) <> 'boolean'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON qc_sampling_switching_state TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_sampling_switching_state TO readonly_user;
  END IF;
END $$;
