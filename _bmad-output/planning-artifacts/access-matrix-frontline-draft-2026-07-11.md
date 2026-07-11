# Access Matrix — Frontline / Pilot-Slice Draft (Skeleton)

**Status:** DRAFT skeleton for the Super Admin (security lead per PRD OQ7) — every cell marked here is a *proposed default* to validate with department heads, not a decision.
**Date:** 2026-07-11
**Feeds:** Story 1.2 (RBAC configuration: module / function / location scope), Story 1.4 (DOA registry seeding), Story 1.9 (Spine Acceptance Contract tests 2 and 5).
**Due:** frontline/pilot subset before Stories 1.2 and 1.4 enter a sprint; full ~36-role matrix before Epic 12 and any post-pilot wave (PRD OQ7: "before Phase 1 detailed design").
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

`production_supervisor`, `production_planner` (Epic 6); `procurement_officer`, `tender_officer` (Epic 4/14); `rd_project_owner`, `rd_head`, `rd_store_keeper`, `hub_operator` (Epic 10); `demand_planner`, `logistics_coordinator` (Epic 15); `scrap_yard_officer`, `disposal_committee_member` (Epic 16); `fixed_asset_accountant` (Epic 17); `import_officer` (Epic 18); `tool_crib_operator` (Epic 19); `gate_pass_issuer` (Epic 20); `epr_compliance_officer`; external: `supplier_portal_user`, `auction_buyer`. **Executive/managerial read roles** (`executive`, `plant_head`) to be defined with Epic 12 dashboards.

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
| Accept out-of-tolerance load | — | — | A | — | A |
| Post GRN lines (physical receiving, Story 3.4) | — | — | C | C | R |
| Edit tolerance configuration | — | — | — | — | — (system_administrator) |

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

**Blocked-for-everyone rows (design invariants, not SoD):** calibration lockout override (FR-M-13/AD-8) · edit-log disable or hard delete (FR-AC-13/C-07) · untagged transaction (FR-AC-01) · IRN-less dispatch of e-invoiceable supply (FR-AC-14) · direct edit of a Released BOM (FR-B-03) · last-writer-wins location update (INT-LOC-01).

## 6. Open Items for the Super Admin

1. **Validate every proposed cell** with the owning department heads (the C/A/R defaults above are inferred from PRD journeys, FR text, and the 7×10 published matrix patterns — none is confirmed).
2. **Name real holders per role per pilot site** — especially which hats combine on one person at a small site, checked against SOD rows (e.g., can the weighbridge operator also be a store assistant? SOD table says nothing prevents it — confirm intent).
3. **Value bands for approval hats** → these go into the DOA registry, not this matrix; collect them in the same interviews (indent bands for department_head, transfer bands, loss-norm bands).
4. **Confirm `unloading_supervisor` vs `warehouse_manager` split** for tolerance-breach acceptance (currently both hold A).
5. **Extend to the full ~36-role set** (placeholders in §2) before Epic 12 and any post-pilot wave; add executive/read-only tiers with Epic 12.
6. **Traceability audit** (OQ7 residual): every capability row should trace to an FR/Story — rows added later must keep the Anchors column filled.
7. **External roles** (supplier portal, auction buyers) need a separate trust-boundary review — do not fold them into internal RBAC without it.
