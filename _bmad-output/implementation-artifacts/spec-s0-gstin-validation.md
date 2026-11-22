---
title: 'S0 GSTIN check digit and site effective_from window (DW-25, DW-26)'
type: 'bugfix'
created: '2026-11-22'
status: 'done'
baseline_revision: 'f7a6bbc8180dac3eb1c37fd6c3322c885cebbaf4'
final_revision: '02691e2360322319b0a4467f973ba886a0a9b106'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** `GSTIN_REGEX` is shape-only, so a transposed character yields a GSTIN that passes validation but is statutorily invalid (DW-25). Site GSTIN registrations accept any `effective_from` calendar date, so 1900-01-01 and 2999-01-01 both return 201; the far-future one leaves the site with no currently effective registration (DW-26).

**Approach:** Add a mod-36 check-digit validator beside `GSTIN_REGEX` in `src/compliance/supplier.ts` and use it in the GSTIN callers in `sites.ts` and `gst.ts`. Bound a site GSTIN `effective_from` to `[2017-07-01, today + 366 days]` and refuse outside it with a 400.

## Boundaries & Constraints

**Always:** The check digit is verified as ordinary mod-36 over the first 14 characters of the GSTIN (weights 1,2 alternating from position 0). `GSTIN_REGEX` stays exported and unchanged so the DB-shape twin (`site_gstin.sql`) and supplier-side callers keep their current behaviour. Refusals use `AppError(400, 'INVALID_PARAMS', ...)`, the code the neighbouring checks already use.

**Block If:** A GSTIN fixture in an existing test cannot be made check-digit-valid without changing the state code or PAN-shaped middle the test asserts on.

**Never:** Do not add checksum checks to `supplier.registered` (`supplier.ts`), `supplier-invoice.ts`, or the DB CHECK. Do not change the `effective_to` rules or the `gst.ts` date window. Do not touch the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid GSTIN | `27AAPFU0939F1ZV` to `POST /api/v1/sites/:id/gstin` | Accepted (201 path unchanged) | None |
| Transposed chars | `27AAPFU0939F1VZ` | Rejected, 400 INVALID_PARAMS | Shape passes, check digit fails |
| Wrong check char | `27AAPFU0939F1ZA` | Rejected, 400 INVALID_PARAMS | Same message |
| Lowercase or padded | ` 27aapfu0939f1zv ` | Accepted after trim and upper-case | None |
| effective_from too early | `2017-06-30` | 400 INVALID_PARAMS naming the window | Checked after date parse |
| effective_from far future | today + 367 days | 400 INVALID_PARAMS naming the window | Checked after date parse |
| Window edges | `2017-07-01`, today + 366 days | Accepted | None |

</intent-contract>

## Code Map

- `src/compliance/supplier.ts` -- owns `GSTIN_REGEX` (line 25); add `gstinCheckCharacter` and `isValidGstin` beside it
- `src/api/v1/sites.ts` -- `postSiteGstinBase` (about line 316) validates `gstin_ext` with `GSTIN_REGEX`; `parseDateWindow` (line 147) validates dates; `isValidCalendarDate` and `toIstCalendarDate` come from `src/lib/business-days.ts`
- `src/api/v1/gst.ts` -- `gstinField` (line 41) and `gstinQueryParam` (line 54) use `GSTIN_REGEX`
- `test/integration/story-11-5.test.ts` -- lines 43-53 hold GSTIN fixtures that the site and gst routes now refuse; the file already has effective_from fixtures from 2020 and 2021, inside the window
- `test/unit/business-days.test.ts` -- unit test style reference (`node:test`, `assert/strict`)

## Tasks & Acceptance

**Execution:**
- [x] `src/compliance/supplier.ts` -- export `gstinCheckCharacter(body14: string): string` and `isValidGstin(value: string): boolean` (regex plus check character) -- makes the check digit a single shared rule
- [x] `src/api/v1/gst.ts` -- `gstinField` and `gstinQueryParam` call `isValidGstin` in place of `GSTIN_REGEX.test`; drop the `GSTIN_REGEX` import -- gst callers get the check digit
- [x] `src/api/v1/sites.ts` -- `gstin_ext` check calls `isValidGstin`; add exported `assertSiteGstinEffectiveFrom(effectiveFrom: string, today: string)` enforcing `2017-07-01` to `today + 366 days` and throwing 400 INVALID_PARAMS; call it in `postSiteGstinBase` after `parseDateWindow` with `toIstCalendarDate(new Date())` -- DW-25 and DW-26 site side
- [x] `test/integration/story-11-5.test.ts` -- replace the ten fixture constants on lines 44-53 with check-digit-valid GSTINs that keep the same state code and middle, and update the line 43 comment -- existing route tests must keep passing
- [x] `test/unit/gstin-validation.test.ts` -- new: known-valid GSTIN accepted; transposed and wrong-check GSTINs rejected; `gstinCheckCharacter` matches the spec example; window edges accepted; one day outside each edge refused with 400 INVALID_PARAMS -- covers both DW items

**Acceptance Criteria:**
- Given `27AAPFU0939F1ZV`, when `isValidGstin` runs, then it returns true
- Given `27AAPFU0939F1VZ` (transposed), when `isValidGstin` runs, then it returns false
- Given a site GSTIN POST with a transposed `gstin_ext`, when the request is processed, then the response is 400 INVALID_PARAMS and nothing is inserted
- Given a site GSTIN POST with `effective_from` `2999-01-01`, when processed, then the response is 400 INVALID_PARAMS naming the window and nothing is inserted
- Given a site GSTIN POST with `effective_from` `2017-07-01` and a valid GSTIN, when processed, then it is accepted as before
- Given the gst branch-transfer routes with a transposed GSTIN, when the request is processed, then the response is 400 INVALID_PARAMS
- Given the supplier registration path, when a GSTIN fails only the check digit, then behaviour is unchanged (shape-only)

## Spec Change Log

## Review Triage Log

### 2026-11-22 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 0
- defer: 5: (high 0, medium 0, low 5)
- reject: 2: (high 0, medium 0, low 2)
- addressed_findings:
  - none

## Design Notes

Check character per the GST mod-36 scheme: map each character to its index in `0-9A-Z`, multiply by weight 1 (even index) or 2 (odd index), sum `floor(p/36) + p%36`, then the check character is `charset[(36 - sum % 36) % 36]`. Reference: `27AAPFU0939F1ZV` yields `V`.

Window rationale: GST went live on 2017-07-01, so no GSTIN can be effective earlier. The upper bound allows a registration dated ahead for a planned change but refuses a typo'd far-future year.

## Verification

**Commands:**
- `npm run build` -- expected: tsc exits 0
- `node --env-file=.env.test --import tsx --test test/unit/gstin-validation.test.ts` -- expected: all pass
- `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/integration/story-11-5.test.ts` -- expected: all pass (DB on 127.0.0.1:5442)
- `npx eslint src/compliance/supplier.ts src/api/v1/sites.ts src/api/v1/gst.ts test/unit/gstin-validation.test.ts test/integration/story-11-5.test.ts` -- expected: no errors

**Manual checks (if no CLI):**
- `supplier.ts` still exports `GSTIN_REGEX` with its original body

## Auto Run Result

Status: done

**Summary:** Added `isValidGstin` (shape plus mod-36 check character) in `src/compliance/supplier.ts` and used it in the site and gst GSTIN validators. Added `assertSiteGstinEffectiveFrom` (2017-07-01 to today + 366 days, 400 INVALID_PARAMS) to the site GSTIN POST. Re-issued the ten story-11-5 GSTIN fixtures with valid check digits.

**Files changed:**
- `src/compliance/supplier.ts`: `gstinCheckCharacter` and `isValidGstin` beside `GSTIN_REGEX` (unchanged)
- `src/api/v1/gst.ts`: GSTIN body and query-param validation use `isValidGstin`
- `src/api/v1/sites.ts`: `gstin_ext` uses `isValidGstin`; `assertSiteGstinEffectiveFrom` called after `parseDateWindow`
- `test/integration/story-11-5.test.ts`: check digits corrected on fixtures A, B, E, F, G, H, I, J, K, M
- `test/unit/gstin-validation.test.ts`: new, 4 tests
- `_bmad-output/implementation-artifacts/spec-s0-gstin-validation.md`: this spec

**Review findings:** patches 0, deferred 5, rejected 2. Deferred items are not appended to the ledger, per the orchestrator instruction:
- `effective_to` has no upper bound on the site route (same DW-26 class).
- `gst.ts` valuation-config `effective_from` has no window (spec Never-list).
- Supplier-side GSTIN (`supplier.registered`, `supplier-invoice.ts` recipient) stays shape-only by scope; DW-25 is only partly closed.
- DB CHECK in `site_gstin.sql` remains shape-only, so direct SQL inserts bypass both rules.
- Stored legacy GSTINs with a bad check digit now return 400 on the gst GET filter and on replays of old idempotency keys. Owner should check pilot data.

Rejected: `toUpperCase` Unicode normalisation (pre-existing); exported `gstinCheckCharacter` lacks a shape guard (internal, sole caller checks shape first).

**Follow-up review recommended:** false (no patches applied in the final pass).

**Verification:**
- `npx tsc --noEmit`: exit 0 (subagent). `npm run build` not run.
- `test/unit/gstin-validation.test.ts`: 4 of 4 pass.
- `test/integration/story-11-5.test.ts` (concurrency 1, test DB 5442): 44 of 44 pass.
- `eslint` on changed files: exit 0 (subagent).
- Prettier: CRLF noise only on the working copy; `sites.ts` line length fixed.
- `graphify update .`: ran.

**Residual risks:** see deferred list above. Supplier-side fixtures in story-4-x use bad check digits; they still pass because that path stays shape-only and will break if it is tightened.
