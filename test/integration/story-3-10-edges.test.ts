import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../../src/config/db.js';
import { persistEvent } from '../../src/events/store.js';

const run = randomUUID().slice(0, 8);
const siteId = randomUUID();
const otherSiteId = randomUUID();
const receivingLocationId = randomUUID();
const stagingZoneId = randomUUID();
const stagingBinId = randomUUID();
const otherStagingBinId = randomUUID();
const generalZoneId = randomUUID();
const generalBinId = randomUUID();
const receiverId = randomUUID();
const managerId = randomUUID();
const operatorId = randomUUID();
const operator2Id = randomUUID();
const controllerId = randomUUID();
const sku = `SKU-310E-${run}`;

async function seedUser(userId: string, role: string, active = true, site = siteId): Promise<void> {
  await getPool().query(
    `INSERT INTO users (user_id, external_id, email, active) VALUES ($1, $2, $2, $3)`,
    [userId, `${role}-${userId.slice(0, 8)}-${run}@example.com`, active],
  );
  await getPool().query(
    `INSERT INTO user_role_assignments (user_id, role, module, function_scope, location_id) VALUES ($1, $2, 'warehouse', 'write', $3)`,
    [userId, role, site],
  );
}

function actor(
  userId: string,
  role: string,
  site = siteId,
): { user_id: string; role: string; location_id: string } {
  return { user_id: userId, role, location_id: site };
}

async function seedPo(poRef: string, itemSku: string, orderedQty: string): Promise<void> {
  await getPool().query(
    `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, status, source_system, last_synced_at)
     VALUES ($1, 'SUP', 'INR', 'open', 'ERP', now())`,
    [poRef],
  );
  await getPool().query(
    `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, source_system, last_synced_at)
     VALUES ($1, 1, $2, $3::numeric, $3::numeric, 1, 'ERP', now())`,
    [poRef, itemSku, orderedQty],
  );
}

async function seedWeighment(poRef: string, correlationId: string): Promise<void> {
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
      `SITE-310E-${run}`,
      poRef,
      receiverId,
      randomUUID(),
    ],
  );
}

async function seedSalesOrder(
  itemSku: string,
  id: string,
  soNumber: string,
  qty: string,
  requiredBy: string | null,
  site = siteId,
): Promise<void> {
  await getPool().query(
    `INSERT INTO erp_sales_order
       (id, so_number_ext, line_no, sku, quantity, required_by, ship_from_site_id, ship_from_site_code_ext, status, source_system, last_synced_at)
     VALUES ($1, $2, 1, $3, $4::numeric, $5, $6, $7, 'open', 'ERP', now())`,
    [
      id,
      soNumber,
      itemSku,
      qty,
      requiredBy,
      site,
      site === siteId ? `SITE-310E-${run}` : `OTHER-310E-${run}`,
    ],
  );
}

async function seedItem(itemSku: string): Promise<void> {
  await getPool().query(
    `INSERT INTO item_master
       (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
     VALUES ($1, 'EA', false, false, false, false, false, 'weighted_average', 'production', 'active')`,
    [itemSku],
  );
}

async function receiveCrossDock(opts: {
  poRef: string;
  correlationId: string;
  grnId: string;
  grnLineId: string;
  taskId: string;
  lotNumber: string;
  qty: string;
  sku: string;
  stagingSelector: Record<string, unknown>;
  occurredAt: string;
}): Promise<void> {
  await persistEvent({
    event_id: randomUUID(),
    stream_type: 'receiving',
    stream_id: opts.grnId,
    event_type: 'goods.received',
    payload: {
      grn_id: opts.grnId,
      grn_line_id: opts.grnLineId,
      correlation_id: opts.correlationId,
      po_ref_ext: opts.poRef,
      line_no: 1,
      source_document: 'PO',
      sku: opts.sku,
      target_location_id: receivingLocationId,
      received_qty: opts.qty,
      lot_id: opts.lotNumber,
      cross_dock: true,
      ...opts.stagingSelector,
      cross_dock_task_id: opts.taskId,
    },
    metadata: {
      correlation_id: opts.correlationId,
      actor: actor(receiverId, 'store_assistant'),
      occurred_at: opts.occurredAt,
    },
  });
}

function isCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'errorCode' in error &&
    (error as { errorCode: string }).errorCode === code;
}

describe('Story 3.10 Tasks 3-5 edge coverage', () => {
  before(async () => {
    await getPool().query(
      `INSERT INTO location_register
         (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, size_class, hazmat_allowed, quarantine, access_restricted, status)
       VALUES
         ($1, $2, 'site', NULL, $1, 'general', 'ambient', 'standard', false, false, false, 'active'),
         ($3, $4, 'zone', $1, $1, 'general', 'ambient', 'standard', false, false, false, 'active'),
         ($5, $6, 'zone', $1, $1, 'staging', 'ambient', 'standard', false, false, false, 'active'),
         ($7, $8, 'bin', $5, $1, 'staging', 'ambient', 'standard', false, false, false, 'active'),
         ($9, $10, 'bin', $5, $1, 'staging', 'ambient', 'standard', false, false, false, 'active'),
         ($11, $12, 'zone', $1, $1, 'general', 'ambient', 'standard', false, false, false, 'active'),
         ($13, $14, 'bin', $11, $1, 'general', 'ambient', 'standard', false, false, false, 'active')`,
      [
        siteId,
        `SITE-310E-${run}`,
        receivingLocationId,
        `RECV-310E-${run}`,
        stagingZoneId,
        `STAGE-310E-${run}`,
        stagingBinId,
        `STAGE-BIN-310E-${run}`,
        otherStagingBinId,
        `STAGE-BIN2-310E-${run}`,
        generalZoneId,
        `GEN-ZONE-310E-${run}`,
        generalBinId,
        `GEN-BIN-310E-${run}`,
      ],
    );
    await getPool().query(
      `INSERT INTO location_register
         (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, size_class, hazmat_allowed, quarantine, access_restricted, status)
       VALUES ($1, $2, 'site', NULL, $1, 'general', 'ambient', 'standard', false, false, false, 'active')`,
      [otherSiteId, `OTHER-SITE-310E-${run}`],
    );
    await Promise.all([
      seedUser(receiverId, 'store_assistant'),
      seedUser(managerId, 'warehouse_manager'),
      seedUser(operatorId, 'warehouse_operator'),
      seedUser(operator2Id, 'warehouse_operator'),
      seedUser(controllerId, 'inventory_controller'),
    ]);
  });

  after(async () => {
    await closePool();
  });

  it('Task 3.9: an out-of-NUMERIC(14,3)-range quantity falls back to putaway with quantity_out_of_pick_range', async () => {
    const qtySku = `${sku}-QTY`;
    const poRef = `PO-QTY-${run}`;
    const correlationId = randomUUID();
    const grnLineId = randomUUID();
    const soId = randomUUID();
    await seedItem(qtySku);
    // Received quantity (12 integer digits) is valid for receiving NUMERIC(15,3) and the PO band,
    // but exceeds the cross-dock NUMERIC(14,3) capacity, so it must fall back to putaway.
    await seedPo(poRef, qtySku, '200000000000');
    await seedSalesOrder(qtySku, soId, `SO-QTY-${run}`, '150000000000', '2026-08-01');
    await seedWeighment(poRef, correlationId);
    await receiveCrossDock({
      poRef,
      correlationId,
      grnId: randomUUID(),
      grnLineId,
      taskId: randomUUID(),
      lotNumber: `LOT-QTY-${run}`,
      qty: '100000000000.000',
      sku: qtySku,
      stagingSelector: { staging_zone_id: stagingZoneId },
      occurredAt: '2026-07-31T09:00:00.000Z',
    });
    const row = await getPool().query(
      `SELECT cross_dock, cross_dock_nonqualification_reason,
              EXISTS (SELECT 1 FROM putaway_task WHERE grn_line_id = $1) AS has_putaway,
              EXISTS (SELECT 1 FROM cross_dock_task WHERE grn_line_id = $1) AS has_cd
       FROM grn_line WHERE grn_line_id = $1`,
      [grnLineId],
    );
    assert.deepStrictEqual(row.rows[0], {
      cross_dock: false,
      cross_dock_nonqualification_reason: 'quantity_out_of_pick_range',
      has_putaway: true,
      has_cd: false,
    });
  });

  it('Task 3.3: multi-candidate matching picks earliest required_by and excludes cross-site demand', async () => {
    const multiSku = `${sku}-MULTI`;
    const poRef = `PO-MULTI-${run}`;
    const correlationId = randomUUID();
    const grnLineId = randomUUID();
    const taskId = randomUUID();
    const lateSo = randomUUID();
    const earlySo = randomUUID();
    const crossSiteSo = randomUUID();
    await seedItem(multiSku);
    await seedPo(poRef, multiSku, '100');
    // Cross-site line with enough demand and the earliest date must be ignored.
    await seedSalesOrder(multiSku, crossSiteSo, `SO-XSITE-${run}`, '5', '2026-07-15', otherSiteId);
    await seedSalesOrder(multiSku, lateSo, `SO-LATE-${run}`, '5', '2026-09-01');
    await seedSalesOrder(multiSku, earlySo, `SO-EARLY-${run}`, '5', '2026-08-10');
    await seedWeighment(poRef, correlationId);
    await receiveCrossDock({
      poRef,
      correlationId,
      grnId: randomUUID(),
      grnLineId,
      taskId,
      lotNumber: `LOT-MULTI-${run}`,
      qty: '5.000',
      sku: multiSku,
      stagingSelector: { staging_zone_id: stagingZoneId },
      occurredAt: '2026-07-31T09:05:00.000Z',
    });
    const row = await getPool().query(
      `SELECT matched_dispatch_order_line_id FROM grn_line WHERE grn_line_id = $1`,
      [grnLineId],
    );
    assert.strictEqual(row.rows[0]!['matched_dispatch_order_line_id'], earlySo);
  });

  it('Task 3.5: two receipts racing for the last demand produce one reservation and one safe fallback', async () => {
    const raceSku = `${sku}-RACE`;
    const poA = `PO-RACE-A-${run}`;
    const poB = `PO-RACE-B-${run}`;
    const correlationA = randomUUID();
    const correlationB = randomUUID();
    const grnLineA = randomUUID();
    const grnLineB = randomUUID();
    await seedItem(raceSku);
    await seedPo(poA, raceSku, '5');
    await seedPo(poB, raceSku, '5');
    await seedSalesOrder(raceSku, randomUUID(), `SO-RACE-${run}`, '5', '2026-08-01');
    await seedWeighment(poA, correlationA);
    await seedWeighment(poB, correlationB);

    await Promise.all([
      receiveCrossDock({
        poRef: poA,
        correlationId: correlationA,
        grnId: randomUUID(),
        grnLineId: grnLineA,
        taskId: randomUUID(),
        lotNumber: `LOT-RACE-A-${run}`,
        qty: '5.000',
        sku: raceSku,
        stagingSelector: { staging_zone_id: stagingZoneId },
        occurredAt: '2026-07-31T09:07:00.000Z',
      }),
      receiveCrossDock({
        poRef: poB,
        correlationId: correlationB,
        grnId: randomUUID(),
        grnLineId: grnLineB,
        taskId: randomUUID(),
        lotNumber: `LOT-RACE-B-${run}`,
        qty: '5.000',
        sku: raceSku,
        stagingSelector: { staging_zone_id: stagingZoneId },
        occurredAt: '2026-07-31T09:07:00.000Z',
      }),
    ]);

    const result = await getPool().query(
      `SELECT COUNT(*) FILTER (WHERE cross_dock)::int AS qualified,
              COUNT(*) FILTER (WHERE NOT cross_dock AND cross_dock_nonqualification_reason = 'insufficient_single_line_demand')::int AS fallback,
              (SELECT COUNT(*)::int FROM cross_dock_task WHERE grn_line_id = ANY($1::uuid[])) AS tasks,
              (SELECT COUNT(*)::int FROM putaway_task WHERE grn_line_id = ANY($1::uuid[])) AS putaways
         FROM grn_line WHERE grn_line_id = ANY($1::uuid[])`,
      [[grnLineA, grnLineB]],
    );
    assert.deepStrictEqual(result.rows[0], { qualified: 1, fallback: 1, tasks: 1, putaways: 1 });
  });

  it('Task 4: assignment requires a supervisor role and cannot be stolen', async () => {
    const assignSku = `${sku}-ASSIGN`;
    const poRef = `PO-ASSIGN-${run}`;
    const correlationId = randomUUID();
    const grnLineId = randomUUID();
    const taskId = randomUUID();
    const soId = randomUUID();
    await seedItem(assignSku);
    await seedPo(poRef, assignSku, '100');
    await seedSalesOrder(assignSku, soId, `SO-ASSIGN-${run}`, '4', '2026-08-01');
    await seedWeighment(poRef, correlationId);
    await receiveCrossDock({
      poRef,
      correlationId,
      grnId: randomUUID(),
      grnLineId,
      taskId,
      lotNumber: `LOT-ASSIGN-${run}`,
      qty: '4.000',
      sku: assignSku,
      stagingSelector: { staging_zone_id: stagingZoneId },
      occurredAt: '2026-07-31T09:10:00.000Z',
    });

    // Wrong role (store_assistant) cannot assign.
    await assert.rejects(
      persistEvent({
        event_id: randomUUID(),
        stream_type: 'warehouse',
        stream_id: taskId,
        event_type: 'cross_dock_task.assigned',
        payload: { cross_dock_task_id: taskId, assigned_to: operatorId },
        metadata: {
          correlation_id: correlationId,
          actor: actor(receiverId, 'store_assistant'),
          occurred_at: '2026-07-31T09:11:00.000Z',
        },
      }),
      isCode('FUNCTION_ACCESS_DENIED'),
    );

    // Controller assigns to operator1.
    await persistEvent({
      event_id: randomUUID(),
      stream_type: 'warehouse',
      stream_id: taskId,
      event_type: 'cross_dock_task.assigned',
      payload: { cross_dock_task_id: taskId, assigned_to: operatorId },
      metadata: {
        correlation_id: correlationId,
        actor: actor(controllerId, 'inventory_controller'),
        occurred_at: '2026-07-31T09:12:00.000Z',
      },
    });

    // A second manager assignment to a DIFFERENT operator must not steal the task.
    await assert.rejects(
      persistEvent({
        event_id: randomUUID(),
        stream_type: 'warehouse',
        stream_id: taskId,
        event_type: 'cross_dock_task.assigned',
        payload: { cross_dock_task_id: taskId, assigned_to: operator2Id },
        metadata: {
          correlation_id: correlationId,
          actor: actor(managerId, 'warehouse_manager'),
          occurred_at: '2026-07-31T09:13:00.000Z',
        },
      }),
      isCode('CROSS_DOCK_TASK_NOT_READY'),
    );
    const assigned = await getPool().query(
      `SELECT assigned_to FROM cross_dock_task WHERE cross_dock_task_id = $1`,
      [taskId],
    );
    assert.strictEqual(assigned.rows[0]!['assigned_to'], operatorId);

    await getPool().query(`UPDATE users SET active = false WHERE user_id = $1`, [operatorId]);
    await assert.rejects(
      persistEvent({
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
          occurred_at: '2026-07-31T09:14:00.000Z',
        },
      }),
      isCode('FUNCTION_ACCESS_DENIED'),
    );
    await getPool().query(`UPDATE users SET active = true WHERE user_id = $1`, [operatorId]);
  });

  it('Task 5: completion is rejected for a supervisor role, a held lot, and a non-staging destination', async () => {
    const compSku = `${sku}-COMP`;
    const poRef = `PO-COMP-${run}`;
    const correlationId = randomUUID();
    const grnLineId = randomUUID();
    const taskId = randomUUID();
    const soId = randomUUID();
    const lotNumber = `LOT-COMP-${run}`;
    await seedItem(compSku);
    await seedPo(poRef, compSku, '100');
    await seedSalesOrder(compSku, soId, `SO-COMP-${run}`, '6', '2026-08-01');
    await seedWeighment(poRef, correlationId);
    await receiveCrossDock({
      poRef,
      correlationId,
      grnId: randomUUID(),
      grnLineId,
      taskId,
      lotNumber,
      qty: '6.000',
      sku: compSku,
      stagingSelector: { staging_zone_code: `STAGE-310E-${run}` },
      occurredAt: '2026-07-31T09:20:00.000Z',
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
        occurred_at: '2026-07-31T09:21:00.000Z',
      },
    });

    // Supervisor role cannot complete.
    await assert.rejects(
      persistEvent({
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
          actor: actor(managerId, 'warehouse_manager'),
          occurred_at: '2026-07-31T09:22:00.000Z',
        },
      }),
      isCode('FUNCTION_ACCESS_DENIED'),
    );

    // Zone row itself is not an acceptable destination bin.
    await assert.rejects(
      persistEvent({
        event_id: randomUUID(),
        stream_type: 'warehouse',
        stream_id: taskId,
        event_type: 'cross_dock_task.completed',
        payload: {
          cross_dock_task_id: taskId,
          to_location_id: stagingZoneId,
          pick_task_id: randomUUID(),
          pick_line_id: randomUUID(),
        },
        metadata: {
          correlation_id: correlationId,
          actor: actor(operatorId, 'warehouse_operator'),
          occurred_at: '2026-07-31T09:23:00.000Z',
        },
      }),
      isCode('CROSS_DOCK_DESTINATION_OUTSIDE_STAGING'),
    );

    // A bin outside the staging zone (general zone descendant) is rejected.
    await assert.rejects(
      persistEvent({
        event_id: randomUUID(),
        stream_type: 'warehouse',
        stream_id: taskId,
        event_type: 'cross_dock_task.completed',
        payload: {
          cross_dock_task_id: taskId,
          to_location_id: generalBinId,
          pick_task_id: randomUUID(),
          pick_line_id: randomUUID(),
        },
        metadata: {
          correlation_id: correlationId,
          actor: actor(operatorId, 'warehouse_operator'),
          occurred_at: '2026-07-31T09:24:00.000Z',
        },
      }),
      isCode('CROSS_DOCK_DESTINATION_OUTSIDE_STAGING'),
    );

    // Clock-skewed completion earlier than creation is rejected.
    await assert.rejects(
      persistEvent({
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
          occurred_at: '2026-07-30T00:00:00.000Z',
        },
      }),
      (error: unknown) => error instanceof Error,
    );

    // Put the lot on hold; completion must be rejected LOT_ON_HOLD.
    await getPool().query(
      `UPDATE lot_master SET quality_hold_status = 'held' WHERE lot_number = $1 AND sku = $2`,
      [lotNumber, compSku],
    );
    await assert.rejects(
      persistEvent({
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
          occurred_at: '2026-07-31T09:25:00.000Z',
        },
      }),
      isCode('LOT_ON_HOLD'),
    );

    // Nothing partially applied: task still ready, no pick rows, no staging stock.
    const state = await getPool().query(
      `SELECT (SELECT status FROM cross_dock_task WHERE cross_dock_task_id = $1) AS status,
              (SELECT COUNT(*)::int FROM pick_line WHERE cross_dock_task_id = $1) AS pick_lines,
              (SELECT COALESCE(SUM(picked),0)::text FROM stock_balance WHERE sku = $2 AND location_id = $3) AS staged`,
      [taskId, compSku, stagingBinId],
    );
    assert.strictEqual(state.rows[0]!['status'], 'ready');
    assert.strictEqual(state.rows[0]!['pick_lines'], 0);
    assert.strictEqual(state.rows[0]!['staged'], '0');
  });

  it('Task 5 / AC5: closed order line during completion returns CROSS_DOCK_ORDER_NOT_OPEN', async () => {
    const closedSku = `${sku}-CLOSED`;
    const poRef = `PO-CLOSED-${run}`;
    const correlationId = randomUUID();
    const grnLineId = randomUUID();
    const taskId = randomUUID();
    const soId = randomUUID();
    const lotNumber = `LOT-CLOSED-${run}`;
    await seedItem(closedSku);
    await seedPo(poRef, closedSku, '100');
    await seedSalesOrder(closedSku, soId, `SO-CLOSED-${run}`, '3', '2026-08-01');
    await seedWeighment(poRef, correlationId);
    await receiveCrossDock({
      poRef,
      correlationId,
      grnId: randomUUID(),
      grnLineId,
      taskId,
      lotNumber,
      qty: '3.000',
      sku: closedSku,
      stagingSelector: { staging_zone_id: stagingZoneId },
      occurredAt: '2026-07-31T09:30:00.000Z',
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
        occurred_at: '2026-07-31T09:31:00.000Z',
      },
    });
    await getPool().query(`UPDATE erp_sales_order SET status = 'closed' WHERE id = $1`, [soId]);
    await assert.rejects(
      persistEvent({
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
          occurred_at: '2026-07-31T09:32:00.000Z',
        },
      }),
      isCode('CROSS_DOCK_ORDER_NOT_OPEN'),
    );
  });
});
