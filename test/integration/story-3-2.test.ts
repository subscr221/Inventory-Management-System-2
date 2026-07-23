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

function gateBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gate_event_id: randomUUID(),
    site_code_ext: 'site-A',
    po_ref_ext: 'PO-2026-0441',
    vehicle_reg_ext: 'KA01AB1234',
    challan_number_ext: 'CH-1',
    challan_photo_ref: `challan-${randomUUID()}.jpg`,
    driver_name: 'Raman',
    gate_id: 'GATE-1',
    entered_at: '2026-07-22T04:45:00.000Z',
    ...overrides,
  };
}

describe('Story 3.2 Gate Event Capture and Vehicle-to-PO Binding', () => {
  let server: Server;
  let port: number;
  let gateHeaders: Record<string, string>;
  let supervisorHeaders: Record<string, string>;
  let managerHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let siteBHeaders: Record<string, string>;
  let siteAId: string;
  let siteBId: string;
  let gateOfficerId: string;

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
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE gate_event, integration_exception, erp_sync_state, erp_sales_order, erp_purchase_order_line, erp_purchase_order, ownership_agreement, obsolescence_flag, replenishment_recommendation, inventory_planning_params, physical_verification_line, physical_verification, cycle_count_line, cycle_count, in_transit, transfer_request, inventory_valuation, lot_master, serial_master, lot_trace, stock_balance, item_master, location_register, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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
       VALUES ('SKU-GATE-1', 'EA', false, false, false, false, false, 'weighted_average', 'production', 'active')`,
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, expected_delivery_date, status, source_system, last_synced_at)
       VALUES ('PO-2026-0441', 'SUP-1', 'INR', '2026-08-01', 'open', 'ERP', now()), ('PO-CLOSED', 'SUP-1', 'INR', '2026-08-01', 'closed', 'ERP', now())`,
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, source_system, last_synced_at)
       VALUES ('PO-2026-0441', 1, 'SKU-GATE-1', 10, 10, 1, 'ERP', now()), ('PO-CLOSED', 1, 'SKU-GATE-1', 10, 0, 1, 'ERP', now())`,
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

    gateOfficerId = await provisionUser(port, 'gate-officer-3-2@example.com', [
      { role: 'gate_officer', module: 'inventory', functionScope: 'write', locationId: siteAId },
      { role: 'gate_officer', module: 'gate', functionScope: 'write', locationId: siteAId },
    ]);
    gateHeaders = await authFor(port, 'gate-officer-3-2@example.com');

    await provisionUser(port, 'unloading-supervisor-3-2@example.com', [
      { role: 'unloading_supervisor', module: 'inventory', functionScope: 'read', locationId: siteAId },
    ]);
    supervisorHeaders = await authFor(port, 'unloading-supervisor-3-2@example.com');

    await provisionUser(port, 'warehouse-manager-3-2@example.com', [
      { role: 'warehouse_manager', module: 'inventory', functionScope: 'read', locationId: '*' },
    ]);
    managerHeaders = await authFor(port, 'warehouse-manager-3-2@example.com');

    await provisionUser(port, 'stock-reader-3-2@example.com', [
      { role: 'stock_viewer', module: 'inventory', functionScope: 'read', locationId: siteAId },
    ]);
    readerHeaders = await authFor(port, 'stock-reader-3-2@example.com');

    await provisionUser(port, 'gate-officer-site-b-3-2@example.com', [
      { role: 'gate_officer', module: 'inventory', functionScope: 'write', locationId: siteBId },
      { role: 'gate_officer', module: 'gate', functionScope: 'write', locationId: siteBId },
    ]);
    siteBHeaders = await authFor(port, 'gate-officer-site-b-3-2@example.com');
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('AC1/AC2: matched online capture creates a binding token from correlation_id and exposes it downstream', async () => {
    const res = await makeRequest(port, 'POST', '/api/v1/gate-events', gateBody(), gateHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const gateEventId = res.body['gate_event_id'] as string;
    assert.strictEqual(res.body['binding_status'], 'matched');
    assert.strictEqual(res.body['po_ref_ext'], 'PO-2026-0441');
    assert.strictEqual(res.body['gate_officer_id'], gateOfficerId);
    assert.ok(typeof res.body['correlation_id'] === 'string' && res.body['correlation_id'] !== gateEventId);
    assert.strictEqual(res.body['business_date'], '2026-07-22');

    const read = await makeRequest(port, 'GET', `/api/v1/gate-events/${gateEventId}`, undefined, supervisorHeaders);
    assert.strictEqual(read.status, 200, JSON.stringify(read.body));
    assert.strictEqual(read.body['binding_status'], 'matched');
    assert.deepStrictEqual(read.body['po_summary'], { po_number_ext: 'PO-2026-0441', supplier_ref_ext: 'SUP-1', status: 'open' });
    assert.strictEqual(read.body['correlation_id'], res.body['correlation_id']);
  });

  it('AC3: unknown and closed PO references are captured as unmatched and visible to exception owners', async () => {
    const unknown = await makeRequest(port, 'POST', '/api/v1/gate-events', gateBody({ po_ref_ext: 'UNKNOWN' }), gateHeaders);
    assert.strictEqual(unknown.status, 201, JSON.stringify(unknown.body));
    assert.strictEqual(unknown.body['binding_status'], 'unmatched');
    const unknownId = unknown.body['gate_event_id'] as string;

    const closed = await makeRequest(port, 'POST', '/api/v1/gate-events', gateBody({ po_ref_ext: 'PO-CLOSED' }), gateHeaders);
    assert.strictEqual(closed.status, 201, JSON.stringify(closed.body));
    assert.strictEqual(closed.body['binding_status'], 'unmatched');

    const list = await makeRequest(port, 'GET', '/api/v1/gate-events?binding=unmatched', undefined, supervisorHeaders);
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    const events = list.body['gate_events'] as Record<string, unknown>[];
    assert.ok(events.some((row) => row['gate_event_id'] === unknownId));

    const denied = await makeRequest(port, 'GET', '/api/v1/gate-events?binding=unmatched', undefined, readerHeaders);
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
    assert.strictEqual(denied.body['error_code'], 'FUNCTION_ACCESS_DENIED');
  });

  it('AC4: challan photo is mandatory and missing photos are rejected before any event is persisted', async () => {
    const res = await makeRequest(port, 'POST', '/api/v1/gate-events', gateBody({ challan_photo_ref: '  ' }), gateHeaders);
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'GATE_CHALLAN_PHOTO_REQUIRED');

    const persisted = await getPool().query('SELECT count(*)::int AS c FROM domain_events WHERE stream_id = $1', [res.body['gate_event_id'] as string]);
    assert.strictEqual(persisted.rows[0]!['c'], 0);
  });

  it('Task 4: reversal soft-closes the row and preserves the original gate event', async () => {
    const created = await makeRequest(port, 'POST', '/api/v1/gate-events', gateBody(), gateHeaders);
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const gateEventId = created.body['gate_event_id'] as string;

    const reversed = await makeRequest(port, 'POST', `/api/v1/gate-events/${gateEventId}/reverse`, { reversal_reason: 'wrong vehicle' }, gateHeaders);
    assert.strictEqual(reversed.status, 200, JSON.stringify(reversed.body));
    assert.strictEqual(reversed.body['status'], 'reversed');
    assert.strictEqual(reversed.body['reversal_reason'], 'wrong vehicle');

    const rows = await getPool().query('SELECT count(*)::int AS c FROM gate_event WHERE gate_event_id = $1', [gateEventId]);
    assert.strictEqual(rows.rows[0]!['c'], 1);

    const repeat = await makeRequest(port, 'POST', `/api/v1/gate-events/${gateEventId}/reverse`, { reversal_reason: 'again' }, gateHeaders);
    assert.strictEqual(repeat.status, 409, JSON.stringify(repeat.body));
    assert.strictEqual(repeat.body['error_code'], 'GATE_ALREADY_REVERSED');
  });

  it('Task 5: RBAC and site scoping reject non-gate roles and out-of-scope sites', async () => {
    const nonGate = await makeRequest(port, 'POST', '/api/v1/gate-events', gateBody(), readerHeaders);
    assert.strictEqual(nonGate.status, 403, JSON.stringify(nonGate.body));
    assert.strictEqual(nonGate.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    const outOfScope = await makeRequest(port, 'POST', '/api/v1/gate-events', gateBody({ site_code_ext: 'site-A' }), siteBHeaders);
    assert.strictEqual(outOfScope.status, 403, JSON.stringify(outOfScope.body));
    assert.strictEqual(outOfScope.body['error_code'], 'LOCATION_ACCESS_DENIED');

    const list = await makeRequest(port, 'GET', '/api/v1/gate-events?site=site-A', undefined, managerHeaders);
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    assert.ok(Array.isArray(list.body['gate_events']));
  });

  it('Task 7: direct and edge gate uploads are accepted, idempotent, and never mutate ERP projections', async () => {
    const gateEventId = randomUUID();
    const correlationId = randomUUID();
    const before = await getPool().query('SELECT count(*)::int AS c FROM erp_purchase_order');
    const envelope = {
      event_id: randomUUID(),
      stream_type: 'gate',
      stream_id: gateEventId,
      event_type: 'gate.entered',
      payload: gateBody({ gate_event_id: gateEventId }),
      metadata: { correlation_id: correlationId, actor: { user_id: randomUUID(), role: 'gate_officer', location_id: siteAId }, device_id: 'EDGE-GATE-1', occurred_at: new Date().toISOString() },
      idempotency_key: `gate-edge-${gateEventId}`,
    };

    const edge = await makeRequest(port, 'POST', '/api/v1/edge/events', envelope, gateHeaders);
    assert.strictEqual(edge.status, 201, JSON.stringify(edge.body));
    const duplicate = await makeRequest(port, 'POST', '/api/v1/edge/events', envelope, gateHeaders);
    assert.strictEqual(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.strictEqual(duplicate.body['error_code'], 'DUPLICATE_EVENT');

    const row = await getPool().query('SELECT binding_status, correlation_id FROM gate_event WHERE gate_event_id = $1', [gateEventId]);
    assert.strictEqual(row.rows[0]!['binding_status'], 'matched');
    assert.strictEqual(row.rows[0]!['correlation_id'], correlationId);
    const after = await getPool().query('SELECT count(*)::int AS c FROM erp_purchase_order');
    assert.strictEqual(after.rows[0]!['c'], before.rows[0]!['c']);
  });

  it('Task 4: reverse negative paths - not found, missing reason, RBAC, site scope', async () => {
    const missing = await makeRequest(port, 'POST', '/api/v1/gate-events/00000000-0000-0000-0000-000000000000/reverse', { reversal_reason: 'x' }, gateHeaders);
    assert.strictEqual(missing.status, 404, JSON.stringify(missing.body));
    assert.strictEqual(missing.body['error_code'], 'GATE_EVENT_NOT_FOUND');

    const created = await makeRequest(port, 'POST', '/api/v1/gate-events', gateBody(), gateHeaders);
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const gateEventId = created.body['gate_event_id'] as string;

    const noReason = await makeRequest(port, 'POST', `/api/v1/gate-events/${gateEventId}/reverse`, {}, gateHeaders);
    assert.strictEqual(noReason.status, 400, JSON.stringify(noReason.body));
    assert.strictEqual(noReason.body['error_code'], 'GATE_REVERSAL_REASON_REQUIRED');

    const nonGate = await makeRequest(port, 'POST', `/api/v1/gate-events/${gateEventId}/reverse`, { reversal_reason: 'x' }, readerHeaders);
    assert.strictEqual(nonGate.status, 403, JSON.stringify(nonGate.body));
    assert.strictEqual(nonGate.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    const outOfScope = await makeRequest(port, 'POST', `/api/v1/gate-events/${gateEventId}/reverse`, { reversal_reason: 'x' }, siteBHeaders);
    assert.strictEqual(outOfScope.status, 403, JSON.stringify(outOfScope.body));
    assert.strictEqual(outOfScope.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });

  it('Task 5: list filters reject invalid binding and status values', async () => {
    const badBinding = await makeRequest(port, 'GET', '/api/v1/gate-events?binding=invalid', undefined, gateHeaders);
    assert.strictEqual(badBinding.status, 400, JSON.stringify(badBinding.body));
    assert.strictEqual(badBinding.body['error_code'], 'INVALID_PARAMS');

    const badStatus = await makeRequest(port, 'GET', '/api/v1/gate-events?status=invalid', undefined, gateHeaders);
    assert.strictEqual(badStatus.status, 400, JSON.stringify(badStatus.body));
    assert.strictEqual(badStatus.body['error_code'], 'INVALID_PARAMS');
  });

  it('Review D1: online create with Idempotency-Key replays the original gate event instead of duplicating', async () => {
    const key = `gate-online-${randomUUID()}`;
    const body = gateBody();
    const first = await makeRequest(port, 'POST', '/api/v1/gate-events', body, { ...gateHeaders, 'Idempotency-Key': key });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const gateEventId = first.body['gate_event_id'] as string;

    const retry = await makeRequest(port, 'POST', '/api/v1/gate-events', body, { ...gateHeaders, 'Idempotency-Key': key });
    assert.strictEqual(retry.status, 200, JSON.stringify(retry.body));
    assert.strictEqual(retry.body['gate_event_id'], gateEventId);
    assert.strictEqual(retry.body['correlation_id'], first.body['correlation_id']);

    const rows = await getPool().query(`SELECT count(*)::int AS c FROM domain_events WHERE idempotency_key = $1`, [key]);
    assert.strictEqual(rows.rows[0]!['c'], 1);
  });

  it('Review re-review: Idempotency-Key reused across sites is rejected, not replayed cross-site', async () => {
    const key = `gate-cross-site-${randomUUID()}`;
    const first = await makeRequest(port, 'POST', '/api/v1/gate-events', gateBody(), { ...gateHeaders, 'Idempotency-Key': key });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const conflict = await makeRequest(port, 'POST', '/api/v1/gate-events', gateBody({ site_code_ext: 'site-B' }), { ...siteBHeaders, 'Idempotency-Key': key });
    assert.strictEqual(conflict.status, 409, JSON.stringify(conflict.body));
    assert.strictEqual(conflict.body['error_code'], 'IDEMPOTENCY_KEY_CONFLICT');
    assert.strictEqual(conflict.body['vehicle_reg_ext'], undefined, 'conflict response must not leak the other site event data');
  });

  it('Review re-review: Idempotency-Key reused with a different vehicle is rejected, not silently replayed', async () => {
    const key = `gate-body-mismatch-${randomUUID()}`;
    const first = await makeRequest(port, 'POST', '/api/v1/gate-events', gateBody({ vehicle_reg_ext: 'KA01AB1234' }), { ...gateHeaders, 'Idempotency-Key': key });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const conflict = await makeRequest(port, 'POST', '/api/v1/gate-events', gateBody({ vehicle_reg_ext: 'KA01AB9999' }), { ...gateHeaders, 'Idempotency-Key': key });
    assert.strictEqual(conflict.status, 409, JSON.stringify(conflict.body));
    assert.strictEqual(conflict.body['error_code'], 'IDEMPOTENCY_KEY_CONFLICT');
  });

  it('Review D2: binding_token is exposed as a deprecated alias of correlation_id', async () => {
    const res = await makeRequest(port, 'POST', '/api/v1/gate-events', gateBody(), gateHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['binding_token'], res.body['correlation_id']);

    const read = await makeRequest(port, 'GET', `/api/v1/gate-events/${res.body['gate_event_id'] as string}`, undefined, supervisorHeaders);
    assert.strictEqual(read.status, 200, JSON.stringify(read.body));
    assert.strictEqual(read.body['binding_token'], read.body['correlation_id']);
  });

  it('Review D3: unmatched worklist defaults oldest-first and supports offset pagination', async () => {
    const older = await makeRequest(port, 'POST', '/api/v1/gate-events', gateBody({ po_ref_ext: 'UNKNOWN', entered_at: '2026-07-20T01:00:00.000Z' }), gateHeaders);
    assert.strictEqual(older.status, 201, JSON.stringify(older.body));
    const newer = await makeRequest(port, 'POST', '/api/v1/gate-events', gateBody({ po_ref_ext: 'UNKNOWN', entered_at: '2026-07-23T01:00:00.000Z' }), gateHeaders);
    assert.strictEqual(newer.status, 201, JSON.stringify(newer.body));

    const list = await makeRequest(port, 'GET', '/api/v1/gate-events?binding=unmatched', undefined, supervisorHeaders);
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    const events = list.body['gate_events'] as Record<string, unknown>[];
    const olderIdx = events.findIndex((row) => row['gate_event_id'] === older.body['gate_event_id']);
    const newerIdx = events.findIndex((row) => row['gate_event_id'] === newer.body['gate_event_id']);
    assert.ok(olderIdx !== -1 && newerIdx !== -1, 'both unmatched events must appear in the worklist');
    assert.ok(olderIdx < newerIdx, `oldest-first worklist: older at ${olderIdx}, newer at ${newerIdx}`);

    const paged = await makeRequest(port, 'GET', '/api/v1/gate-events?binding=unmatched&offset=1', undefined, supervisorHeaders);
    assert.strictEqual(paged.status, 200, JSON.stringify(paged.body));
    const pagedEvents = paged.body['gate_events'] as Record<string, unknown>[];
    assert.strictEqual(pagedEvents.length, events.length - 1);
    assert.strictEqual(pagedEvents[0]!['gate_event_id'], events[1]!['gate_event_id']);

    const explicitDesc = await makeRequest(port, 'GET', '/api/v1/gate-events?binding=unmatched&order=desc', undefined, supervisorHeaders);
    assert.strictEqual(explicitDesc.status, 200, JSON.stringify(explicitDesc.body));
    const descEvents = explicitDesc.body['gate_events'] as Record<string, unknown>[];
    assert.strictEqual(descEvents[descEvents.length - 1]!['gate_event_id'], events[0]!['gate_event_id']);

    const badOffset = await makeRequest(port, 'GET', '/api/v1/gate-events?offset=-1', undefined, supervisorHeaders);
    assert.strictEqual(badOffset.status, 400, JSON.stringify(badOffset.body));
    assert.strictEqual(badOffset.body['error_code'], 'INVALID_PARAMS');

    const badOrder = await makeRequest(port, 'GET', '/api/v1/gate-events?order=sideways', undefined, supervisorHeaders);
    assert.strictEqual(badOrder.status, 400, JSON.stringify(badOrder.body));
    assert.strictEqual(badOrder.body['error_code'], 'INVALID_PARAMS');
  });
});
