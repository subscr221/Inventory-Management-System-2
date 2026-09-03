import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool } from '../../src/config/db.js';

/**
 * Story 9.3 Custody Ledger and Consumption (FR-JW-05, FR-JW-06, FR-JW-07).
 * Real PostgreSQL, the real production router, SCIM provisioning and dev-token auth. Tests run
 * serially; every identifier is run-scoped. Fixture writes use the admin pool (app_user lacks
 * DELETE). The harness scaffolding is a deliberate local re-implementation of the story-9-2
 * closures, which are not exported (never import cross-story).
 *
 * Customer material enters through the Story 9.2 receipt (POST /api/v1/grn-lines with
 * stock_class 'job_work' against a confirmed order), which now also opens the custody ledger.
 * Consumption and own-material postings ride the NEW custody stream.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);
const RUN = run.toUpperCase();

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  text: string;
  headers: Record<string, string | string[] | undefined>;
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
          resolvePromise({
            status: res.statusCode ?? 0,
            body: parsed,
            text: raw,
            headers: res.headers,
          });
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

describe('Story 9.3 Custody Ledger and Consumption', () => {
  let server: Server;
  let port: number;

  let storeUserId: string;
  let storeHeaders: Record<string, string>;
  let coordinatorUserId: string;
  let coordinatorHeaders: Record<string, string>;
  let engineerHeaders: Record<string, string>;
  let qcHeadHeaders: Record<string, string>;
  let siteBReaderHeaders: Record<string, string>;

  let siteAId: string;
  let siteBId: string;
  let dockId: string;
  let kitBomId: string;
  let kitRevisionId: string;
  let draftKitBomId: string;
  let draftKitRevisionId: string;
  let draftCompanyLineId: string;
  const lineIds: Record<string, string> = {};

  const CUSTOMER = `CUST-9-3-${RUN}`;
  const SKU = `SKU-CUST-${RUN}`;
  const SKU_COMPANY = `SKU-COMP-${RUN}`;
  const SKU_OFF = `SKU-OFF-${RUN}`;
  const SKU_PLACEHOLDER = `SKU-PLACEHOLDER-${RUN}`;
  const SKU_UNTAGGED = `SKU-UNTAG-${RUN}`;
  const SKU_OWNED = `SKU-OWNED-${RUN}`;
  const DOCK_CODE = `RECV-DOCK-9-3-${run}`;
  let poCounter = 0;

  // -------------------------------------------------------------------------
  // Fixture helpers
  // -------------------------------------------------------------------------

  async function seedLocation(
    level: string,
    code: string,
    siteId: string | null,
    extra: { zoneType?: string } = {},
  ): Promise<string> {
    const locationId = randomUUID();
    await getAdminPool().query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'ambient', false, 'active')`,
      [locationId, code, level, siteId, siteId ?? locationId, extra.zoneType ?? 'general'],
    );
    return locationId;
  }

  async function seedItem(sku: string): Promise<string> {
    const r = await getAdminPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ($1, 'KG', false, false, false, false, false, 'weighted_average', 'job_work', 'active')
       RETURNING item_id`,
      [sku],
    );
    return r.rows[0]!['item_id'] as string;
  }

  interface KitLine {
    key: string;
    sku: string | null;
    itemId: string | null;
    supplySource: 'company' | 'customer' | 'job_worker' | null;
    placeholder?: string;
  }

  /** A job_work_kit BOM with a current revision and the given lines; returns ids. */
  async function seedKitBom(
    status: 'released' | 'draft',
    lines: KitLine[],
    tag: string,
  ): Promise<{ bomId: string; revisionId: string; lineIds: Record<string, string> }> {
    const bomId = randomUUID();
    const revisionId = randomUUID();
    await getAdminPool().query(
      `INSERT INTO bom (bom_id, parent_item_id, parent_sku, parent_uom, business_stream, bom_type, status, current_revision_id, created_by, source_event_id)
       VALUES ($1, $2, $3, 'EA', 'job_work', 'job_work_kit', $4, $5, $6, $7)`,
      [
        bomId,
        randomUUID(),
        `KIT-9-3-${tag}-${run}`,
        status,
        revisionId,
        coordinatorUserId,
        randomUUID(),
      ],
    );
    await getAdminPool().query(
      `INSERT INTO bom_revision (revision_id, bom_id, revision_code, revision_status, drafted_by, released_at, released_by, source_event_id)
       VALUES ($1, $2, 'A', $3, $4, $5, $6, $7)`,
      [
        revisionId,
        bomId,
        status === 'released' ? 'released' : 'draft',
        coordinatorUserId,
        status === 'released' ? new Date().toISOString() : null,
        status === 'released' ? coordinatorUserId : null,
        randomUUID(),
      ],
    );
    const ids: Record<string, string> = {};
    let lineNo = 0;
    for (const line of lines) {
      lineNo += 1;
      const lineId = randomUUID();
      ids[line.key] = lineId;
      await getAdminPool().query(
        `INSERT INTO bom_line (bom_line_id, revision_id, bom_id, line_no, component_item_id, component_sku, is_placeholder, free_text, output_class, quantity_per, line_uom, uom_conversion_factor, base_quantity_per, is_phantom, effective_from, supply_method, supply_source, source_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'component', '1.0', 'KG', '1.0', '1.0', false, '2020-01-01', 'directed_issue', $9, $10)`,
        [
          lineId,
          revisionId,
          bomId,
          lineNo,
          line.itemId,
          line.sku,
          line.placeholder !== undefined,
          line.placeholder ?? null,
          line.supplySource,
          randomUUID(),
        ],
      );
    }
    return { bomId, revisionId, lineIds: ids };
  }

  async function seedPo(sku: string): Promise<string> {
    poCounter += 1;
    const poRef = `PO-JW-9-3-${run}-${poCounter}`;
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

  async function seedToken(poRef: string): Promise<string> {
    const token = randomUUID();
    await getAdminPool().query(
      `INSERT INTO weighbridge_event
        (weighbridge_event_id, correlation_id, gate_event_id, site_id, site_code_ext, po_ref_ext, line_no,
         tare_kg, gross_kg, net_kg, status, device_id, capture_method, weighed_by, business_date, source_event_id)
       VALUES ($1, $2, $3, $4, 'site-A-9-3', $5, 1, 1000, 2000, 1000, 'accepted', 'WB-9-3', 'MANUAL', $6, '2026-09-03', $7)`,
      [randomUUID(), token, randomUUID(), siteAId, poRef, coordinatorUserId, randomUUID()],
    );
    return token;
  }

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

  interface ReceiptOpts {
    sku?: string;
    receivedQty?: string;
    challanQty?: string;
    lotId?: string;
  }

  /** Posts a job_work GRN line against the order (the Story 9.2 receipt) and returns the lot. */
  async function receive(
    serviceOrderId: string,
    opts: ReceiptOpts = {},
  ): Promise<HttpResult & { grnLineId: string; lot: string }> {
    const sku = opts.sku ?? SKU;
    const poRef = await seedPo(sku);
    const token = await seedToken(poRef);
    const grnLineId = randomUUID();
    const lot = opts.lotId ?? `LOT-JW-${run}-${randomUUID().slice(0, 6)}`;
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/grn-lines',
      {
        grn_id: randomUUID(),
        grn_line_id: grnLineId,
        correlation_id: token,
        po_ref_ext: poRef,
        line_no: 1,
        source_document: 'PO',
        sku,
        target_location_code: DOCK_CODE,
        received_qty: opts.receivedQty ?? '1000',
        stock_class: 'job_work',
        lot_id: lot,
        service_order_id: serviceOrderId,
        challan_number_ext: `CH-${run}-${randomUUID().slice(0, 6)}`,
        challan_date: '2026-09-01',
        challan_qty: opts.challanQty ?? opts.receivedQty ?? '1000',
      },
      storeHeaders,
    );
    assert.strictEqual(res.status, 201, `receipt failed: ${JSON.stringify(res.body)}`);
    return { ...res, grnLineId, lot };
  }

  /** A confirmed order with one receipt (so it is in_process). */
  async function inProcessOrder(
    receipt: ReceiptOpts = {},
    overrides: Record<string, unknown> = {},
  ): Promise<{ orderId: string; lot: string }> {
    const orderId = await confirmedOrder(overrides);
    const r = await receive(orderId, receipt);
    return { orderId, lot: r.lot };
  }

  function consumptionBody(
    lot: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      sku: SKU,
      lot_id: lot,
      location_id: dockId,
      quantity: '100',
      uom: 'KG',
      idempotency_key: randomUUID(),
      ...extra,
    };
  }

  async function consume(
    orderId: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = coordinatorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/consumptions`,
      body,
      headers,
    );
  }

  async function ownMaterial(
    orderId: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = coordinatorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/own-material`,
      body,
      headers,
    );
  }

  async function statement(
    orderId: string,
    headers: Record<string, string> = coordinatorHeaders,
    query = '',
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'GET',
      `/api/v1/service-orders/${orderId}/custody-statement${query}`,
      undefined,
      headers,
    );
  }

  async function ledgerRows(orderId: string): Promise<Array<Record<string, unknown>>> {
    const r = await getAdminPool().query(
      `SELECT entry_id, movement_category, ownership, sku, lot_id, location_id,
              quantity_delta::text AS quantity_delta, uom, billable, bom_line_id, kit_bom_revision_id,
              receipt_id, variance_qty::text AS variance_qty, variance_flagged, site_id, posted_by,
              to_char(business_date, 'YYYY-MM-DD') AS business_date, source_event_id, source_event_type,
              customer_party_code
         FROM custody_ledger_entry WHERE service_order_id = $1
        ORDER BY occurred_at, created_at, entry_id`,
      [orderId],
    );
    return r.rows as Array<Record<string, unknown>>;
  }

  async function balance(
    sku: string,
    lot: string,
    stockClass = 'job_work',
  ): Promise<string | null> {
    const r = await getAdminPool().query(
      `SELECT on_hand::text AS on_hand FROM stock_balance
        WHERE sku = $1 AND lot_id = $2 AND stock_class = $3 AND location_id = $4`,
      [sku, lot, stockClass, dockId],
    );
    return (r.rows[0]?.['on_hand'] as string | undefined) ?? null;
  }

  async function traceRows(
    sku: string,
    lot: string,
    eventType: string,
  ): Promise<Array<Record<string, unknown>>> {
    const r = await getAdminPool().query(
      `SELECT t.event_id, t.event_type, t.quantity_change::text AS quantity_change, t.business_stream, t.location_id
         FROM lot_trace t JOIN lot_master m ON m.lot_id = t.lot_id
        WHERE m.lot_number = $1 AND m.sku = $2 AND t.event_type = $3`,
      [lot, sku, eventType],
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

  async function auditCount(errorCode: string): Promise<number> {
    return countRows('audit_log', 'error_code = $1', [errorCode]);
  }

  async function storedEvent(
    eventType: string,
    orderId: string,
  ): Promise<Record<string, unknown>[]> {
    const r = await getAdminPool().query(
      `SELECT event_id, idempotency_key, payload FROM domain_events
        WHERE event_type = $1 AND stream_id = $2 ORDER BY created_at`,
      [eventType, orderId],
    );
    return r.rows as Record<string, unknown>[];
  }

  function custodyEnvelope(
    eventType: string,
    orderId: string,
    payload: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      stream_type: 'custody',
      stream_id: orderId,
      event_type: eventType,
      payload: { service_order_id: orderId, ...payload },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: coordinatorUserId, role: 'jobwork_coordinator', location_id: siteAId },
        occurred_at: new Date().toISOString(),
      },
      ...extra,
    };
  }

  async function postEvent(
    envelope: Record<string, unknown>,
    headers: Record<string, string> = coordinatorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(port, 'POST', '/api/v1/events', envelope, headers);
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
      '../../read/projections/erp_purchase_order.sql',
      '../../read/projections/gate_event.sql',
      '../../read/projections/weighbridge_event.sql',
      '../../read/projections/grn.sql',
      '../../read/projections/grn_line.sql',
      '../../read/projections/putaway_task.sql',
      '../../read/projections/bom.sql',
      '../../read/projections/bom_revision.sql',
      '../../read/projections/bom_line.sql',
      '../../read/projections/qc_quality_hold.sql',
      '../../read/projections/service_order.sql',
      '../../read/projections/jobwork_material_receipt.sql',
      '../../read/projections/custody_ledger_entry.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
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

    siteAId = await seedLocation('site', `SITE-A-9-3-${run}`, null);
    siteBId = await seedLocation('site', `SITE-B-9-3-${run}`, null);
    dockId = await seedLocation('zone', DOCK_CODE, siteAId, { zoneType: 'staging' });
    const items: Record<string, string> = {};
    for (const sku of [SKU, SKU_COMPANY, SKU_OFF, SKU_PLACEHOLDER, SKU_UNTAGGED, SKU_OWNED]) {
      items[sku] = await seedItem(sku);
    }

    coordinatorUserId = await provisionUser(port, `jw-coordinator-9-3-${run}@example.com`, [
      { role: 'jobwork_coordinator', module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: 'jobwork_coordinator', module: 'jobwork', functionScope: 'read', locationId: '*' },
      // The generic events route maps module = stream_type; the direct-event arms need it.
      { role: 'jobwork_coordinator', module: 'custody', functionScope: 'write', locationId: '*' },
      { role: 'jobwork_coordinator', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    coordinatorHeaders = await authFor(port, `jw-coordinator-9-3-${run}@example.com`);

    storeUserId = await provisionUser(port, `jw-store-9-3-${run}@example.com`, [
      { role: 'store_assistant', module: 'receiving', functionScope: 'write', locationId: siteAId },
      { role: 'store_assistant', module: 'inventory', functionScope: 'write', locationId: '*' },
      { role: 'store_assistant', module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    storeHeaders = await authFor(port, `jw-store-9-3-${run}@example.com`);

    await provisionUser(port, `jw-engineer-9-3-${run}@example.com`, [
      { role: 'engineer', module: 'engineering', functionScope: 'write', locationId: '*' },
      { role: 'engineer', module: 'engineering', functionScope: 'read', locationId: '*' },
    ]);
    engineerHeaders = await authFor(port, `jw-engineer-9-3-${run}@example.com`);

    await provisionUser(port, `qc-head-9-3-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    qcHeadHeaders = await authFor(port, `qc-head-9-3-${run}@example.com`);

    await provisionUser(port, `jw-siteb-reader-9-3-${run}@example.com`, [
      { role: 'jobwork_reader', module: 'jobwork', functionScope: 'read', locationId: siteBId },
    ]);
    siteBReaderHeaders = await authFor(port, `jw-siteb-reader-9-3-${run}@example.com`);

    const kit = await seedKitBom(
      'released',
      [
        { key: 'customer', sku: SKU, itemId: items[SKU]!, supplySource: 'customer' },
        { key: 'company', sku: SKU_COMPANY, itemId: items[SKU_COMPANY]!, supplySource: 'company' },
        {
          key: 'placeholder',
          sku: null,
          itemId: null,
          supplySource: null,
          placeholder: SKU_PLACEHOLDER,
        },
        { key: 'untagged', sku: SKU_UNTAGGED, itemId: items[SKU_UNTAGGED]!, supplySource: null },
      ],
      'MAIN',
    );
    kitBomId = kit.bomId;
    kitRevisionId = kit.revisionId;
    Object.assign(lineIds, kit.lineIds);

    // A DRAFT kit BOM for the AC5 amendment arm: supply-source tagging (the Story 5.6 attributed
    // path) is only accepted on draft / on_hold BOMs, released revisions being immutable.
    const draft = await seedKitBom(
      'draft',
      [{ key: 'company', sku: SKU_COMPANY, itemId: items[SKU_COMPANY]!, supplySource: 'company' }],
      'DRAFT',
    );
    draftKitBomId = draft.bomId;
    draftKitRevisionId = draft.revisionId;
    draftCompanyLineId = draft.lineIds['company']!;
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 1: receipts open the ledger
  // -------------------------------------------------------------------------

  it('AC1: every 9.2 receipt produces exactly one receipt ledger row carrying the variance and the receiver', async () => {
    const orderId = await confirmedOrder();
    const first = await receive(orderId, { receivedQty: '1000', challanQty: '1000' });
    const second = await receive(orderId, { receivedQty: '1100', challanQty: '1000' });

    const rows = await ledgerRows(orderId);
    assert.strictEqual(rows.length, 2, JSON.stringify(rows));
    for (const row of rows) {
      assert.strictEqual(row['movement_category'], 'receipt');
      assert.strictEqual(row['ownership'], 'customer');
      assert.strictEqual(row['billable'], false);
      assert.strictEqual(row['customer_party_code'], CUSTOMER);
      assert.strictEqual(row['posted_by'], storeUserId);
      assert.strictEqual(row['site_id'], siteAId);
      assert.strictEqual(row['source_event_type'], 'jobwork.material_received');
      assert.match(String(row['business_date']), /^\d{4}-\d{2}-\d{2}$/);
    }
    assert.strictEqual(rows[0]!['lot_id'], first.lot);
    assert.strictEqual(rows[0]!['quantity_delta'], '1000.000');
    assert.strictEqual(rows[0]!['variance_qty'], '0.000');
    assert.strictEqual(rows[0]!['variance_flagged'], false);
    assert.strictEqual(rows[1]!['lot_id'], second.lot);
    assert.strictEqual(rows[1]!['quantity_delta'], '1100.000');
    assert.strictEqual(rows[1]!['variance_qty'], '100.000');
    assert.strictEqual(rows[1]!['variance_flagged'], true);

    // Keyed by the receipt's own event and receipt row (same transaction, no second event).
    const receipts = await getAdminPool().query(
      `SELECT receipt_id, source_event_id FROM jobwork_material_receipt WHERE service_order_id = $1 ORDER BY created_at`,
      [orderId],
    );
    assert.strictEqual(rows[0]!['receipt_id'], receipts.rows[0]!['receipt_id']);
    assert.strictEqual(rows[0]!['source_event_id'], receipts.rows[0]!['source_event_id']);
    assert.strictEqual(rows[1]!['receipt_id'], receipts.rows[1]!['receipt_id']);
    assert.strictEqual(
      await countRows('domain_events', "stream_type = 'custody' AND stream_id = $1", [orderId]),
      0,
    );
  });

  // -------------------------------------------------------------------------
  // AC 3: consumption happy path
  // -------------------------------------------------------------------------

  it('AC3: a consumption drains the job_work lot, writes a negative ledger row, appends a lot_trace entry and lowers the running balance in one transaction', async () => {
    const { orderId, lot } = await inProcessOrder({ receivedQty: '1000' });
    const consumptionId = randomUUID();
    const res = await consume(
      orderId,
      consumptionBody(lot, { quantity: '100.250', consumption_id: consumptionId }),
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['consumption_id'], consumptionId);
    assert.strictEqual(res.body['custody_balance_after'], '899.750');
    const entry = res.body['entry'] as Record<string, unknown>;
    assert.strictEqual(entry['movement_category'], 'consumption');
    assert.strictEqual(entry['quantity_delta'], '-100.250');
    assert.strictEqual(entry['bom_line_id'], lineIds['customer']);
    assert.strictEqual(entry['kit_bom_revision_id'], kitRevisionId);
    assert.strictEqual(entry['posted_by'], coordinatorUserId);
    assert.strictEqual(entry['ownership'], 'customer');
    assert.strictEqual(entry['location_id'], dockId);

    assert.strictEqual(await balance(SKU, lot), '899.750000');
    const rows = await ledgerRows(orderId);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[1]!['entry_id'], consumptionId);
    assert.strictEqual(rows[1]!['source_event_type'], 'custody.consumption_posted');

    const [ev] = await storedEvent('custody.consumption_posted', orderId);
    assert.ok(ev, 'custody event stored');
    const payload = ev!['payload'] as Record<string, unknown>;
    assert.strictEqual(payload['bom_line_id'], lineIds['customer']);
    assert.strictEqual(payload['kit_bom_revision_id'], kitRevisionId);
    assert.strictEqual(payload['custody_balance_after'], '899.750');
    assert.strictEqual(payload['posted_by'], coordinatorUserId);
    assert.strictEqual(payload['site_id'], siteAId);
    assert.strictEqual(rows[1]!['source_event_id'], ev!['event_id']);

    const trace = await traceRows(SKU, lot, 'custody.consumption_posted');
    assert.strictEqual(trace.length, 1, JSON.stringify(trace));
    assert.strictEqual(trace[0]!['event_id'], ev!['event_id']);
    // lot_trace.quantity_change is NUMERIC(18,6) (the Story 2.3 grain).
    assert.strictEqual(trace[0]!['quantity_change'], '-100.250000');
    assert.strictEqual(trace[0]!['business_stream'], 'job_work');
    assert.strictEqual(trace[0]!['location_id'], dockId);

    // The raw ledger route lists both rows in statement order with the closing balance.
    const ledger = await makeRequest(
      port,
      'GET',
      `/api/v1/service-orders/${orderId}/custody-ledger`,
      undefined,
      storeHeaders,
    );
    assert.strictEqual(ledger.status, 200, JSON.stringify(ledger.body));
    const entries = ledger.body['entries'] as Array<Record<string, unknown>>;
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0]!['movement_category'], 'receipt');
    assert.strictEqual(entries[1]!['movement_category'], 'consumption');
    assert.deepStrictEqual(ledger.body['closing_balances'], [
      { sku: SKU, uom: 'KG', balance: '899.750' },
    ]);
  });

  // -------------------------------------------------------------------------
  // AC 2: the statement
  // -------------------------------------------------------------------------

  it('AC2: the custody statement carries running balances, receipt variance, closing totals, a text rendering, and is site-scoped with 404-vs-403 collapsed', async () => {
    const orderId = await confirmedOrder();
    const a = await receive(orderId, { receivedQty: '1000', challanQty: '1000' });
    const b = await receive(orderId, { receivedQty: '500', challanQty: '480' });
    const c1 = await consume(orderId, consumptionBody(a.lot, { quantity: '250.5' }));
    assert.strictEqual(c1.status, 201, JSON.stringify(c1.body));
    const c2 = await consume(orderId, consumptionBody(b.lot, { quantity: '0.5' }));
    assert.strictEqual(c2.status, 201, JSON.stringify(c2.body));

    const res = await statement(orderId, storeHeaders);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const st = res.body['statement'] as Record<string, unknown>;
    const header = st['header'] as Record<string, unknown>;
    assert.strictEqual(header['service_order_id'], orderId);
    assert.strictEqual(header['customer_party_code'], CUSTOMER);
    assert.strictEqual(header['customer_name'], 'Acme Fabrication Pvt Ltd');
    assert.strictEqual(header['site_id'], siteAId);
    assert.match(String(header['order_number_ext']), /\S/);
    assert.match(String(header['business_date']), /^\d{4}-\d{2}-\d{2}$/);

    const lines = st['lines'] as Array<Record<string, unknown>>;
    assert.deepStrictEqual(
      lines.map((l) => [l['movement_category'], l['quantity_delta'], l['running_balance']]),
      [
        ['receipt', '1000.000', '1000.000'],
        ['receipt', '500.000', '1500.000'],
        ['consumption', '-250.500', '1249.500'],
        ['consumption', '-0.500', '1249.000'],
      ],
    );
    assert.strictEqual(lines[1]!['variance_qty'], '20.000');
    assert.strictEqual(lines[1]!['variance_flagged'], true);
    assert.strictEqual(lines[1]!['posted_by'], storeUserId);
    assert.strictEqual(lines[0]!['variance_flagged'], false);
    assert.deepStrictEqual(st['closing_balances'], [{ sku: SKU, uom: 'KG', balance: '1249.000' }]);
    assert.strictEqual(st['total_customer_balance'], '1249.000');
    assert.deepStrictEqual(st['own_material'], []);
    assert.strictEqual(st['own_material_total'], '0.000');

    const text = await statement(orderId, storeHeaders, '?format=text');
    assert.strictEqual(text.status, 200, text.text);
    assert.match(String(text.headers['content-type']), /^text\/plain; charset=utf-8/);
    assert.ok(text.text.includes('CUSTODY STATEMENT'));
    assert.ok(text.text.includes(CUSTOMER));
    assert.ok(text.text.includes('1249.000'));
    assert.ok(text.text.includes('FLAGGED'));
    assert.ok(text.text.includes('OWN MATERIAL'));

    const bad = await statement(orderId, storeHeaders, '?format=pdf');
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body['error_code'], 'INVALID_PARAMS');

    // Site scoping: a site-B reader gets the same 404 as for a missing order.
    const denied = await statement(orderId, siteBReaderHeaders);
    assert.strictEqual(denied.status, 404, JSON.stringify(denied.body));
    assert.strictEqual(denied.body['error_code'], 'SERVICE_ORDER_NOT_FOUND');
    const missing = await statement(randomUUID(), coordinatorHeaders);
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.body['error_code'], 'SERVICE_ORDER_NOT_FOUND');
    assert.deepStrictEqual(
      Object.keys(detailsOf(denied.body)),
      Object.keys(detailsOf(missing.body)),
    );
    const deniedLedger = await makeRequest(
      port,
      'GET',
      `/api/v1/service-orders/${orderId}/custody-ledger`,
      undefined,
      siteBReaderHeaders,
    );
    assert.strictEqual(deniedLedger.status, 404);
  });

  // -------------------------------------------------------------------------
  // AC 4: over-balance and physical shortfall
  // -------------------------------------------------------------------------

  it('AC4: an over-balance consumption refuses INSUFFICIENT_STOCK from the ledger with no row written; a physical shortfall refuses from the stock surface, fully rolled back', async () => {
    const orderId = await confirmedOrder();
    const a = await receive(orderId, { receivedQty: '100' });
    const b = await receive(orderId, { receivedQty: '100' });
    const before = await auditCount('INSUFFICIENT_STOCK');

    // Custody balance is 200 for the sku: 200.001 exceeds it (derived in-transaction).
    const over = await consume(orderId, consumptionBody(a.lot, { quantity: '200.001' }));
    assert.strictEqual(over.status, 409, JSON.stringify(over.body));
    assert.strictEqual(over.body['error_code'], 'INSUFFICIENT_STOCK');
    assert.deepStrictEqual(detailsOf(over.body), {
      service_order_id: orderId,
      sku: SKU,
      requested_qty: '200.001',
      custody_balance_qty: '200.000',
    });

    // Custody balance (200) covers 150, but lot A physically holds 100: the stock surface refuses.
    const shortfall = await consume(orderId, consumptionBody(a.lot, { quantity: '150' }));
    assert.strictEqual(shortfall.status, 409, JSON.stringify(shortfall.body));
    assert.strictEqual(shortfall.body['error_code'], 'INSUFFICIENT_STOCK');
    assert.strictEqual(detailsOf(shortfall.body)['lot_id'], a.lot);
    assert.strictEqual(detailsOf(shortfall.body)['stock_class'], 'job_work');
    assert.strictEqual(detailsOf(shortfall.body)['custody_balance_qty'], undefined);

    // Nothing written by either refusal.
    assert.strictEqual((await ledgerRows(orderId)).length, 2);
    assert.strictEqual(await balance(SKU, a.lot), '100.000000');
    assert.strictEqual(await balance(SKU, b.lot), '100.000000');
    assert.strictEqual((await traceRows(SKU, a.lot, 'custody.consumption_posted')).length, 0);
    assert.strictEqual((await storedEvent('custody.consumption_posted', orderId)).length, 0);
    assert.strictEqual(await auditCount('INSUFFICIENT_STOCK'), before + 2);

    // Exactly the balance is allowed (boundary inclusive), across the two lots.
    const exactA = await consume(orderId, consumptionBody(a.lot, { quantity: '100' }));
    assert.strictEqual(exactA.status, 201, JSON.stringify(exactA.body));
    const exactB = await consume(orderId, consumptionBody(b.lot, { quantity: '100.000' }));
    assert.strictEqual(exactB.status, 201, JSON.stringify(exactB.body));
    assert.strictEqual(exactB.body['custody_balance_after'], '0.000');
    const nothingLeft = await consume(orderId, consumptionBody(b.lot, { quantity: '0.001' }));
    assert.strictEqual(nothingLeft.status, 409);
    assert.strictEqual(nothingLeft.body['error_code'], 'INSUFFICIENT_STOCK');
    assert.strictEqual(detailsOf(nothingLeft.body)['custody_balance_qty'], '0.000');
  });

  // -------------------------------------------------------------------------
  // AC 5: kit-line gate
  // -------------------------------------------------------------------------

  it('AC5: off-kit, company-tagged and placeholder skus refuse KIT_LINE_MISMATCH; an untagged line matches and is recorded as untagged', async () => {
    const orderId = await confirmedOrder();
    const off = await receive(orderId, { sku: SKU_OFF, receivedQty: '10' });
    const company = await receive(orderId, { sku: SKU_COMPANY, receivedQty: '10' });
    const placeholder = await receive(orderId, { sku: SKU_PLACEHOLDER, receivedQty: '10' });
    const untagged = await receive(orderId, { sku: SKU_UNTAGGED, receivedQty: '10' });
    const before = await auditCount('KIT_LINE_MISMATCH');

    for (const [sku, lot] of [
      [SKU_OFF, off.lot],
      [SKU_COMPANY, company.lot],
      [SKU_PLACEHOLDER, placeholder.lot],
    ] as const) {
      const res = await consume(orderId, consumptionBody(lot, { sku, quantity: '1' }));
      assert.strictEqual(res.status, 409, `${sku}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'KIT_LINE_MISMATCH');
      assert.deepStrictEqual(detailsOf(res.body), {
        service_order_id: orderId,
        kit_bom_id: kitBomId,
        kit_bom_revision_id: kitRevisionId,
        sku,
      });
      assert.strictEqual(await balance(sku, lot), '10.000000');
    }
    assert.strictEqual(
      (await ledgerRows(orderId)).filter((r) => r['movement_category'] === 'consumption').length,
      0,
    );
    assert.strictEqual(await auditCount('KIT_LINE_MISMATCH'), before + 3);

    const ok = await consume(
      orderId,
      consumptionBody(untagged.lot, { sku: SKU_UNTAGGED, quantity: '4' }),
    );
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual(
      (ok.body['entry'] as Record<string, unknown>)['bom_line_id'],
      lineIds['untagged'],
    );
    const [ev] = await storedEvent('custody.consumption_posted', orderId);
    assert.strictEqual((ev!['payload'] as Record<string, unknown>)['supply_source_untagged'], true);
  });

  it('AC5: after the kit line is re-tagged through the attributed bom.job_work_kit_tagged path, the same posting succeeds and records the matched line and revision', async () => {
    const { orderId, lot } = await inProcessOrder(
      { sku: SKU_COMPANY, receivedQty: '10' },
      { kit_bom_id: draftKitBomId },
    );
    const body = consumptionBody(lot, { sku: SKU_COMPANY, quantity: '3' });

    const refused = await consume(orderId, body);
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.strictEqual(refused.body['error_code'], 'KIT_LINE_MISMATCH');
    assert.strictEqual(detailsOf(refused.body)['kit_bom_revision_id'], draftKitRevisionId);

    const tagged = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${draftKitBomId}/job-work-kit-tags`,
      { tags: [{ bom_line_id: draftCompanyLineId, supply_source: 'customer' }] },
      engineerHeaders,
    );
    assert.ok(tagged.status === 200 || tagged.status === 201, JSON.stringify(tagged.body));

    // The SAME posting (a fresh key: the refusal consumed nothing) now resolves the current revision.
    const accepted = await consume(orderId, { ...body, idempotency_key: randomUUID() });
    assert.strictEqual(accepted.status, 201, JSON.stringify(accepted.body));
    const entry = accepted.body['entry'] as Record<string, unknown>;
    assert.strictEqual(entry['bom_line_id'], draftCompanyLineId);
    assert.strictEqual(entry['kit_bom_revision_id'], draftKitRevisionId);
    assert.strictEqual(await balance(SKU_COMPANY, lot), '7.000000');
  });

  // -------------------------------------------------------------------------
  // AC 6: own material
  // -------------------------------------------------------------------------

  it('AC6: own material drains owned stock, is ledgered processor-owned and billable, stays out of the customer balance, and prints in its own statement section', async () => {
    const { orderId, lot } = await inProcessOrder({ receivedQty: '50' });
    const ownedLot = `LOT-OWN-${run}-${randomUUID().slice(0, 6)}`;
    const seed = await postEvent(
      {
        stream_type: 'inventory',
        stream_id: randomUUID(),
        event_type: 'stock.received',
        payload: {
          business_stream: 'job_work',
          sku: SKU_OWNED,
          target_location_id: dockId,
          quantity: 20,
          lot_id: ownedLot,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: storeUserId, role: 'store_assistant', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      storeHeaders,
    );
    assert.strictEqual(seed.status, 201, JSON.stringify(seed.body));

    const ownId = randomUUID();
    const res = await ownMaterial(orderId, {
      own_material_id: ownId,
      sku: SKU_OWNED,
      lot_id: ownedLot,
      location_id: dockId,
      quantity: '5.5',
      uom: 'KG',
      idempotency_key: randomUUID(),
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['own_material_id'], ownId);
    const entry = res.body['entry'] as Record<string, unknown>;
    assert.strictEqual(entry['movement_category'], 'own_material');
    assert.strictEqual(entry['ownership'], 'processor');
    assert.strictEqual(entry['billable'], true);
    assert.strictEqual(entry['quantity_delta'], '5.500');
    assert.strictEqual(entry['posted_by'], coordinatorUserId);
    assert.strictEqual(await balance(SKU_OWNED, ownedLot, 'owned'), '14.500000');

    // Excluded from the customer balance: the SQL SUM over ownership = 'customer' sees nothing.
    const sum = await getAdminPool().query(
      `SELECT COALESCE(SUM(quantity_delta), 0)::text AS b FROM custody_ledger_entry
        WHERE service_order_id = $1 AND sku = $2 AND ownership = 'customer'`,
      [orderId, SKU_OWNED],
    );
    assert.strictEqual(sum.rows[0]!['b'], '0');
    const trace = await traceRows(SKU_OWNED, ownedLot, 'custody.own_material_added');
    assert.strictEqual(trace.length, 1);
    assert.strictEqual(trace[0]!['quantity_change'], '-5.500000');

    const st = (await statement(orderId)).body['statement'] as Record<string, unknown>;
    assert.deepStrictEqual(st['closing_balances'], [{ sku: SKU, uom: 'KG', balance: '50.000' }]);
    assert.strictEqual(st['total_customer_balance'], '50.000');
    const own = st['own_material'] as Array<Record<string, unknown>>;
    assert.strictEqual(own.length, 1);
    assert.strictEqual(own[0]!['entry_id'], ownId);
    assert.strictEqual(st['own_material_total'], '5.500');
    assert.strictEqual((st['lines'] as unknown[]).length, 1);
    const text = await statement(orderId, coordinatorHeaders, '?format=text');
    assert.ok(text.text.includes(SKU_OWNED));
    assert.ok(text.text.indexOf('OWN MATERIAL (processor-owned') < text.text.indexOf(SKU_OWNED));

    // A supplied bom_line_id must be a processor-supplied kit line: company matches, customer refuses.
    const withLine = await ownMaterial(orderId, {
      sku: SKU_OWNED,
      lot_id: ownedLot,
      location_id: dockId,
      quantity: '1',
      uom: 'KG',
      bom_line_id: lineIds['company'],
      idempotency_key: randomUUID(),
    });
    assert.strictEqual(withLine.status, 201, JSON.stringify(withLine.body));
    assert.strictEqual(
      (withLine.body['entry'] as Record<string, unknown>)['kit_bom_revision_id'],
      kitRevisionId,
    );
    const wrongLine = await ownMaterial(orderId, {
      sku: SKU_OWNED,
      lot_id: ownedLot,
      location_id: dockId,
      quantity: '1',
      uom: 'KG',
      bom_line_id: lineIds['customer'],
      idempotency_key: randomUUID(),
    });
    assert.strictEqual(wrongLine.status, 409, JSON.stringify(wrongLine.body));
    assert.strictEqual(wrongLine.body['error_code'], 'KIT_LINE_MISMATCH');
    assert.strictEqual(await balance(SKU_OWNED, ownedLot, 'owned'), '13.500000');
    // Own material can never touch the customer's job_work lot.
    assert.strictEqual(await balance(SKU, lot), '50.000000');
  });

  // -------------------------------------------------------------------------
  // AC 7: gates and attribution
  // -------------------------------------------------------------------------

  it("AC7: a confirmed (not yet in_process) order, a wrong site, and another order's lot all refuse, each audited", async () => {
    const confirmedId = await confirmedOrder();
    const { orderId, lot } = await inProcessOrder({ receivedQty: '10' });
    const other = await inProcessOrder({ receivedQty: '10' });
    const beforeSrc = await auditCount('SOURCE_DOCUMENT_REQUIRED');
    const beforeCross = await auditCount('CROSS_ISSUE_BLOCKED');

    const notInProcess = await consume(confirmedId, consumptionBody(lot, { quantity: '1' }));
    assert.strictEqual(notInProcess.status, 409, JSON.stringify(notInProcess.body));
    assert.strictEqual(notInProcess.body['error_code'], 'SOURCE_DOCUMENT_REQUIRED');
    assert.strictEqual(detailsOf(notInProcess.body)['status'], 'confirmed');

    const wrongSite = await consume(
      orderId,
      consumptionBody(lot, { quantity: '1', site_id: siteBId }),
    );
    assert.strictEqual(wrongSite.status, 409, JSON.stringify(wrongSite.body));
    assert.strictEqual(wrongSite.body['error_code'], 'SOURCE_DOCUMENT_REQUIRED');
    assert.strictEqual(detailsOf(wrongSite.body)['order_site_id'], siteAId);

    const foreignLot = await consume(orderId, consumptionBody(other.lot, { quantity: '1' }));
    assert.strictEqual(foreignLot.status, 409, JSON.stringify(foreignLot.body));
    assert.strictEqual(foreignLot.body['error_code'], 'CROSS_ISSUE_BLOCKED');
    assert.deepStrictEqual(detailsOf(foreignLot.body), {
      service_order_id: orderId,
      sku: SKU,
      lot_id: other.lot,
      demand_kind: 'custody_consumption',
    });

    const ownOnConfirmed = await ownMaterial(confirmedId, {
      sku: SKU_OWNED,
      location_id: dockId,
      quantity: '1',
      uom: 'KG',
      idempotency_key: randomUUID(),
    });
    assert.strictEqual(ownOnConfirmed.status, 409);
    assert.strictEqual(ownOnConfirmed.body['error_code'], 'SOURCE_DOCUMENT_REQUIRED');

    const mismatch = await consume(
      orderId,
      consumptionBody(lot, { quantity: '1', service_order_id: other.orderId }),
    );
    assert.strictEqual(mismatch.status, 400);
    assert.strictEqual(mismatch.body['error_code'], 'INVALID_PARAMS');
    const noKey = await consume(orderId, { ...consumptionBody(lot), idempotency_key: undefined });
    assert.strictEqual(noKey.status, 400);
    const forgedDerived = await consume(
      orderId,
      consumptionBody(lot, { bom_line_id: lineIds['customer'] }),
    );
    assert.strictEqual(forgedDerived.status, 400);
    assert.strictEqual(forgedDerived.body['error_code'], 'INVALID_PARAMS');
    const forgedPoster = await consume(orderId, consumptionBody(lot, { posted_by: randomUUID() }));
    assert.strictEqual(forgedPoster.status, 400);

    assert.strictEqual(await auditCount('SOURCE_DOCUMENT_REQUIRED'), beforeSrc + 3);
    assert.strictEqual(await auditCount('CROSS_ISSUE_BLOCKED'), beforeCross + 1);
    assert.strictEqual(await balance(SKU, lot), '10.000000');
    assert.strictEqual(await balance(SKU, other.lot), '10.000000');
    assert.strictEqual((await ledgerRows(orderId)).length, 1);
    assert.strictEqual((await ledgerRows(confirmedId)).length, 0);
  });

  it('AC7: a direct POST /api/v1/events cannot bypass any gate - the seam re-derives them, the closed shape holds, and the stock-surface bar stays total', async () => {
    const confirmedId = await confirmedOrder();
    const { orderId, lot } = await inProcessOrder({ receivedQty: '10' });
    const other = await inProcessOrder({ receivedQty: '10' });
    const base = {
      consumption_id: randomUUID(),
      sku: SKU,
      lot_id: lot,
      location_id: dockId,
      quantity: '1',
      uom: 'KG',
      site_id: siteAId,
      posted_by: coordinatorUserId,
    };

    const notInProcess = await postEvent(
      custodyEnvelope('custody.consumption_posted', confirmedId, base),
    );
    assert.strictEqual(notInProcess.status, 409, JSON.stringify(notInProcess.body));
    assert.strictEqual(notInProcess.body['error_code'], 'SOURCE_DOCUMENT_REQUIRED');

    const wrongSite = await postEvent(
      custodyEnvelope('custody.consumption_posted', orderId, { ...base, site_id: siteBId }),
    );
    assert.strictEqual(wrongSite.status, 409);
    assert.strictEqual(wrongSite.body['error_code'], 'SOURCE_DOCUMENT_REQUIRED');

    const foreignLot = await postEvent(
      custodyEnvelope('custody.consumption_posted', orderId, { ...base, lot_id: other.lot }),
    );
    assert.strictEqual(foreignLot.status, 409);
    assert.strictEqual(foreignLot.body['error_code'], 'CROSS_ISSUE_BLOCKED');

    const offKit = await postEvent(
      custodyEnvelope('custody.consumption_posted', orderId, { ...base, sku: SKU_OFF }),
    );
    assert.strictEqual(offKit.status, 409);
    // The lot-under-order gate precedes the kit gate: SKU_OFF was never received under this order.
    assert.strictEqual(offKit.body['error_code'], 'CROSS_ISSUE_BLOCKED');

    // A sku that IS received under this order but is company-tagged (not customer-supplied) clears
    // the lot-under-order gate and trips the kit gate itself, directly through the seam.
    const companyReceipt = await receive(orderId, { sku: SKU_COMPANY, receivedQty: '10' });
    const kitMismatch = await postEvent(
      custodyEnvelope('custody.consumption_posted', orderId, {
        ...base,
        sku: SKU_COMPANY,
        lot_id: companyReceipt.lot,
      }),
    );
    assert.strictEqual(kitMismatch.status, 409, JSON.stringify(kitMismatch.body));
    assert.strictEqual(kitMismatch.body['error_code'], 'KIT_LINE_MISMATCH');

    const overBalance = await postEvent(
      custodyEnvelope('custody.consumption_posted', orderId, { ...base, quantity: '10.001' }),
    );
    assert.strictEqual(overBalance.status, 409);
    assert.strictEqual(overBalance.body['error_code'], 'INSUFFICIENT_STOCK');
    assert.strictEqual(detailsOf(overBalance.body)['custody_balance_qty'], '10.000');

    // Closed shape: derived fields, unknown keys, wrong stream all refuse before any write.
    const derived = await postEvent(
      custodyEnvelope('custody.consumption_posted', orderId, {
        ...base,
        custody_balance_after: '0',
      }),
    );
    assert.strictEqual(derived.status, 400);
    assert.strictEqual(derived.body['error_code'], 'INVALID_PARAMS');
    const unknown = await postEvent(
      custodyEnvelope('custody.consumption_posted', orderId, { ...base, extra: 1 }),
    );
    assert.strictEqual(unknown.status, 400);
    const wrongStream = await postEvent({
      ...custodyEnvelope('custody.consumption_posted', orderId, base),
      stream_type: 'jobwork',
    });
    assert.strictEqual(wrongStream.status, 400, JSON.stringify(wrongStream.body));

    // The Story 9.2 total bar: a direct stock.issued on job_work stock still refuses (no Symbol).
    const directIssue = await postEvent(
      {
        stream_type: 'inventory',
        stream_id: randomUUID(),
        event_type: 'stock.issued',
        payload: {
          business_stream: 'job_work',
          sku: SKU,
          target_location_id: dockId,
          quantity: 1,
          lot_id: lot,
          stock_class: 'job_work',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: storeUserId, role: 'store_assistant', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      storeHeaders,
    );
    assert.strictEqual(directIssue.status, 400, JSON.stringify(directIssue.body));
    assert.strictEqual(directIssue.body['error_code'], 'CROSS_ISSUE_BLOCKED');

    assert.strictEqual(await balance(SKU, lot), '10.000000');
    // 2 receipt rows so far (the customer sku from inProcessOrder, plus the company-tagged receipt
    // used to reach the kit gate above); no consumption/own-material row has been written.
    assert.strictEqual((await ledgerRows(orderId)).length, 2);
    assert.strictEqual((await storedEvent('custody.consumption_posted', orderId)).length, 0);

    // And the legitimate direct event succeeds through the same seam, attributed to posted_by.
    const ok = await postEvent(custodyEnvelope('custody.consumption_posted', orderId, base));
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    const rows = await ledgerRows(orderId);
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows[2]!['posted_by'], coordinatorUserId);
    assert.strictEqual(rows[2]!['bom_line_id'], lineIds['customer']);
    assert.strictEqual(await balance(SKU, lot), '9.000000');
  });

  // -------------------------------------------------------------------------
  // Idempotency and concurrency
  // -------------------------------------------------------------------------

  it('replay with the same idempotency key returns 200 with the stored event and no second ledger row', async () => {
    const { orderId, lot } = await inProcessOrder({ receivedQty: '10' });
    const body = consumptionBody(lot, { quantity: '4' });
    const first = await consume(orderId, body);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const replay = await consume(orderId, body);
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['event_id'], first.body['event_id']);
    assert.strictEqual(replay.body['consumption_id'], first.body['consumption_id']);
    assert.strictEqual((await ledgerRows(orderId)).length, 2);
    assert.strictEqual(await balance(SKU, lot), '6.000000');
    assert.strictEqual((await storedEvent('custody.consumption_posted', orderId)).length, 1);

    // The same key with a different event is a reused key, not a replay.
    const reused = await ownMaterial(orderId, {
      sku: SKU_OWNED,
      location_id: dockId,
      quantity: '1',
      uom: 'KG',
      idempotency_key: body['idempotency_key'],
    });
    assert.strictEqual(reused.status, 409, JSON.stringify(reused.body));
    assert.strictEqual(reused.body['error_code'], 'DUPLICATE_EVENT');
  });

  it('concurrency: two consumptions racing the last unit have exactly one winner', async () => {
    const { orderId, lot } = await inProcessOrder({ receivedQty: '10' });
    const [a, b] = await Promise.all([
      consume(orderId, consumptionBody(lot, { quantity: '10' })),
      consume(orderId, consumptionBody(lot, { quantity: '10' })),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepStrictEqual(statuses, [201, 409], JSON.stringify([a.body, b.body]));
    const loser = a.status === 409 ? a : b;
    assert.strictEqual(loser.body['error_code'], 'INSUFFICIENT_STOCK');
    assert.strictEqual(await balance(SKU, lot), '0.000000');
    const rows = await ledgerRows(orderId);
    assert.strictEqual(rows.filter((r) => r['movement_category'] === 'consumption').length, 1);
    assert.strictEqual((await storedEvent('custody.consumption_posted', orderId)).length, 1);
  });

  // -------------------------------------------------------------------------
  // Recall trace coverage (Task 7)
  // -------------------------------------------------------------------------

  it('recall trace: a consumed customer lot appears in the Story 2.3 where-used within the same query, and the coverage list says so', async () => {
    const { orderId, lot } = await inProcessOrder({ receivedQty: '10' });
    const consumed = await consume(orderId, consumptionBody(lot, { quantity: '2.5' }));
    assert.strictEqual(consumed.status, 201, JSON.stringify(consumed.body));
    const lotRow = await getAdminPool().query(
      `SELECT lot_id FROM lot_master WHERE lot_number = $1 AND sku = $2`,
      [lot, SKU],
    );
    const lotUuid = lotRow.rows[0]!['lot_id'] as string;

    const hold = await makeRequest(
      port,
      'POST',
      '/api/v1/qc/holds',
      { lot_id: lotUuid, hold_reason: 'Story 9.3 recall trace' },
      qcHeadHeaders,
    );
    assert.strictEqual(hold.status, 201, JSON.stringify(hold.body));
    const holdId = ((hold.body['hold'] as Record<string, unknown> | undefined)?.['hold_id'] ??
      hold.body['hold_id']) as string;
    assert.ok(holdId, JSON.stringify(hold.body));

    const trace = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/holds/${holdId}/trace`,
      undefined,
      qcHeadHeaders,
    );
    assert.strictEqual(trace.status, 200, JSON.stringify(trace.body));
    const whereUsed = trace.body['where_used'] as Array<Record<string, unknown>>;
    const custody = whereUsed.filter((w) => w['source'] === 'custody.consumption_posted');
    assert.strictEqual(custody.length, 1, JSON.stringify(whereUsed));
    assert.strictEqual(custody[0]!['production_order_id'], orderId);
    assert.strictEqual(custody[0]!['posting_id'], consumed.body['consumption_id']);
    assert.strictEqual(custody[0]!['component_sku'], SKU);
    assert.strictEqual(custody[0]!['quantity'], '2.500');
    assert.strictEqual(custody[0]!['posting_type'], 'consumption');
    const coverage = trace.body['coverage'] as Record<string, string[]>;
    assert.ok(coverage['where_used']!.some((c) => c.includes('custody.consumption_posted')));
    assert.strictEqual(coverage['not_yet_covered']!.length, 1);
    const movements = trace.body['movements'] as Array<Record<string, unknown>>;
    assert.ok(movements.some((m) => m['event_type'] === 'custody.consumption_posted'));
  });
});
