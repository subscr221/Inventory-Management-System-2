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

describe('Story 3.6 Pick Task Generation and Execution', () => {
  let server: Server;
  let port: number;
  let managerHeaders: Record<string, string>;
  let operatorHeaders: Record<string, string>;
  let siteBOperatorHeaders: Record<string, string>;
  let operatorUserId: string;

  const siteAId = randomUUID();
  const siteBId = randomUUID();
  const zoneAmbientId = randomUUID();
  const zoneColdId = randomUUID();
  const run = randomUUID().slice(0, 8);

  // Bin layout: zone AMBIENT holds bins A1 (pick_sequence 20) and A2 (pick_sequence 10);
  // zone COLD holds bin C1 (pick_sequence 5).
  const binA1 = randomUUID();
  const binA2 = randomUUID();
  const binC1 = randomUUID();

  async function seedLocation(
    locationId: string,
    code: string,
    level: string,
    parentId: string | null,
    siteId: string,
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

  /**
   * Triage 2026-09-05: lot expiries were hardcoded calendar dates. Once the wall clock passed them
   * the "earlier expiry" lot was simply EXPIRED, FEFO correctly refused to pick it, and these tests
   * began failing for a reason unrelated to picking. Dates are relative to today so the scenarios
   * stay true whenever they run.
   */
  const daysAhead = (n: number): string =>
    new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  async function seedLot(sku: string, lotNumber: string, expiry: string | null): Promise<string> {
    const result = await getPool().query(
      `INSERT INTO lot_master (lot_number, sku, expiry_date, quality_hold_status)
       VALUES ($1, $2, $3, 'none') RETURNING lot_id`,
      [lotNumber, sku, expiry],
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
  ): Promise<string> {
    const result = await getPool().query(
      `INSERT INTO erp_sales_order
         (so_number_ext, line_no, sku, quantity, ship_from_site_id, ship_from_site_code_ext, status, source_system, last_synced_at)
       VALUES ($1, $2, $3, $4, $5, 'site-A36', 'open', 'ERP', now())
       RETURNING id`,
      [soNumber, lineNo, sku, quantity, siteAId],
    );
    return result.rows[0]!['id'] as string;
  }

  async function allocatedFor(sku: string, locationId: string, lotNumber: string): Promise<number> {
    const result = await getPool().query(
      `SELECT allocated::float8 AS allocated FROM stock_balance WHERE sku = $1 AND location_id = $2 AND lot_id = $3 AND stock_class = 'owned'`,
      [sku, locationId, lotNumber],
    );
    return result.rows.length > 0 ? (result.rows[0]!['allocated'] as number) : 0;
  }

  /** AC7's observable outcome: stock that has moved out of `allocated` into `picked`. */
  async function pickedFor(sku: string, locationId: string, lotNumber: string): Promise<number> {
    const result = await getPool().query(
      `SELECT picked::float8 AS picked FROM stock_balance WHERE sku = $1 AND location_id = $2 AND lot_id = $3 AND stock_class = 'owned'`,
      [sku, locationId, lotNumber],
    );
    return result.rows.length > 0 ? (result.rows[0]!['picked'] as number) : 0;
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

    // Warehouse topology: site A with two zones (bins hang off an aisle+rack chain per zone).
    await seedLocation(siteAId, `SITE-A36-${run}`, 'site', null, siteAId);
    await seedLocation(siteBId, `SITE-B36-${run}`, 'site', null, siteBId);
    await seedLocation(zoneAmbientId, `ZONE-AMB36-${run}`, 'zone', siteAId, siteAId);
    await seedLocation(zoneColdId, `ZONE-COLD36-${run}`, 'zone', siteAId, siteAId);
    const aisleAmb = randomUUID();
    const rackAmb = randomUUID();
    const aisleCold = randomUUID();
    const rackCold = randomUUID();
    await seedLocation(aisleAmb, `AISLE-AMB36-${run}`, 'aisle', zoneAmbientId, siteAId);
    await seedLocation(rackAmb, `RACK-AMB36-${run}`, 'rack', aisleAmb, siteAId);
    await seedLocation(aisleCold, `AISLE-COLD36-${run}`, 'aisle', zoneColdId, siteAId);
    await seedLocation(rackCold, `RACK-COLD36-${run}`, 'rack', aisleCold, siteAId);
    await seedLocation(binA1, `BIN-A1-36-${run}`, 'bin', rackAmb, siteAId, 20);
    await seedLocation(binA2, `BIN-A2-36-${run}`, 'bin', rackAmb, siteAId, 10);
    await seedLocation(binC1, `BIN-C1-36-${run}`, 'bin', rackCold, siteAId, 5);

    await provisionUser(port, `pick-manager-${run}@example.com`, [
      {
        role: 'warehouse_manager',
        module: 'warehouse',
        functionScope: 'write',
        locationId: siteAId,
      },
    ]);
    managerHeaders = await authFor(port, `pick-manager-${run}@example.com`);

    operatorUserId = await provisionUser(port, `pick-operator-${run}@example.com`, [
      { role: 'store_assistant', module: 'warehouse', functionScope: 'write', locationId: siteAId },
    ]);
    operatorHeaders = await authFor(port, `pick-operator-${run}@example.com`);

    await provisionUser(port, `pick-operator-b-${run}@example.com`, [
      { role: 'store_assistant', module: 'warehouse', functionScope: 'write', locationId: siteBId },
    ]);
    siteBOperatorHeaders = await authFor(port, `pick-operator-b-${run}@example.com`);
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
  });

  it('AC1: single-order generation selects lots FEFO, sequences bins ascending, and allocates stock', async () => {
    const sku = `FG-0010-${run}`;
    const lotEarly = `LOT-E-${run}`;
    const lotLate = `LOT-L-${run}`;
    await seedLot(sku, lotEarly, daysAhead(30));
    await seedLot(sku, lotLate, daysAhead(180));
    // The earlier-expiry lot sits in bin A1 (sequence 20), the later in bin A2 (sequence 10):
    // FEFO must direct 60 from lotEarly first, then 40 from lotLate.
    await seedStock(sku, binA1, lotEarly, 60);
    await seedStock(sku, binA2, lotLate, 100);
    const lineId = await seedOrderLine(`SO36-AC1-${run}`, 1, sku, 100);

    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [lineId], strategy: 'single' },
      managerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const taskIds = res.body['pickTaskIds'] as string[];
    assert.strictEqual(taskIds.length, 1);

    const detail = await makeRequest(
      port,
      'GET',
      `/api/v1/pick-tasks/${taskIds[0]}`,
      undefined,
      managerHeaders,
    );
    assert.strictEqual(detail.status, 200);
    const lines = detail.body['lines'] as Array<Record<string, unknown>>;
    assert.strictEqual(lines.length, 2);
    // Lines come back ordered by pick_sequence ASC; bin A2 (sequence 10) precedes bin A1 (20).
    assert.strictEqual(lines[0]!['location_id'], binA2);
    assert.strictEqual(lines[1]!['location_id'], binA1);
    assert.deepStrictEqual(
      lines.map((l) => l['pick_sequence']),
      [1, 2],
    );
    // FEFO: the earlier-expiry lot covers 60; the later lot covers the remaining 40.
    const early = lines.find((l) => l['location_id'] === binA1)!;
    const late = lines.find((l) => l['location_id'] === binA2)!;
    assert.strictEqual(Number(early['directed_quantity']), 60);
    assert.strictEqual(Number(late['directed_quantity']), 40);
    // Stock is allocated in real time (AC1).
    assert.strictEqual(await allocatedFor(sku, binA1, lotEarly), 60);
    assert.strictEqual(await allocatedFor(sku, binA2, lotLate), 40);
  });

  it('AC1: insufficient available stock rejects INSUFFICIENT_STOCK_FOR_PICK with no partial allocation', async () => {
    const sku = `FG-SHORT-${run}`;
    const lot = `LOT-S-${run}`;
    await seedLot(sku, lot, null);
    await seedStock(sku, binA1, lot, 5);
    const lineId = await seedOrderLine(`SO36-SHORT-${run}`, 1, sku, 50);

    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [lineId], strategy: 'single' },
      managerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INSUFFICIENT_STOCK_FOR_PICK');
    assert.strictEqual(await allocatedFor(sku, binA1, lot), 0);
  });

  it('AC2: batch release consolidates same-sku same-zone orders into one task with per-order lines', async () => {
    const sku = `FG-BATCH-${run}`;
    const lot = `LOT-B-${run}`;
    await seedLot(sku, lot, null);
    await seedStock(sku, binA2, lot, 300);
    const line1 = await seedOrderLine(`SO36-B1-${run}`, 1, sku, 10);
    const line2 = await seedOrderLine(`SO36-B2-${run}`, 1, sku, 20);
    const line3 = await seedOrderLine(`SO36-B3-${run}`, 1, sku, 30);

    const batchId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/batch',
      { dispatchOrderLineIds: [line1, line2, line3], batchId },
      managerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const taskIds = res.body['pickTaskIds'] as string[];
    assert.strictEqual(taskIds.length, 1, 'one consolidated task per (sku, zone) group');

    const detail = await makeRequest(
      port,
      'GET',
      `/api/v1/pick-tasks/${taskIds[0]}`,
      undefined,
      managerHeaders,
    );
    const task = detail.body['task'] as Record<string, unknown>;
    assert.strictEqual(task['strategy'], 'batch');
    assert.strictEqual(task['batch_id'], batchId);
    assert.strictEqual(Number(task['total_quantity']), 60);
    const lines = detail.body['lines'] as Array<Record<string, unknown>>;
    // Per-order sortation preserved at the pick line (AC2).
    assert.deepStrictEqual(
      lines.map((l) => l['dispatch_order_line_id']).sort(),
      [line1, line2, line3].sort(),
    );
    assert.deepStrictEqual(
      lines.map((l) => Number(l['directed_quantity'])).sort((a, b) => a - b),
      [10, 20, 30],
    );
  });

  it('AC3: wave release stamps wave_id on every task; orders outside the wave stay unreleased', async () => {
    const sku = `FG-WAVE-${run}`;
    const lot = `LOT-W-${run}`;
    await seedLot(sku, lot, null);
    await seedStock(sku, binA1, lot, 500);
    const inWave1 = await seedOrderLine(`SO36-W1-${run}`, 1, sku, 10);
    const inWave2 = await seedOrderLine(`SO36-W2-${run}`, 1, sku, 15);
    const outsideWave = await seedOrderLine(`SO36-W3-${run}`, 1, sku, 20);

    const waveId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/wave',
      { dispatchOrderLineIds: [inWave1, inWave2], waveId },
      managerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual((res.body['pickTaskIds'] as string[]).length, 2);

    const list = await makeRequest(
      port,
      'GET',
      `/api/v1/pick-tasks?waveId=${waveId}`,
      undefined,
      managerHeaders,
    );
    const tasks = list.body['pick_tasks'] as Array<Record<string, unknown>>;
    assert.strictEqual(tasks.length, 2);
    for (const t of tasks) assert.strictEqual(t['wave_id'], waveId);
    assert.ok(
      !tasks.some((t) => t['dispatch_order_id'] === outsideWave),
      'outside-wave order stays unreleased',
    );

    const outsideTasks = await getPool().query(
      `SELECT 1 FROM pick_task WHERE dispatch_order_id = $1`,
      [outsideWave],
    );
    assert.strictEqual(outsideTasks.rows.length, 0);
  });

  it('AC4: zone picking generates a task per zone and flags the order picked only when every zone task completes', async () => {
    const sku = `FG-ZONE-${run}`;
    const lotAmb = `LOT-ZA-${run}`;
    const lotCold = `LOT-ZC-${run}`;
    await seedLot(sku, lotAmb, daysAhead(26));
    await seedLot(sku, lotCold, daysAhead(57));
    await seedStock(sku, binA2, lotAmb, 30);
    await seedStock(sku, binC1, lotCold, 100);
    const lineId = await seedOrderLine(`SO36-Z1-${run}`, 1, sku, 80);

    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [lineId], strategy: 'zone' },
      managerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const taskIds = res.body['pickTaskIds'] as string[];
    assert.strictEqual(taskIds.length, 2, 'one task per zone');

    // Confirm every line of both tasks, zone by zone. Each zone task auto-completes on its own
    // last confirmation (AC7's trigger), so no separate supervisor call is needed.
    for (const [i, taskId] of taskIds.entries()) {
      const detail = await makeRequest(
        port,
        'GET',
        `/api/v1/pick-tasks/${taskId}`,
        undefined,
        managerHeaders,
      );
      const lines = detail.body['lines'] as Array<Record<string, unknown>>;
      for (const line of lines) {
        const confirm = await makeRequest(
          port,
          'POST',
          `/api/v1/pick-tasks/${taskId}/lines/${line['pick_line_id']}/confirm`,
          {
            confirmedLotId: line['directed_lot_id'],
            confirmedQuantity: line['directed_quantity'],
            captureMethod: 'PWA',
          },
          operatorHeaders,
        );
        assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
      }
      const after = await makeRequest(
        port,
        'GET',
        `/api/v1/pick-tasks/${taskId}`,
        undefined,
        managerHeaders,
      );
      assert.strictEqual(
        (after.body['task'] as Record<string, unknown>)['status'],
        'completed',
        'zone task auto-completes on its last confirmation',
      );

      const picked = await getPool().query(
        `SELECT 1 FROM dispatch_order_status WHERE dispatch_order_id = $1`,
        [lineId],
      );
      if (i === 0) {
        assert.strictEqual(picked.rows.length, 0, 'order is not picked while a zone task is open');
      } else {
        assert.strictEqual(
          picked.rows.length,
          1,
          'order flags picked when every zone task is confirmed',
        );
      }
    }
  });

  it('AC5: the paper pick list renders task IDs, pick sequence and directed lots; PAPER confirmations record capture_method', async () => {
    const sku = `FG-PAPER-${run}`;
    const lot = `LOT-P-${run}`;
    const lotUuid = await seedLot(sku, lot, null);
    await seedStock(sku, binA1, lot, 50);
    const lineId = await seedOrderLine(`SO36-P1-${run}`, 1, sku, 25);

    const gen = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [lineId], strategy: 'single' },
      managerHeaders,
    );
    const taskId = (gen.body['pickTaskIds'] as string[])[0]!;
    const pickLineId = (gen.body['pickLineIds'] as string[])[0]!;

    const print = await makeRequest(
      port,
      'GET',
      `/api/v1/pick-tasks/${taskId}/print`,
      undefined,
      managerHeaders,
    );
    assert.strictEqual(print.status, 200);
    assert.ok(print.raw.includes('PICK LIST'));
    assert.ok(print.raw.includes(taskId), 'pick list carries the task id');
    assert.ok(print.raw.includes(pickLineId), 'pick list carries the pick line id');
    assert.ok(print.raw.includes(lotUuid), 'pick list carries the directed lot');
    assert.ok(/\n\s*1 \|/.test(print.raw), 'pick list carries the bin pick-sequence');

    const confirm = await makeRequest(
      port,
      'POST',
      `/api/v1/pick-tasks/${taskId}/lines/${pickLineId}/confirm`,
      { confirmedLotId: lotUuid, confirmedQuantity: '25', captureMethod: 'PAPER' },
      operatorHeaders,
    );
    assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
    const line = confirm.body['line'] as Record<string, unknown>;
    assert.strictEqual(line['capture_method'], 'PAPER');
    assert.strictEqual(line['status'], 'confirmed');
  });

  it('AC6/AC8: a lot substitution requires an override reason, reallocates stock, and releases the directed allocation', async () => {
    const sku = `FG-SUB-${run}`;
    const directedLot = `LOT-D-${run}`;
    const substituteLot = `LOT-X-${run}`;
    const directedUuid = await seedLot(sku, directedLot, daysAhead(10));
    const substituteUuid = await seedLot(sku, substituteLot, daysAhead(101));
    await seedStock(sku, binA1, directedLot, 40);
    await seedStock(sku, binA2, substituteLot, 40);
    const lineId = await seedOrderLine(`SO36-S1-${run}`, 1, sku, 40);

    const gen = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [lineId], strategy: 'single' },
      managerHeaders,
    );
    const taskId = (gen.body['pickTaskIds'] as string[])[0]!;
    const pickLineId = (gen.body['pickLineIds'] as string[])[0]!;
    assert.strictEqual(await allocatedFor(sku, binA1, directedLot), 40);

    // Substitution WITHOUT an override reason is rejected (the operator failed to supply required
    // data - a 4xx, unlike the substitution itself which is a 2xx warning outcome).
    const noReason = await makeRequest(
      port,
      'POST',
      `/api/v1/pick-tasks/${taskId}/lines/${pickLineId}/confirm`,
      { confirmedLotId: substituteUuid, confirmedQuantity: '40', captureMethod: 'PWA' },
      operatorHeaders,
    );
    assert.strictEqual(noReason.status, 400, JSON.stringify(noReason.body));
    assert.strictEqual(noReason.body['error_code'], 'PICK_OVERRIDE_REASON_REQUIRED');

    const substituted = await makeRequest(
      port,
      'POST',
      `/api/v1/pick-tasks/${taskId}/lines/${pickLineId}/confirm`,
      {
        confirmedLotId: substituteUuid,
        confirmedQuantity: '40',
        overrideReason: 'Directed lot damaged',
        captureMethod: 'PWA',
      },
      operatorHeaders,
    );
    assert.strictEqual(substituted.status, 200, JSON.stringify(substituted.body));
    assert.strictEqual(substituted.body['warning_code'], 'PICK_LOT_SUBSTITUTED');
    const line = substituted.body['line'] as Record<string, unknown>;
    assert.strictEqual(line['status'], 'substituted');
    assert.strictEqual(line['override_reason'], 'Directed lot damaged');
    assert.strictEqual(line['confirmed_lot_id'], substituteUuid);
    assert.strictEqual(line['directed_lot_id'], directedUuid);
    // Original allocation released; the substituted lot carries the quantity (AC8). This is the
    // task's only line, so its confirmation is also the last one: the task auto-completes and AC7
    // moves the substituted lot's stock straight on from `allocated` into `picked`.
    assert.strictEqual(
      await allocatedFor(sku, binA1, directedLot),
      0,
      'directed lot allocation released',
    );
    assert.strictEqual(await pickedFor(sku, binA1, directedLot), 0, 'directed lot is never picked');
    assert.strictEqual(await allocatedFor(sku, binA2, substituteLot), 0);
    assert.strictEqual(
      await pickedFor(sku, binA2, substituteLot),
      40,
      'substituted lot moves to picked on completion',
    );
  });

  it('AC8: a substitution whose lot lacks available stock rejects INSUFFICIENT_STOCK_FOR_PICK', async () => {
    const sku = `FG-SUBX-${run}`;
    const directedLot = `LOT-DX-${run}`;
    const thinLot = `LOT-TX-${run}`;
    await seedLot(sku, directedLot, null);
    const thinUuid = await seedLot(sku, thinLot, null);
    await seedStock(sku, binA1, directedLot, 30);
    await seedStock(sku, binA2, thinLot, 5);
    const lineId = await seedOrderLine(`SO36-SX-${run}`, 1, sku, 30);

    const gen = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [lineId], strategy: 'single' },
      managerHeaders,
    );
    const taskId = (gen.body['pickTaskIds'] as string[])[0]!;
    const pickLineId = (gen.body['pickLineIds'] as string[])[0]!;

    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/pick-tasks/${taskId}/lines/${pickLineId}/confirm`,
      {
        confirmedLotId: thinUuid,
        confirmedQuantity: '30',
        overrideReason: 'Directed lot missing',
        captureMethod: 'PWA',
      },
      operatorHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INSUFFICIENT_STOCK_FOR_PICK');
    // Rejection rolls the whole confirmation back - the directed allocation is untouched.
    assert.strictEqual(await allocatedFor(sku, binA1, directedLot), 30);
  });

  it('AC7: completion requires every line confirmed, then completes and notifies', async () => {
    const sku = `FG-DONE-${run}`;
    const lotA = `LOT-DA-${run}`;
    const lotB = `LOT-DB-${run}`;
    const lotAUuid = await seedLot(sku, lotA, daysAhead(15));
    const lotBUuid = await seedLot(sku, lotB, daysAhead(45));
    await seedStock(sku, binA1, lotA, 10);
    await seedStock(sku, binA2, lotB, 10);
    const lineId = await seedOrderLine(`SO36-D1-${run}`, 1, sku, 20);

    const gen = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [lineId], strategy: 'single' },
      managerHeaders,
    );
    const taskId = (gen.body['pickTaskIds'] as string[])[0]!;
    const detail = await makeRequest(
      port,
      'GET',
      `/api/v1/pick-tasks/${taskId}`,
      undefined,
      managerHeaders,
    );
    const lines = detail.body['lines'] as Array<Record<string, unknown>>;
    assert.strictEqual(lines.length, 2);

    // Premature completion is rejected.
    const early = await makeRequest(
      port,
      'POST',
      `/api/v1/pick-tasks/${taskId}/complete`,
      {},
      managerHeaders,
    );
    assert.strictEqual(early.status, 409, JSON.stringify(early.body));
    assert.strictEqual(early.body['error_code'], 'PICK_TASK_NOT_ALL_LINES_CONFIRMED');

    for (const line of lines) {
      const lotUuid = line['directed_lot_id'] === lotAUuid ? lotAUuid : lotBUuid;
      const confirm = await makeRequest(
        port,
        'POST',
        `/api/v1/pick-tasks/${taskId}/lines/${line['pick_line_id']}/confirm`,
        {
          confirmedLotId: lotUuid,
          confirmedQuantity: line['directed_quantity'],
          captureMethod: 'PWA',
        },
        operatorHeaders,
      );
      assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
    }

    // AC7's trigger is the LAST confirmation, so the task is already complete here - no separate
    // supervisor call. The manual endpoint is a fallback and now reports the task already done.
    const after = await makeRequest(
      port,
      'GET',
      `/api/v1/pick-tasks/${taskId}`,
      undefined,
      managerHeaders,
    );
    const task = after.body['task'] as Record<string, unknown>;
    assert.strictEqual(task['status'], 'completed', 'task auto-completes on the last confirmation');
    assert.ok(task['completed_at'], 'completed_at is stamped');

    const redundant = await makeRequest(
      port,
      'POST',
      `/api/v1/pick-tasks/${taskId}/complete`,
      {},
      managerHeaders,
    );
    assert.strictEqual(redundant.status, 409, JSON.stringify(redundant.body));
    assert.strictEqual(redundant.body['error_code'], 'PICK_TASK_ALREADY_COMPLETED');

    // AC7's actual outcome: every confirmed line's stock leaves `allocated` and lands in `picked`.
    assert.strictEqual(await allocatedFor(sku, binA1, lotA), 0, 'lot A allocation cleared');
    assert.strictEqual(await pickedFor(sku, binA1, lotA), 10, 'lot A moved to picked');
    assert.strictEqual(await allocatedFor(sku, binA2, lotB), 0, 'lot B allocation cleared');
    assert.strictEqual(await pickedFor(sku, binA2, lotB), 10, 'lot B moved to picked');

    // AC7: the packing station is notified (warehouse_manager placeholder target).
    const note = await getPool().query(
      `SELECT 1 FROM domain_events
        WHERE event_type = 'notification.created'
          AND payload->>'object_id' = $1
          AND payload->'target'->>'role' = 'warehouse_manager'`,
      [taskId],
    );
    assert.strictEqual(note.rows.length, 1, 'pick_task.completed notification emitted');
  });

  it('AC6: an idempotent replay of the same confirmation is a no-op success with no duplicate allocation change', async () => {
    const sku = `FG-IDEM-${run}`;
    const lot = `LOT-I-${run}`;
    const lotUuid = await seedLot(sku, lot, null);
    await seedStock(sku, binA1, lot, 20);
    const lineId = await seedOrderLine(`SO36-I1-${run}`, 1, sku, 20);

    const gen = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [lineId], strategy: 'single' },
      managerHeaders,
    );
    const taskId = (gen.body['pickTaskIds'] as string[])[0]!;
    const pickLineId = (gen.body['pickLineIds'] as string[])[0]!;
    const payload = { confirmedLotId: lotUuid, confirmedQuantity: '20', captureMethod: 'PWA' };

    const first = await makeRequest(
      port,
      'POST',
      `/api/v1/pick-tasks/${taskId}/lines/${pickLineId}/confirm`,
      payload,
      operatorHeaders,
    );
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const replay = await makeRequest(
      port,
      'POST',
      `/api/v1/pick-tasks/${taskId}/lines/${pickLineId}/confirm`,
      payload,
      operatorHeaders,
    );
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    // The single line's confirmation also completes the task, so the quantity has moved on to
    // `picked`; the replay must not move it a second time.
    assert.strictEqual(await allocatedFor(sku, binA1, lot), 0);
    assert.strictEqual(await pickedFor(sku, binA1, lot), 20, 'stock moved exactly once');

    // A conflicting re-confirmation (different quantity) rejects PICK_LINE_ALREADY_CONFIRMED.
    const conflicting = await makeRequest(
      port,
      'POST',
      `/api/v1/pick-tasks/${taskId}/lines/${pickLineId}/confirm`,
      { confirmedLotId: lotUuid, confirmedQuantity: '19', captureMethod: 'PWA' },
      operatorHeaders,
    );
    assert.strictEqual(conflicting.status, 409, JSON.stringify(conflicting.body));
    assert.strictEqual(conflicting.body['error_code'], 'PICK_LINE_ALREADY_CONFIRMED');
  });

  it('Review decision: a confirmed quantity differing from the directed quantity is rejected either way', async () => {
    const sku = `FG-QTY-${run}`;
    const lot = `LOT-Q-${run}`;
    const lotUuid = await seedLot(sku, lot, null);
    await seedStock(sku, binA1, lot, 500);
    const lineId = await seedOrderLine(`SO36-Q1-${run}`, 1, sku, 100);

    const gen = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [lineId], strategy: 'single' },
      managerHeaders,
    );
    const taskId = (gen.body['pickTaskIds'] as string[])[0]!;
    const pickLineId = (gen.body['pickLineIds'] as string[])[0]!;

    // Short pick: previously completed the task and flagged the order picked, losing 99 units of
    // demand with no shortfall record.
    const short = await makeRequest(
      port,
      'POST',
      `/api/v1/pick-tasks/${taskId}/lines/${pickLineId}/confirm`,
      { confirmedLotId: lotUuid, confirmedQuantity: '1', captureMethod: 'PWA' },
      operatorHeaders,
    );
    assert.strictEqual(short.status, 400, JSON.stringify(short.body));
    assert.strictEqual(short.body['error_code'], 'PICK_QUANTITY_MISMATCH');

    // Over-pick: previously allocated stock beyond the sales-order demand.
    const over = await makeRequest(
      port,
      'POST',
      `/api/v1/pick-tasks/${taskId}/lines/${pickLineId}/confirm`,
      { confirmedLotId: lotUuid, confirmedQuantity: '150', captureMethod: 'PWA' },
      operatorHeaders,
    );
    assert.strictEqual(over.status, 400, JSON.stringify(over.body));
    assert.strictEqual(over.body['error_code'], 'PICK_QUANTITY_MISMATCH');

    // Neither rejection may disturb the standing allocation.
    assert.strictEqual(
      await allocatedFor(sku, binA1, lot),
      100,
      'allocation untouched by rejected confirmations',
    );
    assert.strictEqual(await pickedFor(sku, binA1, lot), 0);
  });

  it('Review: generation is idempotent - re-releasing the same demand line does not double-allocate', async () => {
    const sku = `FG-REGEN-${run}`;
    const lot = `LOT-RG-${run}`;
    await seedLot(sku, lot, null);
    await seedStock(sku, binA1, lot, 100);
    const lineId = await seedOrderLine(`SO36-RG-${run}`, 1, sku, 10);

    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [lineId], strategy: 'single' },
      managerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    assert.strictEqual(await allocatedFor(sku, binA1, lot), 10);

    const second = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [lineId], strategy: 'single' },
      managerHeaders,
    );
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'PICK_TASK_ALREADY_GENERATED');
    assert.strictEqual(await allocatedFor(sku, binA1, lot), 10, 'demand allocated exactly once');
  });

  it('Review: assign requires a supervisor, a real assignee, and a permitted site', async () => {
    const sku = `FG-ASSIGN-${run}`;
    const lot = `LOT-AS-${run}`;
    await seedLot(sku, lot, null);
    await seedStock(sku, binA1, lot, 40);
    const lineId = await seedOrderLine(`SO36-AS-${run}`, 1, sku, 10);

    const gen = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [lineId], strategy: 'single' },
      managerHeaders,
    );
    const taskId = (gen.body['pickTaskIds'] as string[])[0]!;

    // Assignment is supervisor-only (Task 8.1's assign RBAC coverage).
    const byOperator = await makeRequest(
      port,
      'POST',
      `/api/v1/pick-tasks/${taskId}/assign`,
      { assignedTo: operatorUserId },
      operatorHeaders,
    );
    assert.strictEqual(byOperator.status, 403, JSON.stringify(byOperator.body));
    assert.strictEqual(byOperator.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    // A well-formed UUID that is nobody must not leave the task looking assigned.
    const ghost = await makeRequest(
      port,
      'POST',
      `/api/v1/pick-tasks/${taskId}/assign`,
      { assignedTo: randomUUID() },
      managerHeaders,
    );
    assert.strictEqual(ghost.status, 404, JSON.stringify(ghost.body));
    assert.strictEqual(ghost.body['error_code'], 'ASSIGNEE_NOT_FOUND');

    const ok = await makeRequest(
      port,
      'POST',
      `/api/v1/pick-tasks/${taskId}/assign`,
      { assignedTo: operatorUserId },
      managerHeaders,
    );
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual((ok.body['task'] as Record<string, unknown>)['assigned_to'], operatorUserId);
  });

  it('Review: non-UUID list filters are a 400, not a 500', async () => {
    for (const key of ['assignedTo', 'zoneId', 'waveId', 'batchId']) {
      const res = await makeRequest(
        port,
        'GET',
        `/api/v1/pick-tasks?${key}=not-a-uuid`,
        undefined,
        managerHeaders,
      );
      assert.strictEqual(res.status, 400, `${key}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS', key);
    }
  });

  it('RBAC: operators cannot generate; out-of-site operators cannot confirm; unknown lines reject', async () => {
    const sku = `FG-RBAC-${run}`;
    const lot = `LOT-R-${run}`;
    const lotUuid = await seedLot(sku, lot, null);
    await seedStock(sku, binA1, lot, 10);
    const lineId = await seedOrderLine(`SO36-R1-${run}`, 1, sku, 10);

    // Generation is supervisor-only.
    const denied = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [lineId], strategy: 'single' },
      operatorHeaders,
    );
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
    assert.strictEqual(denied.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    const gen = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [lineId], strategy: 'single' },
      managerHeaders,
    );
    assert.strictEqual(gen.status, 201, JSON.stringify(gen.body));
    const taskId = (gen.body['pickTaskIds'] as string[])[0]!;
    const pickLineId = (gen.body['pickLineIds'] as string[])[0]!;

    // A site-B operator is site-scoped out of a site-A task.
    const crossSite = await makeRequest(
      port,
      'POST',
      `/api/v1/pick-tasks/${taskId}/lines/${pickLineId}/confirm`,
      { confirmedLotId: lotUuid, confirmedQuantity: '10', captureMethod: 'PWA' },
      siteBOperatorHeaders,
    );
    assert.strictEqual(crossSite.status, 403, JSON.stringify(crossSite.body));
    assert.strictEqual(crossSite.body['error_code'], 'LOCATION_ACCESS_DENIED');

    // Unknown dispatch-order line rejects with a stable code.
    const missing = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [randomUUID()], strategy: 'single' },
      managerHeaders,
    );
    assert.strictEqual(missing.status, 404, JSON.stringify(missing.body));
    assert.strictEqual(missing.body['error_code'], 'DISPATCH_ORDER_LINE_NOT_FOUND');
  });
});
