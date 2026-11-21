---
baseline_commit: c9858b907a0b6119120fb03000c0c2624127489a
---

# Story 7.10: Calibration Certificate Void and Supersede

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a QC manager,
I want to void a wrongly recorded calibration certificate or supersede it with a corrected one,
so that a wrong validity date neither locks a good instrument nor unlocks an expired one, without weakening the non-overridable lockout (Story 7.5).

## Acceptance Criteria

1. **Given** a certificate recorded under Story 7.5 (FR-M-12, FR-M-13), **When** the QC manager voids it with a reason, **Then** a void event is recorded, the certificate no longer counts toward the instrument's calibration status, the lockout is re-evaluated from the remaining certificates, and the voided row stays readable with its reason and actor.
2. **Given** a certificate with a wrong validity date, **When** the QC manager supersedes it with a corrected certificate, **Then** the corrected certificate is recorded, the original is marked superseded in the same transaction, and the 30/14/7-day alert schedule is recomputed from the corrected dates.
3. **Given** an instrument whose only valid certificate is voided, **When** the void is recorded, **Then** the `CALIBRATION_LOCKOUT` bar applies immediately and no role can override it.
4. **Given** a void or supersede on a certificate the actor did not record, **When** it is submitted, **Then** it is accepted only from the QC manager role; the recording inspector cannot void their own certificate (segregation, same shape as SOD-07).

## Tasks / Subtasks

- [x] Task 1: Schema - additive certificate columns, status widening, partial number index (AC: 1, 2)
  - [x] 1.1 In `read/projections/instrument_calibration_certificate.sql` add guarded `ADD COLUMN IF NOT EXISTS` blocks: `voided_at TIMESTAMPTZ`, `void_reason TEXT`, `voided_by UUID`, `superseded_as_correction BOOLEAN NOT NULL DEFAULT false`. Widen `chk_instrument_calibration_certificate_status` to include `'voided'` via the guarded DROP-then-ADD block already in that file (pattern at lines 80-88). Replace `uq_instrument_calibration_certificate_number` with a partial version `WHERE status = 'active'` via guarded DROP/CREATE (Binding Decision 6). Keep every block self-sufficient with guarded grants (project memory `migrations.dual_file_self_sufficient_guarded_grants`); the existing `GRANT INSERT, SELECT, UPDATE TO app_user` covers new columns automatically (column-level grants are not used).
  - [x] 1.2 Mirror every block byte-for-byte into `deploy/compose/init-db.sql` (calibration block lives at init-db.sql:7624-7725). Mind line endings: init-db.sql is CRLF; the canonical read/projections files are LF. Never touch the `powersync_publication` block.
  - [x] 1.3 Update `test/unit/schema-drift.test.ts` EXPECTED entries for the certificate table (constraints, indexes, appUserGrant; entry at :1130-1142) and any accessor-column pin. Run `node --env-file=.env.test --import tsx src/events/migrate.ts` twice to prove idempotency; schema-drift must pass.
  - [x] 1.4 Do NOT reorder `src/events/migrate.ts` MIGRATIONS (calibration entries at :118-126 stay in place; edited files re-apply via guarded blocks). No new migration file is needed; this is an amendment of an existing projection file.

- [x] Task 2: Event contract in `src/events/schema.ts` (AC: 1, 2)
  - [x] 2.1 Append a Story 7.10 comment block after the Story 7.5 calibration block (:2785-2931): `CalibrationCertificateVoidedPayload` { `certificate_id`, `instrument_record_id`, `instrument_id` (DECLARED, checked under lock), `void_reason`, `voided_by` (SERVER-CAPTURED from envelope actor, declared-and-checked per the 8.7 server-captured idiom at schema.ts:4593-4601), `reactivated_certificate_id` (SERVER-DERIVED, nullable, written back onto the payload by the applier), `resulting_calibration_status` (SERVER-DERIVED write-back, `'calibrated' | 'out_of_calibration'`), `business_date`, `voided_at` } plus its Envelope interface. Document in the interface comment: stream_id is certificate_id; void is an event, never an edit; the applier re-derives every derivable field.
  - [x] 2.2 Extend `CalibrationCertificateRecordedPayload` with optional `supersedes_certificate_id?: string` and `supersede_reason?: string` (Binding Decision 5: ONE event type, branched, per the Story 9.6 offcut precedent). Document: when present, the correction rules apply (DOA authority, SOD, correction flag, number reuse); when absent, Story 7.5 behavior is byte-for-byte unchanged.
  - [x] 2.3 Register `maintenance.calibration_certificate_voided` in `SUPPORTED_EVENT_TYPES` (tail-append at the calibration entries :6434-6457) with `{ streamType: 'maintenance', requiresBusinessStream: false }`.

- [x] Task 3: Projection accessors (AC: 1, 2, 3)
  - [x] 3.1 In `src/read/projections/instrument_calibration_certificate.ts`: widen `CertificateStatus` (:15) with `'voided'`; extend `CERT_COLUMNS` with `voided_at`, `void_reason`, `voided_by`, `superseded_as_correction`; extend the `listCertificatesByInstrument` status filter (:199-225) to accept `'voided'`.
  - [x] 3.2 Add `voidCertificate(certificateId, { voidedAt, voidReason, voidedBy }, client)`: guarded `UPDATE ... SET status='voided', voided_at, void_reason, voided_by WHERE certificate_id = $1 AND status IN ('active','superseded') RETURNING *`; a `rowCount` of 0 is a defensive reject, never a silent no-op (7.9 BSD).
  - [x] 3.3 Add `findReactivationCandidate(instrumentRecordId, businessDate, client)`: latest remaining certificate for the instrument with `status = 'superseded'`, `superseded_as_correction = false`, and `valid_until >= $businessDate` (SQL DATE comparison), ordered by `valid_until DESC, recorded_at DESC`, `LIMIT 1`, FOR UPDATE when a client is passed. Add `reactivateCertificate(certificateId, client)`: guarded `UPDATE ... SET status='active' WHERE certificate_id = $1 AND status='superseded' RETURNING *` with rowCount check.
  - [x] 3.4 Extend `supersedeActiveCertificate` (:162-175) with an `asCorrection` flag parameter writing `superseded_as_correction`. Verify the existing call site in `applyCertificateRecorded` passes `false` explicitly.
  - [x] 3.5 Make `getCertificateByNumber` active-preferring after the partial-unique widening (Binding Decision 6): `ORDER BY (status = 'active') DESC, recorded_at DESC LIMIT 1`. Grep every call site and confirm none depends on number-global uniqueness.
  - [x] 3.6 Do NOT touch `setCalibrationStatusFromRegister` (`src/read/projections/instrument_calibration.ts:124-168`) or `ensureInstrumentCalibrationRow`. Status rows match `lower(instrument_id)`; always pass the canonical register key.

- [x] Task 4: Compliance seam in `src/compliance/calibration-register.ts` (AC: 1, 2, 3, 4)
  - [x] 4.1 Add `maintenance.calibration_certificate_voided` to `CALIBRATION_REGISTER_EVENT_TYPES` (:65-72), to `STREAM_ID_FIELD` (:198-205, value `certificate_id`), to the shape-assert switch (:174-193) via a new pure `assertCertificateVoidedShape`, and to the applier switch (:421-440).
  - [x] 4.2 `applyCertificateVoided(envelope, client, eventId)`: `alreadyPersisted` FIRST (:382-393; replay returns the stored event before any state check - the 7.5 resolve-route lesson). Then the documented Locking Contract order (:51-56): lock the register row FOR UPDATE; re-derive `instrument_record_id`/`instrument_id` and reject divergence 409 `CALIBRATION_DERIVATION_MISMATCH`; lock the certificate row FOR UPDATE; reject 404 `CERTIFICATE_NOT_FOUND`, 409 `CERTIFICATE_NOT_VOIDABLE` when status is `expired` or `voided`; trim and require `void_reason` (400 `INVALID_PARAMS` with `details.reason`, mirroring the reject-route idiom at `src/api/v1/maintenance.ts:1522-1528`); re-derive the DOA authority and the SOD leg under lock (Task 5); `voided_by` from `envelope.metadata.actor.user_id`, never the payload; `voided_at` from the transaction clock, never a caller-declared timestamp (7.5 review lesson 5); call `voidCertificate`.
  - [x] 4.3 Status re-evaluation when the voided certificate was the ACTIVE one (AC 1, 3): call `findReactivationCandidate`; if found, `reactivateCertificate` and write `reactivated_certificate_id` + `resulting_calibration_status='calibrated'` back onto the payload BEFORE the domain_events insert (the 7.9 write-back idiom, maintenance-spares.ts:492-531); else `resulting_calibration_status='out_of_calibration'` with `reactivated_certificate_id = null`. Finish with `setCalibrationStatusFromRegister` as the FINAL DB call. When the voided certificate was NOT active, no status write at all and `resulting_calibration_status` mirrors the current status.
  - [x] 4.4 Correction branch in `applyCertificateRecorded` (:523-664): when `supersedes_certificate_id` is present, run the existing flow with these additions: the superseded target must be the instrument's CURRENT active certificate for this instrument (409 `CERTIFICATE_NOT_SUPERSEDABLE` otherwise; correcting non-current history is out of scope); trim and require `supersede_reason`; DOA authority + SOD re-derivation (Task 5); pass `asCorrection: true` to `supersedeActiveCertificate`; write the derived `superseded_certificate_id`-side facts back onto the payload before insert. Number-duplicate pre-check must exempt the superseded target's own number (it is being superseded in the same transaction; Binding Decision 6).
  - [x] 4.5 SOD leg (AC 4): reject 403 `CERTIFICATE_RECORDER_CANNOT_CORRECT` when `envelope.metadata.actor.user_id` equals the locked certificate row's `recorded_by`, in BOTH the void applier and the correction branch (the 13.2/13.3 twin: applier uses the envelope actor, never a payload-declared actor).
  - [x] 4.6 No new 23505 resolver is expected (no new unique constraint; the number index is a widening of an existing arm at store.ts:1811-1844). Verify the widened index still maps to 409 `CERTIFICATE_ALREADY_RECORDED` and add a concurrency test that races the SAME number on the correction path.
  - [x] 4.7 `src/compliance/calibration.ts` (the Story 1.7 gate, 51 lines) is DO-NOT-TOUCH. `assertCalibrationLockout` keeps reading the single status row.

- [x] Task 5: DOA authority helper (AC: 4)
  - [x] 5.1 Add `resolveCalibrationCorrectionAuthority(transactionType, client)` to `calibration-register.ts`, mirroring the Story 8.7 `resolveComplianceAuthority` / Story 7.6 return-to-service pattern: `findFirstActiveDoaEntry(transactionType)` (src/read/projections/doa_registry.ts:232) then `findRoleHolder`; fail closed 404 `APPROVAL_UNRESOLVED`; require the envelope actor to be an active holder of the resolved entry via `isActiveRoleHolderForEntry` (:338), else 403 `APPROVAL_REQUIRED`.
  - [x] 5.2 New DOA transaction types: `maintenance.calibration_certificate_void` and `maintenance.calibration_certificate_supersede` (value 0, the `maintenance.return_to_service` / `maintenance.warranty_override` precedent). No central vocabulary table exists; types are seeded as DOA entry rows.
  - [x] 5.3 Test harness seeds both DOA entries with the pilot QC authority role and a holder user, exactly as story-7-5 seeds `calibration.escalation` for `calibration_scheduler`. Operational prerequisite to record in Completion Notes: before go-live, both bands must be seeded per site resolving to `qc_head` (Binding Decision 1).
  - [x] 5.4 No `SEGREGATED_ROLE_PAIRS` entry (src/cli/verify-segregated-roles-core.ts): the SOD leg is per-certificate actor identity (`recorded_by` on the locked row), not a role pairing - recorder and corrector may legitimately share a role. Document this in Dev Agent Record.

- [x] Task 6: API routes (AC: 1, 2, 4)
  - [x] 6.1 `POST /api/v1/maintenance/instruments/:instrumentRecordId/certificates/:certificateId/void` with body `{ void_reason }` and `POST /api/v1/maintenance/instruments/:instrumentRecordId/certificates/:certificateId/supersede` with the corrected certificate body (same fields as the 7.5 record route plus `supersede_reason`), both exported as `base` + `requireRole({ module: 'maintenance', functionScope: 'write' })` (NEVER a role literal; `test/unit/no-hardcoded-role-in-workflow.test.ts` enforces).
  - [x] 6.2 Handler idiom: `actorContext(req)`, `auditCtxFor(req, actor, httpStatus)`, `idempotencyKeyFrom`, unlocked pre-checks as UX fast-fail ONLY (the seam's locked lookups are authoritative; 7.9 BSD-4), `persistEvent` with `stream_id = certificate_id` (void) or the minted corrected `certificate_id` (supersede), `replayIdOrReject` with the stream_id check. Void returns 200 with the read-back row including `voided_at`/`void_reason`/`voided_by` and the reactivation outcome (amend semantics, 7.9 precedent); supersede returns 201 with the read-back corrected certificate (create semantics). NO handler pre-check that a legitimate replay would trip into 409 (7.5 review lesson 12).
  - [x] 6.3 Register both routes in `src/server.ts` after the Story 7.5 calibration block (:1033-1061), static segments before parameter segments. Add both to `allowedSpineRoutes` in `test/integration/story-1-9.test.ts:171` under a Story 7.10 comment.
  - [x] 6.4 Join the file's `AUDITED_REJECTIONS` set and call `auditRejectedAttempt` for the business rejections (quality.ts:236-281 pattern).

- [x] Task 7: Read surface (AC: 1)
  - [x] 7.1 The existing `GET /api/v1/maintenance/instruments/:instrumentRecordId/certificates` list endpoint must serialize the new columns (`voided_at`, `void_reason`, `voided_by`, `superseded_as_correction`) and accept `?status=voided`. No new GET route.
  - [x] 7.2 `listCalibrationAlerts` keeps returning alerts fired for now-voided/superseded certificates (audit history; Binding Decision 7). Assert this in tests.

- [x] Task 8: Error-code surfaces (AC: 1, 2, 4)
  - [x] 8.1 New stable codes: `CERTIFICATE_NOT_FOUND` (404), `CERTIFICATE_NOT_VOIDABLE` (409), `CERTIFICATE_NOT_SUPERSEDABLE` (409), `CERTIFICATE_RECORDER_CANNOT_CORRECT` (403). Reused: `APPROVAL_REQUIRED` (403), `APPROVAL_UNRESOLVED` (404), `INVALID_PARAMS` (400), `CALIBRATION_DERIVATION_MISMATCH` (409), `CERTIFICATE_ALREADY_RECORDED` (409), `CERTIFICATE_EXPIRED` (422).
  - [x] 8.2 Twin the permanent codes into `src/sync/upload.ts` PERMANENT_ERROR_CODES (:18), `edge/src/sync/connector.ts` (:34, identical block), and `edge/src/messages/en.json` `errors.*`; `test/unit/edge-permanent-error-parity.test.ts` must pass.
  - [x] 8.3 New events are automatically central-only at the edge door (`assertEdgeMaintenanceEventAllowed`, src/sync/upload.ts:436-445). Add an explicit test that an edge upload of the void event rejects 403 `CENTRAL_ONLY_OPERATION`.

- [x] Task 9: Tests - `test/integration/story-7-10.test.ts` (AC: 1, 2, 3, 4)
  - [x] 9.1 Bootstrap exactly like `test/integration/story-7-9.test.ts` (:248-303): full canonical SQL list in `before()`, audit triggers disabled around TRUNCATE, `createAppServer(createAppRouter())`, SCIM + dev-token users (recorder with maintenance write; QC authority user holding the seeded DOA entry; outsider users for the RBAC triad).
  - [x] 9.2 AC1: void the active certificate of an instrument that has a renewal-superseded, still date-valid predecessor; assert the void event persisted, the voided row reads back with reason/actor, the predecessor is `active` again, status is `calibrated`, and `reactivated_certificate_id` is on the payload. Void a superseded (non-active) certificate; assert no status change.
  - [x] 9.3 AC2: supersede the active certificate with a corrected one carrying the SAME certificate_number and an earlier valid_until; assert one transaction outcome (original `superseded` with `superseded_as_correction=true`, corrected row `active`), fresh alert grain (new certificate_id), and run the calibration scan (`runCalibrationExpiryScan`) to prove the corrected dates drive the next stage flags (7.9 review lesson: scan-after-amend test).
  - [x] 9.4 AC3: void the instrument's only certificate; assert status `out_of_calibration`, a `qc.result_recorded` synthetic event on that instrument rejects 423 `CALIBRATION_LOCKOUT` (end-to-end gate proof, not just a row read), and `PUT /api/v1/instruments/:id/calibration-status` to `calibrated` still returns 423. Byte-identical before/after negative-property assertions (7.5 review lesson 14).
  - [x] 9.5 AC4: recorder voiding their own certificate rejects 403 `CERTIFICATE_RECORDER_CANNOT_CORRECT` on BOTH routes (even when the recorder also holds the DOA band); a non-holder rejects 403 `APPROVAL_REQUIRED`; no DOA entry rejects 404 `APPROVAL_UNRESOLVED`; the DOA holder (not the recorder) succeeds. Exercise the same legs via direct `persistEvent(... as any)` to prove the seam owns them (the 13.2/13.3 twin pattern).
  - [x] 9.6 Direct-event doors: forged void with mismatched `instrument_id` rejects 409 `CALIBRATION_DERIVATION_MISMATCH`; forged `voided_by` disagrees with the envelope actor rejects; forged `reactivated_certificate_id`/`resulting_calibration_status` in the payload rejects or is re-derived (shape assert refuses caller-owned derived fields); edge upload rejects 403 `CENTRAL_ONLY_OPERATION`.
  - [x] 9.7 Replay and concurrency: same-key replay of void returns the original event with the ledger unchanged (`alreadyPersisted` before state checks); a second void with a fresh key rejects 409 `CERTIFICATE_NOT_VOIDABLE`; two concurrent voids of the SAME certificate produce exactly one success; two concurrent correction-supersedes racing the SAME certificate_number produce `[201, 409 CERTIFICATE_ALREADY_RECORDED]` (7.5 review lesson 11: race the same key, not distinct keys).
  - [x] 9.8 Boundary tests: `void_reason` blank/whitespace/over-length rejects 400; impossible dates on the supersede path reject through the shared `isValidCalendarDate` (src/lib/business-days.ts), never an unmapped 22008 500; `valid_until` before business_date on the corrected certificate rejects 422 `CERTIFICATE_EXPIRED` (7.5 rule reused).
  - [x] 9.9 RBAC triad 401 anonymous / 403 outsider module / 403 read-scope on both routes (story-7-9.test.ts:684-702 pattern).
  - [x] 9.10 Regression: story-7-5 suite green unchanged (its duplicate-number test at story-7-5.test.ts:1249-1256 races an ACTIVE original, so the partial-unique widening must not break it); story-1-9 spine gate 6/6; story-7-9 suite green.

- [x] Task 10: Close the deferral (AC: 1)
  - [x] 10.1 Mark deferred-work.md row 343 RESOLVED by this story (the Story 7.9 precedent at row 326).
  - [x] 10.2 Record any out-of-scope discoveries as new deferred-work rows rather than building them (7.9 BSD-7).

## Dev Notes

### Binding Scope Decisions

1. **The AC4 "QC manager role" does not exist in code.** Grep across `src/`, `edge/`, `deploy/`, `docs/`, `_bmad-output/`: zero `qc_manager` matches; the term appears only in the epics.md Story 7.10 text. Void/supersede authority is therefore DOA-resolved (Binding Decision 1 of Task 5), never a role literal: two new transaction types `maintenance.calibration_certificate_void` / `maintenance.calibration_certificate_supersede` resolved through `findFirstActiveDoaEntry` + `isActiveRoleHolderForEntry`, fail-closed `APPROVAL_UNRESOLVED` / `APPROVAL_REQUIRED`. The pilot provisioning seeds both bands to `qc_head` (the existing, provisioned highest QC authority). This mirrors `maintenance.return_to_service` (7.6) and `maintenance.warranty_override` (7.7). The certificate route's module gate stays `maintenance:write` like every sibling; the DOA gate is the real authority. Operational prerequisite: the DOA bands must be seeded per site before go-live, and the QC-manager role must hold `maintenance:write` at that site.
2. **SOD-07 leg is per-certificate actor identity**: the actor must not equal the locked row's `recorded_by` (captured from the recording actor at calibration-register.ts:616), enforced in the handler AND re-derived in the applier from `envelope.metadata.actor.user_id` (the Story 13.2/13.3 twin pattern; 13.3's "two-people rule" is the direct precedent). No `SEGREGATED_ROLE_PAIRS` provisioning entry: recorder and corrector may share a role legitimately.
3. **Void is a new event and a new certificate status, never an edit.** `maintenance.calibration_certificate_voided` on the `maintenance` stream, `requiresBusinessStream: false`, stream_id = certificate_id, central-only by construction (edge door auto-refuses). Certificate status CHECK widened with `'voided'`; rows keep `voided_at`/`void_reason`/`voided_by` so the voided row stays readable (AC 1). Certificates remain append-only history.
4. **Lockout re-evaluation reactivates the most recent remaining valid certificate** (AC 1): the latest `superseded`, non-correction, date-valid (`valid_until >= business_date` in SQL) certificate returns to `active`; otherwise the instrument flips `out_of_calibration` through `setCalibrationStatusFromRegister` as the FINAL DB call (Locking Contract: register row, then certificate rows, then status LAST; calibration-register.ts:51-56). Voiding a non-active certificate changes no status. AC 3 falls out by construction: with nothing to reactivate, the lockout applies immediately, and the 7.5 closure keeps `PUT calibration-status` to `calibrated` at 423 for every role.
5. **Correction-supersede rides the EXISTING recorded event with optional fields** (`supersedes_certificate_id`, `supersede_reason`), branched in the applier - the Story 9.6 "one event, three branches" precedent. When absent, Story 7.5 behavior is byte-for-byte unchanged. When present: the target must be the instrument's CURRENT active certificate, the DOA + SOD gates apply, and the original is marked superseded with `superseded_as_correction = true` in the same transaction (supersede FIRST, then insert, so the partial unique index is never transiently violated - the applyCertificateRecorded :599-604 / applyLabelVersionApproved :644-662 idiom). Correction-superseded rows are NEVER reactivation candidates (they were corrected away; reactivating one would resurrect the wrong data this story exists to kill). Renewal-superseded rows (flag false) remain candidates.
6. **Certificate-number uniqueness widened to partial (`status = 'active'`)** so a correction can carry the SAME physical certificate number (the number is usually right; the date is wrong). The story-7-5 duplicate test (story-7-5.test.ts:1249-1256) races an ACTIVE original and stays green; no 7.5 test re-records a superseded number (renewal test uses distinct REN-1/REN-2). `getCertificateByNumber` becomes active-preferring. The existing 23505 arm keeps mapping to 409 `CERTIFICATE_ALREADY_RECORDED`.
7. **Alert schedule recompute is by construction** (AC 2): the corrected certificate is a NEW `certificate_id`, so the `(certificate_id, stage_days)` grain earns a fresh 30/14/7 stage set on the next scan; the superseded/voided certificate leaves `status = 'active'`, so `listCertificateStagesDue`/`listCertificatesExpiredAt` exclude it automatically. Already-fired alert rows are NEVER deleted (audit history). A reactivated certificate keeps its fired rows: fired stages do not refire, due-and-unfired stages fire via the existing catch-up (`<=` stage semantics, calibration-jobs.ts:108-122).
8. **Escalations are untouched.** An open escalation stays open after a void and remains resolvable only by recording a certificate (the existing `applyEscalationResolved` active-certificate rule). A resolved escalation whose `resolving_certificate_id` is later voided remains as history. The correction path's new active certificate fires the existing auto-resolve arm unchanged.

### Architecture Patterns and Constraints

- **Seam idiom (copy exactly)**: pure shape assert (no DB) + applier with `alreadyPersisted` guard first, `reject()` helper, documented Locking Contract, every derivable field DECLARED and re-derived under `FOR UPDATE` with divergence rejecting 409 `..._DERIVATION_MISMATCH` (calibration-register.ts:51-61, 156-163, 169-217, 382-441). Server-captured payload fields follow the 8.7 `approved_by`/`doa_entry_id` pattern (schema.ts:4593-4601): declared, server-written, caller copies rejected.
- **Write-back idiom**: applier writes server-derived values onto `envelope.payload` BEFORE the `domain_events` insert so the event log IS the history (maintenance-spares.ts:492-531). No new history table, no new GET endpoint beyond the existing list serialization.
- **Event registration**: tail-append to `SUPPORTED_EVENT_TYPES`; wire the new type into BOTH seam switches and `STREAM_ID_FIELD`; `src/events/store.ts` hooks already exist (`assertCalibrationRegisterShape` at store.ts:836, `applyCalibrationRegisterProjection` at store.ts:1250).
- **Mutate-in-place route convention** (7.9): `stream_id` = the existing row's id for void (200 response); create semantics (201) only for the corrected certificate. `replayIdOrReject` with the stream_id check. No handler pre-check that a legitimate replay trips (7.5 review lesson 12).
- **Lock order is load-bearing**: two real AB-BA deadlocks (40P01) were fixed in this exact seam by reordering (7.5 review). Asset/register row, then certificate rows (active first), then escalation rows, then status LAST via `setCalibrationStatusFromRegister`. Never call `ensureInstrumentCalibrationRow` from the seam (its `'calibrated'` default silently unlocks).
- **Date discipline**: calendar fields are `YYYY-MM-DD` round-trip validated (`isIsoDate`, calibration-register.ts:98-107; shared `isValidCalendarDate` in src/lib/business-days.ts); DATE comparisons in SQL, never JS; `toIstCalendarDate` for business_date derivation, never `slice(0,10)` on an ISO string (project memory `date.timezone_format_local_ymd`).
- **Canonicalization**: `lower()` on every human-entered key in the handler AND the seam (certificate_number is `lower()`-unique; 7.5 review lesson 15).
- **Notification discipline**: void/supersede emit NO notifications today (no requirement); if one is added, emit only when the event was newly persisted (7.5 review lesson 7) and use `emitNotification` after commit, never in-transaction unless the notice is part of the business fact (AD-17, ADR-001).
- **Edge**: new events are central-only automatically; do NOT add them to `EDGE_MAINTENANCE_EVENT_TYPES`.
- **Grants/migrations**: canonical `read/projections/*.sql` + byte-mirror in `deploy/compose/init-db.sql`, each self-sufficient with guarded grant blocks; MIGRATIONS order never changes; migrate twice to prove idempotency; schema-drift EXPECTED pins updated.
- **Spine**: new routes join `allowedSpineRoutes` in test/integration/story-1-9.test.ts; the Story 1.9 "qc_head cannot override the lockout" spine test (story-1-9.test.ts:1005) must stay green.

### Previous Story Intelligence

- **Story 7.9 (amend-in-place template)**: six-task shape (event contract, seam, accessor, route, tests, deferral closure); mutate-in-place `stream_id`; derived values written back onto the payload; row-dependent validation in the applier against the LOCKED row, never a caller-declared copy; 200 for amend, 201 for create; every out-of-scope item logged to deferred-work.md. Its review also warned: add a scan-after-amend test (mirrored here as the scan-after-supersede test in 9.3), and prefer the 7.5 stream_id cross-check over the spare seam's omission.
- **Story 7.5 (the foundation)**: register feeds the EXISTING Story 1.7 gate; `calibrated` iff an `active` certificate exists with `valid_until >= business_date`; exactly one active certificate per instrument enforced by partial unique index, supersede-then-insert in one transaction; recording an already-expired certificate rejects 422 `CERTIFICATE_EXPIRED`; escalation is status-neutral by construction; manual reinstatement of a registered instrument is 423 `CALIBRATION_LOCKOUT`. Deferred rows 344-352 (scheduling, work-order tie-in, per-parameter points, offline capture, PDF storage, `status_event_version` NULL) stay out of scope here.
- **Story 13.2/13.3 (SOD-07 shape)**: actor-conflict check in the route AND the applier, applier trusts only `envelope.metadata.actor.user_id`, shape assert refuses a payload actor that disagrees with the envelope; 13.3 added the "two-people rule" this story mirrors for certificates.
- **Story 9.6 (branched events)**: ONE event type with optional fields switched in the applier beats a parallel event family when the base validations are shared.

### Testing Standards

- New `test/integration/story-7-10.test.ts` bootstrapped like story-7-9.test.ts (canonical SQL list, TRUNCATE with audit triggers disabled, `createAppServer(createAppRouter())`, SCIM + dev-token users).
- Every guard rejection is asserted BOTH via the route (status + `error_code`) AND via direct `persistEvent(... as any)` against the seam.
- Concurrency tests race the SAME unique key, never distinct keys (7.5 review lesson 11).
- Replay tests assert the original event returns with the ledger unchanged; `alreadyPersisted` runs before every state check.
- Negative-property ACs (3) assert byte-identical before/after state plus the end-to-end 423 gate proof.
- Gates: `npm run build`, `npm run lint`, `npm run format:check`, migrate twice, `npm test`, `npm run spine-acceptance-contract`, edge unit suite unchanged (no edge code beyond error-code parity + en.json).

### Project Structure Notes

- Backend seam: `src/compliance/calibration-register.ts` (extend; the 1188-line Story 7.5 seam). DO NOT touch `src/compliance/calibration.ts` (51-line Story 1.7 gate).
- Projections: `src/read/projections/instrument_calibration_certificate.ts` (extend), `instrument_calibration.ts` (read-only here), `instrument_calibration_alert.ts` (read-only here).
- Schema: `read/projections/instrument_calibration_certificate.sql` + `deploy/compose/init-db.sql` mirror.
- Events: `src/events/schema.ts` (payload block + registry tail), `src/events/store.ts` (no wiring change; verify 23505 arms).
- Routes: `src/api/v1/maintenance.ts` (handlers beside the 7.5 certificate handlers :2984-3131), `src/server.ts` (registration after :1033-1061).
- Jobs: `src/maintenance/calibration-jobs.ts` (read-only here; the scan already excludes non-active certificates).
- Edge surfaces: `src/sync/upload.ts`, `edge/src/sync/connector.ts`, `edge/src/messages/en.json` (error-code parity only).
- Tests: `test/integration/story-7-10.test.ts` (new), `test/unit/schema-drift.test.ts`, `test/integration/story-1-9.test.ts` (allowlist), `test/unit/edge-permanent-error-parity.test.ts` (parity).

### References

- Epic text: `_bmad-output/planning-artifacts/epics.md` Story 7.10 (:3094-3118) [Source: epics.md#Story 7.10]
- Spine: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` AD-8 (:112-116), AD-9 (:119-122), AD-14 (:148-152), AD-16 (:160-164), AD-17 (:166-170)
- Foundation story: `_bmad-output/implementation-artifacts/7-5-calibration-register-and-non-overridable-lockout.md`
- Amend template: `_bmad-output/implementation-artifacts/7-9-spare-min-max-level-amendment.md`
- Deferred row: `_bmad-output/implementation-artifacts/deferred-work.md` row 343 (:75); sprint ledger line 981 ("Rows 326 and 343: Stories 7.9 and 7.10 created")
- Seam: `src/compliance/calibration-register.ts` (Locking Contract :51-56; event set :65-72; shape assert :169-217; appliers :413-441; `applyCertificateRecorded` :523-664; 23505 resolvers :1078-1188)
- Gate (do not touch): `src/compliance/calibration.ts`; wired at `src/events/store.ts:641`
- Projections: `src/read/projections/instrument_calibration_certificate.ts` (:15, :87-100, :132-154, :162-175, :199-225, :245-287); `src/read/projections/instrument_calibration.ts` (:91-104, :124-168)
- Schema: `read/projections/instrument_calibration_certificate.sql` (:26-46, :59-60, :80-88, :112-120); mirror `deploy/compose/init-db.sql` (:7624-7725)
- Jobs: `src/maintenance/calibration-jobs.ts` (:69-77, :108-122, :123-318)
- Routes: `src/api/v1/maintenance.ts` (:2984-3131 record/list certificates; :1522-1528 reject-reason idiom); `src/server.ts` (:1033-1061)
- SOD precedents: `src/read/projections/doa_registry.ts` (:232, :298, :338); Story 13.2/13.3 twin checks; `src/cli/verify-segregated-roles-core.ts`
- Analogous supersede: `src/api/v1/master-data.ts` `applyLabelVersionApproved` (:570-662); Story 9.7/9.8 credit-note supersede fields (schema.ts:5164-5167, :5291-5292)
- Access matrix: `_bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md` (SOD-07 at :344; calibration register rows at :85, :109)

## Dev Agent Record

### Agent Model Used

Kilo (moonshotai/kimi-k3), 2026-11-21

### Debug Log References

- `node --env-file=.env.test --import tsx src/events/migrate.ts` run twice for idempotency; `test/unit/schema-drift.test.ts` 205/205 after the canonical + init-db mirror edits.
- First story-7-10 run: three test-side failures - corrected cert recorded_by tripped the SOD leg on its own void (fixed with a second qc_head holder fixture), canonicalCertificateNumber lower-cases the SAME-number assertion, and valid_until before calibrated_on hits the route's 400 before the seam's 422 CERTIFICATE_EXPIRED (fixture re-anchored). Re-run: 21/21.
- story-7-9 deadlocked when run in parallel with story-7-5 (both TRUNCATE the same tables); green standalone, and the full `npm test` run (sequential) is 2786/2786.
- ESLint clean; the changed files were prettier-dirty at HEAD already, so no reformatting was introduced.

### Completion Notes List

- Schema: additive `voided_at` / `void_reason` / `voided_by` / `superseded_as_correction` columns (guarded ADD COLUMN), status CHECK widened with 'voided' via the atomic DROP+ADD idiom (bom_line pattern), and the certificate-number index re-created partial `WHERE status = 'active'` (BSD 6) - canonical file mirrored byte-for-byte into deploy/compose/init-db.sql; schema-drift EXPECTED entry gained an indexBodies pin for the partial predicate.
- Event contract: `CalibrationCertificateVoidedPayload` (voided_by SERVER-CAPTURED from the envelope actor per the 8.7 idiom; reactivated_certificate_id / resulting_calibration_status / voided_at SERVER-DERIVED `?: never` write-backs refused by the shape assert) and the optional `supersedes_certificate_id` / `supersede_reason` branch on the recorded payload (BSD 5). SUPPORTED_EVENT_TYPES tail-appended, requiresBusinessStream false.
- Seam: `applyCertificateVoided` (alreadyPersisted first, register-then-certificate lock order, derivation re-checks, DOA band + per-certificate SOD under the lock, reactivation of the latest renewal-superseded date-valid certificate or the FINAL setCalibrationStatusFromRegister write) and the correction branch in `applyCertificateRecorded` (target must be the current active, DOA + SOD, supersede-as-correction flag, same-number exemption, superseded-facts write-back). The duplicate-number check runs before the target check so a same-number correction race rejects CERTIFICATE_ALREADY_RECORDED (7.5 review lesson 11). `resolveCalibrationCorrectionAuthority` resolves the first active DOA entry for 'maintenance.calibration_certificate_void' / 'maintenance.calibration_certificate_supersede' and proves the envelope actor is an active holder (BSD 1) - no `qc_manager` role anywhere.
- Routes: `POST .../certificates/:certificateId/void` (200, mutate-in-place idiom) and `POST .../certificates/:certificateId/supersede` (201, create idiom), maintenance:write gate (never a role literal), AUDITED_REJECTIONS wired through the quality.ts auditRejectedAttempt pattern, handler pre-checks are UX fast-fails only. story-1-9 spine allowlist updated.
- Error surfaces: CERTIFICATE_NOT_FOUND / CERTIFICATE_NOT_VOIDABLE / CERTIFICATE_NOT_SUPERSEDABLE / CERTIFICATE_RECORDER_CANNOT_CORRECT plus the reused calibration codes twinned into src/sync/upload.ts and edge/src/sync/connector.ts PERMANENT sets with edge/src/messages/en.json entries; edge-permanent-error-parity 5/5; an explicit edge-upload test proves 403 CENTRAL_ONLY_OPERATION.
- Deployment note (BSD 1, Production Readiness): seed value-0 DOA entries for `maintenance.calibration_certificate_void` and `maintenance.calibration_certificate_supersede` with the pilot QC authority role per site before go-live, mirroring `maintenance.return_to_service` (7.6) and `maintenance.warranty_override` (7.7). Without them both routes fail closed as 404 APPROVAL_UNRESOLVED by design. The test harness seeds them in before() with role qc_head.
- Deferred-work row 343 in `_bmad-output/implementation-artifacts/deferred-work.md` marked RESOLVED 2026-11-21 by this story.
- Task 5.4 decision (BSD 2): NO `SEGREGATED_ROLE_PAIRS` entry was added for this story. The 13.3 two-people rule here is per-certificate actor identity (the corrector must differ from `recorded_by` on the locked row), not a role pairing - recorder and corrector may legitimately share the qc_head role, so a role-pair SOD row would be wrong. `resolveCalibrationCorrectionAuthority` carries the same rationale as a code comment.
- Review follow-ups (2026-11-21, 7 patches applied): (1) replay anchoring - the void route passes the URL certificateId as `expectedStreamId` to `replayIdOrReject` (production-material idiom) and the supersede route anchors the stored payload's `supersedes_certificate_id` to the URL, so a consumed key against a different certificate's URL is 409 DUPLICATE_EVENT, never a phantom 200/201; (2) self-supersede refused in the pure shape assert (`supersedes_certificate_id !== certificate_id`) before any state check; (3) `business_date` is re-derived from the transaction clock in `applyCertificateVoided` and compared like `voided_by`, closing the backdated-direct-write reactivation hole; (4) `voided_at` is stamped by the database transaction clock inside the UPDATE and read back, never the app wall clock; (5) direct persistEvent twin tests added for the correction branch (SOD, NOT_SUPERSEDABLE, APPROVAL_REQUIRED, APPROVAL_UNRESOLVED) plus the route APPROVAL_REQUIRED leg on supersede and a phantom-200 replay regression test; (6) alert-retention test now covers the voided-certificate half of BSD 7; (7) this note discharges the Task 5.4 documentation requirement.

### File List

- read/projections/instrument_calibration_certificate.sql (modified)
- deploy/compose/init-db.sql (modified)
- test/unit/schema-drift.test.ts (modified)
- src/events/schema.ts (modified)
- src/read/projections/instrument_calibration_certificate.ts (modified)
- src/compliance/calibration-register.ts (modified)
- src/api/v1/maintenance.ts (modified)
- src/server.ts (modified)
- src/sync/upload.ts (modified)
- edge/src/sync/connector.ts (modified)
- edge/src/messages/en.json (modified)
- test/integration/story-7-10.test.ts (new)
- test/integration/story-1-9.test.ts (modified)
- _bmad-output/implementation-artifacts/deferred-work.md (modified)
- _bmad-output/implementation-artifacts/sprint-status.yaml (modified)
- _bmad-output/implementation-artifacts/7-10-calibration-certificate-void-and-supersede.md (modified)

### Change Log

- 2026-11-21: Implemented Story 7.10 (void and correction-supersede). Additive schema with partial-active number index; maintenance.calibration_certificate_voided event and supersedes_certificate_id branch with DOA authority plus per-certificate SOD re-derived under the lock; void/supersede routes with audit-rejection recording; edge permanent-code twins; 21-story test suite green (full suite 2786/2786); deferred-work row 343 closed.
- 2026-11-21: Addressed code review findings - 7 items resolved (replay anchoring on both routes, self-supersede refusal, business_date re-derivation, DB-clock voided_at, direct-door test twins, voided-certificate alert retention, Task 5.4 doc note); story suite 26/26.

### Review Findings

- [x] [Review][Patch] (High) Phantom-200 replay: `replayIdOrReject` on the void/supersede routes validates event_type and payload id but not that the stored event's certificate matches the URL `:certificateId`; a consumed key retried against a different certificate's URL echoes the original event's data as 200/201 [src/api/v1/maintenance.ts, voidCertificateBase/supersedeCertificateBase; sibling expectedStreamId idiom at src/api/v1/production-material.ts:131-141]
- [x] [Review][Patch] (Med) Self-supersede not refused: no `certificate_id !== supersedes_certificate_id` check, so a direct event naming both the same active id passes every seam check and dies on the pkey as a raw 23505-to-500 (the 23505 arms in src/events/store.ts:1811-1828 do not cover the pkey) [src/compliance/calibration-register.ts, applyCertificateRecorded]
- [x] [Review][Patch] (Med) business_date trusted from the payload for reactivation validity: the seam uses the declared `business_date` for `findReactivationCandidate` with no re-derivation, so a backdated direct write can reactivate an already-lapsed certificate; the route also silently discards a client-declared body business_date instead of deriving or rejecting [src/compliance/calibration-register.ts, applyCertificateVoided; src/read/projections/instrument_calibration_certificate.ts, findReactivationCandidate]
- [x] [Review][Patch] (Low) voided_at stamped from the app wall clock, not the transaction clock the schema comment and Task 4.2 promise; plus the handler-stamped business_date and seam-stamped voided_at can straddle an IST midnight [src/compliance/calibration-register.ts, applyCertificateVoided; src/events/schema.ts]
- [x] [Review][Patch] (Med) Missing direct persistEvent twin tests: Test Spec 9.5 requires every guard rejection asserted BOTH via the route AND via direct persistEvent; the correction branch has no direct-event tests at all (SOD, CERTIFICATE_NOT_SUPERSEDABLE, APPROVAL_REQUIRED, APPROVAL_UNRESOLVED route-only), and the route suite never exercises APPROVAL_REQUIRED on the supersede route [test/integration/story-7-10.test.ts]
- [x] [Review][Patch] (Low) Alert-retention assertion covers superseded but not voided certificates (Task 7.2 / BSD 7: fired alert rows must survive a void as audit history) [test/integration/story-7-10.test.ts]
- [x] [Review][Patch] (Low) Dev Agent Record does not document the no-SEGREGATED_ROLE_PAIRS decision as Task 5.4 requires (rationale lives only in a code comment) [this file, Dev Agent Record]

Dismissed after triage (10): authority-after-existence check ordering (Task 4.2 mandates it), void-404 vs supersede-409 for unknown ids (Tasks 4.2/4.4 specify both), `?: never` write-back typing (the 8.7 idiom), audit-set boundary (consistent with quality.ts precedent), partial-index removal of full-history uniqueness (BSD 6), unlocked status read on a history-cleanup void (informational mirror, house lock order), reactivation ordering by valid_until DESC (Task 3.3 mandates it verbatim), duplicate-before-target check ordering (deliberate, Task 9.7's explicit race outcome), response calibration_status from post-commit re-read (house-consistent advisory field, stored payload is the audit record).
