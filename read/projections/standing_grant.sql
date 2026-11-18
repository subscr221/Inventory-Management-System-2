-- Standing approval and self-approval limit read model (Story 4.8). CANONICAL definition, applied by
-- src/events/migrate.ts (npm run db:migrate); deploy/compose/init-db.sql duplicates this content
-- for first-boot container init - change both files together. Every statement is idempotent.
--
-- Derived state ONLY: rows are rebuildable by replaying standing_grant.* domain events; mutation
-- happens exclusively through persistEvent inside the same transaction as the domain_events
-- insert (the one exception is standing_grant_prune_setting, a per-assigner preference).
-- item_master.sql runs before this file (the scope FK targets item_group).
--
-- One table, two kinds (D1): a standing approval links one person to one SKU or one item group with
-- an optional monthly quantity cap and end date; a self-approval limit gives one person a rupee
-- ceiling on approving their own requisition lines. Both follow assign, finance-approve, revoke.

CREATE SEQUENCE IF NOT EXISTS standing_grant_ref_seq;

CREATE TABLE IF NOT EXISTS standing_grant (
  grant_id                  UUID PRIMARY KEY,
  grant_ref                 TEXT NOT NULL,
  grant_kind                TEXT NOT NULL,
  grantee_user_id           UUID NOT NULL,
  assigner_user_id          UUID NOT NULL,
  site_id                   UUID NOT NULL,
  scope_sku                 TEXT,
  scope_item_group_id       UUID,
  monthly_qty_cap           NUMERIC(18,3),
  limit_amount              NUMERIC(18,4),
  end_date                  DATE,
  status                    TEXT NOT NULL DEFAULT 'pending-finance',
  finance_approver_user_id  UUID,
  finance_decided_at        TIMESTAMPTZ,
  finance_rejection_reason  TEXT,
  revoked_at                TIMESTAMPTZ,
  revoked_by                TEXT,
  revoke_reason             TEXT,
  expired_at                TIMESTAMPTZ,
  correlation_id            UUID,
  source_event_id           UUID NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_standing_grant_ref UNIQUE (grant_ref),
  CONSTRAINT chk_standing_grant_kind CHECK (grant_kind IN ('standing_approval', 'self_approval_limit')),
  CONSTRAINT chk_standing_grant_status CHECK (status IN ('pending-finance', 'active', 'rejected', 'revoked', 'expired')),
  CONSTRAINT chk_standing_grant_shape CHECK (
    (grant_kind = 'standing_approval' AND limit_amount IS NULL
      AND ((scope_sku IS NOT NULL) <> (scope_item_group_id IS NOT NULL)))
    OR (grant_kind = 'self_approval_limit' AND limit_amount > 0
      AND scope_sku IS NULL AND scope_item_group_id IS NULL AND monthly_qty_cap IS NULL)
  ),
  CONSTRAINT chk_standing_grant_cap CHECK (monthly_qty_cap IS NULL OR monthly_qty_cap > 0),
  CONSTRAINT chk_standing_grant_parties CHECK (grantee_user_id <> assigner_user_id),
  CONSTRAINT chk_standing_grant_revoke_reason CHECK (revoke_reason IS NULL OR revoke_reason IN ('assigner', 'account_disabled'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_standing_grant_item_group' AND conrelid = 'standing_grant'::regclass
  ) THEN
    ALTER TABLE standing_grant
      ADD CONSTRAINT fk_standing_grant_item_group FOREIGN KEY (scope_item_group_id)
        REFERENCES item_group (item_group_id) ON DELETE RESTRICT;
  END IF;
END $$;

-- The hot lookups: a requester's covering grant at raise, and their limit at decision.
CREATE INDEX IF NOT EXISTS idx_standing_grant_active_grantee
  ON standing_grant (grantee_user_id, grant_kind, site_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_standing_grant_assigner ON standing_grant (assigner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_standing_grant_status_end ON standing_grant (status, end_date);

-- Per-assigner pruning cadence (default every 30 days) and the last time the list was sent.
CREATE TABLE IF NOT EXISTS standing_grant_prune_setting (
  assigner_user_id    UUID PRIMARY KEY,
  prune_interval_days INTEGER NOT NULL DEFAULT 30,
  last_prune_sent_at  TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_standing_grant_prune_interval CHECK (prune_interval_days >= 1)
);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON standing_grant TO app_user;
    GRANT INSERT, SELECT, UPDATE ON standing_grant_prune_setting TO app_user;
    GRANT USAGE ON SEQUENCE standing_grant_ref_seq TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON standing_grant TO readonly_user;
    GRANT SELECT ON standing_grant_prune_setting TO readonly_user;
  END IF;
END $$;
