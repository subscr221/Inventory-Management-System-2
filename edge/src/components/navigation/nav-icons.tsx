// Stroke icons for the bottom nav and the icon rail. Hand-drawn 24x24 paths: no icon library and
// no vendor marks (DESIGN.md). Keyed by the nav registry `name`; an unknown name gets the dot.

const ICON_PATHS: Record<string, string> = {
  Dashboard: 'M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z',
  Frontline:
    'M3 7V5a2 2 0 0 1 2-2h2 M17 3h2a2 2 0 0 1 2 2v2 M21 17v2a2 2 0 0 1-2 2h-2 M7 21H5a2 2 0 0 1-2-2v-2 M7 12h10',
  'Refused captures': 'M12 3 2 20h20z M12 10v4 M12 17h.01',
  'New requisition':
    'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z M14 3v6h6 M12 12v6 M9 15h6',
  'Check stock': 'M21 8l-9-5-9 5v8l9 5 9-5z M3 8l9 5 9-5 M12 13v8',
  'My requests': 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  'Report damage': 'M4 21V4 M4 4h13l-2 4 2 4H4',
  'Damage cases':
    'M9 3h6v4H9z M9 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-3 M9 12h6 M9 16h6',
  'Gate entry': 'M4 21V5 M4 5h16v16 M9 21v-6h6v6',
  Stores: 'M3 8l9-4 9 4v9l-9 4-9-4z M3 8l9 4 9-4 M12 12v9',
  'Stores issue': 'M4 7h16v12H4z M4 11h16 M12 11v8',
  'Floor tasks': 'M8 3h8v4H8z M6 7h12v14H6z M9 12h6 M9 16h4',
  'Standing grants': 'M12 3l2.2 4.6H19l-3.8 2.8 1.5 4.6L12 15l-4.7 3 1.5-4.6L5 7.6h4.8z',
  Workflows:
    'M6 9v6 M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 9a9 9 0 0 1-9 9',
  'Access control': 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  Reports: 'M2 20h20 M5 20V10 M11 20V4 M17 20v-7',
  more: 'M4 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0 M11 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0 M18 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0',
  'sign-out': 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
};

const FALLBACK_PATH = 'M12 12h.01';

export function NavIcon({ name }: { name: string }) {
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={ICON_PATHS[name] ?? FALLBACK_PATH} />
    </svg>
  );
}
