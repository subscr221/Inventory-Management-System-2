import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../../src/config/db.js';
import { persistEvent } from '../../src/events/store.js';
import { computeConfirmationRate, listOpenTasks } from '../../src/warehouse/task-metrics.js';

const run = randomUUID().slice(0, 8);
const siteId = randomUUID();
const receivingLocationId = randomUUID();
const stagingZoneId = randomUUID();
const stagingBinId = randomUUID();
const receiverId = randomUUID();
const managerId = randomUUID();
const operatorId = randomUUID();
const sku = `SKU-310-${run}`;

async function seedUser(userId: string, role: string): Promise<void> {
  await getPool().query(
    `INSERT INTO users (user_id, external_id, email, active) VALUES ($1, $2, $2, true)`,
    [userId, `${role}-${run}@example.com`],
  );
  await getPool().query(
    `INSERT INTO user_role_assignments (user_id, role, module, function_scope, location_id) VALUES ($1, $2, 'warehouse', 'write', $3)`,
    [userId, role, siteId],
  );
}

function actor(
  userId: string,
  role: string,
): { user_id: string; role: string; location_id: string } {
  return { user_id: userId, role, location_id: siteId };
}

describe('Story 3.10 Tasks 3-5 cross-dock transaction', () => {
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
        `SITE-310-${run}`,
        receivingLocationId,
        `RECV-310-${run}`,
        stagingZoneId,
        `STAGE-310-${run}`,
        stagingBinId,
        `STAGE-BIN-310-${run}`,
      ],
    );
    await Promise.all([
      seedUser(receiverId, 'store_assistant'),
      seedUser(managerId, 'warehouse_manager'),
      seedUser(operatorId, 'warehouse_operator'),
    ]);
    await getPool().query(
      `INSERT INTO item_master
         (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ($1, 'EA', false, false, false, false, false, 'weighted_average', 'production', 'active')`,
      [sku],
    );
  });

  after(async () => {
    await closePool();
  });

  it('falls back to ordinary putaway with a bounded reason when no same-site demand qualifies', async () => {
    const poRef = `PO-310-FALLBACK-${run}`;
    const correlationId = randomUUID();
    const grnId = randomUUID();
    const grnLineId = randomUUID();
    await getPool().query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, status, source_system, last_synced_at)
       VALUES ($1, 'SUP-310', 'INR', 'open', 'ERP', now())`,
      [poRef],
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, source_system, last_synced_at)
       VALUES ($1, 1, $2, 2, 2, 1, 'ERP', now())`,
      [poRef, sku],
    );
    await getPool().query(
      `INSERT INTO weighbridge_event
         (weighbridge_event_id, correlation_id, gate_event_id, site_id, site_code_ext, po_ref_ext, line_no,
          tare_kg, gross_kg, net_kg, status, device_id, capture_method, weighed_by, business_date, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1, 3, 2, 'accepted', 'WB-310', 'MANUAL', $7, '2026-07-31', $8)`,
      [
        randomUUID(),
        correlationId,
        randomUUID(),
        siteId,
        `SITE-310-${run}`,
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
        received_qty: '2.000',
        lot_id: `LOT-310-FALLBACK-${run}`,
        cross_dock: true,
        staging_zone_id: stagingZoneId,
        cross_dock_task_id: randomUUID(),
      },
      metadata: {
        correlation_id: correlationId,
        actor: actor(receiverId, 'store_assistant'),
        occurred_at: '2026-07-31T07:00:00.000Z',
      },
    });
    const outcome = await getPool().query(
      `SELECT gl.cross_dock, gl.cross_dock_nonqualification_reason,
              EXISTS (SELECT 1 FROM putaway_task pt WHERE pt.grn_line_id = gl.grn_line_id) AS has_putaway,
              EXISTS (SELECT 1 FROM cross_dock_task cdt WHERE cdt.grn_line_id = gl.grn_line_id) AS has_cross_dock
         FROM grn_line gl WHERE gl.grn_line_id = $1`,
      [grnLineId],
    );
    assert.deepStrictEqual(outcome.rows[0], {
      cross_dock: false,
      cross_dock_nonqualification_reason: 'no_open_demand',
      has_putaway: true,
      has_cross_dock: false,
    });
  });

  it('rejects an invalid staging selector before receipt, stock, or task writes', async () => {
    const poRef = `PO-310-INVALID-${run}`;
    const correlationId = randomUUID();
    const grnId = randomUUID();
    const grnLineId = randomUUID();
    await getPool().query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, status, source_system, last_synced_at)
       VALUES ($1, 'SUP-310', 'INR', 'open', 'ERP', now())`,
      [poRef],
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, source_system, last_synced_at)
       VALUES ($1, 1, $2, 1, 1, 1, 'ERP', now())`,
      [poRef, sku],
    );
    await getPool().query(
      `INSERT INTO weighbridge_event
         (weighbridge_event_id, correlation_id, gate_event_id, site_id, site_code_ext, po_ref_ext, line_no,
          tare_kg, gross_kg, net_kg, status, device_id, capture_method, weighed_by, business_date, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1, 2, 1, 'accepted', 'WB-310', 'MANUAL', $7, '2026-07-31', $8)`,
      [
        randomUUID(),
        correlationId,
        randomUUID(),
        siteId,
        `SITE-310-${run}`,
        poRef,
        receiverId,
        randomUUID(),
      ],
    );
    await assert.rejects(
      persistEvent({
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
          received_qty: '1.000',
          lot_id: `LOT-310-INVALID-${run}`,
          cross_dock: true,
          staging_zone_id: receivingLocationId,
          cross_dock_task_id: randomUUID(),
        },
        metadata: {
          correlation_id: correlationId,
          actor: actor(receiverId, 'store_assistant'),
          occurred_at: '2026-07-31T07:30:00.000Z',
        },
      }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'errorCode' in error &&
        error.errorCode === 'CROSS_DOCK_STAGING_INVALID',
    );
    const writes = await getPool().query(
      `SELECT
         (SELECT COUNT(*)::int FROM grn_line WHERE grn_line_id = $1) AS grn_lines,
         (SELECT COUNT(*)::int FROM stock_balance WHERE sku = $2 AND lot_id = $3) AS balances`,
      [grnLineId, sku, `LOT-310-INVALID-${run}`],
    );
    assert.deepStrictEqual(writes.rows[0], { grn_lines: 0, balances: 0 });
  });

  it('qualifies deterministically, assigns centrally, and completes stock plus fulfillment atomically', async () => {
    const poRef = `PO-310-${run}`;
    const soId = randomUUID();
    const correlationId = randomUUID();
    const grnId = randomUUID();
    const grnLineId = randomUUID();
    const taskId = randomUUID();
    const lotNumber = `LOT-310-${run}`;
    const receivedAt = '2026-07-31T08:00:00.000Z';
    const completedAt = '2026-07-31T08:05:00.000Z';

    await getPool().query(
      `INSERT INTO erp_purchase_order
         (po_number_ext, supplier_ref_ext, currency, status, source_system, last_synced_at)
       VALUES ($1, 'SUP-310', 'INR', 'open', 'ERP', now())`,
      [poRef],
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order_line
         (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, source_system, last_synced_at)
       VALUES ($1, 1, $2, 10, 10, 1, 'ERP', now())`,
      [poRef, sku],
    );
    await getPool().query(
      `INSERT INTO erp_sales_order
         (id, so_number_ext, line_no, sku, quantity, required_by, ship_from_site_id, ship_from_site_code_ext, status, source_system, last_synced_at)
       VALUES ($1, $2, 1, $3, 10, '2026-08-01', $4, $5, 'open', 'ERP', now())`,
      [soId, `SO-310-${run}`, sku, siteId, `SITE-310-${run}`],
    );
    await getPool().query(
      `INSERT INTO weighbridge_event
         (weighbridge_event_id, correlation_id, gate_event_id, site_id, site_code_ext, po_ref_ext, line_no,
          tare_kg, gross_kg, net_kg, status, device_id, capture_method, weighed_by, business_date, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1, 11, 10, 'accepted', 'WB-310', 'MANUAL', $7, '2026-07-31', $8)`,
      [
        randomUUID(),
        correlationId,
        randomUUID(),
        siteId,
        `SITE-310-${run}`,
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
        occurred_at: receivedAt,
      },
    });

    const receipt = await getPool().query(
      `SELECT gl.cross_dock, gl.matched_dispatch_order_line_id, cdt.status, cdt.quantity::text
         FROM grn_line gl JOIN cross_dock_task cdt ON cdt.grn_line_id = gl.grn_line_id
        WHERE gl.grn_line_id = $1`,
      [grnLineId],
    );
    assert.deepStrictEqual(receipt.rows[0], {
      cross_dock: true,
      matched_dispatch_order_line_id: soId,
      status: 'ready',
      quantity: '10.000',
    });
    const putaway = await getPool().query(`SELECT 1 FROM putaway_task WHERE grn_line_id = $1`, [
      grnLineId,
    ]);
    assert.strictEqual(putaway.rows.length, 0);

    await persistEvent({
      event_id: randomUUID(),
      stream_type: 'warehouse',
      stream_id: taskId,
      event_type: 'cross_dock_task.assigned',
      payload: { cross_dock_task_id: taskId, assigned_to: operatorId, assigned_by: receiverId },
      metadata: {
        correlation_id: correlationId,
        actor: actor(managerId, 'warehouse_manager'),
        occurred_at: '2026-07-31T08:01:00.000Z',
      },
    });

    const readyBoard = await listOpenTasks({
      siteId,
      taskType: 'cross_docking',
      zoneId: stagingZoneId,
    });
    const readyTask = readyBoard.tasks.filter((row) => row.task_id === taskId);
    assert.equal(readyTask.length, 1);
    assert.equal(readyTask[0]!.assigned_to, operatorId);
    assert.equal(readyTask[0]!.zone_id, stagingZoneId);
    const pendingProductivity = await computeConfirmationRate({
      periodStart: '2026-07-31T07:59:59.999Z',
      periodEnd: '2026-07-31T08:00:00.001Z',
      siteId,
      zoneId: stagingZoneId,
      operatorId,
    });
    assert.equal(pendingProductivity.by_operator[0]?.assigned_count, 1);
    assert.equal(pendingProductivity.by_operator[0]?.completed_count, 0);
    assert.equal(pendingProductivity.by_operator[0]?.avg_duration_seconds, null);

    const completionEventId = randomUUID();
    const pickTaskId = randomUUID();
    const pickLineId = randomUUID();
    await persistEvent({
      event_id: completionEventId,
      stream_type: 'warehouse',
      stream_id: taskId,
      event_type: 'cross_dock_task.completed',
      payload: {
        cross_dock_task_id: taskId,
        to_location_id: stagingBinId,
        pick_task_id: pickTaskId,
        pick_line_id: pickLineId,
        completed_by: managerId,
      },
      metadata: {
        correlation_id: correlationId,
        actor: actor(operatorId, 'warehouse_operator'),
        device_id: `DEV-${run}`,
        occurred_at: completedAt,
      },
    });

    const completed = await getPool().query(
      `SELECT cdt.status, cdt.completed_by, cdt.completed_at, pt.status AS pick_status, pt.fulfillment_source,
              pl.status AS line_status, pl.confirmed_quantity::text, pl.confirmed_location_id, dos.picked_at
         FROM cross_dock_task cdt
         JOIN pick_task pt ON pt.pick_task_id = $2
         JOIN pick_line pl ON pl.pick_line_id = $3
         JOIN dispatch_order_status dos ON dos.dispatch_order_id = cdt.dispatch_order_line_id
        WHERE cdt.cross_dock_task_id = $1`,
      [taskId, pickTaskId, pickLineId],
    );
    assert.strictEqual(completed.rows[0]!['status'], 'completed');
    assert.strictEqual(completed.rows[0]!['completed_by'], operatorId);
    assert.strictEqual(
      new Date(completed.rows[0]!['completed_at'] as string).toISOString(),
      completedAt,
    );
    assert.strictEqual(completed.rows[0]!['pick_status'], 'completed');
    assert.strictEqual(completed.rows[0]!['fulfillment_source'], 'cross_dock');
    assert.strictEqual(completed.rows[0]!['line_status'], 'confirmed');
    assert.strictEqual(completed.rows[0]!['confirmed_quantity'], '10.000');
    assert.strictEqual(completed.rows[0]!['confirmed_location_id'], stagingBinId);
    assert.strictEqual(
      new Date(completed.rows[0]!['picked_at'] as string).toISOString(),
      completedAt,
    );

    const balances = await getPool().query(
      `SELECT location_id, on_hand::text, allocated::text, picked::text FROM stock_balance WHERE sku = $1 AND lot_id = $2 ORDER BY location_id`,
      [sku, lotNumber],
    );
    assert.deepStrictEqual(
      balances.rows.map((row) => [
        row['location_id'],
        row['on_hand'],
        row['allocated'],
        row['picked'],
      ]),
      [
        [receivingLocationId, '0.000000', '0.000000', '0.000000'],
        [stagingBinId, '10.000000', '0.000000', '10.000000'],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );

    const identicalClient = await getPool().connect();
    try {
      await identicalClient.query('BEGIN');
      await assert.rejects(
        persistEvent(
          {
            event_id: completionEventId,
            stream_type: 'warehouse',
            stream_id: taskId,
            event_type: 'cross_dock_task.completed',
            payload: {
              cross_dock_task_id: taskId,
              to_location_id: stagingBinId,
              pick_task_id: pickTaskId,
              pick_line_id: pickLineId,
            },
            metadata: {
              correlation_id: correlationId,
              actor: actor(operatorId, 'warehouse_operator'),
              device_id: `DEV-${run}`,
              occurred_at: completedAt,
            },
          },
          undefined,
          identicalClient,
        ),
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          'errorCode' in error &&
          error.errorCode === 'DUPLICATE_EVENT',
      );
      await identicalClient.query('ROLLBACK');
    } finally {
      identicalClient.release();
    }

    const conflictingClient = await getPool().connect();
    try {
      await conflictingClient.query('BEGIN');
      await assert.rejects(
        persistEvent(
          {
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
              device_id: `DEV-${run}`,
              occurred_at: completedAt,
            },
          },
          undefined,
          conflictingClient,
        ),
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          'errorCode' in error &&
          error.errorCode === 'CROSS_DOCK_TASK_ALREADY_COMPLETED',
      );
      await conflictingClient.query('ROLLBACK');
    } finally {
      conflictingClient.release();
    }

    const afterReplay = await getPool().query(
      `SELECT on_hand::text, allocated::text, picked::text FROM stock_balance WHERE sku = $1 AND location_id = $2 AND lot_id = $3`,
      [sku, stagingBinId, lotNumber],
    );
    assert.deepStrictEqual(afterReplay.rows[0], {
      on_hand: '10.000000',
      allocated: '0.000000',
      picked: '10.000000',
    });

    const board = await listOpenTasks({ siteId, taskType: 'cross_docking' });
    assert.equal(
      board.tasks.some((row) => row.task_id === taskId),
      false,
      'completed cross-dock work must leave the open board',
    );

    const productivity = await computeConfirmationRate({
      periodStart: '2026-07-31T07:59:59.999Z',
      periodEnd: '2026-07-31T08:05:00.001Z',
      siteId,
      zoneId: stagingZoneId,
      operatorId,
    });
    assert.deepStrictEqual(productivity.by_operator, [
      {
        operator_id: operatorId,
        zone_id: null,
        assigned_count: 1,
        completed_count: 1,
        confirmation_rate: '1.0000',
        avg_duration_seconds: '300.000',
        median_duration_seconds: '300.000',
      },
    ]);
  });
});
