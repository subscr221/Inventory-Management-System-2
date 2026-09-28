---
baseline_commit: 2731fa5a5248eb8e8db440cde36fb98da2df0e93
---

# Story 8.9: Report Damage - Universal Capture, QC Task, and Commercial Outcome

Status: in-progress

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As any employee who finds damaged material,
I want to report it from any device by scanning the lot or item, and have the units held, QC decide, and finance settle a commercial outcome,
so that damage found anywhere becomes governed evidence with a concurred resolution instead of an informal write-off (realizes the "A dead PCB on the line" key flow).

## Acceptance Criteria

1. **Universal capture.** Given any signed-in role on any device, including the Story 1.15 employee base role, when they report damage by scanning the lot or item and capturing a reason and a photo, then the report is accepted (offline-capable, Story 1.8 pattern), the reported units go on quality hold, and an ad-hoc QC inspection task opens for them.
2. **Suspect whole lot is a request.** Given a reporter who suspects the damage extends beyond the scanned units, when they mark "Suspect whole lot", then that is recorded as a request, not a hold; the QC head decides whether the hold widens to the lot.
3. **Two keys.** Given a completed ad-hoc QC inspection confirming damage, when the resolution is decided, then it requires QC and finance concurrence keys, with disagreement escalating to the CEO band via the DOA registry.
4. **Four outcomes with ERP reference.** Given finance concurrence, when the commercial outcome is recorded, then it is exactly one of: debit note (FR-P-07), return for replacement, write-off, or accept as-is with price reduction; recorded in IMS and executed in ERP, with the IMS record carrying the ERP reference.
5. **Report and request replacement is one flow.** Given a reporter who also needs the material replaced, when they choose report-and-request-replacement, then it is one flow: the replacement becomes a requisition under normal approval rules (Story 4.3; standing approvals per Story 4.8 where they apply), linked to the damage report.

Owner rulings 2026-09-27 (answers to the create-story questions), binding on this story:

6. **CEO role.** A dedicated `ceo` role decides escalated cases, held by its own pilot account, not by an existing person.
7. **Photo store without a size cap.** Photos are stored as taken; the application imposes no photo size limit.
8. **Screens for every role.** Reporter, QC inspector, QC head, finance, CEO and stores each get their screens in the edge app.
9. **Receipt damage is a damage case.** A DAMAGED or REJECTED GRN line (Story 3.11) opens a damage case, and its held putaway cannot be released to a shelf until the case allows it (closes deferred-work L1157).
10. **Physical custody is tracked.** Reported stock is booked into the QC hold area at report time; when the units physically arrive there they are marked arrived; units taken out of the QC hold area for an external quality check are marked out and awaited until they are marked returned.

Source: [epics.md Story 8.9](../planning-artifacts/epics.md), created 2026-09-26 by [sprint-change-proposal-2026-09-26.md](../planning-artifacts/sprint-change-proposal-2026-09-26.md) section 4.1. PILOT. Closes Story 1.15 AC 3 (damage report from the base role), which 1.15 delivered only as named extension points. ACs 6-10 are owner rulings recorded in this story's Change Log.

## Tasks / Subtasks

- [x] Task 0: Preconditions (AC: all)
  - [x] 0.1 Story 1.15 is `done` but its ~35 files are uncommitted on top of `cf993ff`. This story builds on them (`EMPLOYEE_MODULE`, `EMPLOYEE_EDGE_EVENTS`, the D9 partition in `requireRole`, `SECTIONS`, `NAVIGATION_CAPABILITIES`). Confirm with the user that 1.15 is committed before recording `baseline_commit`; never start on a tree where 1.15 is still loose.
  - [x] 0.2 Read every Table 12 file before editing it. Run `graphify query` for orientation first (project rule).
- [x] Task 1: Red tests first (AC: 1-10)
  - [x] 1.1 Unit `test/unit/damage-rules.test.ts` against pure functions in `src/compliance/damage.ts`: reason catalogue (Table 5) and the OTHER note rule; outcome catalogue (Table 6) and the `price_reduction_pct` pairing in both directions (required for `accept_as_is_price_reduction`, refused for the other three; above 0 and at most 100; decimal string compared with `compareDecimalStrings`); the case state machine (Table 3) and the physical state machine (Table 4): each action legal only in its listed states; `DAMAGE_OUTCOME_MISMATCH` when the second key names a different outcome; `DAMAGE_CASE_LOCKED` after both keys; withdraw only by the key's own holder and only before both keys; `heldQuantity(case)` per D5 (reported quantity before inspection, confirmed quantity after, 0 once `cleared` or closed as `accept_as_is_price_reduction`). Confirm red.
  - [x] 1.2 Unit `test/unit/damage-routing.test.ts` (pattern `test/unit/weighbridge-breach-routing.test.ts`; Story 3.12 lesson: a notification to a role nobody holds reaches nobody): every role in Table 8 has at least one holder at the site in `docs/migration/pilot-mock-extract/roles.json`; exactly one person holds `ceo` and that person holds no other specialist role; `EMPLOYEE_EDGE_EVENTS` contains `{ stream_type: 'damage', event_type: 'damage.reported' }` and no other `damage.*` pair; `EDGE_DAMAGE_EVENT_TYPES` equals `['damage.reported']`. Confirm red.
  - [x] 1.3 Integration `test/integration/story-8-9.test.ts` (copy `makeRequest`, `provisionUser`, `authFor`, `pilotHolderGrants` from `test/integration/story-3-12.test.ts`; add `notification.sql` and the new projection SQL to the DDL list; TRUNCATE the new tables and the notification tables in `before`; seed the three damage DOA bands through the API). DOA authorities are the REAL oldest holders (`findRoleHolder` oldest-wins, memory `local-test-environment.md`): resolve them, never assume the fixture user. Personas: `emp1` employee only; `store1` store assistant plus employee; `qc1` qc_inspector plus employee; `qch` qc_head plus employee; `fin` finance_controller plus employee; `ceo` ceo plus employee; `svc` a service account with no employee grant. Cases, each with exact values and a negative control:
    - capture (AC 1): `emp1` `POST /api/v1/damage-reports` found at a bin with 10 owned units, quantity 4: 201, `report_number` matches `^DMG-\d{4}-\d{4}$`, `status` `on_hold`, `hold_mode` `quarantined`, `physical_state` `awaiting_arrival`; `stock_balance` shows 4 fewer at the bin and 4 more at the site's `ZONE-QC-HOLD`; one `damage_reported` notification to the QC inspection role naming the source bin; event `metadata.actor.role` `employee`. A second report of all remaining units of a single-bin SKU makes `GET /api/v1/stock/:sku/availability` answer `in_stock: false` for that bin. Quantity 40 (more than on hand): 201, `record_only`, `hold_note` `insufficient_stock_at_bin`, `physical_state` `not_held`, no stock moved. `found_at: 'in_use'`: 201, `record_only`, `hold_note` `in_use`, `physical_state` `with_reporter`. Unknown bin 404 `DAMAGE_LOCATION_NOT_FOUND`; lot-controlled item without lot 400 `DAMAGE_LOT_REQUIRED`; OTHER without note 400 `DAMAGE_OTHER_NOTE_REQUIRED`; note on a non-OTHER code 400 `DAMAGE_REASON_INVALID`; no photo id 400 `DAMAGE_PHOTO_REQUIRED`; `svc` 403 `MODULE_ACCESS_DENIED`; replay of the same idempotency key 409 `DUPLICATE_EVENT` with the existing event id.
    - edge door: `emp1` `POST /api/v1/edge/events` with `stream_type: 'damage'`, `event_type: 'damage.reported'`: accepted, `reporter_user_id` stamped from the token even when the body names another user; `damage.key_turned` on the edge door 403 `CENTRAL_ONLY_OPERATION`; an employee grant at another site 403 `LOCATION_ACCESS_DENIED`.
    - custody (AC 10): `store1` marks arrived: `physical_state` `in_qc_hold`, `arrived_by` and `arrived_at` set; marking arrived twice 409 `DAMAGE_PHYSICAL_STATE_INVALID`; `qc1` sends for external check with `destination` "NABL lab, Noida" and `expected_return_date`: `at_external_check`, stock ledger unchanged; `fin` recording the outcome while out 409 `DAMAGE_UNITS_OUT`; `store1` marks returned with `external_result_ref_ext`: back to `in_qc_hold`; `emp1` marking arrived 403 `MODULE_ACCESS_DENIED`; an `in_use` report marked arrived: `in_qc_hold` with no stock posting.
    - stock guard (D5): with 4 units held in `ZONE-QC-HOLD`, `POST /api/v1/stock/bin-moves` moving 4 out of quarantine 409 `DAMAGE_UNITS_HELD`; moving 4 into another quarantine bin succeeds; after the case is `cleared` the same move out succeeds; a quarantine bin holding 6 units of which 4 are held lets 2 leave and refuses the third.
    - receipt cases (AC 9): a GRN line with condition DAMAGED quantity 5 creates one case with `source` `receipt`, `source_grn_line_id` the line, `reason_code` `DAMAGED_COMPONENT`, `hold_mode` `quarantined`, `physical_state` `in_qc_hold`, `reporter_user_id` the receiving actor, no photo required; REJECTED maps to `WRONG_ITEM_OR_SPEC`; GOOD and SHORT lines create none; replaying the receipt creates no second case. The putaway release route (`releasePutawayTaskHandler`, `src/api/v1/receiving.ts:574-661`) for that line's held task 409 `DAMAGE_CASE_BLOCKS_RELEASE` while the case is open, and after a `write_off` close; succeeds after `cleared` and after an `accept_as_is_price_reduction` close.
    - whole lot (AC 2): report with `whole_lot_requested: true` leaves `lot_master.quality_hold_status` `none` and opens no `qc_quality_hold`; `qch` decides `hold_lot`: one governed `qc.hold_placed` with `hold_reason` `damage_report`, report shows `whole_lot_decision` `hold_lot` and the `hold_id`; `qc1` (not the DOA holder) deciding 403 `APPROVAL_REQUIRED`; deciding twice, or on a report without the request, 409 `DAMAGE_WHOLE_LOT_NOT_PENDING`; a lot already under an open governed hold: decision recorded with `lot_already_held: true`, no second hold, no `HOLD_EXISTS` surfaced.
    - inspection: `qc1` with `confirmed_quantity` 0: `cleared`, reporter and stores notified; 3 of 4: `awaiting_keys`, `confirmed_quantity` `3`, held quantity 3, notifications to both key roles; `emp1` inspecting 403 `MODULE_ACCESS_DENIED`; confirmed above reported 400 `DAMAGE_QUANTITY_INVALID`; unknown defect code 400 (the Story 8.5 code from `assertKnownDefectCode`).
    - keys (AC 3): QC key then finance key with the same outcome: `outcome_final`, `final_outcome` equals it, `decided_by` `concurrence`; finance first then QC also works; second key with a different outcome 409 `DAMAGE_OUTCOME_MISMATCH`; one person turning both keys 403 `SOD_VIOLATION`; the reporter turning a key on their own report 403 `SOD_VIOLATION`; a non-holder 403 `APPROVAL_REQUIRED`; no DOA entry for `damage.finance_concurrence` 409 `APPROVAL_UNRESOLVED`; withdraw with reason before the second key: key back to `pending`; withdraw or turn after both 409 `DAMAGE_CASE_LOCKED`; 10 concurrent finance key turns: exactly one succeeds, the rest 409 `DAMAGE_KEY_ALREADY_TURNED`.
    - escalation (AC 3, 6): finance disagrees with a reason after the QC key: `escalated`, notification to the `ceo` role holder; a key turn while escalated 409 `DAMAGE_CASE_LOCKED`; `ceo` decides `write_off`: `outcome_final`, `decided_by` `escalation`, event `metadata.actor.role` `ceo`; `qch` deciding the escalation 403 `APPROVAL_REQUIRED`; disagree before the other key turned 409 `DAMAGE_CASE_STATE_INVALID`.
    - outcome (AC 4): `fin` records `erp_document_ref_ext` on an `outcome_final` case: `closed`, ref stored verbatim; on an `awaiting_keys` case 409 `DAMAGE_CASE_STATE_INVALID`; empty ref 400; `accept_as_is_price_reduction` without `price_reduction_pct` 400 `DAMAGE_OUTCOME_INVALID`.
    - replacement (AC 5): `emp1` reports with `replacement_indent_id` X, then raises indent X with `damage_report_id`: 201, `indent.damage_report_id` equals the report id, approval resolved as for any indent; an indent naming a report whose `replacement_indent_id` differs, or another user's report, 409 `DAMAGE_REPLACEMENT_LINK_INVALID`; an indent without `damage_report_id` unchanged.
    - reads and actions (AC 8): `emp1` `view=mine` lists only own reports (seed another employee's, assert absent); `emp1` `view=workbench` 403 `FUNCTION_ACCESS_DENIED`; `qc1` `view=workbench` 200 for its site only; `fin` `view=workbench` lists exactly the cases awaiting the finance key or its ERP reference; detail `allowed_actions` equals, exactly, `['inspect', 'mark_arrived']` for `qc1` on a fresh report booked into quarantine, `['turn_finance_key']` for `fin` on an `awaiting_keys` case with no key turned, `['decide_escalation']` for `ceo` on an escalated case, `[]` for the reporter; detail by an unrelated employee 403 `FUNCTION_ACCESS_DENIED`; detail carries `reporter_display_name` from `users.display_name`.
    - attachments (AC 7): `PUT /api/v1/attachments/:id` with raw JPEG bytes of 10 KB and again of 6 MB: 201 with `sha256` and `byte_size`; same id same bytes again 200; same id different bytes 409 `ATTACHMENT_CONFLICT`; `image/gif` 415 `ATTACHMENT_TYPE_INVALID` (also when the header claims JPEG but the magic bytes do not); `GET` by the uploader returns identical bytes; by `qc1` 200 once a report at its site references it; by an unrelated employee 403.
  - [x] 1.4 Edge unit: `edge/test/unit/damage-capture.test.ts` for `createDamageReportedEvent` (stream `damage`, `stream_id` equals `report_id`, idempotency key `edge-damage-<eventId>`) and the replacement pairing (both events share `site_id`, SKU and quantity and cross-reference ids); `edge/test/unit/damage-case-view.test.ts` for the workbench grouping (Table 11) and the mapping of `allowed_actions` to action panels; `nav-model.test.ts` gains `Report damage` and `Damage cases`; add `/^damage\./`, `/^damage-/`, `/^damageCases\./`, `/^damage-cases-/` to `edge/test/unit/i18n-literals.test.ts` before any markup.
  - [x] 1.5 Run each new file alone; confirm it fails for the reason the assertion names, not a setup error.
- [x] Task 2: Schema and events (AC: 1-10)
  - [x] 2.1 Migrations at the tail of `MIGRATIONS` in `src/events/migrate.ts` (after `grn_line_condition.sql`), each mirrored in `deploy/compose/init-db.sql`, header, grants and idempotency after `read/projections/qc_quality_hold.sql`: `damage_report.sql` (Table 9 plus `damage_report_action`), `attachment.sql` (Table 10), `indent_damage_link.sql` (`ALTER TABLE indent ADD COLUMN IF NOT EXISTS damage_report_id UUID` with a partial index; no FK, events can arrive in either order across devices). Every CHECK pairing is two-way (Story 8.3 lesson). Extend `test/unit/schema-drift.test.ts`. Run `node --env-file=.env.test --import tsx src/events/migrate.ts` twice.
  - [x] 2.2 Register the eleven `damage.*` types (Table 2) in `SUPPORTED_EVENT_TYPES` (`src/events/schema.ts:5543`), `streamType: 'damage'`, `requiresBusinessStream: false`, and `attachment.uploaded` on stream `attachment`. Payload interfaces next to `IndentRaisedPayload` (`schema.ts:969`), which gains optional `damage_report_id`. Grep every place the `maintenance` stream is registered (shape asserts near `store.ts:770`, apply dispatch near `store.ts:1165` and `1270`, any stream enum or sync rule) and add `damage` the same way; never put `damage.*` on `qc` (D2).
  - [x] 2.3 `src/compliance/damage.ts`: `DAMAGE_EVENT_TYPES`, `DAMAGE_DECISION_MODULES`, `DAMAGE_CUSTODY_MODULES`, `assertDamage*Shape` per event, `applyDamageProjection(envelope, client)` wired into `persistEvent`'s in-transaction appliers, `allowedDamageActions(case, caller, client)`, and the pure rules from 1.1. Numbering `DMG-<year>-<4 digits>` via an allocator mirroring `allocateIndentNumber` (`src/read/projections/indent.ts`), IST year via `toIstCalendarDate`. New unique indexes map to stable 409s in the existing 23505 handler (`store.ts` near 2036-2050); never a second handler.
  - [x] 2.4 `src/compliance/damage-reasons.ts` (pattern `src/compliance/receiving-reasons.ts`): `DAMAGE_REASON_CODES` (Table 5), `MAX_DAMAGE_NOTE_LENGTH = 200`, `DAMAGE_OUTCOMES` (Table 6), `RECEIPT_CONDITION_TO_DAMAGE_REASON` (`DAMAGED` gives `DAMAGED_COMPONENT`, `REJECTED` gives `WRONG_ITEM_OR_SPEC`).
- [x] Task 3: Capture, hold, whole lot (AC: 1, 2, 10)
  - [x] 3.1 `damage.reported` applier: resolve the item (`getItemBySku`, else 404 `ITEM_NOT_FOUND`), the lot (`getLotByNumberAndSku`, `src/read/projections/lot_master.ts:165`; required when `lot_controlled`), the bin by code within `site_id` when `found_at = 'stock'`. Hold per D4: when the item is not serial-controlled, the bin is not already a quarantine location, and the owned balance at (sku, bin, lot) covers the quantity, relocate it to the site's `ZONE-QC-HOLD` in the same transaction with the putaway and bin-move ledger pair (`applyStockIssue` with `relocation` plus `applyStockReceipt`, see `src/compliance/bin-move.ts` near 96-140); `physical_state` `awaiting_arrival`. Export `QC_HOLD_ZONE_CODE` from `src/compliance/receiving.ts:88` instead of retyping it. Otherwise `record_only` with `hold_note` and `physical_state` per Table 4; NEVER refuse a report for stock reasons. Insert the case and its first action row, then `emitNotificationInTransaction` (AD-17) per Table 8.
  - [x] 3.2 `POST /api/v1/damage-reports`: `requireRole({ module: EMPLOYEE_MODULE, functionScope: 'write', locationId: body.site_id })` (D3). Server mints `report_id` if absent and stamps `reporter_user_id` from the token; idempotency through `idempotencyKeyFrom`, replay through `replayIdOrReject` (never check-then-act). 201 `{ event_id, report }`.
  - [x] 3.3 Edge door (`src/api/v1/edge.ts`, `src/sync/upload.ts`): append `{ stream_type: 'damage', event_type: 'damage.reported' }` to `EMPLOYEE_EDGE_EVENTS` (`src/middleware/rbac.ts:143`); add `EDGE_DAMAGE_EVENT_TYPES` and `assertEdgeDamageEventAllowed` beside `assertEdgeQcEventAllowed` (`upload.ts:320`) and call it next to it in `edgeEventUploadBase`; stamp `payload.reporter_user_id` exactly where `indent.raised` stamps `requester_user_id` (`edge.ts:707-729`). Every Table 7 code marked Edge goes into `PERMANENT_ERROR_CODES` (`upload.ts:18`), its mirror in `edge/src/sync/connector.ts:30` (parity test `test/unit/edge-permanent-error-parity.test.ts`), and `errors.<CODE>` in `edge/src/messages/en.json`.
  - [x] 3.4 `POST /api/v1/damage-reports/:id/whole-lot` `{ decision: 'hold_lot' | 'keep_local', reason }`: authority DOA `damage.qc_concurrence` (D7). `hold_lot` persists a governed `qc.hold_placed` (`hold_reason: 'damage_report'`, stream `qc`) through `persistEvent` on the same client as `damage.whole_lot_decided`. Extract the envelope builder from `placeQcHoldBase` (`src/api/v1/quality.ts:2299`) into a shared function; do not duplicate it. A lot with an open governed hold records `lot_already_held: true` and places nothing.
- [x] Task 4: Custody and the stock guard (AC: 1, 10)
  - [x] 4.1 `POST /api/v1/damage-reports/:id/custody/arrived` `{ note? }`, `.../custody/sent-external` `{ destination, reason, expected_return_date?, gate_pass_ref_ext? }`, `.../custody/returned` `{ note?, external_result_ref_ext? }`: gate `DAMAGE_CUSTODY_MODULES = ['warehouse', 'qc']` write at the case site. Transitions per Table 4; anything else 409 `DAMAGE_PHYSICAL_STATE_INVALID`. None of the three posts a stock movement (D6). Sending out is refused once the case is `closed`.
  - [x] 4.2 Stock guard (D5): one helper `assertDamageHeldQuantity(sku, lotNumber, locationId, remainingOnHand, client)` in `src/compliance/damage.ts`, called from `applyStockIssue` (`src/read/projections/stock_balance.ts:435`) only when the source location is a quarantine location (`isQuarantineLocation`, `src/compliance/stock-relocation.ts:34`) and the target is not one; it sums `heldQuantity` over open cases with `quarantine_location_id` equal to the source and refuses with 409 `DAMAGE_UNITS_HELD` when the stock left would fall below it. Take the case rows `FOR SHARE` in the same transaction. Every issue, pick, putaway release and bin move out of quarantine then honours the hold without a second check; verify each of those paths reaches `applyStockIssue` and record any that does not. Re-run `pilot-r6-held-lot-drains`, `story-3-11`, `story-3-6` and the bin-move suites.
- [x] Task 5: Receipt damage opens a case (AC: 9)
  - [x] 5.1 In the `goods.received` applier (`src/compliance/receiving.ts`, the `needsQcHold` branch near 1103-1153), for every `DAMAGED` or `REJECTED` line insert a case in the same transaction: `source` `receipt`, `source_grn_line_id` UNIQUE (a replay inserts nothing), `source_event_id` the receipt event, `reporter_user_id` the receiving actor, `reason_code` from `RECEIPT_CONDITION_TO_DAMAGE_REASON`, `source_reason_code` the 3.11 detail code, `source_photo_ref` the 3.11 `reason_photo_ref` when present, `quantity` the line quantity, `hold_mode` `quarantined`, `quarantine_location_id` the line's target, `physical_state` `in_qc_hold`, `status` `on_hold`. The case needs no photo attachment (pairing CHECK: `source = 'report'` iff `photo_attachment_id` not null). All three paths that persist `goods.received` (two in `src/api/v1/receiving.ts` near 321 and 428, and the edge door near `edge.ts:613`) reach this applier; do not add per-route code. No extra notification: 3.11's `qc_hold_placed` already goes to the inspector.
  - [x] 5.2 `goods.putaway_released` applier (`src/compliance/receiving.ts` near 1458): when the task's GRN line has a case, refuse with 409 `DAMAGE_CASE_BLOCKS_RELEASE` unless the case is `cleared`, or `closed` with `accept_as_is_price_reduction`, and its `physical_state` is `in_qc_hold`. Partial release of unconfirmed units is out of scope (stores moves them with a bin move, which the guard in 4.2 allows). Update the Story 3.11 tests that released a held DAMAGED putaway without a case decision; record each changed assertion in Completion Notes.
- [x] Task 6: Inspection, keys, escalation, outcome, reads (AC: 3, 4, 6, 8)
  - [x] 6.1 `POST /api/v1/damage-reports/:id/inspection` `{ confirmed_quantity, defect_code?, note? }`: gate `qc` write at the case site (the ad-hoc QC task is the case, D8). 0 gives `cleared`; above 0 requires `defect_code` (`assertKnownDefectCode`, `src/compliance/quality.ts:4926`) and gives `awaiting_keys`; `case_value` computed per D7. Notify per Table 8.
  - [x] 6.2 `POST /api/v1/damage-reports/:id/keys/:key/turn` (`key` in `qc`, `finance`), `.../withdraw`, `.../disagree`: RBAC gate `DAMAGE_DECISION_MODULES` write (D9), then `resolveDamageAuthority(transactionType, value, client)` (D7). Lock the case `FOR UPDATE` and re-check status under the lock (8.3, 8.4, 8.5 hold-bypass lesson). SOD per D10.
  - [x] 6.3 `POST /api/v1/damage-reports/:id/escalation/decide` `{ outcome, price_reduction_pct?, reason }`: authority `damage.escalation`; only in `escalated`.
  - [x] 6.4 `POST /api/v1/damage-reports/:id/outcome` `{ erp_document_ref_ext, note? }`: authority `damage.finance_concurrence`; only in `outcome_final` and not `at_external_check` (409 `DAMAGE_UNITS_OUT`); `closed`; notify per Table 8. Bounded text via `isBoundedText` (ref at most 64 characters, notes at most 200, destination at most 120).
  - [x] 6.5 Reads: `GET /api/v1/damage-reports?view=mine|workbench&site_id=&status=&limit=` and `GET /api/v1/damage-reports/:id` per D11; the detail carries `allowed_actions` (Table 11 names), `history` from `damage_report_action`, `reporter_display_name` and the display names of key holders from `users.display_name` (email when null), `photo_status` (`pending` or `stored`), and `replacement_indent_number` and `replacement_status` joined from `indent`. The edge never decides authorization: it renders what `allowed_actions` lists. Wire every route in `src/server.ts` and add each to `allowedSpineRoutes` in `test/integration/story-1-9.test.ts:171`.
  - [x] 6.6 Every rejection code used by the new route files goes into that file's `AUDITED_REJECTIONS` if it keeps one (8.3 lesson on stale codes).
- [x] Task 7: Replacement link (AC: 5)
  - [x] 7.1 `assertIndentRaisedShape` (`src/compliance/indent.ts:135`) accepts optional UUID `damage_report_id`; `applyIndentRaised` (`indent.ts:254`) stores it and, when present, requires a case with `replacement_indent_id = indent_id` and `reporter_user_id = requester_user_id`, else 409 `DAMAGE_REPLACEMENT_LINK_INVALID`. Approval resolution, duplicate detection and numbering are untouched; `raiseIndentBase` forwards the field.
- [x] Task 8: Photo store (AC: 1, 7)
  - [x] 8.1 `PUT /api/v1/attachments/:attachment_id` with the raw image as the body (`Content-Type` `image/jpeg`, `image/png`, `image/webp`, `image/heic` or `image/heif`; checked against the magic bytes too; else 415 `ATTACHMENT_TYPE_INVALID`), gate `EMPLOYEE_MODULE` write. Add `readRawBody(req)` to `src/middleware/body.ts` beside `readJsonBody`; it carries no photo-specific limit (D14), only the server-wide `MAX_BODY_SIZE` every request already has. Compute sha256; write the blob row and an `attachment.uploaded` event (metadata only, never bytes) in one transaction through `persistEvent`'s external client so the upload is edit-logged (AD-12). Same id and hash 200; different hash 409 `ATTACHMENT_CONFLICT`.
  - [x] 8.2 `GET /api/v1/attachments/:attachment_id` returns the bytes with the stored content type and `Cache-Control: private, no-store`; visibility per D11; unknown id 404 `ATTACHMENT_NOT_FOUND`.
  - [x] 8.3 A case may reference an attachment that has not arrived yet (offline ordering); `photo_status` stays `pending` until it has.
- [x] Task 9: Reporter screens (AC: 1, 2, 5)
  - [x] 9.1 `edge/src/capture/damage.ts`: `createDamageReportedEvent` (pattern `edge/src/capture/indent.ts:28-74` over `createOutboxEvent`); with replacement, also `createIndentRaisedEvent` with `damageReportId`, same site, SKU and quantity, `need_by_date` today (IST), `urgent: true`, reason from `damage.replacementReason`, inserted after the damage event so the outbox uploads it second.
  - [x] 9.2 Photo: `<input type="file" accept="image/*" capture="environment">`; keep the original file as taken (no downscale). Store pending photos as Blobs in a dedicated IndexedDB store (`edge/src/local-db/pending-photos.ts`, plain IndexedDB API, no new dependency), not in a PowerSync table: originals are several megabytes. `edge/src/sync/attachment-uploader.ts` PUTs them through `authorizedFetch` when online (on bootstrap and after each `refreshLocalState`), deletes on 200, 201 or 409 with the same hash, and retries otherwise. Only if a photo is larger than the server-wide request limit does the uploader re-encode it as JPEG to fit, so a report never strands. Do not touch the PowerSync `uploadData` path in `connector.ts` beyond the error-code set.
  - [x] 9.3 `edge/src/components/report-damage.tsx`, view `'report-damage'`, page `edge/app/damage/new/page.tsx` (thin `<EdgeClient view=... />`, pattern `edge/app/requests/page.tsx`); fields and copy per Table 13; keyboard-wedge scan inputs for SKU, lot and bin (pattern `fault-report-capture.tsx:64-72`, 56 px `scan-input`). Do not call `assertLotNotHeld`: a held lot may still be reported. Works offline; the done screen shows "Captured - pending sync" until the outbox row settles; submit is debounced (4.3 lesson).
  - [x] 9.4 My requests: widen `SECTIONS` in `edge/src/components/my-requests.tsx:23-25` to `'requisitions' | 'damage_reports'`; fetch `/api/v1/damage-reports?view=mine&limit=51` (display 50, truncation line when more); row: number, state pill, SKU x quantity, lot, "QC and finance will decide" until final, the outcome label once final, the replacement indent number when linked. Keep the quiet refetch and the ready state (1.14 lessons).
- [x] Task 10: Workbench screens for QC, finance, CEO and stores (AC: 2, 3, 4, 8, 10)
  - [x] 10.1 `edge/src/components/damage-cases.tsx`, view `'damage-cases'`, page `edge/app/damage/cases/page.tsx`; the selected case is a query parameter (`?case=<id>`) because the edge app has no dynamic route segments. List and detail side by side on a wide pointer, stacked on touch: groups, cards and copy per Table 11 and Table 14 (sources `mockups/key-qc.html`, `mockups/key-approvals.html`, DESIGN.md `concurrence-keys-card` with pills pending `warn`, concurred `ok`, disagree `err`).
  - [x] 10.2 Action panels render only for names in `allowed_actions`; every action posts through `authorizedFetch`, disables sibling buttons while in flight, returns focus to the case header, announces the result in a live region only when there is a message, and refetches the case quietly (1.14 lessons). Reasons the API requires are required fields in the form.
  - [x] 10.3 The photo loads through `authorizedFetch` into an object URL (revoked on unmount); `photo_status` `pending` shows "Photo not yet uploaded".
  - [x] 10.4 Online only: offline renders the needs-connection card "Approvals need a live connection" (EXPERIENCE.md L100), no rows.
- [x] Task 11: Navigation (AC: 1, 8)
  - [x] 11.1 `NAVIGATION_CAPABILITIES` (`src/api/v1/edge.ts:354-365`): row 7 `Report damage`, modules `[EMPLOYEE_MODULE]`, write; row 8 `Damage cases`, rule `'damage-cases'` evaluated by `hasDamageCaseScope(authContext, siteId, client)`: a `qc` or `warehouse` assignment at the site, or active holder of the role of any of the three damage DOA entries. `NAV_ENTRIES` gains `/damage/new` and `/damage/cases`; `BASE_VIEW_ENTRY` and the view unions in `app-shell.tsx` and `edge-client.tsx` gain both views; a deep link without the entry renders the existing no-access copy (1.15 Task 3.6 pattern). Update every navigation pin (`test/integration/story-1-15.test.ts`, `story-1-8`, anything else that pins the array).
  - [x] 11.2 Edge gates: `npm run edge:typecheck`, `edge:lint`, `edge:test`, then from `edge/` `npx playwright test test/e2e test/accessibility --reporter=line`. New specs `edge/test/e2e/report-damage.spec.ts`, `edge/test/e2e/damage-cases.spec.ts` (one persona per role: QC inspector inspects and marks custody, QC head decides the whole lot and turns the QC key, finance turns its key then records the ERP reference, CEO decides an escalation, stores marks arrived and returned), and `edge/test/accessibility/damage-accessibility.spec.ts`, on a new `edge/test/fixtures/damage-stub.ts` following `employee-base-stub.ts` (stub bootstrap per persona, `PUT /api/v1/attachments/`, `GET /api/v1/damage-reports`, the action POSTs; `/api/v1/edge/events` throws offline so captures stay queued). Real Tab presses for keyboard evidence. The two `offline-shell.spec.ts` tests are known red.
- [x] Task 12: Pilot pack, CEO, DOA, access matrix (AC: 3, 6)
  - [x] 12.1 New pilot person `ceo1@ancorlabs.org` (fictitious display name in the pack's style) with `{ role: 'ceo', module: 'employee', function_scope: 'write', location_id: 'site' }` and the base hat row: hand-edit `docs/migration/pilot-mock-extract/roles.json` and `world.json` (`people`, `operations.actors.ceo`), mirror both in `deploy/rehearsal/mock/generate.mjs` (never regenerate the pack). Update the counts the Story 1.15 pack test pins (22 people, grants accordingly). `provision:roles` dry run: 0 segregation violations; do NOT `--apply` into the local test DB.
  - [x] 12.2 `deploy/provision/staging-doa-bands.sh`: three unbounded bands, `damage.qc_concurrence` for `qc_head`, `damage.finance_concurrence` for `finance_controller`, `damage.escalation` for `ceo`, same skip-if-active rule.
  - [x] 12.3 `src/config/index.ts`: `DAMAGE_STORES_NOTIFICATION_ROLE` (default `store_assistant`), parsed like `QC_INSPECTION_TASK_NOTIFICATION_ROLE` (`config/index.ts:636-642`).
  - [x] 12.4 Access matrix `_bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md`: section 2 gains `ceo` ("Decides damage cases escalated when QC and finance disagree; DOA `damage.escalation`; location scope site"); section 3.8 employee table gains "Report damage" C (employee, all roles); a damage-case capability block (inspect: qc_inspector, qc_head; custody marks: store roles, QC; QC key and whole-lot decision: DOA `damage.qc_concurrence`; finance key and ERP reference: DOA `damage.finance_concurrence`; escalation: DOA `damage.escalation`); the DOA band table gains the three bands; changelog v1.2 naming this story, reviewer "pending Super Admin review". Apply `FORMATTING_RULES.md`.
- [ ] Task 13: Green, regression, smoke, runbook (AC: all)
  - [x] 13.1 Focused set with `node --env-file=.env.test --import tsx --test --test-concurrency=1`: new files plus `story-1-15`, `story-1-8`, `story-1-9`, `story-1-14`, `story-4-3`, `story-4-7`, `story-3-4`, `story-3-6`, `story-3-11`, `story-8-5`, `story-8-3`, `story-11-2-edge-sweep`, `quality-event-registry`, `edge-permanent-error-parity`, `employee-base-role-pack`, `schema-drift`, `segregated-roles`, `provision-roles-core`, `no-hardcoded-role-in-workflow`, `pilot-r6-held-lot-drains`.
  - [x] 13.2 Full `npm test`, `npx tsc --noEmit` root and `edge/`, `npm run lint`, `prettier --check --end-of-line auto` on new files (files unformatted at baseline stay as they are).
  - [x] 13.3 `deploy/rehearsal/mock/operations-smoke.ts`: flow `damageReport` as `operations.actors.employee`: upload a small JPEG, report 1 unit of a stocked SKU at a bin with replacement, raise the linked indent, assert `quarantined` and the link; mark arrived as `store`; inspect as `qc`; both keys as the resolved holders; record an ERP reference as `compliance`; assert `closed`. A second flow drives a disagreement to `ceo`. Guard every missing actor, SKU or band with a named SKIP line.
  - [x] 13.4 `docs/migration/pilot-cutover-runbook.md` row 2.10g after 2.10f, same shape: create the `ceo1@` Keycloak account as 2.9 creates pack accounts, re-apply roles and `staging-doa-bands.sh`, the `damage:` smoke lines PASS; browser: as `maint1@` report with a photo in airplane mode ("Captured - pending sync"), reconnect, My requests shows the case "On hold - with QC" and the linked requisition; as `store1@` mark arrived; as `qc1@` inspect; as `qchead1@` and `accounts@` turn the keys; as `accounts@` record the ERP reference.
  - [ ] 13.5 Staging run (operator task, 1.15 Task 6.3 convention): deploy per runbook 2.15, execute 2.10g, record PASS and date in Completion Notes. Leave unchecked without the operator; never mark done on local evidence.
- [x] Task 14: Records (AC: all)
  - [x] 14.1 `deferred-work.md` section "Deferred from: dev of 8-9-report-damage-universal-capture-qc-task-and-commercial-outcome" listing each Out of scope item still open.
  - [x] 14.2 Story file: Dev Agent Record, File List, Change Log. `graphify update .`.

### Review Findings

Code review 2026-09-27, backend-core chunk only (`src/compliance/{damage,damage-reasons,quality,receiving,indent,bin-move,putaway}.ts`, `src/api/v1/{damage-reports,attachments,edge,events,indents,quality}.ts`, `src/api/router.ts`; diff `2731fa5..857da7e`). The diff was too large (12226 lines) for one pass and was chunked into 5 groups; edge app, tests, read/events/infra, and deploy/docs groups are separate follow-up reviews. Three findings from the Acceptance Auditor layer were false positives caused entirely by this chunk boundary (the guard/backstop code they flagged as missing lives in the read/events/infra chunk, not this one) — noted here so a follow-up review doesn't re-litigate them.

- [x] [Review][Patch] Case release (`cleared`, or `closed` as accept-as-is) had no explicit "confirm returned to stock" custody action, only the "move the released units back to stock" notification. Owner decision 2026-09-28: manual by design (stores physically walks units back, no auto-reversal of the ledger move) — but the loop must close with a real state transition. Added `damage.returned_to_stock` (the reverse of `damage.units_arrived`: `in_qc_hold` → `not_held`, gated on the case having actually released the units), its `mark_returned_to_stock` action and `allowedDamageActions` entry, and the route `POST /api/v1/damage-reports/:reportId/custody/returned-to-stock`. [src/compliance/damage.ts: DAMAGE_RETURNED_TO_STOCK, nextPhysicalState, applyCustody, applyDamageProjection; src/api/v1/damage-reports.ts: markReturnedToStockHandler; src/server.ts route; src/events/schema.ts SUPPORTED_EVENT_TYPES; test/unit/schema-drift.test.ts count 11→12; new integration test "mark_returned_to_stock closes the release loop, gated on release"]
- [x] [Review][Patch] `photo_attachment_id` was validated for UUID shape only, never ownership, so a fabricated report could name another user's already-uploaded photo and (via `canReadAttachment`'s case-visibility branch, D11) hand it a wider audience than its uploader chose. Fixed: `applyDamageReported` now rejects 403 `DAMAGE_PHOTO_NOT_OWNED` when the id already belongs to someone else. A **not-yet-uploaded** id is still accepted (Story 1.8 offline pattern: `photo_status` stays `pending` until its own PUT lands) — this only closes the case where the id is already claimed. [src/compliance/damage.ts applyDamageReported; src/api/v1/damage-reports.ts AUDITED_REJECTIONS; new integration test "photo_attachment_id must be uploaded by the reporter, once claimed"]
- [x] [Review][Patch] `price_reduction_pct` was read raw via `optional()` while `quantity`/`confirmed_quantity` go through `decimal()` coercion in the same file — a client sending it as a JSON number was rejected inconsistently. Fixed: routed through `decimal()` too. [src/api/v1/damage-reports.ts turnKeyHandler/disagreeKeyHandler/decideEscalationHandler payloads]
- [x] [Review][Patch] Custody transitions (`send_external`) checked `status !== 'closed'` but not the full `LOCKED_STATUSES` set (`escalated`, `outcome_final`) that locks every other case action, so units could be sent out for external check on an already-escalated/outcome-final case. Fixed: `send_external` now checks `!LOCKED_STATUSES.has(state.status)`. `return` (bringing units back) is deliberately left ungated on status — a locked-but-still-external case must always be able to come back, since `assertOutcomeRecordable` needs `physical_state !== 'at_external_check'` to unblock recording. [src/compliance/damage.ts nextPhysicalState]
- [x] [Review][Patch] "One line" text validators rejected only `\r`/`\n`, not Unicode line/paragraph separators U+2028/U+2029. Fixed: extended the regex. [src/compliance/damage.ts optionalBoundedText/requiredBoundedText]
- [x] [Review][Patch] `occurred_at` was not validated as well-formed before deriving the report-number year in `applyDamageReported`, unlike the equivalent guard already in `indent.ts`'s `applyIndentRaised`. Fixed: added the same guard. [src/compliance/damage.ts applyDamageReported]

- [x] [Review][Defer] `resolveDamageAuthority`'s escalate-to-next-available-band fallback and its wall-clock (not `occurred_at`) delegation check were flagged as Story 8.9 bugs, but both turned out to be pre-existing, already-reviewed, platform-wide conventions: `listActiveDoaEntries`'s own docstring names it "the approver-escalation fallback... (Story 2.5 review)", and every other `findActiveDelegation` call site in the codebase (indents, purchase-order, quality, receiving, cycle-counts, master-data, etc.) uses the same wall-clock `today`. Fixing either one only in `damage.ts` would make this module inconsistent with the rest of the platform rather than fix a defect this diff introduced — deferred to a cross-cutting review of the DOA/delegation resolvers if the platform owner wants either behavior changed. [src/read/projections/doa_registry.ts resolveDamageAuthority fallback and delegation checks, and its callers]
- [x] [Review][Defer] `listDamageReportsBase` workbench branch is an unpaginated full scan with N+1 authority checks per row; `presentReport` issues up to 3 sequential queries per listed report [src/api/v1/damage-reports.ts] — deferred, pilot-scale performance, not correctness (duplicates the already-recorded "scans up to 2,000 recent cases" entry in deferred-work.md)
- [x] [Review][Defer] `RAW_BODY_PATH_PREFIX` is a blanket string-prefix match over the whole attachments namespace rather than the specific upload route [src/api/router.ts:24,117] — deferred, pre-existing router style in this codebase
- [x] [Review][Defer] Concurrent-PUT idempotent retry on attachments compares only `sha256` against the stored row, not `content_type`; and the duplicate `report_id`/`indent_id` check-then-insert has no advisory lock (same class as the codebase's existing `attachment.uploaded:*` idempotency-key pattern, which the generic 23505 handler in `src/events/store.ts` already backstops) [src/api/v1/attachments.ts putAttachmentBase; src/compliance/damage.ts applyDamageReported ~2208; src/compliance/indent.ts applyIndentRaised] — deferred, narrow race window, existing pattern
- [x] [Review][Defer] `expected_return_date` on a damage custody record is validated as a calendar date but never checked against being in the past [src/compliance/damage.ts ~1824-1836] — deferred, minor data-quality nicety, not tied to any AC

### Review Findings (chunk 2 of 5: read/events/infra)

Code review 2026-09-28, read/events/infra chunk (`read/projections/{attachment,damage_report,indent_damage_link}.sql`, `src/read/projections/{damage_report,indent,stock_balance}.ts`, `src/events/{migrate,schema,store}.ts`, `src/middleware/{body,rbac}.ts`, `src/config/index.ts`, `src/server.ts`, `src/sync/upload.ts`; diff `2731fa5..HEAD` including this session's chunk-1 fixes). 0 decisions, 6 patches applied, 5 deferred, 8 dismissed. The Acceptance Auditor explicitly cross-checked (not just assumed) the two mechanisms the chunk-1 Auditor got wrong last time — D5's quantity guard wiring and D2/D3's edge-door gate — and confirmed both correct; also flagged two spec-vs-code documentation gaps (undocumented `hold_note` value `no_qc_hold_zone` and undocumented `whole_lot_already_held` column, both in Table 9) that are deferred as doc-only, no code defect. No new automated tests were added for this chunk's patches — they're schema-completeness/defensive fixes with narrow or unreachable-today trigger conditions (see each item), and simulating them cleanly (a genuine two-transaction race, or a raw constraint-violating INSERT bypassing the app layer) didn't seem worth the harness complexity versus the risk being closed.

- [x] [Review][Patch] `bin_location_id` had no biconditional pairing CHECK, unlike `bin_code`, contradicting the file's own stated "every pairing CHECK is a full biconditional" invariant. Fixed: `chk_damage_report_bin_pairing` now also requires `(bin_code IS NOT NULL) = (bin_location_id IS NOT NULL)`. [read/projections/damage_report.sql, deploy/compose/init-db.sql (mirrored, per this file's own "change both together" rule)]
- [x] [Review][Patch] No CHECK constraint stopped `external_returned_at` from being set without the case ever having been sent externally, or `external_result_ref_ext` from being set without a return. Fixed: `chk_damage_report_external_pairing` gained `(external_returned_at IS NOT NULL) <= (external_sent_by IS NOT NULL)` and `(external_result_ref_ext IS NOT NULL) <= (external_returned_at IS NOT NULL)` — one-directional, not a full biconditional, because `external_result_ref_ext` is legitimately optional on return (`applyCustody`'s `return` branch always sets `external_returned_at`, only sometimes `external_result_ref_ext`). [read/projections/damage_report.sql, deploy/compose/init-db.sql]
- [x] [Review][Patch] `damage_report_pkey` (a true idempotent replay) and `uq_damage_report_source_grn_line` (a different report_id fighting over an already-cased GRN line — a business-rule violation, not a replay) were mapped to the same misleading `DUPLICATE_EVENT` message and the wrong `report_id`. Fixed: split into two branches; the GRN-line collision now throws `DAMAGE_CASE_ALREADY_EXISTS_FOR_GRN_LINE` with `source_grn_line_id` in its details. Low reachability in practice — `openReceiptDamageCase` already pre-checks `getDamageReportByGrnLine` and no-ops if a case exists, so this constraint only fires on a genuine concurrent race between two receipt transactions for the same line. [src/events/store.ts]
- [x] [Review][Patch] `listOpenDamageReports`'s doc comment said "every case not yet closed or cleared," omitting the 30-day trailing window its own SQL keeps (matching `listDamageReports`'s sibling behavior). Fixed the comment. [src/read/projections/damage_report.ts]
- [x] [Review][Patch] `getDamageReportByGrnLine` lacked the UUID-format guard its sibling `getDamageReportById` has; a malformed id would hit a raw Postgres type-cast error instead of returning null. Low reachability — both call sites pass an internal GRN line id, never a raw request param — but a one-line, unambiguous consistency fix. [src/read/projections/damage_report.ts]
- [x] [Review][Patch] `updateDamageReport` spliced `Object.keys(patch)` straight into the SQL `SET` clause with only a code comment as protection against a future caller passing untrusted keys. Safe today (every current caller passes a literal object), but added a runtime `UPDATABLE_COLUMNS` allowlist so it stays safe. [src/read/projections/damage_report.ts]

- [x] [Review][Defer] The recursive quarantine-pool CTE in `assertDamageHeldQuantity` caps at `depth < 10` with no warning if a site's location hierarchy is deeper — deferred, pilot sites are flat, but worth a log line if this ever fires in practice [src/read/projections/damage_report.ts]
- [x] [Review][Defer] `assertDamageHeldQuantity` fails open (silently skips the guard) if `sourceLocationId` doesn't resolve to a row in `location_register` — deferred, that state can't currently occur since `stock_balance.location_id` is FK-constrained to `location_register`; this is defensive dead code, not a live gap [src/read/projections/damage_report.ts]
- [x] [Review][Defer] Undocumented `hold_note` value `no_qc_hold_zone` (a sensible fallback for a site missing `ZONE-QC-HOLD`) isn't in the story's Table 9 catalogue of five reasons — deferred, doc-only, reconcile in the story file rather than the schema
- [x] [Review][Defer] Undocumented `whole_lot_already_held` column isn't in the story's Table 9 column list for the whole-lot group, though the event payload (`lot_already_held`) needs somewhere to persist it and this is where it lands — deferred, doc-only, functionally correct
- [x] [Review][Defer] `readRawBody` throws on an oversized body without draining or destroying the request socket — deferred, this exactly mirrors the pre-existing `readJsonBody` in the same file, not a regression Story 8.9 introduced; a fix belongs to both functions together, out of this story's scope [src/middleware/body.ts]

### Review Findings (chunk 3 of 5: edge app)

Code review 2026-09-28, edge-app chunk (edge/app/damage/*, edge/src/{capture,components,local-db,sync}/*, edge/src/messages/en.json; diff `2731fa5..HEAD`). 0 decisions, 3 patches applied, ~12 deferred, ~2 dismissed/low-confidence. The one HIGH finding was a real regression this review process itself created: chunk 1's backend fix added `damage.returned_to_stock`/`mark_returned_to_stock` to close AC10's release loop, but the edge app — reviewed only now — never learned about it, so a server-granted action was completely invisible on every device. Caught here specifically because the workflow chunks by file group and reviews groups in sequence; fixed before it could ship.

- [x] [Review][Patch] `mark_returned_to_stock` (added in chunk 1) was missing from `DAMAGE_ACTION_NAMES`/`PANEL_OF`/`ROUTE_OF` in `edge/src/components/damage-case-view.ts` — `isDamageActionName`/`panelsFor` silently drop unrecognized names, so the server-granted action had no button, panel, or route anywhere in the edge app, undermining AC10 on the client side. Fixed: added the action name, panel (`custody`), route (`custody/returned-to-stock`), a `CustodyCard` button, `SUCCESS_LABEL`/`en.json` strings, and updated the two pinned unit tests in `edge/test/unit/damage-case-view.test.ts` (the action-name and route-mapping tests). [edge/src/components/damage-case-view.ts, edge/src/components/damage-cases.tsx, edge/src/messages/en.json]
- [x] [Review][Patch] `submitDamage` (`edge/src/components/edge-client.tsx`) writes the photo to `pendingPhotoStore` *before* inserting the outbox events (deliberately, per its own comment — a report whose photo never stored would wait forever). If the event insert then throws, the already-written photo blob was orphaned with no owning report and no cleanup path. Fixed: wrapped the insert in try/catch and remove the just-stored photo before rethrowing on failure. [edge/src/components/edge-client.tsx]
- [x] [Review][Patch] `damage.doneRefused` told the reporter to "See the list below," but the done screen renders no such list — and the generic `damage.doneDecide` paragraph ("QC and finance will decide, you do not need to do anything more") was shown even when the report was refused, directly contradicting the refusal. Fixed: reworded the message to point at My requests, and suppressed `doneDecide` on the refused path. [edge/src/messages/en.json, edge/src/components/report-damage.tsx]

- [x] [Review][Defer] `edge/src/local-db/pending-photos.ts` has no cap, eviction, or retention policy — a photo blob whose owning capture never completes, or whose uploader never signs back in on a shared tablet, sits in IndexedDB indefinitely. Needs a product decision on retention, not a one-line fix.
- [x] [Review][Defer] `reencodeAsJpeg` (`edge/src/sync/attachment-uploader.ts`) silently degrades a photo to fit the 10MB cap with no signal to the reporter or QC that it happened — by design per D14/Task 9.2 (re-encode only when exceeding the size ceiling), but visibility to QC is a fair enhancement ask.
- [x] [Review][Defer] `uploadOne`'s reencode-once logic (`attachment-uploader.ts`) retries a doomed re-encode on every sync tick indefinitely if the server rejects it for a reason other than size (no backoff, no max-attempt count, no permanent-failure surface to the user).
- [x] [Review][Defer] `classifyUploadResponse` treats `ATTACHMENT_CONFLICT` as unconditionally "stored" based on a comment's assumption ("typically an earlier re-encode") rather than a verified invariant — astronomically unlikely (a `crypto.randomUUID()` collision) but unverified.
- [x] [Review][Defer] `DamageCases`'s per-`${reportId}:${action}` idempotency key (`damage-cases.tsx`) is reused across a retry even if the form body changed between attempts (e.g. the user corrects `confirmed_quantity` after a failed submit) — needs a decision on whether the key should bind to the body, not just the slot.
- [x] [Review][Defer] `InspectionCard`'s client-side quantity check uses `Number()` comparison, not the decimal-string comparison the server (and this diff's own stated philosophy) uses elsewhere — the server is authoritative and re-validates, so this is a client-side precision nit, not a correctness gap.
- [x] [Review][Defer] `groupWorkbench` (`damage-case-view.ts`) has no `default` case on `report.status`; an unrecognized status silently drops out of every primary bucket (defensive - requires a backend contract violation to trigger).
- [x] [Review][Defer] `WORKBENCH_LIMIT = 200` (`damage-cases.tsx`) truncates with no "there are more" indicator, unlike `my-requests.tsx`'s fetch-limit+1 pattern — same pilot-scale acceptance as the backend's "2,000 recent cases" workbench scan deferred earlier in this file.
- [x] [Review][Defer] `CasePhoto`'s object-URL cleanup (`damage-cases.tsx`) has a narrow unmount-timing race that can leak one `URL.createObjectURL` handle — low-likelihood, low-impact (one leaked blob URL per occurrence, not unbounded).
- [x] [Review][Defer] `DamageCases.loadList`'s error handling collapses any non-403 failure (a genuine 500/422) into "needs-connection," which can misdirect troubleshooting for a real backend error as if it were a connectivity issue.
- [x] [Review][Defer] `missingDamageParts`'s focus target always lands on `damage-reason-DEAD_ON_ARRIVAL` regardless of context — a minor, non-adaptive a11y nit in otherwise careful focus-management code.

### Review Findings (chunk 5 of 5: deploy/docs/misc)

Code review 2026-09-28, deploy/docs/misc chunk (deploy/compose/init-db.sql's damage_report mirror - already covered by chunk 2's schema-drift-verified fix, not re-reviewed here; deploy/provision/staging-doa-bands.sh; deploy/rehearsal/mock/{generate.mjs,operations-smoke.ts,ops-lib.ts,rehearse.ts}; docs/migration/pilot-cutover-runbook.md; docs/migration/pilot-mock-extract/{roles.json,world.json}). 1 of 5 chunks remains as its own review pass: tests. Test files touched incidentally by earlier chunks' fixes (schema-drift, damage-case-view.test.ts, story-8-9.test.ts, story-1-9.test.ts) were kept green but not adversarially reviewed as a body of test code in their own right. 0 decisions, 3 patches applied (all in the rehearsal smoke script, not production code), 6 deferred, 5 dismissed. The Acceptance Auditor cross-checked Task 12 (pilot pack, DOA bands, access matrix) and Task 13.4 (runbook row 2.10g) against the live repo, not just the diff, and confirmed both genuinely done - the one real gap was narrower: Task 13.3's "guard every missing actor, SKU or band with a named SKIP line" covered actors and SKU but not a missing DOA band.

- [x] [Review][Patch] `damageReport()`'s pre-flight only checked for missing actors and missing SKU stock, not a missing DOA band, contradicting Task 13.3's explicit requirement. A missing `damage.qc_concurrence`/`damage.finance_concurrence`/`damage.escalation` band would have surfaced as a generic FAIL (409 `APPROVAL_UNRESOLVED` propagated by `approveAs`/`must`) plus cascading SKIPs, not the required named SKIP. Fixed: added a pre-flight probe of all three bands via `POST /api/v1/doa/resolve` (read-only, Task 4 of Story 2.5) before entering the flow, alongside the existing actor/SKU checks. [deploy/rehearsal/mock/operations-smoke.ts]
- [x] [Review][Patch] `damageBin()` only checked that stock existed at a non-quarantine bin, not that it covered both of `damageReport()`'s two sequential 1-unit reports (main flow, then escalation flow) - the second report could silently fall back to `record_only` on low stock with nothing catching it. Fixed: require `>= 2` units at the chosen bin. [deploy/rehearsal/mock/operations-smoke.ts]
- [x] [Review][Patch] The escalation flow's `report()` call skipped the `hold_mode` assertion the main flow applies to itself, so a wrongly-`record_only` second case could proceed through inspection and key turns unnoticed. Fixed: added the same check (the `photo_status` check is deliberately not mirrored here - the escalation flow's photo id is never uploaded, by design; see the deferred item below). [deploy/rehearsal/mock/operations-smoke.ts]

- [x] [Review][Defer] The escalation flow's second case references a photo attachment id that's generated but never uploaded via `PUT /api/v1/attachments/:id` - allowed by the schema (the Story 1.8 offline-pending pattern), but the smoke script never documents this as deliberate, so it reads as an oversight. Worth a comment, not a fix.
- [x] [Review][Defer] Repeated staging runs of `damageReport()` permanently consume 2 units of `BRG-6204` per run with no reclaim path (both cases close as write-offs) - documented as intentional ("Records are permanent") but the operational consequence (eventual stock exhaustion silently turning future PASS runs into SKIP) isn't flagged anywhere.
- [x] [Review][Defer] `deploy/provision/staging-doa-bands.sh`'s new comment for the three damage bands is a garbled run-on sentence - cosmetic, one-line fix, not urgent.
- [x] [Review][Defer] Runbook row `2.10g` packs five distinct actions (Keycloak account, role re-apply, DOA script, smoke run, six-persona browser walkthrough) into one evidence cell with no intermediate checkpoint - a process gap for resuming a partially-failed row under deployment pressure.
- [x] [Review][Defer] `operations-smoke.ts`'s `report_id`/QC-key-turn steps don't assert the response shape before building follow-up URLs or reporting PASS - script robustness, not correctness of the product.
- [x] [Review][Defer] `ops-lib.ts`/`rehearse.ts`'s remote-request helpers weren't confirmed to handle a raw Buffer photo-upload body with the same Content-Type override care the local-request path shows - unverified, not confirmed wrong.

## Dev Notes

A damage case is a new aggregate on a new `damage` stream. It opens two ways: a report by anyone from the edge (base hat), or a DAMAGED or REJECTED line at receipt. Reported units are held by booking them into the site quarantine zone plus a quantity guard on the way out of quarantine, because every existing hold is lot-wide and the UX ruling is that a report holds only the reported units. Physical custody (arrived, out for an external check, returned) is tracked on the case without moving the ledger. QC inspects, the QC and finance keys decide (the CEO on disagreement), and finance records the ERP document number. Every role works the case in the edge app.

### Binding decisions

- **D1 The case is the report.** One `damage_report` row per case, one `DMG-YYYY-NNNN` number, stream `damage`, `stream_id = report_id`; inspection, custody, whole-lot decision, keys, escalation and outcome are events on that stream, so one stream is the whole audit trail. The mocks disagree on the prefix (`DC-2026-0042` in key-qc, `DMG-2026-0027` in key-approvals); `DMG` wins because the desk audit row and approvals mock use it. A receipt case has no `damage.reported` event; its row is derived from `goods.received` (`source_event_id`), and its later events start the `damage` stream.
- **D2 New stream, not `qc`.** `test/unit/quality-event-registry.test.ts` pins every `qc`-stream type into `QUALITY_EVENT_TYPES`, makes the whole family minus `qc.result_recorded` central-only, and pins the edge QC allow-list to that one event; an edge-reportable event on `qc` breaks three invariants. The only `qc` event this story emits is the governed `qc.hold_placed` of a whole-lot decision, through the existing Story 8.5 applier.
- **D3 Reporting is a base-hat act.** Capture gates on `EMPLOYEE_MODULE` (online) and on `[EMPLOYEE_MODULE, 'damage']` through `resolveModuleFromBody` (edge); no one holds a `damage` module, so the audit role of a report is always `employee` and the person is `user_id`. EXPERIENCE.md L28 puts report damage in the base hat; L61 "Reporters observe; they never give a verdict". Service accounts hold no base hat and cannot report (1.15 D8).
- **D4 Book into quarantine at report time (AC 10).** For owned, non-serial stock found at a non-quarantine bin that covers the quantity, the report relocates the units to `ZONE-QC-HOLD` in the same transaction (the Story 3.11 posting precedent, `receiving.ts:1105-1107`), and the case starts `awaiting_arrival` until someone marks the physical arrival. Everything else is `record_only` with a `hold_note` and never refused: in use, serial-controlled, not owned, already in quarantine, or the bin cannot cover the quantity (an offline replay after stock moved). The inspection and stores notifications name the source bin so the units are collected.
- **D5 The hold is a quantity guard on leaving quarantine.** Relocation alone does not stop an issue from a quarantine bin (`applyStockIssue` does not exclude quarantine; only picks, cross-dock and availability do). One guard inside `applyStockIssue`, active only when stock leaves a quarantine location for a non-quarantine one, keeps the sum of held quantities of open cases at that location from being drawn down: `heldQuantity` is the reported quantity before inspection, the confirmed quantity after, and 0 once the case is `cleared` or closed as `accept_as_is_price_reduction`. Debit note, return and write-off units stay held until a later story disposes of them. Putaway release, picks, issues and bin moves all go through `applyStockIssue`, so one check covers them, and the lot-wide Story 8.5 hold is untouched.
- **D6 Custody marks do not move the ledger (AC 10).** "Arrived in QC hold", "sent for external check" and "returned" record where the units physically are. The units stay on the books in `ZONE-QC-HOLD` while out (still ours and still held); an off-site trip carries `gate_pass_ref_ext` as a paper returnable gate pass until Epic 20 (AD-13, the same paper rule EXPERIENCE.md L153 sets for returns). An `in_use` report marked arrived becomes `in_qc_hold` without a stock posting (issued material is outside the ledger; bringing it back to stock is a material return, out of scope). The outcome cannot be recorded, and a receipt putaway cannot be released, while units are out.
- **D7 Authority comes from the DOA registry, fail-closed.** Transaction types `damage.qc_concurrence`, `damage.finance_concurrence`, `damage.escalation`. `resolveDamageAuthority(type, value, client)` wraps the `resolveApprover` ladder (`src/api/v1/indents.ts:70-110`) but treats "no entry" as 409 `APPROVAL_UNRESOLVED` (the indent resolver returns `requiresApproval: false` there, which would fail open). The actor must be the resolved approver or their active delegate, else 403 `APPROVAL_REQUIRED` (8.1 wording). `value` is `confirmed_quantity x item_master.standard_cost_amount` when a standard cost exists, else 0, stored as `case_value`; pilot bands are unbounded and the real value is passed so bands can be tiered later (4.3 lesson). No role name in workflow code (AD-3, lint `doa/no-hardcoded-role-in-workflow`); key and escalation notification targets are `entry.role` of the matching DOA entry.
- **D8 The ad-hoc QC task is the case.** `qc_inspection_task` is one per lot, plan-bound and gate-bound (`UNIQUE (lot_id)`, plan NOT NULL, `source_completion_type` CHECK); reusing it would loosen three constraints the QC gate relies on. The QC task is the case in the workbench group "Damage reported - to inspect" plus the notification, the shape Story 3.4 uses at receipt.
- **D9 Decision routes gate on `DAMAGE_DECISION_MODULES = ['qc', 'compliance', EMPLOYEE_MODULE]` write.** Authority is D7; the list only decides which hat stamps `metadata.actor.role` (1.15 D9 partition puts specialists first): the QC head is stamped `qc_head` through `qc`, the finance controller `finance_controller` through `compliance` (their pack grant), and the CEO through the `employee`-module row. The CEO holds two rows on that module (`ceo` and `employee`); the partition must pick the `ceo` row so the audit reads `ceo` (the integration test pins it). If the partition as written picks by module only, prefer the non-`employee` role within the `employee` module, and record the rule as an amendment to 1.15 D9.
- **D10 Separation.** The reporter cannot turn a key, decide the whole lot or decide the escalation on their own case; the two keys are two different users; the escalation decider is neither key holder. All 403 `SOD_VIOLATION`. Rationale: SOD-01 applied to a two-key case; EXPERIENCE.md L148 and key-approvals L623 "no single-person band applies". For a receipt case the receiving actor is the reporter.
- **D11 Visibility and actions come from the server.** `view=mine`: own cases at any site. `view=workbench`: cases at sites where the caller holds `qc` or `warehouse`, plus cases where the caller is the resolved authority of a pending step; a caller with neither gets 403 `FUNCTION_ACCESS_DENIED`, never a silent empty list (1.15 D6). Detail and attachment GET: the reporter or uploader, a `qc` or `warehouse` holder at the site, or a resolved authority of any damage type; else 403 `FUNCTION_ACCESS_DENIED`. The detail's `allowed_actions` is computed by the same functions the POST routes use, so the screen never offers an action the API would refuse (1.14 pattern: the edge never decides authorization).
- **D12 Key semantics.** A key turn names one outcome from Table 6; either key can go first; the second must name the same outcome, else 409 `DAMAGE_OUTCOME_MISMATCH`: disagreement is explicit (`/disagree`, reason required, own proposed outcome) and moves the case to `escalated`. A key can be withdrawn with a reason by its holder until both keys have turned (EXPERIENCE.md L171 and Q8 override the key-approvals assumption at L409). After both keys, or after escalation, the case is locked; a correction is a new case (append-only, out of scope). The CEO decision is final.
- **D13 ERP reference recorded, not transmitted; four outcomes.** Outbound ERP is limited to BOM structure (ARCHITECTURE-SPINE.md L66); finance executes in ERP and records the document number (`erp_document_ref_ext`, the `_ext` convention and the `dispatch.irn_recorded` precedent in `src/compliance/dispatch.ts:792-831`). The Story 4.5 debit-note route is not reused (it lifts a blocked three-way match, else `MATCH_NOT_BLOCKED`). Four outcomes: key-approvals L498 and key-requisitions L804 list three, but EXPERIENCE.md L153, Q5, the PRD addendum and the AC list four, and the spine wins over mocks (EXPERIENCE.md L15).
- **D14 Photo store with no application cap (AC 7).** The photo is required (AC 1, EXPERIENCE.md L87; the mock's "optional" loses to the spine). The case carries only `photo_attachment_id`; the bytes are a separate idempotent upload with a client-minted id, so an offline report never waits on or fails with its photo, and photos never ride the PowerSync site bucket. Bytes are stored as taken, sent as the raw request body (no base64 inflation), with no photo-specific limit. The one ceiling left is the platform's existing 10 MB per request (`src/middleware/body.ts:4`, nginx `client_max_body_size 10m` in `deploy/compose/nginx.conf.template:60`), which applies to every request and is not changed here; the edge re-encodes only a photo that would exceed it.
- **D15 Replacement is two events with cross-referenced ids.** The edge mints `indent_id` and `report_id` together; the damage event carries `replacement_indent_id`, the indent event `damage_report_id`; the indent applier validates the pairing so a forged link is refused. DOA, SOD-01, duplicate check and numbering of the indent are unchanged ("normal approval rules"); standing approvals apply automatically once Story 4.8 lands.
- **D16 A dedicated CEO role and account (AC 6).** Role `ceo`, held by a new pilot person `ceo1@ancorlabs.org` on the `employee` module at the site (no specialist module is needed: the CEO acts only through DOA), plus the base hat. No existing person is reused, so the escalation decider can never collide with a key holder in the pilot pack.

### Evidence

Table 1 traces each decision to its source.

Table 1: Decision evidence

| Decision | Evidence |
|---|---|
| D1 | EXPERIENCE.md L88; `mockups/key-desk.html` L610; `mockups/key-approvals.html` L474-476; `mockups/key-qc.html` L654 |
| D2 | `test/unit/quality-event-registry.test.ts`; `src/sync/upload.ts:320-334`; `src/compliance/quality.ts:204, 376, 416` |
| D3 | EXPERIENCE.md L28, L61; `src/middleware/rbac.ts:137-145`; `src/api/v1/edge.ts:95-125, 335-346`; 1.15 D8, D9 |
| D4 | `src/compliance/receiving.ts:88, 1103-1153`; `src/compliance/bin-move.ts`; EXPERIENCE.md L101, L149; owner ruling AC 10 |
| D5 | `src/compliance/stock-balance.ts:64-67`; `src/read/projections/stock_balance.ts:435`; `pick.ts:554`, `cross-dock.ts:235`, `stock_balance.ts:205` (the only quarantine exclusions today) |
| D6 | owner ruling AC 10; ARCHITECTURE-SPINE.md AD-13; EXPERIENCE.md L153 |
| D7 | `src/api/v1/indents.ts:70-110`; `src/compliance/quality.ts:1499-1540`; `src/read/projections/doa_registry.ts:179-320`; ARCHITECTURE-SPINE.md AD-3; epics.md Story 8.9 AC 3 |
| D8 | `read/projections/qc_inspection_task.sql:39-71`; 3.4 story L29; `.memlog.md` L52-53 |
| D9 | `docs/migration/pilot-mock-extract/roles.json` (qc_head `qc` write, finance_controller `compliance` write); 1.15 D9 |
| D10 | access matrix SOD-01 (L266); EXPERIENCE.md L148; `mockups/key-approvals.html` L623 |
| D11 | 1.14 story (server-gated navigation and actions); 1.15 D6 |
| D12 | EXPERIENCE.md L88, L148, L171; Q8 (L251); `mockups/key-approvals.html` L680, L756-764; `mockups/key-qc.html` L672-676 |
| D13 | ARCHITECTURE-SPINE.md L66, AD-11; `src/compliance/dispatch.ts:792-831`; 4.5 story L39, L63; EXPERIENCE.md L15, L153; Q5 (L248); PRD addendum L46-51 |
| D14 | owner ruling AC 7; EXPERIENCE.md L15, L87; deferred-work L1160; `src/middleware/body.ts:4`; `deploy/compose/nginx.conf.template:60` |
| D15 | `read/projections/indent.sql:17-45`; `src/compliance/indent.ts:135-394`; EXPERIENCE.md L150; `mockups/key-requisitions.html` L779 |
| D16 | owner ruling AC 6; access matrix (no CEO role); `docs/migration/pilot-mock-extract/world.json` people |

### Events and state

Table 2 lists the events. All carry `report_id`; only `damage.reported` may come through the edge door.

Table 2: Damage events (stream `damage`)

| Event | Payload beyond `report_id` | Who |
|---|---|---|
| `damage.reported` | `site_id`, `reporter_user_id` (server-stamped), `sku`, `lot_number` or null, `quantity` (decimal string), `found_at` (`stock` or `in_use`), `bin_code` (required for `stock`), `reason_code`, `reason_note` or null, `photo_attachment_id`, `whole_lot_requested`, `replacement_indent_id` or null | base hat, edge or online |
| `damage.units_arrived` | `note` or null | `warehouse` or `qc` write at site |
| `damage.sent_for_external_check` | `destination`, `reason`, `expected_return_date` or null, `gate_pass_ref_ext` or null | `warehouse` or `qc` write at site |
| `damage.returned_from_external_check` | `note` or null, `external_result_ref_ext` or null | `warehouse` or `qc` write at site |
| `damage.inspected` | `confirmed_quantity`, `defect_code` or null, `note` or null | `qc` write at site |
| `damage.whole_lot_decided` | `decision` (`hold_lot` or `keep_local`), `reason`, `hold_id` or null, `lot_already_held` | DOA `damage.qc_concurrence` |
| `damage.key_turned` | `key` (`qc` or `finance`), `outcome`, `price_reduction_pct` or null, `note` or null, `doa_entry_id` | DOA per key |
| `damage.key_withdrawn` | `key`, `reason` | the key's holder |
| `damage.disagreed` | `key`, `proposed_outcome`, `price_reduction_pct` or null, `reason`, `doa_entry_id` | DOA per key |
| `damage.escalation_decided` | `outcome`, `price_reduction_pct` or null, `reason`, `doa_entry_id` | DOA `damage.escalation` |
| `damage.outcome_recorded` | `erp_document_ref_ext`, `note` or null | DOA `damage.finance_concurrence` |

Table 3 fixes the case status machine. A decision action outside its listed status is 409 `DAMAGE_CASE_STATE_INVALID`; key actions after the lock are 409 `DAMAGE_CASE_LOCKED`.

Table 3: Case status

| Status | Entered by | Decision actions allowed |
|---|---|---|
| `on_hold` | report or receipt | inspect; whole-lot decision if requested and pending |
| `cleared` | inspection with `confirmed_quantity` 0 | whole-lot decision if pending (terminal otherwise) |
| `awaiting_keys` | inspection above 0 | turn, withdraw (own key), disagree (other key turned); whole-lot decision if pending |
| `escalated` | disagree | escalation decide |
| `outcome_final` | second matching key, or escalation decide | outcome recorded (units not out) |
| `closed` | outcome recorded | none |

Table 4 fixes the physical custody machine; it runs beside Table 3 and is independent of it except where a rule says so.

Table 4: Physical state

| State | Set when | Next |
|---|---|---|
| `awaiting_arrival` | report booked into quarantine (D4) | mark arrived |
| `in_qc_hold` | marked arrived; receipt case at creation; marked returned | send for external check (not once `closed`) |
| `at_external_check` | sent for external check | mark returned |
| `with_reporter` | `record_only`, `in_use` | mark arrived (no stock posting) |
| `not_held` | `record_only` for any stock reason | mark arrived (no stock posting) |

Table 5 fixes the reason catalogue (copy from `mockups/key-requisitions.html` L502).

Table 5: Damage reason codes

| Code | Label | Rule |
|---|---|---|
| `DEAD_ON_ARRIVAL` | Dead on arrival - electronic | Never worked when fitted |
| `DAMAGED_COMPONENT` | Damaged component | Broken, bent, cracked, leaking |
| `WRONG_ITEM_OR_SPEC` | Wrong item or spec | Not what was asked for |
| `OTHER` | Other | `reason_note` required, one line, at most 200 characters; a note on any other code is refused (3.11 review lesson) |

Table 6 fixes the outcomes.

Table 6: Commercial outcomes

| Code | Label | Extra field | Units after close |
|---|---|---|---|
| `debit_note` | Debit note to supplier | none | stay held |
| `return_for_replacement` | Return to supplier for replacement | none | stay held until returned on paper |
| `write_off` | Write-off | none | stay held |
| `accept_as_is_price_reduction` | Accept as-is with price reduction | `price_reduction_pct` above 0, at most 100 | released |

Table 7 lists the new error codes. Edge marks codes that `damage.reported`, a linked `indent.raised`, or any stock event leaving quarantine can raise on the edge door; those go into both permanent-code sets and `en.json`.

Table 7: New error codes

| Code | HTTP | Edge |
|---|---|---|
| `DAMAGE_REASON_INVALID` | 400 | yes |
| `DAMAGE_OTHER_NOTE_REQUIRED` | 400 | yes |
| `DAMAGE_PHOTO_REQUIRED` | 400 | yes |
| `DAMAGE_QUANTITY_INVALID` | 400 | yes |
| `DAMAGE_LOT_REQUIRED` | 400 | yes |
| `DAMAGE_LOT_NOT_FOUND` | 404 | yes |
| `DAMAGE_LOCATION_NOT_FOUND` | 404 | yes |
| `DAMAGE_REPLACEMENT_LINK_INVALID` | 409 | yes |
| `DAMAGE_UNITS_HELD` | 409 | yes |
| `DAMAGE_CASE_BLOCKS_RELEASE` | 409 | yes |
| `DAMAGE_REPORT_NOT_FOUND` | 404 | no |
| `DAMAGE_CASE_STATE_INVALID` | 409 | no |
| `DAMAGE_CASE_LOCKED` | 409 | no |
| `DAMAGE_PHYSICAL_STATE_INVALID` | 409 | no |
| `DAMAGE_UNITS_OUT` | 409 | no |
| `DAMAGE_OUTCOME_INVALID` | 400 | no |
| `DAMAGE_OUTCOME_MISMATCH` | 409 | no |
| `DAMAGE_KEY_ALREADY_TURNED` | 409 | no |
| `DAMAGE_KEY_NOT_TURNED` | 409 | no |
| `DAMAGE_WHOLE_LOT_NOT_PENDING` | 409 | no |
| `ATTACHMENT_TYPE_INVALID` | 415 | no |
| `ATTACHMENT_CONFLICT` | 409 | no |
| `ATTACHMENT_NOT_FOUND` | 404 | no |

Reused: `ITEM_NOT_FOUND`, `SOD_VIOLATION`, `APPROVAL_REQUIRED`, `APPROVAL_UNRESOLVED`, `DUPLICATE_EVENT`, `CENTRAL_ONLY_OPERATION`, `PAYLOAD_TOO_LARGE`, the three 403 RBAC codes, `FUNCTION_ACCESS_DENIED`, and the Story 8.5 defect-code error. Envelope `{ error_code, message, details, trace_id }`.

Table 8 fixes who is told what. Targets are a config role or the role of the matching DOA entry, never a literal in workflow code.

Table 8: Notifications and role targets

| Trigger | Target | `next_step` |
|---|---|---|
| reported | `config.quality.inspectionTaskNotificationRole` at site (pilot `qc_inspector`, `qc1@`) | Inspect reported units, with the source bin or "in use" |
| reported and booked into quarantine | `DAMAGE_STORES_NOTIFICATION_ROLE` at site (pilot `store_assistant`, `store1@`) | Bring units from the bin to QC hold, mark arrived |
| reported with whole lot | role of DOA entry `damage.qc_concurrence` (pilot `qc_head`) | Decide whole-lot hold |
| inspected, confirmed | roles of `damage.qc_concurrence` and `damage.finance_concurrence` | Turn your key |
| first key turned | role of the other key's entry | Concur or disagree |
| disagreed | role of `damage.escalation` (pilot `ceo`, `ceo1@`) | Decide the outcome |
| outcome final | role of `damage.finance_concurrence`; reporter (`user_id`) | Record the ERP reference; outcome for the reporter |
| cleared, or closed | reporter; stores role | Move released units back, or keep held units in quarantine |
| external check overdue (`expected_return_date` passed, not returned) | stores role and the QC inspection role | Chase the external check. Reuse an existing scheduled sweep if one exists; otherwise the workbench lists overdue cases first and the sweep is deferred |

Table 9 fixes the projection. A second table `damage_report_action` (append-only: `report_id`, `action`, `actor_user_id`, `at`, `detail` JSONB, `source_event_id` UNIQUE) backs the case history.

Table 9: `damage_report` columns

| Column | Notes |
|---|---|
| `report_id` UUID PK, `report_number` UNIQUE, `site_id`, `reporter_user_id`, `reported_at`, `source_event_id` | header |
| `source` (`report` or `receipt`), `source_grn_line_id` UNIQUE where not null, `source_reason_code`, `source_photo_ref` | receipt cases; CHECK `source = 'receipt'` iff `source_grn_line_id` not null |
| `sku`, `lot_number`, `quantity` NUMERIC(18,6), `uom`, `found_at`, `bin_location_id`, `bin_code` | what and where |
| `reason_code`, `reason_note`, `photo_attachment_id` | CHECK `source = 'report'` iff `photo_attachment_id` not null |
| `hold_mode` (`quarantined` or `record_only`), `hold_note` (`in_use`, `insufficient_stock_at_bin`, `serial_controlled`, `not_owned_stock`, `already_quarantined`, or null), `quarantine_location_id` | CHECK `quarantined` iff `quarantine_location_id` not null and `hold_note` null |
| `physical_state` (Table 4), `arrived_by`, `arrived_at`, `external_destination`, `external_sent_by`, `external_sent_at`, `external_expected_return_date`, `external_gate_pass_ref_ext`, `external_returned_at`, `external_result_ref_ext` | custody (D6) |
| `whole_lot_requested`, `whole_lot_decision`, `whole_lot_hold_id`, `whole_lot_decided_by`, `whole_lot_decided_at` | Story 8.5 hold link |
| `status` (Table 3), `confirmed_quantity`, `defect_code`, `inspected_by`, `inspected_at`, `case_value` | inspection |
| `qc_key_status`, `qc_key_user_id`, `qc_key_outcome`, `qc_key_price_reduction_pct`, `qc_key_at`; the same five for `finance_key_` | `*_status` in `pending`, `turned`, `disagreed` |
| `final_outcome`, `final_price_reduction_pct`, `decided_by` (`concurrence` or `escalation`), `escalation_user_id`, `decided_at` | D12 |
| `erp_document_ref_ext`, `outcome_recorded_by`, `outcome_recorded_at` | D13 |
| `replacement_indent_id` | D15 |

Table 10 fixes the attachment store.

Table 10: `attachment` columns

| Column | Notes |
|---|---|
| `attachment_id` UUID PK | client-minted |
| `content_type`, `byte_size`, `sha256`, `data` BYTEA | no size CHECK (D14) |
| `uploaded_by`, `uploaded_at`, `source_event_id` | edit-log link |

### Screens

Table 11 fixes the workbench groups and the action names `allowed_actions` may carry; Table 14 describes the panel for each name.

Table 11: Damage cases workbench

| Group (in order) | Cases | Typical viewer |
|---|---|---|
| Damage reported - to inspect | `on_hold` | QC inspector, QC head |
| Whole-lot hold requested | `whole_lot_requested` and no decision | QC head |
| Awaiting your key | `awaiting_keys` with the caller's key pending | QC head, finance |
| Sent on - finance or CEO | `awaiting_keys` with the caller's key turned, or `escalated` | QC head, finance |
| With the CEO - decide | `escalated` | CEO |
| Final - record ERP reference | `outcome_final` | finance |
| Units to move | `awaiting_arrival`, `at_external_check` (overdue first), and `cleared` or closed cases whose released units are still in quarantine | stores, QC inspector |
| Closed (last 30 days) | `closed`, `cleared` | all workbench viewers |

Action names: `inspect`, `decide_whole_lot`, `mark_arrived`, `send_external`, `mark_returned`, `turn_qc_key`, `withdraw_qc_key`, `disagree_qc`, `turn_finance_key`, `withdraw_finance_key`, `disagree_finance`, `decide_escalation`, `record_outcome`.

### Current state of the files this story changes

Table 12 records what each touched file does today and what must survive.

Table 12: Files being modified

| File | Today | This story changes | Must be preserved |
|---|---|---|---|
| `src/middleware/rbac.ts` | `EMPLOYEE_MODULE`, `EMPLOYEE_EDGE_EVENTS` (indent only; comment "Story 8.9 appends damage capture here"), any-of modules with the D9 partition | one pair appended; role preference within the `employee` module if D9 needs it | partition order between modules; three 403 codes |
| `src/middleware/body.ts` | `readJsonBody`, 10 MB | `readRawBody` beside it | `readJsonBody` and the limit |
| `src/api/v1/edge.ts` | events door with central-only refusals and allow-lists (455-540); `indent.raised` stamping (707-729); `NAVIGATION_CAPABILITIES` (354-365) | damage allow-list; reporter stamping; nav rows 7 and 8 | every other stream rule; operating-site selection; table order |
| `src/sync/upload.ts`, `edge/src/sync/connector.ts` | permanent codes and mirror; `assertEdgeQcEventAllowed` | new codes; `assertEdgeDamageEventAllowed` | parity; `uploadData` flow |
| `src/read/projections/stock_balance.ts` | `applyStockIssue` (435) raises `INSUFFICIENT_STOCK`; no quarantine filter | the D5 guard when leaving quarantine | every existing path and code when no case applies |
| `src/compliance/receiving.ts` | `needsQcHold` to `ZONE-QC-HOLD` (1103-1153); putaway release applier (1458); private `QC_HOLD_ZONE_CODE` | receipt case insert; release check; export | receipt, quarantine and SHORT rules; notifications |
| `src/events/schema.ts`, `src/events/store.ts`, `src/events/migrate.ts`, `deploy/compose/init-db.sql` | registry, appliers, 23505 mapper, migrations ending `grn_line_condition.sql` | new types, applier wiring, three migrations | order and existing mappings |
| `src/compliance/indent.ts`, `src/api/v1/indents.ts`, `read/projections/indent.sql` | raise shape, apply, DOA, duplicate check | optional `damage_report_id` and its check | everything else byte-for-byte |
| `src/api/v1/quality.ts` | `placeQcHoldBase` builds and persists `qc.hold_placed` | envelope builder shared | route behaviour and codes |
| `src/config/index.ts` | quality config | one role setting | defaults |
| `src/server.ts`, `test/integration/story-1-9.test.ts` | routes; pinned route list | new routes | order rules |
| `test/integration/story-3-11.test.ts` | releases held DAMAGED putaways without a decision | release now needs the case decided | every other assertion |
| `test/integration/story-1-15.test.ts`, `test/unit/employee-base-role-pack.test.ts` | pin three base nav names; pin pack counts | `Report damage`, `Damage cases` where applicable; 22 people | everything else |
| edge `my-requests.tsx`, `navigation/nav-model.ts`, `app-shell.tsx`, `edge-client.tsx`, `en.json` | 1.15 screens, one `SECTIONS` entry, view union | second section, two views and routes, keys | no client-side authorization; `authorizedFetch`; `t()` for every string |
| `deploy/provision/staging-doa-bands.sh`, pilot pack, `generate.mjs` | four bands; 21 people, 74 grants | three bands; `ceo1@` | every existing id and grant |
| `deploy/rehearsal/mock/operations-smoke.ts`, runbook | flows through `employeeRequisition`; rows through 2.10f | two flows; row 2.10g | existing PASS names; row shape |

### Edge copy

Table 13 fixes the reporter screen; strings come from `mockups/key-requisitions.html` (L450-806), each through `t()` under `damage.*`.

Table 13: Report damage screen

| Part | Content |
|---|---|
| Nav and home | "Report damage" |
| Step 1 | "Which material?" SKU scan (required), lot scan (the error maps `DAMAGE_LOT_REQUIRED`), "Where is it?" `In stock at a bin` (bin scan) or `In use / issued to me` |
| Step 2 | "How many are affected?" quantity; "You report. You do not decide. Only the units you report go on hold; QC inspects them. QC and finance will decide the outcome." |
| Step 3 | "What is wrong?" four reasons (Table 5); one-line field for Other |
| Photo | "Take photo" (required), then "Photo saved" and "Retake" |
| Toggles | "Suspect whole lot - A request only. The QC head decides whether to hold all of the lot everywhere."; "Request replacement - Creates a linked requisition for the same item and quantity, needed today." (reveals department code, which the indent requires) |
| Footer | "Still needed: ..." listing missing parts, or "Ready to send"; button "Send damage report" |
| Done | "Reported - stock on hold, QC informed" online, "Captured - pending sync" offline; "QC and finance will decide - You do not need to do anything more."; whole-lot line when requested; replacement line when chosen; "Back to my requests", "Report another" |

Omitted from the mock: "or pick from material issued to me (last 7 days)" and "of N issued" (no issued-material read exists; deferred).

Table 14 fixes the workbench case panel; strings come from `mockups/key-qc.html` (L459, L649-691) and `mockups/key-approvals.html` (L680-764), each through `t()` under `damageCases.*`.

Table 14: Damage case panel

| Part | Content |
|---|---|
| Header | "{number} - {SKU} x {quantity}", lot, "Reported by {name}, {role}" (receipt cases: "Found at receipt, GRN line {n}"), reason, photo or "Photo not yet uploaded", replacement "{indent number} raised (same flow)" |
| Hold scope card | "Local - reported units only" or "Whole lot {lot} everywhere"; pill "Suspect whole lot - requested"; `decide_whole_lot`: "You decide lot-wide hold as QC head." with "Hold whole lot" and "Keep local" and a required reason |
| Custody card | "Booked in QC hold - awaiting arrival" (`mark_arrived`: "Mark arrived in QC hold"); "In QC hold" (`send_external`: destination, reason, expected return date, gate pass reference, "Send for external check"); "Out for external check at {destination} since {date} - awaiting return" (`mark_returned`: result reference, "Mark returned"); "With the reporter (in use)"; overdue shows "Return overdue since {date}" |
| Inspection card | `inspect`: "Confirmed damaged quantity" of N, defect code, note, "Record inspection"; result "Cleared - no damage" or "Damage confirmed: {n} of {N}" |
| Concurrence card | title "Concurrence - QC and finance either can go first"; rows "QC head" and "Finance controller", each pill Pending, Concurred or Disagrees with name, time and outcome; counter "{n} of 2 concurred"; escalation row "CEO: decides. QC and finance can no longer edit this case." |
| Key actions | outcome choice (Table 6) with price reduction % for accept as-is; "Concur: {outcome}"; "Disagree with {QC or finance} outcome", "Why do you disagree? (required)", "Disagree - escalate to CEO"; after turning: "You concurred, {when}. Waiting for {other}. The outcome locks when both concur." with "Withdraw my concurrence" (reason required); locked: "Both concurred - outcome locked. Stores and finance get their follow-up tasks."; escalated: "With the CEO - Nothing more for you until the CEO decides." |
| CEO action | `decide_escalation`: both positions side by side, outcome choice, reason, "Record CEO decision" |
| Finance close | `record_outcome`: "ERP document number", note, "Record and close"; closed: "Closed - ERP {ref}" |
| History | action rows newest first with who and when |
| Offline | "Approvals need a live connection" |

### Architecture compliance

- AD-1 and AD-16: offline capture through the outbox with `idempotency_key` and `metadata.device_id`; duplicates 409 `DUPLICATE_EVENT` with the existing id; the device shows "Captured - pending sync".
- AD-3: every decision authority through the DOA registry; no role literal in workflow code; notification targets from config or DOA entries.
- AD-12: every write passes `persistEvent` with `auditCtxFor`, the attachment upload included.
- AD-13: no outbound movement is recorded; the external check and a physical return use a paper returnable gate pass until Epic 20 (`gate_pass_ref_ext`).
- AD-14: reads come from `damage_report`, `damage_report_action`, `indent`, `attachment`, `users`; no cross-module stream reads. The receipt case is derived in the receiving applier from the receipt event, inside the same transaction.
- AD-15: the report-time relocation carries the report's site as asserted location, as the putaway and bin-move pair does.
- AD-17: decisions notify in the same transaction.
- AD-18: refused damage captures are recorded by the existing `withRefusedCaptureRecord` wrapper.

### Library and framework requirements

No new dependency. Photo capture is a file input with `capture`; pending photos use the browser's IndexedDB directly; scanning stays keyboard wedge. Node test runner, `tsx`, Postgres 18.4 test container on port 5442, Next.js edge with its own `tsc`, `eslint`, Playwright and axe. No web research was needed; no changed library surface is touched.

### Previous story intelligence

- Story 1.15: extension points `EMPLOYEE_EDGE_EVENTS` and `SECTIONS`; D9 partition; My requests fetches `limit+1`; availability counts only owned, non-quarantine, not-held stock, so the report-time relocation shows there at once; the pilot pack is hand-edited and mirrored in `generate.mjs`; operator task convention.
- Story 1.14: server-gated navigation and actions; review patches on focus return, sibling-button disabling, live regions only with a message, response shape validation before React keys, quiet refetch.
- Story 3.11: "store reports, QC decides"; units-only quarantine at `ZONE-QC-HOLD`; opaque photo key (this story adds the store); stray evidence fields refused; permanent codes in three places.
- Story 8.5: one open governed hold per lot; placement single-actor without DOA; release by a different person; reason-matched flag clearing.
- Story 8.3: re-check status under the row lock; two-way pairing CHECKs; one 23505 handler; `replayIdOrReject`; `compareDecimalStrings`; `AUDITED_REJECTIONS` in step.
- Story 3.12: route notifications only to roles someone holds at pilot, pinned by a unit test.
- Story 4.3: pass the real value to DOA; pin band boundaries; debounce submit.

### Git intelligence

HEAD `cf993ff` (docs only: the 1.15 story file). `4f5164c` is Story 3.12 (routing constant, `story-3-12.test.ts` helpers, `weighbridge-breach-routing.test.ts`, runbook 2.10e). Story 1.15 code is uncommitted (Task 0.1). Recent subjects are all `c`; read diffs.

### Testing standards

- Root: `npm test` (`--test-concurrency=1`); integration files boot `createAppServer(createAppRouter())` on port 0, provision through SCIM, mint tokens through `POST /api/v1/auth/dev-token`, re-run projection DDL and TRUNCATE in `before`.
- DOA: seed bands through the API in the test; resolve the real holder with `findRoleHolder` before asserting who may act.
- Assertions: exact values and negative controls; a 10-in-flight concurrency case for every `*_ALREADY_*` code; mutation-check the SOD, lock and D5 guards.
- Edge: `edge:test`, then Playwright `test/e2e` plus `test/accessibility` on one build; i18n allow-list before markup.
- Gates: `npx tsc --noEmit` (root and edge), `npm run lint`, `prettier --check --end-of-line auto`, `schema-drift`, migration run twice.

### Regression surface

`story-1-15` and the pack test (navigation and counts), `story-1-8`, `story-1-9` (route pin), `story-1-14`, `story-4-3`, `story-4-7`, `story-3-4`, `story-3-6` and the bin-move suites (the D5 guard sits in `applyStockIssue`), `story-3-11` (putaway release now gated), `story-8-5`, `story-8-3`, `story-11-2-edge-sweep`, `quality-event-registry`, `edge-permanent-error-parity`, `pilot-r6-held-lot-drains`, the pilot sim day, and the local operations smoke.

### Out of scope

- Disposing of held units after a debit note, return or write-off: the physical return and its gate pass (Epic 20, AD-13), write-off destruction and ITC reversal (FR-SC-20, Phase 2).
- Transmitting the outcome to ERP (D13).
- Returning issued (`in_use`) units to the stock ledger (material return).
- Partial release of unconfirmed units on a receipt putaway task (stores uses a bin move).
- "Pick from material issued to me" and "of N issued"; serial-level reporting; damaged job-work or customer material (deferred-work L1155).
- Correction of a locked case as a linked new case.
- A scheduled sweep for overdue external checks, if none exists to reuse (Table 8 last row).
- An employee-only reporter cannot see the central refusal of their own offline capture (deferred-work L1187); the device still shows "Needs attention" with the code.
- Standing approvals and self-approval limits (Story 4.8); `NOT_RESOLVED_APPROVER` fallback (Story 4.9).

### Project Structure Notes

- Server: `src/compliance/damage.ts`, `src/compliance/damage-reasons.ts`; routes in `src/api/v1/damage-reports.ts` and `src/api/v1/attachments.ts`; projection helpers `src/read/projections/damage_report.ts` and `attachment.ts`; SQL in `read/projections/`.
- Edge: `edge/src/capture/damage.ts`, `edge/src/local-db/pending-photos.ts`, `edge/src/sync/attachment-uploader.ts`, `edge/src/components/report-damage.tsx`, `edge/src/components/damage-cases.tsx`; pages `edge/app/damage/new/page.tsx` and `edge/app/damage/cases/page.tsx`.
- Variance: the access matrix, the DOA band script and the pilot pack are edited here because the matrix has no CEO role and no damage bands.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 8.9 (L2858-2886), #Epic 8 (L554-564, L2620), #Story 8.5, #Story 8.3, #Story 3.11, #Story 4.8]
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-09-26.md#4.1, #4.2]
- [Source: _bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/addendum.md L46-52; archive/prd.md FR-P-07 (L145), FR-Q-05, FR-Q-06, FR-Q-09 (L262-266)]
- [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md L66, AD-1, AD-3, AD-11 to AD-18, event envelope L291-306, error codes L346]
- [Source: _bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/EXPERIENCE.md L15, L28, L61-62, L87-88, L99-101, L144-153, L169-172, L192-199, L232-233, Q4, Q5, Q8, Q11; DESIGN.md L136-139, L306-308; .memlog.md L50-61, L71, L101, L104]
- [Source: ux-designs/.../mockups/key-requisitions.html L450-806; key-qc.html L427-691; key-approvals.html L409-764; key-stores.html L438-440, L768-782; key-desk.html L532, L610, L850]
- [Source: _bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md L32, L83-84, L98-99, L225, L252-256, L266-278, L312-320, L329]
- [Source: _bmad-output/implementation-artifacts/deferred-work.md L126, L184, L459-461, L516, L1155-1160, L1186-1187]
- [Source: _bmad-output/implementation-artifacts/1-15-employee-base-role.md; 1-14-refused-captures-supervisor-screen.md; 3-11-grn-line-condition-and-reason-codes.md; 8-5-quality-holds-and-recall-trace.md; 8-3-lot-disposition-accept-reject-conditional-release.md; 3-4-goods-receiving-against-asn-or-po-fr-w-02.md; 4-3-purchase-requisition-and-indent-loop.md; 4-5-goods-receipt-and-three-way-match.md]
- [Source: src/middleware/rbac.ts:137-145; src/middleware/body.ts:4-29; src/api/v1/edge.ts:95-125, 335-383, 450-540, 613, 707-744, 1035-1080; src/sync/upload.ts:18, 320-334, 439, 516; edge/src/sync/connector.ts:30, 295, 444-560]
- [Source: src/api/v1/quality.ts:182-216, 2299, 3214-3242; src/compliance/quality.ts:198-279, 1499-1540, 4926, 5116-5290; src/read/projections/qc_inspection_task.ts:342; read/projections/qc_quality_hold.sql]
- [Source: src/compliance/receiving.ts:88, 1103-1153, 1417-1427, 1458; src/api/v1/receiving.ts:321, 428, 574-661; src/compliance/bin-move.ts; src/compliance/stock-relocation.ts:34, 70; src/read/projections/stock_balance.ts:317-552; src/compliance/stock-balance.ts:64-73]
- [Source: src/api/v1/indents.ts:70-110, 151-277, 604-611; src/compliance/indent.ts:135-394; src/events/schema.ts:969-982, 5543, 5790; read/projections/indent.sql:17-45; read/projections/users.sql:7]
- [Source: src/notify/emit.ts:80, 124; src/read/projections/doa_registry.ts:179-320; src/config/index.ts:632-642, 819-822; src/compliance/dispatch.ts:792-831; deploy/compose/nginx.conf.template:60]
- [Source: edge/src/capture/indent.ts:28-74; edge/src/capture/outbox-event.ts; edge/src/components/my-requests.tsx:19-31, 88; edge/src/components/navigation/nav-model.ts:11-24; edge/src/components/app-shell.tsx:82-124, 253-274; edge/src/components/fault-report-capture.tsx:13-15, 64-72; edge/src/components/refused-captures-screen.tsx; edge/src/local-db/schema.ts; edge/test/fixtures/employee-base-stub.ts; edge/test/unit/i18n-literals.test.ts:6-54]
- [Source: test/integration/story-3-12.test.ts:41-116; test/unit/weighbridge-breach-routing.test.ts; test/unit/quality-event-registry.test.ts; test/integration/story-1-9.test.ts:171, 693]
- [Source: deploy/provision/staging-doa-bands.sh; docs/migration/pilot-cutover-runbook.md rows 2.9, 2.9a, 2.10f (L123, L129); docs/migration/pilot-mock-extract/roles.json, world.json]

## Dev Agent Record

### Agent Model Used

Claude Opus 5.5 (claude-opus-5-5), dev-story 2026-09-27; the edge half (Tasks 1.4, 9, 10, 11.1 edge part, 11.2) built by a delegated sub-agent against a fixed API contract and re-verified here.

### Debug Log References

- Baseline `2731fa5` (Story 1.15 committed; tree clean at start).
- Migrations run twice against the test DB (`node --env-file=.env.test --import tsx src/events/migrate.ts`): idempotent.
- Local smoke first failed twice for environment reasons, not code: (1) a leftover `ZONE-QC-HOLD` row from the integration suite belonged to another site (location codes are globally unique), so the smoke site had no QC hold area; (2) the weighbridge-breach leg runs one dispatch cycle of 50 and a backlog of undispatched notifications hid the breach notice. After renaming the stale row and draining the backlog: 54/54 PASS.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created (create-story, 2026-09-27).
- Server: new `damage` stream with eleven events plus `attachment.uploaded`; `src/compliance/damage.ts` holds every guard (pure state machines from Tables 3 and 4, separation of duties D10, fail-closed DOA authority D7, appliers, receipt-case opener, release gate, replacement-link check, server-computed `allowed_actions`); routes in `src/api/v1/damage-reports.ts` and `src/api/v1/attachments.ts` are thin shells. The events door refuses the `damage` and `attachment` streams raw; the edge door accepts only `damage.reported`.
- D4: the report relocates owned, non-serial units to the site's `ZONE-QC-HOLD` in its own transaction; everything else is recorded with a `hold_note`, never refused.
- D5: `assertDamageHeldQuantity` runs inside `applyStockIssue` after the drain and is a no-op unless an open quarantined case holds the SKU. It counts held units against the site's whole quarantine pool (every location at or beneath a quarantine flag), lot by lot where the case names a lot, so moving held units between quarantine bins keeps them held. Relocation callers (bin move, putaway) pass `relocation_target_location_id`. Task 4.2 path audit: issues, picks, putaway, bin moves, replenishment and cross-dock reach `applyStockIssue`; the plant-wide backflush (`applyStockIssueUnderSite`) did not, so it now calls the same guard for every location it drained; dispatch drains `picked` stock that picks never allocate from quarantine, and the QC lot split re-labels within one location - neither can move held units out.
- D9 amendment to 1.15 D9 (recorded here): `requireRole`'s partition now ranks a non-`employee` role on the `employee` module (the CEO's `ceo` row) above the base-hat row on the same module, so the CEO's decisions audit as `ceo` (pinned by the integration suite and the bootstrap role).
- Deviations: `hold_note` gained a sixth value `no_qc_hold_zone`; the defect-code refusal is the Story 8.5 code `DEFECT_CODE_UNKNOWN` at 422, not 400; the online raise route keeps a client `indent_id` only together with `damage_report_id` so a replacement indent can carry the id the report names; APPROVAL_REQUIRED details name `resolved_approver_user_id` (the indent precedent) so the rehearsal's `approveAs` works; the pilot pack and generator also gained the three damage bands in `operations.doa_entries` so the local smoke can run.
- Task 5.2: no Story 3.11 test released a held DAMAGED putaway, so no 3.11 assertion changed; `story-3-11` passes unchanged.
- Task 1.5 (red first): the routing test and all edge unit tests were confirmed red (missing export or module) before implementation. The rules and integration tests were written alongside the module and ran green on first run; their failure reasons were proven instead by mutation: dropping the case `FOR UPDATE`, the reporter separation check, or the D5 guard call each turned the matching integration tests red (4 failures), then restored.
- Gates: root `npm test` 2525/2525; focused set (Task 13.1) 485 tests green after updating the three Story 1.15 navigation pins; `npx tsc --noEmit` clean; `npm run lint` clean; prettier clean on every new file and on every touched file that was clean at baseline (`edge.ts`, `rbac.ts`, `store.ts` were unformatted at baseline and stay so); `schema-drift` extended and green; `provision:roles` dry run 22 people, 76 assignments, 0 segregation violations (not applied locally). Edge: `edge:typecheck`, `edge:lint` clean, `edge:test` 136/136, Playwright `test/e2e test/accessibility` 67/67 (the two `offline-shell` tests passed too).
- Local operations smoke: 54/54 PASS including eight `damage:` and four `damage escalation:` lines.
- Edge deviations (sub-agent, accepted): the replacement toggle also asks item category, UoM and business stream (the indent requires them and the device has no item master); a photo upload 409 is treated as stored (only this device knows the id); a 415 triggers one JPEG re-encode and HEIC that Chrome cannot re-encode stays queued; the list response names no viewer key, so "Awaiting your key" versus "Sent on" is judged by whether the viewer turned a key; the selected case is read from `window.location`; 13 `errors.*` texts added for workbench codes.
- Task 13.5 (staging run, operator task) is open: deploy per runbook 2.15, execute 2.10g, record PASS and date here.

### File List

New:
- `read/projections/damage_report.sql`
- `read/projections/attachment.sql`
- `read/projections/indent_damage_link.sql`
- `src/compliance/damage.ts`
- `src/compliance/damage-reasons.ts`
- `src/read/projections/damage_report.ts`
- `src/api/v1/damage-reports.ts`
- `src/api/v1/attachments.ts`
- `test/unit/damage-rules.test.ts`
- `test/unit/damage-routing.test.ts`
- `test/integration/story-8-9.test.ts`
- `edge/app/damage/new/page.tsx`
- `edge/app/damage/cases/page.tsx`
- `edge/src/capture/damage.ts`
- `edge/src/components/damage-case-view.ts`
- `edge/src/components/damage-cases.tsx`
- `edge/src/components/report-damage.tsx`
- `edge/src/local-db/pending-photos.ts`
- `edge/src/sync/attachment-uploader.ts`
- `edge/test/unit/damage-capture.test.ts`
- `edge/test/unit/damage-case-view.test.ts`
- `edge/test/fixtures/damage-stub.ts`
- `edge/test/e2e/report-damage.spec.ts`
- `edge/test/e2e/damage-cases.spec.ts`
- `edge/test/accessibility/damage-accessibility.spec.ts`

Modified:
- `src/events/schema.ts`, `src/events/store.ts`, `src/events/migrate.ts`, `deploy/compose/init-db.sql`
- `src/middleware/rbac.ts`, `src/middleware/body.ts`, `src/api/router.ts`, `src/server.ts`
- `src/api/v1/edge.ts`, `src/api/v1/events.ts`, `src/api/v1/indents.ts`, `src/api/v1/quality.ts`
- `src/sync/upload.ts`, `src/config/index.ts`
- `src/compliance/indent.ts`, `src/compliance/receiving.ts`, `src/compliance/quality.ts`, `src/compliance/bin-move.ts`, `src/compliance/putaway.ts`
- `src/read/projections/stock_balance.ts`, `src/read/projections/indent.ts`
- `test/unit/schema-drift.test.ts`, `test/unit/employee-base-role-pack.test.ts`, `test/integration/story-1-15.test.ts`, `test/integration/story-1-9.test.ts`
- `edge/app/globals.css`, `edge/src/capture/indent.ts`, `edge/src/components/app-shell.tsx`, `edge/src/components/edge-client.tsx`, `edge/src/components/my-requests.tsx`, `edge/src/components/navigation/nav-model.ts`, `edge/src/local-db/outbox.ts`, `edge/src/messages/en.json`, `edge/src/sync/connector.ts`
- `edge/test/fixtures/employee-base-stub.ts`, `edge/test/unit/i18n-literals.test.ts`, `edge/test/unit/nav-model.test.ts`
- `docs/migration/pilot-mock-extract/roles.json`, `docs/migration/pilot-mock-extract/world.json`, `deploy/rehearsal/mock/generate.mjs`
- `deploy/provision/staging-doa-bands.sh`
- `deploy/rehearsal/mock/operations-smoke.ts`, `deploy/rehearsal/mock/ops-lib.ts`, `deploy/rehearsal/mock/rehearse.ts`
- `docs/migration/pilot-cutover-runbook.md`
- `_bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md`
- `_bmad-output/implementation-artifacts/deferred-work.md`, `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `graphify-out/` (regenerated by `graphify update .`)

## Change Log

- 2026-09-27: Story created (create-story) with fifteen binding decisions and five open questions answered by defaults. Status ready-for-dev.
- 2026-09-27: Owner rulings on the five questions applied (ACs 6-10): dedicated `ceo` role and `ceo1@` pilot account; photo store with no application size cap (raw upload, originals kept); screens for every role (Damage cases workbench, Table 11 and Table 14); receipt DAMAGED and REJECTED lines open damage cases and gate putaway release (deferred-work L1157); book into quarantine at report time with custody marks for arrival, external check and return. Added D5 (quantity guard on leaving quarantine), D6 (custody without ledger moves), D16 (CEO account); D11 now server-computed `allowed_actions`. Status ready-for-dev.
- 2026-09-27: Implemented (dev-story): server damage case, stock guard, receipt cases, photo store, replacement link, CEO role and bands, edge report and workbench screens, smoke flows, runbook row 2.10g, access matrix v1.2. All tasks done except 13.5 (staging operator run). Status review.
