-- Story 10.4 (FR-RD-13): hub member and walk-in customer records.
CREATE TABLE IF NOT EXISTS hub_customer (
  customer_id UUID PRIMARY KEY,
  customer_kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  membership_no TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  location_id UUID,
  source_event_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_hub_customer_kind CHECK (customer_kind IN ('member','walk_in')),
  CONSTRAINT chk_hub_customer_status CHECK (status IN ('active','inactive')),
  CONSTRAINT chk_hub_customer_membership_no CHECK ((customer_kind = 'member' AND membership_no IS NOT NULL) OR (customer_kind = 'walk_in' AND membership_no IS NULL))
);

-- Second review X5: no phone data in Phase 1 (capture is deferred until a privacy decision).
ALTER TABLE hub_customer DROP COLUMN IF EXISTS contact_phone_hash;

-- Second review P-K: membership_no is unique case-insensitively (unique INDEX, not a constraint).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_hub_customer_membership_no' AND conrelid = 'hub_customer'::regclass) THEN
    ALTER TABLE hub_customer DROP CONSTRAINT uq_hub_customer_membership_no;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_hub_customer_membership_no ON hub_customer (lower(btrim(membership_no)));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_hub_customer_kind' AND conrelid = 'hub_customer'::regclass) THEN
    ALTER TABLE hub_customer ADD CONSTRAINT chk_hub_customer_kind CHECK (customer_kind IN ('member','walk_in'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_hub_customer_status' AND conrelid = 'hub_customer'::regclass) THEN
    ALTER TABLE hub_customer ADD CONSTRAINT chk_hub_customer_status CHECK (status IN ('active','inactive'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_hub_customer_membership_no' AND conrelid = 'hub_customer'::regclass) THEN
    ALTER TABLE hub_customer ADD CONSTRAINT chk_hub_customer_membership_no CHECK ((customer_kind = 'member' AND membership_no IS NOT NULL) OR (customer_kind = 'walk_in' AND membership_no IS NULL));
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON hub_customer TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON hub_customer TO readonly_user;
  END IF;
END $$;
