import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool, getPool } from '../../src/config/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  raw: string;
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
              parsed = { error_code: 'NON_JSON_BODY' };
            }
          }
          resolvePromise({ status: res.statusCode ?? 0, body: parsed, raw });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
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
 * Ruling B: customer-owned job-work material is received WITHOUT a purchase order, against the
 * job-work (service) order plus the customer's challan, and the weighbridge is optional. The
 * receipt rides the existing goods.received flow as a third source_document kind
 * ('JOBWORK_CHALLAN'), so every test goes through POST /grn-lines or the generic events door and
 * asserts the same projections a purchase-order GRN writes. Orders are created and confirmed
 * through the Story 9.1 routes. Run-scoped identifiers, no TRUNCATE (Story 3.8 harness).
 */
describe('Pilot Ruling B job-work receipt without a purchase order', () => {
  let server: Server;
  let port: number;
  let storeHeaders: Record<string, string>;
  let storeUserId: string;
  let supervisorHeaders: Record<string, string>;
  let supervisorId: string;
  let coordinatorHeaders: Record<string, string>;
  let coordinatorId: string;
  let kitBomId: string;

  const run = randomUUID().slice(0, 8);
  const RUN = run.toUpperCase();
  const siteId = randomUUID();
  const zoneId = randomUUID();
  const dockId = randomUUID();
  const otherSiteId = randomUUID();
  const siteCode = `RBSITE-${run}`;
  const dockCode = `RBDOCK-${run}`;
  const CUSTOMER = `CUST-RB-${RUN}`;
  const SKU = `RB-CUST-${run}`;
  const SKU_2 = `RB-CUST2-${run}`;
  const SKU_COMPANY = `RB-COMP-${run}`;
  const SKU_OFF_ORDER = `RB-OFF-${run}`;
  const SKU_OWNED = `RB-OWNED-${run}`;
  const SKU_OWNED_2 = `RB-OWNED2-${run}`;
  let buyerHeaders: Record<string, string>;
  let buyerId: string;
  let poSeq = 0;

  async function seedLocation(
    locationId: string,
    code: string,
    level: string,
    parentId: string | null,
    site: string = siteId,
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO location_register
         (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class,
          size_class, hazmat_allowed, quarantine, access_restricted, status)
       VALUES ($1, $2, $3, $4, $5, 'general', 'ambient', 'standard', false, false, false, 'active')`,
      [locationId, code, level, parentId, site],
    );
  }

  async function seedItem(sku: string, stream: string): Promise<void> {
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ($1, 'KG', false, false, false, false, false, 'weighted_average', $2, 'active')`,
      [sku, stream],
    );
  }

  /** A released job_work_kit BOM: two customer-supplied lines and one company-supplied line. */
  async function seedKitBom(): Promise<string> {
    const bomId = randomUUID();
    const revisionId = randomUUID();
    await getAdminPool().query(
      `INSERT INTO bom (bom_id, parent_item_id, parent_sku, parent_uom, business_stream, bom_type, status, current_revision_id, created_by, source_event_id)
       VALUES ($1, $2, $3, 'EA', 'job_work', 'job_work_kit', 'released', $4, $5, $6)`,
      [bomId, randomUUID(), `KIT-RB-${run}`, revisionId, coordinatorId, randomUUID()],
    );
    await getAdminPool().query(
      `INSERT INTO bom_revision (revision_id, bom_id, revision_code, revision_status, drafted_by, released_at, released_by, source_event_id)
       VALUES ($1, $2, 'A', 'released', $3, now(), $3, $4)`,
      [revisionId, bomId, coordinatorId, randomUUID()],
    );
    const lines: Array<[string, string | null]> = [
      [SKU, 'customer'],
      [SKU_2, null],
      [SKU_COMPANY, 'company'],
    ];
    let lineNo = 0;
    for (const [sku, supplySource] of lines) {
      await getAdminPool().query(
        `INSERT INTO bom_line (bom_line_id, revision_id, bom_id, line_no, component_item_id, component_sku, is_placeholder, free_text, output_class, quantity_per, line_uom, uom_conversion_factor, base_quantity_per, is_phantom, effective_from, supply_method, supply_source, source_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, false, NULL, 'component', '1.0', 'KG', '1.0', '1.0', false, '2020-01-01', 'directed_issue', $7, $8)`,
        [randomUUID(), revisionId, bomId, ++lineNo, randomUUID(), sku, supplySource, randomUUID()],
      );
    }
    return bomId;
  }

  async function createOrder(overrides: Record<string, unknown> = {}): Promise<string> {
    const create = await makeRequest(
      port,
      'POST',
      '/api/v1/service-orders',
      {
        site_id: siteId,
        customer_party_code: CUSTOMER,
        customer_name: 'Ruling B Fabrication Pvt Ltd',
        price_basis: { basis_type: 'per_kg', rate: 12.5, currency: 'INR' },
        kit_bom_id: kitBomId,
        idempotency_key: randomUUID(),
        ...overrides,
      },
      coordinatorHeaders,
    );
    assert.strictEqual(create.status, 201, `create order failed: ${JSON.stringify(create.body)}`);
    return (create.body['service_order'] as Record<string, unknown>)['service_order_id'] as string;
  }

  async function confirmedOrder(overrides: Record<string, unknown> = {}): Promise<string> {
    const orderId = await createOrder(overrides);
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

  function challanBody(
    serviceOrderId: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      grn_id: randomUUID(),
      grn_line_id: randomUUID(),
      source_document: 'JOBWORK_CHALLAN',
      stock_class: 'job_work',
      service_order_id: serviceOrderId,
      challan_number_ext: `CH-${run}-${randomUUID().slice(0, 6)}`,
      challan_date: '2026-09-15',
      challan_qty: '100',
      sku: SKU,
      target_location_code: dockCode,
      received_qty: '100',
      ...overrides,
    };
  }

  function strip(body: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
    const copy = { ...body };
    for (const key of keys) delete copy[key];
    return copy;
  }

  function receive(
    body: Record<string, unknown>,
    headers: Record<string, string> = storeHeaders,
  ): Promise<HttpResult> {
    return makeRequest(port, 'POST', '/api/v1/grn-lines', body, headers);
  }

  function postEvent(
    payload: Record<string, unknown>,
    headers: Record<string, string>,
    actor: { user_id: string; role: string },
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'receiving',
        stream_id: payload['grn_id'],
        event_type: 'goods.received',
        payload,
        metadata: {
          correlation_id: randomUUID(),
          actor: { ...actor, location_id: siteId },
          occurred_at: new Date().toISOString(),
        },
      },
      headers,
    );
  }

  async function seedTicket(
    status: 'accepted' | 'tolerance_breach',
    ticketSiteId: string = siteId,
  ): Promise<string> {
    const token = randomUUID();
    await getPool().query(
      `INSERT INTO weighbridge_event
        (weighbridge_event_id, correlation_id, gate_event_id, site_id, site_code_ext, po_ref_ext, line_no,
         tare_kg, gross_kg, net_kg, status, device_id, capture_method, weighed_by, business_date, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1000, 1100, 100, $7, 'WB-1', 'MANUAL', $8, '2026-09-15', $9)`,
      [
        randomUUID(),
        token,
        randomUUID(),
        ticketSiteId,
        siteCode,
        `RB-NOPO-${run}`,
        status,
        supervisorId,
        randomUUID(),
      ],
    );
    return token;
  }

  /** A fresh open PO line for the sku plus an accepted weighbridge ticket bound to it. */
  async function seedPo(sku: string, qty: number): Promise<{ poRef: string; token: string }> {
    const poRef = `RBPO-${run}-${++poSeq}`;
    await getPool().query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, expected_delivery_date, status, source_system, last_synced_at)
       VALUES ($1, 'SUP-1', 'INR', '2026-08-01', 'open', 'ERP', now())`,
      [poRef],
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, over_receipt_tolerance_pct, under_receipt_tolerance_pct, source_system, last_synced_at)
       VALUES ($1, 1, $2, $3, $3, 7, 5, 100, 'ERP', now())`,
      [poRef, sku, qty],
    );
    const token = randomUUID();
    await getPool().query(
      `INSERT INTO weighbridge_event
        (weighbridge_event_id, correlation_id, gate_event_id, site_id, site_code_ext, po_ref_ext, line_no,
         tare_kg, gross_kg, net_kg, status, device_id, capture_method, weighed_by, business_date, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1000, 1100, 100, 'accepted', 'WB-1', 'MANUAL', $7, '2026-09-15', $8)`,
      [randomUUID(), token, randomUUID(), siteId, siteCode, poRef, supervisorId, randomUUID()],
    );
    return { poRef, token };
  }

  function poBody(
    po: { poRef: string; token: string },
    sku: string,
    qty: number,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      grn_id: randomUUID(),
      grn_line_id: randomUUID(),
      correlation_id: po.token,
      po_ref_ext: po.poRef,
      line_no: 1,
      source_document: 'PO',
      sku,
      target_location_code: dockCode,
      received_qty: qty,
      ...overrides,
    };
  }

  const storeActor = (): { user_id: string; role: string } => ({
    user_id: storeUserId,
    role: 'store_assistant',
  });

  async function rowCount(table: string, where: string, params: unknown[]): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`,
      params,
    );
    return r.rows[0]!['n'] as number;
  }

  function errorCode(res: HttpResult): unknown {
    return res.body['error_code'];
  }

  before(async () => {
    // The Ruling B forward migration (idempotent) - applied here the way the Epic 9 suites apply
    // their own projection files, so the suite does not depend on a prior db:migrate run.
    await getAdminPool().query(
      readFileSync(resolve(__dirname, '../../read/projections/grn_jobwork_challan.sql'), 'utf-8'),
    );

    server = createAppServer();
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.off('error', reject);
        port = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    await seedLocation(siteId, siteCode, 'site', null);
    await seedLocation(zoneId, `RBZONE-${run}`, 'zone', siteId);
    await seedLocation(dockId, dockCode, 'bin', zoneId);
    await seedLocation(otherSiteId, `RBSITE2-${run}`, 'site', null, otherSiteId);
    for (const sku of [SKU, SKU_2, SKU_COMPANY, SKU_OFF_ORDER]) await seedItem(sku, 'job_work');
    await seedItem(SKU_OWNED, 'production');
    await seedItem(SKU_OWNED_2, 'production');

    storeUserId = await provisionUser(port, `rb-store-${run}@example.com`, [
      { role: 'store_assistant', module: 'receiving', functionScope: 'write', locationId: siteId },
      { role: 'store_assistant', module: 'warehouse', functionScope: 'write', locationId: siteId },
    ]);
    storeHeaders = await authFor(port, `rb-store-${run}@example.com`);
    supervisorId = await provisionUser(port, `rb-supervisor-${run}@example.com`, [
      {
        role: 'unloading_supervisor',
        module: 'receiving',
        functionScope: 'write',
        locationId: siteId,
      },
    ]);
    supervisorHeaders = await authFor(port, `rb-supervisor-${run}@example.com`);
    coordinatorId = await provisionUser(port, `rb-coordinator-${run}@example.com`, [
      { role: 'jobwork_coordinator', module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: 'jobwork_coordinator', module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    coordinatorHeaders = await authFor(port, `rb-coordinator-${run}@example.com`);
    buyerId = await provisionUser(port, `rb-buyer-${run}@example.com`, [
      {
        role: 'procurement_officer',
        module: 'procurement',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    buyerHeaders = await authFor(port, `rb-buyer-${run}@example.com`);
    kitBomId = await seedKitBom();
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('receives customer material with no purchase order and no weighbridge ticket', async () => {
    const orderId = await confirmedOrder();
    const body = challanBody(orderId, { lot_id: `RB-LOT-${run}` });
    const res = await receive(body);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    const grn = res.body['grn'] as Record<string, unknown>;
    assert.strictEqual(grn['source_document'], 'JOBWORK_CHALLAN');
    assert.strictEqual(grn['po_ref_ext'], null);
    assert.strictEqual(grn['site_id'], siteId);
    assert.strictEqual(grn['received_by'], storeUserId);
    const line = res.body['grn_line'] as Record<string, unknown>;
    assert.strictEqual(line['status'], 'posted');
    assert.strictEqual(line['stock_class'], 'job_work');
    assert.strictEqual(line['po_ref_ext'], null);
    assert.strictEqual(line['weighbridge_correlation_id'], null);

    // Downstream exactly as a purchase-order GRN: a ready putaway task at the dock, and the lot.
    const task = res.body['putaway_task'] as Record<string, unknown>;
    assert.strictEqual(task['status'], 'ready');
    assert.strictEqual(task['from_location_id'], dockId);
    assert.strictEqual(task['grn_line_id'], body['grn_line_id']);
    assert.strictEqual(
      await rowCount('lot_master', 'lot_number = $1 AND sku = $2', [`RB-LOT-${run}`, SKU]),
      1,
    );

    // Customer-owned and unvalued.
    const stock = await getAdminPool().query(
      `SELECT stock_class, on_hand::float AS on_hand FROM stock_balance
        WHERE sku = $1 AND location_id = $2 AND on_hand <> 0`,
      [SKU, dockId],
    );
    assert.strictEqual(stock.rows.length, 1, JSON.stringify(stock.rows));
    assert.strictEqual(stock.rows[0]!['stock_class'], 'job_work');
    assert.strictEqual(stock.rows[0]!['on_hand'], 100);
    // The owner is recorded on the custody ledger's opening movement (Story 9.3).
    const ledger = await getAdminPool().query(
      `SELECT ownership, customer_party_code, movement_category, quantity_delta::float AS qty
         FROM custody_ledger_entry WHERE service_order_id = $1`,
      [orderId],
    );
    assert.strictEqual(ledger.rows.length, 1, JSON.stringify(ledger.rows));
    assert.strictEqual(ledger.rows[0]!['ownership'], 'customer');
    assert.strictEqual(ledger.rows[0]!['customer_party_code'], CUSTOMER);
    assert.strictEqual(ledger.rows[0]!['movement_category'], 'receipt');
    assert.strictEqual(ledger.rows[0]!['qty'], 100);
    assert.strictEqual(await rowCount('inventory_valuation', 'sku = $1', [SKU]), 0);
    assert.strictEqual(await rowCount('inventory_valuation_fifo_layer', 'sku = $1', [SKU]), 0);

    // The Story 9.2 custody record and the first-receipt transition.
    const receipt = await getAdminPool().query(
      `SELECT challan_number_ext, to_char(challan_date, 'YYYY-MM-DD') AS challan_date, grn_line_id
         FROM jobwork_material_receipt WHERE service_order_id = $1`,
      [orderId],
    );
    assert.strictEqual(receipt.rows.length, 1);
    assert.strictEqual(receipt.rows[0]!['challan_number_ext'], body['challan_number_ext']);
    assert.strictEqual(receipt.rows[0]!['challan_date'], '2026-09-15');
    assert.strictEqual(receipt.rows[0]!['grn_line_id'], body['grn_line_id']);
    const order = await getAdminPool().query(
      `SELECT status FROM service_order WHERE service_order_id = $1`,
      [orderId],
    );
    assert.strictEqual(order.rows[0]!['status'], 'in_process');
  });

  it('refuses a receipt with no challan number or no challan date', async () => {
    const orderId = await confirmedOrder();
    for (const missing of ['challan_number_ext', 'challan_date']) {
      const body = strip(challanBody(orderId), missing);
      const res = await receive(body);
      assert.strictEqual(res.status, 409, `${missing}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(errorCode(res), 'SOURCE_DOCUMENT_REQUIRED');
      assert.strictEqual(await rowCount('grn_line', 'grn_line_id = $1', [body['grn_line_id']]), 0);
    }
  });

  it('refuses an unknown, draft, closed or other-site job-work order', async () => {
    const missingOrder = await receive(strip(challanBody(randomUUID()), 'service_order_id'));
    assert.strictEqual(missingOrder.status, 409, JSON.stringify(missingOrder.body));
    assert.strictEqual(errorCode(missingOrder), 'SOURCE_DOCUMENT_REQUIRED');

    const unknown = await receive(challanBody(randomUUID()));
    assert.strictEqual(unknown.status, 409, JSON.stringify(unknown.body));
    assert.strictEqual(errorCode(unknown), 'SOURCE_DOCUMENT_REQUIRED');

    const draft = await receive(challanBody(await createOrder()));
    assert.strictEqual(draft.status, 409, JSON.stringify(draft.body));
    assert.strictEqual(errorCode(draft), 'SOURCE_DOCUMENT_REQUIRED');

    const closedId = await confirmedOrder();
    await getAdminPool().query(
      `UPDATE service_order SET status = 'closed' WHERE service_order_id = $1`,
      [closedId],
    );
    const closed = await receive(challanBody(closedId));
    assert.strictEqual(closed.status, 409, JSON.stringify(closed.body));
    assert.strictEqual(errorCode(closed), 'SOURCE_DOCUMENT_REQUIRED');

    // The store assistant holds receiving write at siteId only.
    const otherSite = await receive(challanBody(await confirmedOrder({ site_id: otherSiteId })));
    assert.strictEqual(otherSite.status, 403, JSON.stringify(otherSite.body));
    assert.strictEqual(errorCode(otherSite), 'LOCATION_ACCESS_DENIED');
  });

  it('refuses an item the job-work order does not expect from the customer', async () => {
    const orderId = await confirmedOrder();
    for (const sku of [SKU_OFF_ORDER, SKU_COMPANY]) {
      const body = challanBody(orderId, { sku });
      const res = await receive(body);
      assert.strictEqual(res.status, 409, `${sku}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(errorCode(res), 'KIT_LINE_MISMATCH');
      assert.strictEqual(await rowCount('stock_balance', 'sku = $1', [sku]), 0);
    }

    // An untagged kit line counts as customer-supplied (the custody consumption rule).
    const untagged = await receive(challanBody(orderId, { sku: SKU_2 }));
    assert.strictEqual(untagged.status, 201, JSON.stringify(untagged.body));

    // A migrated order with no kit BOM names no expected items: nothing to hold the sku against.
    const migratedId = randomUUID();
    await getAdminPool().query(
      `INSERT INTO service_order (service_order_id, order_number_ext, customer_party_code, customer_name, status, has_contractual_offcut, site_id, business_stream, created_by, source_event_id)
       VALUES ($1, $2, $3, 'Migrated Customer', 'in_process', false, $4, 'job_work', $5, $6)`,
      [migratedId, `RB-MIG-${run}`, CUSTOMER, siteId, coordinatorId, randomUUID()],
    );
    const migrated = await receive(challanBody(migratedId, { sku: SKU_OFF_ORDER }));
    assert.strictEqual(migrated.status, 201, JSON.stringify(migrated.body));
  });

  it('refuses a duplicate challan for the same customer and item', async () => {
    const orderId = await confirmedOrder();
    const challan = `CH-DUP-${run}`;
    const first = await receive(challanBody(orderId, { challan_number_ext: challan }));
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const dupBody = challanBody(orderId, { challan_number_ext: challan });
    const dup = await receive(dupBody);
    assert.strictEqual(dup.status, 409, JSON.stringify(dup.body));
    assert.strictEqual(errorCode(dup), 'JOBWORK_CHALLAN_DUPLICATE');
    assert.strictEqual(await rowCount('grn_line', 'grn_line_id = $1', [dupBody['grn_line_id']]), 0);

    // The same paper challan keyed against ANOTHER order of the same customer is still a duplicate.
    const otherOrder = await receive(
      challanBody(await confirmedOrder(), { challan_number_ext: ` ${challan.toLowerCase()} ` }),
    );
    assert.strictEqual(otherOrder.status, 409, JSON.stringify(otherOrder.body));
    assert.strictEqual(errorCode(otherOrder), 'JOBWORK_CHALLAN_DUPLICATE');

    // A challan lists several items: the second SKU of the same challan is a new line.
    const secondSku = await receive(
      challanBody(orderId, { challan_number_ext: challan, sku: SKU_2 }),
    );
    assert.strictEqual(secondSku.status, 201, JSON.stringify(secondSku.body));
  });

  it('replays the original result for the same idempotency key', async () => {
    const orderId = await confirmedOrder();
    const key = `rb-replay-${randomUUID()}`;
    const body = challanBody(orderId, { idempotency_key: key });
    const first = await receive(body);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    // A client retry mints fresh ids but carries the same key.
    const retry = await receive({ ...body, grn_id: randomUUID(), grn_line_id: randomUUID() });
    assert.strictEqual(retry.status, 200, JSON.stringify(retry.body));
    assert.strictEqual(retry.body['replayed'], true);
    assert.strictEqual(
      (retry.body['grn_line'] as Record<string, unknown>)['grn_line_id'],
      body['grn_line_id'],
    );
    assert.strictEqual(
      (retry.body['putaway_task'] as Record<string, unknown>)['putaway_task_id'],
      (first.body['putaway_task'] as Record<string, unknown>)['putaway_task_id'],
    );
    assert.strictEqual(await rowCount('domain_events', 'idempotency_key = $1', [key]), 1);
    assert.strictEqual(
      await rowCount('jobwork_material_receipt', 'service_order_id = $1', [orderId]),
      1,
    );
  });

  it('refuses every supplied weighbridge ticket until the weighbridge supports job-work', async () => {
    const orderId = await confirmedOrder();

    // Every ticket issued today is bound to a purchase order (R7): it cannot vouch for a challan.
    const poBound = await receive(
      challanBody(orderId, { correlation_id: await seedTicket('accepted') }),
    );
    assert.strictEqual(poBound.status, 409, JSON.stringify(poBound.body));
    assert.strictEqual(errorCode(poBound), 'RECEIVING_TICKET_PO_BOUND');

    const unknown = await receive(challanBody(orderId, { correlation_id: randomUUID() }));
    assert.strictEqual(unknown.status, 404, JSON.stringify(unknown.body));
    assert.strictEqual(errorCode(unknown), 'RECEIVING_BINDING_TOKEN_NOT_FOUND');

    const breach = await receive(
      challanBody(orderId, { correlation_id: await seedTicket('tolerance_breach') }),
    );
    assert.strictEqual(breach.status, 409, JSON.stringify(breach.body));
    assert.strictEqual(errorCode(breach), 'RECEIVING_WEIGHT_NOT_ACCEPTED');

    const malformed = await receive(challanBody(orderId, { correlation_id: 'not-a-uuid' }));
    assert.strictEqual(malformed.status, 400, JSON.stringify(malformed.body));

    // A ticket weighed at another site: the route refuses on site scope, the seam on the mismatch.
    const otherSiteTicket = await seedTicket('accepted', otherSiteId);
    const restOther = await receive(challanBody(orderId, { correlation_id: otherSiteTicket }));
    assert.strictEqual(restOther.status, 403, JSON.stringify(restOther.body));
    assert.strictEqual(errorCode(restOther), 'LOCATION_ACCESS_DENIED');
    const doorOther = await postEvent(
      challanBody(orderId, { correlation_id: otherSiteTicket }),
      storeHeaders,
      storeActor(),
    );
    assert.strictEqual(doorOther.status, 409, JSON.stringify(doorOther.body));
    assert.strictEqual(errorCode(doorOther), 'SOURCE_DOCUMENT_REQUIRED');
    assert.strictEqual(
      await rowCount('jobwork_material_receipt', 'service_order_id = $1', [orderId]),
      0,
    );
  });

  it('never stores a caller-supplied correlation id on a ticketless receipt (R6)', async () => {
    const orderId = await confirmedOrder();
    const restBody = challanBody(orderId);
    const rest = await receive(restBody);
    assert.strictEqual(rest.status, 201, JSON.stringify(rest.body));
    assert.strictEqual((rest.body['grn'] as Record<string, unknown>)['correlation_id'], null);

    // The events door lets the caller choose metadata.correlation_id - here a real gate token.
    const doorBody = challanBody(orderId, { sku: SKU_2 });
    const door = await postEvent(doorBody, storeHeaders, storeActor());
    assert.strictEqual(door.status, 201, JSON.stringify(door.body));
    const grn = await getAdminPool().query(`SELECT correlation_id FROM grn WHERE grn_id = $1`, [
      doorBody['grn_id'],
    ]);
    assert.strictEqual(grn.rows[0]!['correlation_id'], null);
  });

  it('refuses linking a challan GRN to a purchase order (R1)', async () => {
    const orderId = await confirmedOrder();
    const body = challanBody(orderId);
    assert.strictEqual((await receive(body)).status, 201);

    const rest = await makeRequest(
      port,
      'POST',
      `/api/v1/grns/${body['grn_id'] as string}/link-po`,
      { po_id: randomUUID() },
      buyerHeaders,
    );
    assert.strictEqual(rest.status, 409, JSON.stringify(rest.body));
    assert.strictEqual(errorCode(rest), 'GRN_NOT_PO_RECEIPT');

    const door = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'procurement',
        stream_id: body['grn_id'],
        event_type: 'grn.po_linked',
        payload: { grn_id: body['grn_id'], po_id: randomUUID() },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: buyerId, role: 'procurement_officer', location_id: siteId },
          occurred_at: new Date().toISOString(),
        },
      },
      buyerHeaders,
    );
    assert.strictEqual(door.status, 409, JSON.stringify(door.body));
    assert.strictEqual(errorCode(door), 'GRN_NOT_PO_RECEIPT');
    const grn = await getAdminPool().query(`SELECT po_id FROM grn WHERE grn_id = $1`, [
      body['grn_id'],
    ]);
    assert.strictEqual(grn.rows[0]!['po_id'], null);
  });

  it('refuses a line whose GRN header is of another kind, order or purchase order (R3)', async () => {
    const orderId = await confirmedOrder();
    const challan = challanBody(orderId);
    assert.strictEqual((await receive(challan)).status, 201);
    const po = await seedPo(SKU_OWNED_2, 50);
    const poLine = poBody(po, SKU_OWNED_2, 20);
    assert.strictEqual((await receive(poLine)).status, 201);

    // A challan line onto the PO GRN, and a PO line onto the challan GRN.
    const onPoGrn = await receive(challanBody(orderId, { grn_id: poLine['grn_id'], sku: SKU_2 }));
    assert.strictEqual(onPoGrn.status, 409, JSON.stringify(onPoGrn.body));
    assert.strictEqual(errorCode(onPoGrn), 'GRN_HEADER_MISMATCH');
    const onChallanGrn = await receive(poBody(po, SKU_OWNED_2, 10, { grn_id: challan['grn_id'] }));
    assert.strictEqual(onChallanGrn.status, 409, JSON.stringify(onChallanGrn.body));
    assert.strictEqual(errorCode(onChallanGrn), 'GRN_HEADER_MISMATCH');

    // A challan line of ANOTHER order onto this order's GRN.
    const otherOrder = await receive(
      challanBody(await confirmedOrder(), { grn_id: challan['grn_id'], sku: SKU_2 }),
    );
    assert.strictEqual(otherOrder.status, 409, JSON.stringify(otherOrder.body));
    assert.strictEqual(errorCode(otherOrder), 'GRN_HEADER_MISMATCH');
    // A line of ANOTHER purchase order onto the PO GRN.
    const otherPo = await seedPo(SKU_OWNED_2, 50);
    const onOtherPo = await receive(poBody(otherPo, SKU_OWNED_2, 10, { grn_id: poLine['grn_id'] }));
    assert.strictEqual(onOtherPo.status, 409, JSON.stringify(onOtherPo.body));
    assert.strictEqual(errorCode(onOtherPo), 'GRN_HEADER_MISMATCH');

    // A legitimate second line on the same GRN of the same kind still works - both kinds.
    const secondChallan = await receive(
      challanBody(orderId, { grn_id: challan['grn_id'], sku: SKU_2 }),
    );
    assert.strictEqual(secondChallan.status, 201, JSON.stringify(secondChallan.body));
    const secondPo = await receive(poBody(po, SKU_OWNED_2, 30, { grn_id: poLine['grn_id'] }));
    assert.strictEqual(secondPo.status, 201, JSON.stringify(secondPo.body));
    assert.strictEqual(await rowCount('grn_line', 'grn_id = $1', [challan['grn_id']]), 2);
    assert.strictEqual(await rowCount('grn_line', 'grn_id = $1', [poLine['grn_id']]), 2);
  });

  it('answers a reused idempotency key by payload, not by key alone (R4)', async () => {
    const orderId = await confirmedOrder();
    const key = `rb-conflict-${randomUUID()}`;
    const body = challanBody(orderId, { idempotency_key: key });
    assert.strictEqual((await receive(body)).status, 201);

    const conflict = await receive({ ...body, grn_line_id: randomUUID(), received_qty: '90' });
    assert.strictEqual(conflict.status, 409, JSON.stringify(conflict.body));
    assert.strictEqual(errorCode(conflict), 'IDEMPOTENCY_KEY_CONFLICT');

    // A retry that re-sends the SAME ids is still a replay, never a second 201.
    const sameIds = await receive(body);
    assert.strictEqual(sameIds.status, 200, JSON.stringify(sameIds.body));
    assert.strictEqual(sameIds.body['replayed'], true);
    assert.strictEqual(await rowCount('domain_events', 'idempotency_key = $1', [key]), 1);
  });

  it('keys the duplicate challan on the lot: a multi-lot challan is received lot by lot (R5)', async () => {
    const orderId = await confirmedOrder();
    const challan = `CH-LOTS-${run}`;
    const lotA = await receive(
      challanBody(orderId, { challan_number_ext: challan, lot_id: `RB-HEAT-A-${run}` }),
    );
    assert.strictEqual(lotA.status, 201, JSON.stringify(lotA.body));
    const lotB = await receive(
      challanBody(orderId, { challan_number_ext: challan, lot_id: `RB-HEAT-B-${run}` }),
    );
    assert.strictEqual(lotB.status, 201, JSON.stringify(lotB.body));
    const lotAAgain = await receive(
      challanBody(orderId, { challan_number_ext: challan, lot_id: `RB-HEAT-A-${run}` }),
    );
    assert.strictEqual(lotAAgain.status, 409, JSON.stringify(lotAAgain.body));
    assert.strictEqual(errorCode(lotAAgain), 'JOBWORK_CHALLAN_DUPLICATE');
  });

  it('refuses a unit_cost or a cross-dock request on a challan receipt (R8, R9)', async () => {
    const orderId = await confirmedOrder();
    const priced = await receive(challanBody(orderId, { unit_cost: '12.50' }));
    assert.strictEqual(priced.status, 400, JSON.stringify(priced.body));
    assert.strictEqual(errorCode(priced), 'INVALID_PARAMS');
    const crossDock = await receive(
      challanBody(orderId, { cross_dock: true, staging_zone_code: `RBZONE-${run}` }),
    );
    assert.strictEqual(crossDock.status, 400, JSON.stringify(crossDock.body));
    assert.strictEqual(errorCode(crossDock), 'INVALID_PARAMS');
    assert.strictEqual(
      await rowCount('jobwork_material_receipt', 'service_order_id = $1', [orderId]),
      0,
    );
  });

  it('refuses the same challan through the purchase-order job_work path (R10)', async () => {
    const orderId = await confirmedOrder();
    const challan = `CH-BOTH-${run}`;
    const lot = `RB-BOTH-${run}`;
    const first = await receive(challanBody(orderId, { challan_number_ext: challan, lot_id: lot }));
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const po = await seedPo(SKU, 1000);
    const viaPo = await receive(
      poBody(po, SKU, 100, {
        stock_class: 'job_work',
        service_order_id: orderId,
        challan_number_ext: challan,
        challan_date: '2026-09-15',
        challan_qty: '100',
        lot_id: lot,
      }),
    );
    assert.strictEqual(viaPo.status, 409, JSON.stringify(viaPo.body));
    assert.strictEqual(errorCode(viaPo), 'JOBWORK_CHALLAN_DUPLICATE');
  });

  it('holds the duplicate, kit and closed-order refusals on the events door', async () => {
    const orderId = await confirmedOrder();
    const challan = `CH-DOOR-${run}`;
    const first = await postEvent(
      challanBody(orderId, { challan_number_ext: challan }),
      storeHeaders,
      storeActor(),
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const dup = await postEvent(
      challanBody(orderId, { challan_number_ext: challan }),
      storeHeaders,
      storeActor(),
    );
    assert.strictEqual(dup.status, 409, JSON.stringify(dup.body));
    assert.strictEqual(errorCode(dup), 'JOBWORK_CHALLAN_DUPLICATE');

    const kit = await postEvent(
      challanBody(orderId, { sku: SKU_COMPANY }),
      storeHeaders,
      storeActor(),
    );
    assert.strictEqual(kit.status, 409, JSON.stringify(kit.body));
    assert.strictEqual(errorCode(kit), 'KIT_LINE_MISMATCH');

    const closedId = await confirmedOrder();
    await getAdminPool().query(
      `UPDATE service_order SET status = 'closed' WHERE service_order_id = $1`,
      [closedId],
    );
    const closed = await postEvent(challanBody(closedId), storeHeaders, storeActor());
    assert.strictEqual(closed.status, 409, JSON.stringify(closed.body));
    assert.strictEqual(errorCode(closed), 'SOURCE_DOCUMENT_REQUIRED');
  });

  it('lets exactly one of two simultaneous identical challans through', async () => {
    const orderId = await confirmedOrder();
    const challan = `CH-RACE-${run}`;
    const results = await Promise.all([
      receive(challanBody(orderId, { challan_number_ext: challan })),
      receive(challanBody(orderId, { challan_number_ext: challan })),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepStrictEqual(statuses, [201, 409], JSON.stringify(results.map((r) => r.body)));
    assert.strictEqual(
      errorCode(results.find((r) => r.status === 409)!),
      'JOBWORK_CHALLAN_DUPLICATE',
    );
    assert.strictEqual(
      await rowCount('jobwork_material_receipt', 'service_order_id = $1', [orderId]),
      1,
    );
  });

  it('refuses an actor without the receiving role on the REST route and the events door', async () => {
    const orderId = await confirmedOrder();

    // No receiving assignment at all.
    const restBody = challanBody(orderId);
    const rest = await receive(restBody, coordinatorHeaders);
    assert.strictEqual(rest.status, 403, JSON.stringify(rest.body));
    const doorBody = challanBody(orderId);
    const door = await postEvent(doorBody, coordinatorHeaders, {
      user_id: coordinatorId,
      role: 'jobwork_coordinator',
    });
    assert.strictEqual(door.status, 403, JSON.stringify(door.body));

    // Receiving write, but not the store assistant role the GRN route is restricted to.
    const supRestBody = challanBody(orderId);
    const supRest = await receive(supRestBody, supervisorHeaders);
    assert.strictEqual(supRest.status, 403, JSON.stringify(supRest.body));
    assert.strictEqual(errorCode(supRest), 'FUNCTION_ACCESS_DENIED');
    const supDoorBody = challanBody(orderId);
    const supDoor = await postEvent(supDoorBody, supervisorHeaders, {
      user_id: supervisorId,
      role: 'unloading_supervisor',
    });
    assert.strictEqual(supDoor.status, 403, JSON.stringify(supDoor.body));
    assert.strictEqual(errorCode(supDoor), 'FUNCTION_ACCESS_DENIED');

    for (const body of [restBody, doorBody, supRestBody, supDoorBody]) {
      assert.strictEqual(await rowCount('grn_line', 'grn_line_id = $1', [body['grn_line_id']]), 0);
    }
    assert.strictEqual(
      await rowCount('jobwork_material_receipt', 'service_order_id = $1', [orderId]),
      0,
    );

    // The store assistant may use the events door, and the actor is the receiver of record.
    const okBody = challanBody(orderId, { received_by: supervisorId });
    const ok = await postEvent(okBody, storeHeaders, {
      user_id: storeUserId,
      role: 'store_assistant',
    });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    const grn = await getAdminPool().query(`SELECT received_by FROM grn WHERE grn_id = $1`, [
      okBody['grn_id'],
    ]);
    assert.strictEqual(grn.rows[0]!['received_by'], storeUserId);
  });

  it('refuses the new kind for owned stock or alongside a purchase order reference', async () => {
    const orderId = await confirmedOrder();
    const owned = await receive(challanBody(orderId, { stock_class: 'owned' }));
    assert.strictEqual(owned.status, 400, JSON.stringify(owned.body));
    assert.strictEqual(errorCode(owned), 'INVALID_PARAMS');
    const withPo = await receive(challanBody(orderId, { po_ref_ext: 'PO-1', line_no: 1 }));
    assert.strictEqual(withPo.status, 400, JSON.stringify(withPo.body));
    assert.strictEqual(errorCode(withPo), 'INVALID_PARAMS');
  });

  it('leaves purchase-order receiving exactly as it was', async () => {
    const poRef = `RBPO-${run}`;
    await getPool().query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, expected_delivery_date, status, source_system, last_synced_at)
       VALUES ($1, 'SUP-1', 'INR', '2026-08-01', 'open', 'ERP', now())`,
      [poRef],
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, over_receipt_tolerance_pct, under_receipt_tolerance_pct, source_system, last_synced_at)
       VALUES ($1, 1, $2, 50, 50, 7, 5, 100, 'ERP', now())`,
      [poRef, SKU_OWNED],
    );
    const token = randomUUID();
    await getPool().query(
      `INSERT INTO weighbridge_event
        (weighbridge_event_id, correlation_id, gate_event_id, site_id, site_code_ext, po_ref_ext, line_no,
         tare_kg, gross_kg, net_kg, status, device_id, capture_method, weighed_by, business_date, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1000, 1100, 100, 'accepted', 'WB-1', 'MANUAL', $7, '2026-09-15', $8)`,
      [randomUUID(), token, randomUUID(), siteId, siteCode, poRef, supervisorId, randomUUID()],
    );
    const poBody = {
      grn_id: randomUUID(),
      grn_line_id: randomUUID(),
      correlation_id: token,
      po_ref_ext: poRef,
      line_no: 1,
      source_document: 'PO',
      sku: SKU_OWNED,
      target_location_code: dockCode,
      received_qty: 50,
    };

    // The purchase order and the weighbridge ticket are still mandatory on a PO receipt.
    const noPo = await receive(strip(poBody, 'po_ref_ext'));
    assert.strictEqual(noPo.status, 400, JSON.stringify(noPo.body));
    assert.strictEqual(errorCode(noPo), 'INVALID_PARAMS');
    const noTicket = await receive(strip(poBody, 'correlation_id'));
    assert.strictEqual(noTicket.status, 400, JSON.stringify(noTicket.body));
    assert.strictEqual(errorCode(noTicket), 'RECEIVING_BINDING_TOKEN_REQUIRED');
    const unknownPo = await receive({ ...poBody, po_ref_ext: `RBPO-NONE-${run}` });
    assert.strictEqual(unknownPo.status, 404, JSON.stringify(unknownPo.body));
    assert.strictEqual(errorCode(unknownPo), 'RECEIVING_PO_NOT_FOUND');

    const res = await receive(poBody);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const grn = res.body['grn'] as Record<string, unknown>;
    assert.strictEqual(grn['source_document'], 'PO');
    assert.strictEqual(grn['po_ref_ext'], poRef);
    const line = res.body['grn_line'] as Record<string, unknown>;
    assert.strictEqual(line['po_ref_ext'], poRef);
    assert.strictEqual(line['line_no'], 1);
    assert.strictEqual(line['stock_class'], 'owned');
    assert.strictEqual(line['weighbridge_correlation_id'], token);
    assert.strictEqual((res.body['putaway_task'] as Record<string, unknown>)['status'], 'ready');
    // Owned GRNs still feed valuation at the PO price.
    const valuation = await getAdminPool().query(
      `SELECT quantity_on_hand::float AS qty, carrying_value::float AS value FROM inventory_valuation WHERE sku = $1`,
      [SKU_OWNED],
    );
    assert.strictEqual(valuation.rows.length, 1);
    assert.strictEqual(valuation.rows[0]!['qty'], 50);
    assert.strictEqual(valuation.rows[0]!['value'], 350);
  });
});
