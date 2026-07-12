import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from '../config/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate(): Promise<void> {
  const pool = getPool();
  const sql = readFileSync(resolve(__dirname, '../../events/domain_events.sql'), 'utf-8');
  console.log('Running migration: events/domain_events.sql');
  await pool.query(sql);
  console.log('Migration complete.');
  await closePool();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
