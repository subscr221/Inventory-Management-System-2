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
import { runDispatchCycle } from '../../src/notify/dispatch.js';
import { TOLERANCE_BREACH_OWNER_ROLE } from '../../src/compliance/weighbridge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROLES_FIXTURE = resolve(__dirname, '../../docs/migration/pilot-mock-extract/roles.json');
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

interface RolesFile {
  people: Record<string, { display_name?: string }>;
  roles: {
    role: string;
    module: string;
    function_scope: 'read' | 'write';
    location_id: string;
    holder: string;
  }[];
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

/**
 * The grants of the first pilot holder of the breach owner role, with `site` mapped to the given
 * site id. Fails loudly when the fixture has no holder: that is the Story 3.12 defect itself.
 */
function pilotHolderGrants(siteId: string): { holder: string; roles: Role[] } {
  const fixture = JSON.parse(readFileSync(ROLES_FIXTURE, 'utf-8')) as RolesFile;
  const grant = fixture.roles.find(
    (r) =>
      r.role === TOLERANCE_BREACH_OWNER_ROLE && (r.location_id === 'site' || r.location_id === '*'),
  );
  assert.ok(
    grant,
    `no holder of "${TOLERANCE_BREACH_OWNER_ROLE}" at "site" or "*" in ${ROLES_FIXTURE}`,
  );
  const roles = fixture.roles
    .filter((r) => r.holder === grant.holder)
    .map((r) => ({
      role: r.role,
      module: r.module,
      functionScope: r.function_scope,
      locationId: r.location_id === 'site' ? siteId : r.location_id,
    }));
  return { holder: grant.holder, roles };
}

describe('Story 3.12 Weighbridge Breach Task Routing for Pilot Roles', () => {
  let server: Server;
  let port: number;
  let gateHeaders: Record<string, string>;
  let weighHeaders: Record<string, string>;
  let holderAHeaders: Record<string, string>;
  let holderBHeaders: Record<string, string>;
  let siteAId: string;
  let siteBId: string;

  function gateBody(): Record<string, unknown> {
    return {
      gate_event_id: randomUUID(),
      site_code_ext: 'site-A',
      po_ref_ext: 'PO-WB-1',
      vehicle_reg_ext: 'KA01AB1234',
      challan_number_ext: `CH-${randomUUID().slice(0, 8)}`,
      challan_photo_ref: `challan-${randomUUID()}.jpg`,
      driver_name: 'Raman',
      gate_id: 'GATE-1',
      entered_at: '2026-07-22T04:45:00.000Z',
    };
  }

  async function newBindingToken(): Promise<string> {
    const res = await makeRequest(port, 'POST', '/api/v1/gate-events', gateBody(), gateHeaders);
    assert.strictEqual(res.status, 201, `gate create failed: ${JSON.stringify(res.body)}`);
    return res.body['correlation_id'] as string;
  }

  async function weigh(grossKg: number): Promise<HttpResult> {
    const token = await newBindingToken();
    return makeRequest(
      port,
      'POST',
      '/api/v1/weighbridge-events',
      {
        weighbridge_event_id: randomUUID(),
        correlation_id: token,
        tare_kg: 12000,
        gross_kg: grossKg,
        po_ref_ext: 'PO-WB-1',
        line_no: 1,
        device_id: 'WB-DEVICE-1',
        capture_method: 'MANUAL',
      },
      weighHeaders,
    );
  }

  async function breachNotificationsFor(
    headers: Record<string, string>,
  ): Promise<Record<string, unknown>[]> {
    const res = await makeRequest(
      port,
      'GET',
      '/api/v1/notifications?type=weighbridge_tolerance_breach',
      undefined,
      headers,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body['notifications'] as Record<string, unknown>[];
  }

  async function createdEventsFor(weighbridgeEventId: string): Promise<Record<string, unknown>[]> {
    const rows = await getPool().query(
      `SELECT payload FROM domain_events
       WHERE stream_type = 'notification' AND event_type = 'notification.created'
         AND payload->>'object_type' = 'weighbridge_event' AND payload->>'object_id' = $1`,
      [weighbridgeEventId],
    );
    return rows.rows.map((r) => r['payload'] as Record<string, unknown>);
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
      '../../read/projections/inventory_planning.sql',
      '../../read/projections/replenishment_recommendation.sql',
      '../../read/projections/obsolescence_flag.sql',
      '../../read/projections/ownership_agreement.sql',
      '../../read/projections/erp_purchase_order.sql',
      '../../read/projections/erp_sales_order.sql',
      '../../read/projections/integration_exception.sql',
      '../../read/projections/gate_event.sql',
      '../../read/projections/weighbridge_event.sql',
      '../../read/projections/notification.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE notification_escalations, notification_escalation_defs, notification_deliveries, notifications, notification_dispatch_log, notification_dispatch_attempts, weighbridge_event, gate_event, integration_exception, erp_sync_state, erp_sales_order, erp_purchase_order_line, erp_purchase_order, ownership_agreement, obsolescence_flag, replenishment_recommendation, inventory_planning_params, physical_verification_line, physical_verification, cycle_count_line, cycle_count, in_transit, transfer_request, inventory_valuation, lot_master, serial_master, lot_trace, stock_balance, item_master, location_register, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    siteAId = randomUUID();
    siteBId = randomUUID();
    await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, site_id, zone_type, temperature_class, status)
       VALUES ($1, 'site-A', 'site', $1, 'general', 'ambient', 'active'), ($2, 'site-B', 'site', $2, 'general', 'ambient', 'active')`,
      [siteAId, siteBId],
    );
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ('SKU-WB-1', 'KG', false, false, false, false, false, 'weighted_average', 'production', 'active')`,
    );
    // PO-WB-1 line 1: 3500 kg with +/-2% tolerance, band [3430, 3570] (same as story-3-3).
    await getPool().query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, expected_delivery_date, status, source_system, last_synced_at)
       VALUES ('PO-WB-1', 'SUP-1', 'INR', '2026-08-01', 'open', 'ERP', now())`,
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, over_receipt_tolerance_pct, under_receipt_tolerance_pct, source_system, last_synced_at)
       VALUES ('PO-WB-1', 1, 'SKU-WB-1', 3500, 3500, 1, 2, 2, 'ERP', now())`,
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

    await provisionUser(port, 'gate-officer-3-12@example.com', [
      { role: 'gate_officer', module: 'inventory', functionScope: 'write', locationId: siteAId },
      { role: 'gate_officer', module: 'gate', functionScope: 'write', locationId: siteAId },
    ]);
    gateHeaders = await authFor(port, 'gate-officer-3-12@example.com');

    await provisionUser(port, 'weighbridge-operator-3-12@example.com', [
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
    weighHeaders = await authFor(port, 'weighbridge-operator-3-12@example.com');

    // Case 1: the real pilot holder, provisioned with exactly the grants the pilot pack gives them.
    const pilot = pilotHolderGrants(siteAId);
    const holderA = `pilot-${pilot.holder.split('@')[0]}-3-12@example.com`;
    await provisionUser(port, holderA, pilot.roles);
    holderAHeaders = await authFor(port, holderA);

    // Case 2: a second holder of the same role at site-B (negative control).
    await provisionUser(port, 'breach-owner-site-b-3-12@example.com', [
      {
        role: TOLERANCE_BREACH_OWNER_ROLE,
        module: 'inventory',
        functionScope: 'read',
        locationId: siteBId,
      },
      {
        role: TOLERANCE_BREACH_OWNER_ROLE,
        module: 'notification',
        functionScope: 'read',
        locationId: siteBId,
      },
    ]);
    holderBHeaders = await authFor(port, 'breach-owner-site-b-3-12@example.com');
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('AC3/AC4: a tolerance breach at site-A reaches the pilot holder of the owner role through the real dispatcher, and no one at site-B', async () => {
    // gross 16000 - tare 12000 = net 4000, above the 3570 upper bound -> breach.
    const res = await weigh(16000);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['status'], 'tolerance_breach');
    const weighbridgeEventId = res.body['weighbridge_event_id'] as string;
    const reason = res.body['tolerance_breach_reason'];
    assert.strictEqual(typeof reason, 'string');
    assert.ok((reason as string).length > 0, 'tolerance_breach_reason is empty');

    const cycle = await runDispatchCycle();
    assert.ok(
      cycle.notificationsCreated >= 1,
      `dispatcher created no notifications: ${JSON.stringify(cycle)}`,
    );

    const inboxA = await breachNotificationsFor(holderAHeaders);
    const forEvent = inboxA.filter((n) => n['object_id'] === weighbridgeEventId);
    assert.strictEqual(
      forEvent.length,
      1,
      `expected exactly one breach notification for ${weighbridgeEventId} in the site-A holder inbox, got ${forEvent.length} (inbox size ${inboxA.length})`,
    );
    const notification = forEvent[0]!;
    assert.strictEqual(notification['event_type'], 'weighbridge_tolerance_breach');
    assert.strictEqual(notification['object_type'], 'weighbridge_event');
    assert.strictEqual(notification['next_step'], reason);

    const inboxB = await breachNotificationsFor(holderBHeaders);
    assert.deepStrictEqual(
      inboxB.filter((n) => n['object_id'] === weighbridgeEventId),
      [],
      'a site-B holder must not receive a site-A breach',
    );
  });

  it('AC1/AC2: the emitted notification.created event targets the owner role constant at the site', async () => {
    const res = await weigh(16000);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['status'], 'tolerance_breach');
    const created = await createdEventsFor(res.body['weighbridge_event_id'] as string);
    assert.strictEqual(
      created.length,
      1,
      `expected one notification.created, got ${created.length}`,
    );
    const target = created[0]!['target'] as Record<string, unknown>;
    assert.strictEqual(target['role'], TOLERANCE_BREACH_OWNER_ROLE);
    assert.strictEqual(target['location_id'], siteAId);
    assert.strictEqual(target['user_id'], null);
    assert.strictEqual(created[0]!['event_type'], 'weighbridge_tolerance_breach');
    assert.strictEqual(created[0]!['next_step'], res.body['tolerance_breach_reason']);
  });

  it('AC1: an accepted weighment emits no notification.created event', async () => {
    // gross 15500 - tare 12000 = net 3500, inside the band.
    const res = await weigh(15500);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['status'], 'accepted');
    assert.strictEqual(res.body['tolerance_breach_reason'], null);
    const created = await createdEventsFor(res.body['weighbridge_event_id'] as string);
    assert.deepStrictEqual(created, []);
  });
});
