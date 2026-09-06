---
baseline_commit: 6439870
---

# Story 11.2: IRN-Before-Dispatch Enforcement

Status: ready-for-dev

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

## Tasks / Subtasks

- [ ] Task 1: the `dispatch_irn` projection (AC: 1, 2)
  - [ ] 1.1 New `read/projections/dispatch_irn.sql`, mirrored into `deploy/compose/init-db.sql`,
        registered in `src/events/migrate.ts` and pinned in `test/unit/schema-drift.test.ts` with the
        FULL `CREATE UNIQUE INDEX` statements (the Story 9.6 group-A lesson: a name-only pin stays
        green when `UNIQUE` is dropped).
  - [ ] 1.2 Grain is ONE row per dispatch order: `dispatch_order_id` UUID primary key, plus
        `irn_ext TEXT NOT NULL`, `irp_acknowledged_at TIMESTAMPTZ`,
        `so_number_ext TEXT`, `site_id UUID NOT NULL`, `recorded_by UUID NOT NULL`,
        `source_event_id UUID NOT NULL`, `correlation_id`, `created_at`, `updated_at`.
  - [ ] 1.3 Constraints: `uq_dispatch_irn_source_event` on `source_event_id`;
        `chk_dispatch_irn_present` requiring `irn_ext` to be non-blank. Guarded DO block using
        DROP-then-ADD, not add-if-absent (the `bom_line` precedent).
  - [ ] 1.4 `src/read/projections/dispatch_irn.ts` with `insertDispatchIrn`, `getDispatchIrn` and a
        `dispatchIrnPresent(dispatchOrderId, client)` reader the gate calls.

- [ ] Task 2: the recording event and its applier (AC: 2)
  - [ ] 2.1 Event type `dispatch.irn_recorded` on the EXISTING `dispatch` stream, beside
        `dispatch.packed` / `dispatch.shipping_documents_generated` / `dispatch.dispatched`. It must
        NOT be `erp.*` and must NOT ride stream `erp`: `assertErpReadOnly`
        (`src/compliance/erp-readonly.ts:16`) 405s both, and Story 9.6 hit exactly this wall
        (binding decision 7). The IRN comes FROM the IRP THROUGH ERP, but recording it is this
        platform's own write.
  - [ ] 2.2 Register the type in `SUPPORTED_EVENT_TYPES` with `streamType: 'dispatch'`. Story 9.6's
        group-A review found three event types missing from that registry; the consumer fails open,
        so the omission is invisible. Do not repeat it.
  - [ ] 2.3 `assertDispatchIrnShape` (pre-transaction, no DB) and `applyDispatchIrnRecorded` (inside
        the transaction), the split every seam in this repo uses. Caller supplies
        `dispatch_order_id`, `irn_ext`, `irp_acknowledged_at`, `recorded_by`, `site_id`;
        every other field is server-derived and refused on input.
  - [ ] 2.4 Replay is idempotent through `alreadyPersisted` plus the `uq_dispatch_irn_source_event`
        23505-to-409 classification, never a bespoke pre-read (the Story 8.8 lesson that a pre-read
        replay check is not a persisted-event signal).

- [ ] Task 3: the dispatch gate (AC: 1)
  - [ ] 3.1 Extend `dispatchGateBlockedLots` in `src/compliance/dispatch.ts`, or add a sibling helper
        called from the same place, so that EVERY dispatch surface meets the IRN check through ONE
        helper. Read the comment at `src/compliance/dispatch.ts:44-56` first: forgetting one half of
        that gate has shipped as a hold-bypass defect five times (Stories 8.3, 8.4, 8.5, 8.8, 9.4).
  - [ ] 3.2 The block fires on `dispatch.dispatched` - the final dispatch - and is re-derived INSIDE
        the transaction, never only at the route. A direct `POST /api/v1/events` must meet the
        identical wall.
  - [ ] 3.3 Refusal is `IRN_MISSING` at 409 with details naming `dispatch_order_id` and
        `so_number_ext`.
  - [ ] 3.4 THERE IS NO OVERRIDE. The access matrix lists IRN-less dispatch of an e-invoiceable
        supply under "Blocked-for-everyone rows (design invariants, not SoD)" and marks
        `dispatch_clerk` "cannot dispatch e-invoiceable supply without IRN - no override"
        (`access-matrix-frontline-draft-2026-07-11.md:48,250`). Do not add a DOA path, an approval
        path or a config flag that disables it.

- [ ] Task 4: which supplies are e-invoiceable (AC: 1)
  - [ ] 4.1 Implement the binding-decision rule below as a single pure predicate,
        `dispatchIsEInvoiceable(...)`, parameterised so a unit test can fail it (the 8.4
        tautological-config lesson).
  - [ ] 4.2 Job-work output dispatch (`src/compliance/jobwork-dispatch.ts`) is OUT of scope: it
        returns the customer's own material under a delivery challan and is not a supply (binding
        decision 3, CONFIRMED 2026-09-06). Add an explicit test arm proving a job-work dispatch is
        NOT blocked, so a later reader cannot mistake the ruling for an oversight.

- [ ] Task 5: error code registration (AC: 1)
  - [ ] 5.1 `IRN_MISSING` into the dispatch route's `AUDITED_REJECTIONS` set: a refused non-compliant
        dispatch attempt is exactly the event an auditor will ask about.
  - [ ] 5.2 `IRN_MISSING` into `PERMANENT_ERROR_CODES` in `src/sync/upload.ts`: a retry of the same
        dispatch never clears it, the IRN has to arrive first (the `BILLING_NOT_READY` precedent).
  - [ ] 5.3 `errors.IRN_MISSING` message into `edge/src/messages/en.json`.

- [ ] Task 6: API surface (AC: 2)
  - [ ] 6.1 `POST /api/v1/dispatch/:dispatchOrderId/irn` recording the IRN, registered
        in `src/server.ts` beside the existing `/pack`, `/generate-documents` and `/dispatch` routes
        (`src/server.ts:1166-1171`).
  - [ ] 6.2 `GET /api/v1/dispatch/:dispatchOrderId/irn` for the dispatch desk to see whether the
        block will lift.
  - [ ] 6.3 RBAC on the existing dispatch module scoping. Recording an IRN is a clerical act on data
        the IRP already issued, not an approval, so it needs no separate role.

- [ ] Task 7: tests (AC: 1, 2)
  - [ ] 7.1 `test/integration/story-11-2.test.ts`: dispatch refused `IRN_MISSING` and audited; IRN
        recorded; dispatch then succeeds; replay of the recording is idempotent; a direct
        `POST /api/v1/events` meets the same wall; an `erp.*`-shaped attempt is 405/403; a job-work
        dispatch is unaffected.
  - [ ] 7.2 Unit arms for `dispatchIsEInvoiceable` and the non-blank `irn_ext` constraint.
  - [ ] 7.3 MUTATION-VERIFY the gate at the SEAM, not just the route: remove the IRN check from the
        applier and confirm the integration arm fails. A route-only pre-check masks a seam-only
        mutant - the specific finding from Story 8.6.

## Dev Notes

### Why this story is in the pilot slice

`epics.md:327` puts Story 11.2 in the pilot go-live slice explicitly, alongside Epics 1, 2, 3, 5, 7,
8, 9 and the Epic 13 sign-off gate: "Story 11.2 is pulled forward because the pilot site dispatches
e-invoiceable supplies from day one and GST law blocks such dispatches without an IRN and signed QR
(FR-AC-14) - going live without it would contradict Epic 1's compliant-by-construction guarantee."
The rest of Epic 11 (11.1, 11.3, 11.4, and the new 11.5) is NOT in the pilot slice.

### Binding decisions

1. **The IRN does NOT go on `erp_sales_order`.** That projection is a read-only ERP mirror
   (`source_system` defaults to `'ERP'`, with `last_synced_at` and `source_snapshot`), rebuilt from
   ERP sync; a locally-written column would be clobbered by the next sync and would also breach the
   read-only contract `assertErpReadOnly` exists to enforce. The IRN lives in its own projection.
2. **The grain is the DISPATCH ORDER, not the sales-order line.** `erp_sales_order` is keyed at
   `(so_number_ext, sku)` line grain, but an IRN is issued against an invoice, and the dispatch order
   is what this platform blocks. One IRN row per dispatch order keeps the gate a single lookup and
   keeps the uniqueness rule expressible in the schema.
3. **Job-work output dispatch is OUT of scope. CONFIRMED 2026-09-06.** Story 9.4's job-work dispatch
   returns the CUSTOMER'S own processed material under a delivery challan; it is NOT a supply by this
   entity and does not attract an e-invoice. The gate therefore applies to the sales dispatch path
   (`src/compliance/dispatch.ts`, `erp_sales_order`-bound), never to `jobwork-dispatch.ts`. This is a
   ruling, not an assumption: do not "fix" the omission by extending the gate to job work.
4. **ALL supplies are e-invoiceable** (ruled 2026-09-05). There is no exemption to classify, so the
   gate applies to every dispatch on this path. Keep `dispatchIsEInvoiceable` as the single place a
   future exemption would land, but its pilot answer is always true.
5. **No override, for anybody.** Design invariant, not a separation-of-duties rule - see Task 3.4.
6. **This platform does not call the IRP.** The IRN arrives through ERP, exactly as the
   acceptance criterion says. No IRP client, no GSP integration, no retry loop against an external
   service. Recording is an inbound command on this platform's own API, the same shape as Story 9.6's
   billing-feed acknowledgment (binding decision 8 there).

### Source tree components to touch

| **File** | **Change** |
| --- | --- |
| `read/projections/dispatch_irn.sql` | NEW, plus its `init-db.sql` mirror |
| `src/read/projections/dispatch_irn.ts` | NEW projection writer and readers |
| `src/compliance/dispatch.ts` | UPDATE: the gate, beside the existing hold and QC halves |
| `src/events/schema.ts` | UPDATE: payload interface plus the `SUPPORTED_EVENT_TYPES` entry |
| `src/events/store.ts` | UPDATE: wire assert and applier |
| `src/events/migrate.ts` | UPDATE: register the new projection file |
| `src/api/v1/dispatch.ts`, `src/server.ts` | UPDATE: the two routes |
| `src/sync/upload.ts`, `edge/src/messages/en.json` | UPDATE: error-code registration |
| `test/unit/schema-drift.test.ts` | UPDATE: pin the new projection |

The table above lists every file this story touches.

### Current state of the code being modified

`src/compliance/dispatch.ts` today owns the dispatch seam: `qcGatedLotIds` (the QC half) and
`dispatchGateBlockedLots` (the complete lot gate: lock lot rows, then the manual/recall hold half,
then the QC half). Its header comment states the rule this story must not break - "Every dispatch
surface calls THIS, never one half of it" - and records that forgetting a half has shipped as a
hold-bypass defect five times. The three dispatch events are `dispatch.packed`,
`dispatch.shipping_documents_generated` and `dispatch.dispatched`, wired in `src/events/store.ts`
around lines 609-617 and 931-945, with routes at `src/server.ts:1166-1175`. Document rendering lives
in `src/warehouse/document-renderer.js` (`renderBOL`, `renderPackingSlip`, `renderCommercialInvoice`,
`renderLabels`).

What must be preserved: the existing lot gate's lock ordering and both of its halves; the read-only
contract on `erp_sales_order`; and the behaviour of job-work dispatch, which shares nothing with this
path.

### Testing standards

Integration tests run against the docker `ims-postgres-test` instance on port 5442, through
`node --env-file=.env.test --import tsx --test --test-concurrency=1`. Run integration files serially.
The suite currently carries a documented noise floor of 28 pre-existing failures concentrated in
Epics 1-3 (a seeding cascade in story-2-5 and story-2-3 among them); verify 0 NEW failures against
that floor rather than expecting a green suite. Guards must be mutation-verified at the seam.

### Project Structure Notes

Everything here follows the established layout: canonical DDL in `read/projections/` mirrored into
`deploy/compose/init-db.sql`, projection writers in `src/read/projections/`, seams in
`src/compliance/`, routes in `src/api/v1/` registered from `src/server.ts`. No new directory, no new
dependency, no new pattern. The only new vocabulary is one event type and one error code.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 11.2] - acceptance criteria, and line 327
  for the pilot-slice inclusion and its rationale
- [Source: _bmad-output/planning-artifacts/epics.md:218] - FR-AC-14 statement
- [Source: _bmad-output/planning-artifacts/epics.md:3083] - inbound IRN is Story 4.7 captured invoice
  data; the outbound IRP flow is this story (INT-GST-01)
- [Source: _bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md:48,250] - no
  override for anyone, a design invariant rather than a separation-of-duties rule
- [Source: src/compliance/dispatch.ts:33-56] - the existing gate and the five-time hold-bypass lesson
- [Source: src/compliance/erp-readonly.ts:16] - the `erp.*` / stream `erp` 405 bar
- [Source: read/projections/erp_sales_order.sql:20-34] - the read-only ERP mirror this story must not
  write to
- [Source: _bmad-output/implementation-artifacts/sprint-change-proposal-2026-09-05.md] - the Story
  11.2 split that produced this story and Story 11.5

## Open Questions

1. ANSWERED 2026-09-05: no signed QR is required, so `renderCommercialInvoice` is untouched and the
   QR is ERP's concern.
2. ANSWERED 2026-09-05: all supplies are e-invoiceable, with no exemption to model.
3. ANSWERED 2026-09-06: job-work output dispatch is NOT a supply, so it is not e-invoiceable and the
   gate must never extend to it. Task 4.2's test arm exists to keep that ruling visible.
4. **Should the block sit at `dispatch.dispatched` only, or also at document generation?** Blocking
   later is safer for the shipment; blocking earlier gives the desk feedback before it prints
   paperwork it cannot use.

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
