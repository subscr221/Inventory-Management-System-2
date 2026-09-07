---
baseline_commit: 6d1195102df07e875938175ea61b3ecc9b9a45b3
---
# Story 9.8: Offcut Acquisition CFO Approval (Two-Step Signature)

Status: done

Epic: 9 (Job Work and Subcontracting)
Story key: `9-8-offcut-acquisition-cfo-approval`
Functional requirements: FR-JW-09/10, FR-JW-12 (extends Story 9.7 AC 7)
Baseline: `6d11951` (current HEAD; Story 9.7 implemented and closed through chunk E, chunk B decision triage applied 2026-09-07).

## Story

As a chief financial officer,
I want to approve an above-band offcut acquisition through my own authenticated action, not by a value someone else claims on my behalf,
so that the second signature the DOA band requires is a real control, not a string the poster can supply.

## Background — why this story exists

Story 9.7 Task 1's review follow-up (recorded under Chunk A Findings): the interim AC 7 implementation is a **single-event contract**. `resolveAcquisitionApproval` (`src/compliance/jobwork-offcut-disposal.ts:527-580`) resolves who the DOA band's approver *would be* (`resolveApprover`, `src/api/v1/indents.ts:66-98`) and then checks that the **poster's own request** names that same user id in an `approved_by` field on the disposal payload:

```
if (claimedApprover !== approval.approverActorId) { ... APPROVAL_REQUIRED ... }
```

Nothing about this is an authenticated CFO action — it is the acting user (a finance controller, per Task 7.2's gate) asserting a string that happens to match. The bearer-key-leak half of this hazard was already closed in 9.7 (refusals no longer name the resolved approver — see `jobwork-offcut-disposal.ts:568-573`), but the structural gap remains: **the CFO never authenticates to approve; the poster just has to know the right UUID.**

The follow-up finding calls for exactly the fix this story implements: *"a persisted proposal event/state, a role-gated CFO approval action, and revised route/test arms - a change of its own, not a patch on the reviewed single-event contract."* [Source: `_bmad-output/implementation-artifacts/9-7-offcut-holding-disposal-and-valuation.md:393`]

**The precedent already exists in this codebase** — Story 2.5's transfer-request approval flow does this correctly:
- `pending_approval` status persisted on the resolved approver (`src/api/v1/transfer-requests.ts:416`, `src/compliance/transfer-request.ts:309-311`)
- A separate `PATCH /transfer-requests/{id}/approve` route gated on **the caller's own authenticated identity**, not a claimed field: `if (row.approver_actor_id !== actor.userId) throw APPROVAL_REQUIRED` (`src/api/v1/transfer-requests.ts:606-620`)
- The approval is posted as its own event (`transfer_request.approval_decided`) carrying `approver_actor_id: actor.userId` — derived from the authenticated session, never from the request body.

This story ports that shape onto the offcut acquisition DOA band.

## Acceptance Criteria

1. **Given** an `acquired` disposal whose value falls in or above the governed `jobwork.offcut_acquisition` DOA band **when** it is posted **then** no disposal effects occur yet (no lot minted, no credit note raised, no clock stopped) — a proposal is persisted recording the disposition, rate, resolved DOA entry and resolved approver, and the response reflects a pending-approval state, not a completed disposal.
2. **Given** a pending acquisition proposal **when** the resolved `cfo` approver submits their own authenticated approval action **then** the disposal effects from Story 9.7 AC 1 and AC 3 execute exactly as they do today (title transfers, owned lot minted under QC hold, credit note raised citing the invoice, Section 143 clock stopped for that quantity) and the disposal record stores the approver's id from their own auth context.
3. **Given** a pending acquisition proposal **when** anyone other than the resolved `cfo` approver — including the original poster — submits an approval action **then** it is refused with `error_code: "APPROVAL_REQUIRED"` and audited, and no disposal effect occurs.
4. **Given** a pending acquisition proposal **when** the poster (or anyone else) attempts to post a second, competing proposal for the same holding, or attempts to approve it themselves via the original disposal route **then** it is refused — the `approved_by` claimed-value path from the 9.7 interim is removed entirely; there is no longer any field on the disposal request through which a caller can name an approver.
5. **Given** dual control (Story 9.7 AC 7 / BSD-10) **when** the same person holds both `finance_controller` and `cfo` **then** the approval action refuses `APPROVAL_REQUIRED` exactly as the interim's inverted acting-user check did — the control is preserved across the two-step redesign, not just carried over as a comment.
6. **Given** a below-band `acquired` disposal, a `returned` disposal, or a free retention (rate zero) **when** it is posted **then** it completes in the SAME single request exactly as Story 9.7 built it — this story only changes the above-band path; nothing below the band gains a proposal step.
7. **Given** a pending acquisition proposal **when** it is queried (e.g. via the holdings GET) **then** its pending state, resolved approver, and proposed terms are visible to authorized readers, so the CFO (or an auditor) can see what is awaiting signature without guessing.
8. **Given** a pending acquisition proposal that is never approved **when** the holding or order is inspected **then** the underlying offcut remains `retained` (Section 143 clock still running, still on the ageing report per AC 9.7-9) — a proposal alone must never be mistaken for a disposal.
9. **Given** the direct `/api/v1/events` door **when** an acquisition proposal or approval event is posted directly **then** the same role/site/dual-control gates apply as on the two REST routes (the 9.7 chunk-C hold-bypass-class precedent at `service-orders.ts:1753-1800` extended to the new event types) — the door cannot be used to skip the second signature.
10. **Given** a proposal-then-approval round trip **when** either step is retried with the same idempotency key **then** it replays cleanly (200, same ids) rather than double-posting — the 9.7 idempotency-binding lesson (`service-orders.ts:1840-1895`, stored-payload target binding) applies to both new routes.

## Tasks / Subtasks

- [x] **Task 1: persisted proposal state (AC 1, 6, 8)**
  - [x] 1.1 Decide and implement the proposal's storage shape. Recommended: a dedicated `job_work_offcut_acquisition_proposal` table (one row per proposal, referencing `holding_id`), following the `job_work_credit_note.sql` pattern (its own append-oriented table rather than overloading `job_work_offcut_holding`'s already-dense disposal-facts CHECK at `read/projections/job_work_offcut_holding.sql:63-164`). Columns: `proposal_id`, `service_order_id`, `holding_id`, `site_id`, `rate`, `currency`, `indicative_rate`, `doa_entry_id`, `resolved_approver_actor_id`, `proposed_by`, `status` (`pending`/`approved`/`superseded`), `created_at`, `decided_at`, `decided_by`, `disposal_event_id` (nullable until approved).
  - [x] 1.2 New event types: `jobwork.offcut_acquisition_proposed` (replaces the above-band branch of `jobwork.offcut_disposed`) and `jobwork.offcut_acquisition_approved` (the second-signature event; its applier performs the AC 1/AC 3 disposal effects that `applyOffcutDisposed` performs today for the `acquired` branch). Register both in `src/events/schema.ts` alongside the existing `jobwork.offcut_disposed`/`jobwork.offcut_revalued` interfaces (`schema.ts:4834-4841` neighborhood).
  - [x] 1.3 In `jobwork-offcut-disposal.ts`, split `resolveAcquisitionApproval` (`:527-580`): the below-band branch keeps today's single-event path unchanged (AC 6). The above-band branch (today's `claimedApprover !== approval.approverActorId` check) is REMOVED — replace with: persist the proposal, return a pending response, do not touch the holding row's disposal facts.
- [x] **Task 2: CFO approval route and applier (AC 2, 3, 5, 10)**
  - [x] 2.1 New route `POST /api/v1/service-orders/:serviceOrderId/offcut-acquisition-proposals/:proposalId/approve`, sibling to the two routes at `service-orders.ts:1973-1996`. Follow the transfer-request precedent exactly: read the proposal (`FOR UPDATE`), check `status = 'pending'`, then `if (proposal.resolved_approver_actor_id !== actor.userId) throw APPROVAL_REQUIRED` — the approver identity comes from the AUTHENTICATED caller (`actorContext(req).userId`), never from the request body (AC 2, 3).
  - [x] 2.2 Dual control (AC 5): also refuse if `actor.userId === proposal.proposed_by` is insufficient on its own — port the 9.7 BSD-10 inversion verbatim: the resolved approver check above already achieves this since `resolveAcquisitionApproval`'s proposal step must refuse to resolve an approver equal to the proposer at PROPOSE time (mirror `jobwork-offcut-disposal.ts:571-580`'s inverted acting-user check into Task 1.3, not just Task 2). Confirm both ends are covered: propose-time (proposer ≠ resolved approver) AND approve-time (approver identity ≠ proposer, redundantly, in case roles changed between propose and approve).
  - [x] 2.3 The approval applier executes the Story 9.7 AC 1/AC 3 disposal effects (mint owned lot under QC hold, raise credit note citing the invoice, stop the Section 143 clock, close the holding row) — reuse the existing `acquired`-branch logic from `applyOffcutDisposed`, now triggered by `jobwork.offcut_acquisition_approved` instead of by the original single-event `jobwork.offcut_disposed`.
  - [x] 2.4 Idempotency (AC 10): both the propose route and the approve route follow the 9.7 stored-payload target-binding pattern (`service-orders.ts:1840-1895`) — a key reused for a different holding/proposal is refused, a genuine retry replays.
- [x] **Task 3: remove the claimed-approver path (AC 4)**
  - [x] 3.1 Remove `approved_by` from `DISPOSAL_FIELDS` (`jobwork-offcut-disposal.ts:120-135`) and from the route's `callerFields` list (`service-orders.ts:1973-1981`). No request to the disposal route can name an approver again.
  - [x] 3.2 Update the event contract: `jobwork.offcut_disposed` payload drops `approved_by`/`doa_entry_id` for the (now below-band-only, or `returned`/free-retention) cases where they were always null anyway; those fields move to the new proposal/approval events.
- [x] **Task 4: events-door parity (AC 9)**
  - [x] 4.1 Extend the 9.7 chunk-C finance-gate precedent (`service-orders.ts:1753-1800`, the `ownership.agreement_set` role-gate idiom in `events.ts`) to `jobwork.offcut_acquisition_proposed` (finance_controller + site scope) and `jobwork.offcut_acquisition_approved` (the resolved-approver-identity check, same as the route — this is the harder one since the direct door has no "read the proposal row first" step built in; the applier must perform the identity check against the persisted proposal, not the door).
- [x] **Task 5: read surface (AC 7, 8)**
  - [x] 5.1 Extend the offcut-holdings GET (`service-orders.ts` GET handler feeding `listOffcutHoldingsByOrder`) to surface any pending proposal on a `retained` holding: `pending_approval: { proposal_id, rate, resolved_approver_actor_id, proposed_by, created_at } | null`. Do not leak the resolved approver's id to unauthorized readers beyond what the existing site-scoped read RBAC already permits — this is a a routing decision, not a bearer secret (the 9.7 refusal-message redaction was about not leaking it in an UNAUTHENTICATED-adjacent refusal path, not about hiding it from an authorized read).
  - [x] 5.2 Confirm (AC 8) the holding's `status` stays `retained` and none of the disposal-facts columns populate while a proposal is merely pending — only the new proposal table changes.
- [x] **Task 6: migration and schema-drift**
  - [x] 6.1 New table DDL under `read/projections/`, mirrored into `deploy/compose/init-db.sql` (LF, per the 9.7 chunk-E correction), migrated via `src/events/migrate.ts`, guarded `IF NOT EXISTS`/idempotent per house convention.
  - [x] 6.2 Extend `test/unit/schema-drift.test.ts` with pins for the new table and the two new event-type schema entries.
- [x] **Task 7: tests**
  - [x] 7.1 New `test/integration/story-9-8.test.ts` (or extend `story-9-7.test.ts` — dev's call, but keep the file under ~2000 lines per the 9.7 experience): propose-then-approve happy path; approval by non-resolved-approver refused; approval by the original proposer refused (dual control at approve time); a below-band acquisition still completes in one request; a pending proposal leaves the holding `retained` and off the disposal-facts columns; idempotent replay on both routes; direct-events-door parity arms for both new event types (mirroring the 9.7 hold-bypass-class arms at `service-orders.ts:1753-1800` and the corresponding test arms).
  - [x] 7.2 Update the now-removed `approved_by` arms in `story-9-7.test.ts` (the AC 7 test block) — those tests move to testing the proposal flow; delete or repoint any assertion on the old claimed-approver contract.
  - [x] 7.3 Full regression: story-9-7, story-9-5 (shared sweep/clock code untouched by this story but re-run for safety), schema-drift, unit suite, tsc/eslint clean.

### Review Findings

Adversarial code review 2026-09-07 (Blind Hunter + Edge Case Hunter + Acceptance Auditor, scoped to
the 14 files this story touches; excludes the unrelated pre-existing uncommitted 9.7 chunk-B sweep
fix sitting in the same working tree). 9 findings routed to action (1 decision, 8 patches), 1
deferred, 2 dismissed as already covered or architecturally deliberate.

- [x] [Review][Defer] Revaluation route/door still accepts a poster-claimed `approved_by`,
  reopening the exact signature-forgery flaw this story exists to close — a `finance_controller` who
  knows the resolved `cfo`'s `user_id` can revalue ANY acquired offcut (including one legitimately
  signed via the new two-step flow) into or above the governed DOA band with zero authenticated CFO
  action, via `POST /service-orders/:id/offcut-revaluations` or the direct events door for
  `jobwork.offcut_revalued`. `REVALUATION_FIELDS` still contains `approved_by`
  [`src/compliance/jobwork-offcut-disposal.ts:200-209`]; the shape validator only checks it is a
  well-formed UUID, never pins it to the authenticated actor
  [`src/compliance/jobwork-offcut-disposal.ts:543-566`]; `applyJobworkOffcutRevalued` still calls the
  unmodified Story 9.7 `resolveAcquisitionApproval` claimed-approver contract with `p.approved_by`
  [`src/compliance/jobwork-offcut-disposal.ts:1670-1683`]; the revaluation route's `callerFields`
  still lists `'approved_by'` [`src/api/v1/service-orders.ts:2082-2088`]. Zero test coverage for this
  path in `story-9-8.test.ts`. — deferred, human decision 2026-09-07: "its taking too much of time."
  Residual risk accepted for now; needs its own follow-up story (extend the two-step flow to
  revaluation, or block above-band revaluation outright) before go-live.

- [x] [Review][Patch] A pending acquisition proposal does not block a competing single-request
  disposal on the same holding, letting the CFO signature be bypassed by re-submitting at a friendlier
  rate — `getPendingProposalForHolding` was built for exactly this guard but is never called anywhere
  in `src/` [`src/read/projections/job_work_offcut_acquisition_proposal.ts:143`,
  `src/compliance/jobwork-offcut-disposal.ts:812-918` (`applyJobworkOffcutDisposed`/
  `offcutDisposalOpen`, no proposal check)]. Once bypassed, the orphaned proposal has no
  supersede/cancel path and the holdings-read API keeps showing it as awaiting CFO signature forever
  [`src/api/v1/service-orders.ts:2451-2475`]. Fix: call `getPendingProposalForHolding` inside
  `applyJobworkOffcutDisposed` (both dispositions) and refuse with a clear, audited error when a
  pending proposal exists on the target holding.

- [x] [Review][Patch] Stale `approved_by?: string` field left on the `JobworkOffcutDisposedPayload`
  TypeScript interface with a doc comment describing the removed claimed-approver contract, even
  though the runtime (`DISPOSAL_FIELDS`, route allow-list) already refuses it — a compile-time
  contract drift Task 3.2 explicitly called for closing [`src/events/schema.ts:4827`]. Fix: delete the
  field and its comment from the interface.

- [x] [Review][Patch] `resolveApprover` (`src/api/v1/indents.ts`) throws `APPROVAL_UNRESOLVED` rather
  than returning `approverActorId: null` when a band matches but no role holder exists, making the new
  `if (band.approverActorId === null)` branch in `applyJobworkOffcutAcquisitionProposed` dead code —
  the thrown error propagates uncaught, skipping `auditedRefusal`, and since `APPROVAL_UNRESOLVED` is
  in `APPLIER_SELF_AUDITED_CODES` the route also skips auditing it, so this refusal is served with NO
  audit_log row [`src/compliance/jobwork-offcut-disposal.ts:1360-1372`]. The identical dead branch
  already exists in Story 9.7's `resolveAcquisitionApproval` (pre-existing, out of scope here), but
  this diff introduces a fresh, closable instance in new code. Fix: wrap the `resolveAcquisitionBand`
  call in `applyJobworkOffcutAcquisitionProposed` in a try/catch routing the thrown AppError through
  `auditedRefusal`.

- [x] [Review][Patch] The propose route's idempotency-retry branch that recognizes a stored
  `JOBWORK_OFFCUT_ACQUISITION_PROPOSED` event has no `spec.bandAware` gate, unlike the sibling branch
  immediately below it — since `postOffcutValuationEvent` is shared with the revaluation route
  (`bandAware` unset there), a key that produced a proposal via the disposal route, reused on the
  revaluation route for the same order/holding, is accepted as a "replay" and returns a
  proposal-shaped response from the revaluation endpoint instead of a revaluation response (no
  double-write, but the wrong response contract) [`src/api/v1/service-orders.ts:1950-1953`]. Fix: add
  `spec.bandAware === true &&` to that condition too.

- [x] [Review][Patch] No validation that an approval event's `occurred_at` is not earlier than the
  proposal's `created_at` before the UPDATE — a backdated `occurred_at` on the direct
  `/api/v1/events` door (unvalidated there) trips the `chk_job_work_offcut_acq_proposal_lifecycle`
  CHECK constraint as an unclassified Postgres 23514, surfacing as a raw 500 instead of a clean
  refusal [`src/compliance/jobwork-offcut-disposal.ts:1456,1576`]. Fix: add an explicit
  `occurredAt < proposal.created_at` check with a clean `INVALID_PARAMS`/409 rejection before calling
  `markOffcutAcquisitionProposalApproved`.

- [x] [Review][Patch] `classifyCreditInsert` — named and messaged for the credit-note table only — is
  reused for the new proposal table's 22003 overflow classification, producing a misleading error
  message ("...exceeds the NUMERIC(18,4) range of the credit note columns") on a proposal-table
  overflow [`src/compliance/jobwork-offcut-disposal.ts:1426`]. Fix: generalize the message/function
  name or add a thin proposal-specific wrapper.

- [x] [Review][Patch] The approve-time "second half" of the dual-control check
  (`if (actingUserId === proposal.proposed_by)`) is provably unreachable given the preceding identity
  check plus the schema's `chk_..._dual_control` constraint — if `actingUserId ==
  resolved_approver_actor_id` and `resolved_approver_actor_id != proposed_by` (guaranteed by the
  constraint), then `actingUserId != proposed_by` always [`src/compliance/jobwork-offcut-disposal.ts:1512`].
  Harmless dead code, but its comment claims it is live defense-in-depth, which could mislead a future
  maintainer (e.g. into thinking finding above about revaluation is already covered by this pattern).
  Fix: correct the comment to describe it as a restated invariant, not a reachable branch.

- [x] [Review][Patch] Dev Agent Record's "Gates run" bullet omits the full regression suite, though it
  was actually run and passed (1988/1989, including Story 9.5, verified against the session's own test
  log) — Task 7.3 explicitly calls out story-9-5 and the unit suite by name. Documentation-completeness
  gap only; the gate itself was satisfied. Fix: add the full-suite result to the Gates run line in the
  Debug Log References section above.

- [x] [Review][Defer] `requireUuidParam` in `service-orders.ts` does not lowercase the UUID path
  param before use (unlike the equivalent helper in `production-completions.ts:188-196`), so a
  same-key retry with different URL-path casing on the new approve route would be wrongly rejected as
  a cross-target `DUPLICATE_EVENT` [`src/api/v1/service-orders.ts:253-259`] — deferred, pre-existing
  (the helper and its case-sensitivity predate this story and are shared by every route in the file;
  fixing it is a cross-cutting change out of this story's scope).

Dismissed (2): AC 8's "still on the ageing report" clause has no new dedicated test, but the property
already holds by composing two independently-tested, unmodified invariants (a pending proposal leaves
the holding `status='retained'`, verified by this story's own tests; the ageing/sweep code, untouched
by this diff, already keys off `status='retained'` and is regression-tested by Story 9.7's own AC 9
arm) — no real gap. Task 2.1's literal wording asks the ROUTE to perform the FOR-UPDATE/identity
check itself; the actual code defers entirely to the applier, which is architecturally deliberate and
necessary for AC 9's cross-door parity (the route has no lock/row to check against) — not a
functional violation, already disclosed by the developer.

## Dev Notes

- **Do not touch** the below-band, `returned`, or free-retention paths — AC 6 is a hard boundary. The single-event contract is CORRECT for those; only the above-band `acquired` path changes shape.
- **Identity, not a claim.** The entire point of this story is that `actor.userId` (from `actorContext(req)`, itself from `getAuthContext(req)`) is the only source of truth for "who is approving." Any field in a request body naming an approver is the exact defect being removed — do not reintroduce it in a different form (e.g. don't accept an `approver_id` field on the approve route "for confirmation").
- **Reuse `resolveApprover`** (`src/api/v1/indents.ts:66-98`) unchanged for resolving the DOA band and candidate approver at PROPOSE time. It already returns `approverActorId`; persist it on the proposal row. Do not re-resolve at approve time (the band and holder could shift between propose and approve; the proposal freezes who was resolved, matching the transfer-request precedent which also freezes `approver_actor_id` at request time).
- **`verify:roles` (Task 0 of Story 9.7, `src/cli/verify-segregated-roles-core.ts`)** already treats `cfo`/`finance_controller` as a segregated pair for the `jobwork.offcut_acquisition` transaction type. No changes needed there — this story only changes HOW the second signature is captured, not the DOA registry or role model.
- **The bearer-key-leak fix stays.** Do not add the resolved approver's id back into any refusal payload (`jobwork-offcut-disposal.ts:568-573`'s reasoning still applies: publishing it would hand anyone the key to impersonate the approval target in a request body — except now there IS no such body field, which is exactly why this story closes the hazard for good rather than just mitigating it).
- **Money/currency/UUID validation helpers** already exist in `jobwork-offcut-disposal.ts` (`MONEY_REGEX`, `CURRENCY_REGEX`, `UUID_REGEX` at `:113-119`) — reuse them for the proposal's rate/currency fields rather than redefining.
- **Naming**: the story deliberately avoids "authorization" vocabulary already used elsewhere (RBAC `functionScope`) — "resolved approver," "proposal," "approve" match the transfer-request precedent's vocabulary for consistency.

### Project Structure Notes

- New table: `read/projections/job_work_offcut_acquisition_proposal.sql` + `.ts` accessor file, alongside the existing `job_work_offcut_holding.*` and `job_work_credit_note.*` pairs.
- New route file location: same file as the existing offcut routes, `src/api/v1/service-orders.ts` (do not create a new route file for two endpoints — house convention keeps job-work routes consolidated there through 9.1-9.7).
- New applier logic lives in `src/compliance/jobwork-offcut-disposal.ts` alongside the existing appliers, not a new compliance file.

### References

- [Source: `_bmad-output/implementation-artifacts/9-7-offcut-holding-disposal-and-valuation.md:393`] — the follow-up finding this story implements, verbatim.
- [Source: `src/compliance/jobwork-offcut-disposal.ts:527-580`] — `resolveAcquisitionApproval`, the single-event contract being replaced.
- [Source: `src/api/v1/indents.ts:66-98`] — `resolveApprover`, reused unchanged.
- [Source: `src/api/v1/transfer-requests.ts:580-650`] — the two-step `pending_approval` + authenticated-approver-identity precedent this story ports.
- [Source: `src/compliance/transfer-request.ts:305-315`] — the `pending_approval` status-assignment precedent.
- [Source: `src/api/v1/service-orders.ts:1753-2040`] — the current offcut valuation route block (finance gate, shared handler, both existing routes) this story extends.
- [Source: `read/projections/job_work_offcut_holding.sql:1-165`] — the holding table this story must NOT overload with proposal state.
- [Source: `_bmad-output/planning-artifacts/epics.md:2753-2790`] — Epic 9 / Story 9.7 epics-level AC text (AC 7 is the one this story supersedes with a real two-step flow).

## Dev Agent Record

### Agent Model Used

claude-opus-5 (1M context)

### Debug Log References

Disclosed decisions and deviations, each one a place where the story's text left a choice open or
where the code forced one:

1. **The disposal route CHOOSES the event type; the appliers are still the authority.** An event
   type has to be fixed before `persistEvent`, and whether an acquisition is above the band depends
   on `quantity x rate`, which needs the holding row. The route therefore reads the holding, computes
   the value and calls `resolveApprover` in `isAboveBandAcquisition`
   (`src/api/v1/service-orders.ts`). That is a convenience, exactly like every other pre-check in
   this file: the disposal applier refuses an above-band acquisition and the proposal applier refuses
   a below-band one, both under the order advisory lock, so the direct events door cannot use the
   wrong event type in either direction. Both refusals are mutation-verified.
2. **`resolveAcquisitionApproval` was kept, not rewritten.** The REVALUATION path still uses the
   Story 9.7 claimed-approver contract, and AC 6 draws the boundary at the acquisition disposal only.
   The disposal path now uses a new `resolveAcquisitionBand` with no claim argument. A revaluation
   that crosses the band therefore still carries the interim contract; that is out of this story's
   scope and is called out here rather than silently widened.
3. **The proposal id doubles as the disposal id.** The approval applier passes `proposal_id` as the
   `disposalId` into the shared effects, so the QC hold's `hold_id` and every duplicate
   classification stay replay-stable without inventing a second identifier on the payload.
4. **`disposed_by` stays the proposer, `approved_by` is the signer.** The holding row keeps
   recording the finance controller who priced the offcut in `disposed_by`; `approved_by` is the CFO
   whose authenticated session executed it. Asserted in both directions in the AC 2 test.
5. **A proposal accepts an optional `location_id` and verifies it.** A proposal moves no stock, so
   the field is meaningless to it, but dropping it silently would be accepted-and-ignored. It is in
   the closed shape and checked against the holding row by `offcutDisposalOpen`.
6. **`superseded` is in the status CHECK but nothing writes it.** The story named three statuses; a
   withdrawal path is not in any AC. The value is admitted by the constraint and the lifecycle CHECK
   keeps it honest if a later story adds one.
7. **The approve-time proposer check is defensive and cannot be reached today.** The schema's
   `chk_job_work_offcut_acq_proposal_dual_control` and the propose-time check both refuse a proposal
   whose proposer is its resolved approver, so `actingUserId === proposal.proposed_by` can only fire
   if a row predates them. It is kept because Task 2.2 asks for both ends explicitly, and because
   the proposer is refused in practice by the identity check one line above it (tested).
8. **`jobwork.offcut_acquisition_approved` is deliberately NOT on the events door's finance gate.**
   The approver is the `cfo`, who holds no `finance_controller` assignment - that separation is the
   control. The door has not read the proposal row, so the identity check lives in the applier where
   the frozen `resolved_approver_actor_id` is available. Proven on the door by the AC 9 arms.
9. **Two test-fixture expectations corrected during the run.** The Story 9.7 harness dispatches
   output before capturing the offcut, so `jobwork_return_clock.reconciled_qty` is already non-zero
   when a proposal is filed. The AC 1 and AC 2 arms assert the DELTA (unchanged on propose, plus the
   acquired quantity on approve) rather than absolute values.

Mutation verification (each mutant introduced, the suite run, the mutant reverted):

| Mutation | Guard removed | Result |
| --- | --- | --- |
| 1 | approve-time `resolved_approver_actor_id !== actingUserId` | story-9-8 2 failures |
| 2 | propose-time `band.approverActorId === p.posted_by` | story-9-8 1 failure |
| 3 | disposal applier's above-band `band.requiresApproval` refusal | story-9-7 2 failures |

Table 1: the three guards this story adds, each killed by an existing arm.

Gates run: `tsc --noEmit` clean, `npm run lint` clean, `npm run db:migrate` twice (idempotent),
`test/unit/schema-drift.test.ts` 160/160, `test/integration/story-9-8.test.ts` 9/9,
`test/integration/story-9-7.test.ts` 30/30, full regression suite (`npm test`) 1988/1989 including
Task 7.3's story-9-5 and the general unit suite (code review 2026-09-07: this line previously
under-itemized the gates actually run, omitting the full-suite result even though it was run and
passed the same session; the single failure is the pre-existing story-5-3 where-used flake,
independently verified failing at baseline in a stashed tree, 0 new).

### Completion Notes List

- The Story 9.7 AC 7 single-event contract is gone. `approved_by` no longer exists on
  `jobwork.offcut_disposed` (payload, route allow-list, or `DISPOSAL_FIELDS`), so there is no field
  on any door through which a caller can name an approver.
- An `acquired` disposal in or above the `jobwork.offcut_acquisition` DOA band now persists a row in
  the new `job_work_offcut_acquisition_proposal` table and performs no disposal effect: the holding
  stays `retained`, the offcut stock stays in its segregated class, no lot is minted, no credit note
  is raised and the CGST Section 143 clock keeps running.
- The second signature is a POST to
  `/api/v1/service-orders/:serviceOrderId/offcut-acquisition-proposals/:proposalId/approve`, gated on
  the caller's own authenticated identity against the approver frozen on the proposal at propose
  time. The Story 9.7 AC 1 and AC 3 effects were extracted into a shared `executeOffcutDisposal` and
  are now driven by that approval instead of by a claim.
- Dual control (BSD-10, inverted against the Story 9.4 chain) is enforced at propose time, at approve
  time, and as a table constraint, so a `finance_controller` who also held `cfo` cannot file a
  proposal only they could sign.
- Below-band acquisitions, free retentions (rate zero) and `returned` disposals are untouched: they
  still complete in one request, and a below-band acquisition may not be proposed either.
- Both new event types are registered, both meet the same wall on `POST /api/v1/events` as on the
  routes, and both steps are idempotent with stored-payload target binding.
- **Code review 2026-09-07 (Blind Hunter + Edge Case Hunter + Acceptance Auditor, scoped diff):** 8
  patches applied, closing a real bypass (a pending proposal did not block a competing single-request
  disposal on the same holding — `getPendingProposalForHolding` had been written but never wired in),
  a missing-audit-row gap on an unreachable `APPROVAL_UNRESOLVED` branch, a cross-route idempotency
  confusion (a proposal key replayed against the revaluation route), an unvalidated backdated
  `occurred_at` on the direct approval event (would have surfaced as a raw Postgres 500), a stale
  `approved_by` field left on the `JobworkOffcutDisposedPayload` TypeScript interface, a misleading
  error-classification message reused from the credit-note path, a misleading "live defense in depth"
  comment on a provably unreachable check, and the Debug Log's own "Gates run" line under-itemizing
  what was actually run. 1 decision-needed finding — the revaluation route/door still accepts a
  poster-claimed `approved_by`, reopening the same signature-forgery flaw this story closes on the
  disposal path — was human-deferred (see Debug Log item 10 and `deferred-work.md` ref 9.8-2); it is
  a real, disclosed residual risk that needs a follow-up story before go-live. 3 new regression tests
  added for the three behavior-changing patches, all 3 mutation-verified (each kills exactly the
  guard it was written for, confirmed by reverting the guard and reintroducing the failure). Full
  regression re-run after patching: `test/integration/story-9-8.test.ts` 12/12,
  `test/integration/story-9-7.test.ts` 30/30, `test/unit/schema-drift.test.ts` 160/160, tsc/eslint
  clean, `db:migrate` still idempotent.

### File List

- `read/projections/job_work_offcut_acquisition_proposal.sql` (new)
- `src/read/projections/job_work_offcut_acquisition_proposal.ts` (new)
- `test/integration/story-9-8.test.ts` (new; +3 tests added in the review-patch round)
- `deploy/compose/init-db.sql`
- `src/api/v1/events.ts`
- `src/api/v1/service-orders.ts`
- `src/compliance/jobwork-offcut-disposal.ts`
- `src/events/migrate.ts`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/server.ts`
- `test/integration/story-1-9.test.ts`
- `test/integration/story-9-7.test.ts`
- `test/unit/schema-drift.test.ts`
- `_bmad-output/implementation-artifacts/9-8-offcut-acquisition-cfo-approval.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `_bmad-output/implementation-artifacts/deferred-work.md` (review round: 2 deferrals recorded)

## Change Log

| Date | Change |
| --- | --- |
| 2026-09-07 | Story 9.8 implemented from baseline `6d11951`: the two-step CFO signature replaces the Story 9.7 claimed-approver contract. All 7 tasks complete, 9 new integration arms, 3 guards mutation-verified. |
| 2026-09-07 | Adversarial code review (3 layers): 1 decision-needed finding human-deferred (revaluation route/door still accepts a claimed `approved_by` — tracked as deferred-work 9.8-2, needs a follow-up story), 8 patch findings fixed with 3 new mutation-verified regression tests, 1 pre-existing helper-casing issue deferred (9.8-1), 2 findings dismissed as already covered. Full suite green, 0 new failures. |
| 2026-09-07 | SECOND bmad-code-review pass over the same working tree: 4 patches applied (the approve route was ported to the exact Story 2.5 transfer-request transaction — proposal row FOR UPDATE inside the same transaction that persists the approval, closing the TOCTOU between the handler's reads and the applier, with the identity/dual-control/status pre-checks run against that locked row on the fresh path only so AD-16 replays still answer against the stored event; handler-raised `APPROVAL_REQUIRED` now self-audits because the route catch skips `APPLIER_SELF_AUDITED_CODES` and the refusal never reaches the applier — caught by the AC 3 arm as an unaudited refusal; the response re-reads the proposal after COMMIT so it cannot describe a row a concurrent writer changed; the `OA` lot sequence derives from MAX over the `-OA{n}` suffix with COALESCE instead of `COUNT(*)::int`). RBAC finding resolved without a new functionScope (handler identity check refuses wrong callers before any event work; every approve route keeps the write scope). Gates: story-9-8 12/12, story-9-7 30/30, story-1-9 10/10, tsc/eslint/prettier clean. |

Table 2: the change log for Story 9.8.
