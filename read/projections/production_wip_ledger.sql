-- Production WIP ledger read model (Story 6.2, FR-MO-05/06, AD-5). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY, and APPEND-ONLY by construction: rows are rebuildable by replaying the
-- production_order.material_issued / confirmation_recorded / material_returned domain events, and
-- mutation happens exclusively through persistEvent, which applies this projection inside the SAME
-- transaction as the domain_events insert. Posting rows are never deleted or rewritten.
--
-- NOTE on the UPDATE grant (recorded deviation, 2026-08-28): the story's Table 2 says "INSERT,
-- SELECT only (append-only - the 7.7 precedent)". The Applier Contract overrides that line: AC6
-- requires a return to close its source posting, which the Counter Contract implements by
-- DECREMENTING open_quantity on the source issue/backflush row in the return's transaction - a
-- real UPDATE, and one the SELECT ... FOR UPDATE lock on the source posting also requires
-- (PostgreSQL refuses FOR UPDATE without UPDATE privilege). The rows stay append-only (never
-- deleted, never rewritten); only the open_quantity counter is decremented, and only by the seam
-- inside persistEvent. Granting UPDATE is the smallest change that satisfies AC5/AC6 and the
-- 6.1 cancel-guard contract.
--
-- One posting per DRAINED BALANCE ROW, not per requirement line (Binding Decision 7): a backflush
-- line can drain several bins/lots, and AC5 requires a return to restore the ORIGINAL lot identity,
-- which is only exact when each posting carries one (location, lot) grain. Issue/backflush postings
-- carry open_quantity (decremented by returns in the return posting's transaction); return postings
-- carry NULL open_quantity and reference their source posting. The pairing CHECK makes a return
-- without source_posting_id + reason_code structurally impossible, and an issue/backflush with
-- either structurally impossible.
--
-- The WIP read (AC4) is computed: net open quantity = SUM(open_quantity) over non-return postings;
-- net open value = SUM(open_quantity * unit_cost) in SQL NUMERIC. A Closed-order zero-WIP check
-- (Story 6.4's closure gate) will read the same accessor.

CREATE TABLE IF NOT EXISTS production_wip_ledger (
  posting_id           UUID PRIMARY KEY,
  production_order_id  UUID NOT NULL,
  posting_type         TEXT NOT NULL,
  bom_line_id          UUID NOT NULL,
  component_item_id    UUID NOT NULL,
  component_sku        TEXT NOT NULL,
  lot_number           TEXT,
  source_location_id   UUID NOT NULL,
  quantity             NUMERIC(18,6) NOT NULL,
  open_quantity        NUMERIC(18,6),
  unit_cost            NUMERIC(14,3) NOT NULL,
  posting_value        NUMERIC(14,3) NOT NULL,
  reason_code          TEXT,
  source_posting_id    UUID,
  source_event_id      UUID NOT NULL,
  occurred_at          TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_production_wip_posting_type CHECK (posting_type IN ('directed_issue','backflush','return','completion_relief','scrap_relief')),
  CONSTRAINT chk_production_wip_quantity_positive CHECK (quantity > 0),
  CONSTRAINT chk_production_wip_open_non_negative CHECK (open_quantity IS NULL OR open_quantity >= 0),
  CONSTRAINT chk_production_wip_posting_pairing CHECK (
    (posting_type = 'return' AND source_posting_id IS NOT NULL AND reason_code IS NOT NULL AND open_quantity IS NULL)
    OR
    (posting_type = 'scrap_relief' AND source_posting_id IS NOT NULL AND reason_code IS NOT NULL AND open_quantity IS NULL)
    OR
    (posting_type = 'completion_relief' AND source_posting_id IS NOT NULL AND reason_code IS NULL AND open_quantity IS NULL)
    OR
    (posting_type IN ('directed_issue','backflush') AND source_posting_id IS NULL AND reason_code IS NULL AND open_quantity IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_production_wip_ledger_order ON production_wip_ledger (production_order_id);
CREATE INDEX IF NOT EXISTS idx_production_wip_ledger_source_posting ON production_wip_ledger (source_posting_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_wip_posting_type'
      AND conrelid = 'production_wip_ledger'::regclass
  ) THEN
    ALTER TABLE production_wip_ledger
      ADD CONSTRAINT chk_production_wip_posting_type CHECK (posting_type IN ('directed_issue','backflush','return','completion_relief','scrap_relief'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_wip_quantity_positive'
      AND conrelid = 'production_wip_ledger'::regclass
  ) THEN
    ALTER TABLE production_wip_ledger
      ADD CONSTRAINT chk_production_wip_quantity_positive CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_wip_open_non_negative'
      AND conrelid = 'production_wip_ledger'::regclass
  ) THEN
    ALTER TABLE production_wip_ledger
      ADD CONSTRAINT chk_production_wip_open_non_negative CHECK (open_quantity IS NULL OR open_quantity >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_wip_posting_pairing'
      AND conrelid = 'production_wip_ledger'::regclass
  ) THEN
    ALTER TABLE production_wip_ledger
      ADD CONSTRAINT chk_production_wip_posting_pairing CHECK (
        (posting_type = 'return' AND source_posting_id IS NOT NULL AND reason_code IS NOT NULL AND open_quantity IS NULL)
        OR
        (posting_type = 'scrap_relief' AND source_posting_id IS NOT NULL AND reason_code IS NOT NULL AND open_quantity IS NULL)
        OR
        (posting_type = 'completion_relief' AND source_posting_id IS NOT NULL AND reason_code IS NULL AND open_quantity IS NULL)
        OR
        (posting_type IN ('directed_issue','backflush') AND source_posting_id IS NULL AND reason_code IS NULL AND open_quantity IS NOT NULL)
      );
  END IF;
END $$;

-- Story 6.3 (FR-MO-07/08) constraint widening. On a database provisioned BEFORE this story both
-- constraints already exist carrying the narrow Story 6.2 definitions, and an add-if-missing guard
-- cannot upgrade a constraint that already exists: they must be DROPPED first.
--
-- Code review 2026-08-31: the inline CREATE TABLE pairing CHECK and the add-if-missing guards above
-- were still stating the narrow Story 6.2 definitions, so this file carried two conflicting
-- authoritative texts under one constraint name. That was not cosmetic. The add-if-missing guard
-- runs BEFORE this block, so against a database where the constraint had been dropped while
-- completion_relief or scrap_relief rows already existed, it re-added the NARROW definition, failed
-- validation with check_violation and aborted the whole file before the widening could run. All
-- three copies now state the widened definition; this block remains because it is the only thing
-- that upgrades a database still carrying the narrow constraint from Story 6.2. The drop is itself guarded on the
-- constraint text, so re-applying this file to an already-upgraded database is a no-op.
--
-- 'completion_relief' and 'scrap_relief' are the two new relief postings. Like a return they close
-- open WIP on a named source posting (source_posting_id NOT NULL, open_quantity NULL) at that
-- posting's issued unit cost; unlike a return they move no stock. A scrap relief carries the
-- operator's reason code, a completion relief does not (the completion event is its own reason).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_wip_posting_type'
      AND conrelid = 'production_wip_ledger'::regclass
      AND (pg_get_constraintdef(oid) NOT LIKE '%completion_relief%'
        OR pg_get_constraintdef(oid) NOT LIKE '%scrap_relief%')
  ) THEN
    ALTER TABLE production_wip_ledger DROP CONSTRAINT chk_production_wip_posting_type;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_wip_posting_type'
      AND conrelid = 'production_wip_ledger'::regclass
  ) THEN
    ALTER TABLE production_wip_ledger
      ADD CONSTRAINT chk_production_wip_posting_type CHECK (posting_type IN ('directed_issue','backflush','return','completion_relief','scrap_relief'));
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_wip_posting_pairing'
      AND conrelid = 'production_wip_ledger'::regclass
      AND (pg_get_constraintdef(oid) NOT LIKE '%completion_relief%'
        OR pg_get_constraintdef(oid) NOT LIKE '%scrap_relief%')
  ) THEN
    ALTER TABLE production_wip_ledger DROP CONSTRAINT chk_production_wip_posting_pairing;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_production_wip_posting_pairing'
      AND conrelid = 'production_wip_ledger'::regclass
  ) THEN
    ALTER TABLE production_wip_ledger
      ADD CONSTRAINT chk_production_wip_posting_pairing CHECK (
        (posting_type = 'return' AND source_posting_id IS NOT NULL AND reason_code IS NOT NULL AND open_quantity IS NULL)
        OR
        (posting_type = 'scrap_relief' AND source_posting_id IS NOT NULL AND reason_code IS NOT NULL AND open_quantity IS NULL)
        OR
        (posting_type = 'completion_relief' AND source_posting_id IS NOT NULL AND reason_code IS NULL AND open_quantity IS NULL)
        OR
        (posting_type IN ('directed_issue','backflush') AND source_posting_id IS NULL AND reason_code IS NULL AND open_quantity IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON production_wip_ledger TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON production_wip_ledger TO readonly_user;
  END IF;
END $$;
