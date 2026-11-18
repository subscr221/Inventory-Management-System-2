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
  assert.strictEqual(res.status, 201, `provision ${externalId} failed: ${JSON.stringify(res.body)}`);
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub} failed: ${JSON.stringify(res.body)}`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

describe('Story 3.16: Floor task read contract extensions', () => {
  let server: Server;
  let port: number;
  let managerHeaders: Record<string, string>;
  let operatorHeaders: Record<string, string>;

  const siteAId = randomUUID();
  const zoneId = randomUUID();
  const binId = randomUUID();
  const run = randomUUID().slice(0, 8);

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

  async function seedItem(sku: string, uom: string): Promise<void> {
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
  ): Promise<string> {
    const result = await getPool().query(
      `INSERT INTO erp_sales_order
         (so_number_ext, line_no, sku, quantity, ship_from_site_id, ship_from_site_code_ext, status, source_system, last_synced_at)
       VALUES ($1, $2, $3, $4, $5, 'site-A316', 'open', 'ERP', now())
       RETURNING id`,
      [soNumber, lineNo, sku, quantity, siteAId],
    );
    return result.rows[0]!['id'] as string;
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

    await seedLocation(siteAId, `SITE-A316-${run}`, 'site', null, siteAId);
    await seedLocation(zoneId, `ZONE-316-${run}`, 'zone', siteAId, siteAId);
    const aisle = randomUUID();
    const rack = randomUUID();
    await seedLocation(aisle, `AISLE-316-${run}`, 'aisle', zoneId, siteAId);
    await seedLocation(rack, `RACK-316-${run}`, 'rack', aisle, siteAId);
    await seedLocation(binId, `BIN-316-${run}`, 'bin', rack, siteAId, 1);

    await provisionUser(port, `pick-manager-316-${run}@example.com`, [
      { role: 'warehouse_manager', module: 'warehouse', functionScope: 'write', locationId: siteAId },
    ]);
    managerHeaders = await authFor(port, `pick-manager-316-${run}@example.com`);

    await provisionUser(port, `pick-operator-316-${run}@example.com`, [
      { role: 'warehouse_operator', module: 'warehouse', functionScope: 'write', locationId: siteAId },
    ]);
    operatorHeaders = await authFor(port, `pick-operator-316-${run}@example.com`);
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
  });

  it('AC 3: list rows carry so_number_ext, confirmed_line_count and line_count', async () => {
    const sku = `FG-316A-${run}`;
    await seedItem(sku, 'EA');
    await seedLot(sku, `LOT-316A-${run}`);
    await seedStock(sku, binId, `LOT-316A-${run}`, 50);
    const orderLine = await seedOrderLine(`SO316-A-${run}`, 1, sku, 10);

    const generated = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [orderLine], strategy: 'single' },
      managerHeaders,
    );
    assert.strictEqual(generated.status, 201, JSON.stringify(generated.body));
    const taskId = (generated.body['pickTaskIds'] as string[])[0]!;

    const list = await makeRequest(
      port,
      'GET',
      `/api/v1/pick-tasks?site=${encodeURIComponent(siteAId)}&status=pending`,
      undefined,
      managerHeaders,
    );
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    const rows = (list.body['pick_tasks'] as Array<Record<string, unknown>>).filter(
      (r) => r['pick_task_id'] === taskId,
    );
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!['so_number_ext'], `SO316-A-${run}`);
    assert.strictEqual(rows[0]!['confirmed_line_count'], 0);
    assert.strictEqual(rows[0]!['line_count'], 1);
  });

  it('AC 3: detail lines carry location_code, directed_lot_number and uom', async () => {
    const sku = `FG-316B-${run}`;
    await seedItem(sku, 'KG');
    await seedLot(sku, `LOT-316B-${run}`);
    await seedStock(sku, binId, `LOT-316B-${run}`, 50);
    const orderLine = await seedOrderLine(`SO316-B-${run}`, 1, sku, 10);

    const generated = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [orderLine], strategy: 'single' },
      managerHeaders,
    );
    assert.strictEqual(generated.status, 201, JSON.stringify(generated.body));
    const taskId = (generated.body['pickTaskIds'] as string[])[0]!;

    const detail = await makeRequest(
      port,
      'GET',
      `/api/v1/pick-tasks/${taskId}`,
      undefined,
      operatorHeaders,
    );
    assert.strictEqual(detail.status, 200, JSON.stringify(detail.body));
    const lines = detail.body['lines'] as Array<Record<string, unknown>>;
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0]!['location_code'], `BIN-316-${run}`);
    assert.strictEqual(lines[0]!['directed_lot_number'], `LOT-316B-${run}`);
    assert.strictEqual(lines[0]!['uom'], 'KG');
  });

  it('AC 3: confirming a line moves confirmed_line_count and surfaces in the in_progress list', async () => {
    const sku = `FG-316C-${run}`;
    await seedItem(sku, 'EA');
    // Two lots in the same bin so FEFO splits the single order into two pick lines.
    const lotA = await seedLot(sku, `LOT-316CA-${run}`);
    const lotB = await seedLot(sku, `LOT-316CB-${run}`);
    await seedStock(sku, binId, `LOT-316CA-${run}`, 6);
    await seedStock(sku, binId, `LOT-316CB-${run}`, 4);
    const orderLine = await seedOrderLine(`SO316-C-${run}`, 1, sku, 10);

    const generated = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [orderLine], strategy: 'single' },
      managerHeaders,
    );
    assert.strictEqual(generated.status, 201, JSON.stringify(generated.body));
    const taskId = (generated.body['pickTaskIds'] as string[])[0]!;

    const detail = await makeRequest(
      port,
      'GET',
      `/api/v1/pick-tasks/${taskId}`,
      undefined,
      operatorHeaders,
    );
    const lines = detail.body['lines'] as Array<Record<string, unknown>>;
    assert.strictEqual(lines.length, 2);
    const firstLine = lines[0]!;
    const lotFor = (line: Record<string, unknown>): string =>
      line['directed_lot_number'] === `LOT-316CA-${run}` ? lotA : lotB;

    const confirm = await makeRequest(
      port,
      'POST',
      `/api/v1/pick-tasks/${taskId}/lines/${firstLine['pick_line_id'] as string}/confirm`,
      {
        confirmedLotId: lotFor(firstLine),
        confirmedQuantity: Number(firstLine['directed_quantity']),
        captureMethod: 'PWA',
      },
      operatorHeaders,
    );
    assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));

    const inProgress = await makeRequest(
      port,
      'GET',
      `/api/v1/pick-tasks?site=${encodeURIComponent(siteAId)}&status=in_progress`,
      undefined,
      managerHeaders,
    );
    const row = (inProgress.body['pick_tasks'] as Array<Record<string, unknown>>).find(
      (r) => r['pick_task_id'] === taskId,
    );
    assert.ok(row, 'task should surface in the in_progress list');
    assert.strictEqual(row['confirmed_line_count'], 1);
    assert.strictEqual(row['line_count'], 2);
    assert.strictEqual(row['status'], 'in_progress');
  });
});
