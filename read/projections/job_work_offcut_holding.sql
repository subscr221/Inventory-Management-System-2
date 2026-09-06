-- Job-work offcut holding ledger (Story 9.6 revised, FR-JW-09/10). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- WHY THIS TABLE EXISTS (sprint change proposal 2026-09-05, which reversed the original 9.6 model).
-- Contractual offcut is its OWN asset with its own contract, not a clause settled on the service
-- order. It is captured here UNVALUED and retained until its fate is actually known; the
-- disposition and the rate are decided later by the finance controller (Story 9.7). Nothing in this
-- table carries money: a rate written at capture would be a guess, and the whole point of the
-- ruling is that no such guess is made.
--
-- THE OWNERSHIP TENSION, STATED PLAINLY because it is counterintuitive and load-bearing. Capture
-- DRAINS the custody ledger so `customerCustodyBalance` reaches zero and the Story 9.5 closure gate
-- stays reachable: the service is finished and the order must be allowed to close. But the material
-- is still the CUSTOMER'S until disposal - ownership "depends on disposition" and disposition is
-- unknown, so the model is fail-closed - and the CGST Section 143 return clock therefore KEEPS
-- RUNNING against it. The custody ledger says the order's obligation is closed; THIS table is where
-- the real, still-open obligation lives. Any deemed-supply sweep, ITC-04 extract or job-work ageing
-- report must read this table as well as jobwork_return_clock, or long-held offcut is invisible
-- exposure. That is Story 9.7's AC, and it is the single most important consumer of this table.
--
-- The physical stock stays segregated in its own `offcut` stock class (customer-owned, laundering
-- barred exactly like `job_work`), so material awaiting a disposal decision is separable from
-- material still in process on the shop floor.
--
-- disposed_at, disposition and disposal_event_id are FORWARD-DECLARED for Story 9.7 (the Story 9.3
-- movement-category precedent): nothing in Story 9.6 writes them, and the lifecycle they express is
-- the reason this table is a ledger rather than a log. `disposition` is closed at two values -
-- `returned` (back to the customer as their own property, no title transfer) and `acquired` (the
-- processor buys it, title transfers). Onward resale, whether a buy-back by the originating
-- customer, a scrap buyer or an auction, is an ordinary sale of stock the processor already owns
-- and is deliberately NOT modelled here.

CREATE TABLE IF NOT EXISTS job_work_offcut_holding (
  holding_id               UUID PRIMARY KEY,
  service_order_id         UUID NOT NULL,
  customer_party_code      TEXT NOT NULL,
  offcut_contract_ref_ext  TEXT,
  sku                      TEXT NOT NULL,
  lot_id                   TEXT NOT NULL,
  source_lot_id            TEXT NOT NULL,
  location_id              UUID NOT NULL,
  quantity                 NUMERIC(18,3) NOT NULL,
  uom                      TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'retained',
  captured_at              TIMESTAMPTZ NOT NULL,
  business_date            DATE NOT NULL,
  disposed_at              TIMESTAMPTZ,
  disposition              TEXT,
  disposal_event_id        UUID,
  site_id                  UUID NOT NULL,
  captured_by              UUID NOT NULL,
  source_event_id          UUID NOT NULL,
  correlation_id           UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_job_work_offcut_holding_status CHECK (status IN ('retained','disposed')),
  CONSTRAINT chk_job_work_offcut_holding_quantity CHECK (quantity > 0),
  CONSTRAINT chk_job_work_offcut_holding_disposition CHECK (
    disposition IS NULL OR disposition IN ('returned','acquired')
  ),
  CONSTRAINT chk_job_work_offcut_holding_lifecycle CHECK (
    (status = 'disposed') = (
      disposed_at IS NOT NULL AND disposition IS NOT NULL AND disposal_event_id IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_work_offcut_holding_source_event ON job_work_offcut_holding (source_event_id);
CREATE INDEX IF NOT EXISTS idx_job_work_offcut_holding_order ON job_work_offcut_holding (service_order_id);
-- The ageing and deemed-supply reads: every still-retained row oldest first.
CREATE INDEX IF NOT EXISTS idx_job_work_offcut_holding_retained ON job_work_offcut_holding (status, captured_at);
CREATE INDEX IF NOT EXISTS idx_job_work_offcut_holding_site ON job_work_offcut_holding (site_id);

-- DROP-then-ADD, not add-if-absent (the bom_line chk_bom_line_supply_method precedent): an
-- add-if-absent guard sees the OLD constraint present and silently skips the ALTER, so widening the
-- disposition vocabulary later would keep being rejected on every already-migrated database while
-- this file claimed otherwise.
DO $$
BEGIN
  ALTER TABLE job_work_offcut_holding DROP CONSTRAINT IF EXISTS chk_job_work_offcut_holding_status;
  ALTER TABLE job_work_offcut_holding
    ADD CONSTRAINT chk_job_work_offcut_holding_status CHECK (status IN ('retained','disposed'));
  ALTER TABLE job_work_offcut_holding DROP CONSTRAINT IF EXISTS chk_job_work_offcut_holding_quantity;
  ALTER TABLE job_work_offcut_holding
    ADD CONSTRAINT chk_job_work_offcut_holding_quantity CHECK (quantity > 0);
  ALTER TABLE job_work_offcut_holding DROP CONSTRAINT IF EXISTS chk_job_work_offcut_holding_disposition;
  ALTER TABLE job_work_offcut_holding
    ADD CONSTRAINT chk_job_work_offcut_holding_disposition CHECK (
      disposition IS NULL OR disposition IN ('returned','acquired')
    );
  ALTER TABLE job_work_offcut_holding DROP CONSTRAINT IF EXISTS chk_job_work_offcut_holding_lifecycle;
  ALTER TABLE job_work_offcut_holding
    ADD CONSTRAINT chk_job_work_offcut_holding_lifecycle CHECK (
      (status = 'disposed') = (
        disposed_at IS NOT NULL AND disposition IS NOT NULL AND disposal_event_id IS NOT NULL
      )
    );
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON job_work_offcut_holding TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON job_work_offcut_holding TO readonly_user;
  END IF;
END $$;
