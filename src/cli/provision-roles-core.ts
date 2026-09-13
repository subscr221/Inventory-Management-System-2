import { SEGREGATED_ROLE_PAIRS } from './verify-segregated-roles-core.js';
import type { RoleAssignment } from '../read/projections/users.js';

/**
 * Pilot cutover accounts (round table 2026-09-13). People sign in as THEMSELVES; the ROLE is
 * what moves. A roles file names, for each hat, the email of its current holder; this planner
 * turns it into one SCIM provisioning plan per person and refuses, before anything is written,
 * every pairing the platform would refuse at the gate (SEGREGATED_ROLE_PAIRS plus the Story 13.3
 * two-people rule on the two final go-live sign-offs). Pure: no I/O, unit-tested.
 */

export interface RolesFilePerson {
  display_name?: string;
  /** The identity provider's subject for this person; defaults to the email. */
  external_id?: string;
}

export interface RolesFileRole {
  role: string;
  module: string;
  function_scope: 'read' | 'write';
  /** 'site' (the file's site_id), '*' (every site), or an explicit location UUID. */
  location_id: string;
  /** Email of the current holder; the key into `people` when that map is present. */
  holder: string;
}

export interface RolesFile {
  site_id: string;
  people?: Record<string, RolesFilePerson>;
  roles: RolesFileRole[];
}

export interface PlannedPerson {
  email: string;
  external_id: string;
  display_name: string | null;
  roles: RoleAssignment[];
}

export interface SegregationViolation {
  holder: string;
  role_a: string;
  role_b: string;
  reason: string;
}

export interface ProvisioningPlan {
  people: PlannedPerson[];
  violations: SegregationViolation[];
  errors: string[];
}

/** The pairings one person may never hold at once, on top of the DOA-registered pairs. */
export const EXTRA_FORBIDDEN_PAIRS: ReadonlyArray<{ a: string; b: string; reason: string }> = [
  {
    a: 'department_head',
    b: 'finance_controller',
    reason:
      'Story 13.3 decision 1: the two final go-live sign-offs must come from two people (SIGNOFF_ACTOR_CONFLICT other_final_signoff)',
  },
];

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function forbiddenPairs(): Array<{ a: string; b: string; reason: string }> {
  const pairs = SEGREGATED_ROLE_PAIRS.map((p) => ({
    a: p.setterRole,
    b: p.approverRole,
    reason: `SOD pair registered for ${p.transactionType}`,
  }));
  return [...pairs, ...EXTRA_FORBIDDEN_PAIRS];
}

export function planProvisioning(file: RolesFile): ProvisioningPlan {
  const errors: string[] = [];
  if (!UUID_REGEX.test(file.site_id ?? '')) errors.push('site_id must be a UUID');
  const roles = Array.isArray(file.roles) ? file.roles : [];
  if (roles.length === 0) errors.push('roles must be a non-empty array');
  const byHolder = new Map<string, PlannedPerson>();
  for (const [index, entry] of roles.entries()) {
    const where = `roles[${index}]`;
    if (typeof entry.role !== 'string' || entry.role.trim() === '') {
      errors.push(`${where}: role is required`);
    }
    if (typeof entry.module !== 'string' || entry.module.trim() === '') {
      errors.push(`${where}: module is required`);
    }
    if (entry.function_scope !== 'read' && entry.function_scope !== 'write') {
      errors.push(`${where}: function_scope must be read or write`);
    }
    const holder = typeof entry.holder === 'string' ? entry.holder.trim().toLowerCase() : '';
    if (!EMAIL_REGEX.test(holder)) errors.push(`${where}: holder must be an email address`);
    let locationId: string;
    if (entry.location_id === 'site') locationId = file.site_id;
    else if (entry.location_id === '*') locationId = '*';
    else if (UUID_REGEX.test(entry.location_id ?? '')) locationId = entry.location_id;
    else {
      errors.push(`${where}: location_id must be 'site', '*' or a UUID`);
      locationId = '*';
    }
    if (!holder) continue;
    const person = file.people?.[holder] ?? file.people?.[entry.holder] ?? {};
    const planned = byHolder.get(holder) ?? {
      email: holder,
      external_id: (person.external_id ?? holder).trim(),
      display_name: person.display_name ?? null,
      roles: [],
    };
    const assignment: RoleAssignment = {
      role: entry.role,
      module: entry.module,
      functionScope: entry.function_scope,
      locationId,
    };
    const duplicate = planned.roles.some(
      (r) =>
        r.role === assignment.role &&
        r.module === assignment.module &&
        r.functionScope === assignment.functionScope &&
        r.locationId === assignment.locationId,
    );
    if (!duplicate) planned.roles.push(assignment);
    byHolder.set(holder, planned);
  }

  const violations: SegregationViolation[] = [];
  for (const person of byHolder.values()) {
    const held = new Set(person.roles.map((r) => r.role));
    for (const pair of forbiddenPairs()) {
      if (held.has(pair.a) && held.has(pair.b)) {
        violations.push({
          holder: person.email,
          role_a: pair.a,
          role_b: pair.b,
          reason: pair.reason,
        });
      }
    }
  }
  const people = [...byHolder.values()].sort((a, b) => a.email.localeCompare(b.email));
  return { people, violations, errors };
}

export function formatPlan(plan: ProvisioningPlan, apply: boolean): string {
  const lines: string[] = [];
  for (const e of plan.errors) lines.push(`ERROR  ${e}`);
  for (const v of plan.violations) {
    lines.push(`REFUSE ${v.holder} holds both ${v.role_a} and ${v.role_b}: ${v.reason}`);
  }
  for (const p of plan.people) {
    const name = p.display_name ? ` ${p.display_name}` : '';
    lines.push(`${apply ? 'APPLY ' : 'PLAN  '}${p.email} (${p.external_id})${name}`);
    for (const r of p.roles) {
      lines.push(`         ${r.role} on ${r.module} ${r.functionScope} @ ${r.locationId}`);
    }
  }
  const assignments = plan.people.reduce((n, p) => n + p.roles.length, 0);
  lines.push(
    `${plan.people.length} people, ${assignments} assignments, ` +
      `${plan.violations.length} segregation violations, ${plan.errors.length} errors` +
      (apply ? '' : ' (dry run; pass --apply to provision)'),
  );
  return lines.join('\n');
}
