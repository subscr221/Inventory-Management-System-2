# Sprint Change Proposal - UX Finalize Backend Gaps (2026-09-26)

Status: APPROVED 2026-09-26 (user, apply all)
Author: correct-course workflow, session 2026-09-26
Trigger artifacts: `ux-designs/ux-Inventory Management System_2-2026-09-23/EXPERIENCE.md` (Backend Dependencies), run memlog, `src/compliance/indent.ts:599-603`, `src/compliance/weighbridge.ts:11`, `src/api/v1/weighbridge.ts:34`

## 1. Issue Summary

The UX redesign run finalized on 2026-09-26 committed behavioural rules that the backend does not implement. Six gaps were recorded in EXPERIENCE.md's Backend Dependencies section and the run memlog. Four are new requirements ratified with the user during design review (receiving reason codes, universal damage reporting with a commercial outcome, an employee base capability, standing approvals with self-approval limits); two are defects found while checking the mocks against code (a stuck indent when no DOA band matches, and weighbridge breach tasks routed to a role absent from the pilot roles file). None has an existing story.

Evidence per item is cited in Table 2.

## 2. Impact Analysis

### Epic impact

- Epic 3 (Warehouse Operations, status done) - reopens for two stories: GRN reason codes and the weighbridge routing defect. Story 3.4 creates QC inspection tasks but has no line condition or reason code; Story 3.3 (done) emits breach notifications to `receiving_supervisor`.
- Epic 8 (Quality Control, status done) - reopens for one story: report damage as universal capture with ad-hoc QC task, QC plus finance concurrence, and the four commercial outcomes.
- Epic 1 (Platform Foundation, in progress) - one story: employee base role. Extends Story 1.2 RBAC.
- Epic 4 (Procurement, in progress) - two stories: standing approvals (extends 4.3 approval rules), and the NOT_RESOLVED_APPROVER defect inside done Story 4.3.
- No epic is invalidated; no resequencing beyond the two reopens.

### Artifact conflicts

- PRD: FR-P-04 already promises approval rules by amount, category and department (only amount bands are built). Standing approvals, the employee base capability and the damage commercial outcome are not in the PRD; an addendum entry is proposed (Section 4.3). FR-P-07 (debit notes) is the hook for the damage outcome.
- Access matrix / compliance spine: SOD-01 (no self-approval) needs a scoped amendment: requisition self-approval is permitted within a per-person limit that the finance department head approved one time. Ruled by the user 2026-09-25.
- Access matrix: defines neither an employee base role nor `receiving_supervisor`; `unloading_supervisor` exists.
- UX spines: no conflict; the spines are the source of these changes.
- Secondary: pilot roles provisioning (item F), DOA registry (standing approval and self-approval-limit grant types).

## 3. Recommended Approach

Direct Adjustment (Option 1): add six stories under the existing epic structure, reopen Epics 3 and 8, and stage two of the six as pre-pilot blocking. Rollback is not applicable (nothing to revert) and the MVP is unchanged - these items harden pilot scope already committed in the UX contract. Effort medium, risk low, timeline impact limited to the two pre-pilot stories.

## 4. Detailed Change Proposals

### 4.1 New stories

Table 1 lists the proposed stories.

Table 1: Proposed stories

| Id | Title | Epic | Priority | Summary |
| --- | --- | --- | --- | --- |
| 3.11 | GRN line condition and reason codes | 3 (reopen) | PRE-PILOT BLOCKING | Each GRN line carries condition and a fixed grouped reason code (SHORT, DAMAGED, REJECTED wrong item or spec, OTHER with photo plus one line) on the line and the goods.received event; DAMAGED and REJECTED lines route to quarantine with a quality hold; reason reporting required at pilot; wrong item or spec never posts against the PO line |
| 3.12 | Weighbridge breach task routing for pilot roles | 3 (reopen) | PRE-PILOT BLOCKING (defect) | Tolerance breach tasks target `receiving_supervisor`, which no pilot account holds, so breaches reach nobody; route to a role present at pilot (`unloading_supervisor`) or provision the role; add a regression test that a breach reaches a real holder |
| 8.9 | Report damage: universal capture, QC task, commercial outcome | 8 (reopen) | PILOT | Any role on any device reports damage (scan lot or item, reason, photo); reported units go on hold and an ad-hoc QC task opens; "Suspect whole lot" is a request the QC head decides; QC and finance concurrence keys with CEO escalation; finance outcome is one of debit note, return for replacement, write-off, accept as-is with price reduction, recorded in IMS and executed in ERP; report and request replacement is one flow, the replacement becoming a requisition under normal rules |
| 1.15 | Employee base role | 1 | PILOT | Every signed-in employee can raise a requisition, check stock availability, report damage and see their own requests without procurement write or inventory read; menus derive from the access matrix |
| 4.8 | Standing approvals and self-approval limits | 4 | PILOT | Per-person grant (SA-YYYY-NNN) linking a user to an item or item group with optional monthly quantity cap (counts quantity issued) and end date; per-person self-approval limit; assigned by site head or head of department, effective after one-time finance department head approval; assigner revokes alone and instantly; auto-revoke same day the account is disabled; pruning lists (default every 30 days, in-app plus email, 90-day unused flag); issue screen and slip state the grant; over cap falls back to normal approval; SOD-01 amended as in Section 4.4 |
| 4.9 | Indent approver resolution fallback | 4 | Defect | An indent with no DOA band match is stored without an approver and approval then refuses NOT_RESOLVED_APPROVER, leaving it stuck (`src/compliance/indent.ts:599-603`); define and implement the fallback (route to head of department band per UX ruling Q6) and surface the state instead of a dead end |

### 4.2 Evidence map

Table 2 traces each story to its evidence.

Table 2: Story evidence

| Story | Evidence |
| --- | --- |
| 3.11 | EXPERIENCE.md Receiving and Damage Governance; memlog reason-code ruling; pre-pilot note in Backend Dependencies |
| 3.12 | `src/compliance/weighbridge.ts:11`, `src/api/v1/weighbridge.ts:34`; pilot roles hold only `unloading_supervisor`; sprint-status review note for Story 3.3 |
| 8.9 | EXPERIENCE.md damage governance and concurrence rules; Q5 ruling (four outcomes); Key Flow "A dead PCB on the line" |
| 1.15 | Backend finding: raising needs procurement write (`indents.ts:557`), stock lookup needs inventory read (`stock.ts:195`); EXPERIENCE.md IA base "employee" hat |
| 4.8 | Memlog standing-approval rulings 2026-09-25; EXPERIENCE.md Requisitions and Standing Approvals; Q6, Q7 rulings |
| 4.9 | `src/compliance/indent.ts:599-603`; memlog indent backend check |

### 4.3 PRD addendum entry (proposed)

Append to `prds/prd-Inventory Management System_2-2026-07-10/addendum.md`: receiving line reason codes (extends FR-W-02), universal damage report with QC plus finance concurrence and four commercial outcomes (hooks FR-P-07), employee base capability (raise requisition, stock availability), standing approvals and per-person self-approval limits (extends FR-P-04), each marked "ratified in UX run 2026-09-23..26".

### 4.4 SOD-01 amendment (proposed wording)

OLD: no self-approval (blanket).
NEW: no self-approval, except a requisition line within the requester's per-person self-approval limit; the limit itself is assigned by the site head or head of department and takes effect only after one-time approval by the finance department head; all self-approved requisitions remain in the audit trail.
Rationale: user ruling 2026-09-25 (senior self-approval within a limit), recorded in the UX memlog.

### 4.5 Sprint status updates (on approval)

- `epic-3`: done becomes in-progress (reopened 2026-09-26); add `3-11` and `3-12` as backlog with the priority notes in Table 1.
- `epic-8`: done becomes in-progress; add `8-9` backlog.
- `epic-1`: add `1-15` backlog.
- `epic-4`: add `4-8` and `4-9` backlog.
- Epics.md gains the six story sections under their epics.

## 5. Implementation Handoff

Scope: Moderate (backlog reorganization; no replan). Route to Developer agent via the normal story cycle: create-story, validate, dev-story, code-review per story. Sequencing: 3.11 and 3.12 first (pre-pilot blocking), then 8.9 and 1.15 and 4.8, 4.9 rides with 4.8. Success criteria: sprint-status.yaml and epics.md updated, six stories reachable by create-story, pre-pilot pair done before cutover rehearsal.
