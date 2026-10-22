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
 * Story 3.13: Gate Entry and Weighbridge Capture Screen.
 *
 * Task 1 server contract: the write-satisfies-read role seam for the gate and weighbridge GETs, the
 * ASN read admission for the gate roles, the bootstrap's site_code_ext and gate_id, the stamp-status
 * read, and the optional supplier fields on gate.entered.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: `Bearer ${process.env['SCIM_BEARER_TOKEN'] ?? ''}` };

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

describe('Story 3.13 Gate Entry and Weighbridge Capture', () => {
  let server: Server;
  let port: number;
  let siteAId: string;
  let gateOfficerHeaders: Record<string, string>;
  let weighOperatorHeaders: Record<string, string>;
  let storeHeaders: Record<string, string>;
  let viewerHeaders: Record<string, string>;

  const ASN_NUMBER = 'ASN-3-13-1';
  const PO_REF = 'PO-3-13-1';
  const DEVICE_KEY = 'WB-3-13';

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
      '../../read/projections/statutory_examination.sql',
      '../../read/projections/item_master.sql',
      '../../read/projections/location_register.sql',
      '../../read/projections/erp_purchase_order.sql',
      '../../read/projections/gate_event.sql',
      '../../read/projections/weighbridge_event.sql',
      '../../read/projections/asn.sql',
      '../../read/projections/asn_line.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE asn_line, asn, weighbridge_event, gate_event, statutory_examination, erp_purchase_order_line, erp_purchase_order, item_master, location_register, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ('SKU-3-13', 'EA', false, false, false, false, false, 'weighted_average', 'production', 'active')`,
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, expected_delivery_date, status, source_system, last_synced_at)
       VALUES ($1, 'SUP-3-13', 'INR', '2026-11-01', 'open', 'ERP', now())`,
      [PO_REF],
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, over_receipt_tolerance_pct, under_receipt_tolerance_pct, source_system, last_synced_at)
       VALUES ($1, 1, 'SKU-3-13', 100, 100, 1, 5, 5, 'ERP', now())`,
      [PO_REF],
    );
    // A weighbridge with a compliant statutory stamp, for the stamp-status read.
    await getPool().query(
      `INSERT INTO statutory_examination (examination_id, asset_id, examination_type, interval_months, next_due_date, status, device_key)
       VALUES ($1, $2, 'weighbridge_legal_metrology', 12, '2027-01-01', 'compliant', $3)`,
      [randomUUID(), randomUUID(), DEVICE_KEY],
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

    // Pilot-shaped gate roles hold both the inventory and their specialist module.
    await provisionUser(port, 'gate-officer-3-13@example.com', [
      { role: 'gate_officer', module: 'inventory', functionScope: 'write', locationId: siteAId },
      { role: 'gate_officer', module: 'gate', functionScope: 'write', locationId: siteAId },
    ]);
    gateOfficerHeaders = await authFor(port, 'gate-officer-3-13@example.com');

    await provisionUser(port, 'weigh-operator-3-13@example.com', [
      {
        role: 'weighbridge_operator',
        module: 'inventory',
        functionScope: 'write',
        locationId: siteAId,
      },
      {
        role: 'weighbridge_operator',
        module: 'weighbridge',
        functionScope: 'write',
        locationId: siteAId,
      },
    ]);
    weighOperatorHeaders = await authFor(port, 'weigh-operator-3-13@example.com');

    await provisionUser(port, 'store-assistant-3-13@example.com', [
      { role: 'store_assistant', module: 'receiving', functionScope: 'write', locationId: siteAId },
    ]);
    storeHeaders = await authFor(port, 'store-assistant-3-13@example.com');

    await provisionUser(port, 'stock-viewer-3-13@example.com', [
      { role: 'stock_viewer', module: 'inventory', functionScope: 'read', locationId: siteAId },
    ]);
    viewerHeaders = await authFor(port, 'stock-viewer-3-13@example.com');

    // Seed one ASN so the gate roles have something to read.
    const asnRes = await makeRequest(
      port,
      'POST',
      '/api/v1/asn',
      {
        asn_number_ext: ASN_NUMBER,
        po_ref_ext: PO_REF,
        site_code_ext: 'site-A',
        lines: [{ line_no: 1, sku: 'SKU-3-13', expected_qty: 100 }],
      },
      storeHeaders,
    );
    assert.strictEqual(asnRes.status, 201, `seed ASN failed: ${JSON.stringify(asnRes.body)}`);
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('AC2: a write-only gate officer lists gate events with 200', async () => {
    const res = await makeRequest(port, 'GET', '/api/v1/gate-events', undefined, gateOfficerHeaders);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  });

  it('AC2: a write-only weighbridge operator lists weighbridge events with 200', async () => {
    const res = await makeRequest(
      port,
      'GET',
      '/api/v1/weighbridge-events',
      undefined,
      weighOperatorHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  });

  it('AC2: gate officer and weighbridge operator read an ASN with 200', async () => {
    for (const headers of [gateOfficerHeaders, weighOperatorHeaders]) {
      const res = await makeRequest(port, 'GET', `/api/v1/asn/${ASN_NUMBER}`, undefined, headers);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body['asn_number_ext'], ASN_NUMBER);
    }
  });

  it('AC2: a read-only stock_viewer still gets 403 on the gate and weighbridge GETs', async () => {
    const gateRes = await makeRequest(port, 'GET', '/api/v1/gate-events', undefined, viewerHeaders);
    assert.strictEqual(gateRes.status, 403, JSON.stringify(gateRes.body));
    const weighRes = await makeRequest(
      port,
      'GET',
      '/api/v1/weighbridge-events',
      undefined,
      viewerHeaders,
    );
    assert.strictEqual(weighRes.status, 403, JSON.stringify(weighRes.body));
  });

  it('AC3: bootstrap carries site_code_ext and gate_id and advertises Gate entry only for gate roles', async () => {
    const gateBootstrap = await makeRequest(
      port,
      'GET',
      '/api/v1/edge/bootstrap',
      undefined,
      gateOfficerHeaders,
    );
    assert.strictEqual(gateBootstrap.status, 200, JSON.stringify(gateBootstrap.body));
    assert.strictEqual(gateBootstrap.body['site_code_ext'], 'site-A');
    assert.strictEqual(gateBootstrap.body['gate_id'], 'GATE-01');
    assert.ok(
      (gateBootstrap.body['navigation'] as string[]).includes('Gate entry'),
      'gate officer should see Gate entry',
    );

    const storeBootstrap = await makeRequest(
      port,
      'GET',
      '/api/v1/edge/bootstrap',
      undefined,
      storeHeaders,
    );
    assert.strictEqual(storeBootstrap.status, 200, JSON.stringify(storeBootstrap.body));
    assert.ok(
      !(storeBootstrap.body['navigation'] as string[]).includes('Gate entry'),
      'a store assistant must not be sent Gate entry',
    );
  });

  it('AC4: the stamp-status read returns the device keys and their stamp state', async () => {
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/weighbridge-events/stamp-status?site=site-A`,
      undefined,
      weighOperatorHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const stampStatus = res.body['stamp_status'] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(stampStatus));
    const device = stampStatus.find((row) => row['device_key'] === DEVICE_KEY);
    assert.ok(device, 'expected the seeded weighbridge device');
    assert.strictEqual(device!['status'], 'compliant');
  });

  it('AC3: gate.entered accepts and persists the optional supplier fields', async () => {
    const body = {
      site_code_ext: 'site-A',
      po_ref_ext: 'UNKNOWN',
      vehicle_reg_ext: 'ka01ab1234',
      driver_name: 'Ravi',
      challan_photo_ref: 'photo-ref-1',
      gate_id: 'GATE-01',
      entered_at: new Date().toISOString(),
      supplier_ref_ext: 'UNLISTED',
      supplier_name_unlisted: 'Acme Traders',
    };
    const res = await makeRequest(port, 'POST', '/api/v1/gate-events', body, gateOfficerHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['supplier_ref_ext'], 'UNLISTED');
    assert.strictEqual(res.body['supplier_name_unlisted'], 'Acme Traders');
    assert.strictEqual(res.body['binding_status'], 'unmatched');
    assert.strictEqual(res.body['vehicle_reg_ext'], 'KA01AB1234');

    const readBack = await makeRequest(
      port,
      'GET',
      `/api/v1/gate-events/${res.body['gate_event_id'] as string}`,
      undefined,
      gateOfficerHeaders,
    );
    assert.strictEqual(readBack.status, 200, JSON.stringify(readBack.body));
    assert.strictEqual(readBack.body['supplier_ref_ext'], 'UNLISTED');
    assert.strictEqual(readBack.body['supplier_name_unlisted'], 'Acme Traders');
  });
});
