-- Story 3.8: Warehouse Task Management and Productivity Tracking (FR-W-07). This file is the
-- CANONICAL definition, applied by src/events/migrate.ts (npm run db:migrate).
-- deploy/compose/init-db.sql duplicates this content for first-boot container init - change both
-- files together. Every statement is idempotent.
--
-- AC3 gate dwell (SM-13). Deliberately a VIEW, not a table: every column is derivable from data
-- already materialized by Stories 3.2 (gate_event), 3.3 (weighbridge_event) and 3.4 (grn), so it
-- carries no independent state, needs no apply*Projection hook, and can never drift out of sync
-- with its sources. This is the one documented exception to the projection-trio table pattern.
--
-- Dwell is measured from the gate-entry instant to the FIRST accepted weighment for the same Story
-- 3.2 binding token (correlation_id); where no weighment applies, it falls back to the first GRN
-- confirmation for that token. A reversed gate event is excluded - a reversal means the entry never
-- stood, so counting its dwell would pollute the shift median.
--
-- Rows whose token has neither an accepted weighment nor a GRN yet are still emitted: a vehicle
-- still in the yard is exactly the case a dwell dashboard must not silently drop. Code review of
-- this story found that emitting them with a NULL dwell_interval was not enough, because
-- percentile_cont skips NULLs and the drill-through predicate excludes them, so a shift in which
-- every vehicle was still waiting after three hours reported a null median and "not exceeded".
-- Those rows now carry an OPEN dwell measured against now(), and dwell_open marks them, so a yard
-- full of stuck vehicles breaches instead of reading as clean.
--
-- A resolved_at that precedes the gate entry is device clock skew, not a sub-zero dwell. It is
-- excluded from dwell_interval (NULL) and surfaced through clock_skew_detected, so a negative
-- interval can never drag the shift median down and hide a real breach, while the affected vehicle
-- stays countable rather than silently vanishing.
--
-- The capture-completeness columns (challan_photo_present, weighment_present, grn_fallback_used)
-- exist for SM-C2: a dwell figure that improved because mandatory capture was skipped must be
-- visible on the same row that reports the improvement, never hidden behind it.
--
-- weighment_present asks whether an accepted weighment EXISTS, deliberately independent of whether
-- that row carries an occurred_at. The earlier revision derived it from the occurred_at-filtered
-- lateral, which reported a pre-migration weighment as "no weighment, GRN fallback used" - SM-C2
-- reporting a skip that never happened. grn_fallback_used means only that the dwell was RESOLVED
-- from the GRN, which is a separate question from whether the vehicle was weighed.
--
-- challan_photo_present is, given gate_event's current DDL (challan_photo_ref TEXT NOT NULL plus
-- chk_gate_event_challan_photo_nonempty), true for every row the database can hold. It is retained
-- deliberately as an invariant tripwire rather than a varying signal: if either constraint is ever
-- relaxed, this column starts varying and SM-C2 begins reporting real skipped capture without any
-- further change here. Read a constant 100 percent as "capture is enforced at write time", not as
-- evidence that capture was audited at read time.

-- Dropped and recreated rather than CREATE OR REPLACE'd. PostgreSQL only lets CREATE OR REPLACE
-- VIEW append columns to the end of the select list: it cannot insert, reorder, or rename one, and
-- fails with 42P16 "cannot change name of view column" if you try. This story's review added
-- dwell_open and clock_skew_detected next to the columns they qualify rather than bolting them on
-- the end, so the shape genuinely changes. The GRANT block below re-establishes the privileges the
-- drop removes, which keeps the whole file re-runnable. Nothing else depends on this view; if
-- anything ever does, this becomes a CASCADE decision rather than a silent one.
DROP VIEW IF EXISTS gate_dwell_metric;

CREATE VIEW gate_dwell_metric AS
SELECT
  ge.gate_event_id,
  ge.correlation_id,
  ge.site_id,
  ge.site_code_ext,
  ge.business_date,
  ge.vehicle_reg_ext,
  ge.po_ref_ext,
  ge.entered_at AS gate_entered_at,
  COALESCE(wb.occurred_at, gr.received_at) AS resolved_at,
  CASE
    WHEN wb.occurred_at IS NOT NULL THEN 'weighbridge'
    WHEN gr.received_at IS NOT NULL THEN 'grn'
    ELSE NULL
  END AS resolution_source,
  CASE
    -- Truly resolved: a real resolution timestamp at or after entry.
    WHEN COALESCE(wb.occurred_at, gr.received_at) IS NOT NULL
         AND COALESCE(wb.occurred_at, gr.received_at) >= ge.entered_at
      THEN COALESCE(wb.occurred_at, gr.received_at) - ge.entered_at
    -- Clock skew: a resolution timestamp predates entry; emit NULL so the median cannot go
    -- negative, and let clock_skew_detected flag the row.
    WHEN COALESCE(wb.occurred_at, gr.received_at) IS NOT NULL
         AND COALESCE(wb.occurred_at, gr.received_at) < ge.entered_at
      THEN NULL
    -- Legacy accepted weighment with no capture instant: counted as resolved with no interval.
    -- The visit completed in the yard; reporting it as open would let a growing false breach
    -- dominate the shift median. A future entry is similarly a NULL dwell, never a negative one.
    WHEN wb.accepted_exists OR ge.entered_at > now() THEN NULL
    -- Genuinely open: no resolution, no legacy weighment, entry in the past, clamped at zero.
    ELSE GREATEST(now() - ge.entered_at, interval '0')
  END AS dwell_interval,
  -- Open only when there is no resolution at all and the entry is in the past, so an historical
  -- vehicle with a weighment row but no capture instant does not become a growing breach.
  (COALESCE(wb.occurred_at, gr.received_at) IS NULL
    AND NOT wb.accepted_exists
    AND ge.entered_at <= now()) AS dwell_open,
  (COALESCE(wb.occurred_at, gr.received_at) IS NOT NULL
    AND COALESCE(wb.occurred_at, gr.received_at) < ge.entered_at) AS clock_skew_detected,
  COALESCE(wb.accepted_exists, false) AS weighment_present,
  (wb.occurred_at IS NULL AND gr.received_at IS NOT NULL) AS grn_fallback_used,
  (ge.challan_photo_ref IS NOT NULL AND length(trim(ge.challan_photo_ref)) > 0) AS challan_photo_present
FROM gate_event ge
LEFT JOIN LATERAL (
  SELECT min(w.occurred_at) AS occurred_at,
         count(*) > 0       AS accepted_exists
    FROM weighbridge_event w
   WHERE w.correlation_id = ge.correlation_id
     AND w.status = 'accepted'
) wb ON true
LEFT JOIN LATERAL (
  SELECT g.received_at
    FROM grn g
   WHERE g.correlation_id = ge.correlation_id
     AND g.received_at IS NOT NULL
   ORDER BY g.received_at ASC
   LIMIT 1
) gr ON true
WHERE ge.status = 'open';

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT ON gate_dwell_metric TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON gate_dwell_metric TO readonly_user;
  END IF;
END $$;
