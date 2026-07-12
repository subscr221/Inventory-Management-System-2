---
title: Materials & Supply Chain Management Platform — User Experience Specification
project: Inventory Management System_2
status: draft
created: 2026-07-12
updated: 2026-07-12
revision_note: "Added navigation specification (2.3), sync badge header standardization (5.1), and journeys 8.5-8.6"
form_factor: [desktop, tablet]
ui_system: Internal (custom, no design-system dependency)
interaction_model: Scan-first, forms-secondary, glove-friendly, one-handed
sync_model: Offline-first with PowerSync
accessibility_standard: WCAG 2.1 AA

---

# User Experience Specification

## 1. Foundation

### 1.1 Form Factor and Deployment Context

**Primary:** 7–10" rugged tablets (iPad Mini, Android enterprise tablets) in warehouse, gate, and hub environments.  
**Secondary:** Desktop and laptop for supervisory, planning, and administrative functions.  
**Tertiary:** Responsive mobile web on personal phones (not officially supported, but must not crash).

**Network assumption:** Frontline operates offline-first. Central control plane (approvals, order closure, dispatch) requires network, with graceful 5-second lag accepted per architecture (NFR-DI-03).

### 1.2 UI System Inheritance

No external design-system library is used. DESIGN.md tokens are the canonical source for colors, typography, spacing, and components. Implementation: React + TailwindCSS with custom theme configuration pointing directly to DESIGN.md token values.

### 1.3 Interaction Model

**Scanning is the primary input method.** Every moment-of-use workflow begins with a barcode, QR, or RFID scan. Keyboard entry is secondary, used only for corrections or when a scan is unavailable.

**One-handed operation on tablet:** All touch targets are 44×44px minimum. Buttons and fields are positioned within thumb reach (bottom two-thirds of a vertically-held tablet).

**Glove-friendly:** Touch targets are spaced at least 8px apart (sm spacing minimum). No small gestures (pinch, long-press on first attempt). Swipe is used only for optional navigation.

---

## 2. Information Architecture

### 2.1 Primary Workflows (by role)

The system serves six frontline role families and three supervisory/administrative families:

**Frontline (mobile/tablet-first):**
1. **Gate Officer** — Vehicle arrival, PO/challan binding, gate event capture
2. **Weighbridge Operator** — Truck tare/gross, weight capture, tolerance validation
3. **Warehouse Assistant (Receiving)** — Goods receipt, lot/serial capture, QC-hold gate
4. **Warehouse Assistant (Putaway)** — Location assignment, directed putaway, locator overrides
5. **Indent Raiser / Floor Supervisor** — Requisition capture, approval polling, status tracking
6. **Tool Crib / Hub Operator** — Custody issue/return, point-of-use sales, member booking

**Supervisory (desktop/tablet mixed):**
1. **Store Manager / Warehouse Supervisor** — Approve indents, release putaway, QC oversight
2. **QC Inspector / Head** — Disposition batches, CoA/CoC generation, quality holds
3. **Production Supervisor** — Production-order release/closure, scrap recording

**Administrative (desktop):**
1. **Procurement Officer** — Supplier registry, PO creation, three-way matching
2. **Finance Controller** — Period close, reconciliation, budget availability
3. **System Administrator** — User provisioning, DOA registry, configuration

### 2.2 Information Architecture Map

```
App Root
├─ Authentication & SSO Gate
├─ Dashboard (role-specific)
│   ├─ Frontline Edge
│   │   ├─ Gate Flow (UJ-GATE-01)
│   │   ├─ Weighbridge Flow (UJ-WEIGH-01)
│   │   ├─ Putaway / Locator (UJ-PUT-01)
│   │   ├─ Indent / Requisition (UJ-IND-01)
│   │   └─ Task Queue (by location, priority)
│   ├─ Supervisory
│   │   ├─ Approvals (pending actions)
│   │   ├─ Stock Status (by location)
│   │   ├─ Order Release
│   │   └─ QC Gate & Disposition
│   └─ Admin
│       ├─ User & Role Management
│       ├─ DOA Registry Configuration
│       └─ System Settings
├─ Modules (by function)
│   ├─ Inventory (stock visibility, transfers, adjustments)
│   ├─ Warehouse (receiving, putaway, picking, shipping)
│   ├─ Procurement (indents, POs, three-way match)
│   ├─ Maintenance (asset register, PM schedules, faults)
│   ├─ Quality (inspection plans, batch release, CoA/CoC)
│   ├─ Production (order release, issue, completion, closure)
│   ├─ R&D & Hub (project issues, hub sales, member bookings)
│   ├─ Job-Work (customer orders, custody ledger, dispatch)
│   ├─ Reports (dashboards, exception alerts, ad-hoc)
│   └─ Admin (configuration, integrations, audit log)
└─ Offline State Indicator
    └─ "Captured, pending sync" badge with sync action
```

Each module contains role-scoped read views and action workflows. Deep linking is used for task queues (gate event, pending approval, etc.).

### 2.3 Navigation Model

This section reconciles the "5-7 primary categories" referenced informally elsewhere in this document with the 10+ modules shown in the section 2.2 information architecture map. The sidebar is fixed at exactly **six** primary items; every module from section 2.2 is grouped under one of the six. No module is orphaned and no category is left undefined.

#### 2.3.1 Primary Sidebar Specification

**Tab Bar (primary, always visible):**
Tablet/desktop: persistent left sidebar with six primary categories, each carrying an icon, a label, and (where relevant) a badge count. Active item is highlighted with a primary-color left border, a tinted background, and a bolded label (see section 2.3.3).

The table below is the canonical navigation specification. It is the single source of truth for sidebar structure; DESIGN.md section 2.3 and any future navigation component implementation must match it.

| Order | Sidebar Item | Icon (Lucide) | Modules Grouped Under This Item | Badge Count Behavior | Roles Who See It |
| --- | --- | --- | --- | --- | --- |
| 1 | Dashboard | `LayoutDashboard` | Role-specific home overview; task queue summary; recent activity | None (no badge; dashboard is the badge-free landing point) | All roles |
| 2 | Frontline | `Truck` | Gate Flow, Weighbridge, Receiving, Putaway / Locator, Task Queue | Count of open tasks assigned to the current user at this location | Gate Officer, Weighbridge Operator, Warehouse Assistant (Receiving, Putaway), Warehouse Supervisor |
| 3 | Inventory | `Package` | Stock Visibility, Transfers, Adjustments, Warehouse (layout, picking, shipping) | Count of open stock exceptions (negative stock, unresolved adjustments) | Warehouse Supervisor, Store Manager, Inventory Analyst, System Administrator |
| 4 | Procurement | `ShoppingCart` | Indents / Requisitions, Purchase Orders, Three-Way Match, Supplier Registry | Count of items awaiting the current user's action (pending indent approvals, pending three-way match exceptions) | Indent Raiser, Store Manager, Procurement Officer, Finance Controller |
| 5 | Operations | `Factory` | Production (order release, issue, completion, closure), Quality (inspection plans, batch release, CoA/CoC), Maintenance (asset register, PM schedules, faults), Job-Work (customer orders, custody ledger, dispatch), R&D & Hub (project issues, hub sales, member bookings) | Count of pending QC dispositions plus overdue maintenance faults, combined into one number with a tooltip breakdown | Production Supervisor, QC Inspector / Head, Maintenance Technician, Tool Crib / Hub Operator |
| 6 | Admin | `Settings` | User & Role Management, DOA Registry Configuration, System Configuration, Audit Log, Reports | Count of pending user-provisioning requests | System Administrator, Finance Controller (Reports only, read-scoped) |

Roles that do not have any content within a given category never see that sidebar item; the sidebar renders only the categories relevant to the signed-in user's role (for example, a Gate Officer sees Dashboard and Frontline, not Procurement or Admin).

#### 2.3.2 Secondary Navigation

**Expanded sidebar:** Each primary item expands as an accordion. Tapping or clicking the primary item toggles its sub-item list open or closed in place, pushing items below it down (no overlay). Only one accordion section is open at a time by default, to keep the list scannable; a user preference can allow multiple sections open simultaneously.

**Collapsed sidebar (icons only):** When the user collapses the sidebar (toggle button at the bottom of the sidebar), each primary item renders as a 44x44px icon with no label. Sub-items are not visible inline. Hovering (desktop) or tapping (tablet) a collapsed icon opens a flyout panel to the right of the icon, listing that item's sub-items; clicking a sub-item navigates and closes the flyout. Collapsed state is remembered per user (local storage / user preference), not per session.

**Mobile (if needed):** Bottom tab bar with 4 icons (Dashboard, Scan, Task Queue, Account). The full six-item sidebar model does not apply to mobile; mobile is a reduced, task-focused surface (see section 9.3).

#### 2.3.3 Active State Styling

- **Active primary item:** 3px primary-color left border, tinted background (10% primary-color opacity), bold label, icon rendered in primary color.
- **Active sub-item:** Tinted background only (no left border, to keep the visual hierarchy subordinate to the primary item), label in primary color, no bold.
- **Hover/focus (not active):** Light neutral background tint, no color change to icon or label, to keep active state visually distinct from hover.
- **Badge on active item:** Badge count remains visible even when the item is active, so the user can see remaining work while inside that section.

**Header (secondary):**
Breadcrumb trail shows current location using a right-caret separator, for example: Dashboard / Warehouse / Receiving / [PO-2026-1234]. Back button provides one-level navigation.

**Context Menu (tertiary):**
Right-side panel or dropdown shows filters (by location, status, date) and view toggles (list / cards / map for warehouse layout).

---

## 3. Voice and Tone

### 3.1 Microcopy Principles

- **Action-first:** Labels begin with a verb. "Approve Indent" not "Approval". "Capture Weight" not "Weight Capture".
- **No jargon unless domain-specific:** "Gate event captured" not "inbound vehicular transaction commenced". "Warehouse block" not "storage classification".
- **Error messages are actionable:** "Weight out of tolerance (±5%) — enter again or call supervisor" not "Validation failed".
- **Confirmations are explicit:** "Gate event QM-2026-0847 captured, pending sync. Vehicle binding updated. Proceed to receiving?" not "OK, saved".
- **Warnings are honest:** "Network unavailable. Working offline — synced automatically when connected. No data loss." not "Error 503".
- **Feedback is immediate:** "Indent approved, submitted to procurement. Status updates via push notification." Avoid "processing..." without timeout.

### 3.2 Tone by Context

| Context | Tone | Example |
| --- | --- | --- |
| **Frontline capture** | Direct, confirmatory | "Lot [QZ-4421] captured. What's next?" |
| **Approval workflows** | Professional, evidenced | "Approver: Rajesh Patel (Warehouse Manager). Reason: Safety stock threshold met." |
| **Compliance & blocking** | Formal, explainable | "Dispatch blocked: QC Hold on lot QZ-4421. Release decision pending inspection plan IS-2500 results." |
| **Offline mode** | Transparent, reassuring | "Captured, pending sync. All data saved locally. Will sync when online." |
| **Error & recovery** | Empathetic, next-step focused | "That PO isn't here yet. Double-check the number or contact procurement." |
| **Success** | Celebratory (modest) | "Gate event captured! Proceeding to receiving." |

### 3.3 Language Support

All UI strings are externalized (i18n). English is the default; regional language support (Hindi, Tamil, Telugu, Kannada) is deferred to Phase 2. Placeholder text shows locale awareness: dates as DD-MMM-YYYY (02-Jul-2026), currency in INR with ₹ symbol.

---

## 4. Component Patterns (Behavioral)

### 4.1 Scan Input Pattern

**Trigger:** Every task begins with a scan field.

```
┌────────────────────────────────┐
│ GATE EVENT CAPTURE             │
├────────────────────────────────┤
│ Scan Vehicle / PO Number       │
│ [▌                          ×] │  ← 56px tall, autofocus, no visible cursor
├────────────────────────────────┤
│                                │
│ Recent: QM-2026-0845           │  ← 3 recent scans, tap to reuse
│         QM-2026-0844           │
│         PO-2026-0900           │
│                                │
├────────────────────────────────┤
│ [Can't Scan?] [Enter Manually] │  ← optional fallback
└────────────────────────────────┘
```

**Behavior:**
- Autofocus on mount; cursor invisible
- Typed/scanned value appears in field as you enter
- On Enter or after 5-digit minimum, trigger lookup
- Lookup failure shows inline error with suggestions (e.g., "No PO found. Did you mean QM-2026-0844?")
- Success transitions to the next form (e.g., scan → gate details → confirm)
- Recent scans shown as quick-tap buttons below the field

### 4.2 Approval & Decision Workflows

**Pattern:** Every approval is a card showing who, what, and why.

```
┌──────────────────────────────────┐
│ INDENT APPROVAL NEEDED           │
│ Status: Awaiting Store Manager   │
├──────────────────────────────────┤
│ Indent: IND-2026-0456            │
│ Raised by: Avi Singh (Prod Supr) │
│ Department: Electronics          │
│ Amount: ₹1,23,000 (Budget avail) │
├──────────────────────────────────┤
│ Reason: Production readiness     │
│ Parts: (3 line items)            │
│   □ Motor 5kW [20 units] 45k     │
│   □ Servo Valve [15 units] 35k   │
│   □ Sensor [100 units] 43k       │
├──────────────────────────────────┤
│ Approval Required By: 02-Jul     │
│ Approver: Rajesh Patel           │
│ Delegation: None active          │
├──────────────────────────────────┤
│ [Approve]     [Request More Info]│  ← Primary and secondary actions
└──────────────────────────────────┘
```

**Approval action flow:**
1. Tap [Approve] → modal opens
2. Modal shows reason field (optional): "Why approved?" (for the audit trail)
3. Tap [Confirm Approval] → event posted, API call to central
4. Success: card disappears from queue; notification sent to raiser ("Approved by Rajesh Patel")
5. On network error: card persists locally; sync badge shows "Sync Pending"; user sees [Retry Sync]

**Rejection flow:**
1. Tap [Request More Info] or similar → reason field required (rejection must be evidenced)
2. Tap [Reject] → event posted
3. Raiser gets notification with reason and option to revise

### 4.3 Status Polling

**Pattern:** Frontline user submits an action and polls for status without navigating.

```
After submitting Indent IND-2026-0456:

┌─────────────────────────────────┐
│ INDENT STATUS                   │
│ IND-2026-0456                   │
├─────────────────────────────────┤
│ Status: [Approved] ✓            │  ← Green badge, updated 2min ago
│ Approved by: Rajesh Patel       │
│ Approved at: 02-Jul 10:45       │
│                                 │
│ Expected PO delivery: 05-Jul    │  ← Auto-updated from ERP feed
│ Supplier: Electronica Ltd       │
│                                 │
├─────────────────────────────────┤
│ [< Back to Indent Queue]        │
└─────────────────────────────────┘
```

**Behavior:**
- Status auto-refreshes every 10 seconds (small pill indicator "Updating...")
- Push notification when status changes (opt-in)
- No manual refresh needed
- Back button returns to queue/list view

### 4.4 Locator Override (Putaway Conflict Resolution)

**Pattern:** Directed putaway expects BIN-A47; operator places stock in BIN-A43. System surfaces the discrepancy and records it.

```
┌────────────────────────────────────┐
│ PUTAWAY CONFIRMATION               │
│ Lot: QZ-4421                       │
│ Item: Motor 5kW                    │
│ Qty: 20 units                      │
├────────────────────────────────────┤
│ Expected Location: BIN-A47         │
│ Scanned Location: BIN-A43          │ ← Difference detected
│                                    │
│ ⚠ Location Mismatch Detected       │
│ Why did you put it here?           │
│ [Accessibility] [Wrong Pick]       │ ← Reason code
│ [Better Access] [Inventory Error]  │ ← user selects one
│                                    │
│ Confidence: [Certain] [Uncertain]  │ ← trust signal
│                                    │
├────────────────────────────────────┤
│ [Confirm Override]   [Rescan]      │
└────────────────────────────────────┘
```

**Behavior:**
- Mismatch detected via location lookup (expected from ASN/putaway plan vs. scanned)
- Reason codes are configurable (DESIGN.md does not dictate these; they live in configuration)
- Confidence rating (certain/uncertain) is captured and feeds algorithm for ABC slotting re-training
- On confirm: location-disputed event is posted; expected location is preserved in the log
- Operator's reason contributes to override pattern learning (NFR-ADOPT-01: feedback loop)

---

## 5. State Patterns

### 5.1 Offline-First State Machine

**[NOTE] Sync badge placement standardization:** The sync state badge described below appears in the **app header** on every screen, not the footer and not floating loosely at the top of an individual form. Placement is standardized to the header for three reasons: (1) the header is always visible regardless of scroll position, so the badge cannot scroll off-screen on long forms; (2) the header sits above the primary content, giving the badge maximum glanceability without the user hunting for it; (3) a single, consistent placement across every screen avoids the ambiguity that comes from having some screens show it at the top and others at the bottom.

**[CROSS-DOCUMENT DEPENDENCY]** DESIGN.md section 2.3 ("Sync State Indicators") currently states the badge appears in a "footer badge" and DESIGN.md's Do's list says "Show sync state in every screen footer." Both statements conflict with the header placement defined here and need to be updated in DESIGN.md to say "header" instead of "footer." This document (EXPERIENCE.md) is the source of truth for the header decision; DESIGN.md is being edited by another agent and was not modified by this change.

Every screen in a frontline flow follows this state model:

```
┌─────────────┐
│   ONLINE    │  App launched with network
│ (connected) │
└──────┬──────┘
       │ Network lost
       ▼
┌─────────────────────┐
│ OFFLINE (captured)  │  Device continues; events queue locally
│  pending sync       │  Badge: "Captured, pending sync" (yellow)
└──────┬──────────────┘
       │ Network restored
       ▼
┌─────────────────┐
│ SYNCING         │  Central processes queued events
│ (in progress)   │  Badge: "Syncing..." (blue spinner)
└──────┬──────────┘
       │ Sync OK
       ├──────────────────► ┌─────────────┐
       │                    │   ONLINE    │
       │                    │ (synced)    │
       │                    └─────────────┘
       │ Sync fails
       ▼
┌──────────────────┐
│ SYNC ERROR       │  Last sync attempt failed
│ (needs retry)    │  Badge: "Sync Error" (red)
└──────┬───────────┘  User can [Retry Sync]
       │ Retry OK
       └──────────────────► ┌─────────────┐
                            │   ONLINE    │
                            │ (synced)    │
                            └─────────────┘
```

**UI indicators per state (all rendered in the app header, per the placement standardization above):**
- **ONLINE (connected):** Header badge shows "Online" (green). API latency low, mutations immediate.
- **OFFLINE (captured):** Header badge shows "Captured, pending sync" (yellow). User continues work. No error indication; expected path.
- **SYNCING:** Header badge shows "Syncing..." with spinner (blue). User can continue; data persists locally.
- **SYNC ERROR:** Header badge shows "Sync Error" with [Retry] button (red). User notified of issue; must retry or contact support.

### 5.2 Approval Workflow States

```
┌─────────────┐
│   RAISED    │  Indent created by floor supervisor
└──────┬──────┘
       │ Store manager approves (or rejects)
       ▼
┌──────────────┐
│   APPROVED   │  Can proceed to PO creation (Epic 4)
│   REJECTED   │  Bounces back with reason; can revise
└──────┬───────┘
       │ (if Approved)
       ▼
┌──────────────┐
│   ORDERED    │  PO issued by procurement
│   (pending)  │  ERP sync confirms
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  RECEIVED    │  Goods receipt posted in Epic 3
│  (fulfilled) │
└──────────────┘
```

Each state change is logged in the edit log with actor, timestamp, and reason.

### 5.3 QC Disposition States

```
┌──────────────┐
│   QC HOLD    │  Finished goods lot enters inspection
│  (captured)  │  assigned inspection plan
└──────┬───────┘
       │ Inspector executes plan
       ▼
┌──────────────┐
│  INSPECTED   │  Result recorded, outcome pending
│  (recorded)  │  calibration-lock validated
└──────┬───────┘
       │ Inspector decides
       ├─ Accept ───────────┐
       ├─ Reject ───────────┤
       └─ Conditional ──────┤
                            ▼
                    ┌──────────────────┐
                    │    RELEASED      │
                    │   (sellable)     │  One of three outcomes
                    │   (downgrade)    │  CoA/CoC generated
                    │   (rework)       │
                    └──────────────────┘
```

The disposition (Accept/Reject/Conditional) is one-per-lot, non-reversible. Edits happen through ECN/exception flow (Epic 1 / Story 1.3 edit log).

---

## 6. Interaction Primitives

### 6.1 Confirmation Pattern

Confirmation is required whenever an action is high-stakes (large-value approval), destructive (cannot be undone by a simple retry), or bulk (affects many records at once). The primary form factor is a gloved, one-handed tablet, so the default confirmation interaction is touch-first. Typing a confirmation word is retained only as a desktop fallback for destructive actions.

#### 6.1.1 Pattern Selection by Context

The table below maps each confirmation context to its required interaction pattern. See Table 1.

| Context | Example actions | Tablet/touch pattern | Desktop pattern |
| --- | --- | --- | --- |
| High-stakes approval | Approve large PO, release production order, ship customer order | Slide-to-confirm | Slide-to-confirm (mouse drag) or type-to-confirm (optional) |
| Destructive action | Reverse gate event, delete draft indent, cancel PO | Slide-to-confirm, then two-tap-with-delay for the second-order effects summary | Type-to-confirm (desktop-only fallback), or slide-to-confirm with mouse |
| Bulk operation | Approve all pending indents, bulk-release putaway tasks | Two-tap-with-delay (summary tap, then confirm tap) | Two-tap-with-delay or Ctrl+Shift+A shortcut with slide-to-confirm |
| Lower-stakes action | Add lot to stock, update location | Inline confirmation or toast notification (no slide or type needed) | Inline confirmation or toast notification |

Table 1: Confirmation pattern selection by context and platform.

#### 6.1.2 Slide-to-Confirm (Tablet/Touch, Primary)

Slide-to-confirm replaces "type APPROVE" for gloved, one-handed use. The user drags a thumb-sized handle across a track; the action commits only once the handle reaches the end of the track.

**Interaction spec:**

- **Track width:** Full modal content width minus 32px padding (minimum 280px on a 768px-wide tablet in portrait mode)
- **Track height:** 56px (matches the scan field height used elsewhere in this spec, so the same thumb motion feels familiar)
- **Thumb (handle) size:** 48x48px (exceeds the 44x44px accessibility floor from section 7.3, sized up because the handle carries a directional icon)
- **Slide distance:** 85 percent of track width must be traversed before the action commits; the last 15 percent is a "commit zone" with a visual snap-to-end
- **Haptic feedback:** Short pulse (approximately 10ms) on drag start, a light tick every 25 percent of track traversed, and a stronger confirmation pulse (approximately 40ms) when the commit zone is reached. On devices without haptic support, the tick is replaced by a subtle audible click that respects the device's silent mode
- **Release before commit:** If the user releases before reaching the commit zone, the handle animates back to the start (idle state) and no action is taken
- **Visual states:**
  - **Idle:** Track shows a muted background with the instruction text centered ("Slide to approve"), handle rests at the left edge (or right edge for RTL locales), a subtle chevron pattern hints at slide direction
  - **Sliding:** Track fills with the primary action color as the handle moves; instruction text fades out once the handle passes 10 percent of the track; percentage-complete is not shown as a number, only as fill color, to keep the motion glanceable
  - **Confirmed:** Track fills completely, handle snaps to the end, a checkmark icon replaces the handle, and the modal transitions to the success state (see section 4.2 approval flow) within 300ms

**Slide-to-confirm wireframe (tablet, portrait):**

```
┌──────────────────────────────────┐
│ CONFIRM APPROVAL                 │
├──────────────────────────────────┤
│ You are approving:               │
│                                  │
│ Indent IND-2026-0456             │
│ Rs 1,23,000 (within budget)      │
│ Raised by: Avi Singh             │
│                                  │
│ Approve as: Rajesh Patel         │
│ (Warehouse Manager)              │
│                                  │
├──────────────────────────────────┤
│  Slide to approve                │
│ ┌──────────────────────────────┐ │
│ │ (o)  >  >  >  >  >  >  >     │ │  ← 56px track, 48x48px handle
│ └──────────────────────────────┘ │
│                                  │
│ [CANCEL]                         │
└──────────────────────────────────┘
```

#### 6.1.3 Two-Tap-with-Delay (Alternative, Bulk and Destructive Contexts)

Two-tap-with-delay is used where a slide gesture is awkward (bulk operations affecting a variable-length list, or a destructive action where an itemized summary must be read first). It trades gesture friction for a forced pause, which still prevents accidental confirmation without requiring text entry.

**Interaction spec:**

1. **First tap** on the primary action button (for example, "Approve All 6") shows a summary screen listing every affected record, with the button re-labeled to "Confirm: Approve All 6" and visually disabled
2. **1-second delay:** The confirm button is disabled for exactly 1 second after the summary appears, with a thin progress ring animating around the button edge so the user can see the delay counting down
3. **Second tap** (only possible after the delay elapses) executes the action immediately, no further gesture required
4. If the user backgrounds the app or navigates away during the delay, the summary screen resets and the flow must restart from the first tap

**When to prefer two-tap-with-delay over slide-to-confirm:** bulk operations (list length varies, so a fixed-distance slide track does not scale well) and destructive actions where the second-order effects (see section 6.3 reversal pattern) need to be read in full before the user can commit, not just glanced at during a slide.

#### 6.1.4 Type-to-Confirm (Desktop-Only Fallback)

**[DESKTOP-ONLY]** Type-to-confirm ("Type APPROVE to confirm") remains available exclusively on desktop (mouse and keyboard, 1280px-plus) as an optional, stricter alternative for destructive actions such as PO cancellation or gate event reversal. It is never shown on tablet or touch form factors, since typing a full word one-handed while gloved is the friction this redesign removes. Desktop users may still encounter slide-to-confirm (dragged with a mouse) as the default; type-to-confirm is offered as a secondary, opt-in option in desktop-only administrative screens where an extra layer of deliberate friction is wanted (for example, System Administrator deleting a user role).

```
┌──────────────────────────────────┐
│ CONFIRM CANCELLATION             │  [DESKTOP-ONLY]
├──────────────────────────────────┤
│ You are cancelling:              │
│ PO-2026-0900                     │
│                                  │
│ [Type "CANCEL" to confirm]       │ ← Desktop-only, keyboard-driven
│ [                           ]    │
│                                  │
├──────────────────────────────────┤
│ [BACK]          [CONFIRM]        │  ← Disabled until text matches
└──────────────────────────────────┘
```

**Lower-stakes actions** (add lot to stock, update location) use an inline confirmation or toast notification, unchanged from the prior pattern.

### 6.2 Error Recovery Pattern

**User attempts an action and receives an error:**

```
┌────────────────────────────────────┐
│ WEIGHT CAPTURE FAILED              │
├────────────────────────────────────┤
│ ✗ Scale connection lost            │
│                                    │
│ Possible causes:                   │
│ • Scale powered off or not paired  │
│ • Bluetooth range exceeded         │
│ • Scale calibration overdue        │
│                                    │
│ Next steps:                        │
│ 1. Check scale is powered on       │
│ 2. Check Bluetooth pairing         │
│ 3. Try [Retry Connection]          │
│ 4. Or [Enter Weight Manually]      │ ← Path forward
│ 5. Contact: Tech Support (ext 123) │
│                                    │
├────────────────────────────────────┤
│ [Retry Connection] [Enter Manual]  │
└────────────────────────────────────┘
```

Every error includes:
1. What failed (explicit statement)
2. Why it might have failed (causes)
3. What to do next (steps)
4. A fallback action (manual entry, skip, or contact)
5. Support contact (internal, with extension or ticket number)

### 6.3 Undo / Reversal Pattern

**User submitted a gate event; realizes it was the wrong vehicle.**

```
After Gate Event Captured:
┌────────────────────────────────────┐
│ Gate Event Captured                │
│ QM-2026-0847                       │
│ Vehicle: MH-08-AB-2345             │
│ PO: PO-2026-0900                   │
│ Status: [Captured]                 │
├────────────────────────────────────┤
│ [View Details]  [Reverse Event]    │
│                                    │
│ Event synced to central (5 sec ago)│
└────────────────────────────────────┘
```

Tap [Reverse Event] → Modal:

```
┌──────────────────────────────────────┐
│ REVERSE GATE EVENT                   │
├──────────────────────────────────────┤
│ This will:                           │
│ 1. Cancel gate event QM-2026-0847    │
│ 2. Unbind vehicle from PO-2026-0900 │
│ 3. Return vehicle to incoming queue  │
│ 4. Create a reversal record          │
│    (auditor-visible, not deleted)    │
│                                      │
│ Reason for reversal:                 │
│ [Wrong Vehicle]                      │  ← reason codes
│ [Wrong PO]                           │
│ [Other: _____________]               │
│                                      │
├──────────────────────────────────────┤
│ [CANCEL]   [CONFIRM REVERSAL]        │
└──────────────────────────────────────┘
```

**Principle:** Nothing is deleted. Every action has a reversal, and the reversal is logged with the actor and reason.

---

## 7. Accessibility Floor (Behavioral)

### 7.1 Keyboard Navigation

- Every screen is fully keyboard-navigable: Tab through fields and buttons, Shift+Tab backward, Enter to submit, Escape to close modals
- Scan fields auto-focus on load, so barcode scanners work without additional clicks
- Shortcuts: Alt+S to scan (desktop), Alt+A to approve (approval flow)
- No keyboard trap; Tab always progresses forward

### 7.2 Screen Reader Support

- Every input has an associated label (not placeholder-only)
- Every icon has aria-label or is decorative (aria-hidden)
- Form validation errors are announced live via aria-live region
- Status badges announce their intent: "Success: Approved", "Warning: Tolerance Breach"
- Link text describes the action: "Approve Indent IND-2026-0456", not "Click Here"

### 7.3 Motor & Cognitive Accessibility

- Touch targets are 44×44px minimum (tactile easy for people with reduced motor control)
- No time limits on forms (except scanning, which has a 30-second inactivity timeout with restart notification)
- Jargon is minimized; homophones (two/to, there/their) avoided
- Estimated task times are shown: "Receiving (usually 2-3 min)" — helps users with time-blindness

### 7.4 Visual Accessibility

- Color is never the only signal; semantic info paired with text or icon
- Contrast ratios are AAA (7:1) for body text, AA (4.5:1) minimum throughout
- Text is resizable (no fixed px sizes for interactive elements; use rem)
- Dark mode is provided and fully supported
- Animations respect prefers-reduced-motion

---

## 8. Key User Flows (Journeys with Climax Beats)

### 8.1 UJ-GATE-01: Gate Officer Logs Inbound Vehicle at 2am (Offline)

**Protagonist:** Raman, gate security officer, 6 years at this location.  
**Moment:** 2:00 AM, truck arrives with challan; network down (scheduled maintenance).

**Steps:**

1. **Arrival** (0 sec)  
   Raman's device shows "Captured, pending sync" in the app header (device is offline, ready).  
   Truck pulls up. Raman picks up the tablet from the desk.

2. **Gate App Open** (5 sec)  
   Raman opens the warehouse app (already logged in, session persisted).  
   Dashboard shows: "Gate Events" [Tap to Start].

3. **Scan PO / Challan** (10 sec)  
   Field autofocuses: "Scan PO or Challan Number".  
   Raman scans the challan barcode 📷 → [QM-2026-0845].

4. **Lookup** (2 sec, offline)  
   Device looks up QM-2026-0845 in local cache (PO and ASN data synced hourly, even offline).  
   Match found: "PO-2026-0900 | Supplier: Electronica Ltd | Expected: 50 units".

5. **Confirm Details** (20 sec)  
   Form shows:
   ```
   Gate Event: QM-2026-0845
   Vehicle Plate: [____] (Raman keys: MH-08-AB-2345)
   Challan Photo: [Take Photo] (Raman taps, camera opens)
   Challan Number: [QM-2026-0845]  (pre-filled)
   Driver Name: [____]  (optional)
   ```
   Raman takes a photo of the physical challan (mandatory offline).  
   Taps driver name: "Suresh Kumar".

6. **Capture Event** (5 sec)  
   Taps [Capture Gate Event].  
   Device shows: ✓ "Gate event captured. Awaiting weight capture."  
   Header badge: "Captured, pending sync" (yellow).

7. **Handoff to Weighing** (0 sec)  
   Raman calls weighbridge operator over radio: "Gate event QM-2026-0845 logged, ready for weighment."  
   Operator approaches with a second device.

---

**Climax beat:** At 02:45 AM, network restores automatically.  
Device shows a subtle banner: "Syncing..." → 15 seconds later → "Synced. 1 gate event processed."  
Gate event QM-2026-0845 is now in the central database. No re-entry, no data loss.

---

**Validates:**
- **SM-13:** Gate dwell = 40 seconds (target ≤4 min; done)
- **SM-14:** Weight offline and synced on reconnection
- **UJ-GATE-01 spec:** Offline capture with photo evidence of challan
- **NFR-ADOPT-01:** Raman sees immediate feedback ("Captured..."), confirming his work entered the system

---

### 8.2 UJ-WEIGH-01: Weighbridge Operator Captures Trusted Weights

**Protagonist:** Priya, weighbridge operator, truck scale paired via Bluetooth.  
**Moment:** 02:10 AM, same truck (from UJ-GATE-01) at the scale.

**Steps:**

1. **Task Queue** (0 sec)  
   Priya's device shows pending tasks: "QM-2026-0845 | Awaiting Weighment".  
   Taps the task.

2. **Open Weight Capture Form** (5 sec)  
   Form autofocuses on "Tare Weight" field.  
   Scale is already paired via Bluetooth (paired at shift start).

3. **Capture Tare** (30 sec)  
   Truck backs onto scale.  
   Priya positions the truck, then taps [Capture Tare] or device auto-reads from scale.  
   Display: "Tare: 8,500 kg".

4. **Offload** (10 min)  
   Driver and assistants offload the truck (manual labor).

5. **Capture Gross** (10 sec)  
   Truck empty, Priya taps [Capture Gross].  
   Scale reads: "Gross: 9,200 kg".  
   Net auto-calculates: 9,200 − 8,500 = 700 kg.

6. **Tolerance Check** (2 sec, automatic)  
   Expected weight (from ASN): 680 kg.  
   Tolerance: ±5% = 646–714 kg.  
   Actual: 700 kg.  
   **In tolerance** ✓. No flag.

7. **Accept Weights** (5 sec)  
   Priya confirms: [Accept Weights].  
   Device shows:
   ```
   ✓ Weight Capture Complete
   Tare: 8,500 kg
   Gross: 9,200 kg
   Net: 700 kg
   Status: [Accepted] In Tolerance
   
   Next: Receiving & QC Inspection
   ```
   Header badge: "Captured, pending sync" (yellow, still offline).

8. **Handoff to Receiving** (0 sec)  
   Priya calls the warehouse assistant: "Weights captured, QM-2026-0845, ready for receiving."

---

**Climax beat:** Network syncs at 02:45 AM.  
Weighbridge event posts to central. Goods receipt flow (Epic 3) picks it up.  
No discrepancies; clean reconciliation.

---

**Validates:**
- **SM-14:** In-tolerance weights accepted, out-of-tolerance flagged (tolerance logic verified)
- **UJ-WEIGH-01 spec:** Offline weight capture with reconciliation
- **NFR-P-04 Tier 1:** Weighbridge available 24x7, offline-capable

---

### 8.3 UJ-PUT-01: Warehouse Assistant Bends Directed Putaway to Reality

**Protagonist:** Vikram, warehouse assistant, 2 years, knows the warehouse layout by heart.  
**Moment:** 02:50 AM, ASN putaway plan arrives on Vikram's device (just synced).

**Steps:**

1. **Putaway Task Assigned** (0 sec)  
   Vikram's queue shows: "Putaway | QM-2026-0845 | 50 units | BIN-A47".  
   He taps the task.

2. **Open Putaway Form** (5 sec)  
   Device shows:
   ```
   PUTAWAY TASK
   Lot: QZ-4421 (Motor 5kW)
   Qty: 50 units
   Expected Location: BIN-A47
   (high-velocity bin per ABC profile)
   
   [Scan Item] [Scan Location]
   ```

3. **Scan Item Confirmation** (5 sec)  
   Vikram scans the item barcode on the pallet.  
   Device confirms: ✓ "Motor 5kW, Lot QZ-4421, 50 units".

4. **Navigate to Bin** (2 min)  
   Vikram picks up the pallet (forklift or hand pallet) and walks to BIN-A47.  
   But BIN-A47 has a stack of prior stock; risk of topple.  
   **Decision:** Vikram puts the pallet in the adjacent BIN-A43 (same aisle, same access, safe).

5. **Scan Actual Location** (5 sec)  
   Device is still waiting: "Scan Location".  
   Vikram scans the barcode on BIN-A43.  
   Device detects mismatch: "Expected BIN-A47, scanned BIN-A43".

6. **Conflict Resolution** (30 sec)  
   Form surfaces:
   ```
   ⚠ Location Mismatch
   
   Expected: BIN-A47
   Actual: BIN-A43
   
   Why?
   [X] Accessibility — space constraint or stacking issue
   [ ] Wrong Pick — picked wrong bin
   [ ] Better Access — this bin is more efficient
   [ ] Inventory Error — expected plan was wrong
   
   How confident?
   [X] Certain
   [ ] Uncertain
   ```
   Vikram selects "Accessibility — space constraint" and [Certain].

7. **Confirm Override** (5 sec)  
   Taps [Confirm Putaway].  
   Device shows:
   ```
   ✓ Putaway Confirmed
   Lot QZ-4421 now in BIN-A43
   
   System note: Location override recorded
   with confidence and reason. ABC 
   slotting algorithm will learn from this.
   
   What's next? [Next Task]
   ```
   Event logged: "location.disputed" with asserted=BIN-A43, expected=BIN-A47, actor=Vikram, reason=Accessibility, confidence=Certain.

---

**Climax beat:** That night, the ABC algorithm reviews overrides and regenerates tomorrow's putaway plan, pushing faster-moving items from inaccessible bins to more accessible ones. Over a week, Vikram's knowledge of the real warehouse (not the theoretical layout) reshapes the directed bins for the whole team.

**3 weeks in:** Scan-to-bin time drops from 3 min to 40 seconds (data-driven slotting). Vikram sees this in the metrics: "Your insights improved putaway speed for 15 other locations." (NFR-ADOPT-01 feedback loop: his work is visible and valued.)

---

**Validates:**
- **SM-15:** Locator override recorded with provenance (Vikram's reason is logged)
- **NFR-ADOPT-01:** Frontline knowledge feeds system learning; Vikram sees the value of his data
- **UJ-PUT-01 spec:** Glove-friendly, one-handed scan-and-confirm on tablet

---

### 8.4 UJ-IND-01: Floor Supervisor Raises Indent and Actually Knows What Happens

**Protagonist:** Avi Singh, production supervisor, 15 minutes between tasks.  
**Moment:** 10:30 AM, production line running low on motors, needs to raise a requisition for 20 units.

**Steps:**

1. **Open Indent App** (3 sec)  
   Avi's phone (personal, running the web app) shows dashboard.  
   Taps [Raise Indent].

2. **Start Indent** (2 sec)  
   Form: "New Indent".  
   Autofocus: "Part Number or Description".

3. **Scan / Search Part** (10 sec)  
   Avi scans the motor item barcode (or types "motor").  
   Search returns: "Motor 5kW | SKU-2847 | Last cost ₹2,250".

4. **Fill Indent Details** (20 sec)  
   ```
   Part: Motor 5kW (SKU-2847)
   Quantity: [20] units
   Department: Production — Line A
   Reason: Stock replenishment
   Budget Availability: ₹45,000 required. 
                        Available: ₹67,234. 
                        OK ✓
   Urgent: [ ] No [X] Yes — EOD required
   ```
   Avi fills in 20 units, selects urgent.  
   System shows budget available; approves the form automatically (his department budget limit is ₹100k, and he's at ₹67k available).

5. **Submit Indent** (3 sec)  
   Taps [Submit Indent].  
   Device shows:
   ```
   ✓ Indent Created
   IND-2026-0456
   Submitted to: Rajesh Patel
                 (Warehouse Manager)
   Status: Awaiting Approval
   ```
   Status badge: "Submitted".

6. **Return to Work** (0 sec)  
   Avi pockets his phone. Production line still running.  
   No need to chase anyone.

7. **Polling for Decision** (Next 2 hours)  
   Avi keeps the indent status screen open in another browser tab (or check periodically).  
   At 11:15 AM (45 minutes later):  
   Rajesh approves.  
   Avi's phone buzzes: **Push notification:**  
   ```
   ✓ Approved: Indent IND-2026-0456
   By: Rajesh Patel (Warehouse Manager)
   Expected delivery: 04-Jul
   ```
   Avi taps notification → status screen:
   ```
   Indent: IND-2026-0456
   Status: [Approved] ✓
   Approver: Rajesh Patel
   Approved at: 02-Jul 11:15
   
   Order Status:
   [To PO] → [Ordered] → [Expected Delivery]
   Supplier: Electronica Ltd
   Expected arrival: 04-Jul EOD
   ```
   No guessing. No chasing.

---

**Climax beat:** At 04-Jul 16:00, goods receipt posts in the system. Avi's inbox gets another notification: "Motors (20 units) received. Ready for issue."

He never raised the indent twice. Never chased. Never guessed. The system told him what happened, when, and what's next.

---

**Validates:**
- **SM-16:** Indent-to-approval cycle < 90 seconds (time to submit). Status polling answers "what happened?" instantly.
- **UJ-IND-01 spec:** 90-second raise on phone, live status, push notification on decision
- **NFR-ADOPT-01:** Avi sees the outcome; he knows the indent worked. No invisible system.

---

### 8.5 UJ-QC-01: QC Inspector Disposes a Finished Goods Batch

**Protagonist:** Meera, QC inspector, 8 years experience, meticulous about compliance.  
**Moment:** 11:00 AM, finished goods lot FG-2026-0789 from the production line needs disposition before shipping.

**Steps:**

1. **Receive Inspection Notification** (0 sec)  
   Meera's device buzzes with a push notification: "New lot ready for inspection: FG-2026-0789."  
   Header badge shows "Online" (green); Meera is at her desk in the QC lab, network connected.  
   She taps the notification.

2. **Open QC Disposition Form** (5 sec)  
   Device shows:
   ```
   QC DISPOSITION
   Lot: FG-2026-0789
   Item: Servo Valve Assembly, Batch 12
   Qty: 500 units
   Inspection Plan: IS-2500 (Finished Goods, Standard)
   Status: [QC Hold]

   [Begin Inspection]
   ```
   Meera taps [Begin Inspection].

3. **Verify Instrument Calibration Status** (10 sec, automatic + manual confirm)  
   Before any measurement can be recorded, the system checks the calibration status of every instrument assigned to inspection plan IS-2500.
   ```
   INSTRUMENT CALIBRATION CHECK

   Torque Wrench TW-014        [Valid until 15-Jul]  ✓
   Digital Caliper DC-007       [Valid until 20-Jul]  ✓
   Pressure Gauge PG-031        [EXPIRED 28-Jun]      ✗

   ⚠ Calibration Lockout
   Pressure Gauge PG-031 is out of calibration.
   Measurements requiring this instrument are BLOCKED.

   [Swap Instrument]   [Contact Calibration Lab]
   ```
   Meera taps [Swap Instrument], selects the backup gauge PG-032 (valid until 30-Aug). System re-validates: ✓ all instruments now within calibration. Inspection unlocked.

4. **Execute Inspection Plan** (12 min)  
   Form steps through each measurement in IS-2500, one at a time:
   ```
   MEASUREMENT 3 of 8
   Parameter: Output Pressure
   Spec: 4.5-5.5 bar
   Instrument: Pressure Gauge PG-032

   Reading: [____] bar
   ```
   Meera records each reading (torque, dimension, pressure, visual defects) against the spec range. Out-of-spec readings are flagged inline in red with the spec band shown alongside the actual value, so Meera never has to recall the tolerance from memory.

5. **Record Disposition Decision** (30 sec)  
   All 8 measurements complete; 7 pass, 1 (dimensional tolerance on unit 214 of 500) is a minor deviation.
   ```
   DISPOSITION DECISION
   Lot: FG-2026-0789
   Result: 7/8 parameters in spec
   Deviation: Unit 214, dimensional tolerance +0.3mm (spec: +/-0.2mm)

   Decision:
   ( ) Accept — full lot
   ( ) Reject — full lot
   (X) Conditional — downgrade or rework

   Reason: [Isolate unit 214 for rework; release remaining 499 units]
   ```
   Meera selects Conditional, enters the reason, and taps [Confirm Disposition]. The decision is recorded as one-per-lot and non-reversible (see section 5.3); any later correction requires the ECN/exception flow with a full edit-log entry (FR-AC-13).

6. **Handle Conditional Release** (1 min)  
   System splits the lot automatically:
   ```
   ✓ Disposition Recorded
   FG-2026-0789 split into:
     FG-2026-0789-A: 499 units — Released (sellable)
     FG-2026-0789-B: 1 unit — Rework queue

   CoA generation available for FG-2026-0789-A.
   ```
   Meera taps [Generate CoA] for the released sub-lot.

7. **Generate Certificate of Analysis** (10 sec)  
   ```
   CERTIFICATE OF ANALYSIS
   Lot: FG-2026-0789-A
   Qty: 499 units
   Inspector: Meera Krishnan
   Date: 12-Jul-2026
   Result: Conforms to spec (7/8 parameters; unit 214 isolated)
   Instruments used: TW-014, DC-007, PG-032 (all calibration-valid)

   [Attach to Lot]   [Download PDF]
   ```
   Meera taps [Attach to Lot]. The CoA is stored against FG-2026-0789-A and becomes visible to shipping and to the customer-facing dispatch document set.

---

**Climax beat:** The CoA is generated and attached to lot FG-2026-0789-A at 11:23 AM. Shipping's dashboard immediately shows the lot as "Cleared for Dispatch." The compliance trail is complete end to end: calibration check, measurement record, disposition decision, and CoA are all linked to the same lot ID and the same inspector, with no manual re-entry and no gap an auditor could question.

---

**Validates:**
- **SM (QC cycle time):** Full disposition of a 500-unit finished goods lot, from notification to CoA attachment, completed in 23 minutes (target cycle time met).
- **FR-AC-13 (edit log):** Every field entered during inspection, and the disposition decision itself, is logged with actor (Meera), timestamp, and reason; the decision is non-reversible outside the ECN/exception flow.
- **Calibration lockout:** Out-of-calibration instrument PG-031 was blocked from use until swapped for a valid instrument; no measurement could be recorded against an expired instrument.

---

### 8.6 UJ-3WM-01: Procurement Officer Completes Three-Way Match

**Protagonist:** Sunita, procurement officer, handles 30+ purchase orders daily.  
**Moment:** 2:00 PM, goods receipt posted for PO-2026-0900; the invoice from the supplier has just arrived, and a three-way match is needed before invoice approval.

**Steps:**

1. **Receive Notification** (0 sec)  
   Sunita's dashboard shows a new item in her "Awaiting Match" queue: "PO-2026-0900 | Goods receipt posted | Invoice received."  
   She taps the item.

2. **Open Three-Way Match View** (3 sec)  
   Device shows PO, goods receipt note (GRN), and invoice side by side:
   ```
   THREE-WAY MATCH: PO-2026-0900
   Supplier: Electronica Ltd

   ┌─── PO ────────┬─── GRN ───────┬─── INVOICE ───┐
   │ Item: Motor 5kW│ Item: Motor 5kW│ Item: Motor 5kW│
   │ Qty: 50 units  │ Qty: 48 units  │ Qty: 48 units  │
   │ Price: Rs.2,250│ Price: -       │ Price: Rs.2,310│
   │ Total: 1,12,500│ (received)     │ Total: 1,10,880│
   └────────────────┴────────────────┴────────────────┘

   [Verify Quantity]   [Verify Price]
   ```

3. **Verify Quantity Match** (10 sec)  
   Sunita taps [Verify Quantity].
   ```
   QUANTITY CHECK
   PO Qty: 50 units
   Received (GRN): 48 units
   Invoiced: 48 units

   ⚠ Short by 2 units vs. PO (within supplier's
   partial-shipment terms; remainder on backorder)

   GRN matches Invoice qty: ✓
   ```
   GRN and invoice quantities agree with each other, even though both are short of the original PO; this is expected for a partial shipment, so quantity is treated as matched.

4. **Verify Price Match** (10 sec)  
   Sunita taps [Verify Price].
   ```
   PRICE CHECK
   PO Price: Rs.2,250 / unit
   Invoice Price: Rs.2,310 / unit
   Variance: +Rs.60 / unit (+2.7%)
   Tolerance: +/-2.0%

   ✗ Price variance exceeds tolerance
   ```
   The price variance of 2.7 percent exceeds the configured 2 percent tolerance.

5. **Handle Mismatch** (20 sec)  
   ```
   MISMATCH DETECTED
   Type: Price variance (+2.7%, tolerance +/-2.0%)

   Options:
   [Contact Supplier for Credit Note]
   [Accept Variance with Justification]
   [Route to Supervisor]
   ```
   Sunita recognizes this as a known fuel-surcharge adjustment communicated by the supplier last week. She selects [Accept Variance with Justification] and enters: "Fuel surcharge per supplier notice dated 05-Jul, within approved 5% surcharge allowance."

6. **Approve Match and Release for Payment** (10 sec)  
   ```
   ✓ Three-Way Match Approved
   PO-2026-0900
   Quantity: Matched (partial shipment, backorder 2 units)
   Price: Variance accepted (justified)
   Approved by: Sunita Rao
   Invoice released for payment.
   ```
   The invoice moves to Finance's payment queue; PO-2026-0900 remains open for the 2-unit backorder.

7. **Handle Exception (Alternate Path)** (not this PO, shown for completeness)  
   If the variance had exceeded the supervisor-escalation threshold (5%) or Sunita had not recognized the cause, she would instead select [Route to Supervisor], which posts the match to her supervisor's approval queue with the full PO/GRN/invoice comparison attached, and the invoice is held from payment until that approval is recorded.

---

**Climax beat:** The three-way match for PO-2026-0900 is approved and the invoice is released for payment at 2:01:30 PM. Sunita moves to the next PO in her queue 90 seconds after opening the first one, having caught a real price variance, applied a documented justification, and kept the backorder visible for follow-up, all without leaving the match screen.

---

**Validates:**
- **Procurement cycle time:** Match-to-approval completed in 90 seconds for a straightforward variance with a known cause.
- **Financial controls:** Price variance outside tolerance cannot be silently approved; it requires an explicit justification or supervisor routing, both of which are logged.
- **Exception handling:** Quantity shortfalls tied to partial shipments are distinguished from true mismatches, and price variances above the escalation threshold route to a supervisor rather than blocking Sunita's queue indefinitely.

---

## 9. Responsive & Platform Considerations

### 9.1 Desktop (Secondary)

Desktop (1280px+) serves office-based supervisory and administrative roles:

- **Left sidebar:** 250px persistent navigation (roles, modules)
- **Main content:** Full grid layout, 3+ columns visible
- **Right sidebar:** Filters and bulk actions
- **Multi-window:** Approval queue on left, detail view on right, side-by-side workflow
- **Keyboard-driven:** Shortcuts for bulk actions (Ctrl+A to approve all, Shift+R to reject)

### 9.2 Tablet (Primary)

Tablets (768px–1024px landscape) are the frontline workhorse:

- **Full-screen forms:** One task per screen, no sidebars (space premium)
- **Landscape mode preferred:** Buttons below scan field (thumb reach)
- **Portrait mode supported:** Task queue on top, actions on bottom
- **Large touch targets:** Minimum 44×44px, soft padding between
- **Camera integration:** Scan field tied to device camera (barcode reader or built-in)

### 9.3 Mobile (Responsive, Not Officially Supported)

Mobile phones (< 768px) are responsive to avoid crashes, but not optimized:

- **Single-column layout:** Stacked forms, full-width buttons
- **Bottom navigation:** Tab bar at bottom (thumb natural reach)
- **Reduced context:** Task queue shows 3 items, carousel scroll
- **Input method:** Keyboard entry or software barcode scanner (not primary)

---

## 10. Error & Accessibility Concerns (Open Items)

- **[ASSUMPTION]** All offline data is stored in SQLite via PowerSync (not specified in this doc; deferred to architecture)
- **[ASSUMPTION]** Push notifications are opt-in; default is off (GDPR / DPDP compliance)
- **[NOTE FOR UX]** Audit trail for reversals: when Avi raises the same indent twice, the system should warn on second submit ("You raised IND-2026-0456 on 02-Jul 10:30. Are you raising a new indent or retrying?"). Deferred to Epic 4 story.
- **[NOTE FOR UX]** Role-specific dashboard templates: gate officer sees gate queue by default, production supervisor sees indent approvals. Deferred to Epic 12 (reporting) customization.

---

## 11. Empty States

Every screen that can render with zero data needs a defined empty state so the user is never looking at a blank void. Each pattern below follows the voice and tone rules in section 3.

### 11.1 Empty Task Queue (No Pending Tasks)

**Context:** Frontline user opens their task queue (gate, weighbridge, putaway, indent) and there is nothing waiting for them.

**Visual description:** A centered, single-color line illustration of a checked clipboard (no photography, matches the flat icon style used elsewhere in this spec). Illustration sits above the message, sized to roughly one-third of the screen height on tablet.

**Microcopy:**
- Headline: "All caught up."
- Body: "No tasks waiting right now. New tasks will appear here as soon as they're assigned."

**Call-to-action:** `[Refresh]` (secondary, in case a sync is pending) and, for roles that can self-initiate work (Indent Raiser, Gate Officer), a primary button: `[Start New Task]`.

```
┌────────────────────────────────────┐
│                                    │
│           [clipboard icon]        │
│                                    │
│         All caught up.            │
│  No tasks waiting right now.      │
│  New tasks will appear here as    │
│  soon as they're assigned.        │
│                                    │
│      [Start New Task]             │
│      [Refresh]                    │
└────────────────────────────────────┘
```

### 11.2 No Search Results

**Context:** User searches for a part, PO, indent, or lot and nothing matches.

**Visual description:** A small, muted magnifying-glass icon with a slash, inline above the message (not full-screen, since the search field and filters remain visible and usable).

**Microcopy:**
- Headline: "No matches for '[search term]'."
- Body: "Double-check the spelling or number, or try one of these:"
  - "Search by a shorter part of the number"
  - "Remove filters (status, date range) and search again"
  - "Scan the barcode instead of typing"

**Call-to-action:** `[Clear Filters]` and `[Scan Instead]` (mirrors the fallback language already used in section 4.1's scan pattern).

### 11.3 First-Time Use (Onboarding)

**Context:** A user's very first login, before any data exists in their view.

**Visual description:** Full-screen welcome card (see section 12 for the complete onboarding flow) rather than a bare empty list, so the first thing a new user sees is guidance, not absence.

**Microcopy:**
- Headline: "Welcome, [First Name]."
- Body: "Let's get you set up. This will take about a minute."

**Call-to-action:** `[Start Tour]` (primary) and `[Skip for Now]` (secondary). Full detail in section 12.

### 11.4 Data Not Yet Synced (Offline First Launch)

**Context:** User opens the app for the first time while offline, before the initial data sync has completed (no cached PO, ASN, or part data available yet).

**Visual description:** A muted cloud-with-clock icon, paired with the same yellow "pending sync" badge color used throughout section 5.1, so the visual language is consistent with the rest of the offline-first system.

**Microcopy:**
- Headline: "Waiting for first sync."
- Body: "This device hasn't connected yet. Connect to Wi-Fi or mobile data once to download your work data. After that, you can work offline as normal."

**Call-to-action:** `[Check Connection]` (primary) and `[Retry Sync]` (secondary, disabled until a connection is detected).

---

## 12. Onboarding Flow

### 12.1 Role-Based Welcome Screen

On first login, the welcome screen is tailored to the authenticated user's role, using the same role families defined in section 2.1. The role determines which workflow the guided tour demonstrates.

| Role family | Welcome headline | Tour demonstrates |
| --- | --- | --- |
| Gate Officer | "Welcome, [Name]. Ready to log your first vehicle?" | Scan field with a sample PO/challan number |
| Weighbridge Operator | "Welcome, [Name]. Let's pair your scale and capture a weight." | Scan field plus Bluetooth scale pairing |
| Warehouse Assistant (Receiving/Putaway) | "Welcome, [Name]. Let's walk through a putaway task." | Scan field plus location scan and mismatch handling |
| Indent Raiser / Floor Supervisor | "Welcome, [Name]. Let's raise your first indent." | Scan/search field plus status polling |
| Store Manager / Supervisor | "Welcome, [Name]. Here's how approvals work." | Approval card and slide-to-confirm (section 6.1) |
| Procurement / Finance / Admin (desktop roles) | "Welcome, [Name]. Here's your dashboard." | Sidebar navigation and module layout (section 2.3) |

### 12.2 Three-Step Guided Tour

The tour is a lightweight, dismissible overlay (spotlight on the relevant UI element plus a caption card), not a separate slideshow, so the user tours their actual live screen.

1. **Step 1: Scan field demonstration.** Spotlight on the scan input from section 4.1. Caption: "Every task starts here. Scan a barcode, QR, or RFID tag, or tap Enter Manually if you can't scan." A sample scan is pre-loaded so the user can tap `[Try It]` and see a real lookup result without needing a physical item on hand.
2. **Step 2: Sync badge explanation.** Spotlight on the offline state badge from section 5.1. Caption: "This badge shows your connection. Yellow means your work is saved on this device and will sync automatically. You never lose data by working offline."
3. **Step 3: First task walkthrough.** Spotlight on the role-specific task queue (see section 12.1 table). Caption: "Here's your task queue. Tap any task to begin. Let's do one together." The user completes one real (or sandboxed, role-dependent) task end-to-end with inline hints replacing the normal micro-copy where helpful.

Each step shows a progress indicator ("Step 1 of 3") and a `[Next]` button; the final step ends with `[Finish]`.

### 12.3 Skip Option

`[Skip for Now]` is available on the welcome screen and on every tour step (top-right corner, secondary style, never the primary action so it's not accidentally tapped by a gloved thumb). Skipping is logged (not penalized) so supervisors can see which users skipped onboarding, in case follow-up training is needed. A skipped tour can be restarted later from Account Settings ("Replay Tour").

### 12.4 Completion State and Transition

On finishing (or skipping) the tour, the user sees a brief confirmation: "You're all set. Your dashboard is ready." with a `[Go to Dashboard]` button. Tapping it transitions directly into the normal role-specific dashboard defined in section 2.2, with no further interstitial screens. The onboarding-complete flag is stored per-user so the tour never re-appears automatically after the first session.

---

## 13. Notification System

### 13.1 In-App Notification Bell

A bell icon sits in the header, to the left of the account menu, on both desktop and tablet layouts (see section 2.3 header definition). An unread count badge overlays the bell's top-right corner.

- **Badge count behavior:** The badge increments by one each time a new notification is created for the current user. Opening the notification history screen (section 13.4) clears the badge to zero and marks all visible notifications as read. The badge displays the exact count up to 99; at 100 or more it displays "99+".
- Tapping the bell opens a dropdown (desktop) or full-screen panel (tablet) showing the 5 most recent notifications, with a `[View All]` link to the full history screen.

### 13.2 Push Notification Opt-In/Opt-Out

Per section 10, push notifications are opt-in by default (off), consistent with GDPR/DPDP compliance. Users manage preference per event type from Account Settings > Notifications. See Table 2.

| Event type | Default | Applies to roles |
| --- | --- | --- |
| Approval received (indent, PO, order approved or rejected) | Off (opt-in) | Indent Raiser, Production Supervisor, Procurement Officer |
| Goods received | Off (opt-in) | Indent Raiser, Warehouse Assistant, Procurement Officer |
| Sync complete | Off (opt-in) | All frontline roles |
| QC hold placed | Off (opt-in) | QC Inspector, Warehouse Supervisor, Production Supervisor |

Table 2: Push notification event types and default opt-in state.

Each event type has its own toggle; there is no single "all notifications" switch, so a user can opt into "QC hold placed" without also receiving "sync complete" pushes.

### 13.3 Notification Lifecycle

Every notification moves through four states, tracked per-notification and visible in the history screen's status filter:

1. **Created:** The triggering event occurs (for example, an indent is approved). The notification is written to the user's notification list and, if the user opted in for that event type, a push notification is also sent.
2. **Read:** The user opens the bell dropdown or history screen and views the notification. The badge count decrements accordingly.
3. **Acted-upon:** The user taps the notification and completes the associated action (for example, opening the approved indent's status screen). Acted-upon notifications are visually distinguished (a checkmark) from ones that were only read.
4. **Expired:** Notifications older than 30 days (configurable, not specified by this document) move to an expired state; they remain visible in history but are excluded from the default filtered view.

### 13.4 Notification History Screen

A dedicated screen (reached via `[View All]` from the bell dropdown, or from the main navigation) lists every notification the user has received, newest first.

**Filters available:**
- By type (approval, goods received, sync, QC hold)
- By date (today, this week, this month, custom range)
- By status (unread, read, acted-upon)

```
┌────────────────────────────────────┐
│ NOTIFICATIONS                      │
├────────────────────────────────────┤
│ Filter: [All Types v] [This Week v]│
│         [Unread v]                 │
├────────────────────────────────────┤
│ ● Indent IND-2026-0456 approved    │
│   by Rajesh Patel. 2 min ago       │
│ ● Sync complete: 3 events. 1hr ago │
│ ○ QC Hold placed on lot QZ-4421.   │
│   Yesterday                        │
├────────────────────────────────────┤
│ [Load More]                        │
└────────────────────────────────────┘
```

### 13.5 Notification Content Template

Each notification follows the confirmations and feedback voice defined in section 3.1: action-first, no jargon, and explicit about who/what/when.

**Template:** "[Status verb]: [Object] [identifier]. [Actor, if applicable]. [Time or next step]."

**Examples:**
- "Approved: Indent IND-2026-0456. By Rajesh Patel (Warehouse Manager). Expected delivery 04-Jul."
- "Received: Goods for PO-2026-0900 (50 units). Ready for putaway."
- "Synced: 3 gate events processed. No action needed."
- "QC Hold: Lot QZ-4421 placed on hold. Inspection plan IS-2500 pending."

---

## References

- **Epics & Stories:** `_bmad-output/planning-artifacts/epics.md` (defines FRs and user journeys)
- **PRD:** `_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md` (business objectives, metrics, compliance)
- **Design System:** `DESIGN.md` (colors, typography, components, tokens)
- **Architecture Spine:** `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` (event store, PowerSync, offline-first)

---

**Status:** Draft. Ready for pilot team (frontline gate officers, warehouse supervisors, procurement) feedback before finalization.

**Next Steps:**
1. Validate information architecture with frontline roles (gate, weighbridge, putaway)
2. Prototype key screens (scan field, approval card, sync state badge) for usability testing
3. Finalize accessibility audit with WCAG reviewer
4. Handoff to UI/frontend team for component implementation (React + TailwindCSS)
