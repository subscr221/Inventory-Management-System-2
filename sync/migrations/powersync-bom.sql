-- Story 5.5 (AC 4): the FIRST downstream read-model replication. The explosion INPUTS - the
-- Released BOM structure and its approved alternates - are replicated so a plant that executes
-- offline retains them (FR-B-07). bom_explosion / bom_explosion_line are deliberately NOT
-- replicated: explosion runs are central planning records, not edge inputs.
--
-- This lives in its own file rather than inside powersync.sql because that file is registered
-- near the HEAD of MIGRATIONS, before the bom tables exist; this one is registered at the TAIL,
-- after read/projections/bom_alternate.sql. Both blocks are guarded and re-runnable, so
-- db:migrate stays idempotent.
--
-- BOM is enterprise-scoped (Story 5.4 binding decision: no site or plant column exists on any BOM
-- table and none may be added), so the matching sync-rules bucket is a parameterless global
-- bucket: every plant's edge devices receive the full Released-BOM explosion-input set, and
-- plant applicability is expressed through line effectivity windows.

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_powersync') THEN
    GRANT SELECT ON bom, bom_revision, bom_line, bom_alternate TO svc_powersync;
  END IF;
END $$;

DO $$
DECLARE
  target_table text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'powersync_publication') THEN
    RETURN;
  END IF;
  FOREACH target_table IN ARRAY ARRAY['bom', 'bom_revision', 'bom_line', 'bom_alternate'] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'powersync_publication'
        AND schemaname = 'public'
        AND tablename = target_table
    ) THEN
      EXECUTE format('ALTER PUBLICATION powersync_publication ADD TABLE %I', target_table);
    END IF;
  END LOOP;
END $$;
