DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_powersync') THEN
    GRANT SELECT ON domain_events TO svc_powersync;
  END IF;
END $$;

DO $$
BEGIN
  -- powersync-service replicates only through a publication named exactly "powersync"
  -- (module-postgres PUBLICATION_NAME); databases created before 2026-09-14 carry the old name.
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'powersync_publication')
     AND NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'powersync') THEN
    ALTER PUBLICATION powersync_publication RENAME TO powersync;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'powersync') THEN
    CREATE PUBLICATION powersync FOR TABLE domain_events;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'powersync'
      AND schemaname = 'public'
      AND tablename = 'domain_events'
  ) THEN
    ALTER PUBLICATION powersync ADD TABLE domain_events;
  END IF;
END $$;

-- Story 5.5 extends this publication with the Released-BOM explosion inputs. That extension lives
-- in powersync-bom.sql, registered at the TAIL of MIGRATIONS, because this file runs before the
-- bom tables are created and cannot reference them.
