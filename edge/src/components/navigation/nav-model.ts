// The flat navigation registry: the single source of truth for the on-device nav and the global
// search. Each entry is advertised by the server's bootstrap `navigation` array by `name`; an entry
// is shown only when the server sent that exact name. `label` is the i18n key rendered to the user.

export interface NavEntry {
  name: string;
  href: string;
  label: string;
}

export const NAV_ENTRIES: NavEntry[] = [
  { name: 'Dashboard', href: '/dashboard', label: 'nav.dashboard' },
  { name: 'Frontline', href: '#frontline', label: 'nav.frontline' },
  // Story 1.14 (Binding Decision 4): a real path, rendered only when the bootstrap names it.
  { name: 'Refused captures', href: '/supervisor/refused-captures', label: 'nav.refusedCaptures' },
  // Enterprise views (Phase 2/4): real paths, rendered only when the bootstrap names them.
  { name: 'Workflows', href: '/workflows', label: 'nav.workflows' },
  { name: 'Access control', href: '/access-control', label: 'nav.accessControl' },
  { name: 'Reports', href: '/reports', label: 'nav.inventorySummary' },
];

/** The nav entries the bootstrap advertised, in the order the server sent them. */
export function entriesFor(navigation: string[]): NavEntry[] {
  return navigation.flatMap((name) => {
    const entry = NAV_ENTRIES.find((candidate) => candidate.name === name);
    return entry ? [entry] : [];
  });
}
