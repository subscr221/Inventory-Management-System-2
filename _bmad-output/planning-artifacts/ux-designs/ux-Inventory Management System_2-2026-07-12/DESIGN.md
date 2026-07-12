---
title: Materials & Supply Chain Management Platform — Design System
project: Inventory Management System_2
status: draft
created: 2026-07-12
updated: 2026-07-12
form_factor: [desktop, tablet]
design_system: internal
accessibility_standard: WCAG 2.1 AA
theme_support: light, dark

colors:
  primary:
    50: "#f0f4ff"
    100: "#e0e8ff"
    200: "#c1d1ff"
    300: "#a2baff"
    400: "#7a9cff"
    500: "#4d77ff"
    600: "#1f47d9"
    700: "#1a3ab3"
    800: "#152d8d"
    900: "#101f67"
  
  neutral:
    50: "#f8f9fa"
    100: "#f0f2f5"
    200: "#e4e8eb"
    300: "#d0d5db"
    400: "#b3bcc4"
    500: "#8a95a1"
    600: "#6b7683"
    700: "#54636e"
    800: "#3d4651"
    900: "#1f2937"
  
  semantic:
    success: "#10b981"
    warning: "#f59e0b"
    error: "#ef4444"
    info: "#3b82f6"
    pending: "#8b5cf6"
    offline: "#9ca3af"
  
  intent:
    captured: "#10b981"
    syncing: "#3b82f6"
    sync_pending: "#f59e0b"
    sync_error: "#ef4444"

typography:
  font_family: "system-ui, -apple-system, 'Segoe UI', sans-serif"
  
  heading_1:
    size: 32px
    weight: 700
    line_height: 1.2
    letter_spacing: -0.02em
  
  heading_2:
    size: 24px
    weight: 700
    line_height: 1.25
    letter_spacing: -0.01em
  
  heading_3:
    size: 20px
    weight: 600
    line_height: 1.3
    letter_spacing: 0
  
  body_large:
    size: 16px
    weight: 400
    line_height: 1.5
    letter_spacing: 0.01em
  
  body_regular:
    size: 14px
    weight: 400
    line_height: 1.5
    letter_spacing: 0.01em
  
  label:
    size: 12px
    weight: 600
    line_height: 1.4
    letter_spacing: 0.02em
  
  caption:
    size: 12px
    weight: 400
    line_height: 1.4
    letter_spacing: 0
  
  monospace:
    family: "'Fira Code', 'Courier New', monospace"
    size: 13px
    weight: 400
    line_height: 1.5

rounded:
  none: 0
  sm: 4px
  md: 8px
  lg: 12px
  xl: 16px
  full: 9999px

spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
  3xl: 64px

elevation:
  shadow_sm: "0 1px 2px 0 rgba(0, 0, 0, 0.05)"
  shadow_md: "0 4px 6px -1px rgba(0, 0, 0, 0.1)"
  shadow_lg: "0 10px 15px -3px rgba(0, 0, 0, 0.1)"
  shadow_xl: "0 20px 25px -5px rgba(0, 0, 0, 0.1)"

components:
  button:
    primary: "bg-{primary.600} text-white"
    secondary: "bg-{neutral.100} text-{neutral.900}"
    tertiary: "bg-transparent border-2 border-{primary.600} text-{primary.600}"
    danger: "bg-{semantic.error} text-white"
    disabled: "bg-{neutral.200} text-{neutral.400} cursor-not-allowed"
  
  input:
    border_color: "{neutral.300}"
    focus_color: "{primary.500}"
    error_color: "{semantic.error}"
    disabled_bg: "{neutral.100}"
  
  badge:
    success: "bg-{semantic.success}/10 text-{semantic.success}"
    warning: "bg-{semantic.warning}/10 text-{semantic.warning}"
    error: "bg-{semantic.error}/10 text-{semantic.error}"
    info: "bg-{semantic.info}/10 text-{semantic.info}"
    pending: "bg-{semantic.pending}/10 text-{semantic.pending}"
    offline: "bg-{semantic.offline}/10 text-{semantic.offline}"

---

# Design System: Materials & Supply Chain Management Platform

## 1. Brand & Style

### 1.1 Design Philosophy

This platform is the operational nerve center for a multi-stream supply chain. Design prioritizes:

- **Clarity over decoration** — every pixel serves a business outcome
- **Frontline-first** — designed for warehouse floor, gate, and hub counter, not office first
- **Offline-first visibility** — network state is always visible; no silent failures
- **Accessibility as the baseline** — WCAG 2.1 AA is non-negotiable; scan-first interaction
- **Compliance by appearance** — audit trails, approvals, and blocks are visible in the interface

### 1.2 Visual Tone

- **Professional, not corporate** — language is direct and action-focused
- **Trusted, not sterile** — the system carries operational authority, not distance
- **Responsive, not reactive** — the interface reflects what just happened and what comes next
- **Glove-friendly, one-handed** — large touch targets, optimized for a warehouse in motion

---

## 2. Colors

### 2.1 Primary Palette

The primary blue (`{primary.600}` #1f47d9) signals intentional action: approval, submission, confirmation. Paired with white text on dark backgrounds, it meets AAA contrast (7.2:1 minimum). Shades are reserved for states: lighter for hover, darker for active, lightest for backgrounds.

**Primary use cases:**
- Call-to-action buttons (approve, submit, issue, allocate)
- Links and navigation highlights
- Success states after action

### 2.2 Semantic Colors

- **Success** (`{semantic.success}` #10b981) — transaction posted, item confirmed, allocation cleared
- **Warning** (`{semantic.warning}` #f59e0b) — tolerance breach, quantity mismatch, overdue return
- **Error** (`{semantic.error}` #ef4444) — rejection, lockout, blocker
- **Info** (`{semantic.info}` #3b82f6) — informational message, notice, help text
- **Pending** (`{semantic.pending}` #8b5cf6) — workflow awaiting action (approval, inspection, disposition)
- **Offline** (`{semantic.offline}` #9ca3af) — device network state, no service available

### 2.3 Sync State Indicators

Every device carries a visible sync state badge in the app header:

- **Captured** (`{intent.captured}` #10b981) — events queued locally, no network required, device continues
- **Syncing** (`{intent.syncing}` #3b82f6) — active network sync in progress, user can continue working
- **Sync Pending** (`{intent.sync_pending}` #f59e0b) — network restored, sync queued, no data loss
- **Sync Error** (`{intent.sync_error}` #ef4444) — sync failed on last attempt; retry available; no data loss

The state label and icon appear in a footer badge with no jargon: "Captured, pending sync" (not "offline mode").

### 2.4 Dark Mode

A dark theme is provided as an alternate (CSS custom properties swap `colors` object). The contrast ratios remain AAA; the interface reflects the same design intent in low-light warehouse conditions.

---

## 3. Typography

### 3.1 Type Hierarchy

Five distinct levels serve the scanning workflows:

| Level | Size | Weight | Use Case |
| --- | --- | --- | --- |
| **Heading 1** | 32px | 700 | Page titles, modal headers, major section breaks |
| **Heading 2** | 24px | 700 | Subsection headers, card titles, workflow stage names |
| **Heading 3** | 20px | 600 | Subheadings, field groups, detail labels |
| **Body Large** | 16px | 400 | Main narrative text, button labels, input values |
| **Body Regular** | 14px | 400 | Form labels, table rows, supplementary text |
| **Label** | 12px | 600 | Badge text, status indicators, metadata |
| **Caption** | 12px | 400 | Hints, timestamps, secondary metadata |

### 3.2 Accessibility in Type

- **Minimum size:** 12px (caption) for essential content; hints below 12px are visual only
- **Line height:** 1.5 minimum for body text; 1.4 for labels and captions (dyslexia-friendly spacing)
- **Letter spacing:** 0.01em to 0.02em for labels (improved scanning in loud environments)
- **Font stack:** system fonts guarantee metric consistency across browsers and operating systems

---

## 4. Layout & Spacing

### 4.1 Grid and Spacing Scale

A **8px base unit** grid ensures visual rhythm and responsive scaling:

| Scale | Value | Use Case |
| --- | --- | --- |
| **xs** | 4px | Micro-spacing (icon padding, tight groups) |
| **sm** | 8px | Inner component spacing (form field gaps) |
| **md** | 16px | Standard content spacing (cards, sections) |
| **lg** | 24px | Major section gaps (between workflows, card stacks) |
| **xl** | 32px | Page-level margins, container edges |
| **2xl** | 48px | Screen-layout boundaries |
| **3xl** | 64px | Full-screen section breaks |

**Desktop layout:** Content confined to `max-width: 1280px`, centered with 2xl margins. Navigation left or top, operations right of center.

**Tablet layout:** Full width with xl margins; stack major sections vertically. Touch targets expanded to 44×44px minimum.

### 4.2 Responsive Breakpoints

| Breakpoint | Width | Device | Behavior |
| --- | --- | --- | --- |
| **sm** | 640px | Phone (not primary target) | Single-column, stacked modals |
| **md** | 768px | Tablet — **primary frontline** | Two-column grid, form-on-left, task-on-right |
| **lg** | 1024px | Tablet landscape, small desktop | Three-column layout, sidebar + main + detail |
| **xl** | 1280px | Desktop — **secondary** | Full layout with navigation, main, sidebar |

---

## 5. Elevation & Depth

### 5.1 Shadow System

Four shadow levels create visual hierarchy without relying on color or lines:

- **Shadow SM** (1px drop) — separates inline elements (buttons in a group)
- **Shadow MD** (4–6px drop) — floated cards, input focus states
- **Shadow LG** (10–15px drop) — modals, popovers, dropdown menus
- **Shadow XL** (20–25px drop) — full-screen overlays, side panels

Shadows are **color-neutral** (black at 5-10% opacity) and respond to the theme (no color shifts in dark mode).

### 5.2 Z-Index Layers

| Layer | Z-index | Elements |
| --- | --- | --- |
| **Ground** | auto | Page content, cards, forms |
| **Floating** | 10 | Tooltips, badges, inline popovers |
| **Modal** | 100 | Dialogs, side sheets, modals |
| **Notification** | 1000 | Toast messages, alerts, status badges |
| **Debug** | 2000 | Dev tools, console (never shipped) |

---

## 6. Shapes

### 6.1 Border Radius

Softness increases with component scale and interaction intent:

- **none** (0px) — input fields, buttons, icons (crisp, operational)
- **sm** (4px) — small UI elements (badges, tags, small buttons)
- **md** (8px) — standard cards, modals, popovers
- **lg** (12px) — large containers, page cards, section headers
- **xl** (16px) — full-screen modals, major containers
- **full** (9999px) — circular elements (avatars, circular buttons, pill inputs)

All radii scale proportionally with container size to maintain visual consistency.

---

## 7. Components

### 7.1 Buttons

**Primary** — "Approve", "Submit", "Issue", "Confirm"  
Filled with primary blue, white text. 44×44px minimum on touch. Disabled state is gray with low opacity.

**Secondary** — "Cancel", "View", "Back"  
Light neutral fill, dark text. Lower visual weight, same height as primary.

**Tertiary** — "Learn More", "Help", "Options"  
Transparent with blue border, blue text. Used sparingly; no border on hover to avoid layout shift.

**Danger** — "Reject", "Delete", "Cancel Order"  
Filled with error red, white text. Requires a modal confirmation for destructive actions.

**Icon Buttons** — All actions available as icon-only buttons on touch. No text-only icons; always pair with a 14px label or tooltip on hover.

### 7.2 Form Inputs

**Text fields** — Bordered rectangle with subtle gray border (`{neutral.300}`), focus ring in primary blue (2px inset).  
Label above, optional hint below in caption size. Full width on mobile, constrained to 400px max on desktop.

**Dropdowns** — Same border as text fields, chevron icon on the right (no native browser appearance).  
Options in a popover below; keyboard arrow keys navigate, Enter selects.

**Radio & Checkbox** — Outlined square/circle (16×16px), filled on select.  
Label to the right, clickable area extends to the label (44px total height).

**Scan Field** (frontline-specific) — Oversized input (20px text, 56px tall), autofocus on load, full width on tablet.  
No visible cursor; only the entered value and a clear button (×) visible.

### 7.3 Status & State Badges

- **Success** badge (green fill, dark text) — "Approved", "Captured", "Delivered"
- **Warning** badge (yellow fill, dark text) — "Tolerance Breach", "Awaiting Review", "Overdue"
- **Error** badge (red fill, white text) — "Rejected", "Failed", "Blocked"
- **Info** badge (blue fill, white text) — "In Progress", "Pending", "Conditional"
- **Pending** badge (purple fill, white text) — "Awaiting Approval", "Awaiting Inspection"
- **Offline** badge (gray fill, dark text) — "Offline Mode", "Syncing"

Badges are 20–28px tall, padded with sm/md spacing, label text only (no icons inside badges; icon precedes the badge if needed).

### 7.4 Task & Status Lists

Items in a queue display as a card per item:

```
┌─────────────────────────────────────┐
│ PO-2026-1234 │ In Receiving        │
│ 48 of 50 items unloaded             │
│ [Start Putaway] [View Details]      │
└─────────────────────────────────────┘
```

Title and metadata on left (right-aligned action badges if needed); action buttons on the right (md spacing between). Cards stack vertically, lg spacing between.

---

## 8. Do's and Don'ts

### Do's
- ✓ Use scan fields as the entry point; keyboard is secondary
- ✓ Show sync state in every screen footer; never hide network status
- ✓ Provide immediate visual confirmation after every action ("Captured, pending sync")
- ✓ Make approval workflows explicit: show the approver name, reason fields, and rollback buttons
- ✓ Ensure every transaction has an undo or reversal path visible in the UI
- ✓ Test layouts with a tablet in both portrait and landscape
- ✓ Color is never the only signal; pair color with text and icons
- ✓ Use 44×44px minimum touch targets on mobile/tablet
- ✓ Provide tooltips and help inline; never assume domain knowledge

### Don'ts
- ✗ Don't use only color to indicate state; always pair with an icon or text
- ✗ Don't disable the approval audit trail in the UI; every decision must be revocable
- ✗ Don't hide the sync state; offline mode must be visible, not surprising
- ✗ Don't use custom fonts; system fonts are faster to load and more accessible
- ✗ Don't assume users will read help text; action labels must be self-evident
- ✗ Don't use tables as a primary display on tablets; use cards and collapsible rows
- ✗ Don't require multi-step forms on frontline moments; single-field entry is the goal
- ✗ Don't force login on every app open; persist session across restarts
- ✗ Don't use hard contrasts or motion that trigger accessibility warnings; contrast is accessibility
- ✗ Don't assume network connectivity; every screen must degrade gracefully offline

---

## 9. Accessibility Standards (WCAG 2.1 AA)

### 9.1 Color Contrast

All text meets AAA (7:1) or AA (4.5:1) minimum:

- **AAA (7:1):** Body text, labels, link text
- **AA (4.5:1):** Small text, disabled state, secondary text

Icons used for meaning always include text or aria-label.

### 9.2 Focus Management

- Focus indicators are always visible (2px outline in primary color)
- Tab order follows visual left-to-right, top-to-bottom flow
- Focus traps in modals: Tab loops within the modal; Escape closes
- Skip links present on every page ("Skip to content", "Skip to navigation")

### 9.3 Semantic HTML

- Headings nest logically (h1 → h2 → h3, no skips)
- Forms use `<label>` elements (not placeholder-only)
- Buttons are `<button>` or `<a role="button">`, not divs with click handlers
- Lists use `<ul>` or `<ol>` for grouped items

### 9.4 Motion & Animation

- Animations are limited to 200ms and eased (ease-in-out)
- `prefers-reduced-motion` is respected; all animations disabled if set
- No auto-playing video or audio
- No flashing content (>3 flashes per second)

### 9.5 Internationalization

- Text is not hard-coded in images
- All strings are externalized to translation files
- Right-to-left (RTL) languages are supported via CSS direction and logical properties
- Currency, dates, and numbers are formatted per locale

---

## 10. Dark Mode

Dark theme swaps the following:

- **Background:** `{neutral.900}` → `{neutral.50}`
- **Text:** `{neutral.50}` → `{neutral.900}`
- **Borders:** `{neutral.300}` → `{neutral.700}`
- **Shadows:** adjust opacity to maintain perceived depth

Scheme is toggled via `prefers-color-scheme` media query or a theme-toggle button in the header. The choice is persisted in localStorage.

---

## References

- **WCAG 2.1 AA:** https://www.w3.org/WAI/WCAG21/quickref/
- **Material Design 3:** https://m3.material.io/ (reference for component patterns)
- **Radix UI:** https://www.radix-ui.com/ (unstyled component library, accessibility foundation)
- **Design MD Spec:** https://github.com/google-labs-code/design.md (format inspiration)

---

**Status:** Draft. Awaiting feedback from frontline pilot team (gate officers, warehouse supervisors) before finalization.

**Next:** Move to EXPERIENCE.md for information architecture, journeys, and component behavior specs.
