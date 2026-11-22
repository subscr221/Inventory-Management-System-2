-- Story 10.2 (FR-AC-03): the six Ind AS 38 (IAS 38.57) development-capitalization criteria, one
-- row per (project, criterion). capitalization_effective_date on rd_project is set forward-only
-- once all six are met; it never moves backwards.

CREATE TABLE IF NOT EXISTS rd_project_checklist (
  checklist_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_code    TEXT NOT NULL,
  criterion_code  TEXT NOT NULL,
  met             BOOLEAN NOT NULL DEFAULT false,
  met_at          TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rd_project_checklist_criterion CHECK (criterion_code IN (
    'technical_feasibility',
    'intention_to_complete',
    'ability_to_use_or_sell',
    'future_economic_benefits',
    'resources_available',
    'expenditure_measurable'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rd_project_checklist_grain ON rd_project_checklist (project_code, criterion_code);

-- Forward-only: the effective date is set server-side when all six criteria first become met and
-- is never back-dated. The checklist set route and the raise seam's budget lock both write/read
-- rd_project, so app_user gains UPDATE on rd_project (the raise seam takes SELECT ... FOR UPDATE).
ALTER TABLE rd_project ADD COLUMN IF NOT EXISTS capitalization_effective_date TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT UPDATE ON rd_project TO app_user;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_rd_project_checklist_criterion'
      AND conrelid = 'rd_project_checklist'::regclass
  ) THEN
    ALTER TABLE rd_project_checklist
      ADD CONSTRAINT chk_rd_project_checklist_criterion CHECK (criterion_code IN (
        'technical_feasibility',
        'intention_to_complete',
        'ability_to_use_or_sell',
        'future_economic_benefits',
        'resources_available',
        'expenditure_measurable'
      ));
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON rd_project_checklist TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON rd_project_checklist TO readonly_user;
  END IF;
END $$;
