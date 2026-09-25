# Spine Pair Review - Inventory Management System_2

## Overall verdict

The spine pair is a usable contract: tokens are complete and hex-committed, contrast targets are stated, every mock is linked and accounted for, and the decision trail to `.memlog.md` is real. Two gaps carry downstream weight: UJ-WEIGH-01 has behavioural rules but no Key Flow, and 13 [ASSUMPTION] tags remain in what is presented as a resolved contract, so a consumer cannot tell committed rules from guesses. With the weighbridge flow written, the match card given a visual spec, and the assumptions either ruled or moved to open items, this pair finalizes cleanly.

## 1. Flow coverage - adequate

Checked the four PRD user journeys (UJ-GATE-01, UJ-WEIGH-01, UJ-PUT-01, UJ-IND-01, per epics.md "UX Design Requirements", line 280, and the FR lines that realize them) against the five Key Flows in EXPERIENCE.md. UJ-GATE-01 is fully covered by "Ramesh at the gate at 6am" (named protagonist, sequenced beats, labelled climax, offline and no-QR and unlisted-supplier failure paths). UJ-PUT-01 is covered as the closing beat of "Suresh accepts a delivery" plus the Suggested rack pattern. The damage-concurrence and standing-approval flows cover the governance rules that dominate this product.

### Findings

- **high** UJ-WEIGH-01 has no Key Flow. Weighbridge capture exists only as a Component Patterns row and the "Stamp overdue" state (EXPERIENCE.md Tables 3 and 4); there is no protagonist, sequence, climax or failure walk for weigh-in, weigh-out, AUTO vs MANUAL, or a tolerance breach. It was folded in on 2026-09-26 without a flow. *Fix:* add a sixth flow (weighbridge operator, gross then tare, breach raises the exception task, offline queue as the climax or failure).
- **medium** UJ-IND-01's normal approval path has no flow. "Ramu collects cleaning gear" covers only the standing-approval bypass; raising a requisition that goes to the head of department, the approver deciding in the inbox, and the requester seeing live status (the "never chase, never raise it twice" promise in epics.md Epic 4 goal) is never walked. *Fix:* extend the Ramu flow with a non-granted line, or add a short approver-side flow.
- **medium** Flows are prose paragraphs, not numbered steps (EXPERIENCE.md Key Flows). The calibration examples number every step; numbered steps are what story-dev extracts acceptance criteria from. *Fix:* renumber each flow as an ordered list, keeping the climax marker.
- **low** Flow 5 has no named protagonist ("The site head grants and prunes"). *Fix:* name the site head as the other flows name their actors.
- **low** Flows 4 and 5 carry no failure path (over-cap fallback and offline grant attempt exist in Tables 3 and 4 but not in the flows). *Fix:* one failure sentence each.

## 2. Token completeness - strong

Extracted every frontmatter token in DESIGN.md and every `{path.to.token}` reference in the prose of both spines. All references resolve: colors (including the four preset accent families), typography roles, rounded scale, spacing scale and named targets, and all 13 component token objects referenced from EXPERIENCE.md (`{components.scan-bar}`, `{components.inbox-card}`, `{components.stepper}`, `{components.sync-badge}`, `{components.bottom-nav}`, `{components.icon-rail}`, `{components.sidebar}`, `{components.approval-class-chip}`, `{components.concurrence-keys-card}`). Every color token has a hex value; no CRITICAL misses. Contrast targets are stated for the load-bearing pairs (side-text 11.1:1, side-muted 5.5:1, text 15.3:1, text-muted 6.3:1, white on all four accents at 4.5:1, and the 3:1 non-text rationale behind `accent-on-dark`). No dark mode is declared, so light/dark pairs are not applicable; the dark sidebar is handled by dedicated `side-*` tokens.

### Findings

- **low** DESIGN.md Sidebar prose hard-codes "232px wide with 52px items and 16px labels" although `{spacing.sidebar-width-touch}`, `{spacing.nav-item-touch}` and `{typography.body-touch}` exist (DESIGN.md Components, Sidebar). *Fix:* reference the tokens; `sidebar-width-touch` is currently defined but never referenced.
- **low** Elevation values are raw ("0 -4px 12px at 6% ink", DESIGN.md Elevation & Depth) with no shadow tokens. Acceptable under the spec, but a consumer building the token layer must invent names. *Fix:* optionally add a `shadow` scale or state that shadows stay literal.

## 3. Component coverage - thin

Listed every component name used in either spine and checked for a DESIGN.md Components visual spec and an EXPERIENCE.md Table 3 behavioural spec. Both sides exist for: buttons, status pills, scan bar, inbox card, stepper, sync badge, bottom nav, icon rail, sidebar, approval-class chips, concurrence keys card. Behaviour-only rows with no visual spec: match card, supplier picker, counted-qty line, weighbridge capture, label print queue, inspect-on-opening flag, suggested rack. Of these, the last three are actions or flags that plausibly compose from existing components; the first four are drawn surfaces a builder must render.

### Findings

- **high** Match card has no visual spec. It is the primary gate feedback (the toast was removed in its favour), appears in Table 3, Interaction Primitives, Accessibility Floor and Flow 1, yet DESIGN.md Components never describes its anatomy, colors or sizing. *Fix:* add a Match card entry (surface card, accept and reject affordances, side-by-side "Scan again" and "Type challan number" at 48px, states for matched, no match, typed).
- **medium** Weighbridge capture has no visual spec: the "Trucks on site" list, weigh-in and weigh-out cards, AUTO vs MANUAL reading and the breach banner are behaviour-only (EXPERIENCE.md Table 3). *Fix:* one Components entry naming which existing primitives it composes and what is bespoke.
- **medium** Counted-qty line and supplier picker have behavioural rules but no visual rows (EXPERIENCE.md Table 3). The counted-qty line carries the tolerance-band computation and its excess message; the picker carries the "Unlisted supplier" affordance. *Fix:* add both to DESIGN.md Components or state explicitly that they compose from listed primitives.
- **medium** Scan component naming drifts: DESIGN.md says "Scan bar", EXPERIENCE.md Table 3 says "Scan sink" and separately "Scan anything bar", all apparently the same `{components.scan-bar}` in different placements. *Fix:* one name, with the stores-home pinned instance described as a placement of it.

## 4. State coverage - adequate

Walked the nine surfaces of Table 1 against Table 4 (State Patterns) and the per-surface rules of Table 5. Offline and pending sync, approval-offline, on hold, printer not ready, IRN block, empty inbox, over cap and stamp overdue are all specified with concrete treatments and exact microcopy. Empty and offline are covered generically for every surface; focus treatment lives in DESIGN.md (focus halo).

### Findings

- **medium** No permission-denied state anywhere. Module visibility derives from the access matrix (Q10), so a denied deep link or a hat switch mid-task will happen; no surface says what renders. *Fix:* one Table 4 row (plain statement of the missing permission, route home).
- **medium** Floor tasks offline behaviour is unstated. Table 4's offline row enumerates gate, stores, QC observations, requisitions and damage reports; picking, packing and dispatch are absent, and the IRN row already says the IRN check needs the network. *Fix:* state whether pick and pack capture queue offline or require connection.
- **low** No cold-load or skeleton treatment for the manager overview and other data-heavy desk surfaces. *Fix:* one row (cached tiles with age stamp, or skeleton).
- **low** Sync failure shows the `err` badge (DESIGN.md Sync badge) but no recovery behaviour (retry, surfaced where). *Fix:* one sentence in Table 4.

## 5. Visual reference coverage - strong

Listed all ten files in `.working/`: color-themes-1, key-approvals, key-desk, key-floor, key-gate-entry, key-maintenance, key-qc, key-requisitions, key-stores, key-shopfloor. Nine are linked inline: Table 1 links each surface mock and names the surface it renders, the colour board is linked from DESIGN.md Colors and EXPERIENCE.md IA, and DESIGN.md links gate-entry, stores, desk, requisitions, approvals and qc at the exact sections they illustrate. key-shopfloor is named as retired in EXPERIENCE.md IA, so no orphans. Spine-wins-on-conflict is stated once in each spine's opening paragraph. No unspecific references found.

### Findings

- **low** All links point into `.working/`; promotion to `mockups/` is a pending Finalize step and will break every link in both spines. *Fix:* rewrite paths at promotion time as one mechanical pass (11 links across the two files).

## 6. Bloat and overspecification - adequate

Both spines are lean (298 and 235 lines) and table-first. DESIGN.md prose carries editorial voice where allowed and stays behind tokens; the only pixel restatement is the sidebar (noted in category 2). The invented domain sections (Receiving and Damage Governance, Requisitions and Standing Approvals, Approvals and Delegation of Authority) carry rules that gate UI states, so they earn their place. Backend Dependencies is genuinely useful to architecture and story-dev.

### Findings

- **medium** The Resolved Questions table (EXPERIENCE.md) restates 14 rulings that are already folded into the body and recorded in `.memlog.md`. No downstream consumer extracts from it, and it will drift from the body. *Fix:* replace with one line pointing at `.memlog.md`, or delete once status goes final.
- **low** Remaining Actions is process state, not contract. *Fix:* move to `.memlog.md`.
- **low** The Device switcher row in Table 3 documents a mock-only control inside the product's behavioural contract. It is flagged "Not a product feature", but a table a consumer source-extracts should not need per-row exclusions. *Fix:* move to a mock legend or a footnote under Table 1.

## 7. Inheritance discipline - adequate

All four sources in the EXPERIENCE.md frontmatter resolve on disk (epics.md, ARCHITECTURE-SPINE.md, the access matrix draft, the PRD folder). Role names in Table 1 use the access-matrix snake_case forms, and the Backend Dependencies section correctly flags the receiving_supervisor vs unloading_supervisor gap. EXPERIENCE.md token references all resolve to DESIGN.md tokens by name. Every ruled decision traces to a `.memlog.md` entry.

### Findings

- **high** 13 [ASSUMPTION] tags remain across the pair (3 in DESIGN.md: sync badge, approval-chip colours, concurrence pill colours; 10 in EXPERIENCE.md: stepper lock, maintenance offline, lot-wide accept block, IRN block, mixed-requisition split, forward-above-band, and four Table 5 layout cells). The spine presents itself as resolved (all 14 questions ruled), so a consumer cannot tell committed contract from educated guess, and several are load-bearing (IRN block gates dispatch; the mixed-requisition split shapes the requisition data model). *Fix:* rule each one in `.memlog.md` and drop the tag, or collect them in an explicit Open Assumptions list so the contract's committed surface is unambiguous.
- **medium** The source UJ identifiers (UJ-GATE-01, UJ-WEIGH-01, UJ-PUT-01, UJ-IND-01) never appear in EXPERIENCE.md, so flows cannot be mapped to requirements without inference. *Fix:* cite the UJ id in each Key Flow heading or first line.
- **medium** Component names drift between the spines: "Scan bar" vs "Scan sink" vs "Scan anything bar", "Inbox card" vs "Task inbox", "Approval-class chips" vs "Standing approval chips". Token references keep them resolvable, but a text search on the name misses half the spec. *Fix:* pick one name per component and use it in both files.
- **low** Role name forms mix registry and prose: "department_head" vs "head of department", "site head / warehouse_manager", and the Standing approvals row uses prose-only names. *Fix:* registry name first, prose alias in parentheses.
- **low** Neither spine carries a glossary; terms (standing approval, self-approval limit, concurrence keys) are used consistently, but the identical-glossary check cannot be performed. *Fix:* optional short glossary in EXPERIENCE.md Foundation.

## 8. Shape fit - strong

DESIGN.md body sections are exactly the canonical eight in canonical order: Brand & Style, Colors, Typography, Layout & Spacing, Elevation & Depth, Shapes, Components, Do's and Don'ts. EXPERIENCE.md carries every required default: Foundation, Information Architecture, Voice and Tone, Component Patterns, State Patterns, Interaction Primitives, Accessibility Floor, Key Flows, plus Responsive and Platform (present in the shadcn example, appropriate for a four-class product). The invented domain sections earn their place as ruled behaviour; the two process sections do not (category 6).

### Findings

- **low** Resolved Questions and Remaining Actions sit after Key Flows and dilute the contract's ending; the examples end on flows. *Fix:* covered by the category 6 fixes.

## Mechanical notes

- All four frontmatter sources resolve. Note that the PRD folder's top level holds only addendum.md, reconcile-scm-requirements.md and review-rubric-walker.md; the main prd.md (where the four UJs are worked) sits in `archive/`. A consumer pointed at the folder may miss it; consider citing `archive/prd.md` explicitly.
- All `{path.to.token}` cross-references in both files resolve against DESIGN.md frontmatter; no broken token paths found. `spacing.sidebar-width-touch` is defined but never referenced.
- Name inconsistencies to normalize: Scan bar / Scan sink / Scan anything bar; Inbox card / Task inbox; Approval-class chips / Standing approval chips; department_head / head of department.
- Eleven mock links across the two spines point into `.working/` and must be rewritten when mocks are promoted to `mockups/`.
- No Mermaid blocks in either file; nothing to validate there.
- Frontmatter completeness: DESIGN.md has name, description, status, created, updated; EXPERIENCE.md has name, status, created, updated, sources. Both consistent with the examples (EXPERIENCE.md needs no description).
- key-shopfloor.html remains on disk in `.working/` although retired; harmless now, but exclude it from promotion.
