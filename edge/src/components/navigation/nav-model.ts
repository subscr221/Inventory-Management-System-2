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
  // Story 1.15 (AC 5): the employee base entries every signed-in person is advertised.
  { name: 'New requisition', href: '/requisitions/new', label: 'nav.newRequisition' },
  { name: 'Check stock', href: '/stock', label: 'nav.checkStock' },
  { name: 'My requests', href: '/requests', label: 'nav.myRequests' },
  // Story 8.9 (Task 11.1): report damage (every signed-in person) and the damage cases workbench.
  { name: 'Report damage', href: '/damage/new', label: 'nav.reportDamage' },
  { name: 'Damage cases', href: '/damage/cases', label: 'nav.damageCases' },
  // Story 3.13 (AC 1): gate entry and weighbridge capture, rendered only when the bootstrap names it.
  { name: 'Gate entry', href: '/gate', label: 'nav.gateEntry' },
  // Story 3.14 (AC 1): the storekeeper's task inbox.
  { name: 'Stores', href: '/stores', label: 'nav.stores' },
  // Story 4.11 (AC 9): the storekeeper's counter issue page, rendered only when the bootstrap names it.
  { name: 'Stores issue', href: '/stores/issue', label: 'nav.storesIssue' },
  // Story 4.8: standing approvals and self-approval limits, for everyone (the held-by-me view).
  { name: 'Standing grants', href: '/standing-grants', label: 'nav.standingGrants' },
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
