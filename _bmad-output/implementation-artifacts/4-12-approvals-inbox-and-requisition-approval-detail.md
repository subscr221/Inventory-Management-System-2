---
status: done
baseline_revision: 5ea4f23551bfe4d3c1159be7f2ac16bb6c939e22
baseline_commit: 5ea4f23551bfe4d3c1159be7f2ac16bb6c939e22
context:
  - _bmad-output/planning-artifacts/epics.md
  - _bmad-output/planning-artifacts/sprint-change-proposal-2026-10-21.md
  - _bmad-output/implementation-artifacts/ux-screen-coverage-audit-2026-10-21.md
  - _bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/EXPERIENCE.md
  - _bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/DESIGN.md
  - _bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/mockups/key-approvals.html
  - _bmad-output/implementation-artifacts/4-10-requisition-line-level-approval-and-mixed-routing.md
  - _bmad-output/implementation-artifacts/4-11-stores-counter-issue-against-a-requisition.md
  - _bmad-output/implementation-artifacts/3-16-floor-task-inbox-and-pick-execution-screen.md
  - src/api/v1/indents.ts
  - src/api/v1/edge.ts
  - src/read/projections/indent.ts
  - src/read/projections/doa_registry.ts
  - src/compliance/indent.ts
  - edge/src/components/app-shell.tsx
  - edge/src/components/edge-client.tsx
  - edge/src/components/navigation/nav-model.ts
  - edge/src/components/floor-tasks.tsx
  - edge/src/components/my-requests.tsx
  - edge/src/components/standing-grants.tsx
  - edge/src/messages/en.json
  - edge/test/unit/i18n-literals.test.ts
  - docs/migration/pilot-mock-extract/roles.json
  - docs/migration/pilot-cutover-runbook.md
---

# Story 4.12: Approvals Inbox and Requisition Approval Detail

Status: done

## Story

As a department head or finance controller holding an `indent_approval` DOA band (or their active delegate),
I want an Approvals inbox that lists the requisitions waiting for me and lets me approve or reject the lines routed to me,
so that UJ-IND-01 completes inside the edge app and stores can issue the approved lines.

PRE-PILOT BLOCKING. Closes audit gap G06 (Ask for info carved out to Story 4.13). Pilot approvers: department head `subscr@ancorlabs.org` and finance controller `accounts@ancorlabs.org` (`docs/migration/pilot-mock-extract/roles.json`). Size L.

## Acceptance Criteria

**AC 1 - Navigation and role gating**

Given a caller who actively holds the role of any `listActiveDoaEntries('indent_approval')` entry at the site (`src/read/projections/doa_registry.ts:218`, with `isActiveRoleHolderForEntry` `:338` and its `locationId` argument) or is the active delegate of such a holder (new delegate-side lookup, Task 1.1),
when the bootstrap runs,
then navigation carries `Approvals` from a new row `{ name: 'Approvals', modules: 'approvals', functionScope: 'read' }` in `NAVIGATION_CAPABILITIES` (`src/api/v1/edge.ts:401-427`; the modules union at `:401` gains `'approvals'`) resolved in `navigationFor` (`:461`) by a new `hasIndentApprovalScope(authContext, siteId)` modelled on `hasDamageCaseScope` (`:435`); NAV_ENTRIES gains `{ name: 'Approvals', href: '/approvals', label: 'nav.approvals' }` (`edge/src/components/navigation/nav-model.ts:11-37`); `approvals` joins `BaseView` and `BASE_VIEW_ENTRY` (`edge/src/components/app-shell.tsx:144-180`) and the duplicate union in `edge/src/components/edge-client.tsx:241-265`; a deep link without the entry renders the existing no-access card (`app-shell.tsx:382-391`) with no fetch.

**AC 2 - Server list filters (`pending_for_me`, `decided_by_me`)**

Given Task 1 server work,
when `GET /api/v1/indents?pending_for_me=true` or `?decided_by_me=true` is called,
then `listIndentsBase` (`src/api/v1/indents.ts:406`) parses both flags (today only `status`, `search`, `mine`, `issuable`, `limit`, `offset`), branches before the base-role refusal at `:490` as the issuable branch does at `:468`, bypasses the raiser-site scope, and calls `listIndents` (`src/read/projections/indent.ts:266`) with an approver filter; `pending_for_me` returns headers in status `raised` (never `pending-confirmation`) having at least one line with `line_status = 'pending'` whose `approver_actor_id` is the caller or a delegator the caller actively represents; `decided_by_me` returns headers having at least one line whose `decided_by` is the caller; every row in either branch carries `pending_for_me_line_ids` (string array, empty for decided), `line_skus` (string array, for the client search), `requester_display_name` and the unmasked `estimated_value` (the `mine` masking at `:515-524` does not apply); the response adds top-level `approver_bands: [{ role, value_min, value_max }]` for the `indent_approval` entries the caller actively holds at the site; a holder with nothing pending gets `{ indents: [], approver_bands }` and never `FUNCTION_ACCESS_DENIED`; both flags together, or either with `mine` or `issuable`, answer 400 `INVALID_PARAMS`.

**AC 3 - Detail, approve and reject admit the resolved approver**

Given Task 1 server work,
when `GET /api/v1/indents/:indentId`, `POST .../approve` or `POST .../reject` is called by a caller who is the resolved approver, the active delegate of the resolved approver, or the decider of at least one line, but holds no procurement role,
then `approveIndentHandler` and `rejectIndentHandler` (`src/api/v1/indents.ts:1142-1150`) gate on `module: [EMPLOYEE_MODULE, 'procurement'], functionScope: 'write'` (the shape `raiseIndentHandler` uses at `:1111`), `assertIndentReadAccess` (`:223`) gains a third admit branch for an approver, active delegate or decider of any line, and the seam keeps enforcing identity per line (`assertLineDecisionAllowed` `src/compliance/indent.ts:893`, `decideAsApprover` `:945`); the detail response adds per line `approver_band: { role, value_max } | null` (joined from `doa_entry_id`), `decided_by_display_name`, and top-level `requester_display_name`, `pending_for_me_line_ids` and `approver_bands`; confirm, withdraw and cancel stay procurement write (the remaining half of `deferred-work.md:1182`); `test/integration/story-4-12.test.ts` proves list, detail, approve and reject with a finance holder provisioned exactly as `roles.json` provisions `accounts@` (employee write at the site plus migration, jobwork, compliance write and inventory read at `*`, no procurement).

**AC 4 - Inbox screen**

Given `/approvals` online,
when the inbox loads (`GET /api/v1/indents?pending_for_me=true` and `?decided_by_me=true`, merged client-side for All),
then tabs Waiting and Decided carry counts and All carries none (`aria-pressed` buttons in a `role="group"` labelled Show, mock key-approvals.html L579-581); Handheld and Tablet render cards (type `Requisition`, reference, amount, subline of item skus, requester, age, status pill; L611-615), Desktop and Desktop touch render a table captioned `Approvals for <role>` with columns Type / reference, Requested by, Amount, Age, Status (L598-603; the SLA column is omitted because SLA hours are mock values, EXPERIENCE.md:171); the status pill reads Waiting, Approved or Rejected in text (DESIGN.md:187-201, :260); a client-side search over reference, item sku and requester (placeholder `Search reference, item, requester`, L575); the band line `Your DOA band as <role>: up to Rs <max>` from `approver_bands`, hidden when empty (L586); the empty Waiting state `Nothing waiting for you` with `New approvals for <role> appear here. Last checked <time>.` and a `See decided items` button (L590), and `No items match` with `Clear filters` when a search empties a tab (L591); no approval-type filter ships because this story carries one type (owner question Q26).

**AC 5 - Requisition detail**

Given a requisition selected by `/approvals?indent=<id>` (query string, no dynamic segment) and fetched from `GET /api/v1/indents/:indentId`,
when it renders,
then a DOA note (`role="note"`) states why it reached the caller: `Routed to you as the requester's head of department by value band (up to Rs <band>)` from the pending line's `approver_band` (L625), with the finance wording `Routed to you as finance controller by value band (above Rs <value_min>)` when the band has no `value_max`; every line shows its route chip per DESIGN.md:302-304 from `approval_route` (`src/read/projections/indent.ts:40`): `Standing approval <standing_grant_ref>` in the ok pair with `<month_to_date_issued> of <cap> used this month` when `cap` is set (Story 4.8 `GrantLineView`, `src/api/v1/indents.ts:143`), `Self-approval limit` in the info pair, `<band role> approval` in the warn pair for `doa` lines; a `line_status` pill with text; lines in `pending_for_me_line_ids` read `Waiting for you`, the others read-only with decider name and time; an Evidence table lists line, sku, qty, value with a Total footer when more than one line (L631-633); a History block lists the raise (`created_at`, requester name) and each line decision (`decided_at`, `decided_by_display_name`, `rejection_reason`) (L652-656); no per-line selection control; with no selection, Tablet and Desktop show `Pick an approval from the list` (L785).

**AC 6 - Approve and Reject**

Given the detail with at least one line pending for the caller, online,
when Approve is activated, or Reject is opened and `Confirm reject` is activated with a non-empty reason (label `Reason for rejection (required, sent to the requester)`, hint `Required before you can reject.`, `Confirm reject` disabled until text, `Cancel` beside it, L709-715),
then `POST /api/v1/indents/:indentId/approve` or `/reject` is sent with `line_ids` equal to `pending_for_me_line_ids` (reject also sends `rejection_reason`); the detail confirms inline (`Approved by you, <time>. <requester> has been notified.` or `Rejected by you, <time>. Reason sent to <requester>: "<reason>"`, L719, L722), the lists re-fetch and the item moves to Decided with no undo (EXPERIENCE.md:171); Approve and Confirm reject are guarded against double activation while a request is in flight; a 409 reloads the detail; `INDENT_LINE_ALREADY_DECIDED`, `INDENT_LINE_NOT_FOUND`, `INDENT_RAISER_CANNOT_APPROVE`, `NOT_RESOLVED_APPROVER`, `INDENT_NOT_IN_RAISED`, `INDENT_PENDING_CONFIRMATION`, `INDENT_ALREADY_DECIDED`, `INDENT_REJECTION_REASON_REQUIRED`, `INVALID_PARAMS` and `FUNCTION_ACCESS_DENIED` render through `errorMessage()` (`edge/src/i18n/locale.ts:37-41`) from the existing `errors.*` keys (`edge/src/messages/en.json:107`, `:264-276`; add only those missing); nothing is written to the outbox; recorded spine deviation: EXPERIENCE.md:137 places Ask for info in the footer and this story ships without it (Story 4.13 adds it).

**AC 7 - Offline and fetch failure**

Given `navigator.onLine` is false or a fetch fails,
when the page is open,
then Approve and Reject are disabled and a `role="status"` block reads `Offline - approvals need a connection. Decisions are checked live against the latest stock and your DOA band, so they are not queued. Reconnect to decide. Evidence shown is from the last sync at <time>.` (mock L707); the last fetched list and detail stay readable with that time; with nothing fetched yet the needs-connection card renders (pattern `my-requests.tsx:286-300`); the page re-fetches when `online` turns true (EXPERIENCE.md:100).

**AC 8 - Device classes, accessibility, i18n, runbook**

Given the four device classes (`edge/src/lib/use-device-class.ts:10`),
when axe and a keyboard-only pass run,
then Handheld opens the detail as its own page with a Back button and a pinned footer that replaces the bottom nav (mock L846 `task mode`): Approve full width 56 px, Reject 48 px secondary; Tablet shows list and detail panes (56/48 px) behind the icon rail; Desktop shows two panes with 34 px compact controls under the sidebar; Desktop touch shows the Desktop layout with 56/48 px targets (DESIGN.md:224-229, EXPERIENCE.md:111, :123, :137); zero WCAG 2.1 AA violations on `/approvals` and `/approvals?indent=<id>`; every string under `approvals.*` plus `nav.approvals`; the i18n literal guard extended; runbook row 2.10n (a two-line requisition approved from phone and desktop windows, then issued as `store1@`) added to `docs/migration/pilot-cutover-runbook.md` and passed on staging.

## Tasks / Subtasks

- [x] Task 1: Server contract (AC 1, AC 2, AC 3)
  - [x] 1.1 `doa_registry.ts`: add `listActiveDelegatorsFor(delegateUserId, asOfDate, client?) : Promise<string[]>`. It MUST mirror `findActiveDelegation` (`:267`) exactly: per delegator take the earliest-created active delegation within dates whose delegate user is active (`DISTINCT ON (delegator_user_id) ... ORDER BY delegator_user_id, created_at, delegation_id`), then keep rows whose `delegate_user_id = $1`. A delegator with two overlapping delegations routes only to the earliest one in the seam, so the inbox must not show the line to the second delegate (it would answer `NOT_RESOLVED_APPROVER`). Unit or integration test both cases.
  - [x] 1.2 `doa_registry.ts`: add `listHeldIndentApprovalBands(userId, siteId, client?)` returning `{ entry_id, role, value_min, value_max }[]` for active `indent_approval` entries whose role the user actively holds at the site (reuse the join in `isActiveRoleHolderForEntry` `:338` with `locationId`), plus the same for each delegator from 1.1 (the delegate inherits the band they act under).
  - [x] 1.3 `edge.ts`: widen the `modules` union with `'approvals'`, add the nav row after `My requests`, add `hasIndentApprovalScope(authContext, siteId)` (true when 1.2 is non-empty for the user at the site), branch in `navigationFor`. Unit test the branch beside the existing navigation tests.
  - [x] 1.4 `indent.ts` projection: extend `ListIndentsParams` with `approverIds?: string[]` (caller plus represented delegators, pending branch) and `decidedBy?: string`; filter with `EXISTS` subqueries on `indent_line`; select `pending_for_me_line_ids` (`array_agg(indent_line_id) FILTER (WHERE line_status='pending' AND approver_actor_id = ANY($n))`, `'{}'` for decided) and `line_skus` in the same query (no N+1); `pending_for_me` also requires header `status = 'raised'`. Keep ordering `created_at DESC, indent_id ASC`.
  - [x] 1.5 `indents.ts` `listIndentsBase`: parse `pending_for_me` and `decided_by_me` (`'true'` only); refuse the combinations in AC 2 with 400 `INVALID_PARAMS`; branch before `:490`; attach `requester_display_name` with `displayNamesFor` (`src/read/projections/damage_report.ts:391`, one call per response, not per row) and `approver_bands` from 1.2; do not mask `estimated_value`.
  - [x] 1.6 `assertIndentReadAccess`: add the third admit branch (caller equals any line's `approver_actor_id` or `decided_by`, or is the active delegate of any line's approver via `findActiveDelegation`, cached per approver as `pendingLineIdsFor` does at `src/compliance/indent.ts:278`). Keep the existing order: procurement read at site, requester, then approver; keep `LOCATION_ACCESS_DENIED` for a procurement reader elsewhere who is not an approver.
  - [x] 1.7 `getIndentBase` (`:386`): add `requester_display_name`, `pending_for_me_line_ids` (reuse `pendingLineIdsFor`, but return `[]` when the caller is the requester: that helper returns all pending lines for the requester so SOD-01 fires, which is wrong for display), `approver_bands` (1.2), and per line `approver_band` and `decided_by_display_name`.
  - [x] 1.8 Change `approveIndentHandler` and `rejectIndentHandler` to `module: [EMPLOYEE_MODULE, 'procurement']` write. Leave confirm, withdraw, cancel on procurement write. Update the JSDoc.
  - [x] 1.9 `test/integration/story-4-12.test.ts` (copy the `makeRequest`, `provisionUser`, `authFor` helpers from `test/integration/story-4-11.test.ts:36-93`; bands via `POST /api/v1/doa/entries` as `story-4-10.test.ts:213-239` does): finance holder without procurement lists pending, reads detail, approves a line above Rs 1,00,000; department head rejects with reason; an active delegate sees and decides the delegator's line; the second of two overlapping delegates sees nothing; a holder with nothing pending gets `[]` not 403; a plain employee gets 403 on detail; the requester's detail returns `pending_for_me_line_ids: []`; `decided_by_me` lists after the decision; `pending-confirmation` headers are excluded; invalid flag combinations answer 400; confirm, withdraw and cancel still refuse an employee-only caller.
  - [x] 1.10 Re-run `test/integration/story-4-3.test.ts`, `story-4-10.test.ts`, `story-4-11.test.ts`, `story-1-15*.test.ts` and `story-1-9.test.ts` unchanged (no new route, so the spine allowlist at `story-1-9.test.ts:377-389` is untouched).

- [x] Task 2: Edge view wiring (AC 1)
  - [x] 2.1 `edge/app/approvals/page.tsx` returning `<EdgeClient view="approvals" />` (shape of `edge/app/standing-grants/page.tsx`).
  - [x] 2.2 `nav-model.ts` entry, `en.json` `nav.approvals: "Approvals"` beside `nav.standingGrants`, `BaseView`, `BASE_VIEW_ENTRY` (`'approvals': 'Approvals'`), `edge-client.tsx` union, AppShell mount branch `view === 'approvals' ? <Approvals online={online} onTaskModeChange={setTaskMode} />`.
  - [x] 2.3 AppShell task mode: add local state `taskMode` and skip `<BottomNav>` (`app-shell.tsx:591`) while it is true. Approvals sets it true only on Handheld with a detail open and false on unmount. Do not read `window.location` in AppShell render (3.15 build break, see Previous story intelligence).

- [x] Task 3: Inbox (AC 4, AC 7)
  - [x] 3.1 Pure model `edge/src/components/approvals-model.ts`: row type, `mergeAll(waiting, decided)` deduped by `indent_id`, `statusOf(row)` (Waiting when `pending_for_me_line_ids` non-empty, else Approved or Rejected from header status, Decided rows whose header is still `raised` read from their decided lines), `matchesSearch(row, q)`, `formatAge`, band line text, DOA note text, route chip descriptor `{ kind: 'ok' | 'info' | 'warn', key, params }`.
  - [x] 3.2 `edge/src/components/approvals.tsx`: imports `authorizedFetch` itself (as `standing-grants.tsx` and `my-requests.tsx` do); two reads in parallel; request-sequence ref so a stale response never overwrites a newer one (`my-requests.tsx:235-280`); 403 renders no-access, never an endless spinner; keep `fetchedAt` for the last-synced text.
  - [x] 3.3 Tabs, counts, search, band line, both empty states, cards on Handheld and Tablet, `<table>` with `<caption>` on Desktop and Desktop touch, rows as buttons that set `?indent=` via `history.pushState` and re-read on `popstate`.

- [x] Task 4: Detail and decisions (AC 5, AC 6, AC 7)
  - [x] 4.1 Read `?indent=` in a `useState` initializer guarded by `typeof window === 'undefined'`, re-read in an effect; when it changes, reset detail, reject draft, confirmation and busy state before loading.
  - [x] 4.2 DOA note, route chips, line pills, Evidence table with Total, History list.
  - [x] 4.3 Footer: Approve primary; Reject secondary that opens the reason textarea; `Confirm reject` danger disabled until trimmed text; `Cancel` restores; `busy` guard on both; on success show the confirmation block, re-fetch both lists; on 409 reload the detail; errors via `errorMessage`.
  - [x] 4.4 Offline block and disabled actions; detail and list stay readable with the last-synced time; re-fetch on `online`.
  - [x] 4.5 Handheld: detail replaces the list, Back clears `?indent=`, pinned footer (fixed bottom, safe-area inset) while task mode is on. Tablet and Desktop: two panes with the empty-detail prompt.

- [x] Task 5: Styles, accessibility, i18n (AC 8)
  - [x] 5.1 `globals.css`: add `.state-pill-info` and `.state-pill-off` from the DESIGN.md:187-201 pairs beside `.state-pill-ok/-warn/-err` (`:906-940`); `.approvals-screen[data-device-class=...]` two-pane grid (pattern `.floor-screen` `:1563-1580`); footer and table rules using the existing `--touch-primary`, `--touch-secondary`, `--control-compact` tokens (`:212-228`). Status is never colour alone.
  - [x] 5.2 All copy under flat dotted `approvals.*` keys; add `/^approvals\./` and `/^approvals-/` to `ALLOWED_LITERAL_PATTERNS` (`edge/test/unit/i18n-literals.test.ts:6-71`); run `i18n:check`.
  - [x] 5.3 Live region announces the decision confirmation; focus moves to the confirmation block after a decision and to the textarea when Reject opens; table rows expose `aria-selected`.

- [x] Task 6: Tests (AC 4 to AC 8)
  - [x] 6.1 `edge/test/unit/approvals-model.test.ts` (`node:test`, `assert/strict`): merge and dedupe, status mapping, search over reference, sku and requester, band and DOA note text including the null `value_max` case, route chip for all three routes and the capped grant.
  - [x] 6.2 `edge/test/fixtures/approvals-stub.ts` on the `page.addInitScript` fetch replacement of `edge/test/fixtures/stores-stub.ts:27` with navigation including `Approvals`.
  - [x] 6.3 `edge/test/e2e/approvals.spec.ts`: approve, reject with reason (Confirm disabled while empty), 409 reload, offline block disables actions, deep link without `Approvals` shows no-access, Handheld hides the bottom nav in detail and Back restores it; viewports from `edge/test/e2e/device-classes.spec.ts:38`, `:68`, `:85`, `:112`.
  - [x] 6.4 `edge/test/accessibility/approvals.spec.ts`: axe (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`) on `/approvals` and `/approvals?indent=<id>`, keyboard-only approve.
  - [x] 6.5 Regression: `npm run edge:test`, `npm --workspace @inventory/edge run build`, edge lint and typecheck, root `npm test`, full edge Playwright (known red on master: `floor-tasks.spec.ts:47` strict mode, from Story 3.16).

- [ ] Task 7: Records and staging (AC 8)
  - [x] 7.1 Runbook row 2.10n in `docs/migration/pilot-cutover-runbook.md` after 2.10m: rebuild app and edge images (no migration); as `indent1@` raise two lines, one under Rs 1,00,000 and one above; as `subscr@` on a phone-width window approve the first from `/approvals`; as `accounts@` on a desktop window approve the second; both appear under Decided; as `store1@` issue both on `/stores/issue`. Evidence: two decided rows and the issue slip number.
  - [x] 7.2 Deferred work: add the follow-up that folds damage-case concurrence and grant decisions into `/approvals` with a type filter (Q26), the omitted SLA column, and offline read of the inbox.
  - [ ] 7.3 Run 2.10n on staging after deploy; record the result in this file. Staging check required before deploy: staging may still lag master (see the memory note on 2.10m), so deploy the 3.14 migration first.

### Review Findings

Code review of 2026-11-19 (Blind Hunter, Edge Case Hunter, Acceptance Auditor). 1 decision, 10 patches, 2 deferred, 15 dismissed.

- [x] [Review][Decision] Approvers can now read issue slips (low) - `assertIssueReadAccess` falls through to `assertIndentReadAccess`, which gained the approver branch, so an approver, delegate or past decider of any line now reads `GET /indents/:id/issues` and the slip detail. Story 4.11 D10 limits slips to warehouse readers, the requester and procurement readers, and this story's AC 3 widens only the detail, approve and reject. Options: restore the 4.11 rule, or keep the wider read and record it as intended. Resolved 2026-11-19: owner ruled keep the wider read; the `assertIssueReadAccess` docstring records it and `story-4-12.test.ts` pins it (approver 200, employee with no band 403). [src/api/v1/indents.ts:935]
- [x] [Review][Patch] A decision still in flight when the approver picks another requisition lands on the new one (medium): the late `setConfirmation` shows "Approved by you" and hides Approve and Reject on the newly selected requisition, and the stale `loadDetail` closure then loads the old requisition into the panel under the new `?indent=` [edge/src/components/approvals.tsx:254]
- [x] [Review][Patch] Handheld deep link with the list loading, failed or offline hides the bottom nav and renders no Back button or footer, so the approver is stuck until reload (medium, AC 8): task mode must follow the detail pane actually rendering [edge/src/components/approvals.tsx:146]
- [x] [Review][Patch] A requisition the caller raised shows under Waiting but opens with no Approve or Reject (medium): the list lateral counts a pending line whose stored approver is the caller even when the caller is the requester (head of department raising their own, or a requester who was the active delegate at routing), while the detail returns an empty pending set for the requester [src/read/projections/indent.ts:328]
- [x] [Review][Patch] `pending_for_me_line_ids` is not empty on `decided_by_me` rows (low, AC 2, Task 1.4): the declared deviation is not accepted, a Decided row reads Waiting and the requisition is counted in both tabs [src/api/v1/indents.ts:562]
- [x] [Review][Patch] No test that an employee with no band is refused reject, and approve by a non-approver is covered only through the losing delegate (low): the widened gate rests on the seam and should be pinned for the plain base-role user [test/integration/story-4-12.test.ts:314]
- [x] [Review][Patch] The axe scan of `/approvals?indent=<id>` can run before the detail renders, and no scan covers the Handheld pinned footer (low, AC 8, Task 6.4) [edge/test/accessibility/approvals.spec.ts:8]
- [x] [Review][Patch] The offline `role="status"` block renders in both panes on Tablet and Desktop and is announced twice (low, AC 7) [edge/src/components/approvals.tsx:387]
- [x] [Review][Patch] A rejection reason containing `$&`, `` $` `` or `$'` is corrupted on screen because `String.replace` reads those as replacement patterns (low): use a function replacer for user-typed text [edge/src/components/approvals.tsx:692]
- [x] [Review][Patch] `useState(readIndentParam)` reads `?indent=` during render, against the rule in the comment four lines below it (Story 3.15); the mount effect already sets it (low) [edge/src/components/approvals.tsx:125]
- [x] [Review][Patch] Record three known limits as `shortcut:` comments and deferred-work entries (low): both lists stop at 200 rows with no "more" indication and the tab counts cap there; the band line is not scoped to the site although the nav entry is (AC 2, AC 3, Task 1.2); the DOA note tells a delegate they are "the requester's head of department" [edge/src/components/approvals.tsx:159]
- [x] [Review][Defer] Delegation windows use the UTC date, so between 00:00 and 05:30 IST the nav entry, both lists, read access and the decision seam all read yesterday's delegation [src/api/v1/indents.ts:228] - deferred, pre-existing
- [x] [Review][Defer] A line routed to its own requester can never be decided: routing does not exclude the requester and SOD-01 refuses them [src/api/v1/indents.ts:113] - deferred, pre-existing

## Dev Notes

### Owner rulings and defaults applied

- Q25 (sprint-change-proposal-2026-10-21.md Table 7): widen the gates (employee hat plus per-line identity), do not add procurement to the finance controller. Verified: `roles.json` gives `accounts@` `employee` write at the site and no `procurement`, so today the finance controller cannot read the detail (`assertIndentReadAccess` 403) or decide (`module: 'procurement'` gate). The staging bootstrap script `deploy/provision/staging-bootstrap-accounts.sh:98-105` lacks the `employee` rows; the pilot roles file is the provisioning source of truth, so the test provisions as `roles.json` does.
- Q26: requisitions only. Recorded deviation from EXPERIENCE.md:169 (one inbox for all approval types).
- Ask for info is Story 4.13. Deviation from EXPERIENCE.md:137 recorded. Leave room in the footer layout for a third action.

### Decisions made by this story

- D1 Inbox scope is the resolved approver, not the band role. A line routes to one `approver_actor_id` at raise (`src/compliance/indent-routing.ts`); another holder of the same band role cannot decide it (`decideAsApprover` answers `NOT_RESOLVED_APPROVER`), so the inbox filters by `approver_actor_id`, never by role. The nav row, in contrast, shows to any active band holder so a holder with nothing pending still sees the empty state.
- D2 `approver_bands` is the caller's held bands, used for the band line; the DOA note uses the per-line `approver_band` from `doa_entry_id`, because a holder of two bands sees lines from either.
- D3 Delegation reverse lookup mirrors the seam's earliest-created rule (Task 1.1). Any divergence shows a line the seam refuses.
- D4 `pending_for_me_line_ids` on the detail is empty for the requester even though `pendingLineIdsFor` returns all pending lines for the requester (deliberate in the seam so SOD-01 fires on decide). The requester never sees Approve; a requester who is also an approver with a self-approval limit decides from My requests (Story 4.8 path), not here.
- D5 Display names come from `displayNamesFor` (`COALESCE(display_name, email)`); decided rows show the decider name, and the confirmation names the requester.
- D6 Online only, no outbox, no PowerSync bucket. Precedent: Story 4.11 D11 and `standing-grants.tsx`. Decisions are checked live (mock L707).
- D7 Selection by query string `?indent=`; the edge app has no dynamic segments.

### Current state of the files this story changes

- `src/api/v1/indents.ts` (1180 lines). `assertIndentReadAccess` `:223` admits procurement read at site or the requester only. `getIndentBase` `:386` returns `{ indent, lines }` with `GrantLineView` fields (`standing_grant_ref`, `cap`, `month_to_date_issued`, `standing_approval_text`) from `presentLines` `:157`, user ids only. `listIndentsBase` `:406`: issuable branch `:468`, base-role refusal `:490`, `mine` scope `:497`, `estimated_value` masked for `mine` without a self-approval limit `:515-524`. `resolveDecisionLineIds` `:932` derives the pending set when `line_ids` is absent. `approveIndentBase` `:971` and `rejectIndentBase` `:1006` (reject requires non-empty `rejection_reason`, else 400 `INDENT_REJECTION_REASON_REQUIRED`); their responses do not pass lines through `withOpenQty`, so re-fetch the detail after a decision rather than trusting the decision response lines. Gates `:1111-1155`.
- `src/read/projections/indent.ts`: `IndentRow` `:4`, `IndentLineRow` `:40` (`approval_route`, `line_status`, `approver_actor_id`, `doa_entry_id`, `decided_at`, `decided_by` as user id, `rejection_reason`, `standing_grant_id`, `self_approved`), `IndentRowWithCounts` `:76`, `getIndentLines` `:135` (`SELECT *`), `ListIndentsParams` `:254`, `listIndents` `:266` (limit default 50, max 200).
- `src/read/projections/doa_registry.ts`: `DoaRegistryEntry` `:9` (`role`, `value_min` exclusive, `value_max` inclusive, null unbounded), `listActiveDoaEntries` `:218`, `findActiveDelegation` `:267` (delegator keyed, earliest-created wins), `findRoleHolder` `:312`, `isActiveRoleHolderForEntry` `:338`. Table `doa_vacation_delegations(delegation_id, delegator_user_id, delegate_user_id, start_date, end_date, active, created_at)`.
- `src/compliance/indent.ts`: `pendingLineIdsFor` `:278`, `assertLineDecisionAllowed` `:893`, `decideAsApprover` `:945`, `applyLineDecision` `:986`, requester notification `indent_decision` `:1082` (already sent; the confirmation copy relies on it), stores `indent_issue_pending` `:1107-1129`. Do not change the seam.
- `src/api/v1/edge.ts`: `NAVIGATION_CAPABILITIES` `:401-427` (rows `:421-425` are mis-indented; do not reformat unrelated lines, Story 4.10 review restored a prettier reflow), `hasDamageCaseScope` `:435`, `hasGateScope` `:450`, `navigationFor` `:461`.
- Edge: `app-shell.tsx` `BaseView` `:144-157`, `BASE_VIEW_ENTRY` `:160-180`, no-access card `:382-391`, mount chain `:392-442`, `useDeviceClass` `:250`, `BottomNav` `:591`; `edge-client.tsx` view union `:241-265`, online listener `:593`; `my-requests.tsx` `MyIndentRow` `:9-21`, `STATUS_KEYS` `:81-89`, needs-connection card `:286-300`; `floor-tasks.tsx` two-pane `:160-163` and offline list `:110-131`; `standing-grants.tsx` reject textarea `:193-212`.

### Preserve

- My requests, Stores issue and the issuable inbox keep their behaviour; the new list branches must not change `mine`, `issuable` or the default procurement list.
- The 403 `FUNCTION_ACCESS_DENIED` for a plain employee without `mine=true` stays.
- Approve with an empty body still decides all of the actor's pending lines (`story-4-3.test.ts` depends on it).
- Self-approval (Story 4.8) still flows through the same approve route for a requester with a limit.

### Architecture compliance

- Reads stay in `src/read/projections/*`; handlers in `src/api/v1/*`; no event, no new route, no schema change (no `init-db.sql` or `read/projections/*.sql` edit, so no schema-drift work).
- Role checks go through `requireRole` and module names, never role names (`src/middleware/rbac.ts:132-137`).
- Edge: global stylesheet `edge/app/globals.css` only (no CSS modules, no Tailwind); flat dotted i18n keys; no new dependency.

### Testing standards

- Root: `node --test` via `npm test` with `.env.test`, Postgres on port 5442, `--test-concurrency=1`. Integration files carry their own helpers; there is no shared fixture module.
- Edge: `npm run edge:test` (node:test), Playwright `test:e2e` and `accessibility` against the standalone build on port 3000, API stubbed through `page.addInitScript`.

### Previous story intelligence

- 3.15 and 3.16 reviews: never put `window.location.search` in a dependency array or read `window` during render (the 3.15 `next build` broke with `ReferenceError: window is not defined`); reset all screen state when the query id changes; a denied read must render no-access, not a spinner; optional enrichment reads must not abort the main screen; every `errors.*` token used must exist.
- 3.16 review: a single failed read must not be shown as an empty inbox; check both reads and render a failure card.
- 4.11 review: guard submits with a busy flag (Enter re-submits), ignore stale responses, reload on 409.
- 4.10 review: per-line chips on My requests were deferred because no detail screen existed; this story provides the approver detail only, My requests stays list-only.
- Known red on master: `edge/test/e2e/floor-tasks.spec.ts:47` (strict mode, from 3.16). Playwright locally needs `npm install` inside `edge/` first.

### Git intelligence

- HEAD `5ea4f23` (3.16 test fix), `9b80b2a` (3.14 review patches), `375262d` (2.10 FK restore). Story 4.11 is committed, so the sequencing rule (commit 4.11 before 4.12 branches) is met. Story 4.8 is done, so the standing approval chip data is live.

### Contradictions resolved

- Epic AC 6 says none of the indent decision codes has an `errors.*` key. Drift: `en.json:264-276` already holds `INDENT_NOT_FOUND`, `INDENT_ALREADY_DECIDED`, `INDENT_NOT_IN_RAISED`, `INDENT_RAISER_CANNOT_APPROVE`, `NOT_RESOLVED_APPROVER`, `INDENT_REJECTION_REASON_REQUIRED`, `INDENT_PENDING_CONFIRMATION`, `INDENT_LINE_NOT_FOUND`, `INDENT_LINE_ALREADY_DECIDED`, and `FUNCTION_ACCESS_DENIED` is at `:107`. Reuse them; add only missing keys.
- Epic cites `src/server.ts:857-858` for the approve body; routes are now `:863-864` and the body is parsed in the handlers.
- Epic's self-approval chip text `Self-approval limit Rs <amount>`: the line carries no limit amount (only `self_approval_grant_id`), so the chip reads `Self-approval limit` without an amount. Do not add a join for it.
- Epic implies the stores inbox has device-class panes; only `floor-tasks.tsx` does, and no pinned footer replacing the bottom nav or desktop table exists yet. This story builds both (Task 2.3, Task 3.3).

### Project Structure Notes

- New: `edge/app/approvals/page.tsx`, `edge/src/components/approvals.tsx`, `edge/src/components/approvals-model.ts`, `edge/test/unit/approvals-model.test.ts`, `edge/test/fixtures/approvals-stub.ts`, `edge/test/e2e/approvals.spec.ts`, `edge/test/accessibility/approvals.spec.ts`, `test/integration/story-4-12.test.ts`.
- Updated: `src/read/projections/doa_registry.ts`, `src/read/projections/indent.ts`, `src/api/v1/indents.ts`, `src/api/v1/edge.ts`, `edge/src/components/app-shell.tsx`, `edge/src/components/edge-client.tsx`, `edge/src/components/navigation/nav-model.ts`, `edge/src/messages/en.json`, `edge/app/globals.css`, `edge/test/unit/i18n-literals.test.ts`, `docs/migration/pilot-cutover-runbook.md`, `_bmad-output/implementation-artifacts/deferred-work.md`.

### References

- Story definition: `_bmad-output/planning-artifacts/epics.md` Story 4.12.
- Rationale and verification notes: `_bmad-output/planning-artifacts/sprint-change-proposal-2026-10-21.md` Tables 1, 2, 5, 7 (Q25, Q26).
- Gap: `_bmad-output/implementation-artifacts/ux-screen-coverage-audit-2026-10-21.md` G06.
- UX: EXPERIENCE.md:19-40, :99-100, :108-123, :137, :155-172; DESIGN.md:187-201, :224-229, :254-304; mockups/key-approvals.html L575-656, L704-736, L785, L840-851.

## Dev Agent Record

### Agent Model Used

Claude Opus 5.5 (claude-opus-5-5)

### Debug Log References

- 2026-11-19: story created by create-story from baseline 5ea4f23.
- 2026-11-19: first integration run answered 500 on `pending_for_me`: `indent_line.approver_actor_id` and `decided_by` are TEXT (`read/projections/indent_line.sql:48`, `:51`), not UUID; the lateral filter casts the id array to `text[]`.
- 2026-11-19: `story-4-10` and `story-4-8` broke on the detail read: a pre-approved line has `decided_by = 'system'`, which failed the `uuid[]` cast in `displayNamesFor`. The detail now looks up UUIDs only. Both suites green again (13/13, 39/39); baseline confirmed green by stashing `src/`.
- 2026-11-19: an online raise of a duplicate answers 409 and stores nothing, so the pending-confirmation exclusion test sets the header status directly.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- Server: `listActiveDelegatorsFor` mirrors `findActiveDelegation` (earliest-created delegation per delegator wins); `listHeldIndentApprovalBands` and `getDoaBandsByIds` added in `doa_registry.ts`. `listIndents` gains `approverIds`, `pendingForMe`, `decidedBy` with one lateral aggregate for `pending_for_me_line_ids` and `line_skus`. `GET /api/v1/indents` gains the `pending_for_me` and `decided_by_me` branch ahead of the base-role refusal (400 on mixed flags). Detail adds `requester_display_name`, `pending_for_me_line_ids`, `approver_bands`, per-line `approver_band` and `decided_by_display_name`. `assertIndentReadAccess` (now async) admits the approver, delegate or decider of any line. Approve and reject gate on `[employee, procurement]` write; confirm, withdraw and cancel unchanged. Bootstrap nav row `Approvals` via `hasIndentApprovalScope`.
- Deviation from AC 2 wording: `pending_for_me_line_ids` on a Decided row is computed, not forced empty, so a requisition where the caller still holds another pending line shows Waiting in both tabs. Normal decisions take all the caller's pending lines, so it is empty in practice.
- Deviation from Task 5.3: selection is exposed with `aria-current` on the row button, not `aria-selected` on a plain table row (axe allows `aria-selected` only on grid rows).
- `approver_band` carries `value_min` as well as `role` and `value_max`, for the finance note `above Rs <min>`.
- Story 1.15 integration test updated: its AC1 case asserted approve and reject were refused `MODULE_ACCESS_DENIED` for the base role; that is the gate this story widens (Q25). It now asserts the seam's `INDENT_RAISER_CANNOT_APPROVE` for those two and `MODULE_ACCESS_DENIED` for confirm, withdraw and cancel.
- No navigation unit test exists for `navigationFor`; the Approvals branch is covered by the bootstrap assertions in `test/integration/story-4-12.test.ts` (holder, delegate, second delegate, requester, plain employee).
- Edge: `/approvals` base view (inbox tabs, search, band line, empty states, cards on Handheld and Tablet, table on Desktop and Desktop touch, detail with DOA note, route chips, Evidence with Total, History, Approve, Reject with reason, offline block). AppShell hides the bottom nav while a Handheld detail is open (task mode). `.state-pill-info` and `.state-pill-off` added.
- Tests: `story-4-12` integration 6/6; root `npm test` 2736/2736; edge unit 220/220 (approvals model 8/8, i18n guard); edge Playwright e2e plus accessibility 120/120 (approvals 14/14, axe zero violations on inbox and detail); edge typecheck, lint and build clean; root eslint clean on changed files. Prettier applied to new files and to the three changed files that were prettier-clean at HEAD; `src/api/v1/edge.ts` was already unformatted at HEAD and is left as is.
- Records: runbook row 2.10n added; deferred-work section for 4.12 added (inbox types, SLA column, offline read, mixed-decision row status, Ask for info).
- Code review 2026-11-19: 1 decision and 10 patches resolved (see Review Findings). The AC 2 deviation above is withdrawn: a `decided_by_me` row now carries an empty `pending_for_me_line_ids`. The list no longer shows a requisition as Waiting to its own raiser. Approvers read issue slips by owner ruling. After the patches: `story-4-12` integration 7/7; root `npm test` 2737/2737; edge unit 220/220; edge Playwright e2e plus accessibility 123/123 (approvals 17/17, axe now also on the Handheld detail).
- OPEN: Task 7.3, running 2.10n on staging, needs a deploy and is not done. Staging lags master and needs the 3.14 migration first.

### File List

- `src/read/projections/doa_registry.ts` (modified)
- `src/read/projections/indent.ts` (modified)
- `src/api/v1/indents.ts` (modified)
- `src/api/v1/edge.ts` (modified)
- `test/integration/story-4-12.test.ts` (new)
- `test/integration/story-1-15.test.ts` (modified)
- `edge/app/approvals/page.tsx` (new)
- `edge/src/components/approvals.tsx` (new)
- `edge/src/components/approvals-model.ts` (new)
- `edge/src/components/app-shell.tsx` (modified)
- `edge/src/components/edge-client.tsx` (modified)
- `edge/src/components/navigation/nav-model.ts` (modified)
- `edge/src/messages/en.json` (modified)
- `edge/app/globals.css` (modified)
- `edge/test/unit/approvals-model.test.ts` (new)
- `edge/test/unit/i18n-literals.test.ts` (modified)
- `edge/test/fixtures/approvals-stub.ts` (new)
- `edge/test/e2e/approvals.spec.ts` (new)
- `edge/test/accessibility/approvals.spec.ts` (new)
- `docs/migration/pilot-cutover-runbook.md` (modified)
- `_bmad-output/implementation-artifacts/deferred-work.md` (modified)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified)
- `_bmad-output/implementation-artifacts/4-12-approvals-inbox-and-requisition-approval-detail.md` (modified)

## Change Log

- 2026-11-19: Story 4.12 created by create-story. Status ready-for-dev.
- 2026-11-19: Implemented Tasks 1 to 6 and 7.1 to 7.2 (server list filters, approver detail read, widened approve and reject gate, edge approvals screen, tests, runbook row 2.10n). Status review; Task 7.3 (staging run) open.
- 2026-11-19: Code review (Blind Hunter, Edge Case Hunter, Acceptance Auditor): 1 decision, 10 patches, 2 deferred, 15 dismissed. All patches applied: in-flight decision no longer paints on a newly picked requisition; Handheld task mode follows the detail pane; the raiser's own requisition never lists as Waiting; Decided rows carry no pending ids; refusal and slip-read tests added; axe waits for the detail and scans Handheld; one offline status; function replacer for typed reasons; `?indent=` read after mount; three known limits recorded. Status done; Task 7.3 (staging run of 2.10n) stays open.
