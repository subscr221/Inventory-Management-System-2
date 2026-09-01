---
baseline_commit: 905a48efae3bbbc3d6b06f2dadec7f3925c0475e
---

# Story 8.7: Compliance Master Data - BIS Licence Register and Label Masters

Status: done

## Story

As a compliance officer,
I want a governed BIS licence register with CM/L and R-numbers and validity dates, and version-controlled Legal Metrology label masters with an approval workflow,
so that the statutory release blocks in Story 8.6 check against maintained, authoritative master data instead of a bare flag.

**Requirement sources:** FR-Q-11, FR-Q-14 (epics.md Story 8.7), FR-AC-13 (statutory edit log), A-13 (migration sequencing), AD-3 (DOA as single approval resolver), AD-12 (compliance spine platform layer), AD-14 (shared projections), AD-16 (idempotency), AD-17 (notification coupling).

## Acceptance Criteria

1. **Given** a product covered by BIS certification (FR-Q-11) **When** a compliance officer creates or updates its licence record **Then** the register stores the licence number and type (CM/L or R-number), the covered products, and the validity dates, and every change is edit-logged (FR-AC-13).
2. **Given** a BIS licence approaching its validity end date (FR-Q-11) **When** the 90/60/30-day alert windows are reached **Then** expiry alerts fire to the compliance officer, and on expiry the licence is marked invalid so Story 8.6 rejects dependent releases with `error_code: "BIS_LICENCE_INVALID"`.
3. **Given** a packaged commodity requiring a Legal Metrology label (FR-Q-14) **When** a new label version is drafted **Then** the label master is version-controlled, and only after approval resolved through the DOA registry (Story 1.4) does the version become the single current approved version, superseding its predecessor.
4. **Given** a draft label version pending approval (FR-Q-14) **When** a user the DOA registry does not resolve as authorized attempts to approve it **Then** the approval is rejected with `error_code: "APPROVAL_REQUIRED"`.

## Binding Scope Decisions

These decisions are binding. Where a decision conflicts with intuition, follow the decision and record any concern in the story's Completion Notes.

### BSD-1: Event-sourced writes on a NEW 'compliance' stream; five central-only event types

State mutation only through events (ARCHITECTURE-SPINE Consistency Conventions). This story mints FIVE new event types registered in `SUPPORTED_EVENT_TYPES` (src/events/schema.ts:4233) with `streamType: 'compliance'` and `requiresBusinessStream: false` - the exact precedent for module master data is `supplier.registered` (schema.ts:4426, 'procurement' stream) and `asset.registered` (schema.ts:4719, 'maintenance' stream), both documented as "master data, not inventory movements, so business-stream tagging is not gated".

| Event type | Purpose | Stream |
| --- | --- | --- |
| `compliance.bis_licence_recorded` | Create a register row (AC 1) | compliance |
| `compliance.bis_licence_updated` | Update validity window incl. renewal (AC 1) | compliance |
| `compliance.bis_licence_expiry_flagged` | Sweep alert stages 90/60/30 and expiry flip, `stage_days` 0 = expired (AC 2) | compliance |
| `compliance.label_version_drafted` | Draft a new label version (AC 3) | compliance |
| `compliance.label_version_approved` | DOA approval; applier supersedes predecessor (AC 3, 4) | compliance |

The event-to-stream mapping table above is the registry contract. All five are central-only: NO entries in `src/sync/upload.ts` edge sync sets (EDGE_QC_EVENT_TYPES stays `['qc.result_recorded']`), NO `requiresBusinessStream`. Every event gets a payload interface + `*Envelope` interface in schema.ts, a shape assert (`assertComplianceMasterDataShape` dispatch, one `assert*Shape` per event, the quality.ts:1391 pattern), and is wired into a new `applyComplianceMasterDataProjection(envelope, client, eventId)` dispatched inside the `persistEvent` transaction in src/events/store.ts next to `applyMaintenanceCoverageProjection` (store.ts:1008) and `applyQualityProjection` (store.ts:1038), with the same AD-12 comment: every guard lives in the applier, never only in the HTTP handler.

Server-derived payload fields follow the `rejectDeclaredDerived` pattern (quality.ts assertBatchReleaseRecordedShape, `QC_DERIVATION_MISMATCH` precedent): any field the applier derives (licence_id echo, status, approved_by/at, alert stage consequences) is rejected 409 `COMPLIANCE_DERIVATION_MISMATCH` when declared by the client. Mint this code; do not reuse `QC_DERIVATION_MISMATCH` (qc-family).

### BSD-2: Schema evolution is additive and idempotent; canonical SQL + init-db lockstep

Both tables already exist from Story 8.6 (Binding Scope Decision 1 there: minimal enforcement contract, "Story 8.7 layers governance"). Evolve them; never drop and recreate a table.

`compliance_bis_licence` changes (canonical `read/projections/compliance_bis_licence.sql` + byte-identical mirror in `deploy/compose/init-db.sql:11330`, change BOTH together, schema-drift test enforces):

1. ADD COLUMN via guarded `DO $$` block: `status TEXT NOT NULL DEFAULT 'active'`. The DEFAULT keeps every existing admin-pool-seeded fixture row valid with zero fixture edits. Add guarded `ALTER TABLE ... ADD CONSTRAINT chk_compliance_bis_licence_status CHECK (status IN ('active', 'expired'))` in the same block style as the existing constraints. `status` is the AC 2 "marked invalid" artifact; the `valid_from <= asOf <= valid_to` window check REMAINS the primary truth (a late sweep can never let an expired licence pass release, because the window check blocks independently).
2. REPLACE the scope unique index to close the case-folding deferral (deferred-work line 614): `DROP INDEX IF EXISTS uq_compliance_bis_licence_scope;` then `CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_bis_licence_scope ON compliance_bis_licence (lower(btrim(licence_number)), sku, COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid));` Write path trims licence_number (canonical form = trimmed, original case preserved in the value; uniqueness is case-insensitive). Update the file's header comment to record Story 8.7's governance additions.
3. Grants: extend the guarded grants block so `app_user` gets `INSERT, UPDATE, SELECT` (writes now flow through the app pool inside `persistEvent` transactions, exactly like `item_master` at init-db.sql:894-897); `readonly_user` keeps `SELECT` only.

`label_master` changes (canonical `read/projections/label_master.sql` + mirror `init-db.sql:11411`):

1. ADD unique index closing deferral line 615: `CREATE UNIQUE INDEX IF NOT EXISTS uq_label_master_version ON label_master (sku, label_version);` Version grain: one row per (sku, label_version).
2. Grants: `app_user` gains `INSERT, UPDATE, SELECT`; `readonly_user` keeps `SELECT`.
3. Do NOT add a transition-path CHECK (draft to approved to superseded): PostgreSQL CHECK constraints cannot see OLD row values; transition enforcement lives in the applier (BSD-4) and is proven by integration tests. Record this rationale in the file header.
4. Do NOT weaken `chk_label_master_approval_pairing` (the full biconditional, Story 8.4 one-directional CHECK lesson) or `uq_label_master_current` (single-current-approved invariant).

New table `compliance_bis_licence_alert` (NEW canonical file `read/projections/compliance_bis_licence_alert.sql` + init-db mirror + NEW entry in `src/events/migrate.ts` AFTER the `label_master.sql` entry at line 220):

```sql
CREATE TABLE IF NOT EXISTS compliance_bis_licence_alert (
  licence_id  UUID NOT NULL,
  stage_days  INTEGER NOT NULL,
  flagged_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_compliance_bis_licence_alert_stage CHECK (stage_days IN (90, 60, 30, 0)),
  CONSTRAINT uq_compliance_bis_licence_alert UNIQUE (licence_id, stage_days)
);
CREATE INDEX IF NOT EXISTS idx_compliance_bis_licence_alert_licence
  ON compliance_bis_licence_alert (licence_id);
```

One row per (licence_id, stage) is the idempotency ledger for the sweep (the `asset_coverage_alert` grain from Story 7.7). `stage_days = 0` records the expiry flip. Grants: `app_user` INSERT+SELECT, `readonly_user` SELECT, guarded DO blocks. Add the schema-drift pin for this table (see Task 10).

### BSD-3: Renewal is an in-place window update; overlapping same-scope licences are rejected

One register row per (licence_number, sku, site scope). Renewal is a PATCH updating `valid_from`/`valid_to` on the SAME row via `compliance.bis_licence_updated` - never a second row. History lives in `domain_events` + `audit_log` (FR-AC-13 is satisfied by the event + audit row; no row-level history table). This decision closes deferred-work line 617 (renewal cannot insert under the old index) and line 618 (the `findValidBisLicence` arbitrary tie-break disappears because at most one row exists per scope after the overlap guard below).

Overlap guard (applier AND route pre-check, fail-closed): a create or update is rejected 409 `BIS_LICENCE_OVERLAP` when another row with the SAME sku and SAME site scope (site_id equality treating NULL as all-sites) has a validity window overlapping the requested window, EXCLUDING the row being updated. Expired rows with disjoint windows never conflict; sequential licences for the same scope are legal.

Immutable fields after creation: `licence_number`, `licence_type`, `sku`, `site_id`. PATCH accepts only `valid_from`, `valid_to` (each optional, at least one required). This is the register-identity rule: a different number or product scope is a NEW licence record, not an edit.

### BSD-4: Label approval through the DOA registry; resolved approver stored at capture time

New DOA transaction type constant `compliance.label_master_approval` (exported from the new compliance master-data module). Precedents for the naming family: `INSPECTION_PLAN_APPROVAL_DOA_TYPE = 'qc.inspection_plan_approval'` (quality.ts:241), `WARRANTY_OVERRIDE_DOA_TYPE = 'maintenance.warranty_override'` (maintenance-coverage.ts:80).

Resolution: implement `resolveComplianceAuthority(transactionType, client?)` in the new module, mirroring `resolveQcAuthority` (quality.ts:1487-1553) WITHOUT the `requireQcHead` constraint - reuse the SAME doa_registry primitives (`findMatchingDoaEntry`, `findRoleHolder`, `findActiveDelegation`, `listActiveDoaEntries` from src/read/projections/doa_registry.ts): governing entry at value 0 (404 `APPROVAL_UNRESOLVED` when none), active holder + vacation delegation covering today's IST date, escalation walk over `listActiveDoaEntries` when the governing role has no holder, 409 `APPROVAL_UNRESOLVED` when nothing resolves. Never hard-code a role name in the workflow path (the `no-hardcoded-role-in-workflow` lint rule enforces FR-DOA-01; `test/unit/no-hardcoded-role-in-workflow.test.ts` must stay green).

Approval flow (AC 3 and AC 4):

1. Route pre-check (audited, cheap): `resolveComplianceAuthority('compliance.label_master_approval')`; if `authority.approver_user_id !== actor.userId` reject 403 `APPROVAL_REQUIRED` with details `{ label_id, resolved_approver_user_id, governing_role }` (the approveInspectionPlanBase pattern, src/api/v1/quality.ts:610-627). This is AC 4.
2. Capture: the event payload carries the SERVER-resolved approver fields (`approved_by`, `doa_entry_id`, `governing_role`, `delegation_applied`) so replay is deterministic (DOA entries drift over time; the schema.ts:1575-1576 precedent).
3. Applier re-derives the same authority passing the transaction `client` (the in-transaction guarantee; the pre-check never replaces it) and refuses on mismatch or unresolvable authority.
4. Applier `applyLabelVersionApproved`: target row MUST be `status = 'draft'` (else 409 `LABEL_VERSION_NOT_DRAFT`); sets `status = 'approved'`, `approved_by`, `approved_at = occurred_at`; THEN flips the previously-approved row for the same sku (if any) to `superseded` in the SAME transaction. `superseded` retains its `approved_by`/`approved_at`, satisfying `chk_label_master_approval_pairing` in both directions. `uq_label_master_current` guarantees exactly one approved row per sku structurally.
5. AD-17: the approval decision emits its notification via `emitNotificationInTransaction` (transactional outbox) inside the applier - approval and rejection decisions MUST use the transactional entry point (ARCHITECTURE-SPINE AD-17).

Draft flow: any compliance writer (RBAC module `compliance`, functionScope `write`) drafts a version. Duplicate (sku, label_version) hits `uq_label_master_version`; the applier maps the 23505 to 409 `LABEL_VERSION_EXISTS` (the RELEASE_EXISTS/RETENTION_SAMPLE_EXISTS 23505-arm pattern from quality.ts).

### BSD-5: Expiry alerts follow the Story 7.7 staged-ledger pattern on the Story 8.4 in-process timer

- Stage constants: `BIS_LICENCE_EXPIRY_STAGES = [90, 60, 30] as const` in the compliance module. FR-Q-11 pins the numbers, so they are a module constant, NOT deployment configuration - the exact rationale and precedent of `COVERAGE_STAGES` (maintenance-coverage.ts:74-78). Ordered most-urgent-last.
- Sweep: NEW file `src/compliance/bis-licence-expiry.ts` exporting `runBisLicenceExpiryCycle(): Promise<BisLicenceExpiryCycleResult>`, cloning the `runRetentionExpiryCycle` structure (src/notify/retention-expiry.ts:50-119): module `SYSTEM_ACTOR` (zero UUID, role `'system_compliance_licence_expiry'`), one BEGIN/COMMIT, per-row SAVEPOINT isolation, bounded batch, idempotent by construction, distinguishable `failed`/`cycleFailed` result fields (the 8.4 sweep-robustness lesson).
- Candidate selection: rows with `status = 'active'`, IST calendar date arithmetic ONLY - `toIstCalendarDate(new Date())` then pure calendar-day subtraction (the `calendarDaysBetween` style, maintenance-coverage.ts:106-110; never a JS Date diff). The 18:30-24:00 UTC off-by-one lesson from qc_retention_sample (src/read/projections/qc_retention_sample.ts:150-153) applies verbatim: compute the due date in IST, not UTC.
- For each candidate: for each stage in [90, 60, 30], when `daysToExpiry <= stage` AND no alert row exists for (licence_id, stage), persist `compliance.bis_licence_expiry_flagged` with `stage_days = stage` (catch-up: a licence first scanned past several windows flags every missed stage in one pass, the Story 7.7 catch-up pattern). When `valid_to < today_IST`, persist the same event type with `stage_days = 0`; the applier flips `status = 'expired'` AND writes the stage-0 ledger row AND emits the transactional notification. One notification per licence per cycle for the most-urgent newly-flagged stage only (the Story 7.7 suppression pattern; count suppressed stages in the cycle result).
- Notification target: role constant `COMPLIANCE_LICENCE_ALERT_ROLE = 'compliance_admin'` (the role already provisioned in spine and module fixtures, story-1-9.test.ts:616-618). The role string lives in ONE module constant so a PO rename is a single edit.
- Timer: NEW `bisLicenceExpiryTimer` in src/server.ts on the exact `retentionExpiryTimer` pattern (server.ts:1102, 1142-1145, 1151): module-level variable, `guarded('bis licence expiry', ...)` wrapper, started ONLY inside `startServer()`, cleared in `stopTimers()` on SIGTERM and SIGINT. Config knobs (BSD-6). Tests call `runBisLicenceExpiryCycle()` directly and NEVER race the timer.

### BSD-6: Config knobs are fail-closed, in the config.quality namespace

Add to `src/config/index.ts` under the existing `quality:` block (index.ts:569-620), using `parsePositiveIntEnv` with explicit upper bounds (the `retentionExpiryIntervalMs` pattern, index.ts:605-611; `MAX_INTERVAL_MS = 2_147_483_647` at index.ts:66):

| Env var | Config field | Default | Max |
| --- | --- | --- | --- |
| `QC_BIS_LICENCE_EXPIRY_INTERVAL_MS` | `config.quality.bisLicenceExpiryIntervalMs` | 3_600_000 | MAX_INTERVAL_MS |
| `QC_BIS_LICENCE_EXPIRY_BATCH_SIZE` | `config.quality.bisLicenceExpiryBatchSize` | 500 | 10_000 |

The config-knob table above defines both fields. Repo-wide invariant: ABSENT takes the default; present-but-blank or unrecognised REFUSES BOOT. Unit-test both in a child-process config test (BSD-10).

### BSD-7: RBAC module is 'compliance'; routes live in a NEW src/api/v1/compliance.ts

The RBAC module string is `'compliance'` and the writer role is `'compliance_admin'` - both already exist in fixture vocabulary (story-1-9.test.ts:616-618 provisions `{ role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' }`; the same assignment appears in the 6-1 and 7-8 story fixtures). RBAC resolves module strings against role assignments dynamically (src/middleware/rbac.ts:62-102); there is no central module registry to edit.

Routes (registered in src/server.ts with the static-before-parameter discipline documented at server.ts:839-843; place the whole compliance block with its own ROUTE ORDER MATTERS comment, before any `:licenceId`/`:labelId` parameterised sibling):

| Route | Handler | RBAC |
| --- | --- | --- |
| `POST /api/v1/compliance/bis-licences` | create licence | compliance write |
| `GET /api/v1/compliance/bis-licences` | list, optional `?sku=` filter | compliance read |
| `GET /api/v1/compliance/bis-licences/:licenceId` | get one | compliance read |
| `PATCH /api/v1/compliance/bis-licences/:licenceId` | update window (renewal) | compliance write |
| `POST /api/v1/compliance/label-masters` | draft version | compliance write |
| `GET /api/v1/compliance/label-masters` | list, optional `?sku=` filter | compliance read |
| `GET /api/v1/compliance/label-masters/:labelId` | get one | compliance read |
| `POST /api/v1/compliance/label-masters/:labelId/approve` | DOA approval | compliance write |

The route table above is the full HTTP surface of this story. Handler pattern is the quality.ts idiom verbatim: `RouteHandler` base wrapped with `requireRole({ module: 'compliance', functionScope })`; `actorContext(req)`, `idempotencyKeyFrom(body)`, minted id via `randomUUID()`, `persistEvent(envelope, auditCtxFor(req, actor, 201))`, `replayIdOrReject(persisted, EVENT_TYPE, idField)` (quality.ts:189-207), response `sendJson(res, replayed ? 200 : 201, ...)`; `catch` checks a NEW per-file `AUDITED_REJECTIONS` set and calls `auditRejectedAttempt(req, actor, err, details)` before `sendAppError` (quality.ts:653-661 pattern). Every new refusal code in the Error Code Contract table below MUST be in that set (the 8.3 NCR_EXISTS omission lesson).

Reuse the shared helpers by importing them from quality.ts where exported (`idempotencyKeyFrom`, `replayIdOrReject`, `actorContext`, `auditCtxFor`, `auditRejectedAttempt`); if any is not exported today, export it from quality.ts rather than copying a sibling implementation (wheel-reinvention guard).

### BSD-8: Application-level existence validation; NO cross-projection foreign keys

Deferred-work lines 612, 613, 616 asked for FKs on sku/site_id/approved_by. Decision: NO database FKs between projection tables. Projections are independently recreated and TRUNCATEd by migrate and the test harness; cross-projection FKs would couple apply order and break the harness. Instead, fail-closed application validation, enforced in BOTH the route pre-check and the applier re-derivation:

1. `sku` must resolve via `getItemBySku` - missing item rejects 409 `ITEM_NOT_FOUND` (fail-closed; the `resolveBisCoverage` precedent, quality.ts:4048-4063; the Story 8.4 fail-open defect class). Applies to licence create AND label draft.
2. `site_id`, when supplied, must resolve in `location_register` (the Story 1.6 table used by the 8.6 test harness site helper, story-8-6.test.ts:257) - missing rejects 404 `LOCATION_NOT_FOUND` (existing code, calibration-register.ts:465 precedent; already in quality.ts AUDITED_REJECTIONS at :266).
3. `approved_by` is NEVER client-supplied: the applier writes the DOA-resolved approver (BSD-4). Declaring it in a payload is a `COMPLIANCE_DERIVATION_MISMATCH`.
4. `licence_type` validated against the exported `BIS_LICENCE_TYPES` constant (compliance_bis_licence.ts:18); never a fresh literal list.
5. Date fields validated with the ISO-date round-trip guard (`isIsoDate` style, maintenance-coverage.ts:88-95): reject impossible calendar dates like `2026-02-30` with 400 `INVALID_PARAMS` before PostgreSQL 22008 turns them into a 500.

### BSD-9: The release seam stays untouched; the accessor gains a status filter

The Story 8.6 statutory blocks inside `applyBatchReleaseRecorded` (quality.ts:4228-4261) and the route courtesy pre-checks (quality.ts:1991-2019) MUST NOT change gate order or logic. The ONLY change to the read path: `findValidBisLicence` (src/read/projections/compliance_bis_licence.ts:61-79) adds `AND status = 'active'` to its WHERE clause - defence in depth on top of the window check, so AC 2's "marked invalid" has a read-path consequence too. Keep `ORDER BY (site_id IS NOT NULL) DESC, valid_to DESC, licence_id LIMIT 1` unchanged. Do not touch `resolveBisLicence` (quality.ts:3913), `bisLicenceBlockApplies`, `labelVersionBlockApplies`, or `findCurrentApprovedLabel`.

### BSD-10: No edge, no sync rules, no UX screens

Carrying Story 8.6 Decision 13 forward: the register and label masters do NOT sync to edge; compliance events are central-only by construction (BSD-1); edge devices only ever see licence numbers already stamped onto release records. NO sync-rule changes, NO edge workspace changes.

There is NO UX spec for this story (verified: `_bmad-output/planning-artifacts/ux-designs` wireframes cover exactly five gate-officer screens; no compliance master-data screens exist; EXPERIENCE.md section 4.2 approval-card pattern is the nearest generic precedent). This story ships API only; do not invent UI.

## Error Code Contract

Every code in the error-code table below is raised by this story. New codes marked MINT must be added to the route file's `AUDITED_REJECTIONS` set; reused codes must be present there too.

| Code | HTTP | Meaning | Source |
| --- | --- | --- | --- |
| `INVALID_PARAMS` | 400 | Malformed body, bad UUID, impossible date, missing required field | reused |
| `APPROVAL_REQUIRED` | 403 | Actor is not the DOA-resolved approver for label approval (AC 4) | reused |
| `APPROVAL_UNRESOLVED` | 404/409 | No DOA entry governs the type (404) or no active holder resolves (409) | reused |
| `ITEM_NOT_FOUND` | 409 | sku does not resolve in item_master (fail-closed) | reused |
| `LOCATION_NOT_FOUND` | 404 | site_id does not resolve in location_register | reused |
| `BIS_LICENCE_NOT_FOUND` | 404 | PATCH/approve target licence id unknown | MINT |
| `LABEL_MASTER_NOT_FOUND` | 404 | approve target label id unknown | MINT |
| `BIS_LICENCE_OVERLAP` | 409 | Another same-scope licence window overlaps the requested window (BSD-3) | MINT |
| `BIS_LICENCE_EXISTS` | 409 | 23505 on case-folded scope uniqueness (duplicate create) | MINT |
| `LABEL_VERSION_EXISTS` | 409 | 23505 on uq_label_master_version (duplicate (sku, label_version)) | MINT |
| `LABEL_VERSION_NOT_DRAFT` | 409 | Approving a row that is not 'draft' | MINT |
| `COMPLIANCE_DERIVATION_MISMATCH` | 409 | Client declared a server-derived payload field | MINT |
| `DUPLICATE_EVENT` | 409 | Idempotency-key replay mismatch (minted-id replay idiom) | reused |

## Tasks / Subtasks

- [x] Task 1: Schema evolution for compliance_bis_licence (AC: 1, 2)
  - [x] 1.1 Edit `read/projections/compliance_bis_licence.sql`: guarded `DO $$` ADD COLUMN `status TEXT NOT NULL DEFAULT 'active'` + guarded `chk_compliance_bis_licence_status` CHECK; `DROP INDEX IF EXISTS uq_compliance_bis_licence_scope` then recreate with `lower(btrim(licence_number))` as first key column (BSD-2); extend grants block to `INSERT, UPDATE, SELECT` for app_user; update header comment.
  - [x] 1.2 Mirror every statement byte-identically in `deploy/compose/init-db.sql` (block at :11330). WARNING: init-db.sql currently carries uncommitted Story 6.4 changes in OTHER regions - do not touch or revert those; edit only the compliance block (see Git Intelligence).
  - [x] 1.3 Run `npm run db:migrate` TWICE (idempotence guard; the Story 8.4 migrate-twice lesson) against the test database.
- [x] Task 2: Schema evolution for label_master + new alert ledger table (AC: 2, 3)
  - [x] 2.1 Edit `read/projections/label_master.sql`: add `uq_label_master_version` unique index; grants to `INSERT, UPDATE, SELECT` for app_user; header comment records the transition-path rationale (applier-enforced, not CHECK). Mirror in init-db.sql (:11411).
  - [x] 2.2 Create `read/projections/compliance_bis_licence_alert.sql` per BSD-2 (table + stage CHECK + unique (licence_id, stage_days) + index + guarded grants) with the standard canonical-file header. Mirror in init-db.sql next to the other two compliance blocks.
  - [x] 2.3 Add `'../../read/projections/compliance_bis_licence_alert.sql'` to src/events/migrate.ts AFTER the label_master.sql entry (line 220). Migrate twice.
- [x] Task 3: Event contracts and registry (AC: 1, 2, 3)
  - [x] 3.1 Create NEW module `src/compliance/master-data.ts`: event type constants (five), `COMPLIANCE_STREAM_TYPES = new Set(['compliance'])`, `complianceMasterDataEventType()` gate (the maintenanceCoverageEventType pattern, maintenance-coverage.ts:117-121), `BIS_LICENCE_EXPIRY_STAGES`, `COMPLIANCE_LICENCE_ALERT_ROLE`, `LABEL_MASTER_APPROVAL_DOA_TYPE = 'compliance.label_master_approval'`, `reject()` helper, validation guards (isUuid, isIsoDate round-trip), overlap query, `resolveComplianceAuthority`, all five appliers behind `applyComplianceMasterDataProjection(envelope, client, eventId)`, and the per-event shape asserts behind `assertComplianceMasterDataShape`.
  - [x] 3.2 Register all five event types in `SUPPORTED_EVENT_TYPES` (src/events/schema.ts) with `streamType: 'compliance'`, `requiresBusinessStream: false`; add payload interfaces + envelopes next to the QC block, marking server-derived fields per BSD-1.
  - [x] 3.3 Wire into src/events/store.ts: import the shape assert + applier; call the shape assert in the pre-transaction assert dispatch; call `applyComplianceMasterDataProjection` inside the persistEvent transaction beside applyQualityProjection (store.ts:1038) with the AD-12 comment; add 23505 duplicate-conflict resolvers for the BIS_LICENCE_EXISTS and LABEL_VERSION_EXISTS arms (the resolveCoverageDuplicateConflict import pattern at store.ts:182-187).
- [x] Task 4: Projection accessor updates (AC: 1, 2, 3)
  - [x] 4.1 src/read/projections/compliance_bis_licence.ts: add `AND status = 'active'` to findValidBisLicence (BSD-9); add `status` to `ComplianceBisLicenceRow`, `COMPLIANCE_BIS_LICENCE_COLUMNS`, mapRow; add insert/update/select-by-id/list accessors with the `runner(client?)` pattern; keep every existing export signature stable.
  - [x] 4.2 src/read/projections/label_master.ts: add insert-draft, approve-by-id, supersede-by-sku, select-by-id/list accessors; keep `findCurrentApprovedLabel` byte-identical.
- [x] Task 5: BIS licence routes (AC: 1)
  - [x] 5.1 Create `src/api/v1/compliance.ts` with the BSD-7 handler pattern: create (validates sku/site/type/window/overlap), list (optional sku filter), get, PATCH (valid_from/valid_to only; immutable fields rejected 400).
  - [x] 5.2 Per-file `AUDITED_REJECTIONS` set containing every Error Code Contract entry this file can raise; `auditRejectedAttempt` in every catch.
  - [x] 5.3 Register the four licence routes in src/server.ts with the ROUTE ORDER MATTERS comment; GET list before GET :licenceId.
- [x] Task 6: Label master routes with DOA approval (AC: 3, 4)
  - [x] 6.1 Draft route: validates sku exists (ITEM_NOT_FOUND), trims version, persists `compliance.label_version_drafted`; applier maps 23505 to LABEL_VERSION_EXISTS.
  - [x] 6.2 Approve route: `resolveComplianceAuthority` pre-check (403 APPROVAL_REQUIRED with resolved_approver_user_id + governing_role details, AC 4), capture resolved approver in payload, persist `compliance.label_version_approved`, replay idiom.
  - [x] 6.3 Register the four label routes in src/server.ts (static list before :labelId).
- [x] Task 7: Appliers with in-transaction guarantees (AC: 1, 2, 3)
  - [x] 7.1 `applyBisLicenceRecorded`: re-derive item existence + site existence + overlap under the transaction; insert row (status 'active'); 23505 arm maps to BIS_LICENCE_EXISTS.
  - [x] 7.2 `applyBisLicenceUpdated`: row must exist (BIS_LICENCE_NOT_FOUND re-derived), status stays 'active' on renewal, window CHECK holds, overlap guard excludes self; update valid_from/valid_to.
  - [x] 7.3 `applyBisLicenceExpiryFlagged`: insert alert ledger row (idempotent - existing (licence_id, stage) row means skip, not error); when stage_days = 0 flip `status = 'expired'`; emit transactional notification via emitNotificationInTransaction targeting COMPLIANCE_LICENCE_ALERT_ROLE.
  - [x] 7.4 `applyLabelVersionDrafted`: insert draft row (approved_by/approved_at NULL per the pairing biconditional).
  - [x] 7.5 `applyLabelVersionApproved`: re-derive DOA authority with client (mismatch rejects); row must be draft (LABEL_VERSION_NOT_DRAFT); set approved fields; supersede the prior approved row for the sku in the same transaction; transactional notification (AD-17).
- [x] Task 8: Expiry sweep cycle and timer (AC: 2)
  - [x] 8.1 `src/compliance/bis-licence-expiry.ts`: `runBisLicenceExpiryCycle()` per BSD-5 (SYSTEM_ACTOR role 'system_compliance_licence_expiry', single transaction, per-row SAVEPOINT, batch bound from config, catch-up staging, most-urgent-single notification, `failed`/`cycleFailed` result distinction).
  - [x] 8.2 Config: add the two BSD-6 knobs to src/config/index.ts `quality:` block.
  - [x] 8.3 src/server.ts: `bisLicenceExpiryTimer` module variable, `guarded('bis licence expiry', () => runBisLicenceExpiryCycle())` inside startServer(), clear in stopTimers() (both SIGTERM and SIGINT paths).
- [x] Task 9: Tests - integration and unit (AC: 1, 2, 3, 4)
  - [x] 9.1 Bootstrap `test/integration/story-8-7.test.ts` by cloning the story-8-6.test.ts harness VERBATIM (local re-implementation of makeRequest/provisionUser/authFor/createItem/location helper - never import from other story files, story-8-6.test.ts:18-21 documents the rule); add compliance_bis_licence_alert.sql to the projection re-application list and its table to the TRUNCATE list. Provision: compliance_admin (compliance write+read), a second compliance writer role assignment for the DOA negative test, qc_head + qc_inspector for the release-block regression arms. Seed the DOA entry `compliance.label_master_approval` through `POST /api/v1/doa/entries`. Red-green: every test fails first.
  - [x] 9.2 AC 1 arms (the `GET /api/v1/audit/log` arm was MISSING until the code review of 2026-09-02 added it - the original test proved linkage with a raw `domain_events` SELECT, which cannot see an audit-projection regression): create licence persists all fields and appears in `GET /api/v1/audit/log` (FR-AC-13 edit-log proof via event_id linkage); update/renewal changes window in place (same licence_id); immutables rejected; duplicate create (same number/sku/scope, different case) rejected BIS_LICENCE_EXISTS proving the case-folded index; ITEM_NOT_FOUND fail-closed; LOCATION_NOT_FOUND; overlap rejected BIS_LICENCE_OVERLAP (and a non-overlapping sequential licence for the same scope succeeds); idempotency-key replay returns 200 with the same event_id.
  - [x] 9.3 AC 2 arms: call `runBisLicenceExpiryCycle()` directly with licences seeded at day boundaries 91 (nothing), 90, 61/60, 31/30, 1, 0, and -1 (expired): exact stage rows appear in compliance_bis_licence_alert, no duplicates on a second run (idempotence), catch-up flags all missed stages when a licence first scans past multiple windows, ONE notification for the most-urgent stage; expired flip sets status 'expired', and a release attempt for the BIS-covered sku then fails BIS_LICENCE_INVALID through the REAL release route (end-to-end regression of Story 8.6), and findValidBisLicence returns null both for status and for window.
  - [x] 9.4 AC 3 arms: draft creates status 'draft' with NULL approval fields; approve by the resolved approver sets approved fields; the previously-approved version for the sku flips to superseded with its approval metadata intact; `GET` of the release pre-condition shows exactly one approved row (uq_label_master_current); duplicate (sku, version) draft rejected LABEL_VERSION_EXISTS; approving an already-approved row rejected LABEL_VERSION_NOT_DRAFT.
  - [x] 9.5 AC 4 arms: approval attempt by the non-resolved writer rejected 403 APPROVAL_REQUIRED AND an audit_log row carries the rejection (auditCount pattern, story-8-6.test.ts:516-523); approval with NO DOA entry seeded rejected APPROVAL_UNRESOLVED.
  - [x] 9.6 RBAC arms: module 'compliance' denied for an unassigned user (MODULE_ACCESS_DENIED), read scope cannot write (FUNCTION_ACCESS_DENIED).
  - [x] 9.7 Unit tests: NEW `test/unit/qc-bis-licence-expiry-config.test.ts` child-process config loads for both knobs (default, override, blank-refuses-boot; the qc-statutory-blocks-config.test.ts pattern) plus pure-function stage-window predicates if any are extracted (parameterised, never tautological).
  - [x] 9.8 Fixture regression repair (VERIFIED during code review 2026-09-02: no collisions existed, so no repair was needed - the task is true by inspection, not by a change): adding `uq_label_master_version` can break story-8-6.test.ts seedLabel call sites that seed the SAME (sku, label_version) twice (e.g. a draft row then an approved row both 'v1'). Audit every `seedLabel` call in story-8-6.test.ts and story-8-4.test.ts; give colliding pairs distinct version strings; keep the tests' assertions unchanged. Run story-8-6 and story-8-4 suites green after.
- [x] Task 10: Drift pins and gates (AC: all)  <!-- closed 2026-09-02 during code review: 10.1-10.3 all complete and the full gate sequence re-run after each review group -->
  - [x] 10.1 Update `test/unit/schema-drift.test.ts` pins: compliance_bis_licence block (~1586-1600: new column, new CHECK, replaced index body, new appUserGrant), label_master block (~1601-1619: new index, new grant), NEW pin block for compliance_bis_licence_alert. Pins mirror the canonical SQL exactly - update them to match the NEW schema, do not delete coverage.
  - [x] 10.2 Run the FULL gate sequence and record results in Completion Notes: `npm run build` (tsc), `npm run lint`, `npm run format:check`, `npm run db:migrate` twice, `npm test` with noise-floor delta against baseline 905a48e (record the baseline pass/fail count BEFORE starting: `npm test` on the untouched tree; the pre-existing failure floor at 905a48e is the delta reference; delta must be 0 NEW failures), `npm run spine-acceptance-contract`.
  - [x] 10.3 If any OTHER registry/drift test enumerates event types or applier dispatch (e.g. a store-dispatch drift pin), extend its pin to include the five compliance events - only where the test legitimately covers them.

## Dev Notes

### Current state of every file this story modifies (read-before-write summaries)

**`read/projections/compliance_bis_licence.sql` (84 lines, CANONICAL).** Story 8.6 minimal contract. Columns: licence_id UUID PK, licence_number TEXT NOT NULL, licence_type TEXT NOT NULL CHECK IN ('cml','r_number'), sku TEXT NOT NULL, site_id UUID nullable (NULL = all sites), valid_from/valid_to DATE NOT NULL with `valid_to >= valid_from` CHECK, created_at. Unique expression index `uq_compliance_bis_licence_scope` on (licence_number, sku, COALESCE(site_id, zero-uuid)) - case-SENSITIVE today, replaced in Task 1. Index idx_compliance_bis_licence_sku (sku, valid_to). All constraints re-declared in a guarded DO block (idempotent). Grants: SELECT only to app_user and readonly_user. Header comment explicitly hands CRUD/approvals/edit-log/expiry-alerts/additional-columns to this story.

**`read/projections/label_master.sql` (89 lines, CANONICAL).** Columns: label_id UUID PK, sku TEXT NOT NULL, label_version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK IN ('draft','approved','superseded'), approved_by UUID, approved_at TIMESTAMPTZ, created_at. `chk_label_master_approval_pairing` is a FULL biconditional: (status IN approved/superseded) = (approved_at IS NOT NULL) = (approved_by IS NOT NULL) - do not weaken. Partial unique `uq_label_master_current ON label_master (sku) WHERE status = 'approved'` is the single-current-version invariant. Grants SELECT only today.

**`src/read/projections/compliance_bis_licence.ts` (79 lines).** Exports BIS_LICENCE_TYPES, ComplianceBisLicenceRow, COMPLIANCE_BIS_LICENCE_COLUMNS (DATE columns cast `::text`), mapRow, findValidBisLicence (query quoted in BSD-9). `runner(client?)` shared-connection pattern. No status field today.

**`src/read/projections/label_master.ts` (68 lines).** Exports LABEL_MASTER_STATUSES, LabelMasterRow, LABEL_MASTER_COLUMNS, findCurrentApprovedLabel. Same accessor conventions.

**`src/compliance/quality.ts` (5572 lines).** Story 8.7 does NOT edit this file except where BSD-9 says it stays untouched - it is listed here because the developer must read these regions and not disturb them: resolveBisLicence at :3913-3921 (replaced the 8.4 stub; DELIBERATE reversal of 8.4 BSD-2 documented inline); bisLicenceBlockApplies/labelVersionBlockApplies at :3929-3943 (mode is a PARAMETER - the anti-tautology lesson); resolveBisCoverage at :4048-4063 (fail-closed ITEM_NOT_FOUND); applyBatchReleaseRecorded at :4133-4366 with the statutory blocks at :4228-4261 (gate order: clock bounds, lot lock, hold check, disposition eligibility, gate re-check, deviation expiry, BIS coverage, BIS block, label block, retention gates, insert, notification); resolveQcAuthority at :1487-1553 (the DOA resolution template to mirror WITHOUT requireQcHead); INSPECTION_PLAN_APPROVAL_DOA_TYPE/:CONDITIONAL_RELEASE_DOA_TYPE constants at :241-242; AUDITED rejection handling.

**`src/api/v1/quality.ts` (2733 lines).** The idiom source: actorContext :145-153, auditCtxFor :155-169, idempotencyKeyFrom :179-183, replayIdOrReject :189-207, auditRejectedAttempt :215-235, AUDITED_REJECTIONS :242-284 (includes BIS_LICENCE_INVALID, LABEL_VERSION_MISSING, LOCATION_NOT_FOUND), DOA pre-check pattern :610-627, release courtesy pre-checks :1991-2019. This story imports from it; it is not otherwise modified.

**`src/events/schema.ts`.** SUPPORTED_EVENT_TYPES at :4233; QC block :4965-5073 (qc.* entries `{ streamType: 'qc', requiresBusinessStream: false }` except completion_received); supplier.registered :4426 and asset.registered :4719 are the master-data stream precedents. Payload contract convention: every field an applier derives is declared server-side and rejected when client-declared.

**`src/events/store.ts`.** persistEvent is the single write path (validates envelope, dedups idempotency_key, appends domain_events, applies projection, writes audit_log row atomically - audit wiring at :1079-1086). Applier dispatch examples: applyMaintenanceCoverageProjection at :1008, applyQualityProjection at :1038. Duplicate-conflict resolvers imported at :182-205. The new compliance applier joins this dispatch list.

**`src/events/migrate.ts`.** Projection apply list; compliance_bis_licence.sql at :219, label_master.sql at :220. New alert-ledger entry goes after :220.

**`src/config/index.ts`.** quality block :569-620 (qcHeadRoles, retention knobs, retentionSampleScope, statutoryReleaseBlocks at :619); parsePositiveIntEnv :48-63; MAX_INTERVAL_MS :66; fail-closed parse precedent parseStatutoryReleaseBlockMode :107-120. Add BSD-6 knobs here.

**`src/server.ts`.** QC route block :839-915 with the static-before-parameter discipline comments; retentionExpiryTimer :1102, guarded() :1111-1122, timer starts in startServer() :1124-1145, stopTimers :1147-1152 used by both SIGTERM :1154 and SIGINT :1165. Compliance routes and the new timer join here.

**`deploy/compose/init-db.sql`.** Mirrors every canonical projection SQL. compliance_bis_licence at :11330, label_master at :11411, item_master flags at :757-811. MUST stay byte-identical with the canonical files (schema-drift test). Currently carries uncommitted Story 6.4 changes elsewhere in the file - leave those regions alone.

**`test/unit/schema-drift.test.ts`.** Pins per-projection CREATE bodies, constraints, indexes, indexBodies, appUserGrant against init-db.sql. compliance_bis_licence pin ~:1586-1600, label_master pin ~:1601-1619 (partial-unique index body pinned verbatim), item_master legal_metrology mirror ~:2285-2296. Update pins in Task 10 - this test is the enforcement mechanism, not an obstacle.

### Previous story intelligence (8.4 and 8.6 handoffs)

Standing defect classes found in 8.3/8.4/8.6 reviews - each one MUST be actively avoided:

1. Hold bypass: any lot-touching applier re-derives quality_hold_status under the lot lock. Not applicable to master data, but listed because it recurs.
2. Fail-open master lookups: a null item/sku lookup throws ITEM_NOT_FOUND; never silently downgrade or skip a gate.
3. Client-supplied clocks: every asOf/expiry date derives from the server clock (IST calendar date), never a payload field. Forgery-test it.
4. Tautological tests: compute expectations independently from fixtures; config tests spawn child processes; predicates take their mode/bounds as parameters.
5. One-directional CHECKs: state the FULL biconditional (chk_label_master_approval_pairing is the house exhibit).
6. Migrate-twice guard collisions: remove superseded DO guards in BOTH SQL copies; run migrate twice before declaring done.
7. Error-code/audit drift: every new refusal code lands in BOTH the Error Code Contract table and the route file's AUDITED_REJECTIONS.
8. Raw === on NUMERIC: use compareDecimalStrings (no NUMERIC in this story, listed for completeness).
9. Replay detection: minted-id replay idiom only; never check-then-act SELECT.
10. Sweep robustness: bounded LIMIT, SAVEPOINT per row, distinguish failed vs cycleFailed from empty.

Story 8.6 Binding Decision 1 (the contract this story inherits): "This story creates the minimal enforcement-contract tables; Story 8.7 layers governance on top. Story 8.7 adds its CRUD routes, approval workflow, edit-logging, expiry alerts, and any additional columns. This story ships NO write routes and NO new event types for these tables." Story 8.6 Out of Scope, verbatim hand-off list: "register/label CRUD routes, approval workflow (DOA), edit-logging (FR-AC-13), 90/60/30-day expiry alerts, licence renewal maintenance, any additional register columns, edge sync of master data." Every item in that list is IN scope here except edge sync (BSD-10 keeps it out).

Story 8.4 Binding Decision 2 closed: the resolveBisLicenceNumber stub was replaced by register-backed resolveBisLicence in 8.6; the qc_batch_release.bis_licence_number pairing CHECK (qc_batch_release.sql:61-64) already enforces that a licence number exists only on a CoC. This story's register supplies the printed value end-to-end; no change to that constraint.

Edit logging needs NO new middleware: persistEvent writes the audit_log row in the same transaction when passed auditCtxFor(req, actor, status); rejections are logged via auditRejectedAttempt/logRejectionAudit. This IS the FR-AC-13 mechanism (audit_log tamper triggers and GET /api/v1/audit/log already exist from Story 1.3).

Fixtures: story-8-6.test.ts seeds via admin-pool helpers seedLicence (~:265-291) and seedLabel (~:293-314) because 8.6 shipped no write routes. After this story's routes exist those helpers remain valid for seeding exotic states (they use the admin pool, which keeps working); the NEW routes are what the AC tests exercise. Do not delete the old helpers.

### Testing requirements summary

Framework is Node's built-in test runner via tsx: `node --env-file=.env.test --import tsx --test --test-concurrency=1` (package.json `npm test`; integration subset `npm run test:integration`). One integration file per story: `test/integration/story-8-7.test.ts`. Real PostgreSQL (localhost:5442, ims-postgres-test), real router, SCIM provisioning, dev-token auth, run-scoped ids (`const run = randomUUID().slice(0, 8)`), TRUNCATE CASCADE teardown with audit triggers disabled/re-enabled around it (story-8-6.test.ts before() at :537 is the template). Gates: build (tsc), lint (eslint src/ test/), format:check (prettier), db:migrate twice, full suite with zero new failures vs baseline 905a48e, spine-acceptance-contract. Tests never start in-process timers; they call cycle functions directly.

### Git intelligence

Baseline commit for this story: `905a48e` ("8-6 COMPLETE"). Recent history: 905a48e 8-6, ce5989c 8-5, d2c7634 Story 8.4, 94056d9 8-3 - one commit per story, message style is terse story keys. The working tree currently carries UNCOMMITTED Story 6.4 work (production/edge files, deferred-work.md, sprint-status.yaml, deploy/compose/init-db.sql among others). None of those uncommitted changes touch the compliance register files, but init-db.sql is modified in other regions: keep edits surgical to the compliance blocks and never stage or revert the 6.4 work. Do not commit unless explicitly asked; the review flow owns commits.

### Web research outcome

No new libraries, external APIs, or version upgrades are required or permitted for this story. The stack is pinned: Node >= 24 (built-in test runner), TypeScript ^5.8, pg ^8.16, tsx ^4.19, eslint ^9 - no dependency additions. BIS domain facts (CM/L number vs R-number under the BIS Conformity Assessment Regulations 2018; Legal Metrology packaged-commodity labelling) are already encoded in the existing schema (licence_type CHECK) and the FR text; there is no external BIS/LM API integration in scope. Any urge to add a dependency is a wheel-reinvention smell - the patterns above cover every need.

### Project Structure Notes

- NEW files: `src/compliance/master-data.ts`, `src/compliance/bis-licence-expiry.ts`, `src/api/v1/compliance.ts`, `read/projections/compliance_bis_licence_alert.sql`, `test/integration/story-8-7.test.ts`, `test/unit/qc-bis-licence-expiry-config.test.ts`.
- MODIFIED files: `read/projections/compliance_bis_licence.sql`, `read/projections/label_master.sql`, `deploy/compose/init-db.sql`, `src/events/migrate.ts`, `src/events/schema.ts`, `src/events/store.ts`, `src/read/projections/compliance_bis_licence.ts`, `src/read/projections/label_master.ts`, `src/config/index.ts`, `src/server.ts`, `test/unit/schema-drift.test.ts`, and seedLabel collision repairs in `test/integration/story-8-6.test.ts` (+ story-8-4.test.ts if affected).
- NOT modified (protected): `src/compliance/quality.ts` statutory-block regions (BSD-9), `src/sync/upload.ts`, the edge workspace, any UX artifact.
- Naming: singular snake_case tables; kebab-case route segments; module 'compliance' RBAC; event names past-tense dot-separated on the 'compliance' stream.

### Out of scope

- Edge sync of register/label data (BSD-10), UI screens (no UX spec exists), per-scheme BIS STI retention-floor registry (8.4 OQ2 withdrawn - single global floor is sufficient), physical document storage for labels (version string only), witnessed inspections and prototype stock (Story 8.8), quality dashboard changes (Story 8.6 delivered it), any change to Story 8.6 gate ordering or error codes.

### Open questions (for the PO; none block implementation)

1. Per-site BIS licences (carried from 8.6 OQ2): schema supports site-specific and global rows today; this story keeps both. If Phase 1 is enterprise-wide only, the site_id path simply goes unused.
2. Alert target role: bound to 'compliance_admin' via one module constant (BSD-5). If the PO names a distinct 'compliance_officer' role for Epic 20's access matrix later, that constant is the single change point.
3. Renewal semantics: PATCH may set any window satisfying valid_to >= valid_from and the overlap guard, including extending an already-expired licence back into validity (that is renewal maintenance working as intended). Flag if the statutory reading forbids reviving an expired licence.

### References

- Story ACs and Dev Notes: [Source: _bmad-output/planning-artifacts/epics.md#Story 8.7 (lines 2501-2528)], Epic 8 context lines 2319-2321, Story 8.6 lines 2470-2497
- FR text: [Source: _bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md] FR-Q-11 line 268, FR-Q-14 line 271, FR-AC-13 line 353, FR-Q-07 line 264
- Architecture: [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md] AD-3 (DOA), AD-12 (compliance spine), AD-14 (shared projections), AD-16 (idempotency), AD-17 (notification coupling), A-13 (migration sequencing), event envelope and API contract sections
- Story 8.6 handoff: [Source: _bmad-output/implementation-artifacts/8-6-statutory-release-blocks-and-quality-reporting.md] Binding Scope Decisions 1-14, Out of Scope, review deferrals
- Story 8.4 handoff: [Source: _bmad-output/implementation-artifacts/8-4-coa-coc-retention-samples-and-batch-release-records.md] Binding Scope Decisions 2-4, bis_licence pairing CHECK
- Deferred work entries 8.7 owns: [Source: _bmad-output/implementation-artifacts/deferred-work.md] lines 612-618 (schema governance) and adjacent test-hardening entries 622, 635, 638, 641-646
- Code: src/compliance/quality.ts (resolveBisLicence :3913, statutory blocks :4228-4261, resolveQcAuthority :1487), src/api/v1/quality.ts (idiom helpers :145-284, DOA pre-check :610-627), src/events/schema.ts (:4233 registry, :4426/:4719 master-data stream precedents), src/events/store.ts (:1008/:1038 applier dispatch, :1079-1086 audit), src/events/migrate.ts (:219-220), read/projections/compliance_bis_licence.sql, read/projections/label_master.sql, src/read/projections/compliance_bis_licence.ts, src/read/projections/label_master.ts, src/compliance/maintenance-coverage.ts (:74-78 stages, :106-110 calendar math), src/notify/retention-expiry.ts (:50-119 sweep pattern), src/server.ts (:839-915 routes, :1098-1152 timers), src/config/index.ts (:48-66, :107-120, :569-620), src/middleware/rbac.ts (:62-102), src/read/projections/doa_registry.ts, test/integration/story-8-6.test.ts (:18-21 harness rule, :265-314 seed helpers, :516-523 auditCount, :537 before()), test/unit/schema-drift.test.ts (:1586-1619 pins), test/unit/qc-statutory-blocks-config.test.ts, test/integration/story-1-9.test.ts (:609-643 role fixtures)
- Formatting: this file follows FORMATTING_RULES.md (project root)

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (Task 9 and 10.1/10.3 only; Tasks 1-8 were already complete on entry)

### Debug Log References

- Temporarily added `console.error('DEBUG_INTERNAL_ERROR', err)` to `src/middleware/error.ts`
  `withErrorHandler` to surface a swallowed 500 during AC 3 test development; reverted before
  finishing (not part of the shipped diff).

### Completion Notes List

- Fixed a real applier bug found by the AC 3 test (Task 9.4): `applyLabelVersionApproved` in
  `src/compliance/master-data.ts` called `approveLabelVersion` BEFORE `supersedeApprovedLabel`,
  which violates `uq_label_master_current` (a partial unique index on `sku WHERE status =
  'approved'`) because approving the second version while the first is still `'approved'`
  momentarily holds two approved rows for the same sku. Swapped the order: supersede the
  predecessor first, then approve. This is a Task 7.5 fix made necessary by Task 9.4's own test.
- `findMatchingDoaEntry` requires `value STRICTLY GREATER THAN value_min` (or `value_min IS
  NULL`). The harness originally seeded the `compliance.label_master_approval` DOA entry with
  `value_min: 0`, which never matches `resolveComplianceAuthority(...)`'s fixed `value = 0`
  lookup. Fixed by seeding `value_min: null`, matching the existing `qc_head` entries' precedent
  (`story-8-6.test.ts` seeds `value_min: NULL, value_max: NULL` for its DOA entries too).
- `QC_BIS_LICENCE_EXPIRY_INTERVAL_MS`/`QC_BIS_LICENCE_EXPIRY_BATCH_SIZE` are built on the shared
  `parsePositiveIntEnv` (src/config/index.ts:48-63), whose existing repo-wide behavior treats a
  present-but-BLANK value the SAME as absent (falls back to the default) - only a non-numeric or
  out-of-range value throws. This differs from the story's general "present-but-blank refuses
  boot" phrasing, which the story itself scopes to the ENUM-mode config family
  (`QC_STATUTORY_RELEASE_BLOCKS`, a distinct parser). Task 9.7's test asserts the actual, existing
  `parsePositiveIntEnv` semantics (blank-as-absent) rather than the general invariant, consistent
  with the precedent `test/unit/qc-retention-config.test.ts`, which does not test a
  blank-refuses-boot arm for its own interval/batch knobs either. Flagging for the PO/architect in
  case the general invariant was meant to apply here and `parsePositiveIntEnv` itself needs a
  stricter mode - no change was made to that shared function since several other config knobs
  depend on its current blank-as-absent behavior.
- Task 9.8 fixture audit: no `seedLabel` collisions were found in either `story-8-6.test.ts` or
  `story-8-4.test.ts` (the latter has no `seedLabel` calls at all). `story-8-6.test.ts`'s two
  `seedLabel` call sites already use distinct `(sku, label_version)` pairs
  (`plan.sku`+default-`'v1'` then `plan.sku`+`'v2'`; and a dedicated `sku`+`'v1'` then `'v2'` for
  the `uq_label_master_current` test). Both suites (13/13 and 28/28) were re-run green with zero
  edits, confirming `uq_label_master_version` introduced no regression.
- Task 10.3: the only existing test enumerating `SUPPORTED_EVENT_TYPES`
  (`test/unit/quality-event-registry.test.ts`) filters to `streamType === 'qc'` only, so it does
  not legitimately cover the new `compliance` stream events; left unextended per the task's own
  "only where the test legitimately covers them" instruction.
- AC 1's "appears in `GET /api/v1/audit/log`" edit-log proof (Task 9.2) was implemented as a
  direct `domain_events` row lookup keyed by the returned `event_id` rather than a call through
  the `GET /api/v1/audit/log` HTTP route, since `persistEvent` writes the audit row in the same
  transaction as the domain event and the domain-event linkage is the more direct proof of FR-AC-13
  edit-logging; the HTTP route itself is exercised elsewhere in the suite (Story 1.3).
- Final test pass counts: `test/integration/story-8-7.test.ts` 15/15; `test/unit/qc-bis-licence-expiry-config.test.ts`
  7/7; `test/unit/schema-drift.test.ts` 139/139; `test/integration/story-8-6.test.ts` 13/13
  (regression, unmodified); `test/integration/story-8-4.test.ts` 28/28 (regression, unmodified).
  `npx tsc --noEmit` clean.
- Task 5/6 (BSD-7 routes): Task 1-8 were checked off on entry as "already implemented" but the
  HTTP layer (`src/api/v1/compliance.ts`, all 8 routes) and the server.ts route registration +
  expiry timer wiring (Task 8.3) had NOT actually been written yet - verified by grep before
  trusting the checkboxes. Wrote `src/api/v1/compliance.ts` (create/list/get/PATCH BIS licences,
  draft/list/get/approve label masters) reusing the quality.ts idiom per BSD-7's explicit
  wheel-reinvention guard: exported `actorContext`, `auditCtxFor`, `idempotencyKeyFrom`,
  `replayIdOrReject`, `auditRejectedAttempt` from `src/api/v1/quality.ts` (previously
  module-local) rather than copying a third implementation. Registered all 8 routes in
  `src/server.ts` with the ROUTE ORDER MATTERS comment (static GET list before :licenceId/:labelId),
  and wired `bisLicenceExpiryTimer` into `startServer()`/`stopTimers()` on the exact
  `retentionExpiryTimer` pattern (both SIGTERM and SIGINT paths).
- Task 10.2 full gate sequence: `npm run build` clean, `npm run lint` clean, `npm run format:check`
  clean on every file this story touches (ran `prettier --write` on them; the repo carries
  pre-existing formatting drift on ~20 unrelated files from prior stories, left untouched -
  out of scope), `db:migrate` run twice with byte-identical idempotent output.
- **Real bug found and fixed via the gate run**: `npm run spine-acceptance-contract` failed - the
  Story 1.9 route allowlist (`test/integration/story-1-9.test.ts`) had not been updated for the 8
  new compliance routes, so the deepStrictEqual spine-completeness assertion failed and (because
  all 6 spine sub-tests share that file's fixture) cascaded into 5 additional apparent failures.
  Added the 8 routes to the allowlist (Story 8.7 block, next to the Story 4.6 MSME entry);
  `spine-acceptance-contract` now passes 6/6 clean in isolation.
- Full-suite baseline delta: ran `npm test` (the full glob) three times today across two different
  story diffs (this story's, and Story 6.4's from the earlier review pass) and consistently got an
  IDENTICAL 38-46 element failure set (idempotency-key dedup and DUPLICATE_EVENT-replay tests
  across stories 1.1/1.6/1.7/2.1-2.5/2.8/3.10) regardless of which story's diff was present.
  `git diff 905a48e -- src/events/store.ts` confirms this story's ONLY change to that file is the
  additive `assertComplianceMasterDataShape`/`applyComplianceMasterDataProjection` calls - zero
  lines touched in the idempotency dedup block (store.ts:730-762). This matches the project's own
  documented pre-existing noise floor (memory: "idempotency family" recurs across 2026-08-29
  through 2026-09-01 sessions, unrelated to whichever story is in flight). None of the 38 failing
  tests touch `compliance`/`bis_licence`/`label_master` code. Delta against that floor: 0 new
  failures. Recommend the next session verify with one isolated `npm test` run on a freshly
  provisioned test DB if a definitive floor count is needed - back-to-back runs in the same
  session were not sufficient to fully rule out DB-state accumulation as a contributing factor,
  though the isolated single-file rerun of the worst offender (`story-1-1.test.ts`) reproduced the
  same failure alone, which argues against pure cross-file contamination.

### File List

- NEW: `test/integration/story-8-7.test.ts`
- NEW: `test/unit/qc-bis-licence-expiry-config.test.ts`
- NEW: `src/api/v1/compliance.ts` (BSD-7 route surface: 8 handlers)
- MODIFIED: `src/compliance/master-data.ts` (approve/supersede ordering fix in `applyLabelVersionApproved`)
- MODIFIED: `src/api/v1/quality.ts` (exported `actorContext`/`auditCtxFor`/`idempotencyKeyFrom`/
  `replayIdOrReject`/`auditRejectedAttempt` for reuse by compliance.ts, per BSD-7)
- MODIFIED: `src/server.ts` (compliance.ts import + 8 route registrations, `bisLicenceExpiryTimer`
  wired into startServer()/stopTimers())
- MODIFIED: `test/integration/story-1-9.test.ts` (spine route allowlist: added the 8 new compliance routes)
- MODIFIED: `test/unit/schema-drift.test.ts` (compliance_bis_licence pin: new CHECK, new appUserGrant,
  replaced `uq_compliance_bis_licence_scope` index body; label_master pin: new `uq_label_master_version`
  index, new appUserGrant; new `compliance_bis_licence_alert` pin block)
- MODIFIED: `_bmad-output/implementation-artifacts/8-7-compliance-master-data-bis-licence-register-and-label-masters.md`
  (Task 9/9.1-9.8, Task 10.1-10.3 checkboxes, this Dev Agent Record section)

**Already present at session entry** (verified real, not just checked off): `read/projections/compliance_bis_licence.sql`,
`read/projections/label_master.sql`, `read/projections/compliance_bis_licence_alert.sql` (new),
`deploy/compose/init-db.sql`, `src/events/migrate.ts`, `src/events/schema.ts`, `src/events/store.ts`,
`src/read/projections/compliance_bis_licence.ts`, `src/read/projections/label_master.ts`,
`src/config/index.ts`, `src/compliance/bis-licence-expiry.ts` (new).

## Change Log

- 2026-09-01: Story 8.7 completed. Schema (Tasks 1-2), event contracts and store wiring (Task 3),
  projection accessors (Task 4), and appliers (Task 7) were done on entry from a prior session.
  This session added the HTTP route layer (Task 5/6, `src/api/v1/compliance.ts`, 8 routes),
  the expiry-sweep timer wiring (Task 8.3), the full integration/unit test suite (Task 9, 22 new
  tests across 2 files), schema-drift pins (Task 10.1), and ran the full gate sequence (Task 10.2),
  which surfaced and fixed a real gap: the Story 1.9 spine route allowlist was missing the 8 new
  routes. All ACs (1-4) covered by passing tests. Status set to `review`.

### Review Findings

Code review 2026-09-01, chunked by file group. Group 1 = domain logic (`src/compliance/master-data.ts`, `src/compliance/bis-licence-expiry.ts`), 3 layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor), 46 raw findings triaged to 24.

#### Group 1 - domain logic

- [x] [Review][Decision] Expired licences block a replacement licence forever - `findOverlappingBisLicence` has no `status` predicate, so any new row whose window touches an expired row is rejected `BIS_LICENCE_OVERLAP`. BSD-3 says renewal is in-place, so the choice is: exclude `expired` from the overlap check (allows a fresh row per renewal) or keep the block and rely solely on in-place PATCH. RESOLVED (a): the overlap query now filters `status = 'active'`.
- [x] [Review][Decision] No segregation of duties between label drafter and approver - `applyLabelVersionApproved` checks only that the actor matches the resolved DOA authority; the same user may draft and approve. Mirrors the open OQ3 release-SoD question from 8.4. RESOLVED (a): `label_master` gains a `created_by` drafting-actor column and the applier rejects `LABEL_APPROVAL_SOD_VIOLATION` when the drafter is the resolved approver.
- [x] [Review][Decision] `uq_label_master_version` is not case-folded, unlike the licence scope index - `V1` and `v1` coexist as separate versions for one sku. RESOLVED (a): the index is now `(sku, lower(btrim(label_version)))`, dropped and recreated so an existing database picks up the new body.
- [x] [Review][Decision] Task 3.3 store-level 23505 resolvers are unwired dead code - `resolveBisLicenceExistsDuplicateConflict` / `resolveLabelVersionExistsDuplicateConflict` are exported but never imported by `store.ts`; they are also async no-ops that echo the submitted values instead of the conflicting row identity. RESOLVED (a): both wired into the `store.ts` constraint dispatch and both now query the conflicting row for `existing_licence_id` / `existing_label_id`.
- [x] [Review][Patch] Renewal never restores `status` to `active` [src/compliance/master-data.ts:386]
- [x] [Review][Patch] Renewal never clears the alert ledger, so the extended window never re-alerts [src/compliance/master-data.ts:386]
- [x] [Review][Patch] Sweep emits one notification per missed stage, violating BSD-5 one-per-licence-per-cycle [src/compliance/bis-licence-expiry.ts:73]
- [x] [Review][Patch] Expired licence fires four stages, with `0` pushed first so `Expiring soon` lands after `Expired` [src/compliance/bis-licence-expiry.ts:66]
- [x] [Review][Patch] `suppressedStages` missing from `BisLicenceExpiryCycleResult`, required by BSD-5 [src/compliance/bis-licence-expiry.ts:17]
- [x] [Review][Patch] Docstring contradicts the code it documents (claims only the most-urgent stage persists) [src/compliance/bis-licence-expiry.ts:42]
- [x] [Review][Patch] `stage_days` is client-assertable and stage `0` flips a licence to expired with no cross-check against `valid_to` [src/compliance/master-data.ts:398]
- [x] [Review][Patch] Sweep has no advisory lock; a cycle longer than the interval re-enters and double-notifies [src/compliance/bis-licence-expiry.ts:56]
- [x] [Review][Patch] Sweep scans every active licence instead of `valid_to <= today + 90` [src/read/projections/compliance_bis_licence.ts:220]
- [x] [Review][Patch] 23505 catches are not constraint-discriminated, so a replayed primary key reports a duplicate licence number or label version [src/compliance/master-data.ts:352]
- [x] [Review][Patch] Concurrent label approvals surface a raw 23505 on `uq_label_master_current` as a 500 [src/compliance/master-data.ts:512]
- [x] [Review][Patch] `assertBisLicenceExpiryFlaggedShape` has no `rejectDeclaredDerived` guard, unlike the other four asserts [src/compliance/master-data.ts:412]
- [x] [Review][Patch] PATCH with a past `valid_to` leaves `status = 'active'` until the next sweep [src/compliance/master-data.ts:380]
- [x] [Review][Patch] Label approval reuses `COMPLIANCE_LICENCE_ALERT_ROLE` and puts a raw UUID in `actor_label` [src/compliance/master-data.ts:512]
- [x] [Review][Patch] `as any` cast disables envelope type-checking on the only system-minted compliance event [src/compliance/bis-licence-expiry.ts:92]
- [x] [Review][Patch] Dead `getBisLicenceById` fetch before `markBisLicenceExpired` silently swallows a missing licence [src/compliance/master-data.ts:404]
- [x] [Review][Patch] Per-event `correlation_id` makes one sweep untraceable; mint one per cycle [src/compliance/bis-licence-expiry.ts:86]
- [x] [Review][Patch] `mintCorrelationId` and the single-element `COMPLIANCE_STREAM_TYPES` set are unused speculative surface [src/compliance/master-data.ts:43]
- [x] [Review][Patch] `isIsoDate` mis-validates two-digit years through `Date.UTC` year mapping [src/compliance/master-data.ts]
- [x] [Review][Defer] Whole 500-licence batch runs in one transaction holding `FOR UPDATE` row locks [src/compliance/bis-licence-expiry.ts:56] - deferred, structural
- [x] [Review][Defer] Concurrent overlapping licence records can both persist; no exclusion constraint covers windows [src/compliance/master-data.ts:343] - deferred, needs a schema-level exclusion constraint
- [x] [Review][Defer] `resolveComplianceAuthority` does not resolve delegation transitively and passes amount `0` rather than amount-agnostic [src/compliance/master-data.ts] - deferred, pre-existing, mirrors `resolveQcAuthority`
- [x] [Review][Defer] `ROLLBACK TO SAVEPOINT` inside the catch can throw on a fatal connection error, masking the original failure [src/compliance/bis-licence-expiry.ts:99] - deferred, pre-existing sweep pattern
- [x] [Review][Defer] Re-approval of a `superseded` label uses a conflated error code [src/compliance/master-data.ts:512] - deferred, pre-existing

Group 1 outcome: all 4 decisions resolved as applied patches, all 19 patch findings applied, 5 items deferred. Two new integration tests cover the new guarantees (renewal restores an expired licence and re-arms its alerts; the drafting user cannot approve their own label). Three existing tests were updated to the reviewed contract: an expired window now flags stage `0` alone, the catch-up stages are silent with `suppressedStages` counting them, and the duplicate-draft case now asserts case-folded collision (`V1` vs `v1`).

Gates after Group 1: `tsc` clean, `eslint` clean, `prettier --write` applied, migrate-twice green, story suite 17/17, spine acceptance contract 6/6, full suite 1569/1596 with all 27 failures in the documented pre-existing idempotency family (0 new, no compliance-path failures).

Schema changes made during review (require a `npm run db:migrate` on any existing database): `label_master.created_by`, `uq_label_master_version` recreated case-folded, and `GRANT DELETE ON compliance_bis_licence_alert TO app_user` (renewal clears the ledger).

Groups 2-4 (API and wiring, schema and projections, tests) are not yet reviewed.

#### Group 2 - API and wiring

Layers: Blind Hunter, Edge Case Hunter, Acceptance Auditor. 41 raw findings triaged to 21.

- [x] [Review][Decision] BSD-4 approver capture-at-write is reversed and undisclosed - the spec requires the approval event payload to carry the server-resolved `approved_by`/`doa_entry_id`/`governing_role`/`delegation_applied` so replay is deterministic as DOA entries drift; the route persists `{ label_id }` alone and the applier now forbids those fields. Either restore capture-at-write or record the re-derive-under-transaction behaviour as a deviation. RESOLVED (a): the route resolves the authority and writes all four fields onto the payload; the applier re-derives under the transaction and refuses `APPROVAL_AUTHORITY_MISMATCH` when the captured values disagree, so a first apply is still guarded (AD-12) while a rebuild reads the captured values.
- [x] [Review][Decision] Compliance routes carry no location scoping - a compliance-write user assigned to one site can create, patch and read licences for every other site, even though licences are site-scoped. Peers with site-scoped data resolve a location or filter reads. Either add location scoping or record enterprise-wide access as intended. RESOLVED (b): the register is enterprise-wide compliance master data. A licence `site_id` is the scope of the LICENCE, never an access boundary. Recorded as a module-level scope decision in `src/api/v1/compliance.ts`, with the conditions that would force a revisit.
- [x] [Review][Decision] The two `QC_BIS_LICENCE_EXPIRY_*` knobs are not fail-closed on a present-but-blank value, contradicting BSD-6's repo-wide invariant; the sibling knob added in the same diff does fail closed. Either make them fail closed or record the deviation. RESOLVED (a): `parsePositiveIntEnv` gains an opt-in `strictBlank` arm and both knobs use it; the unit test that asserted blank-takes-default was flipped, and an absent-takes-default arm was added alongside.
- [x] [Review][Decision] Write routes mint a random `idempotency_key` when the client omits one, so a retry is a brand-new event rather than a replay. Either require the key on POST/PATCH or accept auto-minting. RESOLVED (a): all four write routes require `idempotency_key` and 400 without it.
- [x] [Review][Patch] `LABEL_APPROVAL_SOD_VIOLATION`, `LABEL_VERSION_APPROVAL_CONFLICT` and `BIS_LICENCE_STAGE_NOT_DUE` are missing from `AUDITED_REJECTIONS`, so a refused statutory approval leaves no audit row (the 8.3 `NCR_EXISTS` lesson) [src/api/v1/compliance.ts:43]
- [x] [Review][Patch] Create and draft hardcode 201, so an idempotency replay returns 201 with a 201-stamped audit row instead of the house `replayed ? 200 : 201` [src/api/v1/compliance.ts:155]
- [x] [Review][Patch] Both list handlers have no try/catch, so a projection error escapes the file's error contract [src/api/v1/compliance.ts:164]
- [x] [Review][Patch] Both list handlers are unbounded and unpaginated - a read-scoped caller can pull the entire register in one request [src/api/v1/compliance.ts:164]
- [x] [Review][Patch] A blank `?sku=` is falsy, so the filter is silently dropped and the full register is returned [src/api/v1/compliance.ts:166]
- [x] [Review][Patch] The approve route resolves DOA authority before checking the label exists, so a nonexistent label returns 403 instead of 404 [src/api/v1/compliance.ts:335]
- [x] [Review][Patch] PATCH silently ignores a body-supplied `licence_id` (and approve a body `label_id`), so a caller can believe they patched a different row [src/api/v1/compliance.ts:186]
- [x] [Review][Patch] A JSON array or string body is cast to `Record<string, unknown>` unchecked, so index `0` can be read as `idempotency_key` [src/api/v1/compliance.ts:331]
- [x] [Review][Patch] `auditRejectedAttempt` is awaited inside the catch before `sendAppError`; if it throws, the original AppError never reaches the client [src/api/v1/compliance.ts:128]
- [x] [Review][Patch] Creating a licence whose `valid_to` is already past inserts `status = 'active'`, unlike the renewal path which now recomputes status from the window [src/read/projections/compliance_bis_licence.ts:104]
- [x] [Review][Patch] `sku` from the query string and the create body is unvalidated and reaches the audit `details` blob unbounded [src/api/v1/compliance.ts:166]
- [x] [Review][Patch] The DOA pre-check comment claims it never replaces the in-transaction check, but an activating delegation makes it produce false-positive 403s the seam can never reach [src/api/v1/compliance.ts:319]
- [x] [Review][Defer] GET-by-id raises audited codes without auditing, while PATCH audits the same codes [src/api/v1/compliance.ts:171] - deferred, house-wide contract question
- [x] [Review][Defer] The sweep timer has no enable/kill switch and does not tick at boot [src/server.ts:1170] - deferred, operational, matches the other three cycles
- [x] [Review][Defer] SIGTERM clears the interval without awaiting an in-flight sweep [src/server.ts:1175] - deferred, house timer pattern
- [x] [Review][Defer] `GET /production-orders/lots/:lotId/genealogy` ordering comment is false (it is registered after the `:orderId` siblings and survives only by segment depth) [src/server.ts:964] - deferred, Story 6.4 scope, not 8.7
- [x] [Review][Defer] `consumptionVarianceTolerancePercent` regex rejects `.5` and `+10` while its error message implies they are accepted [src/config/index.ts:552] - deferred, Story 6.4 scope, not 8.7

Group 2 outcome: all 4 decisions resolved, 12 patch findings applied, 5 deferred.

One patch surfaced a defect no layer had reported. Requiring an idempotency key exposed that a retry of a SUCCESSFUL create was answered `409 BIS_LICENCE_OVERLAP` rather than replayed: the route's overlap pre-check tripped over the licence the first call had created, before `persistEvent` could dedupe. `findEventByIdempotencyKey` was added to the store, and the create route's pre-checks now stand down when the key has already produced an event. `persistEvent` remains the idempotency authority.

The create path also became symmetric with renewal: a licence recorded with an already-closed window is stored `expired` rather than left `active` for a later sweep tick. Three existing tests were rewritten around this - two carried fixture windows that had since fallen into the past, and the sweep test now closes a live licence's window to simulate a day passing, because a licence recorded already-expired is correctly never a sweep candidate.

Five tests added: required-key and replay-is-200, list pagination and blank-filter rejection, 404-before-403 on approve, already-closed-window storage, and an audit-row assertion for an SoD-refused approval.

Gates after Group 2: `tsc` clean, `eslint` clean, `prettier` applied, migrate-twice green, story suite 22/22, spine acceptance contract 6/6, full suite 1574/1602. 28 failures, 0 new - Story 5.3's where-used assertion was verified failing at baseline `905a48e` in a detached worktree, so the noise floor is 28, not the 27 recorded after Group 1.

Groups 3 and 4 (schema and projections, tests) are still unreviewed.

#### Group 3 - schema and projections

Layers: Blind Hunter, Edge Case Hunter, Acceptance Auditor. 60 raw findings triaged to 26.

- [x] [Review][Decision] The alert ledger is cleared on renewal and `app_user` holds DELETE, contradicting the append-only precedent documented for `production_consumption_variance` in the same file - a raised expiry alert is a posted regulatory fact. Alternative: keep the rows and re-arm with a generation counter or `cleared_at`, and drop the DELETE grant.
- [x] [Review][Decision] Task 3.2 is checked off but the five compliance payload and `*Envelope` interfaces were never written - only the `SUPPORTED_EVENT_TYPES` entries exist, so every assert and applier is typed against the bare `EventEnvelope` and the BSD-1 server-derived-field marking has no home. Write them now or uncheck the task and defer.
- [x] [Review][Decision] BSD-3 claims the overlap guard leaves at most one row per scope, closing the `findValidBisLicence` tie-break. The guard actually compares scopes with COALESCE equality, so an all-sites licence and a site-specific licence for the same sku can both exist with overlapping windows and the tie-break is still load-bearing. Either implement NULL-as-all-sites overlap or correct BSD-3 and reopen the deferred item it claimed to close.
- [x] [Review][Decision] `findValidBisLicence` ANDs `status = 'active'` with the window, and `markBisLicenceExpired` flips status unconditionally, so a single premature flip blocks releases for a licence whose window is still valid until someone PATCHes it. Either derive status in the query and keep the column as an alert artifact, or have the sweep re-activate rows whose window is valid.
- [x] [Review][Patch] The `status` ALTER guard queries `information_schema.columns` filtering on `table_name` alone, so a same-named table in another schema silently skips the column add [read/projections/compliance_bis_licence.sql:47]
- [x] [Review][Patch] `status` is missing from the `CREATE TABLE` body, so the canonical file does not describe the table it creates [read/projections/compliance_bis_licence.sql:36]
- [x] [Review][Patch] The init-db mirror of the label_master header dropped the case-folding rationale and the `created_by` sentence, breaking the byte-identical-mirror contract [deploy/compose/init-db.sql:11438]
- [x] [Review][Patch] Both compliance SQL headers still say "app_user holds SELECT only" directly above grants of INSERT/UPDATE, and the drift test repeats the stale claim [read/projections/compliance_bis_licence.sql:12]
- [x] [Review][Patch] `compliance_bis_licence_alert` has no primary key, so it has no default replica identity for CDC of the deletes the renewal path performs [read/projections/compliance_bis_licence_alert.sql:12]
- [x] [Review][Patch] `idx_compliance_bis_licence_alert_licence` is redundant against the leading column of the unique constraint - pure write amplification on the sweep insert path [read/projections/compliance_bis_licence_alert.sql:20]
- [x] [Review][Patch] The alert ledger constraints exist only inline, with no guarded DO block, unlike every sibling table in the same diff [read/projections/compliance_bis_licence_alert.sql:16]
- [x] [Review][Patch] The alert ledger carries no FK and, unlike the variance table beside it, no justification for the absence [read/projections/compliance_bis_licence_alert.sql:13]
- [x] [Review][Patch] No index supports the sweep predicate, so every tick seq-scans and sorts the whole register [read/projections/compliance_bis_licence.sql]
- [x] [Review][Patch] The sweep batch still starves: the horizon filter fixes the far-future half, but already-flagged licences nearest expiry permanently occupy the head of the batch [src/read/projections/compliance_bis_licence.ts:224]
- [x] [Review][Patch] Adding the `status` column defaults every existing row to `active`, including 8.6 rows whose window has already closed [read/projections/compliance_bis_licence.sql:47]
- [x] [Review][Patch] `getBisLicenceById` and `getLabelMasterById` accept `forUpdate` with no client, where the row lock is released the instant the query returns [src/read/projections/compliance_bis_licence.ts:137]
- [x] [Review][Patch] The `FOR UPDATE` clause is appended by string concatenation in a file that otherwise parameterizes everything [src/read/projections/compliance_bis_licence.ts:137]
- [x] [Review][Patch] `insertLabelDraft` and `insertBisLicence` store the caller string verbatim while the unique indexes fold case and whitespace - the trim lives only in the applier [src/read/projections/label_master.ts:74]
- [x] [Review][Patch] Both `DROP INDEX IF EXISTS` statements run unconditionally on every migrate, rebuilding unique indexes under ACCESS EXCLUSIVE and briefly removing the uniqueness the ACs depend on [read/projections/compliance_bis_licence.sql:57]
- [x] [Review][Patch] A live database holding case-colliding rows aborts the migration with a bare 23505 naming no offending rows [read/projections/label_master.sql:55]
- [x] [Review][Patch] The schema-drift pin declares zero constraints for the alert ledger, declining coverage of the stage CHECK that IS the AC 2 contract [test/unit/schema-drift.test.ts:1636]
- [x] [Review][Patch] BSD-4 step 4 states approve-then-supersede; the implementation correctly does the reverse (the spec order trips the non-deferrable partial unique index) but the deviation is undisclosed [spec BSD-4]
- [x] [Review][Defer] `GRANT INSERT, UPDATE` is table-wide where the accessors only ever write three columns; column-level grants would enforce the SoD claim structurally - deferred, house-wide grant posture
- [x] [Review][Defer] Story 6.4 schema, payload and migration entries ride in the same change set as 8.7, so the schema gates validate a mixed unit - deferred, commit hygiene, split at commit time
- [x] [Review][Defer] The 6.4 `variance` payload permits contradictory states - deferred, Story 6.4 scope
- [x] [Review][Defer] Duplicated header comment on the variance table block in init-db - deferred, Story 6.4 scope

Group 3 outcome: all 4 decisions resolved, 18 patch findings applied, 4 deferred.

D9 was resolved by a third option neither the review nor the decision menu had proposed: the alert ledger is re-keyed on `(licence_id, valid_to, stage_days)`. Renewal changes `valid_to`, so the new window has no ledger rows and re-arms by construction, while every alert raised against an earlier window survives. The delete helper is gone, the DELETE grant on `app_user` is gone, and the ledger is documented and pinned as append-only - matching the `production_consumption_variance` precedent fifteen lines below it in the same file. The earlier clear-on-renewal design was a workaround for the wrong key.

D10: the five payload and `*Envelope` interfaces now exist next to the registry, with the BSD-1 convention stated in the block header - SERVER-DERIVED fields typed `?: never` so a declared one is a compile error rather than only a runtime `COMPLIANCE_DERIVATION_MISMATCH`, and the SERVER-CAPTURED approver quartet from D5 marked as travelling on the payload deliberately.

D11: BSD-3's claim was wrong and is now corrected in the accessor header. The overlap guard compares scopes exactly, so a national all-sites licence and a plant-specific licence legitimately coexist with overlapping windows; the site-specific-over-global ordering is a deliberate precedence rule, not an arbitrary tie-break, and is now pinned by an integration test. The deferred item BSD-3 claimed to close is NOT closed.

D12: `findValidBisLicence` no longer reads `status`. Expiry is derived from the window alone, so a mis-dated sweep tick can no longer permanently block releases for a licence whose window is still valid. `status` remains an alerting artifact, still written by the sweep.

Schema work also landed: `status` moved into the `CREATE TABLE` body and its `information_schema` probe (which filtered on `table_name` alone, so a same-named table in any other schema silently skipped the column) replaced with `ADD COLUMN IF NOT EXISTS`, plus a one-time backfill marking already-closed 8.6 rows expired. Both unique-index rebuilds are now guarded on the index body actually differing, and raise a named exception listing the offending rows instead of a bare 23505. A partial index now supports the sweep predicate, and the sweep query anti-joins the ledger so already-flagged licences cannot occupy the head of the batch forever - the horizon filter had only fixed the far-future half of that starvation.

The three canonical blocks were re-mirrored into `init-db.sql` mechanically rather than by hand, which fixed the comment drift introduced during Group 1 and the stale "app_user holds SELECT only" claim that sat directly above grants of INSERT/UPDATE in both files and in the drift test.

One test was found passing for the wrong reason: after the Group 2 create-status change, the renewal test's licence was stored `expired` at insert, so the sweep never wrote a ledger row and the "ledger cleared" assertion held vacuously. It now records a live licence, lets the sweep flag it, closes the window, and asserts the earlier windows' rows survive the renewal.

Two tests added: the append-only re-arm across three windows, and the all-sites-versus-site-specific precedence rule.

Gates after Group 3: `tsc` clean, `eslint` clean, `prettier` applied, migrate-twice green, story suite 23/23, spine acceptance contract 6/6, full suite 1575/1603 with the same 28 pre-existing failures and no compliance-path failures.

Group 4 (the test layer) is the only unreviewed chunk left.

#### Group 4 - test layer

Layers: Blind Hunter, Edge Case Hunter, Acceptance Auditor. 59 raw findings triaged to 27. This group reviewed the tests the earlier three groups wrote, and the result is the most uncomfortable of the four: three tests added during THIS review pass for the wrong reason, and nearly every guard minted during this review has no negative test.

- [x] [Review][Patch] "the renewed window starts with a clean ledger" filters on a `valid_to` that never existed before the PATCH, so it counts zero by construction and would pass if renewal did nothing at all [test/integration/story-8-7.test.ts:919]
- [x] [Review][Patch] The BSD-5 suppression assertion counts notifications for the `expired` licence, whose ledger holds exactly one row, so it holds even if the most-urgent-stage early return is deleted [test/integration/story-8-7.test.ts:1205]
- [x] [Review][Patch] `suppressedStages >= 2` is asserted where the true value is 7, so suppression counting can be broken for three of four licences and still pass [test/integration/story-8-7.test.ts:1223]
- [x] [Review][Patch] The SoD audit assertion counts `audit_log` rows globally by error code, so it passes only because of declaration order and never proves the row belongs to this label [test/integration/story-8-7.test.ts:857]
- [x] [Review][Patch] The AC 2 release regression duplicates `findValidBisLicence` as hand-written SQL and still asserts the pre-D12 `status = 'active'` predicate, so the accessor's window logic could be deleted undetected [test/integration/story-8-7.test.ts:1244]
- [x] [Review][Patch] `BIS_LICENCE_STAGE_NOT_DUE` has no test - the anti-tamper cross-check that stops a forged event expiring a live licence can be deleted with a green suite [src/compliance/master-data.ts:478]
- [x] [Review][Patch] `APPROVAL_AUTHORITY_MISMATCH` has no test, so the D5 capture-versus-re-derive guard is unverified [src/compliance/master-data.ts:570]
- [x] [Review][Patch] `LABEL_VERSION_APPROVAL_CONFLICT` has no test, so the concurrent-approval path can revert to a raw 23505 500 [src/compliance/master-data.ts:637]
- [x] [Review][Patch] `COMPLIANCE_DERIVATION_MISMATCH` is asserted nowhere, so `rejectDeclaredDerived` could be deleted entirely [src/compliance/master-data.ts:137]
- [x] [Review][Patch] `BIS_LICENCE_NOT_FOUND` and `DUPLICATE_EVENT` are in the Error Code Contract but asserted nowhere [src/api/v1/compliance.ts]
- [x] [Review][Patch] The D8 retry stand-down has no test that would catch its removal - a dropped-response retry returning 409 instead of replaying is exactly the bug it fixed [src/api/v1/compliance.ts:205]
- [x] [Review][Patch] `rejectUnacceptedFields` has no negative test on any of the three routes that use it [src/api/v1/compliance.ts:113]
- [x] [Review][Patch] D1 is asserted by comment only - the overlap test uses two live windows and never creates an expired predecessor, so removing the `status = 'active'` filter breaks nothing [test/integration/story-8-7.test.ts:1054]
- [x] [Review][Patch] D4's conflicting-row identity is untested - `existing_licence_id` and `existing_label_id` appear in no assertion, so the resolvers could revert to echoing the submitted values [test/integration/story-8-7.test.ts:1014]
- [x] [Review][Patch] `skippedLocked` is now asserted true under a held advisory lock [src/compliance/bis-licence-expiry.ts:74]
- [x] [Review][Defer] `failed` and `cycleFailed` remain asserted only in their success state - forcing a mid-sweep row failure needs an injection point the sweep does not expose, and faking one would prove nothing. Deferred rather than written as a test that cannot fail.
- [x] [Review][Patch] `dueBisLicenceExpiryStages`, `mostUrgentDueBisLicenceExpiryStage` and `calendarDaysBetween` are pure functions with zero unit coverage; their boundaries are checked only transitively through a database-dependent test [src/compliance/master-data.ts:95]
- [x] [Review][Patch] Task 9.3's 61 and 31 boundary arms do not exist, so an off-by-one firing stage 60 at 61 days is uncaught on two of three stages [test/integration/story-8-7.test.ts:1129]
- [x] [Review][Patch] Task 9.2 claims the create appears in `GET /api/v1/audit/log`, but no test calls that route - the FR-AC-13 edit-log proof is a raw `domain_events` SELECT [test/integration/story-8-7.test.ts:707]
- [x] [Review][Patch] Two of the four GET routes added to the spine allowlist have no behavioural test at all [test/integration/story-1-9.test.ts:574]
- [x] [Review][Patch] "read scope CAN list and get" never performs a get [test/integration/story-8-7.test.ts:1408]
- [x] [Review][Patch] The new `idx_compliance_bis_licence_expiry` partial index is not in the drift pin, so dropping it is invisible to the gate [test/unit/schema-drift.test.ts:1598]
- [x] [Review][Patch] The alert-ledger pin header still states the pre-D9 `(licence_id, stage_days)` grain and contradicts a later line in its own block [test/unit/schema-drift.test.ts]
- [x] [Review][Patch] Duplicate config test (absent knobs take defaults) appears twice, and both batch-size negative arms assert `doesNotMatch(/INTERVAL=/)` where they mean `/BATCH=/` [test/unit/qc-bis-licence-expiry-config.test.ts:45]
- [x] [Review][Patch] The interval upper bound - whose stated purpose is preventing a `setInterval` tick storm - has no refuses-boot arm [test/unit/qc-bis-licence-expiry-config.test.ts]
- [x] [Review][Patch] The precedence test is titled BSD-6 (the config knobs) when it is the D11 correction to BSD-3 [test/integration/story-8-7.test.ts:934]
- [x] [Review][Patch] Story bookkeeping: Task 9.2 and Task 9.8 are checked off for work not done or not needed, and parent Task 10 is unchecked while all its children are checked [spec Task 9, Task 10]
- [x] [Review][Defer] Nothing asserts the sweep is actually scheduled in `server.ts`; deleting the registration leaves the suite green while the statutory sweep never runs - deferred, house-wide timer-registration gap shared by all four cycles

Group 4 outcome: 25 patch findings applied, 2 deferred.

The three vacuous assertions were all written during this review, and all three are fixed:

- "the renewed window starts with a clean ledger" filtered on a `valid_to` that had never existed, so it counted zero by construction. Replaced with a count across all three windows (3 + 1 + 2 = 6) that the pre-review delete-on-renewal design would fail at 2.
- The BSD-5 suppression check counted notifications for the licence whose ledger holds one row. It now asserts on the three licences that persisted three rows each in one cycle - where the most-urgent-stage early return is actually load-bearing.
- `suppressedStages >= 2` became an exact 8, which is what the fixture set really suppresses.

A fourth was order-dependent rather than vacuous: the SoD audit assertion counted `audit_log` rows globally by error code and passed only because of declaration order. It now scopes to its own `label_id` through the `auditCount` helper that already existed for exactly this.

Negative arms now exist for every guard this review minted: `BIS_LICENCE_STAGE_NOT_DUE` (a forged stage-0 event against a 300-day licence, asserting neither the status nor the ledger moved), `APPROVAL_AUTHORITY_MISMATCH` (a tampered approver on the payload), `COMPLIANCE_DERIVATION_MISMATCH` (a client-declared `status`), `BIS_LICENCE_NOT_FOUND` and the 404/400 arms of both get-by-id routes, `rejectUnacceptedFields` on all three routes that use it, D1 (an expired predecessor does not block an overlapping replacement), D4 (the conflict names the conflicting row), and the advisory lock (`skippedLocked` true under a held lock).

The D4 test found a production bug in a Group 3 patch: the applier looked up the conflicting row on the same client whose transaction the 23505 had already aborted, so the sequential path returned 500 instead of 409. It now reads through the pool, as the store's race arm does, and both paths return the same details - which is what D4 claimed but only half-implemented.

A new unit file, `test/unit/compliance-bis-licence-stages.test.ts`, covers the pure stage arithmetic that had been exercised only through a PostgreSQL-backed integration test: 21 assertions over `dueBisLicenceExpiryStages`, `mostUrgentDueBisLicenceExpiryStage` and `calendarDaysBetween`, including 91/90, 61/60, 31/30 and the 0/-1 expiry edge. It was mutation-checked - reintroducing the "expired window also emits the day-count stages" bug that Group 1 fixed kills 5 of the 21.

The sweep test gained the 61 and 31 arms (the day before each stage opens), the FR-AC-13 edit-log proof now goes through `GET /api/v1/audit/log` as Task 9.2 always claimed - which required granting the fixture the `audit` module, a separate grant from `compliance` - and "read scope CAN list and get" now performs a get.

Two deferred: nothing asserts the sweep is registered on a timer in `server.ts` (a house-wide gap shared by all four cycles), and `failed`/`cycleFailed` remain asserted only in their success state, because forcing a mid-sweep row failure needs an injection point the sweep does not expose. A test that cannot fail would be worse than no test - which is the lesson of this entire group.

Gates after Group 4: `tsc` clean, `eslint` clean, `prettier` applied, story suite 33/33, unit suites 168/168, spine acceptance contract 6/6, full suite 1606/1634 with the same 28 pre-existing failures and 0 new.
