---
title: 's0-transfer-request-door-hardening'
type: 'bugfix'
created: '2026-11-22'
status: 'done'
baseline_revision: 'b548eb8'
final_revision: 'd9e4cb3'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** GET /api/v1/transfer-requests/:id returns the full `gst` block (GSTINs, unit and taxable value) to any inventory reader. The valuation override and GST document routes read the transfer request outside the transaction that the applier commits in. `assertAndApplyTransferRequestCompliance` is dead code beside the live applier dispatch in `src/events/store.ts`.

**Approach:** Redact the GSTIN and value fields of the `gst` block for roles outside `finance_controller` and `gst_officer`. Move the request read (with `FOR UPDATE`) and the site lookup inside a client transaction that `persistEvent` joins. Delete the dead seam so `store.ts` holds the only applier list.

## Boundaries & Constraints

**Always:** Keep supply class, document status and `ship_blockers` visible to all inventory readers. Keep the event persisted and audited on both routes. Keep the 11.5 integration suite green.

**Block If:** None.

**Never:** Edit the deferred-work ledger or sprint board. Change the event payloads or applier behavior. Add a new role to the GST configuration routes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Officer reads GET /:id | `gst_officer` or `finance_controller` assignment | Full `gst` block, unchanged | None |
| Warehouse reads GET /:id | inventory reader without an officer role | `valuation` has no `from_gstin_ext`, `to_gstin_ext`, `unit_value`, `taxable_value`, `declared_unit_value` | None |
| Override on unknown id | Missing transfer request | 404 NOT_FOUND, transaction rolled back | Thrown inside the transaction |

</intent-contract>

## Code Map

- `src/api/v1/transfer-requests.ts` -- GET /:id, gst-documents GET, override and GST document POST handlers
- `src/compliance/transfer-request.ts` -- holds the dead `assertAndApplyTransferRequestCompliance`
- `src/events/store.ts` -- live applier dispatch (about lines 1000-1004), kept unchanged
- `test/integration/story-11-5.test.ts` -- 11.5 integration suite

## Tasks & Acceptance

**Execution:**
- [x] `src/api/v1/transfer-requests.ts` -- add `redactGstBlock` and apply it to GET /:id and the gst-documents GET -- DW-27
- [x] `src/api/v1/transfer-requests.ts` -- override and GST document POST: `pool.connect`, `BEGIN`, `getTransferRequestById(id, client, true)`, `fromSiteOf(row, client)`, `persistEvent(..., client)`, `COMMIT`, post-commit reads -- DW-28
- [x] `src/compliance/transfer-request.ts` -- delete the dead `assertAndApplyTransferRequestCompliance` seam -- DW-18
- [x] `test/integration/story-11-5.test.ts` -- officer reads for full-view assertions, warehouse read asserts redaction -- regression for DW-27

**Acceptance Criteria:**
- Given a warehouse reader, when GET /api/v1/transfer-requests/:id runs on an inter-GSTIN transfer, then the `gst` block keeps `supply_class`, `ship_blockers` and `valuation.basis_source`, and omits the GSTIN and value fields.
- Given a `gst_officer`, when the same GET runs, then the `gst` block is unchanged.
- Given a valuation override or GST document POST, when the transfer is missing, then the response is 404 and no event row is written.
- Given the seam is removed, when the repo is searched, then no reference to `assertAndApplyTransferRequestCompliance` remains in `src/` or `test/`.

## Design Notes

Redaction is applied on the response, not in the projection, so the stored classification and valuation rows and the ship gate are unaffected. The applier's own `FOR UPDATE` lock is unchanged. The new transaction only ensures the read and the write see the same snapshot.

## Verification

**Commands:**
- `npx tsc --noEmit` -- expected: exit 0
- `npm run test:integration` -- expected: all pass, including `Story 11.5 branch transfer valuation and GST documents`

**Manual checks (if no CLI):**
- `git grep assertAndApplyTransferRequestCompliance -- src test` returns nothing.

## Review Triage Log

### 2026-11-22 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 2, low 1)
- defer: 6: (high 0, medium 2, low 4) — residual, NOT written to deferred-work ledger (owner instruction)
- reject: 2
- addressed_findings:
  - `[medium]` `[patch]` valuation redaction was a denylist (fails open for new fields); switched to allowlist in `redactGstBlock`
  - `[medium]` `[patch]` reader check matched role only; now reuses `SITE_GSTIN_ROLES` (exported from `sites.ts`) and requires module `inventory` or `*`, the `assertGstConfigRole` predicate
  - `[low]` `[patch]` test gaps: `declared_unit_value` redaction asserted; gst-documents GET warehouse redaction asserted

Deferred (not ledger-recorded): post-commit reads can 500 after a persisted event; ROLLBACK can mask the original error and `release()` does not destroy a broken client; external-client 23505 with reused idempotency key gives 409 not replay; `gstOfficerActor` runs after `FOR UPDATE`; `dispatchGateGstDocuments(row)` uses pre-event snapshot; `persistEvent` pre-transaction asserts take a second pool connection while the handler holds one. All six mirror the existing ship and receive routes, so they predate this change.

Rejected: seam removal "unrelated" (it is DW-18); `documents` array redaction (no GSTIN or value fields, so out of DW-27 scope).

## Auto Run Result

Status: done
Final revision: d9e4cb3

Summary: DW-27 GST identifiers are hidden from non-officer readers on GET /:id and GET /gst-documents. DW-28 valuation override and GST document POST now read and lock the request inside the transaction `persistEvent` commits in. DW-18 dead seam removed, so `src/events/store.ts` holds the only applier list.

Files changed:
- `src/api/v1/transfer-requests.ts` — `redactGstBlock` + `canReadGstIdentifiers`; transactional override and GST-document POST; `fromSiteOf` takes client.
- `src/api/v1/sites.ts` — `SITE_GSTIN_ROLES` exported.
- `src/compliance/transfer-request.ts` — dead `assertAndApplyTransferRequestCompliance` removed.
- `test/integration/story-11-5.test.ts` — full-view reads use officer; warehouse redaction asserted on GET /:id and gst-documents.

Verification: `npx tsc --noEmit` exit 0; eslint on the four files clean; prettier `--end-of-line auto` clean on touched files (default-EOL prettier flags untouched baseline files too); `npm run test:integration` 2130 pass, 0 fail (before and after the review patches).

Commit note: the code was NOT committed by this run. Working-tree changes were swept into `d9e4cb3` ("story 7-11-maintenance-supervisor-desk: implemented and reviewed via bmad-loop") by a concurrent bmad-loop run on the same checkout. That commit also contains 34 other files from other stories, and it includes the deferred-work ledger change. This run did not commit, amend or rewrite history.

Residual risks:
- `POST /api/v1/transfer-requests` create response still returns full `gst.valuation` (GSTINs, taxable value) to creator roles (`warehouse_manager`, `logistics_manager`, `store_assistant`). Same leak class as DW-27, outside GET /:id scope. Needs owner ruling.
- Redaction is role-level, not site-scoped. A `gst_officer` at another site still sees GSTINs on any transfer their role lets them read.
- Event-list endpoints that return `valuation_overridden` payloads carry `declared_unit_value`; not reviewed.
