# Validation Report - Inventory Management System_2

- **DESIGN.md:** `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/DESIGN.md`
- **EXPERIENCE.md:** `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/EXPERIENCE.md`
- **Run at:** 2026-09-26T02:38:55

## Overall verdict

The spine pair is a usable contract: tokens are complete and hex-committed, contrast targets are stated, every mock is linked and accounted for, and the decision trail to `.memlog.md` is real. Two gaps carry downstream weight: UJ-WEIGH-01 has behavioural rules but no Key Flow, and 13 [ASSUMPTION] tags remain in what is presented as a resolved contract, so a consumer cannot tell committed rules from guesses. With the weighbridge flow written, the match card given a visual spec, and the assumptions either ruled or moved to open items, this pair finalizes cleanly.

## Category verdicts

- Flow coverage - adequate
- Token completeness - strong
- Component coverage - thin
- State coverage - adequate
- Visual reference coverage - strong
- Bloat and overspecification - adequate
- Inheritance discipline - adequate
- Shape fit - strong

## Findings by severity

### Critical (0)

No critical findings.

### High (3)

**[Flow coverage]** - UJ-WEIGH-01 has no Key Flow (§ EXPERIENCE.md Tables 3 and 4)
Weighbridge capture exists only as a Component Patterns row and the "Stamp overdue" state; there is no protagonist, sequence, climax or failure walk for weigh-in, weigh-out, AUTO vs MANUAL, or a tolerance breach. It was folded in on 2026-09-26 without a flow.
Fix: add a sixth flow (weighbridge operator, gross then tare, breach raises the exception task, offline queue as the climax or failure).

**[Component coverage]** - Match card has no visual spec (§ DESIGN.md Components; EXPERIENCE.md Table 3, Flow 1)
It is the primary gate feedback (the toast was removed in its favour), appears in Table 3, Interaction Primitives, Accessibility Floor and Flow 1, yet DESIGN.md Components never describes its anatomy, colors or sizing.
Fix: add a Match card entry (surface card, accept and reject affordances, side-by-side "Scan again" and "Type challan number" at 48px, states for matched, no match, typed).

**[Inheritance discipline]** - 13 [ASSUMPTION] tags remain across the pair (§ DESIGN.md, EXPERIENCE.md)
3 in DESIGN.md: sync badge, approval-chip colours, concurrence pill colours; 10 in EXPERIENCE.md: stepper lock, maintenance offline, lot-wide accept block, IRN block, mixed-requisition split, forward-above-band, and four Table 5 layout cells. The spine presents itself as resolved (all 14 questions ruled), so a consumer cannot tell committed contract from educated guess, and several are load-bearing (IRN block gates dispatch; the mixed-requisition split shapes the requisition data model).
Fix: rule each one in `.memlog.md` and drop the tag, or collect them in an explicit Open Assumptions list so the contract's committed surface is unambiguous.

### Medium (10)

**[Flow coverage]** - UJ-IND-01's normal approval path has no flow (§ EXPERIENCE.md Key Flows)
"Ramu collects cleaning gear" covers only the standing-approval bypass; raising a requisition that goes to the head of department, the approver deciding in the inbox, and the requester seeing live status (the "never chase, never raise it twice" promise in epics.md Epic 4 goal) is never walked.
Fix: extend the Ramu flow with a non-granted line, or add a short approver-side flow.

**[Flow coverage]** - Flows are prose paragraphs, not numbered steps (§ EXPERIENCE.md Key Flows)
The calibration examples number every step; numbered steps are what story-dev extracts acceptance criteria from.
Fix: renumber each flow as an ordered list, keeping the climax marker.

**[Component coverage]** - Weighbridge capture has no visual spec (§ EXPERIENCE.md Table 3)
The "Trucks on site" list, weigh-in and weigh-out cards, AUTO vs MANUAL reading and the breach banner are behaviour-only.
Fix: one Components entry naming which existing primitives it composes and what is bespoke.

**[Component coverage]** - Counted-qty line and supplier picker have behavioural rules but no visual rows (§ EXPERIENCE.md Table 3)
The counted-qty line carries the tolerance-band computation and its excess message; the picker carries the "Unlisted supplier" affordance.
Fix: add both to DESIGN.md Components or state explicitly that they compose from listed primitives.

**[Component coverage]** - Scan component naming drifts (§ DESIGN.md Components; EXPERIENCE.md Table 3)
DESIGN.md says "Scan bar", EXPERIENCE.md Table 3 says "Scan sink" and separately "Scan anything bar", all apparently the same `{components.scan-bar}` in different placements.
Fix: one name, with the stores-home pinned instance described as a placement of it.

**[State coverage]** - No permission-denied state anywhere (§ EXPERIENCE.md Table 4)
Module visibility derives from the access matrix (Q10), so a denied deep link or a hat switch mid-task will happen; no surface says what renders.
Fix: one Table 4 row (plain statement of the missing permission, route home).

**[State coverage]** - Floor tasks offline behaviour is unstated (§ EXPERIENCE.md Table 4, offline row)
Table 4's offline row enumerates gate, stores, QC observations, requisitions and damage reports; picking, packing and dispatch are absent, and the IRN row already says the IRN check needs the network.
Fix: state whether pick and pack capture queue offline or require connection.

**[Bloat and overspecification]** - The Resolved Questions table restates 14 rulings already folded into the body (§ EXPERIENCE.md Resolved Questions)
The rulings are already folded into the body and recorded in `.memlog.md`. No downstream consumer extracts from it, and it will drift from the body.
Fix: replace with one line pointing at `.memlog.md`, or delete once status goes final.

**[Inheritance discipline]** - The source UJ identifiers never appear in EXPERIENCE.md (§ EXPERIENCE.md Key Flows)
UJ-GATE-01, UJ-WEIGH-01, UJ-PUT-01 and UJ-IND-01 never appear, so flows cannot be mapped to requirements without inference.
Fix: cite the UJ id in each Key Flow heading or first line.

**[Inheritance discipline]** - Component names drift between the spines (§ both spines)
"Scan bar" vs "Scan sink" vs "Scan anything bar", "Inbox card" vs "Task inbox", "Approval-class chips" vs "Standing approval chips". Token references keep them resolvable, but a text search on the name misses half the spec.
Fix: pick one name per component and use it in both files.

### Low (12)

**[Flow coverage]** - Flow 5 has no named protagonist (§ EXPERIENCE.md Key Flow 5)
"The site head grants and prunes" names no actor.
Fix: name the site head as the other flows name their actors.

**[Flow coverage]** - Flows 4 and 5 carry no failure path (§ EXPERIENCE.md Key Flows 4 and 5)
Over-cap fallback and offline grant attempt exist in Tables 3 and 4 but not in the flows.
Fix: one failure sentence each.

**[Token completeness]** - Sidebar prose hard-codes pixel values that tokens already cover (§ DESIGN.md Components, Sidebar)
Sidebar prose hard-codes "232px wide with 52px items and 16px labels" although `{spacing.sidebar-width-touch}`, `{spacing.nav-item-touch}` and `{typography.body-touch}` exist.
Fix: reference the tokens; `sidebar-width-touch` is currently defined but never referenced.

**[Token completeness]** - Elevation values are raw with no shadow tokens (§ DESIGN.md Elevation and Depth)
Elevation values are raw ("0 -4px 12px at 6% ink"). Acceptable under the spec, but a consumer building the token layer must invent names.
Fix: optionally add a `shadow` scale or state that shadows stay literal.

**[State coverage]** - No cold-load or skeleton treatment for data-heavy desk surfaces (§ EXPERIENCE.md Table 4)
The manager overview and other data-heavy desk surfaces have no cold-load treatment.
Fix: one row (cached tiles with age stamp, or skeleton).

**[State coverage]** - Sync failure shows the `err` badge but no recovery behaviour (§ DESIGN.md Sync badge; EXPERIENCE.md Table 4)
Sync failure shows the `err` badge but no recovery behaviour (retry, surfaced where).
Fix: one sentence in Table 4.

**[Visual reference coverage]** - All links point into `.working/`; promotion will break them (§ both spines, 11 links)
Promotion to `mockups/` is a pending Finalize step and will break every link in both spines.
Fix: rewrite paths at promotion time as one mechanical pass (11 links across the two files).

**[Bloat and overspecification]** - Remaining Actions is process state, not contract (§ EXPERIENCE.md Remaining Actions)
Process state does not belong in the contract document.
Fix: move to `.memlog.md`.

**[Bloat and overspecification]** - The Device switcher row documents a mock-only control (§ EXPERIENCE.md Table 3)
It is flagged "Not a product feature", but a table a consumer source-extracts should not need per-row exclusions.
Fix: move to a mock legend or a footnote under Table 1.

**[Inheritance discipline]** - Role name forms mix registry and prose (§ EXPERIENCE.md tables)
"department_head" vs "head of department", "site head / warehouse_manager", and the Standing approvals row uses prose-only names.
Fix: registry name first, prose alias in parentheses.

**[Inheritance discipline]** - Neither spine carries a glossary (§ EXPERIENCE.md Foundation)
Terms (standing approval, self-approval limit, concurrence keys) are used consistently, but the identical-glossary check cannot be performed.
Fix: optional short glossary in EXPERIENCE.md Foundation.

**[Shape fit]** - Resolved Questions and Remaining Actions dilute the contract's ending (§ EXPERIENCE.md, after Key Flows)
They sit after Key Flows; the examples end on flows.
Fix: covered by the Bloat and overspecification fixes.

## Mechanical notes

- All four frontmatter sources resolve. The PRD folder's top level holds only addendum.md, reconcile-scm-requirements.md and review-rubric-walker.md; the main prd.md (where the four UJs are worked) sits in `archive/`. A consumer pointed at the folder may miss it; consider citing `archive/prd.md` explicitly.
- All `{path.to.token}` cross-references in both files resolve against DESIGN.md frontmatter; no broken token paths found. `spacing.sidebar-width-touch` is defined but never referenced.
- Name inconsistencies to normalize: Scan bar / Scan sink / Scan anything bar; Inbox card / Task inbox; Approval-class chips / Standing approval chips; department_head / head of department.
- Eleven mock links across the two spines point into `.working/` and must be rewritten when mocks are promoted to `mockups/`.
- No Mermaid blocks in either file; nothing to validate there.
- Frontmatter completeness: DESIGN.md has name, description, status, created, updated; EXPERIENCE.md has name, status, created, updated, sources. Both consistent with the examples (EXPERIENCE.md needs no description).
- key-shopfloor.html remains on disk in `.working/` although retired; harmless now, but exclude it from promotion.

## Reviewer files

- `review-rubric.md`
