-- Inspection plan approval evidence (Story 8.1, FR-Q-01, AC 1). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying qc.inspection_plan_approved domain events;
-- mutation happens exclusively through persistEvent inside the SAME transaction as the
-- domain_events insert.
--
-- Exactly ONE approval per plan version (Binding Scope Decision 10): the primary key IS the plan
-- version id, so concurrent approval attempts resolve to one record (a 23505 on the primary key
-- resolves to 409 INSPECTION_PLAN_ALREADY_APPROVED in the store's constraint chain). The row
-- carries the SERVER-derived authority: the DOA entry that governed qc.inspection_plan_approval,
-- its governing role (which must be QC Head-level), the resolved approver (holder or active
-- delegate), the acting user (who must equal the resolved approver) and the approval instant.
--
-- Append-only: app_user holds INSERT and SELECT only, never UPDATE or DELETE. An approval is
-- never revoked by this story; a superseding plan is a new version with its own approval.

CREATE TABLE IF NOT EXISTS inspection_plan_approval (
  plan_version_id           UUID PRIMARY KEY,
  plan_id                   UUID NOT NULL,
  approved_by               UUID NOT NULL,
  resolved_approver_user_id UUID NOT NULL,
  doa_entry_id              UUID NOT NULL,
  governing_role            TEXT NOT NULL,
  approved_at               TIMESTAMPTZ NOT NULL,
  source_event_id           UUID NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_inspection_plan_approval_actor_pairing CHECK (approved_by = resolved_approver_user_id),
  CONSTRAINT chk_inspection_plan_approval_role CHECK (btrim(governing_role) <> '' AND char_length(governing_role) <= 100)
);

CREATE INDEX IF NOT EXISTS idx_inspection_plan_approval_plan ON inspection_plan_approval (plan_id, approved_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_approval_actor_pairing'
      AND conrelid = 'inspection_plan_approval'::regclass
  ) THEN
    ALTER TABLE inspection_plan_approval
      ADD CONSTRAINT chk_inspection_plan_approval_actor_pairing CHECK (approved_by = resolved_approver_user_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inspection_plan_approval_role'
      AND conrelid = 'inspection_plan_approval'::regclass
  ) THEN
    ALTER TABLE inspection_plan_approval
      ADD CONSTRAINT chk_inspection_plan_approval_role CHECK (btrim(governing_role) <> '' AND char_length(governing_role) <= 100);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT ON inspection_plan_approval TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON inspection_plan_approval TO readonly_user;
  END IF;
END $$;
