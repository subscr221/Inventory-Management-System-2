import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppServer } from '../../src/server.js';
import { closePool, getPool } from '../../src/config/db.js';

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
    if (data) req.write(data);
    req.end();
  });
}

async function scimCreateUser(
  port: number,
  externalId: string,
  displayName: string,
  roles: Role[],
): Promise<string> {
  const result = await makeRequest(
    port,
    'POST',
    '/api/v1/scim/v2/Users',
    {
      externalId,
      email: externalId,
      displayName,
      roles,
    },
    SCIM_HEADERS,
  );
  assert.equal(result.status, 201, `SCIM user creation failed: ${result.raw}`);
  const userId = result.body['userId'];
  assert(typeof userId === 'string', 'SCIM response missing user id');
  return userId;
}

async function scimCreateAccessToken(port: number, externalId: string): Promise<string> {
  const result = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub: externalId });
  assert.ok(result.status >= 200 && result.status < 300, `dev-token failed: ${result.raw}`);
  const token = result.body['token'];
  assert(typeof token === 'string', 'dev-token response missing token');
  return token;
}

async function createWarehouseManager(
  port: number,
  locationId: string,
): Promise<{ userId: string; token: string }> {
  const externalId = `warehouse-mgr-${randomUUID().slice(0, 8)}`;
  const userId = await scimCreateUser(port, externalId, 'Warehouse Manager', [
    { role: 'warehouse_manager', module: 'warehouse', functionScope: 'write', locationId },
  ]);
  const token = await scimCreateAccessToken(port, externalId);
  return { userId, token };
}

async function createWarehouseOperator(
  port: number,
  locationId: string,
): Promise<{ userId: string; token: string }> {
  const externalId = `warehouse-op-${randomUUID().slice(0, 8)}`;
  const userId = await scimCreateUser(port, externalId, 'Warehouse Operator', [
    { role: 'warehouse_operator', module: 'warehouse', functionScope: 'write', locationId },
  ]);
  const token = await scimCreateAccessToken(port, externalId);
  return { userId, token };
}

async function createQcInspector(
  port: number,
  locationId: string,
): Promise<{ userId: string; token: string }> {
  const externalId = `qc-inspector-${randomUUID().slice(0, 8)}`;
  const userId = await scimCreateUser(port, externalId, 'QC Inspector', [
    { role: 'qc_inspector', module: 'quality', functionScope: 'write', locationId },
  ]);
  const token = await scimCreateAccessToken(port, externalId);
  return { userId, token };
}

// erp_sales_order is a direct-upsert reference projection (Story 2.9), not event-sourced -
// seed it with SQL directly, mirroring Story 3.6's seedOrderLine helper.
async function createErpSalesOrder(
  _port: number,
  _token: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const id = payload['id'] as string;
  await getPool().query(
    `INSERT INTO erp_sales_order
       (id, so_number_ext, line_no, sku, quantity, ship_from_site_id, ship_from_site_code_ext, ship_to_ext, status, source_system, last_synced_at)
     VALUES ($1, $2, 1, $3, $4, $5, 'site-A37', $6, 'open', 'ERP', now())`,
    [
      id,
      payload['so_number_ext'],
      payload['sku'],
      payload['quantity'],
      payload['ship_from_site_id'],
      payload['ship_to_ext'] ?? null,
    ],
  );
  return id;
}

async function createPickTask(
  port: number,
  token: string,
  dispatchOrderId: string,
  dispatchOrderLineIds: string[],
): Promise<{ pickTaskId: string; pickLineId: string }> {
  const result = await makeRequest(
    port,
    'POST',
    '/api/v1/pick-tasks/generate',
    {
      dispatchOrderId,
      dispatchOrderLineIds,
      strategy: 'single',
    },
    { Authorization: `Bearer ${token}` },
  );
  assert.equal(result.status, 201, `Pick task generation failed: ${result.raw}`);
  const pickTaskIds = result.body['pickTaskIds'] as string[] | undefined;
  const pickLineIds = result.body['pickLineIds'] as string[] | undefined;
  assert(
    Array.isArray(pickTaskIds) && pickTaskIds.length > 0,
    'Pick task response missing pickTaskIds',
  );
  assert(
    Array.isArray(pickLineIds) && pickLineIds.length > 0,
    'Pick task response missing pickLineIds',
  );
  return { pickTaskId: pickTaskIds[0]!, pickLineId: pickLineIds[0]! };
}

async function confirmPickLine(
  port: number,
  token: string,
  pickTaskId: string,
  pickLineId: string,
  lotId: string,
  pickedQty: string,
): Promise<string> {
  const result = await makeRequest(
    port,
    'POST',
    `/api/v1/pick-tasks/${pickTaskId}/lines/${pickLineId}/confirm`,
    {
      confirmedLotId: lotId,
      confirmedQuantity: pickedQty,
      captureMethod: 'PWA',
    },
    { Authorization: `Bearer ${token}` },
  );
  assert.equal(result.status, 200, `Pick line confirmation failed: ${result.raw}`);
  const eventId = result.body['event_id'];
  assert(typeof eventId === 'string', 'Pick line response missing event_id');
  return eventId;
}

async function packDispatchOrder(
  port: number,
  token: string,
  dispatchOrderId: string,
  packingLines: Array<{
    sku: string;
    packed_qty: string;
    lot_id: string;
    carton_count: number;
    actual_weight_kg: number | null;
  }>,
): Promise<string> {
  const result = await makeRequest(
    port,
    'POST',
    `/api/v1/dispatch/${dispatchOrderId}/pack`,
    {
      dispatchOrderId,
      packingLines,
    },
    { Authorization: `Bearer ${token}` },
  );
  assert.equal(result.status, 200, `Dispatch pack failed: ${result.raw}`);
  const eventId = (result.body['eventIds'] as unknown[] | undefined)?.[0] ?? result.body['eventId'];
  assert(typeof eventId === 'string', 'Dispatch pack response missing eventId');
  return eventId;
}

async function generateShippingDocuments(
  port: number,
  token: string,
  dispatchOrderId: string,
): Promise<Record<string, unknown>> {
  const result = await makeRequest(
    port,
    'POST',
    `/api/v1/dispatch/${dispatchOrderId}/generate-documents`,
    {
      dispatchOrderId,
    },
    { Authorization: `Bearer ${token}` },
  );
  assert.equal(result.status, 200, `Shipping documents generation failed: ${result.raw}`);
  return result.body;
}

async function dispatchOrder(
  port: number,
  token: string,
  dispatchOrderId: string,
): Promise<string> {
  const result = await makeRequest(
    port,
    'POST',
    `/api/v1/dispatch/${dispatchOrderId}/dispatch`,
    {
      dispatchOrderId,
    },
    { Authorization: `Bearer ${token}` },
  );
  assert.equal(result.status, 200, `Dispatch failed: ${result.raw}`);
  const eventId = result.body['eventId'];
  assert(typeof eventId === 'string', 'Dispatch response missing eventId');
  return eventId;
}

async function getPackingRecords(
  port: number,
  token: string,
  dispatchOrderId: string,
): Promise<Record<string, unknown>[]> {
  const result = await makeRequest(
    port,
    'GET',
    `/api/v1/dispatch/${dispatchOrderId}/packing-records`,
    undefined,
    { Authorization: `Bearer ${token}` },
  );
  assert.equal(result.status, 200, `Get packing records failed: ${result.raw}`);
  const packingRecords = result.body['packingRecords'];
  assert(Array.isArray(packingRecords), 'Packing records response missing array');
  return packingRecords as Record<string, unknown>[];
}

async function getDispatchDocuments(
  port: number,
  token: string,
  dispatchOrderId: string,
): Promise<Record<string, unknown>[]> {
  const result = await makeRequest(
    port,
    'GET',
    `/api/v1/dispatch/${dispatchOrderId}/documents`,
    undefined,
    { Authorization: `Bearer ${token}` },
  );
  assert.equal(result.status, 200, `Get dispatch documents failed: ${result.raw}`);
  const documents = result.body['documents'];
  assert(Array.isArray(documents), 'Dispatch documents response missing array');
  return documents as Record<string, unknown>[];
}

async function getDispatchOrderStatus(
  port: number,
  token: string,
  dispatchOrderId: string,
): Promise<Record<string, unknown> | null> {
  const result = await makeRequest(
    port,
    'GET',
    `/api/v1/dispatch-order-status/${dispatchOrderId}`,
    undefined,
    { Authorization: `Bearer ${token}` },
  );
  if (result.status === 404) return null;
  assert.equal(result.status, 200, `Get dispatch order status failed: ${result.raw}`);
  return result.body as Record<string, unknown>;
}

async function seedItemMaster(sku: string): Promise<void> {
  await getPool().query(
    `INSERT INTO item_master (sku, uom, valuation_method, business_stream)
     VALUES ($1, 'EA', 'weighted_average', 'production')`,
    [sku],
  );
}

async function createLot(lotNumber: string, sku: string, lotId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO lot_master (lot_id, lot_number, sku, quality_hold_status)
     VALUES ($1, $2, $3, 'none')
     ON CONFLICT (lot_number) DO NOTHING`,
    [lotId, lotNumber, sku],
  );
}

async function seedLocation(
  locationId: string,
  code: string,
  level: string,
  parentId: string | null,
  siteId: string,
  pickSequence: number | null = null,
): Promise<void> {
  await getPool().query(
    `INSERT INTO location_register
       (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class,
        size_class, hazmat_allowed, quarantine, access_restricted, status, pick_sequence)
     VALUES ($1, $2, $3, $4, $5, 'general', 'ambient', 'standard', false, false, false, 'active', $6)`,
    [locationId, code, level, parentId, siteId, pickSequence],
  );
}

async function seedStock(
  sku: string,
  locationId: string,
  lotNumber: string,
  onHand: number,
): Promise<void> {
  await getPool().query(
    `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand)
     VALUES ($1, $2, $3, 'owned', $4)`,
    [sku, locationId, lotNumber, onHand],
  );
}

async function placeQualityHold(port: number, token: string, lotId: string): Promise<HttpResult> {
  return makeRequest(
    port,
    'PUT',
    `/api/v1/lots/${lotId}/quality-hold`,
    { hold_reason: 'Story 3.7 AC3 test hold' },
    { Authorization: `Bearer ${token}` },
  );
}

async function clearQualityHold(port: number, token: string, lotId: string): Promise<HttpResult> {
  return makeRequest(
    port,
    'DELETE',
    `/api/v1/lots/${lotId}/quality-hold`,
    {},
    { Authorization: `Bearer ${token}` },
  );
}

describe('Story 3.7 - Packing, Shipping, and Dispatch Documents', () => {
  let server: Server;
  let port: number;
  const siteId = randomUUID();
  const otherSiteId = randomUUID();
  const run = randomUUID().slice(0, 8);
  let warehouseManager: { userId: string; token: string };
  let warehouseOperator: { userId: string; token: string };
  let otherSiteManager: { userId: string; token: string };
  let qcInspector: { userId: string; token: string };
  const zoneId = randomUUID();
  const binId = randomUUID();

  before(async () => {
    server = createAppServer();
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    port = (server.address() as AddressInfo).port;

    // Minimal warehouse topology so pick-task generation's FEFO/zone-resolution query has
    // somewhere to allocate from: site -> zone -> aisle -> rack -> bin chain at siteId. The site
    // row itself is also required for RBAC's actor-location registration check.
    const aisleId = randomUUID();
    const rackId = randomUUID();
    await seedLocation(siteId, `SITE-37-${run}`, 'site', null, siteId);
    await seedLocation(zoneId, `ZONE-37-${run}`, 'zone', siteId, siteId);
    await seedLocation(aisleId, `AISLE-37-${run}`, 'aisle', zoneId, siteId);
    await seedLocation(rackId, `RACK-37-${run}`, 'rack', aisleId, siteId);
    await seedLocation(binId, `BIN-37-${run}`, 'bin', rackId, siteId, 10);

    warehouseManager = await createWarehouseManager(port, siteId);
    warehouseOperator = await createWarehouseOperator(port, siteId);
    otherSiteManager = await createWarehouseManager(port, otherSiteId);
    qcInspector = await createQcInspector(port, siteId);
  });

  after(async () => {
    await closePool();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('should pack a dispatch order', async () => {
    const dispatchOrderId = randomUUID();
    const sku = `SKU-123-${run}`;
    const lotId = randomUUID();
    const quantity = '100';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: `SO-001-${run}`,
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer ABC',
    });

    await createLot(`LOT-${sku}`, sku, lotId);
    await seedStock(sku, binId, `LOT-${sku}`, Number(quantity));
    const { pickTaskId, pickLineId } = await createPickTask(
      port,
      warehouseManager.token,
      dispatchOrderId,
      [dispatchOrderId],
    );
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);

    const eventId = await packDispatchOrder(port, warehouseManager.token, dispatchOrderId, [
      {
        sku,
        packed_qty: quantity,
        lot_id: lotId,
        carton_count: 5,
        actual_weight_kg: 12.5,
      },
    ]);

    assert.equal(typeof eventId, 'string');
    assert(eventId.length > 0);

    const status = await getDispatchOrderStatus(port, warehouseManager.token, dispatchOrderId);
    assert(status !== null);
    assert.equal(status?.dispatch_order_id, dispatchOrderId);
    assert.equal(status?.status, 'packed');
    assert.equal(status?.packed_by, warehouseManager.userId);
    assert(typeof status?.packed_at === 'string');
  });

  it('should reject packing for insufficient picked quantity', async () => {
    const dispatchOrderId = randomUUID();
    const sku = `SKU-124-${run}`;
    const lotId = randomUUID();
    const quantity = '30';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: `SO-002-${run}`,
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer XYZ',
    });

    await createLot(`LOT-${sku}`, sku, lotId);
    await seedStock(sku, binId, `LOT-${sku}`, Number(quantity));
    const { pickTaskId, pickLineId } = await createPickTask(
      port,
      warehouseManager.token,
      dispatchOrderId,
      [dispatchOrderId],
    );
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);

    const result = await makeRequest(
      port,
      'POST',
      `/api/v1/dispatch/${dispatchOrderId}/pack`,
      {
        dispatchOrderId,
        packingLines: [
          {
            sku,
            packed_qty: '50',
            lot_id: lotId,
            carton_count: 3,
            actual_weight_kg: 8.0,
          },
        ],
      },
      { Authorization: `Bearer ${warehouseManager.token}` },
    );

    assert.equal(result.status, 400);
    assert.equal(result.body['error_code'], 'PACKED_QTY_MISMATCH');
  });

  it('should generate shipping documents', async () => {
    const dispatchOrderId = randomUUID();
    const sku = `SKU-125-${run}`;
    const lotId = randomUUID();
    const quantity = '75';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: `SO-003-${run}`,
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer DEF',
    });

    await createLot(`LOT-${sku}`, sku, lotId);
    await seedStock(sku, binId, `LOT-${sku}`, Number(quantity));
    const { pickTaskId, pickLineId } = await createPickTask(
      port,
      warehouseManager.token,
      dispatchOrderId,
      [dispatchOrderId],
    );
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);

    await packDispatchOrder(port, warehouseManager.token, dispatchOrderId, [
      {
        sku,
        packed_qty: quantity,
        lot_id: lotId,
        carton_count: 4,
        actual_weight_kg: 10.0,
      },
    ]);

    const result = await generateShippingDocuments(port, warehouseManager.token, dispatchOrderId);

    assert.equal(typeof result['eventId'], 'string');
    assert.equal(result['dispatchOrderId'], dispatchOrderId);
    assert.equal(result['generatedBy'], warehouseManager.userId);
    assert(Array.isArray(result['documentIds']));
    // bol, packing_slip, commercial_invoice, plus one label document per carton (4 cartons)
    assert.equal(result['documentIds'].length, 7);

    const documents = await getDispatchDocuments(port, warehouseManager.token, dispatchOrderId);
    const documentTypes = documents.map((d) => d['document_type'] as string);
    assert(documentTypes.includes('bol'));
    assert(documentTypes.includes('packing_slip'));
    assert(documentTypes.includes('commercial_invoice'));
    assert.equal(documentTypes.filter((t: string) => t === 'label').length, 4);

    const status = await getDispatchOrderStatus(port, warehouseManager.token, dispatchOrderId);
    assert(status !== null);
    assert.equal(status?.packed_by, warehouseManager.userId);
  });

  it('should reject document generation for unpacked order', async () => {
    const dispatchOrderId = randomUUID();
    const sku = `SKU-126-${run}`;
    const lotId = randomUUID();
    const quantity = '25';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: `SO-004-${run}`,
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer GHI',
    });

    await createLot(`LOT-${sku}`, sku, lotId);
    await seedStock(sku, binId, `LOT-${sku}`, Number(quantity));
    const { pickTaskId, pickLineId } = await createPickTask(
      port,
      warehouseManager.token,
      dispatchOrderId,
      [dispatchOrderId],
    );
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);

    const result = await makeRequest(
      port,
      'POST',
      `/api/v1/dispatch/${dispatchOrderId}/generate-documents`,
      {
        dispatchOrderId,
      },
      { Authorization: `Bearer ${warehouseManager.token}` },
    );

    assert.equal(result.status, 400);
    assert.equal(result.body['error_code'], 'DISPATCH_ORDER_NOT_PACKED');
  });

  it('should dispatch a packed order with documents', async () => {
    const dispatchOrderId = randomUUID();
    const sku = `SKU-127-${run}`;
    const lotId = randomUUID();
    const quantity = '60';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: `SO-005-${run}`,
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer JKL',
    });

    await createLot(`LOT-${sku}`, sku, lotId);
    await seedStock(sku, binId, `LOT-${sku}`, Number(quantity));
    const { pickTaskId, pickLineId } = await createPickTask(
      port,
      warehouseManager.token,
      dispatchOrderId,
      [dispatchOrderId],
    );
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);

    await packDispatchOrder(port, warehouseManager.token, dispatchOrderId, [
      {
        sku,
        packed_qty: quantity,
        lot_id: lotId,
        carton_count: 3,
        actual_weight_kg: 7.5,
      },
    ]);

    await generateShippingDocuments(port, warehouseManager.token, dispatchOrderId);

    const eventId = await dispatchOrder(port, warehouseManager.token, dispatchOrderId);

    assert.equal(typeof eventId, 'string');
    assert(eventId.length > 0);

    const status = await getDispatchOrderStatus(port, warehouseManager.token, dispatchOrderId);
    assert(status !== null);
    assert.equal(status?.status, 'dispatched');
    assert.equal(status?.dispatched_by, warehouseManager.userId);
    assert(typeof status?.dispatched_at === 'string');
  });

  it('should reject dispatch for order without documents', async () => {
    const dispatchOrderId = randomUUID();
    const sku = `SKU-128-${run}`;
    const lotId = randomUUID();
    const quantity = '40';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: `SO-006-${run}`,
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer MNO',
    });

    await createLot(`LOT-${sku}`, sku, lotId);
    await seedStock(sku, binId, `LOT-${sku}`, Number(quantity));
    const { pickTaskId, pickLineId } = await createPickTask(
      port,
      warehouseManager.token,
      dispatchOrderId,
      [dispatchOrderId],
    );
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);

    await packDispatchOrder(port, warehouseManager.token, dispatchOrderId, [
      {
        sku,
        packed_qty: quantity,
        lot_id: lotId,
        carton_count: 2,
        actual_weight_kg: 5.0,
      },
    ]);

    const result = await makeRequest(
      port,
      'POST',
      `/api/v1/dispatch/${dispatchOrderId}/dispatch`,
      {
        dispatchOrderId,
      },
      { Authorization: `Bearer ${warehouseManager.token}` },
    );

    assert.equal(result.status, 400);
    assert.equal(result.body['error_code'], 'DISPATCH_DOCUMENTS_NOT_GENERATED');
  });

  it('should enforce RBAC for dispatch operations', async () => {
    const dispatchOrderId = randomUUID();
    const sku = `SKU-129-${run}`;
    const lotId = randomUUID();
    const quantity = '20';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: `SO-007-${run}`,
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer PQR',
    });

    await createLot(`LOT-${sku}`, sku, lotId);
    await seedStock(sku, binId, `LOT-${sku}`, Number(quantity));
    const { pickTaskId, pickLineId } = await createPickTask(
      port,
      warehouseManager.token,
      dispatchOrderId,
      [dispatchOrderId],
    );
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);

    await packDispatchOrder(port, warehouseManager.token, dispatchOrderId, [
      {
        sku,
        packed_qty: quantity,
        lot_id: lotId,
        carton_count: 1,
        actual_weight_kg: 2.5,
      },
    ]);

    const result = await makeRequest(
      port,
      'POST',
      `/api/v1/dispatch/${dispatchOrderId}/generate-documents`,
      {
        dispatchOrderId,
      },
      { Authorization: `Bearer ${warehouseOperator.token}` },
    );

    assert.equal(result.status, 403);
    assert.equal(result.body['error_code'], 'FUNCTION_ACCESS_DENIED');
  });

  it('should enforce site scoping', async () => {
    const dispatchOrderId = randomUUID();
    const sku = `SKU-130-${run}`;
    const lotId = randomUUID();
    const quantity = '15';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: `SO-008-${run}`,
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer STU',
    });

    await createLot(`LOT-${sku}`, sku, lotId);
    await seedStock(sku, binId, `LOT-${sku}`, Number(quantity));
    const { pickTaskId, pickLineId } = await createPickTask(
      port,
      warehouseManager.token,
      dispatchOrderId,
      [dispatchOrderId],
    );
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);

    const result = await makeRequest(
      port,
      'POST',
      `/api/v1/dispatch/${dispatchOrderId}/pack`,
      {
        dispatchOrderId,
        packingLines: [
          {
            sku,
            packed_qty: quantity,
            lot_id: lotId,
            carton_count: 1,
            actual_weight_kg: 1.5,
          },
        ],
      },
      { Authorization: `Bearer ${otherSiteManager.token}` },
    );

    assert.equal(result.status, 403);
    assert.equal(result.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });

  it('should retrieve packing records', async () => {
    const dispatchOrderId = randomUUID();
    const sku = `SKU-131-${run}`;
    const lotId = randomUUID();
    const quantity = '90.000';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: `SO-009-${run}`,
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer VWX',
    });

    await createLot(`LOT-${sku}`, sku, lotId);
    await seedStock(sku, binId, `LOT-${sku}`, Number(quantity));
    const { pickTaskId, pickLineId } = await createPickTask(
      port,
      warehouseManager.token,
      dispatchOrderId,
      [dispatchOrderId],
    );
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);

    await packDispatchOrder(port, warehouseManager.token, dispatchOrderId, [
      {
        sku,
        packed_qty: quantity,
        lot_id: lotId,
        carton_count: 6,
        actual_weight_kg: 15.0,
      },
    ]);

    const packingRecords = await getPackingRecords(port, warehouseManager.token, dispatchOrderId);
    assert.equal(packingRecords.length, 1);
    const pr = packingRecords[0]!;
    assert.equal(pr.dispatch_order_id, dispatchOrderId);
    assert.equal(pr.sku, sku);
    assert.equal(pr.packed_qty, quantity);
    assert.equal(pr.lot_id, lotId);
    assert.equal(pr.carton_count, 6);
    assert.equal(pr.actual_weight_kg, '15.000');
  });

  it('should retrieve dispatch documents', async () => {
    const dispatchOrderId = randomUUID();
    const sku = `SKU-132-${run}`;
    const lotId = randomUUID();
    const quantity = '110';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: `SO-010-${run}`,
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer YZ',
    });

    await createLot(`LOT-${sku}`, sku, lotId);
    await seedStock(sku, binId, `LOT-${sku}`, Number(quantity));
    const { pickTaskId, pickLineId } = await createPickTask(
      port,
      warehouseManager.token,
      dispatchOrderId,
      [dispatchOrderId],
    );
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);

    await packDispatchOrder(port, warehouseManager.token, dispatchOrderId, [
      {
        sku,
        packed_qty: quantity,
        lot_id: lotId,
        carton_count: 7,
        actual_weight_kg: 18.0,
      },
    ]);

    const docResult = await generateShippingDocuments(
      port,
      warehouseManager.token,
      dispatchOrderId,
    );
    assert(Array.isArray(docResult['documentIds']));
    // bol, packing_slip, commercial_invoice, plus one label document per carton (7 cartons)
    assert.equal(docResult['documentIds'].length, 10);

    const documents = await getDispatchDocuments(port, warehouseManager.token, dispatchOrderId);
    assert.equal(documents.length, 10);

    const bolDoc = documents.find((d: Record<string, unknown>) => d.document_type === 'bol');
    const packingSlipDoc = documents.find(
      (d: Record<string, unknown>) => d.document_type === 'packing_slip',
    );
    const commercialInvoiceDoc = documents.find(
      (d: Record<string, unknown>) => d.document_type === 'commercial_invoice',
    );
    const labelDocs = documents.filter((d: Record<string, unknown>) => d.document_type === 'label');

    assert(bolDoc);
    assert(packingSlipDoc);
    assert(commercialInvoiceDoc);
    assert.equal(labelDocs.length, 7);

    assert(
      typeof bolDoc?.document_content === 'string' &&
        (bolDoc.document_content as string).length > 0,
    );
    assert(
      typeof packingSlipDoc?.document_content === 'string' &&
        (packingSlipDoc.document_content as string).length > 0,
    );
    assert(
      typeof commercialInvoiceDoc?.document_content === 'string' &&
        (commercialInvoiceDoc.document_content as string).length > 0,
    );
    assert(docResult['documentIds'].includes(bolDoc?.document_id));
    assert(docResult['documentIds'].includes(packingSlipDoc?.document_id));
    assert(docResult['documentIds'].includes(commercialInvoiceDoc?.document_id));
  });

  it('should handle edge event upload for dispatch operations', async () => {
    const dispatchOrderId = randomUUID();
    const sku = `SKU-133-${run}`;
    const lotId = randomUUID();
    const quantity = '80';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: `SO-011-${run}`,
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer Edge',
    });

    await createLot(`LOT-${sku}`, sku, lotId);
    await seedStock(sku, binId, `LOT-${sku}`, Number(quantity));
    const { pickTaskId, pickLineId } = await createPickTask(
      port,
      warehouseManager.token,
      dispatchOrderId,
      [dispatchOrderId],
    );
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);

    const packingRecordId = randomUUID();
    const eventId = randomUUID();
    const result = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      {
        event_id: eventId,
        idempotency_key: randomUUID(),
        stream_type: 'warehouse',
        stream_id: dispatchOrderId,
        event_type: 'dispatch.packed',
        metadata: {
          device_id: 'edge-device-001',
          correlation_id: randomUUID(),
          actor: { user_id: randomUUID(), role: 'warehouse_manager', location_id: siteId },
          occurred_at: new Date().toISOString(),
        },
        payload: {
          packing_record_id: packingRecordId,
          dispatch_order_id: dispatchOrderId,
          sku,
          packed_qty: quantity,
          lot_id: lotId,
          carton_count: 4,
        },
      },
      { Authorization: `Bearer ${warehouseManager.token}` },
    );

    assert.equal(result.status, 201, `Edge upload failed: ${result.raw}`);
    assert.equal(result.body['event_id'], eventId);

    const status = await getDispatchOrderStatus(port, warehouseManager.token, dispatchOrderId);
    assert(status !== null);
    assert.equal(status?.status, 'packed');
    assert.equal(status?.packed_by, warehouseManager.userId);
  });

  it('should block document generation when lot is on quality hold (AC3)', async () => {
    const dispatchOrderId = randomUUID();
    const sku = `SKU-HOLD-001-${run}`;
    const lotNumber = `LOT-HOLD-001-${run}`;
    const lotId = randomUUID();
    const quantity = '50';

    await seedItemMaster(sku);
    await createLot(lotNumber, sku, lotId);
    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: `SO-HOLD-001-${run}`,
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer HOLD',
    });

    await seedStock(sku, binId, lotNumber, Number(quantity));
    const { pickTaskId, pickLineId } = await createPickTask(
      port,
      warehouseManager.token,
      dispatchOrderId,
      [dispatchOrderId],
    );
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);

    await packDispatchOrder(port, warehouseManager.token, dispatchOrderId, [
      {
        sku,
        packed_qty: quantity,
        lot_id: lotId,
        carton_count: 2,
        actual_weight_kg: 5.0,
      },
    ]);

    // Place quality hold on the lot
    const holdResult = await placeQualityHold(port, qcInspector.token, lotId);
    assert.equal(holdResult.status, 200, `Place quality hold failed: ${holdResult.raw}`);

    // Document generation should be blocked
    const docResult = await makeRequest(
      port,
      'POST',
      `/api/v1/dispatch/${dispatchOrderId}/generate-documents`,
      {
        dispatchOrderId,
      },
      { Authorization: `Bearer ${warehouseManager.token}` },
    );

    assert.equal(docResult.status, 400);
    assert.equal(docResult.body['error_code'], 'LOT_ON_HOLD');
    assert(Array.isArray((docResult.body['details'] as Record<string, unknown>)?.['held_lot_ids']));

    // Clean up: release the hold
    await clearQualityHold(port, qcInspector.token, lotId);
  });

  it('should block dispatch when lot is on quality hold (AC3 re-check)', async () => {
    const dispatchOrderId = randomUUID();
    const sku = `SKU-HOLD-002-${run}`;
    const lotNumber = `LOT-HOLD-002-${run}`;
    const lotId = randomUUID();
    const quantity = '30';

    await seedItemMaster(sku);
    await createLot(lotNumber, sku, lotId);
    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: `SO-HOLD-002-${run}`,
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer HOLD2',
    });

    await seedStock(sku, binId, lotNumber, Number(quantity));
    const { pickTaskId, pickLineId } = await createPickTask(
      port,
      warehouseManager.token,
      dispatchOrderId,
      [dispatchOrderId],
    );
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);

    await packDispatchOrder(port, warehouseManager.token, dispatchOrderId, [
      {
        sku,
        packed_qty: quantity,
        lot_id: lotId,
        carton_count: 1,
        actual_weight_kg: 2.5,
      },
    ]);

    // Generate documents first (lot not on hold yet)
    await generateShippingDocuments(port, warehouseManager.token, dispatchOrderId);

    // Place quality hold on the lot after document generation
    const holdResult = await placeQualityHold(port, qcInspector.token, lotId);
    assert.equal(holdResult.status, 200, `Place quality hold failed: ${holdResult.raw}`);

    // Dispatch should be blocked (AC3 re-check at dispatch time)
    const dispatchResult = await makeRequest(
      port,
      'POST',
      `/api/v1/dispatch/${dispatchOrderId}/dispatch`,
      {
        dispatchOrderId,
      },
      { Authorization: `Bearer ${warehouseManager.token}` },
    );

    assert.equal(dispatchResult.status, 400);
    assert.equal(dispatchResult.body['error_code'], 'LOT_ON_HOLD');

    // Clean up
    await clearQualityHold(port, qcInspector.token, lotId);
  });
});
