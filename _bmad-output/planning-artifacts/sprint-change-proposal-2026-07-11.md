# Sprint Change Proposal

**Date:** 2026-07-11
**Project:** Inventory Management System_2 (Materials & Supply Chain Management Platform)
**Trigger:** Implementation Readiness Assessment (implementation-readiness-report-2026-07-11.md) — verdict NEEDS WORK
**Mode:** Batch review | **Scope:** All 223 findings (critical + major + minor + coverage + fidelity + UX)
**Prepared by:** Correct Course workflow, 16 parallel drafting agents; every edit anchor mechanically validated (176/176 unique matches, 0 conflicts after adjudication)

---

## 1. Issue Summary

The pre-implementation readiness assessment of the planning chain (PRD → Architecture → Epics) found the epics document structurally excellent — 269/269 FRs mapped, zero orphans, zero entirely-missing requirements — but materially incomplete in fixable ways:

- **11 critical violations**: circular/cross-phase dependencies that make stories unimplementable as sequenced (Epic 3 ↔ Epic 4 PO data, Epic 6 → Epic 8 QC dispositions, Story 5.2 → 5.3/5.5 gate conditions, Epic 13 migrating into Phase-2 modules, pick tasks triggered by orders no Phase-1 story creates).
- **7 statutory coverage gaps**: clauses of Ind AS 38, GST s.143, s.43B(h), BIS retention, and migration scope with no enforcing acceptance criterion.
- **A pilot-slice statutory hole**: dispatch documents produced at the pilot without IRN-before-dispatch enforcement in the slice.
- **78 major + 76 minor quality defects**: missing negative paths on enforcement FRs, systematic off-by-one FR citations in five epics, eight grab-bag stories, capabilities consumed that no story builds (invoice capture, ASNs, BIS/label masters, CI/CD, notifications).
- **Document hygiene**: dead annex-of-record pointer in the PRD; duplicate PRD copies with no declared precedence; six of seven Phase-2 epic goals under-stating family scope.

Discovery context: found by a 52-agent adversarially-verified assessment run before any implementation work started — no code exists yet, so all corrections are planning-artifact edits.

## 2. Impact Analysis

**Epic impact.** All 13 Phase-1 epics receive edits; none is removed or redefined. Net structural changes:

- **5 new capability stories:** 1.10 CI/CD Pipeline Construction, 1.11 Notification & Alerting Foundation, 2.9 ERP Inbound Reference Projections (open POs + sales orders — the new Phase-1 source for PO binding and outbound demand), 4.7 Supplier Invoice Capture, 8.7 Compliance Master Data (BIS licences, label masters).
- **10 story splits** (original keeps its number with reduced scope): 3.9→3.10 (cross-docking), 5.5→5.6 (rollups/kit-tags/ERP sync), 7.4→7.7 (AMC/warranty/insurance), 7.6→7.8 (offline technician + closure codes), 8.6→8.8 (witnessed inspections + prototype rules), 9.4→9.6 (offcut execution + billing feed), 10.4→10.6 (offline POS) + 10.7 (job cards/statements), 12.1→12.5 (exception rule engine), 12.4→12.6 (scheduling/sharing).
- **Resequencing:** Epic 6 now declares Epic 8 (QC dispositions before closure gate); Epic 5 gate conditions staged across 5.2/5.3/5.5; Story 4.2 explicitly sequenced after 4.4/4.5/4.7; Epics 3's PO references rebased onto Story 2.9 projections.
- **Pilot slice:** gains Story 11.2 (IRN-before-dispatch) for statutory closure; Epic 13's dependency contradiction resolved via phased sign-off scoped to each go-live wave.
- **Phase-2 epics:** goals for Epics 15–20 regenerated to full family scope; migration of sales orders / asset register / gate passes moved from Epic 13 to Epics 15/17/20.

**Story impact.** 63 existing stories: ~50 receive AC additions (negative paths, statutory clauses, citation fixes); coverage-map and requirements-inventory lines corrected; 25 findings expressly deferred with reasons (mostly Phase-2-boundary items already carried as notes).

**Artifact conflicts.** PRD: 2 surgical edits (annex path in §0 of both copies; precedence note on the sharded copy). Architecture Spine: 5 additive edits (notification/alerting component, D1 decision record, WCAG/i18n convention row). No PRD goal, MVP scope, or architecture invariant conflicts with any correction.

**Technical impact.** None yet — greenfield, pre-implementation. The corrections *reduce* future technical risk (no circular builds, statutory enforcement testable from day one).

## 3. Recommended Approach

**Direct Adjustment** (Option 1) — modify stories and headers within the existing epic structure. Rollback is N/A (nothing built); MVP review is unnecessary (scope unchanged; only the pilot slice composition is amended for statutory closure).

- **Effort:** Medium — 176 mechanical edits, all pre-validated against the current files.
- **Risk:** Low — every edit anchors to exact unique text; conflicts already adjudicated; no renumbering of existing stories.
- **Timeline impact:** days of planning-artifact work; unblocks sprint planning.

**Decisions embedded in this proposal (flagged for sign-off):**

- **D1 — Phase-1 outbound demand & PO reference source:** a read-only ERP inbound projection (new Story 2.9) supplies open-PO data (gate binding, tolerances, receiving) and sales-order demand (pick tasks, cross-docking, fill-rate KPI). ERP remains master (INT-ERP-01). *Alternative rejected:* re-sequencing Epic 4 before Epic 3 (heavier churn, still leaves outbound demand unsolved).
- **D2 — Pilot slice adds Story 11.2 (IRN-before-dispatch)** rather than documenting an exclusion — the pilot dispatches job-work output, so FR-AC-14 enforcement must be live.
- **D3–D6** (Epic 6→8 dependency, Epic 5 staging, Story 4.2 sequencing note, Epic 13 phased rescope) as detailed in Section 2.

## 4. Detailed Change Proposals

All 176 edits follow, grouped by drafting scope, each with target, edit type, exact old text (anchor), new text, rationale, and the finding(s) it addresses. Anchors were verified to match the current files exactly and uniquely; the set is free of overlapping ranges and can be applied mechanically. The 25 deferrals (findings expressly not edited, with reasons) close the section.


### Epic 1: Platform Foundation, Compliance Spine, and — 13 edits

#### E1-01 — REPLACE in `epics.md`

**Findings addressed:** Q5: traceability — epic header FR list incomplete; Q1 (partial): FR-M-13 ownership-split note, Epic 1 side; UX-2: Story 1.10 CI/CD; UX-3: Story 1.11 notification foundation

**Rationale:** Completes the epic header's requirements list with everything the stories actually deliver (FR-M-13 enforcement, INT-LOC-01, INT-IAM-01/02, NFR foundations), states the FR-M-13 ownership split with Epic 7 explicitly, and registers the two new foundation stories in the architecture-delivered line.

**OLD:**

~~~~markdown
**FRs covered:** FR-AC-01, FR-AC-13, FR-DOA-01

**Architecture delivered:** Node.js 24 LTS / PostgreSQL 18.4 / PowerSync 1.23.x / AWS ECS Fargate + Aurora Multi-AZ, INT-IAM-01/02 (SSO/SCIM), central event store schema (domain_events), offline edge PWA shell (SQLite schema + PowerSync client + "captured, pending sync" status shell), idempotency key infrastructure (AD-16), event envelope schema (AD-1, AD-12)
~~~~

**NEW:**

~~~~markdown
**FRs covered:** FR-AC-01 (business-stream + cost-centre/project-code tagging), FR-AC-13, FR-DOA-01, FR-M-13 (lockout enforcement invariant only — instrument records and the calibration register are Epic 7), INT-LOC-01, INT-IAM-01/02

**NFR foundations delivered:** NFR-U-02 (WCAG 2.1 AA UI standards, Story 1.8), NFR-U-03 (i18n foundation, Story 1.8), NFR-P-04 Tier 1 (offline-first edge availability), NFR-SEC-01/02 (SSO; RBAC to module, function, and location scope); notification and alerting foundation (Story 1.11) consumed by FR-P-04 (UJ-IND-01), FR-M-04, FR-GP-09/10, FR-JW-14

**Architecture delivered:** Node.js 24 LTS / PostgreSQL 18.4 / PowerSync 1.23.x / AWS ECS Fargate + Aurora Multi-AZ, INT-IAM-01/02 (SSO/SCIM), central event store schema (domain_events), offline edge PWA shell (SQLite schema + PowerSync client + "captured, pending sync" status shell), idempotency key infrastructure (AD-16), event envelope schema (AD-1, AD-12), CI/CD pipeline + branch protection (Story 1.10), notification/alerting service (Story 1.11)
~~~~

#### E1-02 — INSERT AFTER in `epics.md`

**Findings addressed:** Q8: 1.1 no negative-path envelope AC; Q5: traceability — inline citation for Story 1.1; UX-2 (cross-ref): 1.1 presupposes the Story 1.10 pipeline

**Rationale:** Adds the missing negative-path AC for envelope enforcement (the compliance foundation every later invariant depends on) with a stable error code, adds the inline requirements citation Story 1.1 lacked, and resolves the pipeline-presupposition by pointing at Story 1.10.

**ANCHOR (insert after):**

~~~~markdown
**Given** a developer submits a test event with all required envelope fields
**When** the event is persisted
**Then** a subsequent stream read returns the event with all fields intact, `metadata.synced_at` populated, and `event_version` monotonically incremented per `stream_id`
~~~~

**NEW (inserted):**

~~~~markdown


**Given** an event submission missing a required envelope field (e.g., no `actor` or no `correlation_id` in `metadata`)
**When** the event store processes the write
**Then** the write is rejected with `error_code: "INVALID_EVENT_ENVELOPE"` and nothing is written to `domain_events`

**Requirements:** AD-1/AD-12 (event envelope, compliance spine substrate), AD-16 (idempotency key infrastructure), NFR-DI-01. The IaC deployment pipeline this story's first AC presupposes is built in Story 1.10, sequenced alongside this story.
~~~~

#### E1-03 — INSERT AFTER in `epics.md`

**Findings addressed:** Q4: 1.2 module-scope and function-scope RBAC denial untested (major)

**Rationale:** The story promises RBAC enforced to module, function, and location scope but tested only location denial; these ACs give the other two enforcement dimensions observable negative paths with stable error codes parallel to the existing LOCATION_ACCESS_DENIED.

**ANCHOR (insert after):**

~~~~markdown
**Given** a valid SSO session for a user scoped to `location_id: "site-A"`
**When** the user calls a write endpoint for `location_id: "site-B"`
**Then** the API returns HTTP 403 with `error_code: "LOCATION_ACCESS_DENIED"`
~~~~

**NEW (inserted):**

~~~~markdown


**Given** a valid SSO session for a user whose roles grant no access to a module (e.g., maintenance)
**When** the user calls any endpoint of that module
**Then** the API returns HTTP 403 with `error_code: "MODULE_ACCESS_DENIED"`

**Given** a valid SSO session for a user whose role grants read-only function scope on a module
**When** the user calls a mutating (write) endpoint of that module
**Then** the API returns HTTP 403 with `error_code: "FUNCTION_ACCESS_DENIED"`
~~~~

#### E1-04 — INSERT AFTER in `epics.md`

**Findings addressed:** Q5: traceability — inline citation for Story 1.2

**Rationale:** Adds the inline requirements citation Story 1.2 lacked, making the mapping recoverable from the story itself rather than only via Story 1.9's test list.

**ANCHOR (insert after):**

~~~~markdown
**Given** a user is deprovisioned via SCIM
**When** they attempt to use an existing session
**Then** the session is invalidated within 30 seconds of the SCIM event
~~~~

**NEW (inserted):**

~~~~markdown


**Requirements:** NFR-SEC-01 (SSO SAML 2.0/OIDC), NFR-SEC-02 (RBAC to module, function, and location scope), INT-IAM-01/02 (SSO/SCIM)
~~~~

#### E1-05 — INSERT AFTER in `epics.md`

**Findings addressed:** COV-2: FR-AC-13 partial — edit-log retention (8 FY); Q11: 1.3 tamper-rejection mechanism undefined at DB layer

**Rationale:** Closes the FR-AC-13 'retained per books-retention' coverage gap with an enforceable 8-FY retention AC (negative path included), and defines the tamper-enforcement mechanism and direct-DB-connection test procedure that AC2 presupposed but never specified.

**ANCHOR (insert after):**

~~~~markdown
**Given** a configuration flag attempts to disable the edit log
**When** any subsequent mutating request is made
**Then** the request is blocked with `error_code: "AUDIT_LOG_DISABLED"` — no mutating operation proceeds without the log active
~~~~

**NEW (inserted):**

~~~~markdown


**Given** edit-log entries from prior financial years
**When** retention is evaluated or an early purge is attempted
**Then** every entry remains retrievable for at least 8 financial years per books-retention (FR-AC-13) — online, or restored from the permanent S3 Glacier archive to queryable within 48 hours (NFR-S-05) — and no deletion path exists inside the retention window; any early-deletion attempt is rejected and logged with `error_code: "AUDIT_LOG_TAMPER_ATTEMPT"`

**Dev notes:**
- **Tamper enforcement mechanism (AC2):** the edit log is append-only by construction — `UPDATE`/`DELETE` grants revoked from every database role including the application role, with DB triggers that reject modifications and write the `AUDIT_LOG_TAMPER_ATTEMPT` entry through an autonomous path. Test procedure for the direct-connection case: execute `UPDATE`/`DELETE` against the edit log as the highest-privilege operational role and assert rejection plus the logged attempt; production superuser access is itself restricted via IAM.
- **Retention (FR-AC-13):** books-retention = 8 financial years (platform retention policy: event store online in PostgreSQL + permanent S3 Glacier archive; archived ranges restorable to queryable within 48 hours).
~~~~

#### E1-06 — REPLACE in `epics.md`

**Findings addressed:** Q3: 1.4 forward-dependency — synthetic module-free DOA trigger (major); Q3: hard-coded-role verification mechanism; DROP-1: FR-DOA-01 'config consumes, never overrides' clause

**Rationale:** Makes all three DOA ACs testable module-free by restating triggers as synthetic resolution requests against the registry API (the same endpoint Epic 4 later consumes), gives the 'no hard-coded role' assertion a defined verification mechanism (CI static check wired into the Story 1.9 run), and restores the dropped FR-DOA-01 clause 'workflow config consumes, never overrides it' as a negative-path AC with a semantic error code.

**OLD:**

~~~~markdown
**Given** a DOA entry: role `procurement_head`, transaction type `po_approval`, value band `> 500000`
**When** a PO of value 600,000 triggers an approval event
**Then** the workflow resolves the approver from the DOA registry and routes to the current holder of `procurement_head` — no hard-coded role name exists in workflow code

**Given** a vacation delegation from User A to User B for dates 2026-08-01 to 2026-08-10
**When** an approval is triggered on 2026-08-05
**Then** the approval routes to User B; the delegation and its active dates are recorded in the event log

**Given** a DOA registry entry is updated by the System Administrator
**When** the next approval workflow triggers after the update
**Then** it uses the new entry immediately with no system restart required
**And** every DOA registry change is logged in the edit log with the administrator's identity
~~~~

**NEW:**

~~~~markdown
**Given** a DOA entry: role `procurement_head`, transaction type `po_approval`, value band `> 500000`
**When** a synthetic resolution request `POST /api/v1/doa/resolve` with `{ "transaction_type": "po_approval", "value": 600000 }` is submitted (registry configuration data only — no PO entity or module code required; Epic 4 approval workflows consume this same endpoint for real POs)
**Then** the registry resolves the approver as the current holder of `procurement_head` and returns the resolution referencing the matched registry entry
**And** the "no hard-coded role name in workflow code" invariant is verified as an observable pass/fail by a CI static check (lint rule rejecting role-name literals in workflow code), executed as part of the Story 1.9 spine contract run

**Given** a vacation delegation from User A to User B for dates 2026-08-01 to 2026-08-10
**When** a synthetic resolution request that resolves to the role held by User A is submitted on 2026-08-05
**Then** the resolution returns User B; the delegation and its active dates are recorded in the event log

**Given** a DOA registry entry is updated by the System Administrator
**When** the next resolution request is submitted after the update
**Then** it uses the new entry immediately with no system restart required
**And** every DOA registry change is logged in the edit log with the administrator's identity

**Given** a workflow configuration entry that attempts to specify its own approver mapping for a transaction type governed by the DOA registry
**When** the configuration is saved or a resolution request for that transaction type is processed
**Then** the write is rejected with `error_code: "DOA_OVERRIDE_BLOCKED"` — workflow configuration consumes the registry's resolution and can never override it (FR-DOA-01)
~~~~

#### E1-07 — REPLACE in `epics.md`

**Findings addressed:** Q2: 1.5 imprecise observables (stock balance / unnamed projection); COV-1: FR-AC-01 partial — cost-centre tagging where applicable

**Rationale:** Rewords the two imprecise assertions to event-store observables ('no event appended to domain_events' instead of a nonexistent stock balance; the Story 1.1 stream read instead of an unnamed projection), and closes the FR-AC-01 partial by enforcing cost-centre (and project-code) tagging where applicable as a spine-level negative-path AC.

**OLD:**

~~~~markdown
As a financial controller,
I want every inventory movement event to carry a mandatory `business_stream` tag enforced at the write path,
So that no untagged transaction can enter the ledger and reporting by stream (production, R&D, maker-hub, job-work) is accurate by construction from the first transaction.

**Acceptance Criteria:**

**Given** a write request for an inventory movement event with no `business_stream` field
**When** the event handler processes the command
**Then** the write is rejected with `error_code: "UNTAGGED_TRANSACTION"` and the stock balance is unchanged

**Given** a write request with `business_stream: "production"` (a valid value)
**When** the event is persisted
**Then** the event payload carries the `business_stream` value and it is queryable via the read model projection

**Given** a write request with `business_stream: "unknown_stream"` (unrecognized value)
**When** the event handler processes the command
**Then** the write is rejected with `error_code: "INVALID_BUSINESS_STREAM"`
~~~~

**NEW:**

~~~~markdown
As a financial controller,
I want every inventory movement event to carry a mandatory `business_stream` tag — plus `cost_centre` and `project_code` where applicable (FR-AC-01) — enforced at the write path,
So that no untagged transaction can enter the ledger and reporting by stream (production, R&D, maker-hub, job-work) is accurate by construction from the first transaction.

**Acceptance Criteria:**

**Given** a write request for an inventory movement event with no `business_stream` field
**When** the event handler processes the command
**Then** the write is rejected with `error_code: "UNTAGGED_TRANSACTION"` and no event is appended to `domain_events`

**Given** a write request with `business_stream: "production"` (a valid value)
**When** the event is persisted
**Then** the event payload carries the `business_stream` value and an event-store stream read (the Story 1.1 read path) returns it with the tag intact — module read-model projections consume the tag from Epic 2 onward

**Given** a write request with `business_stream: "unknown_stream"` (unrecognized value)
**When** the event handler processes the command
**Then** the write is rejected with `error_code: "INVALID_BUSINESS_STREAM"` and no event is appended to `domain_events`

**Given** a transaction type configured as cost-centre-applicable (applicability is dated configuration, not code)
**When** an inventory movement event of that type is submitted with no `cost_centre` field
**Then** the write is rejected with `error_code: "UNTAGGED_TRANSACTION"` and no event is appended to `domain_events`
**And** the same rule enforces `project_code` for project-applicable transaction types (R&D project-code enforcement is exercised end-to-end in Story 10.1)
~~~~

#### E1-08 — REPLACE in `epics.md`

**Findings addressed:** Q6: 1.6 forward-dependency on ASN/lot master

**Rationale:** Removes the forward reference to ASN receiving (Epic 3) and the lot master (Epic 2) by sourcing the expected-location fact from a prior expected-location event, synthetically seeded for spine testing, so the scenario is executable within Epic 1.

**OLD:**

~~~~markdown
**Given** a putaway event arrives with `asserted_location: "BIN-A43"` for a lot whose expected location from the inbound ASN is `BIN-A47`
~~~~

**NEW:**

~~~~markdown
**Given** a putaway event arrives with `asserted_location: "BIN-A43"` for a lot whose expected location `BIN-A47` was recorded by a prior expected-location event (in production sourced from ASN/putaway plans arriving with Epic 3; seeded synthetically as an opaque test event for spine testing — lot IDs are opaque identifiers until Epic 2 defines the lot master)
~~~~

#### E1-09 — INSERT AFTER in `epics.md`

**Findings addressed:** Q5: traceability — inline citation for Story 1.6

**Rationale:** Adds the inline requirements citation Story 1.6 lacked.

**ANCHOR (insert after):**

~~~~markdown
**Given** no location event has been received for a lot
**When** the lot's current location is queried
**Then** the response returns `{ "location": null, "confidence": "none" }` — no default location is invented
~~~~

**NEW (inserted):**

~~~~markdown


**Requirements:** INT-LOC-01, AD-15 (asserted/expected separation), AD-16 (idempotent movement events)
~~~~

#### E1-10 — REPLACE in `epics.md`

**Findings addressed:** Q1: 1.7 forward-dependency — instrument projection/status path never built (major); Q1: FR-M-13 ownership split, story side; Q5: traceability — inline citation for Story 1.7

**Rationale:** Delivers the undeclared scaffolding the lockout ACs presupposed — a minimal instrument-status registry with an admin status endpoint and a synthetic QC-result command — so Story 1.9's module-free spine test 4 is actually executable, and resolves the FR-M-13 dual-ownership by stating the Epic 1/Epic 7 split and how C-12 relates to spine acceptance. Adds the inline citation the story lacked.

**OLD:**

~~~~markdown
**Given** instrument `INS-0042` has a calibration status of `out_of_calibration` in the projection
**When** a QC result event referencing `instrument_id: "INS-0042"` is submitted by any user
**Then** the write is rejected with `error_code: "CALIBRATION_LOCKOUT"` and no result is persisted

**Given** the submitting user holds role `qc_head` (the highest QC authority)
**When** the same write is attempted
**Then** it is still rejected with `CALIBRATION_LOCKOUT` — no role attribute can override the lockout

**Given** instrument `INS-0042` is updated to `calibrated` status
**When** a QC result referencing that instrument is submitted
**Then** the write succeeds and the result is persisted normally

**Given** a calibration escalation request is submitted for an out-of-calibration instrument
**When** the escalation is processed
**Then** it routes to the calibration scheduler via the DOA registry — expediting calibration, not bypassing the lockout
~~~~

**NEW:**

~~~~markdown
**Given** the minimal instrument-status registry delivered by this story holds instrument `INS-0042` with calibration status `out_of_calibration` (status set via the admin endpoint `PUT /api/v1/instruments/{id}/calibration-status`)
**When** a QC result event referencing `instrument_id: "INS-0042"` is submitted by any user (via the synthetic spine-test QC-result command — production QC result capture arrives in Epic 8 and passes through this same enforcement point)
**Then** the write is rejected with `error_code: "CALIBRATION_LOCKOUT"` and no result is persisted

**Given** the submitting user holds role `qc_head` (the highest QC authority)
**When** the same write is attempted
**Then** it is still rejected with `CALIBRATION_LOCKOUT` — no role attribute can override the lockout

**Given** instrument `INS-0042` is updated to `calibrated` status via the admin status endpoint
**When** a QC result referencing that instrument is submitted
**Then** the write succeeds and the result is persisted normally

**Given** a calibration escalation request is submitted for an out-of-calibration instrument
**When** the escalation is processed
**Then** it routes to the calibration scheduler via the DOA registry — expediting calibration, not bypassing the lockout

**Dev notes:**
- **In-scope scaffolding:** a minimal instrument-status registry (instrument ID, calibration status, status-change events, admin status-update endpoint) and a synthetic QC-result spine-test command — the smallest capability that makes the lockout invariant testable with zero module code present (Story 1.9, spine test 4).
- **FR-M-13 ownership split:** Epic 1 owns the non-overridable lockout enforcement invariant; Epic 7 owns the full asset register and calibration register (FR-M-12) with certificates and alerts, which replaces the admin endpoint as the production status source. The C-12 migration sequencing (FR-M instrument records loaded before the FR-Q-04 lockout goes live at a site) governs site go-live activation, not spine acceptance — spine acceptance runs against this story's synthetic registry entries.

**Requirements:** FR-M-13 (enforcement invariant), FR-Q-04 (enforced at this write path; QC result capture is Epic 8), AD-8
~~~~

#### E1-11 — INSERT AFTER in `epics.md`

**Findings addressed:** Q10: 1.8 no sync-rejection path AC; UX-1: WCAG 2.1 AA + i18n foundation ACs in Story 1.8; Q5: traceability — inline citation for Story 1.8

**Rationale:** Adds the missing sync-rejection path AC (no silently stuck pending events on the edge device), and lands the Epic-1-owned UX-alignment foundation: WCAG 2.1 AA shell standards with a CI-enforced audit and an i18n message-catalog foundation, both binding on later module UI stories. Adds the inline citation the story lacked.

**ANCHOR (insert after):**

~~~~markdown
**Given** a `pending_sync` event is resubmitted on the next sync cycle (idempotency test)
**When** the central event store receives the duplicate submission
**Then** HTTP 409 is returned; no duplicate event is created; the balance is updated exactly once (AD-16)
~~~~

**NEW (inserted):**

~~~~markdown


**Given** a queued `pending_sync` event that the central store permanently rejects on sync (envelope or tagging validation failure, e.g. `INVALID_EVENT_ENVELOPE` or `UNTAGGED_TRANSACTION`)
**When** PowerSync processes the upload queue
**Then** the event moves to a visible "sync failed — needs attention" state on the device showing the server `error_code`, it leaves the pending count, and the remaining queue items continue syncing — no silently stuck queue

**Given** any screen of the PWA shell
**When** it is checked by the automated accessibility audit in CI plus manual keyboard-only and screen-reader passes
**Then** the shell meets WCAG 2.1 AA (NFR-U-02): full keyboard operability, visible focus indicators, minimum 4.5:1 text contrast, glove-friendly touch-target sizing, and connectivity/status indicators (e.g., "Working offline — syncing when connected") exposed to assistive technology as live regions; the automated accessibility check is a required status check for shell changes

**Given** the shell's i18n foundation (NFR-U-03)
**When** any user-facing string or server `error_code` is rendered
**Then** it resolves through the locale message catalog — no hard-coded user-facing literals in components, `error_code` values map to localized messages, and adding a locale requires only a new message catalog with no component change

**Requirements:** NFR-P-04 Tier 1 (24x7 offline-first edge capture with visible degraded state), NFR-U-01/02/03/04/05, AD-16. The accessibility and i18n standards established here bind every later module UI story.
~~~~

#### E1-12 — REPLACE in `epics.md`

**Findings addressed:** Q9: 1.9 untestable backlog-blocking clause; UX-2 (cross-ref): 1.9 presupposes the Story 1.10 pipeline

**Rationale:** Splits the conflated final AC into (a) a testable CI assertion — merges blocked by the required status check while a spine test fails — and (b) the sprint-backlog working agreement moved to a dev note, since branch protection cannot observe a sprint backlog; cross-references Story 1.10 as the pipeline owner.

**OLD:**

~~~~markdown
**And** failure of any single test blocks all module epic stories from entering the sprint backlog, enforced by a branch protection rule
~~~~

**NEW:**

~~~~markdown
**And** while any spine contract test is failing, every merge into a module code path is blocked by the required status check `spine-acceptance-contract` (branch protection configured in Story 1.10) — the CI assertion is the testable gate

**Dev note:** "no module epic story enters the sprint backlog while a spine contract test is red" is the team working agreement this gate operationalizes; sprint planning enforces the backlog half, the required status check enforces the merge half. The CI pipeline and branch protection rule themselves are built in Story 1.10.
~~~~

#### E1-13 — REPLACE in `epics.md`

**Findings addressed:** UX-2: Story 1.10 CI/CD Pipeline Construction; UX-3: Story 1.11 Notification & Alerting Foundation

**Rationale:** Adds the two Epic-1-owned foundation stories at the fixed numbers: Story 1.10 (CI/CD pipeline construction — build/test/deploy automation, branch protection, IaC bootstrap that Stories 1.1 and 1.9 presuppose) and Story 1.11 (notification & alerting foundation, architecturally homing the push/escalation capability that FR-P-04/UJ-IND-01, FR-M-04, FR-GP-09/10, and FR-JW-14 consume), inserted at the end of Epic 1 before the Epic 2 section heading. The anchor includes the preceding '---' to disambiguate from the '### Epic 2' epic-list heading.

**OLD:**

~~~~markdown
---

## Epic 2: Core Inventory and Multi-Location Stock Visibility
~~~~

**NEW:**

~~~~markdown
---

### Story 1.10: CI/CD Pipeline Construction

As a platform engineer,
I want an automated CI/CD pipeline (build, test, deploy) with branch protection and a version-controlled IaC bootstrap for the pipeline itself,
So that the deployment path Stories 1.1 and 1.9 presuppose exists as repeatable automation and no change reaches any environment except through the pipeline.

**Sequencing:** first work executed in Epic 1, alongside Story 1.1 — Story 1.1's "the IaC deployment pipeline runs" and Story 1.9's CI gate and branch protection presuppose this story's output.

**Acceptance Criteria:**

**Given** a commit pushed to any branch
**When** the CI pipeline runs
**Then** it builds the application, runs the automated test suites (unit, integration, and — once Story 1.9 lands — the Spine Acceptance Contract suite), and publishes the results as required status checks

**Given** a pull request into the main branch with any required status check failing
**When** a merge is attempted
**Then** the merge is blocked by branch protection with no administrator bypass, until the check passes

**Given** a merge into the main branch
**When** the CD stage runs
**Then** the build deploys to the staging environment through the IaC under `deploy/aws/` with zero manual steps, and promotion to production requires an explicit approval recorded with the approver's identity

**Given** a clean AWS account and the pipeline bootstrap IaC
**When** the bootstrap is executed
**Then** the pipeline itself (CI runners, artifact store, deployment roles) is provisioned entirely from version-controlled IaC — reproducible, never hand-built

**Requirements:** Additional Requirements (greenfield IaC, AWS deployment, `deploy/aws/`), NFR-E-04 (upgrades under 30 minutes); consumed by Stories 1.1 and 1.9

---

### Story 1.11: Notification and Alerting Foundation

As a platform engineer,
I want a shared notification and alerting service — in-app, web push, and escalating alerts with acknowledgment tracking — that every module consumes instead of inventing its own,
So that requisition decisions, fault reports, statutory window clocks, and gate-pass ageing all alert through one auditable channel and nothing expires or fails silently.

**Acceptance Criteria:**

**Given** a module emits a notification event targeting a role at a location
**When** the notification service processes it
**Then** it is delivered in-app and via web push to every user holding that role at that location, and each delivery (or delivery failure) is recorded with `trace_id`

**Given** an escalating alert definition (initial target, acknowledgment window, escalation target)
**When** the acknowledgment window elapses unacknowledged
**Then** the alert escalates to the escalation target — resolved via the DOA registry where the target is a role (AD-3) — and every hop is recorded; no alert expires silently

**Given** a target user's device is offline
**When** a notification is dispatched
**Then** it is queued and delivered on reconnection, and the in-app notification centre shows it with its original timestamp

**Given** the notification service is unavailable
**When** a module emits a notification event
**Then** the event is durably queued (never dropped) and delivered on recovery, and emission never blocks the emitting module's own write path

**Consumers:** FR-P-04 requisition push-notification decisions (UJ-IND-01, Story 4.3); FR-M-04 fault reports reaching the location's maintenance supervisor within 5 minutes (Epic 7); FR-JW-14 job-work statutory-window alerts with escalation (Epic 9); FR-GP-09/10 open-RGP ageing reminders and statutory/insurance window hard alerts (Phase 2, Epic 20); Epic 12 configurable exception alerts (FR-R). These epics consume this service — none builds its own notification channel.

---

## Epic 2: Core Inventory and Multi-Location Stock Visibility
~~~~


### Epic 2: Core Inventory and Multi-Location Stock Vi — 22 edits

#### E2-01 — REPLACE in `epics.md`

**Findings addressed:** Q1

**Rationale:** Story 2.1 AC3 triggered on putaway-task generation, which first exists in Epic 3 Stories 3.4/3.5 — a circular test dependency. Reworded to a location-attribute observable on any stock movement event (testable within Epic 2 via Story 2.2 and the new receipt-posting AC) with an explicit pointer to the Epic 3 consumer.

**OLD:**

~~~~markdown
**Given** a location is created with `zone_type: "hazmat"` and `temperature_class: "cold"`
**When** a putaway task targeting that location is generated for a non-hazmat item
**Then** the system raises a zone-compatibility warning before confirming the putaway
~~~~

**NEW:**

~~~~markdown
**Given** a location is created with `zone_type: "hazmat"` and `temperature_class: "cold"`
**When** any stock movement event attempts to place a non-hazmat item into that location
**Then** the movement response carries `warning_code: "ZONE_INCOMPATIBLE"` before the placement is confirmed, and the location's zone and temperature attributes are returned by `GET /api/v1/locations/{location_id}` — the attribute source consumed by directed putaway when Epic 3 (Story 3.5) delivers putaway tasks
~~~~

#### E2-02 — INSERT AFTER in `epics.md`

**Findings addressed:** Q10

**Rationale:** Adds the per-story FR traceability line so FR-to-story coverage is auditable, matching the inline-citation convention of Epics 4 and 5.

**ANCHOR (insert after):**

~~~~markdown
So that every subsequent transaction references validated items and locations and no stock movement posts against an undefined master.
~~~~

**NEW (inserted):**

~~~~markdown


**FRs:** FR-I-01 (item and location masters); location attributes feed FR-W-01 warehouse topology (Epic 3)
~~~~

#### E2-03 — INSERT AFTER in `epics.md`

**Findings addressed:** FR-I-09 partial

**Rationale:** FR-I-09 is mapped to Epic 2 in the coverage map but no story anywhere delivers kit assembly/disassembly transactions; assembly is at best implicit in Epic 6 and disassembly appears nowhere. This scope note records the assembly landing point explicitly and adds the rule-7 deferral note for disassembly rather than leaving the FR silently uncovered.

**ANCHOR (insert after):**

~~~~markdown
Consignment and VMI stock is segregated from owned inventory. Valuation is Ind AS 2 compliant (FIFO, weighted average, specific identification; LIFO structurally blocked).
~~~~

**NEW (inserted):**

~~~~markdown


**Scope note (FR-I-09):** Kit definitions are superseded by FR-B-02 — existing kits migrate as single-level production BOMs at go-live (Epic 5). Kit assembly transactions execute as production orders against Released BOMs (Epic 6, Stories 6.1-6.3), which must name kit-assembly orders explicitly. Kit disassembly transactions are delivered by no Phase-1 story — Deferred to Phase 2 (Epic 16): a disassembly posting that consumes one assembled kit unit and returns component lots to stock at Ind AS 2 cost with recovered-component condition codes. No Epic 2 story implements kit transactions; this note is the FR-I-09 coverage record.
~~~~

#### E2-04 — INSERT AFTER in `epics.md`

**Findings addressed:** Q10

**Rationale:** Per-story FR traceability line (see E2-02).

**ANCHOR (insert after):**

~~~~markdown
So that I can answer "what do we hold and where" without a phone call, at any moment.
~~~~

**NEW (inserted):**

~~~~markdown


**FRs:** FR-I-01
~~~~

#### E2-05 — INSERT AFTER in `epics.md`

**Findings addressed:** Q3

**Rationale:** No Epic 2 story created owned stock, so Stories 2.2-2.4 presupposed receipts that only Epics 3-4 deliver. This minimal owned-stock receipt-posting AC (referencing the Story 2.9 PO projection) makes the epic independently testable, as the event-sourced spine allows.

**ANCHOR (insert after):**

~~~~markdown
**Given** two concurrent writes attempt to allocate the last unit of a lot to two different orders
**When** both events are processed
**Then** exactly one allocation succeeds; the second returns `error_code: "INSUFFICIENT_STOCK"`
~~~~

**NEW (inserted):**

~~~~markdown


**Given** goods-receipt workflows do not yet exist (GRNs arrive with Epic 3 Story 3.4 and Epic 4 Story 4.5)
**When** an owned-stock receipt event referencing an open-PO line from the ERP inbound projection (Story 2.9) is posted directly via the stock-event API with `quantity`, `unit_cost`, `lot_id`, and location
**Then** on-hand at the target location increases by the received quantity, the PO line reference is recorded on the event, and the balances above are reproducible from directly posted receipt events — Epic 2 stories are testable without Epics 3-4
~~~~

#### E2-06 — INSERT AFTER in `epics.md`

**Findings addressed:** Q10

**Rationale:** Per-story FR traceability line (see E2-02).

**ANCHOR (insert after):**

~~~~markdown
So that a recall can be traced to all affected locations within 15 minutes and expired stock is never issued without an explicit override.
~~~~

**NEW (inserted):**

~~~~markdown


**FRs:** FR-I-04
~~~~

#### E2-07 — INSERT AFTER in `epics.md`

**Findings addressed:** Q6

**Rationale:** The story promises serial tracking end-to-end (FR-I-04) but every AC was lot-only. Adds the three missing serial paths: mandatory serial capture on issue (negative AC, SERIAL_REQUIRED), duplicate-serial rejection (DUPLICATE_SERIAL), and serial-level trace. New error codes are semantic and narrowly scoped; DUPLICATE_EVENT was not reused because it denotes idempotency-key replay, not a business-key collision.

**ANCHOR (insert after):**

~~~~markdown
**Given** a recall event is triggered for `LOT-2026-001`
**When** `GET /api/v1/lots/LOT-2026-001/trace` is called
**Then** the response lists every location the lot has been in, every transaction it appeared in, and its current balance per location — returned within the API p95 threshold of 500ms (NFR-P-05)
~~~~

**NEW (inserted):**

~~~~markdown


**Given** item `EQ-0500` is serial-controlled per its item master flag
**When** an issue transaction for `EQ-0500` is submitted without serial numbers
**Then** the write is rejected with `error_code: "SERIAL_REQUIRED"`

**Given** serial `SN-1001` of `EQ-0500` is already in stock
**When** a receipt event carrying the same serial `SN-1001` is posted
**Then** the write is rejected with `error_code: "DUPLICATE_SERIAL"` and the location currently holding that serial is returned

**Given** serial `SN-1001` has moved through receipt, inter-location transfer, and issue
**When** `GET /api/v1/serials/SN-1001/trace` is called
**Then** the response lists every transaction and location in that serial's history in sequence — returned within the API p95 threshold of 500ms (NFR-P-05)
~~~~

#### E2-08 — REPLACE in `epics.md`

**Findings addressed:** Q9; FR-I-05 partial

**Rationale:** The user-story line narrowed scope to FIFO/weighted-average, contradicting the epic goal and FR-I-05/FR-AC-05 which include specific identification and the standard-cost measurement technique. Widened to match the FR text; the new ACs in E2-11 make both testable.

**OLD:**

~~~~markdown
I want inventory valued using FIFO or weighted average (selectable per item) with LIFO structurally blocked and NRV testing run at period end,
~~~~

**NEW:**

~~~~markdown
I want inventory valued using FIFO, weighted average, or specific identification (selectable per item), with standard cost permitted only as an Ind AS 2 para 21 measurement technique, LIFO structurally blocked, and NRV testing run at period end,
~~~~

#### E2-09 — INSERT AFTER in `epics.md`

**Findings addressed:** Q10

**Rationale:** Per-story FR traceability line (see E2-02).

**ANCHOR (insert after):**

~~~~markdown
So that the stock ledger is Ind AS 2 compliant from the first transaction and no non-permitted valuation method can be applied.
~~~~

**NEW (inserted):**

~~~~markdown


**FRs:** FR-I-05, FR-AC-05, FR-AC-06
~~~~

#### E2-10 — REPLACE in `epics.md`

**Findings addressed:** Q3

**Rationale:** AC1 named 'multiple GRNs', an artifact first created in Epic 3 Story 3.4 / Epic 4 Story 4.5, making the AC untestable at Story 2.4 completion. Reworded to priced receipt events (per E2-05) referencing the Story 2.9 PO projection, with GRNs as the later source.

**OLD:**

~~~~markdown
**Given** item `RM-0042` is configured with `valuation_method: "weighted_average"`
**When** stock is received at varying prices across multiple GRNs
**Then** the running weighted average cost updates after each receipt and is queryable via `GET /api/v1/stock/RM-0042/valuation`
~~~~

**NEW:**

~~~~markdown
**Given** item `RM-0042` is configured with `valuation_method: "weighted_average"`
**When** receipt events are posted at varying unit costs (e.g., 10, 12, then 14) — directly via the stock-event API against open-PO line projections (Story 2.9) within Epic 2, or from GRNs once Epics 3-4 deliver receiving
**Then** the running weighted average cost updates after each receipt and is queryable via `GET /api/v1/stock/RM-0042/valuation`
~~~~

#### E2-11 — INSERT AFTER in `epics.md`

**Findings addressed:** Q9; FR-I-05 partial

**Rationale:** Specific identification was promised by the epic goal, FR-I-05, and FR-AC-05 but implemented and tested nowhere — and the VALUATION_METHOD_NOT_PERMITTED pattern left it ambiguous whether it would even be accepted. Adds a worked specific-identification AC and the standard-cost-as-measurement-technique AC (with the existing error code on the negative path).

**ANCHOR (insert after):**

~~~~markdown
**Given** NRV testing is run and an item's net realisable value has fallen below cost
**When** the NRV write-down event is posted
**Then** the item's carrying value is reduced to NRV, the write-down is recorded with date and authoriser, and any subsequent recovery is capped at original cost (FR-AC-06)
~~~~

**NEW (inserted):**

~~~~markdown


**Given** item `EQ-0500` is serial-controlled with `valuation_method: "specific_identification"`, serial `SN-1001` received at unit cost 12,000 and serial `SN-1002` received at unit cost 13,500 (FR-I-05, FR-AC-05)
**When** an issue transaction for serial `SN-1002` is posted
**Then** the issue cost is exactly 13,500 — the received cost of the specific serial issued — and the remaining carrying value for `EQ-0500` is 12,000

**Given** an administrator configures standard cost for an item (FR-I-05)
**When** the configuration is submitted
**Then** standard cost is accepted only as an Ind AS 2 para 21 measurement technique: the configuration must carry a variance-review cadence, the period-end valuation report shows standard-vs-actual variance per item with breaches of the configured tolerance flagged for review, and an attempt to set `valuation_method: "standard_cost"` without the measurement-technique designation is rejected with `error_code: "VALUATION_METHOD_NOT_PERMITTED"`
~~~~

#### E2-12 — INSERT AFTER in `epics.md`

**Findings addressed:** Q10

**Rationale:** Per-story FR traceability line (see E2-02).

**ANCHOR (insert after):**

~~~~markdown
So that stock moves between sites on an auditable chain of events with no quantity or lot leakage.
~~~~

**NEW (inserted):**

~~~~markdown


**FRs:** FR-I-02
~~~~

#### E2-13 — REPLACE in `epics.md`

**Findings addressed:** Q4

**Rationale:** AC1 put stock in_transit at submission (pre-approval, pre-ship) while AC2 created the in-transit record only at the ship event — a direct contradiction that also corrupted the in_transit balance semantics of Story 2.2. Resolved to the plausible intent: allocation at submission, in_transit at ship.

**OLD:**

~~~~markdown
**Given** a transfer request from `site-A` to `site-B` for 50 units of `RM-0042`, lot `LOT-2026-001`
**When** the request is submitted
**Then** the 50 units show as `in_transit` from `site-A`; the available balance at `site-A` decreases immediately; the request is routed for approval via the DOA registry
~~~~

**NEW:**

~~~~markdown
**Given** a transfer request from `site-A` to `site-B` for 50 units of `RM-0042`, lot `LOT-2026-001`
**When** the request is submitted
**Then** the 50 units show as `allocated` at `site-A`; the available balance at `site-A` decreases immediately while on-hand and in-transit are unchanged; the request is routed for approval via the DOA registry — stock enters `in_transit` only when the ship event posts
~~~~

#### E2-14 — INSERT AFTER in `epics.md`

**Findings addressed:** Q5

**Rationale:** An approval-gated enforcement flow had only the happy path despite the 'no quantity or lot leakage' promise. Adds the three missing negative paths: ship-before-approval (reusing APPROVAL_REQUIRED), over-quantity ship (QUANTITY_EXCEEDS_APPROVED), and lot-mismatch receive (LOT_MISMATCH) — new codes added sparingly where no architecture code fits.

**ANCHOR (insert after):**

~~~~markdown
**Given** the receive event is posted at `site-B`
**When** the transaction is processed
**Then** `site-B` on-hand increases by 50 with `lot_id: "LOT-2026-001"` preserved; the in-transit balance clears; both ship and receive events carry the same `correlation_id`
~~~~

**NEW (inserted):**

~~~~markdown


**Given** a transfer request that has not been approved via the DOA registry
**When** a ship event for that transfer is posted
**Then** the write is rejected with `error_code: "APPROVAL_REQUIRED"` and no stock moves to `in_transit`

**Given** a transfer approved for 50 units
**When** a ship event for 60 units is posted
**Then** the write is rejected with `error_code: "QUANTITY_EXCEEDS_APPROVED"` and the approved quantity is returned to the caller

**Given** the ship event carried `lot_id: "LOT-2026-001"`
**When** a receive event at `site-B` references `lot_id: "LOT-2026-002"`
**Then** the write is rejected with `error_code: "LOT_MISMATCH"` and the in-transit record stays open until a matching receive or an approved discrepancy resolution posts
~~~~

#### E2-15 — INSERT AFTER in `epics.md`

**Findings addressed:** Q10

**Rationale:** Per-story FR traceability line (see E2-02).

**ANCHOR (insert after):**

~~~~markdown
So that inventory accuracy stays at or above 98% (SM-01) and physical verification evidence is a byproduct of operations, not a year-end project.
~~~~

**NEW (inserted):**

~~~~markdown


**FRs:** FR-I-06
~~~~

#### E2-16 — REPLACE in `epics.md`

**Findings addressed:** Q7

**Rationale:** 'In a format suitable for CARO 2020 clause 3(i) evidence' was a judgment, not an observable. Enumerates the required evidence fields, asserts immutability after period lock, and anchors the compliance obligation to its concrete home (Epic 11, FR-AC-15).

**OLD:**

~~~~markdown
**Given** a period-end physical inventory verification is complete
**When** `GET /api/v1/physical-verification/report` is called with location and date filters
**Then** the response includes count sheets, variances, and adjustment records in a format suitable for CARO 2020 clause 3(i) evidence
~~~~

**NEW:**

~~~~markdown
**Given** a period-end physical inventory verification is complete
**When** `GET /api/v1/physical-verification/report` is called with location and date filters
**Then** the response includes, per count: count date, counter and approver identities, location coverage percentage, book versus counted quantity per SKU and lot, variance quantity and value, adjustment event reference, and management sign-off status — the evidence fields consumed by the CARO 2020 clause 3(i) sign-off artifact (Epic 11, FR-AC-15) — and report records are immutable once the period is locked
~~~~

#### E2-17 — INSERT AFTER in `epics.md`

**Findings addressed:** Q10; FR-I-08 partial

**Rationale:** Per-story FR traceability line (see E2-02), with the FR-I-08 partial-coverage state made explicit.

**ANCHOR (insert after):**

~~~~markdown
So that stockouts are reduced by 40% within 12 months (SM-02) and no slow-moving stock ages silently into write-off exposure.
~~~~

**NEW (inserted):**

~~~~markdown


**FRs:** FR-I-03, FR-I-07, FR-I-08 (flagging and NRV trigger; disposition feed deferred — see note below)
~~~~

#### E2-18 — REPLACE in `epics.md`

**Findings addressed:** Q8

**Rationale:** AC1 restated the story title with no formula, expected value, or lead-time source — two wildly different implementations would both pass. States the formula with a worked numeric expected value and names the SKU-location lead-time field as the declared input (source defined in E2-19).

**OLD:**

~~~~markdown
**Given** an item with 90 days of demand history and a configured service level of 95%
**When** the safety stock computation runs
**Then** the safety stock quantity is derived from lead-time demand variability at the target service level and stored against the SKU-location combination with the computation date
~~~~

**NEW:**

~~~~markdown
**Given** an item with 90 days of demand history showing a daily-demand standard deviation of 4 units, `lead_time_days: 9` on the SKU-location record, and a configured service level of 95%
**When** the safety stock computation runs
**Then** the stored safety stock equals `z(0.95) × σ_daily × √lead_time_days` = 1.645 × 4 × 3 = 19.74, rounded up to 20 units, stored against the SKU-location combination with the computation date and the input parameters used (FR-I-07)
~~~~

#### E2-19 — INSERT AFTER in `epics.md`

**Findings addressed:** Q8; FR-I-08 partial

**Rationale:** Two notes: (1) defines the pilot-viable lead-time data source that FR-I-07 needs before Epic 4 exists (second prong of the safety-stock finding); (2) rule-7 explicit deferral note for the FR-I-08 'feeding disposition' clause stranded on Phase-2 Epic 16, with defined interim behavior instead of silence.

**ANCHOR (insert after):**

~~~~markdown
**Given** an item has had zero issues for longer than the configured obsolescence threshold (e.g., 180 days)
**When** the obsolescence flag job runs
**Then** the item is marked `aging` in the read model, appears in the obsolescence exception report, and NRV testing is triggered (FR-AC-06)
~~~~

**NEW (inserted):**

~~~~markdown


**Note (lead-time source):** Until Epic 4 delivers measured PO-to-receipt lead times, `lead_time_days` is maintained per SKU-location — seeded manually or derived from expected dates on open-PO projections (Story 2.9) — and each computation records which source was used.

**Note (FR-I-08 disposition feed):** Deferred to Phase 2 (Epic 16): routing of flagged aging/obsolete stock into the scrap/disposition workflow (FR-SC-01). Phase-1 interim behavior: flagged items carry `disposition_status: "pending_disposition"`, remain visible in the obsolescence exception report, and NRV testing (FR-AC-06) still applies — no stock leaves the ledger until Epic 16 delivers disposition.
~~~~

#### E2-20 — INSERT AFTER in `epics.md`

**Findings addressed:** Q10

**Rationale:** Per-story FR traceability line (see E2-02).

**ANCHOR (insert after):**

~~~~markdown
So that consignment stock never appears in our balance sheet and VMI replenishment signals route to the correct owner.
~~~~

**NEW (inserted):**

~~~~markdown


**FRs:** FR-I-10
~~~~

#### E2-21 — REPLACE in `epics.md`

**Findings addressed:** Q2; Q11

**Rationale:** Three fixes in one contiguous block: (1) AC3 restated as an observable generated-signal record with an addressee field, deferring supplier-channel transmission to Epic 4 Story 4.1 (which is pilot-skipped); (2) new AC proving the balance-sheet promise — consignment units carry zero owned value in the valuation endpoint; (3) negative path for consignment over-issue reusing INSUFFICIENT_STOCK scoped by stock class; plus a note defining where supplier references and VMI minimums live before Epic 4, reconciling with Story 2.1's no-undefined-master philosophy via the Story 2.9 projection.

**OLD:**

~~~~markdown
**Given** VMI stock for `RM-0099` falls below the agreed VMI minimum
**When** the VMI check runs
**Then** a replenishment signal is generated addressed to the VMI supplier, not a standard internal purchase requisition
~~~~

**NEW:**

~~~~markdown
**Given** VMI stock for `RM-0099` falls below the agreed VMI minimum
**When** the VMI check runs
**Then** a replenishment event with `signal_type: "vmi_replenishment"` carrying the owner-party supplier reference is generated and visible in the replenishment exception queue — not a standard internal purchase requisition; transmission to the supplier channel arrives with the supplier registry (Epic 4, Story 4.1)

**Given** 100 consignment units and 40 owned units of `RM-0099` are on hand
**When** `GET /api/v1/stock/RM-0099/valuation` is called
**Then** the carrying value covers only the 40 owned units; the 100 consignment units contribute zero to owned inventory value and are reported in a separate consignment quantity section

**Given** consignment on-hand for `RM-0099` is 100 units
**When** an issue with `stock_class: "consignment"` for 120 units is submitted
**Then** the write is rejected with `error_code: "INSUFFICIENT_STOCK"` scoped to the consignment stock class — owned stock is never drawn to cover a consignment shortfall

**Note (owner-party references before Epic 4):** Supplier references on consignment and VMI records are owner-party codes validated against supplier references appearing on ERP inbound projections (Story 2.9) — not free text. VMI agreement minimums are SKU-location configuration owned by this story; the governed supplier registry (Epic 4, Story 4.1) supersedes these codes without renumbering them.
~~~~

#### E2-22 — REPLACE in `epics.md`

**Findings addressed:** D1; Q3

**Rationale:** Decision D1: new Story 2.9 delivering read-only ERP inbound reference projections — open POs with line tolerances and sales orders as the Phase-1 outbound-demand and PO-reference source for all other epics. Covers header+line fields, sync freshness with staleness flagging, the standard error envelope on sync failures, a read-only enforcement negative AC (SOURCE_SYSTEM_READ_ONLY), and the explicit ERP-remains-master note (INT-ERP-01). Inserted at the end of Epic 2 before the Epic 3 heading; the heading is re-emitted verbatim so no other content changes.

**OLD:**

~~~~markdown
---

## Epic 3: Warehouse Operations and Frontline Capture Flows
~~~~

**NEW:**

~~~~markdown
---

### Story 2.9: ERP Inbound Reference Projections

As a stock controller or planner,
I want read-only projections of ERP open purchase orders (headers and lines with quantity, price, and receipt-tolerance fields) and open sales orders (dispatch demand) synced into the platform on a defined freshness cadence,
So that receiving, replenishment, job-work, and dispatch flows have a defined Phase-1 source for PO reference data and outbound demand while ERP remains the master (INT-ERP-01) and order management (Epic 15) does not yet exist.

**FRs:** INT-ERP-01 (reference projections; ERP remains master). Consumed by FR-W-02 receiving against PO (Epic 3), FR-I-03 replenishment context (Story 2.7), the Phase-1 outbound-demand source (Epics 3, 9, 11), and three-way match inputs (Epic 4).

**Acceptance Criteria:**

**Given** ERP holds open purchase order `PO-2026-0042` with two lines, each carrying ordered quantity, unit price, and over/under-receipt tolerance percentages
**When** the inbound sync runs
**Then** `GET /api/v1/erp/purchase-orders/PO-2026-0042` returns a read-only projection with header fields (supplier reference, currency, expected delivery date) and per-line `sku`, `ordered_qty`, `open_qty`, `unit_price`, `over_receipt_tolerance_pct`, `under_receipt_tolerance_pct`, each stamped `source_system: "ERP"` with a `last_synced_at` timestamp

**Given** ERP holds open sales orders with required-by dates and ship-from sites
**When** `GET /api/v1/erp/sales-orders?site=site-A&status=open` is called
**Then** the response lists dispatch-demand lines (`sku`, `quantity`, `required_by`, `ship_to`) — the Phase-1 outbound-demand source referenced by pick, dispatch, and IRN flows (Epics 3, 9, 11)

**Given** the inbound sync has not completed within the configured freshness threshold (default 15 minutes)
**When** any projection is queried
**Then** the response carries `stale: true` with the age of `last_synced_at`, and a sync-failure alert is raised to the integration exception queue

**Given** a client attempts to create, update, or delete a purchase-order or sales-order projection through the platform API
**When** the write is processed
**Then** it is rejected with `error_code: "SOURCE_SYSTEM_READ_ONLY"` — corrections are made in ERP and arrive on the next sync

**Given** a sync batch contains a malformed record (e.g., a PO line referencing an unknown SKU)
**When** the batch is processed
**Then** the malformed record is routed to the integration exception queue with the standard error envelope (stable `error_code`, source record reference, reason), and the remaining records in the batch sync successfully — no batch-level abort

**Note (reference data, not a procurement module):** These projections are reference data only — ERP remains the master for PO and sales-order lifecycle (INT-ERP-01). Nothing in this platform mutates PO or sales-order state; receipts recorded against a projected PO line (Story 2.2, Epics 3-4) never write back to the projection. Epic 4 builds procurement workflows on top of these projections; Epics 3, 9, and 11 reference Story 2.9 for PO data and dispatch-order demand.

---

## Epic 3: Warehouse Operations and Frontline Capture Flows
~~~~


### Epic 3: Warehouse Operations and Frontline Capture — 12 edits

#### E3-01 — REPLACE in `epics.md`

**Findings addressed:** C1; C2; C3

**Rationale:** Declares the resolved dependency direction at the epic level: the E3-E4 circular dependency (C1) and the missing Phase-1 outbound-demand source (C2, C3) are both resolved by binding against Story 2.9 projections, which lives in Epic 2 — already a declared dependency.

**OLD:**

~~~~markdown
**Depends on:** Epics 1, 2

**Note:** Edge PWA shell is operational from Epic 1. Epic 3 stories build the gate, weighbridge, putaway, and task flows on that platform — no ground-up PWA work here.
~~~~

**NEW:**

~~~~markdown
**Depends on:** Epics 1, 2 — including Story 2.9 (ERP Inbound Reference Projections), which supplies the read-only open-PO projections (with line tolerances) that Stories 3.2-3.4 bind against and the sales-order projections that provide Phase-1 outbound demand for Stories 3.6, 3.7, and 3.10. No Epic 4 PO-creation capability is required by any Epic 3 story.

**Note:** Edge PWA shell is operational from Epic 1. Epic 3 stories build the gate, weighbridge, putaway, and task flows on that platform — no ground-up PWA work here.
~~~~

#### E3-02 — REPLACE in `epics.md`

**Findings addressed:** major: 3.7 FR-W-06 sub-capabilities + consignee; FR-W-06 partial

**Rationale:** Corrects the epic-level coverage claim: FR-W-06 sub-capabilities (customs docs, rate shopping, load planning) have no Phase-1 story and belong with the Epic 15 logistics scope; the epic header must not claim them in full.

**OLD:**

~~~~markdown
**FRs covered:** FR-W-01, FR-W-02, FR-W-03, FR-W-04, FR-W-05, FR-W-06, FR-W-07, FR-W-08, FR-W-09
~~~~

**NEW:**

~~~~markdown
**FRs covered:** FR-W-01, FR-W-02, FR-W-03, FR-W-04, FR-W-05, FR-W-06 (partial — customs documentation, carrier rate shopping, and load planning are deferred to Phase 2 / Epic 15), FR-W-07, FR-W-08, FR-W-09
~~~~

#### E3-03 — REPLACE in `epics.md`

**Findings addressed:** major: 3.7 FR-W-06 sub-capabilities + consignee; FR-W-06 partial

**Rationale:** Keeps the global FR coverage map consistent with the corrected Epic 3 header claim on FR-W-06.

**OLD:**

~~~~markdown
| FR-W-01 to FR-W-09 | Epic 3: Warehouse Operations and Frontline Capture Flows | Phase 1 |
~~~~

**NEW:**

~~~~markdown
| FR-W-01 to FR-W-09 (FR-W-06 partial: customs docs, carrier rate shopping, load planning deferred to Epic 15, Phase 2) | Epic 3: Warehouse Operations and Frontline Capture Flows | Phase 1 |
~~~~

#### E3-04 — REPLACE in `epics.md`

**Findings addressed:** major: 3.1/3.3 intra-epic ordering; minor: FR-W traceability citations; FR-W-03 partial

**Rationale:** Rewords 3.1 AC2 and AC3 to outcomes observable when 3.1 completes (a location API read; a location-service write rejection) instead of preconditioning on putaway tasks that Stories 3.4/3.5 build later. Adds a size-class attribute to the bin response so Story 3.5's FR-W-03 size criterion has a data source, and adds the missing FR-W-01 citation.

**OLD:**

~~~~markdown
### Story 3.1: Warehouse Topology Setup

As a warehouse manager,
I want to define and manage the warehouse topology (sites, zones, aisles, racks, bins) with temperature, hazmat, and quarantine zone attributes,
So that every putaway task, pick path, and location override references a real, validated physical location in the system.

**Acceptance Criteria:**

**Given** a warehouse manager creates a zone `ZONE-COLD` with `temperature_class: "cold"` at `site-A`
**When** `GET /api/v1/locations?site=site-A` is called
**Then** `ZONE-COLD` appears in the response with its zone type and temperature class

**Given** a bin `BIN-A43` is created under aisle `AISLE-A`, rack `RACK-4`, zone `ZONE-AMBIENT`
**When** a putaway task is generated for a lot
**Then** the directed putaway suggestion can reference `BIN-A43` with its full hierarchy path

**Given** a quarantine zone `ZONE-QC-HOLD` is marked `access_restricted: true`
**When** a putaway task targets `ZONE-QC-HOLD` for a user without the `qc_inspector` role
**Then** the system rejects the putaway with `error_code: "ZONE_ACCESS_RESTRICTED"`
~~~~

**NEW:**

~~~~markdown
### Story 3.1: Warehouse Topology Setup (FR-W-01)

As a warehouse manager,
I want to define and manage the warehouse topology (sites, zones, aisles, racks, bins) with temperature, hazmat, and quarantine zone attributes,
So that every putaway task, pick path, and location override references a real, validated physical location in the system.

**Acceptance Criteria:**

**Given** a warehouse manager creates a zone `ZONE-COLD` with `temperature_class: "cold"` at `site-A`
**When** `GET /api/v1/locations?site=site-A` is called
**Then** `ZONE-COLD` appears in the response with its zone type and temperature class (FR-W-01)

**Given** a bin `BIN-A43` is created under aisle `AISLE-A`, rack `RACK-4`, zone `ZONE-AMBIENT`
**When** `GET /api/v1/locations/BIN-A43` is called
**Then** the response returns the bin with its full hierarchy path (`site-A > ZONE-AMBIENT > AISLE-A > RACK-4 > BIN-A43`) and its attributes (size class, temperature class, hazmat flag) — verifiable at this story's completion; putaway-task consumption of the path is exercised in Stories 3.4/3.5 (FR-W-01)

**Given** a quarantine zone `ZONE-QC-HOLD` is marked `access_restricted: true`
**When** any location-assignment write targeting `ZONE-QC-HOLD` is attempted by a user without the `qc_inspector` role
**Then** the system rejects the write with `error_code: "ZONE_ACCESS_RESTRICTED"` — the rule is enforced at the location service, so putaway tasks built in Stories 3.4/3.5 inherit it without re-implementation
~~~~

#### E3-05 — REPLACE in `epics.md`

**Findings addressed:** C1; minor: FR-W traceability citations

**Rationale:** Resolves the C1 forward dependency for 3.2: the PO the gate binds against is now explicitly the Story 2.9 read-only open-PO projection (locally synced for offline scanning), not an Epic 4 PO record. Adds the Depends-on-Story-2.9 note and the missing FR-W-02 citation.

**OLD:**

~~~~markdown
### Story 3.2: Gate Event Capture and Vehicle-to-PO Binding (UJ-GATE-01)

As a gate officer,
I want to log an inbound vehicle by scanning or keying a PO reference and photographing the challan — even with no network — and have the system create a traceable gate event that auto-reconciles on reconnection,
So that every goods entry is on a traceable record from the first second, a vehicle with no matching PO is captured as "unmatched" rather than turned away, and nothing is lost to a network outage.

**Acceptance Criteria:**

**Given** a gate officer opens the edge PWA offline and scans PO `PO-2026-0441`
**When** the gate event is submitted
**Then** a gate event is stored locally with status `pending_sync`, the officer sees "Captured — pending sync", and a vehicle-to-PO binding token is created locally with the gate_id, officer_id, and timestamp (AD-2)

**Given** the device reconnects
**When** PowerSync syncs the gate event to the central event store
**Then** the event auto-reconciles to `PO-2026-0441`; the binding token is visible to downstream weighbridge and receiving flows within 30 seconds
~~~~

**NEW:**

~~~~markdown
### Story 3.2: Gate Event Capture and Vehicle-to-PO Binding (UJ-GATE-01, FR-W-02)

As a gate officer,
I want to log an inbound vehicle by scanning or keying a PO reference and photographing the challan — even with no network — and have the system create a traceable gate event that auto-reconciles on reconnection,
So that every goods entry is on a traceable record from the first second, a vehicle with no matching PO is captured as "unmatched" rather than turned away, and nothing is lost to a network outage.

**Depends on Story 2.9 (ERP Inbound Reference Projections):** PO references scanned at the gate resolve against the read-only open-PO projection synced from the ERP — no Epic 4 PO-creation capability is required.

**Acceptance Criteria:**

**Given** a gate officer opens the edge PWA offline and scans PO `PO-2026-0441`, which exists in the locally synced open-PO projection (Story 2.9)
**When** the gate event is submitted
**Then** a gate event is stored locally with status `pending_sync`, the officer sees "Captured — pending sync", and a vehicle-to-PO binding token is created locally with the gate_id, officer_id, and timestamp (AD-2)

**Given** the device reconnects
**When** PowerSync syncs the gate event to the central event store
**Then** the event auto-reconciles to `PO-2026-0441` in the Story 2.9 open-PO projection; the binding token is visible to downstream weighbridge and receiving flows within 30 seconds
~~~~

#### E3-06 — REPLACE in `epics.md`

**Findings addressed:** C1; major: 3.1/3.3 intra-epic ordering; minor: FR-W traceability citations

**Rationale:** Resolves the C1 forward dependency for 3.3 (PO-line tolerance now sourced from the Story 2.9 projection) and the intra-epic ordering defect in AC2: the accepted weight is asserted as a queryable record on the binding token, not as a post to the goods-receipt event that Story 3.4 builds later. Adds the Depends-on note and FR-W-02 citation.

**OLD:**

~~~~markdown
### Story 3.3: Weighbridge Event Capture and Tolerance Enforcement (UJ-WEIGH-01)

As a weighbridge operator,
I want to record tare and gross weights against the vehicle-to-PO binding token and have net weight auto-calculated and validated against tolerance, with out-of-tolerance loads blocked from silent receipt,
So that every goods receipt carries a trusted, auditable weight and no variance slips through unreviewed.

**Acceptance Criteria:**

**Given** the vehicle-to-PO binding token from Story 3.2 is active
**When** the operator records `tare: 12000 kg` and `gross: 15500 kg`
**Then** net weight auto-calculates as 3500 kg; the event carries the token reference, device_id, timestamp, and `capture_method: "MANUAL"`

**Given** the net weight falls within the configured tolerance for the PO line (e.g., +/- 2%)
**When** the weighbridge event is confirmed
**Then** the weight posts to the goods-receipt event with `status: "accepted"` and feeds the receiving flow
~~~~

**NEW:**

~~~~markdown
### Story 3.3: Weighbridge Event Capture and Tolerance Enforcement (UJ-WEIGH-01, FR-W-02)

As a weighbridge operator,
I want to record tare and gross weights against the vehicle-to-PO binding token and have net weight auto-calculated and validated against tolerance, with out-of-tolerance loads blocked from silent receipt,
So that every goods receipt carries a trusted, auditable weight and no variance slips through unreviewed.

**Depends on Story 2.9 (ERP Inbound Reference Projections):** the tolerance applied to net weight is the line tolerance carried on the read-only open-PO projection — no Epic 4 PO configuration is required.

**Acceptance Criteria:**

**Given** the vehicle-to-PO binding token from Story 3.2 is active
**When** the operator records `tare: 12000 kg` and `gross: 15500 kg`
**Then** net weight auto-calculates as 3500 kg; the event carries the token reference, device_id, timestamp, and `capture_method: "MANUAL"`

**Given** the net weight falls within the line tolerance carried on the Story 2.9 open-PO projection for that PO line (e.g., +/- 2%)
**When** the weighbridge event is confirmed
**Then** the weighbridge event is recorded with `status: "accepted"` and the accepted weight is queryable against the binding token — available for the Story 3.4 receiving flow to consume when it lands, without asserting Story 3.4 behavior here
~~~~

#### E3-07 — REPLACE in `epics.md`

**Findings addressed:** C1; major: 3.4 ASN + negative paths; minor: 3.4/3.7 QC integration testability; minor: FR-W traceability citations

**Rationale:** Resolves C1 for 3.4 (PO validation binds to the Story 2.9 projection), closes the ASN half of FR-W-02 with a minimal INT-SUP-02 ASN intake in scope plus an ASN-path AC, adds the missing negative paths (over-receipt beyond tolerance with new semantic code RECEIPT_TOLERANCE_EXCEEDED, short receipt within tolerance, expired-at-receipt lot reusing LOT_EXPIRED and APPROVAL_REQUIRED), and defines the interim audited manual release for BIS-flagged receipts pending Epic 8's disposition flow. Adds the FR-W-02 citation.

**OLD:**

~~~~markdown
### Story 3.4: Goods Receiving Against ASN or PO

As a receiving store assistant,
I want to receive goods against an ASN or PO — capturing lot/serial numbers, expiry dates, and QC capture flags — and have the system generate putaway tasks automatically,
So that every item enters stock on a complete, traceable receiving record and the putaway queue is ready before the truck is unloaded.

**Acceptance Criteria:**

**Given** the weighbridge token is accepted and the receiving flow opens for `PO-2026-0441`
**When** the store assistant scans each carton's barcode and enters lot and expiry details
**Then** a GRN line is created per item with `lot_id`, `expiry_date`, `received_qty`, and the weighbridge token reference; putaway tasks are generated for each line

**Given** a received item has a BIS licence flag on its item master
**When** the GRN line is confirmed
**Then** a QC inspection task is created for that line before the putaway task is released (FR-Q-02 integration point; QC stories are in Epic 8)

**Given** the operator scans a barcode that does not match the PO line item
**When** the GRN line is attempted
**Then** the system rejects it with `error_code: "ITEM_PO_MISMATCH"` and prompts for confirmation or escalation
~~~~

**NEW:**

~~~~markdown
### Story 3.4: Goods Receiving Against ASN or PO (FR-W-02)

As a receiving store assistant,
I want to receive goods against an ASN or PO — capturing lot/serial numbers, expiry dates, and QC capture flags — and have the system generate putaway tasks automatically,
So that every item enters stock on a complete, traceable receiving record and the putaway queue is ready before the truck is unloaded.

**Depends on Story 2.9 (ERP Inbound Reference Projections):** receiving validates items, quantities, and tolerances against the read-only open-PO projection — no Epic 4 PO-creation capability is required.

**Scope note:** this story includes a minimal supplier ASN intake (INT-SUP-02): an inbound API/EDI endpoint that stores ASN header and lines referencing an open PO on the Story 2.9 projection. Supplier portal and full EDI onboarding remain Phase 2.

**Acceptance Criteria:**

**Given** the weighbridge token is accepted and the receiving flow opens for `PO-2026-0441` from the Story 2.9 open-PO projection
**When** the store assistant scans each carton's barcode and enters lot and expiry details
**Then** a GRN line is created per item with `lot_id`, `expiry_date`, `received_qty`, and the weighbridge token reference; putaway tasks are generated for each line (FR-W-02)

**Given** a supplier ASN captured via the minimal ASN intake (INT-SUP-02) references open PO `PO-2026-0441` on the Story 2.9 projection
**When** the store assistant opens the receiving flow against the ASN
**Then** expected lines (item, quantity, lot/serial where advised) pre-populate from the ASN, and each confirmed GRN line records `source_document: "ASN"` alongside the PO reference (FR-W-02 ASN path)

**Given** a received item has a BIS licence flag on its item master
**When** the GRN line is confirmed
**Then** a QC inspection task is created for that line before the putaway task is released (FR-Q-02 integration point; QC stories are in Epic 8, built alongside Epic 3 in the pilot slice); until the Epic 8 disposition flow lands, an authorized supervisor may manually release the held putaway task, and the manual release is audited with operator identity and reason code

**Given** the operator scans a barcode that does not match any line item of `PO-2026-0441` on the Story 2.9 projection
**When** the GRN line is attempted
**Then** the system rejects it with `error_code: "ITEM_PO_MISMATCH"` and prompts for confirmation or escalation

**Given** the received quantity on a GRN line exceeds the PO line quantity beyond the line tolerance carried on the Story 2.9 projection
**When** the GRN line is submitted
**Then** the system rejects it with `error_code: "RECEIPT_TOLERANCE_EXCEEDED"` and routes a discrepancy task to the named receiving owner — no stock enters the ledger for the rejected line

**Given** the received quantity is short of the PO line quantity but within the line tolerance
**When** the GRN line is confirmed
**Then** the line posts with the received quantity, the shortage variance is flagged on the GRN and visible in the receiving discrepancy view, and the PO line shows an open remaining balance against the Story 2.9 projected quantity (the ERP remains the PO system of record)

**Given** the store assistant enters an `expiry_date` earlier than the receiving date
**When** the GRN line is submitted
**Then** the system rejects it with `error_code: "LOT_EXPIRED"`; the line may only be captured as a quarantined receipt into `ZONE-QC-HOLD` with supervisor approval — an attempt without that approval is rejected with `error_code: "APPROVAL_REQUIRED"`
~~~~

#### E3-08 — REPLACE in `epics.md`

**Findings addressed:** FR-W-03 partial; minor: 3.5 re-slotting engine; minor: FR-W traceability citations

**Rationale:** Closes the FR-W-03 size-criterion gap with an explicit size-based exclusion AC (fed by the size-class attribute added to Story 3.1), and fixes the re-slotting-engine explicitness defect: a scope note plus reworded AC3 make clear the velocity classification and re-slotting job are built by 3.5, not presumed to exist. Adds the FR-W-03 citation.

**OLD:**

~~~~markdown
### Story 3.5: Directed Putaway and Location Override Recording (UJ-PUT-01)

As a store assistant,
I want the system to direct me to the best bin for each received lot and let me scan the actual bin I used — recording any override as an authoritative correction event with a reason code,
So that every physical location is reflected in the system, my real-world knowledge improves the directed suggestions for the whole team, and last-writer-wins is never applied to location.

**Acceptance Criteria:**

**Given** a putaway task exists for 50 kg of `RM-0042` in `ZONE-AMBIENT`
**When** the store assistant opens the task on the edge PWA
**Then** the system displays a directed bin suggestion (e.g., `BIN-A43`) based on velocity class, zone rules, and current occupancy

**Given** the store assistant scans `BIN-A47` instead of the suggested `BIN-A43`
**When** the scan is confirmed with reason code `"better_space_available"`
**Then** a `location.override` event is recorded with the asserted location `BIN-A47`, the expected location `BIN-A43`, the reason code, and the operator identity; `BIN-A47` becomes the authoritative current location

**Given** multiple override events for the same bin cluster within 30 days
**When** the ABC re-slotting engine runs
**Then** the directed putaway suggestion for that item is updated to reflect the operator's preferred bin — the override improves the suggestion for the whole team (NFR-ADOPT-01)

**Given** the store assistant is offline when completing the putaway
**When** the override event is synced
**Then** it replays in the correct sequence relative to other events for the same lot, and the location projection is updated exactly once
~~~~

**NEW:**

~~~~markdown
### Story 3.5: Directed Putaway and Location Override Recording (UJ-PUT-01, FR-W-03)

As a store assistant,
I want the system to direct me to the best bin for each received lot and let me scan the actual bin I used — recording any override as an authoritative correction event with a reason code,
So that every physical location is reflected in the system, my real-world knowledge improves the directed suggestions for the whole team, and last-writer-wins is never applied to location.

**Scope note:** this story builds the velocity-classification capability (ABC classes derived from pick/putaway frequency) and the override-driven re-slotting job — they are deliverables of 3.5, not pre-existing infrastructure.

**Acceptance Criteria:**

**Given** a putaway task exists for 50 kg of `RM-0042` in `ZONE-AMBIENT`
**When** the store assistant opens the task on the edge PWA
**Then** the system displays a directed bin suggestion (e.g., `BIN-A43`) based on velocity class, item size class against bin size class, zone rules, and current occupancy (FR-W-03)

**Given** a received lot carries size class `LARGE` and `BIN-A43` carries size class `SMALL` (size attributes from Story 3.1 topology)
**When** the directed putaway suggestion is computed
**Then** `BIN-A43` is excluded and the suggestion returns the nearest eligible bin whose size class fits the lot (FR-W-03 size criterion)

**Given** the store assistant scans `BIN-A47` instead of the suggested `BIN-A43`
**When** the scan is confirmed with reason code `"better_space_available"`
**Then** a `location.override` event is recorded with the asserted location `BIN-A47`, the expected location `BIN-A43`, the reason code, and the operator identity; `BIN-A47` becomes the authoritative current location

**Given** multiple override events for the same bin cluster within 30 days
**When** the re-slotting job built in this story runs (velocity classification plus override-cluster analysis)
**Then** the directed putaway suggestion for that item is updated to reflect the operator's preferred bin — the override improves the suggestion for the whole team (NFR-ADOPT-01)

**Given** the store assistant is offline when completing the putaway
**When** the override event is synced
**Then** it replays in the correct sequence relative to other events for the same lot, and the location projection is updated exactly once
~~~~

#### E3-09 — REPLACE in `epics.md`

**Findings addressed:** C2; major: 3.6 strategies/optimized-path; FR-W-04 partial; minor: FR-W traceability citations

**Rationale:** Resolves C2 by sourcing dispatch orders from the Story 2.9 sales-order projection (with a Depends-on note). Adds one AC per claimed picking strategy (batch, wave, zone) and a paper-directed AC closing the FR-W-04 partial, and replaces the unverifiable 'optimized path' with an observable ordering rule (ascending bin pick-sequence within zone). Adds the FR-W-04 citation.

**OLD:**

~~~~markdown
### Story 3.6: Pick Task Generation and Execution

As a warehouse operator,
I want to receive system-generated pick tasks with optimized paths and execute them via the edge PWA (single-order, batch, wave, or zone), with task confirmation updating stock allocation in real time,
So that picks are accurate and efficient, and stock allocation is always current without manual reconciliation.

**Acceptance Criteria:**

**Given** a dispatch order requires 100 units of `FG-0010` from `site-A`
**When** pick tasks are generated
**Then** the system creates tasks with an optimized path through the warehouse, selects lots by FEFO, and sets the 100 units as `allocated` in the stock balance

**Given** an operator scans the lot barcode at the pick location
**When** the scan is confirmed on the edge PWA
**Then** the pick line is marked confirmed; if the scanned lot does not match the directed lot, the system prompts for an override reason before allowing the substitution

**Given** the operator confirms all pick lines for an order
**When** the last confirmation is submitted
**Then** stock status moves from `allocated` to `picked` and the packing station is notified
~~~~

**NEW:**

~~~~markdown
### Story 3.6: Pick Task Generation and Execution (FR-W-04)

As a warehouse operator,
I want to receive system-generated pick tasks with optimized paths and execute them via the edge PWA or a printed pick list (single-order, batch, wave, or zone), with task confirmation updating stock allocation in real time,
So that picks are accurate and efficient, and stock allocation is always current without manual reconciliation.

**Depends on Story 2.9 (ERP Inbound Reference Projections):** Phase-1 outbound demand is the sales-order projection synced inbound from the ERP — dispatch orders below are lines of that projection, not the Phase-2 Epic 15 order module.

**Acceptance Criteria:**

**Given** a dispatch order from the Story 2.9 sales-order projection requires 100 units of `FG-0010` from `site-A`
**When** pick tasks are generated
**Then** the system creates tasks whose pick lines are sequenced in ascending bin pick-sequence within each zone (the observable definition of "optimized path"), selects lots by FEFO, and sets the 100 units as `allocated` in the stock balance (FR-W-04)

**Given** three open dispatch orders from the Story 2.9 projection require `FG-0010` from the same zone
**When** the supervisor releases them as a batch pick
**Then** a single consolidated pick task is generated for the combined quantity, with per-order sortation quantities shown at the pick line (FR-W-04 batch strategy)

**Given** open dispatch orders are grouped by dispatch cutoff time into a wave
**When** the wave is released
**Then** pick tasks for all orders in the wave are generated together and carry the `wave_id`; orders outside the wave remain unreleased (FR-W-04 wave strategy)

**Given** a dispatch order's pick lines span `ZONE-AMBIENT` and `ZONE-COLD`
**When** zone picking is selected
**Then** separate pick tasks are generated per zone, each assignable to a zone operator, and the order moves to `picked` only when every zone task is confirmed (FR-W-04 zone strategy)

**Given** a pick task list is generated for an operator working without an edge device
**When** the supervisor prints the pick list
**Then** a paper pick list renders with task IDs, bin pick-sequence, and directed lots; keyed-in confirmations against those task IDs are recorded with `capture_method: "PAPER"` (FR-W-04 paper-directed)

**Given** an operator scans the lot barcode at the pick location
**When** the scan is confirmed on the edge PWA
**Then** the pick line is marked confirmed; if the scanned lot does not match the directed lot, the system prompts for an override reason before allowing the substitution

**Given** the operator confirms all pick lines for an order
**When** the last confirmation is submitted
**Then** stock status moves from `allocated` to `picked` and the packing station is notified
~~~~

#### E3-10 — REPLACE in `epics.md`

**Findings addressed:** major: 3.7 FR-W-06 sub-capabilities + consignee; FR-W-06 partial; C2; minor: 3.4/3.7 QC integration testability; minor: FR-W traceability citations

**Rationale:** Sources the dispatched order and the consignee details from the Story 2.9 sales-order projection (closing the no-Phase-1-customer-master gap), adds the explicit Phase-2/Epic-15 deferral note for the uncovered FR-W-06 sub-capabilities, cites Story 2.3 as the origin of the quality-hold state consumed by the LOT_ON_HOLD block, and adds the FR-W-05/FR-W-06 citations.

**OLD:**

~~~~markdown
### Story 3.7: Packing, Shipping, and Dispatch Documents

As a dispatch clerk,
I want to complete packing validation, generate shipping documents (bill of lading, commercial invoice, packing slips, labels), and confirm dispatch — with the system blocking dispatch if any compliance hold exists,
So that every outbound shipment is documented, weighed, and cleared before the truck leaves the gate.

**Acceptance Criteria:**

**Given** all pick lines for an order are confirmed
**When** the packing station operator confirms weights, labels, and cartonization
**Then** a packing record is created with actual weights and label references; the order moves to `ready_to_ship` status

**Given** the order is `ready_to_ship`
**When** the dispatcher generates shipping documents
**Then** a BOL, packing slip, and commercial invoice are produced with the correct lot references, weights, and consignee details

**Given** the order contains a lot under a quality hold (FR-Q-09 integration point)
**When** dispatch is attempted
**Then** the system blocks dispatch with `error_code: "LOT_ON_HOLD"` — no shipping document is generated until the hold is released
~~~~

**NEW:**

~~~~markdown
### Story 3.7: Packing, Shipping, and Dispatch Documents (FR-W-05, FR-W-06)

As a dispatch clerk,
I want to complete packing validation, generate shipping documents (bill of lading, commercial invoice, packing slips, labels), and confirm dispatch — with the system blocking dispatch if any compliance hold exists,
So that every outbound shipment is documented, weighed, and cleared before the truck leaves the gate.

**Depends on Story 2.9 (ERP Inbound Reference Projections):** the orders packed and dispatched here are dispatch orders from the Story 2.9 sales-order projection; consignee details are sourced from that projection (the ERP customer master remains the consignee system of record in Phase 1).

**Deferred to Phase 2 (Epic 15):** customs documentation, carrier rate shopping, and load planning (FR-W-06 clauses) — Phase 1 delivers BOL, packing slip, commercial invoice, and labels only.

**Acceptance Criteria:**

**Given** all pick lines for a dispatch order (Story 2.9 sales-order projection) are confirmed
**When** the packing station operator confirms weights, labels, and cartonization
**Then** a packing record is created with actual weights and label references; the order moves to `ready_to_ship` status (FR-W-05)

**Given** the order is `ready_to_ship`
**When** the dispatcher generates shipping documents
**Then** a BOL, packing slip, and commercial invoice are produced with the correct lot references, weights, and consignee details taken from the Story 2.9 sales-order projection (FR-W-06)

**Given** the order contains a lot under a quality hold (FR-Q-09 integration point; hold state and `LOT_ON_HOLD` semantics are established in Story 2.3)
**When** dispatch is attempted
**Then** the system blocks dispatch with `error_code: "LOT_ON_HOLD"` — no shipping document is generated until the hold is released
~~~~

#### E3-11 — REPLACE in `epics.md`

**Findings addressed:** minor: 3.8 gate-dwell derivation + SLA wording; minor: FR-W traceability citations

**Rationale:** Makes the SM-13 gate-dwell metric derivable by defining its interval endpoints from events Epic 3 actually captures (gate entry in 3.2, weighbridge acceptance in 3.3, GRN confirmation fallback in 3.4), and fixes the grammatically broken, weakly observable SLA clause in AC1. Adds the FR-W-07 citation per the traceability recommendation.

**OLD:**

~~~~markdown
### Story 3.8: Warehouse Task Management and Productivity Tracking

As a warehouse supervisor,
I want to assign, prioritize, and monitor all open warehouse tasks (receiving, putaway, picking, packing) with productivity metrics per operator and zone,
So that I can balance workload, identify bottlenecks, and track against the gate dwell target of under 4 minutes median (SM-13) and frontline confirmation rate above 95% (SM-17).

**Acceptance Criteria:**

**Given** multiple open putaway and pick tasks exist across operators
**When** the supervisor opens the task management dashboard
**Then** open tasks are grouped by type and operator, showing age, priority, and zone; tasks breach a configurable SLA threshold show highlighted

**Given** an operator completes a task
**When** the confirmation is posted
**Then** the task is marked complete with operator identity and duration; the confirmation rate metric updates in the read model

**Given** the gate dwell metric (SM-13) for the shift shows median above 4 minutes
**When** the supervisor views the exception dashboard
**Then** the metric appears as an exception with drill-through to the individual gate events that breached the threshold
~~~~

**NEW:**

~~~~markdown
### Story 3.8: Warehouse Task Management and Productivity Tracking (FR-W-07)

As a warehouse supervisor,
I want to assign, prioritize, and monitor all open warehouse tasks (receiving, putaway, picking, packing) with productivity metrics per operator and zone,
So that I can balance workload, identify bottlenecks, and track against the gate dwell target of under 4 minutes median (SM-13) and frontline confirmation rate above 95% (SM-17).

**Acceptance Criteria:**

**Given** multiple open putaway and pick tasks exist across operators
**When** the supervisor opens the task management dashboard
**Then** open tasks are grouped by type and operator, showing age, priority, and zone; tasks that breach a configurable SLA threshold are visually highlighted with the breached threshold shown (FR-W-07)

**Given** an operator completes a task
**When** the confirmation is posted
**Then** the task is marked complete with operator identity and duration; the confirmation rate metric updates in the read model

**Given** gate dwell (SM-13) is computed per vehicle as the interval from the gate-entry event timestamp (Story 3.2) to weighbridge acceptance for the same binding token (Story 3.3) — falling back to GRN confirmation (Story 3.4) where no weighment applies — and the shift median exceeds 4 minutes
**When** the supervisor views the exception dashboard
**Then** the metric appears as an exception with drill-through to the individual gate events that breached the threshold
~~~~

#### E3-12 — REPLACE in `epics.md`

**Findings addressed:** C3; FR-W-08 partial; minor: 3.9 replenishment quantity

**Rationale:** Resolves C3 by splitting the story per the report: 3.9 keeps its number with the self-contained replenishment scope, and the cross-docking half becomes new Story 3.10 whose ACs bind to open outbound demand on the Story 2.9 sales-order projection instead of the Phase-2 Epic 15 order entity. Also closes the FR-W-08 demand-signal partial with a demand-driven trigger AC, and fixes the undefined 'standard replenishment quantity' as top-up-to-configured-maximum so the expected task quantity is computable in a test.

**OLD:**

~~~~markdown
### Story 3.9: Forward-Pick Replenishment and Cross-Docking

As a warehouse manager,
I want forward-pick zones replenished automatically from reserve storage when min/max levels are breached, and qualifying inbound receipts cross-docked directly to outbound staging without touching racking,
So that high-velocity picking zones stay stocked without manual intervention and cross-dockable receipts clear the dock faster.

**Acceptance Criteria:**

**Given** the forward-pick quantity for `SKU-RM0042` in zone `FP-ZONE-A` drops below its configured minimum (FR-W-08)
**When** the replenishment trigger runs
**Then** a replenishment task is created to move the standard replenishment quantity from reserve storage to `FP-ZONE-A` and the task appears in the task board for assignment

**Given** a replenishment task completes
**When** the operator confirms the transfer
**Then** the forward-pick balance updates immediately; the reserve balance decreases by the same quantity; both movements carry the same `correlation_id`

**Given** inbound stock on a receipt line matches an open outbound order line and is flagged `cross_dock: true` (FR-W-09)
**When** the receiving event is confirmed
**Then** a cross-dock task routes the stock directly to the outbound staging area; no putaway task to reserve storage is generated for that receipt line

**Given** a cross-dock task is confirmed at outbound staging
**When** the stock is moved
**Then** the outbound order allocation updates to reflect the cross-docked lot and the dock-to-dispatch cycle time is recorded in the task duration metric
~~~~

**NEW:**

~~~~markdown
### Story 3.9: Forward-Pick Replenishment (FR-W-08)

As a warehouse manager,
I want forward-pick zones replenished automatically from reserve storage when min/max levels are breached or when open pick demand signals a shortfall,
So that high-velocity picking zones stay stocked without manual intervention.

**Acceptance Criteria:**

**Given** the forward-pick quantity for `SKU-RM0042` in zone `FP-ZONE-A` drops below its configured minimum (FR-W-08)
**When** the replenishment trigger runs
**Then** a replenishment task is created to move the quantity that tops the zone up to its configured maximum from reserve storage to `FP-ZONE-A`, and the task appears in the task board for assignment

**Given** open pick demand for `SKU-RM0042` from the Story 2.9 sales-order projection exceeds the current forward-pick balance in `FP-ZONE-A`, even though the configured minimum has not yet been breached
**When** the replenishment trigger runs
**Then** a demand-signal replenishment task is created for the shortfall quantity ahead of the min/max cycle (FR-W-08 demand signals)

**Given** a replenishment task completes
**When** the operator confirms the transfer
**Then** the forward-pick balance updates immediately; the reserve balance decreases by the same quantity; both movements carry the same `correlation_id`

---

### Story 3.10: Cross-Docking Execution (FR-W-09)

As a warehouse manager,
I want qualifying inbound receipts cross-docked directly to outbound staging without touching racking,
So that cross-dockable receipts clear the dock faster and dock-to-dispatch time shrinks.

**Depends on Story 2.9 (ERP Inbound Reference Projections):** cross-dock matching binds inbound receipt lines to open outbound demand on the Story 2.9 sales-order projection — no Phase-2 Epic 15 order module is required.

**Acceptance Criteria:**

**Given** inbound stock on a receipt line matches an open sales-order line on the Story 2.9 projection and is flagged `cross_dock: true` (FR-W-09)
**When** the receiving event is confirmed
**Then** a cross-dock task routes the stock directly to the outbound staging area; no putaway task to reserve storage is generated for that receipt line

**Given** a cross-dock task is confirmed at outbound staging
**When** the stock is moved
**Then** the pick allocation for the matching dispatch order (Story 2.9 sales-order projection) updates to reflect the cross-docked lot, and the dock-to-dispatch cycle time is recorded in the task duration metric
~~~~


### Epic 4: Procurement and Supplier Management — 17 edits

#### E4-01 — REPLACE in `epics.md`

**Findings addressed:** minor: FR-P-08 traceability (epic list line 376); major: 4.2 QC-outcome Epic 8 dependency (partial — header declaration); major: 4.5 vs 3.4 scope-overlap (partial — inter-epic PO circularity)

**Rationale:** Fixes the FR-P-08 trace (Epic 4 emits events, Story 12.3 owns the surface — coverage-map range row at line 289 left intact to avoid cross-agent collision), declares the real Epic 8 data dependency of Story 4.2 with the pilot-slice ordering that makes it safe, and resolves the Epic 3/Epic 4 PO circularity via the baked-in Story 2.9 (D1).

**OLD:**

~~~~markdown
**FRs covered:** FR-P-01, FR-P-02, FR-P-03, FR-P-04, FR-P-05, FR-P-06, FR-P-07, FR-P-08, FR-P-09

**Depends on:** Epics 1, 2, 3

**Note:** Tender management (FR-T-01..07) is Phase 2 / Epic 14.
~~~~

**NEW:**

~~~~markdown
**FRs covered:** FR-P-01, FR-P-02, FR-P-03, FR-P-04, FR-P-05, FR-P-06, FR-P-07, FR-P-09. FR-P-08 (spend analytics): Epic 4 emits the underlying PO, receipt, and invoice events; the reporting surface is delivered by Story 12.3.

**Depends on:** Epics 1, 2, 3. Story 4.2's quality-acceptance metric additionally consumes Epic 8 QC disposition events — Epic 8 is in the pilot slice and builds before Epic 4; the metric shows "no data" until disposition events exist.

**Note:** Tender management (FR-T-01..07) is Phase 2 / Epic 14. Open purchase orders inbound from ERP are available as read-only reference projections from Story 2.9; Story 3.4 (Epic 3) receives against those projections until Story 4.4's native POs go live — this resolves the Epic 3 ↔ Epic 4 PO sequencing.
~~~~

#### E4-02 — REPLACE in `epics.md`

**Findings addressed:** FR-P-01 partial

**Rationale:** FR-P-01 requires 'terms' in the registry; no AC captured supplier commercial/payment terms anywhere in the document. Adds capture plus an observable downstream effect (terms default onto POs).

**OLD:**

~~~~markdown
**Given** no supplier record exists for a new vendor
**When** the procurement officer creates a supplier with legal name, contacts, PAN, GSTIN, and certification references (FR-P-01)
**Then** a `SupplierRegistered` event is written to the event store and the supplier is placed in `onboarding` status, not yet orderable
~~~~

**NEW:**

~~~~markdown
**Given** no supplier record exists for a new vendor
**When** the procurement officer creates a supplier with legal name, contacts, PAN, GSTIN, commercial and payment terms (credit period in days, freight and delivery terms), and certification references (FR-P-01)
**Then** a `SupplierRegistered` event is written to the event store, the terms are stored on the supplier record and default onto that supplier's POs (Story 4.4), and the supplier is placed in `onboarding` status, not yet orderable
~~~~

#### E4-03 — REPLACE in `epics.md`

**Findings addressed:** minor: 4.3 enum / 4.1 GSTIN error code (4.1 part)

**Rationale:** The only enforcement AC in the epic without a named error code; assigns the stable UPPER_SNAKE code the finding recommends.

**OLD:**

~~~~markdown
**Given** a GSTIN already exists on another active supplier record
**When** the officer attempts to register a duplicate
**Then** the system blocks creation and surfaces the existing supplier to prevent duplicate vendor masters
~~~~

**NEW:**

~~~~markdown
**Given** a GSTIN already exists on another active supplier record
**When** the officer attempts to register a duplicate
**Then** the system blocks creation with `error_code: "DUPLICATE_SUPPLIER_GSTIN"` and surfaces the existing supplier to prevent duplicate vendor masters
~~~~

#### E4-04 — REPLACE in `epics.md`

**Findings addressed:** critical: 4.2 forward-dependency (D5); major: 4.2 QC-outcome Epic 8 dependency; major: 4.2 responsiveness no capture mechanism

**Rationale:** Applies D5: Story 4.2 keeps its number, gains the explicit sequencing note after 4.4/4.5/4.7, and every metric AC now names the producing event and story. Quality acceptance is bound to Epic 8 Story 8.3 disposition events with a defined 'no data' behavior; responsiveness gets a concrete source and formula (PO issue → confirmation, both events from Story 4.4).

**OLD:**

~~~~markdown
### Story 4.2: Supplier Performance Scorecards

As a procurement officer,
I want supplier performance captured across on-time delivery, quality acceptance, price variance, and responsiveness with a consolidated scorecard,
So that I can make sourcing decisions on evidence rather than anecdote.

**Acceptance Criteria:**

**Given** an active supplier from Story 4.1 with completed goods receipts
**When** a goods receipt is posted against that supplier's PO
**Then** on-time delivery and quality acceptance metrics are updated from the receipt and QC outcome (FR-P-03) and stored as scorecard projection events

**Given** an invoice is matched against a PO with a price difference
**When** the match completes
**Then** the price-variance metric for the supplier is updated with the signed variance percentage

**Given** a procurement officer opens a supplier scorecard
**When** the scorecard view loads
**Then** on-time delivery, quality acceptance, price variance, and responsiveness are shown as trended metrics with the underlying transactions available for drill-through
~~~~

**NEW:**

~~~~markdown
### Story 4.2: Supplier Performance Scorecards

As a procurement officer,
I want supplier performance captured across on-time delivery, quality acceptance, price variance, and responsiveness with a consolidated scorecard,
So that I can make sourcing decisions on evidence rather than anecdote.

**Sequencing:** implement after Stories 4.4, 4.5, and 4.7 — every transactional metric below consumes events those stories produce (`PurchaseOrderIssued` / `PurchaseOrderConfirmed` from 4.4, `GoodsReceived` and match results from 4.5, `SupplierInvoiceCaptured` from 4.7). The story keeps its number but is built last in this epic.

**Acceptance Criteria:**

**Given** an active supplier from Story 4.1 with an issued and confirmed PO (Story 4.4)
**When** a `GoodsReceived` event (Story 4.5) is posted against that supplier's PO
**Then** the on-time delivery metric is updated from the receipt date measured against the PO promised delivery date (FR-P-03) and stored as a scorecard projection event

**Given** QC disposition events exist for the supplier's received lots (Epic 8, Story 8.3 — Epic 8 is in the pilot slice and builds before Epic 4)
**When** a lot is dispositioned accept, reject, or conditional
**Then** the quality-acceptance metric is updated from the disposition (FR-P-03); a supplier with no disposition events shows "no data" for this dimension — never a fabricated zero

**Given** a supplier invoice captured in Story 4.7 is matched against a PO with a price difference
**When** the three-way match (Story 4.5) completes
**Then** the price-variance metric for the supplier is updated with the signed variance percentage

**Given** an issued PO awaiting supplier confirmation
**When** the `PurchaseOrderConfirmed` event (Story 4.4) is recorded
**Then** the responsiveness metric is updated as elapsed business days from `PurchaseOrderIssued` to `PurchaseOrderConfirmed` (FR-P-03), trended per supplier

**Given** a procurement officer opens a supplier scorecard
**When** the scorecard view loads
**Then** on-time delivery, quality acceptance, price variance, and responsiveness are shown as trended metrics with the underlying transactions (receipts, dispositions, matches, confirmations) available for drill-through
~~~~

#### E4-05 — REPLACE in `epics.md`

**Findings addressed:** major: 4.3 offline semantics + 90s measurement (part 1)

**Rationale:** Defines offline capture semantics (local commit, pending-sync indicator per Story 1.8) and gives the 90-second target start/stop points, with the full instrumentation method in the story-level measurement note (E4-08).

**OLD:**

~~~~markdown
**Given** a floor supervisor on the offline-capable PWA
**When** they raise a requisition with item, quantity, need-by date, and a mandatory business-stream tag (FR-AC-01, FR-P-04)
**Then** the requisition is captured in under 90 seconds; an untagged requisition is rejected with `error_code: "UNTAGGED_TRANSACTION"`
~~~~

**NEW:**

~~~~markdown
**Given** a floor supervisor on the offline-capable PWA, with or without network
**When** they raise a requisition with item, quantity, need-by date, and a mandatory business-stream tag (FR-AC-01, FR-P-04)
**Then** the requisition is committed locally and shows "captured, pending sync" (Story 1.8 pattern) even with no network, and capture completes in under 90 seconds measured from opening the new-requisition form to the local commit (see measurement note below); an untagged requisition is rejected at capture with `error_code: "UNTAGGED_TRANSACTION"`
~~~~

#### E4-06 — REPLACE in `epics.md`

**Findings addressed:** major: 4.3 offline semantics + 90s measurement (part 2 — duplicate check)

**Rationale:** Resolves the contradiction between the offline Given and a synchronous server-side duplicate check: online keeps the interactive flow; offline defers the check to sync time with a held state and requester confirmation, matching the document's established offline-replay pattern (Stories 3.3/3.5).

**OLD:**

~~~~markdown
**Given** a similar open requisition for the same item by the same requester exists within the configured open window
**When** a new requisition is submitted
**Then** the system flags the potential duplicate with `error_code: "DUPLICATE_EVENT"` and requires explicit confirmation before proceeding
~~~~

**NEW:**

~~~~markdown
**Given** a similar open requisition for the same item by the same requester exists within the configured open window
**When** a new requisition is submitted while the device is online
**Then** the system flags the potential duplicate with `error_code: "DUPLICATE_EVENT"` and requires explicit confirmation before proceeding

**Given** the same duplicate condition and the requisition was captured offline
**When** the queued requisition syncs
**Then** the duplicate check runs server-side at sync time; the requisition is held in `pending-confirmation` — not routed to approval — and the requester is notified to confirm or withdraw, with the confirmed path applying the same `DUPLICATE_EVENT` flow; the capture is never silently dropped
~~~~

#### E4-07 — REPLACE in `epics.md`

**Findings addressed:** minor: 4.3 enum / 4.1 GSTIN error code (4.3 part)

**Rationale:** expected_delivery was a date-bearing attribute masquerading as a lifecycle state, and the enum had no terminal cancel/close states. Makes the date an attribute of ordered and adds cancelled/closed.

**OLD:**

~~~~markdown
**Given** a requisition has been submitted
**When** the requester views its status
**Then** live status is shown as one of `raised`, `approved`, `rejected`, `ordered`, or `expected_delivery` with the expected delivery date once a PO is placed
~~~~

**NEW:**

~~~~markdown
**Given** a requisition has been submitted
**When** the requester views its status
**Then** live status is shown as one of `raised`, `approved`, `rejected`, `ordered`, `cancelled`, or `closed`, with the expected delivery date shown as an attribute of the `ordered` status once a PO is placed
~~~~

#### E4-08 — REPLACE in `epics.md`

**Findings addressed:** FR-P-04 partial; major: 4.3 offline semantics + 90s measurement (part 3 — measurement note)

**Rationale:** Adds the FR-P-04 configurable requisition approval-rules AC (amount/category/department, DOA-resolved, edit-logged), anchors push notifications to the Story 1.11 foundation, and supplies the instrumented measurement definition for the sub-90-second target referenced by the reworked AC1.

**OLD:**

~~~~markdown
**Given** an approver approves or rejects the requisition
**When** the decision is recorded
**Then** a push notification is sent to the requester with the decision and, for rejections, the mandatory reason
~~~~

**NEW:**

~~~~markdown
**Given** an approver approves or rejects the requisition
**When** the decision is recorded
**Then** a push notification is sent to the requester through the notification foundation (Story 1.11) with the decision and, for rejections, the mandatory reason

**Given** requisition approval rules are configured by amount band, item category, and requesting department (FR-P-04)
**When** a requisition is submitted
**Then** the approving authority is resolved from the DOA registry (FR-DOA-01) against those rules — never hard-coded — the requisition returns `error_code: "APPROVAL_REQUIRED"` until that authority acts, and rule changes are written to the edit log (FR-AC-13) and apply only to requisitions submitted after the change

**Measurement note:** the 90-second target (UJ-IND-01) is measured by client instrumentation from the `form_opened` timestamp to the `local_commit` timestamp on a mid-range Android device, network present or absent; a tap-count budget for the capture flow serves as the CI regression proxy for the timing target.
~~~~

#### E4-09 — REPLACE in `epics.md`

**Findings addressed:** major: 4.4 ERP handoff unimplementable; major: 4.2 responsiveness no capture mechanism (source event)

**Rationale:** Replaces the unimplementable 'ERP handoff (INT)' with an observable outbound boundary on the architecture's adapters/erp channel, testable without a live ERP, and adds the supplier-confirmation capture that grounds Story 4.2's responsiveness metric and Story 4.6's 'PO is confirmed' precondition.

**OLD:**

~~~~markdown
**Given** a PO has been approved by the DOA-resolved authority
**When** the officer issues it
**Then** the PO is transmitted through the ERP handoff (INT), moves to `issued` status, and the linked requisition status flips to `ordered`
~~~~

**NEW:**

~~~~markdown
**Given** a PO has been approved by the DOA-resolved authority
**When** the officer issues it
**Then** a `PurchaseOrderIssued` event is written and its payload (line items, prices, taxes, business-stream tag) is published to the PO-outbound channel of the ERP integration adapter (`adapters/erp` — see interface note below), the PO moves to `issued` status, and the linked requisition status flips to `ordered`; the AC is verified against the adapter's recorded outbound payload, not a live ERP

**Given** an issued PO
**When** the officer records the supplier's order confirmation with the promised delivery date
**Then** a `PurchaseOrderConfirmed` event is written, the promised date is stamped on the PO lines, and the linked requisition shows the expected delivery date (feeds the Story 4.2 responsiveness metric)
~~~~

#### E4-10 — REPLACE in `epics.md`

**Findings addressed:** major: 4.4 ERP handoff unimplementable (interface note); major: 4.5 vs 3.4 scope-overlap (circularity — Story 2.9 reference)

**Rationale:** Explicit interface note required by the ERP-handoff rework: names the owning component, distinguishes the new PO-outbound contract from BOM-scoped INT-ERP-01, defines the test boundary, and ties inbound PO reference data to the baked-in Story 2.9 (D1), closing the Epic 3/4 circularity from the 4.4 side.

**OLD:**

~~~~markdown
**Given** a blanket or contract PO with a defined ceiling
**When** cumulative releases would exceed the ceiling
**Then** the release is blocked until the ceiling is revised through a fresh DOA-gated approval
~~~~

**NEW:**

~~~~markdown
**Given** a blanket or contract PO with a defined ceiling
**When** cumulative releases would exceed the ceiling
**Then** the release is blocked until the ceiling is revised through a fresh DOA-gated approval

**Interface note:** the ERP adapter (`adapters/erp`) is the only component that communicates with the external ERP (architecture spine). This story defines the PO-outbound message contract on that adapter — distinct from INT-ERP-01, which is scoped to BOM structure outbound and cost rates inbound. Tests assert the recorded payload at the adapter boundary; live transmission is per-deployment configuration. Open POs inbound from ERP are the read-only reference projections of Story 2.9, which Story 3.4 receives against until this story's native POs go live.
~~~~

#### E4-11 — REPLACE in `epics.md`

**Findings addressed:** major: 4.5 vs 3.4 scope-overlap

**Rationale:** States the 3.4/4.5 GRN boundary explicitly (3.4 = physical receiving events; 4.5 = PO-matching/financial GRN posting) so two competing receiving implementations cannot emerge, and records the Story 2.9 bridge that dissolves the inter-epic PO circularity.

**OLD:**

~~~~markdown
So that we only pay for what was ordered and received, and discrepancies are caught before payment.

**Acceptance Criteria:**
~~~~

**NEW:**

~~~~markdown
So that we only pay for what was ordered and received, and discrepancies are caught before payment.

**Boundary note:** Story 3.4 (Epic 3) owns physical receiving capture — the gate-token chain (AD-2), lot/serial/expiry entry, and putaway tasks. Story 4.5 owns the procurement and financial side: PO-matching GRN posting, QC Hold stock status, and the three-way match. This story never re-implements physical capture; it consumes Story 3.4's receiving events. Until Story 4.4's native POs go live, Story 3.4 receives against the read-only open-PO reference projections from Story 2.9 (ERP inbound).

**Acceptance Criteria:**
~~~~

#### E4-12 — REPLACE in `epics.md`

**Findings addressed:** minor: 4.5 QC-gate forward reference; major: 4.5 vs 3.4 scope-overlap (AC wiring)

**Rationale:** Restricts the testable scope to what exists at build time (QC Hold posting + inspection task raised) and replaces 'triggering the QC gate' with the same integration-point annotation Story 3.4 already uses for Epic 8; also wires the AC to Story 3.4's events per the boundary note.

**OLD:**

~~~~markdown
**Given** an issued PO from Story 4.4
**When** material arrives and a GRN is created against the PO (FR-P-06)
**Then** received quantities post into QC Hold where the item requires inspection, triggering the QC gate, and a `GoodsReceived` event is written with lot and quantity detail
~~~~

**NEW:**

~~~~markdown
**Given** an issued PO from Story 4.4 and physical receiving captured through Story 3.4
**When** the procurement GRN is posted against the PO (FR-P-06)
**Then** the GRN consumes Story 3.4's receiving events (gate-token chain, lot and expiry capture) without re-entry, received quantities post into QC Hold status where the item requires inspection and a QC inspection task is raised (FR-Q-02 integration point; the QC gate itself is Epic 8 — Story 8.1), and a `GoodsReceived` event is written with lot and quantity detail
~~~~

#### E4-13 — REPLACE in `epics.md`

**Findings addressed:** major: missing supplier-invoice capture (consumer link)

**Rationale:** The invoice entity now has an origin: the match consumes invoices from new Story 4.7 instead of appearing from nowhere.

**OLD:**

~~~~markdown
**Given** a GRN, its source PO, and a supplier invoice
**When** the three-way match is run (FR-P-07)
**Then** quantity and price are compared across all three documents and a match passes only when differences fall within configured tolerance
~~~~

**NEW:**

~~~~markdown
**Given** a GRN, its source PO, and a supplier invoice captured through Story 4.7
**When** the three-way match is run (FR-P-07)
**Then** quantity and price are compared across all three documents and a match passes only when differences fall within configured tolerance
~~~~

#### E4-14 — REPLACE in `epics.md`

**Findings addressed:** minor: 4.5 payment-block vague AC

**Rationale:** Replaces the untestable 'payment is blocked' with the observable mechanism: a blocked match status with a stable error code and exclusion from the ERP payment-clearance feed, unblockable only via edit-logged credit/debit notes.

**OLD:**

~~~~markdown
**Given** a three-way match falls outside tolerance
**When** the match completes
**Then** a discrepancy flag is raised and payment is blocked until resolved by a credit note or debit note, each recorded to the edit log (FR-AC-13)
~~~~

**NEW:**

~~~~markdown
**Given** a three-way match falls outside tolerance
**When** the match completes
**Then** the match record is set to `blocked` with `error_code: "MATCH_OUT_OF_TOLERANCE"`, the invoice is excluded from the payment-clearance feed to ERP (payment executes in ERP; the block is effected by withholding clearance through the `adapters/erp` channel), and the block is lifted only by a credit note or debit note, each recorded to the edit log (FR-AC-13)
~~~~

#### E4-15 — REPLACE in `epics.md`

**Findings addressed:** major: 4.6 missing error paths (validation method); FR-P-09 partial (classification tag)

**Rationale:** Defines what 'validated' means (format check plus certificate verification) and captures the micro/small/medium classification tag FR-P-09's ageing feed requires.

**OLD:**

~~~~markdown
**Given** a supplier claiming MSME status
**When** their Udyam registration number is captured and validated (FR-P-09)
**Then** the supplier is flagged as an MSME vendor and the Udyam number is stored on the supplier record
~~~~

**NEW:**

~~~~markdown
**Given** a supplier claiming MSME status
**When** their Udyam registration number is captured, passes format validation (pattern `UDYAM-XX-00-0000000`), and is verified by the officer against the uploaded Udyam certificate (FR-P-09)
**Then** the supplier is flagged as an MSME vendor with a classification tag of `micro`, `small`, or `medium` taken from the certificate, and the Udyam number, classification, and certificate reference are stored on the supplier record
~~~~

#### E4-16 — REPLACE in `epics.md`

**Findings addressed:** major: 4.6 missing error paths (ERP ageing feed); FR-P-09 partial (classification-tagged ageing fed to ERP); major: missing supplier-invoice capture (consumer link)

**Rationale:** Closes the FR-P-09 coverage gap this story exists to deliver: the ageing is classification-tagged per line and actually fed to ERP through the adapters/erp channel with an auditable feed record; invoices now trace to their Story 4.7 origin.

**OLD:**

~~~~markdown
**Given** MSME invoices are outstanding
**When** the ageing report is generated
**Then** invoices approaching or past their statutory due date are flagged with their s.43B(h) income-tax and MSMED s.16 interest exposure
~~~~

**NEW:**

~~~~markdown
**Given** MSME supplier invoices captured through Story 4.7 are outstanding
**When** the ageing report is generated
**Then** invoices approaching or past their statutory due date are flagged with their s.43B(h) income-tax and MSMED s.16 interest exposure, each line tagged with the supplier's MSME classification (`micro`, `small`, or `medium`)

**Given** the classification-tagged ageing exists
**When** the scheduled ERP feed runs
**Then** the ageing, tagged by MSME classification, is fed to ERP through the ERP integration adapter (`adapters/erp`) so the s.43B(h) disallowance computation in ERP consumes it (FR-P-09), and each feed run is recorded with timestamp and row count
~~~~

#### E4-17 — REPLACE in `epics.md`

**Findings addressed:** major: 4.6 missing error paths (negative ACs, breach behavior); major: missing supplier-invoice capture (new Story 4.7); FR-P-09 partial (due-date stamping at capture)

**Rationale:** Adds the missing negative paths for the enforcement-type FR-P-09 (invalid Udyam rejected with UDYAM_INVALID; lapsed registration suspends the flag with edit-log entry and conservative due-date treatment; explicit statutory-breach behavior with escalation via Story 1.11), then appends new Story 4.7 Supplier Invoice Capture at the end of the epic: manual entry plus file ingestion with mandatory review, matching-ready fields for 4.5, GSTIN+invoice-number duplicate blocking (reusing DUPLICATE_EVENT), an unmatched queue guarded by SOURCE_DOCUMENT_REQUIRED, and due-date stamping at capture feeding 4.6.

**OLD:**

~~~~markdown
**Given** an MSME supplier's Udyam registration is approaching its annual revalidation date
**When** the revalidation window opens
**Then** an alert is raised to re-verify the registration before it lapses

---

## Epic 5: BOM and Engineering Change Management
~~~~

**NEW:**

~~~~markdown
**Given** an MSME supplier's Udyam registration is approaching its annual revalidation date
**When** the revalidation window opens
**Then** an alert is raised through the notification foundation (Story 1.11) to re-verify the registration before it lapses

**Given** a Udyam number that fails format validation or does not match the recorded certificate
**When** the officer attempts to save the MSME flag
**Then** the save is rejected with `error_code: "UDYAM_INVALID"` and the supplier remains untagged as MSME until a valid registration is captured

**Given** an MSME supplier's Udyam revalidation date has passed without re-verification
**When** the daily compliance check runs
**Then** the supplier's MSME flag moves to `suspended-pending-reverification` with the change written to the edit log (FR-AC-13); statutory due dates already stamped on open POs and invoices remain in force (conservative treatment) and new POs to the supplier raise a warning to procurement

**Given** an MSME invoice passes its statutory due date unpaid
**When** the breach is detected
**Then** the invoice is flagged `statutory_breach`, MSMED s.16 interest exposure accrues in the ageing from the day after the due date, and an escalation is sent to the finance compliance officer through the notification foundation (Story 1.11)

---

### Story 4.7: Supplier Invoice Capture

As an accounts payable officer,
I want supplier invoices captured by manual entry or file ingestion with matching-ready fields and duplicate detection,
So that the three-way match (Story 4.5), supplier scorecards (Story 4.2), and MSME ageing (Story 4.6) run against a complete, de-duplicated invoice register.

**Acceptance Criteria:**

**Given** an issued PO from Story 4.4
**When** an invoice is manually entered with supplier, invoice number, invoice date, PO reference, line items (item, quantity, unit price), GST breakup, and total
**Then** a `SupplierInvoiceCaptured` event is written with the business-stream tag inherited from the PO, the invoice enters `captured` status, and every field the Story 4.5 three-way match requires is present and validated at entry

**Given** a supplier invoice arrives as a file (PDF, CSV, or XML)
**When** the file is ingested
**Then** header and line fields are extracted into a review screen where the officer confirms or corrects before posting — no invoice posts unreviewed — and the file, uploader, and timestamp are stored as provenance on the invoice record

**Given** an invoice with the same supplier GSTIN and invoice number already exists within the same financial year
**When** capture is attempted (manual or file)
**Then** the capture is blocked with `error_code: "DUPLICATE_EVENT"`, the existing invoice is surfaced, and an officer override to proceed requires a reason recorded to the edit log (FR-AC-13)

**Given** an invoice that references no valid PO
**When** it is captured
**Then** it lands in an `unmatched` exception queue; any attempt to run the three-way match on it returns `error_code: "SOURCE_DOCUMENT_REQUIRED"` until a procurement officer links a PO

**Given** the supplier is MSME-flagged (Story 4.6)
**When** the invoice is captured
**Then** the statutory payment due date is stamped on the invoice at capture — the earlier of the agreed date and 45 days, or 15 days where no agreement exists — feeding the Story 4.6 ageing

---

## Epic 5: BOM and Engineering Change Management
~~~~


### Epic 5: BOM and Engineering Change Management — ep — 13 edits

#### E5-01 — REPLACE in `epics.md`

**Findings addressed:** Q5-major-5.5-FR-citations (FR-B-08 ownership); FR-B-08 partial

**Rationale:** FR-B-08 (consumption variance at order closure) is actually implemented by Epic 6 Story 6.4; the coverage map row claiming FR-B-01..17 for Epic 5 would corrupt any FR-to-story matrix. Split the row to hand FR-B-08 to Epic 6.

**OLD:**

~~~~markdown
| FR-B-01 to FR-B-17 | Epic 5: BOM and Engineering Change Management | Phase 1 |
~~~~

**NEW:**

~~~~markdown
| FR-B-01 to FR-B-07, FR-B-09 to FR-B-17 | Epic 5: BOM and Engineering Change Management | Phase 1 |
| FR-B-08 | Epic 6: Production Orders and Manufacturing WIP (consumption variance at order closure, Story 6.4) | Phase 1 |
~~~~

#### E5-02 — REPLACE in `epics.md`

**Findings addressed:** Q5-major-5.5-FR-citations (FR-B-08 ownership); FR-B-08 partial (feeds FR-SC reconciliation — explicit deferral note per rule 7)

**Rationale:** Removes FR-B-08 from Epic 5's coverage claim (implemented in Epic 6 Story 6.4) and adds the explicit Phase-2 deferral note for the 'feeds FR-SC reconciliation' clause per the epic directive (Epic 16 owns FR-SC), using the document's existing **Note:** header convention.

**OLD:**

~~~~markdown
**FRs covered:** FR-B-01, FR-B-02, FR-B-03, FR-B-04, FR-B-05, FR-B-06, FR-B-07, FR-B-08, FR-B-09, FR-B-10, FR-B-11, FR-B-12, FR-B-13, FR-B-14, FR-B-15, FR-B-16, FR-B-17
~~~~

**NEW:**

~~~~markdown
**FRs covered:** FR-B-01, FR-B-02, FR-B-03, FR-B-04, FR-B-05, FR-B-06, FR-B-07, FR-B-09, FR-B-10, FR-B-11, FR-B-12, FR-B-13, FR-B-14, FR-B-15, FR-B-16, FR-B-17

**Note:** FR-B-08 (consumption variance at order closure) is delivered by Epic 6 (Story 6.4), which generates the variance report and the scrap-percent recalibration signal consumed by this epic's BOM read models. Deferred to Phase 2 (Epic 16): the FR-B-08 handoff of variance data to the FR-SC expected-vs-actual scrap reconciliation (FR-SC-05).
~~~~

#### E5-03 — INSERT AFTER in `epics.md`

**Findings addressed:** Q10-minor-5.1-validation-negatives; FR-B-03 partial; Q12-minor-dev-notes (5.1)

**Rationale:** Adds the missing structural-integrity negative paths for Story 5.1 — non-overlapping effectivity (the FR-B-03 clause no AC enforced), circular-reference rejection, and scrap-percent bounds — with stable error codes, plus the dev-notes block naming events and projections.

**ANCHOR (insert after):**

~~~~markdown
**Given** a component line references an item that is not yet a released item master
**When** the line is added
**Then** the line is flagged as blocking release until the item master is released (A-11 prerequisite)
~~~~

**NEW (inserted):**

~~~~markdown


**Given** a BOM revision line with a date-effectivity window
**When** another line for the same component on the same revision is saved with an overlapping effectivity window (FR-B-03)
**Then** the save is rejected with `error_code: "EFFECTIVITY_OVERLAP"` — revision date effectivity must be non-overlapping

**Given** a multi-level BOM structure
**When** a component line is added that would make the BOM a descendant of itself at any depth
**Then** the line is rejected with `error_code: "BOM_CYCLE_DETECTED"`

**Given** a component line carrying a scrap %
**When** the value is outside the 0–100 range
**Then** the save is rejected listing the invalid value

**Dev Notes:**

- Domain events: `BomDrafted`, `BomLineAdded`, `BomLineAmended`. Projections: multi-level BOM structure read model (the Story 5.3 where-used graph builds on it), module-scoped per the DB-timing standard.
~~~~

#### E5-04 — REPLACE in `epics.md`

**Findings addressed:** Q1-critical-5.2-gate-forward-dep (D4)

**Rationale:** Applies D4: reduces the 5.2 release gate to released-item-masters + scrap-percent, removing the circular forward dependencies on 5.3 (ECO) and the cost-rollup engine, and names the staging explicitly so FR-B-06 stays traceable. Adds a stable error code for the enforcement path.

**OLD:**

~~~~markdown
**Given** a Draft BOM from Story 5.1
**When** release is attempted (FR-B-06)
**Then** release succeeds only when all component item masters are released, all scrap % are filled, the cost rollup is complete, and an approved ECO exists — otherwise release is blocked listing the unmet conditions
~~~~

**NEW:**

~~~~markdown
**Given** a Draft BOM from Story 5.1
**When** release is attempted (FR-B-06)
**Then** release succeeds only when all component item masters are released (A-11) and all scrap % are filled — otherwise release is blocked with `error_code: "RELEASE_GATE_UNMET"` listing the unmet conditions. The remaining FR-B-06 gate conditions are staged: the approved-ECO condition is added by Story 5.3 (first release of a new BOM is exempt) and the completed-cost-rollup condition by Story 5.6
~~~~

#### E5-05 — REPLACE in `epics.md`

**Findings addressed:** Q5-major-5.5-FR-citations (5.2 immutability citation)

**Rationale:** Fixes the wrong FR citation (immutability of released revisions is FR-B-03; FR-B-02 is kit supersession) and gives the enforcement rejection a stable error code.

**OLD:**

~~~~markdown
**Given** a BOM has been Released
**When** any user attempts to edit its structure directly
**Then** the edit is rejected because Released BOMs are immutable (FR-B-02) — changes are only possible through an ECO (Story 5.3)
~~~~

**NEW:**

~~~~markdown
**Given** a BOM has been Released
**When** any user attempts to edit its structure directly
**Then** the edit is rejected with `error_code: "IMMUTABLE_REVISION"` because Released revisions are immutable (FR-B-03) — changes are only possible through an ECO (Story 5.3)
~~~~

#### E5-06 — REPLACE in `epics.md`

**Findings addressed:** Q8-minor-5.2-kit-migration; Q12-minor-dev-notes (5.2); Q1-critical-5.2-gate-forward-dep (staging note)

**Rationale:** Makes the kit-migration AC testable: names the source (FR-I-09 kit master, Epic 2 — a declared dependency), cites the governing FR-B-02, states the migration-exempt release path recorded in the edit log (resolving the self-contradiction with the FR-B-06 gate), and adds the negative path for kits referencing unreleased item masters. Appends the 5.2 dev-notes block naming events/projections and restating the D4 gate staging.

**OLD:**

~~~~markdown
**Given** existing legacy kit definitions
**When** migration runs
**Then** each kit is migrated as a single-level BOM in Released state with its components preserved
~~~~

**NEW:**

~~~~markdown
**Given** existing legacy kit definitions from the ERP kit master (FR-I-09, Epic 2)
**When** migration runs (FR-B-02)
**Then** each kit whose components all reference released item masters is migrated as a single-level BOM in Released state with its components preserved, released via a migration-exempt path recorded in the edit log (FR-AC-13)

**Given** a legacy kit referencing an item that is not yet a released item master
**When** migration runs (FR-B-02)
**Then** that kit lands as a Draft BOM flagged for remediation rather than being force-released, and appears on the migration exception list feeding the Epic 13 sign-off gate

**Dev Notes:**

- Domain events: `BomReleased`, `BomHeld`, `BomObsoleted`, `LegacyKitMigrated`. Projections: BOM lifecycle-state read model and release-gate checklist projection (module-scoped per the DB-timing standard).
- The FR-B-06 release gate is staged deliberately (D4): this story enforces the released-item-master and scrap-percent conditions; Story 5.3 adds the approved-ECO condition (with a first-release exemption) and Story 5.6 adds the completed-cost-rollup condition.
~~~~

#### E5-07 — REPLACE in `epics.md`

**Findings addressed:** Q3-major-5.3-impact-deps (D1)

**Rationale:** Scopes the impact analysis to what Epic 5's declared dependencies deliver: BOMs and stock from E2, open-PO impact from the baked-in Story 2.9 ERP inbound reference projections (D1 — the only sanctioned PO source), and makes the open-production-order dimension an explicit register-on-arrival extension for E6 instead of an undeclared dependency.

**OLD:**

~~~~markdown
**Given** an ECO reaches the approval step
**When** the approver reviews it
**Then** a where-used and impact analysis (FR-B-05) is displayed across affected BOMs, open production orders, open POs, and current stock
~~~~

**NEW:**

~~~~markdown
**Given** an ECO reaches the approval step
**When** the approver reviews it
**Then** a where-used and impact analysis (FR-B-05) is displayed across affected BOMs and current stock (Epic 2), with open-PO impact read from the ERP inbound reference projections (Story 2.9); the open-production-order dimension displays as empty and registers as an impact source when Epic 6 lands
~~~~

#### E5-08 — INSERT AFTER in `epics.md`

**Findings addressed:** Q1-critical-5.2-gate-forward-dep (D4, ECO condition); Q7-major-FR-B-04-disposition; FR-B-04 partial; Q9-major-5.3-negative-paths; Q12-minor-dev-notes (5.3)

**Rationale:** Applies D4's second leg (the approved-ECO gate condition lands here as an AC, with the first-release exemption that dissolves the chicken-and-egg circularity), adds the FR-B-04 stock-disposition AC (use-up/scrap/rework routing on Implemented, per directive), and adds the missing negative paths on the epic's central enforcement workflow: non-Approved implementation rejection, DOA-resolved approver with unauthorized-approver rejection, and terminal Cancelled semantics — all with stable error codes. Ends with the 5.3 dev-notes block.

**ANCHOR (insert after):**

~~~~markdown
**Given** an ECO is Implemented
**When** the implementation event is recorded
**Then** a new Released BOM revision is created, the prior revision is retained immutably, and the change is attributed in the edit log (FR-AC-13)
~~~~

**NEW (inserted):**

~~~~markdown


**Given** an Approved ECO with on-hand stock of the superseded revision (FR-B-04)
**When** implementation is recorded
**Then** a stock-disposition decision — use-up, scrap, or rework — is required per affected lot before the ECO can reach `Implemented`: use-up permits consuming the superseded revision until exhausted, scrap routes affected lots to the scrap disposition flow, rework routes them to a rework reference, and each decision is written to the edit log (FR-AC-13)

**Given** an ECO that is not in `Approved` state (FR-B-04)
**When** implementation is attempted
**Then** the attempt is rejected with `error_code: "ECO_STATE_INVALID"` — only Approved ECOs may be Implemented

**Given** an ECO reaches the approval step
**When** the approver is resolved
**Then** the approver is resolved from the DOA registry (FR-DOA-01), and an approval attempt by a user outside the resolved chain is rejected with `error_code: "APPROVAL_REQUIRED"`

**Given** a Cancelled ECO
**When** any user attempts to reopen or implement it
**Then** the attempt is rejected with `error_code: "ECO_STATE_INVALID"` — Cancelled is terminal and a new ECO must be raised

**Given** a BOM with at least one prior Released revision
**When** release of a subsequent revision is attempted without an approved ECO covering the change (FR-B-06)
**Then** release is blocked with `error_code: "RELEASE_GATE_UNMET"` — the approved-ECO gate condition (staged from Story 5.2) applies to every revision after the first; the first release of a brand-new BOM is exempt so that initial release is achievable

**Dev Notes:**

- Domain events: `EcoRaised`, `EcoApproved`, `EcoImplemented`, `EcoCancelled`, `EcoStockDispositionRecorded`. Projections: ECO approval queue and where-used impact graph (module-scoped per the DB-timing standard).
- Open-PO impact reads from the Story 2.9 ERP inbound reference projections; the open-production-order impact source registers when Epic 6 lands.
~~~~

#### E5-09 — REPLACE in `epics.md`

**Findings addressed:** Q6-major-5.4-forward-deps (execution bar); Q5-major-5.5-FR-citations (5.4 FR-B-09/FR-B-10 swap)

**Rationale:** Applies the directive rewording: the execution bar becomes a structural validation testable at BOM level (regime flag blocks release-gate eligibility) instead of a forward reference to Epic 6's production-order release, with a stable error code. Also corrects the citation — 'barred from production execution' is FR-B-09's clause, not FR-B-10's.

**OLD:**

~~~~markdown
**Given** an R&D draft BOM
**When** a production order release is attempted against it
**Then** execution is barred (FR-B-10) — R&D draft BOMs cannot execute in production
~~~~

**NEW:**

~~~~markdown
**Given** an R&D draft BOM carrying the `rd_draft` regime flag (FR-B-09)
**When** any execution-intent request references it — release-gate eligibility evaluation (FR-B-06) or explosion to execution (FR-B-07)
**Then** the request is rejected with `error_code: "RD_EXECUTION_BARRED"` — the regime flag structurally blocks release-gate eligibility, testable at BOM level without a production order; Epic 6's production-order release gate consumes this same validation when it lands
~~~~

#### E5-10 — REPLACE in `epics.md`

**Findings addressed:** Q5-major-5.5-FR-citations (5.4 FR-B-09/FR-B-10 swap)

**Rationale:** Citation fix: cloning production BOMs into R&D drafts is FR-B-10's clause; FR-B-09 covers the draft-regime editing behavior already cited in the first AC.

**OLD:**

~~~~markdown
**Given** an existing production BOM
**When** the engineer clones it to an R&D draft (FR-B-09)
**Then** a new editable R&D draft is created without altering the source production BOM
~~~~

**NEW:**

~~~~markdown
**Given** an existing production BOM
**When** the engineer clones it to an R&D draft (FR-B-10)
**Then** a new editable R&D draft is created without altering the source production BOM
~~~~

#### E5-11 — REPLACE in `epics.md`

**Findings addressed:** Q6-major-5.4-forward-deps (as-built trigger); FR-B-10 partial (immutable snapshot + deviation flags)

**Rationale:** Applies the directive rewording: the as-built snapshot is captured against a draft-BOM build record testable within Epic 5, with the E6/E10 integration noted rather than depended on, and restores FR-B-10's dropped 'immutable' and 'deviation flags' qualifiers with an explicit no-edit negative path.

**OLD:**

~~~~markdown
**Given** a prototype is built from an R&D draft BOM
**When** the build is confirmed
**Then** an as-built snapshot is captured for that specific prototype build
~~~~

**NEW:**

~~~~markdown
**Given** an R&D draft BOM with a recorded draft-BOM build record (FR-B-10)
**When** the build record is confirmed
**Then** an immutable as-built snapshot is captured for that specific build, with deviation flags on every line where the as-built structure differs from the draft; any attempt to edit a captured snapshot is rejected — corrections are new snapshots attributed in the edit log (FR-AC-13). The build record is exercised at BOM level in this story; prototype build execution (Epic 10, FR-RD-08) and production trials (Epic 6) integrate against this same capture when they land
~~~~

#### E5-12 — INSERT AFTER in `epics.md`

**Findings addressed:** Q12-minor-dev-notes (5.4)

**Rationale:** Adds the 5.4 dev-notes block naming domain events and projections, and records the BOM-level-validation / later-epic-integration boundary established by E5-09 and E5-11.

**ANCHOR (insert after):**

~~~~markdown
**Given** an R&D draft BOM is proposed for production
**When** the productization gate is run (FR-B-11)
**Then** the gate requires engineering, procurement, and QC sign-offs on a checklist before a production BOM can be created, returning `error_code: "APPROVAL_REQUIRED"` until all sign-offs are recorded
~~~~

**NEW (inserted):**

~~~~markdown


**Dev Notes:**

- Domain events: `RdDraftCreated`, `RdDraftCloned`, `AsBuiltSnapshotCaptured`, `ProductizationGateSigned`. Projections: R&D draft workspace read model and as-built snapshot store (module-scoped per the DB-timing standard).
- The `rd_draft` regime flag and the as-built capture are validated at BOM level in this story; Epic 6 (production-order release) and Epic 10 (prototype build records, FR-RD-08) integrate against the same flag and capture when they land.
~~~~

#### E5-13 — REPLACE in `epics.md`

**Findings addressed:** Q2-major-5.5-explosion-given; Q4-major-5.5-sizing (resolved via the baked-in 5.6 split rather than the reviewer's three-way split); Q5-major-5.5-FR-citations (5.5 alternates/explosion/rollup); Q11-minor-5.5-scope-narrowing; FR-B-15 partial (comparison + valuation boundary); FR-B-16 partial (three supply sources + reconciliation pointer); Q1-critical-5.2-gate-forward-dep (D4, cost-rollup condition); Q12-minor-dev-notes (5.5, 5.6)

**Rationale:** Executes the baked-in split: 5.5 keeps its number with reduced scope (alternates + substitutions + explosion, FR-B-12/FR-B-07) and new Story 5.6 takes cost rollups + ERP sync + job-work kit tagging. Fixes the three wrong citations (alternates FR-B-07→FR-B-12, explosion FR-B-15→FR-B-07, rollup FR-B-08→FR-B-15). Rewrites the explosion Given as a callable service with contract tests, removing the Epic 6 forward dependency; restores FR-B-07's dropped per-plant offline replication clause, FR-B-15's comparison clause and valuation-stays-in-ERP boundary, and FR-B-16's three supply sources with the reconciliation pointer to Story 9.3. D4's cost-rollup gate condition lands as an AC in 5.6 rather than 5.5 because the baked-in split plan moves the rollup scope out of 5.5 into 5.6 — placing the gate AC in 5.5 would recreate the forward-dependency defect D4 exists to fix; 5.6 follows 5.5, so no forward reference results.

**OLD:**

~~~~markdown
### Story 5.5: Approved Alternates and BOM Explosion

As a production planner,
I want approved alternates with priority and effectivity, controlled ad-hoc substitutions, BOM explosion at order release, dated cost-rollup simulations, and job-work kit tagging, with ERP sync outbound only,
So that execution consumes the right materials and finance sees accurate, controlled costs.

**Acceptance Criteria:**

**Given** a Released BOM component with approved alternates (FR-B-07)
**When** alternates are defined
**Then** each alternate carries a priority and effectivity window and is available to execution in priority order

**Given** an operator wants to substitute a material not on the approved alternates list (FR-B-12)
**When** the substitution is attempted
**Then** it requires a logged approval resolved from the DOA registry (FR-DOA-01), returning `error_code: "APPROVAL_REQUIRED"`, and the substitution is written to the edit log

**Given** a production order is released against a Released BOM (FR-B-15)
**When** the BOM is exploded to execution
**Then** directed-issue or backflush requirements are generated per line according to the supply method

**Given** a cost rollup is requested (FR-B-08)
**When** it runs
**Then** the result is stored as a dated simulation snapshot, leaving prior snapshots intact

**Given** a job-work kit BOM (FR-B-16)
**When** it is created
**Then** each line is tagged by supply source (customer-supplied vs own)

**Given** an inbound ERP sync attempts to modify a BOM (FR-B-17)
**When** the inbound change conflicts with the platform record
**Then** ERP sync is treated as outbound-only and the inbound conflict creates a BOM Administrator exception rather than mutating the BOM

---
~~~~

**NEW:**

~~~~markdown
### Story 5.5: Approved Alternates and BOM Explosion

As a production planner,
I want approved alternates with priority and effectivity, controlled ad-hoc substitutions, and a BOM explosion service that generates directed-issue or backflush requirements per plant,
So that execution consumes the right materials in the right order of preference.

**Acceptance Criteria:**

**Given** a Released BOM component with approved alternates (FR-B-12)
**When** alternates are defined
**Then** each alternate carries a priority and effectivity window and is available to execution in priority order

**Given** an operator wants to substitute a material not on the approved alternates list (FR-B-12)
**When** the substitution is attempted
**Then** it requires a logged approval resolved from the DOA registry (FR-DOA-01), returning `error_code: "APPROVAL_REQUIRED"`, and the substitution is written to the edit log

**Given** a Released BOM and an order quantity submitted to the explosion service (FR-B-07)
**When** the BOM is exploded to execution
**Then** directed-issue or backflush requirements are generated per line according to the supply method, verified by contract tests against the service (input: Released BOM + quantity; output: per-line requirement set); production-order release (Epic 6, FR-MO-03) invokes this same service when it lands

**Given** a plant that executes offline (FR-B-07)
**When** Released BOM structures are replicated to that plant's edge devices
**Then** the explosion inputs for the plant's effective Released BOMs are replicated per plant for offline continuity via PowerSync

**Dev Notes:**

- Domain events: `AlternateDefined`, `SubstitutionApproved`, `BomExploded`. Projections: alternates-by-component read model and per-plant replicated BOM structure projection (module-scoped per the DB-timing standard).
- Cost rollups, job-work kit tagging, and ERP outbound sync are split out to Story 5.6.

---

### Story 5.6: Cost Rollups, Job-Work Kit Tagging, and ERP Outbound Sync

As a BOM administrator,
I want dated cost-rollup simulation snapshots with comparison, job-work kit BOMs tagged by supply source, and BOM sync to ERP that is strictly outbound,
So that finance sees accurate, controlled costs and the platform remains the system of record for BOM structure.

**Acceptance Criteria:**

**Given** a cost rollup is requested for a BOM (FR-B-15)
**When** it runs
**Then** the result is stored as a dated simulation snapshot, leaving prior snapshots intact

**Given** two or more dated rollup snapshots for the same BOM (FR-B-15)
**When** a comparison is requested
**Then** the snapshots are compared with per-line and total deltas highlighted

**Given** a Draft BOM without a completed cost rollup
**When** release is attempted (FR-B-06)
**Then** release is blocked with `error_code: "RELEASE_GATE_UNMET"` — the completed-cost-rollup gate condition (staged from Story 5.2) is enforced from this story onward

**Given** a job-work kit BOM (FR-B-16)
**When** it is created
**Then** each line is tagged by supply source — company, customer, or job-worker

**Given** an inbound ERP sync attempts to modify a BOM (FR-B-17)
**When** the inbound change conflicts with the platform record
**Then** ERP sync is treated as outbound-only and the inbound conflict creates a BOM Administrator exception rather than mutating the BOM

**Dev Notes:**

- Domain events: `CostRollupSnapshotted`, `JobWorkKitTagged`, `BomSyncConflictRaised`. Projections: dated rollup snapshot store with comparison view and ERP sync exception queue (module-scoped per the DB-timing standard).
- Boundary (FR-B-15): rollup snapshots are engineering/planning simulations only — inventory valuation stays in ERP, and no valuation postings originate here; cost rates arrive inbound-only per INT-ERP-01 dual mastership.
- FR-B-16 supply-source reconciliation is delivered by Epic 9 (Story 9.3), which consumes these line tags.

---
~~~~


### Epic 6: Production Orders and Manufacturing WIP — 7 edits

#### E6-01 — REPLACE in `epics.md`

**Findings addressed:** C6 (critical: 6.4 closure gate forward-dependency on Epic 8 dispositions); minor: FR-B-08 ownership ambiguity; minor: 6.3 QC Hold entity-definition timing

**Rationale:** Applies D3: declares the Epic 8 dependency the closure gate silently relied on, adds a hard-prerequisite note in the same convention Epics 5/7/8 use, states the E6/E8 division of labor over QC Hold, and claims FR-B-08 (delivered by Story 6.4) in Epic 6's coverage list.

**OLD:**

~~~~markdown
**FRs covered:** FR-MO-01, FR-MO-02, FR-MO-03, FR-MO-04, FR-MO-05, FR-MO-06, FR-MO-07, FR-MO-08, FR-MO-09, FR-MO-10, FR-MO-11, FR-MO-12, FR-MO-13

**Depends on:** Epics 1, 2, 3, 5
~~~~

**NEW:**

~~~~markdown
**FRs covered:** FR-MO-01, FR-MO-02, FR-MO-03, FR-MO-04, FR-MO-05, FR-MO-06, FR-MO-07, FR-MO-08, FR-MO-09, FR-MO-10, FR-MO-11, FR-MO-12, FR-MO-13, FR-B-08

**Depends on:** Epics 1, 2, 3, 5, 8

**Hard prerequisite:** Epic 8's QC disposition recording (FR-Q-05) must be live before the Epic 6 closure gate (FR-MO-12) activates — Epic 8 builds before Epic 6, consistent with the pilot go-live slice. Completions post into QC Hold as a stock state Epic 6 owns; dispositions against those lots are recorded by Epic 8, and Epic 6's closure gate reads Epic 8's disposition-status projection.
~~~~

#### E6-02 — REPLACE in `epics.md`

**Findings addressed:** C6 (critical: 6.4 closure gate forward-dependency on Epic 8 dispositions); minor: 6.3 QC Hold entity-definition timing

**Rationale:** Carries the D3 note into the epic body intro (the text story-context generation consumes), so the QC Hold ownership and the E8 disposition linkage are declared where the stories live, not only in the epic list.

**OLD:**

~~~~markdown
Production supervisors and operators release, execute, and close production orders against verified material availability and Released BOMs. Every finished lot carries a full as-consumed lot genealogy (FR-MO-11), and production WIP is a real-time auditable ledger in quantity and value, distinct from R&D project WIP. Offline plant execution replays cleanly on reconnection with duplicate suppression, while the release, cancel, and close operations remain central-only (FR-MO-13).
~~~~

**NEW:**

~~~~markdown
Production supervisors and operators release, execute, and close production orders against verified material availability and Released BOMs. Every finished lot carries a full as-consumed lot genealogy (FR-MO-11), and production WIP is a real-time auditable ledger in quantity and value, distinct from R&D project WIP. Offline plant execution replays cleanly on reconnection with duplicate suppression, while the release, cancel, and close operations remain central-only (FR-MO-13). Completions post into QC Hold as a stock state this epic owns — the no-bypass rule to sellable stock is enforced here — while QC dispositions against those lots are recorded by Epic 8 (FR-Q-05), whose disposition-status projection the closure gate reads; Epic 8 builds before Epic 6.
~~~~

#### E6-05 — REPLACE in `epics.md`

**Findings addressed:** major: 6.1 lifecycle AC vague / FR-MO-02 cancellation guard omitted; FR-MO-02 partial

**Rationale:** Replaces the vague state-list AC with an explicit valid-transition matrix plus the two FR-MO-02 cancellation guards (state restriction and unreversed-transaction rejection), each with a stable error code — the abuse case the FR exists to block was untested.

**OLD:**

~~~~markdown
**Given** a Planned order
**When** the lifecycle advances
**Then** it moves through `Planned`, `Released`, `In Process`, `Completed`, `Closed`, or `Cancelled` (FR-MO-02) with each transition attributed in the edit log (FR-AC-13)
~~~~

**NEW:**

~~~~markdown
**Given** a production order in any lifecycle state
**When** a state transition is requested (FR-MO-02)
**Then** only valid transitions are accepted — `Planned → Released`, `Released → In Process`, `In Process → Completed`, `Completed → Closed`, and `Planned/Released → Cancelled`; any other transition is rejected with `error_code: "INVALID_STATE_TRANSITION"`, and each accepted transition is attributed in the edit log (FR-AC-13)

**Given** an order in `In Process`, `Completed`, or `Closed` state
**When** cancellation is attempted (FR-MO-02)
**Then** it is rejected with `error_code: "INVALID_STATE_TRANSITION"` — `Cancelled` is reachable only from `Planned` or `Released`

**Given** a `Released` order with unreversed material transactions
**When** cancellation is attempted (FR-MO-02)
**Then** it is rejected with `error_code: "UNREVERSED_TRANSACTIONS"` until every issue against the order is returned or reversed
~~~~

#### E6-06 — REPLACE in `epics.md`

**Findings addressed:** minor: 6.1 release-gate override negative path + undefined availability basis

**Rationale:** Defines the availability basis (unallocated on-hand at the order's plant) and adds the missing negative path for the override authority, reusing the APPROVAL_REQUIRED code and DOA-registry pattern the document already uses elsewhere (e.g. FR-B-12 substitutions).

**OLD:**

~~~~markdown
**Given** a Planned order is submitted for release
**When** the release gate runs (FR-MO-03)
**Then** release succeeds only when an effective Released BOM exists and material availability is confirmed; insufficient availability returns `error_code: "INSUFFICIENT_STOCK"`

**Given** a named authority overrides the release gate despite an availability shortfall
**When** the override is applied
**Then** the order is released and flagged as expediting, with the override recorded to the edit log
~~~~

**NEW:**

~~~~markdown
**Given** a Planned order is submitted for release
**When** the release gate runs (FR-MO-03)
**Then** release succeeds only when an effective Released BOM exists and material availability — unallocated on-hand stock at the order's plant — covers every component line; insufficient availability returns `error_code: "INSUFFICIENT_STOCK"`

**Given** a named authority overrides the release gate despite an availability shortfall
**When** the override is applied
**Then** the order is released and flagged as expediting, with the override recorded to the edit log

**Given** a user who is not a named authority in the DOA registry (FR-DOA-01)
**When** they attempt a release-gate override
**Then** the override is rejected with `error_code: "APPROVAL_REQUIRED"` and the attempt is written to the edit log
~~~~

#### E6-07 — REPLACE in `epics.md`

**Findings addressed:** major: 6.2/6.3 off-by-one FR citations (6.2 portion); major: 6.2 missing error paths; FR-MO-06 partial

**Rationale:** Corrects the off-by-one FR citations in Story 6.2 (backflush is FR-MO-04, the WIP ledger is FR-MO-05, returns are FR-MO-06) and adds the missing error paths: backflush shortfall, mandatory reason codes on returns (an explicit FR-MO-06 clause that was dropped), and over-return rejection.

**OLD:**

~~~~markdown
**Given** an order with backflush lines
**When** a production confirmation is posted (FR-MO-05)
**Then** backflush components are relieved from stock automatically in proportion to the confirmed quantity

**Given** material has been issued to an order (FR-MO-06)
**When** the WIP ledger is viewed
**Then** the production WIP ledger for that order shows accumulated quantity and value in real time

**Given** issued material is returned from the order to stock
**When** the return is posted
**Then** WIP is reversed at the issued cost and the original lot identity is restored
~~~~

**NEW:**

~~~~markdown
**Given** an order with backflush lines
**When** a production confirmation is posted (FR-MO-04)
**Then** backflush components are relieved from stock automatically in proportion to the confirmed quantity

**Given** an order with backflush lines and insufficient component stock to cover the confirmed quantity
**When** a production confirmation is posted (FR-MO-04)
**Then** the confirmation is rejected with `error_code: "INSUFFICIENT_STOCK"` — backflush never drives stock negative — and the shortfall lines are reported to the operator

**Given** material has been issued to an order (FR-MO-05)
**When** the WIP ledger is viewed
**Then** the production WIP ledger for that order shows accumulated quantity and value in real time, distinct from R&D project WIP

**Given** issued material is returned from the order to stock (FR-MO-06)
**When** the return is posted with a mandatory reason code
**Then** WIP is reversed at the issued cost and the original lot identity is restored; a return without a reason code is rejected with `error_code: "REASON_CODE_REQUIRED"`

**Given** a return that would exceed the quantity issued to the order (FR-MO-06)
**When** the return is posted
**Then** it is rejected with `error_code: "RETURN_EXCEEDS_ISSUE"` and the WIP ledger is left unchanged
~~~~

#### E6-08 — REPLACE in `epics.md`

**Findings addressed:** major: 6.2/6.3 off-by-one FR citations (6.3 portion); major: FR-MO-09 short-completion resolution uncovered; FR-MO-09 partial; minor: 6.3 rework forward-dependency + FR-MO-10 re-entry clause dropped; minor: 6.3 QC Hold entity-definition timing (negative AC)

**Rationale:** Corrects the off-by-one FR citations in Story 6.3 (co/by-products are FR-MO-07, scrap is FR-MO-08, tolerance is FR-MO-09, rework is FR-MO-10); adds the FR-MO-09 short-completion resolution AC the epic goal promised but never tested; restores FR-MO-10's dropped re-entry clause with explicit Epic 8 linkage (now a declared dependency per D3); and adds the no-bypass negative AC for the QC Hold stock state.

**OLD:**

~~~~markdown
**Given** an In Process order
**When** a completion is confirmed (FR-MO-07)
**Then** the completed quantity posts into QC Hold as a new finished-goods lot — never directly to sellable stock

**Given** an order that yields co-products and by-products (FR-MO-08)
**When** completion is posted
**Then** each co-product and by-product is posted as its own lot separately from the primary output

**Given** process scrap occurs during the run (FR-MO-09)
**When** a scrap declaration is recorded
**Then** WIP is relieved by the declared scrap and the declaration is logged

**Given** a completion would exceed the ordered quantity plus tolerance (FR-MO-10)
**When** the over-completion is attempted
**Then** it is blocked with `error_code: "APPROVAL_REQUIRED"` until a supervisor approves the over-completion

**Given** a QC disposition requires rework
**When** a rework order is raised
**Then** a linked rework order is created referencing the source lot
~~~~

**NEW:**

~~~~markdown
**Given** an In Process order
**When** a completion is confirmed (FR-MO-07)
**Then** the completed quantity posts into QC Hold as a new finished-goods lot — never directly to sellable stock

**Given** a completion attempts to post output directly to sellable stock (FR-MO-07)
**When** the posting is validated
**Then** it is rejected with `error_code: "QC_HOLD_REQUIRED"` — sellable status is reachable only through a QC disposition recorded in Epic 8 (FR-Q-02, FR-Q-05)

**Given** an order that yields co-products and by-products (FR-MO-07)
**When** completion is posted
**Then** each co-product and by-product is posted as its own lot separately from the primary output

**Given** process scrap occurs during the run (FR-MO-08)
**When** a scrap declaration is recorded
**Then** WIP is relieved by the declared scrap and the declaration is logged, feeding the expected-vs-actual reconciliation in Story 6.4

**Given** a completion would exceed the ordered quantity plus tolerance (FR-MO-09)
**When** the over-completion is attempted
**Then** it is blocked with `error_code: "APPROVAL_REQUIRED"` until a supervisor approves the over-completion

**Given** an order confirmed complete below the ordered quantity minus tolerance (FR-MO-09)
**When** the supervisor resolves the short completion
**Then** an explicit close-short decision with a reason code is recorded, residual WIP is dispositioned (returned to stock or declared as process scrap), and the order becomes eligible for the FR-MO-12 closure gate at the reduced quantity — an order with an unresolved short completion cannot pass closure

**Given** a QC disposition recorded in Epic 8 requires rework (FR-MO-10)
**When** a rework order is raised
**Then** a linked rework order is created referencing the source lot, and the rework order's output posts back into QC Hold as linked lots — re-entering the QC gate, never bypassing it
~~~~

#### E6-09 — REPLACE in `epics.md`

**Findings addressed:** C6 (critical: 6.4 closure gate forward-dependency on Epic 8 dispositions); major: FR-MO-12 closed-order immutability uncovered; FR-MO-12 partial; minor: 6.4 central-only enforcement lacks observable outcome

**Rationale:** Fixes C6 by pointing the closure gate at Epic 8's disposition-status projection (the dependency now declared in the header), adds the FR-MO-12 closed-order immutability negative AC that was entirely uncovered, and makes the central-only rule observable with client-side blocking plus a server-side rejection code on replay.

**OLD:**

~~~~markdown
**Given** an order is submitted for closure (FR-MO-12)
**When** the closure gate runs
**Then** closure succeeds only when WIP is zero, no picks are open, and every output lot has a QC disposition; a non-zero WIP blocks closure

**Given** plant execution occurs offline (FR-MO-13)
**When** the device reconnects
**Then** replicated order data is replayed in sequence with duplicate suppression via `error_code: "DUPLICATE_EVENT"`, and release, cancel, and close remain central-only operations
~~~~

**NEW:**

~~~~markdown
**Given** an order is submitted for closure (FR-MO-12)
**When** the closure gate runs
**Then** closure succeeds only when WIP is zero, no picks are open, and the disposition-status projection maintained by Epic 8 (FR-Q-05, a declared dependency of this epic) shows a recorded QC disposition for every output lot; a non-zero WIP or an undispositioned lot blocks closure

**Given** a Closed production order (FR-MO-12)
**When** any issue, completion, return, scrap declaration, or field edit is attempted against it
**Then** the attempt is rejected with `error_code: "ORDER_CLOSED"` and written to the edit log — closed orders are immutable

**Given** plant execution occurs offline (FR-MO-13)
**When** the device reconnects
**Then** replicated order data is replayed in sequence with duplicate suppression via `error_code: "DUPLICATE_EVENT"`, and release, cancel, and close remain central-only operations

**Given** an offline device attempts a release, cancel, or close operation (FR-MO-13)
**When** the operation is invoked offline or arrives in a replayed queue
**Then** it is blocked client-side while offline and, if replayed, rejected server-side with `error_code: "CENTRAL_ONLY_OPERATION"` and an edit-log entry
~~~~


### Epic 7: Maintenance, Calibration, and Asset Regist — 8 edits

#### E7-01 — REPLACE in `epics.md`

**Findings addressed:** minor: 7.1 fixed-asset forward-dependency; minor: 7.1 duplicate-registration vague-ac

**Rationale:** The fixed-asset link AC presumed a fixed-asset record exists, but the fixed-asset module is Phase 2 (Epic 17, no stories) — reworded as a nullable external reference with an explicit Phase-2 deferral note. The duplicate-registration AC named no detection key and no error code; it now specifies the uniqueness key and a stable DUPLICATE_ASSET code, matching sibling enforcement ACs (CALIBRATION_LOCKOUT, DUPLICATE_EVENT).

**OLD:**

~~~~markdown
**Given** an asset with a corresponding fixed-asset record
**When** the maintenance record is created
**Then** the fixed-asset link is optional and may be attached without being mandatory

**Given** an asset already exists in the register
**When** a duplicate registration is attempted for the same physical asset
**Then** creation is blocked to preserve the one-asset, one-record rule
~~~~

**NEW:**

~~~~markdown
**Given** an asset being registered (FR-M-01)
**When** the maintenance record is created
**Then** the record carries an optional, nullable fixed-asset reference field captured as a free identifier, which may be left empty; no lookup against a fixed-asset module is performed

**Given** an asset already exists in the register with a given serial number (or manufacturer + model + serial combination where no serial exists)
**When** a duplicate registration is attempted for the same uniqueness key
**Then** creation is blocked with `error_code: "DUPLICATE_ASSET"` to preserve the one-asset, one-record rule

**Note:** Deferred to Phase 2 (Epic 17): validation of the fixed-asset reference against FR-FA fixed-asset records; until then the link is a nullable external reference only.
~~~~

#### E7-02 — REPLACE in `epics.md`

**Findings addressed:** major: 7.2 forward-dependency (hub bookings); FR-M-03 partial

**Rationale:** The story sentence made hub bookings (delivered by Story 10.4 in Epic 10, outside the pilot slice) the named meter feed while omitting FR-M-03's manual readings — the only E7-native, pilot-testable source. Reworded around a generic ingestion API with manual readings primary.

**OLD:**

~~~~markdown
As a maintenance planner,
I want calendar-based and meter-based PM plans that auto-generate work orders with grace-window tracking, fed by usage meters from hub bookings and equipment readings,
So that preventive maintenance happens on schedule without manual creation.
~~~~

**NEW:**

~~~~markdown
As a maintenance planner,
I want calendar-based and meter-based PM plans that auto-generate work orders with grace-window tracking, fed by a generic meter-reading ingestion API whose Phase-1 primary source is manually entered readings,
So that preventive maintenance happens on schedule without manual creation.
~~~~

#### E7-03 — REPLACE in `epics.md`

**Findings addressed:** major: 7.2 forward-dependency (hub bookings); FR-M-03 partial; minor: 7.2 grace-window missing-outcome

**Rationale:** Restores FR-M-03's omitted manual-readings source as an explicit, pilot-testable AC; recasts hub bookings/station equipment as later sources into a source-agnostic ingestion API with an Epic 10 / INT-MTR-01 dependency note; adds an observable breach outcome (overdue state + escalation) to grace-window tracking.

**OLD:**

~~~~markdown
**Given** an asset from Story 7.1
**When** a calendar-based or meter-based PM plan is defined (FR-M-02)
**Then** the plan auto-generates work orders as due, tracking each against its grace window

**Given** a meter-based PM plan (FR-M-03)
**When** usage readings arrive from hub bookings or equipment readings
**Then** the asset's usage meter advances and PM due calculations update accordingly

**Given** a meter that has reported no readings for a configured interval
**When** the monthly reconciliation runs
**Then** a silent-meter alert is raised and the meter is reconciled
~~~~

**NEW:**

~~~~markdown
**Given** an asset from Story 7.1
**When** a calendar-based or meter-based PM plan is defined (FR-M-02)
**Then** the plan auto-generates work orders as due, tracking each against its grace window

**Given** a generated PM work order that passes its grace window uncompleted (FR-M-02)
**When** the grace window expires
**Then** the work order transitions to an overdue state and an escalation alert is raised to the maintenance planner

**Given** a meter-based PM plan (FR-M-03)
**When** a technician or operator submits a manual meter reading against the asset
**Then** the reading is accepted through the meter-reading ingestion API, the asset's usage meter advances, and PM due calculations update accordingly

**Given** the meter-reading ingestion API (FR-M-03)
**When** a reading arrives from any registered source (manual entry in Phase 1; hub bookings and station equipment when their feeds come online)
**Then** the reading is applied identically regardless of source, and each reading records its source and capture method

**Given** a meter that has reported no readings for a configured interval
**When** the monthly reconciliation runs
**Then** a silent-meter alert is raised and the meter is reconciled

**Note:** Manual readings are the primary Phase-1 meter feed. Hub-booking usage publication into the meter-reading ingestion API is delivered by Epic 10 (Story 10.4, maker-hub machine-time booking), which is outside the pilot go-live slice; automated station-equipment ingestion is deferred to Phase 2 (INT-MTR-01). This story must not block on either feed.
~~~~

#### E7-04 — REPLACE in `epics.md`

**Findings addressed:** FR-M-06 partial

**Rationale:** FR-M-06 requires monthly MTTR/MTBF 'per asset and class'; the AC computed per asset only. Adds the criticality-class-level aggregation.

**OLD:**

~~~~markdown
**Given** breakdown work orders with recorded downtime (FR-M-06)
**When** the monthly reliability report runs
**Then** MTTR and MTBF are computed per asset from captured downtime
~~~~

**NEW:**

~~~~markdown
**Given** breakdown work orders with recorded downtime (FR-M-06)
**When** the monthly reliability report runs
**Then** MTTR and MTBF are computed from captured downtime both per asset and aggregated per criticality class
~~~~

#### E7-05 — REPLACE in `epics.md`

**Findings addressed:** major: 7.4 undeclared-dependency (E3, equipment BOM); major: off-by-one FR citations 7.4/7.6; major: 7.6 sizing grab-bag (split plan 7.7); FR-M-10/11 partial

**Rationale:** Split per plan: AMC/warranty/insurance move to new Story 7.7; 7.4 keeps its number with reduced scope. 'Where-used from equipment BOMs' referenced an entity no story created — now an explicit maintenance-owned asset parts list created in this story, distinct from the Epic 5 manufacturing BOM. Spares mechanics are pinned to the declared Epic 2 stock ledger. The mis-cited (FR-M-09, FR-M-10) AMC AC leaves this story; FR tags realigned to the canonical FR-M-07/08/09 grouping.

**OLD:**

~~~~markdown
### Story 7.4: Spare Parts, AMC, Warranty, and Insurance Tracking

As a maintenance storekeeper,
I want spares catalogued in inventory with where-used links, reservation and issue with timed returns, critical-spares min-max alerts, and AMC/warranty/insurance expiry tracking,
So that the right spares are on hand and contract coverage never lapses unnoticed.

**Acceptance Criteria:**

**Given** spare parts used in maintenance (FR-M-07)
**When** they are catalogued in inventory
**Then** each spare shows where-used from equipment BOMs and can be reserved and issued, with returns due within 3 working days

**Given** a critical spare with defined min-max levels (FR-M-08)
**When** stock breaches the minimum
**Then** a same-day breach alert is raised

**Given** assets under AMC, warranty, or insurance (FR-M-09, FR-M-10)
**When** an expiry approaches
**Then** alerts are raised at 90, 60, and 30 days before expiry

**Given** a breakdown work order is created for an asset under warranty (FR-M-11)
**When** the work order is opened
**Then** the system performs a warranty check and flags that the repair may be covered before chargeable work proceeds
~~~~

**NEW:**

~~~~markdown
### Story 7.4: Spare Parts Cataloguing, Reservation, and Critical-Spares Alerts

As a maintenance storekeeper,
I want spares catalogued in inventory with where-used links from a maintenance-owned asset parts list, reservation and issue with timed returns, and critical-spares min-max alerts,
So that the right spares are on hand when a work order needs them.

**Acceptance Criteria:**

**Given** an asset from Story 7.1 (FR-M-07)
**When** its spare parts are defined
**Then** a maintenance-owned asset parts list (equipment BOM) is recorded against the asset register — a distinct entity from the Epic 5 manufacturing BOM, created in this story — and each spare shows where-used across the assets whose parts lists reference it

**Given** spare parts used in maintenance (FR-M-07, FR-M-08)
**When** they are catalogued in inventory
**Then** each spare is catalogued under the Epic 2 stock ledger (per FR-I) and can be reserved and issued against a work order, with returns due within 3 working days

**Given** a critical spare with defined min-max levels (FR-M-09)
**When** stock breaches the minimum
**Then** a same-day breach alert is raised

**Note:** Spares cataloguing, reservation, and issue ride on the Epic 2 stock ledger (declared dependency); no new inventory mechanics are built here. AMC, warranty, and insurance tracking moved to Story 7.7.
~~~~

#### E7-06 — REPLACE in `epics.md`

**Findings addressed:** major: 7.6 sizing grab-bag; major: off-by-one FR citations 7.4/7.6; major: FR-M-16 sign-off missing-error-path; FR-M-16 partial; minor: FR-M-15 repair-vs-capitalize dropped; FR-M-15 partial; major: 7.4 undeclared-dependency (E3, equipment BOM)

**Rationale:** Rescopes the grab-bag story per the split plan (offline workflow + closure codes leave for Story 7.8), fixes all three off-by-one citations against the canonical FR-M list (re-stamping FR-M-15→FR-M-14, cost FR-M-16→FR-M-15, broadcast FR-M-17→FR-M-16), restores FR-M-16's dropped return-to-service supervisor sign-off as a negative-path AC with the architecture's APPROVAL_REQUIRED code, adds FR-M-15's repair-vs-capitalize flag capture with an explicit Phase-2 Epic 17 deferral for FR-FA routing, and notes the Epic 3 weighment hook.

**OLD:**

~~~~markdown
### Story 7.6: Statutory Examinations, Machine Status Broadcast, and Closure Codes

As a maintenance supervisor,
I want statutory examination tracking that locks overdue assets, weighbridge re-stamping enforcement, cost accumulation per asset, a fast machine-status broadcast, offline technician workflows, and closure codes with history,
So that legal examinations, trade weighment integrity, and reliable status are all guaranteed.

**Acceptance Criteria:**

**Given** an asset subject to statutory examination (FR-M-14)
**When** its examination becomes overdue (e.g. OSH Code or 12-month weighbridge stamping)
**Then** the asset is locked from use until re-examined

**Given** a weighbridge that has undergone repair (FR-M-15)
**When** trade weighment is attempted before re-stamping
**Then** the weighment is blocked until the weighbridge is re-stamped

**Given** maintenance activities incurring cost (FR-M-16)
**When** work orders are closed
**Then** maintenance cost accumulates per asset for lifecycle costing

**Given** a machine changes operational status (FR-M-17)
**When** the change is recorded
**Then** the status broadcast reaches subscribers within 2 minutes, and technician workflows function offline and replay on reconnection

**Given** a work order is closed (FR-M-18)
**When** a closure code is applied
**Then** the closure code is recorded and the last five closures for the asset are available as history
~~~~

**NEW:**

~~~~markdown
### Story 7.6: Statutory Examinations, Cost Accumulation, and Machine Status Broadcast

As a maintenance supervisor,
I want statutory examination tracking that locks overdue assets, weighbridge re-stamping enforcement, cost accumulation per asset with a repair-vs-capitalize flag, and a fast machine-status broadcast gated by supervisor sign-off on return to service,
So that legal examinations, trade weighment integrity, lifecycle costing, and reliable status are all guaranteed.

**Acceptance Criteria:**

**Given** an asset subject to statutory examination (FR-M-14)
**When** its examination becomes overdue (e.g. OSH Code or 12-month weighbridge stamping)
**Then** the asset is locked from use until re-examined

**Given** a weighbridge that has undergone repair (FR-M-14)
**When** trade weighment is attempted before re-stamping
**Then** the weighment is blocked until the weighbridge is re-stamped

**Given** maintenance activities incurring cost (FR-M-15)
**When** work orders are closed
**Then** maintenance cost accumulates per asset for lifecycle costing, and any work order whose cost exceeds the configured capitalization threshold is flagged repair-vs-capitalize at closure

**Given** a machine changes operational status (FR-M-16)
**When** the change is recorded
**Then** the status broadcast reaches production planning and hub booking subscribers within 2 minutes

**Given** a machine in breakdown or maintenance status (FR-M-16)
**When** return-to-service is attempted without a recorded supervisor sign-off
**Then** the status change is rejected with `error_code: "APPROVAL_REQUIRED"` and the asset remains out of service until a supervisor signs off

**Note:** The trade-weighment block executes inside the Epic 3 FR-W weighbridge flow (declared dependency). Deferred to Phase 2 (Epic 17): routing of above-threshold repair-vs-capitalize flagged work orders into the FR-FA capitalization queue — Phase 1 captures the flag and threshold check at closure only. Offline technician workflows and closure codes moved to Story 7.8.
~~~~

#### E7-07 — REPLACE in `epics.md`

**Findings addressed:** major: 7.6 sizing grab-bag; major: 7.6 vague offline AC; FR-M-17 partial; major: 7.4 warranty override missing-error-path; FR-M-10/11 partial; FR-M-18 partial; major: off-by-one FR citations 7.4/7.6

**Rationale:** Adds the two split-off stories at the end of the epic. Story 7.7 carries AMC/warranty/insurance out of 7.4 with correct FR-M-10/11 citations and restores the missing reason-coded override as an enforcement AC (APPROVAL_REQUIRED) with event-stream capture. Story 7.8 carries the offline workflow and closure codes out of 7.6, replacing the untestable clause with enumerated offline flows, sequenced replay with DUPLICATE_EVENT per the Epic 6 pattern, FR-M-17 conflict flagging via STREAM_CONFLICT with an observable supervisor-queue outcome, FR-M-18 three-part fault/cause/remedy coding enforced at closure, and last-five-closures presented at work-order open.

**OLD:**

~~~~markdown
---

## Epic 8: Quality Control and Batch Release
~~~~

**NEW:**

~~~~markdown
---

### Story 7.7: AMC, Warranty, and Insurance Tracking

As a maintenance manager,
I want AMC, warranty, and insurance records against assets with staged expiry alerts and a warranty check at work-order creation that only a reason-coded override can bypass,
So that contract coverage never lapses unnoticed and warranty-covered repairs are never paid for by mistake.

**Acceptance Criteria:**

**Given** assets under AMC, warranty, or insurance (FR-M-10)
**When** an expiry approaches
**Then** alerts are raised at 90, 60, and 30 days before expiry

**Given** a breakdown work order is created for an asset under warranty (FR-M-11)
**When** the work order is opened
**Then** the system performs a warranty check and flags that the repair may be covered before chargeable work proceeds

**Given** a warranty-flagged work order (FR-M-11)
**When** chargeable work is attempted without a recorded reason-coded override
**Then** the work is blocked with `error_code: "APPROVAL_REQUIRED"` until an override with a reason code is recorded

**Given** a reason-coded override is recorded on a warranty-flagged work order (FR-M-11)
**When** chargeable work then proceeds
**Then** the override, its reason code, and the overriding actor are captured in the event stream

---

### Story 7.8: Offline Technician Workflow and Closure Codes

As a maintenance technician,
I want my day-to-day workflows — fault reporting, work-order status updates, meter readings, spares issue confirmation, and work-order closure — to function fully offline with clean sync, conflict flagging, and three-part closure coding,
So that maintenance work continues uninterrupted in the plant and every closure builds the asset's failure history.

**Acceptance Criteria:**

**Given** a technician device operating offline (FR-M-17)
**When** fault reports, work-order status updates, meter readings, spares issue confirmations, or work-order closures are captured
**Then** each is stored locally with an `idempotency_key` and, on reconnection, replayed in sequence with duplicate suppression via `error_code: "DUPLICATE_EVENT"`

**Given** an offline-captured event that conflicts with a change accepted centrally while the device was offline (FR-M-17)
**When** the replay is processed
**Then** the conflicting event is rejected with `error_code: "STREAM_CONFLICT"`, flagged in a sync-conflict queue, and surfaced to the maintenance supervisor for resolution

**Given** a work order is submitted for closure (FR-M-18)
**When** closure codes are applied
**Then** three-part closure coding — fault, cause, and remedy — is recorded, and closure is rejected until all three codes are present

**Given** a work order is opened for an asset (FR-M-18)
**When** the technician views the work order
**Then** the last five closures for that asset (fault, cause, remedy) are presented at work-order open

**Note:** Offline behavior covers the technician flows delivered in Stories 7.2-7.6 and follows the Epic 1 edge sync foundation (PowerSync, idempotency keys). Return-to-service sign-off (Story 7.6) remains a central-only operation.

---

## Epic 8: Quality Control and Batch Release
~~~~

#### E7-08 — REPLACE in `epics.md`

**Findings addressed:** major: 7.4 undeclared-dependency (E3, equipment BOM)

**Rationale:** Story 7.6's weighbridge re-stamping AC blocks trade weighment, an Epic 3 FR-W flow, but the Epic 7 header declared only Epics 1 and 2. Declares Epic 3 as a backward dependency so the coverage audit and build sequencing reflect the real hook.

**OLD:**

~~~~markdown
**FRs covered:** FR-M-01, FR-M-02, FR-M-03, FR-M-04, FR-M-05, FR-M-06, FR-M-07, FR-M-08, FR-M-09, FR-M-10, FR-M-11, FR-M-12, FR-M-13, FR-M-14, FR-M-15, FR-M-16, FR-M-17, FR-M-18

**Depends on:** Epics 1, 2
~~~~

**NEW:**

~~~~markdown
**FRs covered:** FR-M-01, FR-M-02, FR-M-03, FR-M-04, FR-M-05, FR-M-06, FR-M-07, FR-M-08, FR-M-09, FR-M-10, FR-M-11, FR-M-12, FR-M-13, FR-M-14, FR-M-15, FR-M-16, FR-M-17, FR-M-18

**Depends on:** Epics 1, 2, 3 (backward: the Story 7.6 re-stamping block executes inside the Epic 3 FR-W trade-weighment flow; build order unaffected)
~~~~


### Epic 8: Quality Control and Batch Release — story  — 7 edits

#### E8-01 — REPLACE in `epics.md`

**Findings addressed:** minor: 8.5 where-used/where-shipped dependency gap (FR-Q-09); major: 8.6 missing compliance master data (A-13 pointer); major: 8.3/8.1 rework-and-completions dependency on Story 6.3

**Rationale:** Declares the Epic 3 dependency the where-shipped trace already relies on (Story 3.7 is an explicit FR-Q-09 integration point and is earlier in the pilot slice); repoints the A-13 migration prerequisite at the new Story 8.7 licence register that now owns the schema; and records the D3-consistent E6-on-E8 direction with the pilot completion source so the QC gate is not read as forward-depending on Epic 6.

**OLD:**

~~~~markdown
**Depends on:** Epics 1, 2, 7

**Hard prerequisite:** Epic 7 instrument records loaded before Epic 8 calibration lockout activates (C-12). BIS licence data in product master before FR-Q-11 goes live (A-13).
~~~~

**NEW:**

~~~~markdown
**Depends on:** Epics 1, 2, 3, 7 — Epic 3 supplies the dispatch documents and `LOT_ON_HOLD` dispatch gate (Story 3.7) behind the where-shipped trace (FR-Q-09)

**Hard prerequisite:** Epic 7 instrument records loaded before Epic 8 calibration lockout activates (C-12). BIS licence data loaded into the Story 8.7 licence register before the Story 8.6 FR-Q-11 release block goes live (A-13).

**Sequencing note:** Epic 6 depends on this epic: production completions and rework orders (Story 6.3) subscribe to this epic's completion-event and rework-requested contracts when Epic 6 lands. At pilot, completions enter the QC gate from finished job-work output (Story 9.4).
~~~~

#### E8-02 — REPLACE in `epics.md`

**Findings addressed:** major: 8.3/8.1 rework-and-completions dependency on Story 6.3 (8.1 AC3 part); minor: 8.1 conditional-release underdefined

**Rationale:** Makes the no-bypass gate testable within declared dependencies by defining a completion-event contract with named pilot producers (Story 9.4) and later E6 producers, instead of an undefined 'any production or goods completion' that only pilot-skipped Story 6.3 emits. Rewrites the conditional-release escape valve to create the FR-Q-05 deviation record as an explicit artifact, resolve the approver through the DOA registry (per AD-3, no hard-coded roles), land in a distinct observable state, and adds the missing unauthorized-attempt negative path with the document's standard APPROVAL_REQUIRED code.

**OLD:**

~~~~markdown
**Given** any production or goods completion
**When** it posts (FR-Q-02)
**Then** it enters QC Hold with no bypass path to sellable stock

**Given** an urgent need to move a lot before full inspection completes
**When** conditional release is requested
**Then** the lot may be conditionally released under recorded conditions rather than bypassing the gate
~~~~

**NEW:**

~~~~markdown
**Given** a completion event conforming to the QC completion-event contract published by this story (FR-Q-02)
**When** it posts — finished job-work output (Story 9.4) at pilot, production completions (Story 6.3) when Epic 6 lands (Epic 6 depends on this epic), or a synthetic contract-conformance test event
**Then** the resulting lot enters QC Hold with no bypass path to sellable stock

**Given** an urgent need to move a lot before full inspection completes (FR-Q-02, FR-Q-05)
**When** a user whose authority the DOA registry resolves (Story 1.4) requests conditional release
**Then** a deviation record with the recorded conditions and an expiry is created and the lot moves to the distinct `Conditionally Released` state rather than bypassing the gate

**Given** a lot in QC Hold
**When** conditional release is requested by a user the DOA registry does not resolve as authorized
**Then** the request is rejected with `error_code: "APPROVAL_REQUIRED"`
~~~~

#### E8-03 — REPLACE in `epics.md`

**Findings addressed:** minor: 8.2 AQL parameter source unstated

**Rationale:** Closes the verified residue of the AQL finding: the parameter source was unstated. The inspection plan (the AC's own Given) is declared as the carrier of the AQL value and inspection level, with General Level II as the default — making the table lookup fully determined without embedding redundant example tables from a deterministic standard.

**OLD:**

~~~~markdown
**Given** a lot in QC Hold with an approved inspection plan
**When** sampling is determined (FR-Q-03)
**Then** the sample size and acceptance number follow AQL per IS 2500 / ISO 2859-1 with normal/tightened/reduced switching rules applied
~~~~

**NEW:**

~~~~markdown
**Given** a lot in QC Hold with an approved inspection plan carrying the plan's AQL value and inspection level (General Inspection Level II unless the plan overrides it)
**When** sampling is determined (FR-Q-03)
**Then** the sample size and acceptance number follow the IS 2500 / ISO 2859-1 tables for that AQL value and inspection level, with normal/tightened/reduced switching rules applied per the standard's switching criteria
~~~~

#### E8-04 — REPLACE in `epics.md`

**Findings addressed:** major: 8.3/8.1 rework-and-completions dependency on Story 6.3 (AC4); minor: 8.3 NCR scrap routes to Phase-2 FR-SC; minor: inconsistent error codes (8.3 part); minor: 8.3 split conservation missing

**Rationale:** Gives the single-disposition invariant its missing stable error code (DISPOSITION_EXISTS), adds the quantity-conservation rule and over-split negative path (reusing INSUFFICIENT_STOCK), bounds the Phase-1 scrap outcome to a recorded disposition parked in Blocked/scrap-pending with an explicit Epic 16 deferral note, and reverses the rework AC's direction to match the now-declared E6-on-E8 dependency: this story emits the rework-requested contract; Story 6.3 consumes it when Epic 6 lands, so the AC is testable at pilot.

**OLD:**

~~~~markdown
**Given** a lot that has been inspected (FR-Q-05)
**When** a disposition is recorded
**Then** exactly one disposition (accept, reject, or conditional release) is stored per lot and a second disposition attempt is rejected

**Given** a lot where only part of the quantity conforms (FR-Q-05)
**When** the inspector splits the lot
**Then** partial splits are supported with independent dispositions per split

**Given** a rejected lot raising an NCR (FR-Q-06)
**When** the NCR outcome is set
**Then** the outcome routes to rework (re-enters the gate), downgrade to seconds, or scrap

**Given** an NCR outcome of rework
**When** the rework order is created
**Then** a linked rework order creates a new lot that re-enters QC (integration with Story 6.3)
~~~~

**NEW:**

~~~~markdown
**Given** a lot that has been inspected (FR-Q-05)
**When** a disposition is recorded
**Then** exactly one disposition (accept, reject, or conditional release) is stored per lot and a second disposition attempt is rejected with `error_code: "DISPOSITION_EXISTS"`

**Given** a lot where only part of the quantity conforms (FR-Q-05)
**When** the inspector splits the lot
**Then** partial splits are supported with independent dispositions per split, the sum of split quantities equals the original lot quantity, and a split allocating more than the lot contains is rejected with `error_code: "INSUFFICIENT_STOCK"`

**Given** a rejected lot raising an NCR (FR-Q-06)
**When** the NCR outcome is set
**Then** the outcome routes to rework (re-enters the gate), downgrade to seconds, or scrap — a scrap outcome records the scrap disposition and moves the quantity to `Blocked` (scrap-pending), retaining the event for Phase 2 FR-SC processing

**Given** an NCR outcome of rework (FR-Q-06)
**When** the rework outcome is recorded
**Then** the lot is flagged for rework and a rework-requested event is emitted; when Story 6.3 lands (Epic 6 depends on this epic), the linked rework order it creates produces a new lot that re-enters the QC gate

**Dev Notes:**

- Deferred to Phase 2 (Epic 16): the physical scrap disposal workflow ("scrap to FR-SC" in FR-Q-06). In Phase 1 an NCR scrap outcome parks quantity in `Blocked` (scrap-pending); Epic 16 subscribers consume the retained events without changes to this story.
- Rework-order creation is delivered by Story 6.3 (Epic 6, which depends on this epic); this story's rework-requested event is the integration contract and is testable with a synthetic subscriber before Epic 6 lands.
~~~~

#### E8-05 — REPLACE in `epics.md`

**Findings addressed:** FR-Q-07 partial (BIS STI floor); dropped: FR-Q-07 STI clause; FR-Q-11 partial (CM/L or R-number on CoC); minor: inconsistent error codes (8.4 part); minor: 8.4 retention expiry lead time / undefined disposal

**Rationale:** Restores the dropped FR-Q-07 clause — retention 'never below BIS STI requirements' — as both a positive floor on the retention AC and a negative-path configuration rejection (new semantic code RETENTION_FLOOR_VIOLATION). Adds the FR-Q-11 CM/L-or-R-number-on-CoC AC sourced from the Story 8.7 register. Gives the retention-sample release block its stable code (RETENTION_SAMPLE_REQUIRED), fixes the expiry-alert lead time at 30 days, and defines Phase-1 'disposal' as a recorded event into Blocked/disposal-pending with an explicit Epic 16 deferral note.

**OLD:**

~~~~markdown
**Given** an accepted lot (FR-Q-07)
**When** it is released
**Then** a batch release record and a CoA or CoC are generated for the lot and retained for a default 7 years

**Given** a lot requiring a retention sample (FR-Q-08)
**When** release is attempted before the retention sample is logged
**Then** release is blocked until the retention sample is recorded

**Given** a retention sample approaching its expiry
**When** the expiry alert fires
**Then** the sample is routed to disposal
~~~~

**NEW:**

~~~~markdown
**Given** an accepted lot (FR-Q-07)
**When** it is released
**Then** a batch release record and a CoA or CoC are generated for the lot and retained for a default 7 years, and for BIS-covered products never below the retention period mandated by the applicable BIS Scheme of Testing and Inspection (STI)

**Given** a BIS-covered product whose STI mandates a retention period longer than the configured value (FR-Q-07)
**When** an administrator attempts to configure retention below the STI floor
**Then** the configuration is rejected with `error_code: "RETENTION_FLOOR_VIOLATION"`

**Given** an accepted lot of a BIS-covered product (FR-Q-11)
**When** the CoC is generated
**Then** the CM/L or R-number from the Story 8.7 licence register is printed on the CoC

**Given** a lot requiring a retention sample (FR-Q-08)
**When** release is attempted before the retention sample is logged
**Then** release is rejected with `error_code: "RETENTION_SAMPLE_REQUIRED"` until the retention sample is recorded

**Given** a retention sample approaching its expiry (FR-Q-08)
**When** the expiry alert fires 30 days before expiry
**Then** a recorded disposal event routes the sample to `Blocked` (disposal-pending)

**Dev Notes:**

- Deferred to Phase 2 (Epic 16): physical disposal of expired retention samples. Phase 1 records the disposal event and parks the sample in `Blocked` (disposal-pending) for FR-SC processing.
~~~~

#### E8-06 — REPLACE in `epics.md`

**Findings addressed:** minor: 8.5 where-used/where-shipped dependency gap (FR-Q-09); minor: 8.5 offline propagation missing error path

**Rationale:** Anchors the trace to the concrete, now-declared sources — Story 3.7 dispatch documents plus the Story 2.3 lot trace for where-shipped, Story 9.3 consumption at pilot with Story 6.4 genealogy deepening it later — replacing an AC that implied undeclared/pilot-skipped inputs. Adds the missing offline-device semantics: 'everywhere within 15 minutes' now binds connected nodes, while a stale offline device gets defined reconnect behavior with LOT_ON_HOLD rejection on replay, matching the central-enforcement architecture and NFR-P-04's visible-degraded-state framing.

**OLD:**

~~~~markdown
**Given** a quality issue on a lot (FR-Q-09)
**When** a quality hold is placed
**Then** all instances of that stock flip to `Blocked` everywhere and a where-used and where-shipped trace is available within 15 minutes
~~~~

**NEW:**

~~~~markdown
**Given** a quality issue on a lot (FR-Q-09)
**When** a quality hold is placed
**Then** all instances of that stock flip to `Blocked` on every connected node and a where-used and where-shipped trace is available within 15 minutes — where-shipped over Epic 3 dispatch documents (Story 3.7) and the Story 2.3 lot trace, where-used over whatever consumption event types exist (job-work consumption from Story 9.3; production genealogy from Story 6.4 deepens the trace when Epic 6 lands)

**Given** an edge device that was offline when the hold was placed (FR-Q-09)
**When** the device reconnects
**Then** the hold is applied on the device immediately on reconnect and any queued transaction against the held lot is rejected on replay with `error_code: "LOT_ON_HOLD"` and flagged for supervisor review — the central write path (Story 2.3) and dispatch gate (Story 3.7) reject held-lot transactions throughout, regardless of device state
~~~~

#### E8-07 — REPLACE in `epics.md`

**Findings addressed:** major: 8.6 sizing grab-bag; major: 8.6 missing compliance master data; major: 8.6 prototype forward-dependency (FR-Q-12); minor: 8.6 dashboard vague ACs; minor: inconsistent error codes (8.6 part); FR-Q-11 partial (licence register + number on release record); FR-Q-13 partial (named metrics); FR-Q-15 partial (recorded notice)

**Rationale:** Breaks up the five-FR grab-bag per the fixed split plan: 8.6 keeps the statutory release blocks (FR-Q-11, FR-Q-14) and the FR-Q-13 reporting suite; 8.8 takes witnessed inspections (FR-Q-15) and prototype rules (FR-Q-12). Both blocking ACs now check against Story 8.7's governed master data (licence register with CM/L and R-numbers and validity, DOA-approved versioned label masters), closing the missing-capability hole, and get stable codes (BIS_LICENCE_INVALID, LABEL_VERSION_MISSING). The dashboard AC enumerates the five FR-Q-13 metrics with a verifiable first-pass-yield computation and named drill-through targets. 8.8 rewords the prototype AC as a stock-class-level block (PROTOTYPE_NOT_SALEABLE) testable with Epic 2 data — removing the forward dependency on pilot-skipped Story 10.3, which a sequencing dev note makes explicit — and adds the FR-Q-15 recorded-notice AC plus DOA-approved waivers, with dispatch blocking reusing the Story 3.7 LOT_ON_HOLD gate.

**OLD:**

~~~~markdown
### Story 8.6: BIS Hooks, Label Compliance, and Witnessed Inspections

As a compliance officer,
I want BIS licence validity and Legal Metrology label version control to block release, prototype verification kept non-saleable, a quality dashboard, and customer-witnessed inspection hold points,
So that no lot ships without its statutory and contractual quality gates satisfied.

**Acceptance Criteria:**

**Given** a product requiring a BIS licence (FR-Q-11)
**When** release is attempted with an invalid or expired BIS licence
**Then** release is blocked and a valid CM/L or R-number must appear on the release record

**Given** a packaged commodity requiring a Legal Metrology label (FR-Q-14)
**When** release is attempted without a current approved label version
**Then** release is blocked until the version-controlled, approved label is in place

**Given** a prototype requiring verification (FR-Q-12)
**When** verification is recorded
**Then** it is captured as design evidence and the prototype remains barred from saleable stock

**Given** a QC head opens the quality reporting dashboard (FR-Q-13)
**When** the dashboard loads
**Then** quality KPIs and open exceptions are shown with drill-through

**Given** an order requiring customer-witnessed or third-party inspection (FR-Q-15)
**When** a hold point is reached
**Then** the lot is held until the witness signs off or a recorded waiver is applied
~~~~

**NEW:**

~~~~markdown
### Story 8.6: Statutory Release Blocks and Quality Reporting

As a compliance officer,
I want BIS licence validity and Legal Metrology label version control to block release against the Story 8.7 compliance master data, and a quality reporting dashboard over the FR-Q-13 metrics,
So that no lot ships without its statutory quality gates satisfied and quality performance is measurable.

**Acceptance Criteria:**

**Given** a product requiring a BIS licence (FR-Q-11)
**When** release is attempted and the Story 8.7 licence register holds no valid, unexpired licence for the product
**Then** release is rejected with `error_code: "BIS_LICENCE_INVALID"`

**Given** a product requiring a BIS licence with a valid licence in the Story 8.7 register (FR-Q-11)
**When** release completes
**Then** the CM/L or R-number from the register is printed on the release record

**Given** a packaged commodity requiring a Legal Metrology label (FR-Q-14)
**When** release is attempted without a current approved label version in the Story 8.7 label masters
**Then** release is rejected with `error_code: "LABEL_VERSION_MISSING"` until the version-controlled, approved label is in place

**Given** a QC head opens the quality reporting dashboard (FR-Q-13)
**When** the dashboard loads
**Then** it shows first-pass yield (lots accepted on first disposition / lots dispositioned in the period), rejection rates by product and defect code, NCR and CAPA aging, conditional-release counts, and calibration lockout event counts, each with drill-through to the underlying disposition, NCR, CAPA, or lockout records

**Dev Notes:**

- Witnessed inspections (FR-Q-15) and prototype stock rules (FR-Q-12) moved to Story 8.8; the compliance master data these blocks check (licence register, label masters) is created in Story 8.7.
- The FR-Q-13 metrics stay in this epic per the reporting scope note (module dashboards live in module epics); the Epic 12 executive layer consumes them without change.

---

### Story 8.7: Compliance Master Data — BIS Licence Register and Label Masters

As a compliance officer,
I want a governed BIS licence register with CM/L and R-numbers and validity dates, and version-controlled Legal Metrology label masters with an approval workflow,
So that the statutory release blocks in Story 8.6 check against maintained, authoritative master data instead of a bare flag.

**Acceptance Criteria:**

**Given** a product covered by BIS certification (FR-Q-11)
**When** a compliance officer creates or updates its licence record
**Then** the register stores the licence number and type (CM/L or R-number), the covered products, and the validity dates, and every change is edit-logged (FR-AC-13)

**Given** a BIS licence approaching its validity end date (FR-Q-11)
**When** the 90/60/30-day alert windows are reached
**Then** expiry alerts fire to the compliance officer, and on expiry the licence is marked invalid so Story 8.6 rejects dependent releases with `error_code: "BIS_LICENCE_INVALID"`

**Given** a packaged commodity requiring a Legal Metrology label (FR-Q-14)
**When** a new label version is drafted
**Then** the label master is version-controlled, and only after approval resolved through the DOA registry (Story 1.4) does the version become the single current approved version, superseding its predecessor

**Given** a draft label version pending approval (FR-Q-14)
**When** a user the DOA registry does not resolve as authorized attempts to approve it
**Then** the approval is rejected with `error_code: "APPROVAL_REQUIRED"`

**Dev Notes:**

- Migration sequencing (A-13): BIS licence data is loaded into this register before the Story 8.6 FR-Q-11 release block goes live. Story 2.1's item-master BIS licence flag marks which products the register must cover; this story owns the licence schema and its ongoing renewal maintenance.

---

### Story 8.8: Witnessed Inspections and Prototype Stock Rules

As a QC head,
I want customer-witnessed and third-party inspection hold points with recorded notices and waivers, and prototype stock structurally barred from sellable status at the stock-class level,
So that contractual inspection obligations are met with evidence and no prototype can ever reach saleable stock.

**Acceptance Criteria:**

**Given** an order requiring customer-witnessed or third-party inspection (FR-Q-15)
**When** a hold point is reached
**Then** the lot is held at the hold point — dispatch is rejected by the Story 3.7 gate with `error_code: "LOT_ON_HOLD"` — until the witness signs off or a recorded waiver approved through the DOA registry (Story 1.4) is applied

**Given** a scheduled witnessed or third-party inspection (FR-Q-15)
**When** notice is given to the customer or third party
**Then** the notice is recorded (recipient, date, and method) against the hold point before the inspection is held

**Given** stock in the prototype (non-saleable) stock class (FR-Q-12)
**When** any transaction attempts to move it to sellable status or allocate it to a dispatch
**Then** the transaction is rejected with `error_code: "PROTOTYPE_NOT_SALEABLE"` — enforced at the stock-class level and testable with Epic 2 lot data alone

**Dev Notes:**

- Sequencing (FR-Q-12): prototype build records and design-evidence capture originate in Story 10.3 (Epic 10, sequenced after this epic and outside the pilot slice). This story delivers the stock-class bar so the control is active before any prototype exists; verification-as-design-evidence is captured against Story 10.3's build records when Epic 10 lands.
~~~~


### Epic 9: Job-Work Services — 7 edits

#### E9-01 — REPLACE in `epics.md`

**Findings addressed:** 9.1 lifecycle AC untestable (minor, vague-ac)

**Rationale:** Makes the lifecycle AC testable: names the triggering action and preconditions per transition (Confirm requires kit BOM link + price basis; In Process on first receipt; Closed only via the 9.5 gate) and adds the missing invalid-transition negative path with a stable error code (new code INVALID_STATE_TRANSITION — no existing code covers state-machine violations).

**OLD:**

~~~~markdown
**Given** a Draft service order (FR-JW-02)
**When** the lifecycle advances
**Then** it progresses through Draft, Confirmed, In Process, and Closed with each transition recorded
~~~~

**NEW:**

~~~~markdown
**Given** a Draft service order with a linked kit BOM and a price basis (FR-JW-02)
**When** the coordinator confirms the order
**Then** the order transitions to `Confirmed`, transitions to `In Process` on the first customer-material receipt (Story 9.2), and reaches `Closed` only through the Story 9.5 closure gate, with each transition recorded and attributed

**Given** a service order (FR-JW-02)
**When** a transition is attempted out of sequence (e.g., `Draft` directly to `Closed`) or confirmation is attempted without a linked kit BOM and price basis
**Then** the transition is blocked with `error_code: "INVALID_STATE_TRANSITION"`
~~~~

#### E9-02 — INSERT AFTER in `epics.md`

**Findings addressed:** 9.2 receipt-quantity variance missing (minor, missing-error-path)

**Rationale:** Adds the missing over/short-receipt variance path: received quantity seeds the custody ledger opening balance, so challan-vs-received discrepancies must be flagged, attributed, and surfaced on the first custody statement to protect ledger opening integrity.

**ANCHOR (insert after):**

~~~~markdown
**Given** a confirmed service order and an inbound challan
**When** the material is received through the gate and receiving flows (FR-JW-03)
**Then** the challan is captured and a receipt event is recorded against the order
~~~~

**NEW (inserted):**

~~~~markdown


**Given** a receipt where the received quantity deviates from the inbound challan quantity (FR-JW-03, FR-JW-05)
**When** the deviation exceeds the configured receipt tolerance
**Then** the variance is flagged as an exception, attributed to the receiving user, and reflected on the order's first custody statement
~~~~

#### E9-03 — INSERT AFTER in `epics.md`

**Findings addressed:** 9.2 segregation negative AC missing (minor, missing-error-path)

**Rationale:** Converts the declarative segregation rule into a testable negative scenario with a stable error code, applying the story's own enforcement pattern (cf. SOURCE_DOCUMENT_REQUIRED in AC1). Reuses the architecture's CROSS_ISSUE_BLOCKED code — customer-owned stock allocated to foreign demand is precisely a blocked cross-issue across an ownership boundary.

**ANCHOR (insert after):**

~~~~markdown
**Given** received customer material (FR-JW-04)
**When** it is stocked
**Then** it is placed in a non-valuated stock class, segregated and blocked from any other demand or allocation
~~~~

**NEW (inserted):**

~~~~markdown


**Given** customer-owned stock in the non-valuated class (FR-JW-04)
**When** any non-job-work demand (production, sales, transfer, or R&D) attempts to allocate, reserve, or pick it
**Then** the attempt is rejected with `error_code: "CROSS_ISSUE_BLOCKED"` and logged with the attempting user and demand source
~~~~

#### E9-04 — INSERT AFTER in `epics.md`

**Findings addressed:** 9.3 custody enforcement negatives missing (major, missing-error-path)

**Rationale:** Adds the two missing custody-enforcement negatives on FR-JW-06: over-balance consumption reuses the architecture's INSUFFICIENT_STOCK (the custody balance is a stock balance); off-kit consumption gets a new semantic code KIT_LINE_MISMATCH, resolvable only through an attributed kit-BOM amendment — closing the statutory custody risk before the 9.5 closure gate, which fires too late to distinguish misuse.

**ANCHOR (insert after):**

~~~~markdown
**Given** an order in process (FR-JW-06)
**When** consumption is posted against the order kit lines
**Then** the custody ledger is decremented by the consumed quantity
~~~~

**NEW (inserted):**

~~~~markdown


**Given** a consumption posting that exceeds the remaining custody balance for the item (FR-JW-05, FR-JW-06)
**When** the posting is attempted
**Then** it is blocked with `error_code: "INSUFFICIENT_STOCK"` and the custody ledger is unchanged

**Given** a consumption posting for an item that is not on the order's kit lines (FR-JW-06)
**When** the posting is attempted against the order
**Then** it is blocked with `error_code: "KIT_LINE_MISMATCH"` until the kit BOM is amended through an attributed change (FR-AC-13)
~~~~

#### E9-05 — REPLACE in `epics.md`

**Findings addressed:** 9.4 sizing bundle (major, sizing); 9.4 partial dispatch vague (minor, vague-ac); 9.4 AC5 billing feed vague/unowned transport (major, vague-ac — relocation half); FR-JW-09/10 partial (mis-tagged FR-JW-10 citation)

**Rationale:** Rescopes 9.4 per the baked-in 9.6 split: drops the billing-feed AC (moves to 9.6), corrects the shuffled FR tags (QC gate and partial dispatch are FR-JW-11; election capture is FR-JW-09/10 — the mis-tag of FR-JW-10 onto the QC gate was masking the execution gap), replaces the vague 'partial dispatches are supported' with observable outcomes (open-to-dispatch balance, custody decrement, Story 3.7 dispatch documents, QC-released-only rule), and adds a sequencing dev note tying election capture to the 9.1 confirmation flow. Note: the finding's suggestion to relocate the capture AC into Story 9.1 was superseded by the fixed split plan (capture stays in 9.4); the sequencing note resolves the cross-lifecycle concern.

**OLD:**

~~~~markdown
### Story 9.4: Process Loss, Offcut Election, and Dispatch

As a job-work supervisor,
I want process-loss norms with over-norm approval, contractual offcut election captured at confirmation, output through the FG QC gate before dispatch, partial dispatch support, and a measured billing feed to ERP,
So that loss is controlled, offcuts are handled per contract, and only quality-released output ships.

**Acceptance Criteria:**

**Given** a job with defined process-loss norms (FR-JW-08)
**When** recorded loss exceeds the norm
**Then** the over-norm loss is blocked with `error_code: "APPROVAL_REQUIRED"` until a supervisor approves it

**Given** an order with a contractual offcut arrangement (FR-JW-09)
**When** the order is confirmed
**Then** the offcut election (return, retain-and-buy, or retain free) is captured on the order

**Given** finished job-work output (FR-JW-10)
**When** dispatch is attempted before the output passes the FG QC gate
**Then** dispatch is blocked until QC releases the output (integration with Epic 8)

**Given** a QC-released order (FR-JW-11)
**When** the customer accepts partial shipments
**Then** partial dispatches are supported against the order

**Given** completed, dispatched job work (FR-JW-12)
**When** billing is generated
**Then** a measured billing feed (pieces, weight, or hours) is sent to ERP
~~~~

**NEW:**

~~~~markdown
### Story 9.4: Process Loss, Offcut Election Capture, and QC-Gated Dispatch

As a job-work supervisor,
I want process-loss norms with over-norm approval, contractual offcut election captured at confirmation, output through the FG QC gate before dispatch, and partial dispatch support,
So that loss is controlled, offcut terms are fixed per contract, and only quality-released output ships.

**Acceptance Criteria:**

**Given** a job with defined process-loss norms (FR-JW-08)
**When** recorded loss exceeds the norm
**Then** the over-norm loss is blocked with `error_code: "APPROVAL_REQUIRED"` until a supervisor approves it

**Given** an order with a contractual offcut arrangement (FR-JW-09/10)
**When** the order is confirmed
**Then** the offcut election (return, retain-and-buy, or retain free) is captured on the order; execution of the elected disposition is Story 9.6

**Given** finished job-work output (FR-JW-11)
**When** dispatch is attempted before the output passes the FG QC gate
**Then** dispatch is blocked until QC releases the output (integration with Epic 8)

**Given** a QC-released order (FR-JW-11)
**When** the customer accepts partial shipments
**Then** each partial dispatch reduces the order's open-to-dispatch quantity, decrements the custody ledger (FR-JW-05), and generates dispatch documents through the Story 3.7 flows, with only QC-released quantities dispatchable

**Dev notes:**
- Sequencing: the offcut-election capture AC extends the Story 9.1 `Confirm` transition — implement it inside the Story 9.1 confirmation flow, not as a separate later step.
- Split: offcut-election execution (FR-JW-09/10) and the measured ERP billing feed (FR-JW-12) moved to Story 9.6.
~~~~

#### E9-06 — REPLACE in `epics.md`

**Findings addressed:** 9.5 deemed-supply AC untestable (major, vague-ac); 9.5 FR citations shuffled (minor, traceability); 9.5 clock-stop event missing (minor, spec-gap); FR-JW-13 partial (PV-to-custody-statement reconciliation); FR-JW-14 partial (escalation); FR-AC-11 partial (deemed-supply on breach)

**Rationale:** Rebuilds Story 9.5's statutory ACs: (1) corrects all shuffled FR citations (Rule 45 clocks/deemed-supply/ITC-04 are FR-AC-11; statutory-window alerts with escalation are FR-JW-14; PV-with-custody-statement reconciliation is FR-JW-13); (2) defines the breach window (configurable per-class lead times, 90/30-day defaults) and names alert recipients; (3) adds the FR-JW-14 escalation AC consuming Story 1.11 alerting with DOA-resolved tiers; (4) adds the FR-AC-11 deemed-supply-on-breach AC (clock expiry flags deemed supply, feeds ITC-04, escalates); (5) adds the clock-stop AC so reconciled returns close exposure and the aging report is verifiable end-to-end; (6) adds the FR-JW-13 PV-variance-to-next-custody-statement reconciliation AC connecting Story 2.6's count workflow to the 9.3 custody statement.

**OLD:**

~~~~markdown
**Given** customer material received on a Rule 45 challan (FR-JW-13)
**When** the challan is recorded
**Then** one-year (inputs) and three-year (capital goods) return clocks start running from the challan date and are visible on the order

**Given** a return clock approaching its statutory limit (FR-JW-13)
**When** the breach window is entered
**Then** a deemed-supply alert is raised before the clock expires

**Given** job-work movements in a period (FR-JW-14)
**When** ITC-04 reporting is run
**Then** ITC-04 data and a job-work aging report are produced, and customer stock is included in physical verification
~~~~

**NEW:**

~~~~markdown
**Given** customer material received on a Rule 45 challan (FR-AC-11)
**When** the challan is recorded
**Then** one-year (inputs) and three-year (capital goods) return clocks start running from the challan date and are visible on the order

**Given** an open return clock (FR-AC-11)
**When** processed output or unconsumed material is returned or dispatched and reconciled against the challan quantity
**Then** the clock exposure for the reconciled quantity is closed and the job-work aging report reflects the reduced exposure

**Given** a return clock entering its breach window — configurable lead times per challan class, defaulting to 90 and 30 days before expiry (FR-JW-14)
**When** a lead-time threshold is crossed
**Then** a deemed-supply warning alert naming the order, challan, and expiry date is delivered through the Story 1.11 notification foundation to the job-work coordinator and the compliance officer

**Given** a breach-window alert that is not actioned (FR-JW-14)
**When** the configured escalation interval elapses without the exposure being cleared
**Then** the alert escalates through Story 1.11 to the next tier resolved from the DOA registry (FR-DOA-01) — no alert expires silently

**Given** a return clock that expires with unreconciled quantity (FR-AC-11)
**When** the one-year or three-year limit passes
**Then** the breached quantity is flagged as a deemed supply on the order, a deemed-supply record is raised into the ITC-04 data set, and an escalation is sent through Story 1.11 to the compliance officer and site head

**Given** job-work movements in a period (FR-AC-11, FR-JW-14)
**When** ITC-04 reporting is run
**Then** ITC-04 data — including any deemed-supply records — and a job-work aging report are produced

**Given** customer stock included in a physical verification count (FR-JW-13)
**When** the count records a variance against the custody ledger (via the Story 2.6 count workflow)
**Then** the variance is reconciled on the next custody statement for that customer and order, attributed to the verifying user
~~~~

#### E9-07 — INSERT AFTER in `epics.md`

**Findings addressed:** FR-JW-10 execution missing (major, requirements-coverage); FR-JW-09/10 partial (execution with documents); 9.4 AC5 billing feed vague/unowned transport (major, vague-ac); 9.4 sizing bundle (major, sizing)

**Rationale:** Adds the new Story 9.6 per the fixed split plan, closing the FR-JW-09/10 'executed with documents' gap with one AC per election path (return challan + custody decrement; retain-and-buy billable line + attributed conversion to own stock; free-retention record + attributed adjustment) — each path zeroes the offcut custody balance so orders no longer deadlock against the 9.5 CUSTODY_NOT_ZERO gate. Also gives FR-JW-12 a real interface contract: payload fields, idempotency_key, ERP acknowledgment gating invoiced status, retry/exception queue with Story 1.11 alerting, DUPLICATE_EVENT replay protection, and a billing-reconciliation report; the dev note pins transport ownership to this story since Epic 4's ERP handoff is outside the pilot slice and not an Epic 9 dependency.

**ANCHOR (insert after):**

~~~~markdown
**Given** a service order submitted for closure (FR-JW-15, FR-AC-11)
**When** the custody ledger balance is non-zero
**Then** closure is blocked with `error_code: "CUSTODY_NOT_ZERO"` until the ledger is reconciled to zero

---
~~~~

**NEW (inserted):**

~~~~markdown


### Story 9.6: Offcut Election Execution and ERP Billing Feed

As a job-work coordinator,
I want the captured offcut election executed with documents at dispatch or retention, and a measured billing feed delivered to ERP with acknowledgment and failure handling,
So that offcuts are settled per contract with the paperwork to prove it and every completed job is invoiced from measured quantities.

**Acceptance Criteria:**

**Given** an order with offcut election `return` (FR-JW-09/10)
**When** offcuts are dispatched back to the customer
**Then** a return challan and dispatch documents are generated through the Story 3.7 flows and the custody ledger is decremented by the returned quantity

**Given** an order with offcut election `retain-and-buy` (FR-JW-09/10)
**When** the retention is executed
**Then** a billable line at the contracted rate is raised onto the ERP billing feed, and the custody ledger writes the offcut quantity out to own stock with an attributed conversion record

**Given** an order with offcut election `retain free` (FR-JW-09/10)
**When** the retention is executed
**Then** a free-retention record is written and the custody ledger is adjusted to zero for the offcut quantity with an attributed adjustment referencing the contractual election

**Given** a completed, dispatched job-work order (FR-JW-12)
**When** billing is generated
**Then** a measured billing feed (pieces, certified weight, or hours) — carrying the order and challan references, measured basis and quantity, price basis, and any own-material (FR-JW-07) and retain-and-buy lines — is sent to ERP with an `idempotency_key`, and the order is marked invoiced only on ERP acknowledgment

**Given** a billing feed transmission that fails or is not acknowledged (FR-JW-12)
**When** the configured retry window elapses
**Then** the feed enters an exception queue with an alert through Story 1.11 to the job-work coordinator, retries never create duplicate billable events (replays rejected with `error_code: "DUPLICATE_EVENT"`), and unacknowledged feeds appear on a billing-reconciliation report

**Dev notes:**
- Split from Story 9.4: election capture stays in Story 9.4 (at confirmation); this story executes the elected disposition and owns the billing feed.
- The job-work billing feed is an outbound interface owned by this story — it does not depend on the Epic 4 ERP handoff (Epic 4 is outside the pilot go-live slice).
- Executing the election is a precondition for the Story 9.5 closure gate: retained or unreturned offcuts otherwise leave the custody ledger non-zero (`CUSTODY_NOT_ZERO`).

---
~~~~


### Epic 10: R&D and Maker-Hub Operations — story sect — 14 edits

#### E10-01 — REPLACE in `epics.md`

**Findings addressed:** Q3 (traceability off-by-one); FR-AC-02/03 partial (no retroactive reinstatement)

**Rationale:** The epic intro carries the same off-by-one mistag as Story 10.2 AC3: FR-RD-06 is the equipment custody register; the Ind AS 38 classification rule is FR-AC-02/03. Also surfaces the epic-list goal's 'no retroactive reinstatement' clause (line 444) at the epic body level so the new 10.2 negative AC has a stated source.

**OLD:**

~~~~markdown
Ind AS 38 research-vs-development classification is applied from the first transaction (FR-RD-06)
~~~~

**NEW:**

~~~~markdown
Ind AS 38 research-vs-development classification is applied from the first transaction with no retroactive reinstatement (FR-AC-02, FR-AC-03)
~~~~

#### E10-02 — REPLACE in `epics.md`

**Findings addressed:** Q10 (10.1 malformed Given / unobservable Then)

**Rationale:** AC1's Given ('the need for...') was not a system state and its Then named an architecture property rather than a testable outcome. Restated as an observable ledger-isolation check per the finding's recommendation.

**OLD:**

~~~~markdown
**Given** the need for R&D and hub inventory (FR-RD-01)
**When** an R&D store and a maker-hub store are configured
**Then** each is a first-class location type with its own stock ledger
~~~~

**NEW:**

~~~~markdown
**Given** an R&D store and a maker-hub store configured as first-class location types (FR-RD-01)
**When** stock is received into the R&D store
**Then** the movement appears in the R&D store's own stock ledger and in no other location's ledger, and the same holds for the maker-hub store
~~~~

#### E10-03 — REPLACE in `epics.md`

**Findings addressed:** Q10 (10.1 AC4 missing error_code)

**Rationale:** AC4's rejection specified no error code, unlike its sibling AC2 (CROSS_ISSUE_BLOCKED). Named code PROJECT_CODE_REQUIRED per the finding's recommendation — semantically distinct from UNTAGGED_TRANSACTION because it also covers inactive/closed project codes, not just missing tags.

**OLD:**

~~~~markdown
**Given** any R&D material transaction (FR-RD-03)
**When** it is attempted without an active project code
**Then** the transaction is rejected until a valid active project code is supplied
~~~~

**NEW:**

~~~~markdown
**Given** any R&D material transaction (FR-RD-03)
**When** it is attempted without an active project code
**Then** the transaction is rejected with `error_code: "PROJECT_CODE_REQUIRED"` until a valid active project code is supplied
~~~~

#### E10-04 — REPLACE in `epics.md`

**Findings addressed:** Q6 (Ind AS 38 AC malformed, missing failure path); Q3 (FR-RD-06 mistag on line 2084); FR-AC-02/03 partial; dropped clause: FR-AC-02/03 no retroactive reinstatement

**Rationale:** Restructures the malformed AC (When covered only 'research' while the Then legislated development behavior) into separate research and development paths with the checklist observable on the costing record; adds the missing failure path (checklist fails -> expensed, capitalization blocked) and the no-retroactive-reinstatement negative AC that the epic goal states but no AC enforced. Drops the mistagged FR-RD-06 (equipment custody register) citation.

**OLD:**

~~~~markdown
**Given** an issue on a project (FR-RD-06, FR-AC-02, FR-AC-03)
**When** the phase tag is research
**Then** the cost is expensed; where the phase is development, capitalization occurs only after the six-criteria Ind AS 38 checklist passes
~~~~

**NEW:**

~~~~markdown
**Given** an issue on a project whose phase tag is research (FR-AC-02)
**When** the issue is posted
**Then** the cost is expensed in the period of issue

**Given** an issue on a project whose phase tag is development (FR-AC-03)
**When** the issue is posted
**Then** the cost is capitalized only when the project carries a six-criteria Ind AS 38 checklist with all six criteria recorded as met, and the checklist reference is stored on the costing record

**Given** a development-phase project whose Ind AS 38 checklist is incomplete or has a failing criterion (FR-AC-03)
**When** an issue is posted
**Then** the cost is expensed and capitalization is blocked with `error_code: "CAPITALIZATION_CRITERIA_NOT_MET"`

**Given** costs already expensed under the research phase or a failed checklist (FR-AC-02, FR-AC-03)
**When** the project later passes the six-criteria checklist
**Then** only costs incurred from the date the criteria are met are capitalized; any attempt to retroactively reinstate a previously expensed cost as capitalized is rejected with `error_code: "RETROACTIVE_REINSTATEMENT_BLOCKED"`
~~~~

#### E10-05 — REPLACE in `epics.md`

**Findings addressed:** Q3 (FR mis-citation, line 2088)

**Rationale:** Off-by-one citation: the custody-register AC (named custodian, expected return date, condition codes, overdue ageing) is FR-RD-06 verbatim; FR-RD-05 (three issue types) is already correctly tagged on AC2.

**OLD:**

~~~~markdown
**Given** an equipment-custody issue (FR-RD-05)
**When** it is recorded
~~~~

**NEW:**

~~~~markdown
**Given** an equipment-custody issue (FR-RD-06)
**When** it is recorded
~~~~

#### E10-06 — REPLACE in `epics.md`

**Findings addressed:** Q8 (FR-RD-09 enforcement clause dropped); coverage: FR-RD-09 partial

**Rationale:** FR-RD-09's enforcement clause ('sales orders and dispatch blocked') was dropped — the AC only checked class registration. Dispatch exists in Phase 1 (Epics 3, 9), so the dispatch-blocking half is exercisable now with a named negative-path error code; sales-order blocking is noted as the Epic 15 future enforcement surface per the finding's recommendation.

**OLD:**

~~~~markdown
**Given** a completed prototype build (FR-RD-09)
**When** it is registered
**Then** it is registered as a non-saleable serialized class
~~~~

**NEW:**

~~~~markdown
**Given** a completed prototype build (FR-RD-09)
**When** it is registered
**Then** it is registered as a non-saleable serialized class

**Given** a serialized prototype in the non-saleable class (FR-RD-09)
**When** a dispatch document or issue-to-dispatch is attempted against it
**Then** the transaction is blocked with `error_code: "NON_SALEABLE_CLASS"`; the same class check blocks sales-order allocation when the Phase-2 orders module (Epic 15) lands
~~~~

#### E10-07 — REPLACE in `epics.md`

**Findings addressed:** Q5 (disposition forward dependencies); coverage: FR-RD-11 partial

**Rationale:** Makes the three cross-module disposition legs Phase-1 concrete: retain-as-asset writes to the Phase-1 Epic 7 asset register, transfer-to-production is a reference designation (matching FR-RD-10's own wording), and scrap lines get an interim holding-state AC so FR-RD-11's routing clause is testable now rather than silently unimplementable until Epic 16.

**OLD:**

~~~~markdown
**Given** a completed prototype (FR-RD-10, FR-RD-11)
**When** a disposition is chosen among retain-as-asset, transfer-to-production, teardown, or scrap
**Then** the disposition requires R&D-head approval (`error_code: "APPROVAL_REQUIRED"`), and teardown recovers components with condition codes
~~~~

**NEW:**

~~~~markdown
**Given** a completed prototype (FR-RD-10, FR-RD-11)
**When** a disposition is chosen among retain-as-asset, transfer-to-production, teardown, or scrap
**Then** the disposition requires R&D-head approval (`error_code: "APPROVAL_REQUIRED"`), teardown recovers components with condition codes, retain-as-asset creates an Epic 7 asset-register entry, and transfer-to-production records a production-reference designation

**Given** teardown or scrap lines from an approved disposition (FR-RD-11)
**When** the disposition is executed in Phase 1
**Then** the lines are placed in a scrap-pending holding state carrying quantity, condition code, and source-prototype reference, visible in the project's material history
~~~~

#### E10-08 — INSERT AFTER in `epics.md`

**Findings addressed:** Q5 (scrap routing to Epic 16 unflagged deferral); coverage: FR-RD-11 partial

**Rationale:** Explicit deferral note (edit rule 7) inside Story 10.3 for FR-RD-11's 'scrap lines route to FR-SC' clause, which cannot land in Phase 1 because FR-SC is Epic 16 (Phase 2, no stories). Pairs with the interim holding-state AC added in E10-07.

**ANCHOR (insert after):**

~~~~markdown
**Given** unused project material (FR-RD-12)
**When** it is returned
**Then** the return reverses project WIP by the returned cost
~~~~

**NEW (inserted):**

~~~~markdown


**Note:** Deferred to Phase 2 (Epic 16): routing of teardown and scrap lines into the FR-SC scrap module. Phase 1 holds them in the scrap-pending state above with full source references; Epic 16 consumes that state without rework of this story.
~~~~

#### E10-09 — REPLACE in `epics.md`

**Findings addressed:** Q1 (10.4 oversized, split); Q3 (mis-citations lines 2136/2140/2144); Q4 (FR-RD-14 meter readings uncovered); coverage: FR-RD-13 partial

**Rationale:** Split per plan: 10.4 keeps its number with reduced scope (customer records + booking); offline POS and payment capture move to new Story 10.6, job cards and statements to new Story 10.7. Adds FR-RD-13's mandatory single-reference integrity constraint as a negative AC and FR-RD-14's dropped meter-reading clause (feeding Epic 7's FR-M-03 usage-meter consumer). Fixes the off-by-one tags on the booking AC (FR-RD-15 removed; FR-RD-14 only).

**OLD:**

~~~~markdown
### Story 10.4: Hub Member Records, Machine-Time Booking, and Offline POS

As a maker-hub operator,
I want member and walk-in records, machine-time booking with operator-closed actuals and unclosed-booking exceptions, offline point-of-use sales, and UPI/card capture with end-of-day reconciliation,
So that the hub runs profitably offline with accurate billing and stock.

**Acceptance Criteria:**

**Given** hub customers (FR-RD-13)
**When** records are created
**Then** hub member and walk-in customer records are maintained with member job cards

**Given** a machine-time booking (FR-RD-14, FR-RD-15)
**When** the operator closes the booking
**Then** actual machine time is recorded; a booking left unclosed for 24 hours raises an exception

**Given** a point-of-use material sale offline (FR-RD-16, FR-RD-20)
**When** the sale is confirmed
**Then** hub stock is decremented locally and replayed on reconnection, with replenishment driven via FR-I-03 reorder

**Given** a walk-in payment (FR-RD-17, INT-PAY-01)
**When** payment is taken by UPI QR code or card terminal
**Then** the payment is captured and included in end-of-day reconciliation
~~~~

**NEW:**

~~~~markdown
### Story 10.4: Hub Member Records and Machine-Time Booking

As a maker-hub operator,
I want member and walk-in customer records that every hub transaction references, and machine-time booking with operator-closed actuals, meter readings, and unclosed-booking exceptions,
So that every booking and sale is attributable to exactly one customer and machine usage is captured accurately.

**Acceptance Criteria:**

**Given** hub customers (FR-RD-13)
**When** records are created
**Then** hub member and walk-in customer records are maintained

**Given** a booking, sale, or job card (FR-RD-13)
**When** it is created without a reference to exactly one member or walk-in customer record
**Then** it is rejected with `error_code: "MEMBER_REFERENCE_REQUIRED"`; a reference to more than one customer record is rejected the same way

**Given** a machine-time booking (FR-RD-14)
**When** the operator closes the booking
**Then** actual machine time and the machine meter reading are recorded, and the meter reading feeds the FR-M-03 usage-meter register (Epic 7)

**Given** an open machine-time booking (FR-RD-14)
**When** it remains unclosed for 24 hours
**Then** an exception is raised to the hub operator for resolution

**Note:** Offline point-of-use sale, payment capture, and end-of-day reconciliation are Story 10.6. Member job cards and statements are Story 10.7.
~~~~

#### E10-10 — REPLACE in `epics.md`

**Findings addressed:** Q2 (IAUD forward dependency); Q3 (tag re-audit: stray FR-AC-12 on cost-reporting AC)

**Rationale:** The IAUD ledger itself is Epic 17 (Phase 2); reworded to the Phase-1-testable output contract per the finding's recommendation — the deliverable is the project-wise feed data (mirroring line 205's 'IAUD ledger fed project-wise from FR-RD-19'), with Epic 17 named as the future consumer. Also removes the stray FR-AC-12 tag, which belongs on the B2C invoice AC (fixed in E10-11).

**OLD:**

~~~~markdown
**Given** project material cost (FR-RD-19, FR-AC-04, FR-AC-12)
**When** cost reporting is produced
**Then** it reconciles line-for-line to the store ledger and feeds Form 3CL and the IAUD
~~~~

**NEW:**

~~~~markdown
**Given** project material cost (FR-RD-19, FR-AC-04)
**When** cost reporting is produced
**Then** it reconciles line-for-line to the store ledger, feeds Form 3CL, and produces a project-wise, phase-tagged capitalizable-cost extract in the defined IAUD feed format (consumed by the Epic 17 intangibles/IAUD ledger in Phase 2)
~~~~

#### E10-11 — REPLACE in `epics.md`

**Findings addressed:** Q3 (mis-citation line 2170); dropped clause: FR-AC-12 never miscellaneous income; Q9 (B2C AC placement — addressed via cross-reference)

**Rationale:** Fixes the mistagged citation (content is FR-AC-12, not FR-RD-17) and restores the dropped 'never miscellaneous income' prohibition with an enforcement negative AC. The cross-reference to Story 10.6's point of sale resolves the placement concern (invoice generated at POS, compliance content asserted here) without moving the AC out of the finance-controller story the verifier judged coherent.

**OLD:**

~~~~markdown
**Given** maker-hub B2C sales (FR-RD-17)
**When** invoices are generated
**Then** item-rate charges are separated from machine-time charges on the invoice
~~~~

**NEW:**

~~~~markdown
**Given** maker-hub B2C sales (FR-AC-12)
**When** invoices are generated at Story 10.6's point of sale
**Then** item-rate charges are separated from machine-time service charges on the invoice, and hub material sales post to sales revenue at item rates — never to miscellaneous income

**Given** a hub material sale (FR-AC-12)
**When** a posting attempts to classify it as miscellaneous income
**Then** the posting is rejected with `error_code: "INVALID_REVENUE_CLASSIFICATION"`
~~~~

#### E10-12 — REPLACE in `epics.md`

**Findings addressed:** Q11 (FR-AC-16 vague AC, no enforcement path)

**Rationale:** Replaces the vague 'flows through to reporting' with the observable report field (funding-source subtotal on the FR-AC-04 project cost report) and adds the missing enforcement path: posting without a funding-source tag is rejected, reusing the compliance spine's UNTAGGED_TRANSACTION code (consistent with FR-AC-01 tag enforcement).

**OLD:**

~~~~markdown
**Given** any R&D cost ledger entry (FR-AC-16)
**When** it is posted
**Then** it carries a funding-source tag (internal, DSIR, DST, or grant) that flows through to reporting
~~~~

**NEW:**

~~~~markdown
**Given** any R&D cost ledger entry (FR-AC-16)
**When** it is posted
**Then** it carries a funding-source tag (internal, DSIR, DST, or grant), and the FR-AC-04 project cost report subtotals spend by funding source

**Given** an R&D cost ledger entry without a funding-source tag (FR-AC-16)
**When** posting is attempted
**Then** it is rejected with `error_code: "UNTAGGED_TRANSACTION"`
~~~~

#### E10-13 — REPLACE in `epics.md`

**Findings addressed:** Q1 (10.4 split -> 10.6/10.7); Q7 (10.4 zero negative paths); Q4 (FR-RD-15 billing the member, FR-RD-16 statements uncovered); Q3 (corrected tags on moved ACs); coverage: FR-RD-16 partial; coverage: FR-RD-13 partial

**Rationale:** Adds the two split-off stories at the end of Epic 10 (before the Epic 11 heading) with their fixed numbers. Story 10.6 carries the offline POS and payment scope out of 10.4 with corrected FR tags (FR-RD-15 sale, FR-RD-17 replenishment, FR-RD-20 payment), the previously uncovered 'billing the member' clause, and the missing negative paths: insufficient hub stock offline (INSUFFICIENT_STOCK), sync-replay conflict (STREAM_CONFLICT, distinct from Story 1.8's duplicate suppression), payment failure/timeout (PAYMENT_NOT_CONFIRMED), and EOD reconciliation mismatch. Story 10.7 covers FR-RD-16's job-card contents and on-demand plus monthly statements, with the FR-RD-13 single-reference integrity check on job-card entries.

**OLD:**

~~~~markdown
---

## Epic 11: Financial Compliance and Period Close

Finance teams close periods with a signed-off subledger-to-GL reconciliation
~~~~

**NEW:**

~~~~markdown
---

### Story 10.6: Offline Point-of-Use Sale and Payment Capture

As a maker-hub operator,
I want offline point-of-use material sales that decrement hub stock and bill the member, UPI/card payment capture with failure handling, and end-of-day payment reconciliation,
So that the hub sells and collects accurately with no network, and every rupee taken at the counter reconciles at day end.

**Acceptance Criteria:**

**Given** a point-of-use material sale offline (FR-RD-15)
**When** the sale is confirmed
**Then** hub stock is decremented locally, the sale is billed to the referenced member or walk-in customer at item rates, and the transaction is replayed on reconnection via the Epic 1 offline edge shell (Story 1.8)

**Given** an offline sale for more than the locally known hub stock (FR-RD-15)
**When** the sale is attempted
**Then** it is blocked with `error_code: "INSUFFICIENT_STOCK"` against the device's local ledger

**Given** offline sales replayed on reconnection (FR-RD-15)
**When** replay would drive hub stock negative because another device decremented the same stock while offline
**Then** the conflicting transaction is parked as a sync exception with `error_code: "STREAM_CONFLICT"` for hub-operator resolution and is never silently dropped

**Given** hub stock consumed by point-of-use sales (FR-RD-17)
**When** stock falls below its reorder control level
**Then** replenishment is driven via FR-I-03 reorder against the serving warehouse or a purchase

**Given** a walk-in payment (FR-RD-20, INT-PAY-01)
**When** payment is taken by UPI dynamic QR or card terminal
**Then** the payment is captured with its gateway reference and included in end-of-day reconciliation

**Given** a UPI or card payment that fails or times out at the terminal (FR-RD-20, INT-PAY-01)
**When** no confirmed gateway reference is received
**Then** the sale remains unpaid with `error_code: "PAYMENT_NOT_CONFIRMED"`, the operator can retry or take another payment method, and the unresolved attempt is listed in end-of-day reconciliation

**Given** end-of-day reconciliation (FR-RD-20)
**When** captured payments do not match gateway settlement records
**Then** each mismatch raises an unreconciled-payment exception that must be resolved or escalated before the day close completes

---

### Story 10.7: Member Job Cards and Statements

As a maker-hub operator,
I want member job cards that collect bookings, machine hours, and purchases, with statements on demand and monthly,
So that members are billed transparently and every charge is traceable to a recorded transaction.

**Acceptance Criteria:**

**Given** a hub member's activity (FR-RD-16)
**When** bookings are closed and point-of-use sales are confirmed
**Then** the member's job card collects each booking, its machine hours, and each purchase with date, quantity, and amount

**Given** a job-card entry (FR-RD-13, FR-RD-16)
**When** it is created
**Then** it references exactly one member record and reconciles to the underlying booking or sale transaction

**Given** a member job card (FR-RD-16)
**When** the member or a hub operator requests a statement
**Then** an on-demand statement is produced for the requested period covering bookings, hours, purchases, payments, and outstanding balance

**Given** month end (FR-RD-16)
**When** the monthly statement run executes
**Then** a statement is generated for every member with activity or an outstanding balance in the month, and the run's completion is recorded

---

## Epic 11: Financial Compliance and Period Close

Finance teams close periods with a signed-off subledger-to-GL reconciliation
~~~~

#### E10-14 — REPLACE in `epics.md`

**Findings addressed:** Q5 (under-declared dependencies for disposition legs); Q4 (FR-RD-14 meter-reading feed to Epic 7)

**Rationale:** Epic 10's dependency list was under-declared: the retain-as-asset disposition (E10-07) writes to the Epic 7 operational asset register and the booking meter reading (E10-09) feeds Epic 7's FR-M-03 usage-meter consumer — both Phase-1 modules, so declaring the dependency is safe and consistent with the pilot sequencing (Epic 7 is in the pilot slice; Epic 10 is not). Anchor extended with the FRs-covered line because '**Depends on:** Epics 1, 2, 4' alone is a substring of Epic 17's entry.

**OLD:**

~~~~markdown
**FRs covered:** FR-RD-01, FR-RD-02, FR-RD-03, FR-RD-04, FR-RD-05, FR-RD-06, FR-RD-07, FR-RD-08, FR-RD-09, FR-RD-10, FR-RD-11, FR-RD-12, FR-RD-13, FR-RD-14, FR-RD-15, FR-RD-16, FR-RD-17, FR-RD-18, FR-RD-19, FR-RD-20, FR-AC-02, FR-AC-03, FR-AC-04, FR-AC-12, FR-AC-16

**Depends on:** Epics 1, 2, 4
~~~~

**NEW:**

~~~~markdown
**FRs covered:** FR-RD-01, FR-RD-02, FR-RD-03, FR-RD-04, FR-RD-05, FR-RD-06, FR-RD-07, FR-RD-08, FR-RD-09, FR-RD-10, FR-RD-11, FR-RD-12, FR-RD-13, FR-RD-14, FR-RD-15, FR-RD-16, FR-RD-17, FR-RD-18, FR-RD-19, FR-RD-20, FR-AC-02, FR-AC-03, FR-AC-04, FR-AC-12, FR-AC-16

**Depends on:** Epics 1, 2, 4, 7 (retain-as-asset prototype dispositions create Epic 7 asset-register entries; machine meter readings feed the FR-M-03 usage-meter register)
~~~~


### Epic 11: Financial Compliance and Period Close — 10 edits

#### E11-01 — REPLACE in `epics.md`

**Findings addressed:** Q2

**Rationale:** Epic 11 header transposes FR-AC-10 and FR-AC-14 relative to the FR inventory (lines 214, 218) and the coverage map (lines 305-306): FR-AC-14 is the IRN-before-dispatch block, FR-AC-10 is branch-transfer Rule 28 valuation. Swapping the citations restores traceability.

**OLD:**

~~~~markdown
every e-invoiceable dispatch is blocked until IRN and signed QR are received (FR-AC-10), and branch transfers between GSTINs trigger Rule 28 valuation and GST documents.
~~~~

**NEW:**

~~~~markdown
every e-invoiceable dispatch is blocked until IRN and signed QR are received (FR-AC-14), and branch transfers between GSTINs trigger Rule 28 valuation and GST documents (FR-AC-10).
~~~~

#### E11-02 — REPLACE in `epics.md`

**Findings addressed:** Q1; Q10 partial (11.1 AC2 code)

**Rationale:** Old AC2 required a disposal transaction that only exists in Phase-2 Epic 16, making it untestable in Phase 1. Reworded per directive as (a) an event-subscriber contract driven by the Phase-1 write-off surface (Story 2.6 approval-gated adjustments) and (b) a spine-level precondition on the future disposal-close command, contract-tested Phase 1 and explicitly noted as consumed by Epic 16 — matching the Spine Acceptance Contract pattern and the Epic 11 goal. Also gives the block a stable error code (ITC_REVERSAL_PENDING), fixing the codeless-block inconsistency for 11.1 AC2.

**OLD:**

~~~~markdown
**Given** stock scheduled for write-off (FR-AC-08)
**When** disposal is attempted before the ITC reversal is computed
**Then** disposal is blocked until the ITC reversal is computed and posted
~~~~

**NEW:**

~~~~markdown
**Given** an approved write-off stock adjustment event on the event stream (FR-AC-08)
**When** the ITC register subscriber consumes the event
**Then** an ITC reversal is computed and posted to the register for the affected GSTIN, linked to the originating write-off event — exercised in Phase 1 by the approval-gated write-off adjustments from cycle counting (Story 2.6)

**Given** a disposal-close command for stock whose ITC reversal is not yet computed and posted (FR-AC-08)
**When** the spine-level precondition is evaluated
**Then** the command is rejected with `error_code: "ITC_REVERSAL_PENDING"` — contract-tested in Phase 1 at the command API; the disposal workflow that issues this command arrives with Epic 16 (Phase 2) and consumes this precondition unchanged, per the event-subscriber extension note in the Epic 11 goal
~~~~

#### E11-03 — REPLACE in `epics.md`

**Findings addressed:** Q7; Q12 partial (11.1 dev notes: GSTR-2B ingestion, ERP touchpoints)

**Rationale:** GSTR-2B AC named no ingestion path, matching keys, tolerance, or output destination — the story could not be sized or tested. Now specifies manual portal-JSON upload (the only path implementable without a new integration), concrete match keys with a rounding tolerance, and a categorized per-GSTIN exception report. Dev notes anchor invoice data to new Story 4.7 and PO references to Story 2.9 (baked-in D1), covering the missing-dev-notes gap for 11.1.

**OLD:**

~~~~markdown
**Given** the GSTR-2B for a GSTIN (FR-AC-07)
**When** reconciliation is run
**Then** ITC register entries are matched against GSTR-2B and mismatches are surfaced
~~~~

**NEW:**

~~~~markdown
**Given** a GSTR-2B statement for a GSTIN, ingested by manual upload of the GSTN portal JSON file (FR-AC-07)
**When** reconciliation is run
**Then** ITC register entries are matched to GSTR-2B lines on supplier GSTIN + invoice number + invoice date + taxable value + tax amount per head, with a configurable rounding tolerance (default ±1 rupee per tax head)

**Given** a completed GSTR-2B reconciliation run with differences (FR-AC-07)
**When** mismatches are surfaced
**Then** each mismatch lands in an exception report per GSTIN, categorized as missing-in-2B, missing-in-register, or amount-variance, with drill-through to the underlying GRN and invoice

**Dev notes:**
- Supplier tax invoices enter through Story 4.7 (Supplier Invoice Capture); GRN linkage comes from Story 4.5 receiving events, and open-PO references from Story 2.9 (ERP Inbound Reference Projections).
- GSTR-2B ingestion is manual portal-JSON upload in Phase 1; a GSTN API or ERP-mediated feed is a later integration decision and must not change the matching keys or tolerance contract above.
- The IRN on inbound invoices is captured invoice data (Story 4.7); the outbound IRP flow is Story 11.2 (INT-GST-01).
~~~~

#### E11-04 — REPLACE in `epics.md`

**Findings addressed:** Q2; Q10 partial (11.2 AC1 code)

**Rationale:** IRN-before-dispatch is FR-AC-14 (FR inventory line 218, coverage map line 306), not FR-AC-10 — citation corrected. The blocking AC also gains a stable error code (IRN_MISSING) per the epic-wide error-code discipline; no existing architecture code fits this semantics.

**OLD:**

~~~~markdown
**Given** an e-invoiceable supply ready to dispatch (FR-AC-10, INT-GST-01)
**When** dispatch is attempted before the IRN and signed QR are received from the IRP flow through ERP
**Then** dispatch is blocked until IRN and signed QR are present
~~~~

**NEW:**

~~~~markdown
**Given** an e-invoiceable supply ready to dispatch (FR-AC-14, INT-GST-01)
**When** dispatch is attempted before the IRN and signed QR are received from the IRP flow through ERP
**Then** dispatch is blocked with `error_code: "IRN_MISSING"` until IRN and signed QR are present
~~~~

#### E11-05 — REPLACE in `epics.md`

**Findings addressed:** Q2; Q3; Q8

**Rationale:** Three fixes in one adjacent block: (1) both branch-transfer ACs cite FR-AC-10 (Rule 28), not FR-AC-14 — transposition corrected; (2) Rule 28 valuation is now testable: the four bases are enumerated, selection is configured-default-plus-override with the choice recorded, and the required documents (tax invoice with IRN/QR where e-invoiceable, threshold-triggered e-way bill) are named in a separate AC; (3) the semantically wrong GATE_PASS_REQUIRED — which collides with FR-GP-11/Epic 20 gate enforcement — is replaced with GST_DOCUMENTS_REQUIRED per directive, with an explicit note severing the gate-pass implication.

**OLD:**

~~~~markdown
**Given** a stock transfer between two GSTINs (FR-AC-14)
**When** the branch transfer is created
**Then** it is treated as a taxable supply with Rule 28 valuation options and GST documents generated before dispatch

**Given** a branch transfer without generated documents (FR-AC-14)
**When** dispatch is attempted
**Then** it is blocked with `error_code: "GATE_PASS_REQUIRED"` until the documents exist
~~~~

**NEW:**

~~~~markdown
**Given** a stock transfer between two GSTINs (FR-AC-10)
**When** the branch transfer is created
**Then** it is treated as a taxable supply valued on a Rule 28 basis — open market value; value of like kind and quality; cost-plus under Rules 30/31; or the second-proviso invoice value where the recipient GSTIN is eligible for full ITC — with the basis defaulted per GSTIN pair from dated configuration, overridable by the GST accountant, and the selected basis recorded on the transfer

**Given** a valued branch transfer (FR-AC-10)
**When** GST documents are generated before dispatch
**Then** a tax invoice exists (carrying IRN and signed QR where the supply is e-invoiceable, per the FR-AC-14 block above) and an e-way bill exists where the consignment value exceeds the threshold

**Given** a branch transfer without its generated GST documents (FR-AC-10)
**When** dispatch is attempted
**Then** it is blocked with `error_code: "GST_DOCUMENTS_REQUIRED"` until the documents exist — GST documents are the blocking artifacts here; gate-pass enforcement (FR-GP-11) is Epic 20 (Phase 2)
~~~~

#### E11-06 — REPLACE in `epics.md`

**Findings addressed:** Q11

**Rationale:** APPROVAL_REQUIRED was semantically wrong (the actor already is the approver) and warn-vs-block behavior was undefined. Split into two testable ACs: warn-configured heads proceed with a logged warning; block-configured heads reject with the budget-specific code BUDGET_EXCEEDED and escalate via the DOA registry rather than dead-ending. Configuration scope/ownership (per budget head, finance administration) lands in the Story 11.3 dev notes added by E11-07.

**OLD:**

~~~~markdown
**Given** an approval that would exceed the remaining budget (FR-BC-01)
**When** the approver acts
**Then** the system either warns or blocks per configuration, returning `error_code: "APPROVAL_REQUIRED"` where blocking applies
~~~~

**NEW:**

~~~~markdown
**Given** an approval that would exceed the remaining budget, on a budget head configured to warn (FR-BC-01)
**When** the approver acts
**Then** the approval proceeds and a budget-exceeded warning is recorded on the approval record

**Given** an approval that would exceed the remaining budget, on a budget head configured to block (FR-BC-01)
**When** the approver acts
**Then** the action is rejected with `error_code: "BUDGET_EXCEEDED"` and the request is escalated to the next-higher authority for that budget head resolved from the DOA registry (FR-DOA-01) — a block escalates, it never terminally strands the request
~~~~

#### E11-07 — INSERT AFTER in `epics.md`

**Findings addressed:** Q4; Q12 partial (11.3 dev notes: budget-sync cadence)

**Rationale:** The verified residue of the ERP-unreachable finding is a staleness gap: nothing bounded how old displayed availability may be or what degraded behavior applies when the ERP sync link is down. New AC defines the staleness indicator and the warn/block behavior on stale figures. Dev notes record the budget-sync cadence and configuration ownership, and explicitly scope approvals as Tier-2 central workflows so the offline-device case is a documented non-path rather than an unstated assumption.

**ANCHOR (insert after):**

~~~~markdown
**Given** an approved commitment (FR-BC-01)
**When** it is recorded
**Then** availability is reduced by the commitment until ERP actuals sync back and reconcile it
~~~~

**NEW (inserted):**

~~~~markdown


**Given** budget heads whose last successful ERP sync is older than the configured staleness threshold (FR-BC-02)
**When** an approval screen is opened
**Then** the displayed availability carries its last-synced timestamp and a stale-data indicator; warn-configured heads remain approvable with the staleness logged on the approval record, and block-configured heads require the approver to explicitly acknowledge the staleness before acting

**Dev notes:**
- ERP remains the budget master. The IMS holds synced projections of budget heads and availability plus local commitments — never an editable local budget master (FR-BC-01, FR-BC-02).
- Sync cadence, the staleness threshold, and warn-vs-block behavior are dated configuration per budget head, owned by finance administration (suggested defaults: 15-minute sync, 4-hour staleness threshold).
- Budget-checked approvals are Tier 2 central control-plane workflows (NFR-P-04); the offline-first mandate applies to Tier 1 frontline capture, so no offline approval path is required here.
~~~~

#### E11-08 — REPLACE in `epics.md`

**Findings addressed:** Q5; Q10 partial (11.4 AC1 code)

**Rationale:** Adds the architecture's hardest period-lock case: offline-captured events with a pre-close business_date replaying after close are inevitable under PowerSync (NFR-P-04 24x7 Tier-1 offline capture), and a naive block would strand valid events in the sync queue. Disposition defined (accept event, redirect posting to earliest open period with late_arrival marker, surface on exception report), a DOA-gated controlled reopen path with logged justification is specified, and the direct-attempt block gains the stable PERIOD_LOCKED error code with edit-log capture.

**OLD:**

~~~~markdown
**Given** a closed accounting period (FR-AC-15)
**When** a back-dated transaction into that period is attempted
**Then** it is blocked by the period lock
~~~~

**NEW:**

~~~~markdown
**Given** a closed accounting period (FR-AC-15)
**When** a back-dated transaction into that period is attempted directly
**Then** it is rejected with `error_code: "PERIOD_LOCKED"` and the attempt is written to the statutory edit log (FR-AC-13)

**Given** an event legitimately captured offline before close whose IST `business_date` falls in a period that closed before PowerSync replayed it (FR-AC-15)
**When** the event syncs to the central event store
**Then** the event is accepted — captured facts are never discarded — its financial posting is redirected to the earliest open period carrying a `late_arrival` marker that references the original `business_date`, and the item is listed on a period-exception report for finance review

**Given** a correction that must post into a closed period (FR-AC-15)
**When** a period reopen is requested
**Then** the reopen is blocked with `error_code: "APPROVAL_REQUIRED"` until the authority resolved from the DOA registry (FR-DOA-01) approves it with a logged justification, and the reopen, the corrections, and the re-close are all recorded in the statutory edit log (FR-AC-13) with actor and timestamps
~~~~

#### E11-09 — REPLACE in `epics.md`

**Findings addressed:** Q12 partial (GRNI ageing buckets)

**Rationale:** GRNI ageing had no bucket structure and no data lineage. Buckets are now explicit (0-30/31-60/61-90/90+ by GRN date, value per bucket per location), and GRNI is defined operationally as Story 4.5 GRNs minus Story 4.7 captured supplier invoices, with PO drill-through via Story 2.9 (baked-in D1).

**OLD:**

~~~~markdown
**Given** received-but-not-invoiced goods (FR-AC-15)
**When** the GRNI ageing report is run
**Then** aged GRNI items are listed for finance follow-up
~~~~

**NEW:**

~~~~markdown
**Given** received-but-not-invoiced goods — GRNs from Story 4.5 with no supplier invoice captured against them via Story 4.7 (FR-AC-15)
**When** the GRNI ageing report is run
**Then** GRNI items are listed in 0-30 / 31-60 / 61-90 / 90+ day buckets by GRN date, with value per bucket per location and drill-through to the GRN and its PO reference (Story 2.9)
~~~~

#### E11-10 — REPLACE in `epics.md`

**Findings addressed:** Q6; Q9; Q12 partial (11.4 dev notes)

**Rationale:** The compound AC3 bundled three deliverables into one Then with an undefined '10% test'. Now decomposed into three independently testable ACs, with the 10% test defined as the actual CARO 2020 clause 3(ii)(a) statute: aggregate discrepancy per class of inventory as a percentage of that class's book value, flagged at >=10%. A fourth AC closes the epic's headline gap — close is blocked (APPROVAL_REQUIRED, matching the Epic 13 sign-off pattern at line 2426) until a DOA-resolved finance-controller sign-off is recorded as a domain event in the statutory edit log. Dev notes supply the Story 4.5/4.7/2.9 data lineage and the class-grouping source, completing the missing-dev-notes gap for 11.4.

**OLD:**

~~~~markdown
**Given** subledger balances at close (FR-AC-15)
**When** the reconciliation extract is generated
**Then** a subledger-to-GL reconciliation is produced, and CARO 2020 physical-verification evidence with a 10% test and an open-items report are available for sign-off
~~~~

**NEW:**

~~~~markdown
**Given** subledger balances at close (FR-AC-15)
**When** the reconciliation extract is generated
**Then** a subledger-to-GL reconciliation is produced per GL account, and every difference appears as an open item with a reason code — no unexplained residual

**Given** physical-verification and cycle-count events recorded through Story 2.6 (FR-AC-15)
**When** the CARO 2020 evidence pack is generated for a period
**Then** it compiles count sheets, variances, and approved adjustments per location, and applies the 10% test of CARO 2020 clause 3(ii)(a): for each class of inventory (raw materials, WIP, finished goods, stores and spares, scrap), aggregate discrepancies between counted and book value are computed as a percentage of that class's book value, any class at or above 10% is flagged with its adjustment disposition, and nil results are recorded as evidence too

**Given** open items exist from the reconciliation (FR-AC-15)
**When** the open-items report is run
**Then** each open item carries its reason code, age, owner, and value, filterable by GL account and location

**Given** the reconciliation extract, CARO evidence pack, and open-items report for a period (FR-AC-15)
**When** period close is attempted
**Then** close is blocked with `error_code: "APPROVAL_REQUIRED"` until a finance-controller sign-off resolved from the DOA registry (FR-DOA-01) is recorded as a domain event in the statutory edit log (FR-AC-13) — the period lock takes effect only after this recorded sign-off

**Dev notes:**
- GRNI is computed from Story 4.5 receiving events minus supplier invoices captured in Story 4.7; open-PO references come from Story 2.9 (ERP Inbound Reference Projections).
- The late-arrival disposition preserves the event-sourced rule that captured facts are immutable: the period lock governs financial postings, not event acceptance.
- The class-of-inventory grouping for the 10% test comes from the item-master classification (Schedule III inventory classes); the test runs per class in the aggregate across locations, per financial year, over Story 2.6 verification events.
~~~~


### Epic 12: Cross-Module Reporting and Executive Anal — 6 edits

#### E12-01 — REPLACE in `epics.md`

**Findings addressed:** C7 (12.2 fill rate/forecast accuracy Phase-2 dependency); C8 (12.3 FR-R-05 fulfillment suite Phase-2 dependency)

**Rationale:** Rescopes the epic goal and FR coverage to Phase-1-computable KPIs, moves FR-R-05 out of the Phase-1 FRs-covered list with an explicit Phase-2 note, and corrects the dependency declaration that contradicted the epic's own AC content (both critical verifier notes flagged the 'Depends on: Epics 1-11' understatement). References Story 2.9 per baked-in decision D1.

**OLD:**

~~~~markdown
**Goal:** Executives drill from KPIs (inventory turns, fill rate, procurement spend, stockout count, forecast accuracy) to the underlying transactions in a single pane. All roles have role-specific operational dashboards and exception alerts that surface what needs attention without navigation. Self-service ad-hoc reporting with Excel/PDF/CSV export and scheduled distribution eliminates the report-request queue.

**FRs covered:** FR-R-01, FR-R-02, FR-R-03, FR-R-04, FR-R-05, FR-R-06, FR-R-07, FR-R-08

**Depends on:** Epics 1-11
~~~~

**NEW:**

~~~~markdown
**Goal:** Executives drill from the Phase-1 KPI set (inventory turns, procurement spend, stockout count, and an approximated fill rate) to the underlying transactions in a single pane; forecast accuracy joins the KPI strip when Epic 15 demand planning delivers in Phase 2. All roles have role-specific operational dashboards and exception alerts that surface what needs attention without navigation. Self-service ad-hoc reporting with Excel/PDF/CSV export and scheduled distribution eliminates the report-request queue.

**FRs covered:** FR-R-01, FR-R-02, FR-R-03, FR-R-04, FR-R-06, FR-R-07, FR-R-08. FR-R-05 (fulfillment report suite: order status, backorders, fill rate by location) moves to Epic 15 (Phase 2) alongside the order-management data it reports on.

**Depends on:** Epics 1-11. The fill-rate approximation (Story 12.2) and the demand-planner dashboard (Story 12.1) additionally consume Story 2.9 (ERP Inbound Reference Projections) for sales-order demand and open-PO reference data.
~~~~

#### E12-03 — REPLACE in `epics.md`

**Findings addressed:** C7 (12.2 fill rate/forecast accuracy Phase-2 dependency); C8 (12.3 FR-R-05 fulfillment suite Phase-2 dependency); major: 12.1 vague AC1 (per-role content); major: 12.1 sizing (rule engine split); critical: 12.4 sizing (self-service BI bundle); minor: 12.3/12.4 persona precision

**Rationale:** Aligns the epic intro with the rescoped Phase-1 KPI set, enumerates the seven roles (from the PRD addendum Access Matrix Notes: 7-role matrix with dashboards readable by all seven, plus the two recorded role aliases), and signposts the 12.5/12.6 splits so the intro matches the new story structure.

**OLD:**

~~~~markdown
Executives drill from KPIs — inventory turns, fill rate, procurement spend, stockout count, forecast accuracy — down to the underlying transactions in a single pane (FR-R-03). All seven named roles have role-specific dashboards with configurable exception alerts, and self-service ad-hoc reporting supports Excel/PDF/CSV export and scheduled distribution. Operational domain views live in their module epics; Epic 12 is the cross-module executive layer built on the read model projections.
~~~~

**NEW:**

~~~~markdown
Executives drill from the Phase-1 KPI set — inventory turns, procurement spend, stockout count, and a fill rate approximated from the ERP sales-order reference projections (Story 2.9) — down to the underlying transactions in a single pane (FR-R-03); forecast accuracy is a Phase-2 extension that lands with Epic 15 demand planning. All seven coarse roles of the published access matrix (executive, finance, warehouse manager, inventory controller, procurement officer, demand planner, quality inspector) have role-specific dashboards, with configurable exception rules delivered by Story 12.5. Self-service ad-hoc reporting supports Excel/PDF/CSV export (Story 12.4) with scheduled distribution and shared definitions (Story 12.6). Operational domain views live in their module epics; Epic 12 is the cross-module executive layer built on the read model projections.
~~~~

#### E12-04 — REPLACE in `epics.md`

**Findings addressed:** major: 12.1 sizing (rule engine split); major: 12.1 vague AC1 (per-role content); minor: 12.1 offline/staleness gap; minor: 12.1 NFR-P citation precision

**Rationale:** Rescopes 12.1 to dashboard composition only (rule engine moves to Story 12.5 per the fixed split plan), gives each of the seven roles a verifiable minimum widget set grounded in Phase-1 stories, splits the performance criterion into the correct numbered NFRs (screen 2s = NFR-P-01, API p95 500ms = NFR-P-05, replacing the bare 'NFR-P' that conflated the two), and adds the offline/staleness AC required by the NFR-P-04 two-tier model.

**OLD:**

~~~~markdown
As a role-holder,
I want a dashboard tailored to my role with real-time projections and configurable exception alerts,
So that I see exactly the items needing my attention without hunting through screens.

**Acceptance Criteria:**

**Given** each of the seven named roles (FR-R-01)
**When** a user opens their dashboard
**Then** a role-specific dashboard is shown, driven by real-time read model projections

**Given** configurable exception rules (FR-R-02)
**When** an item breaches a rule threshold
**Then** it surfaces as an exception alert on the relevant role dashboard

**Given** a dashboard request (NFR-P)
**When** the dashboard loads
**Then** it responds within the API p95 target of 500ms
~~~~

**NEW:**

~~~~markdown
As a role-holder,
I want a dashboard tailored to my role with real-time projections and the exception alerts that target my role,
So that I see exactly the items needing my attention without hunting through screens.

**Acceptance Criteria:**

**Given** each of the seven coarse roles of the published access matrix (FR-R-01) — executive, finance, warehouse manager, inventory controller, procurement officer, demand planner, quality inspector
**When** a user opens their dashboard
**Then** a role-specific dashboard is shown, driven by real-time read model projections, rendering at minimum that role's widget set:
- **Executive:** the cross-module KPI strip (Story 12.2), top open exceptions across modules, and the multi-location consolidated view
- **Finance:** period-close status, ITC register summary, budget-head availability, and pending sign-offs (Epic 11)
- **Warehouse manager:** open tasks by type, age, and zone with SLA breaches highlighted (Story 3.8), gate dwell median vs. the 4-minute target (SM-13), and pending-sync edge captures
- **Inventory controller:** stock by location with below-reorder-point exceptions (Stories 2.2, 2.7), cycle-count variances (Story 2.6), aging/obsolescence flags (Story 2.7), and open transfer requests (Story 2.5)
- **Procurement officer:** open PO status with overdue lines (Epic 4, Story 2.9), requisitions and POs awaiting approval, MSME ageing alerts, and a spend snapshot (FR-P-08)
- **Demand planner:** below-safety-stock and reorder exceptions with replenishment recommendations (Story 2.7), and inbound supply vs. sales-order demand from the Story 2.9 reference projections — forecast widgets are a Phase-2 extension (Epic 15)
- **Quality inspector:** open inspections, lots on hold, NCR/CAPA aging, and calibration-lockout events (Epic 8, FR-Q-13)

**Given** an exception alert raised by the rule engine (Story 12.5, FR-R-02)
**When** the user whose role the rule targets opens their dashboard
**Then** the alert appears in that dashboard's exceptions panel with drill-through to the breaching item

**Given** a dashboard request (NFR-P-01, NFR-P-05)
**When** the dashboard loads
**Then** the screen renders within 2 seconds (NFR-P-01) and each backing API call meets the p95 target of 500ms (NFR-P-05)

**Given** the client is offline or a projection backing a widget is older than the configured staleness threshold (NFR-P-04 two-tier model)
**When** the dashboard renders
**Then** each affected widget shows its last-updated timestamp and a visible stale indicator — old numbers are never presented silently as current

**Dev note:** Exception rule definition, evaluation, and alert lifecycle (FR-R-02) are Story 12.5; this story consumes its alerts.
~~~~

#### E12-05 — REPLACE in `epics.md`

**Findings addressed:** C7 (12.2 fill rate/forecast accuracy Phase-2 dependency); major: 12.2 vague ACs (KPI formulas, drill depth/RBAC)

**Rationale:** Fixes C7 per directive: KPI AC rescoped to the three Phase-1-computable KPIs with explicit formulas and period bases; fill rate approximated from Story 2.9 sales-order projections plus Story 3.7 dispatch confirmations with the formula stated (baked-in decision D1 as the only demand source); forecast accuracy an explicit Phase-2 extension AC tied to Epic 15. Also adds the drill-through depth definition (KPI → breakdown → transaction list) and the RBAC collision AC with a stable error code, resolving the vague-AC finding.

**OLD:**

~~~~markdown
**Given** the executive dashboard (FR-R-01, FR-R-03)
**When** it loads
**Then** inventory turns, fill rate, procurement spend, stockout count, and forecast accuracy are shown as KPIs

**Given** a displayed KPI (FR-R-03)
**When** the executive drills into it
**Then** the drill-through leads from the KPI to the underlying transactions in a single pane

**Given** multiple locations (FR-R-01)
**When** the consolidated view is selected
**Then** KPIs are aggregated across all locations with per-location breakdown available
~~~~

**NEW:**

~~~~markdown
**Given** the executive dashboard (FR-R-01, FR-R-03)
**When** it loads
**Then** the Phase-1 KPI set is shown, each computed per its stated definition:
- **Inventory turns** = annualized cost of goods issued ÷ average on-hand inventory value at the Ind AS 2 valuation (Story 2.4), over the trailing 12 months (or since go-live if shorter), per location and consolidated
- **Procurement spend** = sum of received PO line values (GRN-based) in the selected period, decomposable by the five FR-P-08 dimensions
- **Stockout count** = number of SKU-location-days in the period where available quantity was zero for an active item with a configured reorder point (Stories 2.2, 2.7)

**Given** the ERP sales-order reference projections (Story 2.9) and dispatch confirmations (Story 3.7)
**When** the fill-rate KPI is computed
**Then** fill rate = sales-order lines fully dispatched on or before their requested date in the period ÷ sales-order lines due in the period, and the tile is labelled "approximated (ERP reference)"; when Story 2.9 projections are unavailable the tile shows "unavailable" rather than a fabricated value

**Given** Epic 15 demand planning is delivered (Phase 2, FR-D-01 to FR-D-08)
**When** forecast runs have produced forecast-vs-actual history
**Then** forecast accuracy (MAPE) joins the KPI strip without rework of the drill-through frame — this criterion is a Phase-2 extension and is not part of the Phase-1 definition of done

**Given** a displayed KPI (FR-R-03)
**When** the executive drills into it
**Then** the drill path is KPI → dimension breakdown (location, period, category) → contributing transaction list, all within a single pane, with each level filterable

**Given** an executive whose role scope excludes a location or cost-level data (NFR-SEC-06)
**When** they drill from a KPI toward the underlying transactions
**Then** rows outside their location scope are excluded and cost-restricted columns are masked; a drill into a projection the role has no read permission on is rejected with `error_code: "REPORT_PERMISSION_DENIED"`

**Given** multiple locations (FR-R-01)
**When** the consolidated view is selected
**Then** KPIs are aggregated across all locations with per-location breakdown available
~~~~

#### E12-06 — REPLACE in `epics.md`

**Findings addressed:** C8 (12.3 FR-R-05 fulfillment suite Phase-2 dependency); major: 12.3 vague ACs (report content/correctness, NFR-P-03 scope); minor: 12.3/12.4 persona precision

**Rationale:** Fixes C8 per directive: the fulfillment suite (FR-R-05) becomes an explicit Phase-2 dev-note deferral, and 12.3 is completable with inventory + procurement + quality suites — the quality suite referenced generically since Epic 8 retains FR-Q-13. Also resolves the vague-AC finding (report parameters, content, and one correctness check per inventory report, including the valuation-method note tying to Story 2.4 and the Epic 11 subledger) and restates NFR-P-03 to cover every report in the story. Persona mapped to named roles per the persona-precision finding.

**OLD:**

~~~~markdown
As an operations analyst,
I want inventory, procurement, and fulfillment report suites that render quickly,
So that I can produce standard operational reports on demand.

**Acceptance Criteria:**

**Given** inventory data (FR-R-04)
**When** the inventory report suite is run
**Then** aging, movement, and valuation reports are produced

**Given** procurement data (FR-R-04, FR-P-08)
**When** the procurement report suite is run
**Then** PO status, spend analytics (by supplier, category, location, department, and period), and MSME ageing reports are produced — covering all five FR-P-08 dimensions

**Given** fulfillment data (FR-R-05)
**When** the fulfillment report suite is run
**Then** order status, backorders, and fill rate by location are produced, and all reports complete under 10 seconds (NFR-P-03)
~~~~

**NEW:**

~~~~markdown
As an inventory controller or procurement officer (any role granted reporting permission),
I want inventory, procurement, and quality report suites with defined parameters that render quickly,
So that I can produce standard operational reports on demand.

**Acceptance Criteria:**

**Given** inventory data (FR-R-04) and report parameters (date range, location set, item category)
**When** the inventory report suite is run
**Then** three reports are produced: aging (stock bucketed by configurable age ranges, default 0-30/31-60/61-90/90+ days, by location and category), movement (opening balance + receipts - issues - adjustments = closing balance per SKU-location, reconciling to the event stream for the period), and valuation (valued at the Ind AS 2 costing method configured in Story 2.4, stated in the report header, with the report total tying to the Epic 11 inventory subledger balance for the same period)

**Given** procurement data (FR-R-04, FR-P-08)
**When** the procurement report suite is run
**Then** PO status, spend analytics (by supplier, category, location, department, and period), and MSME ageing reports are produced — covering all five FR-P-08 dimensions

**Given** quality data (FR-Q-13, delivered under Epic 8)
**When** the cross-module reporting surface is opened
**Then** the Epic 8 quality report suite (first-pass yield, rejection rates, NCR/CAPA aging, conditional-release counts, lockout events) is reachable from the same surface without re-implementation

**Given** any report in this story (NFR-P-03)
**When** it is run at production data volumes
**Then** it completes under 10 seconds — the bound applies to every report suite in this story, not to any single suite

**Dev note:** Deferred to Phase 2 (Epic 15): the FR-R-05 fulfillment report suite (order status, backorders, fill rate by location) requires the Epic 15 order-management module and ships as a companion story when Epic 15 is broken down. This story is completable with the inventory, procurement, and quality suites alone.
~~~~

#### E12-07 — REPLACE in `epics.md`

**Findings addressed:** critical: 12.4 sizing (self-service BI bundle); major: 12.1 sizing (rule engine split); major: 12.1 missing negative paths (FR-R-02 CRUD/lifecycle); major: 12.4 missing negative paths (export limit, delivery failure, sharing permissions); minor: 12.3/12.4 persona precision

**Rationale:** Applies the fixed 12.6 split (scheduling/distribution + sharing out of 12.4) and adds Story 12.5 (exception rule engine out of 12.1) at the end of the epic per the split rules. Story 12.4 keeps its number with reduced scope (builder + export, FR-R-06), gains the export-limit negative AC, query-path RBAC AC, and the build-vs-embed ADR dev note. Story 12.5 delivers rule CRUD with a validation negative path (INVALID_RULE_DEFINITION), breach evaluation, duplicate suppression, and acknowledge/clear-on-recovery lifecycle. Story 12.6 names the distribution channel (email), defines delivery failure/retry/surfacing (REPORT_DELIVERY_FAILED), and closes the data-exposure gap: shared and scheduled reports always render under the recipient's own permission scope, with REPORT_PERMISSION_DENIED for recipients lacking projection access. Personas mapped to named roles.

**OLD:**

~~~~markdown
### Story 12.4: Self-Service Ad-Hoc Reporting and Scheduled Distribution

As a power user,
I want a drag-and-drop ad-hoc report builder across all projections with export and scheduled distribution, and saved shareable definitions,
So that teams can build and share their own reports without engineering help.

**Acceptance Criteria:**

**Given** the read model projections (FR-R-06)
**When** a user builds an ad-hoc report by drag-and-drop
**Then** they can compose across all available projections and export to Excel, PDF, or CSV

**Given** a saved report definition (FR-R-07)
**When** a schedule is configured
**Then** the report is distributed to named recipients on the schedule

**Given** a report definition (FR-R-08)
**When** it is saved
**Then** it can be shared with other users and reused
~~~~

**NEW:**

~~~~markdown
### Story 12.4: Self-Service Ad-Hoc Report Builder and Export

As a role-holder with report-builder permission (e.g., finance or inventory controller),
I want a drag-and-drop ad-hoc report builder over the projections my role can read, with Excel/PDF/CSV export,
So that teams can build their own reports without engineering help.

**Acceptance Criteria:**

**Given** the read model projections (FR-R-06)
**When** a user builds an ad-hoc report by drag-and-drop
**Then** they can select fields, apply filters, and group/aggregate across the projections their role has read permission on, and export the result to Excel, PDF, or CSV

**Given** a builder user whose role scope excludes a location or cost-level fields (NFR-SEC-06)
**When** the report executes
**Then** rows outside their location scope are excluded and restricted columns are masked before rendering or export — never emitted and hidden client-side; composing over a projection the role has no read permission on is rejected with `error_code: "REPORT_PERMISSION_DENIED"`

**Given** a report whose result exceeds the configured export row limit (default 100,000 rows)
**When** export is attempted
**Then** it is rejected with `error_code: "EXPORT_LIMIT_EXCEEDED"` and the user is prompted to narrow filters or schedule the report for asynchronous delivery (Story 12.6)

**Given** a report definition (FR-R-06)
**When** the owner saves it
**Then** the owner can rerun it later; sharing with other users and scheduled distribution are Story 12.6

**Dev note:** Record the build-vs-embed decision (custom composable query layer vs. an embedded OSS BI engine) as an ADR before implementation. Constraints either way: the event-sourced read model projections are the only data source, data-level RBAC (NFR-SEC-06) is enforced in the query path (not the UI), the builder is a Tier-2 online control-plane surface per NFR-P-04 (not an offline-first flow), and the export limits above apply. Scheduled distribution (FR-R-07) and shared definitions (FR-R-08) are split to Story 12.6.

---

### Story 12.5: Configurable Exception Rule Engine

As an operations lead,
I want to create, edit, and deactivate exception rules over the read model projections, with a defined alert lifecycle,
So that each role's dashboard surfaces breaches automatically and no alert is duplicated, orphaned, or silently lost.

**Acceptance Criteria:**

**Given** a user with rule-administration permission (FR-R-02)
**When** they create a rule naming a projection field, a comparison operator, a threshold, and a target role dashboard
**Then** the rule is saved, versioned, and active from the next evaluation cycle; edits and deactivations are logged with actor and timestamp

**Given** a rule definition with an invalid threshold (e.g., non-numeric for a numeric field) or referencing a projection field that does not exist
**When** it is submitted
**Then** it is rejected with `error_code: "INVALID_RULE_DEFINITION"` and the offending attribute is identified in the error details

**Given** an active rule (FR-R-02)
**When** an item breaches the rule threshold
**Then** an exception alert is raised on the target role dashboard (Story 12.1) referencing the rule and the breaching item

**Given** an alert already open for a rule-item combination
**When** subsequent evaluation cycles find the breach persisting
**Then** the existing alert is updated (last-evaluated timestamp) and no duplicate alert is created while the breach persists

**Given** an open alert
**When** the underlying value returns within the threshold, or a user acknowledges the alert
**Then** the alert auto-clears on recovery, or is marked acknowledged with actor and timestamp — both transitions are recorded in the alert history

---

### Story 12.6: Scheduled Report Distribution and Shared Definitions

As a role-holder with report-builder permission,
I want saved reports distributed on a schedule and shareable with other users under their own permissions,
So that recurring reports arrive without manual runs and sharing never leaks data beyond a recipient's scope.

**Acceptance Criteria:**

**Given** a saved report definition (FR-R-07)
**When** a schedule is configured
**Then** the report is rendered and distributed by email to named recipients on the schedule, and every delivery is logged with definition, recipients, and timestamp

**Given** a scheduled delivery fails — render error or mail rejection (FR-R-07)
**When** the failure occurs
**Then** delivery is retried (default 3 attempts with backoff); on final failure the run is logged with `error_code: "REPORT_DELIVERY_FAILED"` and surfaced as an exception alert to the report owner — never silently dropped

**Given** a report definition shared with another user (FR-R-08)
**When** the recipient runs it
**Then** it executes under the recipient's own permission scope — rows outside their location scope are excluded and restricted columns are masked at render time, never inherited from the owner's scope

**Given** a recipient (shared or scheduled) who has no read permission on any projection the report uses (FR-R-08, NFR-SEC-06)
**When** the report is run or the scheduled render for that recipient executes
**Then** the run is rejected for that recipient with `error_code: "REPORT_PERMISSION_DENIED"` and the owner is notified; scheduled renders always execute under each recipient's own permissions
~~~~


### Epic 13: Data Migration Sign-Off Gate — 7 edits

#### E13-01 — REPLACE in `epics.md`

**Findings addressed:** critical: 13.2 gate passes (C10); FR-DM-01 partial; minor: 13.2 header/story consistency

**Rationale:** D6 rescope of the Epic List goal: removes gate passes (Phase-2 Epic 20, no Phase-1 target entity) and the asset register (Epic 17) from the go-live gate's domain list, and states where each deferred clause lands, including the FR-DM-01 sales-order clause satisfied by Story 2.9 projections per D1.

**OLD:**

~~~~markdown
**Goal:** The system goes live with zero unexplained opening-balance variances (SM-48). Department heads and finance sign off that physically verified stock balances, the asset register with depreciation, open POs, active BOMs, job-work challans, custody registers, and open gate passes in the new system match ERP and legacy records line for line. This sign-off is the mandatory go-live gate.
~~~~

**NEW:**

~~~~markdown
**Goal:** The system goes live with zero unexplained opening-balance variances (SM-48). Department heads and finance sign off that physically verified stock balances, open POs, active BOMs, job-work challans, and custody registers in the new system match ERP and legacy records line for line. This sign-off is the mandatory go-live gate. Open gate-pass migration defers to Epic 20 and asset-register migration to Epic 17 — each migrates in the wave in which its owning epic deploys; open sales orders are not migrated, they enter as Story 2.9 read-only ERP projections.
~~~~

#### E13-03 — REPLACE in `epics.md`

**Findings addressed:** critical: 13.2 gate passes (C10); minor: 13.2 header/story consistency; major: 13.2 pilot-slice dependency contradiction; FR-DM-01 partial

**Rationale:** D6 rescope of the detailed epic goal to the Phase-1 domain list (adding opening stock, which was missing), aligning it with the rescoped Story 13.2 so header and story no longer disagree, and stating the per-wave staging plus the three deferred/redirected FR-DM clauses.

**OLD:**

~~~~markdown
The system goes live with zero unexplained opening-balance variances (SM-48). Every active BOM, open PO, job-work challan, and custody register is verified in the new system, and department heads plus finance sign off — that sign-off is the go-live gate (FR-DM-03). Migration execution runs concurrent with Epics 2-12; these stories are the verification and sign-off events that unblock go-live.
~~~~

**NEW:**

~~~~markdown
The system goes live with zero unexplained opening-balance variances (SM-48). Every Phase-1 migration domain — opening stock, active BOMs, open POs, job-work challans, and custody registers — is verified in the new system, and department heads plus finance sign off — that sign-off is the go-live gate (FR-DM-03). Migration execution runs concurrent with Epics 2-12; these stories are the verification and sign-off events that unblock go-live, staged per go-live wave to the modules each wave deploys. Gate-pass migration (Epic 20) and asset-register migration (Epic 17) defer to their owning epics; open sales orders enter as Story 2.9 read-only ERP projections, not migration.
~~~~

#### E13-04 — REPLACE in `epics.md`

**Findings addressed:** major: 13.1 no rejection/error path; minor: 13.1 AC3 vague stage/no error code; minor: 13.1-13.3 no dev notes; FR-DM-01 partial

**Rationale:** Adds the missing rejection/error path for the import (malformed rows, unknown codes, duplicate lot/serial, partial-failure resume reusing DUPLICATE_EVENT idempotency), pins AC3's vague 'next stage' to the epic's declared stage model with a stable error code (VARIANCE_UNRESOLVED, also used by 13.3) and defined explained/resolved mechanisms, and adds Dev Notes covering staging, import format, ERP extract path (via Story 2.9's views per D1), domain events, and the explicit Epic 17 asset-register deferral.

**OLD:**

~~~~markdown
**Given** an unexplained variance (FR-DM-01, SM-48)
**When** proceeding to the next stage is attempted
**Then** progression is blocked until the variance is explained or resolved
~~~~

**NEW:**

~~~~markdown
**Given** an unexplained variance (FR-DM-01, SM-48)
**When** promotion from the staging load to the dry-run stage is attempted
**Then** promotion is blocked with `error_code: "VARIANCE_UNRESOLVED"` until the variance is explained (a recorded variance-explanation entry naming cause and approver) or resolved (a corrected import row)

**Given** an import file containing malformed rows or rows referencing unknown item or location codes (FR-DM-01)
**When** the import is run
**Then** each failing row is rejected with a row-level `error_code: "MALFORMED_ROW"` or `error_code: "UNKNOWN_REFERENCE"`, valid rows still load, and a rejected-row report lists every rejection with its source file and line

**Given** an import row whose lot or serial number duplicates one already loaded (FR-DM-01)
**When** the import is run
**Then** the row is rejected with `error_code: "DUPLICATE_LOT_SERIAL"` and appears on the rejected-row report

**Given** an import run that failed partway (FR-DM-01)
**When** the corrected file is re-submitted
**Then** the import resumes without duplicating previously accepted rows — already-loaded rows are suppressed idempotently as `DUPLICATE_EVENT`, and only new or corrected rows are applied

**Dev Notes:**

- Stage model per the epic critical note: extraction → staging load → dry-run → reconciliation. This story's blocking AC guards the staging-load → dry-run promotion.
- Import format: versioned CSV templates per location carrying item, location, lot, serial, quantity, and the physical-verification source reference per row. ERP and legacy balances for the variance report come from the same read-only ERP staging views that feed Story 2.9's projections — no alternative extract path.
- Loads, rejections, variance explanations, and stage promotions are recorded as domain events (e.g., `migration.opening_stock.loaded`, `migration.variance.explained`, `migration.stage.promoted`) in the `domain_events` table per the event-sourced architecture.
- Deferred to Phase 2 (Epic 17): asset-register migration (cost, accumulated depreciation, remaining Schedule II life — FR-DM-01 clause). The asset register migrates in the wave in which Epic 17 Fixed Assets deploys; it is not part of this gate.
~~~~

#### E13-05 — REPLACE in `epics.md`

**Findings addressed:** critical: 13.2 gate passes (C10); major: 13.2 pilot-slice dependency contradiction; minor: 13.2 'linkages intact' untestable / no exception path; minor: 13.2 AC3 forward reference to readiness assessment; minor: 13.2 sizing / scope ambiguity; minor: 13.2 header/story consistency; minor: 13.1-13.3 no dev notes; FR-DM-01 partial

**Rationale:** D6 rescope of Story 13.2: removes gate passes from story text and ACs with an explicit Epic 20 deferral note; reframes AC1 from asserting execution outcomes ('when migration runs') to the verification work this story owns, making 'linkages intact' testable (referential-integrity checks + source-vs-migrated counts) with a quarantine path (UNKNOWN_REFERENCE) for unresolvable references; adds the directed open-PO AC reconciling migrated balances against Story 2.9 projections (D1); rephrases AC3 as a self-contained queryable per-domain status that 13.3 consumes; Dev Notes carry the custody-wave staging note, the sales-order-via-2.9 note, and the execution/verification boundary — which also answers the sizing concern (one parameterized sign-off flow, execution owned elsewhere) without a split, consistent with the fixed story-number list containing no 13.x splits.

**OLD:**

~~~~markdown
As a migration lead,
I want active BOMs, open POs, job-work challans with source references, custody and loan registers, and open gate passes migrated with department-head verification per domain,
So that in-flight operations continue seamlessly in the new system.

**Acceptance Criteria:**

**Given** active operational documents (FR-DM-02)
**When** migration runs
**Then** active BOMs, open POs, job-work challans with source references, custody and loan registers, and open gate passes are migrated with their linkages intact

**Given** migrated documents in a domain (FR-DM-02)
**When** the department head reviews them
**Then** a verification sign-off is recorded per domain before that domain is considered migrated

**Given** a domain without a department-head sign-off (FR-DM-02)
**When** go-live readiness is assessed
**Then** that domain is flagged as not yet verified
~~~~

**NEW:**

~~~~markdown
As a migration lead,
I want active BOMs, open POs, job-work challans with source references, and custody and loan registers migrated with department-head verification per domain,
So that in-flight operations continue seamlessly in the new system.

**Acceptance Criteria:**

**Given** a domain's migration output (FR-DM-02)
**When** the domain verification run executes
**Then** active BOMs, open POs, job-work challans with source references, and custody and loan registers pass referential-integrity checks — every migrated document's item, location, supplier, and source-document references resolve — and per-domain reconciliation counts (source records vs migrated records) are produced on the domain verification report

**Given** a migrated document with an unresolvable reference — e.g., an open-PO line whose item is absent from the item master, or a challan source reference that cannot be matched (FR-DM-02)
**When** the domain verification run executes
**Then** the document is quarantined with `error_code: "UNKNOWN_REFERENCE"` and listed on the domain verification report the department head reviews — it does not count as migrated

**Given** migrated open-PO balances (FR-DM-01)
**When** the open-PO domain is verified
**Then** each migrated open-PO line (ordered, received, and open quantities with line tolerances) reconciles against the Story 2.9 ERP inbound reference projection, and every mismatch is listed on the domain verification report

**Given** migrated documents in a domain (FR-DM-02)
**When** the department head reviews them
**Then** a verification sign-off is recorded per domain before that domain is considered migrated

**Given** a domain without a department-head sign-off (FR-DM-02)
**When** the domain's verification status is queried
**Then** the domain reports status `unverified` — this per-domain status is queryable at any time and is the input Story 13.3's go-live gate consumes

**Dev Notes:**

- Boundary: migration *execution* is owned by the module epics (see the epic critical note and each epic's migration-prep note); this story owns the verification checks, reconciliation counts, quarantine handling, and the per-domain sign-off event (`migration.domain.verified` in `domain_events`). The sign-off workflow is one parameterized flow reused across domains.
- Custody-register staging: job-work custody ledgers (Epic 9) verify in the pilot wave; Epic 10 custody/loan registers are Phase 1 but outside the pilot slice — their migration and sign-off are staged to the wave in which Epic 10 deploys.
- Open sales orders are not migrated: they remain in ERP and enter the system exclusively as Story 2.9 read-only projections (this satisfies the FR-DM-01 sales-order clause by projection, not migration); that feed is verified within Story 2.9.
- Deferred to Phase 2 (Epic 20): open gate-pass migration (FR-DM-02 clause). No Phase-1 gate-pass entity exists; legacy open gate passes remain in the legacy register until Epic 20 ships and migrates them.
~~~~

#### E13-06 — REPLACE in `epics.md`

**Findings addressed:** minor: 13.3 AC1 lacks concrete observables

**Rationale:** Gives AC1 concrete observables: the reconciliation report's required contents (per-domain counts, quantity/value variances, explanation status) and its scope (the wave's go-live domains), replacing the untestable 'any remaining discrepancy is surfaced'.

**OLD:**

~~~~markdown
**Given** all migrated data (FR-DM-03)
**When** the final reconciliation is run
**Then** migrated data is reconciled to ERP and legacy records and any remaining discrepancy is surfaced
~~~~

**NEW:**

~~~~markdown
**Given** all migrated data (FR-DM-03)
**When** the final reconciliation is run
**Then** a reconciliation report is produced covering every domain in the wave's go-live scope — per-domain record counts (source vs migrated), quantity and value variances, and the explanation status of each variance — and any remaining discrepancy is surfaced on it
~~~~

#### E13-07 — INSERT AFTER in `epics.md`

**Findings addressed:** major: 13.3 missing negative path (sign-offs + non-zero variance)

**Rationale:** Adds the missing negative path on the gate's core condition: sign-offs recorded but SM-48 violated (non-zero unexplained variance) must block go-live with a stable error code and an enumerated variance list, so a tester has an observable to assert instead of inferring by contrapositive from the unblock AC.

**ANCHOR (insert after):**

~~~~markdown
**Given** completed reconciliation (FR-DM-03)
**When** go-live is requested without department-head and finance sign-off
**Then** go-live is blocked with `error_code: "APPROVAL_REQUIRED"` until both sign-offs are recorded
~~~~

**NEW (inserted):**

~~~~markdown


**Given** recorded department-head and finance sign-offs but a non-zero unexplained opening-balance variance (FR-DM-03, SM-48)
**When** go-live is requested
**Then** go-live is blocked with `error_code: "VARIANCE_UNRESOLVED"` and the response lists each unexplained variance blocking the gate
~~~~

#### E13-08 — INSERT AFTER in `epics.md`

**Findings addressed:** minor: 13.1-13.3 no dev notes; minor: 13.3 AC1 lacks concrete observables (go-live operation undefined); major: 13.2 pilot-slice dependency contradiction

**Rationale:** Dev Notes for Story 13.3: defines the guarded go-live operation (the undefined mechanism flagged in the minor finding), names the sign-off/unblock domain event types in domain_events per the event-sourced architecture, wires the gate to 13.2's per-domain statuses and 13.1's variance condition, and restates per-wave gate scope consistent with E13-02's dependency fix.

**ANCHOR (insert after):**

~~~~markdown
**Given** department-head and finance sign-off with zero unexplained opening-balance variance (FR-DM-03, SM-48)
**When** the sign-off gate is satisfied
**Then** a go-live unblock event is created in the system, releasing the go-live gate
~~~~

**NEW (inserted):**

~~~~markdown


**Dev Notes:**

- "Go-live" is the guarded cutover operation: activation of transactional posting for the wave's site(s). The gate blocks that activation event, nothing else.
- The gate evaluates the per-domain verification statuses recorded by Story 13.2 — every domain in the wave's go-live scope must be `verified` — plus zero unexplained opening-balance variance from Story 13.1's reconciliation (SM-48).
- Sign-offs and the unblock are domain events (`migration.signoff.recorded`, `golive.unblocked`) in the `domain_events` table per the event-sourced architecture; the unblock event is the durable record auditors check.
- Scope per wave: the gate covers exactly the modules deployed in the wave (pilot slice: Epics 1, 2, 3, 5, 7, 8, 9); domains owned by modules outside the wave gate their own later wave.
~~~~


### Cross-cutting edits to _bmad-output/planning-artif — 25 edits

#### E0-01 — REPLACE in `epics.md`

**Findings addressed:** major: 3.7 pilot-slice-coherence (IRN absent from pilot, D2); major: 13 pilot-slice-coherence (pilot PO system of record, partial); major: 3.2 undeclared-dependency (PO reference source stated as Story 2.9 per D1, partial)

**Rationale:** Adds Story 11.2 to the pilot slice with a one-line statutory rationale (D2) and states the pilot's system of record for POs/sales orders as Story 2.9 ERP projections (D1), closing the pilot-coherence gap that an e-invoiceable dispatch could leave the pilot with no IRN gate and no defined PO source.

**OLD:**

~~~~markdown
> **Pilot go-live slice (first go-live at a single site):** Epics 1, 2, 3, 5, 7, 8, 9 + Epic 13 sign-off gate. These seven epics constitute the minimum viable set for the pilot: compliance spine, core inventory, frontline warehouse capture, BOM (for job-work kit BOMs), maintenance instruments (hard prerequisite for QC lockout), QC gate, and job-work services.
~~~~

**NEW:**

~~~~markdown
> **Pilot go-live slice (first go-live at a single site):** Epics 1, 2, 3, 5, 7, 8, 9 + Story 11.2 (IRN-before-dispatch enforcement) + Epic 13 sign-off gate (pilot-scoped — see Epic 13). These seven epics plus Story 11.2 constitute the minimum viable set for the pilot: compliance spine, core inventory, frontline warehouse capture, BOM (for job-work kit BOMs), maintenance instruments (hard prerequisite for QC lockout), QC gate, and job-work services. Story 11.2 is pulled forward because the pilot site dispatches e-invoiceable supplies from day one and GST law blocks such dispatches without an IRN and signed QR (FR-AC-14) — going live without it would contradict Epic 1's compliant-by-construction guarantee. During the pilot, the ERP remains the system of record for purchase orders and sales orders: the pilot consumes them as read-only reference projections via Story 2.9 (ERP Inbound Reference Projections); native PO management arrives with Epic 4 in the first rollout wave.
~~~~

#### E0-02 — REPLACE in `epics.md`

**Findings addressed:** critical: 13.2 cross-phase-forward-dependency (D6, partial — dependency line); major: 13 pilot-slice-coherence

**Rationale:** Reconciles the contradiction between the pilot slice (Epics 1,2,3,5,7,8,9+13) and Epic 13's declared dependency on all Epics 1-12 by making the sign-off phased, and records the D6 rescope of Epic 13 to Phase-1 domains at the dependency line.

**OLD:**

~~~~markdown
**Depends on:** All Epics 1-12 (sign-off gate requires production-ready system)
~~~~

**NEW:**

~~~~markdown
**Depends on:** Phased sign-off. Pilot go-live requires sign-off from the pilot-slice epics only (Epics 1, 2, 3, 5, 7, 8, 9 + Story 11.2), scoped to the pilot site's domains: opening stock, active BOMs, open POs (as ERP reference projections via Story 2.9), job-work challans, and custody and loan registers. Full Phase-1 go-live requires all Epics 1-12 (production-ready system). Migration and verification of sales orders, the asset register with depreciation, and open gate passes are Phase 2 scope (Epics 15, 17, 20 — see their migration scope notes).
~~~~

#### E0-03 — REPLACE in `epics.md`

**Findings addressed:** dropped: FR-O-01 to FR-O-08; dropped: FR-D-01 to FR-D-08; dropped: FR-L-01 to FR-L-08

**Rationale:** Restores the PRD-verbatim behavioral qualifiers dropped from the FR-O/FR-D/FR-L restatement lines: validation checks (credit is load-bearing), configurable routing, FIFO-or-priority allocation, status attribution, SKU-location grain, forecast accuracy tracking, analogy-based NPI, BOM-explosion dependent demand, redistribution, and the owned-fleet scope qualifier.

**OLD:**

~~~~markdown
- FR-O-01 to FR-O-08: Order capture (manual, EDI, e-commerce, internal, inter-branch), validation, routing, split shipments, backorder allocation, status tracking, RMA returns, drop shipping.
- FR-D-01 to FR-D-08: Historical data analysis, statistical forecasting with best-fit model auto-selection, seasonality and trend detection, promotional overlay, collaborative forecasting, NPI forecasting, replenishment planning, inventory optimization.
- FR-L-01 to FR-L-08: Carrier registry and contract rates, shipment planning and consolidation, freight rate shopping, tracking with delay alerts, freight audit and payment, fleet management, import/export documentation, returns logistics.
~~~~

**NEW:**

~~~~markdown
- FR-O-01 to FR-O-08: Order capture (manual, EDI, e-commerce, internal, inter-branch), validation (completeness, credit, availability), routing by configurable rules, split shipments, backorder allocation (FIFO or priority), status tracking with attribution, RMA returns processing, drop shipping.
- FR-D-01 to FR-D-08: Historical data analysis at SKU-location grain, statistical forecasting with best-fit model auto-selection, seasonality and trend detection, promotional overlay, collaborative forecasting with accuracy tracking, NPI forecasting by analogy, replenishment planning (with BOM explosion for dependent demand per FR-B-07), inventory optimization and redistribution.
- FR-L-01 to FR-L-08: Carrier registry and contract rates, shipment planning and consolidation, freight rate shopping, tracking with delay alerts, freight audit and payment, fleet management where an owned fleet exists, import/export documentation, returns logistics.
~~~~

#### E0-04 — REPLACE in `epics.md`

**Findings addressed:** FR-Q-07 partial (BIS STI retention floor dropped from inventory restatement)

**Rationale:** Restores the BIS STI retention floor: without it, BIS-covered products could be configured below the statutory retention minimum.

**OLD:**

~~~~markdown
- FR-Q-07: Batch release records and CoA/CoC per lot; retention default 7 years.
~~~~

**NEW:**

~~~~markdown
- FR-Q-07: Batch release records and CoA/CoC per lot; retention default 7 years, never below BIS STI requirements.
~~~~

#### E0-05 — REPLACE in `epics.md`

**Findings addressed:** dropped: FR-TL-01 to FR-TL-17

**Rationale:** Restores the PRD-verbatim FR-TL collective statement — the heaviest compression in the inventory — including availability broadcast, overdue escalation, block policy, min-max perishables, life-history-through-regrinds, limit-driven condemnation proposals, PPE renewal cycles, and offline conflict escalation.

**OLD:**

~~~~markdown
- FR-TL-01 to FR-TL-17: Tool crib: tool master, QR tag, custody issue/return, hub member lending, perishable tooling stock, life counters, warning/hard-stop thresholds, regrind/repair routing, regrind limits, condemnation to FR-SC, gauge calibration lockout, PPE register, offline crib transactions.
~~~~

**NEW:**

~~~~markdown
- FR-TL-01 to FR-TL-17: Tool crib: tool master with class and QR tag; where-used through FR-B; asset and cost cross-reference; scan-based custody issue and return with overdue escalation; hub member lending with block policy; perishable tooling as min-max stock; life counters auto-incremented from production confirmations; warning and hard-stop thresholds blocking issue; life history surviving regrinds; regrind/repair routing (with confidentiality reference for IP-sensitive tooling); regrind limits proposing condemnation; condemnation exits through FR-SC with defacement; gauge calibration lockout at issue; personal PPE issue register with renewal cycles; tool availability broadcast to planning and booking; offline crib transactions with conflict escalation.
~~~~

#### E0-06 — REPLACE in `epics.md`

**Findings addressed:** dropped: FR-SC-14/15/16 (tolerance-blocked gates)

**Rationale:** Restores the tolerance-blocked-gates enforcement clause: the gate must block exit when exit weighment deviates beyond tolerance — the mechanism between weighment and re-weighment was lost.

**OLD:**

~~~~markdown
- FR-SC-14/15/16: EMD lifecycle; payment before lifting; slot-scheduled lifting with exit weighment and random re-weighment.
~~~~

**NEW:**

~~~~markdown
- FR-SC-14/15/16: EMD lifecycle; payment before lifting; slot-scheduled lifting with exit weighment, tolerance-blocked gates, and random re-weighment.
~~~~

#### E0-07 — REPLACE in `epics.md`

**Findings addressed:** dropped: FR-SC-21 (internal audit read-only access)

**Rationale:** Restores the internal-audit read-only access clause — an access-control/segregation requirement that had disappeared entirely.

**OLD:**

~~~~markdown
- FR-SC-21: Generated vs weighed vs disposed reconciliation per class per location.
~~~~

**NEW:**

~~~~markdown
- FR-SC-21: Generated vs weighed vs disposed reconciliation per class per location; internal audit read-only access.
~~~~

#### E0-08 — REPLACE in `epics.md`

**Findings addressed:** dropped: FR-FA-01 to FR-FA-06 (available-for-use trigger, 5% residual cap)

**Rationale:** Restores the Ind AS 16 available-for-use capitalization trigger and the 5% residual-value cap with justified deviations.

**OLD:**

~~~~markdown
- FR-FA-01 to FR-FA-06: Asset master with tags and parent-child components; capitalization from procurement through CWIP; CWIP ageing per Schedule III; component accounting; Schedule II lives and residual values; SLM/WDV depreciation runs posting to ERP after preview.
~~~~

**NEW:**

~~~~markdown
- FR-FA-01 to FR-FA-06: Asset master with tags and parent-child components; capitalization from procurement through CWIP at Ind AS 16 available-for-use; CWIP ageing per Schedule III; component accounting; Schedule II lives and residual values (max 5%) with justified deviations; SLM/WDV depreciation runs posting to ERP after preview.
~~~~

#### E0-09 — REPLACE in `epics.md`

**Findings addressed:** dropped: FR-FA-15 to FR-FA-20 (intangibles review scope, available-for-use, Schedule III ageing)

**Rationale:** Restores the qualifier drops with behavioral force: register-separate-from-PPE, Schedule III ageing basis, available-for-use trigger, what annual reviews must cover, and mandatory annual impairment tests for indefinite-life intangibles.

**OLD:**

~~~~markdown
- FR-FA-15 to FR-FA-20: Intangibles register; IAUD ledger fed project-wise from FR-RD-19; capitalization and amortization; annual reviews; impairment extension; derecognition and approval-gated IAUD write-offs.
~~~~

**NEW:**

~~~~markdown
- FR-FA-15 to FR-FA-20: Intangibles: register separate from PPE; IAUD ledger fed project-wise from FR-RD-19 with Schedule III ageing; capitalization and amortization at available-for-use; annual reviews of period, method, and indefinite-life assessments; impairment extension including annual tests where required; derecognition and approval-gated IAUD write-offs.
~~~~

#### E0-10 — REPLACE in `epics.md`

**Findings addressed:** FR-AC-02/03 partial (no-retroactive-reinstatement clause dropped)

**Rationale:** Restores the Ind AS 38 no-retroactive-reinstatement rule — a statutory enforcement clause with no enforcing text left in the inventory.

**OLD:**

~~~~markdown
- FR-AC-02/03: Research-phase issues expense; development-phase capitalization only after the six-criteria checklist.
~~~~

**NEW:**

~~~~markdown
- FR-AC-02/03: Research-phase issues expense; development-phase capitalization only after the six-criteria checklist; no retroactive reinstatement.
~~~~

#### E0-11 — REPLACE in `epics.md`

**Findings addressed:** FR-AC-12 partial (never-miscellaneous-income clause dropped)

**Rationale:** Restores the never-miscellaneous-income classification rule for maker-hub B2C sales.

**OLD:**

~~~~markdown
- FR-AC-12: Maker-hub B2C invoices at item rates, separated from machine-time service charges.
~~~~

**NEW:**

~~~~markdown
- FR-AC-12: Maker-hub B2C invoices at item rates, separated from machine-time service charges; never miscellaneous income.
~~~~

#### E0-12 — REPLACE in `epics.md`

**Findings addressed:** dropped: FR-IM-01 to FR-IM-09 (dual FX, valuation posting, PPV fallback)

**Rationale:** Restores the three dropped behavioral clauses (dual exchange rates on import POs, the valuation-posting rule keeping recoverable taxes out of item cost, and the PPV fallback for late true-ups) plus the by-duty-head, never-creditable, allocation-base, and two-year-window qualifiers, verbatim from the PRD.

**OLD:**

~~~~markdown
- FR-IM-01 to FR-IM-09: Imports: import-flagged POs, Bill of Entry capture, import IGST into ITC register, landed cost sheets, provisional assessment lifecycle, late cost true-up, ICEGATE/GSTR-2B reconciliation, duty-exemption licence hooks.
~~~~

**NEW:**

~~~~markdown
- FR-IM-01 to FR-IM-09: Imports: import-flagged POs with dual exchange rates; Bill of Entry capture by duty head; import IGST into the ITC register (BCD/SWS never creditable); landed cost sheets with selectable allocation bases; valuation posting keeping recoverable taxes out of item cost; provisional assessment lifecycle with two-year window; late cost true-up windows with PPV fallback; ICEGATE/GSTR-2B reconciliation; duty-exemption licence hooks (Advance Authorisation, EPCG).
~~~~

#### E0-13 — REPLACE in `epics.md`

**Findings addressed:** FR-DOA-01 partial (consumes-never-overrides clause dropped)

**Rationale:** Restores the consumes-never-overrides rule that makes the DOA registry the single approval resolver (AD-3) enforceable against workflow configuration.

**OLD:**

~~~~markdown
- FR-DOA-01: One enterprise DOA registry (role, transaction type, value band, vacation delegation, change audit) resolving approvers for every workflow.
~~~~

**NEW:**

~~~~markdown
- FR-DOA-01: One enterprise DOA registry (role, transaction type, value band, vacation delegation, change audit) resolving approvers for every workflow; workflow config consumes, never overrides it.
~~~~

#### E0-14 — REPLACE in `epics.md`

**Findings addressed:** dropped: FR-GP-01 (universality clause)

**Rationale:** Restores the universality rule defining which movements MUST have a gate pass — the enforcement scope of the whole FR-GP family.

**OLD:**

~~~~markdown
- FR-GP-01: RGP and NRGP as distinct serially numbered documents per GSTIN and site.
~~~~

**NEW:**

~~~~markdown
- FR-GP-01: RGP and NRGP as distinct serially numbered documents per GSTIN and site; required for every outbound movement that is not a sales dispatch, job-work challan, or scrap dispatch.
~~~~

#### E0-15 — REPLACE in `epics.md`

**Findings addressed:** dropped: FR-GP-02/03 (driving-document enumeration)

**Rationale:** Restores the enumeration of what qualifies as a driving document, without which the blocking rule is unimplementable as specified.

**OLD:**

~~~~markdown
- FR-GP-02/03: RGP issue with full consignment detail and reason codes; blocked unless linked to a driving document.
~~~~

**NEW:**

~~~~markdown
- FR-GP-02/03: RGP issue with full consignment detail and reason codes; blocked unless linked to a driving document (work order, calibration entry, approved demo/sample request).
~~~~

#### E0-16 — REPLACE in `epics.md`

**Findings addressed:** dropped: FR-GP-05/06/07 (substitution updates asset registers)

**Rationale:** Restores the requirement that an approved substitution must also update the asset registers, preventing divergence between the asset register and gate-pass reality.

**OLD:**

~~~~markdown
- FR-GP-05/06/07: Return receipts verifying serial identity and condition; line-level partial returns; approver-gated substitution on return.
~~~~

**NEW:**

~~~~markdown
- FR-GP-05/06/07: Return receipts verifying serial identity and condition; line-level partial returns; approver-gated substitution on return updating asset registers.
~~~~

#### E0-17 — REPLACE in `epics.md`

**Findings addressed:** phase2: Epic 15 goal inadequate; dropped: FR-O/FR-D/FR-L (goal restoration); critical: 13.2 cross-phase-forward-dependency (sales-order migration note, D6); FR-R-05 row correction (scope directive)

**Rationale:** Regenerates the Epic 15 goal so every FR-O/FR-D/FR-L scope element is named before Phase-2 story creation (roughly half the 24 mapped FRs previously had no anchor), takes ownership of FR-R-05, and adds the D6 sales-order migration note deferred from Epic 13.

**OLD:**

~~~~markdown
### Epic 15: Order Management, Demand Planning, and Logistics

**Goal:** Operations managers capture multi-channel orders, route them to optimal fulfillment locations, manage split shipments and backorders, run statistical demand forecasting with auto-selected models, replenish based on forecasts (with BOM explosion for dependent demand), and manage carrier rates, shipment planning, freight audit, and returns logistics.

**FRs covered:** FR-O-01..08, FR-D-01..08, FR-L-01..08

**Depends on:** Epics 2, 5
~~~~

**NEW:**

~~~~markdown
### Epic 15: Order Management, Demand Planning, and Logistics

**Goal:** Operations managers capture orders from every channel (manual, EDI, e-commerce, internal, inter-branch), validate them for completeness, credit, and availability, route them by configurable rules, and manage split shipments, backorder allocation (FIFO or priority), status tracking with attribution, RMA returns processing, and drop shipping. Demand planners analyze history at SKU-location grain, run statistical forecasting with best-fit model auto-selection, seasonality and trend detection, promotional overlay, collaborative forecasting with accuracy tracking, and NPI forecasting by analogy, plan replenishment (with BOM explosion for dependent demand per FR-B-07), and optimize and redistribute inventory across locations. Logistics teams manage the carrier registry and contract rates, shipment planning and consolidation, freight rate shopping, shipment tracking with delay alerts, freight audit and payment, fleet management where an owned fleet exists, import/export documentation, and returns logistics. The fulfillment report suite (FR-R-05) lands here with the order data it reports on.

**FRs covered:** FR-O-01..08, FR-D-01..08, FR-L-01..08, FR-R-05 (fulfillment report suite, moved from Epic 12)

**Depends on:** Epics 2, 5

**Migration scope note (deferred from Epic 13 per FR-DM-01):** Open sales orders with source references are migrated, reconciled, and department-verified within this epic. The Phase-1 Epic 13 gate excludes them; sign-off on migrated sales orders is a go-live gate for this epic.
~~~~

#### E0-18 — REPLACE in `epics.md`

**Findings addressed:** phase2: Epic 16 goal inadequate; dropped: FR-SC-21 (goal restoration); dropped: FR-SC-14/15/16 (goal restoration)

**Rationale:** Regenerates the Epic 16 goal to name every omitted FR-SC element (defective dispositions, defacement, NRV fields, three-different-users rule, class bins, blacklisting, sealed reserves, tolerance-blocked exit gates, sale documents, FR-AC-09 dated config, non-ferrous EPR, witnessed write-off with ITC/FA triggers, FR-SC-21 reconciliation with internal-audit access) so Phase-2 stories inherit full family scope.

**OLD:**

~~~~markdown
**Goal:** Every scrap receipt is source-linked, classified, weighed with photo evidence, and reconciled against BOM scrap percents. Disposal runs a DOA-approved, buyer-registered auction with EMD lifecycle and payment-before-lifting. Hazardous waste runs Form 10 manifests with a non-disableable 90-day storage timer. EPR channels enforce statutory routing for e-waste, battery, and plastic packaging.
~~~~

**NEW:**

~~~~markdown
**Goal:** Every scrap receipt is source-linked, classified once at intake (classification determines bins, routes, and statutory channel; reclassification is audit-logged), stored in segregated class bins that block cross-class putaway, weighed with photo evidence, and reconciled against BOM scrap percents. Defectives run a disposition workflow (repair, refurbish-downgrade, cannibalize, condemn) with committee escalation and cannibalized component recovery; IP-sensitive lots require evidenced defacement before any sale; every lot carries NRV fields with rate source and valuer. Disposal approvals resolve through the DOA registry with proposer, approver, and custodian as three different users. Buyers are registered (GSTIN, PAN, SPCB/CPCB credentials for regulated categories) with blacklisting; lots carry sealed reserve prices; auctions run tender mechanics in reverse with below-reserve and single-bid outcomes escalating to committee. The EMD lifecycle, payment-before-lifting, and slot-scheduled lifting with exit weighment, tolerance-blocked gates, and random re-weighment govern physical removal. Sale documents carry GST, TCS (s.394(1) Income-tax Act 2025), and e-way bill triggers, with scrap-sale tax events maintained as dated configuration, not code (FR-AC-09). Hazardous waste goes to authorized recyclers/TSDFs with Form 10 manifests and the non-disableable 90-day storage timer; e-waste, battery, and non-ferrous EPR channels block awards to unregistered buyers; plastic packaging EPR data is compiled by category, GSTIN, and financial year for CPCB portal returns. Write-off and destruction require witness and evidence and auto-trigger ITC reversal evaluation and FA derecognition. A generated-vs-weighed-vs-disposed reconciliation runs per class per location with internal-audit read-only access.
~~~~

#### E0-19 — REPLACE in `epics.md`

**Findings addressed:** phase2: Epic 17 goal inadequate; dropped: FR-FA-01 to FR-FA-06 (goal restoration); dropped: FR-FA-15 to FR-FA-20 (goal restoration); critical: 13.2 cross-phase-forward-dependency (asset-register migration note, D6)

**Rationale:** Regenerates the Epic 17 goal to name every omitted FR-FA element (available-for-use, Schedule III CWIP ageing, 5% residual cap, dual views, effective-dated transfers with FR-AC-10, repair-vs-capitalize queue, Ind AS 36 indicators, disposal via FR-SC, immutable trail, intangible annual reviews and impairment tests) and adds the D6 asset-register migration note deferred from Epic 13.

**OLD:**

~~~~markdown
### Epic 17: Fixed Assets, Intangibles, and Depreciation

**Goal:** Finance teams manage the operational asset subledger — CWIP accumulation, component accounting, Schedule II SLM/WDV depreciation runs with preview-and-approve posted to ERP, offline physical verification by tag scan, and an intangibles register with IAUD ageing and amortization. The ERP GL stays the book of record.

**FRs covered:** FR-FA-01..20

**Depends on:** Epics 1, 2, 7
~~~~

**NEW:**

~~~~markdown
### Epic 17: Fixed Assets, Intangibles, and Depreciation

**Goal:** Finance teams manage the operational asset subledger: capitalization from procurement through CWIP at Ind AS 16 available-for-use, with CWIP ageing per Schedule III; component accounting; Schedule II lives and residual values (max 5%) with justified deviations; SLM/WDV depreciation runs with preview-and-approve posted to ERP; and dual views — Companies Act books plus a report-only income-tax block-of-assets WDV view. Effective-dated transfers reallocate depreciation, and inter-GSTIN moves trigger FR-AC-10 GST documents before dispatch. Subsequent-expenditure decisions and the repair-vs-capitalize queue from FR-M work orders leave none undecided at period lock. Impairment indicators are captured per Ind AS 36; retirement and disposal route through FR-SC with gain/loss computation; offline physical verification runs by tag scan per CARO 2020; every asset carries an immutable audit trail. The intangibles register sits separate from PPE, with the IAUD ledger fed project-wise from FR-RD-19 with Schedule III ageing, capitalization and amortization at available-for-use, annual reviews of period, method, and indefinite-life assessments, impairment extension including annual tests where required, and derecognition with approval-gated IAUD write-offs. The ERP GL stays the book of record.

**FRs covered:** FR-FA-01..20

**Depends on:** Epics 1, 2, 7

**Migration scope note (deferred from Epic 13 per FR-DM-01):** The asset register — cost, accumulated depreciation, and remaining Schedule II life — is migrated, reconciled, and department-verified within this epic. The Phase-1 Epic 13 gate excludes it; sign-off on the migrated asset register is a go-live gate for this epic.
~~~~

#### E0-20 — REPLACE in `epics.md`

**Findings addressed:** phase2: Epic 18 goal inadequate; dropped: FR-IM-01 to FR-IM-09 (goal restoration)

**Rationale:** Regenerates the Epic 18 goal to name the three omitted FR-IM elements: dual exchange rates on import-flagged POs, the valuation-posting rule keeping recoverable taxes out of item cost, and late cost true-up windows with PPV fallback.

**OLD:**

~~~~markdown
**Goal:** Import officers capture Bill of Entry by duty head, compute landed cost sheets with selectable allocation bases, keep recoverable import IGST in the ITC register (BCD/SWS never creditable), manage the two-year provisional assessment lifecycle, reconcile with ICEGATE/GSTR-2B, and handle duty-exemption licence hooks (Advance Authorisation, EPCG).
~~~~

**NEW:**

~~~~markdown
**Goal:** Import officers raise import-flagged POs carrying dual exchange rates, capture Bill of Entry by duty head, and compute landed cost sheets with selectable allocation bases. Valuation posting keeps recoverable taxes out of item cost: recoverable import IGST goes to the ITC register while BCD/SWS are never creditable. They manage the two-year provisional assessment lifecycle, apply late cost true-ups within configured windows with PPV fallback when a window closes, reconcile with ICEGATE/GSTR-2B, and handle duty-exemption licence hooks (Advance Authorisation, EPCG).
~~~~

#### E0-21 — REPLACE in `epics.md`

**Findings addressed:** phase2: Epic 19 goal inadequate; dropped: FR-TL-01 to FR-TL-17 (goal restoration)

**Rationale:** Regenerates the Epic 19 goal to name every omitted FR-TL element: PPE register with renewal cycles, offline crib transactions with conflict escalation, lending block policy, perishable min-max, life history surviving regrinds, limit-driven condemnation proposals, availability broadcast, where-used and asset/cost cross-reference, and overdue escalation.

**OLD:**

~~~~markdown
**Goal:** Tool crib operators issue and return tools by QR scan, life counters auto-increment from production confirmations, hard-stop thresholds block issue when a tool exceeds its life, regrind/repair routing covers IP-sensitive tooling, and condemned tools exit through the scrap module with evidenced defacement. Gauge calibration lockout applies at issue.
~~~~

**NEW:**

~~~~markdown
**Goal:** Tool crib operators issue and return tools by QR scan against a tool master carrying class, where-used through FR-B, and asset and cost cross-references. Custody issues and returns are scan-based with overdue escalation; hub member lending is governed by a block policy; perishable tooling runs as min-max stock. Life counters auto-increment from production confirmations, warning and hard-stop thresholds block issue when a tool exceeds its life, and life history survives regrinds; regrind/repair routing covers IP-sensitive tooling with confidentiality references, regrind limits propose condemnation, and condemned tools exit through the scrap module with evidenced defacement. Gauge calibration lockout applies at issue. A personal PPE issue register tracks renewal cycles, tool availability broadcasts to production planning and hub booking, and crib transactions run fully offline with conflict escalation.
~~~~

#### E0-22 — REPLACE in `epics.md`

**Findings addressed:** phase2: Epic 20 goal inadequate; dropped: FR-GP-01 (goal restoration); dropped: FR-GP-02/03 (goal restoration); dropped: FR-GP-05/06/07 (goal restoration); critical: 13.2 cross-phase-forward-dependency (gate-pass migration note, D6)

**Rationale:** Regenerates the Epic 20 goal to name every omitted FR-GP element (per-GSTIN-and-site numbering, Rule 55 challans and e-way triggers, return receipts with partial returns and register-updating substitution, NRGP reason restriction with DOA, 7/15/30-day ageing with site-head escalation, off-site visibility report, deposit forfeiture and revaluation) and adds the D6 gate-pass migration note deferred from Epic 13.

**OLD:**

~~~~markdown
### Epic 20: Gate Passes and Returnable Materials

**Goal:** Every non-sale, non-job-work, non-scrap outbound movement requires a serially numbered RGP or NRGP linked to a driving document. Return clocks never expire silently. Gate enforcement blocks exit without a matching open pass. Returnable packaging registers track per-party deposits, refunds, and serialized cylinders.

**FRs covered:** FR-GP-01..14

**Depends on:** Epics 1, 2, 3
~~~~

**NEW:**

~~~~markdown
### Epic 20: Gate Passes and Returnable Materials

**Goal:** Every outbound movement that is not a sales dispatch, job-work challan, or scrap dispatch requires an RGP or NRGP — distinct documents serially numbered per GSTIN and site — issued with full consignment detail and reason codes and blocked unless linked to a driving document (work order, calibration entry, approved demo/sample request). Rule 55 delivery challans and e-way bill triggers cover non-sale movements above threshold. Return receipts verify serial identity and condition, support line-level partial returns, and route substitutions through approver gating that updates the asset registers. NRGPs issue only for permitted non-returnable reasons with DOA approval. Open-RGP ageing runs 7/15/30-day reminder defaults with site-head escalation; statutory and insurance window clocks per RGP class raise hard alerts to named owners — no clock expires silently. Gate enforcement blocks exit without a matching open pass and raises incidents on mismatch. An off-site asset visibility report by party, location, and value serves insurance and audit. Returnable packaging registers track per-party bidirectional balances and serialized cylinders with deposits, refunds, forfeiture, and revaluation.

**FRs covered:** FR-GP-01..14

**Depends on:** Epics 1, 2, 3

**Migration scope note (deferred from Epic 13 per FR-DM-02):** Open gate passes are migrated, reconciled, and department-verified within this epic. The Phase-1 Epic 13 gate excludes them; sign-off on migrated open gate passes is a go-live gate for this epic.
~~~~

#### E0-24 — REPLACE in `epics.md`

**Findings addressed:** FR-R-05 row correction (scope directive)

**Rationale:** FR-R-05 (fulfillment report suite) reports on order-management data that only exists once Epic 15 delivers FR-O; the row split moves it to Epic 15 Phase 2 per the coverage-map correction directive.

**OLD:**

~~~~markdown
| FR-R-01 to FR-R-08 | Epic 12: Cross-Module Reporting and Executive Analytics | Phase 1 |
~~~~

**NEW:**

~~~~markdown
| FR-R-01 to FR-R-04, FR-R-06 to FR-R-08 | Epic 12: Cross-Module Reporting and Executive Analytics | Phase 1 |
| FR-R-05 | Epic 15: Order Management, Demand Planning, and Logistics (fulfillment report suite) | Phase 2 |
~~~~

#### E0-25 — REPLACE in `epics.md`

**Findings addressed:** critical: 13.2 cross-phase-forward-dependency (coverage-map reflection, D6)

**Rationale:** Marks the FR-DM row as Phase-1-domains-only and points to the deferral footnote, consistent with the D6 rescope of Epic 13.

**OLD:**

~~~~markdown
| FR-DM-01 to FR-DM-03 | Epic 13: Data Migration Sign-Off Gate | Phase 1 |
~~~~

**NEW:**

~~~~markdown
| FR-DM-01 to FR-DM-03 | Epic 13: Data Migration Sign-Off Gate (Phase-1 domains; see FR-DM deferral note below) | Phase 1 |
~~~~

#### E0-26 — INSERT AFTER in `epics.md`

**Findings addressed:** critical: 13.2 cross-phase-forward-dependency (FR-DM footnote, D6)

**Rationale:** Adds the FR-DM deferral footnote under the coverage map per D6, so the 100%-coverage claim stays honest about which FR-DM clauses are gated in Phase 1 versus deferred to Phase-2 epics.

**ANCHOR (insert after):**

~~~~markdown
| FR-GP-01 to FR-GP-14 | Epic 20: Gate Passes and Returnable Materials | Phase 2 |
~~~~

**NEW (inserted):**

~~~~markdown

**FR-DM deferral note:** Epic 13's sign-off gate covers the Phase-1 migration domains only: opening stock, active BOMs, open POs, job-work challans, and custody and loan registers. Three FR-DM clauses defer to the Phase-2 epics that own their data: open sales orders (FR-DM-01) migrate and verify in Epic 15, the asset register with cost, accumulated depreciation, and remaining Schedule II life (FR-DM-01) in Epic 17, and open gate passes (FR-DM-02) in Epic 20 — each carried as a migration scope note on that epic.
~~~~


### E5 — PRD annex-of-record path fix, PRD copy preced — 8 edits

#### PA-01 — REPLACE in `prd.md`

**Findings addressed:** Post-Discovery: annex-of-record path is stale (commit 2375fff); Summary Critical Issue 5: PRD annex-of-record pointer is dead

**Rationale:** PRD §0 pointed at PLANNING/SCM-Requirements-Document/ (sharded), deleted in commit 2375fff; the annex now lives as a single file at PLANNING/archive/SCM-Requirements-Document.md (verified present). Updates the path and adds one sentence noting the consolidation, per the readiness report's document-hygiene fix.

**OLD:**

~~~~markdown
It distills and builds on the sharded High-Level Requirements Document v2.1 at `PLANNING/SCM-Requirements-Document/`, which remains the annex of record: FR statements here are normative capability summaries carrying the source document's stable IDs (FR-I-01, FR-P-09, FR-DOA-01, and so on); the full consequence detail, statutory citations, and edge cases for each FR live in the corresponding source section.
~~~~

**NEW:**

~~~~markdown
It distills and builds on the High-Level Requirements Document v2.1 at `PLANNING/archive/SCM-Requirements-Document.md`, which remains the annex of record: FR statements here are normative capability summaries carrying the source document's stable IDs (FR-I-01, FR-P-09, FR-DOA-01, and so on); the full consequence detail, statutory citations, and edge cases for each FR live in the corresponding source section. The annex was previously maintained as a sharded folder at `PLANNING/SCM-Requirements-Document/`; that folder has been consolidated into the single file above, which is now the sole annex location.
~~~~

#### PA-02 — REPLACE in `0-document-purpose.md`

**Findings addressed:** Post-Discovery: annex-of-record path is stale (commit 2375fff); Summary Critical Issue 5: PRD annex-of-record pointer is dead

**Rationale:** Sync edit, not an independent change: applies the identical E5-01 correction to the generated shard of §0 so the sharded copy does not retain the dead annex pointer until the next re-shard. Keeps the two PRD copies byte-consistent in the same change cycle, as PRD §0's own reconciliation rule requires.

**OLD:**

~~~~markdown
It distills and builds on the sharded High-Level Requirements Document v2.1 at `PLANNING/SCM-Requirements-Document/`, which remains the annex of record: FR statements here are normative capability summaries carrying the source document's stable IDs (FR-I-01, FR-P-09, FR-DOA-01, and so on); the full consequence detail, statutory citations, and edge cases for each FR live in the corresponding source section.
~~~~

**NEW:**

~~~~markdown
It distills and builds on the High-Level Requirements Document v2.1 at `PLANNING/archive/SCM-Requirements-Document.md`, which remains the annex of record: FR statements here are normative capability summaries carrying the source document's stable IDs (FR-I-01, FR-P-09, FR-DOA-01, and so on); the full consequence detail, statutory citations, and edge cases for each FR live in the corresponding source section. The annex was previously maintained as a sharded folder at `PLANNING/SCM-Requirements-Document/`; that folder has been consolidated into the single file above, which is now the sole annex location.
~~~~

#### PA-03 — REPLACE in `index.md`

**Findings addressed:** Post-Discovery: sharded PRD copy exists outside planning artifacts (dual-source drift risk); Summary Critical Issue 5: declared-precedence note for the duplicate PRD copies

**Rationale:** Two PRD copies exist with no declared precedence (dual-source drift risk flagged post-discovery). This note declares the whole PRD authoritative and marks PLANNING/prd/ as a generated sharding that must not be edited independently.

**OLD:**

~~~~markdown
# PRD: Materials & Supply Chain Management Platform

## Table of Contents
~~~~

**NEW:**

~~~~markdown
# PRD: Materials & Supply Chain Management Platform

> **Generated copy — do not edit independently.** This folder is a generated sharding of the authoritative whole PRD at `_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md`. The whole PRD is the document of record; make changes there and re-shard this copy in the same change cycle.

## Table of Contents
~~~~

#### PA-04 — INSERT AFTER in `ARCHITECTURE-SPINE.md`

**Findings addressed:** UX Misalignment 3 / Warning: notification service is architecturally homeless

**Rationale:** The readiness report found push/notification infrastructure architecturally homeless: Story 4.3 requires push notifications, FR-M-04 requires 5-minute fault alerts, FR-GP-09/10 and FR-JW-14 require escalating clocks — with no home, each module would invent its own. Adds the component to the Layer mapping table.

**ANCHOR (insert after):**

~~~~markdown
| API Gateway | `api/` | REST API v1; SSO-gated; edit-logged for mutating operations |
~~~~

**NEW (inserted):**

~~~~markdown

| Notification Service | `notify/` | Central alert and push delivery; subscribes to read-model projections and event triggers; delivers PWA push, in-app, and email/SMS; owns escalation clocks |
~~~~

#### PA-05 — INSERT AFTER in `ARCHITECTURE-SPINE.md`

**Findings addressed:** UX Misalignment 3 / Warning: notification service is architecturally homeless

**Rationale:** Companion to E5-04: gives the Notification Service its directory in the Structural Seed so the namespace declared in the Layer mapping table exists in the repository skeleton, matching the seed's one-line-per-module convention.

**ANCHOR (insert after):**

~~~~markdown
  reporting/               # Reporting and analytics module
~~~~

**NEW (inserted):**

~~~~markdown

  notify/                  # Notification service — push, alerts, escalation clocks
~~~~

#### PA-06 — INSERT AFTER in `ARCHITECTURE-SPINE.md`

**Findings addressed:** UX Misalignment 3 / Warning: notification service is architecturally homeless

**Rationale:** Capability → Architecture Map row for the new Notification Service, citing its known consumers across four FR families and its governing rule: it reads shared projections and event triggers per AD-14, never other modules' event streams.

**ANCHOR (insert after):**

~~~~markdown
| Reporting | FR-R-01–FR-R-08 | `reporting/` | AD-14 |
~~~~

**NEW (inserted):**

~~~~markdown

| Notifications & Alerts | FR-P-04/UJ-IND-01 (push-notified indent decisions), FR-M-04 (fault alerts), FR-GP-09/FR-GP-10 + FR-JW-14 (escalating overdue clocks) | `notify/` | AD-14 |
~~~~

#### PA-07 — INSERT AFTER in `ARCHITECTURE-SPINE.md`

**Findings addressed:** Summary Critical Issue 2: Phase-1 outbound-demand model undefined (decision D1); C2; C3; C7; C8

**Rationale:** Records decision D1 in the spine's Deferred table as resolved-in-epics so the architecture and epics agree on the Phase-1 outbound-demand model — the single decision the readiness report identified as unblocking C2, C3, C7, and C8. Cites epics Story 2.9 as directed by the coordinating scope (that story is being added by the parallel epics edit pass).

**ANCHOR (insert after):**

~~~~markdown
| EPR portal automation (INT-EPR-01) | Phase 2; manual upload acceptable for Phase 1 | Phase 2 planning |
~~~~

**NEW (inserted):**

~~~~markdown

| Phase-1 outbound demand source (decision D1) | Resolved in epics (Story 2.9): Phase-1 outbound demand is served by an ERP sales-order projection plus an open-PO inbound reference projection; native order capture (FR-O) remains Phase 2 (Epic 15) | Closed — revisit only if Epic 15 order capture is pulled forward |
~~~~

#### PA-08 — INSERT AFTER in `ARCHITECTURE-SPINE.md`

**Findings addressed:** UX Misalignment 1 / Warning: WCAG 2.1 AA appears in zero stories and zero architecture decisions; UX Misalignment 2 / Warning: i18n has no design-level landing point

**Rationale:** WCAG 2.1 AA and i18n existed only as restated NFR lines with no architecture convention carrying them. This Consistency Conventions row gives both an implementation path anchored to the existing error-envelope seam (stable error_code mapped to localized messages) plus locale resource files, so every frontend story inherits the standard.

**ANCHOR (insert after):**

~~~~markdown
| Config | Workflow rules, retention classes, statutory thresholds as dated configuration files, not hard-coded |
~~~~

**NEW (inserted):**

~~~~markdown

| Frontend standards | WCAG 2.1 AA conformance for every UI surface (NFR-U-02/03); i18n via the stable `error_code` → localized-message mapping plus per-locale resource files — no hard-coded user-facing strings |
~~~~


### Deferrals — 25 findings expressly not edited

- **[Epic 1: Platform Foundation, Compliance Spine, and]** Q7 (minor, Story 1.1): technical-milestone story with platform-engineer persona and no end-user value — _The finding's own recommendation is 'Accept as-is per the spine-first business decision; no restructuring needed' — Story 1.1 is the sanctioned greenfield initial-setup exception under the confirmed spine-first mandate. No edit is warranted._
- **[Epic 1: Platform Foundation, Compliance Spine, and]** Q4 secondary recommendation (Story 1.2): split SCIM provisioning/deprovisioning into its own story — _Not adopted. The fixed new-story-number plan allocates no number for an SSO/SCIM split (new numbers 1.10 and 1.11 are already assigned to CI/CD and notifications), and existing stories must not be renumbered. The verified defect — missing module- and function-scope denial ACs — is fully resolved by edit E1-03; the story remains implementable at its current size._
- **[Epic 1: Platform Foundation, Compliance Spine, and]** Q1 secondary recommendation (Story 1.7): state the FR-M-13 ownership split in Epic 7's header as well as Epic 1's — _Epic 7's header is owned by the Epic 7 agent in this course-correction pass; editing it here risks anchor collisions. The split is stated on the Epic 1 side in both the epic header (E1-01: 'FR-M-13 lockout enforcement invariant only — instrument records and the calibration register are Epic 7') and the Story 1.7 dev notes (E1-10). The Epic 7 agent should mirror the note in its header ('FR-M-13 instrument/calibration register; lockout enforcement invariant delivered by Epic 1 Story 1.7')._
- **[Epic 3: Warehouse Operations and Frontline Capture]** minor: 3.4/3.7 QC integration testability — the 3.7 half only (claim that the LOT_ON_HOLD block needs a quality-hold state only Epic 8 creates, with the recommendation to build a stub QC-task/hold schema in Epic 3 for 3.7) — _Refuted by the findings file's own verifier note: the quality-hold state and LOT_ON_HOLD rejection semantics are established in Epic 2 Story 2.3, which Epic 3 already depends on, so no stub schema is needed for 3.7. Edit E3-10 adds a clarifying citation to Story 2.3 in the 3.7 AC instead of new machinery. The surviving 3.4 half of the same finding (undefined interim behavior for BIS-flagged receipts before Epic 8's disposition flow) IS addressed, via the audited manual-release clause in edit E3-07._
- **[Epic 6: Production Orders and Manufacturing WIP]** minor: 6.4 sizing/bundling (genealogy + closure gate + offline replay + FR-B-08 variance report in one story) — _Splitting 6.4 would require a new 6.x story number, and the fixed story-number allocation for this course correction reserves none for Epic 6 — inventing one risks collision. The verifier note also concedes the bundling matches this document's sibling granularity (6.2 packs 3 FRs, 6.3 packs 4), and every concrete defect inside 6.4 (closure-gate linkage, immutability, central-only observability, FR-B-08 traceability) is individually fixed by edits E6-01, E6-04, and E6-09. Left as a delivery-planning note for sprint planning rather than a document change._
- **[Epic 6: Production Orders and Manufacturing WIP]** minor: FR-B-08 ownership ambiguity — residual sub-fix: Epic 5 Story 5.5's cost-rollup AC mis-cites FR-B-08 (should be FR-B-15) — _That AC ('**Given** a cost rollup is requested (FR-B-08)', currently line 1474) lives in Story 5.5 text the Epic 5 agent is restructuring under D4 and the sanctioned 5.6 split (cost rollups + ERP sync + job-work kit tagging move out of 5.5), so an anchor edit from this scope would collide with that move. The required change — retag the cost-rollup AC to (FR-B-15) wherever it lands (Story 5.6) — should ride the Epic 5 agent's edit. All other parts of this finding (Epic 6 coverage claim, Epic 5 coverage list, FR coverage map) are fixed here by E6-01, E6-03, and E6-04._
- **[Epic 8: Quality Control and Batch Release — story ]** minor: 8.2 AQL vagueness — recommendation to embed numeric lot-size-to-sample-size example mappings and switching-state transition scenarios in the ACs — _The verifier refuted the core claim: IS 2500 / ISO 2859-1 is a deterministic normative specification whose tables and switching triggers are exact lookups, so embedding example values in an epic-level AC is redundant over-specification. Only the verified residue — the unstated AQL-value/inspection-level parameter source — is fixed (edit E8-03)._
- **[Epic 8: Quality Control and Batch Release — story ]** major: 8.6 sizing — sub-recommendation to split FR-Q-13 quality reporting into its own standalone story — _The baked story-number plan fixes the only 8.6 split as 8.8 (witnessed inspections + prototype rules), and 8.7 already extracts the master-data scope. Post-split 8.6 carries two release-block ACs plus one enumerated dashboard AC — within normal story size — and the reporting scope note (epics.md line 328) keeps module dashboards inside module epics, so no further split is warranted._
- **[Epic 8: Quality Control and Batch Release — story ]** major: 8.6 prototype forward-dependency — alternative recommendation to relocate FR-Q-12 entirely into Epic 10 — _The epic directive selects the other remedy the finding itself offered: rewrite the AC as a stock-class-level rule testable with Epic 2 data (edit E8-07, Story 8.8) with an explicit sequencing note deferring design-evidence capture to Story 10.3. Relocating the FR would move the enforcement out of the pilot slice, weakening the control rather than fixing the sequencing._
- **[Epic 10: R&D and Maker-Hub Operations — story sect]** Q9 (minor, sizing): recommendation to split Story 10.5 into 10.5a (verification) / 10.5b (cost reporting + funding attribution) and to move the B2C invoice AC into the POS story — _The baked-in story-split list fixes the new numbers for this epic at 10.6 and 10.7 only — no 10.5 split is assigned, and inventing one would collide with the coordinated numbering. The verifier's own note downgrades the finding: 10.5's capabilities are coherent audit/compliance concerns under the finance-controller persona, not a grab-bag. The genuinely actionable parts of the finding ARE edited: E10-11 fixes the mistagged FR-AC-12 citation, restores the never-miscellaneous-income clause, and adds an explicit cross-reference that the invoice is generated at Story 10.6's point of sale while 10.5 asserts its compliance content — resolving the placement concern without a move._
- **[Epic 10: R&D and Maker-Hub Operations — story sect]** Q1 (partial): recommendation to also break machine-time booking (b) and replenishment (part of c) into their own stories, i.e. a four-way split of 10.4 — _The baked-in decision fixes the split shape: 10.4 keeps customer records + booking, 10.6 takes offline POS + payment capture (replenishment trigger rides with the POS sale that fires it), 10.7 takes job cards + statements. This matches the verifier's conclusion that a 2-3 way split is the right size once Story 1.8's offline platform is accounted for; a further booking-only story is not authorized and not needed. The substance of the finding is fully addressed by E10-09 and E10-13._
- **[Epic 13: Data Migration Sign-Off Gate]** minor: 13.2 sizing — recommendation to split Story 13.2 into per-domain stories 13.2a-13.2d — _The split itself is not applied: the verifier downgraded this to a scope-ambiguity issue (execution is owned by module epics; the sign-off flow is one parameterized workflow), and the baked-in story-number list allocates no new Epic 13 story numbers, so a split would collide with the fixed numbering plan. The surviving substance — AC1 asserting execution outcomes the story does not own — IS fixed in E13-05 by reframing AC1 to verification-run observables and adding an explicit execution/verification boundary Dev Note. Only the structural split is declined._
- **[Cross-cutting edits to _bmad-output/planning-artif]** critical: 13.2 cross-phase-forward-dependency — Epic 13 goal paragraph (line ~476) and Story 13.2 ACs still name the asset register with depreciation and open gate passes (and FR-DM-01 sales orders) as gate content — _The Epic 13 goal/story rescope to Phase-1 domains is owned by the Epic 13 agent per D6; this scope delivered its assigned parts — the phased dependency line (E0-02), the coverage-map FR-DM footnote (E0-25/E0-26), and the Epics 15/17/20 migration scope notes (E0-17/E0-19/E0-22)._
- **[Cross-cutting edits to _bmad-output/planning-artif]** major: 6.3 undeclared dependency — Epic 6 depends on Epic 8 (QC Hold, dispositions, rework) — _D3 assigns the Epic 6 header 'Depends on' edit to the epic-6 agent; scope rule 5 explicitly forbids duplicating it here._
- **[Cross-cutting edits to _bmad-output/planning-artif]** major: 3.2 undeclared dependency — Epic 3 consumes PO data before Epic 4 exists — _D1 resolves this via new Story 2.9 (ERP Inbound Reference Projections), owned by the Epic 2 agent; the Epic 3 header note referencing Story 2.9 belongs to the Epic 3 agent. This scope's pilot-slice edit (E0-01) already names Story 2.9 as the pilot's PO/sales-order source._
- **[Cross-cutting edits to _bmad-output/planning-artif]** major: 10 epic-sizing — Epic 10 carries 25 FRs across 5 stories; Story 10.4 bundles members, booking, and offline POS — _Fixed split numbers 10.6 (offline POS + payment capture) and 10.7 (member job cards + statements) are owned by the Epic 10 agent; story sections are outside this scope._
- **[Cross-cutting edits to _bmad-output/planning-artif]** major: 7.4 epic-sizing — Stories 7.4, 7.6, 5.5, and 6.4 are multi-domain bundles — _Fixed splits 7.7 (AMC/warranty/insurance), 7.8 (offline technician + closure codes), and 5.6 (cost rollups + ERP sync + job-work kit tagging) are owned by the Epic 7 and Epic 5 agents. Note for the orchestrator: the Story 6.4 bundle (genealogy/closure/offline/variance) has no assigned split number in the baked-in list — the Epic 6 agent should either split within its own numbering or accept the bundle._
- **[Cross-cutting edits to _bmad-output/planning-artif]** major: 1.1 greenfield-setup — no story creates the CI/CD pipeline that Stories 1.1 and 1.9 presuppose — _Resolved by new Story 1.10 (CI/CD Pipeline Construction), a fixed story number owned by the Epic 1 agent._
- **[Cross-cutting edits to _bmad-output/planning-artif]** minor: 1.8 — deferred framework decision (Next.js 16 vs TanStack Start) blocks Story 1.8 and every Epic 3 UI story — _The recommended decision-deadline note lives in the Epic 1 header, which is owned by the Epic 1 agent; not a cross-cutting artifact._
- **[Cross-cutting edits to _bmad-output/planning-artif]** minor: 8.1 — Story 8.1 AC references job-work orders delivered by Epic 9 — _AC rephrase to a generic order-scoped spec override is a story-section edit owned by the Epic 8 agent._
- **[Cross-cutting edits to _bmad-output/planning-artif]** minor: 9.4 — pilot QC gate feed: no explicit Epic 9 story posts job-work output into QC Hold — _Verification/AC addition in Story 9.4 (and its split 9.6) is a story-section edit owned by the Epic 9 agent._
- **[Cross-cutting edits to _bmad-output/planning-artif]** minor: 10.2 — boundary between FR-RD-04 project-budget checks and Story 11.3 ERP-synced budget heads unstated — _The recommended boundary statement lives in the Epic 10 header/story dev notes, owned by the Epic 10 agent._
- **[Cross-cutting edits to _bmad-output/planning-artif]** minor: 12.1 — Story 12.1 'Role-Specific Operational Dashboards' contradicts Epic 12's own scope boundary — _Story 12.1 rescope (with fixed split 12.5 for the exception rule engine) is owned by the Epic 12 agent._
- **[Cross-cutting edits to _bmad-output/planning-artif]** minor: 1 user-value-framing — Epic 1 title leads with plumbing rather than the guarantee — _Deliberately left alone: the title appears in two headings that other in-flight agents anchor on, the finding itself concedes the goal already earns the epic, and a cosmetic retitle mid-correction risks anchor collisions for no behavioral gain._
- **[Cross-cutting edits to _bmad-output/planning-artif]** consequence of E0-24/E0-27: Story 12.3's third AC still cites FR-R-05 ('Given fulfillment data (FR-R-05)... fulfillment report suite') — _Story sections are outside this scope; the Epic 12 agent should rescope Story 12.3's fulfillment AC or add a 'Deferred to Phase 2 (Epic 15): fulfillment report suite (FR-R-05)' dev note to match the coverage-map move._

## 5. Implementation Handoff

**Scope classification: Moderate** — backlog reorganization (new stories, splits, dependency/sequencing changes) with no fundamental replan. PRD/architecture edits are minor and surgical.

| Recipient | Responsibility |
|---|---|
| PM (this workflow, on approval) | Apply the 176 edits to `epics.md`, PRD copies, and `ARCHITECTURE-SPINE.md`; commit as a single change |
| PM + Sponsor | Sign off decisions D1 and D2 (embedded defaults); confirm Phase-2 epic goal regenerations |
| Super Admin (security lead) | Access matrix (~36 roles) before Phase-1 detailed design — unchanged obligation from PRD OQ7 |
| UX (next session) | UX design contract before first frontend story (four journeys + 29 stubs) — not blocked by these edits |
| Sprint Planning (next skill) | Re-run readiness spot-check, then `bmad-sprint-planning` against the corrected epics |

**Success criteria:** all 176 edits applied cleanly (anchor match = 176/176); coverage map, requirements inventory, and story ACs consistent; a re-run of the readiness check finds no critical violations; sprint planning can sequence stories without forward dependencies.

**Not addressed by this proposal (tracked separately):** production of the access matrix; the UX design contract; business sign-offs on PRD OQ4/5/6/9/10 and counter-metrics — these are decisions/deliverables, not epics edits.
