-- Branch transfer statutory classification (Story 11.5, FR-AC-10). This file is the CANONICAL
-- definition, applied by src/events/migrate.ts (npm run db:migrate) and the integration-test
-- harness. It carries its OWN grants (guarded DO blocks) so a migrate-provisioned database can
-- serve reads/writes as app_user without depending on deploy/compose/init-db.sql.
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) so the file
-- can be re-applied to a live database safely.
--
-- Review decision D1: the supply class is STAMPED AT CREATE TIME and READ at the ship gate. The
-- gate must never re-derive it from site_gstin / branch_transfer_valuation_config, because both are
-- DATED, MUTABLE configuration: a registration edited between create and ship silently reclassifies
-- a transfer that is already in flight, and an inter-GSTIN movement then ships with no tax invoice
-- because the gate now believes it is intra-GSTIN. One row per transfer request, written by the
-- create applier in the same transaction as the transfer row.
--
-- An intra_site movement resolves no registration and both GSTIN columns stay NULL. An intra_gstin
-- movement resolves ONE shared registration, written to BOTH columns so a reader never has to know
-- which end it came from. An inter_gstin movement resolves two distinct registrations and is the
-- only class that carries a branch_transfer_valuation sibling. transfer_request_id and the site ids
-- are FK-shaped with no declared FK (house convention, matching the sibling valuation table).

CREATE TABLE IF NOT EXISTS branch_transfer_classification (
  transfer_request_id   UUID PRIMARY KEY,
  supply_class          TEXT NOT NULL,
  from_site_id          UUID NOT NULL,
  to_site_id            UUID NOT NULL,
  from_gstin_ext        TEXT,
  to_gstin_ext          TEXT,
  business_date         DATE NOT NULL,
  source_event_id       UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Guarded DROP-then-ADD constraint blocks (the bom_line precedent).
DO $$
BEGIN
  ALTER TABLE branch_transfer_classification DROP CONSTRAINT IF EXISTS chk_branch_transfer_classification_supply_class;
  ALTER TABLE branch_transfer_classification ADD CONSTRAINT chk_branch_transfer_classification_supply_class CHECK (
    supply_class IN ('intra_site', 'intra_gstin', 'inter_gstin')
  );
END $$;

-- A stamped class that resolved no registration cannot later be read as if it had, and a stamped
-- cross-GSTIN class cannot be half-resolved: the two legs are all-or-nothing per class.
DO $$
BEGIN
  ALTER TABLE branch_transfer_classification DROP CONSTRAINT IF EXISTS chk_branch_transfer_classification_gstin_pair;
  ALTER TABLE branch_transfer_classification ADD CONSTRAINT chk_branch_transfer_classification_gstin_pair CHECK (
    (supply_class = 'intra_site' AND from_gstin_ext IS NULL AND to_gstin_ext IS NULL)
    OR (supply_class <> 'intra_site' AND from_gstin_ext IS NOT NULL AND to_gstin_ext IS NOT NULL)
  );
END $$;

-- PLAIN (non-unique) index on the source event, the sibling convention: one create event stamps one
-- row today, and a later multi-row stamping must not be broken by a UNIQUE.
CREATE INDEX IF NOT EXISTS idx_branch_transfer_classification_source_event ON branch_transfer_classification (source_event_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE ON branch_transfer_classification TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON branch_transfer_classification TO readonly_user;
  END IF;
END $$;
