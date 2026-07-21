import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { persistEvent } from '../../src/events/store.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 2.4: Ind AS 2 compliant inventory valuation. Runs against the PRODUCTION router surface
// (createAppRouter) with real auth, RBAC, SCIM provisioning, and PostgreSQL, exactly like the
// Story 2.1-2.3 suites. Tests build on each other's committed data and run serially (npm test
// uses --test-concurrency=1).

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const SKU_WAVG = 'RM-0042';
const SKU_FIFO = 'FG-0010';
const SKU_SPID = 'EQ-0500';
const SKU_STDCOST = 'SC-ITEM-01';
const SKU_NRV = 'NRV-ITEM-01';
const SKU_PRECISION = 'WAVG-PRECISION';
const SKU_CONCURRENCY = 'WAVG-CONCURRENCY';
const SKU_FIFO_CONCURRENCY = 'FIFO-CONCURRENCY';
const SKU_FIFO_IDEM = 'FIFO-IDEM';
const SKU_SPID_IDEM = 'EQ-IDEM';

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
  assert.strictEqual(res.status, 201, `provision ${externalId} failed: ${JSON.stringify(res.body)}`);
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub} failed: ${JSON.stringify(res.body)}`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

function stockEnvelope(
  eventType: string,
  payload: Record<string, unknown>,
  extra: { stream_id?: string; idempotency_key?: string; event_id?: string; actor_location_id?: string } = {},
) {
  return {
    ...(extra.event_id ? { event_id: extra.event_id } : {}),
    stream_type: 'inventory',
    stream_id: extra.stream_id ?? randomUUID(),
    event_type: eventType,
    payload: { business_stream: 'production', ...payload },
    metadata: {
      correlation_id: randomUUID(),
      actor: {
        user_id: randomUUID(),
        role: 'stock_admin_2_4',
        location_id: extra.actor_location_id ?? '00000000-0000-0000-0000-000000000000',
      },
      occurred_at: new Date().toISOString(),
    },
    ...(extra.idempotency_key ? { idempotency_key: extra.idempotency_key } : {}),
  };
}

describe('Story 2.4 Ind AS 2 Compliant Inventory Valuation Integration Tests', () => {
  let server: Server;
  let port: number;
  let operatorHeaders: Record<string, string>;
  let complianceAdminHeaders: Record<string, string>;
  let financeUserId: string;
  let locAId: string;

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
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE inventory_valuation_standard_cost_variance, inventory_valuation_nrv_adjustment, inventory_valuation_serial_cost, inventory_valuation_fifo_layer, inventory_valuation, lot_master, serial_master, lot_trace, stock_balance, item_master, location_register, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    await provisionUser(port, 'inventory-operator-2-4@example.com', [
      { role: 'inventory_admin_2_4', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    operatorHeaders = await authFor(port, 'inventory-operator-2-4@example.com');

    await provisionUser(port, 'compliance-admin-2-4@example.com', [
      { role: 'compliance_admin_2_4', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    complianceAdminHeaders = await authFor(port, 'compliance-admin-2-4@example.com');

    // The DOA-resolved approver for value-banded NRV authorisation (Dev Notes: never hard-code
    // approver roles). Does not need any RBAC assignment of their own to BE the approver - only to
    // exist as an active user holding the governing role.
    financeUserId = await provisionUser(port, 'finance-controller-2-4@example.com', [
      { role: 'finance_controller', module: 'inventory', functionScope: 'read', locationId: '*' },
    ]);

    for (const transactionType of ['inventory.nrv_write_down', 'inventory.nrv_recovery']) {
      const res = await makeRequest(
        port,
        'POST',
        '/api/v1/doa/entries',
        { role: 'finance_controller', transaction_type: transactionType, value_min: null, value_max: null },
        complianceAdminHeaders,
      );
      assert.strictEqual(res.status, 201, `DOA entry ${transactionType} failed: ${JSON.stringify(res.body)}`);
    }

    // Seed item masters, one per valuation_method under test.
    for (const [sku, valuationMethod, serialControlled] of [
      [SKU_WAVG, 'weighted_average', false],
      [SKU_FIFO, 'fifo', false],
      [SKU_SPID, 'specific_identification', true],
      [SKU_STDCOST, 'weighted_average', false],
      [SKU_NRV, 'weighted_average', false],
      [SKU_PRECISION, 'weighted_average', false],
      [SKU_CONCURRENCY, 'weighted_average', false],
      [SKU_FIFO_CONCURRENCY, 'fifo', false],
      [SKU_FIFO_IDEM, 'fifo', false],
      [SKU_SPID_IDEM, 'specific_identification', true],
    ] as const) {
      await getPool().query(
        `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, valuation_method, business_stream, status)
         VALUES ($1, 'EA', false, $2, $3, 'production', 'active')`,
        [sku, serialControlled, valuationMethod],
      );
    }

    const locAResult = await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, site_id, zone_type, temperature_class, status)
       VALUES ($1, 'LOC-2-4-A', 'zone', $2, 'general', 'ambient', 'active') RETURNING location_id`,
      [randomUUID(), randomUUID()],
    );
    locAId = locAResult.rows[0]!['location_id'] as string;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
    await closePool();
    await closeAdminPool();
  });

  // ---------------------------------------------------------------------------------------------
  // AC1: weighted average
  // ---------------------------------------------------------------------------------------------
  it('AC1: running weighted average cost updates after each receipt and is queryable via GET .../valuation', async () => {
    for (const unitCost of [10, 12, 14]) {
      await persistEvent(
        stockEnvelope('stock.received', { sku: SKU_WAVG, target_location_id: locAId, quantity: 10, unit_cost: unitCost }, { actor_location_id: locAId }),
      );
    }

    const res = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_WAVG}/valuation`, undefined, operatorHeaders);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['quantity_on_hand'], 30);
    assert.strictEqual(res.body['running_average_cost'], 12);
    assert.strictEqual(res.body['carrying_value'], 360);

    // Issue at the current running average.
    await persistEvent(
      stockEnvelope('stock.issued', { sku: SKU_WAVG, target_location_id: locAId, quantity: 5 }, { actor_location_id: locAId }),
    );
    const afterIssue = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_WAVG}/valuation`, undefined, operatorHeaders);
    assert.strictEqual(afterIssue.body['quantity_on_hand'], 25);
    assert.strictEqual(afterIssue.body['carrying_value'], 300);
    assert.strictEqual(afterIssue.body['running_average_cost'], 12);
  });

  it('AC1: idempotent duplicate receipt submission updates the running average exactly once', async () => {
    const eventId = randomUUID();
    const idempotencyKey = `story-2-4-idem-${randomUUID()}`;
    const envelope = stockEnvelope(
      'stock.received',
      { sku: SKU_WAVG, target_location_id: locAId, quantity: 10, unit_cost: 20 },
      { actor_location_id: locAId, event_id: eventId, idempotency_key: idempotencyKey },
    );

    const before = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_WAVG}/valuation`, undefined, operatorHeaders);

    const first = await makeRequest(port, 'POST', '/api/v1/events', envelope, operatorHeaders);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const afterFirst = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_WAVG}/valuation`, undefined, operatorHeaders);
    assert.strictEqual(afterFirst.body['quantity_on_hand'], (before.body['quantity_on_hand'] as number) + 10);

    const retry = await makeRequest(port, 'POST', '/api/v1/events', envelope, operatorHeaders);
    assert.strictEqual(retry.status, 409, JSON.stringify(retry.body));
    assert.strictEqual(retry.body['error_code'], 'DUPLICATE_EVENT');

    const afterRetry = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_WAVG}/valuation`, undefined, operatorHeaders);
    assert.deepStrictEqual(afterRetry.body['quantity_on_hand'], afterFirst.body['quantity_on_hand']);
    assert.deepStrictEqual(afterRetry.body['carrying_value'], afterFirst.body['carrying_value']);
  });

  it('monetary precision: fractional costs and quantities (0.1, 0.2, 12.345678) accumulate exactly, no JS float drift', async () => {
    await persistEvent(
      stockEnvelope('stock.received', { sku: SKU_PRECISION, target_location_id: locAId, quantity: 0.1, unit_cost: 0.2 }, { actor_location_id: locAId }),
    );
    const afterFirst = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_PRECISION}/valuation`, undefined, operatorHeaders);
    assert.strictEqual(afterFirst.body['carrying_value'], 0.02);
    assert.strictEqual(afterFirst.body['running_average_cost'], 0.2);

    await persistEvent(
      stockEnvelope('stock.received', { sku: SKU_PRECISION, target_location_id: locAId, quantity: 0.2, unit_cost: 0.1 }, { actor_location_id: locAId }),
    );
    const afterSecond = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_PRECISION}/valuation`, undefined, operatorHeaders);
    assert.strictEqual(afterSecond.body['quantity_on_hand'], 0.3);
    assert.strictEqual(afterSecond.body['carrying_value'], 0.04);
    assert.ok(
      Math.abs((afterSecond.body['running_average_cost'] as number) - 0.133333) < 0.000001,
      `running_average_cost drifted: ${afterSecond.body['running_average_cost']}`,
    );

    await persistEvent(
      stockEnvelope('stock.received', { sku: SKU_PRECISION, target_location_id: locAId, quantity: 12.345678, unit_cost: 2 }, { actor_location_id: locAId }),
    );
    const afterThird = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_PRECISION}/valuation`, undefined, operatorHeaders);
    assert.strictEqual(afterThird.body['quantity_on_hand'], 12.645678);
    assert.strictEqual(afterThird.body['carrying_value'], 24.731356);
  });

  it('concurrency: two concurrent weighted-average receipts both land (no lost update)', async () => {
    await Promise.all([
      persistEvent(stockEnvelope('stock.received', { sku: SKU_CONCURRENCY, target_location_id: locAId, quantity: 10, unit_cost: 5 }, { actor_location_id: locAId })),
      persistEvent(stockEnvelope('stock.received', { sku: SKU_CONCURRENCY, target_location_id: locAId, quantity: 10, unit_cost: 5 }, { actor_location_id: locAId })),
    ]);
    const res = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_CONCURRENCY}/valuation`, undefined, operatorHeaders);
    assert.strictEqual(res.body['quantity_on_hand'], 20);
    assert.strictEqual(res.body['carrying_value'], 100);
  });

  // ---------------------------------------------------------------------------------------------
  // AC2: FIFO
  // ---------------------------------------------------------------------------------------------
  it('AC2: FIFO issue costs from the earliest received layer, and splits across layers when needed', async () => {
    await persistEvent(stockEnvelope('stock.received', { sku: SKU_FIFO, target_location_id: locAId, quantity: 5, unit_cost: 10 }, { actor_location_id: locAId }));
    await persistEvent(stockEnvelope('stock.received', { sku: SKU_FIFO, target_location_id: locAId, quantity: 5, unit_cost: 20 }, { actor_location_id: locAId }));

    // Issue 5: fully depletes the first (earliest, cost 10) layer.
    await persistEvent(stockEnvelope('stock.issued', { sku: SKU_FIFO, target_location_id: locAId, quantity: 5 }, { actor_location_id: locAId }));
    const afterFirstIssue = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_FIFO}/valuation`, undefined, operatorHeaders);
    assert.strictEqual(afterFirstIssue.body['carrying_value'], 100);
    const layersAfterFirst = afterFirstIssue.body['fifo_layers'] as Array<Record<string, unknown>>;
    assert.strictEqual(layersAfterFirst.length, 1);
    assert.strictEqual(layersAfterFirst[0]!['unit_cost'], 20);
    assert.strictEqual(layersAfterFirst[0]!['remaining_quantity'], 5);

    // Add a third layer, then issue 8 - this must split across the remaining layer-2 (5@20) and
    // layer-3 (3 of 5@30), a multi-layer costing split the FEFO/FIFO physical selector cannot do.
    await persistEvent(stockEnvelope('stock.received', { sku: SKU_FIFO, target_location_id: locAId, quantity: 5, unit_cost: 30 }, { actor_location_id: locAId }));
    await persistEvent(stockEnvelope('stock.issued', { sku: SKU_FIFO, target_location_id: locAId, quantity: 8 }, { actor_location_id: locAId }));

    const afterSplit = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_FIFO}/valuation`, undefined, operatorHeaders);
    // Remaining: layer-3 had 5, consumed 3 -> 2 remain at cost 30 = 60 carrying value.
    assert.strictEqual(afterSplit.body['carrying_value'], 60);
    const layersAfterSplit = afterSplit.body['fifo_layers'] as Array<Record<string, unknown>>;
    assert.strictEqual(layersAfterSplit.length, 1);
    assert.strictEqual(layersAfterSplit[0]!['unit_cost'], 30);
    assert.strictEqual(layersAfterSplit[0]!['remaining_quantity'], 2);
  });

  it('concurrency: two concurrent issues that together exactly deplete the last FIFO layer do not double-consume', async () => {
    await persistEvent(stockEnvelope('stock.received', { sku: SKU_FIFO_CONCURRENCY, target_location_id: locAId, quantity: 10, unit_cost: 5 }, { actor_location_id: locAId }));

    await Promise.all([
      persistEvent(stockEnvelope('stock.issued', { sku: SKU_FIFO_CONCURRENCY, target_location_id: locAId, quantity: 5 }, { actor_location_id: locAId })),
      persistEvent(stockEnvelope('stock.issued', { sku: SKU_FIFO_CONCURRENCY, target_location_id: locAId, quantity: 5 }, { actor_location_id: locAId })),
    ]);

    const res = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_FIFO_CONCURRENCY}/valuation`, undefined, operatorHeaders);
    assert.strictEqual(res.body['carrying_value'], 0);
    assert.strictEqual(res.body['quantity_on_hand'], 0);
    assert.strictEqual((res.body['fifo_layers'] as unknown[]).length, 0);
  });

  it('idempotent retry of a FIFO receipt does not double-add a cost layer', async () => {
    const eventId = randomUUID();
    const idempotencyKey = `story-2-4-fifo-idem-${randomUUID()}`;
    const envelope = stockEnvelope(
      'stock.received',
      { sku: SKU_FIFO_IDEM, target_location_id: locAId, quantity: 5, unit_cost: 40 },
      { actor_location_id: locAId, event_id: eventId, idempotency_key: idempotencyKey },
    );

    const first = await makeRequest(port, 'POST', '/api/v1/events', envelope, operatorHeaders);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const retry = await makeRequest(port, 'POST', '/api/v1/events', envelope, operatorHeaders);
    assert.strictEqual(retry.status, 409, JSON.stringify(retry.body));
    assert.strictEqual(retry.body['error_code'], 'DUPLICATE_EVENT');

    const res = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_FIFO_IDEM}/valuation`, undefined, operatorHeaders);
    assert.strictEqual(res.body['carrying_value'], 200);
    assert.strictEqual((res.body['fifo_layers'] as unknown[]).length, 1);
  });

  it('idempotent retry of a specific-identification receipt does not double-set the serial cost', async () => {
    const eventId = randomUUID();
    const idempotencyKey = `story-2-4-serial-idem-${randomUUID()}`;
    const envelope = stockEnvelope(
      'stock.received',
      { sku: SKU_SPID_IDEM, target_location_id: locAId, quantity: 1, unit_cost: 999, serials: [{ serial_number: 'SN-IDEM-1' }] },
      { actor_location_id: locAId, event_id: eventId, idempotency_key: idempotencyKey },
    );

    const first = await makeRequest(port, 'POST', '/api/v1/events', envelope, operatorHeaders);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const retry = await makeRequest(port, 'POST', '/api/v1/events', envelope, operatorHeaders);
    assert.strictEqual(retry.status, 409, JSON.stringify(retry.body));

    const res = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_SPID_IDEM}/valuation`, undefined, operatorHeaders);
    assert.strictEqual(res.body['carrying_value'], 999);
    assert.strictEqual((res.body['serial_costs'] as unknown[]).length, 1);
  });

  // ---------------------------------------------------------------------------------------------
  // AC3: LIFO structurally blocked
  // ---------------------------------------------------------------------------------------------
  it('AC3: an administrator attempting to set valuation_method "lifo" is rejected with VALUATION_METHOD_NOT_PERMITTED', async () => {
    const createRes = await makeRequest(
      port,
      'POST',
      '/api/v1/items',
      { sku: `RM-LIFO-${randomUUID().slice(0, 8)}`, uom: 'ea', valuation_method: 'lifo', business_stream: 'production' },
      operatorHeaders,
    );
    assert.strictEqual(createRes.status, 400, JSON.stringify(createRes.body));
    assert.strictEqual(createRes.body['error_code'], 'VALUATION_METHOD_NOT_PERMITTED');

    const patchRes = await makeRequest(port, 'PATCH', `/api/v1/items/${SKU_WAVG}`, { valuation_method: 'lifo' }, operatorHeaders);
    assert.strictEqual(patchRes.status, 400, JSON.stringify(patchRes.body));
    assert.strictEqual(patchRes.body['error_code'], 'VALUATION_METHOD_NOT_PERMITTED');
  });

  // ---------------------------------------------------------------------------------------------
  // AC4: NRV write-down and recovery cap
  // ---------------------------------------------------------------------------------------------
  it('AC4: NRV write-down reduces carrying value, is recorded with date/authoriser, and recovery is capped at original cost', async () => {
    await persistEvent(stockEnvelope('stock.received', { sku: SKU_NRV, target_location_id: locAId, quantity: 10, unit_cost: 100 }, { actor_location_id: locAId }));
    const initial = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_NRV}/valuation`, undefined, operatorHeaders);
    assert.strictEqual(initial.body['carrying_value'], 1000);

    // Authoriser mismatch is rejected before anything is persisted.
    const mismatch = await makeRequest(
      port,
      'POST',
      `/api/v1/stock/${SKU_NRV}/valuation/nrv-write-down`,
      { effective_date: '2026-07-21', authoriser_actor_id: randomUUID(), nrv_amount: 600, reason: 'Obsolescence assessment' },
      operatorHeaders,
    );
    assert.strictEqual(mismatch.status, 403, JSON.stringify(mismatch.body));
    assert.strictEqual(mismatch.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    const writeDown = await makeRequest(
      port,
      'POST',
      `/api/v1/stock/${SKU_NRV}/valuation/nrv-write-down`,
      { effective_date: '2026-07-21', authoriser_actor_id: financeUserId, nrv_amount: 600, reason: 'Obsolescence assessment', evidence_ref: 'EVID-001' },
      operatorHeaders,
    );
    assert.strictEqual(writeDown.status, 201, JSON.stringify(writeDown.body));
    const writeDownPayload = writeDown.body['payload'] as Record<string, unknown>;
    assert.strictEqual(writeDownPayload['original_cost'], 1000);
    assert.strictEqual(writeDownPayload['current_carrying_value'], 1000);
    assert.strictEqual(writeDownPayload['write_down_amount'], 400);
    assert.strictEqual(writeDownPayload['cumulative_write_down'], 400);
    assert.strictEqual(writeDownPayload['effective_date'], '2026-07-21');
    assert.strictEqual(writeDownPayload['authoriser_actor_id'], financeUserId);

    const afterWriteDown = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_NRV}/valuation`, undefined, operatorHeaders);
    assert.strictEqual(afterWriteDown.body['carrying_value'], 600);
    assert.strictEqual(afterWriteDown.body['pre_writedown_cost'], 1000);
    assert.strictEqual(afterWriteDown.body['cumulative_write_down'], 400);

    // Recovery above original cost (600 + 500 = 1100 > 1000) is rejected and does not mutate state,
    // and must not consume the idempotency key it was submitted with (Task 8: rejected-write coverage).
    const overCapKey = `story-2-4-nrv-recovery-${randomUUID()}`;
    const overCap = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: randomUUID(),
        event_type: 'stock.nrv_recovery_recorded',
        payload: {
          business_stream: 'production',
          sku: SKU_NRV,
          effective_date: '2026-07-22',
          authoriser_actor_id: financeUserId,
          recovery_amount: 500,
          reason: 'Market recovery',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: randomUUID(), role: 'inventory_admin_2_4', location_id: locAId },
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: overCapKey,
      },
      operatorHeaders,
    );
    assert.strictEqual(overCap.status, 409, JSON.stringify(overCap.body));
    assert.strictEqual(overCap.body['error_code'], 'NRV_RECOVERY_EXCEEDS_ORIGINAL_COST');

    const afterRejectedRecovery = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_NRV}/valuation`, undefined, operatorHeaders);
    assert.strictEqual(afterRejectedRecovery.body['carrying_value'], 600, 'a rejected recovery must not mutate carrying value');

    // Retrying the SAME idempotency key with a valid amount proves the rejected attempt above did
    // not consume it (a consumed key would surface DUPLICATE_EVENT here instead).
    const validRecovery = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: randomUUID(),
        event_type: 'stock.nrv_recovery_recorded',
        payload: {
          business_stream: 'production',
          sku: SKU_NRV,
          effective_date: '2026-07-22',
          authoriser_actor_id: financeUserId,
          recovery_amount: 300,
          reason: 'Market recovery',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: randomUUID(), role: 'inventory_admin_2_4', location_id: locAId },
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: overCapKey,
      },
      operatorHeaders,
    );
    assert.strictEqual(validRecovery.status, 201, JSON.stringify(validRecovery.body));
    const recoveryPayload = validRecovery.body['payload'] as Record<string, unknown>;
    assert.strictEqual(recoveryPayload['post_recovery_carrying_value'], 900);

    const afterRecovery = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_NRV}/valuation`, undefined, operatorHeaders);
    assert.strictEqual(afterRecovery.body['carrying_value'], 900);
    assert.strictEqual(afterRecovery.body['pre_writedown_cost'], 1000, 'partial recovery keeps the original-cost cap open');

    // Final recovery to exactly the original cost clears the cap.
    const fullRecovery = await makeRequest(
      port,
      'POST',
      `/api/v1/stock/${SKU_NRV}/valuation/nrv-recovery`,
      { effective_date: '2026-07-23', authoriser_actor_id: financeUserId, recovery_amount: 100, reason: 'Full market recovery' },
      operatorHeaders,
    );
    assert.strictEqual(fullRecovery.status, 201, JSON.stringify(fullRecovery.body));
    const afterFullRecovery = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_NRV}/valuation`, undefined, operatorHeaders);
    assert.strictEqual(afterFullRecovery.body['carrying_value'], 1000);
    assert.strictEqual(afterFullRecovery.body['pre_writedown_cost'], null, 'fully recovered - the cap is cleared');
  });

  // ---------------------------------------------------------------------------------------------
  // AC5: specific identification
  // ---------------------------------------------------------------------------------------------
  it('AC5: specific-identification issue costs the exact serial and leaves the other serial carrying value unchanged', async () => {
    await persistEvent(
      stockEnvelope(
        'stock.received',
        { sku: SKU_SPID, target_location_id: locAId, quantity: 1, unit_cost: 12000, serials: [{ serial_number: 'SN-1001' }] },
        { actor_location_id: locAId },
      ),
    );
    await persistEvent(
      stockEnvelope(
        'stock.received',
        { sku: SKU_SPID, target_location_id: locAId, quantity: 1, unit_cost: 13500, serials: [{ serial_number: 'SN-1002' }] },
        { actor_location_id: locAId },
      ),
    );

    const beforeIssue = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_SPID}/valuation`, undefined, operatorHeaders);
    assert.strictEqual(beforeIssue.body['carrying_value'], 25500);

    await persistEvent(
      stockEnvelope(
        'stock.issued',
        { sku: SKU_SPID, target_location_id: locAId, quantity: 1, serials: [{ serial_number: 'SN-1002' }] },
        { actor_location_id: locAId },
      ),
    );

    const afterIssue = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_SPID}/valuation`, undefined, operatorHeaders);
    assert.strictEqual(afterIssue.body['carrying_value'], 12000);
    const serialCosts = afterIssue.body['serial_costs'] as Array<Record<string, unknown>>;
    assert.strictEqual(serialCosts.length, 1);
    assert.strictEqual(serialCosts[0]!['serial_number'], 'SN-1001');
    assert.strictEqual(serialCosts[0]!['unit_cost'], 12000);
  });

  // ---------------------------------------------------------------------------------------------
  // AC6: standard cost measurement technique
  // ---------------------------------------------------------------------------------------------
  it('AC6: standard cost is accepted only as an Ind AS 2 paragraph 21 measurement technique, with variance reporting and tolerance breach flags', async () => {
    // standard_cost_amount without the designation is rejected.
    const bare = await makeRequest(port, 'PATCH', `/api/v1/items/${SKU_STDCOST}`, { standard_cost_amount: 100 }, operatorHeaders);
    assert.strictEqual(bare.status, 400, JSON.stringify(bare.body));
    assert.strictEqual(bare.body['error_code'], 'VALUATION_METHOD_NOT_PERMITTED');

    const bareMethod = await makeRequest(
      port,
      'POST',
      '/api/v1/items',
      { sku: `RM-STDCOST-${randomUUID().slice(0, 8)}`, uom: 'ea', valuation_method: 'standard_cost', business_stream: 'production' },
      operatorHeaders,
    );
    assert.strictEqual(bareMethod.status, 400, JSON.stringify(bareMethod.body));
    assert.strictEqual(bareMethod.body['error_code'], 'VALUATION_METHOD_NOT_PERMITTED');

    // Valid designation + tight tolerance so the variance review below breaches it.
    const configure = await makeRequest(
      port,
      'PATCH',
      `/api/v1/items/${SKU_STDCOST}`,
      {
        standard_cost_designation: 'ind_as_2_para_21_measurement_technique',
        standard_cost_amount: 100,
        variance_review_cadence: 'monthly',
        variance_tolerance_percent: 5,
      },
      operatorHeaders,
    );
    assert.strictEqual(configure.status, 200, JSON.stringify(configure.body));

    // Actual cost of 150/unit vs standard 100/unit is a 50% variance - well past the 5% tolerance.
    await persistEvent(stockEnvelope('stock.received', { sku: SKU_STDCOST, target_location_id: locAId, quantity: 10, unit_cost: 150 }, { actor_location_id: locAId }));

    const review = await makeRequest(
      port,
      'POST',
      `/api/v1/stock/${SKU_STDCOST}/valuation/standard-cost-variance-review`,
      { period: '2026-07' },
      operatorHeaders,
    );
    assert.strictEqual(review.status, 201, JSON.stringify(review.body));
    const reviewPayload = review.body['payload'] as Record<string, unknown>;
    assert.strictEqual(reviewPayload['standard_cost'], 100);
    assert.strictEqual(reviewPayload['actual_cost'], 150);
    assert.strictEqual(reviewPayload['variance_amount'], 50);
    assert.strictEqual(reviewPayload['breached'], true);

    const report = await makeRequest(port, 'GET', '/api/v1/valuation/standard-cost-variance-report', undefined, operatorHeaders);
    assert.strictEqual(report.status, 200, JSON.stringify(report.body));
    const items = report.body['items'] as Array<Record<string, unknown>>;
    const entry = items.find((row) => row['sku'] === SKU_STDCOST);
    assert.ok(entry, 'standard-cost variance report must include the reviewed sku');
    assert.strictEqual(entry!['breached'], true);
  });

  // ---------------------------------------------------------------------------------------------
  // Route-surface / RBAC smoke: valuation reads require inventory:read
  // ---------------------------------------------------------------------------------------------
  it('rejects an unauthenticated valuation read with 401', async () => {
    const res = await makeRequest(port, 'GET', `/api/v1/stock/${SKU_WAVG}/valuation`);
    assert.strictEqual(res.status, 401, JSON.stringify(res.body));
  });
});
