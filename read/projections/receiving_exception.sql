-- Story 3.19: unloading exception state (over-tolerance GOOD lines and unmatched vehicles) plus
-- the resolver record on grn_line. Forward-only; grn_line.sql is NOT edited.
CREATE TABLE IF NOT EXISTS receiving_exception (
  exception_id         UUID PRIMARY KEY,
  kind                 TEXT NOT NULL,
  source_id            UUID NOT NULL,
  site_id              UUID NOT NULL,
  status               TEXT NOT NULL DEFAULT 'open',
  resolution           TEXT,
  reason_code          TEXT,
  note                 TEXT,
  resolved_by          UUID,
  resolved_at          TIMESTAMPTZ,
  accepted_grn_line_id UUID,
  ordered_qty          NUMERIC(18,3),
  already_received_qty NUMERIC(18,3),
  tolerance_pct        NUMERIC(18,3),
  cap_qty              NUMERIC(18,3),
  counted_qty          NUMERIC(18,3),
  excess_qty           NUMERIC(18,3),
  source_event_id      UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_receiving_exception_kind CHECK (kind IN ('over_tolerance', 'unmatched_vehicle')),
  CONSTRAINT chk_receiving_exception_status CHECK (status IN ('open', 'sent_to_procurement', 'resolved')),
  CONSTRAINT chk_receiving_exception_resolution CHECK (resolution IS NULL OR resolution IN ('matched_to_po', 'accepted_within_band', 'sent_to_procurement')),
  CONSTRAINT chk_receiving_exception_reason CHECK (reason_code IS NULL OR reason_code = 'EXCESS_RETURNED_WITH_VEHICLE'),
  CONSTRAINT chk_receiving_exception_resolved_at CHECK ((status = 'open' AND resolved_at IS NULL) OR (status <> 'open' AND resolved_at IS NOT NULL)),
  CONSTRAINT uq_receiving_exception_source UNIQUE (kind, source_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_receiving_exception_kind'
      AND conrelid = 'receiving_exception'::regclass
  ) THEN
    ALTER TABLE receiving_exception
      ADD CONSTRAINT chk_receiving_exception_kind CHECK (kind IN ('over_tolerance', 'unmatched_vehicle'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_receiving_exception_status'
      AND conrelid = 'receiving_exception'::regclass
  ) THEN
    ALTER TABLE receiving_exception
      ADD CONSTRAINT chk_receiving_exception_status CHECK (status IN ('open', 'sent_to_procurement', 'resolved'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_receiving_exception_resolution'
      AND conrelid = 'receiving_exception'::regclass
  ) THEN
    ALTER TABLE receiving_exception
      ADD CONSTRAINT chk_receiving_exception_resolution CHECK (resolution IS NULL OR resolution IN ('matched_to_po', 'accepted_within_band', 'sent_to_procurement'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_receiving_exception_reason'
      AND conrelid = 'receiving_exception'::regclass
  ) THEN
    ALTER TABLE receiving_exception
      ADD CONSTRAINT chk_receiving_exception_reason CHECK (reason_code IS NULL OR reason_code = 'EXCESS_RETURNED_WITH_VEHICLE');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_receiving_exception_resolved_at'
      AND conrelid = 'receiving_exception'::regclass
  ) THEN
    ALTER TABLE receiving_exception
      ADD CONSTRAINT chk_receiving_exception_resolved_at CHECK ((status = 'open' AND resolved_at IS NULL) OR (status <> 'open' AND resolved_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_receiving_exception_source'
      AND conrelid = 'receiving_exception'::regclass
  ) THEN
    ALTER TABLE receiving_exception
      ADD CONSTRAINT uq_receiving_exception_source UNIQUE (kind, source_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_receiving_exception_site_status ON receiving_exception (site_id, status);

ALTER TABLE grn_line ADD COLUMN IF NOT EXISTS resolved_by UUID;
ALTER TABLE grn_line ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE grn_line ADD COLUMN IF NOT EXISTS resolution TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_grn_line_resolution'
      AND conrelid = 'grn_line'::regclass
  ) THEN
    ALTER TABLE grn_line
      ADD CONSTRAINT chk_grn_line_resolution
      CHECK (resolution IS NULL OR resolution IN ('accepted_within_band', 'sent_to_procurement'));
  END IF;
END $$;

INSERT INTO receiving_exception (exception_id, kind, source_id, site_id, status, source_event_id)
SELECT gen_random_uuid(), 'over_tolerance', l.grn_line_id, g.site_id, 'open', l.source_event_id
  FROM grn_line l
  JOIN grn g ON g.grn_id = l.grn_id
 WHERE l.status = 'rejected' AND l.line_condition = 'GOOD' AND l.resolved_at IS NULL
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON receiving_exception TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON receiving_exception TO readonly_user;
  END IF;
END $$;
