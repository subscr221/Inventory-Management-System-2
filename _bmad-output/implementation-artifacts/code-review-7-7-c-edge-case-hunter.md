# Story 7.7 Group C Review - Edge Case Hunter

Reviewed: `_bmad-output/diff-7-7-group-c.patch` against the implementation surfaces the suite
exercises (`src/api/v1/maintenance.ts`, `src/compliance/maintenance-coverage.ts`,
`src/compliance/maintenance-fault.ts`, `src/maintenance/coverage-jobs.ts`,
`src/read/projections/asset_coverage.ts`). Findings are unexercised paths only. Deletion
check: N/A (new-file diff). Date: 2026-08-27. Line refs "L" are patch lines
(test-file line = patch line - 6).

## High

### CE1. Scan on the expiry day itself (days_remaining == 0) never tested

Due-ness is `(expiry - bd) <= stage AND expiry >= bd` (`asset_coverage.ts:307-308`), so
`business_date == expiry_date` is due and alertable. Tests scan at exactly -90/-60/-30
(L621-627) and at expiry+1 (L814-823) - the inclusive `>=` boundary that separates
"last-day alert" from "already expired" is unpinned.

### CE2. Warranty-check window boundaries (start == today, expiry == today) untested

`getActiveWarrantyForAsset` uses `start_date <= d AND expiry_date >= d`
(`asset_coverage.ts:181-182`). AC2 fixtures sit at -1/+5/plus-minus-10-day offsets
(L968-976); a warranty expiring today or starting today never flows through
`breakdownWorkOrder`, so whether a last-day warranty flags a breakdown WO is unverified.

### CE3. Record-coverage equality boundaries untested: expiry == business_date, start == business_date

Seam gates are strict (`expiryDate < businessDate` rejects COVERAGE_ALREADY_EXPIRED,
`maintenance-coverage.ts:326`; future-start tests `start > bd`). The 422 tests use
expiry = ANCHOR-1 and start = ANCHOR+10 (L1575-1590); the accepted-on-the-boundary cases
(a coverage expiring today / starting today) are never asserted as 201.

### CE4. Forged `coverage_expiry_flagged` seam rejections only partially exercised

Tested: stage-not-due mismatch (L825-867) and duplicate grain (L869-900). Untested branches
in `maintenance-coverage.ts`: unknown coverage 404 COVERAGE_NOT_FOUND (:422), flag against
an expired coverage COVERAGE_ALREADY_EXPIRED (:426), declared vs derived `expiry_date`
mismatch (:442-454), `stream_id != alert_id` INVALID_PAYLOAD (:230-236), `stage_days`
outside {90,60,30} INVALID_PAYLOAD (:211-217).

## Medium

### CE5. Reason-code input edges untested

Empty/whitespace-only or over MAX_REASON_CODE_LENGTH gives 400 INVALID_PARAMS
(`maintenance.ts:4192-4203`), never hit - only the in-length unlisted code 422
(L1296-1311). Case-sensitivity also unpinned: `includes()` (:4239) makes a lowercase
variant of a configured code a 422; no test asserts that.

### CE6. Zero-length coverage (start_date == expiry_date) untested

Handler rejects `expiryDate <= startDate` (`maintenance.ts:3927`); tests cover only the
strictly inverted window (L1601-1605), leaving the `==` half of the `<=` unexercised.

### CE7. `contract_value` regex boundaries untested

Pattern `^\d{1,11}(\.\d{1,3})?$` - negative values, 4 decimals, 12 integer digits, empty
string, `'0.000'` never sent; the only rejection tested is a non-string (`1000`,
L1607-1609).

### CE8. `provider_name` / `reference_number_ext` guard branches untested

Whitespace-only strings and over MAX_COVERAGE_TEXT_LENGTH give 400
(`maintenance.ts:3903-3923`), no test; only happy-path trimming pinned (L1499-1517).

### CE9. Scan `asset_id` filter edges untested

Non-UUID `asset_id` 400 (`maintenance.ts:271`), a valid-but-unknown UUID (zero coverages
evaluated), and the global no-filter scan (`coverage-jobs.ts:127`, `asset_id ?? null`) -
every scan in the suite passes `asset_id` (L622 et al.), so the unfiltered branch that
production cron would use is never run.

### CE10. Concurrent scan race untested

Two parallel scans on the same `business_date` (grain race swallowed per-stage,
`coverage-jobs.ts:199-205`) - only the sequential same-date re-run is tested (L679-691).
The suite races overrides (L1354-1367) and coverage writes (L1558-1572) but never the scan
itself.

### CE11. Intermediate stage windows and partial catch-up untested

Scans happen at exactly -90/-60/-30 or full three-stage catch-up (L693-733). A scan at
e.g. -45 (90+60 due, 30 not; `notifications_suppressed == 1`) or -89 (only 90 due) is
never run, so the per-stage `<=` window between stage boundaries and the suppression
counter's intermediate value are unpinned.

### CE12. Idempotency replay with a different body untested

Replays tested with byte-identical bodies (L1630-1655, L1463-1493); a same-key POST with
changed fields (different reference or reason_code) silently replaying the original 201 is
behavior no test observes.

### CE13. Capitalization at exactly the threshold untested

Only threshold+1 flagged (L1206-1213) and 0.300 unflagged (L1183-1189); whether
`total_cost == capitalizationThreshold` flags (`>` vs `>=`) is unpinned.

## Low

### CE14. `notifications_dropped > 0` path never exercised

(`coverage-jobs.ts:228-231`); every test asserts it is 0, so the drop-counting branch is
untested.

### CE15. Override route not-found edges untested

Unknown work_order UUID 404 WORK_ORDER_NOT_FOUND (`maintenance.ts:4206-4211`), non-UUID
`workOrderId`/`coverageId` path params 400, GET warranty-overrides on unknown work order
404 (:4293-4298).

### CE16. List-filter branches untested

`status=future` (`maintenance.ts:4005`), `status` with omitted `business_date`
(IST-default branch, :4023 - the only place the server clock/timezone enters the read
surface), non-UUID `coverage_id` on the alerts list 400 (:4113-4114).

### CE17. DUPLICATE_COVERAGE grain across assets untested

Same reference + type on a DIFFERENT asset must be 201 (grain is
`(asset_id, coverage_type, lower(ref))`); only same-asset different-type is pinned
(L1549-1554).

### CE18. UTC-midnight drift unguarded

`TODAY` captured once at module load (L138) while the accept handler re-derives its date
per call (`maintenance.ts:1403`); a suite spanning midnight shifts every AC2 fixture
offset by one day with no assertion attributing the failure to clock drift (comment at
L25-28 acknowledges, nothing asserts).

### CE19. Gate persistence after warranty lapse unpinned

Completing/overriding a flagged work order whose warranty has since expired (flag
immutable at creation) is never tested - "expired coverage but still 403 without
override" is only implied.
