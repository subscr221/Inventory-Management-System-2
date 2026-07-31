import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../../src/config/db.js';
import { persistEvent } from '../../src/events/store.js';

const run = randomUUID().slice(0, 8);
const siteId = randomUUID();
const receivingLocationId = randomUUID();
const stagingZoneId = randomUUID();
const stagingBinId = randomUUID();
const receiverId = randomUUID();
const managerId = randomUUID();
const operatorId = randomUUID();
const clerkId = randomUUID();
const sku = `SKU-310D-${run}`;
const lotNumber = `LOT-310D-${run}`;

async function seedUser(userId: string, role: string): Promise<void> {
  await getPool().query(
    `INSERT INTO users (user_id, external_id, email, active) VALUES ($1, $2, $2, true)`,
    [userId, `${role}-${userId.slice(0, 8)}-${run}@example.com`],
  );
  await getPool().query(
    `INSERT INTO user_role_assignments (user_id, role, module, function_scope, location_id) VALUES ($1, $2, 'warehouse', 'write', $3)`,
    [userId, role, siteId],
  );
  await getPool().query(
    `INSERT INTO user_role_assignments (user_id, role, module, function_scope, location_id) VALUES ($1, $2, 'dispatch', 'write', $3)`,
    [userId, role, siteId],
  );
}

function actor(
  userId: string,
  role: string,
): { user_id: string; role: string; location_id: string } {
  return { user_id: userId, role, location_id: siteId };
}

describe('Story 3.10 cross-dock feeds packing and dispatch on staging stock', () => {
  let soId: string;
  let lotUuid: string;

  before(async () => {
    await getPool().query(
      `INSERT INTO location_register
         (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, size_class, hazmat_allowed, quarantine, access_restricted, status)
       VALUES
         ($1, $2, 'site', NULL, $1, 'general', 'ambient', 'standard', false, false, false, 'active'),
         ($3, $4, 'zone', $1, $1, 'general', 'ambient', 'standard', false, false, false, 'active'),
         ($5, $6, 'zone', $1, $1, 'staging', 'ambient', 'standard', false, false, false, 'active'),
         ($7, $8, 'bin', $5, $1, 'staging', 'ambient', 'standard', false, false, false, 'active')`,
      [
        siteId,
        `SITE-310D-${run}`,
        receivingLocationId,
        `RECV-310D-${run}`,
        stagingZoneId,
        `STAGE-310D-${run}`,
        stagingBinId,
        `STAGE-BIN-310D-${run}`,
      ],
    );
    await Promise.all([
      seedUser(receiverId, 'store_assistant'),
      seedUser(managerId, 'warehouse_manager'),
      seedUser(operatorId, 'warehouse_operator'),
      seedUser(clerkId, 'dispatch_clerk'),
    ]);
    await getPool().query(
      `INSERT INTO item_master
         (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ($1, 'EA', false, false, false, false, false, 'weighted_average', 'production', 'active')`,
      [sku],
    );

    const poRef = `PO-310D-${run}`;
    soId = randomUUID();
    const correlationId = randomUUID();
    const grnId = randomUUID();
    const grnLineId = randomUUID();
    const taskId = randomUUID();
    await getPool().query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, status, source_system, last_synced_at)
       VALUES ($1, 'SUP', 'INR', 'open', 'ERP', now())`,
      [poRef],
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, source_system, last_synced_at)
       VALUES ($1, 1, $2, 10, 10, 1, 'ERP', now())`,
      [poRef, sku],
    );
    await getPool().query(
      `INSERT INTO erp_sales_order
         (id, so_number_ext, line_no, sku, quantity, required_by, ship_from_site_id, ship_from_site_code_ext, status, source_system, last_synced_at)
       VALUES ($1, $2, 1, $3, 10, '2026-08-01', $4, $5, 'open', 'ERP', now())`,
      [soId, `SO-310D-${run}`, sku, siteId, `SITE-310D-${run}`],
    );
    await getPool().query(
      `INSERT INTO weighbridge_event
         (weighbridge_event_id, correlation_id, gate_event_id, site_id, site_code_ext, po_ref_ext, line_no,
          tare_kg, gross_kg, net_kg, status, device_id, capture_method, weighed_by, business_date, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1, 11, 10, 'accepted', 'WB', 'MANUAL', $7, '2026-07-31', $8)`,
      [
        randomUUID(),
        correlationId,
        randomUUID(),
        siteId,
        `SITE-310D-${run}`,
        poRef,
        receiverId,
        randomUUID(),
      ],
    );
    await persistEvent({
      event_id: randomUUID(),
      stream_type: 'receiving',
      stream_id: grnId,
      event_type: 'goods.received',
      payload: {
        grn_id: grnId,
        grn_line_id: grnLineId,
        correlation_id: correlationId,
        po_ref_ext: poRef,
        line_no: 1,
        source_document: 'PO',
        sku,
        target_location_id: receivingLocationId,
        received_qty: '10.000',
        lot_id: lotNumber,
        cross_dock: true,
        staging_zone_id: stagingZoneId,
        cross_dock_task_id: taskId,
      },
      metadata: {
        correlation_id: correlationId,
        actor: actor(receiverId, 'store_assistant'),
        occurred_at: '2026-07-31T08:00:00.000Z',
      },
    });
    await persistEvent({
      event_id: randomUUID(),
      stream_type: 'warehouse',
      stream_id: taskId,
      event_type: 'cross_dock_task.assigned',
      payload: { cross_dock_task_id: taskId, assigned_to: operatorId },
      metadata: {
        correlation_id: correlationId,
        actor: actor(managerId, 'warehouse_manager'),
        occurred_at: '2026-07-31T08:01:00.000Z',
      },
    });
    await persistEvent({
      event_id: randomUUID(),
      stream_type: 'warehouse',
      stream_id: taskId,
      event_type: 'cross_dock_task.completed',
      payload: {
        cross_dock_task_id: taskId,
        to_location_id: stagingBinId,
        pick_task_id: randomUUID(),
        pick_line_id: randomUUID(),
      },
      metadata: {
        correlation_id: correlationId,
        actor: actor(operatorId, 'warehouse_operator'),
        occurred_at: '2026-07-31T08:05:00.000Z',
      },
    });
    const lot = await getPool().query(
      `SELECT lot_id FROM lot_master WHERE lot_number = $1 AND sku = $2`,
      [lotNumber, sku],
    );
    lotUuid = lot.rows[0]!['lot_id'] as string;
  });

  after(async () => {
    await closePool();
  });

  it('packs the confirmed cross-dock pick line and dispatches from the staging bin', async () => {
    await persistEvent({
      event_id: randomUUID(),
      stream_type: 'dispatch',
      stream_id: soId,
      event_type: 'dispatch.packed',
      payload: {
        packing_record_id: randomUUID(),
        dispatch_order_id: soId,
        sku,
        packed_qty: '10.000',
        lot_id: lotUuid,
        carton_count: 1,
      },
      metadata: {
        correlation_id: soId,
        actor: actor(clerkId, 'dispatch_clerk'),
        occurred_at: '2026-07-31T09:00:00.000Z',
      },
    });
    await persistEvent({
      event_id: randomUUID(),
      stream_type: 'dispatch',
      stream_id: soId,
      event_type: 'dispatch.shipping_documents_generated',
      payload: { dispatch_order_id: soId, document_types: ['bol'] },
      metadata: {
        correlation_id: soId,
        actor: actor(clerkId, 'dispatch_clerk'),
        occurred_at: '2026-07-31T09:05:00.000Z',
      },
    });
    await persistEvent({
      event_id: randomUUID(),
      stream_type: 'dispatch',
      stream_id: soId,
      event_type: 'dispatch.dispatched',
      payload: { dispatch_order_id: soId },
      metadata: {
        correlation_id: soId,
        actor: actor(clerkId, 'dispatch_clerk'),
        occurred_at: '2026-07-31T09:10:00.000Z',
      },
    });

    const staged = await getPool().query(
      `SELECT on_hand::text, picked::text FROM stock_balance WHERE sku = $1 AND location_id = $2 AND lot_id = $3`,
      [sku, stagingBinId, lotNumber],
    );
    // Staging bin fully consumed by dispatch, not the (empty) receiving bin.
    assert.deepStrictEqual(staged.rows[0], { on_hand: '0.000000', picked: '0.000000' });

    const status = await getPool().query(
      `SELECT dispatched_at FROM dispatch_order_status WHERE dispatch_order_id = $1`,
      [soId],
    );
    assert.notStrictEqual(status.rows[0]!['dispatched_at'], null);
  });
});
