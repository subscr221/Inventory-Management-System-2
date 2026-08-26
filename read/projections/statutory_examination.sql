-- Statutory examination register (Story 7.6, FR-M-14, AD-9). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: rows are rebuildable by replaying maintenance.statutory_examination_recorded,
-- maintenance.statutory_examination_overdue AND maintenance.work_order_completed domain events;
-- mutation happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert. work_order_completed belongs in that replay set because
-- the Binding Decision 6 stamp invalidation flips a weighbridge row to 'overdue' from the work
-- order applier, with no statutory event of its own: a rebuild that omits it resurrects every
-- work-order-invalidated stamp as 'compliant' and silently unlocks the device for trade weighment.
--
-- A statutory subject IS an asset (AD-9): asset_id references the single Story 7.1 register. The
-- grain is (asset_id, examination_type), so one asset carries at most one OSH Code examination and
-- at most one weighbridge legal-metrology stamp. The weighbridge device_id (free text on
-- weighbridge_event) is mapped via device_key, canonicalized with lower() to match the Story 7.1
-- asset-tag and Story 7.5 instrument-id precedent: a case variant of a registered device key is the
-- same physical weighbridge.
--
-- status is the lockout flag the Story 7.6 gates read: 'compliant' allows use, 'overdue' locks the
-- asset from use (AC1) and blocks trade weighment on the device (AC2). It is written only by the
-- examination applier and the overdue scan; no other surface flips it.

CREATE TABLE IF NOT EXISTS statutory_examination (
  examination_id    UUID PRIMARY KEY,
  asset_id          UUID NOT NULL,
  examination_type  TEXT NOT NULL,
  interval_months   INTEGER NOT NULL,
  next_due_date     DATE NOT NULL,
  status            TEXT NOT NULL DEFAULT 'compliant',
  device_key        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_statutory_examination_asset_type UNIQUE (asset_id, examination_type),
  CONSTRAINT chk_statutory_examination_type CHECK (examination_type IN ('osh_code', 'weighbridge_legal_metrology')),
  CONSTRAINT chk_statutory_examination_status CHECK (status IN ('compliant', 'overdue')),
  CONSTRAINT chk_statutory_examination_interval CHECK (interval_months > 0 AND interval_months <= 120)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_statutory_examination_device_key ON statutory_examination (lower(device_key)) WHERE device_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_statutory_examination_status_due ON statutory_examination (status, next_due_date);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_statutory_examination_asset_type'
      AND conrelid = 'statutory_examination'::regclass
  ) THEN
    ALTER TABLE statutory_examination
      ADD CONSTRAINT uq_statutory_examination_asset_type UNIQUE (asset_id, examination_type);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_statutory_examination_type'
      AND conrelid = 'statutory_examination'::regclass
  ) THEN
    ALTER TABLE statutory_examination
      ADD CONSTRAINT chk_statutory_examination_type CHECK (examination_type IN ('osh_code', 'weighbridge_legal_metrology'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_statutory_examination_status'
      AND conrelid = 'statutory_examination'::regclass
  ) THEN
    ALTER TABLE statutory_examination
      ADD CONSTRAINT chk_statutory_examination_status CHECK (status IN ('compliant', 'overdue'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_statutory_examination_interval'
      AND conrelid = 'statutory_examination'::regclass
  ) THEN
    ALTER TABLE statutory_examination
      ADD CONSTRAINT chk_statutory_examination_interval CHECK (interval_months > 0 AND interval_months <= 120);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON statutory_examination TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON statutory_examination TO readonly_user;
  END IF;
END $$;
