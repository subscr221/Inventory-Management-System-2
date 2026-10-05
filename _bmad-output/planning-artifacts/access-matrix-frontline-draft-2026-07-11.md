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

### Employee base (every signed-in person)

The employee base role table below defines the one hat every human account holds in addition to its specialist hats. Service accounts (see "Service (non-human) accounts") do not hold it.

| Role ID | Description | Location scope | Anchors |
|---|---|---|---|
| `employee` | Base hat every signed-in person holds. Raise requisition, check availability, own requests. Assigned as module `employee`, write, at the person's site. | Site | UJ-IND-01, Story 1.15 |

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
| `inventory_controller` | Stock balances, valuation views, transfer approval hat, reorder params, maintains item groups when granted the create, edit or delete right (Story 2.10) | Multi-site | FR-I-01..08, Story 2.10 |
| `store_controller` | Physical custody of stores and warehouses; in Story 2.10 it receives item group notifications only and holds `warehouse` read at the site, no write power | Assigned site(s) | Story 2.10, owner rulings 2026-10-02 |
| `indent_raiser` | Raises indents from floor (wave 1 with Epic 4; DOA-relevant now) | Assigned site(s) | UJ-IND-01, Story 4.3 |
| `department_head` | Indent/requisition approval hat; migration sign-off for own domain | Department + site | FR-P-04, FR-DM-03 |

### Site leadership

The site leadership role table below registers the site head (Story 1.16). The role is granted at one site, never at every site, and is held by a named person at each pilot site. At the pilot the same person also wears `warehouse_manager` (owner ruling 2026-09-30); the two hats are separate assignments. This role is not the `plant_head` placeholder in the deferred list below, which stays as it is.

| Role ID | Description | Location scope | Anchors |
|---|---|---|---|
| `site_head` | Site-level authority: escalation target for job-work clocks and billing, challan classification correction, and (Story 4.8) assigning standing approvals and self-approval limits. Holds neither `finance_controller` nor `cfo`. | Site | FR-JW-09/10, FR-P-04, Stories 1.16, 4.8, 9.5, 9.6 |

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
| `jobwork_coordinator` | Service orders, custody ledger, customer statements, offcut capture to the holding ledger | Assigned site(s) | Stories 9.1-9.4, 9.6 |
| `jobwork_supervisor` | Over-norm loss approval; order closure (custody must be zero) | Assigned site(s) | FR-JW-08/15 |

### Finance / GST (Story 11.2 + Epic 13 gate)

| Role ID | Description | Location scope | Anchors |
|---|---|---|---|
| `gst_officer` | Branch-transfer documents, IRN request monitoring; per-GSTIN scope | GSTIN(s) | FR-AC-10/14, Story 11.2 |
| `finance_controller` | Job-work offcut disposal and valuation (sets the acquisition rate), migration sign-off with dept heads, valuation views; period ops arrive with Epic 11 | All | FR-DM-03, Story 9.7, Story 13.3 |
| `cfo` | Second signature on job-work offcut ACQUISITION above the governed DOA band; no operational duties | All | Story 9.7 |
| `migration_lead` | Staging loads, dry-runs, reconciliation reports; **cannot sign off own load** (SOD-07) | All (project) | Stories 13.1-13.3 |

**Ruled 2026-09-06: `cfo` and `finance_controller` are two distinct roles held by two SEPARATE REAL
PEOPLE.** This SUPERSEDES the 2026-09-05 note that the site head would wear the finance-controller
hat at the pilot; the site head holds neither. The separation is the whole control: the finance
controller sets the acquisition rate at disposal, and the CFO co-signs it above the governed DOA
band, so no single person both prices a customer's offcut and approves paying for it.

Three consequences worth carrying:

- The pilot constraint recorded on 2026-09-05 DISSOLVES. It said that because the site head held
  `finance_controller` and was also the Story 1.11 job-work escalation target, someone else had to
  be found to acknowledge the credit note. With the roles held by separate people that problem does
  not arise.
- The signature sits on the ACQUISITION at disposal, never on capture: capture records a physical
  fact, and gating it would leave produced material on the floor with nothing in the ledger.
- PROVISIONING PREREQUISITE, and it fails closed: `resolveApprover` raises `NO_APPROVER_FOUND` when
  no active user holds a role. A `cfo` DOA band with nobody provisioned refuses every acquisition
  above it, and an unheld `finance_controller` blocks disposal outright. BOTH roles must be granted
  to real, different users before Story 9.7 goes live.

### Damage-case decisions (Story 8.9)

The damage-case decision role table below adds the one role Story 8.9 introduces. The CEO acts only through the DOA registry, so the role is granted on the `employee` module at the site, held by its own account and by no other person.

| Role ID | Description | Location scope | Anchors |
|---|---|---|---|
| `ceo` | Decides damage cases escalated when QC and finance disagree; DOA `damage.escalation` | Site | Story 8.9 AC 3, AC 6 |

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
| Create item group (needs the `create` right) | - | - | - | - | C (right) |
| Edit, deactivate or reactivate item group, assign items (needs the `edit` right) | - | - | - | - | C (right) |
| Delete never-used item group (needs the `delete` right) | - | - | - | - | C (right) |
| Ungrouped items report | - | - | - | R | R |

The inventory and warehouse capability table above lists the item group rows added by Story 2.10. `C (right)` means the holder of `inventory_controller` also needs the matching item group right, granted per person by the CEO or the Finance Head (see section 3.11); `warehouse_manager` is deliberately excluded from changing item groups and receives a 403 `FUNCTION_ACCESS_DENIED`. Reading item groups needs inventory read, as for every other master.

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
| Create/confirm job-work order; record the offcut arrangement | C | A (confirm) | — | — |
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

### 3.8 Employee base (every signed-in person)

The employee base capability table below lists what the `employee` hat grants. Every role holds these capabilities through the base hat, so no specialist hat is needed for them. Stock quantities, valuations and the "Valuation and NRV views" row in section 3.3 stay gated by inventory read and are unchanged.

| Capability | employee (all roles) |
|---|---|
| Raise requisition | C |
| Stock availability (in stock or not, where) | R |
| My requests (own only) | R |
| Report damage (Story 8.9) | C |

### 3.9 Damage cases (Story 8.9)

The damage-case capability table below lists who works a damage case after it is reported. Reporting itself is the base-hat row in section 3.8. The key, whole-lot, escalation and ERP-reference rows are granted by the DOA registry, not by a hat: the hat only lets the person reach the screen, and the registry names the one person who may act. The reporter never turns a key, decides the whole lot or decides the escalation on their own case, the two keys are two different people, and the escalation decider holds neither key (SOD-01 applied to a two-key case).

| Capability | Who | Grant |
|---|---|---|
| Inspect reported units (confirm the damaged quantity) | `qc_inspector`, `qc_head` | `qc` write at the site |
| Mark units arrived in QC hold, sent for external check, returned | Store roles, QC | `warehouse` or `qc` write at the site |
| Decide the whole-lot hold and turn the QC key | `qc_head` | DOA `damage.qc_concurrence` |
| Turn the finance key and record the ERP reference | `finance_controller` | DOA `damage.finance_concurrence` |
| Decide an escalated case | `ceo` | DOA `damage.escalation` |

### 3.10 Site head

The site head capability table below lists what the `site_head` hat grants and which story delivers each row. The grants behind the live rows are `jobwork` write, `jobwork` read and `notification` read, all at the site. A user who holds `jobwork` write without the hat is refused the classification correction with `FUNCTION_ACCESS_DENIED`, and a site head is refused on a clock that belongs to another site with `LOCATION_ACCESS_DENIED`.

| Capability | site_head | Status |
|---|---|---|
| Correct a challan classification (statutory clock) | U | Live (Story 9.5) |
| Receive job-work clock and billing escalations | R | Live (Stories 9.5, 9.6) |
| Assign a standing approval | C | Story 4.8 |
| Assign a per-person self-approval limit | C | Story 4.8 |
| Revoke a grant they assigned | U | Story 4.8 |
| Approve their own grant | Not permitted | Finance department head approves (SOD-01 as amended) |

### 3.11 Item group administration

The item group administration table below lists who may grant item group rights and keep the item group notification recipient list. Only the CEO and the Finance Head (`finance_controller`) may do either; both actions are audited and notified, and a grant to a user who does not hold `inventory_controller` is refused with `GRANTEE_NOT_INVENTORY_CONTROLLER`. These routes carry no module gate because the two roles are provisioned on different modules, so the handler checks the role.

| Capability | ceo | finance_controller | inventory_controller |
|---|---|---|---|
| Grant or revoke item group rights (create, edit, delete) | C | C | - |
| Maintain item group recipient list | C | C | - |

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

**Amended 2026-09-26 (SOD-01):** no self-approval, except a requisition line within the requester's per-person self-approval limit; the limit itself is assigned by the site head or head of department and takes effect only after one-time approval by the finance department head; all self-approved requisitions remain in the audit trail. The original blanket constraint in the SOD-01 row above stands for every other DOA-resolved approval. Rationale: user ruling 2026-09-25 (senior self-approval within a limit), recorded in the UX memlog; applied by `sprint-change-proposal-2026-09-26.md` Section 4.4, delivered by Story 4.8.

**Added 2026-09-30 (Story 1.16, assignment time):** no single identity holds `site_head` together with `finance_controller`, or `site_head` together with `cfo`. Both pairs come from the 2026-09-06 ruling in section 2 (the site head holds neither finance hat) and are refused when roles are provisioned (owner ruling 2026-09-30). They keep the person who assigns a standing grant apart from the finance approver of that grant.

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
| Damage-case QC key (Story 8.9) | `qc_head` | One unbounded band, `damage.qc_concurrence`: every damage case needs the QC head's key and whole-lot decision. | DOA registry (FR-DOA-01) | pilot band, pending Super Admin review |
| Damage-case finance key (Story 8.9) | `finance_controller` | One unbounded band, `damage.finance_concurrence`: every damage case needs the finance controller's key and ERP reference. | DOA registry (FR-DOA-01) | pilot band, pending Super Admin review |
| Damage-case escalation (Story 8.9) | `ceo` | One unbounded band, `damage.escalation`: the CEO decides every case QC and finance disagree on. | DOA registry (FR-DOA-01) | pilot band, pending Super Admin review |

## 9. Changelog

| Version | Date | Change | Reviewed by |
|---|---|---|---|
| v0.1 | 2026-07-11 | Initial draft skeleton; all cells proposed defaults pending validation | Super Admin (security lead) |
| v1.0 | 2026-07-12 | Structured cross-functional review closed all seven open items in §6 (formerly §6 v0.1): cells validated (§7), DOA bands collected (§8), tolerance-breach approver split resolved (§3.2), SOD-11 adopted (§5), ~36-role owners assigned (§2), traceability audit closed (OQ7), external roles formally excluded pending trust-boundary review (§6 item 7). Document status changed from DRAFT to FINALIZED. | Department heads listed in §7; Super Admin (security lead) |
| v1.1 | 2026-09-27 | Story 1.15 (Employee Base Role): section 2 gains the `employee` base hat held by every signed-in person at their site; section 3.8 gains three capability rows (raise requisition, stock availability without quantities, own requests). Quantity, valuation and approval rows are unchanged. | Story 1.15 dev record; pending Super Admin (security lead) review |
| v1.2 | 2026-09-27 | Story 8.9 (Report Damage): section 2 gains the `ceo` role (decides escalated damage cases through DOA `damage.escalation`, site scope); section 3.8 gains "Report damage" for the employee base hat; new section 3.9 lists the damage-case capabilities (inspection, custody marks, the two DOA keys, the whole-lot decision, escalation, the ERP reference); section 8 gains the three damage DOA bands. | Story 8.9 dev record; pending Super Admin (security lead) review |
| v1.3 | 2026-09-30 | Story 1.16 (Site Head Role): section 2 gains the "Site leadership" subsection with the `site_head` role (site scope); new section 3.10 lists the site head capabilities: two live, three delivered by Story 4.8 and one not permitted; section 5 records the two assignment-time pairs that keep `site_head` apart from `finance_controller` and `cfo`. No existing row or ruling is changed. | Story 1.16 dev record; pending Super Admin (security lead) review |
| v1.4 | 2026-10-05 | Story 2.10 (Item Groups Master): section 2 gains the `store_controller` role (site scope, notifications only) and notes item group maintenance on `inventory_controller`; section 3.3 gains the item group rows (create, edit and assign, delete, ungrouped report), restricted to `inventory_controller` with a per-person right and excluding `warehouse_manager` (owner rulings 2026-10-02); new section 3.11 lists the CEO and Finance Head as the only granters of item group rights and keepers of the recipient list. No existing row or ruling is changed. | Story 2.10 dev record; pending Super Admin (security lead) review |
