import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
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

/**
 * Pilot B4: a GRN is the valuated movement of the receiving flow (Story 2.4 AC1 "or from GRNs once
 * Epics 3 and 4 deliver receiving"), so an owned receipt must feed inventory_valuation at the PO
 * line's unit price. Production-stream issues are deliberately NOT covered here: Story 6.2 Binding
 * Decision 9 rules that they do not relieve valuation (deferred-work row 474).
 */
describe('Pilot B4: inventory valuation follows goods receipts', () => {
  let server: Server;
  let port: number;
  let storeHeaders: Record<string, string>;
  let financeHeaders: Record<string, string>;
  let plannerHeaders: Record<string, string>;
  let plannerUserId: string;
  let supervisorId: string;

  const run = randomUUID().slice(0, 8);
  const siteId = randomUUID();
  const dockId = randomUUID();
  const siteCode = `site-B4-${run}`;
  const dockCode = `RECV-DOCK-B4-${run}`;
  const ownedSku = `SKU-B4-OWN-${run}`;
  const explicitSku = `SKU-B4-EXP-${run}`;
  const consignmentSku = `SKU-B4-CON-${run}`;

  async function seedPo(
    poRef: string,
    sku: string,
    orderedQty: number,
    unitPrice: string,
    currency = 'INR',
  ) {
    await getPool().query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, expected_delivery_date, status, source_system, last_synced_at)
       VALUES ($1, 'SUP-B4', $2, CURRENT_DATE, 'open', 'ERP', now())`,
      [poRef, currency],
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, over_receipt_tolerance_pct, under_receipt_tolerance_pct, source_system, last_synced_at)
       VALUES ($1, 1, $2, $3, $3, $4::numeric, 5, 100, 'ERP', now())`,
      [poRef, sku, orderedQty, unitPrice],
    );
  }

  async function seedToken(poRef: string): Promise<string> {
    const token = randomUUID();
    await getPool().query(
      `INSERT INTO weighbridge_event
        (weighbridge_event_id, correlation_id, gate_event_id, site_id, site_code_ext, po_ref_ext, line_no,
         tare_kg, gross_kg, net_kg, status, device_id, capture_method, weighed_by, business_date, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1000, 1100, 100, 'accepted', 'WB-B4', 'MANUAL', $7, CURRENT_DATE, $8)`,
      [randomUUID(), token, randomUUID(), siteId, siteCode, poRef, supervisorId, randomUUID()],
    );
    return token;
  }

  async function receive(
    poRef: string,
    sku: string,
    receivedQty: number,
    overrides: Record<string, unknown> = {},
  ): Promise<{ res: HttpResult; grnLineId: string }> {
    const token = await seedToken(poRef);
    const grnLineId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/grn-lines',
      {
        grn_id: randomUUID(),
        grn_line_id: grnLineId,
        correlation_id: token,
        po_ref_ext: poRef,
        line_no: 1,
        source_document: 'PO',
        sku,
        target_location_code: dockCode,
        received_qty: receivedQty,
        ...overrides,
      },
      storeHeaders,
    );
    return { res, grnLineId };
  }

  async function valuationRow(
    sku: string,
  ): Promise<{ quantity: string; average: string | null; value: string } | null> {
    const r = await getPool().query(
      `SELECT quantity_on_hand::text AS quantity, running_average_cost::text AS average,
              carrying_value::text AS value
         FROM inventory_valuation WHERE sku = $1`,
      [sku],
    );
    return r.rows.length > 0
      ? (r.rows[0] as { quantity: string; average: string | null; value: string })
      : null;
  }

  before(async () => {
    server = createAppServer(createAppRouter());
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.off('error', reject);
        port = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
       VALUES ($1, $3, 'site', NULL, $1, 'general', 'ambient', false, 'active'),
              ($2, $4, 'zone', $1, $1, 'staging', 'ambient', false, 'active')`,
      [siteId, dockId, siteCode, dockCode],
    );
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ($1, 'EA', false, false, false, false, false, 'weighted_average', 'production', 'active'),
              ($2, 'EA', false, false, false, false, false, 'weighted_average', 'production', 'active'),
              ($3, 'EA', false, false, false, false, false, 'weighted_average', 'production', 'active')`,
      [ownedSku, explicitSku, consignmentSku],
    );

    await provisionUser(port, `b4-store-${run}@example.com`, [
      { role: 'store_assistant', module: 'receiving', functionScope: 'write', locationId: siteId },
    ]);
    storeHeaders = await authFor(port, `b4-store-${run}@example.com`);
    supervisorId = await provisionUser(port, `b4-supervisor-${run}@example.com`, [
      {
        role: 'unloading_supervisor',
        module: 'receiving',
        functionScope: 'write',
        locationId: siteId,
      },
    ]);
    await provisionUser(port, `b4-finance-${run}@example.com`, [
      { role: 'finance_controller', module: 'inventory', functionScope: 'read', locationId: '*' },
    ]);
    financeHeaders = await authFor(port, `b4-finance-${run}@example.com`);
    plannerUserId = await provisionUser(port, `b4-planner-${run}@example.com`, [
      {
        role: 'inventory_planner',
        module: 'inventory',
        functionScope: 'write',
        locationId: siteId,
      },
    ]);
    plannerHeaders = await authFor(port, `b4-planner-${run}@example.com`);
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
  });

  it('an owned GRN raises quantity and value at the PO line unit price, and the average re-weights', async () => {
    await seedPo(`PO-B4-1-${run}`, ownedSku, 80, '12.5000');
    const first = await receive(`PO-B4-1-${run}`, ownedSku, 80);
    assert.strictEqual(first.res.status, 201, JSON.stringify(first.res.body));
    assert.deepStrictEqual(await valuationRow(ownedSku), {
      quantity: '80.000000',
      average: '12.500000',
      value: '1000.000000',
    });

    await seedPo(`PO-B4-2-${run}`, ownedSku, 20, '20.0000');
    const second = await receive(`PO-B4-2-${run}`, ownedSku, 20);
    assert.strictEqual(second.res.status, 201, JSON.stringify(second.res.body));
    assert.deepStrictEqual(await valuationRow(ownedSku), {
      quantity: '100.000000',
      average: '14.000000',
      value: '1400.000000',
    });

    const api = await makeRequest(
      port,
      'GET',
      `/api/v1/stock/${ownedSku}/valuation`,
      undefined,
      financeHeaders,
    );
    assert.strictEqual(api.status, 200, JSON.stringify(api.body));
    assert.strictEqual(api.body['quantity_on_hand'], 100);
    assert.strictEqual(api.body['carrying_value'], 1400);
  });

  it('the persisted goods.received event carries the resolved unit_cost so a replay reproduces it', async () => {
    const r = await getPool().query(
      `SELECT payload->>'unit_cost' AS unit_cost FROM domain_events
        WHERE event_type = 'goods.received' AND payload->>'sku' = $1 ORDER BY payload->>'unit_cost'`,
      [ownedSku],
    );
    assert.deepStrictEqual(
      r.rows.map((row: Record<string, unknown>) => Number(row['unit_cost'])),
      [12.5, 20],
    );
  });

  it('an inventory issue after the GRNs lowers quantity at the current average cost', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: randomUUID(),
        event_type: 'stock.issued',
        payload: {
          business_stream: 'production',
          sku: ownedSku,
          target_location_id: dockId,
          quantity: 4,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'inventory_planner', location_id: siteId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.ok(res.status >= 200 && res.status < 300, JSON.stringify(res.body));
    assert.deepStrictEqual(await valuationRow(ownedSku), {
      quantity: '96.000000',
      average: '14.000000',
      value: '1344.000000',
    });
  });

  it('a unit_cost supplied on the GRN line wins over the PO line price', async () => {
    await seedPo(`PO-B4-3-${run}`, explicitSku, 10, '5.0000');
    const { res } = await receive(`PO-B4-3-${run}`, explicitSku, 10, { unit_cost: 7 });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.deepStrictEqual(await valuationRow(explicitSku), {
      quantity: '10.000000',
      average: '7.000000',
      value: '70.000000',
    });
  });

  it('a malformed unit_cost on the GRN line is refused and posts nothing', async () => {
    await seedPo(`PO-B4-4-${run}`, explicitSku, 10, '5.0000');
    const { res } = await receive(`PO-B4-4-${run}`, explicitSku, 10, { unit_cost: -1 });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual((await valuationRow(explicitSku))!.quantity, '10.000000');
  });

  it('a consignment GRN posts stock but leaves valuation untouched', async () => {
    await getPool().query(
      `INSERT INTO ownership_agreement (agreement_id, sku, location_id, stock_class, owner_party_code, business_stream)
       VALUES ($1, $2, $3, 'consignment', 'SUP-B4', 'production')`,
      [randomUUID(), consignmentSku, dockId],
    );
    await seedPo(`PO-B4-5-${run}`, consignmentSku, 30, '9.0000');
    const { res } = await receive(`PO-B4-5-${run}`, consignmentSku, 30, {
      stock_class: 'consignment',
      owner_party_code: 'SUP-B4',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const stock = await getPool().query(
      `SELECT COALESCE(SUM(on_hand), 0)::float AS q FROM stock_balance WHERE sku = $1 AND stock_class = 'consignment'`,
      [consignmentSku],
    );
    assert.strictEqual(stock.rows[0]!['q'], 30);
    const row = await valuationRow(consignmentSku);
    assert.ok(row === null || row.quantity === '0.000000', JSON.stringify(row));
  });

  // Review R2/R3/R4: the PO-price default applies only when it is a safe cost basis.
  async function storedUnitCost(grnLineId: string): Promise<{ has: boolean; text: string | null }> {
    const r = await getPool().query(
      `SELECT payload ? 'unit_cost' AS has, payload->>'unit_cost' AS text,
              jsonb_typeof(payload->'unit_cost') AS kind
         FROM domain_events
        WHERE event_type = 'goods.received' AND payload->>'grn_line_id' = $1`,
      [grnLineId],
    );
    assert.strictEqual(r.rows.length, 1, 'exactly one goods.received event for the GRN line');
    return { has: r.rows[0]!['has'] as boolean, text: r.rows[0]!['text'] as string | null };
  }

  async function ownedOnHand(sku: string): Promise<number> {
    const r = await getPool().query(
      `SELECT COALESCE(SUM(on_hand), 0)::float AS q FROM stock_balance WHERE sku = $1 AND stock_class = 'owned'`,
      [sku],
    );
    return r.rows[0]!['q'] as number;
  }

  async function seedItem(sku: string, valuationMethod = 'weighted_average'): Promise<void> {
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ($1, 'EA', false, false, false, false, false, $2, 'production', 'active')`,
      [sku, valuationMethod],
    );
  }

  it('a PO in a currency other than the books currency is received but not valued', async () => {
    const sku = `SKU-B4-USD-${run}`;
    await seedItem(sku);
    await seedPo(`PO-B4-USD-${run}`, sku, 10, '3.0000', 'USD');
    const { res, grnLineId } = await receive(`PO-B4-USD-${run}`, sku, 10);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(await ownedOnHand(sku), 10);
    const row = await valuationRow(sku);
    assert.ok(row === null || row.value === '0.000000', JSON.stringify(row));
    assert.strictEqual((await storedUnitCost(grnLineId)).has, false);
  });

  it('a zero-price PO line is an unpriced placeholder: received, not valued', async () => {
    const sku = `SKU-B4-ZERO-${run}`;
    await seedItem(sku);
    await seedPo(`PO-B4-ZERO-${run}`, sku, 10, '0');
    const { res, grnLineId } = await receive(`PO-B4-ZERO-${run}`, sku, 10);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(await ownedOnHand(sku), 10);
    const row = await valuationRow(sku);
    assert.ok(row === null || row.value === '0.000000', JSON.stringify(row));
    assert.strictEqual((await storedUnitCost(grnLineId)).has, false);
  });

  it('a specific_identification item without serials is received as before B4, with no defaulted cost', async () => {
    const sku = `SKU-B4-SPEC-${run}`;
    await seedItem(sku, 'specific_identification');
    await seedPo(`PO-B4-SPEC-${run}`, sku, 4, '250.0000');
    const { res, grnLineId } = await receive(`PO-B4-SPEC-${run}`, sku, 4);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(await ownedOnHand(sku), 4);
    assert.strictEqual((await storedUnitCost(grnLineId)).has, false);
  });

  it('a decimal unit_cost string round-trips exactly on the stored event', async () => {
    const sku = `SKU-B4-DEC-${run}`;
    await seedItem(sku);
    await seedPo(`PO-B4-DEC-${run}`, sku, 10, '5.0000');
    const { res, grnLineId } = await receive(`PO-B4-DEC-${run}`, sku, 10, {
      unit_cost: '84.123456',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const stored = await getPool().query(
      `SELECT jsonb_typeof(payload->'unit_cost') AS kind, payload->>'unit_cost' AS text
         FROM domain_events WHERE event_type = 'goods.received' AND payload->>'grn_line_id' = $1`,
      [grnLineId],
    );
    assert.deepStrictEqual(stored.rows[0], { kind: 'string', text: '84.123456' });
    assert.strictEqual((await valuationRow(sku))!.value, '841.234560');
  });

  it('the defaulted cost is the PO NUMERIC as a string, not a float', async () => {
    const sku = `SKU-B4-DEF-${run}`;
    await seedItem(sku);
    await seedPo(`PO-B4-DEF-${run}`, sku, 10, '84.1235');
    const { res, grnLineId } = await receive(`PO-B4-DEF-${run}`, sku, 10);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const stored = await getPool().query(
      `SELECT jsonb_typeof(payload->'unit_cost') AS kind, payload->>'unit_cost' AS text
         FROM domain_events WHERE event_type = 'goods.received' AND payload->>'grn_line_id' = $1`,
      [grnLineId],
    );
    assert.deepStrictEqual(stored.rows[0], { kind: 'string', text: '84.1235' });
  });

  it('an idempotent re-POST of the same GRN line values the receipt once', async () => {
    const sku = `SKU-B4-IDEM-${run}`;
    await seedItem(sku);
    await seedPo(`PO-B4-IDEM-${run}`, sku, 10, '6.0000');
    const body = {
      grn_id: randomUUID(),
      grn_line_id: randomUUID(),
      correlation_id: await seedToken(`PO-B4-IDEM-${run}`),
      po_ref_ext: `PO-B4-IDEM-${run}`,
      line_no: 1,
      source_document: 'PO',
      sku,
      target_location_code: dockCode,
      received_qty: 10,
    };
    const first = await makeRequest(port, 'POST', '/api/v1/grn-lines', body, storeHeaders);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const again = await makeRequest(port, 'POST', '/api/v1/grn-lines', body, storeHeaders);
    assert.ok(again.status < 500, JSON.stringify(again.body));
    assert.strictEqual(await ownedOnHand(sku), 10);
    assert.deepStrictEqual(await valuationRow(sku), {
      quantity: '10.000000',
      average: '6.000000',
      value: '60.000000',
    });
  });
});
