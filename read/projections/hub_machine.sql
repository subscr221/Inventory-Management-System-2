-- Story 10.4 (FR-RD-14): link table from a hub machine to its Epic 7 asset and usage meter.
-- operator_role is DATA (the exception recipient), never a role literal in workflow code.
CREATE TABLE IF NOT EXISTS hub_machine (
  machine_id UUID PRIMARY KEY,
  machine_code TEXT NOT NULL,
  location_id UUID NOT NULL,
  asset_id UUID NOT NULL,
  meter_id UUID,
  operator_role TEXT NOT NULL,
  source_event_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Second review P-K: machine_code is unique case-insensitively (unique INDEX, not a constraint).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_hub_machine_code' AND conrelid = 'hub_machine'::regclass) THEN
    ALTER TABLE hub_machine DROP CONSTRAINT uq_hub_machine_code;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_hub_machine_code ON hub_machine (lower(btrim(machine_code)));

-- Review P3: one machine per asset, one machine per meter (meter optional).
CREATE UNIQUE INDEX IF NOT EXISTS uq_hub_machine_asset ON hub_machine (asset_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hub_machine_meter ON hub_machine (meter_id) WHERE meter_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON hub_machine TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON hub_machine TO readonly_user;
  END IF;
END $$;
