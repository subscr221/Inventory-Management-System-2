import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppServer } from '../../src/server.js';
import { closePool, getPool } from '../../src/config/db.js';
import { runDispatchCycle } from '../../src/notify/dispatch.js';

const SCIM_HEADERS = {
  Authorization: `Bearer ${process.env['SCIM_BEARER_TOKEN'] ?? ''}`,
};

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}

interface Role {
  role: string;
  module: string;
  functionScope: 'read' | 'write';
  locationId: string;
}

function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolvePromise, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        hostname: 'localhost',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: Record<string, unknown> = {};
          if (raw) {
            try {
              parsed = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              parsed = { error_code: 'NON_JSON_BODY' };
            }
          }
          resolvePromise({ status: res.statusCode ?? 0, body: parsed, raw });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
    if (data) req.write(data);
    req.end();
  });
}

async function provisionUser(port: number, externalId: string, roles: Role[]): Promise<string> {
  const res = await makeRequest(
    port,
    'POST',
    '/api/v1/scim/v2/Users',
    { externalId, email: externalId, displayName: externalId, roles },
    SCIM_HEADERS,
  );
  assert.strictEqual(res.status, 201, `provision ${externalId} failed: ${JSON.stringify(res.body)}`);
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub} failed: ${JSON.stringify(res.body)}`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

describe('Story 3.17 Short Pick Exception Seam and Tiles Integration Tests', () => {
  let server: Server;
  let port: number;
  let managerHeaders: Record<string, string>;
  let managerNoQcHeaders: Record<string, string>;
  let operatorHeaders: Record<string, string>;
  let operatorId: string;

  const siteId = randomUUID();
  const zoneId = randomUUID();
  const binId = randomUUID();
  let qcHoldId = randomUUID();
  const siteWithoutQcHoldId = randomUUID();
  const binWithoutQcHoldId = randomUUID();
  const run = randomUUID().slice(0, 8);

  async function seedLocation(
    locationId: string,
    code: string,
    level: string,
    parentId: string | null,
    sId: string,
    pickSequence: number | null = null,
    quarantine = false,
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO location_register
       (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class,
        size_class, hazmat_allowed, quarantine, access_restricted, status, pick_sequence)
       VALUES ($1, $2, $3, $4, $5, 'general', 'ambient', 'standard', false, $7, false, 'active', $6)`,
      [locationId, code, level, parentId, sId, pickSequence, quarantine],
    );
  }

  async function seedItem(sku: string, uom = 'EA'): Promise<void> {
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, valuation_method, business_stream, status)
       VALUES ($1, $2, true, false, 'fifo', 'finished_goods', 'active')
       ON CONFLICT (sku) DO NOTHING`,
      [sku, uom],
    );
  }

  async function seedLot(sku: string, lotNumber: string): Promise<string> {
    const result = await getPool().query(
      `INSERT INTO lot_master (lot_number, sku, expiry_date, quality_hold_status)
       VALUES ($1, $2, NULL, 'none') RETURNING lot_id`,
      [lotNumber, sku],
    );
    return result.rows[0]!['lot_id'] as string;
  }

  async function seedStock(
    sku: string,
    locationId: string,
    lotNumber: string,
    onHand: number,
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand)
       VALUES ($1, $2, $3, 'owned', $4)`,
      [sku, locationId, lotNumber, onHand],
    );
  }

  async function seedOrderLine(
    soNumber: string,
    lineNo: number,
    sku: string,
    quantity: number,
    targetSiteId = siteId,
  ): Promise<string> {
    const result = await getPool().query(
      `INSERT INTO erp_sales_order
       (so_number_ext, line_no, sku, quantity, ship_from_site_id, ship_from_site_code_ext, status, source_system, last_synced_at)
       VALUES ($1, $2, $3, $4, $5, 'site-317', 'open', 'ERP', now())
       RETURNING id`,
      [soNumber, lineNo, sku, quantity, targetSiteId],
    );
    return result.rows[0]!['id'] as string;
  }

  async function createTestTask(
    sku: string,
    lotNumber: string,
    qty = 10,
    targetSiteId = siteId,
    targetBinId = binId,
    mHeaders = managerHeaders,
  ): Promise<{ taskId: string; lineId: string; lotId: string }> {
    await seedItem(sku, 'EA');
    const lotId = await seedLot(sku, lotNumber);
    await seedStock(sku, targetBinId, lotNumber, 100);
    const orderLine = await seedOrderLine(`SO-317-${randomUUID().slice(0, 8)}`, 1, sku, qty, targetSiteId);

    const generated = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [orderLine], strategy: 'single' },
      mHeaders,
    );
    assert.strictEqual(generated.status, 201, JSON.stringify(generated.body));
    const taskId = (generated.body['pickTaskIds'] as string[])[0]!;

    const lineRes = await getPool().query(
      `SELECT pick_line_id FROM pick_line WHERE pick_task_id = $1`,
      [taskId],
    );
    const lineId = lineRes.rows[0]!['pick_line_id'] as string;
    return { taskId, lineId, lotId };
  }

  function shortPickEnvelope(
    taskId: string,
    lineId: string,
    foundQuantity: string | number,
    reason: string,
    note: string | null = null,
    actorLocationId = binId,
    actorUserId = operatorId,
  ): Record<string, unknown> {
    return {
      stream_type: 'warehouse',
      stream_id: taskId,
      event_type: 'pick_line.short_picked',
      payload: {
        pick_task_id: taskId,
        pick_line_id: lineId,
        found_quantity: foundQuantity,
        reason,
        ...(note !== null ? { note } : {}),
        capture_method: 'PWA',
      },
    metadata: {
      correlation_id: randomUUID(),
      device_id: 'DEV-317',
      actor: { user_id: actorUserId, role: 'warehouse_operator', location_id: actorLocationId },
      occurred_at: new Date().toISOString(),
    },
    };
  }

  before(async () => {
    server = createAppServer();
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.off('error', reject);
        port = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    // Seed sites & locations
    await seedLocation(siteId, `SITE-317-${run}`, 'site', null, siteId);
    await seedLocation(zoneId, `ZONE-317-${run}`, 'zone', siteId, siteId);
    await seedLocation(binId, `BIN-317-${run}`, 'bin', zoneId, siteId, 1);

    const existingQc = await getPool().query(
      `SELECT location_id FROM location_register WHERE UPPER(location_code) = 'ZONE-QC-HOLD'`,
    );
    if (existingQc.rows.length > 0) {
      qcHoldId = existingQc.rows[0].location_id;
      await getPool().query(
        `UPDATE location_register SET site_id = $1, quarantine = true, status = 'active' WHERE location_id = $2`,
        [siteId, qcHoldId],
      );
    } else {
      await seedLocation(qcHoldId, 'ZONE-QC-HOLD', 'zone', siteId, siteId, null, true);
    }

    // Site without ZONE-QC-HOLD
    const zoneWithoutQcHoldId = randomUUID();
    await seedLocation(siteWithoutQcHoldId, `SITE-NOQC-${run}`, 'site', null, siteWithoutQcHoldId);
    await seedLocation(zoneWithoutQcHoldId, `ZONE-NOQC-${run}`, 'zone', siteWithoutQcHoldId, siteWithoutQcHoldId);
    await seedLocation(binWithoutQcHoldId, `BIN-NOQC-${run}`, 'bin', zoneWithoutQcHoldId, siteWithoutQcHoldId, 1);

    await provisionUser(port, `manager-317-${run}@example.com`, [
      { role: 'warehouse_manager', module: 'warehouse', functionScope: 'write', locationId: siteId },
    ]);
    managerHeaders = await authFor(port, `manager-317-${run}@example.com`);

    await provisionUser(port, `manager-noqc-${run}@example.com`, [
      { role: 'warehouse_manager', module: 'warehouse', functionScope: 'write', locationId: siteWithoutQcHoldId },
    ]);
    managerNoQcHeaders = await authFor(port, `manager-noqc-${run}@example.com`);

    operatorId = await provisionUser(port, `operator-317-${run}@example.com`, [
      { role: 'warehouse_operator', module: 'warehouse', functionScope: 'write', locationId: siteId },
    ]);
    operatorHeaders = await authFor(port, `operator-317-${run}@example.com`);

    await provisionUser(port, `planner-317-${run}@example.com`, [
      { role: 'production_planner', module: 'production', functionScope: 'write', locationId: siteId },
    ]);
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
  });

  it('BIN_EMPTY: records short pick with found=0, relieves allocation, completes task', async () => {
    const sku = `SKU-BE-${run}`;
    const lotNumber = `LOT-BE-${run}`;
    const { taskId, lineId } = await createTestTask(sku, lotNumber, 10);

    // Initial stock allocated = 10
    const initialStock = await getPool().query(
      `SELECT allocated::text FROM stock_balance WHERE sku = $1 AND location_id = $2 AND lot_id = $3`,
      [sku, binId, lotNumber],
    );
    assert.strictEqual(parseFloat(initialStock.rows[0].allocated), 10);

    const env = shortPickEnvelope(taskId, lineId, '0.000', 'BIN_EMPTY');
    const res = await makeRequest(port, 'POST', '/api/v1/events', env, operatorHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    // Verify pick_line
    const lineRes = await getPool().query(`SELECT status, confirmed_quantity::text FROM pick_line WHERE pick_line_id = $1`, [lineId]);
    assert.strictEqual(lineRes.rows[0].status, 'short');
    assert.strictEqual(parseFloat(lineRes.rows[0].confirmed_quantity), 0);

    // Verify pick_shortfall
    const sfRes = await getPool().query(`SELECT * FROM pick_shortfall WHERE pick_line_id = $1`, [lineId]);
    assert.strictEqual(sfRes.rows.length, 1);
    assert.strictEqual(sfRes.rows[0].reason, 'BIN_EMPTY');
    assert.strictEqual(parseFloat(sfRes.rows[0].directed_quantity), 10);
    assert.strictEqual(parseFloat(sfRes.rows[0].found_quantity), 0);

    // Verify task completion
    const taskRes = await getPool().query(`SELECT status FROM pick_task WHERE pick_task_id = $1`, [taskId]);
    assert.strictEqual(taskRes.rows[0].status, 'completed');

    // Stock balance: allocated was 10, shortfall 10 was relieved -> allocated = 0, picked = 0
    const finalStock = await getPool().query(
      `SELECT allocated::text, picked::text FROM stock_balance WHERE sku = $1 AND location_id = $2 AND lot_id = $3`,
      [sku, binId, lotNumber],
    );
    assert.strictEqual(parseFloat(finalStock.rows[0].allocated), 0);
    assert.strictEqual(parseFloat(finalStock.rows[0].picked), 0);
  });

  it('BIN_EMPTY rejects a non-zero found quantity (400 PICK_SHORT_QUANTITY_INVALID)', async () => {
    const sku = `SKU-BE-NZ-${run}`;
    const lotNumber = `LOT-BE-NZ-${run}`;
    const { taskId, lineId } = await createTestTask(sku, lotNumber, 10);

    const env = shortPickEnvelope(taskId, lineId, '1.000', 'BIN_EMPTY');
    const res = await makeRequest(port, 'POST', '/api/v1/events', env, operatorHeaders);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body['error_code'], 'PICK_SHORT_QUANTITY_INVALID');
  });

  it('LESS_IN_BIN: relieves remainder allocation, moves found quantity to picked on completion', async () => {
    const sku = `SKU-LIB-${run}`;
    const lotNumber = `LOT-LIB-${run}`;
    const { taskId, lineId } = await createTestTask(sku, lotNumber, 10);

    const env = shortPickEnvelope(taskId, lineId, '4.000', 'LESS_IN_BIN');
    const res = await makeRequest(port, 'POST', '/api/v1/events', env, operatorHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    // After task completion: found 4 was moved to picked, 6 was released -> allocated = 0, picked = 4
    const finalStock = await getPool().query(
      `SELECT allocated::text, picked::text FROM stock_balance WHERE sku = $1 AND location_id = $2 AND lot_id = $3`,
      [sku, binId, lotNumber],
    );
    assert.strictEqual(parseFloat(finalStock.rows[0].allocated), 0);
    assert.strictEqual(parseFloat(finalStock.rows[0].picked), 4);

    const sfRes = await getPool().query(`SELECT * FROM pick_shortfall WHERE pick_line_id = $1`, [lineId]);
    assert.strictEqual(sfRes.rows[0].reason, 'LESS_IN_BIN');
    assert.strictEqual(parseFloat(sfRes.rows[0].found_quantity), 4);
  });

  it('OTHER with note succeeds; OTHER without note or blank note is rejected (400 PICK_SHORT_NOTE_REQUIRED)', async () => {
    const sku = `SKU-OTH-${run}`;
    const lotNumber = `LOT-OTH-${run}`;
    const { taskId, lineId } = await createTestTask(sku, lotNumber, 10);

    // Blank note rejected
    const blankEnv = shortPickEnvelope(taskId, lineId, '3.000', 'OTHER', '   ');
    const blankRes = await makeRequest(port, 'POST', '/api/v1/events', blankEnv, operatorHeaders);
    assert.strictEqual(blankRes.status, 400);
    assert.strictEqual(blankRes.body['error_code'], 'PICK_SHORT_NOTE_REQUIRED');

    // Valid note succeeds
    const validEnv = shortPickEnvelope(taskId, lineId, '3.000', 'OTHER', 'Item crushed behind racking');
    const validRes = await makeRequest(port, 'POST', '/api/v1/events', validEnv, operatorHeaders);
    assert.strictEqual(validRes.status, 201, JSON.stringify(validRes.body));

    const sfRes = await getPool().query(`SELECT note FROM pick_shortfall WHERE pick_line_id = $1`, [lineId]);
    assert.strictEqual(sfRes.rows[0].note, 'Item crushed behind racking');
  });

  it('found equal to directed is PICK_SHORT_QUANTITY_INVALID on short event', async () => {
    const sku = `SKU-EQ-${run}`;
    const lotNumber = `LOT-EQ-${run}`;
    const { taskId, lineId } = await createTestTask(sku, lotNumber, 10);

    const env = shortPickEnvelope(taskId, lineId, '10.000', 'LESS_IN_BIN');
    const res = await makeRequest(port, 'POST', '/api/v1/events', env, operatorHeaders);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body['error_code'], 'PICK_SHORT_QUANTITY_INVALID');
  });

  it('idempotent replay returns 201/200 without second stock move or shortfall row; conflicting replay is 409', async () => {
    const sku = `SKU-REP-${run}`;
    const lotNumber = `LOT-REP-${run}`;
    const { taskId, lineId } = await createTestTask(sku, lotNumber, 10);

    const env = shortPickEnvelope(taskId, lineId, '5.000', 'LESS_IN_BIN');
    const res1 = await makeRequest(port, 'POST', '/api/v1/events', env, operatorHeaders);
    assert.strictEqual(res1.status, 201);

    // Exact replay
    const res2 = await makeRequest(port, 'POST', '/api/v1/events', env, operatorHeaders);
    assert.ok(res2.status >= 200 && res2.status < 300);

    // Conflicting replay with different found quantity
    const conflictEnv = shortPickEnvelope(taskId, lineId, '3.000', 'LESS_IN_BIN');
    const res3 = await makeRequest(port, 'POST', '/api/v1/events', conflictEnv, operatorHeaders);
    assert.strictEqual(res3.status, 409);
    assert.strictEqual(res3.body['error_code'], 'PICK_LINE_ALREADY_CONFIRMED');
  });

  it('DAMAGED creates in_qc_hold damage report and relocates short units to ZONE-QC-HOLD', async () => {
    const sku = `SKU-DMG-${run}`;
    const lotNumber = `LOT-DMG-${run}`;
    const { taskId, lineId } = await createTestTask(sku, lotNumber, 10);

    const env = shortPickEnvelope(taskId, lineId, '2.000', 'DAMAGED');
    const res = await makeRequest(port, 'POST', '/api/v1/events', env, operatorHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    // Check damage_report row
    const dmgRes = await getPool().query(
      `SELECT * FROM damage_report WHERE source_pick_line_id = $1`,
      [lineId],
    );
    assert.strictEqual(dmgRes.rows.length, 1);
    assert.strictEqual(dmgRes.rows[0].source, 'pick');
    assert.strictEqual(dmgRes.rows[0].reason_code, 'DAMAGED_COMPONENT');
    assert.strictEqual(dmgRes.rows[0].physical_state, 'in_qc_hold');
    assert.strictEqual(dmgRes.rows[0].hold_mode, 'quarantined');
    assert.strictEqual(parseFloat(dmgRes.rows[0].quantity), 8); // 10 directed - 2 found = 8 damaged
    assert.strictEqual(dmgRes.rows[0].photo_attachment_id, null);

    // Check stock balance at ZONE-QC-HOLD
    const qcStock = await getPool().query(
      `SELECT on_hand::text FROM stock_balance WHERE sku = $1 AND location_id = $2 AND lot_id = $3`,
      [sku, qcHoldId, lotNumber],
    );
    assert.strictEqual(parseFloat(qcStock.rows[0].on_hand), 8);
  });

  it('DAMAGED rolls back with 409 PICK_SHORT_QC_HOLD_MISSING when site has no active quarantine zone', async () => {
    // Provision operator for the site without QC hold
    const opId = await provisionUser(port, `operator-noqc-${run}@example.com`, [
      { role: 'warehouse_operator', module: 'warehouse', functionScope: 'write', locationId: siteWithoutQcHoldId },
    ]);
    const opHeaders = await authFor(port, `operator-noqc-${run}@example.com`);

    const sku = `SKU-NOQC-${run}`;
    const lotNumber = `LOT-NOQC-${run}`;
    const { taskId, lineId } = await createTestTask(
      sku,
      lotNumber,
      10,
      siteWithoutQcHoldId,
      binWithoutQcHoldId,
      managerNoQcHeaders,
    );

    const env = shortPickEnvelope(taskId, lineId, '2.000', 'DAMAGED', null, siteWithoutQcHoldId, opId);
    const res = await makeRequest(port, 'POST', '/api/v1/events', env, opHeaders);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'PICK_SHORT_QC_HOLD_MISSING');

    // Verify transaction rolled back: pick_line is still pending
    const lineRes = await getPool().query(`SELECT status FROM pick_line WHERE pick_line_id = $1`, [lineId]);
    assert.strictEqual(lineRes.rows[0].status, 'pending');
  });

  it('notifications: emits one pick_shortfall_recorded notification for production_planner and pick_task_completed for warehouse_manager', async () => {
    const sku = `SKU-NOTIF-${run}`;
    const lotNumber = `LOT-NOTIF-${run}`;
    const { taskId, lineId } = await createTestTask(sku, lotNumber, 10);

    const env = shortPickEnvelope(taskId, lineId, '5.000', 'LESS_IN_BIN');
    const res = await makeRequest(port, 'POST', '/api/v1/events', env, operatorHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    // Run notification dispatch cycle to fan out notifications
    await runDispatchCycle(1000);

    // Check planner notification
    const plannerNotif = await getPool().query(
      `SELECT * FROM notifications WHERE event_type = 'pick_shortfall_recorded' AND object_id = $1`,
      [taskId],
    );
    assert.strictEqual(plannerNotif.rows.length, 1);
    assert.strictEqual(plannerNotif.rows[0].target_role, 'production_planner');
    assert.ok(plannerNotif.rows[0].next_step.includes('5.000 of 10.000 (LESS_IN_BIN)'));

    // Check warehouse_manager completion notification
    const mgrNotif = await getPool().query(
      `SELECT * FROM notifications WHERE event_type = 'pick_task_completed' AND object_id = $1`,
      [taskId],
    );
    assert.ok(mgrNotif.rows.length >= 1);
    assert.strictEqual(mgrNotif.rows[0].target_role, 'warehouse_manager');
  });

  it('pick_line.confirmed still refuses non-matching quantity with 400 PICK_QUANTITY_MISMATCH', async () => {
    const sku = `SKU-MISMATCH-${run}`;
    const lotNumber = `LOT-MISMATCH-${run}`;
    const { taskId, lineId, lotId } = await createTestTask(sku, lotNumber, 10);

    const env = {
      stream_type: 'warehouse',
      stream_id: taskId,
      event_type: 'pick_line.confirmed',
      payload: {
        pick_task_id: taskId,
        pick_line_id: lineId,
        confirmed_lot_id: lotId,
        confirmed_quantity: '8.000',
        capture_method: 'PWA',
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: operatorId, role: 'warehouse_operator', location_id: binId },
        occurred_at: new Date().toISOString(),
      },
    };
    const res = await makeRequest(port, 'POST', '/api/v1/events', env, operatorHeaders);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body['error_code'], 'PICK_QUANTITY_MISMATCH');
  });

  it('edge event endpoint stamps short_picked_by from authenticated user', async () => {
    const sku = `SKU-EDGE-${run}`;
    const lotNumber = `LOT-EDGE-${run}`;
    const { taskId, lineId } = await createTestTask(sku, lotNumber, 10);

    const env = {
      event_id: randomUUID(),
      idempotency_key: randomUUID(),
      device_id: 'tablet-317',
      stream_type: 'warehouse',
      stream_id: taskId,
      event_type: 'pick_line.short_picked',
      payload: {
        pick_task_id: taskId,
        pick_line_id: lineId,
        found_quantity: '0.000',
        reason: 'BIN_EMPTY',
        capture_method: 'PWA',
        short_picked_by: '00000000-0000-0000-0000-000000000000',
      },
      metadata: {
        correlation_id: randomUUID(),
        device_id: 'tablet-317',
        actor: { user_id: operatorId, role: 'warehouse_operator', location_id: binId },
        occurred_at: new Date().toISOString(),
      },
    };
    const res = await makeRequest(port, 'POST', '/api/v1/edge/events', env, operatorHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    const stored = await getPool().query(
      `SELECT payload->>'short_picked_by' AS short_picked_by FROM domain_events WHERE stream_id = $1 AND event_type = 'pick_line.short_picked'`,
      [taskId],
    );
    assert.strictEqual(stored.rows[0].short_picked_by, operatorId);
  });

  it('pack station: packing succeeds for found quantity on short-picked line and refuses excess with PACKED_QTY_MISMATCH', async () => {
    const sku = `SKU-PACK-${run}`;
    const lotNumber = `LOT-PACK-${run}`;
    const { taskId, lineId, lotId } = await createTestTask(sku, lotNumber, 10);

    // Short-pick with found = 6
    const env = shortPickEnvelope(taskId, lineId, '6.000', 'LESS_IN_BIN');
    const pickRes = await makeRequest(port, 'POST', '/api/v1/events', env, operatorHeaders);
    assert.strictEqual(pickRes.status, 201);

    // Get dispatch order ID (which is the sales order ID)
    const taskRes = await getPool().query(`SELECT dispatch_order_id FROM pick_task WHERE pick_task_id = $1`, [taskId]);
    const dispatchOrderId = taskRes.rows[0].dispatch_order_id;

    // Packing 6 units succeeds
    const packRes = await makeRequest(
      port,
      'POST',
      `/api/v1/dispatch/${dispatchOrderId}/pack`,
      {
        dispatchOrderId,
        packingLines: [{ sku, packed_qty: '6.000', lot_id: lotId, carton_count: 1 }],
      },
      managerHeaders,
    );
    assert.strictEqual(packRes.status, 200, JSON.stringify(packRes.body));

    // Packing more than 6 (e.g. attempting to pack 1 more) refuses with PACKED_QTY_MISMATCH
    const overPackRes = await makeRequest(
      port,
      'POST',
      `/api/v1/dispatch/${dispatchOrderId}/pack`,
      {
        dispatchOrderId,
        packingLines: [{ sku, packed_qty: '1.000', lot_id: lotId, carton_count: 1 }],
      },
      managerHeaders,
    );
  assert.strictEqual(overPackRes.status, 400);
  assert.strictEqual(overPackRes.body['error_code'], 'PACKED_QTY_MISMATCH');
});

  it('lot substitution by number resolves to the substituted lot UUID and consumes that lot', async () => {
    const sku = `SKU-SUB-${run}`;
    const directedLot = `LOT-DIR-${run}`;
    const substitutedLot = `LOT-SUB-${run}`;
    const { taskId, lineId } = await createTestTask(sku, directedLot, 10);

    // Seed a second (substituted) lot with its own stock at a writable bin in the same site.
    const subLotId = await seedLot(sku, substitutedLot);
    await seedStock(sku, binId, substitutedLot, 50);

    // Confirm by lot NUMBER with confirmed_lot_id null (the edge substitution payload shape).
    const env = {
      stream_type: 'warehouse',
      stream_id: taskId,
      event_type: 'pick_line.confirmed',
      payload: {
        pick_task_id: taskId,
        pick_line_id: lineId,
        confirmed_lot_id: null,
        confirmed_lot_number: substitutedLot,
        confirmed_quantity: '10.000',
        override_reason: 'Directed lot short; picked alternate lot',
        capture_method: 'PWA',
      },
      metadata: {
        correlation_id: randomUUID(),
        device_id: 'DEV-317',
        actor: { user_id: operatorId, role: 'warehouse_operator', location_id: binId },
        occurred_at: new Date().toISOString(),
      },
    };
    const res = await makeRequest(port, 'POST', '/api/v1/events', env, operatorHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    // The line is stamped substituted with the RESOLVED substituted lot UUID, not the directed lot.
    const lineRes = await getPool().query(
      `SELECT status, confirmed_lot_id FROM pick_line WHERE pick_line_id = $1`,
      [lineId],
    );
    assert.strictEqual(lineRes.rows[0].status, 'substituted');
    assert.strictEqual(lineRes.rows[0].confirmed_lot_id, subLotId);
  });
});
