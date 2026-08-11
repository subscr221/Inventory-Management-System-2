-- Engineering Change Order (ECO) read model (Story 5.3). This file is the CANONICAL definition.
-- See bom.sql for the canonical comment about source, grants, and idempotency.
--
-- An ECO targets a specific Released BOM revision and carries it through
-- draft -> under_review -> approved -> implemented, or cancelled at any of the first three
-- states. implemented and cancelled are terminal (AC 6, AC 8). Only an Implemented ECO may alter
-- a Released BOM (AC 3, AC 4) - approval alone never mutates bom/bom_revision/bom_line.

CREATE TABLE IF NOT EXISTS eco (
  eco_id                UUID PRIMARY KEY,
  eco_number            TEXT NOT NULL,
  bom_id                UUID NOT NULL,
  target_revision_id    UUID NOT NULL,
  business_stream       TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'draft',
  reason                TEXT NOT NULL,
  raised_by             UUID NOT NULL,
  approver_actor_id     UUID,
  doa_entry_id          UUID,
  review_started_at     TIMESTAMPTZ,
  approved_at           TIMESTAMPTZ,
  approved_by           UUID,
  implemented_at        TIMESTAMPTZ,
  implemented_by        UUID,
  new_revision_id       UUID,
  cancelled_at          TIMESTAMPTZ,
  cancelled_by          UUID,
  cancel_reason         TEXT,
  status_changed_at     TIMESTAMPTZ,
  status_changed_by     UUID,
  correlation_id        UUID,
  source_event_id       UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_eco_status CHECK (status IN ('draft','under_review','approved','implemented','cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_eco_number ON eco (eco_number);
CREATE INDEX IF NOT EXISTS idx_eco_bom_id ON eco (bom_id);
CREATE INDEX IF NOT EXISTS idx_eco_status ON eco (status);
CREATE INDEX IF NOT EXISTS idx_eco_approver ON eco (approver_actor_id) WHERE status = 'under_review';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_eco_status'
      AND conrelid = 'eco'::regclass
  ) THEN
    ALTER TABLE eco
      ADD CONSTRAINT chk_eco_status CHECK (status IN ('draft','under_review','approved','implemented','cancelled'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON eco TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON eco TO readonly_user;
  END IF;
END $$;
