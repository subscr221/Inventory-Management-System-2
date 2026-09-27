-- Damage case (Story 8.9, FR-P-07, the "A dead PCB on the line" key flow). This file is the
-- CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate) and the
-- integration-test harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned
-- database can serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Derived state ONLY (AD-14): a report case is rebuilt by replaying its 'damage' stream
-- (stream_id = report_id); a receipt case is derived from the goods.received event that opened it
-- (source_event_id) and its later decisions ride the same 'damage' stream. Mutation happens
-- exclusively through persistEvent, inside the same transaction as the domain_events insert.
--
-- Every pairing CHECK is a full biconditional in both directions (the Story 8.3/8.4 lesson):
--   source 'receipt' exactly when a GRN line is named, source 'report' exactly when a photo is;
--   hold_mode 'quarantined' exactly when a quarantine location is named and no hold note is;
--   an OTHER reason exactly when a note is carried; each key's status, holder, outcome and time
--   move together, and a price reduction rides exactly the accept-as-is outcome; the final
--   outcome, its decider kind and its time move together; closed exactly when the ERP reference
--   is recorded.
--
-- damage_report_action is the append-only case history (app_user INSERT, SELECT); the case row
-- itself takes UPDATE for its state transitions. Neither is ever deleted.

CREATE SEQUENCE IF NOT EXISTS damage_report_number_seq;

CREATE TABLE IF NOT EXISTS damage_report (
  report_id                      UUID PRIMARY KEY,
  report_number                  TEXT NOT NULL,
  site_id                        UUID NOT NULL,
  reporter_user_id               UUID NOT NULL,
  reported_at                    TIMESTAMPTZ NOT NULL,
  source_event_id                UUID NOT NULL,
  source                         TEXT NOT NULL,
  source_grn_line_id             UUID,
  source_reason_code             TEXT,
  source_photo_ref               TEXT,
  sku                            TEXT NOT NULL,
  lot_number                     TEXT,
  quantity                       NUMERIC(18,6) NOT NULL,
  uom                            TEXT NOT NULL,
  found_at                       TEXT NOT NULL,
  bin_location_id                UUID,
  bin_code                       TEXT,
  reason_code                    TEXT NOT NULL,
  reason_note                    TEXT,
  photo_attachment_id            UUID,
  hold_mode                      TEXT NOT NULL,
  hold_note                      TEXT,
  quarantine_location_id         UUID,
  physical_state                 TEXT NOT NULL,
  arrived_by                     UUID,
  arrived_at                     TIMESTAMPTZ,
  external_destination           TEXT,
  external_sent_by               UUID,
  external_sent_at               TIMESTAMPTZ,
  external_expected_return_date  DATE,
  external_gate_pass_ref_ext     TEXT,
  external_returned_at           TIMESTAMPTZ,
  external_result_ref_ext        TEXT,
  whole_lot_requested            BOOLEAN NOT NULL DEFAULT false,
  whole_lot_decision             TEXT,
  whole_lot_hold_id              UUID,
  whole_lot_already_held         BOOLEAN,
  whole_lot_decided_by           UUID,
  whole_lot_decided_at           TIMESTAMPTZ,
  status                         TEXT NOT NULL DEFAULT 'on_hold',
  confirmed_quantity             NUMERIC(18,6),
  defect_code                    TEXT,
  inspected_by                   UUID,
  inspected_at                   TIMESTAMPTZ,
  case_value                     NUMERIC(18,4),
  qc_key_status                  TEXT NOT NULL DEFAULT 'pending',
  qc_key_user_id                 UUID,
  qc_key_outcome                 TEXT,
  qc_key_price_reduction_pct     NUMERIC(7,4),
  qc_key_at                      TIMESTAMPTZ,
  finance_key_status             TEXT NOT NULL DEFAULT 'pending',
  finance_key_user_id            UUID,
  finance_key_outcome            TEXT,
  finance_key_price_reduction_pct NUMERIC(7,4),
  finance_key_at                 TIMESTAMPTZ,
  final_outcome                  TEXT,
  final_price_reduction_pct      NUMERIC(7,4),
  decided_by                     TEXT,
  escalation_user_id             UUID,
  decided_at                     TIMESTAMPTZ,
  erp_document_ref_ext           TEXT,
  outcome_recorded_by            UUID,
  outcome_recorded_at            TIMESTAMPTZ,
  replacement_indent_id          UUID,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_damage_report_source CHECK (source IN ('report', 'receipt')),
  CONSTRAINT chk_damage_report_source_grn_pairing CHECK ((source = 'receipt') = (source_grn_line_id IS NOT NULL)),
  CONSTRAINT chk_damage_report_photo_pairing CHECK ((source = 'report') = (photo_attachment_id IS NOT NULL)),
  CONSTRAINT chk_damage_report_quantity CHECK (quantity > 0),
  CONSTRAINT chk_damage_report_found_at CHECK (found_at IN ('stock', 'in_use')),
  CONSTRAINT chk_damage_report_bin_pairing CHECK ((found_at = 'stock') = (bin_code IS NOT NULL)),
  CONSTRAINT chk_damage_report_reason_code CHECK (
    reason_code IN ('DEAD_ON_ARRIVAL', 'DAMAGED_COMPONENT', 'WRONG_ITEM_OR_SPEC', 'OTHER')
  ),
  CONSTRAINT chk_damage_report_reason_note_pairing CHECK (
    (reason_code = 'OTHER') = (reason_note IS NOT NULL)
    AND (reason_note IS NULL OR (btrim(reason_note) <> '' AND char_length(reason_note) <= 200))
  ),
  CONSTRAINT chk_damage_report_hold_mode CHECK (hold_mode IN ('quarantined', 'record_only')),
  CONSTRAINT chk_damage_report_hold_note CHECK (
    hold_note IS NULL OR hold_note IN (
      'in_use', 'insufficient_stock_at_bin', 'serial_controlled', 'not_owned_stock',
      'already_quarantined', 'no_qc_hold_zone'
    )
  ),
  CONSTRAINT chk_damage_report_hold_pairing CHECK (
    (hold_mode = 'quarantined') = (quarantine_location_id IS NOT NULL)
    AND (hold_mode = 'quarantined') = (hold_note IS NULL)
  ),
  CONSTRAINT chk_damage_report_physical_state CHECK (
    physical_state IN ('awaiting_arrival', 'in_qc_hold', 'at_external_check', 'with_reporter', 'not_held')
  ),
  CONSTRAINT chk_damage_report_arrival_pairing CHECK ((arrived_by IS NULL) = (arrived_at IS NULL)),
  CONSTRAINT chk_damage_report_external_pairing CHECK (
    (external_sent_by IS NULL) = (external_sent_at IS NULL)
    AND (external_sent_by IS NULL) = (external_destination IS NULL)
    AND (physical_state = 'at_external_check') <= (external_sent_by IS NOT NULL)
  ),
  CONSTRAINT chk_damage_report_whole_lot_decision CHECK (
    whole_lot_decision IS NULL OR whole_lot_decision IN ('hold_lot', 'keep_local')
  ),
  CONSTRAINT chk_damage_report_whole_lot_pairing CHECK (
    (whole_lot_decision IS NOT NULL) = (whole_lot_decided_by IS NOT NULL)
    AND (whole_lot_decided_by IS NOT NULL) = (whole_lot_decided_at IS NOT NULL)
    AND (whole_lot_decision IS NOT NULL) = (whole_lot_already_held IS NOT NULL)
    AND (whole_lot_decision IS NULL OR whole_lot_requested)
    AND (whole_lot_hold_id IS NULL OR whole_lot_decision = 'hold_lot')
    AND (whole_lot_requested = false OR lot_number IS NOT NULL)
  ),
  CONSTRAINT chk_damage_report_status CHECK (
    status IN ('on_hold', 'cleared', 'awaiting_keys', 'escalated', 'outcome_final', 'closed')
  ),
  CONSTRAINT chk_damage_report_inspection_pairing CHECK (
    (confirmed_quantity IS NOT NULL) = (inspected_by IS NOT NULL)
    AND (inspected_by IS NOT NULL) = (inspected_at IS NOT NULL)
    AND (status = 'on_hold') = (confirmed_quantity IS NULL)
    AND (confirmed_quantity IS NULL OR (confirmed_quantity >= 0 AND confirmed_quantity <= quantity))
    AND (status = 'cleared') = (confirmed_quantity IS NOT NULL AND confirmed_quantity = 0)
  ),
  CONSTRAINT chk_damage_report_qc_key_pairing CHECK (
    qc_key_status IN ('pending', 'turned', 'disagreed')
    AND (qc_key_status = 'pending') = (qc_key_user_id IS NULL)
    AND (qc_key_user_id IS NULL) = (qc_key_outcome IS NULL)
    AND (qc_key_outcome IS NULL) = (qc_key_at IS NULL)
    AND COALESCE(qc_key_outcome = 'accept_as_is_price_reduction', false) = (qc_key_price_reduction_pct IS NOT NULL)
  ),
  CONSTRAINT chk_damage_report_finance_key_pairing CHECK (
    finance_key_status IN ('pending', 'turned', 'disagreed')
    AND (finance_key_status = 'pending') = (finance_key_user_id IS NULL)
    AND (finance_key_user_id IS NULL) = (finance_key_outcome IS NULL)
    AND (finance_key_outcome IS NULL) = (finance_key_at IS NULL)
    AND COALESCE(finance_key_outcome = 'accept_as_is_price_reduction', false) = (finance_key_price_reduction_pct IS NOT NULL)
  ),
  CONSTRAINT chk_damage_report_outcome_values CHECK (
    (qc_key_outcome IS NULL OR qc_key_outcome IN ('debit_note', 'return_for_replacement', 'write_off', 'accept_as_is_price_reduction'))
    AND (finance_key_outcome IS NULL OR finance_key_outcome IN ('debit_note', 'return_for_replacement', 'write_off', 'accept_as_is_price_reduction'))
    AND (final_outcome IS NULL OR final_outcome IN ('debit_note', 'return_for_replacement', 'write_off', 'accept_as_is_price_reduction'))
  ),
  CONSTRAINT chk_damage_report_final_pairing CHECK (
    (final_outcome IS NOT NULL) = (decided_by IS NOT NULL)
    AND (decided_by IS NOT NULL) = (decided_at IS NOT NULL)
    AND (decided_by IS NULL OR decided_by IN ('concurrence', 'escalation'))
    AND COALESCE(decided_by = 'escalation', false) = (escalation_user_id IS NOT NULL)
    AND COALESCE(final_outcome = 'accept_as_is_price_reduction', false) = (final_price_reduction_pct IS NOT NULL)
    AND (status IN ('outcome_final', 'closed')) = (final_outcome IS NOT NULL)
  ),
  CONSTRAINT chk_damage_report_outcome_recorded_pairing CHECK (
    (status = 'closed') = (erp_document_ref_ext IS NOT NULL)
    AND (erp_document_ref_ext IS NULL) = (outcome_recorded_by IS NULL)
    AND (outcome_recorded_by IS NULL) = (outcome_recorded_at IS NULL)
    AND (erp_document_ref_ext IS NULL OR (btrim(erp_document_ref_ext) <> '' AND char_length(erp_document_ref_ext) <= 64))
  ),
  CONSTRAINT chk_damage_report_price_reduction_range CHECK (
    (qc_key_price_reduction_pct IS NULL OR (qc_key_price_reduction_pct > 0 AND qc_key_price_reduction_pct <= 100))
    AND (finance_key_price_reduction_pct IS NULL OR (finance_key_price_reduction_pct > 0 AND finance_key_price_reduction_pct <= 100))
    AND (final_price_reduction_pct IS NULL OR (final_price_reduction_pct > 0 AND final_price_reduction_pct <= 100))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_damage_report_number ON damage_report (report_number);
-- AC 9: one case per GRN line, so a replayed receipt opens nothing new.
CREATE UNIQUE INDEX IF NOT EXISTS uq_damage_report_source_grn_line ON damage_report (source_grn_line_id) WHERE source_grn_line_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_damage_report_site_status ON damage_report (site_id, status, reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_damage_report_reporter ON damage_report (reporter_user_id, reported_at DESC);
-- D5: the stock guard looks up held cases by SKU on every issue that could leave quarantine.
CREATE INDEX IF NOT EXISTS idx_damage_report_held_sku ON damage_report (sku, site_id) WHERE hold_mode = 'quarantined';
CREATE INDEX IF NOT EXISTS idx_damage_report_replacement_indent ON damage_report (replacement_indent_id) WHERE replacement_indent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS damage_report_action (
  action_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id        UUID NOT NULL,
  action           TEXT NOT NULL,
  actor_user_id    UUID NOT NULL,
  actor_role       TEXT NOT NULL,
  at               TIMESTAMPTZ NOT NULL,
  detail           JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_event_id  UUID NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_damage_report_action_source_event ON damage_report_action (source_event_id);
CREATE INDEX IF NOT EXISTS idx_damage_report_action_report ON damage_report_action (report_id, at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON damage_report TO app_user;
    GRANT INSERT, SELECT ON damage_report_action TO app_user;
    GRANT USAGE ON SEQUENCE damage_report_number_seq TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON damage_report TO readonly_user;
    GRANT SELECT ON damage_report_action TO readonly_user;
  END IF;
END $$;
