-- Item master read model (Story 2.1). This file is the CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate) and the integration-test harness. It carries its
-- OWN grants (guarded DO blocks) so a migrate-provisioned database can serve item-master
-- reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- item_id is the internal UUID used as the item_master event stream_id (EventEnvelope.stream_id
-- must remain UUID); sku is the unique API-facing identifier. valuation_method deliberately has
-- NO 'lifo' option (Ind AS 2 prohibits it). business_stream is validated in code against the
-- Story 1.5 business_streams vocabulary - no second enum or CHECK constraint here.

-- Story 2.10: item group master. Lives in this file (D1) so every harness that applies
-- item_master.sql also gets the foreign key target. ever_assigned (D9) is set on the first
-- assignment and never cleared: a group that ever held an item cannot be deleted, only
-- deactivated. Name is unique ignoring case (uq_item_group_name_ci).
CREATE TABLE IF NOT EXISTS item_group (
  item_group_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  ever_assigned BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_item_group_code UNIQUE (code),
  CONSTRAINT chk_item_group_status CHECK (status IN ('active', 'inactive')),
  CONSTRAINT chk_item_group_code CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  CONSTRAINT chk_item_group_name CHECK (length(btrim(name)) BETWEEN 1 AND 120)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_item_group_status'
      AND conrelid = 'item_group'::regclass
  ) THEN
    ALTER TABLE item_group
      ADD CONSTRAINT chk_item_group_status CHECK (status IN ('active', 'inactive'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_item_group_code'
      AND conrelid = 'item_group'::regclass
  ) THEN
    ALTER TABLE item_group
      ADD CONSTRAINT chk_item_group_code CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_item_group_name'
      AND conrelid = 'item_group'::regclass
  ) THEN
    ALTER TABLE item_group
      ADD CONSTRAINT chk_item_group_name CHECK (length(btrim(name)) BETWEEN 1 AND 120);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_item_group_name_ci ON item_group (lower(name));

-- Story 2.10 (D3): per-person create / edit / delete rights over item groups, granted and revoked
-- only by a ceo or finance_controller holder (checked in code). A row exists only while at least
-- one right is held; revoking all three removes it.
CREATE TABLE IF NOT EXISTS item_group_right (
  user_id UUID PRIMARY KEY REFERENCES users(user_id),
  can_create BOOLEAN NOT NULL DEFAULT false,
  can_edit BOOLEAN NOT NULL DEFAULT false,
  can_delete BOOLEAN NOT NULL DEFAULT false,
  granted_by UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Story 2.10 (AC 7): extra users told of every item group change, kept by ceo or
-- finance_controller holders only (checked in code).
CREATE TABLE IF NOT EXISTS item_group_recipient (
  user_id UUID PRIMARY KEY REFERENCES users(user_id),
  added_by UUID NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE, DELETE ON item_group TO app_user;
    GRANT INSERT, SELECT, UPDATE, DELETE ON item_group_right TO app_user;
    GRANT INSERT, SELECT, UPDATE, DELETE ON item_group_recipient TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON item_group TO readonly_user;
    GRANT SELECT ON item_group_right TO readonly_user;
    GRANT SELECT ON item_group_recipient TO readonly_user;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS item_master (
  item_id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                         TEXT NOT NULL,
  uom                         TEXT NOT NULL,
  lot_controlled              BOOLEAN NOT NULL DEFAULT false,
  serial_controlled           BOOLEAN NOT NULL DEFAULT false,
  hazmat                      BOOLEAN NOT NULL DEFAULT false,
  quarantine_required         BOOLEAN NOT NULL DEFAULT false,
  bis_licence_required        BOOLEAN NOT NULL DEFAULT false,
  legal_metrology_required    BOOLEAN NOT NULL DEFAULT false,
  valuation_method            TEXT NOT NULL,
  business_stream             TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'active',
  -- Story 2.4: standard cost is NOT a fourth valuation_method - it is an Ind AS 2 paragraph 21
  -- measurement technique layered on top of the actual valuation_method above. It is only
  -- effective once standard_cost_designation carries the exact literal below (enforced by
  -- chk_item_master_standard_cost_designation and re-checked in src/api/v1/items.ts).
  standard_cost_designation   TEXT,
  standard_cost_amount        NUMERIC(18, 6),
  variance_review_cadence     TEXT,
  variance_tolerance_percent  NUMERIC(7, 4),
  count_variance_tolerance_percent NUMERIC(7, 4),
  size_class                  TEXT NOT NULL DEFAULT 'standard',
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_item_master_sku UNIQUE (sku),
  CONSTRAINT chk_item_master_valuation_method CHECK (valuation_method IN ('fifo', 'weighted_average', 'specific_identification')),
  CONSTRAINT chk_item_master_status CHECK (status IN ('active', 'inactive')),
  CONSTRAINT chk_item_master_standard_cost_designation CHECK (
    standard_cost_designation IS NULL OR standard_cost_designation = 'ind_as_2_para_21_measurement_technique'
  ),
  CONSTRAINT chk_item_master_standard_cost_requires_designation CHECK (
    standard_cost_amount IS NULL OR standard_cost_designation = 'ind_as_2_para_21_measurement_technique'
  ),
  CONSTRAINT chk_item_master_standard_cost_amount_non_negative CHECK (standard_cost_amount IS NULL OR standard_cost_amount >= 0),
  CONSTRAINT chk_item_master_variance_tolerance_percent CHECK (
    variance_tolerance_percent IS NULL OR (variance_tolerance_percent >= 0 AND variance_tolerance_percent <= 100)
  ),
  CONSTRAINT chk_item_master_count_variance_tolerance_percent CHECK (
    count_variance_tolerance_percent IS NULL OR (count_variance_tolerance_percent >= 0 AND count_variance_tolerance_percent <= 100)
  ),
  CONSTRAINT chk_item_master_size_class CHECK (size_class IN ('small', 'standard', 'large', 'oversized'))
);

ALTER TABLE item_master ADD COLUMN IF NOT EXISTS standard_cost_designation TEXT;
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS standard_cost_amount NUMERIC(18, 6);
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS variance_review_cadence TEXT;
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS variance_tolerance_percent NUMERIC(7, 4);
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS count_variance_tolerance_percent NUMERIC(7, 4);

-- Story 3.5: size_class for putaway bin-matching (small / standard / large / oversized).
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS size_class TEXT NOT NULL DEFAULT 'standard';

-- Story 8.6 (FR-Q-14): Legal Metrology packaged-commodity flag, mirroring bis_licence_required.
-- Default false keeps the LABEL_VERSION_MISSING release block inert for every existing item until
-- the flag is deliberately set (Binding Scope Decision 7).
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS legal_metrology_required BOOLEAN NOT NULL DEFAULT false;

-- Story 2.10 (AC 4, AC 5): an item carries at most one group; existing items stay valid with
-- NULL. ON DELETE RESTRICT backs the code-level "never used" delete guard.
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS item_group_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_item_master_item_group'
      AND conrelid = 'item_master'::regclass
  ) THEN
    ALTER TABLE item_master
      ADD CONSTRAINT fk_item_master_item_group FOREIGN KEY (item_group_id)
        REFERENCES item_group (item_group_id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_item_master_item_group ON item_master (item_group_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_item_master_valuation_method'
      AND conrelid = 'item_master'::regclass
  ) THEN
    ALTER TABLE item_master
      ADD CONSTRAINT chk_item_master_valuation_method CHECK (valuation_method IN ('fifo', 'weighted_average', 'specific_identification'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_item_master_status'
      AND conrelid = 'item_master'::regclass
  ) THEN
    ALTER TABLE item_master
      ADD CONSTRAINT chk_item_master_status CHECK (status IN ('active', 'inactive'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_item_master_standard_cost_designation'
      AND conrelid = 'item_master'::regclass
  ) THEN
    ALTER TABLE item_master
      ADD CONSTRAINT chk_item_master_standard_cost_designation CHECK (
        standard_cost_designation IS NULL OR standard_cost_designation = 'ind_as_2_para_21_measurement_technique'
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_item_master_standard_cost_requires_designation'
      AND conrelid = 'item_master'::regclass
  ) THEN
    ALTER TABLE item_master
      ADD CONSTRAINT chk_item_master_standard_cost_requires_designation CHECK (
        standard_cost_amount IS NULL OR standard_cost_designation = 'ind_as_2_para_21_measurement_technique'
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_item_master_standard_cost_amount_non_negative'
      AND conrelid = 'item_master'::regclass
  ) THEN
    ALTER TABLE item_master
      ADD CONSTRAINT chk_item_master_standard_cost_amount_non_negative CHECK (standard_cost_amount IS NULL OR standard_cost_amount >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_item_master_variance_tolerance_percent'
      AND conrelid = 'item_master'::regclass
  ) THEN
    ALTER TABLE item_master
      ADD CONSTRAINT chk_item_master_variance_tolerance_percent CHECK (
        variance_tolerance_percent IS NULL OR (variance_tolerance_percent >= 0 AND variance_tolerance_percent <= 100)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_item_master_count_variance_tolerance_percent'
      AND conrelid = 'item_master'::regclass
  ) THEN
    ALTER TABLE item_master
      ADD CONSTRAINT chk_item_master_count_variance_tolerance_percent CHECK (
        count_variance_tolerance_percent IS NULL OR (count_variance_tolerance_percent >= 0 AND count_variance_tolerance_percent <= 100)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_item_master_size_class'
      AND conrelid = 'item_master'::regclass
  ) THEN
    ALTER TABLE item_master
      ADD CONSTRAINT chk_item_master_size_class CHECK (
        size_class IN ('small', 'standard', 'large', 'oversized')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON item_master TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON item_master TO readonly_user;
  END IF;
END $$;
