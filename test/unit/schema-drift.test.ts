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
    constraints: [
      'chk_item_master_valuation_method',
      'chk_item_master_status',
      'chk_item_master_standard_cost_designation',
      'chk_item_master_standard_cost_requires_designation',
      'chk_item_master_standard_cost_amount_non_negative',
      'chk_item_master_variance_tolerance_percent',
      'chk_item_master_count_variance_tolerance_percent',
    ],
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
  {
    canonical: 'read/projections/inventory_valuation.sql',
    table: 'inventory_valuation',
    constraints: [
      'chk_inventory_valuation_quantity_non_negative',
      'chk_inventory_valuation_carrying_value_non_negative',
      'chk_inventory_valuation_recovery_cap',
    ],
    indexes: [] as string[],
  },
  {
    canonical: 'read/projections/inventory_valuation.sql',
    table: 'inventory_valuation_fifo_layer',
    constraints: ['chk_inventory_valuation_fifo_layer_remaining_bounds'],
    indexes: ['idx_inventory_valuation_fifo_layer_sku_sequence'],
  },
  {
    canonical: 'read/projections/inventory_valuation.sql',
    table: 'inventory_valuation_serial_cost',
    constraints: [] as string[],
    indexes: [] as string[],
  },
  {
    canonical: 'read/projections/inventory_valuation.sql',
    table: 'inventory_valuation_nrv_adjustment',
    constraints: ['chk_inventory_valuation_nrv_adjustment_type'],
    indexes: ['idx_inventory_valuation_nrv_adjustment_sku'],
    // Append-only ledger: app_user gets no UPDATE (or DELETE) grant, unlike every other projection.
    appUserGrant: 'INSERT, SELECT',
  },
  {
    canonical: 'read/projections/inventory_valuation.sql',
    table: 'inventory_valuation_standard_cost_variance',
    constraints: [] as string[],
    indexes: ['idx_inventory_valuation_standard_cost_variance_sku'],
    // Append-only ledger: app_user gets no UPDATE (or DELETE) grant, unlike every other projection.
    appUserGrant: 'INSERT, SELECT',
  },
  // Story 2.5 projections (drift gap closed by Story 2.6).
  {
    canonical: 'read/projections/transfer_request.sql',
    table: 'transfer_request',
    constraints: [] as string[],
    indexes: [
      'idx_transfer_request_status',
      'idx_transfer_request_sku',
      'idx_transfer_request_from_loc',
      'idx_transfer_request_to_loc',
    ],
  },
  {
    canonical: 'read/projections/in_transit.sql',
    table: 'in_transit',
    constraints: ['uq_in_transit_transfer_request'],
    indexes: [
      'idx_in_transit_sku',
      'idx_in_transit_from',
      'idx_in_transit_to',
      'idx_in_transit_lot',
      'idx_in_transit_request',
    ],
    // in_transit rows are cleared on full receipt, so app_user additionally holds DELETE.
    appUserGrant: 'INSERT, SELECT, UPDATE, DELETE',
  },
  // Story 2.6 projections.
  {
    canonical: 'read/projections/cycle_count.sql',
    table: 'cycle_count',
    constraints: [] as string[],
    indexes: ['idx_cycle_count_location', 'idx_cycle_count_status'],
  },
  {
    canonical: 'read/projections/cycle_count.sql',
    table: 'cycle_count_line',
    constraints: ['uq_cycle_count_line_grain', 'chk_cycle_count_line_counted_non_negative'],
    indexes: ['idx_cycle_count_line_count', 'idx_cycle_count_line_adjustment'],
  },
  {
    canonical: 'read/projections/physical_verification.sql',
    table: 'physical_verification',
    constraints: [] as string[],
    indexes: ['idx_physical_verification_location'],
  },
  {
    canonical: 'read/projections/physical_verification.sql',
    table: 'physical_verification_line',
    constraints: [] as string[],
    indexes: ['idx_physical_verification_line_pv'],
    // Append-only evidence: app_user gets no UPDATE/DELETE grant.
    appUserGrant: 'INSERT, SELECT',
  },
];

describe('Story 2.1 schema drift guard', () => {
  const migrateSource = read('src/events/migrate.ts');
  const initDb = read('deploy/compose/init-db.sql');

  for (const { canonical, table, constraints, indexes, appUserGrant } of EXPECTED) {
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
      const grant = appUserGrant ?? 'INSERT, SELECT, UPDATE';
      assert.ok(canonicalSql.includes(`GRANT ${grant} ON ${table} TO app_user`), `canonical missing app_user grant for ${table}`);
      assert.ok(initDb.includes(`GRANT ${grant} ON ${table} TO app_user`), `init-db missing app_user grant for ${table}`);
      assert.ok(canonicalSql.includes(`GRANT SELECT ON ${table} TO readonly_user`), `canonical missing readonly_user grant for ${table}`);
      assert.ok(initDb.includes(`GRANT SELECT ON ${table} TO readonly_user`), `init-db missing readonly_user grant for ${table}`);
    });
  }
});
