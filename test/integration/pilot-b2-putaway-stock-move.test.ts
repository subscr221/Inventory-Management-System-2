import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppServer } from '../../src/server.js';
import { closePool, getPool } from '../../src/config/db.js';

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
 * Pilot defect B2: completing a putaway task must MOVE the stock balance from the receiving
 * location to the actual bin, inside the putaway.completed transaction, and completing an already
 * completed task must not append a second event. Every task here is produced by a REAL goods
 * receipt through POST /grn-lines (PO + accepted weighbridge token seeded as Story 3.4 does), so
 * the tests also prove the GRN posts at the location, lot key and stock class the putaway takes
 * from. Run-scoped identifiers, no TRUNCATE (Story 3.8 harness).
 */
describe('Pilot B2 putaway completion moves stock', () => {
  let server: Server;
  let port: number;
  let storeHeaders: Record<string, string>;
  let supervisorId: string;

  const run = randomUUID().slice(0, 8);
  const siteId = randomUUID();
  const zoneId = randomUUID();
  const dockId = randomUUID();
  const binId = randomUUID();
  const quarantineBinId = randomUUID();
  const inactiveBinId = randomUUID();
  const otherSiteId = randomUUID();
  const otherSiteBinId = randomUUID();
  const siteCode = `B2SITE-${run}`;
  const zoneCode = `B2ZONE-${run}`;
  const dockCode = `B2DOCK-${run}`;
  const binCode = `B2BIN-${run}`;
  const quarantineBinCode = `B2QBIN-${run}`;
  const inactiveBinCode = `B2OFF-${run}`;
  const otherSiteBinCode = `B2OTHER-${run}`;
  let poSeq = 0;

  async function seedLocation(
    locationId: string,
    code: string,
    level: string,
    parentId: string | null,
    options: { site?: string; quarantine?: boolean; status?: string } = {},
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO location_register
         (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class,
          size_class, hazmat_allowed, quarantine, access_restricted, status)
       VALUES ($1, $2, $3, $4, $5, 'general', 'ambient', 'standard', false, $6, false, $7)`,
      [
        locationId,
        code,
        level,
        parentId,
        options.site ?? siteId,
        options.quarantine ?? false,
        options.status ?? 'active',
      ],
    );
  }

  async function seedItem(sku: string, lotControlled = false): Promise<void> {
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ($1, 'KG', $2, false, false, false, false, 'weighted_average', 'production', 'active')`,
      [sku, lotControlled],
    );
  }

  interface Received {
    taskId: string;
    fromLocationId: string;
  }

  /** Posts a real GRN line at the dock and returns the ready putaway task it generated. */
  async function receive(
    sku: string,
    qty: number,
    overrides: Record<string, unknown> = {},
  ): Promise<Received> {
    const poRef = `B2PO-${run}-${++poSeq}`;
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
    const res = await makeRequest(
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
        target_location_code: dockCode,
        received_qty: qty,
        ...overrides,
      },
      storeHeaders,
    );
    assert.strictEqual(res.status, 201, `GRN for ${sku} failed: ${JSON.stringify(res.body)}`);
    const task = res.body['putaway_task'] as Record<string, unknown>;
    assert.strictEqual(task['status'], 'ready', JSON.stringify(task));
    return {
      taskId: task['putaway_task_id'] as string,
      fromLocationId: task['from_location_id'] as string,
    };
  }

  /** Puts the lot under a QC gate the way Story 8.1 leaves it (gate row keyed by lot number + sku). */
  async function seedQcGate(sku: string, lotNumber: string, gateStatus: string): Promise<void> {
    const lot = await getPool().query(
      `SELECT lot_id FROM lot_master WHERE lot_number = $1 AND sku = $2`,
      [lotNumber, sku],
    );
    assert.strictEqual(lot.rows.length, 1, `GRN did not create lot ${lotNumber}`);
    await getPool().query(
      `INSERT INTO qc_inspection_task
         (task_id, lot_id, lot_number, source_completion_type, source_completion_id, item_id, sku,
          quantity, uom, site_id, bom_revision_id, plan_id, plan_version_id, plan_scope, completed_at,
          business_date, gate_status, gate_changed_at, source_event_id)
       VALUES ($1, $2, $3, 'job_work_order', $4, $5, $6, 1, 'KG', $7, $8, $9, $10, 'standard', now(),
          '2026-07-23', $11, now(), $12)`,
      [
        randomUUID(),
        lot.rows[0]!['lot_id'],
        lotNumber,
        randomUUID(),
        randomUUID(),
        sku,
        siteId,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        gateStatus,
        randomUUID(),
      ],
    );
  }

  async function balances(
    sku: string,
    locationId: string,
  ): Promise<{ lot_id: string | null; stock_class: string; on_hand: number }[]> {
    const r = await getPool().query(
      `SELECT lot_id, stock_class, on_hand::float AS on_hand FROM stock_balance
        WHERE sku = $1 AND location_id = $2 AND on_hand <> 0 ORDER BY stock_class, lot_id`,
      [sku, locationId],
    );
    return r.rows as { lot_id: string | null; stock_class: string; on_hand: number }[];
  }

  async function onHandAt(sku: string, locationId: string): Promise<number> {
    return (await balances(sku, locationId)).reduce((sum, row) => sum + row.on_hand, 0);
  }

  async function skuTotals(sku: string): Promise<{ onHand: number; available: number }> {
    const r = await getPool().query(
      `SELECT COALESCE(SUM(on_hand), 0)::float AS on_hand, COALESCE(SUM(available), 0)::float AS available
         FROM stock_balance WHERE sku = $1`,
      [sku],
    );
    return {
      onHand: r.rows[0]!['on_hand'] as number,
      available: r.rows[0]!['available'] as number,
    };
  }

  async function completedEventCount(taskId: string): Promise<number> {
    const r = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM domain_events WHERE stream_id = $1 AND event_type = 'putaway.completed'`,
      [taskId],
    );
    return r.rows[0]!['n'] as number;
  }

  function complete(taskId: string, locationCode: string = binCode): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/putaway-tasks/${taskId}/complete`,
      { actual_location_code: locationCode },
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
    await seedLocation(zoneId, zoneCode, 'zone', siteId);
    await seedLocation(dockId, dockCode, 'bin', zoneId);
    await seedLocation(binId, binCode, 'bin', zoneId);
    await seedLocation(quarantineBinId, quarantineBinCode, 'bin', zoneId, { quarantine: true });
    await seedLocation(inactiveBinId, inactiveBinCode, 'bin', zoneId, { status: 'inactive' });
    await seedLocation(otherSiteId, `B2SITE2-${run}`, 'site', null, { site: otherSiteId });
    await seedLocation(otherSiteBinId, otherSiteBinCode, 'bin', otherSiteId, {
      site: otherSiteId,
    });

    supervisorId = await provisionUser(port, `b2-supervisor-${run}@example.com`, [
      {
        role: 'unloading_supervisor',
        module: 'receiving',
        functionScope: 'write',
        locationId: siteId,
      },
    ]);
    await provisionUser(port, `b2-store-${run}@example.com`, [
      { role: 'store_assistant', module: 'receiving', functionScope: 'write', locationId: siteId },
      { role: 'store_assistant', module: 'warehouse', functionScope: 'write', locationId: siteId },
    ]);
    storeHeaders = await authFor(port, `b2-store-${run}@example.com`);
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
  });

  it('plain item: the GRN posts at the task source, and completion moves it to the bin', async () => {
    const sku = `B2-PLAIN-${run}`;
    await seedItem(sku);
    const { taskId, fromLocationId } = await receive(sku, 10);
    assert.strictEqual(fromLocationId, dockId);
    assert.deepStrictEqual(await balances(sku, fromLocationId), [
      { lot_id: null, stock_class: 'owned', on_hand: 10 },
    ]);
    const before = await skuTotals(sku);

    const res = await complete(taskId);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    assert.deepStrictEqual(await balances(sku, dockId), []);
    assert.deepStrictEqual(await balances(sku, binId), [
      { lot_id: null, stock_class: 'owned', on_hand: 10 },
    ]);
    assert.deepStrictEqual(await skuTotals(sku), before);
  });

  it('lot item: the GRN lot key is the key the putaway drains and the bin receives', async () => {
    const sku = `B2-LOT-${run}`;
    const lotNumber = `B2LOT-${run}`;
    await seedItem(sku, true);
    const { taskId, fromLocationId } = await receive(sku, 8, {
      lot_id: lotNumber,
      expiry_date: '2030-01-01',
    });
    assert.deepStrictEqual(await balances(sku, fromLocationId), [
      { lot_id: lotNumber, stock_class: 'owned', on_hand: 8 },
    ]);
    const before = await skuTotals(sku);

    const res = await complete(taskId);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    assert.deepStrictEqual(await balances(sku, dockId), []);
    assert.deepStrictEqual(await balances(sku, binId), [
      { lot_id: lotNumber, stock_class: 'owned', on_hand: 8 },
    ]);
    assert.deepStrictEqual(await skuTotals(sku), before);
  });

  it('consignment receipt: the non-owned class moves as that class, never as owned', async () => {
    const sku = `B2-CONS-${run}`;
    await seedItem(sku);
    await getPool().query(
      `INSERT INTO ownership_agreement (sku, location_id, stock_class, owner_party_code, business_stream)
       VALUES ($1, $2, 'consignment', 'SUP-007', 'production')`,
      [sku, dockId],
    );
    const { taskId, fromLocationId } = await receive(sku, 6, {
      stock_class: 'consignment',
      owner_party_code: 'SUP-007',
    });
    assert.deepStrictEqual(await balances(sku, fromLocationId), [
      { lot_id: null, stock_class: 'consignment', on_hand: 6 },
    ]);

    const res = await complete(taskId);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    assert.deepStrictEqual(await balances(sku, dockId), []);
    assert.deepStrictEqual(await balances(sku, binId), [
      { lot_id: null, stock_class: 'consignment', on_hand: 6 },
    ]);
  });

  it('completing a completed task is idempotent: original event back, no second event, no second move', async () => {
    const sku = `B2-TWICE-${run}`;
    await seedItem(sku);
    const { taskId } = await receive(sku, 5);

    const first = await complete(taskId);
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const second = await complete(taskId);
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    assert.strictEqual(second.body['event_id'], first.body['event_id']);
    assert.strictEqual(second.body['replayed'], true);

    assert.strictEqual(await completedEventCount(taskId), 1);
    assert.strictEqual(await onHandAt(sku, dockId), 0);
    assert.strictEqual(await onHandAt(sku, binId), 5);
  });

  it('concurrent completions: one event, every answer 200 with the same event id', async () => {
    const sku = `B2-RACE-${run}`;
    await seedItem(sku);
    const { taskId } = await receive(sku, 4);

    // Four at once so at least one loser gets past the handler's status pre-read and is refused by
    // the projection seam under the row lock - the path that used to surface as a raw 409.
    const answers = await Promise.all([1, 2, 3, 4].map(() => complete(taskId)));
    for (const res of answers) assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const eventId = answers[0]!.body['event_id'];
    assert.ok(typeof eventId === 'string' && eventId.length > 0);
    for (const res of answers) assert.strictEqual(res.body['event_id'], eventId);
    assert.strictEqual(answers.filter((res) => res.body['replayed'] !== true).length, 1);

    assert.strictEqual(await completedEventCount(taskId), 1);
    assert.strictEqual(await onHandAt(sku, binId), 4);
  });

  it('a direct putaway.completed event on a completed task is refused and appends nothing', async () => {
    const sku = `B2-DIRECT-${run}`;
    await seedItem(sku);
    const { taskId } = await receive(sku, 6);
    assert.strictEqual((await complete(taskId)).status, 200);

    await assert.rejects(
      directCompletion(taskId, binCode),
      (err: unknown) =>
        (err as { errorCode?: string }).errorCode === 'PUTAWAY_TASK_ALREADY_COMPLETED',
    );
    assert.strictEqual(await completedEventCount(taskId), 1);
    assert.strictEqual(await onHandAt(sku, binId), 6);
  });

  it('a source that no longer holds the task quantity refuses the completion and writes no event', async () => {
    const sku = `B2-SHORT-${run}`;
    await seedItem(sku);
    const { taskId } = await receive(sku, 9);
    await getPool().query(
      `UPDATE stock_balance SET on_hand = 3 WHERE sku = $1 AND location_id = $2`,
      [sku, dockId],
    );

    const res = await complete(taskId);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INSUFFICIENT_STOCK');
    assert.strictEqual(await completedEventCount(taskId), 0);
    assert.strictEqual(await onHandAt(sku, dockId), 3);
  });

  async function directCompletion(taskId: string, locationCode: string): Promise<unknown> {
    const { persistEvent } = await import('../../src/events/store.js');
    return persistEvent({
      stream_type: 'putaway',
      stream_id: taskId,
      event_type: 'putaway.completed',
      payload: {
        putaway_task_id: taskId,
        actual_location_code: locationCode,
        completed_by: randomUUID(),
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: randomUUID(), role: 'store_assistant', location_id: siteId },
        occurred_at: new Date().toISOString(),
      },
      idempotency_key: null,
    } as never);
  }

  // Review fix 1: the destination must be an active bin of the task's own site.
  for (const [label, code, destinationId, reason] of [
    ['a bin of another site', otherSiteBinCode, otherSiteBinId, 'site_mismatch'],
    ['a zone row', zoneCode, zoneId, 'not_a_bin'],
    ['a site row', siteCode, siteId, 'not_a_bin'],
    ['an inactive bin', inactiveBinCode, inactiveBinId, 'inactive'],
  ] as [string, string, string, string][]) {
    it(`destination ${label} is refused 409 with no event and no stock move`, async () => {
      const sku = `B2-DEST-${reason}-${destinationId.slice(0, 4)}-${run}`;
      await seedItem(sku);
      const { taskId } = await receive(sku, 7);

      const res = await complete(taskId, code);
      assert.strictEqual(res.status, 409, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'PUTAWAY_DESTINATION_INVALID');
      assert.strictEqual((res.body['details'] as Record<string, unknown>)['reason'], reason);

      // The applier refuses on its own, so a direct POST /events on the putaway stream is covered.
      await assert.rejects(
        directCompletion(taskId, code),
        (err: unknown) =>
          (err as { errorCode?: string }).errorCode === 'PUTAWAY_DESTINATION_INVALID',
      );

      assert.strictEqual(await completedEventCount(taskId), 0);
      assert.strictEqual(await onHandAt(sku, dockId), 7);
      assert.strictEqual(await onHandAt(sku, destinationId), 0);
      assert.strictEqual((await complete(taskId)).status, 200, 'task must still be completable');
    });
  }

  // Review fix 2: a relocation is not a consumption, but a gated lot may only go to quarantine.
  it('a lot under QC hold moves into a quarantine bin', async () => {
    const sku = `B2-QCQ-${run}`;
    const lotNumber = `B2QCQ-${run}`;
    await seedItem(sku, true);
    const { taskId } = await receive(sku, 5, { lot_id: lotNumber, expiry_date: '2030-01-01' });
    await seedQcGate(sku, lotNumber, 'qc_hold');

    const res = await complete(taskId, quarantineBinCode);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(await balances(sku, dockId), []);
    assert.deepStrictEqual(await balances(sku, quarantineBinId), [
      { lot_id: lotNumber, stock_class: 'owned', on_hand: 5 },
    ]);
  });

  it('a lot under QC hold is refused into a normal bin with the QC code, not INSUFFICIENT_STOCK', async () => {
    const sku = `B2-QCN-${run}`;
    const lotNumber = `B2QCN-${run}`;
    await seedItem(sku, true);
    const { taskId } = await receive(sku, 5, { lot_id: lotNumber, expiry_date: '2030-01-01' });
    await seedQcGate(sku, lotNumber, 'qc_hold');

    const res = await complete(taskId);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'PUTAWAY_QC_HOLD_QUARANTINE_REQUIRED');
    assert.match(String(res.body['message']), /QC hold/);
    assert.match(String(res.body['message']), /quarantine bin/);
    assert.strictEqual(await completedEventCount(taskId), 0);
    assert.strictEqual(await onHandAt(sku, dockId), 5);
    assert.strictEqual(await onHandAt(sku, binId), 0);
  });

  it('a lot whose QC gate is released moves into a normal bin', async () => {
    const sku = `B2-QCR-${run}`;
    const lotNumber = `B2QCR-${run}`;
    await seedItem(sku, true);
    const { taskId } = await receive(sku, 5, { lot_id: lotNumber, expiry_date: '2030-01-01' });
    await seedQcGate(sku, lotNumber, 'accepted');

    const res = await complete(taskId);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(await onHandAt(sku, binId), 5);
  });

  // Follow-up F3(c): quarantine is a property of the place, and a zone can carry it for its bins.
  it('a lot under QC hold moves into an unflagged bin beneath a quarantine ZONE', async () => {
    const sku = `B2-QCZ-${run}`;
    const lotNumber = `B2QCZ-${run}`;
    const quarantineZoneId = randomUUID();
    const zoneBinId = randomUUID();
    const zoneBinCode = `B2QZBIN-${run}`;
    await seedLocation(quarantineZoneId, `B2QZONE-${run}`, 'zone', siteId, { quarantine: true });
    await seedLocation(zoneBinId, zoneBinCode, 'bin', quarantineZoneId);
    await seedItem(sku, true);
    const { taskId } = await receive(sku, 5, { lot_id: lotNumber, expiry_date: '2030-01-01' });
    await seedQcGate(sku, lotNumber, 'qc_hold');

    const res = await complete(taskId, zoneBinCode);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(await balances(sku, zoneBinId), [
      { lot_id: lotNumber, stock_class: 'owned', on_hand: 5 },
    ]);
  });

  // Follow-up F2: a relocation is not a consumption, so the obsolescence clock must not move.
  it('completion does not stamp last_issue_at on the source balance', async () => {
    const sku = `B2-CLOCK-${run}`;
    await seedItem(sku);
    const { taskId } = await receive(sku, 10);
    // Extra stock at the dock so the source row survives the move and can be inspected.
    await getPool().query(
      `UPDATE stock_balance SET on_hand = on_hand + 7 WHERE sku = $1 AND location_id = $2`,
      [sku, dockId],
    );

    const res = await complete(taskId);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(await onHandAt(sku, dockId), 7);
    const clock = await getPool().query(
      `SELECT location_id, last_issue_at FROM stock_balance WHERE sku = $1 AND last_issue_at IS NOT NULL`,
      [sku],
    );
    assert.deepStrictEqual(clock.rows, [], 'a putaway must not start or reset the issue clock');
  });
});
