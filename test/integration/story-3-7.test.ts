import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppServer } from '../../src/server.js';
import { closePool } from '../../src/config/db.js';

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

function makeRequest(port: number, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult> {
  return new Promise((resolvePromise, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        hostname: 'localhost',
        port,
        path,
        method,
        headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
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

async function scimCreateUser(port: number, externalId: string, displayName: string, roles: Role[]): Promise<string> {
  const result = await makeRequest(port, 'POST', '/api/v1/scim/Users', {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    externalId,
    userName: externalId,
    displayName,
    active: true,
    'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { roles },
  }, SCIM_HEADERS);
  assert.equal(result.status, 201, `SCIM user creation failed: ${result.raw}`);
  const userId = result.body['id'];
  assert(typeof userId === 'string', 'SCIM response missing user id');
  return userId;
}

async function scimCreateAccessToken(port: number, userId: string): Promise<string> {
  const result = await makeRequest(port, 'POST', `/api/v1/scim/Users/${userId}/access-tokens`, {
    description: 'test token',
    expiresInSeconds: 3600,
  }, SCIM_HEADERS);
  assert.equal(result.status, 201, `SCIM token creation failed: ${result.raw}`);
  const token = result.body['token'];
  assert(typeof token === 'string', 'SCIM response missing token');
  return token;
}

async function createWarehouseManager(port: number, locationId: string): Promise<{ userId: string; token: string }> {
  const externalId = `warehouse-mgr-${randomUUID().slice(0, 8)}`;
  const userId = await scimCreateUser(port, externalId, 'Warehouse Manager', [
    { role: 'warehouse_manager', module: 'warehouse', functionScope: 'write', locationId },
  ]);
  const token = await scimCreateAccessToken(port, userId);
  return { userId, token };
}

async function createWarehouseOperator(port: number, locationId: string): Promise<{ userId: string; token: string }> {
  const externalId = `warehouse-op-${randomUUID().slice(0, 8)}`;
  const userId = await scimCreateUser(port, externalId, 'Warehouse Operator', [
    { role: 'warehouse_operator', module: 'warehouse', functionScope: 'write', locationId },
  ]);
  const token = await scimCreateAccessToken(port, userId);
  return { userId, token };
}

async function createErpSalesOrder(port: number, token: string, payload: Record<string, unknown>): Promise<string> {
  const result = await makeRequest(port, 'POST', '/api/v1/edge/events', {
    event_id: randomUUID(),
    idempotency_key: randomUUID(),
    stream_type: 'erp',
    event_type: 'sales_order.created',
    metadata: { device_id: 'test-device' },
    payload,
  }, { Authorization: `Bearer ${token}` });
  assert.equal(result.status, 201, `ERP sales order creation failed: ${result.raw}`);
  const eventId = result.body['event_id'];
  assert(typeof eventId === 'string', 'Event response missing event_id');
  return eventId;
}

async function createPickTask(port: number, token: string, dispatchOrderId: string, dispatchOrderLineIds: string[]): Promise<string> {
  const result = await makeRequest(port, 'POST', '/api/v1/pick-tasks/generate', {
    dispatchOrderId,
    dispatchOrderLineIds,
    strategy: 'single',
  }, { Authorization: `Bearer ${token}` });
  assert.equal(result.status, 200, `Pick task generation failed: ${result.raw}`);
  const eventId = result.body['eventId'];
  assert(typeof eventId === 'string', 'Pick task response missing eventId');
  return eventId;
}

async function confirmPickLine(port: number, token: string, pickTaskId: string, pickLineId: string, lotId: string, pickedQty: string): Promise<string> {
  const result = await makeRequest(port, 'POST', `/api/v1/pick-tasks/${pickTaskId}/pick-lines/${pickLineId}/confirm`, {
    lotId,
    pickedQty,
  }, { Authorization: `Bearer ${token}` });
  assert.equal(result.status, 200, `Pick line confirmation failed: ${result.raw}`);
  const eventId = result.body['eventId'];
  assert(typeof eventId === 'string', 'Pick line response missing eventId');
  return eventId;
}

async function completePickTask(port: number, token: string, pickTaskId: string): Promise<string> {
  const result = await makeRequest(port, 'POST', `/api/v1/pick-tasks/${pickTaskId}/complete`, {}, { Authorization: `Bearer ${token}` });
  assert.equal(result.status, 200, `Pick task completion failed: ${result.raw}`);
  const eventId = result.body['eventId'];
  assert(typeof eventId === 'string', 'Pick task response missing eventId');
  return eventId;
}

async function packDispatchOrder(port: number, token: string, dispatchOrderId: string, packingLines: Array<{
  sku: string;
  packed_qty: string;
  lot_id: string;
  carton_count: number;
  actual_weight_kg: number | null;
}>): Promise<string> {
  const result = await makeRequest(port, 'POST', '/api/v1/dispatch/packed', {
    dispatchOrderId,
    packingLines,
  }, { Authorization: `Bearer ${token}` });
  assert.equal(result.status, 200, `Dispatch pack failed: ${result.raw}`);
  const eventId = result.body['eventId'];
  assert(typeof eventId === 'string', 'Dispatch pack response missing eventId');
  return eventId;
}

async function generateShippingDocuments(port: number, token: string, dispatchOrderId: string): Promise<Record<string, unknown>> {
  const result = await makeRequest(port, 'POST', '/api/v1/dispatch/shipping-documents-generated', {
    dispatchOrderId,
  }, { Authorization: `Bearer ${token}` });
  assert.equal(result.status, 200, `Shipping documents generation failed: ${result.raw}`);
  return result.body;
}

async function dispatchOrder(port: number, token: string, dispatchOrderId: string): Promise<string> {
  const result = await makeRequest(port, 'POST', '/api/v1/dispatch/dispatched', {
    dispatchOrderId,
  }, { Authorization: `Bearer ${token}` });
  assert.equal(result.status, 200, `Dispatch failed: ${result.raw}`);
  const eventId = result.body['eventId'];
  assert(typeof eventId === 'string', 'Dispatch response missing eventId');
  return eventId;
}

async function getPackingRecords(port: number, token: string, dispatchOrderId: string): Promise<Record<string, unknown>[]> {
  const result = await makeRequest(port, 'GET', `/api/v1/dispatch/${dispatchOrderId}/packing-records`, undefined, { Authorization: `Bearer ${token}` });
  assert.equal(result.status, 200, `Get packing records failed: ${result.raw}`);
  const packingRecords = result.body['packingRecords'];
  assert(Array.isArray(packingRecords), 'Packing records response missing array');
  return packingRecords as Record<string, unknown>[];
}

async function getDispatchDocuments(port: number, token: string, dispatchOrderId: string): Promise<Record<string, unknown>[]> {
  const result = await makeRequest(port, 'GET', `/api/v1/dispatch/${dispatchOrderId}/documents`, undefined, { Authorization: `Bearer ${token}` });
  assert.equal(result.status, 200, `Get dispatch documents failed: ${result.raw}`);
  const documents = result.body['documents'];
  assert(Array.isArray(documents), 'Dispatch documents response missing array');
  return documents as Record<string, unknown>[];
}

async function getDispatchOrderStatus(port: number, token: string, dispatchOrderId: string): Promise<Record<string, unknown> | null> {
  const result = await makeRequest(port, 'GET', `/api/v1/dispatch-order-status/${dispatchOrderId}`, undefined, { Authorization: `Bearer ${token}` });
  if (result.status === 404) return null;
  assert.equal(result.status, 200, `Get dispatch order status failed: ${result.raw}`);
  return result.body as Record<string, unknown>;
}

describe('Story 3.7 - Packing, Shipping, and Dispatch Documents', () => {
  let server: Server;
  let port: number;
  const siteId = randomUUID();
  const otherSiteId = randomUUID();
  let warehouseManager: { userId: string; token: string };
  let warehouseOperator: { userId: string; token: string };
  let otherSiteManager: { userId: string; token: string };

  before(async () => {
    server = createAppServer();
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    port = (server.address() as AddressInfo).port;

    warehouseManager = await createWarehouseManager(port, siteId);
    warehouseOperator = await createWarehouseOperator(port, siteId);
    otherSiteManager = await createWarehouseManager(port, otherSiteId);
  });

  after(async () => {
    await closePool();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('should pack a dispatch order', async () => {
    const dispatchOrderId = randomUUID();
    const sku = 'SKU-123';
    const lotId = randomUUID();
    const quantity = '100';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: 'SO-001',
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer ABC',
    });

    const pickTaskId = await createPickTask(port, warehouseManager.token, dispatchOrderId, [randomUUID()]);
    const pickLineId = randomUUID();
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);
    await completePickTask(port, warehouseManager.token, pickTaskId);

    const eventId = await packDispatchOrder(port, warehouseManager.token, dispatchOrderId, [{
      sku,
      packed_qty: quantity,
      lot_id: lotId,
      carton_count: 5,
      actual_weight_kg: 12.5,
    }]);

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
    const sku = 'SKU-124';
    const lotId = randomUUID();
    const quantity = '50';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: 'SO-002',
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer XYZ',
    });

    const pickTaskId = await createPickTask(port, warehouseManager.token, dispatchOrderId, [randomUUID()]);
    const pickLineId = randomUUID();
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, '30');
    await completePickTask(port, warehouseManager.token, pickTaskId);

    const result = await makeRequest(port, 'POST', '/api/v1/dispatch/packed', {
      dispatchOrderId,
      packingLines: [{
        sku,
        packed_qty: '50',
        lot_id: lotId,
        carton_count: 3,
        actual_weight_kg: 8.0,
      }],
    }, { Authorization: `Bearer ${warehouseManager.token}` });

    assert.equal(result.status, 400);
    assert.equal(result.body['error_code'], 'PACKED_QTY_MISMATCH');
  });

  it('should generate shipping documents', async () => {
    const dispatchOrderId = randomUUID();
    const sku = 'SKU-125';
    const lotId = randomUUID();
    const quantity = '75';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: 'SO-003',
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer DEF',
    });

    const pickTaskId = await createPickTask(port, warehouseManager.token, dispatchOrderId, [randomUUID()]);
    const pickLineId = randomUUID();
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);
    await completePickTask(port, warehouseManager.token, pickTaskId);

    await packDispatchOrder(port, warehouseManager.token, dispatchOrderId, [{
      sku,
      packed_qty: quantity,
      lot_id: lotId,
      carton_count: 4,
      actual_weight_kg: 10.0,
    }]);

    const result = await generateShippingDocuments(port, warehouseManager.token, dispatchOrderId);

    assert.equal(typeof result['eventId'], 'string');
    assert.equal(result['dispatchOrderId'], dispatchOrderId);
    assert.equal(result['generatedBy'], warehouseManager.userId);
    assert(typeof result['billOfLading'] === 'string');
    assert(typeof result['packingSlip'] === 'string');
    assert(typeof result['commercialInvoice'] === 'string');
    assert(Array.isArray(result['shippingLabels']));
    assert(result['shippingLabels'].length === 4);

    const status = await getDispatchOrderStatus(port, warehouseManager.token, dispatchOrderId);
    assert(status !== null);
    assert.equal(status?.status, 'documents_generated');
    assert.equal(status?.generated_by, warehouseManager.userId);
    assert(typeof status?.generated_at === 'string');
  });

  it('should reject document generation for unpacked order', async () => {
    const dispatchOrderId = randomUUID();
    const sku = 'SKU-126';
    const lotId = randomUUID();
    const quantity = '25';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: 'SO-004',
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer GHI',
    });

    const pickTaskId = await createPickTask(port, warehouseManager.token, dispatchOrderId, [randomUUID()]);
    const pickLineId = randomUUID();
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);
    await completePickTask(port, warehouseManager.token, pickTaskId);

    const result = await makeRequest(port, 'POST', '/api/v1/dispatch/shipping-documents-generated', {
      dispatchOrderId,
    }, { Authorization: `Bearer ${warehouseManager.token}` });

    assert.equal(result.status, 400);
    assert.equal(result.body['error_code'], 'DISPATCH_ORDER_NOT_PACKED');
  });

  it('should dispatch a packed order with documents', async () => {
    const dispatchOrderId = randomUUID();
    const sku = 'SKU-127';
    const lotId = randomUUID();
    const quantity = '60';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: 'SO-005',
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer JKL',
    });

    const pickTaskId = await createPickTask(port, warehouseManager.token, dispatchOrderId, [randomUUID()]);
    const pickLineId = randomUUID();
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);
    await completePickTask(port, warehouseManager.token, pickTaskId);

    await packDispatchOrder(port, warehouseManager.token, dispatchOrderId, [{
      sku,
      packed_qty: quantity,
      lot_id: lotId,
      carton_count: 3,
      actual_weight_kg: 7.5,
    }]);

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
    const sku = 'SKU-128';
    const lotId = randomUUID();
    const quantity = '40';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: 'SO-006',
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer MNO',
    });

    const pickTaskId = await createPickTask(port, warehouseManager.token, dispatchOrderId, [randomUUID()]);
    const pickLineId = randomUUID();
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);
    await completePickTask(port, warehouseManager.token, pickTaskId);

    await packDispatchOrder(port, warehouseManager.token, dispatchOrderId, [{
      sku,
      packed_qty: quantity,
      lot_id: lotId,
      carton_count: 2,
      actual_weight_kg: 5.0,
    }]);

    const result = await makeRequest(port, 'POST', '/api/v1/dispatch/dispatched', {
      dispatchOrderId,
    }, { Authorization: `Bearer ${warehouseManager.token}` });

    assert.equal(result.status, 400);
    assert.equal(result.body['error_code'], 'DISPATCH_ORDER_NOT_PACKED');
  });

  it('should enforce RBAC for dispatch operations', async () => {
    const dispatchOrderId = randomUUID();
    const sku = 'SKU-129';
    const lotId = randomUUID();
    const quantity = '20';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: 'SO-007',
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer PQR',
    });

    const pickTaskId = await createPickTask(port, warehouseManager.token, dispatchOrderId, [randomUUID()]);
    const pickLineId = randomUUID();
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);
    await completePickTask(port, warehouseManager.token, pickTaskId);

    await packDispatchOrder(port, warehouseManager.token, dispatchOrderId, [{
      sku,
      packed_qty: quantity,
      lot_id: lotId,
      carton_count: 1,
      actual_weight_kg: 2.5,
    }]);

    const result = await makeRequest(port, 'POST', '/api/v1/dispatch/shipping-documents-generated', {
      dispatchOrderId,
    }, { Authorization: `Bearer ${warehouseOperator.token}` });

    assert.equal(result.status, 403);
    assert.equal(result.body['error_code'], 'FUNCTION_ACCESS_DENIED');
  });

  it('should enforce site scoping', async () => {
    const dispatchOrderId = randomUUID();
    const sku = 'SKU-130';
    const lotId = randomUUID();
    const quantity = '15';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: 'SO-008',
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer STU',
    });

    const pickTaskId = await createPickTask(port, warehouseManager.token, dispatchOrderId, [randomUUID()]);
    const pickLineId = randomUUID();
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);
    await completePickTask(port, warehouseManager.token, pickTaskId);

    const result = await makeRequest(port, 'POST', '/api/v1/dispatch/packed', {
      dispatchOrderId,
      packingLines: [{
        sku,
        packed_qty: quantity,
        lot_id: lotId,
        carton_count: 1,
        actual_weight_kg: 1.5,
      }],
    }, { Authorization: `Bearer ${otherSiteManager.token}` });

    assert.equal(result.status, 403);
    assert.equal(result.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });

  it('should retrieve packing records', async () => {
    const dispatchOrderId = randomUUID();
    const sku = 'SKU-131';
    const lotId = randomUUID();
    const quantity = '90';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: 'SO-009',
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer VWX',
    });

    const pickTaskId = await createPickTask(port, warehouseManager.token, dispatchOrderId, [randomUUID()]);
    const pickLineId = randomUUID();
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);
    await completePickTask(port, warehouseManager.token, pickTaskId);

    await packDispatchOrder(port, warehouseManager.token, dispatchOrderId, [{
      sku,
      packed_qty: quantity,
      lot_id: lotId,
      carton_count: 6,
      actual_weight_kg: 15.0,
    }]);

    const packingRecords = await getPackingRecords(port, warehouseManager.token, dispatchOrderId);
    assert.equal(packingRecords.length, 1);
    const pr = packingRecords[0]!;
    assert.equal(pr.dispatch_order_id, dispatchOrderId);
    assert.equal(pr.sku, sku);
    assert.equal(pr.packed_qty, quantity);
    assert.equal(pr.lot_id, lotId);
    assert.equal(pr.carton_count, 6);
    assert.equal(pr.actual_weight_kg, 15.0);
  });

  it('should retrieve dispatch documents', async () => {
    const dispatchOrderId = randomUUID();
    const sku = 'SKU-132';
    const lotId = randomUUID();
    const quantity = '110';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: 'SO-010',
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer YZ',
    });

    const pickTaskId = await createPickTask(port, warehouseManager.token, dispatchOrderId, [randomUUID()]);
    const pickLineId = randomUUID();
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);
    await completePickTask(port, warehouseManager.token, pickTaskId);

    await packDispatchOrder(port, warehouseManager.token, dispatchOrderId, [{
      sku,
      packed_qty: quantity,
      lot_id: lotId,
      carton_count: 7,
      actual_weight_kg: 18.0,
    }]);

    const docResult = await generateShippingDocuments(port, warehouseManager.token, dispatchOrderId);

    const documents = await getDispatchDocuments(port, warehouseManager.token, dispatchOrderId);
    assert.equal(documents.length, 4);

    const bolDoc = documents.find((d: Record<string, unknown>) => d.document_type === 'bol');
    const packingSlipDoc = documents.find((d: Record<string, unknown>) => d.document_type === 'packing_slip');
    const commercialInvoiceDoc = documents.find((d: Record<string, unknown>) => d.document_type === 'commercial_invoice');
    const labelDocs = documents.filter((d: Record<string, unknown>) => d.document_type === 'label');

    assert(bolDoc);
    assert(packingSlipDoc);
    assert(commercialInvoiceDoc);
    assert.equal(labelDocs.length, 7);

    assert.equal(bolDoc.content, docResult['billOfLading']);
    assert.equal(packingSlipDoc.content, docResult['packingSlip']);
    assert.equal(commercialInvoiceDoc.content, docResult['commercialInvoice']);
  });

  it('should handle edge event upload for dispatch operations', async () => {
    const dispatchOrderId = randomUUID();
    const sku = 'SKU-133';
    const lotId = randomUUID();
    const quantity = '80';

    await createErpSalesOrder(port, warehouseManager.token, {
      id: dispatchOrderId,
      so_number_ext: 'SO-011',
      sku,
      quantity,
      ship_from_site_id: siteId,
      ship_to_ext: 'Customer Edge',
    });

    const pickTaskId = await createPickTask(port, warehouseManager.token, dispatchOrderId, [randomUUID()]);
    const pickLineId = randomUUID();
    await confirmPickLine(port, warehouseOperator.token, pickTaskId, pickLineId, lotId, quantity);
    await completePickTask(port, warehouseManager.token, pickTaskId);

    const packingRecordId = randomUUID();
    const eventId = randomUUID();
    const result = await makeRequest(port, 'POST', '/api/v1/edge/events', {
      event_id: eventId,
      idempotency_key: randomUUID(),
      stream_type: 'warehouse',
      event_type: 'dispatch.packed',
      metadata: { device_id: 'edge-device-001' },
      payload: {
        packing_record_id: packingRecordId,
        dispatch_order_id: dispatchOrderId,
        sku,
        packed_qty: quantity,
        lot_id: lotId,
        carton_count: 4,
      },
    }, { Authorization: `Bearer ${warehouseManager.token}` });

    assert.equal(result.status, 201);
    assert.equal(result.body['event_id'], eventId);

    const status = await getDispatchOrderStatus(port, warehouseManager.token, dispatchOrderId);
    assert(status !== null);
    assert.equal(status?.status, 'packed');
    assert.equal(status?.packed_by, warehouseManager.userId);
  });
});