import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool, getPool } from '../../src/config/db.js';
import { applyStockBalanceProjection } from '../../src/compliance/stock-balance.js';
import { applyJobworkMaterialReceivedProjection } from '../../src/compliance/jobwork-receipt.js';
import { AppError } from '../../src/middleware/error.js';
import type { EventEnvelope } from '../../src/events/store.js';

/**
 * Story 9.2 Customer Material Receipt and Segregated Stock (FR-JW-03, FR-JW-04, FR-JW-05).
 * Real PostgreSQL, the real production router, SCIM provisioning and dev-token auth. Tests run
 * serially; every identifier is run-scoped. Fixture writes use the admin pool (app_user lacks
 * DELETE). The harness scaffolding is a deliberate local re-implementation of the story-9-1 and
 * story-3-4 closures, which are not exported (never import cross-story).
 *
 * Customer material rides the Story 3.4 GRN flow (POST /api/v1/grn-lines) with
 * stock_class 'job_work': every receipt therefore needs a PO line for the sku and an accepted
 * weighbridge token, exactly like owned stock. A fresh PO (ordered 100000, no over-receipt in
 * play) and a fresh token are seeded per receipt.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);
const RUN = run.toUpperCase();

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

function detailsOf(body: Record<string, unknown>): Record<string, unknown> {
  const details = body['details'];
  return typeof details === 'object' && details !== null
    ? (details as Record<string, unknown>)
    : {};
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
    req.setTimeout(60000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
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
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub} failed`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

describe('Story 9.2 Customer Material Receipt and Segregated Stock', () => {
  let server: Server;
  let port: number;

  let storeUserId: string;
  let storeHeaders: Record<string, string>;
  let coordinatorUserId: string;
  let coordinatorHeaders: Record<string, string>;
  let managerHeaders: Record<string, string>;
  let siteBReaderHeaders: Record<string, string>;

  let siteAId: string;
  let siteBId: string;
  let dockId: string;
  let qcZoneId: string;
  let kitBomId: string;

  const CUSTOMER = `CUST-9-2-${RUN}`;
  const SKU = `SKU-CUST-${RUN}`;
  const SKU_Q = `SKU-CUST-Q-${RUN}`;
  const SKU_OWNED = `SKU-OWNED-${RUN}`;
  const DOCK_CODE = `RECV-DOCK-9-2-${run}`;
  let poCounter = 0;

  // -------------------------------------------------------------------------
  // Fixture helpers
  // -------------------------------------------------------------------------

  async function seedLocation(
    level: string,
    code: string,
    siteId: string | null,
    extra: { zoneType?: string; quarantine?: boolean } = {},
  ): Promise<string> {
    const locationId = randomUUID();
    await getAdminPool().query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'ambient', $7, 'active')`,
      [
        locationId,
        code,
        level,
        siteId,
        siteId ?? locationId,
        extra.zoneType ?? 'general',
        extra.quarantine ?? false,
      ],
    );
    return locationId;
  }

  async function seedItem(sku: string, quarantineRequired = false): Promise<void> {
    await getAdminPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ($1, 'KG', false, false, false, $2, false, 'weighted_average', 'job_work', 'active')`,
      [sku, quarantineRequired],
    );
  }

  async function seedBom(): Promise<string> {
    const bomId = randomUUID();
    await getAdminPool().query(
      `INSERT INTO bom (bom_id, parent_item_id, parent_sku, parent_uom, business_stream, bom_type, status, created_by, source_event_id)
       VALUES ($1, $2, $3, 'EA', 'job_work', 'job_work_kit', 'released', $4, $5)`,
      [bomId, randomUUID(), `KIT-9-2-${run}`, coordinatorUserId, randomUUID()],
    );
    return bomId;
  }

  /** Fresh PO + line for one receipt; a huge ordered_qty keeps the Story 3.4 over-receipt band out. */
  async function seedPo(sku: string): Promise<string> {
    poCounter += 1;
    const poRef = `PO-JW-${run}-${poCounter}`;
    await getAdminPool().query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, expected_delivery_date, status, source_system, last_synced_at)
       VALUES ($1, 'SUP-JW', 'INR', '2026-10-01', 'open', 'ERP', now())`,
      [poRef],
    );
    await getAdminPool().query(
      `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, over_receipt_tolerance_pct, under_receipt_tolerance_pct, source_system, last_synced_at)
       VALUES ($1, 1, $2, 100000, 100000, 1, 5, 5, 'ERP', now())`,
      [poRef, sku],
    );
    return poRef;
  }

  async function seedToken(poRef: string, siteId: string = siteAId): Promise<string> {
    const token = randomUUID();
    await getAdminPool().query(
      `INSERT INTO weighbridge_event
        (weighbridge_event_id, correlation_id, gate_event_id, site_id, site_code_ext, po_ref_ext, line_no,
         tare_kg, gross_kg, net_kg, status, device_id, capture_method, weighed_by, business_date, source_event_id)
       VALUES ($1, $2, $3, $4, 'site-A-9-2', $5, 1, 1000, 2000, 1000, 'accepted', 'WB-9-2', 'MANUAL', $6, '2026-09-03', $7)`,
      [randomUUID(), token, randomUUID(), siteId, poRef, coordinatorUserId, randomUUID()],
    );
    return token;
  }

  /** A confirmed order for CUSTOMER at siteA (or overrides) via the Story 9.1 routes. */
  async function confirmedOrder(overrides: Record<string, unknown> = {}): Promise<string> {
    const create = await makeRequest(
      port,
      'POST',
      '/api/v1/service-orders',
      {
        site_id: siteAId,
        customer_party_code: CUSTOMER,
        customer_name: 'Acme Fabrication Pvt Ltd',
        spec_reference_ext: `SPEC-${run}`,
        price_basis: { basis_type: 'per_kg', rate: 12.5, currency: 'INR' },
        kit_bom_id: kitBomId,
        idempotency_key: randomUUID(),
        ...overrides,
      },
      coordinatorHeaders,
    );
    assert.strictEqual(create.status, 201, `create order failed: ${JSON.stringify(create.body)}`);
    const orderId = (create.body['service_order'] as Record<string, unknown>)[
      'service_order_id'
    ] as string;
    const confirm = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/confirm`,
      { idempotency_key: randomUUID() },
      coordinatorHeaders,
    );
    assert.strictEqual(confirm.status, 200, `confirm failed: ${JSON.stringify(confirm.body)}`);
    return orderId;
  }

  async function draftOrder(): Promise<string> {
    const create = await makeRequest(
      port,
      'POST',
      '/api/v1/service-orders',
      {
        site_id: siteAId,
        customer_party_code: CUSTOMER,
        customer_name: 'Acme Fabrication Pvt Ltd',
        price_basis: { basis_type: 'per_kg', rate: 12.5, currency: 'INR' },
        kit_bom_id: kitBomId,
        idempotency_key: randomUUID(),
      },
      coordinatorHeaders,
    );
    assert.strictEqual(create.status, 201, JSON.stringify(create.body));
    return (create.body['service_order'] as Record<string, unknown>)['service_order_id'] as string;
  }

  interface ReceiptOpts {
    sku?: string;
    receivedQty?: string | number;
    challanQty?: string | number;
    lotId?: string;
    serviceOrderId?: string | null;
    challan?: boolean;
    extra?: Record<string, unknown>;
    headers?: Record<string, string>;
  }

  /** Posts a job_work GRN line (fresh PO + token) and returns the response plus the ids used. */
  async function receive(
    opts: ReceiptOpts = {},
  ): Promise<HttpResult & { grnLineId: string; grnId: string; poRef: string }> {
    const sku = opts.sku ?? SKU;
    const poRef = await seedPo(sku);
    const token = await seedToken(poRef);
    const grnId = randomUUID();
    const grnLineId = randomUUID();
    const body: Record<string, unknown> = {
      grn_id: grnId,
      grn_line_id: grnLineId,
      correlation_id: token,
      po_ref_ext: poRef,
      line_no: 1,
      source_document: 'PO',
      sku,
      target_location_code: DOCK_CODE,
      received_qty: opts.receivedQty ?? '1000',
      stock_class: 'job_work',
      lot_id: opts.lotId ?? `LOT-JW-${run}-${randomUUID().slice(0, 6)}`,
      ...(opts.serviceOrderId === null ? {} : { service_order_id: opts.serviceOrderId }),
      ...(opts.challan === false
        ? {}
        : {
            challan_number_ext: `CH-${run}-${randomUUID().slice(0, 6)}`,
            challan_date: '2026-09-01',
            challan_qty: opts.challanQty ?? '1000',
          }),
      ...(opts.extra ?? {}),
    };
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/grn-lines',
      body,
      opts.headers ?? storeHeaders,
    );
    return { ...res, grnLineId, grnId, poRef };
  }

  async function orderRow(serviceOrderId: string): Promise<Record<string, unknown>> {
    const r = await getAdminPool().query(
      `SELECT * FROM service_order WHERE service_order_id = $1`,
      [serviceOrderId],
    );
    assert.strictEqual(r.rows.length, 1);
    return r.rows[0] as Record<string, unknown>;
  }

  async function receiptRows(serviceOrderId: string): Promise<Array<Record<string, unknown>>> {
    const r = await getAdminPool().query(
      `SELECT receipt_id, grn_line_id, challan_number_ext, to_char(challan_date, 'YYYY-MM-DD') AS challan_date,
              sku, lot_id, received_qty::text AS received_qty, challan_qty::text AS challan_qty,
              variance_qty::text AS variance_qty, variance_flagged, received_by, site_id, source_event_id
         FROM jobwork_material_receipt WHERE service_order_id = $1 ORDER BY created_at, receipt_id`,
      [serviceOrderId],
    );
    return r.rows as Array<Record<string, unknown>>;
  }

  async function countRows(table: string, where: string, params: unknown[]): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
      params,
    );
    return r.rows[0]!['n'] as number;
  }

  async function balances(sku: string): Promise<Array<Record<string, unknown>>> {
    const r = await getAdminPool().query(
      `SELECT location_id, lot_id, stock_class, on_hand::text AS on_hand, allocated::text AS allocated, available::text AS available
         FROM stock_balance WHERE sku = $1 ORDER BY stock_class, lot_id`,
      [sku],
    );
    return r.rows as Array<Record<string, unknown>>;
  }

  async function auditCount(errorCode: string): Promise<number> {
    return countRows('audit_log', 'error_code = $1', [errorCode]);
  }

  function stockEnvelope(
    eventType: string,
    payload: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      stream_type: 'inventory',
      stream_id: randomUUID(),
      event_type: eventType,
      payload: { business_stream: 'job_work', ...payload },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: storeUserId, role: 'store_assistant', location_id: siteAId },
        occurred_at: new Date().toISOString(),
      },
      ...extra,
    };
  }

  async function postEvent(
    envelope: Record<string, unknown>,
    headers: Record<string, string> = storeHeaders,
  ): Promise<HttpResult> {
    return makeRequest(port, 'POST', '/api/v1/events', envelope, headers);
  }

  async function withRolledBackClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Harness
  // -------------------------------------------------------------------------

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
      '../../read/projections/notification.sql',
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
      '../../read/projections/grn.sql',
      '../../read/projections/grn_line.sql',
      '../../read/projections/putaway_task.sql',
      '../../read/projections/asn.sql',
      '../../read/projections/asn_line.sql',
      '../../read/projections/pick_task.sql',
      '../../read/projections/bom.sql',
      '../../read/projections/service_order.sql',
      '../../read/projections/jobwork_material_receipt.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE jobwork_material_receipt, service_order, bom, pick_task, asn_line, asn, putaway_task, grn_line, grn, weighbridge_event, gate_event, integration_exception, erp_sync_state, erp_sales_order, erp_purchase_order_line, erp_purchase_order, ownership_agreement, obsolescence_flag, replenishment_recommendation, inventory_planning_params, physical_verification_line, physical_verification, cycle_count_line, cycle_count, in_transit, transfer_request, inventory_valuation, lot_master, serial_master, lot_trace, stock_balance, item_master, location_register, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    siteAId = await seedLocation('site', `SITE-A-9-2-${run}`, null);
    siteBId = await seedLocation('site', `SITE-B-9-2-${run}`, null);
    dockId = await seedLocation('zone', DOCK_CODE, siteAId, { zoneType: 'staging' });
    qcZoneId = await seedLocation('zone', 'ZONE-QC-HOLD', siteAId, {
      zoneType: 'quarantine',
      quarantine: true,
    });
    await seedItem(SKU);
    await seedItem(SKU_Q, true);
    await seedItem(SKU_OWNED);

    coordinatorUserId = await provisionUser(port, `jw-coordinator-9-2-${run}@example.com`, [
      { role: 'jobwork_coordinator', module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: 'jobwork_coordinator', module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    coordinatorHeaders = await authFor(port, `jw-coordinator-9-2-${run}@example.com`);

    // The receiving clerk: GRN write at site A, inventory write for the direct stock-event arms,
    // jobwork read for the receipts route, and the cycle-count create scope.
    storeUserId = await provisionUser(port, `jw-store-9-2-${run}@example.com`, [
      { role: 'store_assistant', module: 'receiving', functionScope: 'write', locationId: siteAId },
      { role: 'store_assistant', module: 'inventory', functionScope: 'write', locationId: '*' },
      { role: 'store_assistant', module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    storeHeaders = await authFor(port, `jw-store-9-2-${run}@example.com`);

    // Warehouse manager: pick generation (module warehouse), transfer creation and cycle-count
    // approval (module inventory); the DOA holder for count adjustments.
    await provisionUser(port, `jw-manager-9-2-${run}@example.com`, [
      { role: 'warehouse_manager', module: 'warehouse', functionScope: 'write', locationId: '*' },
      { role: 'warehouse_manager', module: 'inventory', functionScope: 'write', locationId: '*' },
      { role: 'warehouse_manager', module: 'inventory', functionScope: 'read', locationId: '*' },
    ]);
    managerHeaders = await authFor(port, `jw-manager-9-2-${run}@example.com`);

    await provisionUser(port, `jw-siteb-reader-9-2-${run}@example.com`, [
      { role: 'jobwork_reader', module: 'jobwork', functionScope: 'read', locationId: siteBId },
    ]);
    siteBReaderHeaders = await authFor(port, `jw-siteb-reader-9-2-${run}@example.com`);

    // DOA band for count adjustments (any variance value -> warehouse_manager), for the AC6
    // cycle-count arm.
    await getAdminPool().query(
      `INSERT INTO doa_registry_entries (entry_id, role, transaction_type, value_min, value_max, active)
       VALUES ($1, 'warehouse_manager', 'inventory.count_adjustment', NULL, NULL, true)`,
      [randomUUID()],
    );

    kitBomId = await seedBom();
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 1: receipt blocked without a confirmed order and challan
  // -------------------------------------------------------------------------

  it('AC1: a job_work receipt with no service_order_id refuses SOURCE_DOCUMENT_REQUIRED and writes nothing', async () => {
    const res = await receive({ serviceOrderId: null });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'SOURCE_DOCUMENT_REQUIRED');
    assert.strictEqual(await countRows('grn_line', 'grn_line_id = $1', [res.grnLineId]), 0);
    assert.strictEqual(await countRows('grn', 'grn_id = $1', [res.grnId]), 0);
  });

  it('AC1: an unknown, a draft, and a wrong-site order all refuse SOURCE_DOCUMENT_REQUIRED (transaction rolled back)', async () => {
    const unknown = await receive({ serviceOrderId: randomUUID() });
    assert.strictEqual(unknown.status, 409, JSON.stringify(unknown.body));
    assert.strictEqual(unknown.body['error_code'], 'SOURCE_DOCUMENT_REQUIRED');

    const draftId = await draftOrder();
    const draft = await receive({ serviceOrderId: draftId });
    assert.strictEqual(draft.status, 409, JSON.stringify(draft.body));
    assert.strictEqual(draft.body['error_code'], 'SOURCE_DOCUMENT_REQUIRED');
    assert.strictEqual(detailsOf(draft.body)['status'], 'draft');
    assert.strictEqual((await orderRow(draftId))['status'], 'draft');

    const siteBOrder = await confirmedOrder({ site_id: siteBId });
    const wrongSite = await receive({ serviceOrderId: siteBOrder });
    assert.strictEqual(wrongSite.status, 409, JSON.stringify(wrongSite.body));
    assert.strictEqual(wrongSite.body['error_code'], 'SOURCE_DOCUMENT_REQUIRED');
    assert.strictEqual((await orderRow(siteBOrder))['status'], 'confirmed');
    assert.strictEqual(await countRows('grn_line', 'grn_line_id = $1', [wrongSite.grnLineId]), 0);
    assert.strictEqual(
      await countRows('stock_balance', "sku = $1 AND stock_class = 'job_work'", [SKU]),
      0,
    );
  });

  it('AC1: a confirmed order but no challan reference, date, or quantity refuses SOURCE_DOCUMENT_REQUIRED', async () => {
    const orderId = await confirmedOrder();
    const none = await receive({ serviceOrderId: orderId, challan: false });
    assert.strictEqual(none.status, 409, JSON.stringify(none.body));
    assert.strictEqual(none.body['error_code'], 'SOURCE_DOCUMENT_REQUIRED');

    const noDate = await receive({
      serviceOrderId: orderId,
      challan: false,
      extra: { challan_number_ext: 'CH-NODATE', challan_qty: '1000' },
    });
    assert.strictEqual(noDate.status, 409, JSON.stringify(noDate.body));
    assert.strictEqual(noDate.body['error_code'], 'SOURCE_DOCUMENT_REQUIRED');

    const zeroQty = await receive({ serviceOrderId: orderId, challanQty: '0' });
    assert.strictEqual(zeroQty.status, 409, JSON.stringify(zeroQty.body));
    assert.strictEqual(zeroQty.body['error_code'], 'SOURCE_DOCUMENT_REQUIRED');

    assert.strictEqual((await orderRow(orderId))['status'], 'confirmed');
    assert.strictEqual((await receiptRows(orderId)).length, 0);
  });

  it('AC1 seam point (mutation guard): the custody applier itself refuses a draft order under lock, before any row is written', async () => {
    const draftId = await draftOrder();
    const envelope = {
      stream_type: 'jobwork',
      stream_id: draftId,
      event_type: 'jobwork.material_received',
      payload: {
        service_order_id: draftId,
        receipt_id: randomUUID(),
        grn_line_id: randomUUID(),
        challan_number_ext: 'CH-SEAM',
        challan_date: '2026-09-01',
        sku: SKU,
        lot_id: `LOT-SEAM-${run}`,
        received_qty: '10.000',
        challan_qty: '10.000',
        uom: 'KG',
        site_id: siteAId,
        received_by: storeUserId,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: storeUserId, role: 'store_assistant', location_id: siteAId },
        occurred_at: new Date().toISOString(),
      },
    } as unknown as EventEnvelope;
    await withRolledBackClient(async (client) => {
      await assert.rejects(
        applyJobworkMaterialReceivedProjection(envelope, client, randomUUID()),
        (err: unknown) =>
          err instanceof AppError &&
          err.errorCode === 'SOURCE_DOCUMENT_REQUIRED' &&
          err.statusCode === 409 &&
          (err.details as Record<string, unknown>)['status'] === 'draft',
      );
    });
    assert.strictEqual((await orderRow(draftId))['status'], 'draft');
    assert.strictEqual((await receiptRows(draftId)).length, 0);
  });

  // -------------------------------------------------------------------------
  // AC 2: challan captured, receipt recorded, first receipt flips in_process
  // -------------------------------------------------------------------------

  it('AC2: the first receipt persists the challan, the custody row, the job_work GRN line, and flips confirmed -> in_process in one transaction; the second does not re-transition', async () => {
    const orderId = await confirmedOrder();
    const lot = `LOT-JW-AC2-${run}`;
    const first = await receive({ serviceOrderId: orderId, lotId: lot, receivedQty: '1000' });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const line = first.body['grn_line'] as Record<string, unknown>;
    assert.strictEqual(line['stock_class'], 'job_work');
    assert.strictEqual(line['status'], 'posted');

    const order = await orderRow(orderId);
    assert.strictEqual(order['status'], 'in_process');
    assert.ok(order['in_process_at'], 'in_process_at stamped');
    const firstInProcessAt = String(order['in_process_at']);

    const rows = await receiptRows(orderId);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!['grn_line_id'], first.grnLineId);
    assert.match(String(rows[0]!['challan_number_ext']), /^CH-/);
    assert.strictEqual(rows[0]!['challan_date'], '2026-09-01');
    assert.strictEqual(rows[0]!['received_qty'], '1000.000');
    assert.strictEqual(rows[0]!['challan_qty'], '1000.000');
    assert.strictEqual(rows[0]!['variance_qty'], '0.000');
    assert.strictEqual(rows[0]!['variance_flagged'], false);
    assert.strictEqual(rows[0]!['received_by'], storeUserId);
    assert.strictEqual(rows[0]!['lot_id'], lot);
    assert.strictEqual(rows[0]!['site_id'], siteAId);

    // The custody event is its own domain event on the order's stream, with server-derived
    // variance fields written back before the insert.
    const ev = await getAdminPool().query(
      `SELECT event_id, payload FROM domain_events
        WHERE stream_type = 'jobwork' AND stream_id = $1 AND event_type = 'jobwork.material_received'`,
      [orderId],
    );
    assert.strictEqual(ev.rows.length, 1);
    const payload = ev.rows[0]!['payload'] as Record<string, unknown>;
    assert.strictEqual(payload['variance_qty'], '0.000');
    assert.strictEqual(payload['variance_flagged'], false);
    assert.strictEqual(payload['grn_line_id'], first.grnLineId);
    assert.strictEqual(rows[0]!['source_event_id'], ev.rows[0]!['event_id']);

    const second = await receive({
      serviceOrderId: orderId,
      lotId: `${lot}-B`,
      receivedQty: '500',
      challanQty: '500',
    });
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
    const after2 = await orderRow(orderId);
    assert.strictEqual(after2['status'], 'in_process');
    assert.strictEqual(String(after2['in_process_at']), firstInProcessAt, 'no second transition');
    assert.strictEqual((await receiptRows(orderId)).length, 2);

    // Task 6.1: the read route lists both, oldest first, with the variance fields.
    const list = await makeRequest(
      port,
      'GET',
      `/api/v1/service-orders/${orderId}/receipts`,
      undefined,
      storeHeaders,
    );
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    const receipts = list.body['receipts'] as Array<Record<string, unknown>>;
    assert.strictEqual(receipts.length, 2);
    assert.strictEqual(receipts[0]!['grn_line_id'], first.grnLineId);
    assert.strictEqual(receipts[1]!['grn_line_id'], second.grnLineId);
    assert.strictEqual(receipts[0]!['challan_date'], '2026-09-01');
    assert.strictEqual(receipts[1]!['variance_qty'], '0.000');
    assert.strictEqual(receipts[1]!['variance_flagged'], false);
  });

  it('AC2 concurrency: two receipts fired at the same order simultaneously still produce exactly one transition and two custody rows', async () => {
    // Code review 2026-09-03: the advisory lock keyed by service_order_id (lockOrder in
    // jobwork-receipt.ts) should serialize this - both receipts observe status = confirmed
    // before either commits, but the lock forces the second to re-derive under the FIRST
    // receipt's committed status, so only ONE transitions the order. Prior tests only proved
    // sequential and idempotent-replay behavior; this proves the lock holds under a genuine race.
    const orderId = await confirmedOrder();
    const [a, b] = await Promise.all([
      receive({
        serviceOrderId: orderId,
        lotId: `LOT-RACE-A-${run}`,
        receivedQty: '10',
        challanQty: '10',
      }),
      receive({
        serviceOrderId: orderId,
        lotId: `LOT-RACE-B-${run}`,
        receivedQty: '10',
        challanQty: '10',
      }),
    ]);
    assert.strictEqual(a.status, 201, JSON.stringify(a.body));
    assert.strictEqual(b.status, 201, JSON.stringify(b.body));
    const order = await orderRow(orderId);
    assert.strictEqual(order['status'], 'in_process');
    assert.ok(order['in_process_at'], 'in_process_at stamped exactly once');
    assert.strictEqual((await receiptRows(orderId)).length, 2);
    assert.strictEqual(
      await countRows(
        'domain_events',
        "stream_id = $1 AND event_type = 'jobwork.material_received'",
        [orderId],
      ),
      2,
      'both custody events persisted, no lost update',
    );
  });

  it('AC2 read route: a site-B-only reader gets the same 404 as a missing order (no info leak)', async () => {
    const orderId = await confirmedOrder();
    const denied = await makeRequest(
      port,
      'GET',
      `/api/v1/service-orders/${orderId}/receipts`,
      undefined,
      siteBReaderHeaders,
    );
    assert.strictEqual(denied.status, 404, JSON.stringify(denied.body));
    assert.strictEqual(denied.body['error_code'], 'SERVICE_ORDER_NOT_FOUND');
    const missing = await makeRequest(
      port,
      'GET',
      `/api/v1/service-orders/${randomUUID()}/receipts`,
      undefined,
      storeHeaders,
    );
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.body['error_code'], 'SERVICE_ORDER_NOT_FOUND');
    const bad = await makeRequest(
      port,
      'GET',
      `/api/v1/service-orders/not-a-uuid/receipts`,
      undefined,
      storeHeaders,
    );
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body['error_code'], 'INVALID_PARAMS');
  });

  // -------------------------------------------------------------------------
  // AC 3: tolerance variance
  // -------------------------------------------------------------------------

  it('AC3: an over-tolerance deviation is flagged and attributed to the receiving user; a within-tolerance one is stored unflagged (default 0.5 percent)', async () => {
    const orderId = await confirmedOrder();
    // 0.5 percent of 1000 is 5.000: 1006 is over, 996 (short) is over, 1004 is within, 1005 is at.
    const over = await receive({
      serviceOrderId: orderId,
      receivedQty: '1006',
      challanQty: '1000',
    });
    assert.strictEqual(over.status, 201, JSON.stringify(over.body));
    const short = await receive({
      serviceOrderId: orderId,
      receivedQty: '994.5',
      challanQty: '1000',
    });
    assert.strictEqual(short.status, 201, JSON.stringify(short.body));
    const within = await receive({
      serviceOrderId: orderId,
      receivedQty: '1004',
      challanQty: '1000',
    });
    assert.strictEqual(within.status, 201, JSON.stringify(within.body));
    const atBand = await receive({
      serviceOrderId: orderId,
      receivedQty: '1005',
      challanQty: '1000',
    });
    assert.strictEqual(atBand.status, 201, JSON.stringify(atBand.body));

    const rows = await receiptRows(orderId);
    const byLine = new Map(rows.map((r) => [r['grn_line_id'], r]));
    const o = byLine.get(over.grnLineId)!;
    assert.strictEqual(o['variance_qty'], '6.000');
    assert.strictEqual(o['variance_flagged'], true);
    assert.strictEqual(o['received_by'], storeUserId);
    const s = byLine.get(short.grnLineId)!;
    assert.strictEqual(s['variance_qty'], '-5.500');
    assert.strictEqual(s['variance_flagged'], true);
    const w = byLine.get(within.grnLineId)!;
    assert.strictEqual(w['variance_qty'], '4.000');
    assert.strictEqual(w['variance_flagged'], false);
    const a = byLine.get(atBand.grnLineId)!;
    assert.strictEqual(a['variance_qty'], '5.000');
    assert.strictEqual(a['variance_flagged'], false, 'exactly at tolerance does not flag');
  });

  // -------------------------------------------------------------------------
  // AC 4: non-valuated segregated stock
  // -------------------------------------------------------------------------

  it('AC4: the balance row is job_work class at the dock; no owned availability, no valuation, no cross-dock, invisible to pick and transfer', async () => {
    const sku = `SKU-AC4-${RUN}`;
    await seedItem(sku);
    const orderId = await confirmedOrder();
    const lot = `LOT-JW-AC4-${run}`;
    const res = await receive({
      serviceOrderId: orderId,
      sku,
      lotId: lot,
      receivedQty: '100',
      challanQty: '100',
      extra: { cross_dock: true, staging_zone_code: DOCK_CODE },
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['cross_dock_nonqualification_reason'], 'non_owned_stock');
    assert.strictEqual(res.body['cross_dock_task'], null);

    const rows = await balances(sku);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!['stock_class'], 'job_work');
    assert.strictEqual(rows[0]!['location_id'], dockId);
    assert.strictEqual(rows[0]!['lot_id'], lot);
    assert.strictEqual(Number(rows[0]!['on_hand']), 100);

    // Valuation: non-owned quantities are reported and carry no value.
    assert.strictEqual(await countRows('inventory_valuation', 'sku = $1', [sku]), 0);
    const valuation = await makeRequest(
      port,
      'GET',
      `/api/v1/stock/${sku}/valuation`,
      undefined,
      managerHeaders,
    );
    if (valuation.status === 200) {
      const nonOwned = valuation.body['non_owned_quantities'] as Array<Record<string, unknown>>;
      assert.ok(
        nonOwned.some((n) => n['stock_class'] === 'job_work'),
        `job_work reported as non-owned: ${JSON.stringify(valuation.body)}`,
      );
    }

    // Pick generation (hard-filtered stock_class = 'owned') sees no stock for the lot.
    const so = await getAdminPool().query(
      `INSERT INTO erp_sales_order (so_number_ext, line_no, sku, quantity, ship_from_site_id, ship_from_site_code_ext, status, source_system, last_synced_at)
       VALUES ($1, 1, $2, 10, $3, 'site-A-9-2', 'open', 'ERP', now()) RETURNING id`,
      [`SO-JW-${run}`, sku, siteAId],
    );
    const pick = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      { dispatchOrderLineIds: [so.rows[0]!['id']], strategy: 'single' },
      managerHeaders,
    );
    assert.notStrictEqual(
      pick.status,
      201,
      `pick must not allocate job_work stock: ${JSON.stringify(pick.body)}`,
    );
    assert.strictEqual(Number((await balances(sku))[0]!['allocated']), 0);

    // A transfer request (owned-only source query) sees no stock either.
    const transfer = await makeRequest(
      port,
      'POST',
      '/api/v1/transfer-requests',
      {
        sku_id: sku,
        from_location_id: dockId,
        to_location_id: siteBId,
        quantity: 10,
        lot_id: lot,
        business_stream: 'job_work',
      },
      managerHeaders,
    );
    assert.notStrictEqual(
      transfer.status,
      201,
      `transfer must not allocate job_work stock: ${JSON.stringify(transfer.body)}`,
    );
    assert.strictEqual(Number((await balances(sku))[0]!['allocated']), 0);
  });

  it('AC4 / Task 4.3: a quarantine-required item lands in ZONE-QC-HOLD with a held putaway AND the custody row exists at receipt', async () => {
    const orderId = await confirmedOrder();
    const lot = `LOT-JW-Q-${run}`;
    const res = await receive({
      serviceOrderId: orderId,
      sku: SKU_Q,
      lotId: lot,
      receivedQty: '50',
      challanQty: '50',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const line = res.body['grn_line'] as Record<string, unknown>;
    assert.strictEqual(line['qc_hold'], true);
    assert.strictEqual(line['target_location_id'], qcZoneId);
    assert.strictEqual(line['stock_class'], 'job_work');
    const putaway = res.body['putaway_task'] as Record<string, unknown>;
    assert.strictEqual(putaway['status'], 'held');
    const rows = await balances(SKU_Q);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!['location_id'], qcZoneId);
    assert.strictEqual(rows[0]!['stock_class'], 'job_work');
    const custody = await receiptRows(orderId);
    assert.strictEqual(custody.length, 1);
    assert.strictEqual(custody[0]!['grn_line_id'], res.grnLineId);
    assert.strictEqual((await orderRow(orderId))['status'], 'in_process');
  });

  // -------------------------------------------------------------------------
  // AC 5: cross-issue blocked (total bar)
  // -------------------------------------------------------------------------

  it('AC5: any allocation or issue naming job_work stock is refused CROSS_ISSUE_BLOCKED with the demand context; no audit row (BSD-12 carve-out)', async () => {
    const sku = `SKU-AC5-${RUN}`;
    await seedItem(sku);
    const orderId = await confirmedOrder();
    const lot = `LOT-JW-AC5-${run}`;
    const res = await receive({
      serviceOrderId: orderId,
      sku,
      lotId: lot,
      receivedQty: '100',
      challanQty: '100',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const auditBefore = await auditCount('CROSS_ISSUE_BLOCKED');

    const allocation = await postEvent(
      stockEnvelope('stock.allocated', {
        sku,
        target_location_id: dockId,
        quantity: 10,
        lot_id: lot,
        stock_class: 'job_work',
        allocation_ref: `SO-${run}`,
      }),
    );
    assert.strictEqual(allocation.status, 400, JSON.stringify(allocation.body));
    assert.strictEqual(allocation.body['error_code'], 'CROSS_ISSUE_BLOCKED');
    let d = detailsOf(allocation.body);
    assert.strictEqual(d['sku'], sku);
    assert.strictEqual(d['stock_class'], 'job_work');
    assert.strictEqual(d['lot_id'], lot);
    assert.strictEqual(d['location_id'], dockId);
    assert.strictEqual(d['demand_kind'], 'allocation');

    const issue = await postEvent(
      stockEnvelope('stock.issued', {
        sku,
        target_location_id: dockId,
        quantity: 10,
        lot_id: lot,
        stock_class: 'job_work',
      }),
    );
    assert.strictEqual(issue.status, 400, JSON.stringify(issue.body));
    assert.strictEqual(issue.body['error_code'], 'CROSS_ISSUE_BLOCKED');
    d = detailsOf(issue.body);
    assert.strictEqual(d['demand_kind'], 'issue');

    // A classless drain defaults to 'owned' and never sees the customer material.
    const classless = await postEvent(
      stockEnvelope('stock.issued', { sku, target_location_id: dockId, quantity: 10, lot_id: lot }),
    );
    assert.strictEqual(classless.status, 409, JSON.stringify(classless.body));
    assert.strictEqual(classless.body['error_code'], 'INSUFFICIENT_STOCK');

    const rows = await balances(sku);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(Number(rows[0]!['on_hand']), 100);
    assert.strictEqual(Number(rows[0]!['allocated']), 0);
    assert.strictEqual(
      await auditCount('CROSS_ISSUE_BLOCKED'),
      auditBefore,
      'stock surface writes no audit row',
    );
    assert.strictEqual(
      await countRows(
        'domain_events',
        "event_type IN ('stock.allocated','stock.issued') AND payload->>'sku' = $1",
        [sku],
      ),
      0,
      'no demand event consumed an idempotency key',
    );
  });

  it('AC5 seam point (mutation guard): applyStockBalanceProjection itself refuses a job_work allocation before any balance read', async () => {
    const sku = `SKU-AC5S-${RUN}`;
    await seedItem(sku);
    const orderId = await confirmedOrder();
    const lot = `LOT-JW-AC5S-${run}`;
    const res = await receive({
      serviceOrderId: orderId,
      sku,
      lotId: lot,
      receivedQty: '100',
      challanQty: '100',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    for (const eventType of ['stock.allocated', 'stock.issued']) {
      const envelope = stockEnvelope(eventType, {
        sku,
        target_location_id: dockId,
        quantity: 1,
        lot_id: lot,
        stock_class: 'job_work',
      }) as unknown as EventEnvelope;
      await withRolledBackClient(async (client) => {
        await assert.rejects(
          applyStockBalanceProjection(envelope, client),
          (err: unknown) =>
            err instanceof AppError &&
            err.errorCode === 'CROSS_ISSUE_BLOCKED' &&
            err.statusCode === 400 &&
            (err.details as Record<string, unknown>)['demand_kind'] ===
              (eventType === 'stock.allocated' ? 'allocation' : 'issue'),
        );
      });
    }
  });

  // -------------------------------------------------------------------------
  // AC 6: lot-level segregation, both directions, plus the cycle-count path
  // -------------------------------------------------------------------------

  it('AC6: an owned receipt into a job_work lot, a job_work receipt into an owned lot, and a prototype receipt into a job_work lot all refuse', async () => {
    const sku = `SKU-AC6-${RUN}`;
    await seedItem(sku);
    const orderId = await confirmedOrder();
    const jwLot = `LOT-JW-AC6-${run}`;
    const res = await receive({
      serviceOrderId: orderId,
      sku,
      lotId: jwLot,
      receivedQty: '100',
      challanQty: '100',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    // owned -> job_work lot (direct stock.received, the Story 8.8 laundering pair idiom)
    const ownedIn = await postEvent(
      stockEnvelope('stock.received', {
        sku,
        target_location_id: dockId,
        quantity: 5,
        lot_id: jwLot,
      }),
    );
    assert.strictEqual(ownedIn.status, 400, JSON.stringify(ownedIn.body));
    assert.strictEqual(ownedIn.body['error_code'], 'CROSS_ISSUE_BLOCKED');
    assert.strictEqual(detailsOf(ownedIn.body)['existing_stock_class'], 'job_work');

    // owned -> job_work lot at ANOTHER location (lot-level bar)
    const ownedElsewhere = await postEvent(
      stockEnvelope('stock.received', {
        sku,
        target_location_id: qcZoneId,
        quantity: 5,
        lot_id: jwLot,
      }),
    );
    assert.strictEqual(ownedElsewhere.status, 400, JSON.stringify(ownedElsewhere.body));
    assert.strictEqual(ownedElsewhere.body['error_code'], 'CROSS_ISSUE_BLOCKED');

    // prototype -> job_work lot
    const protoIn = await postEvent(
      stockEnvelope('stock.received', {
        sku,
        target_location_id: dockId,
        quantity: 5,
        lot_id: jwLot,
        stock_class: 'prototype',
      }),
    );
    assert.strictEqual(protoIn.status, 400, JSON.stringify(protoIn.body));
    assert.strictEqual(protoIn.body['error_code'], 'CROSS_ISSUE_BLOCKED');

    // job_work -> owned lot, through the only legitimate job_work receipt path (the GRN flow)
    const ownedLot = `LOT-OWNED-AC6-${run}`;
    const ownedSeed = await postEvent(
      stockEnvelope('stock.received', {
        sku,
        target_location_id: dockId,
        quantity: 5,
        lot_id: ownedLot,
      }),
    );
    assert.strictEqual(ownedSeed.status, 201, JSON.stringify(ownedSeed.body));
    const jwIntoOwned = await receive({
      serviceOrderId: orderId,
      sku,
      lotId: ownedLot,
      receivedQty: '10',
      challanQty: '10',
    });
    assert.strictEqual(jwIntoOwned.status, 400, JSON.stringify(jwIntoOwned.body));
    assert.strictEqual(jwIntoOwned.body['error_code'], 'CROSS_ISSUE_BLOCKED');
    assert.strictEqual(detailsOf(jwIntoOwned.body)['existing_stock_class'], 'owned');
    assert.strictEqual(await countRows('grn_line', 'grn_line_id = $1', [jwIntoOwned.grnLineId]), 0);
    assert.strictEqual(
      await countRows('jobwork_material_receipt', 'grn_line_id = $1', [jwIntoOwned.grnLineId]),
      0,
    );

    const rows = await balances(sku);
    assert.deepStrictEqual(
      rows.map((r) => [r['stock_class'], r['lot_id'], Number(r['on_hand'])]),
      [
        ['job_work', jwLot, 100],
        ['owned', ownedLot, 5],
      ],
    );
  });

  it('AC6: a cycle-count adjustment cannot create an owned balance for a lot holding customer material', async () => {
    const sku = `SKU-AC6C-${RUN}`;
    await seedItem(sku);
    const orderId = await confirmedOrder();
    const jwLot = `LOT-JW-AC6C-${run}`;
    const res = await receive({
      serviceOrderId: orderId,
      sku,
      lotId: jwLot,
      receivedQty: '100',
      challanQty: '100',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    const create = await makeRequest(
      port,
      'POST',
      '/api/v1/cycle-counts',
      {
        location_id: dockId,
        sku_scope: [sku],
        count_type: 'cycle',
        business_date: '2026-09-03',
        business_stream: 'job_work',
      },
      storeHeaders,
    );
    assert.strictEqual(create.status, 201, JSON.stringify(create.body));
    const countId = create.body['cycle_count_id'] as string;
    // Counting 7 units of OWNED stock for the customer lot (book 0) is a +7 owned inflow. The
    // clerk submits; the DOA-resolved warehouse manager approves (a submitter cannot self-approve).
    const submit = await makeRequest(
      port,
      'POST',
      `/api/v1/cycle-counts/${countId}/submit`,
      { lines: [{ sku, lot_id: jwLot, stock_class: 'owned', counted_quantity: 7 }] },
      storeHeaders,
    );
    assert.strictEqual(submit.status, 201, JSON.stringify(submit.body));
    const line = (submit.body['lines'] as Array<Record<string, unknown>>)[0]!;
    assert.strictEqual(line['adjustment_status'], 'pending_approval', JSON.stringify(line));
    const approve = await makeRequest(
      port,
      'PATCH',
      `/api/v1/cycle-counts/${countId}/adjustments/${line['adjustment_id'] as string}/approve`,
      { reason_code: 'found_stock' },
      managerHeaders,
    );
    assert.strictEqual(approve.status, 400, JSON.stringify(approve.body));
    assert.strictEqual(approve.body['error_code'], 'CROSS_ISSUE_BLOCKED');
    assert.strictEqual(detailsOf(approve.body)['existing_stock_class'], 'job_work');
    const rows = await balances(sku);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!['stock_class'], 'job_work');
    assert.strictEqual(Number(rows[0]!['on_hand']), 100);
  });

  // -------------------------------------------------------------------------
  // AC 7: ownership binding fail-closed on every write path
  // -------------------------------------------------------------------------

  it('AC7: a supplied owner_party_code that does not match the order customer refuses OWNER_PARTY_MISMATCH, nothing written', async () => {
    const orderId = await confirmedOrder();
    const res = await receive({
      serviceOrderId: orderId,
      extra: { owner_party_code: 'SOMEONE-ELSE' },
    });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'OWNER_PARTY_MISMATCH');
    assert.strictEqual(detailsOf(res.body)['service_order_id'], orderId);
    assert.strictEqual(await countRows('grn_line', 'grn_line_id = $1', [res.grnLineId]), 0);
    assert.strictEqual((await orderRow(orderId))['status'], 'confirmed');
  });

  it('AC7: a direct stock.received in the job_work class via POST /api/v1/events is refused even with a valid order binding', async () => {
    const sku = `SKU-AC7-${RUN}`;
    await seedItem(sku);
    const orderId = await confirmedOrder();
    for (const payload of [
      // no binding at all
      {
        sku,
        target_location_id: dockId,
        quantity: 5,
        lot_id: `LOT-D1-${run}`,
        stock_class: 'job_work',
      },
      // full, correct binding - still not the receiving flow
      {
        sku,
        target_location_id: dockId,
        quantity: 5,
        lot_id: `LOT-D2-${run}`,
        stock_class: 'job_work',
        service_order_id: orderId,
        owner_party_code: CUSTOMER,
      },
    ]) {
      const res = await postEvent(stockEnvelope('stock.received', payload));
      assert.strictEqual(res.status, 409, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'SOURCE_DOCUMENT_REQUIRED');
    }
    assert.strictEqual(await countRows('stock_balance', 'sku = $1', [sku]), 0);
    assert.strictEqual((await orderRow(orderId))['status'], 'confirmed');
  });

  it('AC7: a direct jobwork.material_received via POST /api/v1/events cannot mint custody or flip the order without its posted job_work GRN line', async () => {
    const orderId = await confirmedOrder();
    const receiptEnvelope = (grnLineId: string): Record<string, unknown> => ({
      stream_type: 'jobwork',
      stream_id: orderId,
      event_type: 'jobwork.material_received',
      payload: {
        service_order_id: orderId,
        receipt_id: randomUUID(),
        grn_line_id: grnLineId,
        challan_number_ext: 'CH-DIRECT',
        challan_date: '2026-09-01',
        sku: SKU,
        lot_id: `LOT-DIRECT-${run}`,
        received_qty: '10.000',
        challan_qty: '10.000',
        uom: 'KG',
        site_id: siteAId,
        received_by: storeUserId,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: coordinatorUserId, role: 'jobwork_coordinator', location_id: siteAId },
        occurred_at: new Date().toISOString(),
      },
    });
    // Invented GRN line.
    const invented = await postEvent(receiptEnvelope(randomUUID()), coordinatorHeaders);
    assert.strictEqual(invented.status, 409, JSON.stringify(invented.body));
    assert.strictEqual(invented.body['error_code'], 'SOURCE_DOCUMENT_REQUIRED');
    assert.strictEqual(detailsOf(invented.body)['grn_line_found'], false);

    // A real OWNED GRN line borrowed from another receipt.
    const ownedPo = await seedPo(SKU_OWNED);
    const ownedToken = await seedToken(ownedPo);
    const ownedLineId = randomUUID();
    const ownedGrn = await makeRequest(
      port,
      'POST',
      '/api/v1/grn-lines',
      {
        grn_id: randomUUID(),
        grn_line_id: ownedLineId,
        correlation_id: ownedToken,
        po_ref_ext: ownedPo,
        line_no: 1,
        source_document: 'PO',
        sku: SKU_OWNED,
        target_location_code: DOCK_CODE,
        received_qty: '10',
        lot_id: `LOT-OWNED-${run}`,
      },
      storeHeaders,
    );
    assert.strictEqual(ownedGrn.status, 201, JSON.stringify(ownedGrn.body));
    const borrowed = await postEvent(receiptEnvelope(ownedLineId), coordinatorHeaders);
    assert.strictEqual(borrowed.status, 409, JSON.stringify(borrowed.body));
    assert.strictEqual(borrowed.body['error_code'], 'SOURCE_DOCUMENT_REQUIRED');
    assert.strictEqual(detailsOf(borrowed.body)['grn_line_stock_class'], 'owned');

    // Shape: the derived fields and an unknown key refuse pre-DB.
    const withDerived = receiptEnvelope(randomUUID());
    (withDerived['payload'] as Record<string, unknown>)['variance_flagged'] = false;
    const derived = await postEvent(withDerived, coordinatorHeaders);
    assert.strictEqual(derived.status, 400, JSON.stringify(derived.body));
    assert.strictEqual(derived.body['error_code'], 'INVALID_PARAMS');

    assert.strictEqual((await receiptRows(orderId)).length, 0);
    assert.strictEqual((await orderRow(orderId))['status'], 'confirmed');
    assert.strictEqual(
      await countRows(
        'domain_events',
        "event_type = 'jobwork.material_received' AND stream_id = $1",
        [orderId],
      ),
      0,
    );
  });

  it('AC7: a second custody receipt for the same GRN line refuses DUPLICATE_EVENT naming the constraint', async () => {
    const orderId = await confirmedOrder();
    const res = await receive({ serviceOrderId: orderId, receivedQty: '10', challanQty: '10' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const lot = (res.body['grn_line'] as Record<string, unknown>)['lot_id'] as string;
    const dup = await postEvent(
      {
        stream_type: 'jobwork',
        stream_id: orderId,
        event_type: 'jobwork.material_received',
        payload: {
          service_order_id: orderId,
          receipt_id: randomUUID(),
          grn_line_id: res.grnLineId,
          challan_number_ext: 'CH-DUP',
          challan_date: '2026-09-01',
          sku: SKU,
          lot_id: lot,
          received_qty: '10.000',
          challan_qty: '10.000',
          uom: 'KG',
          site_id: siteAId,
          received_by: storeUserId,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: coordinatorUserId, role: 'jobwork_coordinator', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      coordinatorHeaders,
    );
    assert.strictEqual(dup.status, 409, JSON.stringify(dup.body));
    assert.strictEqual(dup.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual(detailsOf(dup.body)['constraint'], 'uq_jobwork_receipt_grn_line');
    assert.strictEqual((await receiptRows(orderId)).length, 1);
  });

  // -------------------------------------------------------------------------
  // Task 7.4: idempotent replay
  // -------------------------------------------------------------------------

  it('Task 7.4: replaying jobwork.material_received with its idempotency key returns the stored event (200), one custody row, no double transition', async () => {
    const orderId = await confirmedOrder();
    const sku = `SKU-REPLAY-${RUN}`;
    await seedItem(sku);
    const lot = `LOT-REPLAY-${run}`;
    const first = await receive({
      serviceOrderId: orderId,
      sku,
      lotId: lot,
      receivedQty: '20',
      challanQty: '20',
    });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const inProcessAt = String((await orderRow(orderId))['in_process_at']);
    const stored = await getAdminPool().query(
      `SELECT event_id, idempotency_key, payload FROM domain_events
        WHERE event_type = 'jobwork.material_received' AND stream_id = $1`,
      [orderId],
    );
    assert.strictEqual(stored.rows.length, 1);
    const storedEventId = stored.rows[0]!['event_id'] as string;
    const idempotencyKey = stored.rows[0]!['idempotency_key'] as string;
    assert.strictEqual(idempotencyKey, `jobwork.material_received:${first.grnLineId}`);

    // The replay: the same custody event, same key, through the generic events route (the
    // findEventByIdempotencyKey lesson: persistEvent's short-circuit is the authority).
    const replay = await postEvent(
      {
        stream_type: 'jobwork',
        stream_id: orderId,
        event_type: 'jobwork.material_received',
        payload: {
          service_order_id: orderId,
          receipt_id: randomUUID(),
          grn_line_id: first.grnLineId,
          challan_number_ext: 'CH-REPLAY',
          challan_date: '2026-09-01',
          sku,
          lot_id: lot,
          received_qty: '20.000',
          challan_qty: '20.000',
          uom: 'KG',
          site_id: siteAId,
          received_by: storeUserId,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: coordinatorUserId, role: 'jobwork_coordinator', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: idempotencyKey,
      },
      coordinatorHeaders,
    );
    assert.ok(replay.status === 200 || replay.status === 201, JSON.stringify(replay.body));
    const replayed = (replay.body['event'] as Record<string, unknown> | undefined) ?? replay.body;
    assert.strictEqual(replayed['event_id'], storedEventId, JSON.stringify(replay.body));

    assert.strictEqual((await receiptRows(orderId)).length, 1);
    assert.strictEqual(String((await orderRow(orderId))['in_process_at']), inProcessAt);
    assert.strictEqual(Number((await balances(sku))[0]!['on_hand']), 20);
    assert.strictEqual(
      await countRows(
        'domain_events',
        "event_type = 'jobwork.material_received' AND stream_id = $1",
        [orderId],
      ),
      1,
    );
  });
});
