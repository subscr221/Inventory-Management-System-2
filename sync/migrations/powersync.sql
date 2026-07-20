DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_powersync') THEN
    GRANT SELECT ON domain_events TO svc_powersync;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'powersync_publication') THEN
    CREATE PUBLICATION powersync_publication FOR TABLE domain_events;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'powersync_publication'
      AND schemaname = 'public'
      AND tablename = 'domain_events'
  ) THEN
    ALTER PUBLICATION powersync_publication ADD TABLE domain_events;
  END IF;
END $$;
