-- Inspection plan header (Story 8.1, FR-Q-01, AC 1 and AC 2). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.inspection_plan_created domain events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the
-- SAME transaction as the domain_events insert.
--
-- The header is the SCOPE GRAIN of a plan: one governed product item, one released production or
-- job-work-kit BOM revision used as the product-specification revision (Annex requirement 2 - QC
-- never mutates BOM data, it only references the revision), and either the standard scope or a
-- customer override scoped to an opaque job-work-order reference (Annex requirement 7). The
-- reference carries NO foreign key until Epic 9 exists; source_order_type is constrained to the
-- single literal 'job_work_order' so no arbitrary order type is exposed by this story.
--
-- uq_inspection_plan_grain is the concurrency backstop for two first-version creates racing on
-- the same grain (a 23505 on it resolves to 409 DUPLICATE_INSPECTION_PLAN_VERSION in the store's
-- constraint chain with the existing plan_id). Version numbers are allocated under the header
-- row's FOR UPDATE lock in src/compliance/quality.ts, never by an unlocked MAX(version) + 1.
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE or DELETE. A header's grain is
-- immutable; a new specification revision is a new header.

CREATE TABLE IF NOT EXISTS inspection_plan (
  plan_id            UUID PRIMARY KEY,
  scope              TEXT NOT NULL,
  item_id            UUID NOT NULL,
  sku                TEXT NOT NULL,
  bom_revision_id    UUID NOT NULL,
  source_order_type  TEXT,
  source_order_ref   TEXT,
  created_by         UUID NOT NULL,
  source_event_id    UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inspection_plan_grain UNIQUE NULLS NOT DISTINCT (item_id, bom_revision_id, scope, source_order_type, source_order_ref),
  CONSTRAINT chk_inspection_plan_scope CHECK (scope IN ('standard', 'customer_override')),
  CONSTRAINT chk_inspection_plan_source_order_type CHECK (source_order_type IS NULL OR source_order_type = 'job_work_order'),
  CONSTRAINT chk_inspection_plan_scope_pairing CHECK (
    (scope = 'standard' AND source_order_type IS NULL AND source_order_ref IS NULL)
    OR (scope = 'customer_override' AND source_order_type IS NOT NULL AND source_order_ref IS NOT NULL AND btrim(source_order_ref) <> '' AND char_length(source_order_ref) <= 128)
  )
);

CREATE INDEX IF NOT EXISTS idx_inspection_plan_item_revision ON inspection_plan (item_id, bom_revision_id, scope);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_inspection_plan_grain'
      AND conrelid = 'inspection_plan'::regclass
  ) THEN
    ALTER TABLE inspection_plan
      ADD CONSTRAINT uq_inspection_plan_grain UNIQUE NULLS NOT DISTINCT (item_id, bom_revision_id, scope, source_order_type, source_order_ref);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_scope'
      AND conrelid = 'inspection_plan'::regclass
  ) THEN
    ALTER TABLE inspection_plan
      ADD CONSTRAINT chk_inspection_plan_scope CHECK (scope IN ('standard', 'customer_override'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_source_order_type'
      AND conrelid = 'inspection_plan'::regclass
  ) THEN
    ALTER TABLE inspection_plan
      ADD CONSTRAINT chk_inspection_plan_source_order_type CHECK (source_order_type IS NULL OR source_order_type = 'job_work_order');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_scope_pairing'
      AND conrelid = 'inspection_plan'::regclass
  ) THEN
    ALTER TABLE inspection_plan
      ADD CONSTRAINT chk_inspection_plan_scope_pairing CHECK (
        (scope = 'standard' AND source_order_type IS NULL AND source_order_ref IS NULL)
        OR (scope = 'customer_override' AND source_order_type IS NOT NULL AND source_order_ref IS NOT NULL AND btrim(source_order_ref) <> '' AND char_length(source_order_ref) <= 128)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON inspection_plan TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON inspection_plan TO readonly_user;
  END IF;
END $$;
