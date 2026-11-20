-- Story 8.10 (D11, AC 3): the append-only free-text observation note on a QC inspection task,
-- with an optional caller-owned photo attachment. This is deliberately NOT qc_inspection_result:
-- qc.observation_recorded is a per-characteristic reading batch with NOT NULL characteristic_id and
-- sample_unit_no, and overloading it would corrupt the result grain.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.observation_note_recorded; mutation
-- happens exclusively through persistEvent inside the SAME transaction as the domain_events insert.
-- app_user holds INSERT and SELECT (append-only, never UPDATE or DELETE); readonly_user SELECT.

CREATE TABLE IF NOT EXISTS qc_observation_note (
  note_id         UUID PRIMARY KEY,
  task_id         UUID NOT NULL,
  lot_id          UUID NOT NULL,
  note            TEXT NOT NULL,
  attachment_id   UUID,
  recorded_by     UUID NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL,
  source_event_id UUID NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_qc_observation_note_length CHECK (char_length(note) BETWEEN 1 AND 1000)
);

CREATE INDEX IF NOT EXISTS idx_qc_observation_note_task
  ON qc_observation_note (task_id, recorded_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_qc_observation_note_length'
      AND conrelid = 'qc_observation_note'::regclass
  ) THEN
    ALTER TABLE qc_observation_note
      ADD CONSTRAINT chk_qc_observation_note_length CHECK (char_length(note) BETWEEN 1 AND 1000);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON qc_observation_note TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON qc_observation_note TO readonly_user;
  END IF;
END $$;
