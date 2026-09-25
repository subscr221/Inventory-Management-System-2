---
name: Inventory Management System_2
description: Ergonomic, Zoho-familiar operations UI for a multi-site plant inventory platform, one token set across handheld, tablet, desktop and desktop touch.
status: final
created: 2026-09-23
updated: 2026-09-26
colors:
  accent: '#1E6BC6'
  accent-strong: '#1656A3'
  accent-soft: '#E8F1FC'
  on-accent: '#FFFFFF'
  accent-on-dark: '#5AA2F0'
  preset-teal-accent: '#0A7667'
  preset-teal-accent-strong: '#075C50'
  preset-teal-accent-soft: '#E3F4F1'
  preset-teal-accent-on-dark: '#2BB5A0'
  preset-indigo-accent: '#4F46C8'
  preset-indigo-accent-strong: '#3D35A6'
  preset-indigo-accent-soft: '#EEEDFB'
  preset-indigo-accent-on-dark: '#9A93F2'
  preset-terracotta-accent: '#B4461B'
  preset-terracotta-accent-strong: '#8F3714'
  preset-terracotta-accent-soft: '#FBEDE6'
  preset-terracotta-accent-on-dark: '#F08A5D'
  side: '#1B2230'
  side-hover: '#252E3F'
  side-text: '#C9D1DD'
  side-muted: '#8C97A8'
  bg: '#F4F6F9'
  surface: '#FFFFFF'
  border: '#DDE2E9'
  text: '#1C2430'
  text-muted: '#566173'
  ok: '#1E7A3C'
  ok-bg: '#E6F4EA'
  warn: '#8A5300'
  warn-bg: '#FFF3DC'
  err: '#B3261E'
  err-bg: '#FCE8E6'
  info: '#1F5FAD'
  info-bg: '#E7F0FB'
  off: '#4A5568'
  off-bg: '#ECEFF3'
typography:
  family:
    fontFamily: 'Lato, "Segoe UI", Roboto, system-ui, sans-serif'
  title:
    fontSize: 18px
    fontWeight: 900
  body:
    fontSize: 13px
    fontWeight: 400
  body-touch:
    fontSize: 16px
    fontWeight: 400
  label:
    fontSize: 13px
    fontWeight: 700
  caption:
    fontSize: 12px
    fontWeight: 400
  micro:
    fontSize: 11px
    fontWeight: 700
rounded:
  sm: 6px
  md: 8px
  DEFAULT: 10px
  full: 9999px
spacing:
  '1': 4px
  '2': 8px
  '3': 12px
  '4': 16px
  control-compact: 34px
  touch-secondary: 48px
  touch-primary: 56px
  nav-item-touch: 52px
  sidebar-width-touch: 232px
components:
  button-primary:
    backgroundColor: '{colors.accent}'
    textColor: '{colors.on-accent}'
    hoverColor: '{colors.accent-strong}'
    rounded: '{rounded.DEFAULT}'
    height: '{spacing.control-compact}'
    heightTouch: '{spacing.touch-primary}'
  button-secondary:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.accent}'
    borderColor: '{colors.border}'
    rounded: '{rounded.DEFAULT}'
    height: '{spacing.control-compact}'
    heightTouch: '{spacing.touch-secondary}'
  status-pill:
    rounded: '{rounded.full}'
    typography: '{typography.micro}'
  scan-bar:
    backgroundColor: '{colors.surface}'
    borderColor: '{colors.border}'
    focusRing: '{colors.accent-soft}'
    rounded: '{rounded.DEFAULT}'
    heightTouch: '{spacing.touch-secondary}'
  inbox-card:
    backgroundColor: '{colors.surface}'
    borderColor: '{colors.border}'
    rounded: '{rounded.DEFAULT}'
  match-card:
    backgroundColor: '{colors.surface}'
    borderColor: '{colors.border}'
    rounded: '{rounded.DEFAULT}'
  stepper:
    activeColor: '{colors.accent}'
    doneColor: '{colors.ok}'
    idleColor: '{colors.text-muted}'
  sync-badge:
    rounded: '{rounded.full}'
    typography: '{typography.micro}'
  bottom-nav:
    backgroundColor: '{colors.surface}'
    activeColor: '{colors.accent}'
    height: '{spacing.touch-primary}'
  icon-rail:
    backgroundColor: '{colors.side}'
    activeColor: '{colors.accent-on-dark}'
  sidebar:
    backgroundColor: '{colors.side}'
    hoverColor: '{colors.side-hover}'
    textColor: '{colors.side-text}'
    captionColor: '{colors.side-muted}'
    activeMarker: '{colors.accent-on-dark}'
    itemHeightTouch: '{spacing.nav-item-touch}'
  approval-class-chip:
    rounded: '{rounded.full}'
    typography: '{typography.micro}'
  concurrence-keys-card:
    backgroundColor: '{colors.surface}'
    borderColor: '{colors.border}'
    rounded: '{rounded.DEFAULT}'
---

# Inventory Management System_2 Design Spine

This file is the visual spine for the IMS UX run. Every value traces to the decision log (`.memlog.md`) or to the approved mockups under `mockups/`. Where a mockup and this spine disagree, this spine wins.

## Brand & Style

The posture is **ergonomic over modern**: when a fashionable pattern and an easier-to-operate pattern conflict, the easier one wins. The product is used at a factory gate, in stores, at an inspection bay and at desks, often with gloves, glare and a rugged scanner in hand.

The familiarity reference is the **structure** of Zoho Books and Zoho Inventory: a module sidebar, a top search, a site switcher, quick create, list and detail layouts. Users already know those patterns. The product emulates layout and interaction only. It never uses the Zoho name, logos, icons, screenshots or the Puvi typeface. Other modern ERPs are acceptable secondary references.

Role decides what a person sees; device decides how it is laid out and operated. Every role can use every device class.

## Colors

The colour system has three layers: a per-site accent family, a fixed neutral and sidebar shell, and fixed status colours. Mock reference: [colour direction board](mockups/color-themes-1.html).

### Per-site accent family

Accent is configurable per site, Zoho style. Each accent is a five-token family:

- `{colors.accent}` - primary buttons, links, active tabs, focus.
- `{colors.accent-strong}` - hover and pressed state of accent surfaces.
- `{colors.accent-soft}` - selected rows, focus halo, soft highlight backgrounds.
- `{colors.on-accent}` - text and icons on accent (white).
- `{colors.accent-on-dark}` - the active marker and icon on the dark sidebar and icon rail.

`accent-on-dark` exists because every base accent fails the 3:1 non-text contrast minimum on `{colors.side}`; Blue reaches only 3.01:1 and the other three fall below 3:1. A lighter tint passes for all four families.

The site presets are listed in Table 1 below. The default for CMF-ALIGARH is Ledger Blue. All four pass 4.5:1 for white button text.

Table 1: Site accent presets

| Preset | accent | accent-strong | accent-soft | accent-on-dark |
|---|---|---|---|---|
| Ledger Blue (default) | #1E6BC6 | #1656A3 | #E8F1FC | #5AA2F0 |
| Plant Teal | #0A7667 | #075C50 | #E3F4F1 | #2BB5A0 |
| Board Indigo | #4F46C8 | #3D35A6 | #EEEDFB | #9A93F2 |
| Kiln Terracotta | #B4461B | #8F3714 | #FBEDE6 | #F08A5D |

In the frontmatter the default family uses the bare `accent-*` names; the other presets are stored as `preset-<name>-*` and replace the bare names when a site selects them.

### Shell and neutrals

The navigation sidebar is dark (`{colors.side}` #1B2230), like classic Zoho Books. Sidebar labels use `{colors.side-text}` (11.1:1 on side) and section captions `{colors.side-muted}` (5.5:1). Page background is `{colors.bg}`, cards and panels `{colors.surface}`, dividers `{colors.border}`. Body text `{colors.text}` is 15.3:1 on white; secondary text `{colors.text-muted}` is 6.3:1.

### Status colours

Status colours are fixed across sites and never reuse the accent. Table 2 lists each foreground and background pair.

Table 2: Status colour pairs

| Meaning | Foreground | Background |
|---|---|---|
| OK, done, cleared | `{colors.ok}` #1E7A3C | `{colors.ok-bg}` #E6F4EA |
| Warning, pending, on hold | `{colors.warn}` #8A5300 | `{colors.warn-bg}` #FFF3DC |
| Error, rejected, blocked | `{colors.err}` #B3261E | `{colors.err-bg}` #FCE8E6 |
| Information, in progress | `{colors.info}` #1F5FAD | `{colors.info-bg}` #E7F0FB |
| Off, inactive, offline | `{colors.off}` #4A5568 | `{colors.off-bg}` #ECEFF3 |

Status is never carried by colour alone: every pill, badge and row state also has a text label and, where space allows, an icon.

## Typography

The typeface is **Lato** (open licence), replacing Zoho Puvi, which has no published licence and cannot be bundled. Fallback stack: `{typography.family.fontFamily}`.

- `{typography.title}` - screen and panel titles.
- `{typography.body}` - compact desktop body and table text.
- `{typography.body-touch}` - body, inputs and nav labels in touch-roomy density.
- `{typography.label}` - buttons, field labels, column headers.
- `{typography.caption}` - helper text, timestamps, metadata.
- `{typography.micro}` - pills, chips, badges.

The mocks also use in-between sizes (11.5px to 15px); they are not tokens and should snap to the nearest role.

## Layout & Spacing

Spacing uses a 4px base: `{spacing.1}` to `{spacing.4}` (4, 8, 12, 16px).

**Density follows device input, not role.** A coarse pointer or small viewport gets touch-roomy density; a fine pointer gets compact density. There are four device classes, shown in Table 3.

Table 3: Device classes

| Class | Navigation | Density | Primary target | Secondary target |
|---|---|---|---|---|
| Handheld (phone, rugged scanner) | Bottom nav | Touch-roomy | `{spacing.touch-primary}` 56px, full width, bottom third | `{spacing.touch-secondary}` 48px |
| Tablet | Bottom nav or icon rail; may go two-column | Touch-roomy | 56px | 48px |
| Desktop | Dark sidebar | Compact | `{spacing.control-compact}` 34px | 34px |
| Desktop touch (touchscreen PC) | Dark sidebar, 232px, 52px items | Touch-roomy | 56px | 48px |

Gate screens on a desktop use compact density like any desktop. Design small-first: the rugged scanner screen (mocked at 360x640) is the tightest canvas. On handheld, the fallback action next to a scan result (for example Type challan number) stays reachable without scrolling. Mock reference: [gate entry](mockups/key-gate-entry.html).

## Elevation & Depth

The system is mostly flat; separation comes from `{colors.border}` and the `bg` to `surface` step. Shadows used in the mocks:

- Focus halo: 3px ring in `{colors.accent-soft}`.
- Active nav or tab marker: 3px inset bar in accent (`accent-on-dark` on the sidebar).
- Sticky bottom action bar: soft upward shadow, 0 -4px 12px at 6% ink.
- Drawers and popovers: 0 8px 24px at 18% ink; side drawer -8px 0 24px at 15%.

## Shapes

- `{rounded.DEFAULT}` 10px - cards, inputs, scan bar, primary buttons.
- `{rounded.md}` 8px and `{rounded.sm}` 6px - small buttons, table controls, tags.
- `{rounded.full}` - status pills, chips, sync badge, avatars.

Corners are soft but not bubbly; they signal touchability without losing the ledger feel.

## Components

This section covers visual specs only. Behaviour lives in EXPERIENCE.md.

### Buttons

Primary: `{colors.accent}` fill, `{colors.on-accent}` text, `{colors.accent-strong}` on hover or press, `{typography.label}`. Height `{spacing.control-compact}` on desktop, `{spacing.touch-primary}` in touch density, full width in the bottom third on handheld. Secondary: surface fill, border, accent text, `{spacing.touch-secondary}` in touch density. Disabled buttons use `{colors.off}` on `{colors.off-bg}`.

### Status pills and chips

Pill shape, `{typography.micro}`, foreground and background from Table 2, always with a text label.

### Scan bar

Always-on-top field on stores and scan-driven screens: surface fill, border, scan icon, `{colors.accent-soft}` focus halo, 48px high in touch density. It accepts camera, hardware trigger and keyboard-wedge input. Mock reference: [stores](mockups/key-stores.html).

### Inbox card

Surface card with border and `{rounded.DEFAULT}`: title line in `{typography.label}`, metadata in `{typography.caption}`, a status pill on the right, and one primary action in touch density.

### Match card

Result card for a challan scan: `{colors.surface}` fill, `{colors.border}` border, `{rounded.DEFAULT}`. Matched challan, supplier and PO summary as title in `{typography.label}` with metadata in `{typography.caption}`; the match state uses the status pairs (matched `ok`, no match `warn`). Accept is a primary button and Reject a secondary button; "Scan again" and "Type challan number" sit side by side below and stay visible without scrolling on the 360x640 handheld canvas. Mock reference: [gate entry](mockups/key-gate-entry.html).

### Weighbridge capture

Composes from listed primitives: the "Trucks on site" list uses inbox cards, weigh-in and weigh-out are stepper steps, and the AUTO or MANUAL reading source shows as a status pill (`ok` for AUTO, `warn` for MANUAL) beside the kg value in `{typography.title}`. A tolerance breach shows a banner in the `err` pair; an overdue legal-metrology stamp disables the weigh action with the reason shown. Mock reference: [gate entry](mockups/key-gate-entry.html).

### Counted-qty line and supplier picker

Both compose from listed primitives and carry no bespoke visuals. The counted-qty line renders the tolerance band and the "Excess - returned with vehicle" message in the `warn` pair; the supplier picker is a standard fuzzy-search list with "Unlisted supplier" as a secondary action. Behaviour lives in EXPERIENCE.md Table 3.

### Stepper

Horizontal step labels: active step in accent, completed steps in `{colors.ok}` with a check, pending steps in `{colors.text-muted}`. Nothing may overlap the step labels.

### Sync badge

Pill in the top bar showing connection and sync state using the status pairs (online `ok`, syncing `info`, offline `off`, failed `err`), with a text label.

### Bottom nav

Handheld and tablet navigation: surface bar, `{spacing.touch-primary}` high, icon plus label, active item in accent.

### Icon rail

Collapsed dark navigation: `{colors.side}` fill, icons in `{colors.side-text}`, active item marked with `{colors.accent-on-dark}`.

### Sidebar

Dark module sidebar: `{colors.side}`, labels `{colors.side-text}`, section captions `{colors.side-muted}`, hover `{colors.side-hover}`, active item with a 3px `{colors.accent-on-dark}` inset bar. In desktop touch it is `{spacing.sidebar-width-touch}` wide with `{spacing.nav-item-touch}` items and `{typography.body-touch}` labels. Mock reference: [manager overview](mockups/key-desk.html).

### Standing approval chips

Pill chips on requisition lines and the issue screen. Colour pairings below are lifted from the mocks and committed (accepted 2026-09-26). The **Standing approval** chip carries its reference (for example SA-2026-014) and uses the `ok` pair. The **Self-approval limit** chip shows the amount (Self-approval limit Rs <amount>) and uses the `info` pair. Lines needing department head approval use the `warn` pair. The issue banner and slip state the grant in words, not by colour. Mock references: [requisitions](mockups/key-requisitions.html), [approvals](mockups/key-approvals.html).

### Concurrence keys card

Card for a damage case needing both QC and finance: two key rows (QC, Finance), each with a status pill (pending `warn`, concurred `ok`, disagree `err`) and the decider's name and time. An escalation row to the CEO appears in the `err` pair when the keys disagree. Mock reference: [QC workbench](mockups/key-qc.html).

## Do's and Don'ts

- Do pick the more ergonomic option when it conflicts with the more modern one.
- Do use `{colors.accent-on-dark}`, never the base accent, on the dark sidebar and icon rail.
- Do pair every status colour with a text label and, where possible, an icon.
- Do size touch targets at 56px primary and 48px secondary in touch-roomy density.
- Do keep every text pair at WCAG AA (4.5:1 text, 3:1 non-text).
- Don't use the Zoho name, logos, icons, screenshots or the Puvi font.
- Don't use the accent for status meaning, and don't use status colours for branding.
- Don't bind density to role; bind it to the device input.
- Don't hard-code the accent; always reference the family tokens so site presets work.
