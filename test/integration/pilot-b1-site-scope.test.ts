import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { assignmentCoversLocation, attachLocationCoverage } from '../../src/middleware/rbac.js';
import type { RoleAssignment } from '../../src/read/projections/users.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const BUSINESS_DATE = '2026-07-21';

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
    req.setTimeout(5000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
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
 * Pilot defect B1: a role assignment at a location must grant that location AND everything
 * beneath it in the register hierarchy (a site assignment covers every bin of the site), without
 * widening sideways (bin A never grants bin B, site X never grants site Y).
 */
describe('Pilot B1 site-scoped assignments cover the locations beneath them', () => {
  let server: Server;
  let port: number;
  let siteXHeaders: Record<string, string>;
  let zoneXHeaders: Record<string, string>;
  let binXaHeaders: Record<string, string>;
  let wildcardHeaders: Record<string, string>;
  const siteX = randomUUID();
  const siteY = randomUUID();
  const zoneX = randomUUID();
  const binXa = randomUUID();
  const binXb = randomUUID();
  const binY = randomUUID();
  const binRogue = randomUUID();
  const binXInactive = randomUUID();
  const SKU = 'B1-SKU';

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
      '../../read/projections/item_master.sql',
      '../../read/projections/location_register.sql',
      '../../read/projections/stock_balance.sql',
      '../../read/projections/lot_master.sql',
      '../../read/projections/serial_master.sql',
      '../../read/projections/lot_trace.sql',
      '../../read/projections/inventory_valuation.sql',
      '../../read/projections/transfer_request.sql',
      '../../read/projections/in_transit.sql',
      '../../read/projections/cycle_count.sql',
      '../../read/projections/physical_verification.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE physical_verification_line, physical_verification, cycle_count_line, cycle_count, in_transit, transfer_request, inventory_valuation, lot_master, serial_master, lot_trace, stock_balance, item_master, location_register, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    server = createAppServer(createAppRouter());
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.off('error', reject);
        port = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    // Topology: site X > zone X > bins Xa, Xb; site Y > bin Y (directly under the site).
    // binRogue is parented under site Y but carries zone X as its site_id (review fix 4);
    // binXInactive is a deactivated bin of zone X.
    const rows: [string, string, string, string | null, string, string][] = [
      [siteX, 'B1-SITE-X', 'site', null, siteX, 'active'],
      [siteY, 'B1-SITE-Y', 'site', null, siteY, 'active'],
      [zoneX, 'B1-ZONE-X', 'zone', siteX, siteX, 'active'],
      [binXa, 'B1-BIN-XA', 'bin', zoneX, siteX, 'active'],
      [binXb, 'B1-BIN-XB', 'bin', zoneX, siteX, 'active'],
      [binY, 'B1-BIN-Y', 'bin', siteY, siteY, 'active'],
      [binRogue, 'B1-BIN-ROGUE', 'bin', siteY, zoneX, 'active'],
      [binXInactive, 'B1-BIN-XOFF', 'bin', zoneX, siteX, 'inactive'],
    ];
    for (const [id, code, level, parent, site, status] of rows) {
      await getPool().query(
        `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, status)
         VALUES ($1, $2, $3, $4, $5, 'general', 'ambient', $6)`,
        [id, code, level, parent, site, status],
      );
    }

    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, valuation_method, business_stream, status)
       VALUES ($1, 'EA', false, false, 'weighted_average', 'production', 'active')`,
      [SKU],
    );
    for (const [locationId, onHand] of [
      [binXa, 10],
      [binXb, 5],
      [binY, 7],
      [binRogue, 3],
      [binXInactive, 2],
    ] as [string, number][]) {
      await getPool().query(
        `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand, allocated) VALUES ($1, $2, NULL, 'owned', $3, 0)`,
        [SKU, locationId, onHand],
      );
    }

    const controllerAt = (locationId: string): Role[] => [
      { role: 'inventory_controller', module: 'inventory', functionScope: 'write', locationId },
    ];
    await provisionUser(port, 'site-x-b1@example.com', controllerAt(siteX));
    siteXHeaders = await authFor(port, 'site-x-b1@example.com');
    await provisionUser(port, 'zone-x-b1@example.com', controllerAt(zoneX));
    zoneXHeaders = await authFor(port, 'zone-x-b1@example.com');
    await provisionUser(port, 'bin-xa-b1@example.com', controllerAt(binXa));
    binXaHeaders = await authFor(port, 'bin-xa-b1@example.com');
    await provisionUser(port, 'wildcard-b1@example.com', controllerAt('*'));
    wildcardHeaders = await authFor(port, 'wildcard-b1@example.com');
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  async function visibleStock(
    headers: Record<string, string>,
  ): Promise<{ ids: string[]; onHand: number }> {
    const res = await makeRequest(port, 'GET', `/api/v1/stock/${SKU}`, undefined, headers);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const locations = res.body['locations'] as { location_id: string }[];
    const consolidated = res.body['consolidated'] as { on_hand: number };
    return { ids: locations.map((l) => l.location_id).sort(), onHand: consolidated.on_hand };
  }

  function raiseCount(locationId: string, headers: Record<string, string>): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/cycle-counts',
      {
        location_id: locationId,
        sku_scope: [SKU],
        count_type: 'cycle',
        business_date: BUSINESS_DATE,
        business_stream: 'production',
      },
      headers,
    );
  }

  it('site-scoped user sees stock in the bins of their site and nothing of another site', async () => {
    const seen = await visibleStock(siteXHeaders);
    assert.deepStrictEqual(seen.ids, [binXa, binXb, binXInactive].sort());
    assert.strictEqual(seen.onHand, 17);
  });

  it('zone-scoped user sees the bins beneath the zone', async () => {
    const seen = await visibleStock(zoneXHeaders);
    assert.deepStrictEqual(seen.ids, [binXa, binXb, binXInactive].sort());
  });

  it('bin-scoped user sees only that bin', async () => {
    const seen = await visibleStock(binXaHeaders);
    assert.deepStrictEqual(seen.ids, [binXa]);
    assert.strictEqual(seen.onHand, 10);
  });

  it('wildcard user still sees every location', async () => {
    const seen = await visibleStock(wildcardHeaders);
    assert.deepStrictEqual(seen.ids, [binXa, binXb, binY, binRogue, binXInactive].sort());
    assert.strictEqual(seen.onHand, 27);
  });

  it('site-scoped user can raise a cycle count on a bin of their site', async () => {
    const res = await raiseCount(binXa, siteXHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  });

  it('site-scoped user is refused on a bin of another site', async () => {
    const res = await raiseCount(binY, siteXHeaders);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });

  it('bin-scoped user is refused on a sibling bin and on the parent site', async () => {
    for (const target of [binXb, siteX]) {
      const res = await raiseCount(target, binXaHeaders);
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'LOCATION_ACCESS_DENIED');
    }
  });

  it('a location whose site_id points at a zone is not granted to the zone-scoped user', async () => {
    // Malformed register row: parented under site Y, but its site_id names zone X. Only a SITE
    // root may descend by site_id, so zone X must not pick it up.
    const seen = await visibleStock(zoneXHeaders);
    assert.ok(!seen.ids.includes(binRogue), 'zone X must not cover the rogue bin');
    const res = await raiseCount(binRogue, zoneXHeaders);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });

  it('an inactive bin stays covered by its site: stock left in it remains visible', async () => {
    const seen = await visibleStock(siteXHeaders);
    assert.ok(seen.ids.includes(binXInactive));
    assert.ok(!(await visibleStock(binXaHeaders)).ids.includes(binXInactive));
  });

  it('site-scoped user acting at a bin: the stored event and the audit row carry the BIN id', async () => {
    const streamId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: streamId,
        event_type: 'stock.received',
        payload: {
          sku: SKU,
          target_location_id: binXa,
          quantity: 1,
          business_stream: 'production',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: randomUUID(), role: 'inventory_controller', location_id: binXa },
          occurred_at: new Date().toISOString(),
        },
      },
      siteXHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const stored = await getPool().query(
      `SELECT event_id, metadata->'actor'->>'location_id' AS location_id FROM domain_events WHERE stream_id = $1`,
      [streamId],
    );
    assert.strictEqual(stored.rows.length, 1);
    assert.strictEqual(stored.rows[0]!['location_id'], binXa);
    const audit = await getPool().query(`SELECT location_id FROM audit_log WHERE event_id = $1`, [
      stored.rows[0]!['event_id'],
    ]);
    assert.strictEqual(audit.rows.length, 1);
    assert.strictEqual(audit.rows[0]!['location_id'], binXa);
  });

  it('an exact-match assignment still stamps its own location', async () => {
    const streamId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: streamId,
        event_type: 'stock.received',
        payload: {
          sku: SKU,
          target_location_id: binXa,
          quantity: 1,
          business_stream: 'production',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: randomUUID(), role: 'inventory_controller', location_id: binXa },
          occurred_at: new Date().toISOString(),
        },
      },
      binXaHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const stored = await getPool().query(
      `SELECT metadata->'actor'->>'location_id' AS location_id FROM domain_events WHERE stream_id = $1`,
      [streamId],
    );
    assert.strictEqual(stored.rows[0]!['location_id'], binXa);
  });
});

/**
 * Review fixes 5 and 7: the coverage lookup is an optimisation of the exact-match rule, never a
 * precondition of it. A failing lookup, or an assignment object the lookup never saw, leaves the
 * request on exact-match semantics instead of failing authentication.
 */
describe('Pilot B1 coverage falls back to exact-match', () => {
  const site = randomUUID();
  const bin = randomUUID();
  const assignment = (): RoleAssignment => ({
    role: 'inventory_controller',
    module: 'inventory',
    functionScope: 'write',
    locationId: site,
  });

  it('a failing coverage query does not throw and leaves exact-match in force', async (t) => {
    const logged = t.mock.method(console, 'error', () => undefined);
    const roles = [assignment()];
    await attachLocationCoverage(roles, () => Promise.reject(new Error('connection refused')));
    assert.strictEqual(logged.mock.callCount(), 1);
    assert.strictEqual(assignmentCoversLocation(roles[0]!, site), true);
    assert.strictEqual(assignmentCoversLocation(roles[0]!, bin), false);
  });

  it('an assignment the lookup never saw grants its own location only', async () => {
    const seen = assignment();
    await attachLocationCoverage([seen], () =>
      Promise.resolve({
        rows: [
          { root_id: site, location_id: site },
          { root_id: site, location_id: bin },
        ],
      }),
    );
    assert.strictEqual(assignmentCoversLocation(seen, bin), true);
    const copy = { ...seen };
    assert.strictEqual(assignmentCoversLocation(copy, site), true);
    assert.strictEqual(assignmentCoversLocation(copy, bin), false);
  });
});
