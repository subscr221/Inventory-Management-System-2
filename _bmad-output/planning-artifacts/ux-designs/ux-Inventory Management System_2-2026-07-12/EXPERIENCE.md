---
title: Materials & Supply Chain Management Platform — User Experience Specification
project: Inventory Management System_2
status: draft
created: 2026-07-12
updated: 2026-07-12
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

**Tab Bar (primary, always visible):**  
Tablet/desktop: persistent left sidebar showing 5–7 primary categories (Frontline, Inventory, Warehouse, Procurement, Reports, Admin). Active tab is highlighted with primary color left border.

**Mobile (if needed):** Bottom tab bar with 4 icons (Dashboard, Scan, Task Queue, Account).

**Header (secondary):**  
Breadcrumb trail shows current location: Dashboard > Warehouse > Receiving > [PO-2026-1234]. Back button provides one-level navigation.

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

**UI indicators per state:**
- **ONLINE (connected):** Badge shows "Online" (green). API latency low, mutations immediate.
- **OFFLINE (captured):** Badge shows "Captured, pending sync" (yellow). User continues work. No error indication; expected path.
- **SYNCING:** Badge shows "Syncing..." with spinner (blue). User can continue; data persists locally.
- **SYNC ERROR:** Badge shows "Sync Error" with [Retry] button (red). User notified of issue; must retry or contact support.

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

**High-stakes actions** (approve large PO, release production order, ship customer order) trigger a confirmation modal:

```
┌──────────────────────────────────┐
│ CONFIRM APPROVAL                 │
├──────────────────────────────────┤
│ You are approving:               │
│                                  │
│ Indent IND-2026-0456             │
│ ₹1,23,000 (within budget)        │
│ Raised by: Avi Singh             │
│                                  │
│ Approve as: Rajesh Patel         │
│ (Warehouse Manager)              │
│                                  │
│ [Type "APPROVE" to confirm]      │ ← Deliberate friction
│ [                           ]    │
│                                  │
├──────────────────────────────────┤
│ [CANCEL]        [CONFIRM]        │  ← Disabled until text matches
└──────────────────────────────────┘
```

**Lower-stakes actions** (add lot to stock, update location) use an inline confirmation or toast notification.

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
   Raman's device shows "Captured, pending sync" (device is offline, ready).  
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
   Status badge: "Captured, pending sync" (yellow).

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
   Status badge: "Captured, pending sync" (yellow, still offline).

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
