---
baseline_commit: 5be1c3a
---

# Story 11.2: IRN-Before-Dispatch Enforcement

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a dispatch controller,
I want dispatches blocked until the IRN is received,
so that no non-compliant shipment leaves the site.

## Acceptance Criteria

1. **Given** an e-invoiceable supply ready to dispatch (FR-AC-14, INT-GST-01), **when** dispatch is
   attempted before the IRN is received from the IRP flow through ERP, **then** dispatch is blocked
   with `error_code: "IRN_MISSING"` until the IRN is present.
2. **Given** an IRN returned by the IRP through ERP (FR-AC-14, INT-GST-01), **when** it is recorded
   against the supply, **then** it is stored against it, the dispatch block lifts, and a replay of
   the same recording is idempotent.

RULED 2026-09-05: the SIGNED QR is NOT required by this platform, and ALL supplies are e-invoiceable
with no exemption to model. The gate is the IRN alone, on the understanding that ERP owns producing
and printing the QR. This deliberately diverges from the "IRN and signed QR" wording of FR-AC-14 and
of the epic; the divergence is recorded here rather than hidden.

## Prerequisites

Both items below were confirmed with the Project Lead in the Epic 9 retrospective on 2026-09-07 and
must be closed BEFORE this story starts. They are not part of this story's scope.

1. **Story 9.9 must land first.** It closes deferred-work 9.8-2: the offcut revaluation route and the
   direct events door still accept a poster-claimed `approved_by` compared only against
   `resolveApprover`'s output, never against an authenticated CFO session. This is the same
   signature-forgery contract Story 9.8 closed on the disposal path, still fully reachable on
   revaluation. It was human-deferred under time pressure and converted into a blocking follow-up by
   retrospective decision 1. The Project Lead ruled on 2026-09-07 to close it by extending the
   two-step CFO flow, and Story 9.9 (`9-9-offcut-revaluation-cfo-approval.md`) is that work,
   `ready-for-dev`.
2. **Story 9.10 must land first, and before Story 9.9.** It carries the hold-bypass guard sweep of
   retrospective decision 3: audit every quality and custody gate-check call site once against the
   `dispatchGateBlockedLots` shared-guard pattern, instead of continuing to catch instances one story
   at a time in review. This story adds a THIRD condition to the same dispatch seam, so it broadens
   exactly the surface that sweep covers, and the sweep already has one confirmed hit inside
   `applyDispatchDispatchedProjection` - the applier this story extends. Landing 11.2 first would
   mean patching that seam twice. Story 9.10
   (`9-10-pre-pilot-gate-and-offcut-cleanup.md`) is that work, `ready-for-dev`.

The running order is Story 9.10, then Story 9.9, then this story.

## Tasks / Subtasks

- [x] Task 1: the `dispatch_irn` projection (AC: 1, 2)
  - [x] 1.1 New `read/projections/dispatch_irn.sql`, mirrored into `deploy/compose/init-db.sql`,
        appended to the projection list in `src/events/migrate.ts` (the tail of that list ends at
        `job_work_offcut_acquisition_proposal.sql`, line 270) and pinned in
        `test/unit/schema-drift.test.ts` with the FULL index and constraint statements, following the
        `custody_ledger_entry` pin at `test/unit/schema-drift.test.ts:1731-1748`. A name-only pin
        stays green when `UNIQUE` is dropped or added: that is the Story 9.6 group-A lesson, and it
        cuts both ways here, because this table's uniqueness rules are deliberately narrow. See
        Task 1.3.
  - [x] 1.2 Grain is COVERAGE: one row per DISPATCH ORDER, recording which invoice covers it. Read
        binding decision 2 before writing the DDL; the two facts driving it are that a dispatch order
        is an `erp_sales_order` row at `(so_number_ext, line_no)` grain, and that ERP raises MULTIPLE
        invoices against the same order (ruled 2026-09-07), so neither `so_number_ext` nor
        `invoice_number_ext` is unique here. Columns: `dispatch_order_id UUID PRIMARY KEY`, plus
        `invoice_number_ext TEXT NOT NULL`, `irn_ext TEXT NOT NULL`, `so_number_ext TEXT NOT NULL`,
        `irp_acknowledged_at TIMESTAMPTZ`, `site_id UUID NOT NULL`, `recorded_by UUID NOT NULL`,
        `source_event_id UUID NOT NULL`, `correlation_id`, `created_at`, `updated_at`.
        `so_number_ext` is server-derived from `erp_sales_order`, stored for query convenience only,
        and never the key.
  - [x] 1.3 Constraints: `chk_dispatch_irn_present` requiring `irn_ext` non-blank, and the same for
        `invoice_number_ext`. `idx_dispatch_irn_source_event` on `source_event_id` is a PLAIN index,
        NOT unique: one recording event legitimately writes N coverage rows, one per dispatch order
        the invoice covers. `idx_dispatch_irn_invoice` on `(invoice_number_ext)` and
        `idx_dispatch_irn_so` on `(so_number_ext)` serve the reads. Guarded DO block using
        DROP-then-ADD, not add-if-absent (the `bom_line` precedent). Pin all of these in
        `test/unit/schema-drift.test.ts`, and pin the source-event index EXPLICITLY as non-unique so
        a later reader cannot "restore" a UNIQUE that would break multi-line invoices.
  - [x] 1.4 `src/read/projections/dispatch_irn.ts` with `insertDispatchIrnCoverage`,
        `getDispatchIrn(dispatchOrderId)` and a `dispatchIrnPresent(dispatchOrderId, client)` reader
        the gate calls. `dispatchIrnPresent` is a direct primary-key lookup: the gate already holds
        the dispatch order id, and coverage is stored at exactly that grain, so no join is needed on
        the hot path.

- [x] Task 2: the recording event and its applier (AC: 2)
  - [x] 2.1 Event type `dispatch.irn_recorded` on the EXISTING `warehouse` stream. VERIFIED at HEAD:
        all three dispatch events are registered `streamType: 'warehouse'`, not `'dispatch'`
        (`src/events/schema.ts:5097-5108`, under the Story 3.7 comment), and
        `postDispatched` posts `stream_type: 'warehouse'` with `stream_id: dispatchOrderId`
        (`src/api/v1/dispatch.ts:386-390`). There is no `dispatch` stream type. Do not invent one:
        an unregistered stream type fails the Story 1.9 spine acceptance gate.
  - [x] 2.2 It must NOT be named `erp.*` and must NOT ride stream `erp`: `assertErpReadOnly`
        (`src/compliance/erp-readonly.ts:16-28`) 405s both with `SOURCE_SYSTEM_READ_ONLY`, and Story
        9.6 hit exactly this wall (binding decision 7). The IRN comes FROM the IRP THROUGH ERP, but
        recording it is this platform's own write.
  - [x] 2.3 Register the type in `SUPPORTED_EVENT_TYPES` with `streamType: 'warehouse'` and
        `requiresBusinessStream: false`, matching its three siblings. Recording an IRN posts no
        valuated movement. Story 9.6's group-A review found three event types missing from that
        registry; the consumer fails open, so the omission is invisible. Do not repeat it.
  - [x] 2.4 `assertDispatchIrnShape` (pre-transaction, no DB) and `applyDispatchIrnRecorded` (inside
        the transaction), the split every seam in this repo uses. Wire both in `src/events/store.ts`
        beside the existing dispatch wiring: the assert block at lines 620-628, the applier dispatch
        at lines 943-957. Caller supplies `invoice_number_ext`, `irn_ext`, `dispatch_order_ids` (a
        non-empty array, the coverage list), `irp_acknowledged_at`, `recorded_by` and `site_id`;
        `so_number_ext` and every other field is server-derived and refused on input. The payload
        MUST carry `site_id`: that is the only reason `assertPayloadSiteWriteAccess`
        (`src/api/v1/events.ts:71-89`) fires on the direct events door, and an event without one is
        silently uncovered there. The applier then binds payload site to row site by checking every
        listed dispatch order resolves to that same site, refusing the whole event otherwise.
  - [x] 2.5 One event writes N coverage rows, one per listed dispatch order, in a single transaction.
        Replay is idempotent through `alreadyPersisted`, never a bespoke pre-read (the Story 8.8
        lesson that a pre-read replay check is not a persisted-event signal). Do NOT reach for a
        unique index on `source_event_id` to get idempotency: see Task 1.3.
  - [x] 2.6 A dispatch order already covered by a DIFFERENT invoice is a genuine conflict, not a
        replay. The `dispatch_order_id` primary key raises 23505 and the applier classifies it 409
        `DISPATCH_IRN_CONFLICT`, naming the dispatch order and both invoice numbers. Do not upsert
        over it: silently rewriting which invoice covers a shipment is exactly the audit hole this
        story exists to close. Re-recording the SAME invoice against the same dispatch order is a
        no-op that succeeds, so the classification compares `invoice_number_ext` on the existing row.

- [x] Task 3: the dispatch gate (AC: 1)
  - [x] 3.1 Extend `dispatchGateBlockedLots` in `src/compliance/dispatch.ts:58`, or add a sibling
        helper called from the same place, so that EVERY dispatch surface meets the IRN check through
        ONE helper. Read the header comment at `src/compliance/dispatch.ts:45-57` first: it states
        the rule ("Every dispatch surface calls THIS, never one half of it") and records that
        forgetting one half of that gate has shipped as a hold-bypass defect five times
        (Stories 8.3, 8.4, 8.5, 8.8, 9.4).
  - [x] 3.2 Note the shape difference before writing: the existing gate is LOT-keyed and returns
        blocking lot ids by reason, while the IRN is DISPATCH-ORDER-keyed. Do not force the IRN
        answer into the `{ heldLotIds, qcGatedLotIds }` return shape. Either widen that return with a
        third, differently-keyed field, or add `dispatchGateIrnMissing(dispatchOrderId, client)` and
        call it from the same call sites in the same locked transaction. Whichever is chosen, there
        must be exactly ONE place a future dispatch surface has to call.
  - [x] 3.3 The block fires on `dispatch.dispatched` - the final dispatch - and is re-derived INSIDE
        the transaction, never only at the route. A direct `POST /api/v1/events` must meet the
        identical wall. The insertion point is `applyDispatchDispatchedProjection`
        (`src/compliance/dispatch.ts:400`), AFTER the `DISPATCH_DOCUMENTS_NOT_GENERATED` count check
        and beside the hold and QC rechecks, so it runs under the same locked transaction that has
        already taken `dispatch_order_status ... FOR UPDATE`.
  - [x] 3.4 BE AWARE, and do not "fix" it here: `applyDispatchDispatchedProjection` does NOT call
        `dispatchGateBlockedLots` today. It inlines its own `packing_record JOIN lot_master ...
        FOR UPDATE OF lm` hold query and then calls `qcGatedLotIds` directly. That divergence from
        the header comment's own rule is exactly what the retrospective's hold-bypass sweep
        (Prerequisite 2) exists to consolidate, and consolidating it is that sweep's scope, not this
        story's. Your obligation here is narrower: put the IRN check in ONE helper and call it from
        every dispatch surface that needs it, so this story adds no new ad-hoc call site.
  - [x] 3.5 Refusal is `IRN_MISSING` at 409 with details naming `dispatch_order_id` and
        `so_number_ext`. The 409 is deliberate even though its three sibling refusals in the same
        applier (`DISPATCH_ORDER_NOT_PACKED`, `DISPATCH_ORDER_ALREADY_DISPATCHED`,
        `DISPATCH_DOCUMENTS_NOT_GENERATED`) and the inlined `LOT_ON_HOLD` are all 400: a missing IRN
        is an external-state conflict that a later request can clear, not a malformed request. Do not
        silently align it to 400, and do not renumber the siblings.
  - [x] 3.6 THERE IS NO OVERRIDE. The access matrix lists IRN-less dispatch of an e-invoiceable
        supply under "Blocked-for-everyone rows (design invariants, not SoD)" and marks
        `dispatch_clerk` "cannot dispatch e-invoiceable supply without IRN - no override"
        (`access-matrix-frontline-draft-2026-07-11.md:48,250`). Do not add a DOA path, an approval
        path or a config flag that disables it.

- [x] Task 4: which supplies are e-invoiceable (AC: 1)
  - [x] 4.1 Implement the binding-decision rule below as a single pure predicate,
        `dispatchIsEInvoiceable(...)`, parameterised so a unit test can fail it (the 8.4
        tautological-config lesson: a config asserted against itself is not a test).
  - [x] 4.2 Job-work output dispatch (`src/compliance/jobwork-dispatch.ts`) is OUT of scope: it
        returns the customer's own material under a delivery challan and is not a supply (binding
        decision 3, CONFIRMED 2026-09-06). Add an explicit test arm proving a job-work dispatch is
        NOT blocked, so a later reader cannot mistake the ruling for an oversight.

- [x] Task 5: error code registration and the refusal audit row (AC: 1)
  - [x] 5.1 `IRN_MISSING` and `DISPATCH_IRN_CONFLICT` into `PERMANENT_ERROR_CODES` in
        `src/sync/upload.ts:18`: a retry of the same dispatch never clears a missing IRN (the IRN has
        to arrive first), and a retry of the same recording never clears a coverage conflict (the
        wrong invoice has to be corrected in ERP first). Both follow the `BILLING_NOT_READY` and
        `CUSTODY_NOT_ZERO` precedents in that same set. Add each ONCE. That set already carries
        `LOT_ON_HOLD` twice, at lines 25 and 118; do not add a third duplicate of anything.
  - [x] 5.2 A refused non-compliant dispatch attempt is exactly the event an auditor will ask about,
        so it must leave an audit row. VERIFIED at HEAD: `src/api/v1/dispatch.ts` has NO
        `AUDITED_REJECTIONS` set and NO try/catch on `postDispatched` - it passes `auditCtx` into
        `persistEvent` (line 386), which audits the SUCCESS path only, and the applier's throw rolls
        the transaction back with it. So the audit row does not exist today and this story must
        create it. Follow the pattern at `src/api/v1/compliance.ts:45` (the `AUDITED_REJECTIONS` set)
        and `src/api/v1/compliance.ts:248-255` (the catch that calls `auditFailSafe` before
        `sendAppError`, with the comment "A failing audit write must never replace the contracted
        error with a 500"). Alternatively use the applier-self-audit route taken in Story 9.8
        (`APPLIER_SELF_AUDITED_CODES`, `src/api/v1/service-orders.ts:168`); pick one and state which
        in the Completion Notes, but do not leave the refusal unaudited.
  - [x] 5.3 `errors.IRN_MISSING` message into `edge/src/messages/en.json`, beside the existing
        `errors.LOT_ON_HOLD` and `errors.BILLING_NOT_READY` entries.

- [x] Task 6: API surface (AC: 2)
  - [x] 6.1 `POST /api/v1/dispatch/:dispatchOrderId/irn` recording the IRN, registered
        in `src/server.ts` beside the existing `/pack`, `/generate-documents` and `/dispatch` routes
        (`src/server.ts:1198-1208`). The path names ONE dispatch order because that is what the
        dispatch desk has in hand and what `resolveDispatchOrderSite` plus `assertSiteAccess`
        already scope on. The body carries `invoice_number_ext`, `irn_ext`, `irp_acknowledged_at`
        and an OPTIONAL `also_covers` array of further dispatch order ids on the same invoice; the
        path id is always included in the coverage list. Omitting `also_covers` is the common
        single-line case. `so_number_ext` is DERIVED server-side from `erp_sales_order` and refused
        if a caller supplies it, the same server-derived-field rule as Task 2.4.
  - [x] 6.2 `GET /api/v1/dispatch/:dispatchOrderId/irn` for the dispatch desk to see whether the
        block will lift. It answers for THAT dispatch order only, returning the covering invoice and
        its IRN, or 404 when no coverage exists yet. Do not make it answer for the whole sales
        order: with several invoices per order, a sibling line's IRN says nothing about this one.
  - [x] 6.3 RBAC on the existing dispatch module scoping, reusing `resolveDispatchOrderSite` plus
        `assertSiteAccess(req, siteId, 'write')` exactly as `postDispatched` does
        (`src/api/v1/dispatch.ts:382-383`). Recording an IRN is a clerical act on data the IRP
        already issued, not an approval, so it needs no separate role. Because one recording can
        cover several dispatch orders, run that site assertion over EVERY id in the coverage list,
        not just the one in the path, and refuse the whole request if any of them is outside the
        caller's grants. A partial write here would leave an invoice half-recorded.

- [x] Task 7: tests (AC: 1, 2)
  - [x] 7.1 `test/integration/story-11-2.test.ts`: dispatch refused `IRN_MISSING` and audited; IRN
        recorded; dispatch then succeeds; replay of the recording is idempotent; a direct
        `POST /api/v1/events` meets the same wall; an `erp.*`-shaped attempt is 405; a job-work
        dispatch is unaffected. Two arms prove binding decision 2's grain, and both are required:
        (a) MULTI-LINE INVOICE - a sales order with two lines, recorded once with `also_covers`
        naming the second, dispatches both without a second recording; (b) MULTI-INVOICE ORDER - the
        same sales order invoiced twice, where recording invoice 1 against line 1 leaves line 2 still
        refused `IRN_MISSING` until invoice 2 is recorded against it. Arm (b) is the one that would
        have passed under the abandoned `so_number_ext` key and is the reason the key changed.
  - [x] 7.2 An arm for `DISPATCH_IRN_CONFLICT`: recording a second, different invoice against a
        dispatch order already covered is refused 409 and does not overwrite the first, while
        re-recording the SAME invoice succeeds as a no-op.
  - [x] 7.3 Unit arms for `dispatchIsEInvoiceable` and the non-blank `irn_ext` constraint.
  - [x] 7.4 MUTATION-VERIFY the gate at the SEAM, not just the route: remove the IRN check from the
        applier and confirm the integration arm fails. A route-only pre-check masks a seam-only
        mutant - the specific finding from Story 8.6.
  - [x] 7.5 Add the two new routes to the Story 1.9 spine allowlist if that gate requires it, and
        re-run `test/integration/story-1-9.test.ts`. Story 9.8 touched that file for exactly this
        reason, and Story 8.6 found the allowlist missing eleven routes.

### Review Findings

Code review 2026-09-09 (Blind Hunter, Edge Case Hunter, Acceptance Auditor; diff vs baseline
`5be1c3a`, scoped to this story's File List).

- [x] [Review][Decision] Same invoice number, different IRN is silently accepted as a no-op - the
      applier compares only `invoice_number_ext` before `continue`; `irn_ext` is never compared, so
      an ERP cancel-and-regenerate (or a typo on the first entry) returns 200 and the stale IRN stays
      on file as the compliance evidence [src/compliance/dispatch.ts:731]. Options: (a) refuse 409
      `DISPATCH_IRN_CONFLICT` when the IRN differs (no overwrite; correction is a later story), or
      (b) allow supersession of the IRN for the same invoice.
- [x] [Review][Decision] Any non-blank string clears the statutory gate - the only validation on
      `irn_ext` is non-blank; a GST IRN is a fixed 64-character hex hash, and `irp_acknowledged_at`
      is stored but never consulted by `dispatchGateIrnMissing`
      [src/api/v1/dispatch.ts:565, read/projections/dispatch_irn.sql]. Options: (a) enforce a
      64-character hexadecimal shape on both doors and the CHECK, or (b) keep non-blank only.
- [x] [Review][Decision] No lifecycle guard on recording - the REST route resolves the site through
      `dispatch_order_status`, so an IRN cannot be recorded until picking has started, while the
      events door needs only the ERP line; neither door refuses recording against an already
      dispatched or `cancelled` line [src/api/v1/dispatch.ts:561, src/compliance/dispatch.ts:677].
      Options: (a) route resolves the site from the `erp_sales_order` line so pre-pick recording
      works, and both doors refuse a `cancelled` line; (b) keep as built and document that the desk
      records after pick generation.
- [x] [Review][Patch] `dispatch.irn_recorded` is not role-gated on `POST /api/v1/events` (any
      warehouse write scope, including `warehouse_operator`, lifts the block the REST route restricts
      to `DISPATCH_WRITE_ROLES`), is missing from the `DISPATCH_DENIED_FRONTLINE_ROLES` block on the
      edge door, and `recorded_by` is poster-supplied on the events door (the 9.8-2 attribution
      class) [src/api/v1/events.ts:250, src/api/v1/edge.ts:390, src/compliance/dispatch.ts:683]
- [x] [Review][Patch] `dispatchIsEInvoiceable` fails OPEN: a null ERP line or a blank
      `so_number_ext` skips the IRN wall and dispatch commits with no IRN, contradicting binding
      decision 4 ("pilot answer is always true") and the 8.4/8.6 null-never-blocks reversal
      [src/compliance/dispatch.ts:585-592, :505]
- [x] [Review][Patch] Edge connector `PERMANENT_ERROR_CODES` twin lacks `IRN_MISSING` and
      `DISPATCH_IRN_CONFLICT`, and the new upload.ts comment ("do not duplicate into any edge twin")
      contradicts the twin contract restored by the 9.5 review; `DISPATCH_ORDER_SITE_MISMATCH` and
      `DISPATCH_IRN_INVALID_PAYLOAD` are in neither set [src/sync/upload.ts:125,
      edge/src/sync/connector.ts:58]
- [x] [Review][Patch] `postIrnRecorded` does not lower-case the path UUID or `also_covers` (every
      sibling handler now does), so mixed-case ids defeat the Set dedupe and the advisory-lock key
      and surface a raw `dispatch_irn_pkey` 23505; the applier does not trim `invoice_number_ext` or
      `irn_ext` on the events door while the route does [src/api/v1/dispatch.ts:549, :608,
      src/compliance/dispatch.ts:723]
- [x] [Review][Patch] Coverage-list site check compares sites BEFORE `assertSiteAccess` and uses
      400 `INVALID_PARAMS` where the applier uses `DISPATCH_ORDER_SITE_MISMATCH`, leaking whether a
      UUID exists at another site [src/api/v1/dispatch.ts:611-620]
- [x] [Review][Patch] AC 2 replay is never exercised as a replay: the route mints a fresh
      `event_id` with no `idempotency_key` (the 8.7 D8 rule requires one on mutating routes) and no
      test re-posts the same `event_id` on the events door [src/api/v1/dispatch.ts:626,
      test/integration/story-11-2.test.ts:335]
- [x] [Review][Patch] Audit-row assertion selects the latest `IRN_MISSING` row globally with no
      `dispatch_order_id` scope, and the events-door refusal is never checked for its audit row
      [test/integration/story-11-2.test.ts:371]
- [x] [Review][Patch] Job-work arm is vacuous: it posts `jobwork.output_dispatched` for a
      non-existent order and asserts only `error_code != IRN_MISSING`, so the refusal it observes is
      `SOURCE_DOCUMENT_REQUIRED` [test/integration/story-11-2.test.ts:697]
- [x] [Review][Patch] `irp_acknowledged_at` accepts anything `Date.parse` tolerates (`"1"`,
      `"March"`) and has no upper bound against now, so the TIMESTAMPTZ cast fails inside the
      transaction as a 500 [src/api/v1/dispatch.ts:578, src/compliance/dispatch.ts:628]
- [x] [Review][Patch] `DISPATCH_IRN_CONFLICT` and `DISPATCH_IRN_NOT_RECORDED` have no
      `edge/src/messages/en.json` string [edge/src/messages/en.json]
- [x] [Review][Patch] `so_number_ext` supplied in the REST body is silently dropped rather than
      refused as Tasks 2.4 and 6.1 require (the events door does refuse it)
      [src/api/v1/dispatch.ts:546]
- [x] [Review][Patch] Task 2.6 mechanism deviates undisclosed: spec said let the PK raise 23505 and
      classify it; code takes a per-order advisory lock and pre-reads. Outcome-equivalent, record it
      in the Completion Notes [src/compliance/dispatch.ts:723]
Decisions ruled by the Project Lead on 2026-09-09 and applied in the same review pass: D1 same
invoice with a different IRN SUPERSEDES the stored IRN in place (not a conflict, not a silent
no-op); D2 the IRN must be the IRP's 64-character hexadecimal hash on both doors and in the CHECK;
D3 the IRN routes resolve the order through its `erp_sales_order` line (pre-pick recording works)
and both doors refuse a closed line `DISPATCH_ORDER_CLOSED`. Every checked item above was patched
in this pass; see the Completion Notes entry "Code review 2026-09-09" for the record.

- [x] [Review][Defer] `POST /api/v1/events` has no frontline-role denial for `dispatch.packed`,
      `dispatch.shipping_documents_generated` or `dispatch.dispatched` (only the edge door has the
      `DISPATCH_DENIED_FRONTLINE_ROLES` block) [src/api/v1/events.ts:250] - deferred, pre-existing
- [x] [Review][Defer] IRN applier refusals other than `IRN_MISSING` (`DISPATCH_IRN_CONFLICT`,
      `DISPATCH_ORDER_SITE_MISMATCH`) leave no audit row, matching the sibling appliers
      [src/compliance/dispatch.ts:735] - deferred, pre-existing pattern
- [x] [Review][Defer] `also_covers` is uncapped: N site resolutions, N ERP reads and N advisory locks
      per request [src/api/v1/dispatch.ts:590] - deferred, pre-existing pattern (no list route caps)
- [x] [Review][Defer] `chk_dispatch_irn_present` uses `btrim` (spaces only) and there is no CHECK on
      a blank `so_number_ext` [read/projections/dispatch_irn.sql] - deferred, app paths trim
- [x] [Review][Defer] No uniqueness on `irn_ext` across invoices; a reused IRN under two invoice
      numbers is never detected [read/projections/dispatch_irn.sql] - deferred, ERP-owned invariant

## Dev Notes

### Why this story is in the pilot slice

`epics.md:327` puts Story 11.2 in the pilot go-live slice explicitly, alongside Epics 1, 2, 3, 5, 7,
8, 9 and the Epic 13 sign-off gate: "Story 11.2 is pulled forward because the pilot site dispatches
e-invoiceable supplies from day one and GST law blocks such dispatches without an IRN and signed QR
(FR-AC-14) - going live without it would contradict Epic 1's compliant-by-construction guarantee."
The rest of Epic 11 (11.1, 11.3, 11.4, and the new 11.5) is NOT in the pilot slice. The Epic 9
retrospective on 2026-09-07 reconfirmed this story as the next unit of work, ahead of Epic 10, and
found nothing in Epic 9 that invalidates its scope.

### Binding decisions

1. **The IRN does NOT go on `erp_sales_order`.** That projection is a read-only ERP mirror
   (`source_system` defaults to `'ERP'`, with `last_synced_at` and `source_snapshot`), rebuilt from
   ERP sync; a locally-written column would be clobbered by the next sync and would also breach the
   read-only contract `assertErpReadOnly` exists to enforce. The IRN lives in its own projection.
2. **The row is COVERAGE: one per dispatch order, naming the invoice that covers it. One recording
   event writes many rows.** SETTLED 2026-09-07 by two findings, in order.
   First, against the code: a dispatch order IS a sales-order line.
   `dispatch_order_status.dispatch_order_id` joins `erp_sales_order.id`
   (`src/read/projections/dispatch_order_status.ts:23-25`), and `erp_sales_order` is keyed
   `PRIMARY KEY (so_number_ext, line_no)` with `id` as a surrogate UUID
   (`read/projections/erp_sales_order.sql:19-36`). So an IRN recorded once per dispatch order would
   have to be posted once per line of a multi-line invoice.
   Second, ruled by the Project Lead: **ERP raises MULTIPLE invoices against the same order.** That
   kills `so_number_ext` as a key outright, and there is no order-level anchor that can carry one
   IRN.
   Both facts point at the same model. The IRN belongs to an INVOICE
   (`invoice_number_ext`, ERP-supplied); an invoice covers a SET of dispatch orders; the gate asks a
   dispatch-order-shaped question. So the recording event carries the invoice, its IRN, and the list
   of dispatch orders it covers, and writes one coverage row per dispatch order. The multi-line
   invoice records once, the second invoice against the same order covers its own lines, and the
   gate stays a primary-key lookup. Neither `invoice_number_ext` nor `so_number_ext` is unique in
   this table; `dispatch_order_id` is.
3. **Job-work output dispatch is OUT of scope. CONFIRMED 2026-09-06.** Story 9.4's job-work dispatch
   returns the CUSTOMER'S own processed material under a delivery challan; it is NOT a supply by this
   entity and does not attract an e-invoice. The gate therefore applies to the sales dispatch path
   (`src/compliance/dispatch.ts`, `erp_sales_order`-bound), never to `jobwork-dispatch.ts`. This is a
   ruling, not an assumption: do not "fix" the omission by extending the gate to job work.
4. **ALL supplies are e-invoiceable** (ruled 2026-09-05). There is no exemption to classify, so the
   gate applies to every dispatch on this path. Keep `dispatchIsEInvoiceable` as the single place a
   future exemption would land, but its pilot answer is always true.
5. **No override, for anybody.** Design invariant, not a separation-of-duties rule - see Task 3.6.
6. **This platform does not call the IRP.** The IRN arrives through ERP, exactly as the
   acceptance criterion says. No IRP client, no GSP integration, no retry loop against an external
   service. Recording is an inbound command on this platform's own API, the same shape as Story 9.6's
   billing-feed acknowledgment (binding decision 8 there).
7. **Dispatch events ride the `warehouse` stream, not a `dispatch` stream.** Verified at HEAD; see
   Task 2.1. An earlier draft of this story said otherwise and was wrong.

### Source tree components to touch

Table 1 lists every file this story touches, with the nature of the change.

| **File** | **Change** |
| --- | --- |
| `read/projections/dispatch_irn.sql` | NEW, plus its `deploy/compose/init-db.sql` mirror |
| `src/read/projections/dispatch_irn.ts` | NEW projection writer and readers |
| `src/compliance/dispatch.ts` | UPDATE: the gate, beside the existing hold and QC halves |
| `src/events/schema.ts` | UPDATE: payload interface plus the `SUPPORTED_EVENT_TYPES` entry |
| `src/events/store.ts` | UPDATE: wire assert (near line 620) and applier (near line 943) |
| `src/events/migrate.ts` | UPDATE: append the new projection file to the list |
| `src/api/v1/dispatch.ts` | UPDATE: two new routes, plus the audited-rejection catch |
| `src/server.ts` | UPDATE: register the two routes near line 1198 |
| `src/sync/upload.ts` | UPDATE: `IRN_MISSING` into `PERMANENT_ERROR_CODES` |
| `edge/src/messages/en.json` | UPDATE: the `errors.IRN_MISSING` message |
| `test/unit/schema-drift.test.ts` | UPDATE: pin the new projection with full index statements |
| `test/integration/story-11-2.test.ts` | NEW |
| `test/integration/story-1-9.test.ts` | UPDATE if the spine allowlist gates the new routes |

### Current state of the code being modified

`src/compliance/dispatch.ts` today owns the dispatch seam. `qcGatedLotIds` (line 36) is the QC half;
`dispatchGateBlockedLots` (line 58) is the complete lot gate: it locks the candidate `lot_master`
rows FIRST (so a concurrent hold placement serializes instead of racing past), then applies the
manual and recall hold half, then the QC half, returning `{ heldLotIds, qcGatedLotIds }`. Its header
comment at lines 45-57 states the rule this story must not break. The three appliers are
`applyDispatchPackedProjection` (164), `applyDispatchShippingDocumentsGeneratedProjection` (273) and
`applyDispatchDispatchedProjection` (400), with their shape asserts at 113, 135 and 155.

Two facts about that applier are easy to get wrong. First, `applyDispatchDispatchedProjection` does
NOT call `dispatchGateBlockedLots`: it re-runs the hold check inline with its own
`packing_record JOIN lot_master ... ORDER BY lm.lot_id FOR UPDATE OF lm` query and then calls
`qcGatedLotIds` directly, so the seam's own "call THIS, never one half of it" rule is not actually
honoured at this call site. Second, every refusal it raises is a 400, including `LOT_ON_HOLD`. See
Tasks 3.4 and 3.5; neither is this story's to change.

`src/api/v1/dispatch.ts` (529 lines) holds eight route handlers, `postDispatched` at line 365. It
resolves the site, calls `assertSiteAccess`, builds `auditCtx` through `auditCtxFor`, and calls
`persistEvent` with `stream_type: 'warehouse'`, `stream_id: dispatchOrderId`. It has no try/catch,
so today a refused dispatch leaves no audit row. See Task 5.2.

**What a "dispatch order" actually is.** `resolveDispatchOrderSite`
(`src/api/v1/dispatch.ts:122-132`) calls `getDispatchOrderStatus`, which reads
`dispatch_order_status dos JOIN erp_sales_order eso ON eso.id = dos.dispatch_order_id` and takes
`eso.ship_from_site_id` as the site. The base `dispatch_order_status` table is declared inside
`read/projections/pick_task.sql:121-125` with only `dispatch_order_id`, `picked_at` and `picked_by`;
Story 3.7 added `packed_at`, `packed_by`, `dispatched_at` and `dispatched_by` by ALTER from
`read/projections/packing_record.sql:52-56`. It carries NO `site_id` and NO `so_number_ext` of its
own - both come from the `erp_sales_order` join. That join is why binding decision 2 keys the IRN on
`so_number_ext`.

Document rendering lives in `src/warehouse/document-renderer.js` (`renderBOL`, `renderPackingSlip`,
`renderCommercialInvoice`, `renderLabels`) and is untouched by this story, because the signed QR is
ERP's concern.

Every existing reference to an IRN in the codebase is inbound supplier-invoice side
(`src/api/v1/supplier-invoices.ts`, `src/compliance/supplier-invoice.ts`,
`read/projections/supplier_invoice.sql`, and their schema and migrate entries). Outbound IRN is
greenfield: there is no `dispatch_irn` artifact of any kind at HEAD.

What must be preserved: the existing lot gate's lock ordering and both of its halves; the read-only
contract on `erp_sales_order`; and the behaviour of job-work dispatch, which shares nothing with this
path.

### Previous story intelligence

Story 9.8 (`9-8-offcut-acquisition-cfo-approval.md`) is the most recent completed work. Four of its
lessons apply directly here.

- **A guard written but never wired in is invisible.** 9.8's review found `getPendingProposalForHolding`
  fully implemented and never called, leaving a real bypass open. Task 7.3's seam mutation-verify
  exists to catch the same class here.
- **Handler-raised refusals do not self-audit.** 9.8 had to move `APPROVAL_REQUIRED` auditing into
  the handler because the route catch skipped it and the refusal never reached the applier. Decide
  deliberately, per Task 5.2, where the `IRN_MISSING` audit row is written.
- **Read the row you are gating under `FOR UPDATE` in the same transaction that persists the event.**
  9.8's second review pass ported the approve route to the Story 2.5 transfer-request transaction
  shape to close a TOCTOU between the handler's reads and the applier. The IRN presence check has the
  same exposure: a concurrent IRN write between a route pre-check and the applier.
- **Mutation-verify each new guard individually**, by reverting it and confirming the specific test
  fails. 9.8 did this for all three of its new regression tests.

### Git intelligence

Recent commits: `5be1c3a` (9-7 and 9-8), `6d11951`, `9bbbf05` (9-7), `ed87fb9`, `502b664`
(fix(9-6): bar retained offcut from every demand). The working tree at story creation carried only
`sprint-status.yaml` modifications and the untracked Epic 9 retrospective.

The retrospective flagged loose commit hygiene as an Epic 9 problem: stories 9.5, 9.6 and 9.7
accumulated multiple uncommitted review rounds and landed under generic "commit" messages, making it
hard to trace which patch closed which finding. Team action item 5 asks for a descriptive commit per
review round as it lands. Follow that here.

### Testing standards

Integration tests run against the docker `ims-postgres-test` instance on port 5442, through
`node --env-file=.env.test --import tsx --test --test-concurrency=1`. Run integration files serially.

**The suite is green. There is no noise floor.** The 28-failure floor carried through Epics 8 and 9
was eliminated on 2026-09-05 by root-causing it to four defects plus one live production bug (a
rejected transfer silently leaking its allocation). The last full run at Epic 9 close was 1992/1992,
with one intermittent pre-existing flake, `story-5-3` (a where-used clock window). Any other failure
you see is yours. An earlier draft of this story told the dev agent to expect a 28-failure floor;
that instruction is withdrawn.

Guards must be mutation-verified at the seam, not the route. Run `tsc`, `eslint` and a `db:migrate`
idempotency check before declaring done, per the Story 9.8 gate list.

### Project Structure Notes

Everything here follows the established layout: canonical DDL in `read/projections/` mirrored into
`deploy/compose/init-db.sql`, projection writers in `src/read/projections/`, seams in
`src/compliance/`, routes in `src/api/v1/` registered from `src/server.ts`. No new directory, no new
dependency, no new pattern. The only new vocabulary is one event type and one error code.

### References

- [Source: _bmad-output/planning-artifacts/epics.md:3114] - the Story 11.2 section and its acceptance
  criteria
- [Source: _bmad-output/planning-artifacts/epics.md:327] - the pilot-slice inclusion and its
  rationale
- [Source: _bmad-output/planning-artifacts/epics.md:218] - the FR-AC-14 statement
- [Source: _bmad-output/planning-artifacts/epics.md:3110] - inbound IRN is Story 4.7 captured invoice
  data; the outbound IRP flow is this story (INT-GST-01)
- [Source: _bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md:48,250] - no
  override for anyone, a design invariant rather than a separation-of-duties rule
- [Source: src/compliance/dispatch.ts:36-77] - the existing gate and the five-time hold-bypass lesson
- [Source: src/compliance/erp-readonly.ts:16-28] - the `erp.*` and stream `erp` 405 bar
- [Source: src/events/schema.ts:5097-5108] - the dispatch events registered on the `warehouse` stream
- [Source: src/api/v1/dispatch.ts:365-408] - `postDispatched`, with no rejection audit today
- [Source: src/api/v1/compliance.ts:45,248-255] - the `AUDITED_REJECTIONS` and `auditFailSafe` pattern
- [Source: read/projections/erp_sales_order.sql:19-36] - the read-only ERP mirror this story must not
  write to, and its `(so_number_ext, line_no)` grain
- [Source: src/read/projections/dispatch_order_status.ts:20-27] - the join proving a dispatch order
  is an `erp_sales_order` row
- [Source: read/projections/pick_task.sql:121-125] - the base `dispatch_order_status` DDL, with no
  site or SO columns of its own
- [Source: _bmad-output/implementation-artifacts/epic-9-retro-2026-09-07.md] - the two blocking
  prerequisites and the confirmation that this story is next
- [Source: _bmad-output/implementation-artifacts/deferred-work.md:595] - deferred-work 9.8-2 in full
- [Source: _bmad-output/implementation-artifacts/sprint-change-proposal-2026-09-05.md] - the Story
  11.2 split that produced this story and Story 11.5

## Open Questions

1. ANSWERED 2026-09-05: no signed QR is required, so `renderCommercialInvoice` is untouched and the
   QR is ERP's concern.
2. ANSWERED 2026-09-05: all supplies are e-invoiceable, with no exemption to model.
3. ANSWERED 2026-09-06: job-work output dispatch is NOT a supply, so it is not e-invoiceable and the
   gate must never extend to it. Task 4.2's test arm exists to keep that ruling visible.
4. ANSWERED 2026-09-07 by the Project Lead: block at `dispatch.dispatched` ONLY, not at document
   generation. The statutory act is the movement of goods, not the printing of paperwork, and since
   decision 1 removed the signed QR from this platform's scope, no document this platform renders
   carries the IRN. The `GET` route in Task 6.2 gives the desk its early feedback without a second
   enforcement point. A second block at document generation would add a second place a future
   dispatch surface can forget, which is the exact failure mode Task 3.1 exists to prevent. Do not
   add one.
5. ANSWERED 2026-09-07 by the Project Lead: **ERP can raise MULTIPLE invoices against the same
   order.** This settles the grain, and it is why binding decision 2 keys the row on
   `dispatch_order_id` with the invoice carried as an attribute. An earlier draft of this story keyed
   the row on `so_number_ext`, on the assumption of one invoice per order; that key is WRONG and must
   not be reintroduced. A second invoice against the same order would have collided with the first
   on the primary key, and the gate would have reported the first invoice's IRN as covering lines it
   never covered - a silent false negative on a statutory block. Test arm 7.1(b) exists specifically
   to keep that regression out.

## Dev Agent Record

### Agent Model Used

deepseek/deepseek-v4-flash-0731 (dev-story workflow), 2026-09-09.

### Debug Log References

- Story prerequisites verified: 9-9 and 9-10 both `done` in sprint-status.yaml, so the dispatch seam already converges on the shared `dispatchGateBlockedLots` helper (9.10 swept the inline hold recheck). The IRN check was inserted AFTER the hold/QC rechecks so an already-held dispatch still reports the existing 400 `LOT_ON_HOLD` (story-3-7 / story-9-10 regression arms stay green).
- Two pre-existing integration suites dispatch ERP-backed orders and now legitimately require an IRN first (the AC1 wall): story-3-7 (`should dispatch a packed order with documents`) and story-3-10-dispatch. Both fixtures seed one `dispatch_irn` coverage row before the final dispatch.
- The direct-events-door arm initially failed `MODULE_ACCESS_DENIED` for `stream_type: 'erp'`; the 405 `SOURCE_SYSTEM_READ_ONLY` bar fires on `event_type: 'erp.*'` regardless of stream, so the test posts `event_type: 'erp.sales_order_synced'` on the warehouse stream.
- TypeScript/lint/db:migrate x2/schema-drift/dispatch-related suites all green before completion. Full-suite result: 2029/2030 pass - the single failure is the pre-existing story-5-3 BOM where-used walk test, which also fails at the baseline HEAD commit `5be1c3a` in an isolated worktree (unrelated module; not a regression of this story).

### Completion Notes List

- Audit decision (Task 5.2): chose the **applier-self-audit** route (Story 9.8 / 9.10 pattern). `applyDispatchDispatchedProjection` now accepts an optional `auditCtx`, and when it refuses `IRN_MISSING` it writes the audit row itself (fresh connection via `logRejectionAudit`) before throwing, so the row survives the event rollback on BOTH the route door and the direct events door. No route-level `AUDITED_REJECTIONS` set was added (dispatch.ts route handlers were left as-is) to avoid a double row.
- Task 1: new `read/projections/dispatch_irn.sql` (canonical, guarded DROP-then-ADD `chk_dispatch_irn_present`, plain non-unique `idx_dispatch_irn_source_event`, `idx_dispatch_irn_invoice`, `idx_dispatch_irn_so`), mirrored into `deploy/compose/init-db.sql`, appended to the migrate list, and pinned in `schema-drift.test.ts` with full index bodies (source-event index pinned EXPLICITLY non-unique).
- Task 2: `dispatch.irn_recorded` on the `warehouse` stream (`requiresBusinessStream: false`), `DispatchIrnRecordedPayload`/`DispatchIrnRecordedEnvelope` in schema.ts, `assertDispatchIrnShape` + `applyDispatchIrnRecorded` in compliance/dispatch.ts, wired in store.ts (assert + applier blocks). Payload carries `site_id` (so `assertPayloadSiteWriteAccess` fires on the events door); `so_number_ext` is server-derived from `erp_sales_order` and refused on input. One event writes N coverage rows under a per-dispatch-order advisory lock; a DIFFERENT invoice against an already-covered order throws 409 `DISPATCH_IRN_CONFLICT` naming both invoices; re-recording the SAME invoice is a no-op that succeeds.
- Task 3: added the sibling helper `dispatchGateIrnMissing(dispatchOrderId, client)` in compliance/dispatch.ts and call it from `applyDispatchDispatchedProjection` (the single final-dispatch surface), inside the locked transaction, AFTER the documents-count and hold/QC rechecks. Refusal is 409 `IRN_MISSING` with `dispatch_order_id` + `so_number_ext`. No override path added.
- Task 4: `dispatchIsEInvoiceable(soLine)` - a pure predicate that consults its input (an order that does not resolve to an `erp_sales_order` line is not e-invoiceable), so the gate structurally cannot extend to job-work output dispatch.
- Task 5: `IRN_MISSING` and `DISPATCH_IRN_CONFLICT` added ONCE to `PERMANENT_ERROR_CODES` in upload.ts; `errors.IRN_MISSING` message added to edge en.json.
- Task 6: `POST /api/v1/dispatch/:dispatchOrderId/irn` (body: `invoice_number_ext`, `irn_ext`, optional `irp_acknowledged_at`, optional `also_covers`) and `GET /api/v1/dispatch/:dispatchOrderId/irn` (404 `DISPATCH_IRN_NOT_RECORDED` when no coverage). Both run the site assertion over EVERY id in the coverage list and refuse the whole request if any is outside the caller's grants. Both routes added to story-1-9 spine allowlist.
- Task 7: story-11-2.test.ts covers: AC1 route refusal + audit + block-lift; direct-events-door wall; `erp.*` 405; job-work unaffected; multi-line invoice (also_covers) and multi-invoice-order arms (binding decision 2 grain); `DISPATCH_IRN_CONFLICT` + same-invoice no-op; unit arms for `dispatchIsEInvoiceable` and the non-blank `irn_ext` CHECK. Mutation-verify performed at the seam: temporarily neutered `dispatchGateIrnMissing` and confirmed the AC1 route arm fails (200 vs 409), then restored the real gate.
- **Code review 2026-09-09** (Blind Hunter, Edge Case Hunter, Acceptance Auditor; 3 decisions + 12 patches applied, 5 deferred as ledger 11.2R-1 to 11.2R-5, 4 dismissed). Load-bearing corrections: (a) `dispatch.irn_recorded` is now role-gated on the direct events door (`assertDispatchIrnFunctionAccess` in events.ts, `DISPATCH_WRITE_ROLES` at the payload site) and denied to frontline roles on the edge door, and `recorded_by` was REMOVED from the payload - the applier takes the recording clerk from `metadata.actor.user_id`, which both doors pin - closing the 9.8-2 attribution class before it shipped; (b) the dispatch wall FAILS CLOSED: a dispatch order with no `erp_sales_order` line is refused `IRN_MISSING` (reason `no_erp_sales_order_line`) instead of exempted, and `dispatchIsEInvoiceable` now takes the line (never null) and answers true for every line including a blank `so_number_ext`; (c) D1 supersession: same invoice + different IRN updates the row in place via `supersedeDispatchIrn` (the only UPDATE, `GRANT UPDATE` added and pinned in schema-drift), same invoice + same IRN stays a no-op, different invoice stays 409; (d) D2: `IRN_EXT_REGEX` (64 hex) on both doors, lower-cased by `normalizeIrnExt`, and `chk_dispatch_irn_present` now pins `irn_ext ~ '^[0-9a-f]{64}$'`; (e) D3: `resolveDispatchOrderLineSite` resolves through `erp_sales_order` so an IRN can be recorded/read before pick generation, and a non-open line is refused `DISPATCH_ORDER_CLOSED` on the route and in the applier. Also: `POST /irn` requires `idempotency_key` (8.7 D8) and lower-cases the path id and `also_covers`; the applier lower-cases ids and trims invoice/IRN so both doors store identical bytes; coverage-list access check now runs BEFORE the same-site comparison and uses `DISPATCH_ORDER_SITE_MISMATCH`; `so_number_ext` in the REST body is refused 400; `irp_acknowledged_at` requires an RFC 3339 instant not in the future (`isValidIrpAcknowledgedAt`); `IRN_MISSING`, `DISPATCH_IRN_CONFLICT`, `DISPATCH_IRN_INVALID_PAYLOAD`, `DISPATCH_ORDER_SITE_MISMATCH`, `DISPATCH_ORDER_CLOSED` added to BOTH `PERMANENT_ERROR_CODES` sets (the Task 5 "single-homed" note was wrong - the edge connector twin is the contract) with en.json strings. Tests: audit assertions scoped by `dispatch_order_id` on both doors; job-work arm now posts as a `jobwork_coordinator` and asserts the exact `SOURCE_DOCUMENT_REQUIRED` plus a source-level pin that jobwork-dispatch.ts never references the IRN gate; new arms for replay (route `idempotency_key`, door `event_id`), D3 lifecycle, role gating on both doors, `recorded_by`/`so_number_ext` refusal, IRN shape, timestamp shape, mixed-case normalisation. Three mutants killed (door role gate removed, supersede branch removed, closed-line refusal removed). Task 2.6 mechanism deviation DISCLOSED: advisory lock + pre-read instead of a classified 23505 (outcome-equivalent, safer under concurrency). Test-DB note: the new CHECK could not be added while 52 dev-run fixture rows in the old `IRN-xxx` shape existed on the test database; they were deleted with the admin pool (fixture debris on an uncommitted greenfield table, no real data); a real database gets the table fresh. Gates: tsc, eslint, prettier (11.2 files), edge typecheck, db:migrate x2, schema-drift 164/164, story-11-2 11/11, story-3-7 13/13, story-3-10-dispatch 1/1, story-1-9 6/6, story-9-10 5/5. Post-patch full suite 2033/2034 (147 suites): baseline 2029/2030 plus 4 new arms, ZERO new failures; the single failure is the known story-5-3 where-used walk IST-vs-UTC date-boundary defect (run at 04:11 IST, inside its 00:00-05:30 window), unrelated to this story.

### File List

- read/projections/dispatch_irn.sql (new)
- src/read/projections/dispatch_irn.ts (new)
- src/api/v1/events.ts (review: events-door role gate for dispatch.irn_recorded)
- src/api/v1/edge.ts (review: frontline denial for dispatch.irn_recorded)
- edge/src/sync/connector.ts (review: PERMANENT_ERROR_CODES twin)
- deploy/compose/init-db.sql (mirror of the new projection)
- src/events/migrate.ts (append dispatch_irn.sql)
- test/unit/schema-drift.test.ts (dispatch_irn pin)
- src/events/schema.ts (payload/envelope types + SUPPORTED_EVENT_TYPES entry)
- src/compliance/dispatch.ts (IRN gate helper, shape assert, applier, e-invoiceable predicate)
- src/events/store.ts (assert + applier wiring, auditCtx forwarding)
- src/api/v1/dispatch.ts (POST + GET /irn routes)
- src/server.ts (route registration)
- test/integration/story-1-9.test.ts (spine allowlist additions)
- src/sync/upload.ts (PERMANENT_ERROR_CODES additions)
- edge/src/messages/en.json (errors.IRN_MISSING)
- test/integration/story-11-2.test.ts (new suite)
- test/integration/story-3-7.test.ts (fixture now records IRN before dispatch)
- test/integration/story-3-10-dispatch.test.ts (fixture now records IRN before dispatch)

## Change Log

Table 2 records the revisions to this story file.

| **Date** | **Change** |
| --- | --- |
| 2026-09-06 | Story created from the 2026-09-05 sprint-change-proposal split, with decisions 1 through 6 recorded. |
| 2026-09-07 | Refreshed against HEAD `5be1c3a` after the Epic 9 retrospective. Corrected the stream type (`warehouse`, not `dispatch`), the audited-rejection task (the dispatch route has no such set today), and every stale line reference. Withdrew the 28-failure noise-floor instruction: the suite is green. Added the two blocking prerequisites, Story 9.8 previous-story intelligence, and a proposed default for open question 4. |
| 2026-09-07 | Corrected binding decision 2 against the code: a dispatch order is an `erp_sales_order` row at `(so_number_ext, line_no)` grain. Recorded that `applyDispatchDispatchedProjection` inlines the lot gate rather than calling the shared helper, and that its sibling refusals are 400. Raised open questions 4 and 5. |
| 2026-09-07 | Open questions 4 and 5 answered by the Project Lead. Block sits at `dispatch.dispatched` only. ERP raises multiple invoices per order, so the projection was re-keyed a second time, from `so_number_ext` to coverage grain: `dispatch_order_id` primary key carrying `invoice_number_ext` and `irn_ext`, one recording event writing N coverage rows, a non-unique `source_event_id` index, and a new `DISPATCH_IRN_CONFLICT` refusal. Added the multi-invoice and conflict test arms. |
| 2026-09-09 | Implemented (dev-story). Added the dispatch_irn projection, the dispatch.irn_recorded recording event + applier, the IRN-before-dispatch gate (one helper, no override), dispatchIsEInvoiceable, both error codes + edge message + applier-self-audit of the refusal, the two /irn routes, and the full test suite. Full gates green (tsc, eslint, db:migrate x2, schema-drift, dispatch-related integration suites; full-suite result appended to Completion Notes). Status set to review. |
| 2026-09-09 | Code review (three adversarial layers vs baseline 5be1c3a). 3 decisions ruled (D1 supersession, D2 64-hex IRN, D3 ERP-line lifecycle) and 12 patches applied; 5 deferred to the ledger (11.2R-1 to 11.2R-5), 4 dismissed. Events-door role gate and recorded_by removal close the 9.8-2 attribution class; the wall now fails closed. Review Findings section added under Tasks / Subtasks; File List extended. |
