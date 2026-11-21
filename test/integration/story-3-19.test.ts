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
import { upsertGateEvent } from '../../src/read/projections/gate_event.js';

/**
 * Story 3.19: unloading exception commands (match a gate event to a PO, accept an over-tolerance
 * receipt at the band cap, send an unmatched vehicle to procurement), the receiving_exception
 * projection and list, and the Unloading exceptions navigation capability.
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
  assert.strictEqual(res.status, 201, `provision ${externalId}: ${JSON.stringify(res.body)}`);
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(res.status >= 200 && res.status < 300, JSON.stringify(res.body));
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

describe('Story 3.19 Unloading Exception Commands (server)', () => {
  let server: Server;
  let port: number;
  let siteAId: string;
  let siteBId: string;
  let unloadHeaders: Record<string, string>;
  let unloadUserId: string;
  let unloadBHeaders: Record<string, string>;
  let managerHeaders: Record<string, string>;
  let storeHeaders: Record<string, string>;
  let procurementHeaders: Record<string, string>;
  let storeUserId: string;

  const PO_OPEN = 'PO-319-OPEN';
  const PO_CLOSED = 'PO-319-CLOSED';
  const PO_OVER = 'PO-319-OVER';
  const G_MATCH = randomUUID();
  const G_SEND = randomUUID();
  const G_REVERSED = randomUUID();
  let overLineId: string;
  let overGrnId: string;
  let exhaustedLineId: string;

  async function insertGate(
    id: string,
    opts: { binding?: 'matched' | 'unmatched'; status?: 'open' | 'reversed'; siteId?: string } = {},
  ): Promise<void> {
    const siteId = opts.siteId ?? siteAId;
    await getPool().query(
      `INSERT INTO gate_event
         (gate_event_id, site_id, site_code_ext, po_ref_ext, binding_status, vehicle_reg_ext,
          challan_photo_ref, gate_id, gate_officer_id, correlation_id, entered_at, business_date,
          status, source_event_id)
       VALUES ($1, $2, $3, NULL, $4, 'KA01AB1234', 'photo-gate', 'GATE-01', $5, $6, now(),
               CURRENT_DATE, $7, $8)`,
      [
        id,
        siteId,
        siteId === siteAId ? 'site-A' : 'site-B',
        opts.binding ?? 'unmatched',
        storeUserId,
        randomUUID(),
        opts.status ?? 'open',
        randomUUID(),
      ],
    );
  }

  async function seedToken(poRef: string): Promise<string> {
    const token = randomUUID();
    await getPool().query(
      `INSERT INTO weighbridge_event
        (weighbridge_event_id, correlation_id, gate_event_id, site_id, site_code_ext, po_ref_ext, line_no,
         tare_kg, gross_kg, net_kg, status, device_id, capture_method, weighed_by, business_date, source_event_id)
       VALUES ($1, $2, $3, $4, 'site-A', $5, 1, 1000, 1100, 100, 'accepted', 'WB-1', 'MANUAL', $6, '2026-07-23', $7)`,
      [randomUUID(), token, randomUUID(), siteAId, poRef, unloadUserId, randomUUID()],
    );
    return token;
  }

  async function receive(qty: number, extra: Record<string, unknown> = {}): Promise<HttpResult> {
    const token = await seedToken(PO_OVER);
    return makeRequest(
      port,
      'POST',
      '/api/v1/grn-lines',
      {
        grn_id: randomUUID(),
        grn_line_id: randomUUID(),
        correlation_id: token,
        po_ref_ext: PO_OVER,
        line_no: 1,
        source_document: 'PO',
        sku: 'SKU-3-19',
        target_location_code: 'RECV-DOCK',
        received_qty: qty,
        ...extra,
      },
      storeHeaders,
    );
  }

  const exceptionRow = async (
    kind: string,
    sourceId: string,
  ): Promise<Record<string, unknown> | undefined> =>
    (
      await getPool().query(
        `SELECT * FROM receiving_exception WHERE kind = $1 AND source_id = $2`,
        [kind, sourceId],
      )
    ).rows[0];

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
      '../../read/projections/ownership_agreement.sql',
      '../../read/projections/erp_purchase_order.sql',
      '../../read/projections/erp_sales_order.sql',
      '../../read/projections/integration_exception.sql',
      '../../read/projections/notification.sql',
      '../../read/projections/gate_event.sql',
      '../../read/projections/weighbridge_event.sql',
      '../../read/projections/grn.sql',
      '../../read/projections/grn_line.sql',
      '../../read/projections/grn_line_condition.sql',
      '../../read/projections/grn_line_inspect.sql',
      '../../read/projections/receiving_exception.sql',
      '../../read/projections/putaway_task.sql',
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
        'TRUNCATE receiving_exception, asn_line, asn, putaway_task, grn_line, grn, weighbridge_event, gate_event, integration_exception, erp_sales_order, erp_purchase_order_line, erp_purchase_order, ownership_agreement, inventory_valuation, lot_master, serial_master, lot_trace, stock_balance, item_master, location_register, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    siteAId = randomUUID();
    siteBId = randomUUID();
    await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
       VALUES
         ($1, 'site-A', 'site', NULL, $1, 'general', 'ambient', false, 'active'),
         ($2, 'site-B', 'site', NULL, $2, 'general', 'ambient', false, 'active'),
         ($3, 'ZONE-QC-HOLD', 'zone', $1, $1, 'quarantine', 'ambient', true, 'active'),
         ($4, 'RECV-DOCK', 'zone', $1, $1, 'staging', 'ambient', false, 'active')`,
      [siteAId, siteBId, randomUUID(), randomUUID()],
    );
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ('SKU-3-19', 'EA', false, false, false, false, false, 'weighted_average', 'production', 'active')`,
    );
    for (const [po, status] of [
      [PO_OPEN, 'open'],
      [PO_CLOSED, 'closed'],
      [PO_OVER, 'open'],
    ] as const) {
      await getPool().query(
        `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, expected_delivery_date, status, source_system, last_synced_at)
         VALUES ($1, 'SUP-3-19', 'INR', '2026-12-01', $2, 'ERP', now())`,
        [po, status],
      );
    }
    // Ordered 100, tolerance 10 percent, 90 already received before the platform saw the line:
    // the band cap is 110 - 90 = 20.
    await getPool().query(
      `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, over_receipt_tolerance_pct, under_receipt_tolerance_pct, source_system, last_synced_at, legacy_received_qty)
       VALUES ($1, 1, 'SKU-3-19', 100, 10, 1, 10, 0, 'ERP', now(), 90)`,
      [PO_OVER],
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

    unloadUserId = await provisionUser(port, 'unload-3-19@example.com', [
      {
        role: 'unloading_supervisor',
        module: 'receiving',
        functionScope: 'write',
        locationId: siteAId,
      },
      {
        role: 'unloading_supervisor',
        module: 'inventory',
        functionScope: 'read',
        locationId: siteAId,
      },
    ]);
    unloadHeaders = await authFor(port, 'unload-3-19@example.com');
    await provisionUser(port, 'unload-b-3-19@example.com', [
      {
        role: 'unloading_supervisor',
        module: 'receiving',
        functionScope: 'write',
        locationId: siteBId,
      },
      {
        role: 'unloading_supervisor',
        module: 'inventory',
        functionScope: 'read',
        locationId: siteBId,
      },
    ]);
    unloadBHeaders = await authFor(port, 'unload-b-3-19@example.com');
    await provisionUser(port, 'manager-3-19@example.com', [
      {
        role: 'warehouse_manager',
        module: 'receiving',
        functionScope: 'write',
        locationId: siteAId,
      },
      {
        role: 'warehouse_manager',
        module: 'inventory',
        functionScope: 'read',
        locationId: siteAId,
      },
    ]);
    managerHeaders = await authFor(port, 'manager-3-19@example.com');
    storeUserId = await provisionUser(port, 'store-3-19@example.com', [
      { role: 'store_assistant', module: 'receiving', functionScope: 'write', locationId: siteAId },
    ]);
    storeHeaders = await authFor(port, 'store-3-19@example.com');

    // The procurement_officer notification grant is read from the pilot pack (indent1@).
    const pack = JSON.parse(
      readFileSync(
        resolve(__dirname, '../../docs/migration/pilot-mock-extract/roles.json'),
        'utf-8',
      ),
    ) as { roles: Array<Record<string, string>> };
    const all = pack.roles;
    const indentGrants = all.filter((g) => g['holder'] === 'indent1@ancorlabs.org');
    const notifyGrant = indentGrants.find(
      (g) => g['role'] === 'procurement_officer' && g['module'] === 'notification',
    );
    assert.ok(notifyGrant, 'roles.json must carry the procurement_officer notification grant');
    assert.strictEqual(notifyGrant['function_scope'], 'read');
    await provisionUser(
      port,
      'indent1-3-19@example.com',
      indentGrants
        .filter((g) => g['role'] === 'procurement_officer')
        .map((g) => ({
          role: g['role']!,
          module: g['module']!,
          functionScope: g['function_scope'] as 'read' | 'write',
          locationId: g['location_id'] === 'site' ? siteAId : g['location_id']!,
        })),
    );
    procurementHeaders = await authFor(port, 'indent1-3-19@example.com');

    await insertGate(G_MATCH);
    await insertGate(G_SEND);
    await insertGate(G_REVERSED, { status: 'reversed' });
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('match-po: binds an open unmatched gate event to an open PO', async () => {
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/gate-events/${G_MATCH}/match-po`,
      { po_ref_ext: PO_OPEN, note: '  supplier confirmed  ' },
      unloadHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const row = (
      await getPool().query(`SELECT * FROM gate_event WHERE gate_event_id = $1`, [G_MATCH])
    ).rows[0]!;
    assert.strictEqual(row['binding_status'], 'matched');
    assert.strictEqual(row['po_ref_ext'], PO_OPEN);
    assert.strictEqual(row['resolved_by'], unloadUserId);
    assert.ok(row['resolved_at']);
    assert.strictEqual(row['match_note'], 'supplier confirmed');
    const ex = (await exceptionRow('unmatched_vehicle', G_MATCH))!;
    assert.strictEqual(ex['status'], 'resolved');
    assert.strictEqual(ex['resolution'], 'matched_to_po');
    assert.strictEqual(
      (
        await getPool().query(
          `SELECT count(*)::int AS c FROM domain_events WHERE event_type = 'gate.matched' AND stream_id = $1`,
          [G_MATCH],
        )
      ).rows[0]!['c'],
      1,
    );
  });

  it('match-po: refuses a matched or reversed event, a closed or unknown PO, bad input', async () => {
    const again = await makeRequest(
      port,
      'POST',
      `/api/v1/gate-events/${G_MATCH}/match-po`,
      { po_ref_ext: PO_OPEN },
      unloadHeaders,
    );
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.body['error_code'], 'GATE_EVENT_NOT_UNMATCHED');
    const reversed = await makeRequest(
      port,
      'POST',
      `/api/v1/gate-events/${G_REVERSED}/match-po`,
      { po_ref_ext: PO_OPEN },
      unloadHeaders,
    );
    assert.strictEqual(reversed.status, 409);
    assert.strictEqual(reversed.body['error_code'], 'GATE_EVENT_NOT_UNMATCHED');
    for (const po of [PO_CLOSED, 'PO-DOES-NOT-EXIST']) {
      const res = await makeRequest(
        port,
        'POST',
        `/api/v1/gate-events/${G_SEND}/match-po`,
        { po_ref_ext: po },
        unloadHeaders,
      );
      assert.strictEqual(res.status, 409, po);
      assert.strictEqual(res.body['error_code'], 'PO_NOT_OPEN');
    }
    const noPo = await makeRequest(
      port,
      'POST',
      `/api/v1/gate-events/${G_SEND}/match-po`,
      { note: 'x' },
      unloadHeaders,
    );
    assert.strictEqual(noPo.status, 400);
    const longNote = await makeRequest(
      port,
      'POST',
      `/api/v1/gate-events/${G_SEND}/match-po`,
      { po_ref_ext: PO_OPEN, note: 'n'.repeat(501) },
      unloadHeaders,
    );
    assert.strictEqual(longNote.status, 400);
    assert.strictEqual(longNote.body['error_code'], 'INVALID_PARAMS');
    const badId = await makeRequest(
      port,
      'POST',
      `/api/v1/gate-events/not-a-uuid/match-po`,
      { po_ref_ext: PO_OPEN },
      unloadHeaders,
    );
    assert.strictEqual(badId.status, 400);
    const missing = await makeRequest(
      port,
      'POST',
      `/api/v1/gate-events/${randomUUID()}/match-po`,
      { po_ref_ext: PO_OPEN },
      unloadHeaders,
    );
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.body['error_code'], 'GATE_EVENT_NOT_FOUND');
  });

  it('send-to-procurement: parks the event, leaves the open list, notifies procurement', async () => {
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/gate-events/${G_SEND}/send-to-procurement`,
      { note: 'no PO on file' },
      managerHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const ex = (await exceptionRow('unmatched_vehicle', G_SEND))!;
    assert.strictEqual(ex['status'], 'sent_to_procurement');
    assert.strictEqual(ex['resolution'], 'sent_to_procurement');
    assert.strictEqual(ex['note'], 'no PO on file');
    const gate = (
      await getPool().query(`SELECT * FROM gate_event WHERE gate_event_id = $1`, [G_SEND])
    ).rows[0]!;
    assert.strictEqual(gate['binding_status'], 'unmatched');
    assert.ok(gate['resolved_at']);

    const open = await makeRequest(
      port,
      'GET',
      '/api/v1/gate-events?site=site-A&binding=unmatched&status=open',
      undefined,
      unloadHeaders,
    );
    assert.strictEqual(open.status, 200, JSON.stringify(open.body));
    const ids = (open.body['gate_events'] as Array<Record<string, unknown>>).map(
      (g) => g['gate_event_id'],
    );
    assert.ok(!ids.includes(G_SEND), 'a sent event leaves the open unmatched inbox');

    await runDispatchCycle();
    const notes = await makeRequest(
      port,
      'GET',
      '/api/v1/notifications',
      undefined,
      procurementHeaders,
    );
    assert.strictEqual(notes.status, 200, JSON.stringify(notes.body));
    assert.ok(
      JSON.stringify(notes.body['notifications']).includes(G_SEND),
      'the procurement officer reads the notification',
    );
  });

  it('send-to-procurement: twice is refused; match after send resolves the sent row', async () => {
    const twice = await makeRequest(
      port,
      'POST',
      `/api/v1/gate-events/${G_SEND}/send-to-procurement`,
      {},
      unloadHeaders,
    );
    assert.strictEqual(twice.status, 409);
    assert.strictEqual(twice.body['error_code'], 'GATE_EVENT_ALREADY_RESOLVED');
    const match = await makeRequest(
      port,
      'POST',
      `/api/v1/gate-events/${G_SEND}/match-po`,
      { po_ref_ext: PO_OPEN },
      unloadHeaders,
    );
    assert.strictEqual(match.status, 200, JSON.stringify(match.body));
    const ex = (await exceptionRow('unmatched_vehicle', G_SEND))!;
    assert.strictEqual(ex['status'], 'resolved');
    assert.strictEqual(ex['resolution'], 'matched_to_po');
    const count = await getPool().query(
      `SELECT count(*)::int AS c FROM receiving_exception WHERE kind = 'unmatched_vehicle' AND source_id = $1`,
      [G_SEND],
    );
    assert.strictEqual(count.rows[0]!['c'], 1);
  });

  it('role and site gates: store_assistant and another site are refused', async () => {
    const gate = randomUUID();
    await insertGate(gate);
    for (const path of [
      `/api/v1/gate-events/${gate}/match-po`,
      `/api/v1/gate-events/${gate}/send-to-procurement`,
      `/api/v1/grn-lines/${randomUUID()}/accept-within-band`,
    ]) {
      const res = await makeRequest(port, 'POST', path, { po_ref_ext: PO_OPEN }, storeHeaders);
      assert.strictEqual(res.status, 403, path);
      assert.strictEqual(res.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    }
    const list = await makeRequest(
      port,
      'GET',
      '/api/v1/receiving/exceptions',
      undefined,
      storeHeaders,
    );
    assert.strictEqual(list.status, 403);
    for (const path of [
      `/api/v1/gate-events/${gate}/match-po`,
      `/api/v1/gate-events/${gate}/send-to-procurement`,
    ]) {
      const res = await makeRequest(port, 'POST', path, { po_ref_ext: PO_OPEN }, unloadBHeaders);
      assert.strictEqual(res.status, 403, path);
      assert.strictEqual(res.body['error_code'], 'LOCATION_ACCESS_DENIED');
    }
    // The generic event door never accepts the route-only resolution facts, even from a resolver.
    for (const [streamType, eventType] of [
      ['gate', 'gate.matched'],
      ['gate', 'gate.sent_to_procurement'],
      ['receiving', 'goods.over_tolerance_accepted'],
    ]) {
      const res = await makeRequest(
        port,
        'POST',
        '/api/v1/events',
        {
          stream_type: streamType,
          stream_id: gate,
          event_type: eventType,
          // Well-formed for every shape, so the refusal is the door guard, not validation.
          payload: {
            gate_event_id: gate,
            po_ref_ext: PO_OPEN,
            matched_by: randomUUID(),
            sent_by: randomUUID(),
            grn_line_id: randomUUID(),
            accepted_grn_line_id: randomUUID(),
            resolved_by: randomUUID(),
            accepted_qty: '1',
            excess_qty: '0',
            counted_qty: '1',
            ordered_qty: '1',
            already_received_qty: '0',
            tolerance_pct: '0',
            cap_qty: '1',
          },
          metadata: {
            correlation_id: randomUUID(),
            actor: { user_id: randomUUID(), role: 'unloading_supervisor', location_id: siteAId },
            occurred_at: new Date().toISOString(),
          },
        },
        unloadHeaders,
      );
      // The gate rows may stop earlier at the module check; the receiving row reaches the guard.
      assert.strictEqual(res.status, 403, eventType);
      if (streamType === 'receiving')
        assert.strictEqual(res.body['error_code'], 'FUNCTION_ACCESS_DENIED', eventType);
    }
  });

  it('accept-within-band: posts the cap, resolves the rejected line, records the excess', async () => {
    const over = await receive(30);
    assert.strictEqual(over.status, 200, JSON.stringify(over.body));
    assert.strictEqual(over.body['error_code'], 'RECEIPT_TOLERANCE_EXCEEDED');
    const rejected = over.body['grn_line'] as Record<string, unknown>;
    overLineId = rejected['grn_line_id'] as string;
    overGrnId = rejected['grn_id'] as string;

    const open = await makeRequest(
      port,
      'GET',
      '/api/v1/receiving/exceptions?site=site-A&status=open',
      undefined,
      unloadHeaders,
    );
    assert.strictEqual(open.status, 200, JSON.stringify(open.body));
    const row = (open.body['exceptions'] as Array<Record<string, unknown>>).find(
      (e) => e['source_id'] === overLineId,
    )!;
    assert.ok(row, 'the open over-tolerance row is listed');
    assert.strictEqual(row['kind'], 'over_tolerance');
    assert.strictEqual(Number(row['ordered_qty']), 100);
    assert.strictEqual(Number(row['already_received_qty']), 90);
    assert.strictEqual(Number(row['tolerance_pct']), 10);
    assert.strictEqual(Number(row['cap_qty']), 20);
    assert.strictEqual(Number(row['counted_qty']), 30);
    assert.strictEqual(Number(row['excess_qty']), 10);

    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/grn-lines/${overLineId}/accept-within-band`,
      { note: 'returned 10 with the vehicle' },
      unloadHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const accepted = res.body['grn_line'] as Record<string, unknown>;
    assert.strictEqual(accepted['grn_id'], overGrnId);
    assert.notStrictEqual(accepted['grn_line_id'], overLineId);
    assert.strictEqual(Number(accepted['received_qty']), 20);
    assert.strictEqual(accepted['status'], 'posted');
    assert.ok(res.body['putaway_task'], 'a putaway task exists for the accepted line');
    assert.strictEqual(
      (
        await getPool().query(
          `SELECT count(*)::int AS c FROM putaway_task WHERE grn_line_id = $1`,
          [accepted['grn_line_id']],
        )
      ).rows[0]!['c'],
      1,
    );
    const line = (
      await getPool().query(`SELECT * FROM grn_line WHERE grn_line_id = $1`, [overLineId])
    ).rows[0]!;
    assert.strictEqual(line['status'], 'rejected');
    assert.strictEqual(line['resolution'], 'accepted_within_band');
    assert.strictEqual(line['resolved_by'], unloadUserId);
    assert.ok(line['resolved_at']);
    const ex = (await exceptionRow('over_tolerance', overLineId))!;
    assert.strictEqual(ex['status'], 'resolved');
    assert.strictEqual(ex['resolution'], 'accepted_within_band');
    assert.strictEqual(ex['reason_code'], 'EXCESS_RETURNED_WITH_VEHICLE');
    assert.strictEqual(Number(ex['excess_qty']), 10);
    assert.strictEqual(Number(ex['cap_qty']), 20);
    assert.strictEqual(ex['accepted_grn_line_id'], accepted['grn_line_id']);
    const stock = await getPool().query(
      `SELECT COALESCE(SUM(on_hand), 0)::float AS q FROM stock_balance WHERE sku = 'SKU-3-19'`,
    );
    assert.strictEqual(stock.rows[0]!['q'], 20, 'no quantity above the cap is posted');

    const resolved = await makeRequest(
      port,
      'GET',
      '/api/v1/receiving/exceptions?status=resolved',
      undefined,
      managerHeaders,
    );
    const stored = (resolved.body['exceptions'] as Array<Record<string, unknown>>).find(
      (e) => e['source_id'] === overLineId,
    )!;
    assert.strictEqual(Number(stored['excess_qty']), 10);
    assert.strictEqual(stored['reason_code'], 'EXCESS_RETURNED_WITH_VEHICLE');
  });

  it('accept-within-band: twice, a posted line, and an exhausted band are refused', async () => {
    const twice = await makeRequest(
      port,
      'POST',
      `/api/v1/grn-lines/${overLineId}/accept-within-band`,
      {},
      unloadHeaders,
    );
    assert.strictEqual(twice.status, 409);
    assert.strictEqual(twice.body['error_code'], 'GRN_LINE_ALREADY_RESOLVED');

    const postedLine = (
      await getPool().query(
        `SELECT grn_line_id FROM grn_line WHERE grn_id = $1 AND status = 'posted'`,
        [overGrnId],
      )
    ).rows[0]!['grn_line_id'] as string;
    const notRejected = await makeRequest(
      port,
      'POST',
      `/api/v1/grn-lines/${postedLine}/accept-within-band`,
      {},
      unloadHeaders,
    );
    assert.strictEqual(notRejected.status, 409);
    assert.strictEqual(notRejected.body['error_code'], 'GRN_LINE_NOT_REJECTED');

    const missing = await makeRequest(
      port,
      'POST',
      `/api/v1/grn-lines/${randomUUID()}/accept-within-band`,
      {},
      unloadHeaders,
    );
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.body['error_code'], 'GRN_LINE_NOT_FOUND');

    // The band is now full (110 of 110): a further receipt is rejected, and cannot be accepted.
    const more = await receive(5);
    assert.strictEqual(more.status, 200, JSON.stringify(more.body));
    exhaustedLineId = (more.body['grn_line'] as Record<string, unknown>)['grn_line_id'] as string;

    const otherSite = await makeRequest(
      port,
      'POST',
      `/api/v1/grn-lines/${exhaustedLineId}/accept-within-band`,
      {},
      unloadBHeaders,
    );
    assert.strictEqual(otherSite.status, 403);
    assert.strictEqual(otherSite.body['error_code'], 'LOCATION_ACCESS_DENIED');

    const before = await getPool().query(
      `SELECT count(*)::int AS c FROM grn_line WHERE grn_id = (SELECT grn_id FROM grn_line WHERE grn_line_id = $1)`,
      [exhaustedLineId],
    );
    const exhausted = await makeRequest(
      port,
      'POST',
      `/api/v1/grn-lines/${exhaustedLineId}/accept-within-band`,
      {},
      unloadHeaders,
    );
    assert.strictEqual(exhausted.status, 409);
    assert.strictEqual(exhausted.body['error_code'], 'RECEIPT_BAND_EXHAUSTED');
    const after = await getPool().query(
      `SELECT count(*)::int AS c FROM grn_line WHERE grn_id = (SELECT grn_id FROM grn_line WHERE grn_line_id = $1)`,
      [exhaustedLineId],
    );
    assert.strictEqual(after.rows[0]!['c'], before.rows[0]!['c'], 'nothing posted');
    const ex = (await exceptionRow('over_tolerance', exhaustedLineId))!;
    assert.strictEqual(ex['status'], 'open');
  });

  it('list: rejects a bad status filter', async () => {
    const res = await makeRequest(
      port,
      'GET',
      '/api/v1/receiving/exceptions?status=bogus',
      undefined,
      unloadHeaders,
    );
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
    const other = await makeRequest(
      port,
      'GET',
      '/api/v1/receiving/exceptions?site=site-B',
      undefined,
      unloadHeaders,
    );
    assert.strictEqual(other.status, 403);
  });

  it('createGrnLine still refuses the resolution-only reason code', async () => {
    const res = await receive(5, {
      reason_code: 'EXCESS_RETURNED_WITH_VEHICLE',
      reason_detail: 'x',
    });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'RECEIVING_REASON_INVALID');
  });

  it('upsertGateEvent replay never undoes a match', async () => {
    const client = await getPool().connect();
    try {
      await upsertGateEvent(
        {
          gate_event_id: G_MATCH,
          site_id: siteAId,
          site_code_ext: 'site-A',
          po_ref_ext: null,
          binding_status: 'unmatched',
          vehicle_reg_ext: 'KA01AB1234',
          challan_photo_ref: 'photo-gate',
          gate_id: 'GATE-01',
          gate_officer_id: storeUserId,
          correlation_id: randomUUID(),
          entered_at: new Date().toISOString(),
          business_date: '2026-11-22',
          source_event_id: randomUUID(),
        },
        client,
      );
    } finally {
      client.release();
    }
    const row = (
      await getPool().query(
        `SELECT binding_status, po_ref_ext FROM gate_event WHERE gate_event_id = $1`,
        [G_MATCH],
      )
    ).rows[0]!;
    assert.strictEqual(row['binding_status'], 'matched');
    assert.strictEqual(row['po_ref_ext'], PO_OPEN);
  });

  it('navigation: resolvers see Unloading exceptions, store_assistant does not', async () => {
    const nav = async (headers: Record<string, string>): Promise<string[]> => {
      const res = await makeRequest(port, 'GET', '/api/v1/edge/bootstrap', undefined, headers);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      return res.body['navigation'] as string[];
    };
    assert.ok((await nav(unloadHeaders)).includes('Unloading exceptions'));
    assert.ok((await nav(managerHeaders)).includes('Unloading exceptions'));
    assert.ok(!(await nav(storeHeaders)).includes('Unloading exceptions'));
  });
});
