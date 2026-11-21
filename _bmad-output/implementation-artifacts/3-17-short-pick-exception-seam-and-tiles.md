# Story 3.17: Short Pick Exception Seam and Tiles

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a picker,
I want to record a short pick with a reason (Bin empty, Less in bin than shown, Damaged - report, Other) instead of leaving the line open,
so that the shortfall is durable, planning sees the re-pick and damaged units go on hold.

## Acceptance Criteria

1. **Given** a pending pick line, **When** `pick_line.short_picked` is uploaded with `found_quantity` where 0 <= found < directed (at most 3 decimals), reason `BIN_EMPTY`, `LESS_IN_BIN`, `DAMAGED` or `OTHER`, and a note required only for `OTHER`, **Then** the event is registered beside `pick_line.confirmed` on stream `warehouse` with `requiresBusinessStream: false`, the line status becomes `short`, the unpicked remainder allocation is released, a `pick_shortfall` row is written, `DAMAGED` opens one photo-less damage case in `in_qc_hold` for the short units, the edge door server-sets `short_picked_by`, and `PICK_SHORT_REASON_REQUIRED`, `PICK_SHORT_QUANTITY_INVALID`, `PICK_SHORT_NOTE_REQUIRED` and `PICK_SHORT_QC_HOLD_MISSING` are permanent on both error-code twins with `errors.*` strings.
2. **Given** a task whose remaining lines are confirmed, substituted or short, **When** the last line resolves or `pick_task.completed` is applied, **Then** finalization runs, the allocated-to-picked move uses found quantity for short lines and skips a zero found quantity, `dispatch_order_status.picked_at` is still written so packing proceeds for the found units, one notification per task targets `production_planner` at the task site listing each short line, and the existing `warehouse_manager` packing notification still fires.
3. **Given** the Story 3.16 pick line screen, **When** Short pick is tapped on the lot step or the quantity step, **Then** the live control replaces the disabled 3.16 control: a picked stepper (min 0, max directed), four reason tiles, footer and primary labels from the mock, `Damaged - report` shows the QC note, confirm queues `pick_line.short_picked` with the existing `Captured - pending sync` treatment, and the completion panel shows a short count and the re-pick sentence. No photo capture and no new nav row.
4. **Given** a different unheld lot on the lot step, **When** the picker chooses `Use this lot instead`, **Then** a reason step renders and confirm sends `pick_line.confirmed` with `override_reason`. A missing reason is the existing `PICK_OVERRIDE_REASON_REQUIRED`. `INSUFFICIENT_STOCK_FOR_PICK` renders from `errors.*`. The mock has no substitution flow; this control is the spine exception path, not a new event.
5. **Given** the suite, **When** `test/integration/story-3-17.test.ts`, the 3.16 edge unit tests and the 3.16 floor e2e spec run, **Then** they pass, including the replacement of the disabled Short pick control, and `pick_line.confirmed` still refuses a quantity that is not the directed quantity.

## Tasks / Subtasks

- [ ] Task 1: Schema for `short` status, `pick_shortfall`, and damage source `pick` (AC: 1)
  - [ ] 1.1 Widen `chk_pick_line_status` in `read/projections/pick_line.sql` to `('pending', 'confirmed', 'cancelled', 'substituted', 'short')`. The existing `DO` block only adds the constraint when it is missing, so an existing database will not pick up a CHECK edit. Use the guarded DROP-then-ADD pattern (`ALTER TABLE pick_line DROP CONSTRAINT IF EXISTS chk_pick_line_status` then `ADD CONSTRAINT`). Update the inline `CREATE TABLE` CHECK too, for fresh installs. Mirror the same blocks in `deploy/compose/init-db.sql` (current constraint at `:2901` and the add-if-missing block at `:2909`). init-db.sql is CRLF. Do not touch `powersync_publication`.
  - [ ] 1.2 Add `read/projections/pick_shortfall.sql` as the canonical file, with its own guarded grants (`INSERT, SELECT` to `app_user`, `SELECT` to `readonly_user`). Columns: `pick_shortfall_id UUID PRIMARY KEY`, `pick_task_id UUID NOT NULL`, `pick_line_id UUID NOT NULL UNIQUE`, `directed_quantity NUMERIC(14,3) NOT NULL`, `found_quantity NUMERIC(14,3) NOT NULL`, `reason TEXT NOT NULL`, `note TEXT`, `actor_user_id UUID NOT NULL`, `occurred_at TIMESTAMPTZ NOT NULL`, `source_event_id UUID NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Checks: reason in the four codes, `found_quantity >= 0`, `found_quantity < directed_quantity`, `BIN_EMPTY` implies `found_quantity = 0`, `OTHER` implies a non-blank note of at most 200 characters. Append the file once in `src/events/migrate.ts` after the later `pick_line.sql` entry (`:55`). Mirror in `init-db.sql`.
  - [ ] 1.3 Widen `chk_damage_report_source` in `read/projections/damage_report.sql` (`:94`) and the init-db twin (`:15242`) with DROP-then-ADD so `source IN ('report', 'receipt', 'pick')`. Add `source_pick_line_id UUID` with `ADD COLUMN IF NOT EXISTS`. Add pairing `chk_damage_report_source_pick_pairing`: `(source = 'pick') = (source_pick_line_id IS NOT NULL)`. Leave the receipt pairing and the photo pairing as they are: a `pick` row has a null GRN line and a null photo, which those two checks already allow. Add a partial unique index on `source_pick_line_id` where `source = 'pick'`.
  - [ ] 1.4 Pin the new table and the widened constraints in `test/unit/schema-drift.test.ts` (pick_line entry at `:413-416`; add a `pick_shortfall` entry; extend the damage_report constraint list). Run `node --env-file=.env.test --import tsx src/events/migrate.ts` twice. The second run must be a no-op.

- [ ] Task 2: Event contract and permanent refusals (AC: 1, 5)
  - [ ] 2.1 In `src/events/schema.ts`, add `PickLineShortPickedPayload` and envelope after `PickLineConfirmedEnvelope` (`:606-609`). Fields: `pick_task_id`, `pick_line_id`, `found_quantity` (number or numeric string), `reason` (`BIN_EMPTY | LESS_IN_BIN | DAMAGED | OTHER`), `note` (optional), `capture_method` (`PWA | PAPER`), `short_picked_by` (server-set, never trusted). Register `pick_line.short_picked` in `SUPPORTED_EVENT_TYPES` immediately after `pick_line.confirmed` (`:5956-5959`) with `{ streamType: 'warehouse', requiresBusinessStream: false }`.
  - [ ] 2.2 Add `assertPickLineShortPickedShape` in `src/compliance/pick.ts` and call it from `persistEvent` beside the confirmed assert (`src/events/store.ts:713-715`), before the idempotency key is consumed. Shape rejects a missing UUID, a non-numeric found quantity, more than 3 decimal places, a negative found quantity, an unknown reason, a capture method other than `PWA` or `PAPER`, and a note longer than 200 characters. Reason and note requiredness that needs the directed quantity stays in the applier.
  - [ ] 2.3 Twin `PICK_SHORT_REASON_REQUIRED`, `PICK_SHORT_QUANTITY_INVALID`, `PICK_SHORT_NOTE_REQUIRED` and `PICK_SHORT_QC_HOLD_MISSING` in `src/sync/upload.ts` (pick block at `:113-122`) and `edge/src/sync/connector.ts` (pick block at `:121-132`). `test/unit/edge-permanent-error-parity.test.ts` must stay green. Add `errors.PICK_SHORT_REASON_REQUIRED`, `errors.PICK_SHORT_QUANTITY_INVALID`, `errors.PICK_SHORT_NOTE_REQUIRED` and `errors.PICK_SHORT_QC_HOLD_MISSING` in `edge/src/messages/en.json` beside the existing pick errors (`:179` area; keys have moved, search `errors.PICK_`).
  - [ ] 2.4 Extend `test/unit/pick-shape.test.ts` with a short-picked shape case. Do not add a REST route and do not add a Story 1.9 spine allowlist entry. The upload door is the existing edge events route.

- [ ] Task 3: Short-pick applier, stock, finalization, packing (AC: 1, 2, 5)
  - [ ] 3.1 Add `applyPickLineShortPickedProjection` and call it from `src/events/store.ts` beside `applyPickLineConfirmedProjection` (`:1056-1061`). Lock the line with `getPickLineByIdForUpdate` first. Refuse a missing line, a line that belongs to another task, a cancelled line, and a line already `confirmed`, `substituted` or `short` with a different payload, using `PICK_LINE_ALREADY_CONFIRMED` (already permanent). An identical replay (same found quantity, reason and note) returns without a second stock move or a second shortfall row.
  - [ ] 3.2 Enforce quantity against the locked directed quantity, not the client. `found >= directed`, a non-milli value, or `BIN_EMPTY` with found other than 0 is `400 PICK_SHORT_QUANTITY_INVALID`. A reason outside the four codes is `400 PICK_SHORT_REASON_REQUIRED`. `OTHER` with a blank note is `400 PICK_SHORT_NOTE_REQUIRED`. `pick_line.confirmed` still refuses any quantity other than directed (`PICK_QUANTITY_MISMATCH` at `pick.ts:472-482`). Do not weaken that check. Delete the "genuine short pick needs an explicit exception flow" comment at `pick.ts:467-471` once this applier exists.
  - [ ] 3.3 Stock, in this order, on the locked line's bin and directed lot (lot-less lines pass `lotNumber` null into `releaseStock`, which already accepts null). Short units means directed minus found. `BIN_EMPTY`, `LESS_IN_BIN` and `OTHER`: `releaseStock` of the short units only; found units stay allocated. `DAMAGED`: `releaseStock` of the short units, then relocate those units from the pick bin into the site `ZONE-QC-HOLD` with the same `applyStockIssue` (`relocation: true`) plus `applyStockReceipt` pair `damage.ts` uses at `:1174-1200`, then open the case. If `ZONE-QC-HOLD` is missing, inactive, not quarantine, or not at the task site, throw `409 PICK_SHORT_QC_HOLD_MISSING` and roll the transaction back. Do not fall through to damage's `record_only` path. Do not post `stock.adjusted`. A found quantity of 0 skips `applyStockPick` later; it does not skip the release.
  - [ ] 3.4 Stamp the line `short`. Set `confirmed_quantity` to the found quantity (including `0`), `confirmed_lot_id` to `directed_lot_id`, `confirmed_location_id` to `location_id`, `confirmed_by` and `short_picked_by` from `envelope.metadata.actor.user_id` (ignore any client actor field). Insert one `pick_shortfall` row. Move the task `pending` to `in_progress` the same way confirmation does (`pick.ts:608-611`). When no `pending` line remains (`pick.ts:618-629`), call `finalizePickTaskCompletion`.
  - [ ] 3.5 In `finalizePickTaskCompletion`, include `short` in the allocated-to-picked query (`pick.ts:662`, today `status IN ('confirmed', 'substituted')`). Quantity is `confirmed_quantity`, which is the found quantity. Skip rows whose quantity is 0 so `applyStockPick` is never called with zero. Re-run `assertQcGateAllows` only for short or confirmed lines that actually move stock. In `applyPickTaskCompletedProjection`, count `short` as resolved (`pick.ts:830-831`). A task whose lines are all short, or mixed confirmed and short, must complete. A still-pending line still returns `409 PICK_TASK_NOT_ALL_LINES_CONFIRMED`.
  - [ ] 3.6 Widen the four packing filters in `src/compliance/dispatch.ts` (`:236`, `:259`, `:289`, `:672`) from `status IN ('confirmed', 'substituted')` to include `'short'`. Do not otherwise change packing. Because `confirmed_quantity` is the found quantity, the existing sums become the picked quantity. A zero-found short line adds nothing and must not create a packable grain. Add a regression that a short line with a positive found quantity packs, and that `PACKED_QTY_MISMATCH` still fires if packing exceeds that found quantity.
  - [ ] 3.7 Include `short` in the list count at `src/read/projections/pick_task.ts:302-303` (`FILTER (WHERE status IN ('confirmed', 'substituted'))`). Otherwise the 3.16 inbox under-counts `n of m picked` after a short line.
  - [ ] 3.8 On the edge door (`src/api/v1/edge.ts:823-825`), when `stream_type` is `warehouse` and `event_type` is `pick_line.short_picked`, set `payload.short_picked_by` from `authContext.userId`. Do not add a new role allowlist. Warehouse write at the site already admits `warehouse_operator` and `store_assistant`, which is the 3.16 door. Do not block a supervisor who already holds warehouse write.

- [ ] Task 4: Photo-less pick damage case (AC: 1)
  - [ ] 4.1 Add `openPickShortDamageCase` in `src/compliance/damage.ts` next to `openReceiptDamageCase` (`:1871`). One case per pick line: if a row already exists for `source_pick_line_id`, return. Insert with `source: 'pick'`, `source_pick_line_id`, `source_grn_line_id: null`, `photo_attachment_id: null`, `reason_code: 'DAMAGED_COMPONENT'`, `physical_state: 'in_qc_hold'`, `hold_mode: 'quarantined'`, quantity equal to the short units as numeric text, bin and quarantine location equal to `ZONE-QC-HOLD`, reporter equal to the picker. Write a `reported` damage action. Do not require a photo and do not render a damage-reason UI.
  - [ ] 4.2 Widen `DamageReportRow.source` (`src/read/projections/damage_report.ts:26`) and `InsertDamageReportInput.source` (`:187`) to `'report' | 'receipt' | 'pick'`. Add `source_pick_line_id` to the row, the insert input, `SELECT_COLUMNS` and `insertDamageReport`. A replay of the short event must not allocate a second `DMG-YYYY-NNNN` number.

- [ ] Task 5: Planning notification (AC: 2)
  - [ ] 5.1 Inside `finalizePickTaskCompletion`, after the existing `warehouse_manager` notification (`pick.ts:713-725`), if the task has at least one `short` line, emit one notification with `emitNotificationInTransaction`. Target `{ role: 'production_planner', location_id: <task site id> }` (`src/notify/emit.ts:6-16`). `event_type` `pick_shortfall_recorded`. `next_step` lists each short line as found of directed plus the reason. One notification per task, not per line. The packing notification still fires when there are no short lines and when there are.
  - [ ] 5.2 Do not add a `notification` read grant for `planner1@ancorlabs.org`. That holder has production write and inventory read only (`docs/migration/pilot-mock-extract/roles.json:444-469`). The test asserts the notification row, not that planner1 can open `GET /api/v1/notifications`. Record the inbox gap in `deferred-work.md`.

- [ ] Task 6: Edge short-pick tiles and lot substitution (AC: 3, 4)
  - [ ] 6.1 Replace the disabled Short pick button in `edge/src/components/pick-line.tsx:477-480` with a live control on both the lot step and the quantity step. Reuse `ScanField` and the existing outbox path (`insertCaptureEvent`). Do not add a nav row. Do not add photo capture.
  - [ ] 6.2 Pure model in `edge/src/components/pick-line-model.ts`. `BIN_EMPTY` sets found to 0. Raising found back to directed clears the short state and returns the picker to ordinary confirm (`confirmPayload`, which must still omit `override_reason` unless this is a substitution). While short, the Short pick button leaves the footer. Footer text is `Left: short reason` until a tile is chosen, `Left: one line` while Other has an empty note, then `Ready`. Primary label is `Confirm short pick - <found> of <directed>` and stays disabled until a reason is chosen and, for Other, the note is non-empty. `Damaged - report` shows `The damaged units go on hold and a QC task is raised. You only report; QC and finance decide.`
  - [ ] 6.3 Confirm writes `pick_line.short_picked` (stream `warehouse`, `capture_method: 'PWA'`) through the same settlement path as confirm (`pick-line.tsx:246-278`). The upload is not inside `pick-line.tsx`. `confirmPickLine` in `edge/src/components/edge-client.tsx:1117-1146` hardcodes `eventType: 'pick_line.confirmed'` and calls `confirmPayload`, which has no reason or found-quantity fields. Add a sibling callback (or a discriminated input) that writes `pick_line.short_picked` via `createOutboxEvent` and `insertOwnCapture`, and thread it through `FloorTasksProps` the same way `confirmPickLine` is threaded. Do not reuse `confirmPickLine` for a short pick. Mint a new idempotency key when found quantity, reason or note changes. Reuse the key for a retry of the same payload. A refusal of the new codes lands in Refused captures via `errorMessage`.
  - [ ] 6.4 Treat `short` as settled in `lineSettled` and `taskComplete` (`pick-line-model.ts:153-164`) so a short line advances and a task of confirmed plus short lines shows the completion panel. On that panel (`pick-line.tsx:353-370`) add a warn pill `<k> short` and the sentence `Short lines go back to planning for a re-pick.` Do not build the mock's All lines catalogue. Story 3.16 shows one current line at a time because a task is one SKU (`src/read/projections/pick_task.ts:85`). A local overlay may pill the line just shorted; do not add a second list.
  - [ ] 6.5 From the existing `Wrong lot - not picked` state (`pick-line-model.ts:116-123`), add `Use this lot instead`. A held lot (`getHeldLot` / `assertLotNotHeld`) still does not advance and does not open short pick or substitution. The substitution step collects `override_reason` and sends `pick_line.confirmed` with that field set. `confirmPayload` (`pick-line-model.ts:137-149`) does not accept `override_reason` today, and `confirmPickLine` does not pass it. Extend both. Do not send `pick_line.short_picked` for a substitution. The held-lot check in `confirmPickLine` (`edge-client.tsx:1120-1125`) must stay in front of both writes. The mock (`key-floor.html` around the wrong-lot copy) has no substitution control; do not invent extra mock chrome.
  - [ ] 6.6 All new copy under `floor.*` in `edge/src/messages/en.json`. Extend `edge/test/unit/i18n-literals.test.ts` if a new literal would fail the guard. Keep the scan field focused. Announce the result and the next instruction through the existing aria-live region. No horizontal scroll at 360 px. Primary stays 56 px on handheld. Zero new WCAG 2.1 AA violations.

- [ ] Task 7: Tests and deferred-work (AC: 5)
  - [ ] 7.1 `test/integration/story-3-17.test.ts`: happy path for each reason; `BIN_EMPTY` rejects a non-zero found quantity; `OTHER` rejects a blank note; found equal to directed is `PICK_SHORT_QUANTITY_INVALID` on the short event and still `PICK_QUANTITY_MISMATCH` on `pick_line.confirmed`; replay is a no-op; a conflicting replay is `PICK_LINE_ALREADY_CONFIRMED`; remainder allocation is released and found units stay allocated until finalization; finalization moves only the found quantity and writes `dispatch_order_status`; `DAMAGED` creates one `in_qc_hold` case for the short units and relocates those units to `ZONE-QC-HOLD`; a missing hold zone rolls back; the planner notification is one row per task; the warehouse_manager notification still fires; a direct event cannot stamp a different `short_picked_by`.
  - [ ] 7.2 Extend `edge/test/unit` pick-line or floor-tasks tests: stepper bounds, Bin empty forces 0, raising found to directed clears short, Other blocks confirm until the note is set, outbox payload shape, substitution payload carries `override_reason`, `taskComplete` accepts `short`.
  - [ ] 7.3 Update `edge/test/e2e/floor-tasks.spec.ts` so Short pick is no longer asserted disabled. Cover one short confirm and the completion sentence. Re-run `edge/test/accessibility/floor-tasks.spec.ts`.
  - [ ] 7.4 Add a `deferred-work.md` section for this story. Close the 3.6 data-loss path (the comment removed in Task 3.2). Leave open: `BIN_EMPTY` and `LESS_IN_BIN` release allocation and do not post a stock adjustment, so the system can show available quantity that is not in the bin; planner1 has no notification read grant. Do not build either gap in this story.

## Dev Notes

- **Scope boundary.** This story turns on the control Story 3.16 left disabled (`floor.shortPickDisabled`). It does not add a nav row, a photo flow, a new REST route, a spine allowlist route, a stock adjustment, or a notification grant. Lot substitution is the existing `pick_line.confirmed` override path, not a new event.
- **Validation walk.** Picking layouts and the four reasons are mock assumptions (`key-floor.html`, EXPERIENCE.md remaining action at `:269`). Build the drafted layout. Record user changes as follow-ups. Do not block implementation on a staging walk; Story 3.16 already shipped the screen.
- **Owner defaults, already ruled in the sprint change.** Q14: notify `production_planner` at the task site, not QC. Q15: a dispatch order with short lines still reaches packing for the found units. The `pick_shortfall` row is the re-pick signal. Do not hold the order for planning.
- **Line numbers were verified on 2026-11-22.** Epics.md citations have drifted. Use the paths in the tasks, not the epic line numbers.

### Binding stock rules

Table 1 is the stock contract. Do not invent a fifth reason or a stock adjustment.

| Reason | Found quantity | Allocation and stock | Damage case |
| --- | --- | --- | --- |
| BIN_EMPTY | must be 0 | release the full directed allocation; no relocate | no |
| LESS_IN_BIN | 0 <= found < directed | release directed minus found; found stays allocated until finalization | no |
| DAMAGED | 0 <= found < directed | release the short units, then relocate those units to ZONE-QC-HOLD | yes, quantity is the short units, `in_qc_hold`, no photo |
| OTHER | 0 <= found < directed, note required | same as LESS_IN_BIN | no |

### Architecture compliance

- No `architecture.md` was found under `_bmad-output/planning-artifacts`. Follow the live seams: `persistEvent` is the only write path, projections apply inside that transaction, and `read/projections/*.sql` is canonical with an `init-db.sql` mirror.
- `requiresBusinessStream: false` on the new event, same rationale as `pick_line.confirmed` (`src/events/schema.ts:5948-5959`). Do not tag the event and do not post a valuation movement from it. The damage relocate is valuation-neutral, matching `damage.ts:1174-1176`.
- Dual-file migrations: each new or widened SQL file is self-sufficient and carries its own guarded grants. Do not copy the `users.sql` split-brain (grants only in `init-db.sql`).
- CHECK widening never propagates by editing the constraint text alone (deferred-work 220). DROP then ADD.
- Idempotency is by `idempotency_key` alone (`src/events/store.ts` replay). A retried short pick with a changed payload and the same key records the first payload. The edge must mint a new key when the payload changes (Story 3.15 and 3.16 review rule).
- Date and quantity formatting: persist quantities as numeric text. Do not pass found quantity through a JavaScript float. DATE or timestamp display, if any, uses local year-month-day components, not `toISOString().slice(0, 10)`.

### Library and framework requirements

- Do not add a dependency and do not upgrade. Root pins `node >=24`, `pg ^8.16.0`, TypeScript via `tsx`. Edge pins `next ^16.2.10`. Tests are `node --test` plus Playwright. New code uses those, not a newer framework API.

### File structure requirements

- Server event and seam: `src/events/schema.ts`, `src/events/store.ts`, `src/compliance/pick.ts`, `src/compliance/damage.ts`, `src/api/v1/edge.ts`.
- Reads and packing: `src/read/projections/pick_task.ts`, `src/read/projections/damage_report.ts`, `src/compliance/dispatch.ts`.
- SQL: `read/projections/pick_line.sql`, new `read/projections/pick_shortfall.sql`, `read/projections/damage_report.sql`, `deploy/compose/init-db.sql`, `src/events/migrate.ts`.
- Edge: `edge/src/components/pick-line.tsx`, `edge/src/components/pick-line-model.ts`, `edge/src/components/edge-client.tsx` (`confirmPickLine` at `:1117`), `edge/src/messages/en.json`, `edge/src/sync/connector.ts`. Do not create a new route or a new screen shell.
- Tests: `test/integration/story-3-17.test.ts`, `test/unit/pick-shape.test.ts`, `test/unit/schema-drift.test.ts`, `test/unit/edge-permanent-error-parity.test.ts`, `edge/test/unit/*pick*`, `edge/test/e2e/floor-tasks.spec.ts`, `edge/test/accessibility/floor-tasks.spec.ts`.

### Testing requirements

- Integration tests hit PostgreSQL on `127.0.0.1:5442` via `.env.test`. Run `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/integration/story-3-17.test.ts` and the touched unit files. Then `npm test` if the story suite is green.
- Edge: `npm --workspace @inventory/edge test`, `npm --workspace @inventory/edge run typecheck`, `npm --workspace @inventory/edge run lint`. A failing `next build` is a blocker. Do not put `window` in a render-time dependency array (Story 3.15 review).
- Root: `npm run lint` and `npx tsc --noEmit` on touched server files.
- Regression: `pick_line.confirmed` quantity mismatch stays a 400. Packing of a fully confirmed line is unchanged. A short line is packable only up to found quantity.

### Previous story intelligence (3.16)

- Story 3.16 shipped the floor inbox and the three-step pick screen. Short pick is a disabled button with `floor.shortPickDisabled`. This story replaces that control. Do not leave both.
- `pick_task.completed` stays SOD-gated to `warehouse_manager` and `inventory_controller` (`pick.ts:808-821`). The picker still must not emit that event. Finalization stays inline.
- A held lot blocks the lot step online and offline. Short pick and substitution do not bypass that.
- Idempotency key, no-access card, and aria-live rules from the 3.16 Dev Notes still apply.
- Files to extend, not replace: `edge/src/components/pick-line.tsx`, `pick-line-model.ts`, `floor-tasks.tsx` only if the inbox pill count needs a client change (the server count in Task 3.7 should be enough), `edge/test/e2e/floor-tasks.spec.ts`, `edge/test/accessibility/floor-tasks.spec.ts`.

### Project context reference

- `_bmad-output/project-context.md` has no implementation rules beyond the stub. The binding rules are the seams above and `FORMATTING_RULES.md` for any markdown this story edits (`deferred-work.md`).
- Project memory that applies: tagging enforcement stays in `persistEvent` and this event does not require a business stream; DATE formatting uses local year-month-day; each migration file carries its own guarded grants.

### References

- Epic text: `_bmad-output/planning-artifacts/epics.md` Story 3.17 (after Story 3.16). Story 3.16 AC 4 and AC 5 name this story as the exception owner.
- Origin: `_bmad-output/planning-artifacts/sprint-change-proposal-2026-10-21.md` Table 1 row 3.17, Table 2 verification note, Table 3 order 10, questions Q14 and Q15.
- UX: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/EXPERIENCE.md` Report damage row, accessibility floor, remaining action to validate unelicited picking layouts. Mock tiles: `mockups/key-floor.html` short-pick section (labels Bin empty, Less in bin than shown, Damaged - report, Other).
- Previous story: `_bmad-output/implementation-artifacts/3-16-floor-task-inbox-and-pick-execution-screen.md`.
- Seams verified 2026-11-22: `src/compliance/pick.ts:398-631` and `:639-763` and `:776-857`; `src/compliance/dispatch.ts:232-299` and `:666-674`; `src/compliance/damage.ts:1865-1944` and `:1174-1200`; `src/api/v1/edge.ts:821-825`; `src/events/schema.ts:592-609` and `:5956-5959`; `src/events/store.ts:713-717` and `:1056-1061`; `read/projections/pick_line.sql:25`; `read/projections/damage_report.sql:94-96`; `src/read/projections/pick_task.ts:302-303`; `src/notify/emit.ts:6-16`.

## Dev Agent Record

### Agent Model Used

x-ai/grok-4.7

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.

### File List

## Change Log

- 2026-11-22: Story context created from epics.md Story 3.17, sprint-change-proposal-2026-10-21, the Story 3.16 file, and the current pick, dispatch, damage and edge seams. Status ready-for-dev.
