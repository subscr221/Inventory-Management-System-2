---
status: done
followup_review_recommended: false
final_revision: b1acd1d
story: 3-19-unloading-exception-commands-server
baseline_commit: 02a098d
baseline_revision: 02a098db32d153e27ae439bbc45e5a6974827f11
context:
  - _bmad-output/implementation-artifacts/epic-3-context.md
  - _bmad-output/project-context.md
review_loop_iteration: 0
warnings:
  - oversized
---

# Story 3.19: Unloading Exception Commands (server)

<intent-contract>

## Intent

**Problem:** An unloading supervisor has no server command to resolve the two unloading exceptions the pilot produces: a gate event that bound to no open PO, and a GOOD GRN line rejected as over the PO receipt tolerance. Nothing records who resolved what, so the Story 3.20 screen has nothing to call.

**Approach:** Add three event-sourced commands (match a gate event to a PO, accept an over-tolerance receipt at the band cap, send an unmatched vehicle to procurement), a `receiving_exception` projection that holds the durable open, sent and resolved state with the band facts, a list endpoint over it, and an `Unloading exceptions` navigation capability for the two resolver roles.

## Boundaries & Constraints

**Always:** Resolver roles are `unloading_supervisor` and `warehouse_manager` only (a role allowlist on top of the receiving write module check), and the actor must hold receiving or inventory write at the exception's site. Every state change is a registered domain event applied in-transaction by a projection, so a replay rebuilds it. No quantity above the band cap is ever posted. The rejected line keeps status `rejected`. The accepted line goes through the unchanged `goods.received` seam (stock, putaway task, QC routing). New `.sql` is appended at the `src/events/migrate.ts` tail and mirrored verbatim in `deploy/compose/init-db.sql`, and the projection is pinned in schema-drift. `sprint-status.yaml` is never written.

**Block If:** None. The intent is fully specified by the epic story text.

**Never:** No DOA band on accept. No `Hold excess for buyer decision`. No procurement route for over-tolerance lines. No weighbridge breach acceptance. No edge UI and no edge `NAV_ENTRIES` row (that is Story 3.20). No offline outbox path for these commands.

## I/O & Edge-Case Matrix

Table 1: I/O and edge-case matrix lists every command outcome the integration test must cover.

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
| --- | --- | --- | --- |
| Match happy path | Open unmatched gate event, open PO, supervisor at site | 200; `gate.matched`; row `binding_status` matched, `po_ref_ext` set, `resolved_by`, `resolved_at`, `match_note`; exception row kind `unmatched_vehicle` status `resolved` resolution `matched_to_po` | None |
| Match a matched or reversed event | `binding_status` matched or status reversed | Refused | 409 `GATE_EVENT_NOT_UNMATCHED` |
| Match to a closed or unknown PO | `getPurchaseOrderByRef` null or status not open | Refused | 409 `PO_NOT_OPEN` |
| Match after send-to-procurement | Event already sent | 200; the sent exception row becomes `resolved` / `matched_to_po` | None |
| Send to procurement | Open unmatched gate event | 200; exception row `sent_to_procurement`; gate event stays unmatched and leaves the open unmatched list; notification to `procurement_officer` at the site | None |
| Send twice | Already sent | Refused | 409 `GATE_EVENT_ALREADY_RESOLVED` |
| Accept within band | GOOD line rejected over tolerance, ordered 100, pct 10, already 90, counted 30 | 200; new posted line qty 20 on the same `grn_id`, putaway task created; rejected line resolved `accepted_within_band`; exception row resolved with excess 10 and reason `EXCESS_RETURNED_WITH_VEHICLE` | None |
| Accept a line not rejected over tolerance | status not `rejected` or `line_condition` not GOOD | Refused | 409 `GRN_LINE_NOT_REJECTED` |
| Accept twice | `resolved_at` already set | Refused | 409 `GRN_LINE_ALREADY_RESOLVED` |
| Accept with no room left | cap is zero | Refused, nothing posted | 409 `RECEIPT_BAND_EXHAUSTED` |
| Wrong role | `store_assistant` with receiving write | Refused | 403 `FUNCTION_ACCESS_DENIED` |
| Wrong site | Supervisor at another site | Refused | 403 `LOCATION_ACCESS_DENIED` |
| Replay of `gate.entered` on a matched row | `upsertGateEvent` with binding unmatched, no PO | `binding_status` and `po_ref_ext` unchanged | None |

</intent-contract>

## Code Map

- `src/compliance/gate.ts` -- gate event shape asserts and `applyGateProjection`; gains `gate.matched` and `gate.sent_to_procurement`
- `src/read/projections/gate_event.ts`, `read/projections/gate_event.sql` -- gate row, upsert replay guard, list filter
- `src/compliance/receiving.ts` -- `goods.received` applier; the over-tolerance branch (around line 1079) gains the open exception insert
- `src/compliance/receiving-reasons.ts` -- `RECEIPT_REASON_CODES`; resolution-only `EXCESS_RETURNED_WITH_VEHICLE`
- `src/api/v1/receiving.ts` -- role, site and audit helpers to reuse (exported)
- `src/events/schema.ts`, `src/events/store.ts` -- event registry and the assert/apply wiring
- `src/api/v1/edge.ts` -- `NAVIGATION_CAPABILITIES` and `navigationFor`
- `src/server.ts` -- route registration
- `deploy/rehearsal/mock/generate.mjs`, `docs/migration/pilot-mock-extract/roles.json` -- pilot pack grants
- `test/integration/story-1-9.test.ts`, `test/unit/schema-drift.test.ts` -- route list and projection pins

## Tasks & Acceptance

**Execution:**

- [x] `read/projections/gate_event.sql` and `deploy/compose/init-db.sql` -- add `ALTER TABLE gate_event ADD COLUMN IF NOT EXISTS resolved_by UUID`, `resolved_at TIMESTAMPTZ`, `match_note TEXT` -- durable resolver record
- [x] `read/projections/receiving_exception.sql` (new), `src/events/migrate.ts` tail, `deploy/compose/init-db.sql` tail -- `receiving_exception` table (exception_id, kind `over_tolerance` or `unmatched_vehicle`, source_id, site_id, status `open`/`sent_to_procurement`/`resolved`, resolution, reason_code, note, resolved_by, resolved_at, accepted_grn_line_id, ordered, already received, tolerance pct, cap, counted, excess, source_event_id, timestamps; unique kind plus source_id); `ALTER TABLE grn_line ADD COLUMN IF NOT EXISTS resolved_by`, `resolved_at`, `resolution` with a CHECK; backfill an open row for every existing unresolved GOOD rejected line; grants -- durable resolution state
- [x] `src/read/projections/receiving_exception.ts` (new) -- insert/upsert helpers and `listReceivingExceptions` that computes live band facts for open over-tolerance rows and returns stored facts for resolved rows -- one read model for 3.20
- [x] `src/read/projections/gate_event.ts` -- map new columns; `upsertGateEvent` keeps existing `binding_status` and `po_ref_ext` when the row is matched; `listGateEvents` excludes `resolved_at IS NOT NULL` when listing open unmatched; `markGateEventMatched`/`markGateEventSent` helpers
- [x] `src/compliance/gate.ts` -- register `gate.matched` and `gate.sent_to_procurement` shapes and projections (refusals in Table 1; procurement notification in transaction)
- [x] `src/compliance/receiving-exceptions.ts` (new) -- `goods.over_tolerance_accepted` shape and projection (resolve the rejected line, upsert the resolved exception row) and a `readOverToleranceFacts` helper under the PO line advisory lock
- [x] `src/compliance/receiving.ts` -- the over-tolerance branch inserts the open exception row; the reason validator refuses resolution-only codes
- [x] `src/compliance/receiving-reasons.ts` and the 3-11 story Reason Catalogue -- add `EXCESS_RETURNED_WITH_VEHICLE` as resolution-only
- [x] `src/events/schema.ts`, `src/events/store.ts` -- envelopes, registry entries, wiring
- [x] `src/api/v1/unloading-exceptions.ts` (new), `src/api/v1/receiving.ts`, `src/server.ts` -- `POST /api/v1/gate-events/:gateEventId/match-po`, `POST /api/v1/gate-events/:gateEventId/send-to-procurement`, `POST /api/v1/grn-lines/:grnLineId/accept-within-band`, `GET /api/v1/receiving/exceptions` (registered before any parameter route)
- [x] `src/api/v1/edge.ts` -- `Unloading exceptions` capability with `hasUnloadingExceptionScope`
- [x] `deploy/rehearsal/mock/generate.mjs`, `docs/migration/pilot-mock-extract/roles.json` -- `procurement_officer` notification read for indent1@
- [x] `test/integration/story-3-19.test.ts` (new), `test/integration/story-1-9.test.ts`, `test/unit/schema-drift.test.ts` -- coverage of Table 1, navigation both cases, route list, drift pins

**Acceptance Criteria:**

- Given an open unmatched gate event, when `unloading_supervisor` or `warehouse_manager` at the site calls match-po with an open PO, then a `gate.matched` event is applied and the row records the PO, resolver, time and note; `GATE_EVENT_NOT_UNMATCHED` and `PO_NOT_OPEN` are refused.
- Given a GOOD line rejected over tolerance, when accept-within-band is called, then one `goods.received` line equal to the band cap posts on the same `grn_id` with stock and a putaway task, the rejected line stays `rejected` with `resolution` `accepted_within_band`, and the exception row records the excess with `EXCESS_RETURNED_WITH_VEHICLE`; `createGrnLine` still refuses that code.
- Given an open unmatched gate event, when send-to-procurement is called, then an exception row `sent_to_procurement` is written, the event leaves the open unmatched list, and a `procurement_officer` holding the indent1@ notification grant reads the notification.
- Given the bootstrap, when `unload1`-shaped and `warehouse_manager` callers load navigation, then `Unloading exceptions` appears, and a `store_assistant` with receiving write does not see it.
- Given `GET /api/v1/receiving/exceptions?status=open`, when called by a resolver, then rows carry ordered, already received, tolerance pct, cap, counted and excess.

## Spec Change Log

## Review Triage Log

### 2026-11-22 - Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2 (high 0, medium 1, low 1)
- defer: 1 (high 0, medium 1, low 0)
- reject: 27 (high 0, medium 4, low 23)
- addressed_findings:
  - `[medium]` `[patch]` The generic `POST /api/v1/events` door accepted `gate.matched`, `gate.sent_to_procurement` and `goods.over_tolerance_accepted`, bypassing the resolver-role allowlist, the band cap and the paired `goods.received` posting. Added a route-only guard in `src/api/v1/events.ts` (403 `FUNCTION_ACCESS_DENIED`) and a well-formed-payload assertion in the 3.19 role-gate test.
  - `[low]` `[patch]` A missing PO line behind the rejected GRN line was reported as `RECEIPT_BAND_EXHAUSTED`; it now returns 404 `RECEIVING_PO_NOT_FOUND`.

## Design Notes

The accepted line is rebuilt from the rejected line's original `goods.received` payload (read from `domain_events` by `source_event_id`), so the target location, lot, expiry, stock class, owner and inspect fields carry over exactly. The override is a new `grn_line_id`, `received_qty` equal to the cap, `line_condition` GOOD, the actor as `received_by`, and reason and serial fields dropped. The handler nests `persistEvent` inside its own transaction (precedent: the job-work custody event), and the applier re-takes the same PO line advisory lock, so the cap is re-checked atomically.

Cap is `GREATEST(ordered x (1 + pct / 100) - already received, 0)` in PostgreSQL NUMERIC, where already received counts non-rejected platform lines plus `legacy_received_qty`, matching `readPoReceiptBand`. The accepted quantity is the lesser of cap and counted; excess is counted minus accepted.

A sent-to-procurement gate event gets `resolved_at` set (so it leaves the open unmatched list) but stays unmatched; a later match flips the exception row to `resolved` / `matched_to_po`.

## Verification

**Commands:**

- `npx tsc --noEmit` -- expected: no errors
- `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/integration/story-3-19.test.ts` -- expected: all pass
- `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/integration/story-1-9.test.ts test/unit/schema-drift.test.ts test/integration/story-3-13.test.ts test/integration/story-3-14.test.ts test/integration/story-3-4.test.ts test/integration/story-3-11.test.ts` -- expected: all pass
- `npm test` -- expected: no new failures against the known-red baseline

## Auto Run Result

Status: done

**Summary:** Story 3.19 adds three event-sourced unloading exception commands (`match-po`, `send-to-procurement`, `accept-within-band`), the `receiving_exception` projection with live band facts, `GET /api/v1/receiving/exceptions`, and the `Unloading exceptions` navigation capability for `unloading_supervisor` and `warehouse_manager`. The implementation was recovered from the stopped attempt on branch `rescue/3-19-unloading-exceptions`, verified against every task, acceptance criterion and Table 1 row, then reviewed.

**Files changed:**

- `src/api/v1/unloading-exceptions.ts` - the four routes, role and site gates, accept-within-band transaction
- `src/compliance/receiving-exceptions.ts` - `goods.over_tolerance_accepted` shape, projection, `readOverToleranceFacts`
- `src/read/projections/receiving_exception.ts`, `read/projections/receiving_exception.sql` - exception read model, `grn_line` resolution columns, backfill
- `src/compliance/gate.ts`, `src/read/projections/gate_event.ts`, `read/projections/gate_event.sql` - `gate.matched` and `gate.sent_to_procurement`, resolver columns, replay guard
- `src/compliance/receiving.ts`, `src/compliance/receiving-reasons.ts` - open exception insert on over-tolerance reject, resolution-only reason code
- `src/events/schema.ts`, `src/events/store.ts`, `src/events/migrate.ts`, `deploy/compose/init-db.sql` - registry, wiring, migration tail and mirror
- `src/api/v1/events.ts` - generic door refuses the three route-only facts (review patch)
- `src/api/v1/edge.ts`, `src/api/v1/gate.ts`, `src/api/v1/receiving.ts`, `src/server.ts` - navigation, exports, route registration
- `deploy/rehearsal/mock/generate.mjs`, `docs/migration/pilot-mock-extract/roles.json` - `procurement_officer` notification read
- `test/integration/story-3-19.test.ts` and updated 1-9, 3-4, 3-11, 3-14, schema-drift and role-pack tests

**Review findings:** 2 patches applied, 1 deferred (PO site check on binding, pre-existing), 27 rejected.

**Verification:** `npx tsc --noEmit` clean; `story-3-19.test.ts` 11 of 11; `npm test` 2804 of 2804, 0 fail.

**Residual risks:** Concurrent resolution of one gate event relies on the `uq_stream_version` conflict (409 `STREAM_CONFLICT`) rather than a row lock; the exception list is capped at 500 rows with no pagination; staging not exercised.
