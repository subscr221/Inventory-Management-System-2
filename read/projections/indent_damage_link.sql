-- Story 8.9 (AC 5, D15): a replacement requisition names the damage case it replaces. Forward-only
-- ADD COLUMN IF NOT EXISTS on indent; appended at the tail of src/events/migrate.ts, indent.sql is
-- NOT edited. No foreign key: the damage report and its indent are two events from one device and
-- the indent applier validates the pairing itself, refusing a forged link. MIRRORED verbatim at the
-- tail of deploy/compose/init-db.sql for first-boot container init - change both files together.

ALTER TABLE indent ADD COLUMN IF NOT EXISTS damage_report_id UUID;

CREATE INDEX IF NOT EXISTS idx_indent_damage_report ON indent (damage_report_id) WHERE damage_report_id IS NOT NULL;
