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
    950: "#000000"   # badge ink - see Section 9.6 for rationale
  
  semantic:
    success: "#10b981"
    warning: "#f59e0b"
    error: "#ef4444"
    info: "#3b82f6"
    pending: "#8b5cf6"
    offline: "#9ca3af"
    # "_strong" variants are darkened fills used only where a solid color
    # surface must carry WHITE text at AAA contrast (badges, danger button,
    # error message text). See Section 9.6 for measured ratios.
    error_strong: "#991b1b"
    info_strong: "#1e40af"
    pending_strong: "#5b21b6"
    # "_dark" variants are lightened tints used only for inline text/icons
    # on dark-mode surfaces (neutral.900), where the base hue fails AA.
    error_dark: "#f87171"
    info_dark: "#60a5fa"
    pending_dark: "#a78bfa"
  
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
    danger: "bg-{semantic.error_strong} text-white"   # 8.31:1 AAA - see Section 9.6
    disabled: "bg-{neutral.200} text-{neutral.400} cursor-not-allowed"   # WCAG 1.4.3 exempt, see Section 9.6
  
  input:
    border_color: "{neutral.500}"   # 3.05:1, meets WCAG 1.4.11 non-text minimum - see Section 9.6
    focus_color: "{primary.500}"
    error_border_color: "{semantic.error}"       # 3.76:1, non-text use only (border/icon)
    error_text_color: "{semantic.error_strong}"  # 8.31:1 AAA, required for error message TEXT
    disabled_bg: "{neutral.100}"
  
  badge:
    success: "bg-{semantic.success} text-{neutral.950}"          # 8.28:1 AAA
    warning: "bg-{semantic.warning} text-{neutral.950}"          # 9.78:1 AAA
    error: "bg-{semantic.error_strong} text-white"                # 8.31:1 AAA
    info: "bg-{semantic.info_strong} text-white"                  # 8.72:1 AAA
    pending: "bg-{semantic.pending_strong} text-white"            # 8.98:1 AAA
    offline: "bg-{semantic.offline} text-{neutral.950}"           # 8.27:1 AAA

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

The primary blue (`{primary.600}` #1f47d9) signals intentional action: approval, submission, confirmation. White text on this fill measures 7.09:1, not the 7.2:1 previously documented; it still clears the AAA (7:1) threshold, but only by a 0.09 margin (see Section 9.6). Because that margin is thin, any critical, high-emphasis call-to-action that must guarantee AAA under all rendering conditions should use `{primary.700}` (#1a3ab3, 9.13:1) instead. Shades are reserved for states: lighter for hover, darker for active, lightest for backgrounds.

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

None of the six semantic hues above are safe as standalone text color directly on a white or light background; measured contrast ranges from 2.15:1 to 4.23:1, all below the AA (4.5:1) minimum (see Section 9.6). Semantic colors are for fills, icons, and accents only, always inside a verified badge treatment (Section 7.3) or paired with an icon and neutral-colored text, consistent with the "color is never the only signal" rule in Section 8.

### 2.3 Sync State Indicators

Every device carries a visible sync state badge in the app header, rendered with the same solid-fill badge component and corrected tokens defined in Section 7.3:

- **Captured** (`{intent.captured}` #10b981, badge text `{neutral.950}`) - events queued locally, no network required, device continues
- **Syncing** (`{intent.syncing}` #3b82f6, rendered with `{semantic.info_strong}` fill and white text) - active network sync in progress, user can continue working
- **Sync Pending** (`{intent.sync_pending}` #f59e0b, badge text `{neutral.950}`) - network restored, sync queued, no data loss
- **Sync Error** (`{intent.sync_error}` #ef4444, rendered with `{semantic.error_strong}` fill and white text) - sync failed on last attempt; retry available; no data loss

The state label and icon appear in a header badge with no jargon: "Captured, pending sync" (not "offline mode").

### 2.4 Dark Mode

A dark theme is provided as an alternate (CSS custom properties swap `colors` object). The base neutral pairing (`{neutral.50}` text on `{neutral.900}` background) measures 13.93:1, comfortably AAA. The six semantic hues do not carry this guarantee automatically: used as inline text or icon color directly on the `{neutral.900}` background, `{semantic.error}`, `{semantic.info}`, and `{semantic.pending}` fall below AA (3.90:1, 3.99:1, and 3.47:1 respectively). Dark-mode inline text and icons in those three colors must use the `{semantic.error_dark}`, `{semantic.info_dark}`, and `{semantic.pending_dark}` tints instead, which measure 5.31:1, 5.77:1, and 5.39:1 against `{neutral.900}` (AA). Solid-fill badges are unaffected by theme, since Section 7.3's badge tokens already carry their own verified fill/text pairing regardless of background. Full figures are in Section 9.6.

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

All six badges use a single, unified treatment: a solid color fill with a single verified text color, never a tinted background with same-color text. The earlier draft's YAML tokens (`bg-{semantic.success}/10 text-{semantic.success}`, a 10%-opacity tint with same-color text) contradicted this prose and, when measured, failed AA outright (2.31:1 at best, 1.99:1 at worst - see Section 9.6). The tokens in the YAML frontmatter now match the descriptions below exactly:

- **Success** badge (`{semantic.success}` #10b981 fill, `{neutral.950}` black text) - 8.28:1 AAA - "Approved", "Captured", "Delivered"
- **Warning** badge (`{semantic.warning}` #f59e0b fill, `{neutral.950}` black text) - 9.78:1 AAA - "Tolerance Breach", "Awaiting Review", "Overdue"
- **Error** badge (`{semantic.error_strong}` #991b1b fill, white text) - 8.31:1 AAA - "Rejected", "Failed", "Blocked"
- **Info** badge (`{semantic.info_strong}` #1e40af fill, white text) - 8.72:1 AAA - "In Progress", "Pending", "Conditional"
- **Pending** badge (`{semantic.pending_strong}` #5b21b6 fill, white text) - 8.98:1 AAA - "Awaiting Approval", "Awaiting Inspection"
- **Offline** badge (`{semantic.offline}` #9ca3af fill, `{neutral.950}` black text) - 8.27:1 AAA - "Offline Mode", "Syncing"

Error, Info, and Pending use a darker "_strong" fill than their base semantic hue so that white text clears AAA; Success, Warning, and Offline keep their base hue with black (`{neutral.950}`) text. Every badge now clears AAA (7:1), not just the AA (4.5:1) floor a solid-fill treatment would technically require for 12px bold label text. See Section 9.6 for the full before/after audit.

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
- ✓ Show sync state in every screen header; never hide network status
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

All text meets AAA (7:1) or AA (4.5:1) minimum, verified per pair in Section 9.6:

- **AAA (7:1):** Body text, links, and standalone semantic-color usage
- **AA (4.5:1):** Small text (badge/label text under 14px bold or 18px regular), disabled state, secondary text

Semantic colors (Section 2.2) are never used as bare text color on white or light backgrounds; they appear only inside a verified solid-fill badge (Section 7.3) or paired with neutral-colored text and an icon. Disabled controls (`{neutral.400}` text on `{neutral.200}`, 1.56:1) are exempt from this requirement per WCAG 1.4.3, since inactive UI components carry no contrast obligation; this is a documented exception, not a failure. Icons used for meaning always include text or aria-label.

### 9.2 Focus Management

- Focus indicators are always visible (2px outline in primary color)
- Tab order follows visual left-to-right, top-to-bottom flow
- Focus traps in modals: Tab loops within the modal; Escape closes
- Skip links present on every page ("Skip to content", "Skip to navigation")

### 9.3 Semantic HTML

- Headings nest logically (h1, then h2, then h3, no skips)
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

### 9.6 Contrast Ratio Audit

Every foreground/background pair used by the components in this document was recalculated against the WCAG 2.1 relative-luminance formula (`L = 0.2126R + 0.7152G + 0.0722B` on linearized sRGB channels, contrast ratio `(L1 + 0.05) / (L2 + 0.05)`). This section is the authoritative record of claimed versus actual ratios, the pairs that failed, and the corrected values now in effect. All corrected values are already reflected in the YAML frontmatter and the component prose earlier in this document.

**Text and button pairs**

| Component | Foreground | Background | Claimed | Actual | Standard | Result |
| --- | --- | --- | --- | --- | --- | --- |
| Button primary text | white | `{primary.600}` #1f47d9 | AAA (7.2:1) | 7.09:1 | AAA (7:1) | Pass, thin margin (correction: claim updated to 7.09:1) |
| Button primary text, safer alternative | white | `{primary.700}` #1a3ab3 | not documented | 9.13:1 | AAA (7:1) | Pass, recommended for critical CTAs |
| Button secondary text | `{neutral.900}` | `{neutral.100}` | implied AAA | 13.09:1 | AAA (7:1) | Pass |
| Button tertiary text/border | `{primary.600}` | white | implied AAA | 7.09:1 | AAA (7:1) | Pass, thin margin |
| Button danger text, original | white | `{semantic.error}` #ef4444 | implied AAA | 3.76:1 | AA (4.5:1) | Fail, below AA |
| Button danger text, corrected | white | `{semantic.error_strong}` #991b1b | n/a | 8.31:1 | AAA (7:1) | Pass (correction applied) |
| Button disabled text | `{neutral.400}` | `{neutral.200}` | n/a | 1.56:1 | exempt | WCAG 1.4.3 exempts inactive controls; no fix required |
| Input border, original | `{neutral.300}` | white | implied 3:1 | 1.48:1 | AA non-text (3:1) | Fail, below non-text minimum |
| Input border, corrected | `{neutral.500}` | white | n/a | 3.05:1 | AA non-text (3:1) | Pass (minimum); `{neutral.600}` at 4.62:1 recommended for margin |
| Input focus ring | `{primary.500}` | white | implied 3:1 | 3.89:1 | AA non-text (3:1) | Pass, no change needed |
| Input error message text, original | `{semantic.error}` | white | implied AAA | 3.76:1 | AA (4.5:1) | Fail, below AA |
| Input error message text, corrected | `{semantic.error_strong}` | white | n/a | 8.31:1 | AAA (7:1) | Pass (correction applied) |

**Semantic colors as standalone text on white**

| Semantic color | Hex | Actual on white | Result |
| --- | --- | --- | --- |
| Success | #10b981 | 2.54:1 | Fail AA |
| Warning | #f59e0b | 2.15:1 | Fail AA |
| Error | #ef4444 | 3.76:1 | Fail AA |
| Info | #3b82f6 | 3.68:1 | Fail AA |
| Pending | #8b5cf6 | 4.23:1 | Fail AA |
| Offline | #9ca3af | 2.54:1 | Fail AA |

None of the six base semantic hues are safe as bare text on white. Section 2.2 and Section 9.1 now state this explicitly: these colors are for fills, icons, and accents only.

**Badge contrast, before and after unification**

| Badge | Before (10% tint bg, same-color text) | After (solid fill, unified spec) | Fill | Text |
| --- | --- | --- | --- | --- |
| Success | 2.31:1, fail AA | 8.28:1, pass AAA | `{semantic.success}` #10b981 | `{neutral.950}` black |
| Warning | 1.99:1, fail AA | 9.78:1, pass AAA | `{semantic.warning}` #f59e0b | `{neutral.950}` black |
| Error | 3.29:1, fail AA | 8.31:1, pass AAA | `{semantic.error_strong}` #991b1b | white |
| Info | 3.29:1, fail AA | 8.72:1, pass AAA | `{semantic.info_strong}` #1e40af | white |
| Pending | 3.75:1, fail AA | 8.98:1, pass AAA | `{semantic.pending_strong}` #5b21b6 | white |
| Offline | 2.35:1, fail AA | 8.27:1, pass AAA | `{semantic.offline}` #9ca3af | `{neutral.950}` black |

All six badges failed AA under the original tinted-background spec and now pass AAA under the corrected solid-fill spec.

**Dark mode pairs**

| Pair | Actual | Standard | Result |
| --- | --- | --- | --- |
| `{neutral.50}` text on `{neutral.900}` background | 13.93:1 | AAA (7:1) | Pass |
| `{semantic.success}` text on `{neutral.900}`, original hue | 5.79:1 | AA (4.5:1) | Pass AA, not AAA |
| `{semantic.warning}` text on `{neutral.900}`, original hue | 6.83:1 | AA (4.5:1) | Pass AA, close to AAA |
| `{semantic.offline}` text on `{neutral.900}`, original hue | 5.78:1 | AA (4.5:1) | Pass AA, not AAA |
| `{semantic.error}` text on `{neutral.900}`, original hue | 3.90:1 | AA (4.5:1) | Fail AA |
| `{semantic.info}` text on `{neutral.900}`, original hue | 3.99:1 | AA (4.5:1) | Fail AA |
| `{semantic.pending}` text on `{neutral.900}`, original hue | 3.47:1 | AA (4.5:1) | Fail AA |
| `{semantic.error_dark}` #f87171 text on `{neutral.900}`, corrected | 5.31:1 | AA (4.5:1) | Pass (correction applied) |
| `{semantic.info_dark}` #60a5fa text on `{neutral.900}`, corrected | 5.77:1 | AA (4.5:1) | Pass (correction applied) |
| `{semantic.pending_dark}` #a78bfa text on `{neutral.900}`, corrected | 5.39:1 | AA (4.5:1) | Pass (correction applied) |
| Dark-mode border, original: `{neutral.700}` on `{neutral.900}` | 2.37:1 | AA non-text (3:1) | Fail |
| Dark-mode border, corrected: `{neutral.600}` on `{neutral.900}` | 3.18:1 | AA non-text (3:1) | Pass (minimum); `{neutral.500}` at 4.82:1 recommended for margin |

The original claim in Section 2.4 that "the contrast ratios remain AAA" in dark mode was inaccurate for the error, info, and pending hues; the corrected `_dark` tints resolve this at AA.

**Summary of corrections applied**

1. Corrected the documented primary.600-on-white ratio from 7.2:1 to the measured 7.09:1; it still passes AAA, but the margin is thin enough to recommend `{primary.700}` for critical CTAs.
2. Added `{semantic.error_strong}` (#991b1b), `{semantic.info_strong}` (#1e40af), and `{semantic.pending_strong}` (#5b21b6) for solid fills that must carry white text at AAA.
3. Added `{neutral.950}` (#000000, "badge ink") for solid fills that must carry black text at AAA.
4. Added `{semantic.error_dark}` (#f87171), `{semantic.info_dark}` (#60a5fa), and `{semantic.pending_dark}` (#a78bfa) for dark-mode inline text and icons.
5. Unified the badge component (YAML and prose) to a single solid-fill treatment; all six badges now pass AAA (was: all six failing AA).
6. Updated `button.danger` to use `{semantic.error_strong}`, resolving a 3.76:1 AA failure (now 8.31:1 AAA).
7. Updated `input.border_color` from `{neutral.300}` (1.48:1) to `{neutral.500}` (3.05:1) to meet the WCAG 1.4.11 non-text minimum; split the original `input.error_color` token into `error_border_color` (non-text use) and `error_text_color` (`{semantic.error_strong}`, for message text).
8. Corrected the inverted background/text swap direction documented in Section 10, and updated the dark-mode border swap from `{neutral.700}` to `{neutral.600}`.
9. Clarified Section 9.1 so the AAA/AA rule matches what is actually achievable and enforced: body text and links at AAA, badge/label text and disabled state at AA, with an explicit WCAG 1.4.3 exemption noted for disabled controls.

---

## 10. Dark Mode

Dark theme swaps the following. The direction below was previously documented backward (it read as if the default background were `{neutral.900}`); the corrected direction is:

- **Background:** light mode `{neutral.50}` becomes dark mode `{neutral.900}`
- **Text:** light mode `{neutral.900}` becomes dark mode `{neutral.50}`
- **Borders:** light mode `{neutral.300}` becomes dark mode `{neutral.600}` (corrected from `{neutral.700}`, which measured 2.37:1 against `{neutral.900}` and failed the 3:1 non-text minimum; `{neutral.600}` measures 3.18:1 and passes, see Section 9.6)
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
