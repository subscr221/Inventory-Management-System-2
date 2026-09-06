# Story 9.7: Offcut Holding, Disposal and Valuation

Status: ready-for-dev

Epic: 9 (Job Work and Subcontracting)
Story key: `9-7-offcut-holding-disposal-and-valuation`
Functional requirements: FR-JW-09/10, FR-JW-12, FR-JW-13, FR-JW-14, FR-AC-11
Baseline: branch `chore/9-6-reversal-and-noise-floor` at `c8520c2`, working tree clean. Story 9.6 is implemented and its offcut half is REVERSED per `sprint-change-proposal-2026-09-05.md`.

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
  - [ ] 0.5 The integration suite for this story seeds its own two fixture users the same way; never the same user, never the acting coordinator.
  - [ ] 0.6 Add both roles to `_bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md` rows only if the file still lacks them; do not restate rulings already recorded there.

- [ ] **Task 1: close the offcut issue hole in the segregation bar (AC 1, AC 2, AC 3; PREREQUISITE, do first after Task 0)**
  - [ ] 1.1 `src/compliance/stock-balance.ts:373-392`: the segregated-class issue/allocation bar keys on `stockClass === JOB_WORK_STOCK_CLASS` ONLY. `offcut` is in `SEGREGATED_STOCK_CLASSES` (so the laundering bar covers receipts) but is NOT barred from issue or allocation, so customer-owned retained offcut can today be picked into any sales dispatch. Widen the arm to `stockClass === JOB_WORK_STOCK_CLASS || stockClass === OFFCUT_STOCK_CLASS`.
  - [ ] 1.2 Mint ONE new Symbol door, `CUSTODY_OFFCUT_DISPOSAL`, exported from `src/compliance/custody-ledger.ts` beside `CUSTODY_CONSUMPTION` (`:73`) and `CUSTODY_RETURN` (`:84`), with an `isCustodyOffcutDisposalHandoff` predicate matching the two existing ones. The `offcut` arm admits ONLY that Symbol; `CUSTODY_RETURN` must NOT open the offcut class (that door belongs to `job_work` material returning under a Rule 45 challan, a different physical fact).
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
  - [ ] 1.4 `src/compliance/cycle-count.ts:91` duplicates `SEGREGATED_STOCK_CLASSES` verbatim and already lists `offcut`; confirm no change is needed and say so in the Debug Log.

- [ ] **Task 2: schema (AC 1, AC 3, AC 4, AC 5, AC 6)**
  - [ ] 2.1 `read/projections/job_work_offcut_holding.sql`: `ADD COLUMN IF NOT EXISTS` the disposal facts - `disposed_by UUID`, `disposal_rate NUMERIC(18,4)`, `indicative_rate NUMERIC(18,4)`, `disposal_currency TEXT`, `disposal_value NUMERIC(18,4)`, `approved_by UUID`, `doa_entry_id UUID`, `return_challan_number_ext TEXT`. Every one is NULL while `status = 'retained'`.
  - [ ] 2.2 Widen `chk_job_work_offcut_holding_lifecycle` with DROP-then-ADD (the file's own stated rule, never add-if-absent) so that `status = 'disposed'` also requires `disposed_by`, and so that `disposition = 'acquired'` requires `disposal_rate`, `disposal_currency` and `disposal_value` non-null while `disposition = 'returned'` requires all three NULL and `return_challan_number_ext` non-null.
  - [ ] 2.3 NEW `read/projections/job_work_credit_note.sql` following the `job_work_billing_feed.sql` lifecycle shape: `credit_note_id UUID PK`, `service_order_id`, `holding_id`, `document_kind TEXT CHECK IN ('original','delta')`, `supersedes_credit_note_id UUID` (NULL on `original`, mandatory on `delta`), `cited_invoice_ref_ext TEXT NOT NULL` (the feed's `acknowledged_ref_ext`), `rate NUMERIC(18,4)`, `indicative_rate NUMERIC(18,4)`, `currency`, `value NUMERIC(18,4)`, `delta_value NUMERIC(18,4)` (NULL on `original`), `status TEXT CHECK IN ('pending','acknowledged')`, `acknowledged_at`, `acknowledged_by`, `acknowledged_ref_ext`, `valued_by UUID NOT NULL`, `site_id`, `source_event_id UUID NOT NULL`, `created_at`, `updated_at`. Unique on `source_event_id`; plain (NOT unique) index on `cited_invoice_ref_ext` and on `acknowledged_ref_ext` - both are citations, not identities (the group-A ruling that this story is the first consumer of).
  - [ ] 2.4 Lifecycle CHECK on the credit note: `(status = 'acknowledged') = (acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL AND acknowledged_ref_ext IS NOT NULL)`. There is deliberately no `void` or `exception` state: a wrong value is corrected by a `delta` row, never by mutating or voiding (the 9.6 feed-header ruling, carried forward).
  - [ ] 2.5 Own grants in guarded `DO` blocks (`app_user`: INSERT, SELECT, UPDATE; `readonly_user`: SELECT), every statement idempotent, register the new file in `src/events/migrate.ts` beside `job_work_offcut_holding.sql` (`:260`), and mirror BOTH files into `deploy/compose/init-db.sql` with CRLF in the same commit.
  - [ ] 2.6 `src/read/projections/job_work_offcut_holding.ts`: extend `JobWorkOffcutHoldingRow`, add `getRetainedHoldingForUpdate(holdingId, client)` (SELECT ... FOR UPDATE) and `markOffcutHoldingDisposed(input, client)` as a GUARDED UPDATE (`WHERE holding_id = $1 AND status = 'retained'`) returning whether it matched. Add `listRetainedOffcutHoldings({ siteIds, today })` for the sweep and the report.
  - [ ] 2.7 NEW `src/read/projections/job_work_credit_note.ts` with `insertCreditNote`, `getCreditNoteById` (malformed UUID returns null, the `getBillingFeedById` precedent), `listCreditNotesByOrder`, `markCreditNoteAcknowledged` (guarded on `status <> 'acknowledged'`).
  - [ ] 2.8 Pin every new table, column and FULL index statement in `test/unit/schema-drift.test.ts`. Do not "fix" the pre-existing CRLF pins.

- [ ] **Task 3: event contract (AC 1, AC 3, AC 5, AC 6)**
  - [ ] 3.1 `src/events/schema.ts`: three new payload interfaces on the `jobwork` stream (BSD-2), `JobworkOffcutDisposedPayload`, `JobworkOffcutRevaluedPayload`, `JobworkCreditNoteAcknowledgedPayload`, each with its `...Envelope` type, each documenting which fields are caller-supplied and which are server-derived.
    - `jobwork.offcut_disposed`: caller supplies `service_order_id`, `disposal_id`, `holding_id`, `site_id`, `disposition`, and on `acquired` `rate` plus `currency` and optionally `approved_by`; on `returned` `return_challan_number_ext` and `location_id`. Server-derived and REFUSED on input: `disposal_value`, `indicative_rate`, `credit_note_id`, `owned_lot_number`, `clock_reconciled_qty`.
    - `jobwork.offcut_revalued`: `service_order_id`, `revaluation_id`, `holding_id`, `site_id`, `rate`, `currency`, optional `approved_by`; server-derives `delta_value`, `credit_note_id`, `supersedes_credit_note_id`.
    - `jobwork.credit_note_acknowledged`: `service_order_id`, `credit_note_id`, `site_id`, `acknowledged_ref_ext` (mandatory), `acknowledged_by`.
  - [ ] 3.2 Register all three in `SUPPORTED_EVENT_TYPES` and wire the three appliers into the `src/events/store.ts` transaction chain in existing chain order.
  - [ ] 3.3 While in `schema.ts`, correct the STALE doc comments the reversal left behind: the `CustodyOffcutRecordedPayload` header (`:4680-4690`) still describes three branches, `offcut_rate_estimate` and `settles_offcut`, and the `JobworkBillingFeedGeneratedPayload` header still names an offcut-settlement precondition. Both describe code that no longer exists. Comment-only edit, no behaviour change.

- [ ] **Task 4: disposal applier, NEW file `src/compliance/jobwork-offcut-disposal.ts` (AC 1, AC 2, AC 3, AC 4, AC 7)**
  - [ ] 4.1 Header comment stating the lock order verbatim (advisory lock on the order, order row FOR UPDATE, holding row FOR UPDATE, then stock, then clocks, then the holding and credit-note rows LAST) and why the order accepts `closed` (BSD-3).
  - [ ] 4.2 Pure predicate `offcutDisposalOpen(holding, disposition)` returning the first failing reason, parameterised so unit tests can fail it (the 8.4 lesson). Refuses a non-`retained` row with the NEW code `OFFCUT_NOT_RETAINED` (409).
  - [ ] 4.3 Order gate: re-read the order under the advisory lock; accept `in_process` OR `closed` (BSD-3). Do NOT call `requireInProcessOrder` - it would make every offcut undisposable the moment the order closed, which is exactly the lifecycle the holding ledger exists to support.
  - [ ] 4.4 Branch `returned`: issue the offcut-class stock through the new `CUSTODY_OFFCUT_DISPOSAL` Symbol door (Task 1), require `return_challan_number_ext`, render documents (Task 4.8), write NO credit note, write NO owned receipt.
  - [ ] 4.5 Branch `acquired`: DOA check (Task 4.7) first, then issue the offcut-class stock through the same Symbol door, then MINT A NEW LOT and post an ordinary `owned` receipt through the compliance seam - never `applyStockReceipt` directly, the 2026-09-06 fix in `jobwork-offcut.ts`. Lot number `${order.order_number_ext}-${order.site_id.slice(0,8)}-OA${sequence}`; wrap `createLot` in `classifyDuplicate` for the global-uniqueness collision. A new lot is mandatory: the laundering bar is lot-ROW based and refuses an `owned` receipt on any lot that has ever held an `offcut` row, regardless of `on_hand`.
  - [ ] 4.6 QC hold on the minted owned lot (AC 3), delegated to `receiveQcCompletion` on the SAME transaction, copying `src/compliance/jobwork-output.ts:230-300`. `source_completion_type: 'job_work_order'` is already in `SOURCE_COMPLETION_TYPES` (`quality.ts:675-680`); do not add a vocabulary value. The material was only ever inspected as the customer's, against the customer's specification.
  - [ ] 4.7 DOA second signature (AC 7): `resolveApprover('jobwork.offcut_acquisition', disposalValue)` from `src/api/v1/indents.ts:66`. If `requiresApproval` and `approverActorId === null`, refuse `APPROVAL_UNRESOLVED` (409). If `p.approved_by !== approval.approverActorId`, refuse `APPROVAL_REQUIRED` (403). Then refuse `APPROVAL_REQUIRED` when `approved_by === envelope.metadata.actor.user_id`: this is DUAL CONTROL, so the acting user must NOT be the approver. This INVERTS the 9.4 over-norm-loss acting-user check (`custody-ledger.ts:1093`), which requires them to be the same person - copy the shape, invert the comparison, and say so in a comment or the next reviewer will read it as a transcription bug. When the value is below every band `findMatchingDoaEntry` returns no entry and the disposal proceeds unapproved; a claimed `approved_by` in that case is refused `INVALID_PARAMS` rather than silently dropped (the 9.4 symmetric refusal).
  - [ ] 4.8 Documents (AC 2): render plain text in this module and store through the generic `dispatch_document` table keyed by `service_order_id`, copying `renderJobWorkDispatchDocuments` (`jobwork-dispatch.ts:232-265`). Use ONLY the four allowed `document_type` values (`bol`, `packing_slip`, `commercial_invoice`, `label`) - the return challan is the `commercial_invoice` slot, exactly as 9.4 does it. Do NOT widen `chk_dispatch_document_type` and do NOT import the Story 3.7 renderers (BSD-6).
  - [ ] 4.9 Stop the clock (AC 1) on BOTH branches: `reconcileReturnClocks({ category: 'offcut', counter: 'reconciled_qty', strict: false })`, the forward-declared and still-unused path at `jobwork-return-clock.ts:167`. Non-strict for the reason the 9.5 chunk-2 review settled: clock capacity is `challan_qty` while the holding quantity derives from the received balance, which an over-tolerance receipt may exceed.
  - [ ] 4.10 Credit note (AC 3, AC 4): on `acquired` with `rate > 0`, insert ONE `original` credit note citing the order's acknowledged billing-feed reference. A rate of exactly zero is a contractual free retention: mint the lot, write NO credit note, and record the zero rate on the holding row (BSD-5). Store `indicative_rate` from `service_order.offcut_rate` beside the negotiated rate; apply NO tolerance and refuse NOTHING on rate (AC 4, the final 2026-09-05 ruling).
  - [ ] 4.11 Credit note precondition: the order must have an acknowledged billing feed carrying `acknowledged_ref_ext`, or there is no invoice to credit. Refuse the NEW code `CREDIT_NOTE_UNCITABLE` (409, with `details.reason`) rather than inventing a placeholder reference.
  - [ ] 4.12 Close the holding row through the guarded UPDATE; a zero-row result means a concurrent disposal won, so refuse `DUPLICATE_EVENT` rather than reporting success (the 9.5 sweep's `skippedRaced` lesson, applied to a write path).
  - [ ] 4.13 Every money figure settles through the scaled-decimal helpers in `src/compliance/custody-statement.ts:20-59`. No `Number()` on a NUMERIC string anywhere.

- [ ] **Task 5: revaluation applier (AC 5)**
  - [ ] 5.1 `jobwork.offcut_revalued` on a `disposed` + `acquired` holding row. Refuses `OFFCUT_NOT_RETAINED`'s sibling condition with `INVALID_PARAMS` when the row is still retained or was `returned`.
  - [ ] 5.2 Requires an existing `original` credit note for the holding; refuses the NEW code `CREDIT_NOTE_MISSING` (409) otherwise.
  - [ ] 5.3 Inserts a `delta` credit note with `supersedes_credit_note_id` set and `delta_value = new_value - latest_value` (signed, may be negative). NEVER updates the original row and NEVER updates a previously acknowledged delta. A second revaluation chains off the latest delta.
  - [ ] 5.4 Updates the holding row's `disposal_rate` and `disposal_value` to the current commercial value, leaving `indicative_rate` untouched. State plainly in the header that the DOCUMENT trail is immutable while the holding row carries the current value; that is the distinction AC 5 draws.
  - [ ] 5.5 The DOA band applies to the revalued acquisition value on the same terms as Task 4.7.

- [ ] **Task 6: credit-note acknowledgment applier (AC 6)**
  - [ ] 6.1 `jobwork.credit_note_acknowledged` flips `status` to `acknowledged` and stamps `acknowledged_at`, `acknowledged_by`, `acknowledged_ref_ext` (mandatory, non-empty, `MAX_TEXT_LENGTH` 200).
  - [ ] 6.2 SoD (AC 6): refuse `SOD_VIOLATION` (403) when `acknowledged_by` or the acting user equals the credit note's `valued_by`. Copy `jobwork-billing.ts:531`. With no rate band anywhere (the 2026-09-05 ruling removed it), this guard carries the ENTIRE control over the acquisition rate. Do not weaken it, do not make it configurable.
  - [ ] 6.3 Guarded UPDATE on `status <> 'acknowledged'`; a second acknowledgment is `DUPLICATE_EVENT`.

- [ ] **Task 7: routes, RBAC, registration (AC 1, AC 3, AC 5, AC 6, AC 7)**
  - [ ] 7.1 `POST /api/v1/service-orders/:serviceOrderId/offcut-disposals`, `POST /api/v1/service-orders/:serviceOrderId/offcut-revaluations`, `POST /api/v1/jobwork/credit-notes/:creditNoteId/acknowledgment`, `GET /api/v1/service-orders/:serviceOrderId/offcut-holdings`. All in `src/api/v1/service-orders.ts`, all `requireRole({ module: 'jobwork', functionScope: ... })`, all with `requireIdempotencyKey`, `rejectUnacceptedFields` symmetric on server-derived fields, path-id equals body-id, `assertSiteWriteAccess` against the ORDER's site re-checked on retries as well (the 9.5 chunk-3 fix).
  - [ ] 7.2 Role gate above RBAC on the two write routes that set value: posting a disposal or a revaluation requires the `finance_controller` role, derived from the SAME assignment that supplies the site scope (the `CHALLAN_RECLASSIFICATION_ROLES` shape at `service-orders.ts:1240`, including its privilege-and-scope-from-one-assignment fix). Refuse `FUNCTION_ACCESS_DENIED` (403).
  - [ ] 7.3 Register the STATIC `/api/v1/jobwork/credit-notes/...` segment BEFORE every parameterised `/service-orders/:serviceOrderId/...` route in `src/server.ts:1051-1073`, the recorded lesson at that comment.
  - [ ] 7.4 Add the new codes to `AUDITED_REJECTIONS` (`service-orders.ts:79`): `OFFCUT_NOT_RETAINED`, `CREDIT_NOTE_MISSING`, `CREDIT_NOTE_UNCITABLE`. `SOD_VIOLATION`, `APPROVAL_REQUIRED`, `APPROVAL_UNRESOLVED` and `FUNCTION_ACCESS_DENIED` are already there.
  - [ ] 7.5 Add the three new codes to `src/sync/upload.ts` `PERMANENT_ERROR_CODES` and `edge/src/messages/en.json`, defensively (no edge scope in this story - disposal and valuation are office actions), the 9.4 through 9.6 precedent.
  - [ ] 7.6 Add all four routes to the Story 1.9 spine allowlist in `test/integration/story-1-9.test.ts`.

- [ ] **Task 8: sweep and reports (AC 8, AC 9)**
  - [ ] 8.1 Widen the ageing report `GET /api/v1/jobwork/reports/aging` (`service-orders.ts:1290`) with an `offcut_holdings` section: every `status = 'retained'` row, site-scoped through the existing `reportSiteScope`, bucketed by age since `captured_at` using the SAME `agingBucketFor` thresholds, carrying `service_order_id`, `offcut_contract_ref_ext`, `sku`, `lot_id`, `quantity`, `uom`, `captured_at`. Acquired and returned rows are excluded by the `retained` filter, which is the whole of AC 9's second half.
  - [ ] 8.2 Widen `runJobworkClockSweepCycle` (`src/notify/jobwork-clock-sweep.ts`) so that a clock's alert and breach `next_step` text names any retained offcut on the same (order, sku), and so that retained offcut whose order has CLOSED still reaches the coordinator. Add `offcutRetained` to `JobworkClockSweepResult`.
  - [ ] 8.3 CRITICAL, do not get this wrong: capture deliberately does NOT reconcile the clock, so the retained quantity is STILL outstanding on `jobwork_return_clock` and already counts toward `deemed_supply_qty`. The clock stays the single accounting authority. The sweep must SURFACE retained offcut, never add it to the deemed-supply arithmetic - double-counting it would overstate the Section 143 exposure on every ITC-04 extract. Assert non-double-counting in a test.
  - [ ] 8.4 No new background cycle and no new advisory key: this rides the existing 6th cycle (`jobwork clock breach`, key 9505). `test/unit/background-cycles.test.ts` pins seven cycles after 9.6 and must stay at seven.

- [ ] **Task 9: tests**
  - [ ] 9.1 NEW `test/integration/story-9-7.test.ts`, serial, run-scoped random suffix, local fixture closures, admin pool for seeding (`app_user` has no DELETE), against the docker container `ims-postgres-test` on port 5442.
  - [ ] 9.2 Arms, one per AC: retained-to-returned with documents and clock stop; retained-to-acquired with owned lot, QC hold, credit note and clock stop; acquired at rate zero minting a lot and raising NO credit note; negotiated rate differing from indicative accepted with both stored; revaluation raising a delta with the original untouched; self-acknowledgment refused `SOD_VIOLATION`; above-band acquisition refused `APPROVAL_REQUIRED` and audited, then accepted with the resolved `cfo`; approver equal to the acting user refused; disposal on a CLOSED order accepted; ageing report showing retained then not showing acquired; sweep surfacing retained offcut without double-counting deemed supply.
  - [ ] 9.3 Two-point mutation verification (the 9.3 through 9.6 standard) on the three load-bearing gates: the SoD refusal, the DOA dual-control refusal, and the Task 1 offcut issue bar. Each mutant must be killed by BOTH a route arm and a direct `POST /api/v1/events` arm.
  - [ ] 9.4 A direct-event bypass arm for each of the three new event types (the hold-bypass class).
  - [ ] 9.5 NEW `test/unit/jobwork-offcut-disposal-predicates.test.ts` for `offcutDisposalOpen`, the delta arithmetic, and the zero-rate branch.
  - [ ] 9.6 Gates before handing over: `tsc`, `eslint`, `prettier`, `npm run db:migrate` twice (idempotent), schema-drift, story-9-1 through story-9-6 and story-1-9 regressions, then the full suite compared against the baseline. The noise floor was ELIMINATED on 2026-09-05: the suite is expected GREEN, and any failure is yours until proven otherwise. Do not reintroduce a tolerated floor.

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
| `deploy/compose/init-db.sql` | CRLF mirror of every canonical SQL file | The new credit-note table and the holding-table columns | Mirror parity |
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

- Seam files stay in `src/compliance/`, sweep and notification code in `src/notify/`, projection accessors in `src/read/projections/`, canonical SQL in `read/projections/` with LF endings and a CRLF mirror in `deploy/compose/init-db.sql` in the same commit.
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

### Debug Log References

### Completion Notes List

### File List

## Change Log

| **Date** | **Change** | **By** |
| --- | --- | --- |
| 2026-09-06 | Task 0 implemented ahead of the rest of the story: `verifySegregatedRoles` plus `npm run verify:roles` and a 7-arm integration suite. Five violation codes, including two hazards the acceptance criteria do not name - a second role banded on the same DOA transaction type (approver resolution falls back across roles) and an active vacation delegation that hands both halves of the pair to one person. Provisioning the real users and the band remains an administrative act against the target environment | dev |
| 2026-09-06 | Story created, status ready-for-dev. Twelve binding scope decisions, six rulings in place of open questions, and one live defect found during analysis and folded in as prerequisite Task 1: the `offcut` stock class is segregated for receipts but not barred from issue or allocation, so customer-owned retained offcut can currently be picked into any sales dispatch | create-story workflow |
