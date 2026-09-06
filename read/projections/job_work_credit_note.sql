-- Job-work offcut credit notes (Story 9.7, FR-JW-09/10, FR-JW-12). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- WHAT A CREDIT NOTE IS HERE. When the processor ACQUIRES contractual offcut, title transfers and
-- the processor owes the customer the acquisition value. That value is billed as a CREDIT NOTE
-- against the service invoice already raised for the order - never as a line on the service billing
-- feed, which the 2026-09-05 reversal deliberately stopped waiting for the offcut so that finished
-- work invoices on time. `cited_invoice_ref_ext` is the ERP document reference of that service
-- invoice, taken from job_work_billing_feed.acknowledged_ref_ext.
--
-- THAT CITATION IS NOT AN IDENTITY. The 9.6 code review ruled acknowledged_ref_ext deliberately
-- NON-unique because one consolidated ERP invoice may legitimately cover several job-work orders,
-- and this table is the first consumer of that ruling. Both `cited_invoice_ref_ext` and this
-- table's own `acknowledged_ref_ext` are therefore PLAINLY indexed, never uniquely: tightening
-- either would refuse a legitimate consolidated document.
--
-- CORRECTIONS ARE DELTAS, NEVER MUTATIONS (AC 5, the 9.6 feed-header ruling carried forward). A
-- revalued acquisition raises a second row with document_kind = 'delta', supersedes_credit_note_id
-- pointing at the row it corrects and delta_value carrying the SIGNED difference (negative when the
-- rate is revised down). The original is never updated and an acknowledged delta is never updated
-- either: once ERP has ingested a document, changing it here would silently disagree with the
-- customer's books. A second revaluation chains off the LATEST delta. There is deliberately no
-- `void` and no `exception` state - `pending` and `acknowledged` are the whole lifecycle.
--
-- THE ACKNOWLEDGMENT IS THE CONTROL OVER THE RATE (AC 6). The 2026-09-05 ruling removed the rate
-- tolerance band, so nothing arithmetic constrains what the finance controller may write as the
-- acquisition rate. What constrains it is that the person who set the rate (`valued_by`) may not
-- acknowledge the document that bills it; the applier refuses SOD_VIOLATION. That guard carries the
-- entire control and must not be weakened or made configurable.

CREATE TABLE IF NOT EXISTS job_work_credit_note (
  credit_note_id            UUID PRIMARY KEY,
  service_order_id          UUID NOT NULL,
  holding_id                UUID NOT NULL,
  document_kind             TEXT NOT NULL,
  supersedes_credit_note_id UUID,
  cited_invoice_ref_ext     TEXT NOT NULL,
  rate                      NUMERIC(18,4) NOT NULL,
  indicative_rate           NUMERIC(18,4),
  currency                  TEXT NOT NULL,
  value                     NUMERIC(18,4) NOT NULL,
  delta_value               NUMERIC(18,4),
  status                    TEXT NOT NULL DEFAULT 'pending',
  acknowledged_at           TIMESTAMPTZ,
  acknowledged_by           UUID,
  acknowledged_ref_ext      TEXT,
  valued_by                 UUID NOT NULL,
  site_id                   UUID NOT NULL,
  source_event_id           UUID NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_job_work_credit_note_kind CHECK (document_kind IN ('original','delta')),
  CONSTRAINT chk_job_work_credit_note_status CHECK (status IN ('pending','acknowledged')),
  CONSTRAINT chk_job_work_credit_note_chain CHECK (
    (document_kind = 'delta') = (supersedes_credit_note_id IS NOT NULL AND delta_value IS NOT NULL)
  ),
  -- Chunk B code review 2026-09-06: the biconditional used to pass for a `pending` row carrying ONE
  -- or TWO of the ack stamps, and nothing prevented an acknowledgment predating the document. The
  -- lifecycle is now all-or-nothing per status, and an acknowledgment can only post-date its row.
  CONSTRAINT chk_job_work_credit_note_lifecycle CHECK (
    (status = 'pending' AND acknowledged_at IS NULL AND acknowledged_by IS NULL
      AND acknowledged_ref_ext IS NULL)
    OR (status = 'acknowledged' AND acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL
      AND acknowledged_ref_ext IS NOT NULL AND acknowledged_at >= created_at)
  ),
  -- BSD-5 says zero is the free-retention floor, so an acquisition money leg is never negative
  -- (chunk B code review 2026-09-06). delta_value stays SIGNED: a downward revaluation is a
  -- negative correction, that is its whole purpose.
  CONSTRAINT chk_job_work_credit_note_money CHECK (rate >= 0 AND value >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_work_credit_note_source_event ON job_work_credit_note (source_event_id);
CREATE INDEX IF NOT EXISTS idx_job_work_credit_note_order ON job_work_credit_note (service_order_id);
CREATE INDEX IF NOT EXISTS idx_job_work_credit_note_holding ON job_work_credit_note (holding_id);
-- Both reference columns are CITATIONS of ERP documents, not identities of these rows: one
-- consolidated ERP invoice may be cited by several credit notes, and one ERP credit-note number may
-- acknowledge several of these rows. Plain indexes, never unique (the 9.6 group-A ruling).
CREATE INDEX IF NOT EXISTS idx_job_work_credit_note_cited_ref ON job_work_credit_note (cited_invoice_ref_ext);
CREATE INDEX IF NOT EXISTS idx_job_work_credit_note_ack_ref ON job_work_credit_note (acknowledged_ref_ext);
CREATE INDEX IF NOT EXISTS idx_job_work_credit_note_site ON job_work_credit_note (site_id);

-- DROP-then-ADD, not add-if-absent (the bom_line chk_bom_line_supply_method precedent): an
-- add-if-absent guard sees the OLD constraint present and silently skips the ALTER, so any future
-- widening would keep being rejected on every already-migrated database while this file claimed
-- otherwise.
DO $$
BEGIN
  ALTER TABLE job_work_credit_note DROP CONSTRAINT IF EXISTS chk_job_work_credit_note_kind;
  ALTER TABLE job_work_credit_note
    ADD CONSTRAINT chk_job_work_credit_note_kind CHECK (document_kind IN ('original','delta'));
  ALTER TABLE job_work_credit_note DROP CONSTRAINT IF EXISTS chk_job_work_credit_note_status;
  ALTER TABLE job_work_credit_note
    ADD CONSTRAINT chk_job_work_credit_note_status CHECK (status IN ('pending','acknowledged'));
  ALTER TABLE job_work_credit_note DROP CONSTRAINT IF EXISTS chk_job_work_credit_note_chain;
  ALTER TABLE job_work_credit_note
    ADD CONSTRAINT chk_job_work_credit_note_chain CHECK (
      (document_kind = 'delta') = (supersedes_credit_note_id IS NOT NULL AND delta_value IS NOT NULL)
    );
  ALTER TABLE job_work_credit_note DROP CONSTRAINT IF EXISTS chk_job_work_credit_note_lifecycle;
  ALTER TABLE job_work_credit_note
    ADD CONSTRAINT chk_job_work_credit_note_lifecycle CHECK (
      (status = 'pending' AND acknowledged_at IS NULL AND acknowledged_by IS NULL
        AND acknowledged_ref_ext IS NULL)
      OR (status = 'acknowledged' AND acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL
        AND acknowledged_ref_ext IS NOT NULL AND acknowledged_at >= created_at)
    );
  ALTER TABLE job_work_credit_note DROP CONSTRAINT IF EXISTS chk_job_work_credit_note_money;
  ALTER TABLE job_work_credit_note
    ADD CONSTRAINT chk_job_work_credit_note_money CHECK (rate >= 0 AND value >= 0);
  -- A delta must point at a REAL document; the same-holding/order binding is enforced by the
  -- revaluation applier under the order advisory lock (a cross-row CHECK cannot express it).
  ALTER TABLE job_work_credit_note DROP CONSTRAINT IF EXISTS fk_job_work_credit_note_supersedes;
  ALTER TABLE job_work_credit_note
    ADD CONSTRAINT fk_job_work_credit_note_supersedes
      FOREIGN KEY (supersedes_credit_note_id) REFERENCES job_work_credit_note(credit_note_id);
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON job_work_credit_note TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON job_work_credit_note TO readonly_user;
  END IF;
END $$;
