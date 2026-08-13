-- BOM explosion run header read model (Story 5.5). This file is the CANONICAL definition,
-- applied by src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It
-- carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can serve
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks).
--
-- Derived state ONLY: rows are rebuildable by replaying bom.exploded domain events. The explosion
-- math runs at CAPTURE time in src/engineering/bom-explosion.ts and is embedded in the event
-- payload; the applier persists it verbatim so replay is byte-deterministic and never recomputes.
--
-- order_quantity is unbounded NUMERIC deliberately: the scrap-adjusted product
-- qty * base_quantity_per * (1 + scrap/100) can exceed NUMERIC(18,6) scale and PostgreSQL 18
-- silently rounds excess scale. Explosion runs are CENTRAL planning records and are NOT
-- replicated to the edge; only the explosion INPUTS (bom/bom_revision/bom_line/bom_alternate) are.

CREATE TABLE IF NOT EXISTS bom_explosion (
  explosion_id      UUID PRIMARY KEY,
  bom_id            UUID NOT NULL,
  revision_id       UUID NOT NULL,
  order_quantity    NUMERIC NOT NULL,
  business_date     DATE NOT NULL,
  depth_truncated   BOOLEAN NOT NULL DEFAULT false,
  requirement_count INTEGER NOT NULL,
  exploded_by       UUID NOT NULL,
  correlation_id    UUID,
  source_event_id   UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bom_explosion_quantity_positive CHECK (order_quantity > 0),
  CONSTRAINT chk_bom_explosion_requirement_count CHECK (requirement_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_explosion_source_event ON bom_explosion (source_event_id);
CREATE INDEX IF NOT EXISTS idx_bom_explosion_bom_id ON bom_explosion (bom_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_explosion_quantity_positive'
      AND conrelid = 'bom_explosion'::regclass
  ) THEN
    ALTER TABLE bom_explosion
      ADD CONSTRAINT chk_bom_explosion_quantity_positive CHECK (order_quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_bom_explosion_requirement_count'
      AND conrelid = 'bom_explosion'::regclass
  ) THEN
    ALTER TABLE bom_explosion
      ADD CONSTRAINT chk_bom_explosion_requirement_count CHECK (requirement_count >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON bom_explosion TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON bom_explosion TO readonly_user;
  END IF;
END $$;
