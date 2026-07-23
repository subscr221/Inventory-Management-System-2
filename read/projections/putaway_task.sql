CREATE TABLE IF NOT EXISTS putaway_task (
  putaway_task_id     UUID PRIMARY KEY,
  grn_line_id         UUID NOT NULL,
  sku                 TEXT NOT NULL,
  lot_id              TEXT,
  quantity            NUMERIC(18,3) NOT NULL,
  from_location_id    UUID NOT NULL,
  site_id             UUID NOT NULL,
  status              TEXT NOT NULL DEFAULT 'ready',
  owner_role          TEXT,
  released_by         UUID,
  release_reason_code TEXT,
  released_event_id   UUID,
  source_event_id     UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_putaway_task_status CHECK (status IN ('ready', 'held', 'completed'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_putaway_task_status'
      AND conrelid = 'putaway_task'::regclass
  ) THEN
    ALTER TABLE putaway_task
      ADD CONSTRAINT chk_putaway_task_status CHECK (status IN ('ready', 'held', 'completed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_putaway_task_grn_line ON putaway_task (grn_line_id);
CREATE INDEX IF NOT EXISTS idx_putaway_task_site_status ON putaway_task (site_id, status);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON putaway_task TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON putaway_task TO readonly_user;
  END IF;
END $$;

-- Story 3.5: Directed Putaway and Location Override - additive columns for Task 2
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS directed_location_id UUID;
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS directed_location_code TEXT;
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS velocity_class_at_suggestion TEXT;
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS actual_location_id UUID;
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS actual_location_code TEXT;
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS override_reason_code TEXT;
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS override_confidence TEXT;
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS putaway_task ADD COLUMN IF NOT EXISTS completed_by UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_putaway_task_velocity_class_value'
      AND conrelid = 'putaway_task'::regclass
  ) THEN
    ALTER TABLE putaway_task
      ADD CONSTRAINT chk_putaway_task_velocity_class_value
      CHECK (velocity_class_at_suggestion IS NULL OR velocity_class_at_suggestion IN ('A','B','C'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_putaway_task_override_confidence'
      AND conrelid = 'putaway_task'::regclass
  ) THEN
    ALTER TABLE putaway_task
      ADD CONSTRAINT chk_putaway_task_override_confidence
      CHECK (override_confidence IS NULL OR override_confidence IN ('certain','uncertain'));
  END IF;
END $$;
