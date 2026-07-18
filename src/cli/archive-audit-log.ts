import { getPool, closePool } from '../config/db.js';
import { runArchiveAuditLog } from './archive-audit-log-core.js';

// CLI entry point. All failure paths (including pool.connect rejection when the database is down)
// route through the catch below so the designed 'Archive failed:' message and cleanup always run
// instead of an unhandled promise rejection. process.exitCode (not process.exit) lets closePool
// drain before the process terminates.
async function main(): Promise<void> {
  try {
    const { archivedCount, archivePath } = await runArchiveAuditLog(getPool());
    if (archivedCount === 0) {
      console.log('No audit log entries to archive.');
    } else {
      console.log(`Archived ${archivedCount} audit log entries to ${archivePath}`);
    }
  } catch (err) {
    console.error('Archive failed:', err);
    process.exitCode = 1;
  } finally {
    await closePool().catch(() => {});
  }
}

void main();
