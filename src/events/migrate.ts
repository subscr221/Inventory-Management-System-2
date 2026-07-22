import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdminPool, closeAdminPool } from '../config/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATIONS = ['../../events/domain_events.sql', '../../sync/migrations/powersync.sql', '../../read/projections/users.sql', '../../read/projections/audit_log.sql', '../../read/projections/doa_registry.sql', '../../read/projections/business_stream_config.sql', '../../read/projections/location.sql', '../../read/projections/instrument_calibration.sql', '../../read/projections/notification.sql', '../../read/projections/item_master.sql', '../../read/projections/location_register.sql', '../../read/projections/stock_balance.sql', '../../read/projections/lot_master.sql', '../../read/projections/serial_master.sql', '../../read/projections/lot_trace.sql', '../../read/projections/inventory_valuation.sql', '../../read/projections/transfer_request.sql', '../../read/projections/in_transit.sql', '../../read/projections/cycle_count.sql', '../../read/projections/physical_verification.sql', '../../read/projections/inventory_planning.sql', '../../read/projections/replenishment_recommendation.sql', '../../read/projections/obsolescence_flag.sql', '../../read/projections/ownership_agreement.sql', '../../read/projections/erp_purchase_order.sql', '../../read/projections/erp_sales_order.sql', '../../read/projections/integration_exception.sql', '../../read/projections/gate_event.sql', '../../read/projections/weighbridge_event.sql'];

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
