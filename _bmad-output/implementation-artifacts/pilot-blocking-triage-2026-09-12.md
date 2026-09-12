# Pilot-Blocking Triage of Deferred Work

Date: 2026-09-12. Pass: pre-pilot sweep item 4 (first pass, for ruling by the program
director). Source: `deferred-work.md` (493 numbered rows plus the bullet-form deferrals from
Story 9.6 onward). Baseline: commit `820c657`, all 66 PILOT stories done, Epic 13 closed.

Method: the 2026-09-04 round table already gave every numbered row a verdict (Table 1 of the
ledger: Fix batch 33, Decided 16, Open 109, Resolved 53, Killed 253, Folded 25). This pass does
not re-open Killed, Folded or Resolved rows. It re-reads the Decided and Open rows and the
post-9.6 bullets through one question only: does this item change what happens at ONE pilot
site in the first weeks after go-live, or block the cutover itself? Rows the team has since
closed in code (2026-09-09 edge sweep, 2026-09-12 edge parity) are listed in section 4 for
confirmation only. Each row was checked against the current tree where the ledger cited a file.

## 1. Blocking: the team already ruled these are needed before go-live

Table 1 lists the rows whose recorded decision says "required before go-live" and which have
no story in `sprint-status.yaml`. They need a story each, or an explicit reversal of the ruling.

Table 1: Rulings not yet implemented

| Ref | Story | Item | Recorded decision | Proposed action |
| --- | --- | --- | --- | --- |
| 326 | 7-4 | A catalogued spare's min-max levels cannot be edited; a second POST on the key is 409 | "Min-max edit route is required before go-live; stocking levels change monthly. Backlog story." | Create the story; small (one edit route, one event) |
| 343 | 7-5 | A calibration certificate cannot be voided or superseded; a wrong validity date locks or unlocks a machine | "Certificate void or supersede route is required before go-live. Backlog story." | Create the story; small-medium |
| 215 and 616 | 4-7, 8-4 | DATE columns serialise as shifted timestamps on a non-UTC host; `TimeZone` and `DateStyle` are not pinned on the pool | "One IST-pin commit: pg DATE parser plus pool TimeZone, with its own full-suite run." | Do the commit before the staging deploy; every `business_date` on the platform depends on it |

## 2. Blocking candidates found by this pass

Table 2 lists rows the round table left Open or Decided that this pass rates as pilot-affecting.
Ranked by consequence at one site. "Fix" means a code change before the rehearsal; "Runbook"
means a procedure or configuration mitigation recorded in `docs/migration/pilot-cutover-runbook.md`.

Table 2: Candidates for ruling

| Rank | Ref | Story | Item (verified against current tree) | Pilot consequence | Proposed |
| --- | --- | --- | --- | --- | --- |
| 1 | 13-1 bullet | 13-1 | ERP `snapshot_at` accepts future dates (`src/adapters/erp/sync.ts`, no guard as of today) | Since 2026-09-12 a future-dated snapshot makes BOTH final sign-offs permanently `SIGNOFF_STALE`; the site cannot unblock until the ERP row is corrected | Fix: refuse `snapshot_at` later than now plus a small skew in the sync adapter; one arm in the 2.9 suite |
| 2 | 13-2 bullet | 13-2 | Receiving computes over-receipt from `grn_line` sums against `ordered_qty` and never reads `erp_purchase_order_line.open_qty` | Every migrated PO that was partly received in the legacy system accepts a full second receipt on day one | Fix before the rehearsal; medium |
| 3 | 432 | 7-7 | No `LC_COLLATE`, `POSTGRES_INITDB_ARGS` or `COLLATE` anywhere under `deploy/` (confirmed) | Pairs with Table 1 row 3: a restore to a different-locale host changes `lower()` semantics on uniqueness checks | Runbook: pin `POSTGRES_INITDB_ARGS` and `TZ` in the compose files in the same commit as the IST pin |
| 4 | 11.5R-1 | 11.5 | `metadata.occurred_at` has a 5-minute future bound and no lower bound | A backdated instant drives the GST and valuation gates; statutory | Fix: a lower bound (for example 7 days) at the events door, with the 11.5 suite arm |
| 5 | 285 | 7-1 | `persistEvent` has no registry-membership or stream-to-event consistency check outside the migration stream (the ledger's own re-check, 2026-09-04) | A mismatched `stream_type` skips shape validation and the direct-writes guard | Verify first (30 minutes); if still open, fix at the persist path before the rehearsal |
| 6 | 11.2R-1 | 11.2 | `POST /api/v1/events` has no frontline-role denial for the three dispatch events; only the edge door has one | A store assistant with events-door access can pack, document and dispatch | Fix: mirror `DISPATCH_DENIED_FRONTLINE_ROLES` on the events door; small |
| 7 | 761 | 9-5 | Return-clock FIFO ignores `challan_class` (decided, not implemented) | Section 143 clock drained in the wrong order; ITC-04 figures wrong for mixed-class orders | Implement the decided lock-query fix; small |
| 8 | 768 and 769 | 9-5 | Return-clock counters only ever add; the classification correction records no actor or reason | The first mis-posted return in the pilot has no correction path and no audit | Runbook: name the manual correction owner; schedule the reversal-event design |
| 9 | 118 | 2-3 | FEFO/FIFO cannot split one request across lots; `NO_AVAILABLE_LOT` even when combined stock suffices | Pickers hit refusals daily on any SKU held in several lots | Runbook and training: split the request by lot; or fix if the site's lot profile makes this frequent (ask the site) |
| 10 | 706 | 8-7 | Compliance-authority delegation is single-hop and never checks the delegate is active | An inactive user can be resolved as BIS compliance authority | Fix: add the active check; small |
| 11 | 604 | 8-3 | `supplier-scorecards.ts` writes a scorecard metric with no site-access assertion | Cross-site write; one pilot site limits the blast radius | Accept for pilot; fix with the procurement write-site guard (row 208) |
| 12 | 495 | 7-8 | Only `open` work orders are swept to `overdue`; `in_progress` and `on_hold` never are | Overdue escalations silent for in-flight maintenance | Fix if the site runs statutory maintenance in the pilot window; else accept |
| 13 | 304 | 7-2 | A failed overdue notification is never retried; the work order stays `overdue` with no alert | One notification outage loses escalations permanently | Runbook: a daily read of the overdue list until the outbox design lands |
| 14 | 792 | 9-6 | `parsePositiveIntEnv` has no lower bound; `JOBWORK_BILLING_RETRY_WINDOW_MS=1` empties the backlog into the exception queue | One mistyped env value on the staging host | Runbook: freeze the sweep env values in Table 2 of the runbook; fix the helper later |
| 15 | 13-2 bullet | 13-2 | A verification run producing more than 10,000 findings can never complete | Depends on the pilot site's challan and custody row counts | Ask the site for counts before the rehearsal; fix only if within a factor of two |
| 16 | 138 | 2-9 | Dropped ERP PO lines persist as phantoms (decided: a line status column) | Open-PO verification (13.2) and receiving both see lines the ERP has dropped | Implement with the 2-9 closure feed if any pilot PO has dropped lines; else accept |
| 17 | 543 | 8-2 | The Story 1.7 synthetic `qc.result_recorded` shape is still accepted on both doors with no task binding | A QC result can be recorded outside any inspection task | Verify (spine test 4 pins it); accept if the role gate holds, else fix |

## 3. Accepted for the pilot without action

Everything else in Open and Decided. Representative groups, with the reason:

- Single-site blast radius: enterprise-wide reads or missing site predicates (246, 677, 749, 775, 364). One pilot site means one site.
- Scale: unbounded lists and fan-outs (103, 510, 776, 11.2R-3, 11.5R-13, 13-2 exclusions cap). Pilot volumes are far below the thresholds; revisit before the second site.
- Concurrency windows needing load the pilot will not produce (178, 192, 522, 782, 11.5R-3, 369, 443). Watch the logs for `40P01`.
- Phase 2 scope by ruling (327, 328, 329, 330, 344 to 349, 356 to 360, 399, 474, 635, 636, 641, 742, 743, 11.5R-4).
- CI and test hygiene (306, 312, 574, 609, 791, 620, 615, 652).
- Hardening with no pilot trigger (98, 99, 88, 713, 714, 720, 736, 662, 11.5R-9, 11.5R-10).
- Cosmetic or contract-stable (499, 9.9-3, 11.2R-4, 11.2R-5, 11.5R-14, 13-2 paging total).

## 4. Closed since the round table, confirm and strike

- 11.5R-8 edge `PERMANENT_ERROR_CODES` parity: closed 2026-09-12, both sets 188, parity test asserts equality.
- 11.5R-15 and row 172 (edge and dispatch appliers, cross-site): closed 2026-09-09 by the edge-door site-scope sweep.
- Row 94 (committed default database role passwords): fix batch applied; no literal password remains in `deploy/compose/init-db.sql`.
- Story 7.8 edge test pin (`held_lot` synced table): updated 2026-09-12, edge suite 45/45.

## 5. Information needed from the site before ruling

- Row counts for job-work challans and custody ledger entries at the pilot site (Table 2 rank 15).
- Whether any open PO at the site was partly received in the legacy system (rank 2), and whether any has dropped lines (rank 16).
- The SKU-to-lot profile for fast movers (rank 9).
- Whether statutory maintenance and calibration will run inside the pilot window (Table 1 rows 1 and 2, rank 12).
