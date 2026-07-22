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

function makeRequest(port: number, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult> {
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
  const res = await makeRequest(port, 'POST', '/api/v1/scim/v2/Users', { externalId, email: externalId, displayName: externalId, roles }, SCIM_HEADERS);
  assert.strictEqual(res.status, 201, `provision ${externalId} failed: ${JSON.stringify(res.body)}`);
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub} failed: ${JSON.stringify(res.body)}`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

describe('Story 3.3 Weighbridge Event Capture and Tolerance Enforcement', () => {
  let server: Server;
  let port: number;
  let gateHeaders: Record<string, string>;
  let weighHeaders: Record<string, string>;
  let weighSiteBHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let managerHeaders: Record<string, string>;
  let siteAId: string;
  let siteBId: string;
  let weighOperatorId: string;

  function gateBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      gate_event_id: randomUUID(),
      site_code_ext: 'site-A',
      po_ref_ext: 'PO-WB-1',
      vehicle_reg_ext: 'KA01AB1234',
      challan_number_ext: 'CH-1',
      challan_photo_ref: `challan-${randomUUID()}.jpg`,
      driver_name: 'Raman',
      gate_id: 'GATE-1',
      entered_at: '2026-07-22T04:45:00.000Z',
      ...overrides,
    };
  }

  // Creates a Story 3.2 gate event at site-A and returns its binding token (correlation_id).
  async function newBindingToken(overrides: Record<string, unknown> = {}): Promise<string> {
    const res = await makeRequest(port, 'POST', '/api/v1/gate-events', gateBody(overrides), gateHeaders);
    assert.strictEqual(res.status, 201, `gate create failed: ${JSON.stringify(res.body)}`);
    return res.body['correlation_id'] as string;
  }

  function wbBody(correlationId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      weighbridge_event_id: randomUUID(),
      correlation_id: correlationId,
      tare_kg: 12000,
      gross_kg: 15500,
      po_ref_ext: 'PO-WB-1',
      line_no: 1,
      device_id: 'WB-DEVICE-1',
      capture_method: 'MANUAL',
      ...overrides,
    };
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
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE weighbridge_event, gate_event, integration_exception, erp_sync_state, erp_sales_order, erp_purchase_order_line, erp_purchase_order, ownership_agreement, obsolescence_flag, replenishment_recommendation, inventory_planning_params, physical_verification_line, physical_verification, cycle_count_line, cycle_count, in_transit, transfer_request, inventory_valuation, lot_master, serial_master, lot_trace, stock_balance, item_master, location_register, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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
    // PO-WB-1: an open PO whose line-1 ordered_qty is 3500 kg with +/-2% tolerance -> band [3430, 3570].
    // PO-WB-NOLINE: an open header with no lines, exercising the tolerance-unknowable rejection.
    await getPool().query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, expected_delivery_date, status, source_system, last_synced_at)
       VALUES ('PO-WB-1', 'SUP-1', 'INR', '2026-08-01', 'open', 'ERP', now()), ('PO-WB-NOLINE', 'SUP-1', 'INR', '2026-08-01', 'open', 'ERP', now())`,
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

    await provisionUser(port, 'gate-officer-3-3@example.com', [
      { role: 'gate_officer', module: 'inventory', functionScope: 'write', locationId: siteAId },
      { role: 'gate_officer', module: 'gate', functionScope: 'write', locationId: siteAId },
    ]);
    gateHeaders = await authFor(port, 'gate-officer-3-3@example.com');

    weighOperatorId = await provisionUser(port, 'weighbridge-operator-3-3@example.com', [
      { role: 'weighbridge_operator', module: 'inventory', functionScope: 'write', locationId: siteAId },
      { role: 'weighbridge_operator', module: 'weighbridge', functionScope: 'write', locationId: siteAId },
    ]);
    weighHeaders = await authFor(port, 'weighbridge-operator-3-3@example.com');

    await provisionUser(port, 'weighbridge-operator-site-b-3-3@example.com', [
      { role: 'weighbridge_operator', module: 'inventory', functionScope: 'write', locationId: siteBId },
      { role: 'weighbridge_operator', module: 'weighbridge', functionScope: 'write', locationId: siteBId },
    ]);
    weighSiteBHeaders = await authFor(port, 'weighbridge-operator-site-b-3-3@example.com');

    await provisionUser(port, 'unloading-supervisor-3-3@example.com', [
      { role: 'unloading_supervisor', module: 'inventory', functionScope: 'read', locationId: siteAId },
    ]);
    readerHeaders = await authFor(port, 'unloading-supervisor-3-3@example.com');

    await provisionUser(port, 'warehouse-manager-3-3@example.com', [
      { role: 'warehouse_manager', module: 'inventory', functionScope: 'read', locationId: '*' },
    ]);
    managerHeaders = await authFor(port, 'warehouse-manager-3-3@example.com');
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('AC1/AC2: accepted capture auto-calculates net and carries the binding token, device, and capture_method', async () => {
    const token = await newBindingToken();
    const weighbridgeEventId = randomUUID();
    const res = await makeRequest(port, 'POST', '/api/v1/weighbridge-events', wbBody(token, { weighbridge_event_id: weighbridgeEventId }), weighHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['weighbridge_event_id'], weighbridgeEventId);
    assert.strictEqual(res.body['net_kg'], '3500.000');
    assert.strictEqual(res.body['tare_kg'], '12000.000');
    assert.strictEqual(res.body['gross_kg'], '15500.000');
    assert.strictEqual(res.body['status'], 'accepted');
    assert.strictEqual(res.body['binding_token'], token);
    assert.strictEqual(res.body['correlation_id'], token);
    assert.strictEqual(res.body['device_id'], 'WB-DEVICE-1');
    assert.strictEqual(res.body['capture_method'], 'MANUAL');
    assert.strictEqual(res.body['weighed_by'], weighOperatorId);
    assert.strictEqual(res.body['business_date'], '2026-07-22');

    // Accepted weight is queryable against the binding token, with the resolved PO line summary.
    const read = await makeRequest(port, 'GET', `/api/v1/weighbridge-events/${weighbridgeEventId}`, undefined, readerHeaders);
    assert.strictEqual(read.status, 200, JSON.stringify(read.body));
    assert.strictEqual(read.body['status'], 'accepted');
    assert.strictEqual(read.body['binding_token'], token);
    const summary = read.body['po_summary'] as Record<string, unknown>;
    assert.strictEqual(summary['po_number_ext'], 'PO-WB-1');
    assert.strictEqual((summary['line'] as Record<string, unknown>)['line_no'], 1);
  });

  it('AC3: out-of-tolerance net is flagged tolerance_breach and blocked from silent receipt', async () => {
    const token = await newBindingToken();
    // gross 16000 - tare 12000 = net 4000, above the 3570 upper bound -> breach.
    const res = await makeRequest(port, 'POST', '/api/v1/weighbridge-events', wbBody(token, { gross_kg: 16000 }), weighHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['net_kg'], '4000.000');
    assert.strictEqual(res.body['status'], 'tolerance_breach');
    assert.ok(typeof res.body['tolerance_breach_reason'] === 'string' && (res.body['tolerance_breach_reason'] as string).length > 0);

    const list = await makeRequest(port, 'GET', '/api/v1/weighbridge-events?status=tolerance_breach', undefined, managerHeaders);
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    const events = list.body['weighbridge_events'] as Record<string, unknown>[];
    assert.ok(events.some((row) => row['weighbridge_event_id'] === res.body['weighbridge_event_id']));
  });

  it('AC1: WEIGHBRIDGE_BINDING_TOKEN_NOT_FOUND for a token with no gate event', async () => {
    const res = await makeRequest(port, 'POST', '/api/v1/weighbridge-events', wbBody(randomUUID()), weighHeaders);
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'WEIGHBRIDGE_BINDING_TOKEN_NOT_FOUND');
  });

  it('AC3: WEIGHBRIDGE_SITE_MISMATCH when the supplied weighbridge site differs from the gate-event site', async () => {
    const token = await newBindingToken();
    const res = await makeRequest(port, 'POST', '/api/v1/weighbridge-events', wbBody(token, { site_code_ext: 'site-B' }), weighHeaders);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'WEIGHBRIDGE_SITE_MISMATCH');
  });

  it('AC1: WEIGHBRIDGE_NET_NEGATIVE is rejected before any event is persisted', async () => {
    const token = await newBindingToken();
    const weighbridgeEventId = randomUUID();
    const res = await makeRequest(port, 'POST', '/api/v1/weighbridge-events', wbBody(token, { weighbridge_event_id: weighbridgeEventId, tare_kg: 15500, gross_kg: 12000 }), weighHeaders);
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'WEIGHBRIDGE_NET_NEGATIVE');
    const persisted = await getPool().query('SELECT count(*)::int AS c FROM domain_events WHERE stream_id = $1', [weighbridgeEventId]);
    assert.strictEqual(persisted.rows[0]!['c'], 0);
  });

  it('AC3: a PO reference with no line rejects with WEIGHBRIDGE_PO_LINE_NOT_FOUND (tolerance unknowable)', async () => {
    const token = await newBindingToken({ po_ref_ext: 'PO-WB-NOLINE' });
    const res = await makeRequest(port, 'POST', '/api/v1/weighbridge-events', wbBody(token, { po_ref_ext: 'PO-WB-NOLINE' }), weighHeaders);
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'WEIGHBRIDGE_PO_LINE_NOT_FOUND');
  });

  it('Task 5: RBAC rejects non-weighbridge roles and out-of-scope sites', async () => {
    const token = await newBindingToken();
    const nonWeigh = await makeRequest(port, 'POST', '/api/v1/weighbridge-events', wbBody(token), readerHeaders);
    assert.strictEqual(nonWeigh.status, 403, JSON.stringify(nonWeigh.body));
    assert.strictEqual(nonWeigh.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    // A weighbridge operator scoped to site-B cannot record against a site-A gate token.
    const outOfScope = await makeRequest(port, 'POST', '/api/v1/weighbridge-events', wbBody(token), weighSiteBHeaders);
    assert.strictEqual(outOfScope.status, 403, JSON.stringify(outOfScope.body));
    assert.strictEqual(outOfScope.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });

  it('AC4/Task 7: edge upload replays idempotently and never mutates any erp_* projection', async () => {
    const token = await newBindingToken();
    const weighbridgeEventId = randomUUID();
    const beforePo = await getPool().query('SELECT count(*)::int AS c FROM erp_purchase_order');
    const beforeLine = await getPool().query('SELECT count(*)::int AS c FROM erp_purchase_order_line');
    const envelope = {
      event_id: randomUUID(),
      stream_type: 'weighbridge',
      stream_id: weighbridgeEventId,
      event_type: 'weighbridge.recorded',
      payload: wbBody(token, { weighbridge_event_id: weighbridgeEventId }),
      metadata: { correlation_id: token, actor: { user_id: weighOperatorId, role: 'weighbridge_operator', location_id: siteAId }, device_id: 'EDGE-WB-1', occurred_at: '2026-07-22T05:10:00.000Z' },
      idempotency_key: `wb-edge-${weighbridgeEventId}`,
    };

    const edge = await makeRequest(port, 'POST', '/api/v1/edge/events', envelope, weighHeaders);
    assert.strictEqual(edge.status, 201, JSON.stringify(edge.body));
    const duplicate = await makeRequest(port, 'POST', '/api/v1/edge/events', envelope, weighHeaders);
    assert.strictEqual(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.strictEqual(duplicate.body['error_code'], 'DUPLICATE_EVENT');

    const rows = await getPool().query('SELECT count(*)::int AS c, max(status) AS status FROM weighbridge_event WHERE weighbridge_event_id = $1', [weighbridgeEventId]);
    assert.strictEqual(rows.rows[0]!['c'], 1);
    assert.strictEqual(rows.rows[0]!['status'], 'accepted');

    const afterPo = await getPool().query('SELECT count(*)::int AS c FROM erp_purchase_order');
    const afterLine = await getPool().query('SELECT count(*)::int AS c FROM erp_purchase_order_line');
    assert.strictEqual(afterPo.rows[0]!['c'], beforePo.rows[0]!['c']);
    assert.strictEqual(afterLine.rows[0]!['c'], beforeLine.rows[0]!['c']);
  });
});
