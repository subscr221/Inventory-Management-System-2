-- Job-work statutory return clock read model (Story 9.5, FR-AC-11, FR-JW-14). This file is the
-- CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY: exactly one clock row per jobwork_material_receipt row (1:1, receipt_id is
-- FK-shaped, not an FK - the Story 9.1 BSD-8 rebuildable-projection idiom), inserted by the Story
-- 9.2 receipt applier in the SAME transaction as the receipt (Binding decision 1: the receipt is
-- 9.2's immutable capture of what arrived; the clock is the mutable statutory lifecycle row).
--
-- CGST Section 143(1): inputs sent to a job worker must come back (or be supplied from the job
-- worker's premises) within ONE year of the challan date, capital goods within THREE years;
-- otherwise the original dispatch is deemed a supply on the day the goods went out. expiry_date is
-- computed in SQL as challan_date + 365 / 1095 calendar days by challan_class, never by JS Date
-- arithmetic across DST/timezone (the 9.1 DATE-vs-timezone gotcha).
--
-- Two counters on purpose (Binding decision 6): reconciled_qty is material that went BACK to the
-- principal (dispatch, return, forward-declared offcut); loss_qty is waste and scrap accounted
-- under Section 143(5) - reported in its own ITC-04 column, never deemed supply. Consumption into
-- WIP moves NEITHER counter: the bracket is still on the job worker's floor and the clock is still
-- running. deemed_supply_qty is frozen at breach time (challan - reconciled - loss on the day the
-- limit passed); a late reconciliation against a breached clock reduces the outstanding capacity
-- but never rewrites the recorded deemed supply.
--
-- alert_90_sent_at / alert_30_sent_at are the two GLOBAL lead-day stage stamps (Story 9.5 Open
-- question 5): the sweep is single-pass, tightest-stage-wins, so a clock first seen inside the
-- 30-day window fires ONE alert and sets BOTH stamps. Named so per-class knobs slot in later.

CREATE TABLE IF NOT EXISTS jobwork_return_clock (
  clock_id                  UUID PRIMARY KEY,
  receipt_id                UUID NOT NULL,
  service_order_id          UUID NOT NULL,
  sku                       TEXT NOT NULL,
  challan_qty               NUMERIC(18,3) NOT NULL,
  reconciled_qty            NUMERIC(18,3) NOT NULL DEFAULT 0,
  loss_qty                  NUMERIC(18,3) NOT NULL DEFAULT 0,
  challan_class             TEXT NOT NULL,
  challan_date              DATE NOT NULL,
  expiry_date               DATE NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'open',
  deemed_supply_qty         NUMERIC(18,3) NOT NULL DEFAULT 0,
  deemed_supply_recorded_at TIMESTAMPTZ,
  alert_90_sent_at          TIMESTAMPTZ,
  alert_30_sent_at          TIMESTAMPTZ,
  site_id                   UUID NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_jobwork_return_clock_class CHECK (challan_class IN ('input','capital_goods')),
  CONSTRAINT chk_jobwork_return_clock_status CHECK (status IN ('open','partially_reconciled','reconciled','breached')),
  CONSTRAINT chk_jobwork_return_clock_counters CHECK (
    reconciled_qty >= 0 AND loss_qty >= 0 AND deemed_supply_qty >= 0
    AND reconciled_qty + loss_qty <= challan_qty
  ),
  CONSTRAINT chk_jobwork_return_clock_expiry CHECK (expiry_date > challan_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_jobwork_return_clock_receipt ON jobwork_return_clock (receipt_id);
CREATE INDEX IF NOT EXISTS idx_jobwork_return_clock_order_sku ON jobwork_return_clock (service_order_id, sku, challan_date, created_at);
CREATE INDEX IF NOT EXISTS idx_jobwork_return_clock_sweep ON jobwork_return_clock (status, expiry_date);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_jobwork_return_clock_class'
      AND conrelid = 'jobwork_return_clock'::regclass
  ) THEN
    ALTER TABLE jobwork_return_clock
      ADD CONSTRAINT chk_jobwork_return_clock_class CHECK (challan_class IN ('input','capital_goods'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_jobwork_return_clock_status'
      AND conrelid = 'jobwork_return_clock'::regclass
  ) THEN
    ALTER TABLE jobwork_return_clock
      ADD CONSTRAINT chk_jobwork_return_clock_status CHECK (status IN ('open','partially_reconciled','reconciled','breached'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_jobwork_return_clock_counters'
      AND conrelid = 'jobwork_return_clock'::regclass
  ) THEN
    ALTER TABLE jobwork_return_clock
      ADD CONSTRAINT chk_jobwork_return_clock_counters CHECK (
        reconciled_qty >= 0 AND loss_qty >= 0 AND deemed_supply_qty >= 0
        AND reconciled_qty + loss_qty <= challan_qty
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_jobwork_return_clock_expiry'
      AND conrelid = 'jobwork_return_clock'::regclass
  ) THEN
    ALTER TABLE jobwork_return_clock
      ADD CONSTRAINT chk_jobwork_return_clock_expiry CHECK (expiry_date > challan_date);
  END IF;
END $$;

-- Story 9.5 code review (chunk 1): BACKFILL. The 1:1 invariant above holds only for receipts taken
-- after this file first ran. On a database already carrying Story 9.2 or 9.4 receipts those challans
-- would be invisible to the sweep, to ITC-04 and to the aging report, and a return posted against one
-- would be refused by reconcileReturnClocks's strict mode for want of clock capacity - and they are
-- the OLDEST challans, the ones nearest their Section 143 limit. challan_class is read from the
-- receipt (which defaults it to 'input'), and expiry is computed by the same SQL date arithmetic the
-- insert path uses. NOT EXISTS on receipt_id makes every later apply a no-op (migrate-twice
-- idempotency), and this file runs after jobwork_material_receipt.sql in src/events/migrate.ts, so
-- challan_class is always present by the time this statement executes.
INSERT INTO jobwork_return_clock (
  clock_id, receipt_id, service_order_id, sku, challan_qty, challan_class, challan_date, expiry_date,
  site_id
)
SELECT gen_random_uuid(),
       r.receipt_id,
       r.service_order_id,
       r.sku,
       r.challan_qty,
       r.challan_class,
       r.challan_date,
       (r.challan_date + make_interval(days => CASE WHEN r.challan_class = 'capital_goods' THEN 1095 ELSE 365 END))::date,
       r.site_id
  FROM jobwork_material_receipt r
 WHERE NOT EXISTS (
   SELECT 1 FROM jobwork_return_clock c WHERE c.receipt_id = r.receipt_id
 );

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON jobwork_return_clock TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON jobwork_return_clock TO readonly_user;
  END IF;
END $$;
