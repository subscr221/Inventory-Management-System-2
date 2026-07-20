import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 2.1: item master + location register + central inventory-master validation. Runs against
// the PRODUCTION router surface (createAppRouter) so route moves and RBAC wiring are exercised
// exactly as deployed.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };

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
  assert.strictEqual(res.status, 201, `provision ${externalId} failed: ${JSON.stringify(res.body)}`);
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub} failed: ${JSON.stringify(res.body)}`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

/** Inventory movement envelope referencing master data (Story 2.1 canonical placement shape). */
function movementEnvelope(
  streamId: string,
  userId: string,
  actorLocationId: string,
  payload: Record<string, unknown>,
  extra: { idempotency_key?: string; event_id?: string; device_id?: string } = {},
) {
  return {
    ...(extra.event_id ? { event_id: extra.event_id } : {}),
    stream_type: 'inventory',
    stream_id: streamId,
    event_type: 'stock.moved',
    payload: { business_stream: 'production', ...payload },
    metadata: {
      correlation_id: randomUUID(),
      actor: { user_id: userId, role: 'inventory_controller', location_id: actorLocationId },
      occurred_at: new Date().toISOString(),
      ...(extra.device_id ? { device_id: extra.device_id } : {}),
    },
    ...(extra.idempotency_key ? { idempotency_key: extra.idempotency_key } : {}),
  };
}

async function domainEventCount(streamId: string): Promise<number> {
  const result = await getPool().query(`SELECT count(*)::int AS count FROM domain_events WHERE stream_id = $1`, [streamId]);
  return result.rows[0]!['count'] as number;
}

describe('Story 2.1 Item Master and Location Register Integration Tests', () => {
  let server: Server;
  let port: number;
  let adminHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let deniedHeaders: Record<string, string>;
  let scopedHeaders: Record<string, string>;
  let edgeHeaders: Record<string, string>;
  let adminUserId: string;
  let siteId: string;
  let zoneId: string;
  let hazmatBinId: string;
  let hazmatBinCode: string;
  let plainBinId: string;

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
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE item_master, location_register, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    adminUserId = await provisionUser(port, 'im-admin@example.com', [
      { role: 'inventory_controller', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    adminHeaders = await authFor(port, 'im-admin@example.com');

    await provisionUser(port, 'im-reader@example.com', [
      { role: 'stock_viewer', module: 'inventory', functionScope: 'read', locationId: '*' },
    ]);
    readerHeaders = await authFor(port, 'im-reader@example.com');

    await provisionUser(port, 'im-denied@example.com', [
      { role: 'qc_inspector', module: 'quality', functionScope: 'write', locationId: '*' },
      { role: 'config_writer', module: 'config', functionScope: 'write', locationId: '*' },
    ]);
    deniedHeaders = await authFor(port, 'im-denied@example.com');

    // Warehouse topology used across the suite: site > zone > two bins (one hazmat-zoned).
    const site = await makeRequest(port, 'POST', '/api/v1/locations', { location_code: 'SITE-A', level: 'site' }, adminHeaders);
    assert.strictEqual(site.status, 201, JSON.stringify(site.body));
    siteId = site.body['location_id'] as string;

    const zone = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      { location_code: 'ZONE-A1', level: 'zone', parent_location_id: siteId },
      adminHeaders,
    );
    assert.strictEqual(zone.status, 201, JSON.stringify(zone.body));
    zoneId = zone.body['location_id'] as string;

    const aisle = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      { location_code: 'AISLE-A1-01', level: 'aisle', parent_location_id: zoneId },
      adminHeaders,
    );
    assert.strictEqual(aisle.status, 201, JSON.stringify(aisle.body));
    const rack = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      { location_code: 'RACK-A1-01-R1', level: 'rack', parent_location_id: aisle.body['location_id'] as string },
      adminHeaders,
    );
    assert.strictEqual(rack.status, 201, JSON.stringify(rack.body));

    hazmatBinCode = 'BIN-HAZ-01';
    const hazmatBin = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      {
        location_code: hazmatBinCode,
        level: 'bin',
        parent_location_id: rack.body['location_id'] as string,
        zone_type: 'hazmat',
        temperature_class: 'cold',
        hazmat_allowed: true,
      },
      adminHeaders,
    );
    assert.strictEqual(hazmatBin.status, 201, JSON.stringify(hazmatBin.body));
    hazmatBinId = hazmatBin.body['location_id'] as string;

    const plainBin = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      { location_code: 'BIN-GEN-01', level: 'bin', parent_location_id: rack.body['location_id'] as string },
      adminHeaders,
    );
    assert.strictEqual(plainBin.status, 201, JSON.stringify(plainBin.body));
    plainBinId = plainBin.body['location_id'] as string;

    // Site-scoped users are provisioned AFTER the register rows exist so their concrete
    // assignment locationId is a registered location (Task 3.8).
    await provisionUser(port, 'im-scoped@example.com', [
      { role: 'site_operator', module: 'inventory', functionScope: 'write', locationId: siteId },
    ]);
    scopedHeaders = await authFor(port, 'im-scoped@example.com');

    await provisionUser(port, 'im-edge@example.com', [
      { role: 'edge_operator', module: 'inventory', functionScope: 'write', locationId: siteId },
    ]);
    edgeHeaders = await authFor(port, 'im-edge@example.com');
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // ---------------------------------------------------------------------------------------------
  // Task 5.1 - item master
  // ---------------------------------------------------------------------------------------------

  it('AC1: creates an item and reads it back by SKU with all fields and created_at', async () => {
    const create = await makeRequest(
      port,
      'POST',
      '/api/v1/items',
      { sku: 'RM-0042', uom: 'kg', lot_controlled: true, valuation_method: 'weighted_average', business_stream: 'production' },
      adminHeaders,
    );
    assert.strictEqual(create.status, 201, JSON.stringify(create.body));

    const res = await makeRequest(port, 'GET', '/api/v1/items/RM-0042', undefined, adminHeaders);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['sku'], 'RM-0042');
    assert.strictEqual(res.body['uom'], 'kg');
    assert.strictEqual(res.body['lot_controlled'], true);
    assert.strictEqual(res.body['serial_controlled'], false);
    assert.strictEqual(res.body['hazmat'], false);
    assert.strictEqual(res.body['quarantine_required'], false);
    assert.strictEqual(res.body['bis_licence_required'], false);
    assert.strictEqual(res.body['valuation_method'], 'weighted_average');
    assert.strictEqual(res.body['business_stream'], 'production');
    assert.strictEqual(res.body['status'], 'active');
    assert.ok(typeof res.body['item_id'] === 'string' && res.body['item_id'].length > 0);
    assert.ok(typeof res.body['created_at'] === 'string' && !Number.isNaN(Date.parse(res.body['created_at'] as string)));
    assert.ok(typeof res.body['updated_at'] === 'string' && !Number.isNaN(Date.parse(res.body['updated_at'] as string)));

    // The projection row, the item.created domain event, and the audit entry committed together.
    const itemId = res.body['item_id'] as string;
    const events = await getPool().query(
      `SELECT event_id, event_type, stream_type FROM domain_events WHERE stream_id = $1`,
      [itemId],
    );
    assert.strictEqual(events.rows.length, 1);
    assert.strictEqual(events.rows[0]!['event_type'], 'item.created');
    assert.strictEqual(events.rows[0]!['stream_type'], 'item_master');
    const audit = await getPool().query(`SELECT 1 FROM audit_log WHERE event_id = $1`, [events.rows[0]!['event_id']]);
    assert.strictEqual(audit.rows.length, 1, 'audit entry must exist for item.created');
  });

  it('rejects a duplicate SKU with 409 DUPLICATE_SKU', async () => {
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/items',
      { sku: 'RM-DUP-1', uom: 'ea', valuation_method: 'fifo', business_stream: 'production' },
      adminHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const dup = await makeRequest(
      port,
      'POST',
      '/api/v1/items',
      { sku: 'RM-DUP-1', uom: 'ea', valuation_method: 'fifo', business_stream: 'production' },
      adminHeaders,
    );
    assert.strictEqual(dup.status, 409, JSON.stringify(dup.body));
    assert.strictEqual(dup.body['error_code'], 'DUPLICATE_SKU');
  });

  it('blocks invalid valuation methods, especially lifo, with INVALID_VALUATION_METHOD', async () => {
    for (const method of ['lifo', 'standard_cost', '']) {
      const res = await makeRequest(
        port,
        'POST',
        '/api/v1/items',
        { sku: `RM-BAD-${randomUUID().slice(0, 8)}`, uom: 'ea', valuation_method: method, business_stream: 'production' },
        adminHeaders,
      );
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'INVALID_VALUATION_METHOD');
    }
  });

  it('rejects an unknown business stream with INVALID_BUSINESS_STREAM (Story 1.5 vocabulary reused)', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/items',
      { sku: 'RM-BAD-STREAM', uom: 'ea', valuation_method: 'fifo', business_stream: 'not_a_stream' },
      adminHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_BUSINESS_STREAM');
  });

  it('updates an item via PATCH and appends item.updated with before/after', async () => {
    const create = await makeRequest(
      port,
      'POST',
      '/api/v1/items',
      { sku: 'RM-PATCH-1', uom: 'ea', valuation_method: 'fifo', business_stream: 'production' },
      adminHeaders,
    );
    assert.strictEqual(create.status, 201, JSON.stringify(create.body));
    const itemId = create.body['item_id'] as string;

    const patch = await makeRequest(port, 'PATCH', '/api/v1/items/RM-PATCH-1', { uom: 'kg', hazmat: true }, adminHeaders);
    assert.strictEqual(patch.status, 200, JSON.stringify(patch.body));
    assert.strictEqual(patch.body['uom'], 'kg');
    assert.strictEqual(patch.body['hazmat'], true);

    const events = await getPool().query(
      `SELECT event_type FROM domain_events WHERE stream_id = $1 ORDER BY event_version ASC`,
      [itemId],
    );
    assert.deepStrictEqual(
      events.rows.map((r) => r['event_type']),
      ['item.created', 'item.updated'],
    );
  });

  it('rolls back the projection row and audit entry when the domain-event write fails mid-transaction', async () => {
    const adminPool = getAdminPool();
    await adminPool.query(`
      CREATE OR REPLACE FUNCTION story21_forced_failure() RETURNS trigger AS $$
      BEGIN
        IF NEW.event_type = 'item.created' AND NEW.payload->'item'->>'sku' = 'ROLLBACK-SKU' THEN
          RAISE EXCEPTION 'STORY21_FORCED_FAILURE';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
    `);
    await adminPool.query(
      `CREATE TRIGGER trg_story21_forced_failure BEFORE INSERT ON domain_events FOR EACH ROW EXECUTE FUNCTION story21_forced_failure()`,
    );
    try {
      const auditBefore = await getPool().query(`SELECT count(*)::int AS count FROM audit_log`);
      const res = await makeRequest(
        port,
        'POST',
        '/api/v1/items',
        { sku: 'ROLLBACK-SKU', uom: 'ea', valuation_method: 'fifo', business_stream: 'production' },
        adminHeaders,
      );
      assert.strictEqual(res.status, 500, JSON.stringify(res.body));

      const row = await getPool().query(`SELECT 1 FROM item_master WHERE sku = 'ROLLBACK-SKU'`);
      assert.strictEqual(row.rows.length, 0, 'projection row must roll back with the failed event write');
      const auditAfter = await getPool().query(`SELECT count(*)::int AS count FROM audit_log`);
      assert.strictEqual(auditAfter.rows[0]!['count'], auditBefore.rows[0]!['count'], 'no audit entry may survive the rollback');
    } finally {
      await adminPool.query(`DROP TRIGGER IF EXISTS trg_story21_forced_failure ON domain_events`);
      await adminPool.query(`DROP FUNCTION IF EXISTS story21_forced_failure()`);
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Task 5.2 - location register
  // ---------------------------------------------------------------------------------------------

  it('AC3 (read side): returns zone and temperature attributes from GET /api/v1/locations/:locationId', async () => {
    const res = await makeRequest(port, 'GET', `/api/v1/locations/${hazmatBinId}`, undefined, adminHeaders);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['location_code'], hazmatBinCode);
    assert.strictEqual(res.body['level'], 'bin');
    assert.strictEqual(res.body['zone_type'], 'hazmat');
    assert.strictEqual(res.body['temperature_class'], 'cold');
    assert.strictEqual(res.body['hazmat_allowed'], true);
    assert.strictEqual(res.body['site_id'], siteId);
    assert.ok(typeof res.body['created_at'] === 'string');
  });

  it('validates the hierarchy: missing parent, wrong parent level, inactive parent, and parent on a site are rejected', async () => {
    const orphanZone = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      { location_code: 'ZONE-ORPHAN', level: 'zone', parent_location_id: randomUUID() },
      adminHeaders,
    );
    assert.strictEqual(orphanZone.status, 404, JSON.stringify(orphanZone.body));
    assert.strictEqual(orphanZone.body['error_code'], 'PARENT_LOCATION_NOT_FOUND');

    const binUnderSite = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      { location_code: 'BIN-UNDER-SITE', level: 'bin', parent_location_id: siteId },
      adminHeaders,
    );
    assert.strictEqual(binUnderSite.status, 400, JSON.stringify(binUnderSite.body));
    assert.strictEqual(binUnderSite.body['error_code'], 'INVALID_HIERARCHY');

    const inactiveSite = await makeRequest(port, 'POST', '/api/v1/locations', { location_code: 'SITE-INACTIVE', level: 'site' }, adminHeaders);
    assert.strictEqual(inactiveSite.status, 201, JSON.stringify(inactiveSite.body));
    const inactivePatch = await makeRequest(port, 'PATCH', `/api/v1/locations/${inactiveSite.body['location_id'] as string}`, { status: 'inactive' }, adminHeaders);
    assert.strictEqual(inactivePatch.status, 200, JSON.stringify(inactivePatch.body));
    const childUnderInactive = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      { location_code: 'ZONE-INACTIVE-PARENT', level: 'zone', parent_location_id: inactiveSite.body['location_id'] as string },
      adminHeaders,
    );
    assert.strictEqual(childUnderInactive.status, 400, JSON.stringify(childUnderInactive.body));
    assert.strictEqual(childUnderInactive.body['error_code'], 'INACTIVE_LOCATION');

    const siteWithParent = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      { location_code: 'SITE-CHILD', level: 'site', parent_location_id: zoneId },
      adminHeaders,
    );
    assert.strictEqual(siteWithParent.status, 400, JSON.stringify(siteWithParent.body));
    assert.strictEqual(siteWithParent.body['error_code'], 'INVALID_HIERARCHY');
  });

  it('rejects a duplicate location code with 409 DUPLICATE_LOCATION_CODE', async () => {
    const dup = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      { location_code: hazmatBinCode, level: 'zone', parent_location_id: siteId },
      adminHeaders,
    );
    assert.strictEqual(dup.status, 409, JSON.stringify(dup.body));
    assert.strictEqual(dup.body['error_code'], 'DUPLICATE_LOCATION_CODE');
  });

  it('updates location attributes via PATCH and appends location_register.updated', async () => {
    const patch = await makeRequest(
      port,
      'PATCH',
      `/api/v1/locations/${plainBinId}`,
      { temperature_class: 'cold', quarantine: true },
      adminHeaders,
    );
    assert.strictEqual(patch.status, 200, JSON.stringify(patch.body));
    assert.strictEqual(patch.body['temperature_class'], 'cold');
    assert.strictEqual(patch.body['quarantine'], true);

    const events = await getPool().query(
      `SELECT event_type, stream_type FROM domain_events WHERE stream_id = $1 ORDER BY event_version ASC`,
      [plainBinId],
    );
    assert.deepStrictEqual(
      events.rows.map((r) => `${r['stream_type']}:${r['event_type']}`),
      ['location_register:location_register.created', 'location_register:location_register.updated'],
    );

    const revert = await makeRequest(
      port,
      'PATCH',
      `/api/v1/locations/${plainBinId}`,
      { temperature_class: 'ambient', quarantine: false },
      adminHeaders,
    );
    assert.strictEqual(revert.status, 200, JSON.stringify(revert.body));
  });

  it('returns 404 LOCATION_NOT_FOUND for an unknown location id', async () => {
    const res = await makeRequest(port, 'GET', `/api/v1/locations/${randomUUID()}`, undefined, adminHeaders);
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'LOCATION_NOT_FOUND');
  });

  // ---------------------------------------------------------------------------------------------
  // Task 5.3 / AC2 - unknown item rejection on the central write path
  // ---------------------------------------------------------------------------------------------

  it('AC2: rejects a movement referencing an unknown SKU with ITEM_NOT_FOUND before any domain event or idempotency key', async () => {
    const streamId = randomUUID();
    const idempotencyKey = `im-${randomUUID()}`;
    const rejected = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      movementEnvelope(streamId, adminUserId, siteId, { sku: 'NONEXISTENT', quantity: 5 }, { idempotency_key: idempotencyKey }),
      adminHeaders,
    );
    assert.strictEqual(rejected.status, 400, JSON.stringify(rejected.body));
    assert.strictEqual(rejected.body['error_code'], 'ITEM_NOT_FOUND');
    assert.strictEqual((rejected.body['details'] as Record<string, unknown>)['sku'], 'NONEXISTENT');
    assert.strictEqual(await domainEventCount(streamId), 0, 'rejected movement must not touch domain_events');

    // The idempotency key was NOT consumed by the rejection: the corrected retry succeeds with it.
    const retry = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      movementEnvelope(streamId, adminUserId, siteId, { sku: 'RM-0042', quantity: 5 }, { idempotency_key: idempotencyKey }),
      adminHeaders,
    );
    assert.strictEqual(retry.status, 201, JSON.stringify(retry.body));
  });

  it('rejects an unknown SKU through the edge upload path too (central seam, not the HTTP handler)', async () => {
    const streamId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      movementEnvelope(
        streamId,
        adminUserId,
        siteId,
        { sku: 'NONEXISTENT-EDGE', quantity: 1 },
        { event_id: randomUUID(), idempotency_key: `edge-${randomUUID()}`, device_id: 'rugged-01' },
      ),
      edgeHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'ITEM_NOT_FOUND');
    assert.strictEqual(await domainEventCount(streamId), 0);
  });

  it('rejects a movement to an unknown target location with LOCATION_NOT_FOUND echoing the identifier', async () => {
    const streamId = randomUUID();
    const missing = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      movementEnvelope(streamId, adminUserId, siteId, { sku: 'RM-0042', target_location_id: missing }),
      adminHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'LOCATION_NOT_FOUND');
    assert.strictEqual((res.body['details'] as Record<string, unknown>)['target_location_id'], missing);
    assert.strictEqual(await domainEventCount(streamId), 0);
  });

  it('stamps HTTP event actor location from auth instead of trusting the request body (Task 3.8)', async () => {
    const streamId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      movementEnvelope(streamId, adminUserId, randomUUID(), { sku: 'RM-0042', quantity: 1 }),
      adminHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const row = await getPool().query(`SELECT metadata, stream_id FROM domain_events WHERE stream_id = $1`, [streamId]);
    assert.strictEqual(row.rows.length, 1);
    assert.strictEqual(row.rows[0]!['metadata']['actor']['location_id'], '00000000-0000-0000-0000-000000000000');
  });

  // ---------------------------------------------------------------------------------------------
  // Task 5.4 - non-inventory and legacy shapes remain unaffected
  // ---------------------------------------------------------------------------------------------

  it('leaves inventory events without master references otherwise untouched (legacy Story 1.6/1.9 shapes)', async () => {
    const streamId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      movementEnvelope(streamId, adminUserId, siteId, { quantity: 3 }),
      adminHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  });

  it('leaves non-inventory streams untouched by item/location validation', async () => {
    const streamId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'config',
        stream_id: streamId,
        event_type: 'config.noted',
        payload: { sku: 'NONEXISTENT', target_location_id: randomUUID(), note: 'non-inventory streams pass through' },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: adminUserId, role: 'system_administrator', location_id: randomUUID() },
          occurred_at: new Date().toISOString(),
        },
      },
      deniedHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(await domainEventCount(streamId), 1);
  });

  // ---------------------------------------------------------------------------------------------
  // Task 5.5 / AC3 - ZONE_INCOMPATIBLE warning with two-step confirmation
  // ---------------------------------------------------------------------------------------------

  it('AC3: a non-hazmat item into a hazmat location warns ZONE_INCOMPATIBLE first, persists only after confirmation, exactly once', async () => {
    const streamId = randomUUID();
    const idempotencyKey = `zone-${randomUUID()}`;

    // Step 1: unconfirmed placement returns the warning envelope and persists NOTHING.
    const warned = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      movementEnvelope(
        streamId,
        adminUserId,
        siteId,
        { sku: 'RM-0042', target_location_code: hazmatBinCode },
        { idempotency_key: idempotencyKey },
      ),
      adminHeaders,
    );
    assert.strictEqual(warned.status, 200, JSON.stringify(warned.body));
    assert.strictEqual(warned.body['warning_code'], 'ZONE_INCOMPATIBLE');
    assert.strictEqual(warned.body['confirmation_required'], true);
    assert.strictEqual(warned.body['persisted'], false);
    const details = warned.body['details'] as Record<string, unknown>;
    assert.strictEqual(details['sku'], 'RM-0042');
    assert.strictEqual(details['target_location_id'], hazmatBinId);
    assert.strictEqual(details['target_location_code'], hazmatBinCode);
    assert.ok(Array.isArray(details['reasons']) && (details['reasons'] as string[]).includes('non_hazmat_item_in_hazmat_zone'));
    assert.ok(String(warned.body['message']).includes('placement_confirmed'), 'warning copy must be actionable');
    assert.strictEqual(await domainEventCount(streamId), 0, 'warned movement must not persist');

    // Step 2: the confirmed resubmission persists (the warning did not consume the key).
    const confirmed = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      movementEnvelope(
        streamId,
        adminUserId,
        siteId,
        { sku: 'RM-0042', target_location_code: hazmatBinCode, placement_confirmed: true },
        { idempotency_key: idempotencyKey },
      ),
      adminHeaders,
    );
    assert.strictEqual(confirmed.status, 201, JSON.stringify(confirmed.body));
    assert.strictEqual(await domainEventCount(streamId), 1);

    // Step 3: retrying the confirmation with the same idempotency key persists nothing new.
    const duplicate = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      movementEnvelope(
        streamId,
        adminUserId,
        siteId,
        { sku: 'RM-0042', target_location_code: hazmatBinCode, placement_confirmed: true },
        { idempotency_key: idempotencyKey },
      ),
      adminHeaders,
    );
    assert.strictEqual(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.strictEqual(duplicate.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual(await domainEventCount(streamId), 1, 'confirmed placement must persist exactly once');
  });

  it('auto-confirms zone-incompatible edge placements so the outbox cannot mark an unpersisted movement synced', async () => {
    const streamId = randomUUID();
    const idempotencyKey = `edge-zone-${randomUUID()}`;
    const eventId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      movementEnvelope(
        streamId,
        adminUserId,
        siteId,
        { sku: 'RM-0042', target_location_code: hazmatBinCode },
        { event_id: eventId, idempotency_key: idempotencyKey, device_id: 'rugged-01' },
      ),
      edgeHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['warning_code'], undefined);
    assert.strictEqual(await domainEventCount(streamId), 1);
    const row = await getPool().query(`SELECT payload, metadata FROM domain_events WHERE event_id = $1`, [eventId]);
    assert.strictEqual(row.rows.length, 1);
    assert.strictEqual(row.rows[0]!['payload']['placement_confirmed'], true);
    assert.strictEqual(row.rows[0]!['metadata']['actor']['location_id'], siteId);
  });

  it('rejects inactive item, target location, and actor location references', async () => {
    const inactiveItem = await makeRequest(
      port,
      'POST',
      '/api/v1/items',
      { sku: 'RM-INACTIVE', uom: 'ea', valuation_method: 'fifo', business_stream: 'production', status: 'inactive' },
      adminHeaders,
    );
    assert.strictEqual(inactiveItem.status, 201, JSON.stringify(inactiveItem.body));
    const inactiveItemMove = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      movementEnvelope(randomUUID(), adminUserId, siteId, { sku: 'RM-INACTIVE', quantity: 1 }),
      adminHeaders,
    );
    assert.strictEqual(inactiveItemMove.status, 400, JSON.stringify(inactiveItemMove.body));
    assert.strictEqual(inactiveItemMove.body['error_code'], 'INACTIVE_ITEM');

    const inactiveLocation = await makeRequest(port, 'POST', '/api/v1/locations', { location_code: 'SITE-INACTIVE-ACTOR', level: 'site' }, adminHeaders);
    assert.strictEqual(inactiveLocation.status, 201, JSON.stringify(inactiveLocation.body));
    const inactiveLocationId = inactiveLocation.body['location_id'] as string;
    const patch = await makeRequest(port, 'PATCH', `/api/v1/locations/${inactiveLocationId}`, { status: 'inactive' }, adminHeaders);
    assert.strictEqual(patch.status, 200, JSON.stringify(patch.body));

    const inactiveTarget = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      movementEnvelope(randomUUID(), adminUserId, siteId, { sku: 'RM-0042', target_location_id: inactiveLocationId }),
      adminHeaders,
    );
    assert.strictEqual(inactiveTarget.status, 400, JSON.stringify(inactiveTarget.body));
    assert.strictEqual(inactiveTarget.body['error_code'], 'INACTIVE_LOCATION');

    await provisionUser(port, 'im-inactive-actor@example.com', [
      { role: 'inactive_site_operator', module: 'inventory', functionScope: 'write', locationId: inactiveLocationId },
    ]);
    const inactiveActorHeaders = await authFor(port, 'im-inactive-actor@example.com');
    const inactiveActor = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      movementEnvelope(randomUUID(), adminUserId, inactiveLocationId, { sku: 'RM-0042', quantity: 1 }),
      inactiveActorHeaders,
    );
    assert.strictEqual(inactiveActor.status, 400, JSON.stringify(inactiveActor.body));
    assert.strictEqual(inactiveActor.body['error_code'], 'ACTOR_LOCATION_INACTIVE');
  });

  it('persists a compatible placement without any warning', async () => {
    const streamId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      movementEnvelope(streamId, adminUserId, siteId, { sku: 'RM-0042', target_location_id: plainBinId, quantity: 2 }),
      adminHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['warning_code'], undefined);
    assert.strictEqual(await domainEventCount(streamId), 1);
  });

  it('rejects mismatched target_location_id and target_location_code with INVALID_PARAMS', async () => {
    const streamId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      movementEnvelope(streamId, adminUserId, siteId, {
        sku: 'RM-0042',
        target_location_id: plainBinId,
        target_location_code: hazmatBinCode,
      }),
      adminHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
    assert.strictEqual(await domainEventCount(streamId), 0);
  });

  // ---------------------------------------------------------------------------------------------
  // Task 5.7 - RBAC
  // ---------------------------------------------------------------------------------------------

  it('enforces module and function scopes on the item and location master endpoints', async () => {
    const deniedGet = await makeRequest(port, 'GET', '/api/v1/items/RM-0042', undefined, deniedHeaders);
    assert.strictEqual(deniedGet.status, 403, JSON.stringify(deniedGet.body));
    assert.strictEqual(deniedGet.body['error_code'], 'MODULE_ACCESS_DENIED');

    const readerGet = await makeRequest(port, 'GET', '/api/v1/items/RM-0042', undefined, readerHeaders);
    assert.strictEqual(readerGet.status, 200, JSON.stringify(readerGet.body));

    const readerCreate = await makeRequest(
      port,
      'POST',
      '/api/v1/items',
      { sku: 'RM-DENIED', uom: 'ea', valuation_method: 'fifo', business_stream: 'production' },
      readerHeaders,
    );
    assert.strictEqual(readerCreate.status, 403, JSON.stringify(readerCreate.body));
    assert.strictEqual(readerCreate.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    const readerLocation = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      { location_code: 'SITE-DENIED', level: 'site' },
      readerHeaders,
    );
    assert.strictEqual(readerLocation.status, 403, JSON.stringify(readerLocation.body));
    assert.strictEqual(readerLocation.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    const deniedLocation = await makeRequest(port, 'GET', `/api/v1/locations/${plainBinId}`, undefined, deniedHeaders);
    assert.strictEqual(deniedLocation.status, 403, JSON.stringify(deniedLocation.body));
    assert.strictEqual(deniedLocation.body['error_code'], 'MODULE_ACCESS_DENIED');
  });

  it('enforces location-scoped movement access and accepts the scoped actor at their registered site', async () => {
    const otherSite = await makeRequest(port, 'POST', '/api/v1/locations', { location_code: 'SITE-B', level: 'site' }, adminHeaders);
    assert.strictEqual(otherSite.status, 201, JSON.stringify(otherSite.body));
    const otherSiteId = otherSite.body['location_id'] as string;

    const denied = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      movementEnvelope(randomUUID(), adminUserId, otherSiteId, { sku: 'RM-0042', quantity: 1 }),
      scopedHeaders,
    );
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
    assert.strictEqual(denied.body['error_code'], 'LOCATION_ACCESS_DENIED');

    const allowed = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      movementEnvelope(randomUUID(), adminUserId, siteId, { sku: 'RM-0042', quantity: 1 }),
      scopedHeaders,
    );
    assert.strictEqual(allowed.status, 201, JSON.stringify(allowed.body));
  });
});
