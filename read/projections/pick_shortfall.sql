-- Story 3.17: Pick shortfall recording for short-picked lines (AC 1).
-- This file is the CANONICAL definition, applied by src/events/migrate.ts.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init.

CREATE TABLE IF NOT EXISTS pick_shortfall (
  pick_shortfall_id UUID PRIMARY KEY,
  pick_task_id UUID NOT NULL,
  pick_line_id UUID NOT NULL UNIQUE,
  directed_quantity NUMERIC(14,3) NOT NULL,
  found_quantity NUMERIC(14,3) NOT NULL,
  reason TEXT NOT NULL,
  note TEXT,
  actor_user_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  source_event_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_pick_shortfall_reason CHECK (reason IN ('BIN_EMPTY', 'LESS_IN_BIN', 'DAMAGED', 'OTHER')),
  CONSTRAINT chk_pick_shortfall_found_quantity CHECK (found_quantity >= 0),
  CONSTRAINT chk_pick_shortfall_found_lt_directed CHECK (found_quantity < directed_quantity),
  CONSTRAINT chk_pick_shortfall_bin_empty CHECK (reason <> 'BIN_EMPTY' OR found_quantity = 0),
  CONSTRAINT chk_pick_shortfall_other_note CHECK (reason <> 'OTHER' OR (note IS NOT NULL AND btrim(note) <> '' AND char_length(note) <= 200))
);

CREATE INDEX IF NOT EXISTS idx_pick_shortfall_task ON pick_shortfall (pick_task_id);
CREATE INDEX IF NOT EXISTS idx_pick_shortfall_source_event ON pick_shortfall (source_event_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_pick_shortfall_reason' AND conrelid = 'pick_shortfall'::regclass) THEN
    ALTER TABLE pick_shortfall ADD CONSTRAINT chk_pick_shortfall_reason CHECK (reason IN ('BIN_EMPTY', 'LESS_IN_BIN', 'DAMAGED', 'OTHER'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_pick_shortfall_found_quantity' AND conrelid = 'pick_shortfall'::regclass) THEN
    ALTER TABLE pick_shortfall ADD CONSTRAINT chk_pick_shortfall_found_quantity CHECK (found_quantity >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_pick_shortfall_found_lt_directed' AND conrelid = 'pick_shortfall'::regclass) THEN
    ALTER TABLE pick_shortfall ADD CONSTRAINT chk_pick_shortfall_found_lt_directed CHECK (found_quantity < directed_quantity);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_pick_shortfall_bin_empty' AND conrelid = 'pick_shortfall'::regclass) THEN
    ALTER TABLE pick_shortfall ADD CONSTRAINT chk_pick_shortfall_bin_empty CHECK (reason <> 'BIN_EMPTY' OR found_quantity = 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_pick_shortfall_other_note' AND conrelid = 'pick_shortfall'::regclass) THEN
    ALTER TABLE pick_shortfall ADD CONSTRAINT chk_pick_shortfall_other_note CHECK (reason <> 'OTHER' OR (note IS NOT NULL AND btrim(note) <> '' AND char_length(note) <= 200));
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON pick_shortfall TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON pick_shortfall TO readonly_user;
  END IF;
END $$;
