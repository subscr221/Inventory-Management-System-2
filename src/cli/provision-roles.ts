import { readFileSync } from 'node:fs';
import { closePool } from '../config/db.js';
import { provisionUser, reactivateUser, updateUserRoles } from '../adapters/iam/scim.js';
import { getUserIdByExternalId, lookupActiveUserWithRoles } from '../read/projections/users.js';
import { formatPlan, planProvisioning, type RolesFile } from './provision-roles-core.js';

// Pilot cutover accounts (round table 2026-09-13):
//   npm run provision:roles -- deploy/provision/roles.json [--apply]
// Dry run by default. Refuses the whole file on any segregation violation or validation error, so
// a forbidden pairing is caught at the operator's desk and never at the gate. With --apply, each
// person is provisioned through the SCIM adapter (the same seam an identity provider's SCIM
// client uses): created if new, roles REPLACED if known, reactivated first if deprovisioned.
// Never deprovisions: a person absent from the file is left alone.
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const path = args.find((a) => !a.startsWith('--'));
  if (!path) {
    console.error('usage: provision-roles <roles.json> [--apply]');
    process.exitCode = 2;
    return;
  }
  let file: RolesFile;
  try {
    file = JSON.parse(readFileSync(path, 'utf-8')) as RolesFile;
  } catch (err) {
    console.error(`cannot read ${path}:`, err);
    process.exitCode = 2;
    return;
  }
  const plan = planProvisioning(file);
  console.log(formatPlan(plan, apply));
  if (plan.errors.length > 0 || plan.violations.length > 0) {
    process.exitCode = 1;
    return;
  }
  if (!apply) return;
  try {
    for (const person of plan.people) {
      const existingId = await getUserIdByExternalId(person.external_id);
      if (existingId === null) {
        await provisionUser({
          externalId: person.external_id,
          email: person.email,
          displayName: person.display_name,
          roles: person.roles,
        });
        console.log(`created  ${person.email}`);
        continue;
      }
      const active = await lookupActiveUserWithRoles(person.external_id);
      if (active === null) {
        await reactivateUser(person.external_id);
        console.log(`reactivated ${person.email}`);
      }
      await updateUserRoles(person.external_id, person.roles);
      console.log(`updated  ${person.email} (${person.roles.length} assignments)`);
    }
  } catch (err) {
    console.error('provisioning failed:', err);
    process.exitCode = 1;
  } finally {
    await closePool().catch(() => {});
  }
}

void main();
