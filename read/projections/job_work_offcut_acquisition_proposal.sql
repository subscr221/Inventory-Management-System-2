-- Job-work offcut ACQUISITION PROPOSAL (Story 9.8, extends Story 9.7 AC 7). This file is the
-- CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- WHY THIS TABLE EXISTS. Story 9.7 shipped the DOA second signature on an above-band offcut
-- acquisition as a SINGLE event: the finance controller posting the disposal named an `approved_by`
-- that had to match resolveApprover's output. That is not an authenticated CFO action - it is the
-- poster asserting a string, and knowing the right UUID was the whole control. This table is the
-- persisted middle state that makes the second signature real: the acquisition is PROPOSED here and
-- nothing happens to the stock, the lot, the credit note or the Section 143 clock until the RESOLVED
-- approver approves it through their own authenticated request. The shape is ported verbatim from
-- the Story 2.5 transfer-request `pending_approval` precedent.
--
-- THE PROPOSAL FREEZES WHO WAS RESOLVED (the transfer-request precedent again). resolveApprover runs
-- ONCE, at propose time, and `resolved_approver_actor_id` is stored. It is never re-resolved at
-- approve time: the band, the role holder and any active delegation could all shift in between, and
-- re-resolving would silently move the signature to somebody the proposal never named.
--
-- DUAL CONTROL IS A COLUMN CONSTRAINT, not only an applier check (BSD-10, inverted against the
-- Story 9.4 over-norm-loss chain where the acting user must EQUAL the approver). The finance
-- controller prices the offcut and the CFO approves paying for it, so a row whose proposer IS its
-- resolved approver is not a proposal that merely gets refused later - it is not representable.
--
-- ONE PENDING PROPOSAL PER HOLDING (AC 4). The partial unique index is what refuses a second,
-- competing proposal for the same offcut while one is still awaiting signature; a client posting
-- one gets a schema-derived DUPLICATE_EVENT rather than two proposals racing to approve the same
-- holding. `superseded` is reserved for a future withdrawal path - nothing in Story 9.8 writes it,
-- and the lifecycle CHECK keeps it honest if something ever does.

CREATE TABLE IF NOT EXISTS job_work_offcut_acquisition_proposal (
  proposal_id                UUID PRIMARY KEY,
  service_order_id           UUID NOT NULL,
  holding_id                 UUID NOT NULL,
  site_id                    UUID NOT NULL,
  rate                       NUMERIC(18,4) NOT NULL,
  currency                   TEXT NOT NULL,
  indicative_rate            NUMERIC(18,4),
  proposed_value             NUMERIC(18,4) NOT NULL,
  doa_entry_id               UUID NOT NULL,
  resolved_approver_actor_id UUID NOT NULL,
  proposed_by                UUID NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'pending',
  decided_at                 TIMESTAMPTZ,
  decided_by                 UUID,
  disposal_event_id          UUID,
  source_event_id            UUID NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_job_work_offcut_acq_proposal_status CHECK (
    status IN ('pending','approved','superseded')
  ),
  CONSTRAINT chk_job_work_offcut_acq_proposal_lifecycle CHECK (
    (status = 'pending' AND decided_at IS NULL AND decided_by IS NULL
      AND disposal_event_id IS NULL)
    OR (status = 'approved' AND decided_at IS NOT NULL AND decided_by IS NOT NULL
      AND disposal_event_id IS NOT NULL AND decided_at >= created_at)
    OR (status = 'superseded' AND decided_at IS NOT NULL AND disposal_event_id IS NULL)
  ),
  -- BSD-5: zero is the free-retention floor, so an acquisition money leg is never negative. A free
  -- retention is below every band anyway and never reaches this table.
  CONSTRAINT chk_job_work_offcut_acq_proposal_money CHECK (rate >= 0 AND proposed_value >= 0),
  CONSTRAINT chk_job_work_offcut_acq_proposal_dual_control CHECK (
    resolved_approver_actor_id <> proposed_by
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_work_offcut_acq_proposal_source_event ON job_work_offcut_acquisition_proposal (source_event_id);
-- AC 4: one pending proposal per holding. A second competing proposal is refused by the schema.
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_work_offcut_acq_proposal_pending ON job_work_offcut_acquisition_proposal (holding_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_job_work_offcut_acq_proposal_order ON job_work_offcut_acquisition_proposal (service_order_id);
CREATE INDEX IF NOT EXISTS idx_job_work_offcut_acq_proposal_approver ON job_work_offcut_acquisition_proposal (resolved_approver_actor_id, status);
CREATE INDEX IF NOT EXISTS idx_job_work_offcut_acq_proposal_site ON job_work_offcut_acquisition_proposal (site_id);

-- DROP-then-ADD, not add-if-absent (the bom_line chk_bom_line_supply_method precedent): an
-- add-if-absent guard sees the OLD constraint present and silently skips the ALTER, so any future
-- widening would keep being rejected on every already-migrated database while this file claimed
-- otherwise.
DO $$
BEGIN
  ALTER TABLE job_work_offcut_acquisition_proposal
    DROP CONSTRAINT IF EXISTS chk_job_work_offcut_acq_proposal_status;
  ALTER TABLE job_work_offcut_acquisition_proposal
    ADD CONSTRAINT chk_job_work_offcut_acq_proposal_status CHECK (
      status IN ('pending','approved','superseded')
    );
  ALTER TABLE job_work_offcut_acquisition_proposal
    DROP CONSTRAINT IF EXISTS chk_job_work_offcut_acq_proposal_lifecycle;
  ALTER TABLE job_work_offcut_acquisition_proposal
    ADD CONSTRAINT chk_job_work_offcut_acq_proposal_lifecycle CHECK (
      (status = 'pending' AND decided_at IS NULL AND decided_by IS NULL
        AND disposal_event_id IS NULL)
      OR (status = 'approved' AND decided_at IS NOT NULL AND decided_by IS NOT NULL
        AND disposal_event_id IS NOT NULL AND decided_at >= created_at)
      OR (status = 'superseded' AND decided_at IS NOT NULL AND disposal_event_id IS NULL)
    );
  ALTER TABLE job_work_offcut_acquisition_proposal
    DROP CONSTRAINT IF EXISTS chk_job_work_offcut_acq_proposal_money;
  ALTER TABLE job_work_offcut_acquisition_proposal
    ADD CONSTRAINT chk_job_work_offcut_acq_proposal_money CHECK (rate >= 0 AND proposed_value >= 0);
  ALTER TABLE job_work_offcut_acquisition_proposal
    DROP CONSTRAINT IF EXISTS chk_job_work_offcut_acq_proposal_dual_control;
  ALTER TABLE job_work_offcut_acquisition_proposal
    ADD CONSTRAINT chk_job_work_offcut_acq_proposal_dual_control CHECK (
      resolved_approver_actor_id <> proposed_by
    );
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON job_work_offcut_acquisition_proposal TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON job_work_offcut_acquisition_proposal TO readonly_user;
  END IF;
END $$;
