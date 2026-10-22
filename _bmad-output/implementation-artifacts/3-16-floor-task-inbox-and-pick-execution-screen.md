# Story 3.16: Floor Task Inbox and Pick Execution Screen
Status: ready-for-dev

## Story

As a picker (`warehouse_operator`, picker1@ancorlabs.org, `docs/migration/pilot-mock-extract/roles.json:401-413`),
I want a task inbox that opens each pick list one line at a time (scan bin, scan lot, confirm quantity), offline if needed,
so that Story 3.6 pick tasks are executed from the device instead of a paper list.

## Acceptance Criteria

**AC 1 - Navigation and role gating (nav row, deep link safety, store_assistant read)**

Given a caller with warehouse write at the site,
when the bootstrap runs,
then navigation carries `Floor tasks` from a new row `{ name: 'Floor tasks', modules: ['warehouse'], functionScope: 'write' }` (`src/api/v1/edge.ts:420-422`, precedent `Stores issue` at `:422`) with NAV_ENTRIES `{ name: 'Floor tasks', href: '/floor/tasks', label: 'nav.floorTasks' }` and `nav.floorTasks` in `en.json` beside `nav.storesIssue`; `floor-tasks` joins BaseView and BASE_VIEW_ENTRY so a deep link without the entry renders the no-access card with no fetch; `store_assistant` also holds warehouse write (`roles.json:332-335`) and is in PICK_READ_ROLES (`src/api/v1/pick-tasks.ts:39-44`), so it sees and can use the screen (accepted; access matrix :54 scopes it to putaway and counts).

**AC 2 - Floor task inbox (two status reads merged, ownership ordering, offline list)**

Given `/floor/tasks` online,
when the inbox loads `GET /api/v1/pick-tasks?site=<site>&status=pending` and `GET /api/v1/pick-tasks?site=<site>&status=in_progress` (one status per request, `src/api/v1/pick-tasks.ts:282`; `src/read/projections/pick_task.ts:265`) merged client-side,
then one group headed `Pick lists - sales orders` (mock key-floor.html L617) lists tasks whose `assigned_to` equals the bootstrap `user_id` (`src/api/v1/edge.ts:536`) first, then tasks with `assigned_to` null at the site, both actionable (no assignment check exists in `src/compliance/pick.ts`; assign is PICK_SUPERVISE_ROLES only, `pick-tasks.ts:359`), tasks assigned to someone else hidden; each inbox card shows the task id, the sales order number, `n of m picked` and a text pill (`In progress` or `Pending`) from the Task 1 list fields; the empty state reads `All caught up`; offline the last fetched list shows with `Showing the list from <time>`.

**AC 3 - Server read contract extensions (pick task list and pick line detail)**

Given Task 1 server work,
when `GET /api/v1/pick-tasks/:pickTaskId` (`src/server.ts:1416`) and `GET /api/v1/pick-tasks` (`:1415`) are called,
then each line also carries `location_code`, `directed_lot_number` and `uom` joined from `location_register`, `lot_master` and `item_master` (today `src/read/projections/pick_line.ts:62-66` returns IDs only; `item_master` has no description column so none is promised), and each list row carries `so_number_ext` (joined from `erp_sales_order` via `dispatch_order_id`, `read/projections/erp_sales_order.sql:21`), `confirmed_line_count` and `line_count` (`src/read/projections/pick_task.ts:272-274`, same FILTER predicates as `pick.ts:828-832`), with integration tests for both.

**AC 4 - Line execution: scan bin, scan lot, held-lot guard, step indicator**

Given the current line,
when the picker scans or types bin then lot in the ScanField,
then a wrong bin shows `Wrong bin - <code>` and stays on step 1, a matching bin advances, the directed lot advances with the quantity prefilled, a lot whose `lot_number` is present in the synced `held_lot` table with `quality_hold_status` held (`edge/src/local-db/schema.ts:191-203`; `getHeldLot` and `assertLotNotHeld`, `edge/src/capture/held-lot.ts:22`, `:35`) shows `On hold - awaiting QC` and does not advance, online or offline (mock L918, L461), a different unheld lot shows `Wrong lot - not picked` naming the directed lot and stays on step 2 (mock L919, L467; lot substitution with override reason, Story 3.6 AC 8, is an exception flow in Story 3.17); the three-step indicator exposes `aria-current="step"`.

**AC 5 - Confirm quantity and outbox-with-refusal (server-stamped confirmed_by, no picker completion command)**

Given step 3 with the quantity equal to directed,
when Confirm is tapped,
then one `pick_line.confirmed` event (stream warehouse, payload `{ pick_task_id, pick_line_id, confirmed_lot_id, confirmed_quantity, capture_method: 'PWA' }` per `src/compliance/pick.ts:136-153`; `confirmed_by` stamped server-side at `src/api/v1/edge.ts:674-676`) is written with `insertCaptureEvent` (`edge/src/local-db/outbox.ts:42`), the screen advances, the line reads Synced or `Captured - pending sync`, and a `PICK_*`, `LOT_ON_HOLD` or `INSUFFICIENT_STOCK_FOR_PICK` refusal (`edge/src/sync/connector.ts:119-129`, `:141`; strings at `en.json:86`, `:179-189`) lands in Refused captures with its `errors.*` text; the quantity field is read-only at the directed quantity and the mock's `Short pick` secondary (L713, L719) renders disabled with the reason `Short pick comes in a later release - leave the line open and tell your supervisor` (EXPERIENCE.md:122).

**AC 6 - Inline finalization and completion panel**

Given the last outstanding line,
when its `pick_line.confirmed` event is accepted,
then the server finalizes the task inline (`src/compliance/pick.ts:612-628`; no `pick_task.completed` is sent by the picker because that command is SOD-gated to `warehouse_manager` and `inventory_controller`, `pick.ts:29`, `:808-821`), the screen shows a completion panel with task id, order, line count, the line `All lines picked` and Back to tasks once the last line reads Synced (or `Captured - pending sync` while offline), and a `LOT_ON_HOLD`, `INSUFFICIENT_STOCK_FOR_PICK` or `PICK_LINE_ALREADY_CONFIRMED` refusal of that last confirm renders from `errors.*` in Refused captures and reloads the task; the task leaves the inbox once the list returns it as completed.

**AC 7 - Device classes, accessibility and i18n**

Given the four device classes (EXPERIENCE.md:135 plus mock L450-454),
when the screen renders and axe plus a keyboard-only pass run,
then Handheld shows one page at a time with the primary pinned at 56 px, Tablet and Desktop show inbox and task side by side, no horizontal scroll at 360 px, zero WCAG 2.1 AA violations, strings under `floor.*`, and after each confirm the result and the next instruction are announced through the aria-live region (EXPERIENCE.md:119) while the scan field stays focused and armed (EXPERIENCE.md:74).

## Tasks / Subtasks

- [ ] Task 1: Server nav row, deep-link gate and read contract extensions (AC 1, AC 3)
  - [ ] 1.1 Add the bootstrap nav row `{ name: 'Floor tasks', modules: ['warehouse'], functionScope: 'write' }` and NAV_ENTRIES `{ name: 'Floor tasks', href: '/floor/tasks', label: 'nav.floorTasks' }` (`src/api/v1/edge.ts:420-422`, precedent `Stores issue` at `:422`); add `nav.floorTasks` to `edge/src/messages/en.json` beside `nav.storesIssue`; verify picker and store_assistant hold warehouse write (`roles.json:401-413`, `:332-335`).
  - [ ] 1.2 Add `floor-tasks` to BaseView and BASE_VIEW_ENTRY (precedent `putaway-task`/`grn-read` from 3.15) so a deep link without the entry renders the no-access card with no fetch; wire the view into the AppShell render chain (`edge/src/components/app-shell.tsx`).
  - [ ] 1.3 Extend `GET /api/v1/pick-tasks` list rows with `so_number_ext`, `confirmed_line_count`, `line_count` (`src/read/projections/pick_task.ts:272-274`, FILTER predicates per `src/compliance/pick.ts:828-832`), with integration tests.
  - [ ] 1.4 Extend `GET /api/v1/pick-tasks/:pickTaskId` lines with `location_code`, `directed_lot_number`, `uom` joined from `location_register`, `lot_master`, `item_master` (`src/read/projections/pick_line.ts:62-66`), with integration tests.

- [ ] Task 2: Floor task inbox screen (AC 2)
  - [ ] 2.1 `floor-tasks` view loads `GET /api/v1/pick-tasks?site=<site>&status=pending` and `?status=in_progress` (one status per request) merged client-side.
  - [ ] 2.2 Render one group `Pick lists - sales orders`: tasks with `assigned_to` equal to the bootstrap `user_id` first, then `assigned_to` null; hide others; card shows task id, `so_number_ext`, `n of m picked` (from `confirmed_line_count`/`line_count`), text pill `In progress`/`Pending`; empty state `All caught up`; offline shows last fetched list with `Showing the list from <time>`.
  - [ ] 2.3 Card opens the line screen via `/floor/tasks?task=<id>`; Handheld one page at a time with Back, Tablet/Desktop side by side (EXPERIENCE.md:113, mock L450-454).

- [ ] Task 3: Pick line screen steps 1 and 2 (AC 4)
  - [ ] 3.1 Three-step indicator `1 Scan bin - 2 Scan lot - 3 Confirm qty` with `aria-current="step"` on the active step (mock L678); reuse `ScanField` (`edge/src/components/scan-field.tsx`).
  - [ ] 3.2 Step 1 bin scan: wrong bin shows `Wrong bin - <code>`, stays on step 1; matching bin advances.
  - [ ] 3.3 Step 2 lot scan: directed lot advances with quantity prefilled; held lot (`held_lot` table with `quality_hold_status` held, `getHeldLot`/`assertLotNotHeld`, `edge/src/capture/held-lot.ts:22`, `:35`) shows `On hold - awaiting QC` and does not advance, online or offline; different unheld lot shows `Wrong lot - not picked` naming the directed lot, stays on step 2 (substitution belongs to 3.17).

- [ ] Task 4: Confirm quantity and outbox event (AC 5)
  - [ ] 4.1 Step 3 quantity read-only at directed; Confirm disabled unless equal; `Short pick` secondary renders disabled with the reason `Short pick comes in a later release - leave the line open and tell your supervisor` (no short-pick control, no photo capture).
  - [ ] 4.2 Confirm writes one `pick_line.confirmed` event (stream warehouse, payload `{ pick_task_id, pick_line_id, confirmed_lot_id, confirmed_quantity, capture_method: 'PWA' }`) via `insertCaptureEvent` (`edge/src/local-db/outbox.ts:42`); line then reads Synced or `Captured - pending sync`.
  - [ ] 4.3 Map `PICK_*`, `LOT_ON_HOLD`, `INSUFFICIENT_STOCK_FOR_PICK` refusals (`edge/src/sync/connector.ts:119-129`, `:141`) to `errors.*` text via `errorMessage` (`en.json:86`, `:179-189`) and show in Refused captures.

- [ ] Task 5: Inline finalization and completion panel (AC 6)
  - [ ] 5.1 On last line confirmed, show completion panel with task id, order, line count, `All lines picked` and Back to tasks once the last line reads Synced or `Captured - pending sync` (offline); no `pick_task.completed` from the picker (server finalizes inline, `src/compliance/pick.ts:612-628`).
  - [ ] 5.2 A `LOT_ON_HOLD`, `INSUFFICIENT_STOCK_FOR_PICK` or `PICK_LINE_ALREADY_CONFIRMED` refusal of the last confirm renders from `errors.*` in Refused captures and reloads the task.
  - [ ] 5.3 The task leaves the inbox once the list returns it completed (re-fetch pending and in_progress lists).

- [ ] Task 6: Device classes, accessibility and i18n (AC 7)
  - [ ] 6.1 Handheld: one page at a time, primary pinned 56 px; Tablet/Desktop: inbox and task side by side; no horizontal scroll at 360 px (EXPERIENCE.md:135, mock L450-454).
  - [ ] 6.2 After each confirm, announce the result and the next instruction through the aria-live region; the scan field stays focused and armed (EXPERIENCE.md:74, `:119`).
  - [ ] 6.3 All new copy under `floor.*`; extend the i18n literal guard (`edge/test/unit/i18n-literals.test.ts` ALLOWED_LITERAL_PATTERNS); zero axe violations and keyboard-only pass (e2e and accessibility specs).

- [ ] Task 7: Tests and regression (AC 3, AC 7)
  - [ ] 7.1 Edge unit tests: inbox grouping and ownership ordering, line state machine (wrong bin, wrong lot, held lot, quantity gate), outbox event shape, i18n literals guard.
  - [ ] 7.2 Integration tests for both projection extensions (`test/integration/story-3-16.test.ts`).
  - [ ] 7.3 E2E spec for scan bin to scan lot to confirm to completion; accessibility spec run.
  - [ ] 7.4 Full regression: edge build (`npm --workspace @inventory/edge run build`), edge unit suite, edge lint and typecheck, root unit and integration tests.

## Dev Notes

- **Precondition - validation walk**: before build, one validation walk with picker1@ancorlabs.org on the staging preview (`_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/EXPERIENCE.md:262`, `:269`) or the owner's recorded waiver. Record the outcome in the Dev Agent Record before implementation.
- **Domain facts**: `pick_task` is one SKU per task (`src/read/projections/pick_task.ts:85`), so the mock's five-item list is illustrative. The mock groups `Pick lists - production issue` and `Moves` have no backend and must not be built. The mock's short-pick flow is Story 3.17: render the disabled control only (AC 5). Lot substitution is Story 3.17 (AC 4 names the directed lot only).
- **Reuse, do not reinvent**: `ScanField` (`edge/src/components/scan-field.tsx`), the stores inbox group/card rendering and `buildInbox` grouping pattern (3.14), the outbox-with-refusal flow and `insertCaptureEvent` (3.13), the AppShell view union and no-access card (`edge/src/components/app-shell.tsx`, 3.15 `putaway-task`/`grn-read`), `errorMessage(code)` mapping (`edge/src/i18n/locale.ts`), and the `held_lot` guard (`edge/src/capture/held-lot.ts`).
- **Server**: the two status reads are separate requests because the list endpoint accepts one status (`src/api/v1/pick-tasks.ts:282-289`). The list joins for `so_number_ext`, `confirmed_line_count`, `line_count` must reuse the exact FILTER predicates of the completed-count path (`src/compliance/pick.ts:828-832`) or counts diverge. Do not change `PICK_SUPERVISE_ROLES` gating of assign or completion commands.
- **Testing standards**: unit tests in `edge/test/unit/*.test.ts` (node + tsx), integration in `test/integration/*.test.ts`, e2e in `edge/test/e2e` and accessibility in `edge/test/accessibility` (Playwright). A failing build is a blocker: the edge build prerenders every route and crashes on server-unsafe browser globals.

### Previous story intelligence (3.13, 3.14, 3.15)

The 3.15 code review (2026-10-23) produced hard-won rules that 3.16 MUST follow:

- **Never** put `window.location.search` directly in a `useEffect` dependency array. It is evaluated during server render and fails `next build` with `ReferenceError: window is not defined` (verified: the 3.15 build broke this way). Use `[typeof window !== 'undefined' ? window.location.search : '']` or read inside the effect.
- Read `?task=` in a `useState` initializer guarded by `typeof window === 'undefined'`, then re-read in an effect. When the query changes, **reset all screen state** (task, suggestion, status, message, idempotency ref) before loading, or the old task renders and submits against the stale id.
- **Idempotency keys**: the server replays by `idempotency_key` alone (`src/events/store.ts:960`). Mint a fresh key whenever the payload changes (new line, new quantity) and reuse it across retries of the same payload, or a timed-out confirm replayed with a different payload silently records the first one.
- A denied read with no data must render the no-access card, not an infinite spinner: 3.15's detail-route 403 sat on "Loading" forever because the loading gate swallowed the `read-only` state.
- Optional enrichment reads (location codes, joined names) must never abort the main screen: wrap them in their own try/catch or `.catch(() => null)`.
- IndexedDB writes on the completion path must not block the screen; surface failures in the UI.
- Every `errors.*` token used must exist in `en.json`; the i18n literal guard (`edge/test/unit/i18n-literals.test.ts`) must be extended for any new `floor.*` literals.

### Project Structure Notes

- Edge PWA lives under `edge/`: `app/` routes, `src/components/`, `src/local-db/`, `src/sync/`, `src/session/`, `src/i18n/locale.ts`, `src/messages/en.json`. Follow the 3.15 layout (`putaway-task.tsx` + `putaway-task-model.ts` pair: pure model in `*-model.ts`, component owns fetch/render).
- Server: `src/api/v1/pick-tasks.ts` (routes, role gates), `src/read/projections/pick_task.ts` and `pick_line.ts` (joins), `src/compliance/pick.ts` (finalize), `src/api/v1/edge.ts` (bootstrap nav, event stamping). Do not touch `src/compliance/pick.ts` finalize semantics beyond what AC 6 requires.
- No new libraries, dependencies or npm packages. Next.js 16.2.10 / React (Turbopack), Node + tsx test runner, Playwright for e2e/accessibility (all installed; verify against `package.json` if in doubt).

### References

- Epic story definition and cross-story dependencies: `_bmad-output/planning-artifacts/epics.md:1858-1894` (Story 3.16), `:1898-1926` (3.17 scope boundary)
- Origin and audit gap G08: `_bmad-output/implementation-artifacts/sprint-change-proposal-2026-10-21.md`, `_bmad-output/implementation-artifacts/ux-screen-coverage-audit-2026-10-21.md:225`, `:467`
- Mock (picking screens): `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/mockups/key-floor.html` L450-454 (device classes), L461 (held lot), L467-468 (assumptions), L521/688-700 (stepper, tiles), L617 (inbox group), L713/719-722 (Short pick button, footer), L706 (warn pill), L728-732 (completion panel)
- Device and a11y rules: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/EXPERIENCE.md` L19, L74, L112-113, L119-120, L131-135, L262, L269
- Server contracts: `src/api/v1/pick-tasks.ts:39-44,282-289,359`; `src/read/projections/pick_task.ts:85,265,272-274`; `src/read/projections/pick_line.ts:62-66`; `src/compliance/pick.ts:136-153,612-628,828-832`; `src/api/v1/edge.ts:420-422,536,674-676`; `src/events/store.ts:960`. Line numbers were verified against the current tree on 2026-10-23; the epics.md hints predate later stories and have shifted (nav rows now at `:420-422`, bootstrap user_id at `:536`).
- Edge patterns: `edge/src/components/scan-field.tsx`; `edge/src/local-db/outbox.ts:42`; `edge/src/sync/connector.ts:119-141`; `edge/src/capture/held-lot.ts:22,35`; `edge/src/local-db/schema.ts:191-203`; `edge/src/messages/en.json:86,179-189`; `edge/test/unit/i18n-literals.test.ts`
- Roles: `docs/migration/pilot-mock-extract/roles.json:332-335,401-413`

## Dev Agent Record

### Agent Model Used

Record the model that implements this story.

### Debug Log References

- 2026-10-23: Story 3.16 created with comprehensive context (epics.md:1858-1894, key-floor mock, EXPERIENCE.md 2026-09-23, 3.15 code review learnings). Validation-walk precondition recorded.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created

### File List

Anticipated files this story will create or update (confirm and complete during implementation):

- NEW `edge/app/floor/tasks/page.tsx` (or equivalent routed view)
- NEW `edge/src/components/floor-tasks.tsx` (inbox screen)
- NEW `edge/src/components/pick-line.tsx` (line execution screen)
- NEW `edge/src/components/pick-line-model.ts` (pure state machine, unit-tested)
- UPDATE `edge/src/components/app-shell.tsx` (view union, render chain, no-access card)
- UPDATE `edge/src/components/edge-client.tsx` (view wiring)
- UPDATE `src/api/v1/edge.ts` (nav row, NAV_ENTRIES)
- UPDATE `src/api/v1/pick-tasks.ts` (list/detail payload extensions)
- UPDATE `src/read/projections/pick_task.ts`, `src/read/projections/pick_line.ts` (joins)
- UPDATE `edge/src/messages/en.json` (`nav.floorTasks`, `floor.*`)
- UPDATE `edge/test/unit/i18n-literals.test.ts` (literal guard)
- NEW `edge/test/unit/floor-tasks.test.ts`, `edge/test/unit/pick-line.test.ts`
- NEW `test/integration/story-3-16.test.ts`
- NEW `edge/test/e2e/floor-tasks.spec.ts`, `edge/test/accessibility/floor-tasks.spec.ts`
- UPDATE `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Change Log

- 2026-10-23: Story 3.16 created by create-story with full context. Status set to ready-for-dev.

## Status

ready-for-dev
