---
baseline_commit: 5be1c3a
---

# Story 9.9: Offcut Revaluation CFO Approval

Status: done

## Story

As a CFO,
I want an above-band offcut revaluation to require my own authenticated signature,
so that no one can revalue a customer's offcut by naming me as the approver.

## Acceptance Criteria

1. **Given** an offcut revaluation whose revalued value falls in or above the governed DOA band,
   **when** it is posted, **then** it is recorded as a PROPOSAL and nothing changes: no delta credit
   note is raised, the holding keeps its current value, and the Section 143 clock is untouched.
2. **Given** a pending revaluation proposal, **when** the RESOLVED approver approves it through their
   own authenticated request, **then** the revaluation is applied exactly as it is today: the delta
   credit note supersedes the latest document and the holding carries the new current value.
3. **Given** a pending revaluation proposal, **when** anyone other than the frozen resolved approver
   attempts to approve it, **then** it is refused, and no request body field can name an approver on
   any revaluation route.
4. **Given** a revaluation whose revalued value falls below every governed band, **when** it is
   posted, **then** it completes in ONE request exactly as it does today, unsigned.
5. **Given** a pending revaluation proposal, **when** the document it was priced against has since
   been superseded by another revaluation, **then** approving it is refused rather than raising a
   delta against a document that is no longer the latest.
6. **Given** any of the above, **when** the same request is replayed with the same idempotency key,
   **then** it answers against the stored event and is idempotent.

## Context

This story closes deferred-work 9.8-2 and is retrospective action item 1. It BLOCKS Story 11.2.

Story 9.8 made the DOA second signature real on the offcut DISPOSAL path: `approved_by` was removed
from the accepted fields, an above-band acquisition became a proposal, and the CFO's approval became
their own authenticated request bound to a frozen `resolved_approver_actor_id`. The REVALUATION path
was left on the old Story 9.7 contract when the work was human-deferred on 2026-09-07 with the note
"its taking too much of time". The Project Lead ruled on 2026-09-07 that it is closed by extending
the two-step flow, not by blocking above-band revaluation.

### What is actually broken

The band arithmetic, the dual-control rule and the below-band refusal are ALL already correct on the
revaluation path. `applyJobworkOffcutRevalued` computes `newValue = billableValueOf(holding.quantity,
p.rate)` and calls the SAME `resolveAcquisitionApproval` helper the disposal path used before 9.8
(`src/compliance/jobwork-offcut-disposal.ts:1745-1752`), which resolves the band, refuses a claim
below every band, refuses a claim that is not the resolved approver, and refuses the acting user
being that approver.

The single defect is that `p.approved_by` is a string the POSTER supplies, not a signature anyone
made. The route accepts it as a caller field
(`callerFields: ['rate', 'currency', 'approved_by']`, `src/api/v1/service-orders.ts:2091`), and the
shape validator only checks that it is a UUID when present
(`src/compliance/jobwork-offcut-disposal.ts:566-568`), while checking `posted_by` against the
authenticated actor two lines later. So the sole barrier between a finance controller and their own
second signature is not knowing the CFO's user id.

The code names this defence itself at `src/compliance/jobwork-offcut-disposal.ts:679-682`: "the
approver's user id is a bearer credential here (the `approved_by` claim must equal it), and
publishing it in a refusal would hand a finance controller the key to their own second signature".
A user id is not a bearer credential. It appears in audit rows, event payloads, user listings and
prior event history. Suppressing it in refusal messages narrows one leak of a value that leaks
everywhere else. That comment must be deleted along with the field it defends.

## Tasks / Subtasks

- [x] Task 1: extend the proposal projection to carry both kinds (AC: 1, 5)
  - [x] 1.1 Extend `read/projections/job_work_offcut_acquisition_proposal.sql` ADDITIVELY rather than
        creating a sibling table. The Story 9.8 table already encodes every property this story needs
        - the frozen `resolved_approver_actor_id`, dual control as a column constraint, one pending
        proposal per holding, and the `pending`/`approved`/`superseded` lifecycle - and duplicating
        it would duplicate all four. Mirror every change into `deploy/compose/init-db.sql`.
  - [x] 1.2 Add `kind TEXT NOT NULL DEFAULT 'acquisition'` with a CHECK constraining it to
        `('acquisition','revaluation')`. The default is what backfills existing rows correctly; every
        row written before this story IS an acquisition.
  - [x] 1.3 Add `revaluation_event_id UUID`, the revaluation counterpart of `disposal_event_id`. Do
        NOT rename `disposal_event_id`: it is pinned in `test/unit/schema-drift.test.ts` and read by
        the Story 9.8 approve path. Widen `chk_job_work_offcut_acq_proposal_lifecycle` so an
        `approved` row requires EXACTLY ONE of the two event ids, matching its `kind`, and a
        `pending` row requires neither.
  - [x] 1.4 Add `supersedes_credit_note_id UUID` and `currency TEXT`, frozen at propose time. AC 5
        depends on this: the delta chains off the LATEST document, and a below-band revaluation can
        land between propose and approve, so the document the proposal was priced against must be
        recorded rather than re-derived at approve time. This is the same reasoning that already
        freezes `resolved_approver_actor_id`, applied to the other moving part.
  - [x] 1.5 The existing partial unique index (one pending proposal per holding) is CORRECT across
        both kinds and must NOT be split per kind. An acquisition proposal and a revaluation proposal
        on the same holding are mutually exclusive by lifecycle anyway - revaluation requires
        `status = 'disposed' AND disposition = 'acquired'`, which acquisition has not yet reached -
        and one pending signature per offcut is the rule either way.
  - [x] 1.6 Update the `test/unit/schema-drift.test.ts` pin with the FULL new constraint text, not
        just the column names. The Story 9.6 group-A lesson: a name-only pin stays green when the
        constraint body changes.

- [x] Task 2: the two new event types (AC: 1, 2)
  - [x] 2.1 `jobwork.offcut_revaluation_proposed` and `jobwork.offcut_revaluation_approved`, declared
        beside `JOBWORK_OFFCUT_ACQUISITION_PROPOSED` and `JOBWORK_OFFCUT_ACQUISITION_APPROVED`
        (`src/compliance/jobwork-offcut-disposal.ts:105-112`) and added to the exported set there.
  - [x] 2.2 Register BOTH in `SUPPORTED_EVENT_TYPES` on the same stream and with the same
        `requiresBusinessStream` setting as their acquisition counterparts. Story 9.6's group-A
        review found three event types missing from that registry and the consumer fails open, so the
        omission is invisible. Do not repeat it.
  - [x] 2.3 Add both to the Story 1.9 spine allowlist and re-run `test/integration/story-1-9.test.ts`.
        Story 9.8 touched that file for exactly this reason; Story 8.6 found it missing eleven routes.

- [x] Task 3: the propose path (AC: 1, 4)
  - [x] 3.1 In `applyJobworkOffcutRevalued`, replace the `resolveAcquisitionApproval` call at
        `src/compliance/jobwork-offcut-disposal.ts:1745-1752` with the disposal path's post-9.8
        contract: resolve the band on `newValue`; below every band, proceed in one request exactly as
        today with `approved_by` NULL; in or above a band, refuse - this event cannot carry a
        signature at all any more.
  - [x] 3.2 `applyJobworkOffcutRevaluationProposed`, modelled on `applyJobworkOffcutAcquisitionProposed`
        (`src/compliance/jobwork-offcut-disposal.ts:1314`). It runs every precondition the
        revaluation applier runs BEFORE writing the proposal - the order is in process and accepts
        billing, the holding locks, `status = 'disposed' AND disposition = 'acquired'`, a latest
        credit note exists (`CREDIT_NOTE_MISSING` otherwise), and the currency matches that
        document's currency - so a proposal is never raised for a revaluation that could not have
        succeeded. Freeze `supersedes_credit_note_id`, `currency`, `rate`, `proposed_value`,
        `doa_entry_id` and `resolved_approver_actor_id` on the row.
  - [x] 3.3 It writes NOTHING else: no credit note, no holding update, no clock movement. AC 1 is a
        statement about absence, so test it as one.
  - [x] 3.4 The proposal applier refuses a BELOW-band proposal, and the revaluation applier refuses an
        ABOVE-band revaluation. Both refusals are re-derived under the order advisory lock so the
        direct `POST /api/v1/events` door cannot pick the wrong event type to slip past the second
        signature in either direction. This symmetry is the Story 9.8 pattern; copy it exactly.

- [x] Task 4: the approve path (AC: 2, 3, 5)
  - [x] 4.1 `applyJobworkOffcutRevaluationApproved`, modelled on
        `applyJobworkOffcutAcquisitionApproved` (`src/compliance/jobwork-offcut-disposal.ts:1502`).
        The approver is `envelope.metadata.actor.user_id` and nothing else; the shape validator
        requires `approved_by === envelope.metadata.actor.user_id` and 403s otherwise, exactly as the
        acquisition approval does at `src/compliance/jobwork-offcut-disposal.ts:543-551`. The applier
        then compares that authenticated identity against the proposal row's FROZEN
        `resolved_approver_actor_id`. Never re-resolve the approver at approve time: the band, the
        role holder and any delegation can all shift in between.
  - [x] 4.2 On approval it performs the revaluation the proposal describes, reusing the existing
        delta-credit-note and holding-update code rather than reimplementing it: `insertCreditNote`
        with `document_kind: 'delta'`, then `updateOffcutHoldingValuation`. Extract the shared body
        out of `applyJobworkOffcutRevalued` into one helper both paths call, so the below-band and
        approved-above-band routes cannot drift apart.
  - [x] 4.3 AC 5: before applying, re-read the latest credit note for the holding and refuse
        `CREDIT_NOTE_SUPERSEDED` at 409 if it is no longer the frozen `supersedes_credit_note_id`.
        A below-band revaluation can land between propose and approve, and raising the proposed delta
        against a stale document would silently corrupt the running correction. Say so in the
        message: the proposal has to be re-posted against the current document.
  - [x] 4.4 `POST /service-orders/:serviceOrderId/offcut-revaluation-proposals/:proposalId/approve`,
        ported from `approveOffcutAcquisitionProposalBase` (`src/api/v1/service-orders.ts:2241`)
        INCLUDING its 2026-09-07 review fixes, which are load-bearing and were themselves found in
        review: the proposal row is read `FOR UPDATE` inside the SAME transaction that persists the
        approval, so a concurrent propose, approve or order-close serializes instead of slipping
        between two independent pre-reads; the authorization pre-checks run against that locked row
        on the FRESH path only, so an AD-16 replay still answers against the stored event; the
        response re-reads the proposal after COMMIT.
  - [x] 4.5 The approve route accepts `idempotency_key` and NOTHING else - `rejectFieldsOutside(body,
        ['idempotency_key'])`. There is deliberately NO finance-controller gate on it: the whole
        point is that a DIFFERENT person signs. A key reused for a different proposal is 409
        `DUPLICATE_EVENT`, not a success about a proposal the caller never approved.

- [x] Task 5: delete the forgeable field and its defence (AC: 3)
  - [x] 5.1 Remove `'approved_by'` from `callerFields` on the revaluation route
        (`src/api/v1/service-orders.ts:2091`), leaving `['rate', 'currency']`. The allow-list then
        refuses a request naming an approver with `INVALID_PARAMS`, matching the disposal route's
        post-9.8 comment at `src/api/v1/service-orders.ts:2070-2076`.
  - [x] 5.2 Remove `'approved_by'` from `REVALUATION_FIELDS`
        (`src/compliance/jobwork-offcut-disposal.ts:201-210`) and delete the
        `approved_by must be a UUID when supplied` branch from the shape validator
        (`src/compliance/jobwork-offcut-disposal.ts:566-568`), so the closed-shape check refuses the
        field on the direct events door too.
  - [x] 5.3 Delete the "bearer credential" paragraph at
        `src/compliance/jobwork-offcut-disposal.ts:679-682`. It documents a defence that no longer
        exists and, worse, reads as a reason to believe the old contract was sound. Replace it with
        a pointer to this story. `resolveAcquisitionApproval`'s `claimedApprover` parameter is then
        unused by both call sites: remove the parameter rather than leaving it defaulted.
  - [x] 5.4 Grep for any remaining caller-supplied `approved_by` on any route or event door before
        declaring this done. The retrospective's recurring-bug-class lesson applies: this is the
        SECOND path found carrying the same defect, so assume there is a third until a search says
        otherwise.

- [x] Task 6: error codes and messages (AC: 1, 3, 5)
  - [x] 6.1 Register the new refusals in `PERMANENT_ERROR_CODES` in `src/sync/upload.ts:18`: a retry
        of the same request never clears an above-band revaluation posted as a plain revaluation, nor
        a below-band proposal, nor a superseded document. Follow the `CREDIT_NOTE_MISSING` and
        `OFFCUT_NOT_RETAINED` precedents already in that set from Story 9.7.
  - [x] 6.2 Add the corresponding `errors.*` messages to `edge/src/messages/en.json`.
  - [x] 6.3 Add every new refusal that a route can raise to that route's audited-rejection handling,
        following the `APPLIER_SELF_AUDITED_CODES` split at `src/api/v1/service-orders.ts:168`. Story
        9.8's review found a handler-raised `APPROVAL_REQUIRED` leaving no audit row because the
        route catch skipped it and the refusal never reached the applier. A refused signature is
        exactly the event an auditor will ask about.

- [x] Task 7: tests (AC: 1 through 6)
  - [x] 7.1 `test/integration/story-9-9.test.ts`: above-band revaluation becomes a proposal and
        changes nothing (assert the absence of a delta credit note and an unchanged holding value);
        the resolved approver approves and the delta lands; a non-approver is refused; the PROPOSER
        is refused even if they hold the approver role (dual control); a below-band revaluation still
        completes in one request; every path replays idempotently.
  - [x] 7.2 THE FORGERY ARM, the reason this story exists: a finance controller posting a revaluation
        with `approved_by` naming the real, correct CFO user id is REFUSED. Assert it on BOTH doors -
        the REST route and a direct `POST /api/v1/events` - because the route allow-list and the
        closed-shape check are two different guards and Story 8.6 proved a route-only guard passes a
        seam-only mutant.
  - [x] 7.3 AC 5: propose, then land a below-band revaluation, then approve the proposal. Assert 409
        `CREDIT_NOTE_SUPERSEDED` and that no delta was raised.
  - [x] 7.4 MUTATION-VERIFY each new guard individually by reverting it and confirming the specific
        arm fails: the frozen-approver comparison, the dual-control check, the below-band proposal
        refusal, the above-band revaluation refusal, and the superseded-document check. Story 9.8
        did this for all three of its new regression tests and it is the house standard.
  - [x] 7.5 Re-run `test/integration/story-9-7.test.ts` and `test/integration/story-9-8.test.ts` in
        full. This story edits a projection and a helper both of them exercise.

- [x] Task 8: data check before declaring done
  - [x] 8.1 Query for existing `jobwork.offcut_revalued` events carrying a non-null `approved_by`.
        Any that exist were recorded under the forgeable contract and cannot be distinguished from
        genuine approvals after the fact. Report the count in the Completion Notes. If the pilot
        database holds none, say so explicitly - that is the answer that closes the question.

### Review Findings

Three-layer adversarial review (Blind Hunter, Edge Case Hunter, Acceptance Auditor) of the Story 9.9 diff against baseline `5be1c3a`, triaged 2026-09-09. Six patch findings, seven deferred, six dismissed.

**Patch findings**

- [x] [Review][Patch] Deadlock window between the route and events-door approve paths takes locks in opposite order [src/compliance/jobwork-offcut-disposal.ts:2153, src/api/v1/service-orders.ts:2354] - FIXED 2026-09-09: the route now acquires the order advisory lock before the proposal row, mirroring the events-door applier; both doors serialize on the advisory lock first.
- [x] [Review][Patch] Approve route replay still demands current site-write access, contradicting its own AD-16 comment [src/api/v1/service-orders.ts:2372] - FIXED 2026-09-09: the site-write gate now runs only on a fresh request, matching the credit-note acknowledgment route.
- [x] [Review][Patch] Reused proposal_id through the events door surfaces as a raw 500 instead of a classified 409 [src/compliance/jobwork-offcut-disposal.ts:2104] - FIXED 2026-09-09: classifyDuplicate now names the proposal table's pkey and source-event unique.
- [x] [Review][Patch] isAboveBandValue catch swallows every resolveApprover failure, not just APPROVAL_UNRESOLVED [src/api/v1/service-orders.ts:1892] - FIXED 2026-09-09: only APPROVAL_UNRESOLVED routes to the proposal; other errors propagate.
- [x] [Review][Patch] Replayed above-band proposal answers a hardcoded status of `pending_approval` even when the proposal has since been approved [src/api/v1/service-orders.ts:2075] - FIXED 2026-09-09: the top-level status follows the proposal row.
- [x] [Review][Patch] Events-door propose and approve success paths are untested; only the refusals are covered [test/integration/story-9-9.test.ts] - FIXED 2026-09-09: added a door propose + door approve success test asserting the frozen row and the executed delta.

**Deferred findings**

- [x] [Review][Defer] AC 5 refusal leaves the proposal pending forever, holding the one-pending-per-holding slot [src/compliance/jobwork-offcut-disposal.ts:2287, read/projections/job_work_offcut_acquisition_proposal.sql:102] - deferred, already tracked as deferred-work 9.9-1; note it is deliberately weaponizable by any finance controller who posts a below-band revaluation while a signature is pending.
- [x] [Review][Defer] Holdings read surface exposes `resolved_approver_actor_id` and `proposed_by` for both proposal kinds [src/api/v1/service-orders.ts:2573] - deferred, pre-existing from Story 9.8.
- [x] [Review][Defer] Approve applier executes the frozen `proposed_value` with no invariant re-derivation against the live holding quantity [src/compliance/jobwork-offcut-disposal.ts:2305] - deferred, latent while quantity is immutable under the Story 9.10 bar.
- [x] [Review][Defer] The `superseded` lifecycle leg allows `decided_at` without `decided_by` and has no created-at bound [read/projections/job_work_offcut_acquisition_proposal.sql:89] - deferred, reserved for the future withdrawal path.
- [x] [Review][Defer] AC 5 superseded signal is shadowed when the intervening revaluation changed currency [src/compliance/jobwork-offcut-disposal.ts:2268] - deferred, produces a misleading INVALID_PARAMS instead of CREDIT_NOTE_SUPERSEDED.
- [x] [Review][Defer] Edge connector PERMANENT_ERROR_CODES lacks CREDIT_NOTE_SUPERSEDED [edge/src/sync/connector.ts] - deferred, already tracked as deferred-work 9.9-2.
- [x] [Review][Defer] The `acquisition_proposals` response key now carries revaluation rows [src/api/v1/service-orders.ts:2589] - deferred, already tracked as deferred-work 9.9-3.

**Dismissed as noise**: occurred_at future-dating (bounded platform-wide at src/events/store.ts:472), door-side cross-target idempotency (platform semantics, consistent with every other applier), the review-scope note that the working-tree diff also carries Story 9.10 hunks in shared files, the kind-domain CHECK being realized indirectly, and the AC 5 message wording deviation (disclosed).

## Dev Notes

### Design decisions

1. **Extend the Story 9.8 proposal table, do not add a sibling.** It already carries the frozen
   approver, dual control as a column constraint, one-pending-per-holding, and the lifecycle CHECK.
   A second table would duplicate four correctness properties and give the next reader two places to
   look. The discriminator is `kind`, defaulting to `'acquisition'` so existing rows backfill right.
2. **Freeze the superseded document, not just the approver.** Story 9.8 froze
   `resolved_approver_actor_id` because the band, role holder and delegation can all move between
   propose and approve. On the revaluation path the document being superseded can move too, because
   a below-band revaluation needs no signature and can land in between. Same reasoning, second
   moving part. AC 5 exists because of it.
3. **Below-band revaluation is untouched.** It completes in one request today and must keep doing so.
   This story narrows what a single request can do above the band; it does not add friction below it.
4. **No new DOA transaction type.** The revaluation path already bands against
   `JOBWORK_OFFCUT_ACQUISITION_TRANSACTION_TYPE` through the shared helper, deliberately: a
   below-band disposal followed by an unsigned revaluation would otherwise be a route to any value
   (the Story 9.7 Task 5.5 reasoning, recorded at
   `src/compliance/jobwork-offcut-disposal.ts:1744-1746`). Keep that.
5. **The `claimedApprover` parameter goes away entirely.** After Task 5, no call site passes one.
   Leaving it as an optional parameter would leave the forgeable path one line from being
   reintroduced.

### Source tree components to touch

Table 1 lists the files this story touches and the nature of each change.

| **File** | **Change** |
| --- | --- |
| `read/projections/job_work_offcut_acquisition_proposal.sql` | UPDATE: `kind`, `revaluation_event_id`, frozen document columns, widened lifecycle CHECK |
| `deploy/compose/init-db.sql` | UPDATE: mirror the above |
| `src/read/projections/job_work_offcut_acquisition_proposal.ts` | UPDATE: writers and readers for the new columns |
| `src/compliance/jobwork-offcut-disposal.ts` | UPDATE: two new appliers, the revaluation applier's band contract, the shared delta helper, and the deletions in Task 5 |
| `src/events/schema.ts` | UPDATE: two payload interfaces plus two `SUPPORTED_EVENT_TYPES` entries |
| `src/events/store.ts` | UPDATE: wire both asserts and both appliers |
| `src/api/v1/service-orders.ts` | UPDATE: the revaluation route's caller fields, the new approve route |
| `src/server.ts` | UPDATE: register the approve route |
| `src/sync/upload.ts`, `edge/src/messages/en.json` | UPDATE: error-code registration |
| `test/unit/schema-drift.test.ts` | UPDATE: re-pin the projection with full constraint text |
| `test/integration/story-1-9.test.ts` | UPDATE: spine allowlist |
| `test/integration/story-9-9.test.ts` | NEW |

### Previous story intelligence

Story 9.8 is the direct precedent and its review rounds are worth more than its first draft.

- **A guard written but never wired in is invisible.** 9.8's review found
  `getPendingProposalForHolding` fully implemented and never called, leaving a real bypass open.
  Task 7.4's per-guard mutation verify exists to catch that class.
- **Port the transaction shape, not just the logic.** 9.8's second review pass rewrote the approve
  route to read the proposal `FOR UPDATE` inside the same transaction that persists the approval,
  closing a TOCTOU between the handler's reads and the applier. Task 4.4 says to port that version.
- **Handler-raised refusals do not self-audit.** See Task 6.3.
- **A pre-read is not a replay signal** (Story 8.8). Idempotency comes from `alreadyPersisted` and
  the stored event, never from checking whether a row already exists.

### Testing standards

Integration tests run against the docker `ims-postgres-test` instance on port 5442, through
`node --env-file=.env.test --import tsx --test --test-concurrency=1`. Run integration files serially.

The suite is green and there is no noise floor: the 28-failure floor carried through Epics 8 and 9
was eliminated on 2026-09-05, and the last full run at Epic 9 close was 1992/1992 with one
intermittent pre-existing flake, `story-5-3` (a where-used clock window). Any other failure is yours.
Run `tsc`, `eslint` and a `db:migrate` idempotency check before declaring done, per the Story 9.8
gate list.

### References

- [Source: _bmad-output/implementation-artifacts/deferred-work.md:595] - deferred-work 9.8-2 in full,
  with every file and line the gap touches
- [Source: _bmad-output/implementation-artifacts/epic-9-retro-2026-09-07.md] - action item 1 and
  decision 1, which make this story a blocker on Story 11.2
- [Source: src/compliance/jobwork-offcut-disposal.ts:1745-1752] - the revaluation call into
  `resolveAcquisitionApproval`, the line this story replaces
- [Source: src/compliance/jobwork-offcut-disposal.ts:566-568] - the shape validator's UUID-only check
  on `approved_by`, beside its correct `posted_by` check
- [Source: src/compliance/jobwork-offcut-disposal.ts:679-682] - the "bearer credential" comment to
  delete
- [Source: src/compliance/jobwork-offcut-disposal.ts:543-551] - the correct contract, on the
  acquisition approval path
- [Source: src/compliance/jobwork-offcut-disposal.ts:1314,1502] - the propose and approve appliers to
  model on
- [Source: src/api/v1/service-orders.ts:2091] - `callerFields` carrying `approved_by`
- [Source: src/api/v1/service-orders.ts:2241-2270] - the approve route to port, with its review fixes
- [Source: read/projections/job_work_offcut_acquisition_proposal.sql] - the table being extended, and
  its header comment explaining why each property exists
- [Source: _bmad-output/implementation-artifacts/9-8-offcut-acquisition-cfo-approval.md] - the story
  this one completes

## Dev Agent Record

### Agent Model Used

Claude Opus 5 (1M context), model id `claude-opus-5[1m]`.

### Debug Log References

Table 3 records the per-guard mutation verification required by Task 7.4. Each mutation was applied
alone, the named arm of `test/integration/story-9-9.test.ts` was run, and the file was restored from
the bytes read before the edit. Nine of eleven were killed.

| **Mutation** | **Guard reverted** | **Result** |
| --- | --- | --- |
| M1 | Frozen-approver comparison in `applyJobworkOffcutRevaluationApproved` | KILLED |
| M2 | Frozen-approver comparison in the shared approve route | SURVIVED, equivalent |
| M3 | Propose-time dual control in `applyJobworkOffcutRevaluationProposed` | KILLED |
| M4 | Below-band proposal refusal | KILLED |
| M5 | Above-band refusal in `applyJobworkOffcutRevalued` | KILLED |
| M6 | The AC 5 superseded-document check | KILLED |
| M7 | `approved_by` restored to the revaluation route's `callerFields` | KILLED |
| M8 | `approved_by` restored to `REVALUATION_FIELDS` (closed shape) | KILLED |
| M9 | The `kind` guard in `applyJobworkOffcutRevaluationApproved` | KILLED |
| M10 | The `kind` guard in the shared approve route | SURVIVED, equivalent |
| M11 | The events-door finance gate on the revaluation proposal | KILLED |

The two survivors are ROUTE-half duplicates of seam guards that were themselves killed (M2 duplicates
M1, M10 duplicates M9). With either route pre-check removed the applier refuses with the identical
status, error code and audit row, so nothing observable changes. That is the documented design, not
a gap: the routes' own comments say the pre-check "merely fails the wrong route caller before any
event work, instead of after". Killing them would require asserting an implementation detail rather
than a behaviour, so they are reported as equivalent mutants instead of being chased.

M9 did NOT die on the first pass. The cross-route arm as first written exercised only the
acquisition door against a revaluation proposal, which the ACQUISITION applier's own guard catches;
the reverse direction, an acquisition proposal reached through the revaluation door, was untested.
The arm was extended and M9 then died.

### Completion Notes List

Story 9.9 closes deferred-work 9.8-2. An above-band offcut revaluation is now PROPOSED and executes
nothing until the resolved `cfo` approves through their own authenticated request; `approved_by` is
gone from the revaluation route's allow-list, from `REVALUATION_FIELDS`, from the shape validator and
from the payload interface, so no request body can name an approver on either door.

FOUND BY EXECUTION, NOT BY READING. Task 2's list of registries did not include the events door, and
`src/api/v1/events.ts` was named by no task. The `OFFCUT_VALUATION_EVENT_TYPES` gate that forces a
proposer to hold `finance_controller` therefore did not cover
`jobwork.offcut_revaluation_proposed`, and a `jobwork_coordinator` posted a priced revaluation
proposal successfully. The test arm written for the gate failed on its first run and is what caught
it (mutation M11 re-confirms it). The event type was added to that set; its approved twin stays out
for the reason its acquisition twin does.

A SECOND GAP the task list did not name: with one table carrying both signatures, `kind` becomes part
of a proposal row's identity. Without a guard, `jobwork.offcut_acquisition_approved` aimed at a
revaluation proposal would have run the DISPOSAL effects, minting an owned lot and transferring title
on a holding disposed of long ago. The guard was added to the existing acquisition applier as well as
the new revaluation one, and to the shared route.

Deviations from the task list as written, all deliberate:

1. Task 1.4 asked for `supersedes_credit_note_id UUID` and `currency TEXT`. Only the first was added:
   `currency TEXT NOT NULL` already existed on the Story 9.8 table and was already frozen at propose
   time, so adding it again would have duplicated a column. Nothing the task wanted is missing.
2. Task 5.3 asked for `resolveAcquisitionApproval`'s `claimedApprover` PARAMETER to be removed. After
   Task 5 no call site remained at all, so the whole function was deleted rather than left as a
   parameterless helper nothing calls. Strictly stronger than the task, and it takes the "bearer
   credential" paragraph with it as Task 5.3 required.
3. Task 4.4 said to PORT `approveOffcutAcquisitionProposalBase` including its 2026-09-07 review
   fixes. It was parameterised by `kind` instead and both handlers call the one function, so those
   fixes are literally shared rather than copied. A copy would have inherited the fixes once and
   drifted from the next one.
4. Task 6.1 and 6.2 asked for the new refusals to be registered. No genuinely new error code was
   needed: `APPROVAL_REQUIRED`, `INVALID_PARAMS` and `CREDIT_NOTE_SUPERSEDED` are already in
   `PERMANENT_ERROR_CODES` and in `edge/src/messages/en.json`. The `CREDIT_NOTE_SUPERSEDED` message
   was broadened to cover its second use rather than adding redundant entries. Reported here because
   the task expected additions.
5. A constraint the task list did not ask for, `chk_job_work_offcut_acq_proposal_kind`, ties
   `supersedes_credit_note_id` to `kind`: required on a revaluation proposal, refused on an
   acquisition. AC 5 depends on that column being present, and a CHECK is where the Story 9.8 table
   already expresses that class of rule. No foreign key was added to `job_work_credit_note`: the
   applier freezes the id from a row it has just read under lock in the same transaction, and an FK
   would add a cross-file apply-order dependency for no reachable case.
6. `markOffcutRevaluationProposalApproved` is a separate writer rather than the existing one
   parameterised on a column name, and both now carry a `kind` predicate. The widened lifecycle
   CHECK requires EXACTLY ONE of the two event ids matching `kind`, so a shared writer would turn a
   mismatch into an unclassified 23514 500.

DISCLOSED GAP, recorded as deferred-work 9.9-1. A proposal refused `CREDIT_NOTE_SUPERSEDED` is stale
forever and still holds the holding's one pending slot, because Story 9.8 reserved the `superseded`
status for a withdrawal path that nothing writes. Story 9.9 did not invent one: withdrawing a pending
signature request is its own authority question. The refusal message was rewritten so it does not
tell a finance controller to re-propose, which would refuse them `DUPLICATE_EVENT`, and the test
asserts the gap so it cannot change silently. Ledger entries 9.9-2 (nine codes of pre-existing drift
between the server and edge `PERMANENT_ERROR_CODES` sets) and 9.9-3 (the `acquisition_proposals`
response key now carries both kinds) were raised at the same time.

TASK 5.4 SWEEP RESULT. Four other call sites accept a caller-supplied `approved_by`
(`src/api/v1/compliance.ts:380,465` and `src/api/v1/quality.ts:2970,3032`), and all four are
DENY-lists: the field is refused there, not accepted. Two more are genuine claim fields
(`src/compliance/production-completion.ts:460` for over-completion and
`src/compliance/custody-ledger.ts:1146` for over-norm loss), but neither carries the 9.8-2 defect:
each compares the claim against `resolveApprover`'s output AND, two lines later, requires
`envelope.metadata.actor.user_id` to equal the resolved approver. The acting-user check is the real
gate there, and it is single control by design (the Story 9.4 shape, deliberately inverted against
this one). The claim field is redundant in both, not forgeable into a bypass. The acquisition path
closed by Story 9.8 and the revaluation path closed here were the only two where a claimed string was
the ONLY barrier. There is no third instance.

TASK 8 DATA CHECK. On the only database reachable from this environment, the `ims-postgres-test`
instance on port 5442, there are 29 `jobwork.offcut_revalued` events and ZERO of them carry a
non-null `approved_by`. The 151 `job_work_offcut_holding` rows with `approved_by` set therefore all
come from the acquisition path, never from a revaluation recorded under the forgeable contract. No
pilot or production database is reachable from here, so this answer covers the test instance only and
the same query should be run against the pilot database before go-live.

GATES. `tsc --noEmit` clean; `eslint src/ test/` clean; `prettier --check` clean on every file this
story touched. `db:migrate` run twice in a row against the test instance, both clean, so the additive
columns and the DROP-then-ADD constraint blocks are idempotent. `story-1-9` (spine) 6/6, `story-9-7`
38/38 and `story-9-8` 13/13 all pass UNCHANGED, with no fixture edits.

FULL SUITE: 2020 passed, 1 failed, out of 2021 across 146 suites. The baseline at Story 9.10's close
was 2007/2007; this story adds 14 tests (12 integration plus the schema-drift and event-registry
pins), and 2007 + 14 = 2021 exactly. ZERO new failures. The single failure is
`story-5-3` "does not report superseded or retired lines in the where-used impact walk", the
pre-existing clock-window flake this story's Testing Standards names, and its mechanism was
identified rather than assumed: `where_used_impact.ts:101,111` filter on
`effective_to >= CURRENT_DATE`, which Postgres evaluates in UTC, while the ECO implement path stamps
`effective_to` with the application's IST calendar date. Between 00:00 and 05:30 IST the stamped date
is one day ahead of the database's, the retired line still satisfies the filter, and the arm fails.
The full run crossed midnight IST. Nothing in Story 9.9 touches BOM, ECO or where-used code.

### File List

Table 4 lists every file this story added or changed.

| **File** | **Change** |
| --- | --- |
| `read/projections/job_work_offcut_acquisition_proposal.sql` | MODIFIED: `kind`, `supersedes_credit_note_id`, `revaluation_event_id`, the new kind CHECK, the widened lifecycle CHECK, the standalone upgrade path, header rationale |
| `deploy/compose/init-db.sql` | MODIFIED: mirrors the above verbatim |
| `src/read/projections/job_work_offcut_acquisition_proposal.ts` | MODIFIED: the new columns on the row, insert and select; `markOffcutRevaluationProposalApproved`; a `kind` predicate on the acquisition flip |
| `src/compliance/jobwork-offcut-disposal.ts` | MODIFIED: two new event types and appliers, the revaluation band contract, `latestSupersedableCreditNote`, `executeOffcutRevaluationDelta`, `resolveAcquisitionBandAudited`, the acquisition `kind` guard, and the Task 5 deletions |
| `src/events/schema.ts` | MODIFIED: two payload and envelope interfaces, two `SUPPORTED_EVENT_TYPES` entries, `approved_by` removed from `JobworkOffcutRevaluedPayload` |
| `src/events/store.ts` | MODIFIED: both appliers wired into the jobwork chain |
| `src/api/v1/service-orders.ts` | MODIFIED: the revaluation route's caller fields and proposal spec, the approve route parameterised by kind, the new handler, `kind` on the holdings read |
| `src/api/v1/events.ts` | MODIFIED: `jobwork.offcut_revaluation_proposed` added to the events-door finance gate |
| `src/server.ts` | MODIFIED: the revaluation approve route registered |
| `src/sync/upload.ts` | MODIFIED: the `CREDIT_NOTE_SUPERSEDED` rationale extended to its Story 9.9 use |
| `edge/src/messages/en.json` | MODIFIED: the `CREDIT_NOTE_SUPERSEDED` message covers both refusals |
| `test/unit/schema-drift.test.ts` | MODIFIED: the kind constraint pinned by name, the new columns and widened CHECK pinned as TEXT, plus a Story 9.9 event-registry pin |
| `test/integration/story-1-9.test.ts` | MODIFIED: the approve route added to the spine allowlist |
| `test/integration/story-9-9.test.ts` | NEW: 12 arms covering AC 1 through AC 6, the forgery arm on both doors, and the kind discriminator in both directions |
| `_bmad-output/implementation-artifacts/deferred-work.md` | MODIFIED: 9.8-2 marked RESOLVED; entries 9.9-1, 9.9-2 and 9.9-3 raised |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | MODIFIED: story status |

## Change Log

Table 2 records the revisions to this story file.

| **Date** | **Change** |
| --- | --- |
| 2026-09-07 | Story created to close deferred-work 9.8-2 and unblock Story 11.2, after the Project Lead ruled for extending the two-step flow rather than blocking above-band revaluation outright. |
| 2026-09-09 | Implemented. All 8 tasks and 39 subtasks complete; status set to review. Two gaps the task list did not name were closed (the events-door finance gate on the new proposal event, and the `kind` guard that stops an acquisition approval executing a revaluation proposal), six deviations disclosed, and three deferred-work entries raised. |
| 2026-09-09 | Code review complete (three adversarial layers). 0 decision-needed, 6 patch findings fixed, 7 deferred (4 new entries 9.9R-1 to 9.9R-4), 6 dismissed. Status set to done. |
