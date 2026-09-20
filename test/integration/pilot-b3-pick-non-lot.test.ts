import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppServer } from '../../src/server.js';
import { closePool, getPool } from '../../src/config/db.js';
import {
  assertPickLineConfirmedShape,
  assertPickTaskCreatedShape,
} from '../../src/compliance/pick.js';
import type {
  PickLineConfirmedEnvelope,
  PickTaskCreatedEnvelope,
} from '../../src/events/schema.js';

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

describe('Pilot B3: stock that is not lot-controlled can be picked', () => {
  let server: Server;
  let port: number;
  let managerHeaders: Record<string, string>;
  let operatorHeaders: Record<string, string>;

  const siteId = randomUUID();
  const zoneId = randomUUID();
  const binP1 = randomUUID();
  const binP2 = randomUUID();
  const run = randomUUID().slice(0, 8);

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

  /** A NULL lotNumber seeds the lot-less balance row a plain (not lot-controlled) item carries. */
  async function seedStock(
    sku: string,
    locationId: string,
    lotNumber: string | null,
    onHand: number,
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand)
       VALUES ($1, $2, $3, 'owned', $4)`,
      [sku, locationId, lotNumber, onHand],
    );
  }

  async function seedOrderLine(soNumber: string, sku: string, quantity: number): Promise<string> {
    const result = await getPool().query(
      `INSERT INTO erp_sales_order
         (so_number_ext, line_no, sku, quantity, ship_from_site_id, ship_from_site_code_ext, status, source_system, last_synced_at)
       VALUES ($1, 1, $2, $3, $4, 'site-B3', 'open', 'ERP', now())
       RETURNING id`,
      [soNumber, sku, quantity, siteId],
    );
    return result.rows[0]!['id'] as string;
  }

  async function balanceFor(
    sku: string,
    locationId: string,
    lotNumber: string | null,
  ): Promise<{ on_hand: number; allocated: number; picked: number; available: number }> {
    const result = await getPool().query(
      `SELECT on_hand::float8 AS on_hand, allocated::float8 AS allocated, picked::float8 AS picked,
              available::float8 AS available
         FROM stock_balance
        WHERE sku = $1 AND location_id = $2 AND lot_id IS NOT DISTINCT FROM $3::text AND stock_class = 'owned'`,
      [sku, locationId, lotNumber],
    );
    assert.strictEqual(result.rows.length, 1, 'exactly one balance row at the grain');
    return result.rows[0] as {
      on_hand: number;
      allocated: number;
      picked: number;
      available: number;
    };
  }

  function generate(lineId: string): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [lineId], strategy: 'single' },
      managerHeaders,
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

    await seedLocation(siteId, `SITE-B3-${run}`, 'site', null);
    await seedLocation(zoneId, `ZONE-B3-${run}`, 'zone', siteId);
    const aisle = randomUUID();
    const rack = randomUUID();
    await seedLocation(aisle, `AISLE-B3-${run}`, 'aisle', zoneId);
    await seedLocation(rack, `RACK-B3-${run}`, 'rack', aisle);
    await seedLocation(binP1, `BIN-P1-B3-${run}`, 'bin', rack, 10);
    await seedLocation(binP2, `BIN-P2-B3-${run}`, 'bin', rack, 20);

    await provisionUser(port, `b3-manager-${run}@example.com`, [
      {
        role: 'warehouse_manager',
        module: 'warehouse',
        functionScope: 'write',
        locationId: siteId,
      },
    ]);
    managerHeaders = await authFor(port, `b3-manager-${run}@example.com`);
    await provisionUser(port, `b3-operator-${run}@example.com`, [
      { role: 'store_assistant', module: 'warehouse', functionScope: 'write', locationId: siteId },
    ]);
    operatorHeaders = await authFor(port, `b3-operator-${run}@example.com`);
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
  });

  it('a plain item generates a pick task with lot-less lines and allocates the lot-less balance', async () => {
    const sku = `PLAIN-GEN-${run}`;
    await seedStock(sku, binP1, null, 83);
    const lineId = await seedOrderLine(`SOB3-GEN-${run}`, sku, 10);

    const res = await generate(lineId);
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
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0]!['location_id'], binP1);
    assert.strictEqual(lines[0]!['directed_lot_id'], null);
    assert.strictEqual(Number(lines[0]!['directed_quantity']), 10);

    const balance = await balanceFor(sku, binP1, null);
    assert.strictEqual(balance.allocated, 10);
    assert.strictEqual(balance.available, 73);
  });

  it('confirming and completing a lot-less pick moves the quantity to picked at the right bin only', async () => {
    const sku = `PLAIN-DONE-${run}`;
    // Bin P1 (pick_sequence 10) is drained first; bin P2 covers the remainder.
    await seedStock(sku, binP1, null, 6);
    await seedStock(sku, binP2, null, 50);
    const lineId = await seedOrderLine(`SOB3-DONE-${run}`, sku, 10);

    const gen = await generate(lineId);
    assert.strictEqual(gen.status, 201, JSON.stringify(gen.body));
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

    for (const line of lines) {
      const confirm = await makeRequest(
        port,
        'POST',
        `/api/v1/pick-tasks/${taskId}/lines/${line['pick_line_id']}/confirm`,
        {
          confirmedLotId: null,
          confirmedQuantity: line['directed_quantity'],
          captureMethod: 'PWA',
        },
        operatorHeaders,
      );
      assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
      assert.strictEqual((confirm.body['line'] as Record<string, unknown>)['status'], 'confirmed');
    }

    const after = await makeRequest(
      port,
      'GET',
      `/api/v1/pick-tasks/${taskId}`,
      undefined,
      managerHeaders,
    );
    assert.strictEqual((after.body['task'] as Record<string, unknown>)['status'], 'completed');

    const p1 = await balanceFor(sku, binP1, null);
    const p2 = await balanceFor(sku, binP2, null);
    assert.deepStrictEqual(p1, { on_hand: 6, allocated: 0, picked: 6, available: 0 });
    assert.deepStrictEqual(p2, { on_hand: 50, allocated: 0, picked: 4, available: 46 });
  });

  it('insufficient plain stock is still refused with no partial allocation', async () => {
    const sku = `PLAIN-SHORT-${run}`;
    await seedStock(sku, binP1, null, 5);
    const lineId = await seedOrderLine(`SOB3-SHORT-${run}`, sku, 50);

    const res = await generate(lineId);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INSUFFICIENT_STOCK_FOR_PICK');
    assert.strictEqual((await balanceFor(sku, binP1, null)).allocated, 0);
  });

  it('a lot-controlled item never draws from a stray lot-less balance', async () => {
    const sku = `LOTTED-B3-${run}`;
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, valuation_method, business_stream)
       VALUES ($1, 'EA', true, 'weighted_average', 'manufacturing')`,
      [sku],
    );
    await seedStock(sku, binP1, null, 40);
    const lineId = await seedOrderLine(`SOB3-LOTTED-${run}`, sku, 10);

    const res = await generate(lineId);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INSUFFICIENT_STOCK_FOR_PICK');
    assert.strictEqual((await balanceFor(sku, binP1, null)).allocated, 0);
  });

  it('a lot-less line cannot be confirmed against a lot, and a lot line cannot be confirmed lot-less', async () => {
    const plainSku = `PLAIN-SUB-${run}`;
    await seedStock(plainSku, binP1, null, 20);
    const plainLine = await seedOrderLine(`SOB3-SUB1-${run}`, plainSku, 5);
    const genPlain = await generate(plainLine);
    assert.strictEqual(genPlain.status, 201, JSON.stringify(genPlain.body));
    const plainTask = (genPlain.body['pickTaskIds'] as string[])[0]!;
    const plainPickLine = (genPlain.body['pickLineIds'] as string[])[0]!;
    const toLot = await makeRequest(
      port,
      'POST',
      `/api/v1/pick-tasks/${plainTask}/lines/${plainPickLine}/confirm`,
      {
        confirmedLotId: randomUUID(),
        confirmedQuantity: '5',
        captureMethod: 'PWA',
        overrideReason: 'wrong',
      },
      operatorHeaders,
    );
    assert.strictEqual(toLot.status, 400, JSON.stringify(toLot.body));
    assert.strictEqual(toLot.body['error_code'], 'PICK_TASK_INVALID_PAYLOAD');

    const lotSku = `LOT-SUB-${run}`;
    const lotNumber = `LOT-B3-${run}`;
    await getPool().query(
      `INSERT INTO lot_master (lot_number, sku, expiry_date, quality_hold_status) VALUES ($1, $2, NULL, 'none')`,
      [lotNumber, lotSku],
    );
    await seedStock(lotSku, binP1, lotNumber, 20);
    const lotLine = await seedOrderLine(`SOB3-SUB2-${run}`, lotSku, 5);
    const genLot = await generate(lotLine);
    assert.strictEqual(genLot.status, 201, JSON.stringify(genLot.body));
    const lotTask = (genLot.body['pickTaskIds'] as string[])[0]!;
    const lotPickLine = (genLot.body['pickLineIds'] as string[])[0]!;
    const toNone = await makeRequest(
      port,
      'POST',
      `/api/v1/pick-tasks/${lotTask}/lines/${lotPickLine}/confirm`,
      {
        confirmedLotId: null,
        confirmedQuantity: '5',
        captureMethod: 'PWA',
        overrideReason: 'wrong',
      },
      operatorHeaders,
    );
    assert.strictEqual(toNone.status, 400, JSON.stringify(toNone.body));
    assert.strictEqual(toNone.body['error_code'], 'PICK_TASK_INVALID_PAYLOAD');
    assert.strictEqual((await balanceFor(lotSku, binP1, lotNumber)).allocated, 5);
  });

  it('two concurrent generations on the same lot-less row never allocate more than is available', async () => {
    const sku = `PLAIN-RACE-${run}`;
    await seedStock(sku, binP1, null, 10);
    const lineA = await seedOrderLine(`SOB3-RACE-A-${run}`, sku, 8);
    const lineB = await seedOrderLine(`SOB3-RACE-B-${run}`, sku, 8);

    const results = await Promise.all([generate(lineA), generate(lineB)]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepStrictEqual(statuses, [201, 409], JSON.stringify(results.map((r) => r.body)));
    const balance = await balanceFor(sku, binP1, null);
    assert.strictEqual(balance.allocated, 8);
    assert.strictEqual(balance.available, 2);
  });

  it('a pre-B3 style pick event that names a lot still validates, and a missing lot is still refused', () => {
    const lotId = randomUUID();
    const created = {
      payload: {
        pick_task_id: randomUUID(),
        dispatch_order_id: randomUUID(),
        sku: 'OLD-SKU',
        quantity: '5',
        lot_id: lotId,
        location_id: randomUUID(),
        pick_sequence: 10,
        strategy: 'single',
        zone_id: randomUUID(),
        pick_lines: [
          {
            pick_line_id: randomUUID(),
            dispatch_order_line_id: randomUUID(),
            sku: 'OLD-SKU',
            directed_lot_id: lotId,
            directed_quantity: '5',
            location_id: randomUUID(),
            pick_sequence: 10,
          },
        ],
      },
    } as unknown as PickTaskCreatedEnvelope;
    assert.doesNotThrow(() => assertPickTaskCreatedShape(created));

    const confirmed = {
      payload: {
        pick_task_id: randomUUID(),
        pick_line_id: randomUUID(),
        confirmed_lot_id: lotId,
        confirmed_quantity: '5',
        capture_method: 'PWA',
      },
    } as unknown as PickLineConfirmedEnvelope;
    assert.doesNotThrow(() => assertPickLineConfirmedShape(confirmed));

    // Only an explicit null is the lot-less form; an absent key is a malformed event, as before.
    delete (confirmed.payload as unknown as Record<string, unknown>)['confirmed_lot_id'];
    assert.throws(() => assertPickLineConfirmedShape(confirmed), /confirmed_lot_id/);
  });

  // Review R1: a lot-less pick must be able to leave the building - pack, documents, dispatch.
  function post(path: string, body: unknown): Promise<HttpResult> {
    return makeRequest(port, 'POST', path, body, managerHeaders);
  }

  /** generate -> confirm every line (which completes the task); returns nothing, asserts each step. */
  async function pickAll(lineId: string, confirmedLotId: string | null): Promise<void> {
    const gen = await generate(lineId);
    assert.strictEqual(gen.status, 201, JSON.stringify(gen.body));
    const taskId = (gen.body['pickTaskIds'] as string[])[0]!;
    const detail = await makeRequest(
      port,
      'GET',
      `/api/v1/pick-tasks/${taskId}`,
      undefined,
      managerHeaders,
    );
    for (const line of detail.body['lines'] as Array<Record<string, unknown>>) {
      const confirm = await makeRequest(
        port,
        'POST',
        `/api/v1/pick-tasks/${taskId}/lines/${line['pick_line_id']}/confirm`,
        { confirmedLotId, confirmedQuantity: line['directed_quantity'], captureMethod: 'PWA' },
        operatorHeaders,
      );
      assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
    }
  }

  async function documentsThenDispatch(orderId: string, seed: string): Promise<void> {
    const docs = await post(`/api/v1/dispatch/${orderId}/generate-documents`, {
      dispatchOrderId: orderId,
    });
    assert.strictEqual(docs.status, 200, docs.raw);
    const irn = await post(`/api/v1/dispatch/${orderId}/irn`, {
      idempotency_key: randomUUID(),
      invoice_number_ext: `INV-B3-${seed}-${run}`,
      irn_ext: createHash('sha256').update(`IRN-B3-${seed}-${run}`).digest('hex'),
    });
    assert.strictEqual(irn.status, 200, irn.raw);
    const dispatched = await post(`/api/v1/dispatch/${orderId}/dispatch`, {
      dispatchOrderId: orderId,
    });
    assert.strictEqual(dispatched.status, 200, dispatched.raw);
  }

  it('a lot-less pick is packed, documented and dispatched, and the quantity leaves the right balance row only', async () => {
    const sku = `PLAIN-SHIP-${run}`;
    // Plain stock has no lot to keep a pick inside one bin: this one drains P1 (6) and takes 4 from P2.
    await seedStock(sku, binP1, null, 6);
    await seedStock(sku, binP2, null, 50);
    const orderId = await seedOrderLine(`SOB3-SHIP-${run}`, sku, 10);
    await pickAll(orderId, null);
    // P2 also holds another order's picked quantity: the dispatch decrement must leave it alone.
    await getPool().query(
      `UPDATE stock_balance SET picked = picked + 15
        WHERE sku = $1 AND location_id = $2 AND lot_id IS NULL AND stock_class = 'owned'`,
      [sku, binP2],
    );

    const pack = await post(`/api/v1/dispatch/${orderId}/pack`, {
      dispatchOrderId: orderId,
      packingLines: [{ sku, packed_qty: '10', lot_id: null, carton_count: 1 }],
    });
    assert.strictEqual(pack.status, 200, pack.raw);

    await documentsThenDispatch(orderId, 'SHIP');

    // The lot-less line is on the documents, not silently dropped by a lot_master join.
    const docs = await getPool().query(
      `SELECT document_type, document_content FROM dispatch_document WHERE dispatch_order_id = $1`,
      [orderId],
    );
    const slip = docs.rows.find((r) => r['document_type'] === 'packing_slip');
    assert.ok(slip, 'a packing slip was generated');
    assert.match(String(slip['document_content']), new RegExp(`SKU: ${sku}`));
    assert.doesNotMatch(String(slip['document_content']), /Lot: (null|undefined)/);

    assert.deepStrictEqual(await balanceFor(sku, binP1, null), {
      on_hand: 0,
      allocated: 0,
      picked: 0,
      available: 0,
    });
    assert.deepStrictEqual(await balanceFor(sku, binP2, null), {
      on_hand: 46,
      allocated: 0,
      picked: 15,
      available: 31,
    });
  });

  it('a lot-controlled item still needs a lot on the packing record; with it the lot path is unchanged', async () => {
    const sku = `LOT-SHIP-${run}`;
    const lotNumber = `LOT-SHIP-B3-${run}`;
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, valuation_method, business_stream)
       VALUES ($1, 'EA', true, 'weighted_average', 'manufacturing')`,
      [sku],
    );
    const lot = await getPool().query(
      `INSERT INTO lot_master (lot_number, sku, expiry_date, quality_hold_status)
       VALUES ($1, $2, NULL, 'none') RETURNING lot_id`,
      [lotNumber, sku],
    );
    const lotId = lot.rows[0]!['lot_id'] as string;
    await seedStock(sku, binP1, lotNumber, 25);
    const orderId = await seedOrderLine(`SOB3-LOTSHIP-${run}`, sku, 5);
    await pickAll(orderId, lotId);

    const lotLess = await post(`/api/v1/dispatch/${orderId}/pack`, {
      dispatchOrderId: orderId,
      packingLines: [{ sku, packed_qty: '5', lot_id: null, carton_count: 1 }],
    });
    assert.strictEqual(lotLess.status, 400, lotLess.raw);
    assert.strictEqual(lotLess.body['error_code'], 'DISPATCH_PACKED_INVALID_PAYLOAD');
    const none = await getPool().query(
      `SELECT 1 FROM packing_record WHERE dispatch_order_id = $1`,
      [orderId],
    );
    assert.strictEqual(none.rows.length, 0, 'the refused record was not written');

    const pack = await post(`/api/v1/dispatch/${orderId}/pack`, {
      dispatchOrderId: orderId,
      packingLines: [{ sku, packed_qty: '5', lot_id: lotId, carton_count: 1 }],
    });
    assert.strictEqual(pack.status, 200, pack.raw);
    await documentsThenDispatch(orderId, 'LOTSHIP');
    assert.deepStrictEqual(await balanceFor(sku, binP1, lotNumber), {
      on_hand: 20,
      allocated: 0,
      picked: 0,
      available: 20,
    });
  });

  it('a lot-less packing record is refused when the order was picked from a lot', async () => {
    // Not lot-controlled in item_master, yet the stock sits in a lot and was picked from it: the
    // packing record must name that lot, or the decrement would look for a lot-less row.
    const sku = `SOFT-LOT-${run}`;
    const lotNumber = `LOT-SOFT-B3-${run}`;
    const lot = await getPool().query(
      `INSERT INTO lot_master (lot_number, sku, expiry_date, quality_hold_status)
       VALUES ($1, $2, NULL, 'none') RETURNING lot_id`,
      [lotNumber, sku],
    );
    await seedStock(sku, binP1, lotNumber, 12);
    const orderId = await seedOrderLine(`SOB3-SOFT-${run}`, sku, 4);
    await pickAll(orderId, lot.rows[0]!['lot_id'] as string);

    const lotLess = await post(`/api/v1/dispatch/${orderId}/pack`, {
      dispatchOrderId: orderId,
      packingLines: [{ sku, packed_qty: '4', lot_id: null, carton_count: 1 }],
    });
    assert.strictEqual(lotLess.status, 400, lotLess.raw);
    assert.strictEqual(lotLess.body['error_code'], 'DISPATCH_PACKED_INVALID_PAYLOAD');
  });
});
