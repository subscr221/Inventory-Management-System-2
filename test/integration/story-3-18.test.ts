import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';

/**
 * Story 3.18 (AC 1, AC 2, AC 4): the pack station bootstrap nav row, the dispatch list read with
 * its four-way stage derivation and IRN coverage, and the picked-lines read.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: `Bearer ${process.env['SCIM_BEARER_TOKEN'] ?? ''}` };

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
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
              parsed = { error_code: 'NON_JSON_BODY', raw };
            }
          }
          resolvePromise({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
    if (data) req.write(data);
    req.end();
  });
}

async function provisionUser(
  port: number,
  externalId: string,
  roles: Array<{
    role: string;
    module: string;
    functionScope: 'read' | 'write';
    locationId: string;
  }>,
): Promise<string> {
  const res = await makeRequest(
    port,
    'POST',
    '/api/v1/scim/v2/Users',
    { externalId, email: externalId, displayName: externalId, roles },
    SCIM_HEADERS,
  );
  assert.strictEqual(res.status, 201, `provision ${externalId}: ${JSON.stringify(res.body)}`);
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(res.status >= 200 && res.status < 300, JSON.stringify(res.body));
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

const IRN64 = 'a'.repeat(64);

describe('Story 3.18 Pack Station and Dispatch Screen', () => {
  let server: Server;
  let port: number;
  let siteAId: string;
  let siteBId: string;
  let dispatchHeaders: Record<string, string>;
  let managerHeaders: Record<string, string>;
  let storeHeaders: Record<string, string>;
  let invClerkHeaders: Record<string, string>;
  let gateHeaders: Record<string, string>;

  const soPicked = randomUUID();
  const soPacked = randomUUID();
  const soDocs = randomUUID();
  const soDocsIrn = randomUUID();
  const soDispatched = randomUUID();
  const soSiteB = randomUUID();

  before(async () => {
    const adminPool = getAdminPool();
    for (const file of [
      '../../events/domain_events.sql',
      '../../read/projections/users.sql',
      '../../read/projections/audit_log.sql',
      '../../read/projections/location_register.sql',
      '../../read/projections/item_master.sql',
      '../../read/projections/erp_sales_order.sql',
      '../../read/projections/pick_task.sql',
      '../../read/projections/packing_record.sql',
      '../../read/projections/dispatch_document.sql',
      '../../read/projections/dispatch_irn.sql',
      '../../read/projections/lot_master.sql',
      '../../read/projections/pick_line.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE pick_line, packing_record, dispatch_document, dispatch_irn, dispatch_order_status, pick_task, erp_sales_order, lot_master, item_master, location_register, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    siteAId = randomUUID();
    await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
       VALUES ($1, 'site-A', 'site', NULL, $1, 'general', 'ambient', false, 'active')`,
      [siteAId],
    );
    siteBId = randomUUID();
    await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
       VALUES ($1, 'site-B', 'site', NULL, $1, 'general', 'ambient', false, 'active')`,
      [siteBId],
    );
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ('SKU-3-18', 'EA', true, false, false, false, false, 'weighted_average', 'production', 'active')`,
    );

    server = createAppServer(createAppRouter());
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.off('error', reject);
        port = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    // AC 1 personas: dispatch clerk (warehouse write) and warehouse manager get the nav row; a
    // store assistant (warehouse write, wrong role) and a dispatch clerk holding only inventory
    // read do not.
    await provisionUser(port, 'dispatch-3-18@example.com', [
      { role: 'dispatch_clerk', module: 'warehouse', functionScope: 'write', locationId: siteAId },
    ]);
    dispatchHeaders = await authFor(port, 'dispatch-3-18@example.com');
    await provisionUser(port, 'manager-3-18@example.com', [
      {
        role: 'warehouse_manager',
        module: 'warehouse',
        functionScope: 'write',
        locationId: siteAId,
      },
    ]);
    managerHeaders = await authFor(port, 'manager-3-18@example.com');
    await provisionUser(port, 'store-3-18@example.com', [
      { role: 'store_assistant', module: 'warehouse', functionScope: 'write', locationId: siteAId },
    ]);
    storeHeaders = await authFor(port, 'store-3-18@example.com');
    await provisionUser(port, 'invclerk-3-18@example.com', [
      { role: 'dispatch_clerk', module: 'inventory', functionScope: 'read', locationId: siteAId },
    ]);
    invClerkHeaders = await authFor(port, 'invclerk-3-18@example.com');
    await provisionUser(port, 'gate-3-18@example.com', [
      { role: 'gate_officer', module: 'gate', functionScope: 'write', locationId: siteAId },
    ]);
    gateHeaders = await authFor(port, 'gate-3-18@example.com');

    const insertSo = async (id: string, siteId: string, code: string, so: string) =>
      getPool().query(
        `INSERT INTO erp_sales_order (id, so_number_ext, line_no, sku, quantity, ship_to_ext, ship_from_site_id, ship_from_site_code_ext, status, source_system, last_synced_at)
         VALUES ($1, $2, 1, 'SKU-3-18', 10, 'Kisan Agro', $3, $4, 'open', 'ERP', now())`,
        [id, so, siteId, code],
      );
    const insertStatus = async (id: string, args: { packed?: boolean; dispatched?: boolean }) =>
      getPool().query(
        `INSERT INTO dispatch_order_status (dispatch_order_id, picked_at, picked_by, packed_at, dispatched_at)
         VALUES ($1, now(), $2, $3, $4)`,
        [
          id,
          randomUUID(),
          args.packed ? new Date().toISOString() : null,
          args.dispatched ? new Date().toISOString() : null,
        ],
      );

    await insertSo(soPicked, siteAId, 'site-A', 'SO-3-18-1');
    await insertStatus(soPicked, {});
    await insertSo(soPacked, siteAId, 'site-A', 'SO-3-18-2');
    await insertStatus(soPacked, { packed: true });
    await insertSo(soDocs, siteAId, 'site-A', 'SO-3-18-3');
    await insertStatus(soDocs, { packed: true });
    await getPool().query(
      `INSERT INTO dispatch_document (document_id, dispatch_order_id, document_type, document_content, generated_by)
       VALUES ($1, $2, 'packing_slip', 'PACKING SLIP', $3)`,
      [randomUUID(), soDocs, randomUUID()],
    );
    await insertSo(soDocsIrn, siteAId, 'site-A', 'SO-3-18-4');
    await insertStatus(soDocsIrn, { packed: true });
    await getPool().query(
      `INSERT INTO dispatch_document (document_id, dispatch_order_id, document_type, document_content, generated_by)
       VALUES ($1, $2, 'commercial_invoice', 'TAX INVOICE', $3)`,
      [randomUUID(), soDocsIrn, randomUUID()],
    );
    await getPool().query(
      `INSERT INTO dispatch_irn (dispatch_order_id, invoice_number_ext, irn_ext, so_number_ext, site_id, recorded_by, source_event_id)
       VALUES ($1, 'INV-3-18', $2, 'SO-3-18-4', $3, $4, $5)`,
      [soDocsIrn, IRN64, siteAId, randomUUID(), randomUUID()],
    );
    await insertSo(soDispatched, siteAId, 'site-A', 'SO-3-18-5');
    await insertStatus(soDispatched, { packed: true, dispatched: true });
    await insertSo(soSiteB, siteBId, 'site-B', 'SO-3-18-B');
    await insertStatus(soSiteB, {});

    // AC 4 picked-lines seed: two confirmed pick lines for soPicked, one lot-controlled with a
    // lot_number bridge, one substituted.
    const pickTaskId = randomUUID();
    await getPool().query(
      `INSERT INTO pick_task (pick_task_id, dispatch_order_id, sku, total_quantity, strategy, zone_id, status, created_by)
       VALUES ($1, $2, 'SKU-3-18', 10, 'single', $3, 'completed', $4)`,
      [pickTaskId, soPicked, siteAId, randomUUID()],
    );
    const lotA = randomUUID();
    const lotB = randomUUID();
    await getPool().query(
      `INSERT INTO lot_master (lot_id, lot_number, sku) VALUES ($1, 'L-3-18-A', 'SKU-3-18'), ($2, 'L-3-18-B', 'SKU-3-18')`,
      [lotA, lotB],
    );
    await getPool().query(
      `INSERT INTO pick_line (pick_line_id, pick_task_id, dispatch_order_line_id, sku, directed_lot_id, confirmed_lot_id, directed_quantity, confirmed_quantity, location_id, pick_sequence, status, capture_method)
       VALUES ($1, $2, $3, 'SKU-3-18', $4, $4, 6, 6, $5, 1, 'confirmed', 'PWA'),
              ($6, $2, $3, 'SKU-3-18', $7, $7, 4, 4, $5, 2, 'substituted', 'PWA')`,
      [randomUUID(), pickTaskId, soPicked, lotA, siteAId, randomUUID(), lotB],
    );
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('AC1: dispatch clerk and warehouse manager get the nav row; store assistant and inventory-read clerk do not', async () => {
    const nav = async (headers: Record<string, string>) => {
      const res = await makeRequest(port, 'GET', '/api/v1/edge/bootstrap', undefined, headers);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      return res.body['navigation'] as string[];
    };
    assert.ok((await nav(dispatchHeaders)).includes('Pack and dispatch'));
    assert.ok((await nav(managerHeaders)).includes('Pack and dispatch'));
    assert.ok(!(await nav(storeHeaders)).includes('Pack and dispatch'));
    assert.ok(!(await nav(invClerkHeaders)).includes('Pack and dispatch'));
  });

  it('AC2: the list derives stage and IRN coverage, scoped to the site', async () => {
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/dispatch?site=${siteAId}`,
      undefined,
      dispatchHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const rows = (res.body['dispatchOrders'] as Array<Record<string, unknown>>).map((r) => ({
      id: r['dispatch_order_id'] as string,
      stage: r['stage'] as string,
      irn: r['irn_recorded'] as boolean,
    }));
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.strictEqual(rows.length, 5, `expected 5 site-A rows, got ${JSON.stringify(rows)}`);
    assert.equal(byId.get(soPicked)?.stage, 'picked');
    assert.equal(byId.get(soPacked)?.stage, 'packed');
    assert.equal(byId.get(soDocs)?.stage, 'documents_generated');
    assert.equal(byId.get(soDocs)?.irn, false);
    assert.equal(byId.get(soDocsIrn)?.stage, 'documents_generated');
    assert.equal(byId.get(soDocsIrn)?.irn, true);
    assert.equal(byId.get(soDispatched)?.stage, 'dispatched');
    assert.equal(byId.has(soSiteB), false, 'site B order must not appear in site A list');
  });

  it('AC2: the stage filter applies to the derived value', async () => {
    const stages = async (filter: string) => {
      const res = await makeRequest(
        port,
        'GET',
        `/api/v1/dispatch?site=${siteAId}&stage=${filter}`,
        undefined,
        dispatchHeaders,
      );
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      return (res.body['dispatchOrders'] as Array<Record<string, unknown>>).map(
        (r) => r['dispatch_order_id'] as string,
      );
    };
    assert.deepStrictEqual((await stages('picked')).sort(), [soPicked].sort());
    assert.deepStrictEqual((await stages('packed')).sort(), [soPacked].sort());
    assert.deepStrictEqual(
      (await stages('documents_generated')).sort(),
      [soDocs, soDocsIrn].sort(),
    );
    assert.deepStrictEqual((await stages('dispatched')).sort(), [soDispatched].sort());
  });

  it('AC2: rejects a missing site and an invalid stage', async () => {
    const missing = await makeRequest(port, 'GET', '/api/v1/dispatch', undefined, dispatchHeaders);
    assert.strictEqual(missing.status, 400);
    const badStage = await makeRequest(
      port,
      'GET',
      `/api/v1/dispatch?site=${siteAId}&stage=bogus`,
      undefined,
      dispatchHeaders,
    );
    assert.strictEqual(badStage.status, 400);
  });

  it('AC4: picked-lines returns the confirmed lots with the lot-number bridge', async () => {
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/dispatch/${soPicked}/picked-lines`,
      undefined,
      dispatchHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const lines = res.body['pickedLines'] as Array<Record<string, unknown>>;
    assert.strictEqual(lines.length, 2);
    const numbers = lines.map((l) => l['confirmed_lot_number'] as string | null).sort();
    assert.deepStrictEqual(numbers, ['L-3-18-A', 'L-3-18-B']);
  });

  it('AC1/AC2: rejects the list and picked-lines without a dispatch read role or site access', async () => {
    // No token: 401.
    const noAuth = await makeRequest(port, 'GET', `/api/v1/dispatch?site=${siteAId}`);
    assert.strictEqual(noAuth.status, 401);
    // A role outside DISPATCH_READ_ROLES (gate_officer): 403.
    const gate = await makeRequest(
      port,
      'GET',
      `/api/v1/dispatch?site=${siteAId}`,
      undefined,
      gateHeaders,
    );
    assert.strictEqual(gate.status, 403);
    // A dispatch clerk at site A reading site B's list: 403 (site scoping).
    const crossSite = await makeRequest(
      port,
      'GET',
      `/api/v1/dispatch?site=${siteBId}`,
      undefined,
      dispatchHeaders,
    );
    assert.strictEqual(crossSite.status, 403);
    // A dispatch clerk reading picked-lines without the dispatch read role: 403.
    const pickedGate = await makeRequest(
      port,
      'GET',
      `/api/v1/dispatch/${soPicked}/picked-lines`,
      undefined,
      gateHeaders,
    );
    assert.strictEqual(pickedGate.status, 403);
  });
});
