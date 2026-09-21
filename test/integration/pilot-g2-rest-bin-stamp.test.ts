import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppServer } from '../../src/server.js';
import { closeAdminPool, closePool, getAdminPool, getPool } from '../../src/config/db.js';

const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };

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
    req.setTimeout(15000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
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
  assert.strictEqual(
    res.status,
    201,
    `provision ${externalId} failed: ${JSON.stringify(res.body)}`,
  );
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(
    res.status >= 200 && res.status < 300,
    `dev-token ${sub} failed: ${JSON.stringify(res.body)}`,
  );
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

/**
 * Pilot follow-up G2: the ordinary REST handlers stamp the location ACTED ON, exactly as the
 * envelope paths do since B1. A SITE-scoped user acting at one bin records that bin on the stored
 * event and on the audit_log row; an action with no single location keeps the site.
 */
describe('Pilot G2 REST handlers stamp the bin acted on', () => {
  let server: Server;
  let port: number;
  let storeHeaders: Record<string, string>;
  let managerHeaders: Record<string, string>;
  let supervisorId: string;

  const run = randomUUID().slice(0, 8);
  const siteId = randomUUID();
  const zoneId = randomUUID();
  const dockId = randomUUID();
  const binId = randomUUID();
  const siteCode = `G2SITE-${run}`;
  const dockCode = `G2DOCK-${run}`;
  const binCode = `G2BIN-${run}`;

  async function seedLocation(
    locationId: string,
    code: string,
    level: string,
    parentId: string | null,
    pickSequence: number | null = null,
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO location_register
         (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class,
          size_class, hazmat_allowed, quarantine, access_restricted, status, pick_sequence)
       VALUES ($1, $2, $3, $4, $5, 'general', 'ambient', 'standard', false, false, false, 'active', $6)`,
      [locationId, code, level, parentId, siteId, pickSequence],
    );
  }

  async function seedItem(sku: string): Promise<void> {
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ($1, 'KG', false, false, false, false, false, 'weighted_average', 'production', 'active')`,
      [sku],
    );
  }

  /** The stamp on the stored event and on its audit_log row. */
  async function stamps(eventId: string): Promise<{ event: string; audit: string }> {
    const stored = await getPool().query(
      `SELECT metadata->'actor'->>'location_id' AS location_id FROM domain_events WHERE event_id = $1`,
      [eventId],
    );
    assert.strictEqual(stored.rows.length, 1, `event ${eventId} not stored`);
    const audit = await getPool().query(`SELECT location_id FROM audit_log WHERE event_id = $1`, [
      eventId,
    ]);
    assert.strictEqual(audit.rows.length, 1, `audit row for ${eventId} missing`);
    return {
      event: stored.rows[0]!['location_id'] as string,
      audit: audit.rows[0]!['location_id'] as string,
    };
  }

  /** Posts a real GRN line at the dock and returns the ready putaway task it generated. */
  async function receive(sku: string, qty: number): Promise<string> {
    const res = await postGrn(sku, qty, dockCode);
    assert.strictEqual(res.status, 201, `GRN for ${sku} failed: ${JSON.stringify(res.body)}`);
    return (res.body['putaway_task'] as Record<string, unknown>)['putaway_task_id'] as string;
  }

  async function postGrn(sku: string, qty: number, targetCode: string): Promise<HttpResult> {
    const poRef = `G2PO-${run}-${sku}`;
    await getPool().query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, expected_delivery_date, status, source_system, last_synced_at)
       VALUES ($1, 'SUP-1', 'INR', '2026-08-01', 'open', 'ERP', now())`,
      [poRef],
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, over_receipt_tolerance_pct, under_receipt_tolerance_pct, source_system, last_synced_at)
       VALUES ($1, 1, $2, $3, $3, 1, 5, 100, 'ERP', now())`,
      [poRef, sku, qty],
    );
    const token = randomUUID();
    await getPool().query(
      `INSERT INTO weighbridge_event
        (weighbridge_event_id, correlation_id, gate_event_id, site_id, site_code_ext, po_ref_ext, line_no,
         tare_kg, gross_kg, net_kg, status, device_id, capture_method, weighed_by, business_date, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1000, 1100, 100, 'accepted', 'WB-1', 'MANUAL', $7, '2026-07-23', $8)`,
      [randomUUID(), token, randomUUID(), siteId, siteCode, poRef, supervisorId, randomUUID()],
    );
    return makeRequest(
      port,
      'POST',
      '/api/v1/grn-lines',
      {
        grn_id: randomUUID(),
        grn_line_id: randomUUID(),
        correlation_id: token,
        po_ref_ext: poRef,
        line_no: 1,
        source_document: 'PO',
        sku,
        target_location_code: targetCode,
        received_qty: qty,
      },
      storeHeaders,
    );
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

    await seedLocation(siteId, siteCode, 'site', null);
    await seedLocation(zoneId, `G2ZONE-${run}`, 'zone', siteId);
    await seedLocation(dockId, dockCode, 'bin', zoneId);
    await seedLocation(binId, binCode, 'bin', zoneId, 10);

    supervisorId = await provisionUser(port, `g2-supervisor-${run}@example.com`, [
      {
        role: 'unloading_supervisor',
        module: 'receiving',
        functionScope: 'write',
        locationId: siteId,
      },
    ]);
    // Every assignment is SITE-scoped: the bin is reached through hierarchy coverage only.
    await provisionUser(port, `g2-store-${run}@example.com`, [
      { role: 'store_assistant', module: 'receiving', functionScope: 'write', locationId: siteId },
      { role: 'store_assistant', module: 'warehouse', functionScope: 'write', locationId: siteId },
      { role: 'store_assistant', module: 'inventory', functionScope: 'write', locationId: siteId },
    ]);
    storeHeaders = await authFor(port, `g2-store-${run}@example.com`);
    await provisionUser(port, `g2-manager-${run}@example.com`, [
      {
        role: 'warehouse_manager',
        module: 'warehouse',
        functionScope: 'write',
        locationId: siteId,
      },
    ]);
    managerHeaders = await authFor(port, `g2-manager-${run}@example.com`);
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closeAdminPool();
    await closePool();
  });

  it('putaway complete records the destination bin on the event and the audit row', async () => {
    const sku = `G2-PUT-${run}`;
    await seedItem(sku);
    const taskId = await receive(sku, 10);

    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/putaway-tasks/${taskId}/complete`,
      { actual_location_code: binCode },
      storeHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(await stamps(res.body['event_id'] as string), {
      event: binId,
      audit: binId,
    });
  });

  it('a goods receipt records the receiving bin on the event and the audit row', async () => {
    const sku = `G2-GRN-${run}`;
    await seedItem(sku);
    const taskId = await receive(sku, 10);
    const received = await getPool().query(
      `SELECT e.event_id FROM domain_events e
         JOIN putaway_task pt ON pt.grn_line_id::text = e.payload->>'grn_line_id'
        WHERE pt.putaway_task_id = $1 AND e.event_type = 'goods.received'`,
      [taskId],
    );
    assert.strictEqual(received.rows.length, 1);
    assert.deepStrictEqual(await stamps(received.rows[0]!['event_id'] as string), {
      event: dockId,
      audit: dockId,
    });
  });

  it('putaway assignment is a site-level duty and keeps the site id', async () => {
    const sku = `G2-ASG-${run}`;
    await seedItem(sku);
    const taskId = await receive(sku, 10);

    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/putaway-tasks/${taskId}/assign`,
      { assigned_to: supervisorId },
      managerHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(await stamps(res.body['event_id'] as string), {
      event: siteId,
      audit: siteId,
    });
  });

  it('pick line confirm records the line bin', async () => {
    const sku = `G2-PICK-${run}`;
    await getPool().query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand)
       VALUES ($1, $2, NULL, 'owned', 20)`,
      [sku, binId],
    );
    const order = await getPool().query(
      `INSERT INTO erp_sales_order
         (so_number_ext, line_no, sku, quantity, ship_from_site_id, ship_from_site_code_ext, status, source_system, last_synced_at)
       VALUES ($1, 1, $2, 5, $3, $4, 'open', 'ERP', now())
       RETURNING id`,
      [`G2SO-${run}`, sku, siteId, siteCode],
    );
    const gen = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [order.rows[0]!['id'] as string], strategy: 'single' },
      managerHeaders,
    );
    assert.strictEqual(gen.status, 201, JSON.stringify(gen.body));
    const taskId = (gen.body['pickTaskIds'] as string[])[0]!;
    const detail = await makeRequest(
      port,
      'GET',
      `/api/v1/pick-tasks/${taskId}`,
      undefined,
      managerHeaders,
    );
    const line = (detail.body['lines'] as Array<Record<string, unknown>>)[0]!;
    assert.strictEqual(line['location_id'], binId);

    const confirm = await makeRequest(
      port,
      'POST',
      `/api/v1/pick-tasks/${taskId}/lines/${line['pick_line_id']}/confirm`,
      { confirmedLotId: null, confirmedQuantity: line['directed_quantity'], captureMethod: 'PWA' },
      storeHeaders,
    );
    assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
    assert.deepStrictEqual(await stamps(confirm.body['event_id'] as string), {
      event: binId,
      audit: binId,
    });
  });

  it('cycle-count raise and submit record the counted bin', async () => {
    const sku = `G2-CC-${run}`;
    await seedItem(sku);
    await getPool().query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand)
       VALUES ($1, $2, NULL, 'owned', 30)`,
      [sku, binId],
    );
    const raise = await makeRequest(
      port,
      'POST',
      '/api/v1/cycle-counts',
      {
        location_id: binId,
        sku_scope: [sku],
        count_type: 'cycle',
        business_date: '2026-07-23',
        business_stream: 'production',
      },
      storeHeaders,
    );
    assert.strictEqual(raise.status, 201, JSON.stringify(raise.body));
    const countId = raise.body['cycle_count_id'] as string;
    const raised = await getPool().query(
      `SELECT event_id FROM domain_events WHERE stream_id = $1 ORDER BY event_version`,
      [countId],
    );
    assert.strictEqual(raised.rows.length, 1);
    assert.deepStrictEqual(await stamps(raised.rows[0]!['event_id'] as string), {
      event: binId,
      audit: binId,
    });

    const submit = await makeRequest(
      port,
      'POST',
      `/api/v1/cycle-counts/${countId}/submit`,
      { lines: [{ sku, counted_quantity: 30 }] },
      storeHeaders,
    );
    assert.ok(submit.status < 300, JSON.stringify(submit.body));
    const events = await getPool().query(
      `SELECT event_id FROM domain_events WHERE stream_id = $1 ORDER BY event_version`,
      [countId],
    );
    assert.strictEqual(events.rows.length, 2);
    assert.deepStrictEqual(await stamps(events.rows[1]!['event_id'] as string), {
      event: binId,
      audit: binId,
    });
  });

  it('cycle-count approval is a site-level duty and keeps the site id (review R7f)', async () => {
    const sku = `G2-CCA-${run}`;
    await seedItem(sku);
    await getPool().query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand)
       VALUES ($1, $2, NULL, 'owned', 30)`,
      [sku, binId],
    );
    // A count adjustment needs a DOA band and a holder of its role. Neither is this run's to own
    // (both are global and outlive a run), so they are only created when the registry has none.
    const adminPool = getAdminPool();
    const band = await adminPool.query(
      `SELECT 1 FROM doa_registry_entries WHERE transaction_type = 'inventory.count_adjustment' AND active`,
    );
    const undo: Array<() => Promise<unknown>> = [];
    if (band.rows.length === 0) {
      const made = await adminPool.query(
        `INSERT INTO doa_registry_entries (role, transaction_type) VALUES ('warehouse_manager', 'inventory.count_adjustment') RETURNING entry_id`,
      );
      undo.push(() =>
        adminPool.query(`DELETE FROM doa_registry_entries WHERE entry_id = $1`, [
          made.rows[0]!['entry_id'],
        ]),
      );
    }
    try {
      await approveAtSite();
    } finally {
      for (const step of undo) await step();
    }

    async function approveAtSite(): Promise<void> {
      const raise = await makeRequest(
        port,
        'POST',
        '/api/v1/cycle-counts',
        {
          location_id: binId,
          sku_scope: [sku],
          count_type: 'cycle',
          business_date: '2026-07-23',
          business_stream: 'production',
        },
        storeHeaders,
      );
      assert.strictEqual(raise.status, 201, JSON.stringify(raise.body));
      const countId = raise.body['cycle_count_id'] as string;
      const submit = await makeRequest(
        port,
        'POST',
        `/api/v1/cycle-counts/${countId}/submit`,
        { lines: [{ sku, counted_quantity: 20 }] },
        storeHeaders,
      );
      assert.ok(submit.status < 300, JSON.stringify(submit.body));
      const line = (submit.body['lines'] as Array<Record<string, unknown>>)[0]!;
      const adjustmentId = line['adjustment_id'] as string;

      // The approver is whoever the resolver picks at approval time (the oldest active holder of
      // the DOA role, possibly an earlier run's user, or that holder's delegate) - never a user this
      // test assumes. A site-scoped approving user of this run asks first: either they ARE the
      // approver, or the refusal names the real one, who is then given the same site-scoped
      // assignment and signs as themself.
      const approvePath = `/api/v1/cycle-counts/${countId}/adjustments/${adjustmentId}/approve`;
      await provisionUser(port, `g2-approver-${run}@example.com`, [
        {
          role: 'warehouse_manager',
          module: 'inventory',
          functionScope: 'write',
          locationId: siteId,
        },
      ]);
      let approve = await makeRequest(
        port,
        'PATCH',
        approvePath,
        { reason_code: 'shrinkage' },
        await authFor(port, `g2-approver-${run}@example.com`),
      );
      let ownsReach = true;
      if (approve.status !== 200) {
        assert.strictEqual(approve.body['error_code'], 'APPROVAL_REQUIRED', approve.raw);
        const approverId = (approve.body['details'] as Record<string, unknown>)[
          'approver_actor_id'
        ] as string;
        const approver = await adminPool.query(`SELECT external_id FROM users WHERE user_id = $1`, [
          approverId,
        ]);
        const reach = await adminPool.query(
          `SELECT 1 FROM user_role_assignments
            WHERE user_id = $1 AND module IN ('inventory', '*') AND function_scope = 'write'
              AND role IN ('inventory_controller', 'warehouse_manager', 'finance_controller', 'audit_signoff')`,
          [approverId],
        );
        ownsReach = reach.rows.length === 0;
        if (ownsReach) {
          await adminPool.query(
            `INSERT INTO user_role_assignments (user_id, role, module, function_scope, location_id)
             VALUES ($1, 'warehouse_manager', 'inventory', 'write', $2)`,
            [approverId, siteId],
          );
          undo.push(() =>
            adminPool.query(
              `DELETE FROM user_role_assignments WHERE user_id = $1 AND module = 'inventory' AND location_id = $2`,
              [approverId, siteId],
            ),
          );
        }
        approve = await makeRequest(
          port,
          'PATCH',
          approvePath,
          { reason_code: 'shrinkage' },
          await authFor(port, approver.rows[0]!['external_id'] as string),
        );
      }
      assert.strictEqual(approve.status, 200, JSON.stringify(approve.body));
      const approved = await getPool().query(
        `SELECT event_id FROM domain_events WHERE stream_id = $1 AND event_type = 'cycle_count.adjustment_approved'`,
        [countId],
      );
      assert.strictEqual(approved.rows.length, 1);
      const stamp = await stamps(approved.rows[0]!['event_id'] as string);
      // The count was AT the bin; the approval is not. With the site assignment this test granted the
      // stamp is exactly the site; a pre-existing wider grant of the approver's keeps its own stamp.
      assert.notStrictEqual(stamp.event, binId);
      assert.notStrictEqual(stamp.audit, binId);
      if (ownsReach) assert.deepStrictEqual(stamp, { event: siteId, audit: siteId });
    }
  });
});
