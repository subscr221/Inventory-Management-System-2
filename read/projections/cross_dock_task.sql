CREATE TABLE IF NOT EXISTS cross_dock_task (
  cross_dock_task_id      UUID PRIMARY KEY,
  grn_line_id             UUID NOT NULL REFERENCES grn_line(grn_line_id),
  dispatch_order_line_id  UUID NOT NULL REFERENCES erp_sales_order(id),
  sku                     TEXT NOT NULL,
  lot_id                  UUID NOT NULL REFERENCES lot_master(lot_id),
  quantity                NUMERIC(14,3) NOT NULL,
  site_id                 UUID NOT NULL REFERENCES location_register(location_id),
  from_location_id        UUID NOT NULL REFERENCES location_register(location_id),
  staging_zone_id         UUID NOT NULL REFERENCES location_register(location_id),
  to_location_id          UUID REFERENCES location_register(location_id),
  status                  TEXT NOT NULL DEFAULT 'ready',
  priority                TEXT NOT NULL DEFAULT 'normal',
  assigned_to             UUID REFERENCES users(user_id),
  assigned_by             UUID REFERENCES users(user_id),
  assigned_at             TIMESTAMPTZ,
  created_by              UUID NOT NULL REFERENCES users(user_id),
  created_at              TIMESTAMPTZ NOT NULL,
  completed_by            UUID REFERENCES users(user_id),
  completed_at            TIMESTAMPTZ,
  correlation_id          UUID NOT NULL,
  source_event_id         UUID NOT NULL,
  completion_event_id     UUID,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_cross_dock_task_grn_line UNIQUE (grn_line_id),
  CONSTRAINT chk_cross_dock_task_status CHECK (status IN ('ready', 'completed')),
  CONSTRAINT chk_cross_dock_task_priority CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT chk_cross_dock_task_quantity_positive CHECK (quantity > 0),
  CONSTRAINT chk_cross_dock_task_completion_fields CHECK (
    (status = 'ready' AND to_location_id IS NULL AND completed_by IS NULL AND completed_at IS NULL AND completion_event_id IS NULL)
    OR
    (status = 'completed' AND to_location_id IS NOT NULL AND completed_by IS NOT NULL AND completed_at IS NOT NULL AND completion_event_id IS NOT NULL)
  )
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_cross_dock_task_grn_line' AND conrelid = 'cross_dock_task'::regclass) THEN
    ALTER TABLE cross_dock_task ADD CONSTRAINT uq_cross_dock_task_grn_line UNIQUE (grn_line_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_cross_dock_task_status' AND conrelid = 'cross_dock_task'::regclass) THEN
    ALTER TABLE cross_dock_task ADD CONSTRAINT chk_cross_dock_task_status CHECK (status IN ('ready', 'completed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_cross_dock_task_priority' AND conrelid = 'cross_dock_task'::regclass) THEN
    ALTER TABLE cross_dock_task ADD CONSTRAINT chk_cross_dock_task_priority CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_cross_dock_task_quantity_positive' AND conrelid = 'cross_dock_task'::regclass) THEN
    ALTER TABLE cross_dock_task ADD CONSTRAINT chk_cross_dock_task_quantity_positive CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_cross_dock_task_completion_fields' AND conrelid = 'cross_dock_task'::regclass) THEN
    ALTER TABLE cross_dock_task ADD CONSTRAINT chk_cross_dock_task_completion_fields CHECK (
      (status = 'ready' AND to_location_id IS NULL AND completed_by IS NULL AND completed_at IS NULL AND completion_event_id IS NULL)
      OR
      (status = 'completed' AND to_location_id IS NOT NULL AND completed_by IS NOT NULL AND completed_at IS NOT NULL AND completion_event_id IS NOT NULL)
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cross_dock_task_site_status ON cross_dock_task (site_id, status);
CREATE INDEX IF NOT EXISTS idx_cross_dock_task_staging_status ON cross_dock_task (staging_zone_id, status);
CREATE INDEX IF NOT EXISTS idx_cross_dock_task_assigned_status ON cross_dock_task (assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_cross_dock_task_dispatch_status ON cross_dock_task (dispatch_order_line_id, status);
CREATE INDEX IF NOT EXISTS idx_cross_dock_task_correlation ON cross_dock_task (correlation_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON cross_dock_task TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON cross_dock_task TO readonly_user;
  END IF;
END $$;
