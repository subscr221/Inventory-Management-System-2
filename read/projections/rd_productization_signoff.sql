-- R&D productization gate sign-off read model (Story 5.4). This file is the CANONICAL definition.
-- See rd_build_record.sql for the canonical comment about source, grants, and idempotency.
--
-- One row per (bom_id, gate_function) sign-off on the FR-B-11 productization gate. Exactly three
-- fixed gate functions exist: engineering, procurement, qc. A re-sign REPLACES the row (upsert on
-- uq_rd_signoff_function) rather than duplicating it. The productization checklist is a COMPUTED
-- read over bom, bom_line, and this table (src/read/projections/rd_productization.ts) - there is
-- deliberately no stored checklist table. gate_function is the column name, not "function", which
-- is a reserved word in enough tooling to be worth avoiding.

CREATE TABLE IF NOT EXISTS rd_productization_signoff (
  signoff_id          UUID PRIMARY KEY,
  bom_id              UUID NOT NULL,
  gate_function       TEXT NOT NULL,
  signed_by           UUID NOT NULL,
  signed_at           TIMESTAMPTZ NOT NULL,
  approver_actor_id   UUID NOT NULL,
  doa_entry_id        UUID,
  notes               TEXT,
  source_event_id     UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rd_signoff_function CHECK (gate_function IN ('engineering','procurement','qc'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rd_signoff_function ON rd_productization_signoff (bom_id, gate_function);
CREATE INDEX IF NOT EXISTS idx_rd_signoff_bom_id ON rd_productization_signoff (bom_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_signoff_function'
      AND conrelid = 'rd_productization_signoff'::regclass
  ) THEN
    ALTER TABLE rd_productization_signoff
      ADD CONSTRAINT chk_rd_signoff_function CHECK (gate_function IN ('engineering','procurement','qc'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON rd_productization_signoff TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON rd_productization_signoff TO readonly_user;
  END IF;
END $$;
