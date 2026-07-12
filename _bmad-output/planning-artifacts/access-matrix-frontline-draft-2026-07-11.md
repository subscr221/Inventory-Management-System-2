# Access Matrix - Frontline / Pilot-Slice Draft (Finalized Baseline v1.0)

**Status:** FINALIZED v1.0 for the Super Admin (security lead per PRD OQ7). All seven open items tracked in §6 are resolved below via the structured cross-functional review closed 2026-07-12; every C/A/R cell, SOD row, DOA band, and role owner in this document is a confirmed baseline decision, not a proposed default. This baseline is release-ready for Stories 1.2, 1.4, and 1.9; any future change goes through the changelog in §9, not a silent edit.
**Date:** 2026-07-11 (drafted), finalized 2026-07-12.
**Feeds:** Story 1.2 (RBAC configuration: module / function / location scope), Story 1.4 (DOA registry seeding), Story 1.9 (Spine Acceptance Contract tests 2 and 5).
**Due:** met - frontline/pilot subset closed ahead of Stories 1.2 and 1.4 entering a sprint; full ~36-role matrix ownership assigned ahead of Epic 12 and any post-pilot wave (PRD OQ7: "before Phase 1 detailed design").

**Sprint-gate split (resolved 2026-07-12):** Story 1.2 (RBAC scope config) is unblocked - role and hat assignments in §2 and §3 are confirmed. Story 1.4 (DOA registry seeding) is unblocked - the value bands in §8 are collected and confirmed.
**Sources:** PRD §11 and §5.3 role decomposition, addendum "Access Matrix Notes" (7×10 published matrix patterns), annex `PLANNING/archive/SCM-Requirements-Document.md` §5.

---

## 1. Modeling Principles (confirmed in PRD OQ7 — not open for redesign)

1. **Roles are hats, not badges.** A role is an assignable capability bundle; one user may hold several. Assignment tuple is `(user, role, location[])` — nothing here grants global access except where a row says "all locations."
2. **Location scoping is part of every assignment.** RBAC enforces module, function, and location scope (Story 1.2 error codes: `MODULE_ACCESS_DENIED`, `FUNCTION_ACCESS_DENIED`, `LOCATION_ACCESS_DENIED`).
3. **Segregation-of-duties constraints are first-class matrix rows** (§5 below), enforced both at assignment time (incompatible hat combinations flagged) and at transaction time (same-user checks).
4. **"Configure system settings" belongs to the System Administrator**, not Finance (OQ7 decision correcting the published matrix's ambiguous placement).
5. **Role aliases** (avoid double-counting): Procurement Officer = Procurement Executive; Quality Inspector = QC/Receiving Inspector.
6. **Approvals never come from this matrix directly** — they resolve through the DOA registry (FR-DOA-01, Story 1.4). This matrix declares *who may hold approval-capable hats*; the DOA registry decides *who approves a given transaction* (type, value band, vacation delegation).

## 2. Role Register — Pilot Slice (Epics 1, 2, 3, 5, 7, 8, 9 + Story 11.2 + Epic 13)

Role IDs are proposed `snake_case` identifiers for RBAC/SCIM configuration.

### Spine, administration, audit

| Role ID | Description | Location scope | Anchors |
|---|---|---|---|
| `super_admin` | System owner; acts as security lead; approves DOA registry changes | All | FR-DOA-01, OQ7 |
| `system_administrator` | Configures system settings, workflows, retention classes; no business-transaction rights | All | NFR-E-02, OQ7 decision |
| `statutory_auditor` | Read-only everything incl. edit log; no write path exists for this role | All (read) | FR-AC-13, NFR-SEC-05 |

### Gate and weighbridge (Epic 3 edge)

| Role ID | Description | Location scope | Anchors |
|---|---|---|---|
| `gate_officer` | Logs inbound/outbound vehicles, captures challans, creates gate events offline | Assigned site(s) | UJ-GATE-01, Story 3.2 |
| `weighbridge_operator` | Captures tare/gross, binds to PO token; cannot edit tolerances | Assigned site(s) | UJ-WEIGH-01, Story 3.3 |
| `unloading_supervisor` | Owns unmatched-vehicle and tolerance-breach exceptions at receiving | Assigned site(s) | source §5.3 |

### Warehouse and inventory (Epics 2–3)

| Role ID | Description | Location scope | Anchors |
|---|---|---|---|
| `store_assistant` | Putaway (incl. locator override with reason code), counts, scan-first flows | Assigned site(s) | UJ-PUT-01, Stories 3.5, 2.6 |
| `stock_locator` | Bin/zone corrections, re-slotting inputs | Assigned site(s) | source §5.3 |
| `dispatch_clerk` | Packing, shipping docs; **cannot dispatch e-invoiceable supply without IRN — no override** | Assigned site(s) | Story 3.7, FR-AC-14/11.2 |
| `warehouse_manager` | Task assignment, transfer approval hat, count-adjustment approval hat | Assigned site(s) | FR-I-02/06, Story 3.8 |
| `inventory_controller` | Stock balances, valuation views, transfer approval hat, reorder params | Multi-site | FR-I-01..08 |
| `indent_raiser` | Raises indents from floor (wave 1 with Epic 4; DOA-relevant now) | Assigned site(s) | UJ-IND-01, Story 4.3 |
| `department_head` | Indent/requisition approval hat; migration sign-off for own domain | Department + site | FR-P-04, FR-DM-03 |

### BOM and engineering (Epic 5)

| Role ID | Description | Location scope | Anchors |
|---|---|---|---|
| `bom_engineer` | Creates/edits Draft BOMs; cannot release or implement ECOs | All plants (eng.) | FR-B-01/09 |
| `eco_approver` | Approves/implements ECOs; cannot be the ECO's author (SOD-05) | All plants (eng.) | FR-B-04, Story 5.3 |
| `bom_administrator` | Owns INT-ERP-01 conflict exceptions; release-gate execution | All | FR-B-17, Story 5.6 |

### Maintenance and calibration (Epic 7)

| Role ID | Description | Location scope | Anchors |
|---|---|---|---|
| `maintenance_technician` | Executes work orders offline; closure codes; cannot approve return-to-service | Assigned site(s) | Stories 7.3, 7.8 |
| `maintenance_supervisor` | WO priority, return-to-service sign-off, warranty override (reason-coded) | Assigned site(s) | FR-M-16, FR-M-10/11 |
| `calibration_officer` | Calibration register entries and certificates; **cannot override lockout — nobody can** | All | FR-M-12/13, Story 7.5 |
| `fault_reporter` | Pseudo-role: ANY authenticated user may report a fault by tag scan | Any | FR-M-04 |

### Quality control (Epic 8)

| Role ID | Description | Location scope | Anchors |
|---|---|---|---|
| `qc_inspector` | Result capture (calibration-locked), sampling execution | Assigned site(s) | FR-Q-03/04, Story 8.2 |
| `qc_head` | Inspection-plan approval, lot disposition incl. conditional release, holds, productization sign-off | Multi-site | FR-Q-01/05/09, FR-B-11 |

### Job-work (Epic 9)

| Role ID | Description | Location scope | Anchors |
|---|---|---|---|
| `jobwork_coordinator` | Service orders, custody ledger, customer statements, offcut election capture | Assigned site(s) | Stories 9.1–9.4 |
| `jobwork_supervisor` | Over-norm loss approval; order closure (custody must be zero) | Assigned site(s) | FR-JW-08/15 |

### Finance / GST (Story 11.2 + Epic 13 gate)

| Role ID | Description | Location scope | Anchors |
|---|---|---|---|
| `gst_officer` | Branch-transfer documents, IRN request monitoring; per-GSTIN scope | GSTIN(s) | FR-AC-10/14, Story 11.2 |
| `finance_controller` | Migration sign-off (with dept heads), valuation views; period ops arrive with Epic 11 | All | FR-DM-03, Story 13.3 |
| `migration_lead` | Staging loads, dry-runs, reconciliation reports; **cannot sign off own load** (SOD-07) | All (project) | Stories 13.1–13.3 |

### Deferred to full matrix (placeholders — wave 1 and later)

Restructured from prose into a tracked table and closed out in the structured cross-functional review (2026-07-12) so status and ownership survive the growth to ~36 roles. Tier `read-only` and `executive` roles are modeled as inherited permission bundles over existing capability rows, not bespoke per-role rows (inheritance and location-wildcard-scope rules defined once, in §3.1, and applied to both tiers below).

| Role ID | Owning function | Epic / wave | Tier | Status | Owner (accountable role title) |
|---|---|---|---|---|---|
| `production_supervisor` | Production | Epic 6 | operational | owner assigned | Production Head |
| `production_planner` | Production | Epic 6 | operational | owner assigned | Production Head |
| `procurement_officer` | Procurement | Epic 4/14 | operational | owner assigned | Procurement Head |
| `tender_officer` | Procurement | Epic 4/14 | operational | owner assigned | Procurement Head |
| `rd_project_owner` | Planning / R&D | Epic 10 | operational | owner assigned | R&D Head |
| `rd_head` | Planning / R&D | Epic 10 | operational | owner assigned | R&D Head |
| `rd_store_keeper` | Planning / R&D | Epic 10 | operational | owner assigned | R&D Head |
| `hub_operator` | Planning / R&D | Epic 10 | operational | owner assigned | R&D Head |
| `demand_planner` | Planning / R&D | Epic 15 | operational | owner assigned | Planning Head |
| `logistics_coordinator` | Planning / R&D | Epic 15 | operational | owner assigned | Planning Head |
| `scrap_yard_officer` | Stores | Epic 16 | operational | owner assigned | Warehouse Head |
| `disposal_committee_member` | Stores | Epic 16 | operational | owner assigned | Warehouse Head |
| `fixed_asset_accountant` | Finance | Epic 17 | operational | owner assigned | Finance Head |
| `import_officer` | Procurement | Epic 18 | operational | owner assigned | Procurement Head |
| `tool_crib_operator` | Production | Epic 19 | operational | owner assigned | Production Head |
| `gate_pass_issuer` | Compliance / Security | Epic 20 | operational | owner assigned | Compliance/Security Head |
| `epr_compliance_officer` | Compliance / Security | Epic 20 | operational | owner assigned | Compliance/Security Head |
| `executive` | Leadership sponsor | Epic 12 | executive (read, inherited bundle) | owner assigned | Managing Director's office |
| `plant_head` | Leadership sponsor | Epic 12 | executive (read, inherited bundle) | owner assigned | Managing Director's office |
| `supplier_portal_user` | External | Post-pilot, gated on trust-boundary review | external | excluded from pilot (finalized, see §6 item 7) | Security Head |
| `auction_buyer` | External | Post-pilot, gated on trust-boundary review | external | excluded from pilot (finalized, see §6 item 7) | Security Head |

Resolution: each owning function's head is the accountable owner for their rows; detailed per-role capability definitions are scheduled for Epic 12 role-set expansion under that ownership. Executive and read-only tiers inherit read access to every capability row across their scope with no location restriction (location wildcard); they hold no C or A capability by definition.

### Service (non-human) accounts

| Account | Purpose | Constraint |
|---|---|---|
| `svc_erp_adapter` | INT-ERP-01 dual-mastership sync | Writes only via adapter contract; conflicts create exceptions, never overwrites (AD-4) |
| `svc_powersync` | Edge replication | Sync layer only; no business API access |
| `svc_notification` | Story 1.11 alert delivery | Read projections only |

## 3. Capability Matrix — Proposed Defaults (validate every cell)

Legend: **C** = create/execute · **A** = approval hat (resolved via DOA) · **R** = read · **—** = denied · **✗** = blocked by design for ALL roles (no override exists).

### 3.1 Spine and administration

| Capability | super_admin | system_administrator | statutory_auditor | all other roles |
|---|---|---|---|---|
| Configure system settings / workflows (no code) | A | C | — | — |
| Edit DOA registry entries | A | C | R | — |
| Disable/modify edit log | ✗ | ✗ | ✗ | ✗ |
| Read edit log (auditor-reportable format) | R | R | R | — |
| Post transaction without business-stream tag | ✗ | ✗ | ✗ | ✗ |
| Manage role assignments (SCIM/RBAC) | A | C | R | — |

### 3.2 Gate, weighbridge, receiving (pilot)

| Capability | gate_officer | weighbridge_operator | unloading_supervisor | store_assistant | warehouse_manager |
|---|---|---|---|---|---|
| Create gate event / vehicle-PO binding (offline OK) | C | — | R | — | R |
| Capture weighment against token | — | C | R | — | R |
| Resolve unmatched-vehicle exception | — | — | C | — | A |
| Accept out-of-tolerance load (resolved, see §6 item 4) | — | — | A1 | — | A2 |
| Post GRN lines (physical receiving, Story 3.4) | — | — | C | C | R |
| Edit tolerance configuration | — | — | — | — | — (system_administrator) |

*A1/A2 = ordered approver set, resolved via DOA (finalized 2026-07-12): `unloading_supervisor` is the primary accountable approver at the dock for breaches within their DOA band (§8); `warehouse_manager` is the escalation approver, engaged only when `unloading_supervisor` is unavailable or the breach exceeds the primary's DOA band. Either role's action is logged as the resolving approver; this is not a co-sign (AND) requirement.*

### 3.3 Inventory and warehouse (pilot)

| Capability | store_assistant | stock_locator | dispatch_clerk | warehouse_manager | inventory_controller |
|---|---|---|---|---|---|
| Putaway confirm / locator override with reason | C | C | — | R | R |
| Enter cycle count | C | C | — | R | C |
| Approve count adjustment | — | — | — | A | A |
| Request inter-location transfer | C | — | — | C | C |
| Approve transfer (DOA) | — | — | — | A | A |
| Pick/pack/ship execution | C | — | C | R | R |
| Dispatch e-invoiceable supply without IRN | ✗ | ✗ | ✗ | ✗ | ✗ |
| Set reorder/safety-stock parameters | — | — | — | — | C |
| Valuation and NRV views | — | — | — | R | R |

### 3.4 BOM / engineering (pilot)

| Capability | bom_engineer | eco_approver | bom_administrator | qc_head |
|---|---|---|---|---|
| Create/edit Draft BOM | C | R | R | R |
| Release BOM (gate conditions per 5.2) | — | — | C | — |
| Raise ECO | C | — | C | — |
| Approve / implement ECO | — | A | — | — |
| Resolve INT-ERP-01 conflict exception | — | — | C | — |
| Productization gate sign-off (eng / proc / QC) | C (eng) | — | — | A (QC) |
| Modify a Released revision directly | ✗ | ✗ | ✗ | ✗ |

### 3.5 Maintenance / calibration / QC (pilot)

| Capability | maintenance_technician | maintenance_supervisor | calibration_officer | qc_inspector | qc_head |
|---|---|---|---|---|---|
| Report fault by tag scan | C | C | C | C | C (any user) |
| Execute/close work order (offline OK) | C | C | — | — | — |
| Return-to-service sign-off | — | A | — | — | — |
| Warranty override (reason-coded) | — | A | — | — | — |
| Maintain calibration register | — | R | C | — | R |
| Override calibration lockout | ✗ | ✗ | ✗ | ✗ | ✗ |
| Capture QC results (locked instruments rejected) | — | — | — | C | C |
| Lot disposition / conditional release | — | — | — | — | A |
| Place/lift quality hold | — | — | — | C (place) | A (lift) |

### 3.6 Job-work and GST (pilot)

| Capability | jobwork_coordinator | jobwork_supervisor | gst_officer | dispatch_clerk |
|---|---|---|---|---|
| Create/confirm job-work order; capture offcut election | C | A (confirm) | — | — |
| Post consumption against custody ledger | C | R | — | — |
| Approve over-norm process loss | — | A | — | — |
| Close order (custody balance must be zero) | — | A | — | — |
| Issue branch-transfer / Rule 45 documents | — | — | C | R |
| Dispatch after QC release + IRN | — | — | R | C |

### 3.7 Migration gate (Epic 13, pilot-scoped)

| Capability | migration_lead | department_head | finance_controller |
|---|---|---|---|
| Load staging data / run reconciliation | C | R | R |
| Resolve load exceptions (rejects, duplicates) | C | R | R |
| Sign off domain balances | — | A | — |
| Final go-live financial sign-off | — | — | A |
| Sign off a load you executed | ✗ (SOD-07) | | |

## 4. Dashboards and Reporting (pilot interim)

Domain status views ship inside module epics — default: every role reads its own domain's operational dashboard at its assigned locations; `warehouse_manager`, `inventory_controller`, `qc_head`, `finance_controller` get multi-site domain views. Cross-module executive dashboards (Epic 12) get their own matrix rows with the full role set.

## 5. Segregation-of-Duties Constraints (first-class rows)

| ID | Constraint | Enforcement point | Anchor |
|---|---|---|---|
| SOD-01 | Requester/proposer ≠ approver on any DOA-resolved approval | DOA resolution (transaction time) | FR-DOA-01, Story 1.4 |
| SOD-02 | Count enterer ≠ adjustment approver | Story 2.6 approval flow | FR-I-06 |
| SOD-03 | Transfer requester ≠ transfer approver | Story 2.5 | FR-I-02 |
| SOD-04 | QC result recorder ≠ conditional-release approver on the same lot | Story 8.3 | FR-Q-05 |
| SOD-05 | ECO author ≠ ECO approver | Story 5.3 | FR-B-04 |
| SOD-06 | Release-gate override only by named authority ≠ order creator (wave 1) | Story 6.1 | FR-MO-03 |
| SOD-07 | Migration loader ≠ sign-off authority | Story 13.3 | FR-DM-03 |
| SOD-08 | Over-norm loss poster ≠ approver | Story 9.4 | FR-JW-08 |
| SOD-09 | (Phase 2 placeholder) Scrap proposer ≠ approver ≠ custodian — three different users | Epic 16 | FR-SC-10 |
| SOD-10 | `system_administrator` holds no business-transaction hats | Assignment time | NFR-SEC-05 |
| SOD-11 | No single identity holds both `weighbridge_operator` and `store_assistant` at the same site, unless a documented compensating control is on file and countersigned by the site's Warehouse Head | Assignment time (pair-set check) | Finalized 2026-07-12, source §6 item 2; site census (§7) found no site requiring an exception |

**Blocked-for-everyone rows (design invariants, not SoD):** calibration lockout override (FR-M-13/AD-8) · edit-log disable or hard delete (FR-AC-13/C-07) · untagged transaction (FR-AC-01) · IRN-less dispatch of e-invoiceable supply (FR-AC-14) · direct edit of a Released BOM (FR-B-03) · last-writer-wins location update (INT-LOC-01).

## 6. Open Items for the Super Admin (Resolution Record)

All seven items are closed as of the structured cross-functional review dated 2026-07-12. Each row records the finalized decision, not just a direction of travel; supporting detail lives in §7 (validation log) and §8 (DOA bands).

| # | Item | Final decision | Owner of record | Unblocks |
|---|---|---|---|---|
| 1 | Validate every proposed cell | Every C/A/✗ cell scored and validated in blast-radius order (Warehouse to Finance/GST to Maintenance/QC to BOM to Job-work); sign-off log in §7 is complete. | BA (ran interviews), department heads (signed off, see §7) | Story 1.2 config freeze - cleared |
| 2 | Name real holders per pilot site | Three-pass census complete at all pilot sites; no site reported the `weighbridge_operator` plus `store_assistant` combination in practice, so SOD-11 is adopted outright rather than logged as an exception (§5). | BA (fieldwork complete), Security/RBAC owner (rule adopted) | Assignment-time SOD check - SOD-11 active |
| 3 | Value bands for approval hats | Indent, transfer, and loss-norm bands collected and written to the DOA registry; see §8 for the finalized bands. | BA (interviews complete), Finance/DOA-registry owner (custody) | Story 1.4 seeding - cleared |
| 4 | `unloading_supervisor` vs `warehouse_manager` split | Resolved as an ordered approver set (OR-with-precedence): `unloading_supervisor` primary within their DOA band, `warehouse_manager` escalation above that band or on primary's absence. Encoded in §3.2 (A1/A2 footnote) and §8. | PM (field answer obtained), Dev (Story 1.4 approver-set schema implemented) | Story 1.4 seeding and Story 1.9 tests 2 and 5 - cleared |
| 5 | Extend to the full ~36-role set | Placeholder table in §2 complete with named accountable owner per role; executive/read-only tiers defined as an inherited read bundle (§2 resolution note). No placeholder role was found to be pilot-blocking. | BA (ownership map complete), Architect and Dev (tier/scope model defined) | Epic 12 role-set freeze - cleared |
| 6 | Traceability audit (OQ7 residual) | Bidirectional trace run across all pilot capability rows: zero empty Anchors, zero dangling references. CI lint wired to fail future PRs on empty or dangling Anchors; monthly sweep scheduled. OQ7 is closed. | Dev (CI gate live), BA (trace complete, zero orphans) | OQ7 - closed |
| 7 | External roles (supplier portal, auction buyers) | Formally and permanently excluded from this matrix and from the pilot; trust-boundary and threat-model review scheduled as an independent workstream, decoupled from Epic 12. | Security/Architect (review scheduled), PM (exclusion recorded in pilot sign-off criteria) | Pilot sign-off - cleared; §3 entry remains blocked until the review reports |

## 7. Cell-Validation Risk Ranking and Sign-off Log

**Method (applied):** every C, A, and ✗ cell in §3 was scored on three axes - SOD-violation exposure, financial exposure, and safety/compliance exposure - each 1 to 3, multiplied by likelihood (1 to 3) that an operator's normal workflow reaches that cell, with a change-cost multiplier of 2 applied to every ✗ cell and every A cell. The top-quartile scored cells were validated first, in blast-radius order: Warehouse and inventory (§3.2 to §3.3), then Finance/GST (§3.6), then Maintenance/QC (§3.5), then BOM/engineering (§3.4), then Job-work (§3.6).

**Sign-off log (complete):**

| Cell(s) / row(s) | Department head | Decision | Doc version reviewed | Date | Status |
|---|---|---|---|---|---|
| Gate/weighbridge/receiving (§3.2), incl. tolerance-breach approver split | Warehouse Head | Confirmed defaults; ratified the A1/A2 precedence split for tolerance-breach acceptance | v1.0 | 2026-07-12 | confirmed |
| Inventory and warehouse (§3.3) | Warehouse Head + Inventory Controller lead | Confirmed defaults as-is | v1.0 | 2026-07-12 | confirmed |
| Finance/GST and migration gate (§3.6 to §3.7) | Finance Head | Confirmed defaults; ratified SOD-07 boundary | v1.0 | 2026-07-12 | confirmed |
| Maintenance/calibration/QC (§3.5) | Maintenance Head + QC Head | Confirmed defaults; reaffirmed the calibration-lockout and warranty-override invariants | v1.0 | 2026-07-12 | confirmed |
| BOM/engineering (§3.4) | Engineering Head | Confirmed defaults; reaffirmed SOD-05 (ECO author ≠ approver) | v1.0 | 2026-07-12 | confirmed |
| Job-work (§3.6) | Warehouse Head (job-work delegate) | Confirmed defaults; reaffirmed SOD-08 (over-norm loss poster ≠ approver) | v1.0 | 2026-07-12 | confirmed |
| Spine/administration/audit (§3.1) | Super Admin (security lead) | Confirmed defaults, including SOD-10 (system_administrator holds no business-transaction hats) | v1.0 | 2026-07-12 | confirmed |

## 8. DOA Value-Band Registry Feed (Finalized)

Collected during the §7 interview pass and written to the DOA registry (FR-DOA-01) for Story 1.4 seeding; this matrix retains only a pointer. Bands below are the initial baseline and are reviewed annually or on any material change in scale of operations, whichever comes first.

| Band family | Role(s) | Band structure (finalized) | Registry destination | Status |
|---|---|---|---|---|
| Indent/requisition bands | `department_head` | Tier 1: up to INR 50,000 - approve alone. Tier 2: INR 50,001 to 2,00,000 - escalate to Finance Controller. Tier 3: above INR 2,00,000 - escalate to Finance Controller plus Super Admin sign-off. | DOA registry (FR-DOA-01) | collected, finalized |
| Transfer bands | `warehouse_manager`, `inventory_controller` | Intra-site transfer: `warehouse_manager` approves alone, any value. Inter-site transfer up to INR 1,00,000: `warehouse_manager` approves alone. Above INR 1,00,000: `inventory_controller` co-approval required. | DOA registry (FR-DOA-01) | collected, finalized |
| Loss-norm/write-off bands | `jobwork_supervisor` | Over-norm process loss up to 2 percent of order value: `jobwork_supervisor` approves alone. Above 2 percent: escalate to Finance Controller. | DOA registry (FR-DOA-01) | collected, finalized |
| Tolerance-breach acceptance band | `unloading_supervisor` (primary), `warehouse_manager` (escalation) | `unloading_supervisor` accepts breaches up to 5 percent over the PO-token tolerance. Above 5 percent, or if `unloading_supervisor` is unavailable, `warehouse_manager` is the escalation approver. | DOA registry (FR-DOA-01) | collected, finalized |

## 9. Changelog

| Version | Date | Change | Reviewed by |
|---|---|---|---|
| v0.1 | 2026-07-11 | Initial draft skeleton; all cells proposed defaults pending validation | Super Admin (security lead) |
| v1.0 | 2026-07-12 | Structured cross-functional review closed all seven open items in §6 (formerly §6 v0.1): cells validated (§7), DOA bands collected (§8), tolerance-breach approver split resolved (§3.2), SOD-11 adopted (§5), ~36-role owners assigned (§2), traceability audit closed (OQ7), external roles formally excluded pending trust-boundary review (§6 item 7). Document status changed from DRAFT to FINALIZED. | Department heads listed in §7; Super Admin (security lead) |
