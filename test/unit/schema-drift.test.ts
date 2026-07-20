import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 2.1 Task 4.5: lightweight schema drift guard. The canonical projection SQL files are
// applied by src/events/migrate.ts, and deploy/compose/init-db.sql must mirror them for
// first-boot container init. This guard fails when one side gains a table/grant the other lacks.

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf-8');
}

const EXPECTED = [
  {
    canonical: 'read/projections/item_master.sql',
    table: 'item_master',
    constraints: ['uq_item_master_sku', 'chk_item_master_valuation_method', 'chk_item_master_status'],
  },
  {
    canonical: 'read/projections/location_register.sql',
    table: 'location_register',
    constraints: ['uq_location_register_code', 'chk_location_register_level', 'chk_location_register_status'],
  },
];

describe('Story 2.1 schema drift guard', () => {
  const migrateSource = read('src/events/migrate.ts');
  const initDb = read('deploy/compose/init-db.sql');

  for (const { canonical, table, constraints } of EXPECTED) {
    it(`${table}: canonical file is in the migration list and mirrored in init-db.sql`, () => {
      const canonicalSql = read(canonical);
      const fileName = canonical.split('/').pop()!;
      assert.ok(migrateSource.includes(fileName), `src/events/migrate.ts must apply ${fileName}`);

      for (const source of [canonicalSql, initDb]) {
        assert.ok(source.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `missing CREATE TABLE for ${table}`);
        assert.ok(source.includes(`GRANT INSERT, SELECT, UPDATE ON ${table} TO app_user`), `missing app_user grant for ${table}`);
        assert.ok(source.includes(`GRANT SELECT ON ${table} TO readonly_user`), `missing readonly_user grant for ${table}`);
        for (const constraint of constraints) {
          assert.ok(source.includes(constraint), `missing constraint ${constraint} for ${table}`);
        }
      }
    });
  }
});
