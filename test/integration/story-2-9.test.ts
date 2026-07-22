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

// Story 2.9: ERP Inbound Reference Projections (INT-ERP-01). Runs against the PRODUCTION router
// surface with real auth, RBAC, and PostgreSQL; serial (--test-concurrency=1). These projections are
// reference data ONLY - NOT event-sourced - populated by the ERP sync adapter via direct upsert and
// read-only to the platform.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const BUSINESS_DATE = '2026-07-22';

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

describe('Story 2.9 ERP Inbound Reference Projections', () => {
  let server: Server;
  let port: number;
  let adminHeaders: Record<string, string>;
  let svcErpHeaders: Record<string, string>;
  let siteAReaderHeaders: Record<string, string>;
  let siteBReaderHeaders: Record<string, string>;
  let normalWriterHeaders: Record<string, string>;
  let plannerHeaders: Record<string, string>;
  let superHeaders: Record<string, string>;
  let locAId: string;

  async function resetErp(): Promise<void> {
    await getAdminPool().query(
      'TRUNCATE integration_exception, erp_sync_state, erp_sales_order, erp_purchase_order_line, erp_purchase_order',
    );
  }

  function poBatch(): unknown {
    return {
      purchase_orders: [
        {
          po_number_ext: 'PO-2026-0042',
          supplier_ref_ext: 'SUPPLIER-X',
          currency: 'INR',
          expected_delivery_date: '2026-08-15',
          lines: [
            { line_no: 1, sku: 'SKU-ERP-1', ordered_qty: 100.5, open_qty: 40.25, unit_price: 12.3456, over_receipt_tolerance_pct: 150.5, under_receipt_tolerance_pct: 5.25 },
            { line_no: 2, sku: 'SKU-ERP-2', ordered_qty: 10, open_qty: 10, unit_price: 999.9999 },
          ],
        },
      ],
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
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE integration_exception, erp_sync_state, erp_sales_order, erp_purchase_order_line, erp_purchase_order, ownership_agreement, obsolescence_flag, replenishment_recommendation, inventory_planning_params, physical_verification_line, physical_verification, cycle_count_line, cycle_count, in_transit, transfer_request, inventory_valuation, lot_master, serial_master, lot_trace, stock_balance, item_master, location_register, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    // Two active sites; a site row references itself as site_id.
    const idA = randomUUID();
    const idB = randomUUID();
    await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, site_id, zone_type, temperature_class, status)
       VALUES ($1, 'site-A', 'site', $1, 'general', 'ambient', 'active'), ($2, 'site-B', 'site', $2, 'general', 'ambient', 'active')`,
      [idA, idB],
    );
    locAId = idA;

    for (const sku of ['SKU-ERP-1', 'SKU-ERP-2']) {
      await getPool().query(
        `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
         VALUES ($1, 'EA', false, false, false, false, false, 'weighted_average', 'production', 'active')`,
        [sku],
      );
    }

    await provisionUser(port, 'erp-admin-2-9@example.com', [
      { role: 'system_administrator', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    adminHeaders = await authFor(port, 'erp-admin-2-9@example.com');

    await provisionUser(port, 'erp-svc-2-9@example.com', [
      { role: 'svc_erp_adapter', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    svcErpHeaders = await authFor(port, 'erp-svc-2-9@example.com');

    await provisionUser(port, 'erp-reader-a-2-9@example.com', [
      { role: 'stock_controller', module: 'inventory', functionScope: 'read', locationId: idA },
    ]);
    siteAReaderHeaders = await authFor(port, 'erp-reader-a-2-9@example.com');

    await provisionUser(port, 'erp-reader-b-2-9@example.com', [
      { role: 'stock_controller', module: 'inventory', functionScope: 'read', locationId: idB },
    ]);
    siteBReaderHeaders = await authFor(port, 'erp-reader-b-2-9@example.com');

    await provisionUser(port, 'erp-writer-2-9@example.com', [
      { role: 'warehouse_operator', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    normalWriterHeaders = await authFor(port, 'erp-writer-2-9@example.com');

    await provisionUser(port, 'erp-planner-2-9@example.com', [
      { role: 'inventory_planner', module: 'inventory', functionScope: 'write', locationId: idA },
    ]);
    plannerHeaders = await authFor(port, 'erp-planner-2-9@example.com');

    // A wildcard-module super-writer: exactly the actor who could otherwise fabricate an event on any
    // stream. The central persistEvent guard must stop even this caller from forging `erp` rows.
    await provisionUser(port, 'erp-super-2-9@example.com', [
      { role: 'system_administrator', module: '*', functionScope: 'write', locationId: '*' },
    ]);
    superHeaders = await authFor(port, 'erp-super-2-9@example.com');
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('AC1: syncs a two-line PO and serves a read-only projection with all fields and numeric precision', async () => {
    await resetErp();
    const sync = await makeRequest(port, 'POST', '/api/v1/erp/sync', poBatch(), adminHeaders);
    assert.strictEqual(sync.status, 200, JSON.stringify(sync.body));
    assert.deepStrictEqual(sync.body['purchase_orders'], { applied: 1, failed: 0 });

    const res = await makeRequest(port, 'GET', '/api/v1/erp/purchase-orders/PO-2026-0042', undefined, siteAReaderHeaders);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['supplier_ref_ext'], 'SUPPLIER-X');
    assert.strictEqual(res.body['currency'], 'INR');
    assert.strictEqual(res.body['expected_delivery_date'], '2026-08-15');
    assert.strictEqual(res.body['source_system'], 'ERP');
    assert.ok(typeof res.body['last_synced_at'] === 'string' && (res.body['last_synced_at'] as string).length > 0);
    const lines = res.body['lines'] as Array<Record<string, unknown>>;
    assert.strictEqual(lines.length, 2);
    const l1 = lines.find((l) => l['line_no'] === 1)!;
    assert.strictEqual(l1['sku'], 'SKU-ERP-1');
    assert.strictEqual(l1['ordered_qty'], 100.5);
    assert.strictEqual(l1['open_qty'], 40.25);
    assert.strictEqual(l1['unit_price'], 12.3456, 'unit_price NUMERIC(18,4) must survive without float drift');
    assert.strictEqual(l1['over_receipt_tolerance_pct'], 150.5, 'over-receipt tolerance may exceed 100%');
    assert.strictEqual(l1['under_receipt_tolerance_pct'], 5.25);
    assert.strictEqual(l1['source_system'], 'ERP');
    const l2 = lines.find((l) => l['line_no'] === 2)!;
    assert.strictEqual(l2['unit_price'], 999.9999);
    assert.strictEqual(l2['over_receipt_tolerance_pct'], null);
  });

  it('AC2: lists site-scoped dispatch-demand lines; denies a caller assigned elsewhere; empty is []', async () => {
    await resetErp();
    const batch = {
      sales_orders: [
        { so_number_ext: 'SO-1', line_no: 1, sku: 'SKU-ERP-1', quantity: 5, required_by: '2026-08-01', ship_to_ext: 'CUST-1', ship_from_site_code_ext: 'site-A' },
        { so_number_ext: 'SO-1', line_no: 2, sku: 'SKU-ERP-2', quantity: 3, required_by: '2026-08-02', ship_to_ext: 'CUST-1', ship_from_site_code_ext: 'site-A' },
        { so_number_ext: 'SO-2', line_no: 1, sku: 'SKU-ERP-1', quantity: 7, required_by: '2026-08-03', ship_to_ext: 'CUST-2', ship_from_site_code_ext: 'site-B' },
      ],
    };
    const sync = await makeRequest(port, 'POST', '/api/v1/erp/sync', batch, adminHeaders);
    assert.strictEqual(sync.status, 200, JSON.stringify(sync.body));
    assert.deepStrictEqual(sync.body['sales_orders'], { applied: 3, failed: 0 });

    const listA = await makeRequest(port, 'GET', '/api/v1/erp/sales-orders?site=site-A&status=open', undefined, siteAReaderHeaders);
    assert.strictEqual(listA.status, 200, JSON.stringify(listA.body));
    const rowsA = listA.body['sales_orders'] as Array<Record<string, unknown>>;
    assert.strictEqual(rowsA.length, 2, 'site-A caller sees only site-A lines');
    assert.ok(rowsA.every((r) => r['ship_from_site_code'] === 'site-A'));
    assert.deepStrictEqual(
      rowsA.map((r) => ({ sku: r['sku'], quantity: r['quantity'], required_by: r['required_by'], ship_to: r['ship_to'] })).sort((a, b) => a.required_by! < b.required_by! ? -1 : 1),
      [
        { sku: 'SKU-ERP-1', quantity: 5, required_by: '2026-08-01', ship_to: 'CUST-1' },
        { sku: 'SKU-ERP-2', quantity: 3, required_by: '2026-08-02', ship_to: 'CUST-1' },
      ],
    );

    const denied = await makeRequest(port, 'GET', '/api/v1/erp/sales-orders?site=site-A&status=open', undefined, siteBReaderHeaders);
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
    assert.strictEqual(denied.body['error_code'], 'LOCATION_ACCESS_DENIED');

    // status=open excludes a closed line; empty result is [].
    const listBOpen = await makeRequest(port, 'GET', '/api/v1/erp/sales-orders?site=site-B&status=open', undefined, adminHeaders);
    assert.strictEqual((listBOpen.body['sales_orders'] as unknown[]).length, 1);
    // Re-sync a NON-EMPTY snapshot that omits SO-2 -> SO-2 soft-closes. (An EMPTY batch is a no-op
    // and never mass-closes the book - review decision 2026-07-22; covered by its own test below.)
    await makeRequest(port, 'POST', '/api/v1/erp/sync', {
      sales_orders: [
        { so_number_ext: 'SO-1', line_no: 1, sku: 'SKU-ERP-1', quantity: 5, required_by: '2026-08-01', ship_to_ext: 'CUST-1', ship_from_site_code_ext: 'site-A' },
        { so_number_ext: 'SO-1', line_no: 2, sku: 'SKU-ERP-2', quantity: 3, required_by: '2026-08-02', ship_to_ext: 'CUST-1', ship_from_site_code_ext: 'site-A' },
      ],
    }, adminHeaders);
    const listBAfter = await makeRequest(port, 'GET', '/api/v1/erp/sales-orders?site=site-B&status=open', undefined, adminHeaders);
    assert.deepStrictEqual(listBAfter.body['sales_orders'], [], 'closed lines are excluded and empty result is []');
    const listBClosed = await makeRequest(port, 'GET', '/api/v1/erp/sales-orders?site=site-B&status=closed', undefined, adminHeaders);
    assert.strictEqual((listBClosed.body['sales_orders'] as unknown[]).length, 1, 'soft-closed line resolves under status=closed, never hard-deleted');
  });

  it('AC3: stale reads carry stale:true + age, raise exactly one dedup alert; fresh sync clears it; never-synced is stale/null', async () => {
    await resetErp();
    await makeRequest(port, 'POST', '/api/v1/erp/sync', poBatch(), adminHeaders);

    // Within threshold -> not stale.
    await getAdminPool().query(`UPDATE erp_sync_state SET last_successful_at = now() - interval '5 minutes' WHERE projection_name = 'purchase_orders'`);
    const fresh = await makeRequest(port, 'GET', '/api/v1/erp/purchase-orders/PO-2026-0042', undefined, adminHeaders);
    assert.strictEqual(fresh.body['stale'], false, 'within the 15-minute threshold a read is not stale (strict >)');

    // Past threshold -> stale + age, and an alert is raised.
    await getAdminPool().query(`UPDATE erp_sync_state SET last_successful_at = now() - interval '20 minutes' WHERE projection_name = 'purchase_orders'`);
    const stale1 = await makeRequest(port, 'GET', '/api/v1/erp/purchase-orders/PO-2026-0042', undefined, adminHeaders);
    assert.strictEqual(stale1.body['stale'], true);
    assert.ok((stale1.body['last_synced_at_age_seconds'] as number) > 900, 'age exceeds the freshness threshold');
    // Repeated stale reads must not stack duplicate open alerts.
    await makeRequest(port, 'GET', '/api/v1/erp/purchase-orders/PO-2026-0042', undefined, adminHeaders);
    const openAlerts = await getPool().query(
      `SELECT count(*)::int AS c FROM integration_exception WHERE record_type = 'sync_batch' AND error_code = 'ERP_SYNC_STALE' AND source_record_ref = 'purchase_orders' AND status = 'open'`,
    );
    assert.strictEqual(openAlerts.rows[0]!['c'], 1, 'repeated stale reads raise exactly one open alert (deduped)');

    // A fresh sync clears the alert and reads report not stale.
    await makeRequest(port, 'POST', '/api/v1/erp/sync', poBatch(), adminHeaders);
    const cleared = await getPool().query(
      `SELECT count(*)::int AS c FROM integration_exception WHERE record_type = 'sync_batch' AND error_code = 'ERP_SYNC_STALE' AND source_record_ref = 'purchase_orders' AND status = 'open'`,
    );
    assert.strictEqual(cleared.rows[0]!['c'], 0, 'a fresh in-threshold sync resolves the open stale alert');
    const afterSync = await makeRequest(port, 'GET', '/api/v1/erp/purchase-orders/PO-2026-0042', undefined, adminHeaders);
    assert.strictEqual(afterSync.body['stale'], false);

    // Never-synced zero-row feed: stale with null age.
    await resetErp();
    const neverSynced = await makeRequest(port, 'GET', '/api/v1/erp/sales-orders?site=site-A', undefined, siteAReaderHeaders);
    assert.strictEqual(neverSynced.body['stale'], true);
    assert.strictEqual(neverSynced.body['last_synced_at_age_seconds'], null);
    assert.deepStrictEqual(neverSynced.body['sales_orders'], []);
  });

  it('AC4: every write verb on the projection routes is rejected SOURCE_SYSTEM_READ_ONLY; unauth is 401; direct event and edge upload rejected', async () => {
    for (const [method, path] of [
      ['POST', '/api/v1/erp/purchase-orders'],
      ['PUT', '/api/v1/erp/purchase-orders/PO-2026-0042'],
      ['PATCH', '/api/v1/erp/purchase-orders/PO-2026-0042'],
      ['DELETE', '/api/v1/erp/purchase-orders/PO-2026-0042'],
      ['POST', '/api/v1/erp/sales-orders'],
      ['PUT', '/api/v1/erp/sales-orders'],
      ['PATCH', '/api/v1/erp/sales-orders'],
      ['DELETE', '/api/v1/erp/sales-orders'],
    ] as const) {
      const res = await makeRequest(port, method, path, method === 'DELETE' ? undefined : { any: 'thing' }, adminHeaders);
      assert.strictEqual(res.status, 405, `${method} ${path}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'SOURCE_SYSTEM_READ_ONLY', `${method} ${path}`);
    }

    // Unauthenticated write short-circuits at global auth with 401.
    const unauth = await makeRequest(port, 'PUT', '/api/v1/erp/purchase-orders/PO-2026-0042', { any: 'thing' });
    assert.strictEqual(unauth.status, 401, JSON.stringify(unauth.body));

    // A direct authenticated POST /api/v1/events with an erp stream_type is rejected by the central guard.
    const directEvent = await makeRequest(port, 'POST', '/api/v1/events', {
      stream_type: 'erp',
      stream_id: randomUUID(),
      event_type: 'erp.purchase_order_synced',
      payload: { po_number_ext: 'PO-HACK' },
      metadata: { correlation_id: randomUUID(), actor: { user_id: randomUUID(), role: 'system_administrator', location_id: locAId }, occurred_at: new Date().toISOString() },
    }, superHeaders);
    assert.strictEqual(directEvent.body['error_code'], 'SOURCE_SYSTEM_READ_ONLY', JSON.stringify(directEvent.body));

    // An edge upload with an erp stream_type is likewise rejected (never fabricates ERP rows).
    const edgeEvent = await makeRequest(port, 'POST', '/api/v1/edge/events', {
      event_id: randomUUID(),
      stream_type: 'erp',
      stream_id: randomUUID(),
      event_type: 'erp.sales_order_synced',
      payload: { so_number_ext: 'SO-HACK' },
      metadata: { correlation_id: randomUUID(), actor: { user_id: randomUUID(), role: 'system_administrator', location_id: locAId }, device_id: 'EDGE-1', occurred_at: new Date().toISOString() },
      idempotency_key: `edge-erp-${randomUUID()}`,
    }, superHeaders);
    assert.strictEqual(edgeEvent.body['error_code'], 'SOURCE_SYSTEM_READ_ONLY', JSON.stringify(edgeEvent.body));
  });

  it('AC5: a malformed record routes to the exception queue while the rest of the batch syncs; a bad line isolates at the PO grain', async () => {
    await resetErp();
    const batch = {
      purchase_orders: [
        { po_number_ext: 'PO-GOOD', supplier_ref_ext: 'SUP-1', currency: 'INR', lines: [{ line_no: 1, sku: 'SKU-ERP-1', ordered_qty: 5, open_qty: 5, unit_price: 1 }] },
        // One good line + one unknown-SKU line: the WHOLE PO is rejected (PO-grain atomicity).
        { po_number_ext: 'PO-BAD', supplier_ref_ext: 'SUP-1', currency: 'INR', lines: [
          { line_no: 1, sku: 'SKU-ERP-1', ordered_qty: 5, open_qty: 5, unit_price: 1 },
          { line_no: 2, sku: 'SKU-DOES-NOT-EXIST', ordered_qty: 5, open_qty: 5, unit_price: 1 },
        ] },
        { po_number_ext: 'PO-BAD-2', supplier_ref_ext: 'SUP-1', currency: 'INR', lines: [{ line_no: 1, sku: 'ALSO-MISSING', ordered_qty: 5, open_qty: 5, unit_price: 1 }] },
      ],
    };
    const sync = await makeRequest(port, 'POST', '/api/v1/erp/sync', batch, adminHeaders);
    assert.strictEqual(sync.status, 200, JSON.stringify(sync.body));
    assert.deepStrictEqual(sync.body['purchase_orders'], { applied: 1, failed: 2 }, 'good PO applied; two malformed POs failed');

    const good = await makeRequest(port, 'GET', '/api/v1/erp/purchase-orders/PO-GOOD', undefined, adminHeaders);
    assert.strictEqual(good.status, 200);
    const bad = await makeRequest(port, 'GET', '/api/v1/erp/purchase-orders/PO-BAD', undefined, adminHeaders);
    assert.strictEqual(bad.status, 404, 'the malformed PO is not partially applied - no header, no first line');

    const exc = await getPool().query(
      `SELECT source_record_ref, error_code FROM integration_exception WHERE record_type = 'purchase_order' AND status = 'open' ORDER BY source_record_ref`,
    );
    assert.strictEqual(exc.rows.length, 2, 'each malformed PO queues independently');
    assert.deepStrictEqual(exc.rows.map((r) => r['source_record_ref']), ['PO-BAD', 'PO-BAD-2']);
    assert.ok(exc.rows.every((r) => r['error_code'] === 'ITEM_NOT_FOUND'));

    const lineCount = await getPool().query(`SELECT count(*)::int AS c FROM erp_purchase_order_line WHERE po_number_ext = 'PO-BAD'`);
    assert.strictEqual(lineCount.rows[0]!['c'], 0, 'no line of the rejected PO survives');
  });

  it('AC6 (idempotency/replay): re-syncing an unchanged PO produces no duplicate rows or churn alert; concurrent syncs yield one row', async () => {
    await resetErp();
    await makeRequest(port, 'POST', '/api/v1/erp/sync', poBatch(), adminHeaders);
    await makeRequest(port, 'POST', '/api/v1/erp/sync', poBatch(), adminHeaders);
    const headers = await getPool().query(`SELECT count(*)::int AS c FROM erp_purchase_order WHERE po_number_ext = 'PO-2026-0042'`);
    assert.strictEqual(headers.rows[0]!['c'], 1, 're-sync upserts by grain - no duplicate header');
    const lines = await getPool().query(`SELECT count(*)::int AS c FROM erp_purchase_order_line WHERE po_number_ext = 'PO-2026-0042'`);
    assert.strictEqual(lines.rows[0]!['c'], 2, 're-sync upserts lines by grain - no duplicate lines');
    const alerts = await getPool().query(`SELECT count(*)::int AS c FROM integration_exception WHERE status = 'open'`);
    assert.strictEqual(alerts.rows[0]!['c'], 0, 'a clean idempotent re-sync raises no alert');

    // Concurrent syncs racing the same grain still yield exactly one row (ON CONFLICT upsert).
    await resetErp();
    await Promise.all([
      makeRequest(port, 'POST', '/api/v1/erp/sync', poBatch(), adminHeaders),
      makeRequest(port, 'POST', '/api/v1/erp/sync', poBatch(), adminHeaders),
    ]);
    const raced = await getPool().query(`SELECT count(*)::int AS c FROM erp_purchase_order WHERE po_number_ext = 'PO-2026-0042'`);
    assert.strictEqual(raced.rows[0]!['c'], 1, 'concurrent syncs for the same grain yield exactly one row');
  });

  it('AC5/RBAC: the sync trigger is restricted to svc_erp_adapter / system_administrator; a normal inventory writer is denied', async () => {
    await resetErp();
    const svc = await makeRequest(port, 'POST', '/api/v1/erp/sync', poBatch(), svcErpHeaders);
    assert.strictEqual(svc.status, 200, JSON.stringify(svc.body));
    const denied = await makeRequest(port, 'POST', '/api/v1/erp/sync', poBatch(), normalWriterHeaders);
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
    assert.strictEqual(denied.body['error_code'], 'FUNCTION_ACCESS_DENIED');
  });

  it('empty and all-failed batches are no-ops: no mass-close, no fresh success, staleness preserved (review decision 2026-07-22)', async () => {
    await resetErp();
    await makeRequest(port, 'POST', '/api/v1/erp/sync', poBatch(), adminHeaders);
    // Drive the heartbeat stale so a wrongful "fresh success" stamp would be observable.
    await getAdminPool().query(`UPDATE erp_sync_state SET last_successful_at = now() - interval '20 minutes' WHERE projection_name = 'purchase_orders'`);

    // Empty batch: applied 0 / failed 0 - must NOT close the open PO and must NOT refresh the heartbeat.
    const empty = await makeRequest(port, 'POST', '/api/v1/erp/sync', { purchase_orders: [] }, adminHeaders);
    assert.deepStrictEqual(empty.body['purchase_orders'], { applied: 0, failed: 0 });
    const afterEmpty = await makeRequest(port, 'GET', '/api/v1/erp/purchase-orders/PO-2026-0042', undefined, adminHeaders);
    assert.strictEqual(afterEmpty.status, 200, 'the open PO survives an empty batch (never mass-closed)');
    assert.strictEqual(afterEmpty.body['status'], 'open', 'the PO is not soft-closed by an empty batch');
    assert.strictEqual(afterEmpty.body['stale'], true, 'an empty batch does not stamp a fresh success heartbeat');

    // All-failed batch: one unknown-SKU PO -> applied 0 / failed 1 - same no-op guarantees.
    const allBad = await makeRequest(port, 'POST', '/api/v1/erp/sync', {
      purchase_orders: [{ po_number_ext: 'PO-ALLBAD', supplier_ref_ext: 'SUP-1', currency: 'INR', lines: [{ line_no: 1, sku: 'SKU-DOES-NOT-EXIST', ordered_qty: 1, open_qty: 1, unit_price: 1 }] }],
    }, adminHeaders);
    assert.deepStrictEqual(allBad.body['purchase_orders'], { applied: 0, failed: 1 });
    const afterAllBad = await makeRequest(port, 'GET', '/api/v1/erp/purchase-orders/PO-2026-0042', undefined, adminHeaders);
    assert.strictEqual(afterAllBad.body['status'], 'open', 'a batch whose every record failed does not mass-close the book');
    assert.strictEqual(afterAllBad.body['stale'], true, 'an all-failed batch does not report a fresh, healthy heartbeat');
  });

  it('Task 7: creating an ownership agreement never raises a premature OWNER_PARTY_NOT_IN_ERP warning (removed - review decision 2026-07-22)', async () => {
    await resetErp();
    await makeRequest(port, 'POST', '/api/v1/erp/sync', poBatch(), adminHeaders); // supplier_ref_ext = SUPPLIER-X

    // owner_party_code and supplier_ref_ext are DIFFERENT identifier namespaces, so the old
    // supplier-ref comparison false-positived. The warning is removed pending the Epic 4.1 governed
    // supplier registry: agreements create cleanly and the exception queue stays empty either way.
    const unknownOwner = await makeRequest(port, 'PUT', '/api/v1/ownership-agreements/SKU-ERP-1/' + locAId + '/consignment', { owner_party_code: 'SUPPLIER-Y', business_stream: 'production' }, plannerHeaders);
    assert.ok(unknownOwner.status === 200 || unknownOwner.status === 201, `agreement must still be created: ${JSON.stringify(unknownOwner.body)}`);
    const knownOwner = await makeRequest(port, 'PUT', '/api/v1/ownership-agreements/SKU-ERP-2/' + locAId + '/consignment', { owner_party_code: 'SUPPLIER-X', business_stream: 'production' }, plannerHeaders);
    assert.ok(knownOwner.status === 200 || knownOwner.status === 201, JSON.stringify(knownOwner.body));

    const warn = await getPool().query(
      `SELECT count(*)::int AS c FROM integration_exception WHERE error_code = 'OWNER_PARTY_NOT_IN_ERP'`,
    );
    assert.strictEqual(warn.rows[0]!['c'], 0, 'no owner-party warning is raised - the premature supplier-ref comparison is removed');
  });

  it('Task 9.4: Story 2.7 lead-time integration stays optional-additive - safety stock still fails closed with LEAD_TIME_NOT_CONFIGURED with zero 2.9 data', async () => {
    const params = await makeRequest(port, 'POST', '/api/v1/planning/params', { sku: 'SKU-ERP-1', location_id: locAId, service_level: 0.95, business_stream: 'production' }, plannerHeaders);
    assert.ok(params.status === 200 || params.status === 201, JSON.stringify(params.body));
    const compute = await makeRequest(port, 'POST', '/api/v1/planning/safety-stock/compute', { sku: 'SKU-ERP-1', location_id: locAId, business_date: BUSINESS_DATE }, plannerHeaders);
    assert.strictEqual(compute.status, 400, JSON.stringify(compute.body));
    assert.strictEqual(compute.body['error_code'], 'LEAD_TIME_NOT_CONFIGURED', '2.7 fails closed without ERP-derived lead time - 2.9 is not a hard dependency');
  });
});
