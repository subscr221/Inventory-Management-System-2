-- Job-work ERP billing feed read model (Story 9.6, FR-JW-12). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- The FIRST outbound interface in this codebase with a LIFECYCLE (Binding decision 6): the
-- po_outbound_message / msme_ageing_feed / payment_clearance_feed shapes are append-only records,
-- but AC4 and AC5 demand acknowledgment, a retry window, an exception queue and a reconciliation
-- report, which need mutable status columns. One row per order: uq_job_work_billing_feed_order is
-- AC5's "retries never create duplicate billable events" expressed in the schema (Binding
-- decision 14) - a retry re-sends the SAME row and a second generation collides into 409
-- DUPLICATE_EVENT. The row is created by jobwork.billing_feed_generated, flipped to `acknowledged`
-- by jobwork.billing_feed_acknowledged (the INBOUND command that stamps the order invoiced, Binding
-- decisions 8 and 9), and flipped to `exception` by the retry-window sweep (plain projection UPDATE,
-- the 8.4 retention precedent). There is deliberately NO attempt_count or last_attempt_at: no
-- transmitter exists in this codebase, so nothing would ever write them and a reader would take an
-- always-zero counter for a real retry count. open_to_dispatch_qty is a REPORTING fact captured at
-- generation (Binding decision 18), never a refusal. Money columns are NUMERIC(18,4) in the order's
-- price-basis currency; quantities are NUMERIC(18,3) like every other Epic 9 projection.
--
-- `exception` IS NOT TERMINAL, and that is the correction path (Story 9.6 code review 2026-09-05).
-- The acknowledgment UPDATE guards on `status <> 'acknowledged'`, not on `status = 'pending'`, so a
-- late ERP acknowledgment still rescues a swept feed. There is deliberately NO void or supersede
-- column: void-and-regenerate would mint a SECOND billable line after ERP had already ingested the
-- first, with no void approver anywhere in the acknowledgment SoD chain and a dangling
-- service_order.invoiced_feed_id. A wrong feed is corrected in ERP as a credit note, never by
-- regenerating here. The only reachable transitions are absent to pending, pending to acknowledged,
-- pending to exception, and exception to acknowledged; the sweep filters on status = 'pending'
-- twice, so acknowledged never returns to exception and nothing returns to pending.
--
-- THIS TABLE IS NOT REBUILDABLE by a truncate-and-replay (Story 9.6 code review 2026-09-05, the 8.4
-- retention-sample precedent). The generation applier short-circuits on alreadyPersisted(), which is
-- true for any event already in domain_events, so a replay inserts ZERO rows; and the payload is
-- derived from LIVE projections at generation time, so even a forced replay would re-derive figures
-- against today's dispatch and custody state rather than reproducing the numbers ERP was sent. Treat
-- the rows as durable outbound records: back them up, do not rebuild them.

CREATE TABLE IF NOT EXISTS job_work_billing_feed (
  feed_id               UUID PRIMARY KEY,
  service_order_id      UUID NOT NULL,
  idempotency_key       TEXT NOT NULL,
  payload               JSONB NOT NULL,
  measured_basis        TEXT NOT NULL,
  measured_quantity     NUMERIC(18,3) NOT NULL,
  currency              TEXT NOT NULL,
  total_value           NUMERIC(18,4) NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',
  open_to_dispatch_qty  NUMERIC(18,3) NOT NULL DEFAULT 0,
  first_sent_at         TIMESTAMPTZ NOT NULL,
  acknowledged_at       TIMESTAMPTZ,
  acknowledged_by       UUID,
  acknowledged_ref_ext  TEXT,
  exception_raised_at   TIMESTAMPTZ,
  alert_sent_at         TIMESTAMPTZ,
  site_id               UUID NOT NULL,
  generated_by          UUID NOT NULL,
  source_event_id       UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_job_work_billing_feed_status CHECK (status IN ('pending','acknowledged','exception')),
  CONSTRAINT chk_job_work_billing_feed_basis CHECK (measured_basis IN ('per_piece','per_kg','per_hour','lumpsum')),
  CONSTRAINT chk_job_work_billing_feed_amounts CHECK (
    measured_quantity >= 0 AND total_value >= 0 AND open_to_dispatch_qty >= 0
  ),
  CONSTRAINT chk_job_work_billing_feed_lifecycle CHECK (
    (status = 'acknowledged') = (
      acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL AND acknowledged_ref_ext IS NOT NULL
    )
    AND (status <> 'exception' OR exception_raised_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_work_billing_feed_order ON job_work_billing_feed (service_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_work_billing_feed_source_event ON job_work_billing_feed (source_event_id);
CREATE INDEX IF NOT EXISTS idx_job_work_billing_feed_sweep ON job_work_billing_feed (status, first_sent_at);
-- Story 9.6 code review 2026-09-05: acknowledged_ref_ext is a CITATION of an ERP document, not the
-- identity of this row, so it follows the plainly-indexed reference_ext / grn.invoice_number_ext
-- precedent and is deliberately NOT unique - one consolidated ERP invoice may legitimately
-- acknowledge several job-work orders. The index serves the reconciliation report's duplicate-ref
-- lookup. site_id is indexed because both the AC4 reconciliation report and the coordinator alert
-- are site-scoped reads.
CREATE INDEX IF NOT EXISTS idx_job_work_billing_feed_ack_ref ON job_work_billing_feed (acknowledged_ref_ext);
CREATE INDEX IF NOT EXISTS idx_job_work_billing_feed_site ON job_work_billing_feed (site_id);

-- Story 9.6 code review 2026-09-05: DROP-then-ADD, not add-if-absent (the bom_line
-- chk_bom_line_supply_method precedent). An add-if-absent guard sees the OLD constraint present and
-- silently skips the ALTER, so a future fourth status or fifth measured_basis would keep being
-- rejected on every already-migrated database while this file claimed otherwise.
DO $$
BEGIN
  ALTER TABLE job_work_billing_feed DROP CONSTRAINT IF EXISTS chk_job_work_billing_feed_status;
  ALTER TABLE job_work_billing_feed
    ADD CONSTRAINT chk_job_work_billing_feed_status CHECK (status IN ('pending','acknowledged','exception'));
  ALTER TABLE job_work_billing_feed DROP CONSTRAINT IF EXISTS chk_job_work_billing_feed_basis;
  ALTER TABLE job_work_billing_feed
    ADD CONSTRAINT chk_job_work_billing_feed_basis CHECK (measured_basis IN ('per_piece','per_kg','per_hour','lumpsum'));
  ALTER TABLE job_work_billing_feed DROP CONSTRAINT IF EXISTS chk_job_work_billing_feed_amounts;
  ALTER TABLE job_work_billing_feed
    ADD CONSTRAINT chk_job_work_billing_feed_amounts CHECK (
      measured_quantity >= 0 AND total_value >= 0 AND open_to_dispatch_qty >= 0
    );
  ALTER TABLE job_work_billing_feed DROP CONSTRAINT IF EXISTS chk_job_work_billing_feed_lifecycle;
  ALTER TABLE job_work_billing_feed
    ADD CONSTRAINT chk_job_work_billing_feed_lifecycle CHECK (
      (status = 'acknowledged') = (
        acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL AND acknowledged_ref_ext IS NOT NULL
      )
      AND (status <> 'exception' OR exception_raised_at IS NOT NULL)
    );
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON job_work_billing_feed TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON job_work_billing_feed TO readonly_user;
  END IF;
END $$;
