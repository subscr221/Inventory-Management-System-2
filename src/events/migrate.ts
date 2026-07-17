import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdminPool, closeAdminPool } from '../config/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATIONS = ['../../events/domain_events.sql', '../../read/projections/users.sql', '../../read/projections/audit_log.sql'];

async function migrate(): Promise<void> {
  // DDL requires admin_user - app_user has no CREATE privilege on the public schema.
  const pool = getAdminPool();
  for (const migration of MIGRATIONS) {
    const sql = readFileSync(resolve(__dirname, migration), 'utf-8');
    console.log(`Running migration: ${migration}`);
    await pool.query(sql);
  }
  console.log('Migration complete.');
  await closeAdminPool();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
