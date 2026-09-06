# Sprint Change Proposal: Offcut Domain Model Reversal

Date: 2026-09-05
Trigger story: Story 9.6, Offcut Election Execution and ERP Billing Feed
Status: APPROVED 2026-09-05. Planning artifacts updated; code reversal and Story 9.7 outstanding.
Baseline commit: 6439870 (Story 9.6 implemented, group-A code review applied)

## Issue Summary

Story 9.6 shipped an offcut model in which the disposition is elected at order confirmation, the
rate is contracted at confirmation, and the offcut is settled, valued, converted to own stock and
billed in a single posting. That model is commercially wrong.

Issue category: misunderstanding of original requirements. The PRD line the epic was built from
(FR-JW-09/10, "Contractual offcut election (return, retain-and-buy, retain free) captured at
confirmation and executed with documents") reads naturally as one decision made up front, and every
downstream artifact inherited that reading. The business reality, ruled by the user on 2026-09-05,
is different in four ways.

1. Offcut is its own asset with its own contract, carrying its own reference number, because it may
   be resold either back to the originating customer or through auction.
2. Captured offcut goes into a separate holding ledger at quantity grain, UNVALUED, and is retained
   there until disposal.
3. Disposal happens later and is one of two branches, both open until that moment: the material is
   RETURNED to the customer as their own property, or it is ACQUIRED by the processor at a rate,
   which transfers title. Ruled 2026-09-05: the processor always buys before it sells and never
   sells on the customer's behalf, so any onward resale (back to the customer, to a scrap buyer, or
   at auction) is an ordinary sale of stock the processor already owns, outside job work.
4. The rate is decided at disposal and is supplied by the `finance_controller` role, not named by
   the coordinator posting the offcut.

Evidence that the two models genuinely conflict, taken from the working tree at the baseline commit:

- `read/projections/service_order.sql` makes `offcut_rate` and `offcut_currency` mandatory at
  confirm whenever `has_contractual_offcut` is true, and the confirm route refuses without them.
  Under the new model no rate exists at that point, and where the disposal is an auction no rate
  can exist even in principle.
- `src/compliance/jobwork-offcut.ts` settles, values, converts to own stock and stamps
  `offcut_settled_at` in one posting, and refuses any second posting on the order.
- `src/compliance/jobwork-billing.ts` refuses billing with reason `offcut_not_settled` until that
  posting has landed, so the service invoice waits on the offcut.
- `src/compliance/jobwork-offcut.ts` calls `reconcileReturnClocks` at capture, stopping the CGST
  Section 143 return clock at the moment the offcut is captured rather than when it is disposed.

Binding answers given by the user on 2026-09-05, which shape everything below:

- Ownership while retained "depends on disposition". Because disposition is unknown until disposal,
  the only implementable reading is fail-closed: the material remains the customer's, the Section
  143 clock keeps running, and disposal is the ownership-transfer event.
- Billing is a credit note raised against the service invoice. The service invoice no longer waits.
- The disposition grain is per order, decided later.
- Valuation happens at disposal and is revisable afterwards through a delta document.
- Captured offcut leaves the custody ledger at capture and enters the holding ledger, so custody
  reaches zero and the order can still close.

## Impact Analysis

### Epic impact

Epic 9 can still be completed, but not as currently written. The epic's job-work narrative is
unaffected; three of its stories carry acceptance criteria that state the superseded model as fact.
No epic is obsoleted, no new epic is required, and no resequencing of other epics is implied.
Epics 10 through 13 are untouched: a search of the planning artifacts finds offcut referenced only
in the PRD functional requirement, the Epic 9 stories, and the access matrix.

### Story impact

Table 1 lists every story whose acceptance criteria or implementation is affected.

Table 1: Story impact

| **Story** | **State** | **Impact** |
| --- | --- | --- |
| 9.4 | done, committed | AC captures the offcut election at confirmation. The election moves to disposal, so this AC is withdrawn and the confirm gate reduces to recording that the order will produce contractual offcut |
| 9.5 | done, committed | The closure gate still works, because offcut now leaves custody at capture. The breach sweep must be widened to read the holding ledger, or long-held offcut becomes invisible deemed supply |
| 9.6 | review, committed at 6439870 | Offcut half largely reversed. Billing half survives, minus the offcut precondition |
| 9.7 (new) | proposed | Offcut holding, disposal, valuation and the credit note |

### Artifact conflicts

Table 2 names each planning artifact requiring an edit.

Table 2: Artifact conflicts

| **Artifact** | **Location** | **Conflict** |
| --- | --- | --- |
| PRD | `prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md` line 245 | FR-JW-09/10 says the election is captured at confirmation and executed with documents |
| Epics | `epics.md` line 134 | Duplicates the same FR-JW-09/10 wording |
| Epics | `epics.md` Story 9.4 acceptance criteria | Election captured on confirm |
| Epics | `epics.md` Story 9.6 acceptance criteria 1 to 3 | Immediate execution at a contracted rate |
| Epics | `epics.md` Story 9.6 dev notes | Executing the election is a precondition for the 9.5 closure gate |
| Access matrix | `access-matrix-frontline-draft-2026-07-11.md` lines 82, 90, 203 | `jobwork_coordinator` owns offcut election capture; `finance_controller` is scoped to migration sign-off and valuation views with period ops deferred to Epic 11 |

The architecture spine (`ARCHITECTURE-SPINE.md`) contains no offcut reference and needs no change.
There are no UI/UX specifications for this flow. Deployment, IaC, monitoring and CI artifacts are
unaffected beyond the schema files that travel with the code.

### Technical impact

Reversals required in code, all within Epic 9 modules:

- `read/projections/service_order.sql` and its `init-db.sql` mirror: `offcut_rate` and
  `offcut_currency` stop being confirm-time mandatory but are RETAINED, re-read as the offcut
  contract's indicative buy-in rate (ruling of 2026-09-05). Nothing may require them at confirm,
  because the offcut contract may be made after the service order is confirmed.
- `src/compliance/service-order.ts`: the confirm gate demanding the rate pair is withdrawn.
- `src/compliance/jobwork-offcut.ts`: capture stops converting to own stock, stops valuing, stops
  billing, and stops calling `reconcileReturnClocks`. It becomes a drain from custody into the
  holding ledger.
- `src/compliance/jobwork-billing.ts`: the `offcut_not_settled` billing precondition is removed.
- `src/adapters/erp/job-work-billing-feed.ts`: `offcutRateOutOfBand`, the
  `OFFCUT_RATE_OUT_OF_BAND` error code and the `JOBWORK_OFFCUT_RATE_TOLERANCE_PCT` knob are
  REMOVED (final ruling of 2026-09-05, superseding an interim choice of a hard band). The
  commercial value is the rate negotiated in reality; the indicative rate is stored beside it so
  the variance is visible, and nothing is refused on rate. With no band, separation of duties is
  the only remaining control over the rate and must not be weakened.

New work required:

- A holding-ledger projection recording captured offcut at quantity grain, unvalued, carrying the
  offcut contract reference, with a retained and disposed lifecycle.
- A capture event that drains custody into the holding ledger and neither values nor converts.
- A disposal event, gated to `finance_controller`, carrying the disposition and, on `acquired`,
  the rate. It returns the material or transfers title, and stops the Section 143 clock at that
  point. It does NOT model resale: once acquired, the material is ordinary owned stock.
- A revaluation event raising a delta document, never mutating an acknowledged one.
- A credit note document with its own lifecycle and acknowledgment, citing the original ERP invoice
  number. This is the first consumer of `acknowledged_ref_ext`, and it vindicates the group-A ruling
  that the column stays a plain, non-unique citation: a unique index there would have blocked
  consolidated invoices and this credit note flow alike.
- Widening the Story 9.5 breach sweep to read the holding ledger.

What survives unchanged: the separation-of-duties principle, retargeted so that the
`finance_controller` who sets the rate may not acknowledge the document that bills it; the custody
drain mechanics; the QC hold placed on any lot that becomes own stock; and the established stance
that corrections are delta documents rather than mutations or voids.

## Recommended Approach

Selected path: hybrid of direct adjustment and partial rollback.

Table 3 records the evaluation of each option.

Table 3: Path evaluation

| **Option** | **Effort** | **Risk** | **Verdict** |
| --- | --- | --- | --- |
| Direct adjustment only | Medium | High | Not viable alone. Amending acceptance criteria does not remove shipped behaviour that actively contradicts the new model, such as the confirm-time rate mandate |
| Partial rollback of the 9.6 offcut half, plus a new story | High | Medium | Recommended. Reverses only what contradicts, keeps the billing feed that survives intact |
| Full rollback of Story 9.6 | High | High | Not viable. The billing feed, measured basis, acknowledgment, dispatch and SoD work are all correct and would be destroyed to no purpose |
| PRD MVP review | Low | Low | Not required. The MVP still stands; one functional requirement is restated, nothing is dropped |

Rationale. The offcut half of Story 9.6 and its billing half are cleanly separable in the codebase:
they live in different modules, and the only coupling between them is the `offcut_not_settled`
billing precondition, which this change removes anyway. Reversing the offcut half while keeping the
billing half therefore costs less than it appears to, and it preserves a reviewed, tested, committed
billing feed. Doing the reversal as a fresh story rather than an in-place rewrite also leaves the
contradiction visible in history, which matters in a system whose audit trail is a deliverable.

MVP impact: none. FR-JW-09/10 is restated, not withdrawn. No scope is deferred.

## Detailed Change Proposals

### PRD

Location: `prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md` line 245.

OLD:

- **FR-JW-09/10** Contractual offcut election (return, retain-and-buy, retain free) captured at
  confirmation and executed with documents.

NEW:

- **FR-JW-09/10** Contractual offcut is captured to a separate holding ledger at quantity grain,
  unvalued, under its own contract reference, and retained until disposal. Disposal (return, sale
  as scrap including by auction, or internal reuse) is elected at disposal time, valued then by the
  finance controller, and executed with documents.

Rationale: the requirement wording is the root of the misreading and must be fixed before the epic
text is derived from it again.

### Epics: functional requirement line

Location: `epics.md` line 134. Same OLD and NEW text as the PRD change above.

### Epics: Story 9.4 acceptance criterion

OLD:

**Given** an order with a contractual offcut arrangement (FR-JW-09/10)
**When** the order is confirmed
**Then** the offcut election (return, retain-and-buy, or retain free) is captured on the order;
execution of the elected disposition is Story 9.6

NEW:

**Given** an order with a contractual offcut arrangement (FR-JW-09/10)
**When** the order is confirmed
**Then** the order records that it carries a contractual offcut arrangement and, where one exists,
the offcut contract reference; no disposition and no rate are elected at confirmation, because both
are decided at disposal (Story 9.7)

Rationale: the election cannot be made at confirmation under the new model, and requiring a rate
there is impossible where the disposal is an auction.

### Epics: Story 9.6 acceptance criteria 1 to 3

OLD: the three criteria beginning "Given an order with offcut election `return`", "... `retain-and-buy`"
and "... `retain free`", each executing the disposition immediately, the retain-and-buy one raising
"a billable line at the contracted rate".

NEW, replacing all three with one:

**Given** processing that produces contractual offcut (FR-JW-09/10)
**When** the offcut quantity is captured
**Then** the quantity leaves the custody ledger and is recorded in the offcut holding ledger,
unvalued, against the order and its offcut contract reference, with the Section 143 return clock
still running against it, and the order's custody balance is reduced so the closure gate is
reachable

Rationale: capture and disposal are now two moments. Story 9.6 owns capture; Story 9.7 owns
disposal.

### Epics: Story 9.6 acceptance criterion 4

OLD: "... and any own-material (FR-JW-07) and retain-and-buy lines ..."

NEW: "... and any own-material (FR-JW-07) lines; offcut buyback is billed separately as a credit
note when the offcut is valued at disposal (Story 9.7), and billing is never held waiting for it ..."

Rationale: removes the `offcut_not_settled` precondition, which otherwise blocks a service invoice
for however long the offcut sits retained.

### Epics: Story 9.6 dev notes

OLD:

- Executing the election is a precondition for the Story 9.5 closure gate: retained or unreturned
  offcuts otherwise leave the custody ledger non-zero (`CUSTODY_NOT_ZERO`).

NEW:

- Capture moves offcut OUT of the custody ledger into the holding ledger, so the Story 9.5 closure
  gate is reachable while the offcut is still retained. The offcut's own lifecycle continues after
  the order closes, under its contract reference.
- The Section 143 clock follows the material, not the order: it keeps running while offcut is
  retained and is stopped only at disposal. The Story 9.5 breach sweep must therefore read the
  holding ledger as well as the return clocks.

### New Story 9.7: Offcut Holding, Disposal and Valuation

Proposed placement: Epic 9, after Story 9.6.

As a finance controller,
I want retained offcut disposed of and valued when its fate is actually known, with the resulting
buyback billed as a credit note against the service invoice,
So that customer offcut is never valued at a guessed rate and never sits unaccounted.

Draft acceptance criteria:

1. **Given** offcut retained in the holding ledger, **when** the finance controller records a
   disposal, **then** the disposition (`returned` or `acquired`) and, on `acquired`, the rate are
   captured together, the holding ledger row is closed, and the Section 143 clock for that quantity
   is stopped.
2. **Given** a disposal of `return`, **when** it is executed, **then** a return challan and dispatch
   documents are generated through the Story 3.7 flows.
3. **Given** a disposal of `acquired`, **when** it is executed, **then** title transfers to the
   processor, a new owned lot is minted under a QC hold, and a credit note for the acquisition value
   is raised against the order's service invoice citing that invoice's ERP document reference. A
   contractual free retention is the same branch at a rate of zero and raises no credit note.
4. **Given** a valued disposal, **when** the finance controller later revises the rate, **then** a
   delta document is raised and the original is never mutated.
5. **Given** any offcut disposal, **when** the acknowledging actor is the finance controller who set
   the rate, **then** the acknowledgment is refused `SOD_VIOLATION`.

### Access matrix

Two rows require revision in `access-matrix-frontline-draft-2026-07-11.md`.

- Line 82: `jobwork_coordinator` loses "offcut election capture" and gains "offcut capture to the
  holding ledger".
- Line 90: `finance_controller` gains job-work offcut disposal and valuation. Note for the sponsor:
  the matrix currently says this role's period operations arrive with Epic 11, so this ruling pulls
  a finance controller duty forward into the pilot slice. That is a staffing question, not a
  technical one, and it needs confirming before Story 9.7 is scheduled.

## Implementation Handoff

Scope classification: **Major**. A committed story is being partly reversed, a functional
requirement is being restated, a new story is being added, and a role's responsibilities are moving
earlier than the access matrix anticipated.

Table 4 sets out the handoff.

Table 4: Handoff plan

| **Recipient** | **Responsibility** |
| --- | --- |
| Product Manager | Approve the restated FR-JW-09/10. The finance controller duty moving into the pilot slice was CONFIRMED by the user on 2026-09-05; the outstanding part is naming who holds the role at the pilot site |
| Solution Architect | Confirm the holding ledger as a distinct projection rather than a widening of `custody_ledger_entry`, and confirm the clock-follows-material rule |
| Product Owner | Reprioritise Story 9.7 against the remaining pilot scope and decide whether 9.6 closes before 9.7 starts |
| Developer | Execute the reversal in 9.6, then implement 9.7; widen the Story 9.5 breach sweep |

Success criteria:

1. No code path requires an offcut rate before disposal.
2. Retained offcut is visible to the Story 9.5 breach sweep and ages against the Section 143 clock.
3. A service invoice generates without waiting for offcut disposal.
4. Offcut buyback reaches ERP as a credit note citing the original invoice.
5. The negotiated rate is recorded as the commercial value with the indicative rate stored beside
   it for variance, the `OFFCUT_RATE_OUT_OF_BAND` guard and its tolerance knob are gone, and the
   finance controller who set the rate cannot acknowledge the credit note that bills it.

## Open Questions

Questions 1 and 2 were ANSWERED on 2026-09-05 and are recorded here for traceability.

1. ANSWERED. A resale may be a buy-back by the originating customer or a sale to any other buyer, as
   scrap or at any agreed price. Combined with the answer to question 2, this means resale is never a
   disposal branch: it is what the processor does with stock it already owns. Disposal therefore has
   exactly two branches, `returned` and `acquired`.
2. ANSWERED. Buy then sell, always. The processor will not sell on the customer's behalf, so no
   agency path is modelled and title always transfers before any onward sale.
3. ANSWERED 2026-09-05. The offcut contract carries a pre-indicative buy-in rate; the final rate
   moves with the offcut's physical condition, which the processor verifies alone. The commercial
   value is the rate NEGOTIATED in reality, recorded with the indicative rate beside it so the
   variance is visible. No tolerance is applied and nothing is refused on rate, so the
   `OFFCUT_RATE_OUT_OF_BAND` guard is removed. An interim ruling the same day chose a hard band and
   was superseded.
4. ANSWERED 2026-09-05. Yes. Offcut still governed by the job contract with the customer appears
   on the job-work ageing report regardless of whether its order has closed. Once acquired, title
   has transferred, it is no longer a job-work exposure, and it is carried in the scrap holding
   ledger instead.
