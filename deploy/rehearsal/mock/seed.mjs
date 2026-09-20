#!/usr/bin/env node
// Seeds the platform side of a mock rehearsal pack (world.json, written by generate.mjs) with the
// same direct inserts the Story 13.2 integration test uses: site and bins, item master, the ERP
// purchase-order projection, service orders, job-work receipts with their return clocks, and the
// custody ledger. Idempotent: a second run skips what it finds.
//
//   node deploy/rehearsal/mock/seed.mjs --site-code MOCK-SITE --actor-email lead@example.org [--dry-run]
//
// The site is looked up by location_code: when it ALREADY exists it is reused and the pack's bins
// are parented to it (a code that exists at another level, or a bin code that already belongs to
// another site, is refused). Packs written with generate.mjs --tag carry run-scoped identifiers,
// so several packs seed side by side. --dry-run does all of it inside the transaction, prints what
// it would create and skip, and rolls back.
//
// Connection: DB_HOST, DB_PORT, DB_NAME, DB_ADMIN_USER, DB_ADMIN_PASSWORD (as src/config/index.ts).
// NOT seeded here, because they go through the API in the rehearsal itself: the ERP stock-balance
// snapshot (POST /api/v1/erp/sync with erp-sync-stock-balances.json) and the legacy kits
// (POST /api/v1/boms/legacy-kit-migration from world.json legacy_kits).
//
// The platform is append-only: on a shared database this data stays until a restore. Take the
// pgBackRest backup first (runbook 2.12 and section 9).

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { siteCode: 'MOCK-SITE', actorEmail: null, pack: null, dryRun: false };
  for (let i = 2; i < argv.length; i += 2) {
    if (argv[i] === '--dry-run') {
      args.dryRun = true;
      i -= 1;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${argv[i]}`);
    if (argv[i] === '--site-code') args.siteCode = value;
    else if (argv[i] === '--actor-email') args.actorEmail = value;
    else if (argv[i] === '--pack') args.pack = value;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.actorEmail) throw new Error('--actor-email is required: a provisioned user the seeded receipts are attributed to');
  args.pack ??= join(HERE, 'out', args.siteCode);
  return args;
}

const args = parseArgs(process.argv);
const world = JSON.parse(readFileSync(join(args.pack, 'world.json'), 'utf8'));
const purchaseOrders = JSON.parse(readFileSync(join(args.pack, 'erp-sync-purchase-orders.json'), 'utf8')).purchase_orders;
if (world.site_code !== args.siteCode) throw new Error(`pack is for ${world.site_code}, not ${args.siteCode}`);

const client = new pg.Client({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME ?? 'inventory_events',
  user: process.env.DB_ADMIN_USER ?? 'admin_user',
  password: process.env.DB_ADMIN_PASSWORD ?? 'admin_password',
});
await client.connect();

const counts = {};
const tally = (name, created) => {
  counts[name] ??= { created: 0, skipped: 0 };
  counts[name][created ? 'created' : 'skipped'] += 1;
};
const one = async (sql, params) => (await client.query(sql, params)).rows[0];

try {
  await client.query('BEGIN');

  const actor = await one(`SELECT user_id FROM users WHERE lower(email) = lower($1) AND active`, [args.actorEmail]);
  if (!actor) throw new Error(`no active user with email ${args.actorEmail}; provision the accounts first (runbook 2.9)`);

  async function location(level, code, siteId) {
    const found = await one(`SELECT location_id, level, site_id FROM location_register WHERE location_code = $1`, [code]);
    if (found && found.level !== level) throw new Error(`location ${code} exists as a ${found.level}, not a ${level}`);
    if (found && siteId && found.site_id !== siteId) throw new Error(`bin ${code} already belongs to another site (${found.site_id}); generate the pack with a --tag`);
    tally(level, !found);
    if (found) return found.location_id;
    const id = randomUUID();
    await client.query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
       VALUES ($1, $2, $3, $4, $5, 'general', 'ambient', false, 'active')`,
      [id, code, level, siteId, siteId ?? id],
    );
    return id;
  }
  const siteId = await location('site', world.site_code, null);
  const binIds = new Map();
  for (const bin of world.bins) binIds.set(bin, await location('bin', bin, siteId));

  for (const it of world.items) {
    const found = await one(`SELECT uom, lot_controlled, serial_controlled FROM item_master WHERE sku = $1`, [it.sku]);
    tally('item', !found);
    // SKUs are global, not run-scoped: an existing item is reused as it is, so say when it differs.
    if (found && (found.uom !== it.uom || found.lot_controlled !== it.lot_controlled || found.serial_controlled !== it.serial_controlled))
      console.warn(`warning: item ${it.sku} exists with uom ${found.uom}, lot ${found.lot_controlled}, serial ${found.serial_controlled}; the pack expects ${it.uom}, ${it.lot_controlled}, ${it.serial_controlled}`);
    if (found) continue;
    await client.query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ($1, $2, $3, $4, false, false, false, 'weighted_average', 'production', 'active')`,
      [it.sku, it.uom, it.lot_controlled, it.serial_controlled],
    );
  }

  for (const po of purchaseOrders) {
    const found = await one(`SELECT 1 FROM erp_purchase_order WHERE po_number_ext = $1`, [po.po_number_ext]);
    tally('purchase_order', !found);
    if (found) continue;
    await client.query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, expected_delivery_date, status, source_system, last_synced_at)
       VALUES ($1, $2, $3, (now() + INTERVAL '30 days')::date, 'open', 'ERP', now())`,
      [po.po_number_ext, po.supplier_ref_ext, po.currency],
    );
    for (const l of po.lines) {
      await client.query(
        `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, over_receipt_tolerance_pct, under_receipt_tolerance_pct, source_system, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ERP', now())`,
        [po.po_number_ext, l.line_no, l.sku, l.ordered_qty, l.open_qty, l.unit_price, l.over_receipt_tolerance_pct, l.under_receipt_tolerance_pct],
      );
    }
  }

  const custodyBin = binIds.get(world.bins.find((b) => b.startsWith('BIN-J')) ?? world.bins[0]);
  for (const so of world.service_orders) {
    const found = await one(`SELECT 1 FROM service_order WHERE order_number_ext = $1 AND site_id = $2`, [so.order_number_ext, siteId]);
    tally('service_order', !found);
    if (found) continue;
    const serviceOrderId = randomUUID();
    await client.query(
      `INSERT INTO service_order (service_order_id, order_number_ext, customer_party_code, customer_name, status, has_contractual_offcut, site_id, business_stream, created_by, source_event_id)
       VALUES ($1, $2, $3, $4, 'in_process', false, $5, 'job_work', $6, $7)`,
      [serviceOrderId, so.order_number_ext, so.customer_party_code, so.customer_name, siteId, actor.user_id, randomUUID()],
    );
    const custody = (category, sku, delta, receiptId) =>
      client.query(
        `INSERT INTO custody_ledger_entry (entry_id, service_order_id, customer_party_code, movement_category, ownership, sku, lot_id, location_id, quantity_delta, uom, receipt_id, site_id, posted_by, occurred_at, business_date, source_event_id, source_event_type)
         VALUES ($1, $2, $3, $4, 'customer', $5, NULL, $6, $7, 'KG', $8, $9, $10, now(), CURRENT_DATE, $11, 'jobwork.material_received')`,
        [randomUUID(), serviceOrderId, so.customer_party_code, category, sku, custodyBin, delta, receiptId, siteId, actor.user_id, randomUUID()],
      );
    for (const c of so.challans) {
      const receiptId = randomUUID();
      const grnLineId = randomUUID();
      await client.query(
        `INSERT INTO grn_line (grn_line_id, grn_id, po_ref_ext, line_no, sku, received_qty, uom, stock_class, weighbridge_correlation_id, qc_hold, shortage_variance_qty, status, source_event_id)
         VALUES ($1, $2, $3, 1, $4, $5, $6, 'job_work', $7, false, 0, 'posted', $8)`,
        [grnLineId, randomUUID(), `${world.document_ref_prefix}PO-JW`, c.sku, c.challan_qty, c.uom, randomUUID(), randomUUID()],
      );
      await client.query(
        `INSERT INTO jobwork_material_receipt (receipt_id, service_order_id, grn_line_id, challan_number_ext, challan_date, sku, lot_id, received_qty, challan_qty, uom, variance_qty, variance_flagged, received_by, site_id, source_event_id, challan_class)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $7, $8, 0, false, $9, $10, $11, $12)`,
        [receiptId, serviceOrderId, grnLineId, c.challan_number_ext, c.challan_date, c.sku, c.challan_qty, c.uom, actor.user_id, siteId, randomUUID(), c.challan_class],
      );
      await client.query(
        `INSERT INTO jobwork_return_clock (clock_id, receipt_id, service_order_id, sku, challan_qty, challan_class, challan_date, expiry_date, status, site_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, ($7::date + INTERVAL '365 days')::date, 'open', $8)`,
        [randomUUID(), receiptId, serviceOrderId, c.sku, c.challan_qty, c.challan_class, c.challan_date, siteId],
      );
      await custody('receipt', c.sku, c.challan_qty, receiptId);
    }
    await custody('consumption', so.challans[0].sku, -so.consumed_qty, null);
  }

  await client.query(args.dryRun ? 'ROLLBACK' : 'COMMIT');
  console.log(`${args.dryRun ? 'DRY RUN, rolled back: would seed' : 'seeded'} ${world.site_code} (site_id ${args.dryRun && counts.site.created ? 'new' : siteId})`);
  console.table(counts);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
