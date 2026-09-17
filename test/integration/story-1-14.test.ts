import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool, getPool } from '../../src/config/db.js';
import { hasRefusedCaptureReadScope } from '../../src/api/v1/refused-captures.js';

// Story 1.14: Refused-Captures Supervisor Screen (AC 1, 2), server side. The bootstrap advertises
// the page to anyone with a read grant at their operating site (Binding Decision 2), the list
// narrows to the site the page asks for, a caller with no grant is refused, and the index the
// Story 1.13 review found missing exists. The screen itself is covered by the edge e2e spec.
// Fixture helpers are copied from test/integration/story-1-13.test.ts (Testing standards).

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
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
          resolvePromise({ status: res.statusCode ?? 0, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('Story 1.14 Refused-Captures Supervisor Screen (server side)', () => {
  let server: Server;
  let port: number;
  let siteId: string;
  let otherSiteId: string;
  let techId: string;
  let elsewhereTechId: string;
  const headers: Record<string, Record<string, string>> = {};

  async function provision(name: string, roles: Role[]): Promise<string> {
    const externalId = `${name}-1-14-${run}@example.com`;
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/scim/v2/Users',
      { externalId, email: externalId, displayName: externalId, roles },
      SCIM_HEADERS,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const token = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub: externalId });
    headers[name] = { Authorization: `Bearer ${token.body['token'] as string}` };
    return (res.body as Record<string, string>)['userId']!;
  }

  function both(role: string, module: string, locationId: string): Role[] {
    return [
      { role, module, functionScope: 'write', locationId },
      { role, module, functionScope: 'read', locationId },
    ];
  }

  /** An inventory capture from a maintenance-only technician: the middleware refuses it MODULE_ACCESS_DENIED. */
  function inventoryEnvelope(userId: string, locationId: string): Record<string, unknown> {
    const eventId = randomUUID();
    return {
      event_id: eventId,
      stream_type: 'inventory',
      stream_id: randomUUID(),
      event_type: 'stock.moved',
      payload: { business_stream: 'production', sku: `NONEXISTENT-${run}`, quantity: 1 },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: userId, role: 'device_role', location_id: locationId },
        device_id: `EDGE-1-14-${run}`,
        capture_method: 'MANUAL',
        occurred_at: new Date().toISOString(),
      },
      schema_version: 1,
      idempotency_key: `edge-1-14-${eventId}`,
    };
  }

  async function recordsFor(eventId: unknown): Promise<Array<Record<string, unknown>>> {
    const r = await getPool().query(`SELECT * FROM edge_refused_capture WHERE event_id = $1`, [eventId]);
    return r.rows as Array<Record<string, unknown>>;
  }

  /** A refusal created through the real upload path, recorded at the declared site. */
  async function refusal(who: string, userId: string, locationId: string): Promise<Record<string, unknown>> {
    const body = inventoryEnvelope(userId, locationId);
    const res = await makeRequest(port, 'POST', '/api/v1/edge/events', body, headers[who]);
    assert.strictEqual(res.body['error_code'], 'MODULE_ACCESS_DENIED', JSON.stringify(res.body));
    const rows = await recordsFor(body['event_id']);
    assert.strictEqual(rows.length, 1);
    return rows[0]!;
  }

  before(async () => {
    const adminPool = getAdminPool();
    for (const file of [
      '../../events/domain_events.sql',
      '../../read/projections/users.sql',
      '../../read/projections/audit_log.sql',
      '../../read/projections/doa_registry.sql',
      '../../read/projections/business_stream_config.sql',
      '../../read/projections/location.sql',
      '../../read/projections/instrument_calibration.sql',
      '../../read/projections/notification.sql',
      '../../read/projections/item_master.sql',
      '../../read/projections/location_register.sql',
      '../../read/projections/stock_balance.sql',
      '../../read/projections/lot_master.sql',
      '../../read/projections/serial_master.sql',
      '../../read/projections/lot_trace.sql',
      '../../read/projections/inventory_valuation.sql',
      '../../read/projections/asset.sql',
      '../../read/projections/maintenance_work_order.sql',
      '../../read/projections/maintenance_sync_conflict.sql',
      '../../read/projections/edge_refused_capture.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }

    server = createAppServer(createAppRouter());
    await new Promise<void>((resolvePromise) => {
      server.listen(0, () => {
        port = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    siteId = randomUUID();
    otherSiteId = randomUUID();
    techId = await provision('tech', both('maintenance_technician', 'maintenance', siteId));
    elsewhereTechId = await provision('elsewhere', both('maintenance_technician', 'maintenance', otherSiteId));
    // Sees every site's inventory refusals; wildcard-only, so it never bootstraps an edge device.
    await provision('supervisor', both(`refusal_supervisor_${run}`, 'inventory', '*'));
    await provision('nobody', []);
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // --- AC 2: navigation entry and the 403 path ---------------------------------

  it('AC2: bootstrap advertises the page to a persona with a read grant at the operating site', async () => {
    const res = await makeRequest(port, 'GET', '/api/v1/edge/bootstrap', undefined, headers['tech']);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body['navigation'], ['Dashboard', 'Frontline', 'Refused captures']);
    assert.strictEqual(res.body['site_id'], siteId);
  });

  it('AC2: a persona with no assignment is served no navigation and the list answers 403 MODULE_ACCESS_DENIED', async () => {
    const bootstrap = await makeRequest(port, 'GET', '/api/v1/edge/bootstrap', undefined, headers['nobody']);
    assert.strictEqual(bootstrap.status, 403, JSON.stringify(bootstrap.body));
    assert.equal('navigation' in bootstrap.body, false);

    const list = await makeRequest(
      port,
      'GET',
      `/api/v1/edge/refused-captures?status=open&location_id=${siteId}&limit=100`,
      undefined,
      headers['nobody'],
    );
    assert.strictEqual(list.status, 403, JSON.stringify(list.body));
    assert.strictEqual(list.body['error_code'], 'MODULE_ACCESS_DENIED');
  });

  it('Binding Decision 2: hasRefusedCaptureReadScope is read scope at the site or everywhere, never a role name', () => {
    const site = randomUUID();
    const read = (locationId: string, functionScope: 'read' | 'write' = 'read'): Role => ({
      role: 'anything',
      module: 'maintenance',
      functionScope,
      locationId,
    });
    assert.equal(hasRefusedCaptureReadScope([], site), false);
    assert.equal(hasRefusedCaptureReadScope([read(randomUUID())], site), false, 'a grant elsewhere is not a grant here');
    assert.equal(hasRefusedCaptureReadScope([read(site)], site), true);
    assert.equal(hasRefusedCaptureReadScope([read(site, 'write')], site), true, 'write implies read');
    assert.equal(hasRefusedCaptureReadScope([read('*')], site), true, 'a wildcard site grant covers every site');
    assert.equal(hasRefusedCaptureReadScope([read(site.toUpperCase())], site), true, 'assignment case never matters');
  });

  // --- AC 1: the list the page reads ------------------------------------------

  it('AC1: the list narrowed by location_id returns only that site\'s open refusals, newest first', async () => {
    const first = await refusal('tech', techId, siteId);
    const elsewhere = await refusal('elsewhere', elsewhereTechId, otherSiteId);
    const second = await refusal('tech', techId, siteId);

    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/edge/refused-captures?status=open&location_id=${siteId}&limit=100`,
      undefined,
      headers['supervisor'],
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const refusals = res.body['refusals'] as Array<Record<string, unknown>>;
    assert.ok(refusals.every((row) => row['location_id'] === siteId), 'every row belongs to the requested site');
    const ids = refusals.map((row) => row['refusal_id']);
    assert.ok(ids.includes(first['refusal_id']));
    assert.ok(ids.includes(second['refusal_id']));
    assert.equal(ids.includes(elsewhere['refusal_id']), false, 'the other site\'s refusal is not listed');
    assert.ok(
      ids.indexOf(second['refusal_id'] as string) < ids.indexOf(first['refusal_id'] as string),
      'newest first: the API order the screen renders without re-sorting',
    );
    const times = refusals.map((row) => new Date(row['refused_at'] as string).getTime());
    assert.deepStrictEqual(times, [...times].sort((a, b) => b - a));
  });

  // --- Task 1.4: the index the 1.13 review found missing -----------------------

  it('Task 1.4: edge_refused_capture carries the (status, refused_at DESC, refusal_id) index', async () => {
    const r = await getPool().query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'edge_refused_capture' AND indexname = $1`,
      ['idx_edge_refused_capture_status_refused_at'],
    );
    assert.strictEqual(r.rows.length, 1, 'index missing; run node dist/src/events/migrate.js');
    const indexdef = (r.rows[0] as { indexdef: string }).indexdef;
    assert.ok(indexdef.includes('(status, refused_at DESC, refusal_id)'), indexdef);
  });
});
