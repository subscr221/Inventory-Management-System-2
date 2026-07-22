import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getAdminPool, closeAdminPool } from '../../src/config/db.js';

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

async function provisionUser(port: number, externalId: string, roles: Role[]): Promise<void> {
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
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(
    res.status >= 200 && res.status < 300,
    `dev-token ${sub} failed: ${JSON.stringify(res.body)}`,
  );
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

describe('Story 3.1 Warehouse Topology Setup', () => {
  let server: Server;
  let port: number;
  let managerHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let qcHeaders: Record<string, string>;
  let siteId: string;
  let ambientZoneId: string;
  let restrictedZoneId: string;
  let aisleId: string;
  let rackId: string;

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
      '../../read/projections/location_register.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE location_register, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    await provisionUser(port, 'wms-manager@example.com', [
      { role: 'warehouse_manager', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    managerHeaders = await authFor(port, 'wms-manager@example.com');

    await provisionUser(port, 'wms-reader@example.com', [
      { role: 'stock_viewer', module: 'inventory', functionScope: 'read', locationId: '*' },
    ]);
    readerHeaders = await authFor(port, 'wms-reader@example.com');

    await provisionUser(port, 'wms-qc@example.com', [
      { role: 'qc_inspector', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    qcHeaders = await authFor(port, 'wms-qc@example.com');
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('AC1: lists a cold zone by site code with zone type and temperature class', async () => {
    const site = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      { location_code: 'site-A', level: 'site' },
      managerHeaders,
    );
    assert.strictEqual(site.status, 201, JSON.stringify(site.body));
    siteId = site.body['location_id'] as string;

    const zone = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      {
        location_code: 'ZONE-COLD',
        level: 'zone',
        parent_location_id: siteId,
        zone_type: 'general',
        temperature_class: 'cold',
      },
      managerHeaders,
    );
    assert.strictEqual(zone.status, 201, JSON.stringify(zone.body));

    const list = await makeRequest(
      port,
      'GET',
      '/api/v1/locations?site=site-A',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    const locations = list.body['locations'] as Record<string, unknown>[];
    const coldZone = locations.find((location) => location['location_code'] === 'ZONE-COLD');
    assert.ok(coldZone, 'ZONE-COLD must appear in the site-filtered list');
    assert.strictEqual(coldZone['level'], 'zone');
    assert.strictEqual(coldZone['zone_type'], 'general');
    assert.strictEqual(coldZone['temperature_class'], 'cold');
  });

  it('AC2: reads a bin by code with full hierarchy path and warehouse attributes', async () => {
    const zone = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      {
        location_code: 'ZONE-AMBIENT',
        level: 'zone',
        parent_location_id: siteId,
        temperature_class: 'ambient',
      },
      managerHeaders,
    );
    assert.strictEqual(zone.status, 201, JSON.stringify(zone.body));
    ambientZoneId = zone.body['location_id'] as string;

    const aisle = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      { location_code: 'AISLE-A', level: 'aisle', parent_location_id: ambientZoneId },
      managerHeaders,
    );
    assert.strictEqual(aisle.status, 201, JSON.stringify(aisle.body));
    aisleId = aisle.body['location_id'] as string;

    const rack = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      { location_code: 'RACK-4', level: 'rack', parent_location_id: aisleId },
      managerHeaders,
    );
    assert.strictEqual(rack.status, 201, JSON.stringify(rack.body));
    rackId = rack.body['location_id'] as string;

    const bin = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      {
        location_code: 'BIN-A43',
        level: 'bin',
        parent_location_id: rackId,
        size_class: 'medium',
        temperature_class: 'ambient',
        hazmat_allowed: true,
      },
      managerHeaders,
    );
    assert.strictEqual(bin.status, 201, JSON.stringify(bin.body));

    const read = await makeRequest(
      port,
      'GET',
      '/api/v1/locations/BIN-A43',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(read.status, 200, JSON.stringify(read.body));
    assert.strictEqual(read.body['location_code'], 'BIN-A43');
    assert.strictEqual(
      read.body['hierarchy_path'],
      'site-A > ZONE-AMBIENT > AISLE-A > RACK-4 > BIN-A43',
    );
    assert.strictEqual(read.body['size_class'], 'medium');
    assert.strictEqual(read.body['temperature_class'], 'ambient');
    assert.strictEqual(read.body['hazmat_allowed'], true);
  });

  it('AC3: rejects non-QC writes under a restricted quarantine zone with ZONE_ACCESS_RESTRICTED', async () => {
    const managerRestrictedCreate = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      {
        location_code: `ZONE-MANAGER-RESTRICTED-${randomUUID().slice(0, 8)}`,
        level: 'zone',
        parent_location_id: siteId,
        zone_type: 'quarantine',
        access_restricted: true,
      },
      managerHeaders,
    );
    assert.strictEqual(managerRestrictedCreate.status, 403, JSON.stringify(managerRestrictedCreate.body));
    assert.strictEqual(managerRestrictedCreate.body['error_code'], 'ZONE_ACCESS_RESTRICTED');

    const managerZone = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      {
        location_code: `ZONE-MANAGER-OPEN-${randomUUID().slice(0, 8)}`,
        level: 'zone',
        parent_location_id: siteId,
      },
      managerHeaders,
    );
    assert.strictEqual(managerZone.status, 201, JSON.stringify(managerZone.body));
    const managerRestrictedPatch = await makeRequest(
      port,
      'PATCH',
      `/api/v1/locations/${managerZone.body['location_id'] as string}`,
      { access_restricted: true },
      managerHeaders,
    );
    assert.strictEqual(managerRestrictedPatch.status, 403, JSON.stringify(managerRestrictedPatch.body));
    assert.strictEqual(managerRestrictedPatch.body['error_code'], 'ZONE_ACCESS_RESTRICTED');

    const zone = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      {
        location_code: 'ZONE-QC-HOLD',
        level: 'zone',
        parent_location_id: siteId,
        zone_type: 'quarantine',
        quarantine: true,
        access_restricted: true,
      },
      qcHeaders,
    );
    assert.strictEqual(zone.status, 201, JSON.stringify(zone.body));
    restrictedZoneId = zone.body['location_id'] as string;

    const denied = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      {
        location_code: `AISLE-DENIED-${randomUUID().slice(0, 8)}`,
        level: 'aisle',
        parent_location_id: restrictedZoneId,
      },
      managerHeaders,
    );
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
    assert.strictEqual(denied.body['error_code'], 'ZONE_ACCESS_RESTRICTED');

    const allowed = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      {
        location_code: `AISLE-QC-${randomUUID().slice(0, 8)}`,
        level: 'aisle',
        parent_location_id: restrictedZoneId,
      },
      qcHeaders,
    );
    assert.strictEqual(allowed.status, 201, JSON.stringify(allowed.body));
    const restrictedAisleId = allowed.body['location_id'] as string;

    const deepDenied = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      {
        location_code: `RACK-DENIED-${randomUUID().slice(0, 8)}`,
        level: 'rack',
        parent_location_id: restrictedAisleId,
      },
      managerHeaders,
    );
    assert.strictEqual(deepDenied.status, 403, JSON.stringify(deepDenied.body));
    assert.strictEqual(deepDenied.body['error_code'], 'ZONE_ACCESS_RESTRICTED');

    const patchDenied = await makeRequest(
      port,
      'PATCH',
      `/api/v1/locations/${restrictedZoneId}`,
      { access_restricted: false },
      managerHeaders,
    );
    assert.strictEqual(patchDenied.status, 403, JSON.stringify(patchDenied.body));
    assert.strictEqual(patchDenied.body['error_code'], 'ZONE_ACCESS_RESTRICTED');
  });
});
