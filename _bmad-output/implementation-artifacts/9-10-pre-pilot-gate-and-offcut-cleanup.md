---
baseline_commit: 5be1c3a
---

# Story 9.10: Pre-Pilot Gate Sweep and Offcut Reconciliation Cleanup

Status: done

## Story

As a project lead preparing the pilot,
I want the recurring hold-bypass class swept once and the offcut reconciliation gaps closed,
so that Story 11.2 broadens the dispatch write surface onto a seam that has already been audited.

## Sequencing

This story runs FIRST, ahead of Story 9.9 and Story 11.2, decided by the Project Lead on
2026-09-07. Table 1 gives the order and the reason for it.

| **Order** | **Story** | **Why here** |
| --- | --- | --- |
| 1 | 9.10 (this story) | The sweep may patch the same dispatch seam Story 11.2 extends. Doing that once is cheaper than doing it twice, and 11.2 should land on an audited seam. |
| 2 | 9.9 | Closes deferred-work 9.8-2, the revaluation signature-forgery gap. Independent of this story. |
| 3 | 11.2 | The pilot's statutory IRN block. Both prerequisites above must be closed first. |

The story number is higher than 9.9 because 9.9 was created first. Numbering is not the running
order; Table 1 is.

## Acceptance Criteria

1. **Given** every quality and custody gate-check call site in the codebase, **when** they are
   audited against the `dispatchGateBlockedLots` shared-guard pattern, **then** each one either calls
   the shared guard or carries a recorded, defensible reason for not doing so, and any site missing
   a half of the gate is fixed.
2. **Given** an offcut-class stock balance, **when** a cycle-count variance adjustment is attempted
   against it, **then** it is refused, because the adjustment would move `stock_balance` while
   leaving the `job_work_offcut_holding` row that prices the credit note and reconciles the Section
   143 clock untouched.
3. **Given** a physical verification covering customer-owned stock, **when** offcut-class and
   job-work-class lines are counted, **then** they appear in the count for existence assurance and
   carry a zero variance value, because this platform holds customer-owned material unvalued.
4. **Given** a UUID path parameter supplied in upper case, **when** it is used as an event target,
   **then** it behaves identically to the lower-case form on every route, not only on the routes that
   already lower-case it.
5. **Given** the billing reconciliation report, **when** one ERP reference acknowledges several
   orders, **then** the report surfaces the duplicate-reference count rather than leaving it to be
   discovered by hand.

## Tasks / Subtasks

- [x] Task 1: the hold-bypass gate sweep (AC: 1)
  - [x] 1.1 Read `src/compliance/dispatch.ts:45-57` first. It states the rule the sweep enforces:
        "Every dispatch surface calls THIS, never one half of it", and records that forgetting a half
        has shipped as a defect five times (Stories 8.3, 8.4, 8.5, 8.8, 9.4). Four of those five were
        found by review, not design. This sweep is retrospective action item 2 and exists so the
        sixth instance is found by audit instead.
  - [x] 1.2 CONFIRMED HIT, fix it: `applyDispatchDispatchedProjection`
        (`src/compliance/dispatch.ts:449-465`) does NOT call `dispatchGateBlockedLots`. It inlines its
        own `packing_record JOIN lot_master ... ORDER BY lm.lot_id FOR UPDATE OF lm` query and then
        calls `qcGatedLotIds` directly. It happens to check both halves in the right order today, so
        this is not a live bypass - it is the shared guard's own file diverging from the rule its
        header comment states, which is how the next divergence becomes invisible. Replace the inline
        pair with a `dispatchGateBlockedLots` call and keep the existing refusal codes and status
        codes byte-for-byte (they are 400, including `LOT_ON_HOLD`; do not renumber them here).
  - [x] 1.3 The codebase currently has THREE gate idioms. Reconcile them or record why each stays:
        (a) `dispatchGateBlockedLots`, the shared guard, called from
        `src/compliance/jobwork-dispatch.ts:303`; (b) inline hold query plus `qcGatedLotIds`, at
        `src/compliance/dispatch.ts:449-465`, the Task 1.2 hit; (c) inline hold query plus
        `assertQcGateAllows`, at `src/compliance/cross-dock.ts:305-325`. Idiom (c) checks BOTH halves
        and is correct, but through a different mechanism, so a reader auditing call sites has to
        recognise three shapes to be sure. Prefer converging on (a); where that is not possible,
        leave a comment at the call site naming which halves it covers and why it does not use the
        shared guard.
  - [x] 1.4 Latent divergence, fix or document: `src/compliance/lot-serial-validation.ts:193,203,299`
        and `src/api/v1/lots.ts:231,243` test `quality_hold_status === 'held'`, while
        `src/compliance/dispatch.ts` tests `!== 'none'`. These are equivalent TODAY because
        `chk_lot_master_quality_hold_status` constrains the column to `('none','held')`
        (`read/projections/lot_master.sql:24`). They stop being equivalent the moment a third status
        is added, and the dispatch seam's own comments already talk about a "manual/recall hold" as
        though one exists. Normalise every site to `!== 'none'`, which fails closed against a status
        nobody has written yet.
  - [x] 1.5 Audit the remaining `quality_hold_status` readers for the missing-half pattern:
        `src/api/v1/lots.ts:170,231,243`, `src/compliance/lot-serial-validation.ts:193,203,299`. For
        each, record in the Completion Notes whether it is an OUTBOUND path (must check both halves),
        a REPORTING read (no gate needed), or a WRITE that sets the flag. Do not change reporting
        reads.
  - [x] 1.6 Produce a written inventory in the Completion Notes: every call site, its classification,
        and its disposition. AC 1 is satisfied by that inventory existing and being complete, not by
        a count of patches. A sweep that finds nothing is a valid outcome ONLY if the inventory shows
        what was looked at.

- [x] Task 2: refuse cycle-count adjustments on offcut-class stock (AC: 2)
  - [x] 2.1 The defect: `src/compliance/cycle-count.ts` never references `job_work_offcut_holding` -
        grep returns nothing. So a variance adjustment on an offcut-class balance moves
        `stock_balance` and leaves the holding row untouched. That row is what
        `billableValueOf(holding.quantity, rate)` prices for the credit note, what disposal and
        revaluation act on, and what `clock_reconciled_qty` reconciles the Section 143 clock against.
        A warehouse count can therefore put the customer's billed quantity silently out of step with
        the physical quantity.
  - [x] 2.2 RULED 2026-09-07 by the Project Lead: REFUSE the adjustment; do not reconcile the holding
        from the count. The offcut is the customer's, held unvalued, under a running statutory clock,
        and already priced into a credit note. Changing its quantity is a commercial event between
        two parties, not a warehouse correction one counter can make. Reconciling from the count
        would let a warehouse count move a customer's bill with no finance signature, which cuts
        directly against the Story 9.7 through 9.9 approval design.
  - [x] 2.3 Add the bar beside the existing class-conflict guard at
        `src/compliance/cycle-count.ts:1034-1086`. That guard only fires on a CLASS CONFLICT, so a
        same-class offcut-to-offcut adjustment passes straight through it today. The new bar is
        unconditional on `stock_class = 'offcut'`, regardless of the existing class.
  - [x] 2.4 Use a new refusal code rather than overloading `CROSS_ISSUE_BLOCKED`, whose message is
        about crossing customer-owned material with another class and would be actively misleading
        here. Register it in `CYCLE_COUNT_ERROR_CODES` (`src/compliance/cycle-count.ts:106`), in
        `PERMANENT_ERROR_CODES` (`src/sync/upload.ts:18`) - a retry of the same count never clears it
        - and in `edge/src/messages/en.json`. The message must say what to do instead: the quantity
        is corrected through the offcut disposal and revaluation flow, not through a count.
  - [x] 2.5 The bar is re-derived in the applier under the same locks as the existing guard, never
        only at the route, so a direct `POST /api/v1/events` meets the identical wall. This is the
        hold-bypass class and Task 1 is sweeping for exactly this shape; do not introduce a new
        instance of it in the same story.
  - [x] 2.6 Note the second-order reason this matters: `resolveCountApprover(line.variance_value)`
        (`src/compliance/cycle-count.ts:915`) routes a variance to a DOA band by its value. An offcut
        line carries a value this platform does not recognise, so it would route by a meaningless
        number. Task 3 removes the number; this task removes the line.

- [x] Task 3: physical verification counts customer-owned stock at zero value (AC: 3)
  - [x] 3.1 RULED 2026-09-07 by the Project Lead: customer-owned material physically exists in the
        building and its presence must be verifiable, so offcut-class and job-work-class lines STAY
        in the physical verification count. But this platform holds offcut unvalued by the
        2026-09-05 offcut-domain ruling, so their `variance_value` must be zero, not a figure derived
        from a rate that is not the company's.
  - [x] 3.2 `physical_verification` already stores `stock_class` per line
        (`src/read/projections/physical_verification.ts:33,216`), so the classes are already counted.
        The change is confined to how `variance_value` is computed for them
        (`src/compliance/cycle-count.ts:536,857`): zero for every class in
        `CUSTOMER_OWNED_STOCK_CLASSES`, unchanged for `owned` and `prototype`.
  - [x] 3.3 Reuse the `CUSTOMER_OWNED_STOCK_CLASSES` set introduced by commit `502b664` rather than
        testing for `offcut` and `job_work` separately. That set exists precisely so the two classes
        cannot drift apart again, and the commit message says so.
  - [x] 3.4 Confirm the zero flows through to the report surface at
        `src/api/v1/physical-verification.ts:369-377`, which passes `variance_value` straight out. A
        zero computed at write time but re-derived at read time would defeat the change.

- [x] Task 4: close deferred-work 9.8-1 (AC: 4)
  - [x] 4.1 `requireUuidParam` in `src/api/v1/service-orders.ts:253-259` returns the raw path segment.
        The equivalent helper in `src/api/v1/production-completions.ts:188-196` lower-cases it, with
        a comment recording why: `UUID_REGEX` is case-insensitive while PostgreSQL returns uuid
        columns lower-cased, so comparing a raw path segment against a persisted `stream_id` let an
        upper-case path COMMIT a completion and then answer 409.
  - [x] 4.2 Apply the same `.toLowerCase()` and carry the explanatory comment across. Keep the
        `service-orders.ts` version's richer `details` payload; the two helpers differ there
        deliberately.
  - [x] 4.3 Check whether any OTHER route file defines a third copy of this helper before closing the
        ledger entry. Two copies that disagreed is the reason this entry exists.

- [x] Task 5: close deferred-work 9.6C-1 (AC: 5)
  - [x] 5.1 `listUnacknowledgedBillingFeeds` (`src/read/projections/job_work_billing_feed.ts:200-229`)
        reports every feed not acknowledged, but never surfaces duplicate `acknowledged_ref_ext`
        values, although the index that would serve that lookup exists at
        `read/projections/job_work_billing_feed.sql:79-85`.
  - [x] 5.2 One consolidated ERP invoice legitimately acknowledging several orders is CORRECT
        behaviour, not an error. The report must therefore surface a duplicate-reference COUNT for
        the reader to judge, never a refusal or a warning that implies a defect.
  - [x] 5.3 Add it as an additional column or a companion query on the same report. Do not change the
        acknowledgment path itself: nothing about how acknowledgments are recorded is wrong.

- [x] Task 6: tests (AC: 1 through 5)
  - [x] 6.1 `test/integration/story-9-10.test.ts`: an offcut-class count adjustment is refused and
        audited; an owned-class adjustment on the same task still succeeds; a physical verification
        covering an offcut line records it with zero variance value while an owned line keeps its
        computed value; an upper-case UUID path parameter behaves identically to lower-case on a
        `service-orders` route; the reconciliation report surfaces a duplicate reference count when
        one ERP reference acknowledges two orders.
  - [x] 6.2 MUTATION-VERIFY the offcut count bar at the SEAM, not the route: remove it from the
        applier and confirm the integration arm fails. A route-only pre-check masks a seam-only
        mutant, the specific finding from Story 8.6.
  - [x] 6.3 Any gate call site CHANGED by Task 1 needs a regression arm proving both halves still
        refuse. A refactor of a guard with no test that the guard still fires is how the class
        recurred five times.
  - [x] 6.4 Re-run the dispatch and job-work suites in full: `test/integration/story-3-7.test.ts`,
        `story-9-4`, `story-9-6`, `story-9-7`, `story-9-8`, plus `test/unit/schema-drift.test.ts`.
        Task 1 touches a seam that all of them exercise.

- [x] Task 7: close the ledger entries (AC: 1 through 5)
  - [x] 7.1 Mark 9.6C-1, 9.6C-2, 9.8-1 resolved in
        `_bmad-output/implementation-artifacts/deferred-work.md`, each with the commit that closed it.
        Do NOT mark 9.8-2 resolved; Story 9.9 owns it.
  - [x] 7.2 Update retrospective action items 2, 3, 4 and 6 in the Epic 9 retrospective with their
        outcome. Item 5 is a standing team agreement and stays open by design.

### Review Findings

Adversarial code review 2026-09-08, three layers (Blind Hunter, Edge Case Hunter, Acceptance
Auditor) against baseline 5be1c3a. Every finding below was re-verified against the source before
being rated; layer-assigned severities were discarded.

- [x] [Review][Patch] Customer-owned variance zeroing breaks DOA banding for both classes - RESOLVED 2026-09-08, option 1: band on the COMPUTED variance value and zero only the physical-verification evidence row; `unit_cost` stays mandatory for customer-owned lines because the banding still consumes it. Task 3 zeroes `variance_value` for every member of `CUSTOMER_OWNED_STOCK_CLASSES` (`cycle-count.ts:846`), but `resolveCountApprover` bands on the STORED value (`cycle-count.ts:928`, `api/v1/cycle-counts.ts:485`) and `findMatchingDoaEntry` uses `$2 > value_min` (`doa_registry.ts:191`). Two consequences, neither disclosed. First, `job_work` count adjustments are NOT barred by Task 2, so a job-work variance of any magnitude now bands at value 0, the lowest-authority band. Second, `applyAdjustmentDecision` calls `resolveCountApprover` for BOTH the approved and the rejected decision, so under any registry whose lowest band has `value_min = 0` the adjustment can be neither approved NOR rejected, and the count blocks physical-verification completion permanently. The story's own test seeds `value_min: null, value_max: null`, the one band shape that hides this. Also unresolved by the same choice: `resolveUnitCost` (`cycle-count.ts:500`) still refuses a customer-owned count line that omits `unit_cost`, for a figure that is then discarded. Options: band on the computed value and zero only the physical-verification evidence row; or bar `job_work` adjustments the way `offcut` is barred; or give customer-owned classes their own DOA route.
- [x] [Review][Patch] AC 1 sweep never covered `assertQcGateAllows`, which no-ops when a lot has no QC inspection task - RESOLVED 2026-09-08, option 1: widen the sweep now - run the manual and recall hold half of `assertQcGateAllows` regardless of whether the lot carries a QC inspection task, so the nine call sites gain the missing half centrally. `quality.ts:4635` does `const task = await getQcInspectionTaskByLotId(...); if (!task) return;`, and the `quality_hold_status !== 'none'` checks live only inside the `accepted` and `conditionally_released` branches. `qc_inspection_task` rows are minted only for synthetic-completion, production-order and job-work-order sources, while `POST /lots/:id/quality-hold` (`api/v1/lots.ts:350`) places a manual or recall hold on any lot. Call sites whose ONLY gate is `assertQcGateAllows` therefore never check the hold half: `pick.ts:354,500,632`, `transfer-request.ts:276,473`, `production-material.ts:764,903`, `maintenance-spares.ts:573,672`. None is named in Task 1.5, which scoped the audit to `lots.ts` and `lot-serial-validation.ts`. The same root cause makes the QC half of the cross-dock gate vacuous. Options: widen the sweep now; or record the nine sites as a ledger entry and close AC 1 against the narrower scope actually audited.
- [x] [Review][Patch] AC 4 is unmet on routes that never defined `requireUuidParam` - RESOLVED 2026-09-08, option 1: fix the routes as well as the seven helper copies - lower-case the UUID path segment wherever it is compared against a persisted value or passed as a `stream_id`. Task 4 lower-cased all seven private copies of the helper, but AC 4 says the fix lands "on every route". `api/v1/cycle-counts.ts:454` and `:603` compare the raw path segment against the persisted value (`line.cycle_count_id !== id`), and PostgreSQL returns `uuid` columns lower-cased, so an upper-case path answers 404 where the lower-case form answers 200. `cycle-counts.ts:343,427` pass the raw segment as `stream_id`, the exact 9.8-1 mechanism. Roughly nineteen further route files share the shape. Options: fix the routes as well as the helpers; or narrow AC 4 to the helper copies and open a ledger entry for the rest.
- [x] [Review][Patch] Offcut count line still mints a `pending_approval` adjustment that can never be resolved [src/compliance/cycle-count.ts:850] - RESOLVED DIFFERENTLY 2026-09-08: the mint is KEPT. applyStockAdjusted refuses a non-approved adjustment before it reaches the offcut bar, so suppressing the mint would have made the bar unreachable and deleted AC 2's audited refusal. The deadlock's real cause was D1; with the count-line value restored the offcut adjustment rejects cleanly, and the refusal details now name that exit (`resolution: reject_adjustment_to_close_count`).
- [x] [Review][Patch] `OFFCUT_ADJUSTMENT_REFUSED` missing from the edge connector permanent-error registry [edge/src/sync/connector.ts:23]
- [x] [Review][Patch] `listDuplicateAcknowledgedRefs` drops cross-site duplicates and attributes them to one arbitrary site [src/read/projections/job_work_billing_feed.ts:246]
- [x] [Review][Patch] Cross-dock by-design comment states two false reasons and claims a QC half it does not have [src/compliance/cross-dock.ts:326]
- [x] [Review][Patch] Task 1.6 gate inventory was never written, so AC 1's stated satisfaction condition is unmet [_bmad-output/implementation-artifacts/9-10-pre-pilot-gate-and-offcut-cleanup.md:308]
- [x] [Review][Patch] File List omits `deferred-work.md` and `epic-9-retro-2026-09-07.md`, both changed by Task 7 [_bmad-output/implementation-artifacts/9-10-pre-pilot-gate-and-offcut-cleanup.md:319]
- [x] [Review][Patch] Task 1.4's literal instruction was overridden without recording the supersession [_bmad-output/implementation-artifacts/9-10-pre-pilot-gate-and-offcut-cleanup.md:49]
- [x] [Review][Patch] AC 1 regression arm pins the new `reason` field rather than the convergence, and the changed `lot-serial-validation.ts:303` gate has no arm at all [test/integration/story-9-10.test.ts]
- [x] [Review][Patch] Test seeds an unbounded DOA band into global registry state and cleans up nothing [test/integration/story-9-10.test.ts:538]
- [x] [Review][Defer] Seven byte-identical `requireUuidParam` copies were multiplied rather than extracted, in a story whose thesis is that duplication hides divergence [src/api/v1/service-orders.ts:254] - deferred, pre-existing
- [x] [Review][Defer] `logRejectionAudit` inside an applier makes the applier non-replayable and can wait on an exhausted pool while holding locks [src/compliance/cycle-count.ts:1070] - deferred, pre-existing
- [x] [Review][Defer] Lower-casing changes retry semantics for any event committed through an upper-case path before this change [src/api/v1/service-orders.ts:2024] - deferred, pre-existing
- [x] [Review][Defer] AC 2 and AC 3 fixture asserts a stock-class grain the laundering bar refuses to create [test/integration/story-9-10.test.ts:1067] - deferred, pre-existing

## Dev Notes

### Why these five items are one story

They are the residue of the Epic 9 retrospective, and four of the five are the same underlying
lesson: adding a stock class or a write path means walking every consumer of it. `offcut` was added
to `SEGREGATED_STOCK_CLASSES` when the class was introduced, but that set governs only the laundering
check on RECEIPTS. Commit `502b664` found and closed the issue side of that gap. Tasks 2 and 3 close
the count and verification sides. Task 1 sweeps the structurally identical class on the quality gate.

Bundling them is deliberate: they touch overlapping files (`cycle-count.ts` for Tasks 2 and 3, the
dispatch seam for Task 1) and they share one review. Tasks 4 and 5 are small, unrelated ledger
closures included because they are cheap while the ledger is open.

### Decisions taken 2026-09-07 (Project Lead)

1. **Offcut count adjustments are REFUSED, not reconciled.** See Task 2.2 for the reasoning. The
   alternative considered and rejected was updating the holding and raising a delta credit note from
   the count, which would let a warehouse count move a customer's bill without a finance signature.
2. **Customer-owned classes stay in physical verification, valued at zero.** See Task 3.1. The
   alternative considered and rejected was excluding them entirely, which would lose the
   physical-existence check on material the company is legally accountable for.
3. **9.6C-1 is fixed here rather than deferred past the pilot**, because the ledger is open and the
   change is a report column.
4. **This story runs before 9.9 and 11.2.** See Table 1.

### Current state of the code being modified

`src/compliance/cycle-count.ts` carries `SEGREGATED_STOCK_CLASSES` at line 91 and constants
`JOB_WORK_STOCK_CLASS` and `OFFCUT_STOCK_CLASS` at 92-93. Its only current use of the offcut constant
is the cross-class conflict at 1064-1068, added by `502b664`. The guard at 1037 fires only when the
inflow class differs from the existing class, which is why a same-class offcut adjustment is
currently unguarded. The file never references `job_work_offcut_holding`.

`src/compliance/dispatch.ts` exposes `qcGatedLotIds` (line 36) and `dispatchGateBlockedLots` (line
58). The shared guard is called from exactly one place outside its own file,
`src/compliance/jobwork-dispatch.ts:303`. `applyDispatchDispatchedProjection` at line 400 does not
call it.

`src/compliance/cross-dock.ts:305-325` takes the lot lock, checks the hold inline, then calls
`assertQcGateAllows` with an explicit comment recording the lot-gate-stock order. It is correct; it
is simply a third shape.

What must be preserved: the existing refusal codes and HTTP status codes at every site Task 1
touches (they are asserted by existing tests), the lock ordering at each gate, and the behaviour of
owned-class and prototype-class counting, which this story does not change.

### Testing standards

Integration tests run against the docker `ims-postgres-test` instance on port 5442, through
`node --env-file=.env.test --import tsx --test --test-concurrency=1`. Run integration files serially.

The suite is green and there is no noise floor: the 28-failure floor carried through Epics 8 and 9
was eliminated on 2026-09-05, and the last full run at Epic 9 close was 1992/1992 with one
intermittent pre-existing flake, `story-5-3` (a where-used clock window). Any other failure is yours.
Run `tsc`, `eslint` and a `db:migrate` idempotency check before declaring done.

### References

- [Source: _bmad-output/implementation-artifacts/epic-9-retro-2026-09-07.md] - action items 2, 3, 4
  and 6, and the recurring-bug-class finding that motivates Task 1
- [Source: _bmad-output/implementation-artifacts/deferred-work.md:583-584] - 9.6C-1 and 9.6C-2 in full
- [Source: _bmad-output/implementation-artifacts/deferred-work.md:594] - 9.8-1 in full
- [Source: src/compliance/dispatch.ts:45-57] - the rule the sweep enforces, and the five-time history
- [Source: src/compliance/dispatch.ts:449-465] - the confirmed ad-hoc call site
- [Source: src/compliance/cross-dock.ts:305-325] - the third gate idiom
- [Source: src/compliance/cycle-count.ts:1034-1086] - the class-conflict guard a same-class offcut
  adjustment passes through
- [Source: read/projections/lot_master.sql:24] - the `('none','held')` domain behind Task 1.4
- [Source: commit 502b664] - the issue-side half of this same gap, and the
  `CUSTOMER_OWNED_STOCK_CLASSES` set Task 3.3 reuses

## Dev Agent Record

### Agent Model Used

### Debug Log References

- **AC 1 sweep (Tasks 1.1-1.6).** Confirmed hit: `applyDispatchDispatchedProjection` inlined its own
  hold query plus `qcGatedLotIds`, a second divergence from the shared `dispatchGateBlockedLots`
  guard inside the guard's OWN file. Converged on the shared guard (byte-for-byte code 400
  `LOT_ON_HOLD`, `reason: 'quality_hold' | 'qc_gate'`). Cross-dock completion is a THIRD idiom that
  does not use the shared guard by design (addresses the lot by NUMBER, not UUID, and its QC gate
  goes through `assertQcGateAllows`); it still covers both halves in the fixed lock order, so it is
  not a bypass - a call-site comment now names the halves and the reason, per Task 1.3.
  `lot-serial-validation.ts:299` was normalized `=== 'held'` -> `!== 'none'` (fails closed against a
  third status). The reason-LABEL reads at `lot-serial-validation.ts:193` and `lots.ts:231` are
  REPORTING reads and were deliberately left as `=== 'held'` with a documenting comment (Task 1.5).
- **AC 2 (Task 2).** The offcut-class count-adjustment bar is unconditional on
  `stock_class = 'offcut'` regardless of the existing class, applies to both delta directions, lives
  in the `applyStockAdjusted` applier under the same locks as the class-conflict guard (both doors),
  and uses a NEW code `OFFCUT_ADJUSTMENT_REFUSED` (not `CROSS_ISSUE_BLOCKED`), registered in
  `CYCLE_COUNT_ERROR_CODES`, `PERMANENT_ERROR_CODES` (sync/upload.ts) and `edge en.json`. The refusal
  is a statutory decision, so the applier writes its own `logRejectionAudit` row on a fresh
  connection (survives the rollback) - `applyCycleCountProjection` now accepts and forwards
  `auditCtx`, mirroring the offcut-domain appliers, so both the approve route and the direct events
  door leave exactly one audit row. `resolveCountApprover` still routes by variance_value, which Task
  3 removes for offcut; Task 2 removes the line entirely.
- **AC 3 (Task 3).** `variance_value` at count-line creation is `'0.000000'` for every class in
  `CUSTOMER_OWNED_STOCK_CLASSES` (offcut AND job_work) and unchanged for owned/prototype. The set was
  exported from `stock-balance.ts` and reused (Task 3.3). The physical-verification snapshot copies
  the stored line value and the report passes it straight out (Task 3.4), so the zero is fixed at
  write time.
- **AC 4 (Task 4).** `requireUuidParam` lower-cases the path segment in ALL SEVEN route files that
  define it (service-orders, quality, production-orders, production-material, compliance,
  maintenance, production-completions) with the explanatory comment carried across. The 9.8-1
  deferred-work entry was recorded when the offcut approve route's retry target-binding compared the
  raw path segment against a stored lower-case payload; the disposal route has the same
  stored-vs-path binding, which the AC4 test reproduces.
- **AC 5 (Task 5).** `listDuplicateAcknowledgedRefs` companion query on the reconciliation report
  surfaces every acknowledged_ref_ext covering more than one order (site-scoped). The report marks
  it as a COUNT, never a defect - one consolidated ERP invoice acknowledging several orders is
  correct.
- **Task 7 ledger closures.** deferred-work 9.6C-1 (duplicate acknowledged_ref_ext count) and 9.8-1
  (requireUuidParam case) are closed by the code above and marked resolved in the ledger; 9.6C-2 was
  already closed by the 9.6C review group (it referenced the same report surface and is marked
  resolved with a pointer to this story).

### Completion Notes List

- Story 9.10 complete. Task 1.2 converged the dispatch-dispatched gate call site onto the shared
  guard; Task 1.4 normalized the `=== 'held'` gate to `!== 'none'`; Tasks 2-3 added the offcut count
  bar and the zero-value customer-owned variance; Tasks 4-5 closed deferred-work 9.8-1 and 9.6C-1.
- Task 1.4 was SUPERSEDED IN PART by Task 1.5, and the override is recorded here rather than left
  implicit (code review 2026-09-08, P7). Two sites keep `=== 'held'`: `src/api/v1/lots.ts` and
  `src/compliance/lot-serial-validation.ts`, at the points where the status is used to pick a REASON
  LABEL rather than to gate. Normalising those would have reported an excluded lot as
  `insufficient_quantity`. Every site that GATES was normalised.
- Task 1.6 gate inventory. Table 3 is the written inventory AC 1 requires; the acceptance condition
  is that this table exists and is complete, not that a particular number of patches was applied.

| **Call site** | **Kind** | **Hold half** | **QC half** | **Outcome** |
| --- | --- | --- | --- | --- |
| `src/compliance/jobwork-dispatch.ts:303` | WRITE | shared guard | shared guard | already complete, unchanged |
| `src/compliance/dispatch.ts:449` | WRITE | inline, now shared guard | inline, now shared guard | converged (Task 1.2) |
| `src/compliance/cross-dock.ts:316` | WRITE | inline under row lock | `assertQcGateAllows` | complete; call-site comment corrected 2026-09-08 |
| `src/compliance/lot-serial-validation.ts:303` | WRITE | `!== 'none'` | caller's gate | normalised (Task 1.4) |
| `src/compliance/lot-serial-validation.ts:197` | REPORTING | `=== 'held'` label | not applicable | deliberately unchanged (Task 1.5) |
| `src/api/v1/lots.ts:235` | REPORTING | `=== 'held'` label | not applicable | deliberately unchanged (Task 1.5) |
| `src/api/v1/lots.ts:247` | OUTBOUND | `!== 'none'` | not applicable | already correct |
| `src/compliance/quality.ts:4635` (`assertQcGateAllows`) | WRITE, shared | MISSING before 2026-09-08 | present | FIXED by code review D2 |
| `src/compliance/pick.ts:354,500,632` | WRITE | via `assertQcGateAllows` only | via `assertQcGateAllows` | covered by the D2 fix |
| `src/compliance/transfer-request.ts:276,473` | WRITE | via `assertQcGateAllows` only | via `assertQcGateAllows` | covered by the D2 fix |
| `src/compliance/production-material.ts:764,903` | WRITE | via `assertQcGateAllows` only | via `assertQcGateAllows` | covered by the D2 fix |
| `src/compliance/maintenance-spares.ts:573,672` | WRITE | via `assertQcGateAllows` only | via `assertQcGateAllows` | covered by the D2 fix |

- The inventory in Table 3 is what the original Task 1.6 was missing, and writing it is what exposed
  the live defect: `assertQcGateAllows` returned early when a lot carried no `qc_inspection_task`
  row, so its manual and recall hold check never ran for the nine call sites where it is the only
  lot gate. Those lots are exactly the ones a recall hold targets. The fix hoists the hold check
  above the early return.
- Mutation-verified (Task 6.2/6.3): removing the offcut bar from the applier fails the AC2 arm;
  reverting the requireUuidParam lower-casing fails the AC4 arm; removing the QC-gate half from
  `dispatchGateBlockedLots` fails the AC1 arm.
- Full suite at dev complete: 2006/2006 pass (includes story-9-10 4/4, story-2-6, story-3-7,
  story-8-1, story-9-4, story-9-6, story-9-7, story-9-8, schema-drift). tsc, eslint and prettier
  clean.
- Full suite after the 2026-09-08 code-review patches: 2007/2007 pass, 144 suites, 0 failures. The
  extra test is the D2 arm (a held lot with no QC inspection task, plus the lot-serial-validation
  gate Task 6.3 had left unarmed). Nothing regressed on the unconditional hold check, which is the
  result that matters: no existing test depended on a held lot passing `assertQcGateAllows`. tsc,
  eslint and prettier clean; the prettier pass was scoped back to the change set after it reformatted
  five unrelated files.

### File List

- edge/src/messages/en.json - register errors.OFFCUT_ADJUSTMENT_REFUSED
- src/api/v1/compliance.ts - requireUuidParam lower-cases (Task 4)
- src/api/v1/lots.ts - quality_hold_status REPORTING label documented (Task 1.5)
- src/api/v1/maintenance.ts - requireUuidParam lower-cases (Task 4)
- src/api/v1/production-material.ts - requireUuidParam lower-cases (Task 4)
- src/api/v1/production-orders.ts - requireUuidParam lower-cases (Task 4)
- src/api/v1/quality.ts - requireUuidParam lower-cases (Task 4)
- src/api/v1/service-orders.ts - requireUuidParam lower-cases (Task 4); reconciliation report
  surfaces duplicate_acknowledged_refs (Task 5)
- src/compliance/cross-dock.ts - third-idiom call-site comment (Task 1.3)
- src/compliance/cycle-count.ts - offcut count-adjustment bar + self-audit (Task 2); zero
  variance_value for customer-owned classes (Task 3); auditCtx threading
- src/compliance/dispatch.ts - dispatch-dispatched call site converges on dispatchGateBlockedLots
  (Task 1.2)
- src/compliance/lot-serial-validation.ts - `=== 'held'` gate normalized to `!== 'none'`; REPORTING
  label documented (Tasks 1.4, 1.5)
- src/compliance/stock-balance.ts - export CUSTOMER_OWNED_STOCK_CLASSES (Task 3.3)
- src/events/store.ts - forward auditCtx to applyCycleCountProjection (Task 2)
- src/read/projections/job_work_billing_feed.ts - listDuplicateAcknowledgedRefs (Task 5)
- src/sync/upload.ts - OFFCUT_ADJUSTMENT_REFUSED in PERMANENT_ERROR_CODES (Task 2.4)
- test/integration/story-9-10.test.ts - NEW: AC 1-5 regression arms (Tasks 6.1, 6.3); code review
  2026-09-08 adds the D2 no-inspection-task hold arm and the lot-serial-validation arm, pins the
  physical-verification evidence row for D1, and retires the seeded DOA band in `after()`
- _bmad-output/implementation-artifacts/deferred-work.md - Task 7.1 marks 9.6C-1, 9.6C-2 and 9.8-1
  resolved; code review 2026-09-08 appends 9.10R-1 through 9.10R-4 (omitted from the original File
  List, code review P6)
- _bmad-output/implementation-artifacts/epic-9-retro-2026-09-07.md - Task 7.2 records the outcome of
  retrospective action items 2, 3, 4 and 6 (omitted from the original File List, code review P6)

The files below were changed by the 2026-09-08 code review rather than by Tasks 1-7.

- src/compliance/quality.ts - `assertQcGateAllows` checks the manual and recall hold half
  unconditionally, above the no-inspection-task early return (D2); the two now-unreachable duplicate
  checks in the `accepted` and `conditionally_released` branches are removed
- edge/src/sync/connector.ts - OFFCUT_ADJUSTMENT_REFUSED added to the edge PERMANENT_ERROR_CODES
  twin of src/sync/upload.ts (P2)
- src/api/v1/bom-costing.ts, cross-dock.ts, cycle-counts.ts, dispatch.ts, doa.ts, events.ts, gate.ts,
  location-register.ts, location.ts, physical-verification.ts, pick-tasks.ts, putaway.ts,
  receiving.ts, replenishment.ts, supplier-scorecards.ts, three-way-match.ts, transfer-requests.ts,
  weighbridge.ts - 50 raw UUID path parameters lower-cased at extraction, extending AC 4 from the
  seven helper copies to the routes that never defined the helper (D3)

## Change Log

Table 2 records the revisions to this story file.

| **Date** | **Change** |
| --- | --- |
| 2026-09-07 | Story created from Epic 9 retrospective action items 2, 3, 4 and 6, with four Project Lead decisions taken the same day: refuse offcut count adjustments, count customer-owned stock at zero value in physical verification, fix 9.6C-1 now, and run this story ahead of 9.9 and 11.2. |
| 2026-09-08 | Implemented Tasks 1-7 and moved Status to review. Swept the hold-bypass class (dispatch-dispatched converged on the shared guard; `=== 'held'` gate normalized), refused offcut-class count adjustments with a new audited code, zeroed customer-owned physical-verification variance, lower-cased requireUuidParam across all seven route files, surfaced duplicate acknowledged_ref_ext counts on the reconciliation report, and closed deferred-work 9.6C-1 / 9.8-1 in the ledger. story-9-10.test.ts adds the four acceptance arms, mutation-verified against the applier bar, the requireUuidParam lower-casing and the dispatch QC-gate half. Full suite 2006/2006; tsc/eslint/prettier clean. |
| 2026-09-08 | Adversarial code review (Blind Hunter, Edge Case Hunter, Acceptance Auditor) against baseline 5be1c3a. Three decisions resolved by the Project Lead and twelve patches applied. Load-bearing fixes: the customer-owned variance zeroing moved from the count line to the physical-verification evidence row, because the count line's value is what the DOA registry bands on and zeroing it could leave an adjustment neither approvable nor rejectable; the manual and recall hold half of `assertQcGateAllows` made unconditional, closing a live bypass at nine call sites; AC 4 extended to 50 raw UUID path parameters across eighteen further route files. Four findings deferred as 9.10R-1 through 9.10R-4. |
