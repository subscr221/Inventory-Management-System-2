---
baseline_commit: 76b2acffb7be366fda1732e2167dc68b0216bf7a
---
# Story 4.10: Requisition Line-Level Approval and Mixed Routing

Status: done

<!-- Created 2026-10-20 by create-story from baseline 76b2acf. PILOT. Prerequisite of Story 4.8; Story 4.11 depends on this story. -->

## Story

As a requester and as an approver,
I want each requisition line to carry its own approval route and state,
so that lines covered by a standing approval go straight to stores while the rest follow DOA approval, without splitting the document.

## Acceptance Criteria

1. **Per-line route and state.** Given a requisition with several lines, when it is raised, then each `indent_line` row carries its own `approval_route` (`doa`, `standing_approval`, `self_approval`; this story writes only `doa`, the other two values are reserved for Story 4.8) and its own `line_status` (`pending`, `approved`, `rejected`), and the header `status` is derived from its lines (Table 1).
2. **Mixed routing, no split.** Given a mixed requisition, when some lines are covered by a live grant and others are not, then covered lines are approved for issue at once and uncovered lines go to the DOA approver resolved on each line's own value; the document is never split. This story delivers the routing seam and the per-line resolver; the grant lookup that marks a line `standing_approval` is Story 4.8's, so under this story every line resolves through DOA and the seam is proven by a test that injects a pre-approved line.
3. **Per-line decision.** Given a DOA approver, when they decide a requisition, then they approve or reject individual lines (or every pending line they hold, when the request names no line ids; the persisted event always carries the explicit list); SOD-01 (`INDENT_RAISER_CANNOT_APPROVE`), the resolved-approver-or-delegate check, the raised-only and already-decided guards from Story 4.3 apply per line; each line decision writes its own audit-log entry and the requester is notified in the same transaction.
4. **Pilot value bands.** Given UX ruling Q6 (head of department up to Rs 1,00,000, finance controller above), when this story deploys, then two `indent_approval` entries are seeded in the DOA registry on staging (`deploy/provision/staging-doa-bands.sh`) and in the pilot seed (`deploy/rehearsal/mock/generate.mjs`, regenerated into `docs/migration/pilot-mock-extract/world.json`), and a regression test locks the band boundary: a line valued exactly 1,00,000 routes to `department_head`, a line valued 1,00,000.01 routes to `finance_controller`, a zero-value line routes to `department_head`.
5. **Migration of whole-indent decisions.** Given indents persisted before this story, when the schema change applies, then every existing line inherits the header decision (route `doa`, status, approver, DOA entry, decided_at, decided_by, rejection_reason) idempotently, and Story 4.3 behaviour for a single-route requisition is unchanged: `test/integration/story-4-3.test.ts` passes without edits to its assertions, except any test that asserts an indent with no matching band is stored (that behaviour is the Story 4.9 defect and AC 6 replaces it).
6. **No band, no store.** Given a line whose value matches no active `indent_approval` entry, when the requisition is raised (HTTP or edge sync), then the raise is refused with `INDENT_APPROVAL_BAND_MISSING` (409) naming the line number and value, and nothing is persisted; a requisition is never stored with a line that has no approver path. Story 4.9 keeps the head-of-department fallback and the re-resolution of indents already stuck (party-mode ruling 2026-10-20).
7. **Header counts.** Given a requisition with decided lines, when it is read or listed, then the header carries `line_count` and `approved_line_count`, and the edge My Requests row shows "n of m approved" whenever `approved_line_count` is below `line_count` and above zero (party-mode ruling 2026-10-20).

## Tasks / Subtasks

- [x] Task 1: Schema (AC 1, 5)
  - [x] 1.1 `read/projections/indent_line.sql`: add `approval_route TEXT NOT NULL DEFAULT 'doa'`, `line_status TEXT NOT NULL DEFAULT 'pending'`, `approver_actor_id TEXT`, `doa_entry_id UUID`, `decided_at TIMESTAMPTZ`, `decided_by TEXT`, `rejection_reason TEXT`, each as guarded `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, plus named constraints `chk_indent_line_route` (three values), `chk_indent_line_status` (three values), `chk_indent_line_rejection_reason` (non-empty when rejected) in guarded `DO $$` blocks, and index `idx_indent_line_status (indent_id, line_status)`.
  - [x] 1.2 Backfill in the same file, idempotent: `UPDATE indent_line l SET ... FROM indent i WHERE l.indent_id = i.indent_id AND l.decided_at IS NULL AND i.decided_at IS NOT NULL` mapping header `approved`/`ordered`/`closed` to line `approved`, header `rejected` to line `rejected`, copying `approver_actor_id`, `doa_entry_id`, `decided_at`, `decided_by`, `rejection_reason`. Undecided headers (`raised`, `pending-confirmation`, `cancelled`) leave lines `pending` but copy `approver_actor_id` and `doa_entry_id` when set.
  - [x] 1.3 Mirror byte-for-byte into `deploy/compose/init-db.sql` (indent_line block at about line 3845). Extend `test/unit/schema-drift.test.ts` (indent entries at 551-566) with the new constraints and index. `src/events/migrate.ts` already registers both files; no change.
  - [x] 1.4 `src/read/projections/indent.ts`: extend `IndentLineRow` and `InsertIndentLineInput` with the new columns; add `updateIndentLineDecision(client, lineId, patch)` and `getIndentLines(..., forUpdate)`; extend the `updateIndentStatus` whitelist only if a new header column is needed (none expected).
- [x] Task 2: Per-line routing at raise (AC 1, 2, 4)
  - [x] 2.1 Extract the band resolution from `resolveApprover` in `src/api/v1/indents.ts:70-110` into an exported `routeIndentLines(lines, client?)` in a new `src/compliance/indent-routing.ts` that returns, per line, `{ approval_route: 'doa', approver_actor_id, doa_entry_id, requires_approval }` using `findMatchingDoaEntry`, `findRoleHolder`, `findActiveDelegation` exactly as today. Line value is `requested_qty * unit_price_estimate` rounded to 4 decimals, treated as 0 when `unit_price_estimate` is null. Keep the no-holder `APPROVAL_UNRESOLVED` 409. Replace today's "no entry, `requiresApproval:false`" branch with a 409 `INDENT_APPROVAL_BAND_MISSING` whose details carry `{ line_no, line_value, transaction_type }` (AC 6); it throws before `persistEvent`, so nothing is stored. The check never names a role, so `no-hardcoded-role-in-workflow` stays green.
  - [x] 2.2 Header fields stay populated for compatibility: `approver_actor_id`/`doa_entry_id` on the header are those of the highest-value DOA line (ties: lowest `line_no`). The response 201 `APPROVAL_REQUIRED` envelope is unchanged.
  - [x] 2.3 Carry the per-line routing in the `indent.raised` payload (`lines[].approval_route`, `lines[].approver_actor_id`, `lines[].doa_entry_id`, all optional in `IndentRaisedPayload` at `src/events/schema.ts:969`) so `applyIndentRaised` (`src/compliance/indent.ts:263-430`) persists them through `insertIndentLine`. Absent fields default to `doa` and the header values (old events replay unchanged).
  - [x] 2.4 `src/api/v1/edge.ts:741-763` (offline sync) calls `routeIndentLines` the same way; no second resolver idiom.
  - [x] 2.5 Seam hook for Story 4.8: `routeIndentLines` accepts an optional `preRouted` map (line index to `{ approval_route, approver_actor_id: null }`); a line present in it skips DOA resolution and `applyIndentRaised` inserts it with `line_status = 'approved'`, `decided_by = 'system'`, `decided_at = now()`. Only tests use it in this story.
- [x] Task 3: Per-line decisions (AC 3)
  - [x] 3.1 `IndentApprovedPayload`/`IndentRejectedPayload` (`src/events/schema.ts`) gain `line_ids: string[]`, optional in the type for old events only. The route handler resolves the list before `persistEvent`: body `line_ids` as given, or, when the body names none, every `pending` line whose approver the actor is or delegates for. The applier never resolves lines; it decides exactly the ids in the payload, so a replay against a changed delegation table decides the same lines. An old event with no `line_ids` replays as "all lines" (its header decision already covered every line).
  - [x] 3.2 Rewrite `assertDecisionAllowed` (`src/compliance/indent.ts:573-656`) as `assertLineDecisionAllowed(indent, line, actor, client)`: header must be `raised` (keep `INDENT_PENDING_CONFIRMATION` and `INDENT_NOT_IN_RAISED`), line must be `pending` (`INDENT_LINE_ALREADY_DECIDED` 409, new), SOD-01 per line, null line approver refuses `NOT_RESOLVED_APPROVER` (unchanged message, Story 4.9 owns the fallback), actor must be line approver or active delegate. Unknown line id for this indent: `INDENT_LINE_NOT_FOUND` 404 (new). A `line_ids` list where any line fails a guard refuses the whole request with that guard's error (all or nothing); a body naming no lines where the actor holds zero pending lines refuses `NOT_RESOLVED_APPROVER` at the route layer.
  - [x] 3.3 `applyIndentApproved` / `applyIndentRejected`: lock the header with `getIndentById(..., forUpdate = true)`, lock lines `FOR UPDATE`, decide each named line, write one `logAuditEntry` per line (`src/read/projections/audit_log.ts:27`, action `indent.line_approved` / `indent.line_rejected`, details with `indent_line_id`, `line_no`, `sku`, `line_value`, `doa_entry_id`), then derive and persist the header per Table 1 with `updateIndentStatus`. One `emitNotificationInTransaction` per event to the requester (`event_type: 'indent_decision'`) with the decided line numbers in the payload.
  - [x] 3.4 Routes `POST /indents/:indentId/approve` and `/reject` (`src/api/v1/indents.ts:503-575`) accept optional body `line_ids`; reject still requires `rejection_reason` and applies it to every named line. Response `{ event_id, indent, lines }`. `GET /indents/:indentId` returns `lines[]` with the new columns. Both `GET /indents/:indentId` and `GET /indents` add `line_count` and `approved_line_count` to each header, computed in SQL (one grouped subquery in `listIndents`, no N+1) (AC 7).
  - [x] 3.5 Add the new codes to `PERMANENT_ERROR_CODES` in `src/sync/upload.ts` and its twin `edge/src/sync/connector.ts:194-203`, and strings in `edge/src/messages/en.json` next to 262-269.
- [x] Task 4: Header derivation (AC 1)
  - [x] 4.1 Implement `deriveIndentStatus(lines)` in `src/compliance/indent.ts` per Table 1, used by Task 3.3 and by `applyIndentRaised` for the Task 2.5 case. `ordered`, `closed`, `cancelled`, `pending-confirmation` are header-only transitions and are never derived.
  - [x] 4.2 `applyIndentOrdered` keeps requiring header `approved`; `applyIndentCancelled` and `applyIndentWithdrawn` leave `line_status` as is (cancellation is a header fact).
- [x] Task 5: Pilot bands (AC 4)
  - [x] 5.1 `deploy/provision/staging-doa-bands.sh`: add `band department_head indent_approval` with `value_min null, value_max 100000` and `band finance_controller indent_approval` with `value_min 100000, value_max null` using the script's existing idempotency on active type plus role. Owner confirmed these amounts 2026-10-21 (O1).
  - [x] 5.2 `deploy/rehearsal/mock/generate.mjs:479-495`: replace the single unbounded `['indent_approval','department_head']` entry with the two bands; regenerate `docs/migration/pilot-mock-extract/world.json` (line 853 area) and commit both.
  - [x] 5.3 Runbook `docs/migration/pilot-cutover-runbook.md`: new row 2.10j "indent approval bands seeded and a mixed-value requisition routes two lines to two approvers"; fix row 2.9a's stale "four approval bands" to the real count after this change (nine).
- [x] Task 6: Edge display (AC 1)
  - [x] 6.1 `edge/src/components/my-requests.tsx` (status map 76-83): show a per-line status chip (`Pending`, `Approved`, `Rejected`) when the API returns lines, and on the list row replace the bare `Approved` label with "{approved} of {total} approved" when `approved_line_count` is between 1 and `line_count - 1` (AC 7); keys in `edge/src/messages/en.json` under `myRequests.line.*` and `myRequests.partialApproved`. No layout change; no new screen.
- [x] Task 7: Tests (AC 1-5)
  - [x] 7.1 New `test/integration/story-4-10.test.ts` (node:test, pattern of `story-4-3.test.ts:238-275` for per-run bands with suffixed roles): three-line raise routes two lines to the dept-head holder and one to the finance-controller holder with header approver = highest-value line; approve two lines by id leaves header `raised` and third line `pending`; reject the third with reason derives header `approved` (Table 1); reject all derives `rejected`; SOD-01 per line; `INDENT_LINE_ALREADY_DECIDED`; `INDENT_LINE_NOT_FOUND`; absent `line_ids` decides only the actor's lines; approver of line A cannot decide line B (`NOT_RESOLVED_APPROVER`); band boundary 100000 / 100000.01 / 0; Task 2.5 pre-routed line is `approved` at raise and the other line still waits (AC 2 mixed, no split); audit entries per line; edge sync path (`edge.ts`) produces the same per-line routing; a line with no matching band refuses the whole raise with `INDENT_APPROVAL_BAND_MISSING` and leaves no `indent` row (AC 6, HTTP and edge sync); the persisted `indent.approved` payload carries the explicit `line_ids` even when the body named none (AC 3); `line_count` and `approved_line_count` on `GET /indents/:id` and `GET /indents` after a partial decision (AC 7).
  - [x] 7.2 Migration test: insert a legacy approved indent and lines without decision columns through the projection helpers, run the backfill statement, assert lines inherit the header decision; run it twice to prove idempotency.
  - [x] 7.3 `test/integration/story-4-3.test.ts` must pass unmodified. Run `test/unit/no-hardcoded-role-in-workflow.test.ts` (no role literals in `src/compliance/indent-routing.ts`), `test/unit/schema-drift.test.ts`, `test/integration/story-1-9.test.ts` (route allowlist unchanged: no new routes).
  - [x] 7.4 Gates: `npm run lint`, `npx tsc --noEmit`, `npx prettier --check`, full `npm test` (baseline 2588 of 2588), `graphify update .`.

## Dev Notes

### Owner rulings

- **O1 Band values: CONFIRMED by owner 2026-10-21.** department_head up to Rs 1,00,000 inclusive, finance_controller above, unbounded. AC 4 "confirmed with the owner" is satisfied; Task 5 seeds exactly these.
- **O2 Story 4.9 ordering: RULED 2026-10-20 (party mode).** 4.10 goes first and takes the "no band, no store" half of 4.9 (AC 6). Story 4.9 keeps the head-of-department fallback (needs a department data model that does not exist yet) and the re-resolution of indents already stuck. The `NOT_RESOLVED_APPROVER` refusal on the line decision path stays as a defensive guard for legacy rows.
- **O3 Header meaning: RULED 2026-10-20 (party mode).** Header `approved` means "at least one line approved and none pending" so Story 4.11 can issue. No fourth status. The list row shows "n of m approved" from server-side counts (AC 7).
- **O4 Explicit line ids in events: RULED 2026-10-20 (party mode).** The event always stores the decided line ids; the applier never resolves them (Task 3.1).
- **For Story 4.11 (not this story):** when a later line of an already partly issued requisition is approved, the storekeeper gets no signal today; 4.11 must define the slip and notification for a late-approved line (party mode, Ravi, 2026-10-20).

### Decisions

- **D1 Route vocabulary reserved.** `approval_route` CHECK lists all three values now so Story 4.8 only adds its own columns (`standing_grant_id`, `self_approved`, `self_approval_grant_id`) with `ADD COLUMN IF NOT EXISTS`, as its Task 1.3 plans.
- **D2 Line value.** `line_value` already exists on `indent_line` (`requested_qty * unit_price_estimate`); route on it, not on a new field. Null price means 0 and routes to the lowest band, same as today's header rule for a priceless indent.
- **D3 No new events.** Per-line decisions ride the existing `indent.approved` and `indent.rejected` events with `line_ids`; the audit log carries the per-line record. Adding `indent.line_approved` events would force a third approval idiom (Story 9.7 rule: do not invent a second approval idiom).
- **D4 Header derivation.** Table 1 is the whole rule. A requisition with one approved and one rejected line is header `approved` so that Story 4.11 can issue the approved line; the rejected line is visible on the lines array.
- **D5 Header approver kept.** `indent.approver_actor_id` and `doa_entry_id` remain populated (highest-value line) because `edge/src/components/my-requests.tsx`, `listIndents` filters and Story 1.15 tests read them. They are informational after this story; the per-line columns are authoritative.
- **D6 Absent `line_ids` keeps Story 4.3 clients working.** The 4.3 tests and the edge client post an empty body; they must keep decoding the same `{ event_id, indent }` shape (the added `lines` key is additive).
- **D7 Category and department are out of scope.** `doa_registry_entries` has no category or department column and users carry no department; routing stays value-band only. Story 4.9 decides how "requester's head of department" is derived.
- **D8 No new routes.** Story 1.9's route allowlist stays at eight indent routes.
- **D9 Error code additions.** `INDENT_APPROVAL_BAND_MISSING` (409, raise), `INDENT_LINE_NOT_FOUND` (404), `INDENT_LINE_ALREADY_DECIDED` (409). All three go into both permanent-code lists and `en.json`.

### Header status derivation

Table 1 gives the rule applied after every line decision.

| Line states present | Derived header status |
|---|---|
| any `pending` | `raised` (unchanged) |
| none `pending`, at least one `approved` | `approved`, `decided_at` = latest line decision, `decided_by` = that line's `decided_by` |
| all `rejected` | `rejected`, `rejection_reason` = reason of the last rejected line |

Table 1: header status from line states. Header-only states (`pending-confirmation`, `ordered`, `closed`, `cancelled`) are never produced by derivation.

### Current state of the files this story changes

- `src/compliance/indent.ts` (844 lines): `INDENT_EVENT_TYPES` 22-32; `assertIndentRaisedShape` 136-212; `applyIndentRaised` 263-430 inserts lines at 372-388 with `randomUUID()`; `assertDecisionAllowed` 573-656 holds SOD-01 (614-623), null approver (628-636), delegate check (637-654); `applyIndentApproved` 658, `applyIndentRejected` 700, both end with `emitNotificationInTransaction` (679-697, 731-749). Error codes are inline string literals; keep that style, no constants object.
- `src/api/v1/indents.ts` (657 lines): `INDENT_DOA_TYPE` 35; `resolveApprover` 70-110 (no entry returns `requiresApproval:false, approverActorId:null`, no holder throws 409 `APPROVAL_UNRESOLVED`); raise 200-286; approve 503-530; reject 532-575 (`INDENT_REJECTION_REASON_REQUIRED` 400); `requireRole` wrappers 615-657.
- `src/api/v1/edge.ts:741-763`: sync-time raise, same resolver on header value.
- `src/read/projections/indent.ts`: `IndentLineRow` 40, `getIndentById(id, client, forUpdate)` 60, `getIndentLines` 74, `insertIndentLine` 239, `updateIndentStatus` 275 (column whitelist), `allocateIndentNumber` 333.
- `read/projections/indent_line.sql:9-21`: no route, state, approver or decision columns; `uq_indent_line_no`, `chk_indent_line_qty_positive`, index on `sku`. Mirror in `deploy/compose/init-db.sql` from about line 3845.
- `src/read/projections/doa_registry.ts:179-198`: `findMatchingDoaEntry` predicate `$2 > value_min AND $2 <= value_max`, null bounds open-ended, `ORDER BY created_at, entry_id LIMIT 1`. `findRoleHolder(role, client, locationId?)` 312 picks the oldest holder; `findActiveDelegation` 267.
- `deploy/provision/staging-doa-bands.sh`: seven bands today, none for `indent_approval`; `band role type suffix` helper posts `POST /api/v1/doa/entries` as the finance controller, idempotent on an active type plus role.
- `deploy/rehearsal/mock/generate.mjs:479-495`: `doa_entries` with one unbounded `indent_approval` / `department_head` entry, applied by `deploy/rehearsal/mock/setup-operations.ts:110`.

### Preserve

- `test/integration/story-4-3.test.ts` (17 tests: SOD-01 at 668, `NOT_RESOLVED_APPROVER` 681, double approve 704, boundaries 884) passes unmodified.
- `story-1-15.test.ts:323-637` (base-role raise, `mine=true`, edge sync) and the band seeds in `story-4-2/4-4/4-5/4-6/4-7/8-9/9-4` tests use per-run suffixed roles; new seeds must not collide.
- Duplicate window, `pending-confirmation` hold, damage replacement link (Story 8.9), `recomputeIndentEstimatedValue`, business-stream tagging (`src/compliance/business-stream.ts:63`).
- `emitNotificationInTransaction` for decisions (AD-17, ADR-001); channels `in_app` and `web_push` only.

### Architecture compliance

- State changes only through events; `indent_line` columns are a projection written inside the persist transaction (`src/events/store.ts:1174`).
- Error envelope `{ error_code, message, details, trace_id }`; new codes `INDENT_LINE_NOT_FOUND` (404), `INDENT_LINE_ALREADY_DECIDED` (409) stable and mirrored in both permanent-code lists.
- Approvers resolve from the DOA registry only (AD-3); no role literal in workflow code.
- Schema convention from Story 2.10 review pass 2: `CREATE TABLE IF NOT EXISTS` skips inline constraints on existing databases, so every new constraint is a guarded `DO $$` block; grants INSERT/SELECT/UPDATE only.
- `constraintOf` must map 23514 to 400 and 23503 to 409 for the new checks (2.10 review patch).
- Lock order: header `FOR UPDATE` first, then lines, never `FOR SHARE` then `UPDATE` (2.10 deadlock patch).

### Testing standards

- `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/**/*.test.ts`; `ims-postgres-test` postgres 18.4 on port 5442 (recreate from `init-db.sql` if missing).
- Integration files boot `createAppServer(createAppRouter())` on port 0, provision users via SCIM, `POST /api/v1/auth/dev-token`; assert exact values plus one negative control per guard.
- Mutation-verify the Table 1 derivation and the SOD-01 per-line guard (flip each and watch the test fail).

### Previous story intelligence

- Story 2.10 reviews repeated: N+1 collapse (load all lines once), no-op writes must not emit events or notifications, malformed id 400 `INVALID_PARAMS` versus unknown 404, test personas at `'*'` hide location bugs, completion notes must match the File List.
- Story 1.16: `findRoleHolder` location argument exists; this story passes none (indent routing is not site-scoped today; Story 4.8 D3 adds the grant site).
- Story 9.10: `requireUuidParam` is lower-cased; `indents.ts` does not use it today, keep its existing `loadIndentOr404` idiom.

### Contradictions resolved

- UX EXPERIENCE.md UJ-IND-01 says a mixed requisition "splits into one request per route"; epics.md 4.10 and the 2026-09-29 rulings say never split. The later ruling wins; the UX copy is informational.
- Runbook row 2.9a says "four approval bands"; the script seeds seven today and nine after Task 5.1.
- `_bmad-output/project-context.md` is a stub; conventions come from `AGENTS.md`, `FORMATTING_RULES.md`, the architecture spine and the prior story files cited here.

### References

- [epics.md Story 4.10](../planning-artifacts/epics.md) lines 2020-2048; Story 4.8 at 1957-1992; Story 4.9 at 1994-2018.
- [Story 4.8 file](4-8-standing-approvals-and-self-approval-limits.md) Tables 1, 3, 4 and decisions D6, D8, D10.
- [Story 4.3 file](4-3-purchase-requisition-and-indent-loop.md) File List 356-384, review findings 396-420.
- [UX run EXPERIENCE.md](../planning-artifacts/ux-designs/ux-Inventory%20Management%20System_2-2026-09-23/EXPERIENCE.md) lines 155-172, UJ-IND-01 201-207; `.memlog.md` lines 76, 102.
- [Architecture spine](../planning-artifacts/architecture/architecture-Inventory%20Management%20System_2-2026-07-11/ARCHITECTURE-SPINE.md) AD-3, AD-14, AD-17, Consistency Conventions 181-198.
- [sprint-change-proposal-2026-09-26.md](../planning-artifacts/sprint-change-proposal-2026-09-26.md) Sections 4.1, 4.4, 5.

## Dev Agent Record

### Agent Model Used

Claude Fable 5.1 (claude-fable-5-1), 2026-10-21.

### Debug Log References

- Story 4.3 clients post an empty decision body. Holding zero pending lines, the route names every line so the seam answers with the precise Story 4.3 guard (`INDENT_ALREADY_DECIDED`, SOD-01, `NOT_RESOLVED_APPROVER`) instead of a flat route-layer 403; the 17 story-4-3 tests pass unmodified.
- `deploy/rehearsal/mock/setup-operations.ts` probed every band at value 1, which would skip the finance band once the department-head band exists; it now probes inside each band.
- AC 6 refuses every raise with no band, so `story-1-15.test.ts` (band started at 5,000, raises at 1,000) and `story-8-9.test.ts` (no `indent_approval` band) seed an unbounded band; no assertion changed.

### Completion Notes List

- Task 1: seven guarded columns, three guarded constraints, one index and the idempotent backfill in `indent_line.sql`, mirrored into `init-db.sql`; drift test extended; `IndentLineRow`, `insertIndentLine`, `getIndentLines(forUpdate)`, `updateIndentLineDecision`, `getIndentWithCounts`, and `listIndents` with the grouped line-count subquery.
- Task 2: `src/compliance/indent-routing.ts` (`routeIndentLines`, `lineValueOf`, `headerApproverOf`, `INDENT_DOA_TYPE`, `preRouted` seam); the HTTP raise and the edge sync both call it; `INDENT_APPROVAL_BAND_MISSING` throws before `persistEvent`. `resolveApprover` stays in `indents.ts` for its 20 other callers.
- Task 3: `line_ids` resolved in the route before `persistEvent` (body as given, else the actor's pending lines); the applier decides exactly the ids in the payload under header then line `FOR UPDATE`, one audit entry per line (`indent.line_approved` / `indent.line_rejected`), header derived per Table 1, one requester notification per event. Three codes added to both permanent lists and `en.json`.
- Task 4: `deriveIndentStatus` exported and unit-tested; ordered, cancelled, withdrawn unchanged.
- Task 5: two bands in `staging-doa-bands.sh` (helper gained optional value bounds), `generate.mjs`, `world.json` (patched in place, not regenerated, to avoid unrelated churn); runbook rows 2.9a corrected and 2.10j added.
- Task 6: My Requests row shows "n of m approved" from server counts; per-line chips render when a response carries lines.
- Task 7: `test/integration/story-4-10.test.ts` 11 tests (routing, boundary, AC 6 HTTP and edge, per-line decisions, held lines and explicit `line_ids` in the event, SOD-01, all-rejected, Table 1 unit, pre-routed seam, idempotent backfill).

### File List

- read/projections/indent_line.sql
- deploy/compose/init-db.sql
- src/read/projections/indent.ts
- src/compliance/indent-routing.ts (new)
- src/compliance/indent.ts
- src/api/v1/indents.ts
- src/api/v1/edge.ts
- src/events/schema.ts
- src/sync/upload.ts
- edge/src/sync/connector.ts
- edge/src/messages/en.json
- edge/src/components/my-requests.tsx
- deploy/provision/staging-doa-bands.sh
- deploy/rehearsal/mock/generate.mjs
- deploy/rehearsal/mock/setup-operations.ts
- docs/migration/pilot-mock-extract/world.json
- docs/migration/pilot-cutover-runbook.md
- test/integration/story-4-10.test.ts (new)
- test/unit/schema-drift.test.ts
- test/integration/story-1-15.test.ts (band seed only)
- test/integration/story-8-9.test.ts (band seed only)
- _bmad-output/implementation-artifacts/sprint-status.yaml

### Review Findings

Code review 2026-10-21 (Blind Hunter, Edge Case Hunter, Acceptance Auditor). 0 decision-needed, 6 patch (all applied), 4 defer, 20 dismissed.

- [x] [Review][Patch] A direct `POST /api/v1/events` `indent.raised` could set a line `approval_route` to `self_approval` or `standing_approval` and be stored approved by `system` with no DOA check. The events door now drops `approval_route`, `approver_actor_id` and `doa_entry_id` from each line [src/api/v1/events.ts]. Regression test added.
- [x] [Review][Patch] A null or non-object entry in `lines` threw a TypeError (500, retried by the edge outbox). `routeIndentLines` now answers 400 `INVALID_PARAMS` [src/compliance/indent-routing.ts]. Regression test added.
- [x] [Review][Patch] A duplicate-held raise with pre-routed lines would, once confirmed, sit `raised` with no pending line. `applyIndentConfirmed` now derives the header from the lines [src/compliance/indent.ts].
- [x] [Review][Patch] Prettier reflowed unrelated code in `edge.ts`; the file was restored and only the two intended edits reapplied [src/api/v1/edge.ts].
- [x] [Review][Patch] The reject notification named no line numbers and no outstanding count; it now does [src/compliance/indent.ts].
- [x] [Review][Patch] The approve/reject JSDoc sat above the wrong function [src/api/v1/indents.ts].
- [x] [Review][Defer] A pre-approved (non-`doa`) line writes no audit entry and no notification at raise [src/compliance/indent.ts] - deferred, Story 4.8 owns the grant path that creates such lines.
- [x] [Review][Defer] When the requester holds the band role, the line is frozen with the requester as approver and SOD-01 blocks it forever [src/compliance/indent-routing.ts] - deferred, pre-existing, Story 4.9.
- [x] [Review][Defer] The role-holder fallback picks any other `indent_approval` role without regard to value band, so a large line can route to a smaller band's holder [src/compliance/indent-routing.ts] - deferred, pre-existing behaviour moved verbatim from `resolveApprover`, Story 4.9.
- [x] [Review][Defer] The My Requests list row never receives `lines[]`, so the per-line chips render only where a response carries lines [edge/src/components/my-requests.tsx] - deferred, AC 7 label is served by the counts; chips need a detail screen that does not exist yet.

Dismissed with reason: the band boundary is inclusive on the department head and exclusive on finance in `findMatchingDoaEntry` (proven by the boundary test); the header lock is taken before the line locks in the applier; a concurrent decision gets a clean 409; `IndentRow` header approver is informational by D5; the permanent `INDENT_APPROVAL_BAND_MISSING` code is the story's own Task 3.5; the empty-body fallback to all lines is deliberate so `story-4-3.test.ts` passes unmodified (Task 3.2 text predates AC 5; recorded in the Debug Log); old events without `line_ids` only replay against fresh projections where every line is pending; and the remaining items were style, test-shape or theory with no reachable call site.

### Change Log

- 2026-10-20: story created from baseline 76b2acf (create-story), status ready-for-dev.
- 2026-10-20: party-mode review applied: AC 6 (no band, no store), AC 7 (header counts, "n of m approved"), explicit `line_ids` in every event (Task 3.1), rulings O2 to O4, 4.11 note on late-approved lines.
- 2026-10-21: implemented Tasks 1 to 7 (dev-story); full suite 2599 of 2599, lint and tsc clean, graph updated; status review. Uncommitted.
- 2026-10-21: code review (3 layers): 6 patches applied (events door strips client line routing, null-line 400, confirm derives header, edge.ts prettier noise reverted, reject notification text, JSDoc), 4 deferred, 20 dismissed; full suite 2601 of 2601; status done. Uncommitted.
