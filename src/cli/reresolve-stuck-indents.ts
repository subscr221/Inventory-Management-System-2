import { getPool, closePool } from '../config/db.js';
import { reresolveStuckIndents, formatReresolveReport } from './reresolve-stuck-indents-core.js';

// Story 4.9 CLI. Default is report mode (read-only); --apply routes stuck lines and audits them.
async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  try {
    const result = await reresolveStuckIndents(getPool(), { apply });
    console.log(formatReresolveReport(result, apply));
    if (apply && result.exceptions.length > 0) process.exitCode = 1;
  } catch (err) {
    console.error('Stuck-indent re-resolution failed:', err);
    process.exitCode = 1;
  } finally {
    await closePool().catch(() => {});
  }
}

void main();
