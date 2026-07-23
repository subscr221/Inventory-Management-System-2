-- Story 3.5: Velocity Classification for Putaway Optimization
-- Tracks ABC velocity class (based on putaway/pick frequency) and preferred bins for re-slotting.

CREATE TABLE IF NOT EXISTS velocity_class (
  sku                    TEXT NOT NULL,
  site_id                UUID NOT NULL,
  velocity_class         TEXT NOT NULL DEFAULT 'C',
  putaway_count_30d      INTEGER NOT NULL DEFAULT 0,
  override_count_30d     INTEGER NOT NULL DEFAULT 0,
  preferred_location_id  UUID,
  preferred_location_code TEXT,
  computed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_event_id        UUID,
  PRIMARY KEY (sku, site_id),
  CONSTRAINT chk_velocity_class_value CHECK (velocity_class IN ('A','B','C'))
);

CREATE INDEX IF NOT EXISTS idx_velocity_class_site_class ON velocity_class (site_id, velocity_class);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON velocity_class TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON velocity_class TO readonly_user;
  END IF;
END $$;
