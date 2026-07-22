CREATE TABLE IF NOT EXISTS domain_events (
  event_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_type     TEXT NOT NULL,
  stream_id       UUID NOT NULL,
  event_type      TEXT NOT NULL,
  event_version   INTEGER NOT NULL,
  payload         JSONB NOT NULL,
  metadata        JSONB NOT NULL,
  schema_version  INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_stream_version UNIQUE (stream_id, event_version),
  CONSTRAINT uq_idempotency UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_domain_events_stream ON domain_events (stream_type, stream_id, event_version);
CREATE INDEX IF NOT EXISTS idx_domain_events_type ON domain_events (event_type);
CREATE INDEX IF NOT EXISTS idx_domain_events_created ON domain_events (created_at);
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON domain_events TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON domain_events TO readonly_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_powersync') THEN
    GRANT SELECT ON domain_events TO svc_powersync;
  END IF;
END $$;
