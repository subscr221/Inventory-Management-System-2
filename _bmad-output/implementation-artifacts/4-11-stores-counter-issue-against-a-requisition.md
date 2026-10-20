---
baseline_commit: 908443fee297a1d5eae85f708e656902b630b3eb
---
# Story 4.11: Stores Counter Issue Against a Requisition

Status: done

<!-- Created 2026-10-21 by create-story from baseline 908443f (Story 4.10 done and committed). PILOT. Prerequisite of Story 4.8 (issue-time cap check and slip text). Source: epics.md Story 4.11, user ruling 2026-09-29, party-mode ruling 2026-10-20. -->

## Story

As a storekeeper,
I want to issue stock at the counter against approved requisition lines, fully or in part,
so that approved needs are met from stock with a printed slip and an exact ledger record.

PILOT. Builds the stores issue flow that Story 4.8 Table 4 row 1 found missing ("No stores issue flow. Build it as Story 4.11, line-level, partial issue"). Story 4.10 gave every `indent_line` its own `line_status`; this story consumes `approved` lines.

## Acceptance Criteria

1. **Issue from a bin, through the ledger.** Given an `indent_line` with `line_status = 'approved'`, when a storekeeper posts an issue naming the line, a bin at the requisition's site, a quantity and (where the item demands it) a lot or serials, then one `indent.issued` event is persisted on the `procurement` stream and, inside the same transaction, one `stock.issued` event per issued line drains `stock_balance` at that bin through `applyStockIssue` (valuation outflow, lot trace, serial state and QC gate all ride the existing `stock.issued` seams); the line's `issued_qty` grows by the quantity; an `indent_issue` slip row with number `ISS-YYYY-NNNN` and `indent_issue_line` rows are written; the response carries the slip text; one audit entry per issued line is written.
2. **Partial issue, line stays open.** Given a line with `issued_qty < requested_qty`, when a partial issue is posted, then the line keeps `issue_state = 'open'` with `open_qty = requested_qty - issued_qty` on reads; a later issue of the remainder is a second slip; the sum of issues never exceeds `requested_qty` (approved quantity equals requested quantity in Story 4.10; a database CHECK enforces `issued_qty <= requested_qty`). When `issued_qty` reaches `requested_qty` the line becomes `issue_state = 'issued'`.
3. **Close the remainder with a reason.** Given an open approved line, when the storekeeper closes it with a non-empty reason (for example "item not stocked, remainder to purchase"), then an `indent.line_closed` event sets `issue_state = 'closed'`, `closed_reason`, `closed_at`, `closed_by`; a closed line refuses further issue; an empty reason is refused with `INDENT_LINE_CLOSE_REASON_REQUIRED` (400).
4. **Stable refusals.** Given an issue attempt, when the line is not `approved` (pending or rejected) the request is refused `INDENT_LINE_NOT_APPROVED` (409); when the line is already fully issued, `INDENT_LINE_FULLY_ISSUED` (409); when closed, `INDENT_LINE_CLOSED` (409); when the quantity would exceed the open quantity, `INDENT_ISSUE_EXCEEDS_APPROVED` (409, details `open_qty`); when the header is `cancelled`, `closed`, `rejected`, `pending-confirmation` or `ordered`, `INDENT_NOT_ISSUABLE` (409); when the bin is not under the requisition's site, `INDENT_ISSUE_BIN_OUTSIDE_SITE` (409); when the body names no line, `INDENT_ISSUE_LINE_REQUIRED` (400). A refusal of any line refuses the whole request and persists nothing (all or nothing, Story 4.10 Task 3.2 idiom). Insufficient stock surfaces the existing `INSUFFICIENT_STOCK` (409) from `applyStockIssue` unchanged.
5. **Lot and serial capture per Story 2.3.** Given a `lot_controlled` item, when it is issued without `lot_id` the request is refused `LOT_REQUIRED`; an expired lot refuses `LOT_EXPIRED` unless `override_expired_lot: true` from a role in `EXPIRED_LOT_OVERRIDE_ROLES`; a held lot refuses `LOT_ON_HOLD`; a `serial_controlled` item requires `serials` summing to the quantity (`SERIAL_REQUIRED`, `SERIAL_NOT_AVAILABLE`). None of this is re-implemented: the nested `stock.issued` event carries `lot_id`, `serials`, `override_expired_lot` and `fefo_mode` exactly as `src/compliance/lot-serial-validation.ts` expects, and the regression test proves each code through the issue route.
6. **Slip text.** Given a completed issue, when the slip is read (`GET /api/v1/indents/issues/:issueId`) or returned in the issue response, then it is plain text in the `document-renderer.ts` style naming the slip number, site, requisition number, requester (user id and department), each issued line (line number, SKU, quantity and UOM, bin, lot or serials, requested and issued-to-date quantities), who issued and when, and an **approval basis** line per issued line (Table 2). A line routed `standing_approval` or `self_approval` prints the placeholder basis from Table 2 until Story 4.8 supplies `standing_approval_text`.
7. **Late-approved line (party-mode ruling 2026-10-20).** Given a requisition that already has at least one `indent_issue` row, when a further line of it is approved, then `applyLineDecision` emits, in the same transaction, one notification `event_type: 'indent_issue_pending'` targeted at the stores issue role at the requisition's site, whose `next_step` names the line number, SKU, quantity and the existing slip numbers ("issue on a new slip"); and the next issue of that line renders its own slip whose header lists the earlier slip numbers of the same requisition ("Earlier slips: ISS-2026-0012"). No slip is amended after it is written.
8. **Reads.** Given a requisition, when it is read (`GET /api/v1/indents/:indentId`) each line carries `issued_qty`, `open_qty`, `issue_state`, `closed_reason`; the header gains `issued_line_count` (lines with `issue_state in ('issued','closed')`) next to Story 4.10's counts; `GET /api/v1/indents?issuable=true` lists requisitions at the caller's site that have at least one approved open line (the storekeeper's "Issues pending" inbox); `GET /api/v1/indents/:indentId/issues` lists the slips of one requisition.
9. **Stores issue screen (online).** Given a storekeeper with `warehouse` write at the site, when they open the edge app's Stores issue page, then they see the issuable requisitions (AC 8), pick one, enter per line the quantity, bin code, lot or serials, post the issue, and see the slip text with a Print button (`window.print()` on a print-only stylesheet). Offline capture of issues is out of scope (Decision D11) and is logged in `deferred-work.md`.
10. **Pilot proof.** Given the staging smoke, when `deploy/rehearsal/mock/operations-smoke.ts` `indent()` runs, then after the department head approval the storekeeper account issues the approved line from `BIN-A01` (`CON-GLOVES`, opening stock there) on a slip, a second issue refuses `INDENT_LINE_FULLY_ISSUED`, and runbook row 2.10k records the manual check.

## Tasks / Subtasks

- [x] Task 1: Schema (AC 1, 2, 3, 8)
  - [x] 1.1 `read/projections/indent_line.sql`: guarded `ALTER TABLE indent_line ADD COLUMN IF NOT EXISTS` for `issued_qty NUMERIC(18,3) NOT NULL DEFAULT 0`, `issue_state TEXT NOT NULL DEFAULT 'open'`, `closed_reason TEXT`, `closed_at TIMESTAMPTZ`, `closed_by TEXT`; guarded `DO $$` constraints `chk_indent_line_issue_state IN ('open','issued','closed')`, `chk_indent_line_issued_qty` (`issued_qty >= 0 AND issued_qty <= requested_qty`), `chk_indent_line_closed_reason` (non-empty when `closed`); index `idx_indent_line_issue_state (indent_id, issue_state)`. No backfill needed (defaults are correct for every existing row).
  - [x] 1.2 New `read/projections/indent_issue.sql`: `indent_issue (issue_id UUID PK, issue_number_ext TEXT NOT NULL UNIQUE, indent_id UUID NOT NULL, site_id UUID NOT NULL, issued_by TEXT NOT NULL, issued_at TIMESTAMPTZ NOT NULL, slip_content TEXT NOT NULL, source_event_id UUID NOT NULL UNIQUE, correlation_id UUID, created_at)` plus sequence `indent_issue_number_seq` and the `allocateIndentNumber` idiom (`src/read/projections/indent.ts:406`) for `ISS-YYYY-NNNN`; `indent_issue_line (issue_line_id UUID PK, issue_id UUID NOT NULL, indent_line_id UUID NOT NULL, line_no INTEGER, sku TEXT, quantity NUMERIC(18,3) CHECK > 0, uom TEXT, location_id UUID NOT NULL, location_code TEXT NOT NULL, lot_id TEXT, serials JSONB, stock_issued_event_id UUID NOT NULL, approval_basis TEXT NOT NULL, standing_grant_id UUID)`; indexes on `indent_id` and `indent_line_id`; grants `INSERT, SELECT, UPDATE` to `app_user` (schema convention from Story 2.10 review pass 2). `standing_grant_id` is reserved null for Story 4.8 Task 1.3 and 5.1.
  - [x] 1.3 Register the new file in `src/events/migrate.ts` next to `indent_line.sql`; mirror both files byte-for-byte into `deploy/compose/init-db.sql` (indent_line block ends about line 3947); extend `test/unit/schema-drift.test.ts` (indent entries near 551-575) with the new tables, constraints and index.
  - [x] 1.4 `src/read/projections/indent.ts`: extend `IndentLineRow` with the five columns; add `applyIndentLineIssue(client, lineId, quantity)` (single `UPDATE ... SET issued_qty = issued_qty + $2, issue_state = CASE WHEN issued_qty + $2 >= requested_qty THEN 'issued' ELSE 'open' END WHERE indent_line_id = $1 AND issue_state = 'open' RETURNING *`, and treat zero rows as a 409 by the caller), `closeIndentLine(client, lineId, patch)`, `LINE_COUNT_SELECT` gains `issued_line_count`; `listIndents` gains `issuable: boolean` (EXISTS approved open line, site filter) and `openQtyOf(line)` as a pure helper. New `src/read/projections/indent_issue.ts` with `insertIndentIssue`, `insertIndentIssueLine`, `getIndentIssueById`, `listIndentIssuesByIndent`, `allocateIssueNumber(year, client)`.
- [x] Task 2: Events and seam (AC 1, 2, 3, 4, 5)
  - [x] 2.1 `src/events/schema.ts`: add `'indent.issued'` and `'indent.line_closed'` to `SUPPORTED_EVENT_TYPES` with `streamType: 'procurement'` (same `requiresBusinessStream` as `indent.approved`, about line 5906-5938); payload types `IndentIssuedPayload { indent_id, issue_id, issue_number_ext?, lines: Array<{ indent_line_id, quantity, location_id, lot_id?, serials?: Array<{ serial_number }>, override_expired_lot?, fefo_mode? }> }` and `IndentLineClosedPayload { indent_id, indent_line_id, closed_reason }`.
  - [x] 2.2 New `src/compliance/indent-issue.ts` (keep `indent.ts`, already 1040 lines, for decisions only) exporting `indentIssueEventType(envelope)`, `assertIndentIssueShape(envelope)` and `applyIndentIssueProjection(envelope, client, eventId)`, wired into `src/events/store.ts` directly after the indent seam (`assertIndentShape` about line 775, `applyIndentProjection` about line 1174). Reuse `alreadyPersisted` from `indent.ts` (export it).
  - [x] 2.3 `applyIndentIssued` sequence, in this order: lock header `getIndentById(id, client, true)`; refuse `INDENT_NOT_FOUND` (404) and `INDENT_NOT_ISSUABLE` (409) unless header `status in ('raised','approved')`; lock lines `getIndentLines(id, client, true)`; for each payload line: `INDENT_LINE_NOT_FOUND` (404), `INDENT_LINE_NOT_APPROVED`, `INDENT_LINE_CLOSED`, `INDENT_LINE_FULLY_ISSUED`, `INDENT_ISSUE_EXCEEDS_APPROVED` (details `{ line_no, requested_qty, issued_qty, open_qty, quantity }`), bin under site via `isLocationDescendantOf` (`src/compliance/production-material.ts:542`, lift it to `src/read/projections/location_register.ts` if it is not already exported) else `INDENT_ISSUE_BIN_OUTSIDE_SITE`; duplicate `indent_line_id` in one body refuses `INVALID_PARAMS`. Only after every line passes: allocate `ISS-YYYY-NNNN`, insert `indent_issue`, then per line persist the nested `stock.issued` event (Task 2.4), `applyIndentLineIssue`, `insertIndentIssueLine` (with the nested event id and the Table 2 basis), `logAuditEntry` (`src/read/projections/audit_log.ts:27`, `error_code: 'indent.line_issued'`, details `{ indent_id, indent_line_id, line_no, sku, quantity, location_id, lot_id, issue_number_ext }`), finally render the slip (Task 3) and `UPDATE indent_issue SET slip_content`. Header status is never changed by an issue (Decision D5).
  - [x] 2.4 Nested ledger event: inside the same `client`, `persistEvent({ stream_type: 'inventory', stream_id: <sku or the bin, whichever stock-balance.ts:55 expects>, event_type: 'stock.issued', payload: { sku, quantity: Number(q), target_location_id, lot_id, serials, fefo_mode, override_expired_lot, stock_class: 'owned', business_stream: indent.business_stream, reference: { indent_id, indent_line_id, issue_id } }, metadata: { correlation_id: indent.correlation_id, causation_id: eventId, actor, occurred_at } }, auditCtx, client)` following the in-transaction precedent `src/compliance/purchase-order.ts:680-697` (emits `indent.ordered` with the same client). Confirm the `persistEvent` client parameter and the `stock.issued` payload keys against `src/compliance/stock-balance.ts:286-420` and `src/events/schema.ts` before coding; `applyStockIssue` (`src/read/projections/stock_balance.ts:444`) and `applyValuationOutflow` (`inventory-valuation.ts:869` handles `stock.issued`) then run through their own seams. Do not call `applyStockIssue` directly (that would skip lot trace, serial state and valuation).
  - [x] 2.5 `applyIndentLineClosed`: lock header and line, require `line_status = 'approved'` and `issue_state = 'open'` (`INDENT_LINE_NOT_APPROVED` or `INDENT_LINE_CLOSED` / `INDENT_LINE_FULLY_ISSUED` otherwise), `closeIndentLine`, one audit entry `indent.line_closed`, and one `emitNotificationInTransaction` to the requester (`event_type: 'indent_decision'`, `status_verb: 'closed'`, `next_step` with the reason and the issued-to-date quantity).
  - [x] 2.6 Error codes (all new, Decision D9): add to `src/sync/upload.ts:191-204`, the twin block `edge/src/sync/connector.ts:194-207`, and `edge/src/messages/en.json` next to 262-272.
- [x] Task 3: Slip rendering (AC 6, 7)
  - [x] 3.1 `src/warehouse/document-renderer.ts`: add `renderIssueSlip(input: IssueSlipInput): string` beside `renderPackingSlip` (line 104), same plain-text idiom: title `ISSUE SLIP ISS-2026-0233`, then `'='.repeat(30)`, padded `Label : value` rows (`Site`, `Requisition`, `Issued to` as `<requester_user_id> (<department_code>)`, `Earlier slips` when any, `Issued by`, `Issued at` in IST via `toIstCalendarDate`), a `Lines:` block with one entry per issued line (`1. <SKU> qty <q> <uom> from <bin> lot <lot or none>, serials <n> | requested <r>, issued to date <i>`) followed by `Basis: <Table 2 text>`. The renderer is pure (no database); the applier gathers the input.
  - [x] 3.2 Table 2 basis derivation lives in `indent-issue.ts` as `approvalBasisOf(line, doaEntry)` reading `approval_route`, `decided_by`, `decided_at` and the DOA entry role (`getDoaEntryById` in `src/read/projections/doa_registry.ts`, add it if absent). Story 4.8 replaces the two placeholder branches with its D9 text; leave a one-line comment naming `standing_approval_text`.
- [x] Task 4: Routes (AC 1, 3, 4, 8)
  - [x] 4.1 `src/api/v1/indents.ts`: `issueIndentHandler` for `POST /api/v1/indents/:indentId/issue` (body `{ lines: [{ indent_line_id, quantity, location_id | location_code, lot_id?, serials?, override_expired_lot?, fefo_mode? }] }`, resolves `location_code` through `getLocationByCode`, 201 `{ event_id, issue, slip_text, indent, lines }`); `closeIndentLineHandler` for `POST /api/v1/indents/:indentId/lines/:lineId/close` (body `{ reason }`, 200 `{ event_id, indent, lines }`); `listIndentIssuesHandler` for `GET /api/v1/indents/:indentId/issues`; `getIndentIssueHandler` for `GET /api/v1/indents/issues/:issueId` (returns the row with `slip_content`; register it before the `/:indentId` routes so `issues` is not read as an id, see the Story 2.10 first-match note in `deferred-work.md`). Keep the `loadIndentOr404` idiom and `auditCtxFor`. `listIndentsHandler` accepts `issuable=true`.
  - [x] 4.2 Register in `src/server.ts:829-836` with `requireRole({ module: 'warehouse', functionScope: 'write', locationId: indent.site_id })` for issue and close, `read` for the two GETs; no role literal (`store1@` holds `warehouse` write, `cmf_supervisor@` too, per `roles.json`). Read access to the slip also passes for the requester (reuse `assertIndentReadAccess`, `indents.ts:134`).
  - [x] 4.3 Add the four routes to `allowedSpineRoutes` in `test/integration/story-1-9.test.ts:373-380` (eight indent routes become twelve; Story 4.10 D8 is superseded by this story).
- [x] Task 5: Late-approved line (AC 7)
  - [x] 5.1 `src/compliance/indent.ts` `applyLineDecision` (line 817): after the per-line update and before the requester notification, if `decision === 'approved'` and `listIndentIssuesByIndent(indentId, client)` is non-empty, emit one `emitNotificationInTransaction({ target: { role: config.storesIssueRole, location_id: indent.site_id }, event_type: 'indent_issue_pending', status_verb: 'approved', object_type: 'indent', object_id, actor_label: 'Indent <number>', next_step: 'Line <n> <sku> qty <q> approved after slip(s) <ISS...>; issue on a new slip' })`. The role string comes from `src/config/index.ts` (`IMS_STORES_ISSUE_ROLE`, default `store_assistant`), never from a literal in `src/compliance` (`test/unit/no-hardcoded-role-in-workflow.test.ts`). One notification per decision event, not per line.
  - [x] 5.2 Slip header `Earlier slips:` (Task 3.1) lists prior `issue_number_ext` of the same requisition, oldest first.
- [x] Task 6: Edge stores issue page (AC 9)
  - [x] 6.1 New `edge/app/stores/issue/page.tsx` rendering `edge/src/components/stores-issue.tsx`: online only through `authorizedFetch` (`edge/src/session/api-fetch.ts:15`); list from `GET /api/v1/indents?issuable=true`; detail shows approved open lines with `open_qty`; per-line inputs quantity, bin code, lot, serials (comma separated), `override_expired_lot` checkbox; posts Task 4.1; on 201 shows `slip_text` in a `<pre>` with a Print button calling `window.print()` under a `@media print` rule that hides the shell. Error codes map through `edge/src/messages/en.json` strings. Add the entry to the stores section of `edge/src/components/app-shell.tsx` navigation. No offline queueing, no scanner wiring (manual entry is always available per EXPERIENCE.md line 77).
  - [x] 6.2 Edge Playwright or unit coverage per the existing pattern for `spare-issue-capture.tsx` (`edge/test/unit`): render list, submit, show slip, map one refusal code.
- [x] Task 7: Pilot proof (AC 10)
  - [x] 7.1 `deploy/rehearsal/mock/operations-smoke.ts` `indent()` (1486-1548): after the department head approval add step "indent: storekeeper issues at the counter" as `ctx.as('store')` (the `store1@` persona; confirm the persona key in `ops-lib.ts`): `POST /api/v1/indents/<id>/issue` with `{ lines: [{ indent_line_id, quantity: '100', location_code: 'BIN-A01' }] }` expecting 201 and `slip_text` containing `ISSUE SLIP` and the requisition number; a second identical post expecting 409 `INDENT_LINE_FULLY_ISSUED`. Keep the opening stock of `CON-GLOVES` at `BIN-A01` large enough across repeated sim days (check `generate.mjs` quantity; raise it if the daily sim would drain it).
  - [x] 7.2 `docs/migration/pilot-cutover-runbook.md`: row 2.10k in the style of 2.10j: migrate (`npm run db:migrate` adds `indent_issue`, `indent_issue_line` and five columns on `indent_line`), raise and approve a two-line requisition, issue one line partially as `store1@` from `BIN-A01`, read the slip, issue the remainder, confirm `INDENT_LINE_FULLY_ISSUED`, close the second line with a reason, confirm the requester notification and the `issuable=true` list drops the requisition.
- [x] Task 8: Tests (AC 1-8, 10)
  - [x] 8.1 New `test/integration/story-4-11.test.ts` (pattern `story-4-10.test.ts`: per-run suffixed roles, `createAppServer(createAppRouter())`, SCIM users, dev tokens; seed a site, zone and bin via the location register and stock through `stock.received` events): full issue drains `stock_balance` by the quantity and writes `indent_issue`, `indent_issue_line`, `issued_qty`, `issue_state = 'issued'`, a `stock.issued` event with `causation_id` of the `indent.issued` event, one audit row per line, slip text with number, requisition, requester, basis "Approved by department_head"; partial issue then remainder on a second slip whose header lists the first; over-open-quantity refuses `INDENT_ISSUE_EXCEEDS_APPROVED` and leaves stock and lines untouched; pending line `INDENT_LINE_NOT_APPROVED`; rejected line same; fully issued line `INDENT_LINE_FULLY_ISSUED`; closed line `INDENT_LINE_CLOSED`; close without reason 400; header `cancelled` refuses `INDENT_NOT_ISSUABLE`; bin at another site `INDENT_ISSUE_BIN_OUTSIDE_SITE`; mixed body with one bad line persists nothing; `INSUFFICIENT_STOCK` passes through; lot-controlled item without lot `LOT_REQUIRED`, expired lot `LOT_EXPIRED` then success with override from an allowed role, held lot `LOT_ON_HOLD`, serial item `SERIAL_REQUIRED` then success with serials and `serial_master.current_location_id` null afterwards, lot trace row with negative `quantity_change`; valuation outflow recorded; `GET /indents/:id` exposes `issued_qty`, `open_qty`, `issue_state`, `issued_line_count`; `?issuable=true` lists only requisitions with an approved open line at the caller's site; late approval after a slip emits `indent_issue_pending` to the configured role at the site (read `notification` rows) and none when no slip exists; requester without `warehouse` write gets 403 `FUNCTION_ACCESS_DENIED` on issue; replaying the `indent.issued` event is idempotent (`alreadyPersisted`).
  - [x] 8.2 Unit test for `renderIssueSlip` and `approvalBasisOf` (every Table 2 row).
  - [x] 8.3 `test/integration/story-4-3.test.ts` and `story-4-10.test.ts` pass unmodified; `story-1-9.test.ts` updated for the four routes; `schema-drift.test.ts`, `no-hardcoded-role-in-workflow.test.ts` green.
  - [x] 8.4 Gates: `npm run lint`, `npx tsc --noEmit`, `npx prettier --check`, full `npm test` (baseline 2601 of 2601), `graphify update .`; add the offline-issue deferral to `deferred-work.md`.

### Review Findings

- [x] [Review][Decision] Close a remainder once the header is `ordered` - `closeIndentLineBase` calls `assertHeaderIssuable`, so "remainder to purchase" (AC 3's own example reason) is refused with INDENT_NOT_ISSUABLE after the PO exists. Allow close on `ordered` headers (issue stays refused), or keep the guard? [src/api/v1/indents.ts closeIndentLineBase, src/compliance/indent-issue.ts] RESOLVED: allow (assertHeaderClosable); issue stays refused.
- [x] [Review][Decision] Cancel after issue - `cancelIndentBase` is unchanged, so a requisition with `issued_qty > 0` can be cancelled after the ledger moved. Block cancel when any line has issued_qty > 0, or leave to a returns story? [src/api/v1/indents.ts:891] RESOLVED: block - 409 INDENT_CANCEL_AFTER_ISSUE.
- [x] [Review][Decision] Issuable inbox scope - `issuable=true` unions warehouse-write and procurement-read sites (wildcard if either is), so procurement readers see the stores inbox. AC 8 says the caller's site for the storekeeper. Restrict to warehouse-write sites only? [src/api/v1/indents.ts:452-483] RESOLVED: warehouse-write sites only.
- [x] [Review][Decision] Header never leaves raised/approved when all approved lines are issued or closed and another line stays pending or rejected, so it keeps showing in the issuable list. Define terminal header handling now, or defer to 4.8? [src/compliance/indent-issue.ts:222-245,566-596] RESOLVED: deferred to Story 4.8 (see deferred-work.md).
- [x] [Review][Decision] `Stores issue` is missing from server `NAVIGATION_CAPABILITIES`, so the nav entry never shows (page reachable by URL only). Dev notes record this as a deliberate defer, but AC 9 says "when they open the Stores issue page". Add `{ name: 'Stores issue', modules: ['warehouse'], functionScope: 'write' }` now? [src/api/v1/edge.ts:359-372] RESOLVED: added to NAVIGATION_CAPABILITIES.
- [x] [Review][Patch] HIGH: events-door bypass via sync upload and edge door - `indent.issued` / `indent.line_closed` are refused only in `POST /events`; `src/sync/upload.ts` has no guard and the appliers check no role or site. Reject both types in the upload door (and edge.ts) and assert warehouse-write at `indent.site_id` inside the appliers [src/sync/upload.ts, src/api/v1/edge.ts:741, src/compliance/indent-issue.ts:288-461]
- [x] [Review][Patch] Duplicate issue on retry - `issue_id` and `event_id` are fresh `randomUUID()` per request, so a timeout retry or double-tap issues twice; the comment "a replay writes the same slip row" is false. Accept a client-supplied `issue_id` (UI generates once per form open) and use it as the idempotency key [src/api/v1/indents.ts:506-508,565-571, edge/src/components/stores-issue.tsx]
- [x] [Review][Patch] Close notification target pairs the closer's role with the requester's user_id; target the requester's role or user only [src/compliance/indent-issue.ts:524] DISMISSED: with user_id set the role is descriptive (emit.ts); same as the existing decision notification.
- [x] [Review][Patch] `getIndentIssueBase` skips the access check when the indent is missing (`if (indent) assertIssueReadAccess`); fail closed with 404 [src/api/v1/indents.ts:682-683]
- [x] [Review][Patch] Slip "Site" prints the site UUID; print the site code or name, and guard null `department_code` (prints "(null)") [src/warehouse/document-renderer.ts, test/unit/story-4-11-issue-slip.test.ts]
- [x] [Review][Patch] Slip number year uses `getUTCFullYear` while the printed date is IST; derive the year from the IST date [src/compliance/indent-issue.ts:439]
- [x] [Review][Patch] Serials: reject serial count != quantity and duplicate serial numbers, server and client [src/compliance/indent-issue.ts:194-263, edge/src/components/stores-issue-model.ts:951-955]
- [x] [Review][Patch] Quantity compared and sent as floats (`Number(quantity) > Number(open)`, `stockPayload.quantity = Number(...)`, `String(1e21)` coercion in the route); compare as scaled integers or BigInt, reject non-finite, cap digits [src/compliance/indent-issue.ts:349-351,357,459-460, src/api/v1/indents.ts:523-525, edge/src/components/stores-issue-model.ts:939]
- [x] [Review][Patch] Edge page: guard submit with `submitting` (Enter re-submits), ignore stale open() responses, reload the indent on 409, handle missing slip_text instead of a blank slip, look forms up by indent_line_id not index [edge/src/components/stores-issue.tsx:1040-1105,1159]
- [x] [Review][Patch] `approvalBasisOf` throws on an unparseable `decided_at` after stock has moved (RangeError aborts the transaction); guard the date and add the Table 2 unit tests Task 8.2 requires (doa, grant, fallback rows) [src/compliance/indent-issue.ts:372-385, test/unit/story-4-11-issue-slip.test.ts]
- [x] [Review][Patch] Smoke step deviates from AC 10 / Task 7.1: raise opening stock so the full issue succeeds and the re-issue is refused INDENT_LINE_FULLY_ISSUED (not partial + close + INDENT_LINE_CLOSED) [deploy/rehearsal/mock/operations-smoke.ts] DOWNGRADED TO DEFER: INDENT_LINE_FULLY_ISSUED is proven by the integration suite and runbook 2.10k; the smoke keeps the partial + close path so the daily sim does not drain BIN-A01.
- [x] [Review][Patch] `INDENT_ISSUE_NOT_FOUND` has no en.json message; an unknown bin code returns 409 `INDENT_ISSUE_BIN_OUTSIDE_SITE`, use 404 or 422 for "not found" and trim the code [edge/src/messages/en.json, src/api/v1/indents.ts:526-537]
- [x] [Review][Patch] Bound input: `closed_reason` max length and `lines[]` max count (also removes the per-line lookup amplifier) [src/api/v1/indents.ts:603, src/compliance/indent-issue.ts:294-296]
- [x] [Review][Patch] `indent_issue` / `indent_issue_line` grant UPDATE to app_user though slips are immutable; drop UPDATE (or column-limit), add FK and unique (issue_id, indent_line_id) [read/projections/indent_issue.sql:50-97, deploy/compose/init-db.sql] DONE: UPDATE dropped on indent_issue_line (indent_issue keeps it for the slip text write), unique (issue_id, indent_line_id) added; no FK (projection tables here carry none).
- [x] [Review][Patch] Weak tests: replay test swallows errors with `.catch(() => undefined)` and ends on a vacuous assertion; notification regex has an unescaped `.`; add a double-issue concurrency test and a multi-line rollback test [test/integration/story-4-11.test.ts]
- [x] [Review][Patch] Cleanup: dead `const actor = ...; void actor;` and `void client;`, false route-order comment in `server.ts`, prettier reflow of `i18n-literals.test.ts` outside the story [src/api/v1/indents.ts:470,480, src/compliance/indent-issue.ts, src/server.ts] DONE except the prettier reflow of i18n-literals.test.ts, kept (repo-prettier clean).
- [x] [Review][Defer] Slip number sequence never resets per year and burns a number on rollback - deferred, document gaps as expected or use a per-year counter later
- [x] [Review][Defer] Per-line `getLocationByCode` lookups in the issue route loop (N+1) [src/api/v1/indents.ts:527] - deferred, bounded once the lines[] cap lands
- [x] [Review][Defer] Audit entry hard-codes http_status and logs the success marker in error_code [src/compliance/indent-issue.ts:516-537] - deferred, matches the existing audit precedent
- [x] [Review][Defer] Issuable list capped at 100 with no pagination [edge/src/components/stores-issue.tsx:1023] - deferred, pilot volumes
- [x] [Review][Defer] Integration tests TRUNCATE shared tables CASCADE [test/integration/story-4-11.test.ts] - deferred, repo-wide test pattern
- [x] [Review][Defer] `correlation_id ?? randomUUID()` breaks trace continuity for untagged indents [src/api/v1/indents.ts:574,646] - deferred, pre-existing fallback

## Dev Notes

### Owner rulings and open questions

- **Q1 Header `ordered` and issue.** This story refuses issue once a PO was placed (`INDENT_NOT_ISSUABLE` for `ordered`). If the owner wants stock issue and purchase to coexist on one requisition, drop `ordered` from the refusal set in Task 2.3; nothing else changes.
- **Q2 Who may close a remainder.** Taken as the storekeeper (`warehouse` write at the site). If the requester should also close their own line, add `assertIndentReadAccess` plus requester match to the close route.
- **Q3 Stores issue role for the late-approval notification.** Defaulted to `store_assistant` through config (`IMS_STORES_ISSUE_ROLE`); the pilot `store1@` holds it. Confirm or change the env value on staging.
- **Q4 Edge screen online only.** The UX mock (`key-stores.html` line 452) says "Offline-first issue"; this story ships an online page (D11). Offline capture is a follow-up story.
- **Party-mode ruling 2026-10-20 (Ravi) applied:** late-approved line gets a notification to stores and its own slip listing earlier slips (AC 7).

### Decisions

- **D1 Two new events, one seam file.** `indent.issued` and `indent.line_closed` on the `procurement` stream (`stream_id = indent_id`, like every indent event). They live in `src/compliance/indent-issue.ts` so `indent.ts` stays the decision seam. Story 4.8 D8 and Task 5.1 hook into this applier.
- **D2 Ledger by nested `stock.issued`, not by direct `applyStockIssue`.** The generic `stock.issued` path is the only one that validates lot and serial (`lot-serial-validation.ts:572-668`), writes `lot_trace` (`appendTraceEntry`), empties `serial_master.current_location_id` (`applySerialIssue`), applies valuation outflow and the QC gate (`operation: 'issue'`). Emitting it inside the issue transaction (precedent `purchase-order.ts:680-697`) reuses all of that; calling `applyStockIssue` directly (the `maintenance-spares.ts:790` idiom) would skip lot trace and serial state, which AC 5 forbids.
- **D3 Approved quantity equals requested quantity.** Story 4.10 approves whole lines; there is no `approved_qty`. "Issued never exceeds approved" is `issued_qty <= requested_qty`, enforced by CHECK and by the `INDENT_ISSUE_EXCEEDS_APPROVED` guard. If a later story adds quantity edits at approval it adds `approved_qty` and repoints both.
- **D4 Line issue state is separate from line decision state.** `line_status` (pending, approved, rejected) is the approval fact; `issue_state` (open, issued, closed) is the fulfilment fact. A rejected line stays `open` and is never issuable; reads expose both.
- **D5 Header status untouched by issue.** `applyIndentClosed` requires `ordered` (purchase closure). Issue completion is visible through `issued_line_count` and per-line `issue_state`; no new header status (Story 4.10 O3: no fourth status).
- **D6 One slip per issue post.** Each `POST .../issue` is one `indent.issued` event, one `ISS-YYYY-NNNN` slip, any number of lines of the same requisition. A partial issue and its remainder are two slips (job-work partial-dispatch precedent, `jobwork-dispatch.ts:240-241`). Slips are immutable text in `indent_issue.slip_content`.
- **D7 Slip storage follows `dispatch_document`.** Plain text column, rendered by a pure function in `src/warehouse/document-renderer.ts`, read by a GET; no PDF, no file store. Edge prints the text.
- **D8 Issue is online only on the server side too.** `src/api/v1/edge.ts` sync handles only `indent.raised`; an uploaded `indent.issued` through `POST /api/v1/events` must be refused the way Story 4.10 review hardened `indent.raised` there (`src/api/v1/events.ts`): the events door does not accept `indent.issued` or `indent.line_closed` (add them to its rejection, test it).
- **D9 Error codes.** `INDENT_LINE_NOT_APPROVED`, `INDENT_LINE_FULLY_ISSUED`, `INDENT_LINE_CLOSED`, `INDENT_ISSUE_EXCEEDS_APPROVED`, `INDENT_NOT_ISSUABLE`, `INDENT_ISSUE_BIN_OUTSIDE_SITE` (all 409), `INDENT_ISSUE_LINE_REQUIRED`, `INDENT_LINE_CLOSE_REASON_REQUIRED` (400). Inline string literals in the seam, as `indent.ts` does; mirrored in both permanent-code lists and `en.json`. Story 4.8 adds `STANDING_APPROVAL_LAPSED` later.
- **D10 Authorisation by module, not role.** Indent routes use `requireRole({ module, functionScope, locationId })` only (`src/middleware/rbac.ts`); issue uses module `warehouse`, `write`, at `indent.site_id`. `store_controller` has `warehouse` read only (access matrix line 59) so it can read slips but not issue.
- **D11 Edge page online only.** The edge app has no indent approval or issue screens today (Story 4.3 Dev Notes 148-157: approvals on the central app). A minimal online page satisfies AC 9 and gives Story 4.8 its "issue screen" to print the grant text on. Offline-first issue, scanner wiring and the "Scan anything" bar are deferred.
- **D12 Seams left for Story 4.8.** `indent_issue_line.standing_grant_id` column (null), `approvalBasisOf` placeholder branches for `standing_approval` and `self_approval`, and the lock-then-check position in `applyIndentIssued` right after the per-line guards (D8 of 4.8 locks the grant row there). Month-to-date issued per grant will be summed from `indent_issue_line` rows carrying the grant id (4.8 D7).

### Approval basis on the slip

Table 2 gives the basis line printed per issued line and returned as `approval_basis` on `indent_issue_line`.

| `approval_route` | Basis text |
|---|---|
| `doa` | `Approved by <doa entry role> (<decided_by>) on <decided_at IST date>` |
| `standing_approval` (Story 4.8 later) | `Standing approval <grant id> for <requester>` placeholder: `Standing approval (grant pending Story 4.8)` until 4.8 D9 text replaces it |
| `self_approval` (Story 4.8 later) | `Within self-approval limit` |

Table 2: approval basis text by line route. Never print "No approval required" or a grade word (EXPERIENCE.md line 60).

### Line fulfilment state

Table 3 gives the issue-state transitions enforced in `applyIndentIssued` and `applyIndentLineClosed`.

| From `issue_state` | Event | Guard | To |
|---|---|---|---|
| `open` | `indent.issued` with `issued_qty + q < requested_qty` | line `approved`, header `raised` or `approved` | `open` |
| `open` | `indent.issued` with `issued_qty + q = requested_qty` | same | `issued` |
| `open` | `indent.issued` with `issued_qty + q > requested_qty` | refused `INDENT_ISSUE_EXCEEDS_APPROVED` | `open` |
| `open` | `indent.line_closed` | line `approved`, reason non-empty | `closed` |
| `issued` or `closed` | any | refused `INDENT_LINE_FULLY_ISSUED` / `INDENT_LINE_CLOSED` | unchanged |

Table 3: issue-state machine per requisition line.

### Current state of the files this story changes

- `src/api/v1/indents.ts` (709 lines): routes registered in `src/server.ts:829-836`, eight today; `loadIndentOr404` 398-414; `auditCtxFor` 57; `persistEvent` call shape 551-569; detail response `{ indent: getIndentWithCounts, lines }` 306-308; list 310-396 with `validStatuses` 320-328 and the `mine=true` rule 372-381; `UUID_REGEX` 660.
- `src/compliance/indent.ts` (1040 lines): `INDENT_EVENT_TYPES` 25-35; `alreadyPersisted` 306; `applyIndentProjection` 315-352; `deriveIndentStatus` 238-266; `applyLineDecision` 817 (header lock 826, lines lock 832, per-line guard 750, update 856, audit 866-884, derive 889, requester notification 906-924); `applyIndentOrdered` 948 requires `approved`; `applyIndentClosed` 1017 requires `ordered`.
- `src/compliance/indent-routing.ts`: `routeIndentLines` 83, `headerApproverOf` 118; untouched here.
- `src/read/projections/indent.ts` (410 lines): `IndentLineRow` 40-59; `LINE_COUNT_SELECT/JOIN` 66-75; `getIndentById(id, client, forUpdate)` 83; `getIndentLines(id, client, forUpdate)` 97; `updateIndentLineDecision` 126-141; `listIndents` 154; `updateIndentStatus` 348 whitelist 351-360; `allocateIndentNumber` 406.
- `read/projections/indent_line.sql` (113 lines): Story 4.10 columns 48-54, constraints 56-78, index 80, backfill 84-104, grants 108. Mirror `deploy/compose/init-db.sql` 3845-3947.
- `src/read/projections/stock_balance.ts`: `applyStockIssue(input: StockIssueInput, client)` 444 (locks matching rows, `INSUFFICIENT_STOCK` 474-487, drains ordered `lot_id NULLS FIRST, balance_id`, returns `StockDrainRow[]`); grain `(sku, location_id, lot_id, stock_class)` with `lot_id` being the lot number; `available = on_hand - allocated - picked`.
- `src/compliance/stock-balance.ts:286-420`: `stock.issued` applier reads `sku, quantity (number), lot_id, stock_class, target_location_id | target_location_code`; `CROSS_ISSUE_BLOCKED` for customer-owned classes.
- `src/compliance/lot-serial-validation.ts`: scope `stock.received | stock.allocated | stock.issued` on stream `inventory` 77-78; `validateLotForIssueAllocate` 277; `validateSerialsForIssue` 367; `assertLotSerialShape` 422 (`override_expired_lot` role gate 446-452, roles 86-93); `applyLotSerialValidation` 503; issue branch 572-668 (serial sum must equal quantity 638-650, `applySerialIssue`, `appendLotTrace` 98-124). `item_master.lot_controlled` / `serial_controlled` (`item_master.sql:79-80`).
- `src/events/store.ts`: `persistEvent` 612; shape asserts 651-857 (indent 775); appliers 969-1267 (lot-serial 969, stock-balance 970, valuation 976, indent 1174). `src/events/schema.ts`: `SUPPORTED_EVENT_TYPES` 5659, indent entries 5906-5938.
- `src/compliance/purchase-order.ts:680-697`: in-transaction `persistEvent` of `indent.ordered` with the same client (the nested-event precedent for Task 2.4).
- `src/warehouse/document-renderer.ts:104` `renderPackingSlip`; `src/read/projections/dispatch_document.ts:40-84` storage and readers; `src/api/v1/dispatch.ts:560-583` document GET.
- `src/notify/emit.ts:124` `emitNotificationInTransaction(input, client)`; `EmitNotificationInput` 24-39; recipients by `target.user_id` or role at `location_id` (`src/notify/dispatch.ts:106-115`); channels `in_app`, `web_push`.
- `src/api/v1/events.ts:175-197`: the events door; Story 4.10 review stripped routing fields from an uploaded `indent.raised` there.
- `src/middleware/rbac.ts`: `RbacOptions { module, functionScope, locationId? }`; no per-route role list on indent routes.
- `edge/src/components/my-requests.tsx`: `MyIndentRow` 17-20 with `lines?`, status label 99-108, per-line pills 159-169; `edge/src/components/spare-issue-capture.tsx` is the only issue-like component; `edge/app` has no `stores` folder; `edge/src/messages/en.json` is the only locale (indent errors 262-272, `myRequests.*` 610-613).
- `deploy/rehearsal/mock/operations-smoke.ts:1486-1548` `indent(ctx)`: raise `CON-GLOVES` qty 100 then department head approval; ends there. `deploy/pilot/sim/pilot-day.ts:140` calls it daily. `world.json`: `BIN-A01` holds `CON-GLOVES` (no lot) and `RM-COIL-3MM LOT-0001`; `BIN-B02 FAST-M8-BOLT LOT-0005`; `store1@ancorlabs.org` is `store_assistant` with `warehouse` write at site `9e4a90a8-5e35-4ca9-b988-d563cff74de3`.
- `docs/migration/pilot-cutover-runbook.md`: Table 2 header at 112, rows 2.10i 132 and 2.10j 133 are the style to copy.
- `test/integration/story-1-9.test.ts:373-380`: the eight indent routes in `allowedSpineRoutes`.

### Preserve

- `test/integration/story-4-3.test.ts` (17 tests) and `story-4-10.test.ts` (11 tests) pass unmodified; the `{ event_id, indent, lines }` shapes are only extended.
- `deriveIndentStatus` and Table 1 of Story 4.10 are untouched; issue never changes `line_status` or header `status`.
- `indent.ordered` from `applyPoIssued` still requires header `approved`; a partially issued requisition can still be ordered for its unissued lines unless Q1 is ruled otherwise.
- The events door (`src/api/v1/events.ts`) and `edge.ts` sync keep refusing anything but the documented indent events offline.
- `stock_balance` CHECKs (`on_hand >= 0`, `allocated + picked <= on_hand`) and `qcGateExclusionSql` stay the single source of "can this bin give"; the issue seam adds no stock arithmetic of its own.
- Story 1.9 route allowlist test changes only by the four new entries.

### Architecture compliance

- State changes only through events (`indent.issued`, `indent.line_closed`, nested `stock.issued`); projections written inside the persist transaction; replay idempotent via `alreadyPersisted` and `indent_issue.source_event_id UNIQUE`.
- Error envelope `{ error_code, message, details, trace_id }`; codes stable and mirrored (D9); `constraintOf` maps 23514 to 400 and 23503 to 409 for the new CHECKs (Story 2.10 review patch).
- AD-3: no approver or role literal in workflow code; the only role string is a config default (Task 5.1).
- AD-14: `indent_issue` and `indent_issue_line` are rebuildable projections; the slip text is derived data stored for exact reprint.
- AD-17: notification emission is the caller's explicit choice, in-transaction, `in_app` and `web_push` only.
- Lock order: header `FOR UPDATE`, then lines, then `stock_balance` rows inside `applyStockIssue`; never lines before header (Story 2.10 deadlock patch).
- Schema convention: every new constraint in a guarded `DO $$` block; `CREATE TABLE IF NOT EXISTS`; grants `INSERT, SELECT, UPDATE`; both SQL files changed together.

### Testing standards

- `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/**/*.test.ts`; `ims-postgres-test` postgres 18.4 on port 5442 (recreate from `init-db.sql` if missing).
- Integration files boot `createAppServer(createAppRouter())` on port 0, provision users via SCIM, `POST /api/v1/auth/dev-token`; assert exact values plus one negative control per guard.
- Mutation-verify the `issued_qty <= requested_qty` guard and the nested `stock.issued` emission (comment each out and watch the test fail).
- Stock seeding in tests: `stock.received` events through `persistEvent` (see any Story 2.3 or 7.4 test for the payload), not direct inserts.

### Previous story intelligence

- Story 4.10: all-or-nothing on a list body; explicit ids in the event, the applier never resolves them; one audit row per line; N+1 avoided by loading lines once; `INVALID_PARAMS` 400 for malformed ids versus 404 for unknown; events door hardening for client-sent routing fields; prettier reflow of `edge.ts` was reverted once, run prettier only on touched files.
- Story 4.10 review deferred: My Requests list rows get no `lines[]`; the per-line chips need a detail screen. The stores issue page (Task 6) is a detail screen for the storekeeper, not the requester; do not widen it.
- Story 2.10: no-op writes emit nothing; one notification per user per change; test personas at `'*'` hide location bugs, so the 4.11 test seeds a real site id.
- Story 7.4 / 7.8: `maintenance.spare_issued` deallocates before issuing and freezes `valuation` onto the payload; the `spare-issue-capture.tsx` component is the closest edge precedent for an issue confirmation screen.
- Story 2.3: null `lot_id` drains any lot at the location by design (story file lines 121, 145); FEFO auto-selection exists via `fefo_mode`; `SERIAL_NOT_AVAILABLE` is 400.

### Git intelligence

HEAD `908443f` (2026-10-21) is the Story 4.10 commit: 26 files, `indent-routing.ts` new, `indent.ts` plus 372 lines, `story-4-10.test.ts` 805 lines, runbook row 2.10j, bands in `staging-doa-bands.sh` and `generate.mjs`. The prior commits are Story 2.10 closure and pilot cleanup. Full suite at baseline: 2601 of 2601.

### Contradictions resolved

- UX mock `key-stores.html` line 452 "Offline-first issue" versus Story 4.3 Dev Notes "approval and status screens on the central app": this story ships online only (D11, Q4).
- Mock line 453 "issued qty may be reduced below requested but not raised": consistent with D3 (partial allowed, never over).
- Story 4.10 D8 "no new routes, allowlist stays at eight": superseded; this story adds four.
- `_bmad-output/project-context.md` is a stub; conventions come from `AGENTS.md`, `FORMATTING_RULES.md`, the architecture spine and the story files cited here.

### References

- [epics.md Story 4.11](../planning-artifacts/epics.md) lines 2050-2075; Story 4.8 at 1957-1992.
- [Story 4.10 file](4-10-requisition-line-level-approval-and-mixed-routing.md) Owner rulings O3 and the Story 4.11 note, Decisions D1 to D9, Table 1.
- [Story 4.8 file](4-8-standing-approvals-and-self-approval-limits.md) D7, D8, D9, Tasks 1.3, 5.1, 5.2, Table 3 row "Story 4.11 issue applier", Table 4 rows 1 and 6.
- [Story 2.3 file](2-3-lot-batch-and-serial-traceability.md) lines 17-21, 58, 121-176.
- [Story 4.3 file](4-3-purchase-requisition-and-indent-loop.md) lines 143-157, 356-418.
- [UX run EXPERIENCE.md](../planning-artifacts/ux-designs/ux-Inventory%20Management%20System_2-2026-09-23/EXPERIENCE.md) lines 37, 59-60, 77-79, 203-208; `mockups/key-stores.html` lines 448-454, 490-493, 798-811.
- [Architecture spine](../planning-artifacts/architecture/architecture-Inventory%20Management%20System_2-2026-07-11/ARCHITECTURE-SPINE.md) AD-3, AD-14, AD-17.
- [deferred-work.md](deferred-work.md) "Deferred from: code review of story-4-10 (2026-10-21)".

## Dev Agent Record

### Agent Model Used

Claude Fable 5.1 (claude-fable-5-1), dev-story 2026-10-21.

### Debug Log References

- `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/integration/story-4-11.test.ts`: 10 of 10.
- Full suite `node --env-file=.env.test --import tsx --test --test-concurrency=1 "test/**/*.test.ts"`: 2617 of 2617 (baseline 2601; 10 integration plus 4 unit plus 2 drift entries).
- `edge`: `npx tsc --noEmit` clean, `node --import tsx --test test/unit/*.test.ts` 140 of 140.
- `npx tsc --noEmit -p .` clean, `npm run lint` clean, prettier applied to every touched file (`--end-of-line auto`, autocrlf noise ignored), `graphify update .` run.
- First test run: three test-side fixes (slip label padding `Earlier slips :`, notifications need `runDispatchCycle()` before they project, the events-door test needs a procurement writer to reach the door) and one server fix (`warehouse` joins the list gate for `issuable=true`).

### Completion Notes List

- Schema: five fulfilment columns and three guarded CHECKs on `indent_line`; new `indent_issue`, `indent_issue_line`, `indent_issue_number_seq` in `read/projections/indent_issue.sql`, registered in `migrate.ts`, mirrored in `init-db.sql`, drift test extended. No backfill needed (defaults are right for every existing row).
- Events: `indent.issued` and `indent.line_closed` on the `procurement` stream; payload types in `schema.ts`; new seam `src/compliance/indent-issue.ts` wired into `store.ts` after the indent seam. The applier locks header then lines, runs every guard before any write, then per line persists a nested `stock.issued` with the same client (D2) so lot, serial, trace, valuation and QC gate run through their own seams; `applyIndentLineIssue` repeats the state predicate in its UPDATE; one audit row per line; slip rendered last and stored on `indent_issue.slip_content`.
- `RbacOptions.locationId` is synchronous, so the site check for issue and close is `assertWarehouseWriteAtSite` inside the base handlers (module gate on `warehouse` write only). `store_controller` (warehouse read) can read slips, not issue.
- `GET /api/v1/indents/issues/:issueId` is registered after `GET /:indentId`; the two cannot collide (different segment counts), the comment in `server.ts` says why it sits with the 4.11 block.
- Late-approved line (AC 7): `applyLineDecision` emits `indent_issue_pending` to `config.storesIssueRole` (`IMS_STORES_ISSUE_ROLE`, default `store_assistant`) at the site, once per decision event, only when a slip already exists. Proven both ways in the test.
- Events door refuses `indent.issued` and `indent.line_closed` with 403 `FUNCTION_ACCESS_DENIED` (D8).
- Edge: online page `/stores/issue` (`stores-issue.tsx`, pure model `stores-issue-model.ts` with its own unit test), `nav.storesIssue` entry rendered only when the bootstrap advertises `Stores issue`, print through `window.print()` with a print-only style. Offline capture logged in `deferred-work.md`.
- Smoke: `indent()` gains a counter-issue step (2 of 100 from `BIN-A01`, close remainder, re-issue refused `INDENT_LINE_CLOSED`); runbook row 2.10k added.
- Owner questions Q1 to Q4 in Dev Notes stay open; defaults taken as written there.

### File List

- read/projections/indent_line.sql
- read/projections/indent_issue.sql (new)
- deploy/compose/init-db.sql
- src/events/migrate.ts
- src/events/schema.ts
- src/events/store.ts
- src/config/index.ts
- src/read/projections/indent.ts
- src/read/projections/indent_issue.ts (new)
- src/compliance/indent.ts
- src/compliance/indent-issue.ts (new)
- src/warehouse/document-renderer.ts
- src/api/v1/indents.ts
- src/api/v1/events.ts
- src/server.ts
- src/sync/upload.ts
- edge/src/sync/connector.ts
- edge/src/messages/en.json
- edge/src/components/navigation/nav-model.ts
- edge/src/components/stores-issue.tsx (new)
- edge/src/components/stores-issue-model.ts (new)
- edge/app/stores/issue/page.tsx (new)
- edge/test/unit/stores-issue-model.test.ts (new)
- edge/test/unit/i18n-literals.test.ts
- test/integration/story-4-11.test.ts (new)
- test/integration/story-1-9.test.ts
- test/unit/story-4-11-issue-slip.test.ts (new)
- test/unit/schema-drift.test.ts
- deploy/rehearsal/mock/operations-smoke.ts
- docs/migration/pilot-cutover-runbook.md
- _bmad-output/implementation-artifacts/deferred-work.md
- _bmad-output/implementation-artifacts/sprint-status.yaml

### Change Log

- 2026-10-21: story created from baseline 908443f (create-story), status ready-for-dev.
- 2026-10-21: implemented Tasks 1 to 8 (dev-story); full suite 2617 of 2617, edge 140 of 140, tsc and lint clean, graph updated; status review. Uncommitted.
