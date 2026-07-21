import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf-8');
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;])\s*/g, '$1')
    .trim();
}

function extractCreateTable(sql: string, table: string): string {
  const match = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(.*?\\);`, 'is').exec(sql);
  assert.ok(match, `missing CREATE TABLE for ${table}`);
  return normalizeSql(match[0]!);
}

function extractDoBlock(sql: string, constraint: string): string {
  const blocks = sql.match(/DO \$\$.*?END \$\$;/gis) ?? [];
  const block = blocks.find((candidate) => candidate.includes(constraint));
  assert.ok(block, `missing guarded constraint block for ${constraint}`);
  return normalizeSql(block);
}

const EXPECTED = [
  {
    canonical: 'read/projections/item_master.sql',
    table: 'item_master',
    constraints: ['chk_item_master_valuation_method', 'chk_item_master_status'],
    indexes: [] as string[],
  },
  {
    canonical: 'read/projections/location_register.sql',
    table: 'location_register',
    constraints: [
      'chk_location_register_level',
      'chk_location_register_zone_type',
      'chk_location_register_temperature_class',
      'chk_location_register_status',
    ],
    indexes: ['idx_location_register_parent', 'idx_location_register_site'],
  },
  {
    canonical: 'read/projections/stock_balance.sql',
    table: 'stock_balance',
    constraints: [
      'uq_stock_balance_grain',
      'chk_stock_balance_on_hand_non_negative',
      'chk_stock_balance_allocated_non_negative',
      'chk_stock_balance_allocated_within_on_hand',
      'chk_stock_balance_in_transit_non_negative',
    ],
    indexes: [] as string[],
  },
  {
    canonical: 'read/projections/lot_master.sql',
    table: 'lot_master',
    constraints: ['uq_lot_master_lot_number', 'chk_lot_master_quality_hold_status'],
    indexes: ['idx_lot_master_sku_expiry', 'idx_lot_master_lot_id'],
  },
  {
    canonical: 'read/projections/serial_master.sql',
    table: 'serial_master',
    constraints: ['uq_serial_master_sku_serial_number'],
    indexes: ['idx_serial_master_sku_serial'],
  },
  {
    canonical: 'read/projections/lot_trace.sql',
    table: 'lot_trace',
    constraints: [] as string[],
    indexes: ['idx_lot_trace_lot_timestamp', 'idx_lot_trace_event_id'],
  },
];

describe('Story 2.1 schema drift guard', () => {
  const migrateSource = read('src/events/migrate.ts');
  const initDb = read('deploy/compose/init-db.sql');

  for (const { canonical, table, constraints, indexes } of EXPECTED) {
    it(`${table}: canonical definition is in the migration list and mirrored in init-db.sql`, () => {
      const canonicalSql = read(canonical);
      const fileName = canonical.split('/').pop()!;
      assert.ok(migrateSource.includes(fileName), `src/events/migrate.ts must apply ${fileName}`);
      assert.strictEqual(extractCreateTable(initDb, table), extractCreateTable(canonicalSql, table));

      for (const constraint of constraints) {
        assert.strictEqual(extractDoBlock(initDb, constraint), extractDoBlock(canonicalSql, constraint));
      }
      for (const index of indexes) {
        assert.ok(canonicalSql.includes(index), `canonical SQL missing index ${index}`);
        assert.ok(initDb.includes(index), `init-db.sql missing index ${index}`);
      }
      assert.ok(canonicalSql.includes(`GRANT INSERT, SELECT, UPDATE ON ${table} TO app_user`), `canonical missing app_user grant for ${table}`);
      assert.ok(initDb.includes(`GRANT INSERT, SELECT, UPDATE ON ${table} TO app_user`), `init-db missing app_user grant for ${table}`);
      assert.ok(canonicalSql.includes(`GRANT SELECT ON ${table} TO readonly_user`), `canonical missing readonly_user grant for ${table}`);
      assert.ok(initDb.includes(`GRANT SELECT ON ${table} TO readonly_user`), `init-db missing readonly_user grant for ${table}`);
    });
  }
});
