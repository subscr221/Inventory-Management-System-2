import { getPool, closePool } from '../config/db.js';
import {
  verifySegregatedRoles,
  formatSegregatedRolesReport,
} from './verify-segregated-roles-core.js';

// CLI entry point for the go-live separation-of-duties check (Story 9.7 Task 0). Read-only: it
// provisions nothing and changes nothing. Exit code 1 on any violation so a deployment pipeline can
// gate on it; the same catch-and-drain shape as archive-audit-log.ts, so a database outage reports
// as a failure rather than an unhandled rejection.
async function main(): Promise<void> {
  try {
    const result = await verifySegregatedRoles(getPool());
    console.log(formatSegregatedRolesReport(result));
    if (!result.ok) process.exitCode = 1;
  } catch (err) {
    console.error('Segregated-role verification failed:', err);
    process.exitCode = 1;
  } finally {
    await closePool().catch(() => {});
  }
}

void main();
