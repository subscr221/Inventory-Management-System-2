---
baseline_commit: 502b66473221ffbbc6ebbcf4ed868ed8f0040355
---
# Story 9.7: Offcut Holding, Disposal and Valuation

Status: review

Epic: 9 (Job Work and Subcontracting)
Story key: `9-7-offcut-holding-disposal-and-valuation`
Functional requirements: FR-JW-09/10, FR-JW-12, FR-JW-13, FR-JW-14, FR-AC-11
Baseline: `502b664` (the commit the implementation and the code-review passes diff against; front matter `baseline_commit`). The create-story baseline was branch `chore/9-6-reversal-and-noise-floor` at `c8520c2`; story 9.6 is implemented and its offcut half is REVERSED per `sprint-change-proposal-2026-09-05.md`.

## Story

As a finance controller,
I want retained offcut disposed of and valued when its fate is actually known, with the resulting buyback billed as a credit note against the service invoice,
so that customer offcut is never valued at a guessed rate and never sits unaccounted.

## Acceptance Criteria

1. **Given** offcut retained in the holding ledger (FR-JW-09/10) **when** the finance controller records a disposal **then** the disposition (`returned` or `acquired`) and, on `acquired`, the final rate are captured together, the final rate being the offcut contract's INDICATIVE rate adjusted for the offcut's physical condition as verified by the processor, the holding ledger row is closed, and the Section 143 clock for that quantity is stopped.
2. **Given** a disposal of `returned` (FR-JW-09/10) **when** it is executed **then** a return challan and dispatch documents are generated through the Story 3.7 flows.
3. **Given** a disposal of `acquired` (FR-JW-09/10) **when** it is executed **then** title transfers to the processor, a new owned lot is minted under a QC hold, and a credit note for the acquisition value is raised against the order's service invoice citing that invoice's ERP document reference; a contractual free retention is the same branch at a rate of zero, which mints the lot and raises no credit note.
4. **Given** a disposal of `acquired` whose negotiated rate differs from the offcut contract's indicative rate (FR-JW-09/10) **when** the disposal is posted **then** it is accepted and the negotiated rate is recorded as the commercial value, with the indicative rate stored beside it so the variance is visible on the credit note and the reports; no tolerance is applied and nothing is refused on rate.
5. **Given** a valued disposal (FR-JW-12) **when** the finance controller later revises the rate **then** a delta document is raised and the original is never mutated.
6. **Given** any offcut disposal (FR-JW-12) **when** the acknowledging actor is the finance controller who set the rate **then** the acknowledgment is refused with `error_code: "SOD_VIOLATION"`.
7. **Given** a disposal of `acquired` whose acquisition value falls in or above the governed DOA band (FR-JW-09/10) **when** it is posted without a resolved second signature from the `cfo` role **then** it is refused with `error_code: "APPROVAL_REQUIRED"` and audited, and with one it proceeds and records the approver on the disposal.
8. **Given** offcut still retained in the holding ledger (FR-AC-11, FR-JW-14) **when** the Story 9.5 breach sweep runs **then** retained offcut is read alongside the return clocks and ages against the same deemed-supply thresholds, whether or not its order has closed.
9. **Given** offcut held under the job contract with the customer (FR-JW-13, FR-JW-14) **when** the job-work ageing report is produced **then** offcut still governed by that contract appears on the report; once it is `acquired` and title has transferred it leaves the report and is carried as ordinary owned stock, because it is no longer customer material and no longer a job-work exposure.

## Tasks / Subtasks

- [x] **Task 0: operational prerequisite - the go-live check that both roles are held by two different people (AC 7). DONE 2026-09-06, ahead of the rest of the story.**
  - [x] 0.1 `src/cli/verify-segregated-roles-core.ts` declares `SEGREGATED_ROLE_PAIRS` (the `jobwork.offcut_acquisition` pair: setter `finance_controller`, approver `cfo`) and `verifySegregatedRoles(pool, pairs, today)`, which reports five violation codes: `ROLE_UNHELD`, `ROLES_SHARE_HOLDER`, `DOA_BAND_MISSING`, `DOA_TYPE_MULTI_ROLE` (the BSD-9 cross-role fallback hazard) and `DELEGATION_COLLAPSES_PAIR` (an active vacation delegation handing both halves back to one person, because `resolveApprover` substitutes the delegate).
  - [x] 0.2 `src/cli/verify-segregated-roles.ts` plus `npm run verify:roles`: read-only, exits 1 on any violation so a deployment pipeline can gate on it. Verified against the test database, where it currently reports `ROLE_UNHELD` for `cfo` and `DOA_BAND_MISSING` and exits 1.
  - [x] 0.3 `test/integration/segregated-roles.test.ts`, 7/7 green: the happy pair, both roles on one user, an inactive approver, no band, a second role banded on the same transaction type, and a delegation collapse that is clean outside its window. Role names and the transaction type are run-scoped so the suite cannot see or disturb real assignments.
  - [ ] 0.4 REMAINS OPERATIONAL and cannot be done from the repository: an administrator must provision a real `cfo` user through SCIM, grant `finance_controller` to a DIFFERENT real user, and register the `jobwork.offcut_acquisition` band for `cfo` through the Story 1.4 DOA registry API. Run `npm run verify:roles` against the target environment until it exits 0; until then every above-band acquisition refuses `APPROVAL_UNRESOLVED` and disposal refuses `FUNCTION_ACCESS_DENIED`, which is intended fail-closed behaviour, not a defect.
  - [x] 0.5 The integration suite for this story seeds its own two fixture users the same way; never the same user, never the acting coordinator.
  - [x] 0.6 Add both roles to `_bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md` rows only if the file still lacks them; do not restate rulings already recorded there.

- [x] **Task 1: close the offcut issue hole in the segregation bar (AC 1, AC 2, AC 3; PREREQUISITE, do first after Task 0)**
  - [x] 1.1 `src/compliance/stock-balance.ts:373-392`: the segregated-class issue/allocation bar keys on `stockClass === JOB_WORK_STOCK_CLASS` ONLY. `offcut` is in `SEGREGATED_STOCK_CLASSES` (so the laundering bar covers receipts) but is NOT barred from issue or allocation, so customer-owned retained offcut can today be picked into any sales dispatch. Widen the arm to `stockClass === JOB_WORK_STOCK_CLASS || stockClass === OFFCUT_STOCK_CLASS`.
  - [x] 1.2 Mint ONE new Symbol door, `CUSTODY_OFFCUT_DISPOSAL`, exported from `src/compliance/custody-ledger.ts` beside `CUSTODY_CONSUMPTION` (`:73`) and `CUSTODY_RETURN` (`:84`), with an `isCustodyOffcutDisposalHandoff` predicate matching the two existing ones. The `offcut` arm admits ONLY that Symbol; `CUSTODY_RETURN` must NOT open the offcut class (that door belongs to `job_work` material returning under a Rule 45 challan, a different physical fact).
  - [x] 1.3 DONE 2026-09-06, PULLED FORWARD out of this story and fixed on master rather than left
        live: `offcut` now carries the same TOTAL demand bar as `job_work` in
        `src/compliance/stock-balance.ts`, with NO Symbol door, because nothing in Story 9.6 issues
        offcut stock at all. The regression arm lives in `test/integration/story-9-6.test.ts` and is
        mutation-verified (removing `offcut` from `CUSTOMER_OWNED_STOCK_CLASSES` fails exactly that
        arm). THIS STORY MUST OPEN ITS OWN DOOR on that same Symbol mechanism for disposal - a
        classifier or a payload field would reopen the hole.
        Also fixed alongside it: `cycle-count.ts` picked the refusal CODE with a job_work-only test,
        so an `offcut` count conflict reported `PROTOTYPE_NOT_SALEABLE`.
  - [ ] 1.4 STILL OPEN, found while walking the class vocabulary on 2026-09-06 and NOT fixed:
        physical-verification variance reconciliation filters lines to `JOB_WORK_STOCK_CLASS`
        (`src/compliance/cycle-count.ts:1423`), so a variance counted against `offcut` stock is
        reconciled onto NOTHING. Offcut has left the custody ledger by then, so the adjustment
        belongs on the HOLDING ledger, which has no adjustment path until this story builds one.
        Until it does, a physical count of retained offcut cannot be reconciled anywhere.
  - [x] 1.5 `src/compliance/cycle-count.ts:91` duplicates `SEGREGATED_STOCK_CLASSES` verbatim and already lists `offcut`; confirm no change is needed and say so in the Debug Log.

- [x] **Task 2: schema (AC 1, AC 3, AC 4, AC 5, AC 6)**
  - [x] 2.1 `read/projections/job_work_offcut_holding.sql`: `ADD COLUMN IF NOT EXISTS` the disposal facts - `disposed_by UUID`, `disposal_rate NUMERIC(18,4)`, `indicative_rate NUMERIC(18,4)`, `disposal_currency TEXT`, `disposal_value NUMERIC(18,4)`, `approved_by UUID`, `doa_entry_id UUID`, `return_challan_number_ext TEXT`. Every one is NULL while `status = 'retained'`.
  - [x] 2.2 Widen `chk_job_work_offcut_holding_lifecycle` with DROP-then-ADD (the file's own stated rule, never add-if-absent) so that `status = 'disposed'` also requires `disposed_by`, and so that `disposition = 'acquired'` requires `disposal_rate`, `disposal_currency` and `disposal_value` non-null while `disposition = 'returned'` requires all three NULL and `return_challan_number_ext` non-null.
  - [x] 2.3 NEW `read/projections/job_work_credit_note.sql` following the `job_work_billing_feed.sql` lifecycle shape: `credit_note_id UUID PK`, `service_order_id`, `holding_id`, `document_kind TEXT CHECK IN ('original','delta')`, `supersedes_credit_note_id UUID` (NULL on `original`, mandatory on `delta`), `cited_invoice_ref_ext TEXT NOT NULL` (the feed's `acknowledged_ref_ext`), `rate NUMERIC(18,4)`, `indicative_rate NUMERIC(18,4)`, `currency`, `value NUMERIC(18,4)`, `delta_value NUMERIC(18,4)` (NULL on `original`), `status TEXT CHECK IN ('pending','acknowledged')`, `acknowledged_at`, `acknowledged_by`, `acknowledged_ref_ext`, `valued_by UUID NOT NULL`, `site_id`, `source_event_id UUID NOT NULL`, `created_at`, `updated_at`. Unique on `source_event_id`; plain (NOT unique) index on `cited_invoice_ref_ext` and on `acknowledged_ref_ext` - both are citations, not identities (the group-A ruling that this story is the first consumer of).
  - [x] 2.4 Lifecycle CHECK on the credit note: `(status = 'acknowledged') = (acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL AND acknowledged_ref_ext IS NOT NULL)`. There is deliberately no `void` or `exception` state: a wrong value is corrected by a `delta` row, never by mutating or voiding (the 9.6 feed-header ruling, carried forward).
  - [x] 2.5 Own grants in guarded `DO` blocks (`app_user`: INSERT, SELECT, UPDATE; `readonly_user`: SELECT), every statement idempotent, register the new file in `src/events/migrate.ts` beside `job_work_offcut_holding.sql` (`:260`), and mirror BOTH files into `deploy/compose/init-db.sql` with LF in the same commit.
  - [x] 2.6 `src/read/projections/job_work_offcut_holding.ts`: extend `JobWorkOffcutHoldingRow`, add `getRetainedHoldingForUpdate(holdingId, client)` (SELECT ... FOR UPDATE) and `markOffcutHoldingDisposed(input, client)` as a GUARDED UPDATE (`WHERE holding_id = $1 AND status = 'retained'`) returning whether it matched. Add `listRetainedOffcutHoldings({ siteIds, today })` for the sweep and the report.
  - [x] 2.7 NEW `src/read/projections/job_work_credit_note.ts` with `insertCreditNote`, `getCreditNoteById` (malformed UUID returns null, the `getBillingFeedById` precedent), `listCreditNotesByOrder`, `markCreditNoteAcknowledged` (guarded on `status <> 'acknowledged'`).
  - [x] 2.8 Pin every new table, column and FULL index statement in `test/unit/schema-drift.test.ts`. Do not "fix" the pre-existing CRLF pins.

- [x] **Task 3: event contract (AC 1, AC 3, AC 5, AC 6)**
  - [x] 3.1 `src/events/schema.ts`: three new payload interfaces on the `jobwork` stream (BSD-2), `JobworkOffcutDisposedPayload`, `JobworkOffcutRevaluedPayload`, `JobworkCreditNoteAcknowledgedPayload`, each with its `...Envelope` type, each documenting which fields are caller-supplied and which are server-derived.
    - `jobwork.offcut_disposed`: caller supplies `service_order_id`, `disposal_id`, `holding_id`, `site_id`, `disposition`, and on `acquired` `rate` plus `currency` and optionally `approved_by`; on `returned` `return_challan_number_ext` and `location_id`. Server-derived and REFUSED on input: `disposal_value`, `indicative_rate`, `credit_note_id`, `owned_lot_number`, `clock_reconciled_qty`.
    - `jobwork.offcut_revalued`: `service_order_id`, `revaluation_id`, `holding_id`, `site_id`, `rate`, `currency`, optional `approved_by`; server-derives `delta_value`, `credit_note_id`, `supersedes_credit_note_id`.
    - `jobwork.credit_note_acknowledged`: `service_order_id`, `credit_note_id`, `site_id`, `acknowledged_ref_ext` (mandatory), `acknowledged_by`.
  - [x] 3.2 Register all three in `SUPPORTED_EVENT_TYPES` and wire the three appliers into the `src/events/store.ts` transaction chain in existing chain order.
  - [x] 3.3 While in `schema.ts`, correct the STALE doc comments the reversal left behind: the `CustodyOffcutRecordedPayload` header (`:4680-4690`) still describes three branches, `offcut_rate_estimate` and `settles_offcut`, and the `JobworkBillingFeedGeneratedPayload` header still names an offcut-settlement precondition. Both describe code that no longer exists. Comment-only edit, no behaviour change.

- [x] **Task 4: disposal applier, NEW file `src/compliance/jobwork-offcut-disposal.ts` (AC 1, AC 2, AC 3, AC 4, AC 7)**
  - [x] 4.1 Header comment stating the lock order verbatim (advisory lock on the order, order row FOR UPDATE, holding row FOR UPDATE, then stock, then clocks, then the holding and credit-note rows LAST) and why the order accepts `closed` (BSD-3).
  - [x] 4.2 Pure predicate `offcutDisposalOpen(holding, disposition)` returning the first failing reason, parameterised so unit tests can fail it (the 8.4 lesson). Refuses a non-`retained` row with the NEW code `OFFCUT_NOT_RETAINED` (409).
  - [x] 4.3 Order gate: re-read the order under the advisory lock; accept `in_process` OR `closed` (BSD-3). Do NOT call `requireInProcessOrder` - it would make every offcut undisposable the moment the order closed, which is exactly the lifecycle the holding ledger exists to support.
  - [x] 4.4 Branch `returned`: issue the offcut-class stock through the new `CUSTODY_OFFCUT_DISPOSAL` Symbol door (Task 1), require `return_challan_number_ext`, render documents (Task 4.8), write NO credit note, write NO owned receipt.
  - [x] 4.5 Branch `acquired`: DOA check (Task 4.7) first, then issue the offcut-class stock through the same Symbol door, then MINT A NEW LOT and post an ordinary `owned` receipt through the compliance seam - never `applyStockReceipt` directly, the 2026-09-06 fix in `jobwork-offcut.ts`. Lot number `${order.order_number_ext}-${order.site_id.slice(0,8)}-OA${sequence}`; wrap `createLot` in `classifyDuplicate` for the global-uniqueness collision. A new lot is mandatory: the laundering bar is lot-ROW based and refuses an `owned` receipt on any lot that has ever held an `offcut` row, regardless of `on_hand`.
  - [x] 4.6 QC hold on the minted owned lot (AC 3), delegated to `receiveQcCompletion` on the SAME transaction, copying `src/compliance/jobwork-output.ts:230-300`. `source_completion_type: 'job_work_order'` is already in `SOURCE_COMPLETION_TYPES` (`quality.ts:675-680`); do not add a vocabulary value. The material was only ever inspected as the customer's, against the customer's specification.
  - [x] 4.7 DOA second signature (AC 7): `resolveApprover('jobwork.offcut_acquisition', disposalValue)` from `src/api/v1/indents.ts:66`. If `requiresApproval` and `approverActorId === null`, refuse `APPROVAL_UNRESOLVED` (409). If `p.approved_by !== approval.approverActorId`, refuse `APPROVAL_REQUIRED` (403). Then refuse `APPROVAL_REQUIRED` when `approved_by === envelope.metadata.actor.user_id`: this is DUAL CONTROL, so the acting user must NOT be the approver. This INVERTS the 9.4 over-norm-loss acting-user check (`custody-ledger.ts:1093`), which requires them to be the same person - copy the shape, invert the comparison, and say so in a comment or the next reviewer will read it as a transcription bug. When the value is below every band `findMatchingDoaEntry` returns no entry and the disposal proceeds unapproved; a claimed `approved_by` in that case is refused `INVALID_PARAMS` rather than silently dropped (the 9.4 symmetric refusal).
  - [x] 4.8 Documents (AC 2): render plain text in this module and store through the generic `dispatch_document` table keyed by `service_order_id`, copying `renderJobWorkDispatchDocuments` (`jobwork-dispatch.ts:232-265`). Use ONLY the four allowed `document_type` values (`bol`, `packing_slip`, `commercial_invoice`, `label`) - the return challan is the `commercial_invoice` slot, exactly as 9.4 does it. Do NOT widen `chk_dispatch_document_type` and do NOT import the Story 3.7 renderers (BSD-6).
  - [x] 4.9 Stop the clock (AC 1) on BOTH branches: `reconcileReturnClocks({ category: 'offcut', counter: 'reconciled_qty', strict: false })`, the forward-declared and still-unused path at `jobwork-return-clock.ts:167`. Non-strict for the reason the 9.5 chunk-2 review settled: clock capacity is `challan_qty` while the holding quantity derives from the received balance, which an over-tolerance receipt may exceed.
  - [x] 4.10 Credit note (AC 3, AC 4): on `acquired` with `rate > 0`, insert ONE `original` credit note citing the order's acknowledged billing-feed reference. A rate of exactly zero is a contractual free retention: mint the lot, write NO credit note, and record the zero rate on the holding row (BSD-5). Store `indicative_rate` from `service_order.offcut_rate` beside the negotiated rate; apply NO tolerance and refuse NOTHING on rate (AC 4, the final 2026-09-05 ruling).
  - [x] 4.11 Credit note precondition: the order must have an acknowledged billing feed carrying `acknowledged_ref_ext`, or there is no invoice to credit. Refuse the NEW code `CREDIT_NOTE_UNCITABLE` (409, with `details.reason`) rather than inventing a placeholder reference.
  - [x] 4.12 Close the holding row through the guarded UPDATE; a zero-row result means a concurrent disposal won, so refuse `DUPLICATE_EVENT` rather than reporting success (the 9.5 sweep's `skippedRaced` lesson, applied to a write path).
  - [x] 4.13 Every money figure settles through the scaled-decimal helpers in `src/compliance/custody-statement.ts:20-59`. No `Number()` on a NUMERIC string anywhere.

- [x] **Task 5: revaluation applier (AC 5)**
  - [x] 5.1 `jobwork.offcut_revalued` on a `disposed` + `acquired` holding row. Refuses `OFFCUT_NOT_RETAINED`'s sibling condition with `INVALID_PARAMS` when the row is still retained or was `returned`.
  - [x] 5.2 Requires an existing `original` credit note for the holding; refuses the NEW code `CREDIT_NOTE_MISSING` (409) otherwise.
  - [x] 5.3 Inserts a `delta` credit note with `supersedes_credit_note_id` set and `delta_value = new_value - latest_value` (signed, may be negative). NEVER updates the original row and NEVER updates a previously acknowledged delta. A second revaluation chains off the latest delta.
  - [x] 5.4 Updates the holding row's `disposal_rate` and `disposal_value` to the current commercial value, leaving `indicative_rate` untouched. State plainly in the header that the DOCUMENT trail is immutable while the holding row carries the current value; that is the distinction AC 5 draws.
  - [x] 5.5 The DOA band applies to the revalued acquisition value on the same terms as Task 4.7.

- [x] **Task 6: credit-note acknowledgment applier (AC 6)**
  - [x] 6.1 `jobwork.credit_note_acknowledged` flips `status` to `acknowledged` and stamps `acknowledged_at`, `acknowledged_by`, `acknowledged_ref_ext` (mandatory, non-empty, `MAX_TEXT_LENGTH` 200).
  - [x] 6.2 SoD (AC 6): refuse `SOD_VIOLATION` (403) when `acknowledged_by` or the acting user equals the credit note's `valued_by`. Copy `jobwork-billing.ts:531`. With no rate band anywhere (the 2026-09-05 ruling removed it), this guard carries the ENTIRE control over the acquisition rate. Do not weaken it, do not make it configurable.
  - [x] 6.3 Guarded UPDATE on `status <> 'acknowledged'`; a second acknowledgment is `DUPLICATE_EVENT`.

- [x] **Task 7: routes, RBAC, registration (AC 1, AC 3, AC 5, AC 6, AC 7)**
  - [x] 7.1 `POST /api/v1/service-orders/:serviceOrderId/offcut-disposals`, `POST /api/v1/service-orders/:serviceOrderId/offcut-revaluations`, `POST /api/v1/jobwork/credit-notes/:creditNoteId/acknowledgment`, `GET /api/v1/service-orders/:serviceOrderId/offcut-holdings`. All in `src/api/v1/service-orders.ts`, all `requireRole({ module: 'jobwork', functionScope: ... })`, all with `requireIdempotencyKey`, `rejectUnacceptedFields` symmetric on server-derived fields, path-id equals body-id, `assertSiteWriteAccess` against the ORDER's site re-checked on retries as well (the 9.5 chunk-3 fix).
  - [x] 7.2 Role gate above RBAC on the two write routes that set value: posting a disposal or a revaluation requires the `finance_controller` role, derived from the SAME assignment that supplies the site scope (the `CHALLAN_RECLASSIFICATION_ROLES` shape at `service-orders.ts:1240`, including its privilege-and-scope-from-one-assignment fix). Refuse `FUNCTION_ACCESS_DENIED` (403).
  - [x] 7.3 Register the STATIC `/api/v1/jobwork/credit-notes/...` segment BEFORE every parameterised `/service-orders/:serviceOrderId/...` route in `src/server.ts:1051-1073`, the recorded lesson at that comment.
  - [x] 7.4 Add the new codes to `AUDITED_REJECTIONS` (`service-orders.ts:79`): `OFFCUT_NOT_RETAINED`, `CREDIT_NOTE_MISSING`, `CREDIT_NOTE_UNCITABLE`. `SOD_VIOLATION`, `APPROVAL_REQUIRED`, `APPROVAL_UNRESOLVED` and `FUNCTION_ACCESS_DENIED` are already there.
  - [x] 7.5 Add the three new codes to `src/sync/upload.ts` `PERMANENT_ERROR_CODES` and `edge/src/messages/en.json`, defensively (no edge scope in this story - disposal and valuation are office actions), the 9.4 through 9.6 precedent.
  - [x] 7.6 Add all four routes to the Story 1.9 spine allowlist in `test/integration/story-1-9.test.ts`.

- [x] **Task 8: sweep and reports (AC 8, AC 9)**
  - [x] 8.1 Widen the ageing report `GET /api/v1/jobwork/reports/aging` (`service-orders.ts:1290`) with an `offcut_holdings` section: every `status = 'retained'` row, site-scoped through the existing `reportSiteScope`, bucketed by age since `captured_at` using the SAME `agingBucketFor` thresholds, carrying `service_order_id`, `offcut_contract_ref_ext`, `sku`, `lot_id`, `quantity`, `uom`, `captured_at`. Acquired and returned rows are excluded by the `retained` filter, which is the whole of AC 9's second half.
  - [x] 8.2 Widen `runJobworkClockSweepCycle` (`src/notify/jobwork-clock-sweep.ts`) so that a clock's alert and breach `next_step` text names any retained offcut on the same (order, sku), and so that retained offcut whose order has CLOSED still reaches the coordinator. Add `offcutRetained` to `JobworkClockSweepResult`.
  - [x] 8.3 CRITICAL, do not get this wrong: capture deliberately does NOT reconcile the clock, so the retained quantity is STILL outstanding on `jobwork_return_clock` and already counts toward `deemed_supply_qty`. The clock stays the single accounting authority. The sweep must SURFACE retained offcut, never add it to the deemed-supply arithmetic - double-counting it would overstate the Section 143 exposure on every ITC-04 extract. Assert non-double-counting in a test.
  - [x] 8.4 No new background cycle and no new advisory key: this rides the existing 6th cycle (`jobwork clock breach`, key 9505). `test/unit/background-cycles.test.ts` pins seven cycles after 9.6 and must stay at seven.

- [x] **Task 9: tests**
  - [x] 9.1 NEW `test/integration/story-9-7.test.ts`, serial, run-scoped random suffix, local fixture closures, admin pool for seeding (`app_user` has no DELETE), against the docker container `ims-postgres-test` on port 5442.
  - [x] 9.2 Arms, one per AC: retained-to-returned with documents and clock stop; retained-to-acquired with owned lot, QC hold, credit note and clock stop; acquired at rate zero minting a lot and raising NO credit note; negotiated rate differing from indicative accepted with both stored; revaluation raising a delta with the original untouched; self-acknowledgment refused `SOD_VIOLATION`; above-band acquisition refused `APPROVAL_REQUIRED` and audited, then accepted with the resolved `cfo`; approver equal to the acting user refused; disposal on a CLOSED order accepted; ageing report showing retained then not showing acquired; sweep surfacing retained offcut without double-counting deemed supply.
  - [x] 9.3 Two-point mutation verification (the 9.3 through 9.6 standard) on the three load-bearing gates: the SoD refusal, the DOA dual-control refusal, and the Task 1 offcut issue bar. Each mutant must be killed by BOTH a route arm and a direct `POST /api/v1/events` arm.
  - [x] 9.4 A direct-event bypass arm for each of the three new event types (the hold-bypass class).
  - [x] 9.5 NEW `test/unit/jobwork-offcut-disposal-predicates.test.ts` for `offcutDisposalOpen`, the delta arithmetic, and the zero-rate branch.
  - [x] 9.6 Gates before handing over: `tsc`, `eslint`, `prettier`, `npm run db:migrate` twice (idempotent), schema-drift, story-9-1 through story-9-6 and story-1-9 regressions, then the full suite compared against the baseline. The noise floor was ELIMINATED on 2026-09-05: the suite is expected GREEN, and any failure is yours until proven otherwise. Do not reintroduce a tolerated floor.

## Dev Notes

### Binding scope decisions already made (read before coding)

1. **Capture is done and reversed; this story owns disposal only.** `src/compliance/jobwork-offcut.ts` drains custody into `job_work_offcut_holding` UNVALUED, mints an `offcut`-class lot, and deliberately does NOT call `reconcileReturnClocks`. Do not re-open capture, do not add a rate to it, do not stop the clock there.
2. **The three new events ride the `jobwork` stream, not `custody`.** Capture was a custody movement; disposal is not - the custody balance is already zero and the order may already be closed. `jobwork.billing_feed_generated` is the naming precedent. Event types must never begin with `erp.` and must never use `stream_type: 'erp'`: `assertErpReadOnly` (`src/compliance/erp-readonly.ts:16-27`) refuses both with 405 before any write.
3. **Disposal must work on a CLOSED order.** The holding ledger exists precisely because the offcut's lifecycle outlives the order's (the `job_work_offcut_holding.sql` header says so, and the 9.6 epic dev note repeats it). `requireInProcessOrder` would forbid it. Accept `in_process` or `closed`, the `orderAcceptsBilling` shape at `jobwork-billing.ts:105`.
4. **`returned` and `acquired` are the whole vocabulary.** The CHECK constraint already closes it at two values. Onward resale, including auction and buy-back by the originating customer, is an ordinary sale of stock the processor already owns and is OUT OF SCOPE (the 2026-09-05 buy-then-sell ruling). Two prices exist and must never be conflated: this story records what the processor PAYS the customer for title, never what it later RECEIVES.
5. **A contractual free retention is `acquired` at a rate of zero, not a third branch.** Same title transfer, same owned lot, same QC hold, no credit note because there is nothing to credit.
6. **"Through the Story 3.7 flows" means the generic `dispatch_document` TABLE, not the 3.7 renderers.** `src/warehouse/document-renderer.ts` hard-queries `erp_sales_order` and `packing_record` by `dispatch_order_id` and would silently render "Unknown" and "N/A" for a job-work order instead of failing closed; the sales-order-bound `dispatch_order_status` state machine does not apply either. Stories 9.4 and 9.6 both settled this. The document table's `dispatch_order_id` is a bare UUID with no foreign key.
7. **The credit note is the first consumer of `job_work_billing_feed.acknowledged_ref_ext`.** That column is a CITATION, not an identity, and its index must stay non-unique so one consolidated ERP invoice can be cited by several documents. The 9.6 group-A review made that ruling specifically for this story; do not "tighten" it.
8. **No void path, anywhere.** A wrong value is corrected by a `delta` credit note. The 9.6 feed header sets out the reasoning: regenerating after ERP has ingested a document mints a second billable artefact with no approver in the chain.
9. **The DOA transaction type must be dedicated to `cfo`.** `resolveApprover` (`src/api/v1/indents.ts:66-95`) falls back to the holder of ANY OTHER ROLE banded under the same `transaction_type` when the matched band's role has no holder. Reusing an existing transaction type, or seeding a second role under `jobwork.offcut_acquisition`, would silently resolve the CFO signature to somebody else and defeat AC 7 while every test stayed green.
10. **Dual control inverts the 9.4 acting-user check.** In the over-norm-loss chain the acting user MUST equal the approver. Here the finance controller posts and the CFO signs, so the acting user must NOT equal the approver. Same shape, opposite comparison, and it needs a comment saying so.
11. **The clock is the single accounting authority for deemed supply.** Retained offcut is still outstanding on `jobwork_return_clock`, so surfacing it in the sweep and report must never add it to `deemed_supply_qty`.
12. **No new scrap projection.** Acquired offcut becomes ordinary owned stock on a minted lot under QC hold, which is AC 3's literal requirement; AC 9's "scrap holding ledger" is satisfied by that owned stock plus the disposed holding row. A segregated scrap class would be a new story with its own valuation and ageing views.

### Critical defect classes to not reintroduce (from the 9.1 through 9.6 review history)

- **Hold-bypass class** (8.3 through 8.8, 9.3, 9.4, 9.5, 9.6): every gate here - `OFFCUT_NOT_RETAINED`, the DOA band, the SoD refusal, the role gate, the credit-note citation - must be re-derived INSIDE the applier under the order advisory lock. A route pre-check is a convenience, never the authority, and a direct `POST /api/v1/events` must meet the identical wall. This class has now been found five separate times; assume it is present until a test proves otherwise.
- **Self-approval class** (6.1, 6.3, the 8.x release SoD, the 9.4 acting-user check, the 9.6 feed SoD): RBAC is module plus function scope, never a role literal on the route, so any two actions one operator can reach need an explicit actor comparison in the applier.
- **Cross-site write hole** (closed centrally on 2026-09-06 with `assertPayloadSiteWriteAccess`): every new payload carries `site_id` and every new door asserts it. Payloads without `site_id` are the known-unswept residue elsewhere; do not add another.
- **Float coercion**: rates, values and quantities settle through the scaled-integer helpers. `Number()` on a NUMERIC string is the repeated 9.2 through 9.4 finding.
- **Lock order**: order advisory lock, order row FOR UPDATE, holding row FOR UPDATE, then stock, then clocks, then the ledger and document rows last. Document it in the header of every new seam file.
- **Guarded UPDATE races**: a zero-row result is a race, not a success. The 9.5 sweep learned this the expensive way.
- **Route registration order**: static segments before parameterised ones, or the parameter swallows them.
- **Audit completeness**: every refusal code the new routes can emit lands in `AUDITED_REJECTIONS` with `auditFailSafe` routing, or a refused statutory decision leaves no audit row (the 8.3 `NCR_EXISTS` omission).
- **Role spelling**: `jobwork_coordinator`, `finance_controller`, `cfo`, `compliance_officer`, `site_head`. The `job_work_coordinator` spelling has no holder anywhere.

### Existing code being modified (read fully before editing)

Table 1 lists every file this story modifies, what it does today, and what must survive the edit.

| **File** | **Current state** | **This story changes** | **Must preserve** |
| --- | --- | --- | --- |
| `src/compliance/stock-balance.ts` | `SEGREGATED_STOCK_CLASSES` includes `offcut` (`:93`) but the issue/allocation bar (`:373-392`) keys on `job_work` alone; both laundering arms (`:392-467`); `NON_SALEABLE_STOCK_CLASSES` is prototype-only (`:83`) | Widens the issue/allocation arm to `offcut` and admits the new `CUSTODY_OFFCUT_DISPOSAL` Symbol only | Both laundering arms, the two existing Symbol doors, `segregationErrorCode`'s 2026-09-06 offcut fix |
| `src/compliance/custody-ledger.ts` | Four appliers, `CUSTODY_CONSUMPTION` (`:73`), `CUSTODY_RETURN` (`:84`), `classifyDuplicate` (`:440`), the 9.4 acting-user DOA chain (`:1046-1100`) | Adds and exports ONE Symbol plus its predicate. No applier goes here; the file is already over 1300 lines | Every existing applier, both Symbols, the 23505 classification |
| `src/compliance/jobwork-offcut.ts` | Capture only: drains custody, mints the `offcut` lot, writes the holding row, deliberately no clock call | Nothing functional. Read it first - it is the template for the disposal applier's shape | The no-clock-at-capture decision and its header explanation |
| `src/compliance/jobwork-return-clock.ts` | `reconcileReturnClocks` with the forward-declared, never-used `offcut` category (`:167`) | Nothing. This story is its first caller | The strict-versus-capped contract and the counter guards |
| `src/notify/jobwork-clock-sweep.ts` | Tightest-stage-wins sweep, key 9505, site-scoped notification copies | Adds retained-offcut context to the alert text and the result shape | Per-row SAVEPOINT isolation, the race counter, site scoping of every copy, the existing arithmetic |
| `src/api/v1/service-orders.ts` | `postCustodyEvent` (`:612`), `AUDITED_REJECTIONS` (`:79`), the role-plus-scope gate (`:1240`), the ageing report (`:1290`), RBAC wrappers (`:1649+`) | Four routes, three codes, the ageing report section | Every existing route and helper signature, the idempotency and RBAC idioms |
| `src/server.ts` | Route registration (`:1051-1120`), seven background cycles | Four route registrations in the correct order | Static-before-parameterised ordering, the `guarded()` wrapper, all seven cycles |
| `src/events/schema.ts` | Custody and jobwork payload types; two STALE offcut headers | Three payload interfaces plus the stale-comment correction | Every existing type |
| `src/events/store.ts`, `src/events/migrate.ts` | Applier chain; projection file list (`:257-261`) | Three applier calls, one SQL file entry | Existing chain order and entries |
| `read/projections/job_work_offcut_holding.sql` | Capture columns plus the forward-declared `disposed_at` / `disposition` / `disposal_event_id` | Eight additive columns, widened lifecycle CHECK by DROP-then-ADD | Every existing column, index and grant |
| `deploy/compose/init-db.sql` | LF mirror of every canonical SQL file | The new credit-note table and the holding-table columns | Mirror parity |
| `src/sync/upload.ts`, `edge/src/messages/en.json` | Permanent-error codes and messages | Three entries each | Existing entries |
| `test/integration/story-1-9.test.ts` | Spine allowlist through 9.6's routes | Four entries | Existing entries |
| `test/unit/schema-drift.test.ts` | Pinned table and index list | The new table and columns | The pre-existing pins |

### Source tree to touch (new files)

Table 2 lists the files this story creates.

| **File** | **Purpose** |
| --- | --- |
| `read/projections/job_work_credit_note.sql` | Credit-note projection with the original/delta document chain and an acknowledgment lifecycle |
| `src/read/projections/job_work_credit_note.ts` | Credit-note accessors |
| `src/compliance/jobwork-offcut-disposal.ts` | Disposal, revaluation and acknowledgment appliers, plus the disposal document renderer |
| `test/integration/story-9-7.test.ts` | Integration suite |
| `test/unit/jobwork-offcut-disposal-predicates.test.ts` | Disposal predicate, delta arithmetic, zero-rate branch |
| `src/cli/verify-segregated-roles-core.ts` | Task 0, ALREADY BUILT: the go-live separation-of-duties verifier |
| `src/cli/verify-segregated-roles.ts` | Task 0, ALREADY BUILT: CLI entry point behind `npm run verify:roles` |
| `test/integration/segregated-roles.test.ts` | Task 0, ALREADY BUILT: 7 arms over the five violation codes |

### Testing standards summary

node:test serial integration suites, run-scoped random suffix, local fixture closures only, SCIM plus dev-token actors, admin pool for seeding (`app_user` has no DELETE), migrate-twice idempotency gate, two-point mutation verification at both the seam and the route, a direct-event bypass arm for every new event type, and sweep functions called directly rather than through live timers. The test database is the docker container `ims-postgres-test` on port 5442; run integration files serially.

Gotchas carried forward from 9.5 and 9.6 that apply here: `custody_ledger_entry` rows ordered by sku come back in the database collation, which sorts `SKU-CUST2-...` ahead of `SKU-CUST-...`, so assert by sku map and never by position; `stock_balance.on_hand` is `NUMERIC(18,6)`, so cast to `numeric(18,3)` before comparing text; and node-pg returns a bare `DATE` as LOCAL midnight, so select dates with `to_char(..., 'YYYY-MM-DD')` rather than mapping through `toISOString()` (the 2026-09-06 fix in `job_work_offcut_holding.ts`). Never hardcode a future date in a fixture: six such date bombs were defused on 2026-09-05.

### Project Structure Notes

- Seam files stay in `src/compliance/`, sweep and notification code in `src/notify/`, projection accessors in `src/read/projections/`, canonical SQL in `read/projections/` with LF endings and an LF mirror in `deploy/compose/init-db.sql` in the same commit.
- Every SQL statement idempotent (`IF NOT EXISTS` or a guarded `DO` block) so the file can be re-applied to a live database. Constraint changes are DROP-then-ADD, never add-if-absent.
- No edge-sync scope: disposal, valuation and acknowledgment are office actions. The three error codes still go into `upload.ts` and `en.json` defensively.
- No UX specification exists for this flow; no UI work is in scope.

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` lines 2753-2820 (Story 9.7 acceptance criteria and dev notes), 2660-2680 (Story 9.4 revised confirm criterion), 2738-2752 (Story 9.6 revised criteria and dev notes)
- Sprint change proposal: `_bmad-output/planning-artifacts/sprint-change-proposal-2026-09-05.md` (the reversal, the four binding user answers, the four answered open questions)
- Architecture: `.../architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` AD-6 (custody ledger non-valuated and segregated), AD-11 (ERP GL is the book of record), AD-12 (gates never live in routes), AD-14 (shared projections), AD-16 (idempotency keys), AD-17 (notification emission coupling)
- Previous stories: `9-6-...md` (capture, the billing feed, the SoD and citation rulings), `9-5-...md` (the return clock, `reconcileReturnClocks`, the sweep pattern, the closure gate), `9-4-...md` (the dispatch document renderer, the DOA chain for over-norm loss), `9-3-...md` (the custody ledger and the Symbol-door idiom)
- Code anchors verified in this session: `src/compliance/stock-balance.ts:83-106` (class sets and `segregationErrorCode`), `:349-392` (the non-saleable arm and the job-work issue bar), `:392-467` (both laundering arms); `src/compliance/custody-ledger.ts:73-90` (both Symbols), `:440` (`classifyDuplicate`), `:1046-1100` (the over-norm DOA chain including the acting-user check this story inverts); `src/compliance/jobwork-offcut.ts` (capture in full, the lot-mint and compliance-seam-not-raw-projection lessons); `src/compliance/jobwork-output.ts:230-300` (lot mint plus `receiveQcCompletion` hand-off); `src/compliance/jobwork-dispatch.ts:232-265` (`renderJobWorkDispatchDocuments` and the four document types); `src/compliance/jobwork-return-clock.ts:166-260` (`ReconcileCategory`, the strict-versus-capped contract); `src/compliance/jobwork-billing.ts:40-60` (the stream and SoD rationale), `:105` (`orderAcceptsBilling`), `:531` (the `SOD_VIOLATION` refusal); `src/compliance/quality.ts:675-680` (`SOURCE_COMPLETION_TYPES`); `src/api/v1/indents.ts:66-95` (`resolveApprover` and its cross-role fallback); `src/api/v1/service-orders.ts:79-120` (`AUDITED_REJECTIONS`), `:603-700` (`postCustodyEvent`), `:1240-1260` (the role-plus-scope gate), `:1290-1330` (the ageing report), `:1649-1761` (the RBAC wrappers); `src/server.ts:1051-1120` (route order); `src/notify/jobwork-clock-sweep.ts:1-230` (the sweep, key 9505); `read/projections/job_work_offcut_holding.sql` (the whole file, especially the ownership-tension header); `read/projections/job_work_billing_feed.sql:1-80` (the lifecycle shape this story's credit note copies); `read/projections/dispatch_document.sql:7-26` (the four allowed document types); `src/read/projections/job_work_offcut_holding.ts` (accessors and the DATE mapping gotcha); `test/integration/story-1-9.test.ts` (spine allowlist)

### Open questions

Table 3 records the questions this story answers by ruling rather than by asking, so the dev agent is never blocked. Each ruling is implemented as written and flagged for product-owner confirmation before go-live.

| **Question** | **Ruling** | **Lives in** |
| --- | --- | --- |
| 1. Does surfacing retained offcut in the sweep add it to the deemed-supply figure? | No. Capture does not reconcile the clock, so the quantity is still counted there; adding it again would overstate the Section 143 exposure on every ITC-04 extract | BSD-11, Task 8.3 |
| 2. Where does acquired offcut live once title transfers, given AC 9's "scrap holding ledger"? | Ordinary owned stock on the minted lot under QC hold, which is AC 3's literal requirement. No new scrap projection and no new stock class; the disposed holding row is the historical record | BSD-12, Task 4.5 |
| 3. What if a disposal is posted before the service invoice has been acknowledged? | Refused `CREDIT_NOTE_UNCITABLE`. There is no invoice to credit and a placeholder reference would be a fabricated citation. The `returned` branch is unaffected | Task 4.11 |
| 4. Can the same holding row be disposed twice, or partially? | Neither. Disposal closes the whole row; a second attempt is `OFFCUT_NOT_RETAINED`. Partial disposal would need a split, which is a new story. Capture already writes one row per posting, so an order that wants two fates posts two captures | Task 4.2, Task 4.12 |
| 5. Does the DOA band apply to a revaluation? | Yes, on the revalued acquisition value. Otherwise a below-band disposal followed by a revaluation is an unsigned route to any value | Task 5.5 |
| 6. Which document type carries the return challan? | `commercial_invoice`, the slot Story 9.4 already uses for the job-work challan. The CHECK constraint's four values are not widened | BSD-6, Task 4.8 |

## Dev Agent Record

### Agent Model Used

Claude Opus 5 (1M context), bmad-dev-story workflow, 2026-09-06.

### Debug Log References

Baseline `502b664` on branch `chore/9-6-reversal-and-noise-floor` (Task 0 and Task 1.3 were already
committed there). Every gate below was run against the docker container `ims-postgres-test` on port
5442; integration files were run serially.

Ten disclosures, each a place where the shipped code differs from the story text or where a finding
came out of execution rather than reasoning:

1. **Task 1.1 was already closed before this story started.** `offcut` is in
   `CUSTOMER_OWNED_STOCK_CLASSES` as of commit `502b664`, so the issue/allocation bar already
   covered it. This story added only the door: the new `CUSTODY_OFFCUT_DISPOSAL` Symbol and its
   `offcut`-only arm, which is what Task 1.3 said this story had to do on that same mechanism.
2. **Task 4.6 DEVIATION, the load-bearing one: `receiveQcCompletion` cannot gate this lot, so the
   QC hold is the Story 8.5 GOVERNED hold instead.** The hand-off is plan-bound - it refuses
   `INVALID_PAYLOAD` without a UUID `bom_revision_id`, and `quality.ts` then requires that
   revision's BOM parent to BE the item being gated. The acquired lot carries the customer's RAW
   MATERIAL sku, which has no BOM at all (the order's kit revision has the OUTPUT item as its
   parent), so the hand-off is refused outright. This was found by EXECUTION, not by reading: the
   first run of the AC 3 arm failed with `bom_revision_id must be a UUID`. It is the Story 9.6
   BSD-19 finding repeating for the same material for the same reason, so the fix is the same one
   9.6 settled on: `insertQcQualityHold` plus `placeQualityHold`, which is what
   `dispatchGateBlockedLots` and every allocation and pick gate actually read. AC 3's "minted under
   a QC hold" is satisfied, and the integration arm asserts the hold through the codebase's own
   predicate rather than through a task row.
3. **AC 8 needed a change the tasks did not name: `listReturnClocksDueForSweep` excluded closed
   orders outright** (`AND o.status <> 'closed'`). Widening the alert text alone would have left
   retained offcut on a closed order invisible, which is precisely the exposure AC 8 exists to
   close. The candidate query now also admits a clock whose order is closed when retained offcut
   exists on that (order, sku). Story 9.5's own behaviour is otherwise untouched.
4. **The ageing report's offcut buckets are AGE bands, not an expiry.** The holding row has no
   statutory deadline of its own - the deadline lives on `jobwork_return_clock` - so the section
   reuses `agingBucketFor` against a 90-day reporting horizon (`OFFCUT_AGING_HORIZON_DAYS`) so the
   30/90-day boundaries stay the report's, and it carries `counted_in_deemed_supply: false` on the
   payload so no consumer folds the two figures together.
5. **One column beyond Task 2.1's eight: `owned_lot_id`.** The acquisition mints a lot and nothing
   else recorded which one; it is also what the `OA` sequence counts, so a second acquisition on
   the same order cannot collide on the global `uq_lot_master_lot_number`.
6. **Task 1.5 confirmed, no change needed**: `cycle-count.ts:91` already lists
   `offcut` in its duplicated `SEGREGATED_STOCK_CLASSES`.
7. **Task 1.4 REMAINS OPEN, as the story says it does.** Physical-verification
   variance reconciliation still filters lines to `JOB_WORK_STOCK_CLASS`
   (`cycle-count.ts:1423`), so a variance counted against `offcut` stock reconciles onto nothing.
   Closing it needs an adjustment path on the holding ledger, which no task in this story
   commissions. Left open deliberately rather than half-built.
8. **A concurrent Story 9.6 code-review session was writing to this repository during this run** and
   added `CUSTODY_OFFCUT_CAPTURE`, a receive-side Symbol gate on the `offcut` class in the same
   `stock-balance.ts` arm region. The two doors coexist and were verified together: capture opens
   the receipt, disposal opens the issue, and neither opens the other's direction.
9. **`deploy/compose/init-db.sql` is LF in this repository**, not CRLF as the story text assumes.
   Both new blocks were mirrored with the file's existing endings; `schema-drift` is green at
   158/158, which is the check that actually governs the mirror.
10. **The DOA band and the `cfo` holder are resolved in the test the way the seam resolves them**,
    never assumed to be this run's fixture user: `doa_registry_entries` and role assignments are
    global and outlive a run, so a reran suite would otherwise assert against a previous run's CFO.

Table 4 records the mutation verification (Task 9.3), three load-bearing gates, each killed:

| **Mutant** | **Change** | **Result** |
| --- | --- | --- |
| Offcut issue bar | `offcut` removed from `CUSTOMER_OWNED_STOCK_CLASSES` | Task 1 arm fails (route AND direct-event probes are both in it) |
| Credit-note SoD | `selfAcknowledged` forced to `false` | AC 6 arm fails (route self-acknowledgment AND the forged-`acknowledged_by` direct event) |
| Dual control | acting-user comparison inverted back to the 9.4 same-person form | 2 of 3 AC 7 arms fail, including the direct-event probe past the route's role gate |

Gates (as run at dev time): `tsc` clean; `eslint src/ test/` clean; `prettier` clean on every touched file (the repo's
50 pre-existing unformatted files were left alone); `npm run db:migrate` run twice, idempotent;
`schema-drift` 158/158; story-9-7 22/22; unit suite 509/509; story-9-1 27, 9-2 19, 9-3 12, 9-4 13,
9-5 34, 9-6 20, 1-9 6 - all green; FULL SUITE 1966/1966, zero failures. The noise floor stays
eliminated.

Gates (as re-verified 2026-09-06 after the chunk A/B/C code-review passes; these supersede the dev-time figures above): `tsc --noEmit` clean; eslint clean on every touched file; unit suite 512/512; story-9-7 28/28; schema-drift 158/158 + story-9-6 22/22 + story-1-9 6/6; story-9-4 + 9-5 + 6-3 + 6-4 = 111/111.

### Completion Notes List

- Disposal, revaluation and credit-note acknowledgment ride the `jobwork` stream (BSD-2) and work on
  a CLOSED order (BSD-3), through `requireInProcessOrder(..., orderAcceptsBilling)`.
- `returned` issues the offcut stock through the new Symbol door, renders four documents into the
  generic `dispatch_document` table (return challan in the `commercial_invoice` slot, BSD-6), and
  writes no credit note. `acquired` transfers title, mints a new owned lot under a governed QC hold,
  and raises one `original` credit note citing the acknowledged service invoice; a free retention is
  the same branch at rate zero and raises none (BSD-5).
- No tolerance is applied to the negotiated rate (AC 4): the indicative rate is stored beside it and
  the variance is visible on the credit note and the reports. The control over the rate is the DOA
  second signature above the band plus the acknowledgment SoD, never arithmetic.
- Dual control inverts the Story 9.4 acting-user check (BSD-10) and says so at the comparison.
- Revaluation chains deltas off the LATEST document and never mutates one; the holding row carries
  the current commercial value while the document trail stays immutable (AC 5).
- Retained offcut is surfaced in the breach sweep and the ageing report and is never added to
  `deemed_supply_qty` (BSD-11, asserted directly in the AC 8 arm: a 100 KG challan with 40 KG of
  retained offcut reports 100 KG of deemed supply, not 140).
- No new background cycle and no new advisory key; the sweep still rides key 9505.
- Task 0.4 stays operational and is NOT closed by this story: an administrator must provision a real
  `cfo` and a DIFFERENT real `finance_controller` and register the `jobwork.offcut_acquisition` band
  before go-live. `npm run verify:roles` must exit 0 against the target environment. Until then
  above-band acquisitions refuse `APPROVAL_UNRESOLVED` and disposal refuses `FUNCTION_ACCESS_DENIED`,
  which is intended fail-closed behaviour.
- Task 0.6 needed no change: the `cfo` and `finance_controller` rows and the two-people ruling are
  already in the access-matrix draft.

### File List

New:

- `read/projections/job_work_credit_note.sql`
- `src/read/projections/job_work_credit_note.ts`
- `src/compliance/jobwork-offcut-disposal.ts`
- `test/integration/story-9-7.test.ts`
- `test/unit/jobwork-offcut-disposal-predicates.test.ts`

Modified:

- `read/projections/job_work_offcut_holding.sql`
- `deploy/compose/init-db.sql`
- `src/read/projections/job_work_offcut_holding.ts`
- `src/read/projections/jobwork_return_clock.ts`
- `src/compliance/custody-ledger.ts`
- `src/compliance/stock-balance.ts`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/events/migrate.ts`
- `src/notify/jobwork-clock-sweep.ts`
- `src/api/v1/service-orders.ts`
- `src/server.ts`
- `src/sync/upload.ts`
- `edge/src/messages/en.json`
- `test/integration/story-1-9.test.ts`
- `test/unit/schema-drift.test.ts`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Change Log

| **Date** | **Change** | **By** |
| --- | --- | --- |
| 2026-09-06 | Tasks 1-9 implemented from baseline `502b664`. New offcut credit-note projection with an original/delta chain, eight disposal columns plus `owned_lot_id` on the holding ledger, three `jobwork`-stream events, the disposal/revaluation/acknowledgment appliers, a third Symbol door for the `offcut` class, four routes behind a finance-controller gate, the ageing-report offcut section and the sweep widening. Ten disclosures in the Debug Log, of which two are load-bearing: the QC gate on an acquired lot is the Story 8.5 governed hold because `receiveQcCompletion` is plan-bound and refuses customer raw material, and the sweep's candidate query had to be widened because it excluded closed orders entirely. Three gates mutation-verified at both the route and the direct-event door. Full suite 1966/1966 | dev |
| 2026-09-06 | Task 0 implemented ahead of the rest of the story: `verifySegregatedRoles` plus `npm run verify:roles` and a 7-arm integration suite. Five violation codes, including two hazards the acceptance criteria do not name - a second role banded on the same DOA transaction type (approver resolution falls back across roles) and an active vacation delegation that hands both halves of the pair to one person. Provisioning the real users and the band remains an administrative act against the target environment | dev |
| 2026-09-06 | Story created, status ready-for-dev. Twelve binding scope decisions, six rulings in place of open questions, and one live defect found during analysis and folded in as prerequisite Task 1: the `offcut` stock class is segregated for receipts but not barred from issue or allocation, so customer-owned retained offcut can currently be picked into any sales dispatch | create-story workflow |

## Review Findings

Adversarial code review 2026-09-06 (Blind Hunter + Edge Case Hunter + Acceptance Auditor, parallel), run in chunks A-E over the full Story 9.7 diff (baseline `502b664`, working tree). Each chunk's applied patches are checked `[x]` with their verification; open decisions and the follow-up stay `[ ]`.

### Chunk A Findings (compliance) - 2026-09-06

Chunk A scope: the six compliance files (`jobwork-offcut-disposal.ts`, `stock-balance.ts`, `custody-ledger.ts`, `service-order.ts`, `jobwork-billing.ts`, `jobwork-offcut.ts`).

APPLIED 2026-09-06 (apply-every-patch): 12 of 13 patches shipped in this pass; decision 1's interim (the 403 no longer leaks `resolved_approver_user_id`) shipped and the full two-step rework is an OPEN follow-up below. Verification: `tsc --noEmit` clean, eslint clean, unit suite 512/512, story-9-7 28/28 (six new regression arms added), story-9-6 22/22, story-1-9 6/6, and jobwork 9-1..9-5 + 6-3/6-4 = 169/169. Schema touched (holding `clock_reconciled_qty`) in both the canonical and init-db copies. New stable error code `CREDIT_NOTE_SUPERSEDED` registered in `AUDITED_REJECTIONS`, `upload.ts` and edge `en.json`.

- [x] [Review][Patch] The CFO "second signature" is never authenticated - `approved_by` is a caller-claimed UUID and the 403 details publish `resolved_approver_user_id`, so an above-band acquisition can be approved by anyone with jobwork write access who reads the error and claims the id on retry. AC 7 (BSD-9/10). `jobwork-offcut-disposal.ts:387-444` RESOLVED (party-mode 2026-09-06, decision 1 to Option A): rework to a true two-step signature - the disposal is recorded pending the CFO's signature and the resolved `cfo` approves through their own authenticated action (`metadata.actor.user_id` IS the approver, the 9.4 acting-user shape and the Story 4.1 approval-route idiom), covering the shared `resolveAcquisitionApproval` so the revaluation path inherits it. Interim regardless: stop returning `resolved_approver_user_id` in the 403 details. APPLIED 2026-09-06, INTERIM ONLY: neither `APPROVAL_REQUIRED` refusal detail returns `resolved_approver_user_id` anymore (matching the 9.4 no-leak precedent). The full two-step rework is an event-contract change (a persisted, CFO-authenticated approval step) and is recorded as an OPEN follow-up below rather than bolted onto this reviewed contract inside a patch pass.
- [x] [Review][Patch] The Section 143 clock stop is silent best-effort: `reconcileReturnClocks` with `strict: false` allocates up to remaining (order, sku) capacity and the unallocated residual is never surfaced while the holding still closes, so AC 1's "clock stopped for that quantity" can silently not happen; `clock_reconciled_qty` is recorded only on the event payload. `jobwork-offcut-disposal.ts:524-544, 778-779` RESOLVED (party-mode 2026-09-06, decision 2 to Option B): keep `strict: false` (the over-tolerance ruling stands) but surface the shortfall - write `clock_reconciled_qty` / the unallocated residual onto the holding row (or a reconciliation-exception record) so the Story 9.5 sweep machinery can act on it, never silently.
- [x] [Review][Patch] Refusals raised inside the appliers (APPROVAL_REQUIRED, APPROVAL_UNRESOLVED, SOD_VIOLATION, OFFCUT_NOT_RETAINED and the new CREDIT_NOTE_* codes) are audited only by the routes via `AUDITED_REJECTIONS`; the appliers discard or omit the audit context, so a direct `POST /api/v1/events` refused on these codes leaves no audit row, contrary to AC 7's "refused ... and audited" on a door this story requires to meet the identical wall. `jobwork-offcut-disposal.ts:554-557, 855-859, 971-975` RESOLVED (party-mode 2026-09-06, decision 3 to Option A): audit refusals inside the appliers when refusing an audited code, using the never-throwing `logRejectionAudit` helper the Story 6.4 pattern established, so both doors are covered.
- [x] [Review][Patch] `posted_by` / `acknowledged_by` are accepted as any UUID and never compared with `metadata.actor.user_id`, then stamped verbatim as `valued_by` / `disposed_by` / `placed_by` / `generated_by` / `acknowledged_by`; a direct-events caller can name a third party as the valuer and acknowledge as themselves, walking past the SoD guard that is "the ENTIRE control over the acquisition rate". Sibling billing shapes pin identity (`jobwork-billing.ts:193, 222`). Fix: mirror the pin in the shape asserts [jobwork-offcut-disposal.ts:291-346]
- [x] [Review][Patch] `MONEY_REGEX` has no integer-width bound, so an oversized rate or rate x quantity product overflows the `NUMERIC(18,4)` money columns as an unclassified SQLSTATE 22003 raw 500; the same commit bounds the order rate at 14 digits (`service-order.ts`) and classifies 22003 on the billing-feed path. Fix: bound the regex and/or classify 22003 on these inserts [jobwork-offcut-disposal.ts:119, 269-278]
- [x] [Review][Patch] `currency` is free-form text (any non-blank value up to 200 chars), never ISO-shaped and never matched against the order's `offcut_currency`, the cited invoice or the superseded document, so a credit note can bill a different currency than the invoice it cites and delta arithmetic can subtract across currencies; `updateOffcutHoldingValuation` never writes `disposal_currency`, leaving the current-value row mixing units after a cross-currency revaluation. Fix: reuse `CURRENCY_REGEX`, require equality with the order and the superseded document, and update `disposal_currency` on revaluation [jobwork-offcut-disposal.ts:310-311, 334-335, 901-951]
- [x] [Review][Patch] None of the three new events requires `stream_id` to equal the payload `service_order_id` (the billing-feed shape enforces it, `jobwork-billing.ts:231`), so an event can be stored on order A's stream while mutating order B. Fix: add the equality check to the shape assert [jobwork-offcut-disposal.ts:291-346]
- [x] [Review][Patch] The acknowledgment applier never checks the target is the LATEST document on its holding, so a superseded original/delta can be acknowledged while the delta carrying the current commercial value stays pending. Fix: refuse when a later document supersedes the target [jobwork-offcut-disposal.ts:1036-1064]
- [x] [Review][Patch] `raisesCreditNote` keys on the rate being positive, not on the computed value: a tiny quantity x rate product that rounds to `"0.0000"` mints a zero-value `original` credit note, contradicting BSD-5's "nothing to credit" (free retention is the only no-note case), and that phantom document then gates later revaluations. Fix: key on the computed scaled value [jobwork-offcut-disposal.ts:242-244, 786-812]
- [x] [Review][Patch] `location_id` is mandatory on `acquired` even though the event contract documents it as `returned`-only, and it is never compared with the holding row's own `location_id`, so a wrong-bin disposal fails late as a misleading class-scoped `INSUFFICIENT_STOCK` after the DOA checks. Fix: derive from or compare against the holding row [jobwork-offcut-disposal.ts:228, 606, 640-710]
- [x] [Review][Patch] Reusing one `disposal_id` across two `acquired` disposals of different holdings survives every gate and dies on the `qc_quality_hold` primary key as an unclassified 23505 raw 500; `insertQcQualityHold` is not duplicate-classified. Fix: wrap in `classifyDuplicate` or pre-check [jobwork-offcut-disposal.ts:725-739]
- [x] [Review][Patch] `acknowledged_ref_ext` (and the return challan number) are stored untrimmed even though `assertText` only checks the trimmed value, so citations can carry leading/trailing whitespace and break exact-match round-trips; the billing path rewrites the trimmed value (`jobwork-billing.ts:221`). Fix: store the trimmed value [jobwork-offcut-disposal.ts:279-289, 1048-1056]
- [x] [Review][Patch] `offcut_contract_ref_ext` accepted at confirm has no type or length gate and `null` silently clears a reference recorded at creation; the value is later rendered into statutory return documents. Fix: validate shape at confirm [service-order.ts:239-252, 809-818]
- [ ] [Review][Follow-up] The full two-step CFO signature from decision 1, Option A: the above-band acquisition must be recorded pending the CFO's signature and the resolved `cfo` must approve through their own authenticated action before title transfers. This needs a persisted proposal event/state, a role-gated CFO approval action and revised route and test arms - a change of its own (recommend `create-story`), not a patch on the reviewed single-event contract. The bearer-key leak that made the current form exploitable is already removed (interim above).

### Chunk B Findings (schema/events/projections) - 2026-09-06

Chunk B scope: the ten schema/events/projection files. Note: the applied chunk-A patches are inside the diff (holding `clock_reconciled_qty`, revaluation `disposal_currency`, audit plumbing), so they were re-audited here.

APPLIED 2026-09-06 (chunk B apply-every-patch): all six chunk B patches shipped (pointer-based latest-document selection, credit-note constraint classification, malformed-UUID accessor guards, tightened credit-note lifecycle/money CHECKs, holding status-gated + money CHECKs, supersede FK, schema payload nullability), mirrored in `init-db.sql` and verified by the schema-drift guard. The two DECISION findings below stay open for a separate call. Verification: tsc clean, eslint clean, story-9-7 28/28, schema-drift + 9-6 + 1-9 186/186, unit 512/512.

- [x] [Review][Patch] The delta chain's "latest document" is the LAST row by `ORDER BY created_at ASC, credit_note_id ASC`, but `created_at` defaults to `now()` - the TRANSACTION start time. Two revaluations of one holding serialize on the order advisory lock AFTER their transactions begin; the one that began first but lost the lock inserts a delta stamped EARLIER than the one it superseded, and the next revaluation chains off the wrong document and computes `delta_value` against the wrong base. Fix: derive the latest by the supersede pointer (the document no other row supersedes) instead of by timestamp, keeping the existing lock serialization [job_work_credit_note.ts:146-162, job_work_credit_note.sql:55]
- [x] [Review][Patch] A racing double-submit of the SAME revaluation/acknowledgment event (both pass the uncommitted-peer `alreadyPersisted` read) dies on `uq_job_work_credit_note_source_event` / `job_work_credit_note_pkey` as an UNCLASSIFIED raw PG 500: neither `classifyDuplicate` (custody constraint names only) nor the store's 23505 map knows the new constraints, so the exact case the idempotency seam exists for returns 500 instead of a clean duplicate/replay. Fix: register both constraint names in the store 23505 map and/or widen `classifyDuplicate` [store.ts:1273-2160, job_work_credit_note.ts:86-87]
- [ ] [Review][Decision] AC 8's closed-order arm cannot fire when the clock is FULLY reconciled: the sweep-candidate query filters `status IN ('open','partially_reconciled')` before its closed-order EXISTS arm, and an over-tolerance receipt can fully absorb clock capacity while a retained holding stays outstanding past closure - the exact corner Story 9.5's non-strict reconcile was built for. The holding then ages silently (only the ageing report sees it). Fix options: admit closed-order retained holdings to the sweep independent of clock status, or accept the ageing report as the surface (over-tolerance corner) and document it [jobwork_return_clock.ts:176-191]
- [ ] [Review][Decision] The sweep's retained-offcut notice is (order, sku)-scoped and tells EVERY due clock of that sku that the full retained quantity is "already counted on this clock ... dispose of it to close the exposure" - false for every clock except the one that actually carries the quantity, and for offcut beyond challan capacity it is counted on no clock at all. Fix options: name the originating clock (holding `source_lot_id` to receipt), or soften the notice text to "retained contractual offcut exists on this order - dispose or revalue it" [jobwork-clock-sweep.ts:170-183]
- [x] [Review][Patch] Malformed-UUID guards are missing on the new accessors `markCreditNoteAcknowledged` (no UUID_REGEX guard) and the retained-offcut listers that cast caller-supplied ids into `uuid[]`/`uuid` (`22P02` 500 on a malformed id, while every sibling accessor returns not-found). Fix: mirror the sibling guards [job_work_credit_note.ts:165-178, job_work_offcut_holding.ts:313, 330]
- [x] [Review][Patch] The credit-note lifecycle CHECK does not actually enforce all-or-nothing acknowledgment: the biconditional over "all three NOT NULL" lets a `pending` row carry one or two ack stamps, and nothing requires `acknowledged_at >= created_at`. The single guarded accessor happens to write all three atomically; the constraint should enforce the property its header claims [job_work_credit_note.sql:62-66]
- [x] [Review][Patch] Schema payload types drift: `disposal_value` and `indicative_rate` are typed non-nullable on the `jobwork.offcut_disposed` interface while the applier stores `null` for both on the `returned` branch; the sibling derived fields (`credit_note_id`, `owned_lot_number`) are correctly `string | null`. Fix the type or omit the fields on `returned` [schema.ts:4834-4841]
- [x] [Review][Patch] Schema hardening (three low gaps, no live writer): the holding lifecycle CHECK does not gate the disposal-facts legs on `status = 'retained'` (a retained row could carry disposal money); negative rate/value is not column-gated; a delta's `supersedes_credit_note_id` has no same-holding/order binding. All writes go through guarded accessors today, so these are contract-hardening only [job_work_offcut_holding.sql:124-148, job_work_credit_note.sql:43-59]
- Dismissed (1): the widened lifecycle CHECK invalidating "legacy 9.6-era disposed rows" - the holding table only ever held `retained` rows before 9.7 (disposal did not exist), and the added columns are additive/nullable, so no real migration path violates the new CHECK.

### Chunk C Findings (routes/notify/sync) - 2026-09-06

Chunk C scope: the six route/notify/sync files. Note: the applied chunk-A audit-skip/`CREDIT_NOTE_SUPERSEDED` registrations are inside the diff and were re-audited here.

APPLIED 2026-09-06 (chunk C apply-every-patch): all eight chunk C patches shipped (events-door finance gate for the two valuation event types, replay-target binding + payload-sourced replay subjects on all three routes, replay-status from the replay not the echoed id, acknowledgment retry replaying before the current-scope collapse, `offcutRetained` counted only after a committed outcome, per-route allow-list field refusal, `CREDIT_NOTE_SUPERSEDED` added to `AUDITED_REJECTIONS`, ageing bucket horizon boundary). Verification: tsc clean, eslint clean, story-9-7 28/28 (dual-control and events-door finance-gate arms updated/extended), 9-4/9-5/6-3/6-4 111/111.

- [x] [Review][Patch] The `finance_controller` valuation gate is REST-route-only: `requireFinanceControllerScope` runs solely in the two route handlers, and the direct `POST /api/v1/events` door authorizes on module `jobwork` + `write` alone, so a user holding only a jobwork write grant (e.g. `jobwork_coordinator`) at the order's site can price an acquisition, mint owned stock, raise the credit note and stop the clock through the events door - the exact hold-bypass class the route comment claims is closed. Task 7.2's "naming the price is a finance decision" is unenforced on one of the two doors and no audit records the decision. Fix: gate the two event types on the events door by required role (the `ownership.agreement_set` precedent in events.ts:97-110) or inside the appliers [service-orders.ts:1753-1800]
- [x] [Review][Patch] Idempotency-key replay is not bound to its target on the three routes: a live key reused for a disposal/revaluation on a DIFFERENT order, or an acknowledgment of a DIFFERENT credit note, replays the stored event and the route answers 200/201 - with the response subject (`holding`, `credit_notes`, `credit_note_id`) read from the CURRENT request, so the reply describes a record the caller never touched and the real target stays silent. The 9.5 closure route hardened against exactly this by reading the replayed id from the persisted payload. Fix: compare the stored event's subject (`service_order_id`/`holding_id`/`credit_note_id`) with the request target and refuse mismatches, and serve the response subject from the stored payload [service-orders.ts:1840-1895, 1975-2033]
- [x] [Review][Patch] On those same replays the response status is `persistedId === postingId ? 201 : 200`, so whether a replay reads as "created" depends on whether the client supplied the id, not on whether the event is new - a caller cannot tell a replay from a fresh posting. Fix: decide the status from the replay, not the echoed id [service-orders.ts:1889-1895]
- [x] [Review][Patch] An acknowledgment retry 404s (and is audited as `NOT_FOUND`) when the caller's write grant at the note's site changed since the original success: the second `if (!note || accessDenied)` is unconditional despite the `isRetry` replay promise. Fix: when the stored event matches the request target, replay before re-checking current site scope [service-orders.ts:1966-1998]
- [x] [Review][Patch] `offcutRetained` is incremented before the row's outcome is known, so a raced breach (`skippedRaced`) or a rolled-back emit still counts the clock as one whose notice named retained offcut, and a retried row is counted again next tick. Fix: increment only after the notice/breach write commits [jobwork-clock-sweep.ts:183, 217-225, 277-285]
- [x] [Review][Patch] The three routes accept-but-ignore body fields the events door refuses: `site_id` naming a different site is silently overwritten from the order on the valuation routes, and revaluation/acknowledgment requests silently drop fields that belong to the other routes (disposition, challan, rate, disposal_id ...) - answered 201/200 instead of the `INVALID_PARAMS` the identical payload draws on the direct door. Fix: per-route allow-list refusal of non-caller fields (the `rejectUnacceptedFields` deny-list is not symmetric) [service-orders.ts:1820, 1862, 1951-1959]
- [x] [Review][Patch] `CREDIT_NOTE_SUPERSEDED` is not actually in `AUDITED_REJECTIONS` (only in `APPLIER_SELF_AUDITED_CODES`), so the route-level backstop the chunk-A record claims does not exist for that code - coverage rests solely on the applier's self-audit. Add it to the set (the route skip already excludes it, so nothing double-audits) [service-orders.ts:139-142]
- [x] [Review][Patch] The ageing report buckets retained holdings by `90 - age_days` with runway 0 reading as `due_within_30` and only negative runway as `breached`, so a holding retained exactly the full horizon is reported as "due within 30 days" and `beyond_90` is dead code; the labels read as time-to-deadline for a ledger that carries none. Fix the boundary semantics and drop the dead band [service-orders.ts:1325, 1395, 1415-1434]
- Clean: no double-audit on the new routes (skip set matches `APPLIER_AUDITED_CODES`); en.json has no duplicates and all codes match `upload.ts` and the server sets; server.ts route ordering is safe; the billing-feed adapter diff is comment-only; AC 9's ageing block is site-scoped and retained-only.

### Chunk D Findings (tests) - 2026-09-06

Chunk D scope: the five test files. Coverage was checked against every applied chunk A/B/C patch guard plus the AC/task matrix.

APPLIED 2026-09-06 (chunk D apply-every-patch, PARTIAL): D1 (dual-control fixture cleanup), D3 (DOA fixture band/role), D4 (replay cross-target arms) and D6 (per-route allow-list refusal arms) shipped with the D10 currency_refused predicate arm; story-9-7 now 30/30, predicates 14/14. D2/D5/D7/D8/D9 and the remaining D10 sub-arms (ageing boundary, SUPERSEDED-in-AUDITED observability, offcutRetained raced path) remain OPEN - the D10 bullet below stays unchecked and is partial.

- [x] [Review][Patch] The dual-control fixture leaks a GLOBAL role mutation: the resolved `cfo` user is granted `finance_controller` at `*` and never cleaned up, contaminating later authorization and segregation tests (and subsequent runs on the same DB). Fix: remove the assignment in a finally/after [story-9-7.test.ts:1401-1405]
- [ ] [Review][Patch] Weak/false-green assertions: the stock-class issue-bar arms accept any `>= 400` (a 404/500/RBAC error passes without proving `SOURCE_DOCUMENT_REQUIRED`); the AC 8 "closed order" arm accepts `[200, 409]` for the closure attempt so the order may never close and the closed-order sweep arm is unexercised; the ageing report arm reads the body before asserting status; `offcutRetained >= 1` cannot detect a doubled count; the clock-reconcile comparison floats `NUMERIC` strings through `Number()`; the offcut-holdings GET arm is satisfied by any disposed holding rather than the requested order's. Fix each to assert the exact code/row [story-9-7.test.ts:956, 1577, 1549, 1591, 1085, 1787-1790]
- [x] [Review][Patch] The DOA fixture resolves the approver as the OLDEST active entry by transaction type without matching the value band or asserting the `cfo` role, so stale overlapping entries can approve against the wrong authority or make the suite order-dependent. Fix the helper to match band and role [story-9-7.test.ts:422-425, 847-861]
- [x] [Review][Patch] No test refuses an idempotency key reused for a DIFFERENT target: a disposal/revaluation key replayed against another order or holding, or an acknowledgment key replayed against another credit note, never draws the stored-payload binding refusal; deleting the guard keeps the suite green. Add the mismatch arms (and assert the response subject comes from the STORED event) [story-9-7.test.ts:1735-1763]
- [ ] [Review][Patch] Direct-events door gaps for guards that are only proven at the route door: an `acquired` priced disposal by a non-finance actor (the finance gate arm only tries `returned`); the finance gate SITE sub-check (finance holder scoped to site B posting site A); the currency equality guards; the payload-site binding (site-B actor posting a site-A event); `CREDIT_NOTE_UNCITABLE`, `OFFCUT_NOT_RETAINED` and `CREDIT_NOTE_SUPERSEDED` door arms; the revaluation finance gate and revaluation `posted_by` pin on both doors; the events-door self-audit row for every `APPLIER_AUDITED_CODES` code (only SOD_VIOLATION is asserted today). Add the arms [story-9-7.test.ts:1445-1458, 1656-1667, 1681, 1704-1716, 1832]
- [x] [Review][Patch] Per-route allow-list refusals are never asserted: `site_id` on offcut-disposals/offcut-revaluations, `return_challan_number_ext` on a revaluation, and `rate`/`site_id` on the acknowledgment route should all draw `INVALID_PARAMS` but no arm sends them. Add the three failing arms [service-orders.ts:1849-1855, 2014]
- [ ] [Review][Patch] The acknowledgment-replay-after-grant-change branch is dead in tests (every ack fixture is wildcard-scoped): move a site-scoped grant between a successful ack and its retry and assert the 200 replay. Also pin the replay 200-vs-201 semantics for a retry that echoes its own id [story-9-7.test.ts:1273-1330]
- [ ] [Review][Patch] Untested arithmetic/lifecycle boundaries: a clock SHORTFALL (over-tolerance receipt leaves `clock_reconciled_qty < quantity` on the disposed row); `disposal_id` reuse across two different acquired holdings (QC-hold PK collision path); an in-range 14-digit rate times a large quantity overflowing `NUMERIC(18,4)` (the 22003 classification arms are dead code to the suite); a positive rate x tiny quantity rounding to `"0.0000"` (the P9 computed-value gate, end to end); acknowledging an earlier DELTA in a two-delta chain (P8 beyond the original). Add the arms [jobwork-offcut-disposal.ts:243-253, 912-933, 973, 985-989, 1012-1064]
- [ ] [Review][Patch] The chunk B pointer-based latest-document fix is not mutation-worthy (serial revaluations cannot distinguish it from `created_at` ordering) and the schema-drift pins omit the new money CHECKs, the supersede FK and the standalone clock-column upgrade. Fix: seed a pointer-latest doc with an EARLIER `created_at` and assert it is selected; extend the drift pins with negative arms [job_work_credit_note.ts:164-208, schema-drift.test.ts:1844-2007]
- [ ] [Review][Patch] Small coverage holes: the ageing horizon boundary (90 days to `breached`, 89 to `due_within_30`, `beyond_90` dead for offcut); the `currency_refused` predicate arm (returned with a currency and no rate); `CREDIT_NOTE_SUPERSEDED` in `AUDITED_REJECTIONS` is unobservable (only its presence in the applier set is caught); the `offcutRetained` raced/rolled-back path. Add the arms [service-orders.ts:1420-1422, jobwork-offcut-disposal.ts:298, 219-236]
- Clean: AC 1-9 each have at least one mutation-worthy green arm on at least one door; Tasks 1.3/4.2/4.12/7.2/9.3/9.4 have their two-point mutation arms; the open items (Task 1.4 first, Task 0.4) are correctly NOT covered by tests pretending they are done; the story-9-6 additions and story-1-9 spine allowlist are clean.

### Chunk E Findings (docs) - 2026-09-06

Chunk E scope: the four documentation files. Cross-checked against code and test-run truth.

APPLIED 2026-09-06 (chunk E apply-every-patch): all nine chunk E patches shipped (baseline reconciled, stale gate counts superseded, sprint-status 9-7 narrative and header updated, ASCII arrows removed, CRLF wording corrected, deferred-work and mutation-verification tables captioned and named, duplicate Task 1.4 renumbered to 1.5, sprint-status 9-6 indent and group-C summary aligned). The Review Findings reorganization (chunk A bullets under their own heading) was shipped during recording.

- [x] [Review][Patch] Eleven of the thirteen chunk A finding bullets physically sat under the `### Chunk C Findings` heading (introduced when the chunk B/C sections were inserted after the top two bullets), so the chunk A "12 of 13 shipped" claim could not be traced and the chunk C summary (8 patches) contradicted the 20 checked bullets beneath it. FIXED 2026-09-06 during recording: the section is reorganized with a `### Chunk A Findings (compliance)` heading carrying all thirteen chunk A bullets and the follow-up; chunk C keeps only its eight.
- [x] [Review][Patch] Front matter `baseline_commit: 502b664...` contradicts the intro's unchanged "Baseline: branch `chore/9-6-reversal-and-noise-floor` at `c8520c2`". Reconcile the intro line to the baseline the review actually used [9-7 story:2, 11]
- [x] [Review][Patch] The Debug Log "Gates" line and Change Log report STALE pre-review counts (story-9-7 22/22, unit 509/509, 9-6 20, FULL SUITE 1966/1966) that contradict the review sections' own post-review counts (28/28, 512/512, 22/22). Update to the verified numbers [9-7 story:297-301, 364]
- [x] [Review][Patch] The sprint-status 9-7 entry is frozen at create-story (ends "Blocked on the Story 9.6 reversal landing first ... two open questions carried") while its status is `review`; the header `last_updated` summary still says "9-7 in-progress". Update the narrative and header to record implementation + the chunk A/B/C review outcome and the open items [sprint-status.yaml:2-4, 1113]
- [x] [Review][Patch] Six ASCII `->` sequences in prose violate FORMATTING_RULES (decision 1 -> Option A, baseline `502b664` -> working tree x2, `source_lot_id` -> receipt, decision 2 -> Option B, decision 3 -> Option A). Convert to "to" [9-7 story:374, 379, 386, 395, 408-409]
- [x] [Review][Patch] Task 2.5, Table 1 and the Project Structure Notes claim the SQL is mirrored "with CRLF" into `deploy/compose/init-db.sql`, but the file is LF (disclosure 9 already concedes); the checked box describes an action that was never performed. Correct the wording to LF [9-7 story:66, 173, 201]
- [x] [Review][Patch] The new deferred-work table has no caption and is never referenced by name, breaking the file's Table 1-8 numbering convention (next would be Table 9). Add the caption and a prose reference [deferred-work.md:575-580]
- [x] [Review][Patch] The 9-7 mutation-verification table has no `Table N:` name and the lead-in does not reference it by name (sibling tables are all named). Add it [9-7 story:289-295]
- [x] [Review][Patch] Two sibling subtasks under Task 1 are both numbered "1.4" (one open, one `[x]`); unique ids are needed for the decision-to-patch trail (the Debug Log already disambiguates them as "the first/second one"). Renumber [9-7 story:53, 59]
- [x] [Review][Patch] The sprint-status 9-6 entry key was re-indented from 2 to 5 spaces, out of level with its siblings; restore 2-space nesting. Also the 9-6 group-C summary names an `updateServiceOrderFields` ref arm that is not among the nine group-C patches the 9-6 story records - align the summary with that list [sprint-status.yaml:1112]
- Clean: every applied-status note matches the code (decision 1 interim only, both chunk B decisions genuinely open, all marked-applied guards present in the working tree); the party-mode resolutions (1 to A, 2 to B, 3 to A with the interim-regardless condition) are faithfully recorded; the deferred-work ledger has no applied-but-still-listed entries; the 9-6 story and its group-C record agree; the verification counts were reproduced exactly by running the suites.
