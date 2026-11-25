---
baseline_commit: 83bcb6148be8a8219886ad205eec05ce88cd89e2
---

# Story 10.4: Hub Member Records and Machine-Time Booking

Status: review

## Story

As a maker-hub operator,
I want member and walk-in customer records that every hub transaction references, and machine-time booking with operator-closed actuals, meter readings, and unclosed-booking exceptions,
So that every booking and sale is attributable to exactly one customer and machine usage is captured accurately.

## Acceptance Criteria

1. **Given** hub customers (FR-RD-13)
   **When** records are created
   **Then** hub member and walk-in customer records are maintained

2. **Given** a booking, sale, or job card (FR-RD-13)
   **When** it is created without a reference to exactly one member or walk-in customer record
   **Then** it is rejected with `error_code: "MEMBER_REFERENCE_REQUIRED"`; a reference to more than one customer record is rejected the same way

3. **Given** a machine-time booking (FR-RD-14)
   **When** the operator closes the booking
   **Then** actual machine time and the machine meter reading are recorded, and the meter reading feeds the FR-M-03 usage-meter register (Epic 7)

4. **Given** an open machine-time booking (FR-RD-14)
   **When** it remains unclosed for 24 hours
   **Then** an exception is raised to the hub operator for resolution

**Note:** Offline point-of-use sale, payment capture, and end-of-day reconciliation are Story 10.6. Member job cards and statements are Story 10.7.

**Source:** [epics.md](../planning-artifacts/epics.md) Story 10.4, lines 3904-3928, verbatim. Do not reword the ACs.

## Tasks / Subtasks

- [x] **Task 1: Projections `hub_customer`, `hub_machine`, `hub_booking` (AC: 1, 2, 3, 4)**
  - [x] `read/projections/hub_customer.sql` (new) - `customer_id UUID PK`, `customer_kind IN ('member','walk_in')`, `display_name`, `membership_no` (unique on `lower(btrim(membership_no))`, NOT NULL iff member, NULL iff walk_in via CHECK), `status IN ('active','inactive')`, `location_id`, source_event_id. No phone or other contact column: phone capture is deferred until a privacy decision (second review X5)
  - [x] `read/projections/hub_machine.sql` (new) - `machine_id UUID PK`, `machine_code` (unique on `lower(btrim(machine_code))`), `location_id` (maker_hub_store), `asset_id` (Epic 7 asset), `meter_id` (FR-M-03 meter); the machine-to-meter link is what lets a close feed the register
  - [x] `read/projections/hub_booking.sql` (new) - `booking_id UUID PK`, `customer_id UUID NOT NULL REFERENCES hub_customer`, `machine_id NOT NULL REFERENCES hub_machine`, `scheduled_start/scheduled_end`, `status IN ('open','closed')`, `opened_at`, `closed_at`, `actual_minutes` (CHECK >= 0, required when closed), `meter_reading_value`, `reading_id`, `exception_raised_at` (NULL until the 24h exception fires), `backdate_reason` (second review X4)
  - [x] Single-customer integrity is STRUCTURAL: one NOT NULL `customer_id` column, never two nullable member/walk-in columns, so "more than one" cannot be stored
  - [x] Append to `MIGRATIONS` tail in `src/events/migrate.ts`, mirror into `deploy/compose/init-db.sql`, add to `EXPECTED` in `test/unit/schema-drift.test.ts`

- [x] **Task 2: Event types and payload interfaces (AC: 1, 3, 4)**
  - [x] `src/events/schema.ts` - payload/envelope pairs for `hub.customer_registered`, `hub.machine_registered`, `hub.booking_opened`, `hub.booking_closed`, `hub.booking_exception_raised`
  - [x] Append to `SUPPORTED_EVENT_TYPES` on the stream type Story 10.1 used for maker-hub events (confirm in `schema.ts`; `requiresBusinessStream` per the 10.3 precedent)

- [x] **Task 3: Compliance seam `src/compliance/hub-customer.ts` (AC: 1, 2)**
  - [x] Customer register applier; export a REUSABLE `assertSingleHubCustomerRef(payload)` guard that throws `MEMBER_REFERENCE_REQUIRED` when zero or more than one customer reference is present (accept exactly one `customer_id`; reject `customer_ids` arrays of length != 1, or `member_id` plus `walk_in_id` together) and a DB-side `requireActiveHubCustomer(client, customerId)` check
  - [x] Stories 10.6 (sales) and 10.7 (job cards) call this same guard; do not fork it

- [x] **Task 4: Compliance seam `src/compliance/hub-booking.ts` (AC: 2, 3)**
  - [x] Open: shape assert (pre-transaction, no DB) then applier with `FOR UPDATE` on machine; refuses `MEMBER_REFERENCE_REQUIRED`
  - [x] Close: operator-only actuals (`actual_minutes`, `meter_reading_value`); inside the SAME `persistEvent` transaction, emit/apply `maintenance.meter_reading_recorded` with `source: 'hub_booking'` against the machine's `meter_id` by calling the existing `asset-meter.ts` applier path. Do NOT re-implement reading insertion or the regression check; `METER_READING_REGRESSION` from Story 7.2 surfaces unchanged and must roll the whole close back
  - [x] Closing an already-closed booking is refused (`HUB_BOOKING_ALREADY_CLOSED`)

- [x] **Task 5: 24-hour unclosed-booking exception job `src/hub/booking-jobs.ts` (AC: 4)**
  - [x] Model on `src/maintenance/*-jobs.ts` (e.g. `pm-jobs.ts`): select `status='open' AND exception_raised_at IS NULL AND opened_at <= now() - interval '24 hours'`, emit `hub.booking_exception_raised`, set `exception_raised_at` (idempotent, one exception per booking)
  - [x] Notify the hub operator with `emitNotificationInTransaction`; resolve the recipient from role assignments / registry data, never a hard-coded role literal (`test/unit/no-hardcoded-role-in-workflow.test.ts` must stay green)
  - [x] Register the job wherever the maintenance jobs are scheduled in `src/server.ts`

- [x] **Task 6: REST routes `src/api/v1/hub-customers.ts`, `hub-machines.ts`, `hub-bookings.ts` (AC: 1-4)**
  - [x] Customer create/list, machine register/list, booking open/close/list-open; register in `src/server.ts` and the Story 1.9 spine allowlist; RBAC via the existing site-role pattern from 10.3 routes
  - [x] Route handlers carry idempotency keys and delegate guards to the compliance seams (a direct `POST /api/v1/events` must not bypass them)

- [x] **Task 7: Error codes registered in three places (AC: 2, 3, 4)**
  - [x] `MEMBER_REFERENCE_REQUIRED` plus new `HUB_CUSTOMER_NOT_FOUND`, `HUB_MACHINE_NOT_FOUND`, `HUB_BOOKING_NOT_FOUND`, `HUB_BOOKING_ALREADY_CLOSED`, `HUB_MACHINE_NOT_METERED` in `PERMANENT_ERROR_CODES` (`src/sync/upload.ts`), `edge/src/sync/connector.ts`, `edge/src/messages/en.json`. There is no separate server error registry: the seams throw these as `AppError` codes, so the three client-facing places are the whole registration surface. Review 2026-11-25: `HUB_MACHINE_BUSY`, `HUB_DUPLICATE_RECORD` and `HUB_BOOKING_NOT_OVERDUE` were added to all three places. Second review P-A: the three `*_NOT_FOUND` codes are NOT in the permanent sets and are listed in an explicit `RETRYABLE_ERROR_CODES` set in both classifiers, checked before the generic 4xx branch (absence from the permanent set alone would have settled them as `needs_attention`), so they retry offline

- [x] **Task 8: Integration test `test/integration/story-10-4.test.ts` (AC: 1-4)**
  - [x] AC1 member and walk-in created; membership_no rules. AC2 booking with no ref, with two refs, with unknown ref all `MEMBER_REFERENCE_REQUIRED` / not found; exactly one succeeds. AC3 close records actuals and the meter reading appears in `asset_meter_reading` with `source='hub_booking'` and advances the meter; regression reading rolls back the close. AC4 job with a booking opened 25h ago raises exactly one exception and a second run is a no-op; a booking opened 23h ago and a closed booking raise none

- [x] **Task 9: Verification gates**
  - [x] `npx tsc --noEmit`, `npm run lint`, `npm run db:migrate` twice (idempotent), `npm test`, `npm run spine-acceptance-contract`, `npm run edge:typecheck`, schema-drift and no-hardcoded-role-in-workflow green; then `graphify update .`

## Dev Notes

### Scope boundaries - read before writing code

This story owns hub customer records, the machine register link to Epic 7 meters, machine-time booking open/close, the meter-reading feed, and the 24-hour unclosed exception. It does NOT own:

- **Point-of-use sale, payment capture, end-of-day reconciliation.** Story 10.6. It will consume `assertSingleHubCustomerRef`; ship the guard here, not the sale.
- **Member job cards and statements.** Story 10.7. Same guard.
- **Usage-meter register internals.** Story 7.2 owns `asset_meter`, `asset_meter_reading`, regression and silent-meter logic. This story only CALLS it with `source: 'hub_booking'` (the value is already in `READING_SOURCES`).
- **Billing machine time.** No rates, charges or invoicing here.
- **Booking calendar UX.** Not in the ACs. The only conflict rule is `HUB_MACHINE_BUSY` (review D3, narrowed by second review X3): a new booking is refused when its scheduled window overlaps an open booking's window on the same machine, or when either has no complete scheduled window.

### Existing infrastructure this story reuses, not reinvents

Table 1 lists the precedents. Reinventing any row is a review-blocking defect.

| Component | Path | How Story 10.4 uses it |
| --- | --- | --- |
| Usage-meter seam | `src/compliance/asset-meter.ts` (`maintenance.meter_reading_recorded`, `READING_SOURCES` includes `hub_booking`) | the close path feeds the register through it; regression/shape checks come free |
| Meter projections | `read/projections/asset_meter.sql`, `asset_meter_reading.sql`, `src/read/projections/asset_meter*.ts` | read accessors for the test and for resolving a machine's meter |
| Asset register | `read/projections/asset.sql`, `src/compliance/asset.ts` | `hub_machine.asset_id` references the Epic 7 asset; do not create a second machine master |
| R&D/hub guards | `src/compliance/rd-guards.ts` (`RD_LOCATION_TYPES` has `maker_hub_store`, stream `maker_hub`) | location and stream conventions for hub rows |
| Compliance seam pattern | `src/compliance/rd-prototype.ts`, `rd-disposition.ts` (Story 10.3) | structure: `*EventType`, pre-transaction shape assert, in-transaction applier, `alreadyPersisted` plain SELECT |
| Scheduled jobs | `src/maintenance/pm-jobs.ts`, `reliability-jobs.ts` | model for the 24h exception job |
| Notifications | `emitNotificationInTransaction` | exception delivery to the hub operator |
| Route registration | `src/server.ts`, `src/api/v1/rd-*.ts` | 10.3 routes are the closest template |

### Architecture invariants that bind this story

- **AD-9 (one asset register):** machines are Epic 7 assets; `hub_machine` is a link table, not a master.
- **AD-14 (read models are shared projections):** write through `persistEvent` only, read via accessors.
- **AD-16 (idempotency):** every command carries an idempotency key; `alreadyPersisted` is a plain SELECT, never `FOR UPDATE` on `domain_events`.
- **No hard-coded roles in workflow code:** hub operator resolved from role/registry data.

### Exactly-one customer reference (AC 2)

Enforce at two layers: (a) pre-transaction shape assert on the command payload (zero or multiple refs: `MEMBER_REFERENCE_REQUIRED`, HTTP 400, details `{ refs_supplied: n }`), (b) the booking row's single NOT NULL FK. A reference to a non-existent or inactive customer is `HUB_CUSTOMER_NOT_FOUND`, not `MEMBER_REFERENCE_REQUIRED`. Export the guard from `hub-customer.ts` for 10.6/10.7.

### Close and meter feed (AC 3)

The booking close and the meter reading must commit atomically: one transaction, so a rejected reading (`METER_READING_REGRESSION`) leaves the booking open. A machine with no linked `meter_id` cannot be booked at all: `HUB_MACHINE_NOT_METERED` (409) at open (second review P-F); the same check stays at close as a guard. `reading_id` is generated by the command and stored on the booking for traceability. `actual_minutes` is operator-entered, an integer from 0 to 100000, and may not exceed the whole minutes (rounded up) between the STORED `opened_at` and `closed_at`; within that cap it is independent of the clock difference. `meter_reading_value` must be exact in NUMERIC(18,4): at most 14 integer and 4 decimal digits in the shortest decimal form of the number, so nothing is silently rounded (P-J).

### 24-hour exception (AC 4)

Threshold is 24 hours from `opened_at` (not from `scheduled_end`). Make the 24h a named constant, not a magic number. The job must be safe to run repeatedly (idempotent via `exception_raised_at`). The exception does not auto-close or alter the booking; the operator resolves it by closing the booking.

### Error codes

Reuse nothing already minted. New codes and their offline classification (both classifiers, `src/sync/upload.ts` and `edge/src/sync/connector.ts`, plus `edge/src/messages/en.json`; there is no server-side registry):

- Permanent (`PERMANENT_ERROR_CODES`, settle as `needs_attention`): `MEMBER_REFERENCE_REQUIRED`, `HUB_BOOKING_ALREADY_CLOSED`, `HUB_MACHINE_BUSY`, `HUB_MACHINE_NOT_METERED`, `HUB_DUPLICATE_RECORD`, `HUB_BOOKING_NOT_OVERDUE`.
- Retryable (`RETRYABLE_ERROR_CODES`, stay `pending_sync`, because the parent record may still be syncing): `HUB_CUSTOMER_NOT_FOUND`, `HUB_MACHINE_NOT_FOUND`, `HUB_BOOKING_NOT_FOUND`.
- Reused existing codes: `INVALID_PARAMS`, `LOCATION_NOT_FOUND`, `ASSET_NOT_FOUND`, `METER_NOT_FOUND`, `METER_READING_REGRESSION`, `LOCATION_ACCESS_DENIED`, `DUPLICATE_EVENT`.

### Inherited defects and corrections - do not copy (from Stories 10.2/10.3)

- `alreadyPersisted` uses a plain SELECT, never `FOR UPDATE` on `domain_events`.
- Guarded DROP/ADD pairs must escape `_` in `indexdef NOT LIKE` patterns or match on the constraint name.
- Timestamps in payloads need an explicit UTC offset (the `ISO8601_TIMESTAMP_REGEX` rule in `asset-meter.ts`); a naive timestamp shifts the 24h clock.
- NUMERIC(18,4) bound for meter values: reuse the meter seam's validation, do not re-derive.

### Open questions (not blockers; proceed with the defaults stated)

- Q1: Walk-in records: persisted per visit or reusable? Default: reusable record, `membership_no` NULL.
- Q2: Which role is the "hub operator" recipient for exceptions? Default: resolve from site role assignments for the booking's location; confirm the role name with the owner and seed it as registry data.
- Q3: Can a booking be opened by someone other than the closing operator? Default: yes, any hub staff with the site role.
- Q4 (second review): phone capture. Deferred; no contact field exists in Phase 1 until a privacy decision is made.
- Known limit (second review X2): `opened_at` and `closed_at` are checked against server time when the event is first applied (5 minutes either way; `opened_at` up to 12 hours back with a `backdate_reason`). An offline-queued hub event is therefore accepted only while its timestamps are inside those bounds; a replay of an event the server already holds always returns the original event. Revisit when the edge queues hub writes.

### Verification commands

- `npm run test:integration -- test/integration/story-10-4.test.ts`
- `npx tsc --noEmit`; `npm run lint`; `npm run db:migrate` (twice)
- `npm run spine-acceptance-contract`; `npm run edge:typecheck`
- `test/unit/schema-drift.test.ts`, `test/unit/no-hardcoded-role-in-workflow.test.ts`

## References

- [epics.md](../planning-artifacts/epics.md) lines 3904-3928 - Story 10.4 ACs, verbatim source
- [epics.md](../planning-artifacts/epics.md) line 2912 - hub-booking meter publication is delivered here (Story 7.2 note)
- [10-3-project-wip-ledger-and-prototype-build-records.md](10-3-project-wip-ledger-and-prototype-build-records.md) - seam, route, error-code precedents
- [epic-10-context.md](epic-10-context.md) - FR-RD-13/14, `MEMBER_REFERENCE_REQUIRED` constraint
- `src/compliance/asset-meter.ts` - meter reading seam, `hub_booking` source
- `src/maintenance/pm-jobs.ts` - scheduled-job pattern

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5.5

### Debug Log References

Gates: tsc clean; lint clean; db:migrate twice idempotent; story-10-4 5/5; spine-acceptance-contract 6/6; edge:typecheck clean; full npm test 2916/2916.

After second review 2026-11-25: tsc clean; lint clean; db:migrate twice idempotent; story-10-4 21/21 (run twice); story-1-9 6/6; schema-drift, no-hardcoded-role, background-cycles, sync-upload and edge-permanent-error-parity 258/258; edge connector unit 18/18; spine-acceptance-contract 6/6; edge:typecheck clean; full npm test 2933/2933.

After review 2026-11-25: tsc clean; lint clean; db:migrate twice idempotent; story-10-4 13/13 (run twice); story-1-9 6/6; schema-drift 228/228; no-hardcoded-role 1/1; background-cycles 13/13; spine-acceptance-contract 6/6; edge:typecheck clean; full npm test 2924/2924.

### Completion Notes List

- Hub events ride the existing 'research' stream (10.1 added no maker_hub stream type; maker_hub is a business-stream tag and location type).
- Close applies the 7.2 meter applier (source hub_booking) in the same transaction through a synthetic maintenance envelope; no separate domain_events row is written for the reading, the hub.booking_closed event carries reading_id.
- Hub operator role is DATA on hub_machine.operator_role (Q2 default); the 24h job notifies it in-transaction.
- Added codes beyond the list: HUB_DUPLICATE_RECORD, HUB_BOOKING_NOT_OVERDUE. Added 'hub booking exception' background cycle (HUB_BOOKING_EXCEPTION_SWEEP_INTERVAL_MS, hourly) and updated background-cycles test.
- Tests written alongside the implementation, not strictly red-first.
- Q1 walk-in reusable (membership_no NULL); Q3 any hub staff with the engineering write role may open or close.

### Review Decisions and Patches (2026-11-25)

Decisions (owner accepted the recommendations):

- D1 done. Exception notification targets `{ role: operator_role }` with no location_id, matching `src/maintenance/pm-jobs.ts`. Verified in `src/notify/dispatch.ts`: `resolveTargetUserIds` adds a location clause only when `location_id` is set, so a role-only target notifies every holder of the role at any location (and `emit.ts` stores a null location). The test asserts the stored target has a role and no location.
- D2 done. New event `hub.machine_meter_linked` (payload machine_id, meter_id; the meter's asset must equal the machine's asset) on the research stream, registered in `src/events/schema.ts` (payload, envelope, `SUPPORTED_EVENT_TYPES`), applied in `src/compliance/hub-booking.ts` (machine locked FOR UPDATE; same meter is a no-op, a different meter is `HUB_DUPLICATE_RECORD`), exposed as `POST /api/v1/hub-machines/:machineId/meter` (idempotent via idempotency_key, in the Story 1.9 allowlist). `HUB_MACHINE_NOT_METERED` still refuses a close on an unlinked machine. The payload carries no asset_id: the asset is derived from the locked machine row, so it cannot disagree with it.
- D3 done. Opening a booking on a machine that already has an open booking is `HUB_MACHINE_BUSY` (409), checked under the machine row lock in the applier; the pre-transaction shape check stays DB-free. Registered in `src/sync/upload.ts`, `edge/src/sync/connector.ts` and `en.json`.
- D4 done. `assertHubLocationAccess` and `hubReadScope` in `src/api/v1/hub-common.ts` reuse `assignmentCoversLocation` and `permittedLocationsForModuleScope` from `src/middleware/rbac.ts`. Writes need an engineering write assignment covering the machine's location (open, close, meter link, register) or the customer's location when one is given; list endpoints filter to readable locations. A customer with no location is unscoped and visible to every reader. A booking is scoped by its machine's location only; the customer's location is not checked at booking time. Denial is 403 `LOCATION_ACCESS_DENIED`. The seam itself is not location-aware, so a direct `POST /api/v1/events` is governed by that route's own scope rules.
- D5 done, superseded by second review X5 (no phone data at all in Phase 1; the hash and its salt are removed). The raw phone never enters an event payload or the read model. The route hashes it to `contact_phone_hash` (salted SHA-256, fixed documented salt `HUB_PHONE_SALT` in `src/compliance/hub-customer.ts`); the column was renamed to `contact_phone_hash` in `hub_customer.sql` and `init-db.sql` (tables are unreleased, so no data migration); the seam refuses any payload that still carries `contact_phone`. The hash is pseudonymous, not anonymous: a fixed salt does not stop a targeted guess of the small phone space. A keyed HMAC with a secret in config is the upgrade path.
- D6 done, refined by second review X2 and X4 (the checks moved to the applier so replays skip them, and `opened_at` may be backdated up to 12 hours with a reason). The server sets `opened_at` and `closed_at` to now when omitted; a client value must be within 5 minutes of server time (shape check, `INVALID_PARAMS`). Backdating is therefore impossible through the API. The 24-hour selector itself is unchanged (`opened_at <= now() - 24h`); tests that need an old booking move `opened_at` by direct UPDATE (`backdate` helper). Known limit: the bound also applies to a hub event replayed from an offline queue more than 5 minutes after it was created, which is then a permanent `INVALID_PARAMS`; revisit when the edge queues hub writes.

Patches:

- P1 done. Create, open, close, machine register and meter link return the original record on an idempotent replay (id taken from the persisted event); a key reused for a different event type, or (close, meter link) a different stream, is 409 `DUPLICATE_EVENT`. Blank idempotency keys are treated as absent.
- P2 done. `runHubBookingExceptionJob` catches and logs per booking, continues, and returns `failures`; only `HUB_BOOKING_NOT_OVERDUE` is silent. No test forces a failing booking.
- P3 done. `uq_hub_machine_asset` on hub_machine(asset_id) and the partial `uq_hub_machine_meter` on hub_machine(meter_id) WHERE meter_id IS NOT NULL, created with IF NOT EXISTS in `hub_machine.sql` and mirrored in `init-db.sql`; schema-drift EXPECTED updated. A duplicate is 409 `HUB_DUPLICATE_RECORD`.
- P4 done. `HUB_CUSTOMER_NOT_FOUND`, `HUB_MACHINE_NOT_FOUND` and `HUB_BOOKING_NOT_FOUND` are out of both `PERMANENT_ERROR_CODES` sets, so the sync layer was meant to retry them. That was wrong: a code absent from the set falls to the generic 4xx branch and settles as `needs_attention`. Corrected by second review P-A with an explicit retry list. The en.json messages stay.
- P5 done. `actual_minutes` is an integer from 0 to 100000 and may not exceed the minutes between opened_at and closed_at (rounded up to the next minute); both are `INVALID_PARAMS` 400.
- P6 done. A customer `location_id` must exist (`LOCATION_NOT_FOUND`, 404) and be a maker_hub_store (`INVALID_PARAMS`, as for machines) through the shared `requireHubLocation`; no new code needed.
- P7 done. The close compares times with `new Date(x).getTime()`, so the Date returned by pg keeps its milliseconds.
- P8 done. The close shape check validates `actual_minutes`, `meter_reading_value` (finite, non-negative, NUMERIC(18,4)) and `closed_at` directly, so errors name the close fields, not the meter envelope fields.
- P9 done. The unreachable 404 after a persisted close is gone; the route returns the booking as read.
- P10 done. Integration tests rewritten: each test seeds its own asset, meter, machine and customer with run-unique codes; no TRUNCATE. Added: idempotent replay (open, register, customer, close, key reuse across types and streams), HUB_MACHINE_BUSY, 24h boundary (exactly 24h overdue, 23h59 not), closed_at before opened_at, read-only role denied on write routes, location-scoped writer, meter-ownership mismatch at register and link, close field naming, and the phone hash.
- P11 done. Task 7 and the Dev Notes error-code line now name the real registration places (upload.ts, connector.ts, en.json) and state there is no server registry.

### Second Review Decisions and Patches (2026-11-25)

Decisions (owner accepted the recommendations):

- X1 done. Direct `hub.*` events on the generic doors now need the `engineering` module and the hub location rule. Finding: the edge upload door (`POST /api/v1/edge/events`) is NOT closed to the research stream, so it carried hub events exactly like `POST /api/v1/events`, authorised only by a `research` grant. Both doors now resolve the module to `engineering` for any `hub.*` event type and call `assertHubEventWriteAccess` (`src/api/v1/hub-common.ts`): a global engineering writer passes; a location-scoped writer needs the machine's or booking's location (from the row), or the payload `location_id` for customer and machine registration, to be covered. No edge client queues hub events yet (`edge/src` has only the error-code classifiers), so no existing edge flow changed; a scoped engineering user still uploads through the edge door (tested).
- X2 done. The 5-minute window moved from the pre-transaction shape check into the applier, which runs only for a new event; `persistEvent` returns the original event for a replayed idempotency key before any applier, so a replay is never refused for its age. Server time is the default when the timestamp is omitted. Offline-queued events are accepted only inside the window (see Open questions).
- X3 done. `HUB_MACHINE_BUSY` only when the new booking's scheduled window overlaps an open booking's window on the same machine (half-open, so adjacent windows are fine). A booking with no complete window conflicts with any open booking, and an open booking with no window blocks any new one. Still checked under the machine row lock.
- X4 done. A client `opened_at` more than 5 minutes in the past needs a non-blank `backdate_reason` (at most 500 characters) and may be at most 12 hours back; the 5-minute future skew limit stays. The reason is stored on `hub_booking.backdate_reason`. The `actual_minutes` cap stays relative to the stored `opened_at` and `closed_at`.
- X5 done. `contact_phone_hash`, its salt and the route hashing are gone from the projection SQL, `init-db.sql`, the payload, the seam, the route, the read accessor and the tests. The seam refuses any payload carrying `contact_phone` or `contact_phone_hash`; the route ignores an unknown `contact_phone` field. No contact field is returned in any hub customer response. The migration drops an existing `contact_phone_hash` column (unreleased table).
- X6 done. `operator_role` is validated at machine registration against 1 to 64 letters, digits, underscores or hyphens. The repo has no role registry (roles are free text on `user_role_assignments`), so there is no existence check; pattern only. The exception notification stays role-only with no location. Because a row seeded outside registration can still hold a bad role, `applyException` refuses to flag a booking whose machine role fails the pattern (`INVALID_PARAMS`, rolled back), so the sweep counts it in `failures` instead of raising an exception nobody is notified of.

Patches:

- P-A done. `RETRYABLE_ERROR_CODES` (the three `*_NOT_FOUND` codes) in `classifyUploadFailure` and `classifyServerUploadFailure`, checked before the generic 4xx branch and kept out of `PERMANENT_ERROR_CODES`; comments corrected; unit tests in `test/unit/sync-upload.test.ts` and `edge/test/unit/connector.test.ts`.
- P-B done. `replayId` compares the stream id lowercase; an uppercase UUID in the close URL returns 200.
- P-C done. `persistHubEvent` takes a `compare` list of the client-supplied material fields per route; a replay whose stored values differ is 409 `DUPLICATE_EVENT` with `changed_fields`. Server-generated values (new ids, defaulted timestamps) are not compared.
- P-D done. A writer whose engineering write grant is location-scoped must give a customer `location_id` (403 `LOCATION_ACCESS_DENIED`); a global writer may omit it. Applies to the route and to direct events.
- P-E done. `asset_id` and `meter_id` are lowercased before comparing and storing at machine registration and meter link.
- P-F done. Opening a booking on a machine with no meter is 409 `HUB_MACHINE_NOT_METERED`; no booking row is written.
- P-G done. `isTs` checks every calendar and clock component (month, day of month with leap years, hour, minute, second, offset), so 2026-02-30 and similar are `INVALID_PARAMS`, not a 500.
- P-H done. A blank `membership_no` on a walk-in is treated as absent.
- P-I done. `''` or whitespace in `customer_id`, `member_id`, `walk_in_id` or a `customer_ids` element is `MEMBER_REFERENCE_REQUIRED`.
- P-J done. `meter_reading_value` must match `^\d{1,14}(\.\d{1,4})?$` in its shortest decimal form: 0.3 and 120.5 pass, 0.30000000000000004, 1e-7 and 1e14 are refused.
- P-K done. `uq_hub_customer_membership_no` and `uq_hub_machine_code` are unique indexes on `lower(btrim(...))`; the migration drops the old constraints; `init-db.sql` mirrors; schema-drift pins the index bodies.
- P-L done. Task 1, Task 7, Dev Notes (Close and meter feed, Error codes, scope boundary), Open questions, the D5, D6 and P4 notes, and this Change Log are corrected.
- P-M done. Sweep test: one due booking whose machine holds an invalid `operator_role` fails, the other due booking still gets its exception, `failures` is 1.
- P-N done. Tests added for the uppercase URL close, open on an unmetered machine, disjoint and overlapping windows, backdating within 12 hours with a reason and refusal beyond 12 hours or without a reason, replay beyond the window, and direct `hub.*` events under a non-engineering role on both doors.

### Review Findings

Deferred, not fixed in this review:

- Lists (customers, machines, open bookings) are unpaged, and the exception sweep has no batch limit.
- No length rules on display_name, machine_code and membership_no (case-variant duplicates are now refused, second review P-K).
- No customer or machine deactivate or edit events (hub_customer.status is never changed).
- The booking close feeds the meter register through a synthetic envelope with no domain_events row of its own.
- A reading_id that already exists in asset_meter_reading would surface as a 500 rather than a mapped code.
- The new payload interfaces in `src/events/schema.ts` are unused by the seams, and `persistEvent` is called with `as never` casts.
- The exception is not escalated if the operator role has no holder or nobody acts on it.
- `raised_at` on `hub.booking_exception_raised` is client-controlled for a direct event.
- Opening a booking does not check the machine asset's state (for example decommissioned or under maintenance).

### File List

- read/projections/hub_customer.sql, hub_machine.sql, hub_booking.sql (new)
- src/read/projections/hub.ts (new, accessors for all three)
- src/compliance/hub-customer.ts, hub-booking.ts (new)
- src/hub/booking-jobs.ts (new)
- src/api/v1/hub-common.ts, hub-customers.ts, hub-machines.ts, hub-bookings.ts (new)
- test/integration/story-10-4.test.ts (new)
- src/events/schema.ts, store.ts, migrate.ts, server.ts, config/index.ts, sync/upload.ts (edited)
- src/api/v1/events.ts, src/api/v1/edge.ts (second review X1: hub.* module and location gate)
- deploy/compose/init-db.sql, edge/src/sync/connector.ts, edge/src/messages/en.json (edited)
- test/unit/schema-drift.test.ts, test/unit/background-cycles.test.ts, test/unit/sync-upload.test.ts, edge/test/unit/connector.test.ts, test/integration/story-1-9.test.ts (edited)

## Change Log

- 2026-11-24: Story 10.4 implemented; status review.
- 2026-11-25: Code review decisions D1-D6 and patches P1-P11 applied (see Review Decisions and Patches); status stays review.
- 2026-11-25: Second review decisions X1-X6 and patches P-A to P-N applied (see Second Review Decisions and Patches); status stays review.
