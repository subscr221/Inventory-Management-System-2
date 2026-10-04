# Phase 1 — Device Class and Density Layer

## Goal

Replace the current desktop-only shell with four device classes per EXPERIENCE.md Foundation rules. Every surface must render meaningfully on handheld, tablet, desktop, and desktop touch.

## Input documents (read first)

- _bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/DESIGN.md — tokens, component specs, do/don't list.
- _bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/EXPERIENCE.md — device breakpoints, interaction primitives, state patterns, key flows.
- _bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/mockups/key-gate-entry.html — tightest canvas reference (360x640 handheld). Read the whole file.
- _bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/mockups/key-stores.html — scan bar + inbox card reference.
- _bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/mockups/key-desk.html — desktop sidebar reference.

## Constraints

- No component library. Plain CSS custom properties only.
- Token names in DESIGN.md frontmatter win over prose descriptions. Reference {colors.accent} etc. not hex values.
- Density binds to pointer type, never to role. Coarse pointer = touch-roomy (56px primary, 48px secondary). Fine pointer = compact (34px controls).
- Mobile-first approach: build for 360x640 handheld first, then widen.
- The existing token layer in edge/app/globals.css is already correct (Zoho palette). Do NOT change color/token values. Only add media queries, new layout classes, and new components.
- i18n literal guard (
pm run i18n:check) must pass. All visible strings must come from edge/src/messages/en.json.
- Lato font family already loaded? Verify edge/app/layout.tsx imports Lato. If not, add it.
- Existing views must not regress at desktop (min-width:1101px pointer:fine).

## Deliverables

### 1. edge/src/lib/use-device-class.ts — NEW

Hook returning one of: "handheld" | "tablet" | "desktop" | "desktop-touch".
Breakpoints: <600, 600-1100, >1100. Pointer type decides coarse vs fine.
Desktop-touch = >1100 width AND coarse pointer OR touch action media feature present.
Must read window.innerWidth and window.matchMedia("(pointer: coarse)") on mount and window resize. Use useState + useEffect. Debounce resize to 50ms.

### 2. edge/app/globals.css — modify

Add three new media query blocks:
`css
@media (max-width: 599px) { /* Handheld: bottom nav, touch density */ }
@media (min-width: 600px) and (max-width: 1100px) { /* Tablet: icon rail or bottom nav, touch density */ }
@media (min-width: 1101px) and (pointer: coarse) { /* Desktop touch: sidebar, touch density */ }
`
Remove old 767px breakpoint. Keep min-width:1101px and pointer:fine block.
Apply --control-height: var(--touch-primary) in touch rooms; --control-height: var(--control-compact) in compact rooms.

### 3. edge/src/components/bottom-nav.tsx — NEW

Dark-surface bar (g token), 	ouch-primary height, icons + labels, active item accent-colored.
Four items max visible, overflow into More dropdown (use existing dropdown pattern if available, otherwise simple relative-positioned popup).
Renders when device class is handheld or tablet-in-handheld-mode.

### 4. edge/src/components/icon-rail.tsx — NEW

Collapsed dark sidebar variant (side fill, side-text label colors).
Icons only (no text), tooltip on hover showing label.
Active item marked with ccent-on-dark inset bar (3px left border).
Width: 64px default, expands to 232px in desktop touch mode.
Renders when device class is tablet-in-icon-rail-mode or desktop-touch.

### 5. edge/src/components/app-shell.tsx — refactor

- Import useDeviceClass().
- Switch nav surface based on result: Handhold ? BottomNav, Tablet ? IconRail or BottomNav, Desktop/DesktopTouch ? Sidebar (existing).
- Apply density tokens to all interactive elements: buttons, inputs, table cells, nav items, form fields.
- In handheld: primary action pinned in bottom third, full width. Scan bar always at top.
- Preserve all existing functionality: sync badge, global search, site switcher, quick create, sign out, view rendering logic.
- Sidebar caption should use ody-touch size in desktop-touch mode.

### 6. i18n additions in edge/src/messages/en.json

- 
av.bottomNav: string
- 
av.more: string
- 
av.hatSwitch: string (if switching nav for hat model prep)

## Verification

After implementation, run ALL of these and report results:
1. 
pm run typecheck — must pass
2. 
pm run lint — must pass  
3. 
pm run i18n:check — must pass
4. 
pm run build — must compile cleanly (SSR hydration)
5. Start dev server (
pm run dev -- -p 3002)
6. Open browser, test at these viewports: 360, 768, 1280, 1366(coarse). Verify nav surface switches correctly.
7. Verify existing views at 1280px render identically to pre-change (no regression)
8. Take screenshots at each viewport showing the nav changes

## Output files to produce

- zoho-phase1-handheld.png — 360px screenshot showing bottom nav
- zoho-phase1-tablet.png — 768px screenshot showing icon rail or bottom nav
- zoho-phase1-desktop.png — 1280px screenshot showing sidebar (should look same as before)
- zoho-phase1-touch.png — 1366px coarse pointer screenshot showing sidebar at 232px with larger controls
