-- Replenishment recommendation read model (Story 2.7). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries
-- its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve reads/writes as
-- app_user without depending on deploy/compose/init-db.sql. deploy/compose/init-db.sql duplicates
-- this content for first-boot container init - change both files together. Every statement is
-- idempotent so the file can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying replenishment.recommended domain events;
-- mutation happens exclusively through persistEvent inside the SAME transaction as the domain_events
-- insert. One OPEN recommendation per (sku, location_id) is enforced by the partial unique index
-- uq_replenishment_recommendation_open so a re-run or a concurrent reorder check cannot stack
-- duplicate open recommendations. Phase-1 emits a recommendation only - NOT a purchase requisition or
-- PO (Epic 4 owns those).

CREATE TABLE IF NOT EXISTS replenishment_recommendation (
  recommendation_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                   TEXT NOT NULL,
  location_id           UUID NOT NULL,
  on_hand_at_check      NUMERIC(18, 6) NOT NULL,
  reorder_point         NUMERIC(18, 6) NOT NULL,
  recommended_order_qty NUMERIC(18, 6) NOT NULL,
  status                TEXT NOT NULL DEFAULT 'open',
  triggered_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_event_id       UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_replenishment_recommendation_status CHECK (status IN ('open', 'superseded', 'fulfilled'))
);

CREATE INDEX IF NOT EXISTS idx_replenishment_recommendation_sku ON replenishment_recommendation (sku);
CREATE INDEX IF NOT EXISTS idx_replenishment_recommendation_location ON replenishment_recommendation (location_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_replenishment_recommendation_open ON replenishment_recommendation (sku, location_id) WHERE status = 'open';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_replenishment_recommendation_status'
      AND conrelid = 'replenishment_recommendation'::regclass
  ) THEN
    ALTER TABLE replenishment_recommendation
      ADD CONSTRAINT chk_replenishment_recommendation_status CHECK (status IN ('open', 'superseded', 'fulfilled'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON replenishment_recommendation TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON replenishment_recommendation TO readonly_user;
  END IF;
END $$;
