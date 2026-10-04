import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppServer } from '../../src/server.js';
import { closePool, getPool } from '../../src/config/db.js';
import { persistEvent } from '../../src/events/store.js';

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
 * Pilot F1: with hierarchy coverage (B1) a site-scoped user acting at a bin is stamped with the BIN
 * id. The compliance "actor must be at the site" seams used to compare that stamp to the site id by
 * equality, so such a caller was refused although they are at the site.
 */
describe('Pilot F1: a bin-stamped actor of the task site passes the pick site seam', () => {
  let server: Server;
  let port: number;
  let managerHeaders: Record<string, string>;
  let operatorHeaders: Record<string, string>;
  let operatorId: string;

  const siteId = randomUUID();
  const zoneId = randomUUID();
  const binId = randomUUID();
  const otherSiteId = randomUUID();
  const otherBinId = randomUUID();
  const run = randomUUID().slice(0, 8);

  async function seedLocation(
    locationId: string,
    code: string,
    level: string,
    parentId: string | null,
    site: string,
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO location_register
         (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class,
          size_class, hazmat_allowed, quarantine, access_restricted, status, pick_sequence)
       VALUES ($1, $2, $3, $4, $5, 'general', 'ambient', 'standard', false, false, false, 'active', 10)`,
      [locationId, code, level, parentId, site],
    );
  }

  /** Seeds stock and an order line, generates the pick task, returns its ids and directed qty. */
  async function pickLineFor(
    tag: string,
  ): Promise<{ taskId: string; lineId: string; quantity: unknown }> {
    const sku = `F1-${tag}-${run}`;
    await getPool().query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand)
       VALUES ($1, $2, NULL, 'owned', 20)`,
      [sku, binId],
    );
    const order = await getPool().query(
      `INSERT INTO erp_sales_order
         (so_number_ext, line_no, sku, quantity, ship_from_site_id, ship_from_site_code_ext, status, source_system, last_synced_at)
       VALUES ($1, 1, $2, 5, $3, 'site-F1', 'open', 'ERP', now())
       RETURNING id`,
      [`SOF1-${tag}-${run}`, sku, siteId],
    );
    const gen = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [order.rows[0]!['id']], strategy: 'single' },
      managerHeaders,
    );
    assert.strictEqual(gen.status, 201, JSON.stringify(gen.body));
    const taskId = (gen.body['pickTaskIds'] as string[])[0]!;
    const lineId = (gen.body['pickLineIds'] as string[])[0]!;
    return { taskId, lineId, quantity: '5' };
  }

  function confirmEnvelope(
    taskId: string,
    lineId: string,
    actorLocationId: string,
  ): Record<string, unknown> {
    return {
      stream_type: 'warehouse',
      stream_id: taskId,
      event_type: 'pick_line.confirmed',
      payload: {
        pick_task_id: taskId,
        pick_line_id: lineId,
        confirmed_lot_id: null,
        confirmed_quantity: '5',
        override_reason: null,
        capture_method: 'PWA',
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: operatorId, role: 'store_assistant', location_id: actorLocationId },
        occurred_at: new Date().toISOString(),
      },
    };
  }

  async function lineStatus(lineId: string): Promise<unknown> {
    const result = await getPool().query(`SELECT status FROM pick_line WHERE pick_line_id = $1`, [
      lineId,
    ]);
    return result.rows[0]!['status'];
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
    await seedLocation(siteId, `SITE-F1-${run}`, 'site', null, siteId);
    await seedLocation(zoneId, `ZONE-F1-${run}`, 'zone', siteId, siteId);
    await seedLocation(binId, `BIN-F1-${run}`, 'bin', zoneId, siteId);
    await seedLocation(otherSiteId, `SITE-F1-OTHER-${run}`, 'site', null, otherSiteId);
    await seedLocation(otherBinId, `BIN-F1-OTHER-${run}`, 'bin', otherSiteId, otherSiteId);

    await provisionUser(port, `f1-manager-${run}@example.com`, [
      {
        role: 'warehouse_manager',
        module: 'warehouse',
        functionScope: 'write',
        locationId: siteId,
      },
    ]);
    managerHeaders = await authFor(port, `f1-manager-${run}@example.com`);
    operatorId = await provisionUser(port, `f1-operator-${run}@example.com`, [
      { role: 'store_assistant', module: 'warehouse', functionScope: 'write', locationId: siteId },
    ]);
    operatorHeaders = await authFor(port, `f1-operator-${run}@example.com`);
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
  });

  it('a site-scoped operator stating a bin of the site confirms a pick line', async () => {
    const { taskId, lineId } = await pickLineFor('BIN');
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      confirmEnvelope(taskId, lineId, binId),
      operatorHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const stored = await getPool().query(
      `SELECT metadata->'actor'->>'location_id' AS location_id
         FROM domain_events WHERE stream_id = $1 AND event_type = 'pick_line.confirmed'`,
      [taskId],
    );
    assert.strictEqual(stored.rows[0]!['location_id'], binId, 'the bin stamp reached the seam');
    assert.strictEqual(await lineStatus(lineId), 'confirmed');
  });

  it('an actor stamped at a bin of ANOTHER site is still refused by the seam', async () => {
    const { taskId, lineId } = await pickLineFor('OTHER');
    for (const foreign of [otherBinId, otherSiteId]) {
      await assert.rejects(
        persistEvent(confirmEnvelope(taskId, lineId, foreign) as never),
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          (error as { errorCode?: string }).errorCode === 'LOCATION_ACCESS_DENIED',
      );
    }
    assert.strictEqual(await lineStatus(lineId), 'pending');
  });

  it('stating the site id itself still passes', async () => {
    const { taskId, lineId } = await pickLineFor('SITE');
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      confirmEnvelope(taskId, lineId, siteId),
      operatorHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(await lineStatus(lineId), 'confirmed');
  });

  // Review R5: seams that fall back to the actor's location AS the site must resolve a bin stamp.
  it('a quality hold placed by a bin-stamped actor on an ungoverned lot is recorded at the SITE', async () => {
    const qcHeadId = await provisionUser(port, `f1-qchead-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: siteId },
    ]);
    const qcHeaders = await authFor(port, `f1-qchead-${run}@example.com`);
    const lot = await getPool().query(
      `INSERT INTO lot_master (lot_number, sku, expiry_date, quality_hold_status)
       VALUES ($1, $2, NULL, 'none') RETURNING lot_id`,
      [`LOT-F1-R5-${run}`, `SKU-F1-R5-${run}`],
    );
    const holdId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'qc',
        stream_id: holdId,
        event_type: 'qc.hold_placed',
        payload: { hold_id: holdId, lot_id: lot.rows[0]!['lot_id'], hold_reason: 'R5 bin stamp' },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: qcHeadId, role: 'qc_head', location_id: binId },
          occurred_at: new Date().toISOString(),
        },
      },
      qcHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const hold = await getPool().query(`SELECT site_id FROM qc_quality_hold WHERE hold_id = $1`, [
      holdId,
    ]);
    assert.strictEqual(hold.rows[0]!['site_id'], siteId, 'the site, not the bin');
  });
});
