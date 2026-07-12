# Low-Fidelity Wireframes Index

This directory contains standalone SVG wireframes for the five key screens
identified in the UX review of the Materials & Supply Chain Management
Platform. Each wireframe is a flat, low-fidelity SVG (no gradients, no
complex shadows) suitable for implementation handoff, review in a browser,
or import into a vector editor.

## Wireframe Files

Table 1 lists each wireframe file, the screen it represents, and the
`EXPERIENCE.md` section it illustrates.

| File | Screen | EXPERIENCE.md Section |
| --- | --- | --- |
| `frontline-dashboard.svg` | Gate officer role-specific dashboard with task queue | Section 2.3 (Navigation Model), Section 10 (role-specific dashboard note) |
| `scan-input-screen.svg` | Scan-first input pattern for gate event capture | Section 4.1 (Scan Input Pattern) |
| `approval-card-queue.svg` | Indent approval workflow, stacked card queue | Section 4.2 (Approval and Decision Workflows) |
| `sync-state-badge.svg` | All four sync states shown in header context | Section 5.1 (Offline-First State Machine) |
| `locator-override-modal.svg` | Putaway location mismatch conflict resolution modal | Section 4.4 (Locator Override) |

See Table 1 above for the full file-to-section mapping.

## Wireframe Descriptions

### 1. Frontline Dashboard (`frontline-dashboard.svg`)

Shows the gate officer's role-specific dashboard: a header bar with app
name, sync badge, and user avatar; a left sidebar with the six primary
navigation categories (Dashboard, Frontline, Inventory, Procurement,
Operations, Admin); and a main content area with three task queue cards
(PO number, status badge, vehicle info, action buttons). A dashed empty
state hint at the bottom communicates that the queue is short and new
events will appear automatically.

### 2. Scan Input Screen (`scan-input-screen.svg`)

Implements the scan-first input pattern from `EXPERIENCE.md` section 4.1:
a full-screen tablet layout dominated by a large 56px scan field with
autofocus styling, three recent-scan quick-tap buttons below it, and
fallback options (`Can't Scan?`, `Enter Manually`) at the bottom. The sync
badge appears in the header, showing the "Captured, pending sync" state.

### 3. Approval Card Queue (`approval-card-queue.svg`)

Two approval cards stacked vertically, each showing indent number, raised
by, department, amount, line items, and reason, matching the card pattern
from `EXPERIENCE.md` section 4.2. Each card carries a "Awaiting Store
Manager" status badge, the approver name, and delegation status, plus
primary (`Approve`) and secondary (`Request More Info`) action buttons.

### 4. Sync State Badge (`sync-state-badge.svg`)

Four header bars stacked vertically, one per sync state defined in
`EXPERIENCE.md` section 5.1: Online (green), Captured/Offline (yellow),
Syncing (blue, with a spinner glyph), and Sync Error (red, with a
`Retry` button). Each header bar shows the badge in context alongside
navigation and the user avatar, plus a notes panel summarizing the state
transitions.

### 5. Locator Override Modal (`locator-override-modal.svg`)

A modal overlay on a dimmed tablet background, illustrating the putaway
conflict resolution flow from `EXPERIENCE.md` section 4.4. It shows the
expected location (`BIN-A47`) next to the scanned location (`BIN-A43`), a
warning banner for the mismatch, four reason-code radio options
(Accessibility, Wrong Pick, Better Access, Inventory Error), a
Certain and Uncertain confidence selector, and `Confirm Override` and
`Rescan` action buttons.

## Design Tokens Used

All wireframes draw their values from `DESIGN.md`, the canonical token
source. Table 2 summarizes the tokens applied.

| Token Category | Values Used | Source in DESIGN.md |
| --- | --- | --- |
| Primary color | `#1f47d9` (buttons, focus states, active nav) | Colors, primary.600 |
| Neutral grays | `#f8f9fa` through `#1f2937` (backgrounds, borders, text) | Colors, neutral scale |
| Semantic: success | `#10b981` (Online badge, Approved status) | Colors, semantic.success |
| Semantic: warning | `#f59e0b` (Captured/pending badge, mismatch warning) | Colors, semantic.warning |
| Semantic: error | `#ef4444` (Sync Error badge, scanned-location mismatch) | Colors, semantic.error |
| Semantic: info | `#3b82f6` (Syncing badge) | Colors, semantic.info |
| Pending | `#8b5cf6` (Awaiting Store Manager badge) | Colors, semantic.pending |
| Typography | `system-ui, -apple-system, 'Segoe UI', sans-serif` | Typography, font_family |
| Spacing | 4px, 8px, 16px, 24px, 32px | Spacing scale (xs, sm, md, lg, xl) |
| Border radius | 4px (buttons, badges), 8px (cards), 12px (modal) | Rounded scale (sm, md, lg) |
| Layout | `viewBox="0 0 1024 768"` (tablet landscape) | Layout, lg breakpoint (1024px) |

See Table 2 above for the token-to-source mapping.

## Fidelity and Scope Notes

All five files are intentionally low-fidelity: flat shapes, simple
borders, no gradients, and gray placeholder boxes where a photo or image
would appear (for example, a challan photo capture step is out of scope
for these five screens and was not requested). Text labels are present
throughout so the wireframes remain readable without a design tool.

## Open Questions

- Role-specific dashboard templates beyond the gate officer view (for
  example, production supervisor, procurement officer) are deferred per
  `EXPERIENCE.md` section 10, and are not covered by this wireframe set.
- Reason codes shown in the locator override modal are illustrative;
  `EXPERIENCE.md` section 4.4 notes these are configurable and not
  dictated by `DESIGN.md`.
- Dark mode variants are not included in this wireframe set; `DESIGN.md`
  section 10 describes the token swap but no dark-mode wireframe was
  requested.

## Dependencies on Other Agents' Work

- Any change to the color, spacing, or radius tokens in `DESIGN.md`
  should be reflected back into these wireframes before frontend
  implementation begins.
- The approval and locator-override interaction details depend on the
  workflows documented in `EXPERIENCE.md` sections 4.2 and 4.4; if those
  sections change, the corresponding wireframe should be revised.
- These SVGs are a handoff artifact only; no Figma file exists for this
  project, so the frontend team should treat these SVGs as the
  authoritative low-fidelity reference until a higher-fidelity mockup is
  produced.
